import type {
  TripBundle, TripPlace, TripDay, TransportLeg,
  RestaurantSuggestion, HotelSuggestion, Place,
} from './backend-types'

const bySortOrder = (a: TripPlace, b: TripPlace) =>
  (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)

export function orderedDays(bundle: TripBundle): TripDay[] {
  return [...bundle.days].sort((a, b) => a.day_number - b.day_number)
}

export function placesForDay(bundle: TripBundle, dayNumber: number): TripPlace[] {
  return bundle.places.filter((tp) => tp.day_number === dayNumber).sort(bySortOrder)
}

export function legsForDay(bundle: TripBundle, dayId: string): TransportLeg[] {
  return bundle.transport_legs
    .filter((l) => l.trip_day_id === dayId)
    .sort((a, b) => a.leg_order - b.leg_order)
}

export function restaurantsForDay(bundle: TripBundle, dayId: string): RestaurantSuggestion[] {
  return bundle.restaurants.filter((r) => r.trip_day_id === dayId)
}

export function tripHotels(bundle: TripBundle): HotelSuggestion[] {
  return bundle.hotels
}

export function buildPlaceIndex(bundle: TripBundle): Map<string, Place> {
  /* Trip stops FIRST, then suggestion-only places, so a place that is both a stop and
     a suggestion target keeps the trip's own row. */
  const index = new Map(bundle.places.map((tp) => [tp.place_id, tp.place]))
  for (const p of bundle.suggestion_places ?? []) {
    if (!index.has(p.id)) index.set(p.id, p)
  }
  return index
}

export function findTripPlace(bundle: TripBundle, placeId: string | null): TripPlace | null {
  if (!placeId) return null
  return bundle.places.find((tp) => tp.place_id === placeId) ?? null
}

// A place with missing/zero/out-of-range coords is unresolved (a "saved with gaps" trip
// has these). It must not get a pin, must NOT extend the map bounds (one (0,0) drags the
// frame out to span half the globe), and is not a stop on the journey line.
export function hasRealCoords(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) && Number.isFinite(lat) &&
    Math.abs(lng) <= 180 && Math.abs(lat) <= 90 &&
    (lng !== 0 || lat !== 0)
  )
}

// The trip's stops in a single journey order: every dayed, resolved-coordinate place across
// ALL days, sorted by (day_number, sort_order) — Day 1's first stop first, the last day's
// final stop last. This is the beta "connect the pins" model (docs/roadmap/
// trip-map-day-connections.md): a plain ordered path, independent of transport-leg data, so
// it always connects even on the many trips that come back with zero legs. Undayed places
// (the base hotel) and unresolved coordinates are deliberately excluded — the hotel becomes
// the parent hub in the future routing phase, not a stop on the line.
export function orderedTripPlaces(bundle: TripBundle): TripPlace[] {
  return bundle.places
    .filter((tp) => tp.day_number !== null && hasRealCoords(tp.place.lng, tp.place.lat))
    .sort((a, b) => {
      const byDay = (a.day_number ?? 0) - (b.day_number ?? 0)
      if (byDay !== 0) return byDay
      return (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)
    })
}

// One global trail number per stop, 1..N in journey order, keyed by trip_place id. So the
// pins read as one sequence to follow end to end (the last stop carries the highest number),
// not per-day counters that restart each day.
export function buildTrailNumbers(bundle: TripBundle): Map<string, number> {
  const numbers = new Map<string, number>()
  orderedTripPlaces(bundle).forEach((tp, i) => numbers.set(tp.id, i + 1))
  return numbers
}

// The pin's global trail number as a string, or null for pins that are not stops on the
// journey line (the undayed base hotel, unresolved coordinates) — those recede.
export function pinLabelForPlace(bundle: TripBundle, tripPlace: TripPlace): string | null {
  const number = buildTrailNumbers(bundle).get(tripPlace.id)
  return number ? String(number) : null
}

// The trail's coordinates: the ordered stops, with per-hop road geometry substituted where a
// same-day transport leg provides it, and a straight pin-to-pin fallback everywhere else. The
// trail must ALWAYS connect (see TripMap.drawTrail) — most "saved with gaps" trips carry zero
// legs — so a hop only upgrades when a leg exists for that exact pair ON THAT DAY.
//
// The day dimension is DEFENSE-IN-DEPTH, not a production bug fix. It is NOT the
// `unique (trip_id, place_id)` constraint: that only stops a place appearing twice, and would
// still permit an A->B leg spanning two days (the transport_legs FK checks only that the day
// belongs to the trip, not endpoint-day membership). The real reason today's producer cannot
// emit such a bundle is that `persist_transport` groups stops by day before constructing
// pairs, so every leg it writes is within one day by construction. The day key is kept because
// it makes "cross-day hops stay straight" true by construction rather than by relying on an
// invariant enforced in a different table, and it costs three lines.
export function trailCoordinates(bundle: TripBundle): [number, number][] {
  const stops = orderedTripPlaces(bundle)
  if (stops.length < 2) return []
  // ONE key builder, used by BOTH insertion and lookup. Constructing the key at two sites made
  // the day/FROM/TO fields two-site guards: removing a field from only one expression still
  // leaves the keys mismatched, so the geometry stays unconsumed and the wrong-day/FROM/TO
  // tests stay GREEN. With one builder, deleting one field reddens exactly the test that
  // names it.
  // `day` is widened to include null purely so the ONE builder serves both call sites: the
  // leg side resolves to `number | undefined`, the stop side to `number | null`. It is never
  // actually null at the stop side — orderedTripPlaces filters undayed places out.
  const hopKey = (day: number | null | undefined, from: string | null, to: string | null) =>
    `${day}|${from}->${to}`
  const dayOf = new Map(bundle.days.map((d) => [d.id, d.day_number]))
  const byHop = new Map<string, [number, number][]>()
  for (const leg of bundle.transport_legs) {
    // `if (coords)` IS load-bearing. Storing `undefined` equals not storing ONLY when the key
    // is absent. `transport_legs` has NO unique constraint on hop, day/hop or day/order, so
    // two rows CAN share a composite key; without this branch a later NULL-geometry row
    // Map.sets over an earlier drawable one and the hop silently degrades to a straight line.
    // POLICY: DRAWABLE WINS over a later NULL for the same hop.
    // ACCEPTED LIMIT: two DRAWABLE rows on one hop remain order-dependent — last-write-wins,
    // and the frontend orders only by leg_order with no uniqueness in the schema. Today's
    // producer cannot emit that state, so an arbitrary-but-drawable winner is explicitly
    // accepted rather than given a tie-break rule. Revisit if any producer can emit two
    // drawable rows for one hop.
    const coords = leg.route_geometry?.coordinates
    if (coords) {
      const day = leg.trip_day_id ? dayOf.get(leg.trip_day_id) : undefined
      byHop.set(hopKey(day, leg.from_place_id, leg.to_place_id), coords as [number, number][])
    }
  }
  const out: [number, number][] = [[stops[0].place.lng, stops[0].place.lat]]
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]
    // Same-day hops only. A cross-day transition has no leg by construction and stays straight.
    const hop = prev.day_number === stops[i].day_number
      ? byHop.get(hopKey(prev.day_number, prev.place_id, stops[i].place_id))
      : undefined
    // Interior points only — endpoints snap to the pins. Mapbox returns road-snapped ends that
    // can sit tens of metres off a place (one inside a park), and the trail must meet the pins.
    if (hop) for (const c of hop.slice(1, -1)) out.push(c)
    out.push([stops[i].place.lng, stops[i].place.lat])
  }
  return out
}
