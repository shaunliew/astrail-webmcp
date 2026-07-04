import { describe, it, expect, vi } from 'vitest'
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip, saveProfile } from '@/lib/trip/mock-api'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

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

  it('cancel() before timers fire suppresses all events', () => {
    vi.useFakeTimers()
    const events: StreamEvent[] = []
    const handle = streamGeneration('trip_tokyo_demo', (e) => events.push(e))
    handle.cancel()
    vi.runAllTimers()
    vi.useRealTimers()
    expect(events).toHaveLength(0)
  })
})

describe('createTrip', () => {
  it('returns the demo trip id for a request with at least one reel', async () => {
    const res = await createTrip({
      reel_urls: ['https://www.instagram.com/reel/AAA/'], requested_places: [],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })
    expect(res.trip_id).toBe(TOKYO_TRIP.trip.id)
  })

  it('accepts a request with only a requested place', async () => {
    const res = await createTrip({
      reel_urls: [], requested_places: ['Tokyo Disneyland'],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })
    expect(res.trip_id).toBe(TOKYO_TRIP.trip.id)
  })

  it('rejects a request with no reels and no requested places', async () => {
    await expect(createTrip({
      reel_urls: [], requested_places: [],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })).rejects.toThrow(/at least one/i)
  })
})

describe('saveProfile', () => {
  it('returns a completed profile echoing the onboarding input', async () => {
    const res = await saveProfile({
      origin_city: 'Tokyo',
      travel_style_tags: ['food-led', 'walkable'],
      preference_tags: ['ramen'],
      preference_notes: 'avoid rushing',
    })
    expect(res.onboarding_completed).toBe(true)
    expect(res.origin_city).toBe('Tokyo')
    expect(res.travel_style_tags).toEqual(['food-led', 'walkable'])
    expect(res.preference_tags).toEqual(['ramen'])
    expect(res.preference_notes).toBe('avoid rushing')
  })

  it('accepts null origin and notes and still completes onboarding', async () => {
    const res = await saveProfile({
      origin_city: null, travel_style_tags: [], preference_tags: [], preference_notes: null,
    })
    expect(res.onboarding_completed).toBe(true)
    expect(res.origin_city).toBeNull()
  })
})
