import { describe, it, expect, vi } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { getItineraryTool, getPlaceEvidenceTool, type TripReader } from '../tools/trips'

const FULL = TOKYO_TRIP.trip.id
const SHORT = FULL.slice(0, 8) // exactly what list_trips prints back to the agent

const reader = (over: Partial<TripReader> = {}): TripReader => ({
  current: () => null,
  list: async () => [TOKYO_TRIP.trip],
  load: async (id) => (id === FULL ? TOKYO_TRIP : null),
  ...over,
})

describe('get_itinerary — resolving which trip', () => {
  it('accepts the 8-char short id that list_trips prints', async () => {
    // The budget forces list_trips to emit a prefix, so the agent can only ever hand one back.
    const out = await getItineraryTool(reader()).execute({ trip_id: SHORT })
    expect(String(out)).toContain('Senso-ji Temple')
  })

  it('accepts the full uuid too', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: FULL })
    expect(String(out)).toContain('Senso-ji Temple')
  })

  it('uses the open trip when no id is given', async () => {
    const load = vi.fn()
    const out = await getItineraryTool(reader({ current: () => TOKYO_TRIP, load })).execute({})
    expect(String(out)).toContain('Senso-ji Temple')
    expect(load).not.toHaveBeenCalled() // already in memory; no round-trip
  })

  it('asks which trip rather than guessing when none is open', async () => {
    const out = await getItineraryTool(reader()).execute({})
    expect(String(out)).toContain('Call list_trips')
  })

  it('reports an unknown id instead of silently returning nothing', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: 'deadbeef' })
    expect(String(out)).toContain('No trip with id')
  })

  it('refuses an ambiguous prefix rather than picking one', async () => {
    const t2 = { ...TOKYO_TRIP.trip, id: `${FULL.slice(0, 8)}ffff-0000-0000-000000000000` }
    const out = await getItineraryTool(reader({ list: async () => [TOKYO_TRIP.trip, t2] })).execute({
      trip_id: SHORT,
    })
    expect(String(out)).toContain('matches 2 trips')
  })

  it('avoids a network load when the open trip already matches the id', async () => {
    const load = vi.fn()
    await getItineraryTool(reader({ current: () => TOKYO_TRIP, load })).execute({ trip_id: SHORT })
    expect(load).not.toHaveBeenCalled()
  })

  it('surfaces a failed load honestly', async () => {
    const out = await getItineraryTool(reader({ load: async () => null })).execute({ trip_id: SHORT })
    expect(String(out)).toContain('could not be loaded')
  })

  it('scopes to one day when asked', async () => {
    const out = await getItineraryTool(reader()).execute({ trip_id: SHORT, day: 2 })
    expect(String(out)).toContain('Shibuya Sky')
    expect(String(out)).not.toContain('D1 ')
  })
})

describe('get_place_evidence', () => {
  it('returns the verbatim caption quote and its source', async () => {
    const out = String(await getPlaceEvidenceTool(reader()).execute({ trip_id: SHORT, place: '1' }))
    expect(out).toContain('Senso-ji Temple')
    expect(out).toContain('confidence')
  })

  it('passes the resolver s ambiguity message through rather than guessing', async () => {
    const out = String(
      await getPlaceEvidenceTool(reader()).execute({ trip_id: SHORT, place: 'Shibuya' }),
    )
    expect(out).toContain('ambiguous')
  })

  it('needs a trip like the others', async () => {
    const out = String(await getPlaceEvidenceTool(reader()).execute({ place: '1' }))
    expect(out).toContain('Call list_trips')
  })
})
