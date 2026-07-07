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
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from api.schemas import GenerateTripRequest, GenerateTripResponse
from api.streaming import stream_trip_events
from auth import get_current_user_id, get_user_id_from_query_or_header
from jobs import compute_idempotency_key, enqueue_job, recover_inflight_jobs
from pipeline.runner import record_event, run_generation
from preferences import compose_preference_summary, fetch_traveler_profile
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
    except Exception:
        pass   # boot-time DB blip must not down the app; the next restart's sweep will re-pick pending jobs
    yield


app = FastAPI(title="Astrail Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/generate-trip", response_model=GenerateTripResponse)
async def generate_trip(
    req: GenerateTripRequest,
    background: BackgroundTasks,
    user_id: str = Depends(get_current_user_id),
) -> GenerateTripResponse:
    client = await get_supabase_client()
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date)

    # Idempotent replay: a retried POST (same request-derived key) returns the
    # SAME trip instead of creating a duplicate.
    existing = await (
        client.table("jobs").select("trip_id").eq("idempotency_key", idem).maybe_single().execute()
    )
    if existing is not None and existing.data is not None:
        return GenerateTripResponse(trip_id=existing.data["trip_id"])

    profile = await fetch_traveler_profile(client, user_id)
    preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
    origin_city = req.origin_city or (profile.get("origin_city") if profile else None)

    # Create the trip FIRST (jobs composite FK needs it), persist the run
    # inputs as a create_trip event (recovery replays from this payload), then
    # enqueue the durable job.
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
    try:
        await record_event(
            client, trip_id, event_type="stage", stage="create_trip", message="trip created",
            payload={
                "reel_urls": req.reel_urls,
                "start_date": req.start_date,
                "end_date": req.end_date,
                "pace": req.pace,
                "requested_places": req.requested_places,
            },
        )
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except Exception:
        # Never leave an orphan trip with no durable job: ANY failure between the
        # trip insert and the enqueue (not just APIError — a transient httpx
        # ConnectError/ReadTimeout counts too) must not leave the trip stuck
        # `generating` with nothing to recover it (recovery only scans `jobs`).
        await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq(
            "user_id", user_id
        ).execute()
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")

    if winning_trip_id != trip_id:
        # Lost an idempotency-key race to a concurrent POST — the winner is
        # canonical. Delete OUR orphan trip (owner-filtered) and redirect;
        # do NOT dispatch a second run_generation.
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)

    background.add_task(
        run_generation, trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
        job_id=job_id, pace=req.pace,
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
        )
