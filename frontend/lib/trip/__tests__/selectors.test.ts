import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type {
  Place, TripBundle, TripDay, TripPlace, TransportLeg, HotelSuggestion,
} from '@/lib/trip/backend-types'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
  orderedTripPlaces, pinLabelForPlace, trailCoordinates,
  recommendedHotelId, selectedHotel, hubSpokeFeatures,
} from '@/lib/trip/selectors'

describe('trip selectors', () => {
  it('orderedDays returns days sorted by day_number', () => {
    const days = orderedDays(TOKYO_TRIP)
    expect(days.map((d) => d.day_number)).toEqual([1, 2, 3])
  })

  it("placesForDay returns only that day's trip-places, sorted by sort_order", () => {
    const day1 = placesForDay(TOKYO_TRIP, 1)
    expect(day1.length).toBeGreaterThan(0)
    expect(day1.every((tp) => tp.day_number === 1)).toBe(true)
    const orders = day1.map((tp) => tp.sort_order ?? Infinity)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('legsForDay matches by trip_day_id and sorts by leg_order', () => {
    const legs = legsForDay(TOKYO_TRIP, 'day_1')
    expect(legs.every((l) => l.trip_day_id === 'day_1')).toBe(true)
  })

  it('restaurantsForDay filters by trip_day_id', () => {
    const rests = restaurantsForDay(TOKYO_TRIP, 'day_2')
    expect(rests.every((r) => r.trip_day_id === 'day_2')).toBe(true)
  })

  it('tripHotels returns the hotel rows', () => {
    expect(tripHotels(TOKYO_TRIP).length).toBeGreaterThan(0)
  })

  it('buildPlaceIndex maps every place_id to its Place', () => {
    const idx = buildPlaceIndex(TOKYO_TRIP)
    for (const tp of TOKYO_TRIP.places) {
      expect(idx.get(tp.place_id)?.id).toBe(tp.place_id)
    }
  })

  it('findTripPlace resolves a place_id and returns null for misses', () => {
    const known = TOKYO_TRIP.places[0].place_id
    expect(findTripPlace(TOKYO_TRIP, known)?.place_id).toBe(known)
    expect(findTripPlace(TOKYO_TRIP, 'nope')).toBeNull()
    expect(findTripPlace(TOKYO_TRIP, null)).toBeNull()
  })

  it('orderedTripPlaces threads every dayed stop across all days by (day, sort_order)', () => {
    const stops = orderedTripPlaces(TOKYO_TRIP)
    expect(stops.map((tp) => tp.place.name)).toEqual([
      'Senso-ji Temple', 'teamLab Planets', // Day 1
      'Shibuya Sky', 'Ichiran Shibuya',     // Day 2
      'Tokyo Disneyland',                    // Day 3
    ])
    // the undayed base hotel is not a stop on the journey line
    expect(stops.some((tp) => tp.day_number === null)).toBe(false)
  })

  it('pinLabelForPlace numbers stops globally 1..N across the whole trip', () => {
    const stops = orderedTripPlaces(TOKYO_TRIP)
    expect(pinLabelForPlace(TOKYO_TRIP, stops[0])).toBe('1')  // Day 1's first stop
    expect(pinLabelForPlace(TOKYO_TRIP, stops[2])).toBe('3')  // Day 2 continues the sequence
    expect(pinLabelForPlace(TOKYO_TRIP, stops[4])).toBe('5')  // last day carries the highest number
    // pins that are not stops (the undayed base hotel) recede — no number
    expect(pinLabelForPlace(TOKYO_TRIP, TOKYO_TRIP.places.find((tp) => tp.day_number === null)!)).toBeNull()
  })
})

// ---- trailCoordinates fixtures ----------------------------------------------------------
// Synthetic bundles: TOKYO_TRIP supplies the fields the selector never reads, these override
// the three it does (places, days, transport_legs).
const PIN_A: [number, number] = [139.7, 35.7]
const PIN_B: [number, number] = [139.71, 35.71]
const INTERIOR_1: [number, number] = [139.7031, 35.7042]
const INTERIOR_2: [number, number] = [139.7072, 35.7081]
// Deliberately OFF-PIN route endpoints. Mapbox snaps a leg's ends to the road, which can sit
// tens of metres from the place; the fixture roadish() instead ends exactly on the pins, so
// using it here would test duplicate-removal rather than endpoint snapping.
const OFF_PIN_START: [number, number] = [139.6801, 35.6802]
const OFF_PIN_END: [number, number] = [139.7301, 35.7302]
// Never produced by a straight hop: if this shows up in the output, a leg that should have
// been ignored was consumed.
const DISTINCT: [number, number] = [139.9501, 35.9502]

const testPlace = (id: string, [lng, lat]: [number, number]): Place => ({
  id, name: id, name_local: null, place_type: 'attraction', lat, lng,
  country: 'Japan', city: 'Tokyo', area: 'Test', aliases: [], source_summary: {},
})

const stopAt = (
  placeId: string, coords: [number, number], dayNumber: number, sortOrder: number,
): TripPlace => ({
  id: `tp_${placeId}_d${dayNumber}`, trip_id: 'trip_x', place_id: placeId,
  source_type: 'reel_extracted',
  evidence_json: {
    confidence: 1, source_url: null, quote: null, quotes: [], rationale: null,
    evidence_kind: 'reel_quote',
  },
  day_number: dayNumber, sort_order: sortOrder, place: testPlace(placeId, coords),
})

const testDay = (id: string, dayNumber: number): TripDay => ({
  id, trip_id: 'trip_x', day_number: dayNumber, day_date: null, title: null, summary: null,
  weather_summary: null, weather_source: null, weather_payload: {},
})

const testLeg = (
  id: string, dayId: string | null, from: string | null, to: string | null,
  coordinates: [number, number][] | null,
): TransportLeg => ({
  id, trip_id: 'trip_x', trip_day_id: dayId, from_place_id: from, to_place_id: to,
  leg_order: 0, transport_mode: 'walk', routing_provider: 'mapbox', routing_profile: 'walking',
  status: 'ok', duration_seconds: 120, distance_meters: 300,
  route_geometry: coordinates ? { type: 'LineString', coordinates } : null,
  warning: null,
})

const testBundle = (
  places: TripPlace[], days: TripDay[], transport_legs: TransportLeg[],
): TripBundle => ({ ...TOKYO_TRIP, places, days, transport_legs })

const DAYS = [testDay('day_1', 1), testDay('day_2', 2)]
const A_DAY1 = stopAt('pl_a', PIN_A, 1, 0)
const B_DAY1 = stopAt('pl_b', PIN_B, 1, 1)

describe('trailCoordinates', () => {
  // DECLARED SHARED POSITIVE CONTROL — a happy-path pin, not attributable to one guard. It
  // keeps the negative tests below from passing vacuously.
  it('threads road geometry for a same-day hop', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_1', 'pl_a', 'pl_b', [PIN_A, INTERIOR_1, INTERIOR_2, PIN_B]),
    ])
    expect(trailCoordinates(bundle)).toEqual([PIN_A, INTERIOR_1, INTERIOR_2, PIN_B])
  })

  // Anti-regression for the "always connects" invariant: most "saved with gaps" trips come
  // back with ZERO legs, and a leg-driven line would leave every one of their pins floating.
  it('falls back to a straight hop with zero legs', () => {
    expect(trailCoordinates(testBundle([A_DAY1, B_DAY1], DAYS, []))).toEqual([PIN_A, PIN_B])
  })

  it('snaps hop endpoints to the pins', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_1', 'pl_a', 'pl_b',
        [OFF_PIN_START, INTERIOR_1, INTERIOR_2, OFF_PIN_END]),
    ])
    // EXACT full array. A first/last-only assertion also passes against `hop.slice(1)`,
    // because the stop's own coordinate is appended last either way.
    expect(trailCoordinates(bundle)).toEqual([PIN_A, INTERIOR_1, INTERIOR_2, PIN_B])
  })

  it('ignores a leg whose TO does not match', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_1', 'pl_a', 'pl_elsewhere', [PIN_A, DISTINCT, PIN_B]),
    ])
    // Exact array — DISTINCT must not appear anywhere.
    expect(trailCoordinates(bundle)).toEqual([PIN_A, PIN_B])
  })

  // Separate from the TO case: a one-sided key check passes a single combined test.
  it('ignores a leg whose FROM does not match', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_1', 'pl_elsewhere', 'pl_b', [PIN_A, DISTINCT, PIN_B]),
    ])
    expect(trailCoordinates(bundle)).toEqual([PIN_A, PIN_B])
  })

  it('ignores a leg whose trip_day_id points at the wrong day', () => {
    // A -> B are consecutive stops ON DAY 1; the leg is mis-assigned to day 2's trip_day_id,
    // so only the `${day}|` key prefix can reject it.
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_2', 'pl_a', 'pl_b', [PIN_A, DISTINCT, PIN_B]),
    ])
    expect(trailCoordinates(bundle)).toEqual([PIN_A, PIN_B])
  })

  it('keeps a cross-day hop straight even when a same-pair leg exists', () => {
    // The leg carries the PREVIOUS stop's day, so the prefixed lookup would find it — only
    // the day-EQUALITY guard rejects it. Synthetic hardening: today's producer groups stops
    // by day before pairing, so it cannot emit this bundle.
    const bundle = testBundle(
      [A_DAY1, stopAt('pl_b', PIN_B, 2, 0)], DAYS,
      [testLeg('leg_a', 'day_1', 'pl_a', 'pl_b', [PIN_A, DISTINCT, PIN_B])],
    )
    expect(trailCoordinates(bundle)).toEqual([PIN_A, PIN_B])
  })

  it('keeps drawable geometry when a duplicate hop row carries NULL', () => {
    // transport_legs has no uniqueness over hop, day/hop or day/order, so two rows CAN share
    // a composite key. The drawable row MUST carry a distinctive INTERIOR point: a two-point
    // LineString has no interior after slice(1, -1) and renders identically to the straight
    // fallback, which would leave this green with `if (coords)` deleted.
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [
      testLeg('leg_a', 'day_1', 'pl_a', 'pl_b', [PIN_A, INTERIOR_1, PIN_B]),
      testLeg('leg_b', 'day_1', 'pl_a', 'pl_b', null),
    ])
    expect(trailCoordinates(bundle)).toEqual([PIN_A, INTERIOR_1, PIN_B])
  })

  // drawTrail calls trailCoordinates BEFORE checking output length, so without the
  // stops.length < 2 guard an empty "saved with gaps" bundle indexes stops[0] and throws.
  it('returns [] for zero stops', () => {
    expect(trailCoordinates(testBundle([], DAYS, []))).toEqual([])
  })

  it('returns [] for a single stop', () => {
    expect(trailCoordinates(testBundle([A_DAY1], DAYS, []))).toEqual([])
  })
})

// ---- hotel-hub selectors (T7) -----------------------------------------------------------
const HUB: [number, number] = [139.72, 35.72]

const testHotel = (over: Partial<HotelSuggestion> = {}): HotelSuggestion => ({
  id: 'hotel_x', trip_id: 'trip_x', trip_day_id: null, base_place_id: null,
  name: 'Test Hotel', area: null, star_rating: null, price_snapshot: {},
  travala_hotel_id: null, preference_match_json: {}, source: 'travala',
  status: 'suggested', searched_at: null,
  lat: HUB[1], lng: HUB[0], geo_status: 'placed', route_score: null,
  rank: null, is_recommended: false, place_durations: {},
  ...over,
})

// Override a stop's place_type without rebuilding it — used to plant a base-hotel place.
const asType = (tp: TripPlace, t: Place['place_type']): TripPlace => ({
  ...tp, place: { ...tp.place, place_type: t },
})

describe('hotel-hub selectors', () => {
  it('recommendedHotelId returns the rank-1 placed hotel', () => {
    expect(recommendedHotelId(TOKYO_TRIP)).toBe('hotel_1')
  })

  it('recommendedHotelId returns null when no hotel is placed', () => {
    const allUnresolved: TripBundle = {
      ...TOKYO_TRIP,
      hotels: TOKYO_TRIP.hotels.map((h) => ({
        ...h, geo_status: 'unresolved' as const, is_recommended: false, rank: null,
        lat: null, lng: null,
      })),
    }
    expect(recommendedHotelId(allUnresolved)).toBeNull()
  })

  it('selectedHotel finds a hotel by id and returns null for misses / null', () => {
    expect(selectedHotel(TOKYO_TRIP, 'hotel_1')?.id).toBe('hotel_1')
    expect(selectedHotel(TOKYO_TRIP, 'nope')).toBeNull()
    expect(selectedHotel(TOKYO_TRIP, null)).toBeNull()
  })

  it('hubSpokeFeatures draws a straight 2-point spoke from the hub to each dayed destination', () => {
    const hotel = TOKYO_TRIP.hotels.find((h) => h.id === 'hotel_1')!
    const fc = hubSpokeFeatures(hotel, TOKYO_TRIP)
    expect(fc.type).toBe('FeatureCollection')
    // The five dayed, real-coord places in journey order; the UNDAYED base-hotel place is excluded.
    const destIds = fc.features.map((f) => f.properties?.place_id)
    expect(destIds).toEqual(['pl_senso', 'pl_teamlab', 'pl_shibuya', 'pl_ichiran', 'pl_disney'])
    for (const f of fc.features) {
      expect(f.geometry.type).toBe('LineString')
      expect(f.geometry.coordinates).toHaveLength(2)                 // straight, 2-point
      expect(f.geometry.coordinates[0]).toEqual([hotel.lng, hotel.lat]) // starts at the hub
    }
    // Endpoints match the destination place coords, in order.
    expect(fc.features.map((f) => f.geometry.coordinates[1])).toEqual([
      [139.7967, 35.7148], [139.7906, 35.6497], [139.7016, 35.6580],
      [139.7002, 35.6606], [139.8804, 35.6329],
    ])
    // Every fixture duration is present → every spoke is labeled.
    expect(fc.features.map((f) => f.properties?.duration_s)).toEqual([4500, 6000, 2700, 2700, 11000])
  })

  it('hubSpokeFeatures excludes a base-hotel place (place_type "hotel") even when it is dayed', () => {
    // orderedTripPlaces already drops UNDAYED places; this base-hotel place is DAYED, so only the
    // explicit place_type==='hotel' exclusion keeps it out of the spokes.
    const hotelBaseStop = asType(stopAt('pl_hotel', [139.73, 35.73], 1, 2), 'hotel')
    const bundle = testBundle([A_DAY1, B_DAY1, hotelBaseStop], DAYS, [])
    const fc = hubSpokeFeatures(testHotel(), bundle)
    expect(fc.features.map((f) => f.properties?.place_id)).toEqual(['pl_a', 'pl_b'])
  })

  it('hubSpokeFeatures excludes a place referenced by a hotel base_place_id (non-hotel type)', () => {
    // pl_base is a plain 'area' place — NOT excluded by place_type. Only the base_place_id linkage
    // (read from bundle.hotels) keeps the hotel from spoking to its own base.
    const baseStop = asType(stopAt('pl_base', [139.74, 35.74], 1, 2), 'area')
    const hub = testHotel({ base_place_id: 'pl_base' })
    const bundle: TripBundle = { ...testBundle([A_DAY1, B_DAY1, baseStop], DAYS, []), hotels: [hub] }
    const fc = hubSpokeFeatures(hub, bundle)
    expect(fc.features.map((f) => f.properties?.place_id)).toEqual(['pl_a', 'pl_b'])
  })

  it('hubSpokeFeatures draws an unlabeled-but-present spoke when a duration is missing', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [])
    const fc = hubSpokeFeatures(testHotel({ place_durations: { pl_a: 900 } }), bundle)
    expect(fc.features).toHaveLength(2)                              // NEVER drop the line
    const byId = new Map(fc.features.map((f) => [f.properties?.place_id, f.properties]))
    expect(byId.get('pl_a')?.duration_s).toBe(900)                  // labeled
    expect(byId.get('pl_b')?.duration_s).toBeUndefined()            // present but unlabeled
  })

  it('hubSpokeFeatures leaves a spoke unlabeled for a non-finite duration', () => {
    const bundle = testBundle([A_DAY1, B_DAY1], DAYS, [])
    const fc = hubSpokeFeatures(testHotel({ place_durations: { pl_a: Infinity, pl_b: 600 } }), bundle)
    expect(fc.features).toHaveLength(2)
    const byId = new Map(fc.features.map((f) => [f.properties?.place_id, f.properties]))
    expect(byId.get('pl_a')?.duration_s).toBeUndefined()            // Infinity is not a label
    expect(byId.get('pl_b')?.duration_s).toBe(600)
  })

  it('hubSpokeFeatures returns an empty collection for an unresolved hotel', () => {
    const hotel = TOKYO_TRIP.hotels.find((h) => h.id === 'hotel_2')!
    expect(hubSpokeFeatures(hotel, TOKYO_TRIP)).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('hubSpokeFeatures returns an empty collection for an absent hotel', () => {
    expect(hubSpokeFeatures(null, TOKYO_TRIP)).toEqual({ type: 'FeatureCollection', features: [] })
  })

  it('hubSpokeFeatures returns an empty collection for a placed hotel without real coords', () => {
    // Null coords (the pre-check) AND (0,0) (hasRealCoords' zero-guard) both yield no spokes —
    // an unlocatable hub is never pinned (Guardrail #1).
    expect(hubSpokeFeatures(testHotel({ lat: null, lng: null }), TOKYO_TRIP))
      .toEqual({ type: 'FeatureCollection', features: [] })
    expect(hubSpokeFeatures(testHotel({ lat: 0, lng: 0 }), TOKYO_TRIP))
      .toEqual({ type: 'FeatureCollection', features: [] })
  })
})
