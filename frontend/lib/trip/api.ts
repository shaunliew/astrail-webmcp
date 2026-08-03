import type { GenerateTripRequest, GenerateTripResponse, RequestSeatResponse, StreamEvent } from './backend-types'
// Mock-auth shell: generation runs against the offline fixture replay with zero backend
// (mirrors the MOCK_AUTH_ENABLED switches in middleware.ts and use-user.ts).
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import * as mockApi from '@/lib/trip/mock-api'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000'

// Thrown on any non-ok backend response. Carries the HTTP `status` and the backend error
// `code` (from the {"error":{"code","message"}} envelope) so callers can branch on a stable
// slug (e.g. classifyGenerateError → TrialExhaustedCard) instead of parsing message strings.
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// Build an ApiError from a non-ok Response: parse the {"error":{"code","message"}} envelope;
// on a non-JSON body or a shape mismatch, fall back to (status, "unknown", statusText) so a
// malformed error page never surfaces as a JSON parse error.
async function apiErrorFrom(res: Response): Promise<ApiError> {
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return new ApiError(res.status, 'unknown', res.statusText)
  }
  const err = (parsed as { error?: { code?: unknown; message?: unknown } } | null)?.error
  if (err && typeof err.code === 'string' && typeof err.message === 'string') {
    return new ApiError(res.status, err.code, err.message)
  }
  return new ApiError(res.status, 'unknown', res.statusText)
}

export async function generateTrip(
  req: GenerateTripRequest,
  accessToken: string
): Promise<GenerateTripResponse> {
  if (MOCK_AUTH_ENABLED) return mockApi.createTrip(req)
  const res = await fetch(`${BACKEND_URL}/generate-trip`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    throw await apiErrorFrom(res)
  }

  return res.json()
}

// POST /request-seat — idempotent beta-seat request (mirrors generateTrip's authed-POST shape,
// no body). The backend `coalesce`s repeat clicks to the original stamp, so this always resolves
// to {"requested_at": "<iso>"}. Non-ok responses throw an ApiError via the shared envelope parser.
export async function requestSeat(accessToken: string): Promise<RequestSeatResponse> {
  if (MOCK_AUTH_ENABLED) return { requested_at: MOCK_SEAT_REQUESTED_AT }
  const res = await fetch(`${BACKEND_URL}/request-seat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!res.ok) {
    throw await apiErrorFrom(res)
  }

  return res.json()
}

// Fixed stamp for the mock-auth shell — no wall-clock, so the offline flow is deterministic.
const MOCK_SEAT_REQUESTED_AT = '2026-01-01T00:00:00.000Z'

export function streamTrip(tripId: string, accessToken: string): EventSource {
  const url = new URL(`${BACKEND_URL}/generate-trip/stream/${tripId}`)
  url.searchParams.set('token', accessToken)
  return new EventSource(url.toString())
}

// EventSource wrapper matching the mock streamGeneration's { cancel } handle.
// The backend replays ALL events on each (re)connection (per-connection seen-set),
// so onReset fires on every open — callers clear their event list there to
// avoid duplicates after an auto-reconnect.
// onFail is the dead-backend escape hatch: EventSource auto-reconnects forever,
// so after 5 consecutive failed (re)connections we close and hand control back
// to the caller — otherwise a downed backend means an eternal "generating" screen.
export function streamGeneration(
  tripId: string,
  accessToken: string,
  onEvent: (e: StreamEvent) => void,
  onReset?: () => void,
  onFail?: () => void,
): { cancel: () => void } {
  if (MOCK_AUTH_ENABLED) return mockApi.streamGeneration(tripId, onEvent) // scripted replay; never resets/fails
  const es = streamTrip(tripId, accessToken)
  let consecutiveErrors = 0
  es.onopen = () => {
    consecutiveErrors = 0
    onReset?.()
  }
  es.onerror = () => {
    consecutiveErrors += 1
    if (consecutiveErrors >= 5) {
      es.close()
      onFail?.()
    }
  }
  es.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      es.close()
      return
    }
    try {
      onEvent(JSON.parse(msg.data) as StreamEvent)
    } catch {
      // malformed line — skip (contract: heartbeat comments never reach onmessage)
    }
  }
  return { cancel: () => es.close() }
}
