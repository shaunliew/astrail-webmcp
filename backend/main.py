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
    OrganizeJobStatus,
    OrganizeSavedReelsRequest,
    OrganizeSavedReelsResponse,
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
    check_and_increment_daily_quota,
    get_current_user_id_stashed,
    limiter,
    refund_daily_quota,
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
        try:
            from mem0_client import get_mem0_client
            await get_mem0_client()   # warm once so the first trip skips the blocking ping
        except Exception:
            pass   # memory is best-effort; a warm failure must never down the app
    except Exception:
        pass   # boot-time DB blip must not down the app; the reaper re-picks pending jobs
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


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/readiness")
async def readiness():
    """Deep readiness probe: confirms Supabase is reachable. NOT the deploy gate
    (that is /health) — a DB blip should not fail a rolling deploy."""
    try:
        client = await get_supabase_client()
        await client.table("users").select("id").limit(1).execute()
        return {"ready": True}
    except Exception:
        return JSONResponse(status_code=503, content={"ready": False})


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
                                   destination_hint=req.destination_hint, place_ids=place_ids)

    # Idempotent replay: a retried POST (same request-derived key) returns the
    # SAME trip instead of creating a duplicate — WITHOUT consuming daily quota.
    existing = await (
        client.table("jobs").select("trip_id").eq("idempotency_key", idem).maybe_single().execute()
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
            client, trip_id, event_type="stage", stage="create_trip", message="trip created",
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
    if owner.data is None or owner.data["user_id"] != user_id:  # guardrail #6 owner check
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
