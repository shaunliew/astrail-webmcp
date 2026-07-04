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

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from postgrest.exceptions import APIError

from api.schemas import GenerateTripRequest, GenerateTripResponse
from api.streaming import stream_trip_events
from auth import get_current_user_id, get_user_id_from_query_or_header
from jobs import compute_idempotency_key, enqueue_job
from pipeline.runner import record_event, run_generation
from supabase_client import get_supabase_client

app = FastAPI(title="Astrail Backend")

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
        },
    )

    try:
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except APIError:
        # Never leave an orphan trip with no durable job.
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
    owner = await client.table("trips").select("user_id").eq("id", trip_id).execute()
    if not owner.data or owner.data[0]["user_id"] != user_id:  # guardrail #6 owner check
        raise HTTPException(status_code=404, detail="Trip not found")
    return StreamingResponse(stream_trip_events(client, trip_id), media_type="text/event-stream")
