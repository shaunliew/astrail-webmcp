import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
  pinLabelForPlace,
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

  it('pinLabelForPlace numbers only the active day in itinerary order', () => {
    const day1 = placesForDay(TOKYO_TRIP, 1)
    expect(pinLabelForPlace(TOKYO_TRIP, day1[0], 1)).toBe('1')
    expect(pinLabelForPlace(TOKYO_TRIP, day1[1], 1)).toBe('2')
    expect(pinLabelForPlace(TOKYO_TRIP, placesForDay(TOKYO_TRIP, 2)[0], 1)).toBeNull()
    expect(pinLabelForPlace(TOKYO_TRIP, TOKYO_TRIP.places.find((tp) => tp.day_number === null)!, 1)).toBeNull()
  })
})
