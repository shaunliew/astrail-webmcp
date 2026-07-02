import { describe, it, expect, vi } from 'vitest'
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration } from '@/lib/trip/mock-api'
import type { StreamEvent } from '@/lib/trip/backend-types'

describe('mock-api', () => {
  it('getTrip returns the Tokyo bundle for the demo id, null otherwise', async () => {
    const bundle = await getTrip('trip_tokyo_demo')
    expect(bundle?.trip.id).toBe('trip_tokyo_demo')
    expect(await getTrip('nope')).toBeNull()
  })

  it('listTrips returns at least the demo trip', async () => {
    const trips = await listTrips()
    expect(trips.some((t) => t.id === 'trip_tokyo_demo')).toBe(true)
  })

  it('getProfile returns the demo profile + facts', async () => {
    const { profile, facts } = await getProfile()
    expect(profile.id).toBe('demo-user')
    expect(facts.length).toBeGreaterThan(0)
  })

  it('submitFeedback resolves ok', async () => {
    const res = await submitFeedback({ trip_id: 'trip_tokyo_demo', artifact_type: 'trip', artifact_id: null, rating: 5 })
    expect(res.ok).toBe(true)
  })

  it('streamGeneration emits stage events then a terminal result', async () => {
    vi.useFakeTimers()
    const events: StreamEvent[] = []
    const handle = streamGeneration('trip_tokyo_demo', (e) => events.push(e))
    await vi.runAllTimersAsync()
    handle.cancel()
    vi.useRealTimers()
    expect(events.some((e) => e.type === 'stage')).toBe(true)
    expect(events.some((e) => e.type === 'heartbeat')).toBe(true)
    expect(events.at(-1)?.type).toBe('result')
  })
})
