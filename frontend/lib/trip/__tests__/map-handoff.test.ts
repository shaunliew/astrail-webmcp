import { describe, it, expect } from 'vitest'
import { markTripFramed, consumeTripFramed } from '@/lib/trip/map-handoff'

describe('map handoff', () => {
  it('reports a match exactly once, then clears (one-shot)', () => {
    markTripFramed('trip-abc')
    expect(consumeTripFramed('trip-abc')).toBe(true)
    // Consumed — a second read no longer matches, so a re-mount frames normally.
    expect(consumeTripFramed('trip-abc')).toBe(false)
  })

  it('does not match a different trip, and clears the stale mark either way', () => {
    markTripFramed('trip-a')
    expect(consumeTripFramed('trip-b')).toBe(false)
    expect(consumeTripFramed('trip-a')).toBe(false)
  })

  it('returns false when nothing was marked', () => {
    expect(consumeTripFramed('anything')).toBe(false)
  })
})
