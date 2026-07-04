"""Live deterministic generation runner (scrape → extract → dedup → route-assembly),
streamed as generation_events and persisted progressively. Owns the durable job
lifecycle via an atomic CAS claim guard. Reuses the pure offline helpers; NEVER
imports or mutates offline_harness.run_offline_pipeline (the frozen #16 eval
anchor). Phase-3/4 enrich agents are deferred — their asyncio.gather fan-out
slots into the enrich phase later.

Guardrails: #3 (partial pipeline failure degrades, never hangs), #6 (owner check
on every trips write), #12 (durable job = restart-with-cache-reuse). Every
`.execute()` here is on the async supabase-py client and MUST be awaited.
"""
from __future__ import annotations

import asyncio
import os

from models.place import PlaceResult
from pipeline.dedup import dedupe_places
from pipeline.offline_harness import _date_range, assemble_itinerary
from jobs import mark_job_done, mark_job_running
from supabase_client import get_supabase_client


async def record_event(client, trip_id, *, event_type, stage, message, payload=None) -> None:
    """Insert one generation_events row (progressive persistence + SSE source)."""
    await client.table("generation_events").insert({
        "trip_id": trip_id, "event_type": event_type, "stage": stage,
        "message": message, "payload": payload or {},
    }).execute()


async def _set_status(client, trip_id, user_id, status) -> None:
    # Owner check (guardrail #6): filter on id AND user_id even under service-role.
    await client.table("trips").update({"status": status}).eq("id", trip_id).eq("user_id", user_id).execute()


async def _fail(client, trip_id, user_id, job_id, stage, message) -> dict:
    await record_event(client, trip_id, event_type="error", stage=stage, message=message)
    await _set_status(client, trip_id, user_id, "failed")
    await record_event(client, trip_id, event_type="result", stage=stage,
                        message="generation failed", payload={"error": message})
    if job_id:
        await mark_job_done(client, job_id, status="failed")
    return {"error": message}


async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                          *, job_id=None, pace="balanced", client=None, scrape=None, extract=None) -> dict:
    """Run the deterministic spine; own the job lifecycle; always write a terminal result."""
    client = client or await get_supabase_client()

    # Atomic claim guard (amendment §C): abort BEFORE any work if another instance
    # already owns this job (double-run guard on recovery + original dispatch racing).
    if job_id and not await mark_job_running(client, job_id):
        return {"skipped": "job already claimed by another run"}

    if scrape is None:
        from scrape.apify_direct import scrape_reel
        token = os.environ["APIFY_TOKEN"]

        async def scrape(url):
            return await scrape_reel(url, token=token)
    if extract is None:
        from genagents.place_extractor import extract_places
        extract = extract_places

    try:
        await _set_status(client, trip_id, user_id, "generating")
        degraded = False

        # PHASE 1: SCRAPE (parallel, partial-failure isolated)
        await record_event(client, trip_id, event_type="stage", stage="scrape",
                            message=f"scraping {len(reel_urls)} reel(s)")
        scraped = await asyncio.gather(*[scrape(u) for u in reel_urls], return_exceptions=True)
        reels = []
        for url, res in zip(reel_urls, scraped):
            if isinstance(res, Exception):
                degraded = True
                await record_event(client, trip_id, event_type="warning", stage="scrape",
                                    message=f"reel skipped: {url}")
            else:
                reels.append(res)
        if not reels:
            return await _fail(client, trip_id, user_id, job_id, "scrape", "no reels could be scraped")

        # PHASE 2: EXTRACT (parallel, partial-failure isolated) + DEDUP
        await record_event(client, trip_id, event_type="stage", stage="extract",
                            message=f"extracting places from {len(reels)} reel(s)")
        per_reel = await asyncio.gather(*[extract(r) for r in reels], return_exceptions=True)
        places: list[PlaceResult] = []
        for res in per_reel:
            if isinstance(res, Exception):
                degraded = True
                await record_event(client, trip_id, event_type="warning", stage="extract",
                                    message="extraction failed for one reel")
            else:
                places.extend(res)
        if not places:
            return await _fail(client, trip_id, user_id, job_id, "extract",
                                "no verified places after extraction")

        await record_event(client, trip_id, event_type="stage", stage="dedup",
                            message=f"deduping {len(places)} place(s)")
        canonical = dedupe_places(places).places

        # PHASE 4: NARRATE (deterministic route assembly)
        await record_event(client, trip_id, event_type="stage", stage="narrate",
                            message="assembling itinerary")
        itinerary = assemble_itinerary(canonical, _date_range(start_date, end_date), pace=pace)

        status = "saved_with_gaps" if degraded else "complete"
        await record_event(client, trip_id, event_type="stage", stage="save", message="saving trip")
        await _set_status(client, trip_id, user_id, status)
        payload = {"itinerary": itinerary.model_dump()}
        await record_event(client, trip_id, event_type="result", stage="save",
                            message="generation complete", payload=payload)
        if job_id:
            await mark_job_done(client, job_id, status="succeeded")
        return payload
    except Exception:
        # Any unexpected error → terminal result, failed status, failed job (never hang the stream).
        return await _fail(client, trip_id, user_id, job_id, "save", "unexpected generation error")
