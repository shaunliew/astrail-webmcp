"""Astrail FastAPI app — health, trip generation, and SSE streaming.

POST /generate-trip authenticates via the Authorization header and is
idempotent: a request-derived key (jobs.compute_idempotency_key) means a
retried POST replays the existing trip instead of creating a duplicate. When
two same-key POSTs race, enqueue_job's atomic insert picks exactly one
winner; the loser deletes its own orphan trip (owner-filtered) and redirects
to the winner's trip_id WITHOUT dispatching a second run_generation.

GET /generate-trip/stream/{trip_id} authenticates via a ?token= query param
(browser EventSource cannot set headers, with a header fallback), verifies
trip ownership (guardrail #6), and streams generation_events as SSE. That token
is redacted out of the access log by log_redaction (ISSUES-B1).
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ConfigDict
from slowapi.errors import RateLimitExceeded

from api.errors import build_error_response, register_error_handlers
from api.schemas import (
    AccountDeletionCancelResponse,
    AccountDeletionResponse,
    AccountDeletionStatusResponse,
    CaptureSavedReelRequest,
    CaptureSavedReelResponse,
    GenerateTripRequest,
    GenerateTripResponse,
    MemoryClearResponse,
    MemoryFact,
    OrganizeJobStatus,
    OrganizeSavedReelsRequest,
    OrganizeSavedReelsResponse,
    RequestSeatResponse,
    SettingsPreferencesResponse,
    TripFeedback,
    TripFeedbackRequest,
    TripFeedbackResponse,
)
from api.streaming import stream_organize_events, stream_trip_events
from auth import get_current_user_id, get_user_id_from_query_or_header
# Shared fail-open generation-freeze read (plan §3.6). Kept in deletion.py so all three generation
# entrypoints (generate_trip, organize, the Telegram worker) call ONE implementation; the leading
# underscore preserves the in-module name the existing tests reference.
from deletion import account_is_pending_deletion as _account_is_pending_deletion
from config_validation import validate_required_secrets
from jobs import compute_idempotency_key, enqueue_job, reclaim_expired_jobs
from log_redaction import install as _install_log_redaction
from observability import capture_exception as _sentry_capture, init_sentry as _init_sentry
from pipeline.runner import record_event, run_generation
from preferences import compose_preference_summary, fetch_traveler_profile
from rate_limit import (
    BURST_LIMIT,
    DAILY_TRIP_QUOTA,
    ENTITLEMENTS_ENABLED,
    SAVE_LIMIT,
    TRIAL_LIFETIME_LIMIT,
    check_and_increment_daily_quota,
    get_current_user_id_stashed,
    limiter,
    refund_daily_quota,
    reserve_and_enqueue_trip_job,
)
from saved_reels import capture_saved_reel
from organizer import (
    ActiveOrganizeConflict,
    InvalidOrganizeRequest,
    create_organize_job,
    get_organize_status,
    recover_organize_jobs,
    run_organize_job,
)
from supabase_client import get_supabase_client

_RECOVERY_TASKS: set = set()
_RECOVERY_SEM = asyncio.Semaphore(3)   # bound boot fan-out so a backlog doesn't stampede Apify/OpenAI/DB
REAP_INTERVAL_S = 120

logger = logging.getLogger(__name__)

# ISSUES-B1: strip `?token=<JWT>` out of uvicorn's access log. At import, because Dockerfile:25
# starts uvicorn with DEFAULT access logging (no --no-access-log, no --log-config) — this filter
# is the whole mechanism, and module import completes before the first request is served.
_install_log_redaction()
# ISSUES-B1 re-add: optional error monitoring, DORMANT unless SENTRY_DSN is set. The
# before_send scrubber (observability.py) is what closes the `?token=` capture hole that
# got Sentry removed; init here so the SDK is armed before the first request/background task.
_init_sentry()


def _spawn(coro) -> asyncio.Task:
    """Create a background task and RETAIN a reference to it until it finishes.

    `asyncio.create_task` returns the only strong reference — the event loop does not keep
    one — so a fire-and-forget task can be garbage-collected mid-flight and simply stop, with
    no error anywhere. For a recovery re-dispatch that is a silently dropped run; for the
    reaper it is the end of all periodic reclaim. The done-callback discards the reference so
    the set cannot grow without bound.
    """
    task = asyncio.create_task(coro)
    _RECOVERY_TASKS.add(task)
    task.add_done_callback(_RECOVERY_TASKS.discard)
    return task


async def _redispatch_organize(client, job: dict) -> None:
    """Bound organize re-dispatch with the same recovery semaphore as trips (ISSUES-B4).

    Without it a boot backlog of reclaimed organize jobs fans out all at once and stampedes
    Apify/OpenAI/Mapbox and the DB — exactly what the trip-side bound already prevents.
    """
    async with _RECOVERY_SEM:
        await run_organize_job(job["id"], job["user_id"], client=client)


async def _run_deletion_sweep(client) -> None:
    """The reaper's account-deletion branch. NO-OP unless the execution gate is live.

    Gated OFF through Task 6: while `_DELETION_EXECUTION_READY` is False this returns before
    importing or touching anything, so the two-pass delete engine never runs — the sweep is
    inert until the same PR that builds notifications + the live E2E proof flips the flag.
    Kept a separate function (called in its OWN try in `_reap_loop`) so a deletion failure can
    never skip trip/organize job recovery, and so the gate is unit-testable in isolation.
    """
    if not _DELETION_EXECUTION_READY:
        return
    from deletion_engine import sweep_due_deletions

    await sweep_due_deletions(client)


async def _reap_loop(client) -> None:
    """Reclaim expired leases on a timer, not only at boot.

    Boot-time recovery alone leaves a guardrail #12 silent drop: a job that crashed with an
    UNEXPIRED lease is skipped at boot — correctly, since at that instant it is
    indistinguishable from one a live instance owns — and nothing ever rechecked it, so it
    stayed `running` forever with no terminal event and no retry.

    Concurrent reapers across instances are safe: every reclaim is one atomic UPDATE whose
    predicate re-evaluates against the current row, and every claim after it is a CAS.

    NO `clock` SEAM. Both sweeps now compare against `clock_timestamp()` inside Postgres, so
    this process's own clock has no bearing on which leases are expired — which is the point:
    a reaper here injecting an instant is exactly how a skewed instance used to reclaim leases
    another instance was still holding. Tests drive expiry by moving the fake DATABASE's clock.
    """
    while True:
        await asyncio.sleep(REAP_INTERVAL_S)
        try:
            for job in await reclaim_expired_jobs(client=client):
                _spawn(_redispatch(client, job))
            for job in await recover_organize_jobs(client):
                _spawn(_redispatch_organize(client, job))
        except Exception as exc:
            # A DB blip must NEVER kill the reaper — a reaper that dies on its first
            # transient error is worse than none, because nothing after it says so.
            logger.warning("reap_loop_iteration_failed", exc_info=True)
            _sentry_capture(exc)   # already exposed via exc_info above; scrubbed en route to Sentry
        # Account-deletion sweep in its OWN try: a deletion error must never skip the trip/
        # organize recovery above (they are the load-bearing guardrail #12 path). No-op while
        # the gate is off. Same cadence as the reclaim sweeps (this shares the 120s tick).
        try:
            await _run_deletion_sweep(client)
        except Exception as exc:  # noqa: BLE001 — TYPE only: a postgrest/supabase traceback can
            # carry connection details, so this deletion path stays on the arc's type-only
            # discipline (never exc_info / the message). The row stays selected and retries next tick.
            logger.warning("deletion_sweep_iteration_failed error=%s", type(exc).__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Guardrail #12: on boot, re-queue and re-run anything a crash left mid-flight
    (restart-with-cache-reuse, NOT resume — a reclaimed job re-executes from Phase 1), then
    keep reclaiming on a timer so a crash inside the TTL is picked up rather than dropped.
    A boot-time DB blip must DEGRADE, not crash startup: the app must still start and
    serve /health even if Supabase is unreachable; the next sweep re-picks pending jobs."""
    # BEFORE the broad `try` — deliberately. Inside it, `except Exception: pass` would
    # swallow a missing secret and boot a broken app. A config error must be fatal; a DB
    # blip must not be. See config_validation for why an unbootable app beats the
    # deterministic pre-claim retry loop that `_fail`'s token skip would otherwise open.
    validate_required_secrets()
    reaper = None
    try:
        client = await get_supabase_client()
        # Started BEFORE the boot sweeps: a sweep blip (the likely boot failure) must not
        # cost this process its periodic reclaim for the rest of its life.
        reaper = _spawn(_reap_loop(client))
        for job in await reclaim_expired_jobs(client=client):
            _spawn(_redispatch(client, job))
        for job in await recover_organize_jobs(client):
            _spawn(_redispatch_organize(client, job))
    except Exception:
        pass   # boot-time DB blip must not down the app; the reaper re-picks pending jobs
    # OUTSIDE the Supabase try, deliberately. This warm used to live INSIDE it, so any
    # boot-time DB blip (get_supabase_client or either sweep raising) jumped straight to the
    # except and skipped the warm entirely — leaving /readiness reporting `not_initialized`
    # with a perfectly good key until the first trip lazily built the client, which is
    # misleading in precisely the way the mem0 readiness field exists to prevent. Kept AFTER
    # the sweeps so the 8s construction timeout never delays guardrail #12 job recovery.
    try:
        from mem0_client import get_mem0_client
        await get_mem0_client()   # warm once so the first trip skips the blocking ping
    except Exception:
        pass   # memory is best-effort; a warm failure must never down the app
    try:
        yield
    finally:
        if reaper is not None:
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper


app = FastAPI(title="Astrail Backend", lifespan=lifespan)

app.state.limiter = limiter


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    # Reuse the shared envelope builder (DRY — F3), then inject Retry-After /
    # X-RateLimit-* (the Limiter was created with headers_enabled=True).
    response = build_error_response(429, f"Too many requests: {exc.detail}", code="rate_limited")
    return request.app.state.limiter._inject_headers(response, request.state.view_rate_limit)


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
register_error_handlers(app)

# The fallback must list every origin the app is actually SERVED from, because it is what applies
# when ALLOWED_ORIGINS is unset — and a missing origin here fails as a browser CORS block, i.e. trip
# generation silently dying for users on that host. Verified live 2026-08-07: astrail.xyz and
# app.astrail.xyz both serve the identical Vercel build; www.astrail.xyz has NO DNS record and is
# kept only so adding that record later needs no code change.
_allowed_origins = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://astrail.xyz,https://www.astrail.xyz,https://app.astrail.xyz",
    ).split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class _CaptureSavedReelRequest(CaptureSavedReelRequest):
    model_config = ConfigDict(extra="forbid")


class _TripFeedbackRequest(TripFeedbackRequest):
    model_config = ConfigDict(extra="forbid")


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/readiness")
async def readiness():
    """Deep readiness probe: confirms Supabase is reachable, and reports mem0's
    CONFIGURATION state. NOT the deploy gate (that is /health) — neither a DB blip nor a
    mem0 outage should fail a rolling deploy.

    Uses mem0_status(), which observes the singleton without constructing it: calling
    get_mem0_client() here would retry an 8s blocking constructor on every poll during a
    mem0 outage. mem0 is reported, never required — MEM0_API_KEY deliberately stays OUT of
    REQUIRED_SECRETS (guardrail #3). Before this field existed, an unset or mistyped key
    left the service fully green while memory silently did nothing, which is how the
    2026-08-02 'mem0 is not working' report became undiagnosable from the outside.
    """
    from mem0_client import mem0_status

    mem0_state = mem0_status()
    try:
        client = await get_supabase_client()
        await client.table("users").select("id").limit(1).execute()
        return {"ready": True, "mem0": mem0_state}
    except Exception:
        return JSONResponse(status_code=503, content={"ready": False, "mem0": mem0_state})


@app.get("/settings/preferences", response_model=SettingsPreferencesResponse)
@limiter.limit(BURST_LIMIT)
async def get_settings_preferences(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
) -> SettingsPreferencesResponse:
    """PRD §18. The user's STORED mem0 memories, read live. Degrades rather than erroring
    (guardrail #3): `status` carries the bad news so an unrelated settings screen still
    renders. Not identical to a generation's recall — see list_memory_facts."""
    from mem0_client import get_mem0_client, mem0_status
    from pipeline.preferences import list_memory_facts

    status, facts = await list_memory_facts(await get_mem0_client(), user_id)
    # A None client means EITHER "no key" OR "key set but construction failed", and
    # list_memory_facts cannot tell them apart — it only sees None. Only the first is
    # genuinely `disabled`. Reporting "memory is off by configuration" during a mem0
    # OUTAGE is the precise misdiagnosis this arc exists to remove, and it would also
    # contradict /readiness, which says `init_failed` for the same state.
    if status == "disabled" and mem0_status() == "init_failed":
        status = "unavailable"
    return SettingsPreferencesResponse(
        status=status, facts=[MemoryFact(**f) for f in facts])


_CLEAR_FAILURE_MESSAGE = {
    "unavailable": "Memory could not be cleared. Nothing was deleted — please try again.",
    "unknown": "We could not confirm whether your memory was cleared. Refresh this page to "
               "see the current state; do not retry blindly.",
}

# ---------------------------------------------------------------------------------------
# THE CLEAR ROUTE IS DELIBERATELY GATED OFF. Do not flip this without reading why.
#
# Codex's cross-model code review returned DO-NOT-MERGE on this endpoint, and it was right.
# `cleared: true` promises a postcondition ("your memory is now empty") that we cannot yet
# keep, because TWO unbounded delays sit between us and mem0, both MEASURED on 2026-08-03:
#   1. mem0's own add queue — an add sat PENDING for 17 minutes, 33x the 30s visibility
#      window. Our own live smoke reproduced the failure: it added, the clear answered
#      `cleared`, and the adds were still queued afterwards.
#   2. our own event loop — `asyncio.wait_for` bounds each await's DURATION, not the gaps
#      between them, so a stall ages an in-flight add out of view with mem0 perfectly
#      healthy.
# No finite window closes either. A route that can emit a `cleared` it cannot stand behind
# is precisely the lie this whole arc exists to delete, so it stays shut.
#
# WHAT DOES SHIP: the engine (pipeline/memory_clear.py) and the write-back interlock
# (pipeline/preferences.py) are complete, reviewed and fully exercised by the suite — the
# interlock is a real improvement to every generation and runs in production from day one.
#
# TO ENABLE: land durable reconciliation of mem0's returned event ids (its V3 add response
# carries `event_id`; the completion mechanism is the events endpoint, which the installed
# Python SDK does not expose — so it needs a small raw-HTTP adapter plus a reconciler that
# is SEPARATE from trip-job terminal state, because the write-back runs after the job is
# terminal). Then flip this to True IN THE SAME PR, and re-run
# scripts/smoke_memory_clear.py — which itself must first be taught to reconcile accepted
# event ids, or it will keep leaving provider-side data for a deleted test entity.
_CLEAR_RECONCILIATION_READY = False

_CLEAR_GATED_MESSAGE = (
    "Clearing saved memory is temporarily unavailable while we make deletion verifiable. "
    "Nothing was deleted."
)

# ---------------------------------------------------------------------------------------
# ACCOUNT-DELETION IS DELIBERATELY GATED OFF (Task 2 of the lean account-deletion arc).
#
# The schema, the request/cancel RPCs, and these two endpoints ship FIRST, but the delete
# ENGINE + sweep that actually acts on `pending_deletion`/`deleting` accounts is Task 3, and
# the notification emails are Task 4. Entering an account into a 7-day grace that nothing
# will act on would be a lie of its own, so both endpoints fail-closed with 503 until Task 6
# builds the rest and flips this to True IN THE SAME PR as the live E2E proof. Fail-closed:
# a missing RPC (a migration lagging a deploy) 503s the same way.
_DELETION_EXECUTION_READY = False

_DELETION_GATED_MESSAGE = (
    "Account deletion isn't available yet. Nothing on your account was changed."
)


@app.post("/settings/memory/clear", response_model=MemoryClearResponse)
@limiter.limit(BURST_LIMIT)
async def clear_settings_memory(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
):
    """PRD §824. STRICT by design — the deliberate inverse of GET /settings/preferences,
    which degrades (guardrail #3). Never reports a clear it did not verify."""
    from mem0_client import get_mem0_client
    from pipeline.memory_clear import clear_memory        # NOT pipeline.preferences (A17)

    if not _CLEAR_RECONCILIATION_READY:
        # `memory_unavailable`, NOT `memory_clear_unknown`: that code means "CONFIRMED
        # nothing was deleted", which is exactly and provably true when we do not attempt.
        # Reporting `unknown` would claim an uncertainty we do not actually have — a small
        # lie in the opposite direction, and this endpoint exists to stop lying.
        # Returns BEFORE touching Supabase or mem0: nothing is attempted, nothing is spent.
        return build_error_response(503, _CLEAR_GATED_MESSAGE, code="memory_unavailable")

    try:
        client = await get_supabase_client()
    except Exception:                                     # noqa: BLE001 — A7
        # Without a client we cannot arm the guard, so nothing is deleted. Truthful AND
        # inside the documented contract; the global handler's 500 would be neither.
        return build_error_response(
            503, _CLEAR_FAILURE_MESSAGE["unavailable"], code="memory_unavailable")

    outcome = await clear_memory(client, await get_mem0_client(), user_id=user_id)
    if outcome == "cleared":
        return MemoryClearResponse()
    # Returned, not raised: _STATUS_CODE_SLUG (api/errors.py) has no 503 entry, so
    # HTTPException(503) would emit code "error" and collapse the two failure codes into
    # one. Precedent: the rate-limit handler above does exactly this for 429.
    code = "memory_unavailable" if outcome == "unavailable" else "memory_clear_unknown"
    return build_error_response(503, _CLEAR_FAILURE_MESSAGE[outcome], code=code)


@app.post("/saved-reels", response_model=CaptureSavedReelResponse)
@limiter.limit(SAVE_LIMIT)
async def create_saved_reel(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True (see generate_trip)
    req: _CaptureSavedReelRequest,
    user_id: str = Depends(get_current_user_id_stashed),  # stashes request.state.user_id for key_func
) -> CaptureSavedReelResponse:
    client = await get_supabase_client()
    try:
        saved_reel = await capture_saved_reel(client, user_id, req.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="A valid Instagram Reel or post URL is required") from exc
    return CaptureSavedReelResponse(saved_reel=saved_reel)


@app.post("/trips/{trip_id}/feedback", response_model=TripFeedbackResponse, status_code=201)
@limiter.limit(BURST_LIMIT)
async def submit_trip_feedback(
    request: Request,          # must be named `request` — slowapi's key_func resolves it by name
    response: Response,        # required: the limiter is headers_enabled=True
    trip_id: UUID,             # UUID (not str) so a malformed id is a 422, never a Postgres 500
    req: _TripFeedbackRequest,
    user_id: str = Depends(get_current_user_id_stashed),
) -> TripFeedbackResponse:
    """Trip-level feedback (PRD §18, PRD:86 beta adoption metric).

    Append-only: a resubmission inserts another row rather than replacing. The table has
    no unique constraint, and a user who rates 2 then 5 after re-reading the itinerary is
    signal worth keeping; analytics take latest-per-user via feedback_user_id_created_at_idx.

    Owner check is app-code, NOT RLS: this backend connects with service_role, which is
    exempt from every RLS policy (persist.py:515). feedback_insert_own_trip is a backstop
    for a future direct-from-frontend path only.
    """
    trip_key = str(trip_id)
    client = await get_supabase_client()

    owner = await client.table("trips").select("user_id").eq("id", trip_key).maybe_single().execute()
    # `owner is None` is load-bearing, NOT defensive noise. postgrest 2.31.0's
    # AsyncMaybeSingleRequestBuilder.execute() returns a bare None when zero rows match
    # (request_builder.py:167: `if len(parsed.data) == 0: return None`) -- NOT an object whose
    # .data is None. Dereferencing owner.data would AttributeError into a 500, which leaks an
    # existence oracle: 500 = no such trip, 404 = exists but not yours. This matches the repo's
    # majority convention (jobs.py:80, generate_trip's replay precheck below,
    # organizer.py:184) -- the `stream` route was the one outlier, fixed in 124417b.
    if owner is None or owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6
        raise HTTPException(status_code=404, detail="Trip not found")  # 404 not 403: do not confirm existence

    inserted = await client.table("feedback").insert({
        "trip_id": trip_key,
        "user_id": user_id,               # from the token, never the body
        "artifact_type": "trip",          # trip-level scope; artifact-level is a later, additive arc
        "artifact_id": None,
        "feedback_type": req.feedback_type,
        "rating": req.rating,
        "comment": req.comment,
        # PRD:1035's source_type / generation_stage / preference_source stay NULL for
        # trip-level feedback -- they describe how an ARTIFACT was generated.
        "source_type": None,
        "generation_stage": None,
        "preference_source": None,
    }).execute()

    if not inserted.data:
        raise HTTPException(status_code=500, detail="Failed to store feedback")

    # Build the response from the PERSISTED row, not from the request (plan-eng-review A2).
    # Echoing req.* would make the 201 body incapable of ever reporting a persistence bug:
    # it would look correct even if the row were wrong. Every field read here is part of the
    # insert payload above, so it is present in BOTH the real client and the _Table test fake
    # (only created_at would diverge, which is why the response omits it).
    row = inserted.data[0]
    return TripFeedbackResponse(
        feedback=TripFeedback(
            id=str(row["id"]),
            trip_id=str(row["trip_id"]),
            artifact_type=row["artifact_type"],
            feedback_type=row["feedback_type"],
            rating=row["rating"],
            comment=row["comment"],
        )
    )


@app.post("/generate-trip", response_model=GenerateTripResponse)
@limiter.limit(BURST_LIMIT)
async def generate_trip(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True: slowapi
    req: GenerateTripRequest,                             #   injects X-RateLimit-*/Retry-After into it on
    background: BackgroundTasks,                          #   the success path — without a `response` kwarg
    user_id: str = Depends(get_current_user_id_stashed),  #   _inject_headers(None, ...) breaks every call.
) -> GenerateTripResponse:                               # (the dep stashes request.state.user_id for key_func)
    client = await get_supabase_client()
    # Generation freeze (plan §3.6): a pending/deleting account gets a clean "scheduled for
    # deletion" response instead of starting a trip. Ungated + inert while everyone is 'active'.
    if await _account_is_pending_deletion(client, user_id):
        raise HTTPException(403, {"code": "account_pending_deletion",
            "message": "This account is scheduled for deletion. Cancel the deletion to plan new trips."})
    place_ids = [str(place_id) for place_id in req.place_ids]
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date,
                                   preferences=req.preferences, pace=req.pace,
                                   destination_hint=req.destination_hint, place_ids=place_ids,
                                   budget_level=req.budget_level, origin_city=req.origin_city,   # Fix 9
                                   requested_places=req.requested_places)

    # ROLLBACK PATH (Fix 3): flag off -> the retained pre-arc legacy daily-quota flow
    # (_generate_trip_legacy below). Flag on -> the new atomic-RPC entitlement path.
    if not ENTITLEMENTS_ENABLED:
        return await _generate_trip_legacy(client, req, user_id, idem, place_ids, background)

    # Forward path: an atomic Postgres RPC reserves the entitlement (trial OR daily) AND
    # enqueues the durable job in ONE transaction, so a charge can never precede a job.
    # fetch_traveler_profile is a traveler_profiles READ that swallows read failures (a
    # benign empty profile), so nothing here raises a charge into existence.
    profile = await fetch_traveler_profile(client, user_id)
    preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
    origin_city = req.origin_city or (profile.get("origin_city") if profile else None)
    event_payload = {
        "reel_urls": req.reel_urls, "start_date": req.start_date, "end_date": req.end_date,
        "pace": req.pace, "preferences": req.preferences,
        "destination_hint": req.destination_hint,
        "requested_places": req.requested_places, "place_ids": place_ids,
    }

    res = await reserve_and_enqueue_trip_job(
        client, user_id=user_id, idempotency_key=idem,
        destination_hint=req.destination_hint, start_date=req.start_date, end_date=req.end_date,
        budget_level=req.budget_level, origin_city=origin_city,
        preference_summary=preference_summary, preference_sources=preference_sources,
        event_payload=event_payload, trial_limit=TRIAL_LIFETIME_LIMIT, daily_limit=DAILY_TRIP_QUOTA,
    )

    if res.outcome == "identity_unavailable":
        raise HTTPException(503, {"code": "identity_unavailable",
            "message": "We couldn't verify your account. Please sign in again."})
    if res.outcome in ("replay",):
        return GenerateTripResponse(trip_id=res.trip_id)
    if res.outcome == "trial_exhausted":
        raise HTTPException(403, {"code": "trial_exhausted",
            "message": "Your free trip is planned. Beta seats unlock unlimited planning — only 25 exist."})
    if res.outcome == "daily_exhausted":
        raise HTTPException(429, {"code": "rate_limited",
            "message": "Daily trip limit reached. Try again tomorrow."})
    if res.outcome == "conflict_retry":                                           # Fix 1 — never NULL
        raise HTTPException(409, {"code": "conflict_retry",
            "message": "That request is already being processed — please retry."})
    # created — the only remaining outcome. ReserveResult.outcome is a fixed 6-value contract
    # from the pgTAP-tested RPC; every rejection/replay case returned or raised above, so here
    # res.trip_id/res.job_id are guaranteed non-null.
    background.add_task(
        run_generation, res.trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
        job_id=res.job_id, pace=req.pace, preferences=req.preferences,
        destination_hint=req.destination_hint, place_ids=place_ids,
    )
    return GenerateTripResponse(trip_id=res.trip_id)


async def _generate_trip_legacy(client, req, user_id: str, idem: str,
                                place_ids: list[str], background: BackgroundTasks) -> GenerateTripResponse:
    """Pre-arc rollback path (Fix 1/Fix 3): the CURRENT generate_trip flow verbatim, with the
    single change that its replay lookup filters `charge_refunded_at IS NULL` so it stays
    partial-index-safe. Legacy jobs carry `charge_kind = NULL` (harmless). It enforces only
    the durable DAILY quota (no lifetime trial) and is reached only when ENTITLEMENTS_ENABLED
    is false. Reuses check_and_increment_daily_quota / refund_daily_quota / enqueue_job."""
    # Idempotent replay: a retried POST (same request-derived key) returns the
    # SAME trip instead of creating a duplicate — WITHOUT consuming daily quota.
    # ACTIVE row only (Fix 1/Fix 4): `.is_(...,"null")` keeps this partial-index-safe.
    existing = await (
        client.table("jobs").select("trip_id").eq("idempotency_key", idem)
        .is_("charge_refunded_at", "null").maybe_single().execute()
    )
    if existing is not None and existing.data is not None:
        return GenerateTripResponse(trip_id=existing.data["trip_id"])

    # Layer 1 — durable daily quota. AFTER the replay short-circuit (a retried POST
    # must not consume quota) and BEFORE the trip insert.
    if not await check_and_increment_daily_quota(client, user_id, DAILY_TRIP_QUOTA):
        raise HTTPException(status_code=429, detail="Daily trip limit reached. Try again tomorrow.")

    # Quota is now consumed. ANY failure before a durable job exists must (a) preserve
    # the existing invariant — never leave an orphan trip stuck `generating` with no job
    # to recover it (mark it failed FIRST) — and (b) best-effort refund the quota. The
    # trip insert is INSIDE this try so its own failure refunds too (Codex HIGH #2). The
    # refund runs AFTER the fail-mark and is swallowed, so a refund error can't strand the
    # trip in `generating` (Codex HIGH #3).
    trip_id: str | None = None
    try:
        profile = await fetch_traveler_profile(client, user_id)
        preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
        origin_city = req.origin_city or (profile.get("origin_city") if profile else None)

        trip = (
            await client.table("trips")
            .insert({
                "user_id": user_id,
                "status": "generating",
                "destination_hint": req.destination_hint,
                "start_date": req.start_date,
                "end_date": req.end_date,
                "budget_level": req.budget_level,
                "origin_city": origin_city,
                "preference_summary": preference_summary,
                "preference_sources": preference_sources,
            })
            .execute()
        ).data[0]
        trip_id = trip["id"]
        await record_event(
            client, trip_id, event_type="stage", stage="create_trip", message="Starting your trip",
            payload={
                "reel_urls": req.reel_urls,
                "start_date": req.start_date,
                "end_date": req.end_date,
                "pace": req.pace,
                # preferences + destination_hint are replayed by _redispatch on recovery;
                # requested_places is recorded for audit (not yet resolved into the pipeline).
                "preferences": req.preferences,
                "destination_hint": req.destination_hint,
                "requested_places": req.requested_places,
                "place_ids": place_ids,
            },
        )
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except Exception:
        # LOG IT, with the traceback. This handler used to swallow the exception whole, so a
        # 500 here left Render with nothing but `POST /generate-trip 500` — the cause had to
        # be reproduced locally to be found. `exc_info=True` matches the reap loop above; the
        # error TYPE alone would not have named the failing constraint, which is the one fact
        # worth having. Everything reachable inside this try is a Supabase call, so the
        # traceback carries DB error text, not a credential. The client response below is
        # unchanged and deliberately says nothing about any of it.
        logger.exception("generate_trip_enqueue_failed trip_id=%s", trip_id)
        # Invariant FIRST (load-bearing): a created-but-jobless trip must be marked failed
        # (recovery only scans `jobs`; a transient httpx ConnectError/ReadTimeout counts too).
        if trip_id is not None:
            try:
                await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq(
                    "user_id", user_id
                ).execute()
            except Exception as exc:
                # Still best-effort — a fail-mark failure must NOT skip the quota refund below
                # — but no longer silent: this is the path that strands a trip in `generating`
                # forever, and it left no trace that it had happened.
                logger.warning(
                    "generate_trip_fail_mark_failed trip_id=%s error=%s", trip_id, type(exc).__name__
                )
        try:
            await refund_daily_quota(client, user_id)   # best-effort; never masks the 500 / fail-mark
        except Exception as exc:
            logger.warning("generate_trip_quota_refund_failed error=%s", type(exc).__name__)
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")

    if winning_trip_id != trip_id:
        # Lost an idempotency-key race to a concurrent POST — the winner is canonical (and
        # counted its own quota). Best-effort refund ours, then delete OUR orphan trip
        # (owner-filtered) and redirect; do NOT dispatch a second run_generation.
        try:
            await refund_daily_quota(client, user_id)
        except Exception as exc:
            # Same silence, same fix: losing the race then silently losing a day's quota is
            # a user-visible cost with no server-side trace. Still swallowed — the winner's
            # trip_id is the right answer regardless.
            logger.warning("generate_trip_quota_refund_failed error=%s", type(exc).__name__)
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)

    background.add_task(
        run_generation, trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
        job_id=job_id, pace=req.pace, preferences=req.preferences,
        destination_hint=req.destination_hint,
        place_ids=place_ids,
    )
    return GenerateTripResponse(trip_id=trip_id)


@app.post("/request-seat", response_model=RequestSeatResponse)
@limiter.limit(BURST_LIMIT)
async def request_seat(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True (see generate_trip)
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
) -> RequestSeatResponse:
    """Record this user's beta-seat request time, idempotently.

    The stamp is a security-definer RPC that sets seat_requested_at = coalesce(
    seat_requested_at, now()): the FIRST click records now(); repeat clicks return the
    ORIGINAL time (no overwrite). It's an RPC — not a PostgREST .update() — because `users`
    has no authenticated UPDATE RLS policy and the coalesce is a SQL expression, matching the
    arc's other atomic mutations (reserve_and_enqueue_trip_job / increment_daily_trip_usage).

    A missing users row makes the UPDATE match nothing, so the RPC returns NULL -> 503
    identity_unavailable (never a silent 200 with no stamp). If the RPC is absent from the
    live DB (a migration that lagged a code deploy — deploys are manual, render.yaml
    autoDeploy:false), PostgREST returns PGRST202; fail CLOSED with a distinct 503
    (code seat_request_unavailable), mirroring check_and_increment_daily_quota / the reserve
    wrapper. Any other APIError propagates (-> 500).
    """
    from postgrest.exceptions import APIError

    client = await get_supabase_client()
    try:
        resp = await client.rpc("request_seat", {"p_user_id": user_id}).execute()
    except APIError as exc:
        if getattr(exc, "code", None) == "PGRST202":
            raise HTTPException(503, {"code": "seat_request_unavailable",
                "message": "Couldn't record your seat request right now. Please try again shortly."}) from None
        raise
    # request_seat RETURNS a scalar timestamptz, so resp.data IS the value (the repo's
    # scalar-RPC convention: check_and_increment_daily_quota reads increment_daily_trip_usage's
    # `returns int` the same way). No matching row -> the RPC returns NULL -> resp.data is None.
    stamp = resp.data
    if not stamp:
        raise HTTPException(503, {"code": "identity_unavailable",
            "message": "We couldn't verify your account. Please sign in again."})
    return RequestSeatResponse(requested_at=stamp)


# Bound the best-effort scheduled-email lookup+send (T6, review finding #4): the admin.get_user_by_id
# read rides the ~30s service-role client timeout and the Resend send rides its own ~10s, so a
# degraded GoTrue/Resend could otherwise add ~40s to the 200. wait_for caps the whole best-effort
# side channel; a TimeoutError is swallowed like any other notice failure (the deletion is already
# scheduled). Awaited-but-bounded is simpler + more reliable than fire-and-forget (no orphan task /
# GC risk on a Render restart).
_EMAIL_BUDGET_S = 6.0


async def _send_scheduled_deletion_email(client, user_id: str, scheduled_for: str) -> None:
    """Best-effort: look up the caller's email (the JWT carries only the sub, never the address)
    and fire the "deletion scheduled" notice (plan §3.5, the safety net).

    Bounded to `_EMAIL_BUDGET_S` and wrapped so NOTHING here — the service-role auth.users read,
    the send, or a wait_for TimeoutError — can raise into the endpoint or delay the 200 beyond the
    budget: an email must never fail (or slow) an already-scheduled deletion. Secret-safe: logs
    only the exception TYPE name (an auth/httpx error can embed the bearer key or the address).

    C2: on a CONFIRMED send, stamp `account_deletion_log.notified_at` so the sweep's durable
    notice-retry doesn't re-send. A failed/timed-out send leaves it NULL and the sweep retries
    within a tick — this up-front send is now the fast path, not the only path.
    """
    from datetime import datetime, timezone

    from notifications import send_deletion_scheduled_email

    async def _lookup_and_send() -> bool:
        # The JWT sub is the identity; read the address service-side (RPC already captured it into
        # the log, but the endpoint only got scheduled_for back). get_user_by_id is the admin read.
        resp = await client.auth.admin.get_user_by_id(user_id)
        email = getattr(getattr(resp, "user", None), "email", None)
        return await send_deletion_scheduled_email(email, scheduled_for)

    sent = False
    try:
        sent = await asyncio.wait_for(_lookup_and_send(), timeout=_EMAIL_BUDGET_S)
    except Exception as exc:  # noqa: BLE001 — best-effort (incl. TimeoutError): a notice must NEVER break/slow a scheduled deletion
        logger.warning("scheduled deletion email failed: %s", type(exc).__name__)

    if not sent:
        return  # notified_at stays NULL -> the sweep's C2 retry re-sends within a tick
    try:
        # Stamp the durable "notice confirmed sent" marker (guarded on outcome='pending', F1
        # discipline). Bounded + best-effort: a stamp failure just means the sweep re-sends once
        # (a duplicate cancel-by notice beats a silent none), so it must not raise/slow the 200.
        await asyncio.wait_for(
            client.table("account_deletion_log")
            .update({"notified_at": datetime.now(timezone.utc).isoformat()})
            .eq("user_id", user_id).eq("outcome", "pending").execute(),
            timeout=_EMAIL_BUDGET_S,
        )
    except Exception as exc:  # noqa: BLE001 — a stamp failure must never break/slow a scheduled deletion
        logger.warning("scheduled deletion notified_at stamp failed: %s", type(exc).__name__)


@app.post("/account/deletion", response_model=AccountDeletionResponse)
@limiter.limit(BURST_LIMIT)
async def request_account_deletion_endpoint(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True (see generate_trip)
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
) -> AccountDeletionResponse:
    """Enter the 7-day cancellable deletion grace for the AUTHENTICATED account.

    GATED OFF until Task 6 (`_DELETION_EXECUTION_READY`): the delete engine + sweep +
    notifications don't exist yet, so this must not schedule a deletion nothing will act on.
    Returns 503 while gated — before any DB round-trip, so nothing is touched.

    The deleted account is ALWAYS the caller's JWT sub (self-serve only) — this endpoint has
    no request body and never accepts a client-supplied user_id. The RPC is privilege-pinned to
    service_role, so a client cannot schedule another uuid via PostgREST either.
    """
    if not _DELETION_EXECUTION_READY:
        return build_error_response(503, _DELETION_GATED_MESSAGE, code="deletion_unavailable")

    from notifications import resend_configured
    if not resend_configured():
        # The scheduled-deletion email is the load-bearing safety net (plan §3.5). Refuse to start a
        # grace we cannot notify — flipping execution-ready without RESEND must fail closed, not
        # accept a silent no-notice deletion. (Transient SEND failures stay best-effort; this is
        # CONFIG.) Pre-DB slot, like the gate above: returns before any RPC / get_supabase_client.
        return build_error_response(503, _DELETION_GATED_MESSAGE, code="deletion_unavailable")

    from deletion import DeletionRPCUnavailable, request_account_deletion

    client = await get_supabase_client()
    try:
        scheduled_for = await request_account_deletion(client, user_id)
    except DeletionRPCUnavailable:
        # A migration lagging a deploy: fail CLOSED, don't 500. Returned (not raised) so the
        # envelope carries the distinct code, matching the clear route's 503 handling.
        return build_error_response(503, _DELETION_GATED_MESSAGE, code="deletion_unavailable")
    if scheduled_for is None:
        # The CAS matched nothing: the account is not 'active' (already pending/deleting).
        raise HTTPException(409, {"code": "deletion_not_active",
            "message": "This account can't be scheduled for deletion right now."})
    # Fire the immediate "deletion scheduled — cancel by {date}" notice (Resend, best-effort) —
    # the load-bearing safety net (plan §3.5). Wrapped so NEITHER the email lookup NOR the send can
    # fail the 200 or the already-scheduled deletion.
    await _send_scheduled_deletion_email(client, user_id, scheduled_for)
    return AccountDeletionResponse(scheduled_for=scheduled_for)


@app.post("/account/deletion/cancel", response_model=AccountDeletionCancelResponse)
@limiter.limit(BURST_LIMIT)
async def cancel_account_deletion_endpoint(
    request: Request,                                     # required by slowapi; must be named `request`
    response: Response,                                   # REQUIRED with headers_enabled=True
    user_id: str = Depends(get_current_user_id_stashed),  # token-derived: guardrails #5 + #6
) -> AccountDeletionCancelResponse:
    """Cancel the pending deletion for the AUTHENTICATED account, reversing the grace.

    GATED OFF until Task 6 (503 while gated). Only works before the sweeper claims the account
    into 'deleting' (Task 3's point of no return) — a row already 'deleting' returns 409
    deletion_already_started. Caller is always the JWT sub (privilege-pinned RPC)."""
    if not _DELETION_EXECUTION_READY:
        return build_error_response(503, _DELETION_GATED_MESSAGE, code="deletion_unavailable")

    from deletion import DeletionRPCUnavailable, cancel_account_deletion

    client = await get_supabase_client()
    try:
        status = await cancel_account_deletion(client, user_id)
    except DeletionRPCUnavailable:
        return build_error_response(503, _DELETION_GATED_MESSAGE, code="deletion_unavailable")
    if status == "cancelled":
        return AccountDeletionCancelResponse()
    if status == "already_deleting":
        raise HTTPException(409, {"code": "deletion_already_started",
            "message": "Your account deletion has already started and can no longer be cancelled."})
    # status == "not_pending": there is no pending deletion to cancel.
    raise HTTPException(409, {"code": "no_pending_deletion",
        "message": "There is no pending account deletion to cancel."})


@app.get("/account/deletion/status", response_model=AccountDeletionStatusResponse)
async def account_deletion_status_endpoint(
    user_id: str = Depends(get_current_user_id),  # token-derived: guardrails #5 + #6
) -> AccountDeletionStatusResponse:
    """Report the AUTHENTICATED account's deletion state so a returning user's UI can show (or
    hide) the pending banner across sessions (the T5 gap, wired at T6).

    UNGATED — a harmless read. It is NOT tied to `_DELETION_EXECUTION_READY`: while that flag is
    False nobody is pending, so every caller simply reads 'active'. The account is ALWAYS the
    caller's JWT sub — there is no request body or query id to supply another uuid — so this can
    never leak a different user's status (guardrails #5/#6).

    NEVER 500s a returning user's UI, but it distinguishes two cases that used to collapse (Fix 5):
      * a SUCCESSFUL read whose row is absent / a bare None / an unexpected value = a
        legitimately-absent status = NO pending deletion → the safe default {account_status:
        'active', deletion_scheduled_for: null} (banner HIDDEN); and
      * a genuine read FAILURE (the read raised) → {account_status: 'unknown', ...null}. Collapsing
        this to 'active' would hide the Cancel banner from a genuinely-pending user while a
        re-request says "already scheduled" — no route to cancel. 'unknown' lets the UI preserve
        cancellation guidance instead. Secret-safe: logs only the exception TYPE name.
    """
    try:
        client = await get_supabase_client()
        res = await (client.table("users").select("account_status, deletion_scheduled_for")
                     .eq("id", user_id).maybe_single().execute())
        row = getattr(res, "data", None) if res is not None else None
        if isinstance(row, dict) and row.get("account_status") in (
            "active", "pending_deletion", "deleting"
        ):
            return AccountDeletionStatusResponse(
                account_status=row["account_status"],
                deletion_scheduled_for=row.get("deletion_scheduled_for"),
            )
        # A successful read with no matching row / bare None / an unexpected value = no pending
        # deletion. Keep the 'active' default (banner HIDDEN) — only the EXCEPTION path is 'unknown'.
        return AccountDeletionStatusResponse(account_status="active", deletion_scheduled_for=None)
    except Exception as exc:  # noqa: BLE001 — a genuine read FAILURE is 'unknown', never a false 'active'
        logger.warning("account deletion status read failed: %s", type(exc).__name__)
        return AccountDeletionStatusResponse(account_status="unknown", deletion_scheduled_for=None)


class _OrganizeSavedReelsRequest(OrganizeSavedReelsRequest):
    model_config = ConfigDict(extra="forbid")


@app.post("/saved-reels/organize", response_model=OrganizeSavedReelsResponse)
@limiter.limit(BURST_LIMIT)
async def organize_saved_reels(
    request: Request,
    response: Response,
    req: _OrganizeSavedReelsRequest,
    background: BackgroundTasks,
    user_id: str = Depends(get_current_user_id_stashed),
) -> OrganizeSavedReelsResponse:
    client = await get_supabase_client()
    # Generation freeze (plan §3.6): organize is the THIRD generation entrypoint — a pending/
    # deleting account gets a clean "scheduled for deletion" response instead of burning
    # Apify/OpenAI spend (and racing the cascade). Ungated + inert while everyone is 'active'.
    if await _account_is_pending_deletion(client, user_id):
        raise HTTPException(403, {"code": "account_pending_deletion",
            "message": "This account is scheduled for deletion. Cancel the deletion to organize reels."})
    saved_reel_ids = [str(saved_reel_id) for saved_reel_id in req.saved_reel_ids]
    try:
        job_id = await create_organize_job(client, user_id, saved_reel_ids)
    except ActiveOrganizeConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidOrganizeRequest as exc:
        # The RPC's own boundary validation. Pydantic rejects the same shapes first, so this
        # is defense in depth for a request that somehow reaches the RPC malformed — it must
        # still read as the client error it is, not a 500.
        raise HTTPException(status_code=422, detail="Saved Reel organize request is invalid") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Saved Reel not found") from exc
    background.add_task(run_organize_job, job_id, user_id, client=client)
    return OrganizeSavedReelsResponse(job_id=job_id)


@app.get("/saved-reels/organize/{job_id}", response_model=OrganizeJobStatus)
async def organize_status(
    job_id: str,
    user_id: str = Depends(get_current_user_id),
) -> OrganizeJobStatus:
    client = await get_supabase_client()
    try:
        return OrganizeJobStatus.model_validate(await get_organize_status(client, job_id, user_id))
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Organize job not found") from exc


@app.get("/saved-reels/organize/{job_id}/stream")
async def organize_stream(
    job_id: str,
    cursor: str | None = None,
    user_id: str = Depends(get_user_id_from_query_or_header),
) -> StreamingResponse:
    client = await get_supabase_client()
    try:
        await get_organize_status(client, job_id, user_id)
    except PermissionError as exc:
        raise HTTPException(status_code=404, detail="Organize job not found") from exc
    return StreamingResponse(
        stream_organize_events(client, job_id, user_id, cursor=cursor),
        media_type="text/event-stream",
    )


@app.get("/generate-trip/stream/{trip_id}")
async def stream(
    trip_id: str,
    user_id: str = Depends(get_user_id_from_query_or_header),
) -> StreamingResponse:
    client = await get_supabase_client()
    owner = await client.table("trips").select("user_id").eq("id", trip_id).maybe_single().execute()
    # `owner is None` is load-bearing: maybe_single() returns a bare None on zero rows
    # (postgrest request_builder.py:167). Without it this 500s instead of 404ing, which tells
    # a caller which trip ids exist. Matches jobs.py:80 / generate_trip's replay precheck /
    # organizer.py:184 / submit_trip_feedback's owner check.
    if owner is None or owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6
        raise HTTPException(status_code=404, detail="Trip not found")
    return StreamingResponse(stream_trip_events(client, trip_id), media_type="text/event-stream")


async def _redispatch(client, job: dict) -> None:
    """Reconstruct a reclaimable job's run inputs from its create_trip event and re-run it.

    If no create_trip event exists, skip (leave it for a human/next sweep) — never crash
    startup. run_generation's CAS claim (mark_job_running) makes a concurrent double-dispatch
    of the same job safe.
    """
    ev = await (
        client.table("generation_events").select("payload").eq("trip_id", job["trip_id"])
        .eq("stage", "create_trip").maybe_single().execute()
    )
    if ev is None or ev.data is None:
        return  # no inputs to replay; leave it for a human/next sweep
    payload = ev.data["payload"]
    async with _RECOVERY_SEM:  # bound concurrent boot re-dispatch (Fix 3)
        await run_generation(
            job["trip_id"], job["user_id"], payload["reel_urls"], payload["start_date"],
            payload["end_date"], job_id=job["id"], pace=payload.get("pace", "balanced"),
            preferences=payload.get("preferences"), destination_hint=payload.get("destination_hint"),
            place_ids=payload.get("place_ids", []),
        )
