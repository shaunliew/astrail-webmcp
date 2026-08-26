import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { orderedTripPlaces } from '@/lib/trip/selectors'
import { resolvePlaceRef } from '../resolve'

const ok = (r: ReturnType<typeof resolvePlaceRef>) => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.message}`)
  return r
}

describe('resolvePlaceRef — pin numbers', () => {
  it('resolves the pin number the user can see on the map', () => {
    const r = ok(resolvePlaceRef(TOKYO_TRIP, '1'))
    expect(r.tripPlace.place.name).toBe('Senso-ji Temple')
    expect(r.pin).toBe(1)
  })

  it('resolves every pin the trail assigns', () => {
    const count = orderedTripPlaces(TOKYO_TRIP).length
    for (let pin = 1; pin <= count; pin++) {
      expect(ok(resolvePlaceRef(TOKYO_TRIP, String(pin))).pin).toBe(pin)
    }
  })

  it('rejects an out-of-range pin with the valid range, not a guess', () => {
    const r = resolvePlaceRef(TOKYO_TRIP, '99')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('stops 1-')
  })
})

describe('resolvePlaceRef — names', () => {
  it('matches an exact name', () => {
    expect(ok(resolvePlaceRef(TOKYO_TRIP, 'Shibuya Sky')).pin).toBe(3)
  })

  it('ignores case, punctuation and accents', () => {
    // Reel captions are inconsistent about all three; the agent will echo whatever it read.
    expect(ok(resolvePlaceRef(TOKYO_TRIP, 'senso ji temple')).pin).toBe(1)
    expect(ok(resolvePlaceRef(TOKYO_TRIP, 'SENSO-JI TEMPLE')).pin).toBe(1)
    expect(ok(resolvePlaceRef(TOKYO_TRIP, '  teamlab planets  ')).pin).toBe(2)
  })

  it('matches an unambiguous substring', () => {
    expect(ok(resolvePlaceRef(TOKYO_TRIP, 'Disneyland')).pin).toBe(5)
  })

  it('returns candidates instead of guessing when a substring is ambiguous', () => {
    // "Shibuya" hits both Shibuya Sky and Ichiran Shibuya. Picking one silently edits the
    // wrong stop — the single worst failure this resolver can have.
    const r = resolvePlaceRef(TOKYO_TRIP, 'Shibuya')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('ambiguous')
      expect(r.message).toContain('Shibuya Sky')
      expect(r.message).toContain('Ichiran Shibuya')
      expect(r.message).toContain('pin number')
    }
  })

  it('prefers an exact name over a longer substring match', () => {
    // Guards the match ORDER: exact must win, or a place whose name is contained in another
    // becomes unreachable by its own name.
    const r = ok(resolvePlaceRef(TOKYO_TRIP, 'Shibuya Sky'))
    expect(r.tripPlace.place.name).toBe('Shibuya Sky')
  })

  it('tells the agent how to recover when nothing matches', () => {
    const r = resolvePlaceRef(TOKYO_TRIP, 'Eiffel Tower')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('get_itinerary')
  })

  it('rejects an empty ref', () => {
    expect(resolvePlaceRef(TOKYO_TRIP, '   ').ok).toBe(false)
  })
})

describe('resolvePlaceRef — degenerate bundles', () => {
  it('reports an empty trip rather than throwing', () => {
    const empty = { ...TOKYO_TRIP, places: [] }
    const r = resolvePlaceRef(empty, '1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('no stops')
  })
})
