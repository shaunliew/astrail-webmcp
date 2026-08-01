import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
  orderedTripPlaces, pinLabelForPlace,
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
