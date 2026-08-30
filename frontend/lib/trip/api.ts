import type {
  AccountDeletionCancelResponse,
  AccountDeletionResponse,
  AccountDeletionStatusResponse,
  GenerateTripRequest,
  GenerateTripResponse,
  MemoryClearResponse,
  RequestSeatResponse,
  StreamEvent,
  TripFeedbackRequest,
  TripFeedbackResponse,
  TripPlace,
  Trip,
} from './backend-types'
// Mock-auth shell: generation runs against the offline fixture replay with zero backend
// (mirrors the MOCK_AUTH_ENABLED switches in middleware.ts and use-user.ts).
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import { resolveBackendUrl } from '@/lib/backend-url'
import * as mockApi from '@/lib/trip/mock-api'

const BACKEND_URL = resolveBackendUrl()

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

// Fixed 7-days-out schedule for the mock-auth deletion short-circuit — deterministic, no wall-clock.
const MOCK_DELETION_SCHEDULED_FOR = '2026-01-08T00:00:00.000Z'

// POST /account/deletion — enter the 7-day cancellable deletion grace for the AUTHENTICATED
// account (self-serve; no body — the backend reads identity from the token, never a
// client-supplied user id: guardrails #5/#6). Mirrors requestSeat's authed-POST shape. Non-ok
// responses throw an ApiError whose `status` + `code` let the caller branch distinctly: 503
// deletion_unavailable (gated off / not live) vs 409 deletion_not_active (already pending/deleting).
export async function requestAccountDeletion(accessToken: string): Promise<AccountDeletionResponse> {
  // Under the mock-auth demo shell there is no backend and the token is fake — short-circuit to a
  // deterministic mock success instead of firing a real network call (mirrors generateTrip /
  // requestSeat). The fixed schedule keeps the offline flow reproducible (no wall-clock).
  if (MOCK_AUTH_ENABLED) return { scheduled_for: MOCK_DELETION_SCHEDULED_FOR }
  const res = await fetch(`${BACKEND_URL}/account/deletion`, {
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

// POST /account/deletion/cancel — reverse a pending deletion for the AUTHENTICATED account.
// Only works before the sweeper claims the account into `deleting` (Task 3's point of no return):
// a claimed row throws ApiError(409, 'deletion_already_started'), which the UI reacts to by
// showing the in-progress state and disabling Cancel. 503 deletion_unavailable = gated off.
export async function cancelAccountDeletion(accessToken: string): Promise<AccountDeletionCancelResponse> {
  // Mock-auth shell: no backend, fake token — short-circuit to a mock success (mirrors the sibling
  // fns) so the demo never fires a real authed request.
  if (MOCK_AUTH_ENABLED) return { cancelled: true }
  const res = await fetch(`${BACKEND_URL}/account/deletion/cancel`, {
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

// GET /account/deletion/status — read the AUTHENTICATED account's deletion state (self-serve; no
// body — identity from the token, never a client-supplied user id: guardrails #5/#6) so a returning
// user is seeded onto the pending banner / locked in-progress state across sessions without an
// in-session request. Fail-safe by design: the backend returns ('active', null) when it can't read
// the real state, so this read never blocks the UI. The DeleteAccountCard fetches it on mount, and
// that card renders only behind NEXT_PUBLIC_DELETION_ENABLED — a hidden card never calls this.
export async function getAccountDeletionStatus(
  accessToken: string,
): Promise<AccountDeletionStatusResponse> {
  // Mock-auth shell: no backend, fake token — report a benign 'active' state without a network call
  // (mirrors the sibling deletion fns) so the demo shell never fires a real authed request.
  if (MOCK_AUTH_ENABLED) return { account_status: 'active', deletion_scheduled_for: null }
  const res = await fetch(`${BACKEND_URL}/account/deletion/status`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })

  if (!res.ok) {
    throw await apiErrorFrom(res)
  }

  return res.json()
}

// POST /settings/memory/clear — clear the caller's remembered mem0 preferences (self-serve; no
// body — identity from the token: guardrails #5/#6). STRICT by design (the inverse of the
// degrading GET /settings/preferences): the backend returns 200 {"cleared":true} ONLY on a
// verified clear, and otherwise a 503 with a DISTINCT code — memory_unavailable (nothing was
// deleted; safe to retry / service unreachable) vs memory_clear_unknown (attempted, could not be
// confirmed). A non-ok response throws an ApiError carrying that code so the caller surfaces each
// state honestly — never a fake success. While the backend's reconciliation gate is off it 503s
// memory_unavailable, so the button truthfully reports "couldn't reach" until go-live.
export async function clearMemory(accessToken: string): Promise<MemoryClearResponse> {
  if (MOCK_AUTH_ENABLED) return mockApi.clearMemory().then(() => ({ cleared: true }))
  const res = await fetch(`${BACKEND_URL}/settings/memory/clear`, {
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

// Client-side draft union (Codex r1 #7): narrower than the TripFeedbackRequest mirror (which
// stays 1:1 with the Pydantic model — guardrail #4). The union prevents invalid CONSTRUCTION — a
// fresh literal / buildDraft result can't be rating-without-a-value or rating-on-a-thumbs-row. It
// is NOT a structural firewall: an object assigned from a wider value could still carry extra keys
// past the union, so the real guarantee is "drafts built by buildDraft / object literals", enforced
// by the exact-key serialization tests (lib/trip/__tests__/trip-feedback-api.test.ts). Every member
// stays assignable to TripFeedbackRequest — pinned at compile time by _DraftAssignableToRequest below.
export type TripFeedbackDraft =
  | { feedback_type: 'thumbs_up' | 'thumbs_down'; comment?: string }
  | { feedback_type: 'rating'; rating: 1 | 2 | 3 | 4 | 5; comment?: string }
  | { feedback_type: 'free_text'; comment: string }

type _Assert<T extends true> = T
// Compile-time pin (guardrail #4): every TripFeedbackDraft member must stay assignable to the
// backend mirror. tsc fails here if a future mirror change breaks assignability.
type _DraftAssignableToRequest = _Assert<TripFeedbackDraft extends TripFeedbackRequest ? true : false>

// Deterministic id for the mock-auth shell — no wall-clock, no randomness.
const MOCK_FEEDBACK_ID = 'mock-feedback-1'

// POST /trips/{tripId}/feedback — append-only trip-level feedback, ONE request per user action
// (a thumbs/rating signal may carry the note in the same row; backend allows optional comment
// there). Strict cross-field 422s live behind the draft union; ownership is 404-not-403; 429 =
// BURST_LIMIT (3/min default). Resubmission inserts a new row by design (analytics take
// latest-per-user), so callers may POST again to change a verdict.
export async function submitTripFeedback(
  tripId: string,
  req: TripFeedbackDraft,
  accessToken: string
): Promise<TripFeedbackResponse> {
  // Mock-auth shell: no backend — echo a deterministic persisted-row shape (mirrors requestSeat).
  if (MOCK_AUTH_ENABLED) {
    return {
      feedback: {
        id: MOCK_FEEDBACK_ID,
        trip_id: tripId,
        artifact_type: 'trip',
        feedback_type: req.feedback_type,
        rating: 'rating' in req ? req.rating : null,
        comment: req.comment ?? null,
      },
    }
  }
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}/feedback`, {
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

// ---- WebMCP itinerary edits (backend endpoints are flag-gated by WEBMCP_EDITS_ENABLED) ----
// Owner checks live server-side and return 404 (never 403) so a caller cannot probe which trip
// ids exist. 409 means the trip is not in an editable state — usually a generation still running,
// which would otherwise clobber the edit when the pipeline writes its itinerary.

export type TripPlaceEditResult = { trip_place: TripPlace; days_touched: number[] }
export type TripPlaceDeleteResult = { removed_id: string; days_touched: number[] }

export async function editTripPlace(
  tripId: string,
  tripPlaceId: string,
  patch: { day_number?: number; sort_order?: number },
  accessToken: string,
): Promise<TripPlaceEditResult> {
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}/places/${tripPlaceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await editErrorMessage(res))
  return (await res.json()) as TripPlaceEditResult
}

export async function deleteTripPlace(
  tripId: string,
  tripPlaceId: string,
  accessToken: string,
): Promise<TripPlaceDeleteResult> {
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}/places/${tripPlaceId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(await editErrorMessage(res))
  return (await res.json()) as TripPlaceDeleteResult
}

/** Turns the backend error envelope into something an agent can relay to a person. */
async function editErrorMessage(res: Response): Promise<string> {
  let code = ''
  let message = ''
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    code = body?.error?.code ?? ''
    message = body?.error?.message ?? ''
  } catch {
    /* non-JSON error body */
  }
  // A 404 here has two very different causes and the caller cannot tell them apart: the trip or
  // stop genuinely does not exist, OR this deployment has WEBMCP_EDITS_ENABLED unset, in which
  // case the backend hides the whole write surface behind the same bare 404 (main.py:_require_webmcp_edits_enabled).
  // Saying only "not found" makes a correctly-disabled deployment look broken to an agent that is
  // staring at the trip it was asked to edit. Name both, so nobody debugs the wrong one.
  if (res.status === 404)
    return 'That trip or stop was not found — or trip editing is not enabled on this deployment.'
  if (res.status === 409) {
    return message || 'This trip cannot be edited right now — it may still be generating.'
  }
  if (res.status === 422) return message || 'Nothing to change.'
  return message || code || `Request failed (${res.status}).`
}

export type AddTripPlaceResult = { trip_place: TripPlace; days_touched: number[] }
export type EditTripDatesResult = { trip: Trip; days_touched: number[] }

export async function addTripPlace(
  tripId: string,
  body: { name: string; day_number: number; position?: number | null; lat?: number | null; lng?: number | null },
  accessToken: string,
): Promise<AddTripPlaceResult> {
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}/places`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await editErrorMessage(res))
  return (await res.json()) as AddTripPlaceResult
}

export async function editTripDates(
  tripId: string,
  body: { start_date?: string | null; end_date?: string | null },
  accessToken: string,
): Promise<EditTripDatesResult> {
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await editErrorMessage(res))
  return (await res.json()) as EditTripDatesResult
}

export type ReplanTripResult = { days_narrated: number; routes_refreshed: boolean }

/**
 * How long a rewrite may run before the browser stops waiting for it.
 *
 * Generous on purpose — the endpoint refreshes routes and then narrates the whole trip, which
 * measured around 30 seconds for two days, so a long trip on a slow model must not be cut off
 * mid-narration. The bound exists for the case where the answer never fully arrives: this is the
 * one call in the app whose promise is HELD, in `GlobalTools`\' per-trip map, to stop a second
 * rewrite starting. A call that never settles therefore does not merely lose one rewrite — the
 * map entry is never cleared, so the follow-up that a later edit queued behind it never starts,
 * and the trip\'s prose is frozen for the rest of the session while the UI insists it is being
 * updated. A timeout turns that into an honest failure.
 *
 * Which is why the bound has to cover the WHOLE call and not the header round-trip. The first
 * version cleared the timer in a `finally` attached to the fetch alone, so `res.json()` — and
 * `editErrorMessage`\'s read of the error body — ran with no bound at all. A server or proxy that
 * returns headers and then stalls the body reaches exactly the wedge described above, past a
 * timeout that has already disarmed itself.
 */
const REPLAN_TIMEOUT_MS = 120_000

/**
 * What the user is told when it runs out. The whole message is a statement of UNCERTAINTY, and
 * that is the point rather than a hedge.
 *
 * It has now been wrong in both directions. "The trip itself is unchanged" was false because
 * `/trips/{id}/replan` refreshes the routes BEFORE it narrates (backend/main.py) and aborting a
 * browser fetch neither rolls that back nor stops the server task. Replacing it with "the routes
 * were already refreshed" was the same mistake mirrored: a stall can happen before the request
 * ever reaches FastAPI, in which case nothing was refreshed and nothing is running. From here
 * both are guesses, so the honest thing is to say which way it MIGHT have gone and stop.
 *
 * It also does not say "try again". A second rewrite started now can finish before the one the
 * server may still be working on, which lets the OLDER snapshot\'s prose land last and overwrite
 * the newer — the same stale write the per-trip queue prevents, arriving from the one direction
 * the client cannot see.
 */
const REPLAN_TIMED_OUT =
  'Astrail stopped waiting for the summaries to be rewritten. The rewrite may still be finishing on the server and the trip may already have changed, so re-read it in a moment rather than starting another.'

/**
 * Re-routes the trip and rewrites its day summaries.
 *
 * Costs an LLM call and nothing from the user's trip allowance (`/trips/{id}/replan` has no quota
 * reserve and no entitlement check, only the burst limiter). Every itinerary edit now starts one
 * of these on its own, so it is no longer approval-gated on that path — but it must never be
 * SILENT: go through `GlobalTools`, which coalesces this tab's rewrites for a trip into one and
 * puts them on the activity rail, rather than calling this directly. Another tab counts its own.
 */
export async function replanTrip(tripId: string, accessToken: string): Promise<ReplanTripResult> {
  // AbortController rather than AbortSignal.timeout: the latter is absent in some of the
  // environments this runs under, and a silently-undefined signal is exactly no bound at all.
  const controller = new AbortController()
  const bell = setTimeout(() => controller.abort(), REPLAN_TIMEOUT_MS)
  /* A refusal we read off a real status line, kept apart from everything else in this function.
     `editErrorMessage` swallows its own failed body read and still derives the right message from
     `res.status`, so a backend that answers 409 and then stalls its error body produces a correct,
     specific refusal — which the abort check below would otherwise throw away and replace with a
     timeout sentence guessing that the routes were refreshed, when the editability guard had in
     fact refused before touching anything. A named 409 beats a guessed timeout: the status is
     evidence, the timeout is an inference. */
  let refusal: Error | null = null
  try {
    const res = await fetch(`${BACKEND_URL}/trips/${tripId}/replan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
    // Both reads are inside the bound, deliberately: each consumes the response BODY, which is
    // the half a stalled proxy holds open.
    if (!res.ok) {
      refusal = new Error(await editErrorMessage(res))
      throw refusal
    }
    return (await res.json()) as ReplanTripResult
  } catch (e) {
    if (e === refusal) throw e
    // An abort surfaces as a DOMException named AbortError, whose own message ("The operation was
    // aborted") tells a user nothing about what was attempted or what it left behind. Checked on
    // the SIGNAL rather than on the error, because an aborted body read on the SUCCESS path
    // arrives here as a bare AbortError with no status behind it.
    if (controller.signal.aborted) throw new Error(REPLAN_TIMED_OUT)
    throw e
  } finally {
    clearTimeout(bell)
  }
}
