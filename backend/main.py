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
from config_validation import validate_required_secrets
from jobs import compute_idempotency_key, enqueue_job, reclaim_expired_jobs
from log_redaction import install as _install_log_redaction
from pipeline.runner import record_event, run_generation
from preferences import compose_preference_summary, fetch_traveler_profile
from rate_limit import (
    BURST_LIMIT,
    DAILY_TRIP_QUOTA,
    ENTITLEMENTS_ENABLED,
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
        except Exception:
            # A DB blip must NEVER kill the reaper — a reaper that dies on its first
            # transient error is worse than none, because nothing after it says so.
            logger.warning("reap_loop_iteration_failed", exc_info=True)


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

_allowed_origins = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "https://astrail.xyz,https://www.astrail.xyz").split(",")
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
@limiter.limit(BURST_LIMIT)
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
        raise HTTPException(status_code=422, detail="A valid Instagram Reel URL is required") from exc
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
