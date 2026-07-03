import { describe, it, expectTypeOf } from 'vitest'
import type {
  Trip, Place, TripDay, TransportLeg, TripBundle, StageEvent, GenerationEvent,
} from '@/lib/trip/backend-types'

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
})
