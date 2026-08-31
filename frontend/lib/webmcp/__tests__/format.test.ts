import { describe, it, expect } from 'vitest'
import type { TripBundle, TripDay, TripPlace } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { placesForDay } from '@/lib/trip/selectors'
import { formatItinerary, formatTripList, tripHeader } from '../format'
import { envelopeLength, OUTPUT_LIMIT, OUTPUT_TARGET } from '../fit'

/** A deliberately worst-case bundle: long names, long day titles, weather on every day. */
function syntheticBundle(days: number, stopsPerDay: number): TripBundle {
  const tripDays: TripDay[] = Array.from({ length: days }, (_, i) => ({
    ...TOKYO_TRIP.days[0],
    id: `day-${i + 1}`,
    day_number: i + 1,
    title: 'Arashiyama and the western temples',
    weather_summary: 'light rain in the morning, clearing',
  }))

  const places: TripPlace[] = []
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < stopsPerDay; s++) {
      const base = TOKYO_TRIP.places[0]
      places.push({
        ...base,
        id: `tp-${d}-${s}`,
        place_id: `p-${d}-${s}`,
        day_number: d + 1,
        sort_order: s,
        place: { ...base.place, id: `p-${d}-${s}`, name: 'Tenryu-ji Temple Garden North Gate' },
      })
    }
  }

  return {
    ...TOKYO_TRIP,
    trip: { ...TOKYO_TRIP.trip, title: 'Kyoto & Nara, temples and back streets' },
    days: tripDays,
    places,
  }
}

describe('tripHeader', () => {
  it('summarises where, when, size and status on one line', () => {
    const h = tripHeader(TOKYO_TRIP)
    expect(h).toContain('·')
    expect(h).toContain(TOKYO_TRIP.trip.status)
    expect(h.split('\n')).toHaveLength(1)
  })
})

describe('formatItinerary', () => {
  it('renders days and pin-numbered stops with their provenance', () => {
    const out = formatItinerary(TOKYO_TRIP)
    expect(out).toContain('D1')
    expect(out).toContain('Akasaka Station')
    expect(out).toMatch(/ 1 Akasaka Station · (reel|you|astrail)/)
  })

  it('scopes to a single day when asked', () => {
    // The stop is read from the day being asked for, not named literally: the fixture's days
    // have been redistributed once already, and a hardcoded name silently stops testing scoping
    // the moment it moves to another day.
    const out = formatItinerary(TOKYO_TRIP, 2)
    expect(out).toContain('D2')
    expect(out).not.toContain('D1 ')
    expect(out).toContain(placesForDay(TOKYO_TRIP, 2)[0].place.name)
  })

  it('reports a missing day with the valid range instead of returning nothing', () => {
    const out = formatItinerary(TOKYO_TRIP, 99)
    expect(out).toContain('no day 99')
    expect(out).toContain('Days: 1-')
  })

  it('omits the legend from output — it belongs in the tool description', () => {
    // Output is billed per call; descriptions are free and sent once. Re-explaining
    // reel/you/astrail on every call is the easiest way to waste the budget.
    const out = formatItinerary(TOKYO_TRIP)
    expect(out).not.toMatch(/extracted from|legend|reel = /i)
  })

  it('fits the budget on the worst realistic trip (10 days, 40 stops)', () => {
    const out = formatItinerary(syntheticBundle(10, 4))
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_TARGET)
  })

  it('stays under the hard cap even at absurd size (20 days, 200 stops)', () => {
    const out = formatItinerary(syntheticBundle(20, 10))
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
    expect(out).toContain('omitted')
    expect(out).toContain('get_itinerary')
  })

  it('never emits a partial day when truncating', () => {
    const out = formatItinerary(syntheticBundle(20, 10))
    for (let d = 1; d <= 20; d++) {
      if (!out.includes(`D${d} Arashiyama`)) continue
      const stops = out.split(`D${d} Arashiyama`)[1].split('\nD')[0]
      const count = (stops.match(/Tenryu-ji/g) ?? []).length
      expect(count).toBe(10)
    }
  })

  it('a single day request always fits, even for a heavy day', () => {
    const out = formatItinerary(syntheticBundle(10, 12), 3)
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })
})

describe('formatTripList', () => {
  const trip = (id: string, status = 'complete') => ({
    id, title: 'Kyoto & Nara', inferred_destination: null, destination_hint: null,
    start_date: '2026-03-03', end_date: '2026-03-07', status,
  })

  it('guides a new user rather than returning an empty string', () => {
    expect(formatTripList([])).toContain('Save some Instagram Reels')
  })

  it('lists trips one per line with a short id', () => {
    const out = formatTripList([trip('abcdef12-3456-7890-abcd-ef1234567890')])
    expect(out).toContain('1 Kyoto & Nara')
    expect(out).toContain('id=abcdef12')
    expect(out).not.toContain('ef1234567890') // full UUIDs would eat the budget
  })

  it('caps the list and says how many were withheld', () => {
    const many = Array.from({ length: 20 }, (_, i) => trip(`id-${i}-aaaaaaaa`))
    const out = formatTripList(many)
    expect(out).toContain('and 8 more')
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_LIMIT)
  })
})
