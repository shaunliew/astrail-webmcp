import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

// Hoisted mock surface: the Supabase browser client (own-row read), listTrips (canonical trip),
// and getAccessToken (seat-request orchestration). apiRequestSeat's fetch is stubbed per test.
const h = vi.hoisted(() => {
  const getUser = vi.fn()
  const maybeSingle = vi.fn()
  const from = vi.fn()
  const createClient = vi.fn(() => ({ auth: { getUser }, from }))
  const listTrips = vi.fn()
  const getAccessToken = vi.fn()
  return { getUser, maybeSingle, from, createClient, listTrips, getAccessToken }
})

vi.mock('@/lib/supabase/client', () => ({ createClient: h.createClient }))
vi.mock('@/lib/trip/supabase-api', () => ({ listTrips: h.listTrips }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken: h.getAccessToken }))

import {
  classifyGenerateError,
  fetchCanonicalTripId,
  readEntitlement,
  useEntitlement,
} from '@/lib/entitlement'
import { ApiError } from '@/lib/trip/api'
import { ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'

type Row = { plan: string; lifetime_trip_count: number; seat_requested_at: string | null }

function stubRow(row: Row | null) {
  h.maybeSingle.mockResolvedValue({ data: row, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  h.getAccessToken.mockResolvedValue('jwt-token')
  h.listTrips.mockResolvedValue([])
  // Own-row read chain: from('users').select(...).eq('id', ...).maybeSingle()
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: h.maybeSingle }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  h.from.mockReturnValue(query)
})

describe('readEntitlement', () => {
  it('maps the snake_case own-row read into the camelCase shape', async () => {
    stubRow({ plan: 'beta', lifetime_trip_count: 3, seat_requested_at: '2026-08-01T00:00:00Z' })
    await expect(readEntitlement()).resolves.toEqual({
      plan: 'beta',
      lifetimeTripCount: 3,
      seatRequestedAt: '2026-08-01T00:00:00Z',
    })
    expect(h.from).toHaveBeenCalledWith('users')
  })

  it('scopes the read to the signed-in user id (RLS users_select_own)', async () => {
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: h.maybeSingle }
    query.select.mockReturnValue(query)
    query.eq.mockReturnValue(query)
    h.from.mockReturnValue(query)
    stubRow({ plan: 'trial', lifetime_trip_count: 0, seat_requested_at: null })

    await readEntitlement()

    expect(query.eq).toHaveBeenCalledWith('id', 'user-1')
  })

  it('throws when no row is returned (hook fails open on this)', async () => {
    stubRow(null)
    await expect(readEntitlement()).rejects.toThrow()
  })

  it('throws when there is no signed-in user', async () => {
    h.getUser.mockResolvedValue({ data: { user: null } })
    await expect(readEntitlement()).rejects.toThrow()
  })
})

describe('fetchCanonicalTripId', () => {
  it('returns the first (most-recent) trip id', async () => {
    h.listTrips.mockResolvedValue([{ id: 'trip-newest' }, { id: 'trip-older' }])
    await expect(fetchCanonicalTripId()).resolves.toBe('trip-newest')
  })

  it('returns null when the user has no trips', async () => {
    h.listTrips.mockResolvedValue([])
    await expect(fetchCanonicalTripId()).resolves.toBeNull()
  })
})

describe('classifyGenerateError', () => {
  it('is true only for an ApiError whose code is trial_exhausted', () => {
    expect(classifyGenerateError(new ApiError(403, ERROR_CODE_TRIAL_EXHAUSTED, 'x'))).toBe(true)
  })

  it('is false for an ApiError with a different code', () => {
    expect(classifyGenerateError(new ApiError(429, 'rate_limited', 'x'))).toBe(false)
  })

  it('is false for a plain Error even if its message says trial_exhausted', () => {
    expect(classifyGenerateError(new Error('trial_exhausted'))).toBe(false)
  })

  it('is false for non-error values', () => {
    expect(classifyGenerateError(null)).toBe(false)
    expect(classifyGenerateError('trial_exhausted')).toBe(false)
  })
})

describe('useEntitlement', () => {
  it('starts in the loading state before the reads settle', () => {
    // Pending reads: loading flags stay true.
    h.getUser.mockReturnValue(new Promise(() => {}))
    h.listTrips.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useEntitlement())

    expect(result.current.loading).toBe(true)
    expect(result.current.canonicalTripLoading).toBe(true)
    expect(result.current.isTrialExhausted).toBe(false)
  })

  it('marks a trial user with a spent trip as exhausted', async () => {
    stubRow({ plan: 'trial', lifetime_trip_count: 1, seat_requested_at: null })

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => {
      expect(result.current.loading).toBe(false)
      expect(result.current.canonicalTripLoading).toBe(false)
    })
    expect(result.current.isTrialExhausted).toBe(true)
    expect(result.current.seatRequested).toBe(false)
  })

  it('is not exhausted for a beta user', async () => {
    stubRow({ plan: 'beta', lifetime_trip_count: 5, seat_requested_at: null })

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isTrialExhausted).toBe(false)
  })

  it('is not exhausted for a trial user who has not spent their trip', async () => {
    stubRow({ plan: 'trial', lifetime_trip_count: 0, seat_requested_at: null })

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isTrialExhausted).toBe(false)
  })

  it('resolves the canonical trip id from listTrips()[0]', async () => {
    stubRow({ plan: 'trial', lifetime_trip_count: 1, seat_requested_at: null })
    h.listTrips.mockResolvedValue([{ id: 'trip-1' }, { id: 'trip-0' }])

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => expect(result.current.canonicalTripLoading).toBe(false))
    expect(result.current.canonicalTripId).toBe('trip-1')
  })

  it('fails open when the own-row read rejects (isTrialExhausted false, no throw)', async () => {
    h.maybeSingle.mockRejectedValue(new Error('read failed'))

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.isTrialExhausted).toBe(false)
  })

  it('reflects an already-stamped seat request on load', async () => {
    stubRow({ plan: 'trial', lifetime_trip_count: 1, seat_requested_at: '2026-08-02T12:00:00Z' })

    const { result } = renderHook(() => useEntitlement())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.seatRequested).toBe(true)
  })

  it('flips seatRequested true after a successful requestSeat() action', async () => {
    stubRow({ plan: 'trial', lifetime_trip_count: 1, seat_requested_at: null })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ requested_at: '2026-08-03T09:00:00.000Z' }),
      } as Response),
    )

    const { result } = renderHook(() => useEntitlement())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.seatRequested).toBe(false)

    await act(async () => {
      await result.current.requestSeat()
    })

    expect(result.current.seatRequested).toBe(true)
    expect(h.getAccessToken).toHaveBeenCalled()
  })
})
