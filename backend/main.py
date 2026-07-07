"""Astrail FastAPI app — health, trip generation, and SSE streaming.

POST /generate-trip authenticates via the Authorization header and is
idempotent: a request-derived key (jobs.compute_idempotency_key) means a
retried POST replays the existing trip instead of creating a duplicate. When
two same-key POSTs race, enqueue_job's atomic insert picks exactly one
winner; the loser deletes its own orphan trip (owner-filtered) and redirects
to the winner's trip_id WITHOUT dispatching a second run_generation.

GET /generate-trip/stream/{trip_id} authenticates via a ?token= query param
(browser EventSource cannot set headers, with a header fallback), verifies
trip ownership (guardrail #6), and streams generation_events as SSE.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from slowapi.errors import RateLimitExceeded

from api.errors import build_error_response, register_error_handlers
from api.schemas import GenerateTripRequest, GenerateTripResponse
from api.streaming import stream_trip_events
from auth import get_user_id_from_query_or_header
from jobs import compute_idempotency_key, enqueue_job, recover_inflight_jobs
from pipeline.runner import record_event, run_generation
from rate_limit import (
    BURST_LIMIT,
    DAILY_TRIP_QUOTA,
    check_and_increment_daily_quota,
    get_current_user_id_stashed,
    limiter,
    refund_daily_quota,
)
from supabase_client import get_supabase_client

_RECOVERY_TASKS: set = set()
_RECOVERY_SEM = asyncio.Semaphore(3)   # bound boot fan-out so a backlog doesn't stampede Apify/OpenAI/DB


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Guardrail #12: on boot, re-queue and re-run anything a crash left mid-flight
    (restart-with-cache-reuse, NOT resume — a reclaimed job re-executes from Phase 1).
    A boot-time DB blip must DEGRADE, not crash startup: the app must still start and
    serve /health even if Supabase is unreachable; the next restart's sweep re-picks
    pending jobs."""
    try:
        client = await get_supabase_client()
        for job in await recover_inflight_jobs(client=client):
            task = asyncio.create_task(_redispatch(client, job))
            _RECOVERY_TASKS.add(task)                     # retain ref so it isn't GC'd mid-flight
            task.add_done_callback(_RECOVERY_TASKS.discard)
        try:
            from mem0_client import get_mem0_client
            await get_mem0_client()   # warm once so the first trip skips the blocking ping
        except Exception:
            pass   # memory is best-effort; a warm failure must never down the app
    except Exception:
        pass   # boot-time DB blip must not down the app; the next restart's sweep will re-pick pending jobs
    yield


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


@app.get("/health")
async def health():
    return {"status": "ok"}


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
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date,
                                   preferences=req.preferences, pace=req.pace,
                                   destination_hint=req.destination_hint)

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
        trip = (
            await client.table("trips")
            .insert({
                "user_id": user_id,
                "status": "generating",
                "destination_hint": req.destination_hint,
                "start_date": req.start_date,
                "end_date": req.end_date,
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
                "preferences": req.preferences,
                "destination_hint": req.destination_hint,
            },
        )
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except Exception:
        # Invariant FIRST (load-bearing): a created-but-jobless trip must be marked failed
        # (recovery only scans `jobs`; a transient httpx ConnectError/ReadTimeout counts too).
        if trip_id is not None:
            await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq(
                "user_id", user_id
            ).execute()
        try:
            await refund_daily_quota(client, user_id)   # best-effort; never masks the 500 / fail-mark
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")

    if winning_trip_id != trip_id:
        # Lost an idempotency-key race to a concurrent POST — the winner is canonical (and
        # counted its own quota). Best-effort refund ours, then delete OUR orphan trip
        # (owner-filtered) and redirect; do NOT dispatch a second run_generation.
        try:
            await refund_daily_quota(client, user_id)
        except Exception:
            pass
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)

    background.add_task(
        run_generation, trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
        job_id=job_id, pace=req.pace, preferences=req.preferences,
        destination_hint=req.destination_hint,
    )
    return GenerateTripResponse(trip_id=trip_id)


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
        )
