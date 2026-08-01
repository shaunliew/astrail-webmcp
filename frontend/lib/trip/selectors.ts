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
