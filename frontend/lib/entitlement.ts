'use client'

// Single source of the free-trial / beta-seat entitlement logic (plan L815-829). The own-row
// read, the canonical-trip link, error classification, and the seat-request orchestration all
// live here so the flows (Task 9) consume one hook and never re-derive the rules.
import { useCallback, useEffect, useRef, useState } from 'react'
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import { createClient } from '@/lib/supabase/client'
import { getAccessToken } from '@/lib/supabase/session'
import { ApiError, requestSeat as apiRequestSeat } from '@/lib/trip/api'
import { listTrips } from '@/lib/trip/supabase-api'
import { ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'
import type { RequestSeatResponse, UserPlan } from '@/lib/trip/backend-types'

// A trial plan is exhausted once its lifetime trip count reaches this (backend TRIAL_LIFETIME_LIMIT).
export const TRIAL_LIFETIME_LIMIT = 1

export type Entitlement = {
  plan: UserPlan
  lifetimeTripCount: number
  seatRequestedAt: string | null
}

// Own-row read of the entitlement fields — RLS `users_select_own` scopes it to the signed-in
// user, so no explicit owner filter beyond the id. Throws on a missing session or missing row;
// the hook owns the fail-open decision (an advisory read must never block generation, plan L823).
// MOCK: a fresh trial account (0 trips) so the mock-auth shell always shows Generate.
export async function readEntitlement(): Promise<Entitlement> {
  if (MOCK_AUTH_ENABLED) return { plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null }
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  const { data } = await supabase
    .from('users')
    .select('plan, lifetime_trip_count, seat_requested_at')
    .eq('id', user.id)
    .maybeSingle()
  const row = data as
    | { plan?: UserPlan | null; lifetime_trip_count?: number | null; seat_requested_at?: string | null }
    | null
  if (!row) throw new Error('No entitlement row')
  return {
    plan: row.plan ?? 'trial',
    lifetimeTripCount: row.lifetime_trip_count ?? 0,
    seatRequestedAt: row.seat_requested_at ?? null,
  }
}

// The canonical trip for the "Open your trip" recovery link (r2-F5): the most-recent trip.
// listTrips() is ordered created_at desc and a trial-exhausted user has exactly one trip, so
// trips[0] is unambiguous. null when the user has no trips yet.
export async function fetchCanonicalTripId(): Promise<string | null> {
  const trips = await listTrips()
  return trips[0]?.id ?? null
}

// True only for the trial-exhausted ApiError — the signal to render TrialExhaustedCard instead
// of a generic error message (Task 9 wiring). A plain Error or any other code is false.
export function classifyGenerateError(err: unknown): boolean {
  return err instanceof ApiError && err.code === ERROR_CODE_TRIAL_EXHAUSTED
}

// Orchestration: resolve the access token, then POST /request-seat. Idempotent server-side.
export async function requestSeat(): Promise<RequestSeatResponse> {
  const token = await getAccessToken()
  return apiRequestSeat(token)
}

export type UseEntitlement = {
  loading: boolean
  isTrialExhausted: boolean
  seatRequested: boolean
  requestSeat: () => Promise<void>
  requesting: boolean
  canonicalTripId: string | null
  canonicalTripLoading: boolean
  // Re-read the own-row entitlement + canonical trip against current server state. Wired to a
  // generation terminal in the flows so a server-side refund (failed run → complete_trip_run) is
  // reflected without a full page reload. Fail-open and unmount-safe (see the hook).
  refetch: () => Promise<void>
}

// The consumer hook (plain useState/useEffect, no SWR). Loads the own-row entitlement and the
// canonical trip on mount, each with its own loading flag; `refetch()` re-runs both against
// current server state (wired to a generation terminal in the flows so a server-side refund is
// reflected without a reload). The own-row read fails open: on the initial load an error resolves
// to a fresh-trial state (isTrialExhausted false) so a downed advisory read shows Generate — the
// backend RPC is the real enforcer.
export function useEntitlement(): UseEntitlement {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null)
  const [loading, setLoading] = useState(true)
  const [seatRequested, setSeatRequested] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [canonicalTripId, setCanonicalTripId] = useState<string | null>(null)
  const [canonicalTripLoading, setCanonicalTripLoading] = useState(true)
  // Spans the whole mount (not one effect run) so `refetch` — called imperatively from a flow
  // long after mount — can guard its own setState against an unmount in flight. Re-armed on mount
  // so StrictMode's mount→unmount→mount leaves it true (same pattern as the flows' activeRef).
  const activeRef = useRef(true)

  // Load (or reload) both advisory reads. `initial` gates the loading flags AND the fallback
  // policy. On the FIRST load a rejected own-row read falls back to a fresh-trial state so a
  // downed read still shows Generate (fail-open, plan L823). On a REFETCH a rejected read leaves
  // the prior state untouched — a transient reread failure must NEVER flip an eligible user (post
  // -refund) back into a blocking isTrialExhausted=true. Both paths guard setState with activeRef.
  const load = useCallback(async (initial: boolean): Promise<void> => {
    await Promise.all([
      readEntitlement()
        .then((e) => {
          if (!activeRef.current) return
          setEntitlement(e)
          if (e.seatRequestedAt) setSeatRequested(true)
        })
        .catch(() => {
          // Initial: fresh-trial fallback (fail-open). Refetch: keep prior state (never re-block).
          if (initial && activeRef.current) {
            setEntitlement({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null })
          }
        })
        .finally(() => {
          if (initial && activeRef.current) setLoading(false)
        }),
      fetchCanonicalTripId()
        .then((id) => {
          if (activeRef.current) setCanonicalTripId(id)
        })
        .catch(() => {
          // Initial: null (no recovery link). Refetch: keep prior id (fail-open, same as above).
          if (initial && activeRef.current) setCanonicalTripId(null)
        })
        .finally(() => {
          if (initial && activeRef.current) setCanonicalTripLoading(false)
        }),
    ])
  }, [])

  useEffect(() => {
    activeRef.current = true
    void load(true)
    return () => {
      activeRef.current = false
    }
  }, [load])

  const isTrialExhausted =
    entitlement?.plan === 'trial' && entitlement.lifetimeTripCount >= TRIAL_LIFETIME_LIMIT

  async function requestSeatAction(): Promise<void> {
    setRequesting(true)
    try {
      await requestSeat()
      setSeatRequested(true)
    } finally {
      setRequesting(false)
    }
  }

  // Revalidate without flipping the initial loading flags: a background reread, not a re-mount.
  const refetch = useCallback(() => load(false), [load])

  return {
    loading,
    isTrialExhausted,
    seatRequested,
    requestSeat: requestSeatAction,
    requesting,
    canonicalTripId,
    canonicalTripLoading,
    refetch,
  }
}
