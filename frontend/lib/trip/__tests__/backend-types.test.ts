import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  Trip, Place, TripDay, TransportLeg, TripBundle, StageEvent, GenerationEvent,
  GenerateTripRequest,
} from '@/lib/trip/backend-types'

const baseRequest: GenerateTripRequest = {
  reel_urls: ['https://ig/r1'],
  requested_places: [],
  destination_hint: null,
  start_date: '2026-08-01',
  end_date: '2026-08-02',
  budget_level: null,
  origin_city: null,
  preferences: null,
}

describe('backend-types contract', () => {
  it('Trip.status is the frozen union', () => {
    expectTypeOf<Trip['status']>().toEqualTypeOf<
      'draft' | 'generating' | 'places_ready' | 'complete' | 'saved_with_gaps' | 'failed'
    >()
  })
  it('Place carries anti-hallucination fields', () => {
    expectTypeOf<Place['lat']>().toBeNumber()
    expectTypeOf<Place['lng']>().toBeNumber()
  })
  it('TransportLeg.status matches the DB check', () => {
    expectTypeOf<TransportLeg['status']>().toEqualTypeOf<
      'pending' | 'ok' | 'no_route' | 'failed' | 'skipped'
    >()
  })
  it('TripBundle aggregates the trip output', () => {
    expectTypeOf<TripBundle['trip']>().toEqualTypeOf<Trip>()
    expectTypeOf<TripBundle['days']>().toEqualTypeOf<TripDay[]>()
  })
  it('StageEvent and GenerationEvent both exist', () => {
    expectTypeOf<StageEvent['type']>().toEqualTypeOf<'stage'>()
    expectTypeOf<GenerationEvent['event_type']>().toBeString()
  })
  it('GenerateTripRequest mirrors backend pace (guardrail #4)', () => {
    // Contract: mirrors backend GenerateTripRequest.pace. Goes red at COMPILE time if the
    // field is removed or retyped — `npm run typecheck` is the gate, not a runtime assertion.
    const withPace: GenerateTripRequest = { ...baseRequest, pace: 'relaxed' }
    expect(withPace.pace).toBe('relaxed')
  })
})
