"""Live deterministic generation runner (scrape → extract → dedup → route-assembly),
streamed as generation_events and persisted progressively. Owns the durable job
lifecycle via an atomic CAS claim guard. Reuses the pure offline helpers; NEVER
imports or mutates offline_harness.run_offline_pipeline (the frozen #16 eval
anchor). Weather, transport, restaurants, hotels, and narration (Phase-3) are live:
each is a self-contained, best-effort enrich stage — weather persists sequentially
(narration reads its trip_days.weather_summary), then transport/restaurants/hotels/
narration fan out via asyncio.gather(return_exceptions=True) to cut enrich latency; no
enrich failure ever fails the trip. Narration is the LLM prose layer over the
deterministic `narrate` assembly.

Guardrails: #3 (partial pipeline failure degrades, never hangs), #6 (owner check
on every trips write), #12 (durable job = restart-with-cache-reuse). Every
`.execute()` here is on the async supabase-py client and MUST be awaited.
"""
from __future__ import annotations

import asyncio
import os

from models.place import PlaceResult
from pipeline.dedup import dedupe_places
from pipeline.geo import centroid
from pipeline.offline_harness import _date_range, assemble_itinerary
from pipeline.persist import persist_hotels, persist_itinerary, persist_narration, persist_restaurants, persist_transport, persist_weather
from jobs import mark_job_done, mark_job_running
from supabase_client import get_supabase_client

# A3: mem0=_UNSET (not None) means "not injected -> resolve the real singleton". Explicit
# mem0=None then unambiguously means "memory disabled" (tests pass None or a fake), so a
# CI run with MEM0_API_KEY set never constructs the real client / hits the network.
_UNSET = object()


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
    """Best-effort terminal failure write: each write is independent so one Supabase
    error (e.g. the original failure was connectivity) doesn't block the others — the
    terminal `result` event and the job-failed mark are the load-bearing ones."""
    try:
        await record_event(client, trip_id, event_type="error", stage=stage, message=message)
    except Exception:
        pass
    try:
        await _set_status(client, trip_id, user_id, "failed")
    except Exception:
        pass
    try:
        await record_event(client, trip_id, event_type="result", stage=stage,
                            message="generation failed", payload={"error": message})
    except Exception:
        pass
    if job_id:
        try:
            await mark_job_done(client, job_id, status="failed")
        except Exception:
            pass
    return {"error": message}


async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                          *, job_id=None, pace="balanced", preferences=None, destination_hint=None,
                          client=None, scrape=None, extract=None, mem0=_UNSET,
                          weather=None, transport=None, restaurant=None, narrator=None, hotel=None) -> dict:
    """Run the deterministic spine; own the job lifecycle; always write a terminal result."""
    try:
        if client is None:
            client = await get_supabase_client()

        if scrape is None:
            from scrape.apify_direct import scrape_reel
            token = os.environ["APIFY_TOKEN"]

            async def scrape(url):
                return await scrape_reel(url, token=token)
        if extract is None:
            from genagents.place_extractor import extract_places
            extract = extract_places

        # Atomic claim guard (amendment §C): abort BEFORE any work if another instance
        # already owns this job (double-run guard on recovery + original dispatch racing).
        if job_id and not await mark_job_running(client, job_id):
            return {"skipped": "job already claimed by another run"}

        await _set_status(client, trip_id, user_id, "generating")
        degraded = False

        # PREFERENCES: retrieve-once memory read → one immutable PreferenceContext.
        # Best-effort (guardrail #3): a mem0 miss/outage/timeout degrades to inferred
        # defaults. Injected `mem0` (tests) overrides the singleton; None disables
        # memory unambiguously (A3 sentinel) — never construct/hit the real client
        # unless the caller left `mem0` un-injected.
        from pipeline.preferences import build_preference_context
        if mem0 is _UNSET:
            from mem0_client import get_mem0_client
            mem0 = await get_mem0_client()
        pref_ctx = await build_preference_context(
            mem0, user_id, explicit_text=preferences, pace=pace,
            destination_hint=destination_hint)
        await record_event(client, trip_id, event_type="stage", stage="preferences",
                           message=pref_ctx.summary,
                           payload={"preference_source": pref_ctx.source})

        # PHASE 1+2: SCRAPE + EXTRACT, with a per-reel EXTRACTION CACHE. A repeat reel (same
        # normalized URL + EXTRACTOR_VERSION) skips BOTH scrape and extract. Non-reel URLs are
        # uncacheable → normal scrape+extract. Cache writes are best-effort (never fail the trip).
        from genagents.place_extractor import EXTRACTOR_VERSION
        from pipeline.cache import cache_places, get_cached_places

        # Per-reel results indexed by reel_urls position, so `places` is assembled in reel-URL order
        # regardless of cache state (WARM == COLD). Without this, cache-HIT places would precede MISS
        # extractions and change the input order into the (mostly, but not fully) order-independent
        # dedup — re-running the same reels could then yield a different itinerary at a confidence tie.
        results: list[list[PlaceResult] | None] = [None] * len(reel_urls)
        miss_idx: list[int] = []
        n_hit = 0
        for i, url in enumerate(reel_urls):
            try:
                cached = await get_cached_places(client, url, EXTRACTOR_VERSION)
            except Exception:
                cached = None   # cache READ is a pure optimization — a Supabase blip / model_validate
                                # drift = MISS (scrape+extract), NEVER fail the trip (guardrail #3).
            if cached is not None:
                results[i] = cached
                n_hit += 1
            else:
                miss_idx.append(i)
        if n_hit:
            await record_event(client, trip_id, event_type="stage", stage="cache_hit",
                               message=f"{n_hit} reel(s) from cache (skipped scrape+extract)")

        if miss_idx:
            # SCRAPE (misses only, parallel, partial-failure isolated)
            await record_event(client, trip_id, event_type="stage", stage="scrape",
                               message=f"scraping {len(miss_idx)} reel(s)")
            scraped = await asyncio.gather(*[scrape(reel_urls[i]) for i in miss_idx],
                                           return_exceptions=True)
            to_extract: list[tuple[int, object]] = []   # (reel_urls index, ReelData)
            for i, res in zip(miss_idx, scraped):
                if isinstance(res, Exception):
                    degraded = True
                    await record_event(client, trip_id, event_type="warning", stage="scrape",
                                       message=f"reel skipped: {reel_urls[i]}")
                else:
                    to_extract.append((i, res))
            # EXTRACT (misses only) + write-through cache each successful extraction
            if to_extract:
                await record_event(client, trip_id, event_type="stage", stage="extract",
                                   message=f"extracting places from {len(to_extract)} reel(s)")
                extracted = await asyncio.gather(*[extract(reel) for _i, reel in to_extract],
                                                 return_exceptions=True)
                for (i, reel), res in zip(to_extract, extracted):
                    if isinstance(res, Exception):
                        degraded = True
                        await record_event(client, trip_id, event_type="warning", stage="extract",
                                           message="extraction failed for one reel")
                    else:
                        results[i] = res
                        try:
                            await cache_places(client, reel_urls[i], reel, res, EXTRACTOR_VERSION)
                        except Exception:
                            pass   # cache write is best-effort — never fail the trip on it

        # Flatten in reel-URL order (index-stable): cache state cannot reorder the itinerary input.
        places: list[PlaceResult] = [p for r in results if r for p in r]
        if not places:
            return await _fail(client, trip_id, user_id, job_id, "extract",
                                "no verified places after extraction")

        await record_event(client, trip_id, event_type="stage", stage="dedup",
                            message=f"deduping {len(places)} place(s)")
        canonical = dedupe_places(places).places

        # NARRATE — route assembly (deterministic)
        await record_event(client, trip_id, event_type="stage", stage="narrate",
                            message="assembling itinerary")
        dates = _date_range(start_date, end_date)
        itinerary = assemble_itinerary(canonical, dates, pace=pace)
        if any(w.severity == "flag" for w in itinerary.feasibility_warnings):
            degraded = True

        # ENRICH — weather (Phase-3 agent, partial-failure isolated). FULLY SELF-CONTAINED:
        # the default-injection, the fetch, and even the warning-write are ALL inside one
        # try/except that swallows everything — a weather failure (broken import, API error,
        # or a failed warning-write) must NEVER propagate to the outer `_fail` (guardrail #3).
        weather_reports = []
        try:
            if weather is None:
                from genagents.weather import fetch_weather as weather   # resolved here, isolated
            center = centroid(canonical)
            if center is not None:
                await record_event(client, trip_id, event_type="stage", stage="weather",
                                   message="fetching weather")
                weather_reports = await weather(center[0], center[1], dates)
        except Exception:
            weather_reports = []
            try:
                await record_event(client, trip_id, event_type="warning", stage="weather",
                                   message="weather unavailable")
            except Exception:
                pass   # best-effort: a warning-write failure must not fail the trip either

        status = "saved_with_gaps" if degraded else "complete"
        await record_event(client, trip_id, event_type="stage", stage="save", message="saving trip")
        try:
            dropped = await persist_itinerary(client, trip_id, canonical, dates)
            try:
                # Owner-checked (guardrail #6) + best-effort: never fail the trip on this write.
                await client.table("trips").update(
                    {"preference_summary": pref_ctx.summary,
                     "preference_sources": [pref_ctx.source]}
                ).eq("id", trip_id).eq("user_id", user_id).execute()
            except Exception:
                pass   # best-effort trip metadata; never fail the trip on it
            if dropped:
                status = "saved_with_gaps"
                await record_event(client, trip_id, event_type="warning", stage="save",
                                   message=f"{dropped} place(s) shown in the itinerary were not saved "
                                           "(missing coordinates or merged with an existing place)")
            if weather_reports:                       # weather AFTER persist created trip_days (ordering!)
                try:
                    await persist_weather(client, trip_id, weather_reports)
                except Exception:
                    try:
                        await record_event(client, trip_id, event_type="warning", stage="weather",
                                           message="weather persist failed")
                    except Exception:
                        pass   # best-effort — weather persist failure is non-critical

            # Compute the soft-guidance preference block ONCE, before the enrich gather — restaurant
            # and narrator are the only two stages that personalize toward it (Task 4).
            from pipeline.preferences import preference_block
            pref_block = preference_block(pref_ctx)

            # Enrich stages are INDEPENDENT (disjoint write tables) and best-effort (guardrail #3),
            # so run them CONCURRENTLY instead of sequentially (~halves the enrich block latency).
            # Weather is persisted ABOVE, sequentially, because narration reads
            # trip_days.weather_summary. Each coroutine is fully self-contained: it swallows its own
            # errors (a failure can't fail the trip), and return_exceptions=True additionally
            # guarantees one stage's raise never cancels its siblings.
            async def _stage_transport():
                try:
                    await record_event(client, trip_id, event_type="stage", stage="transport",
                                       message="computing routes")
                    await persist_transport(client, trip_id, fetch_legs=transport)
                    # persist_transport isolates per-day fetch failures internally (status="failed"
                    # rows, never raises) — surface that as the same non-critical warning.
                    failed_legs = (await client.table("transport_legs").select("id")
                                   .eq("trip_id", trip_id).eq("status", "failed").execute()).data
                    if failed_legs:
                        await record_event(client, trip_id, event_type="warning", stage="transport",
                                           message="transport legs unavailable")
                except Exception:
                    try:
                        await record_event(client, trip_id, event_type="warning", stage="transport",
                                           message="transport legs unavailable")
                    except Exception:
                        pass   # best-effort — transport failure is non-critical

            async def _stage_restaurants():
                try:
                    await record_event(client, trip_id, event_type="stage", stage="restaurants",
                                       message="suggesting restaurants")
                    await persist_restaurants(client, trip_id, suggest=restaurant, preference_block=pref_block)
                except Exception:
                    try:
                        await record_event(client, trip_id, event_type="warning", stage="restaurants",
                                           message="restaurant suggestions unavailable")
                    except Exception:
                        pass   # best-effort — restaurant failure is non-critical

            async def _stage_hotels():
                try:
                    await record_event(client, trip_id, event_type="stage", stage="hotels",
                                       message="searching hotels")
                    await persist_hotels(client, trip_id, fetch=hotel)
                except Exception:
                    try:
                        await record_event(client, trip_id, event_type="warning", stage="hotels",
                                           message="hotel suggestions unavailable")
                    except Exception:
                        pass   # best-effort — hotel failure is non-critical

            async def _stage_narration():
                # MUST run after persist_weather (above): reads trip_days.weather_summary.
                try:
                    await record_event(client, trip_id, event_type="stage", stage="summarize",
                                       message="narrating the trip")
                    await persist_narration(client, trip_id, user_id, narrate=narrator, preference_block=pref_block)
                except Exception:
                    try:
                        await record_event(client, trip_id, event_type="warning", stage="summarize",
                                           message="narration unavailable")
                    except Exception:
                        pass   # best-effort — narration failure is non-critical

            await asyncio.gather(_stage_transport(), _stage_restaurants(),
                                 _stage_hotels(), _stage_narration(), return_exceptions=True)
        except Exception:
            status = "saved_with_gaps"
            await record_event(client, trip_id, event_type="warning", stage="save",
                                message="normalized persistence failed; itinerary saved to the result event only")
        await _set_status(client, trip_id, user_id, status)
        payload = {"itinerary": itinerary.model_dump()}
        await record_event(client, trip_id, event_type="result", stage="save",
                            message="generation complete", payload=payload)
        if job_id:
            await mark_job_done(client, job_id, status="succeeded")
        return payload
    except Exception:
        # Any unexpected error → terminal result, failed status, failed job (never hang the stream).
        if client is None:
            raise  # never got a client → BackgroundTasks logs it; startup recovery sweep re-picks the still-pending job
        return await _fail(client, trip_id, user_id, job_id, "save", "unexpected generation error")
