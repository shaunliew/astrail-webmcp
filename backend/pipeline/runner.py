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
import contextlib
import logging
import os

from models.place import PlaceResult
from pipeline.dedup import dedupe_places
from pipeline.feasibility import group_places_by_day
from pipeline.geo import centroid
from pipeline.offline_harness import _date_range, assemble_itinerary
from pipeline.persist import persist_hotels, persist_itinerary, persist_narration, persist_restaurants, persist_tradeoffs, persist_transport, persist_weather
from pipeline.tradeoffs import build_hotel_comparisons, warnings_to_notes
from jobs import _heartbeat, mark_job_running
from observability import capture_exception as _sentry_capture
from organizer import LeaseLost, authorize_place_ids
from supabase_client import get_supabase_client

# A3: mem0=_UNSET (not None) means "not injected -> resolve the real singleton". Explicit
# mem0=None then unambiguously means "memory disabled" (tests pass None or a fake), so a
# CI run with MEM0_API_KEY set never constructs the real client / hits the network.
_UNSET = object()

logger = logging.getLogger(__name__)


def _n(count: int, noun: str) -> str:
    """'1 Reel' / '3 Reels'. Every `message=` below renders in the user-facing
    decision rail, so `reel(s)` is not an option there — DESIGN.md §7 wants
    decisions in English, not log lines."""
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


async def _complete_trip_run(client, job_id, trip_id, lease_token, *,
                             status, stage, message, payload) -> bool:
    """Terminal write for a leased run: the job's status AND the `result` event in ONE
    fenced transaction. Returns False iff we were superseded — then emit nothing.

    They cannot be two statements. `mark_job_done`'s fence stops a superseded worker writing
    the JOB row, but nothing stops it writing the EVENT — and `api/streaming.py` ends the
    stream on the first `result` row, deduping by row **id**, so a second writer's row is a
    different id and is NOT deduped. The user's session would end on a stale worker's result:
    a failure that isn't real, or an itinerary the replacement has already superseded, with
    the replacement's genuine result never delivered. A fenced UPDATE followed by a separate
    INSERT can still interleave — the update failing while the insert lands. One transaction
    is what makes "no job write => no event write" true rather than merely probable.
    """
    result = await client.rpc("complete_trip_run", {
        "p_job_id": job_id, "p_trip_id": trip_id, "p_lease_token": lease_token,
        "p_status": status, "p_stage": stage, "p_message": message, "p_payload": payload,
    }).execute()
    return bool(result.data)


async def _abort_when_lease_lost(work, lease_lost: asyncio.Event, *, job_id) -> None:
    """Run `work`, CANCELLING it the moment the lease is lost — a race, not a gate.

    A single `if lease_lost.is_set()` in front of a long section is a TOCTOU: the check passes
    and then minutes of work follow (a delete-reinsert of the whole itinerary, four enrich
    stages, and an Agents SDK narration call with no timeout). The heartbeat can mark the lease
    lost anywhere in there, and a worker that only checks at the ends does not notice until it
    reaches one — so it keeps writing on a job a replacement already owns.

    Layering, stated honestly, because none of the three is sufficient alone:
      * the gate before this call rejects a lease already lost (cancellation cannot preempt
        work that never reaches an await point that suspends);
      * this race makes the abort PROMPT rather than eventual;
      * only the DB-side fence (`replace_trip_itinerary`) actually CLOSES the window, since
        the lease can be lost mid-statement and cancellation lands only at await points.

    `LeaseLost` is raised rather than returned so the caller's outer handler treats it exactly
    as a gate's — `_fail` then sees `lease_lost` set and suppresses its unfenced writes.
    """
    task = asyncio.ensure_future(work)
    lost = asyncio.ensure_future(lease_lost.wait())
    try:
        await asyncio.wait({task, lost}, return_when=asyncio.FIRST_COMPLETED)
        if task.done():
            task.result()               # re-raises whatever the work raised, unchanged
            return
        task.cancel()
        # AWAIT the cancellation: the work's own `except`/`finally` blocks must finish before
        # we unwind past it, or teardown races the abort we just started.
        with contextlib.suppress(asyncio.CancelledError):
            await task
        raise LeaseLost(f"trip job {job_id} lease superseded")
    finally:
        # Never leave either future dangling — including when THIS coroutine is the one being
        # cancelled, in which case `task` is still pending and would outlive the run.
        for future in (task, lost):
            if not future.done():
                future.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await future


async def record_event(client, trip_id, *, event_type, stage, message, payload=None) -> None:
    """Insert one generation_events row (progressive persistence + SSE source)."""
    await client.table("generation_events").insert({
        "trip_id": trip_id, "event_type": event_type, "stage": stage,
        "message": message, "payload": payload or {},
    }).execute()


async def _set_status(client, trip_id, user_id, status) -> None:
    # Owner check (guardrail #6): filter on id AND user_id even under service-role.
    await client.table("trips").update({"status": status}).eq("id", trip_id).eq("user_id", user_id).execute()


async def _fail(client, trip_id, user_id, job_id, stage, message, *, lease_token=None,
                lease_lost=None) -> dict:
    """Terminal failure write, structured around WHO owns the fencing.

    On a leased failure the CAS (`complete_trip_run`) is the SOLE terminal writer — it sets
    `jobs.status='failed'`, `trips.status='failed'`, `charge_refunded_at` + the counter refund,
    and the terminal `result` event, all in ONE fenced transaction (Fix 5, RPC B). So we call it
    REGARDLESS of `lease_lost` and let the CAS arbitrate: a worker superseded by a replacement
    loses the CAS and writes nothing (there is no unfenced `error` event or `_set_status` left to
    leak); a worker that lost its lease to a transient partition but STILL owns the row wins the
    CAS and delivers the terminal result promptly (no silent spinner — the launch-audit P1). This
    is why `lease_lost` no longer gates anything here: the heartbeat sets it in two cases it cannot
    tell apart — a replacement truly claimed the job, OR the row is merely unreachable past the TTL
    while THIS worker still owns it — and short-circuiting on it would drop the terminal result in
    the second case. The CAS's own predicate (id + lease_token + status='running' + trip_id) makes
    that distinction authoritatively.

    Unfenced best-effort writes remain ONLY for the no-lease fallbacks. A no-lease worker is never
    superseded — the heartbeat that sets `lease_lost` runs only for a leased worker — so no gate is
    needed there. Each is independent so one Supabase error (e.g. the original failure was
    connectivity) doesn't block the others; the terminal `result` event is the load-bearing one,
    because the SSE stream ends on it. A run that never owned the job MUST NOT write the job's
    terminal state (that is the reaper's row), which is why the no-`job_id` branch emits the result
    event directly while the has-`job_id`-but-no-token branch leaves it to the reaper.

    `lease_lost` is retained in the signature for caller compatibility but no longer gates any
    write — the CAS does the fencing now.
    """
    if job_id is not None and lease_token is not None:
        try:
            ok = await _complete_trip_run(client, job_id, trip_id, lease_token, status="failed",
                                          stage=stage, message="Astrail couldn't finish this trip",
                                          payload={"error": message})
            logger.info("trip_fail_fenced job_id=%s won=%s", job_id, ok)
        except Exception:
            # This CAS is now the SOLE terminal writer AND the refund site (Fix 5), so a silent
            # miss here means no result event, no refund, and no trace. Still swallow (a terminal
            # failure must not cascade), but log the traceback — the call is Supabase-only, so the
            # text carries DB error detail, not a credential (same posture as the reap loop).
            logger.warning("trip_fail_fenced_error job_id=%s", job_id, exc_info=True)
        return {"error": message}

    # Unfenced fallbacks — no lease to fence with; best-effort writes are all we have.
    try:
        await record_event(client, trip_id, event_type="error", stage=stage, message=message)
    except Exception:
        pass
    try:
        await _set_status(client, trip_id, user_id, "failed")
    except Exception:
        pass
    if job_id is None:
        # No durable job to fence against — the terminal result is still REQUIRED, because
        # the SSE stream ends on it.
        try:
            await record_event(client, trip_id, event_type="result", stage=stage,
                                message="Astrail couldn't finish this trip", payload={"error": message})
        except Exception:
            pass
    # else job present but never leased → the reaper owns the terminal result — unchanged.
    return {"error": message}


async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                          *, job_id=None, pace="balanced", preferences=None, destination_hint=None,
                          place_ids=None,
                          client=None, scrape=None, extract=None, mem0=_UNSET,
                          weather=None, transport=None, restaurant=None, narrator=None, hotel=None) -> dict:
    """Run the deterministic spine; own the job lifecycle; always write a terminal result."""
    lease_token = None      # in scope for the pre-claim failure path, which must NOT finalize
    lease_lost = asyncio.Event()
    beat = None
    try:
        if client is None:
            client = await get_supabase_client()

        place_ids = place_ids or []
        if not place_ids and scrape is None:
            from scrape.apify_direct import scrape_reel
            token = os.environ["APIFY_TOKEN"]

            async def scrape(url):
                return await scrape_reel(url, token=token)
        if not place_ids and extract is None:
            from genagents.place_extractor import extract_places
            extract = extract_places

        # Atomic claim guard (amendment §C): abort BEFORE any work if another instance
        # already owns this job (double-run guard on recovery + original dispatch racing).
        # The claim mints this attempt's lease token — every terminal write is fenced on it.
        if job_id:
            lease_token = await mark_job_running(client, job_id)
            if lease_token is None:
                return {"skipped": "job already claimed by another run"}
            # Started only AFTER the claim is won: a loser that started a beat would be
            # renewing the WINNER's lease. Cancelled in this function's `finally`.
            beat = asyncio.create_task(_heartbeat(client, job_id, lease_token, lease_lost))

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

        if place_ids:
            # Organized-place trips are deliberately a separate branch: selected
            # canonical IDs are owner-checked through Saved Reel proof and never
            # trigger a second scrape, extraction, or paid analysis.
            selected = await authorize_place_ids(client, user_id, place_ids)
            places = [PlaceResult(
                name=row["name"], category=row.get("place_type", "other"),
                lat=row["lat"], lng=row["lng"], confidence=row.get("confidence", 0.0),
                evidence_quote=row.get("evidence_quote", "Organized from a Saved Reel"),
                source_type="reel_extracted", source_url=row.get("source_url"),
                source_reel_url=row.get("source_reel_url"),
                city_or_region_guess=row.get("city"),
            ) for row in selected]
            await record_event(client, trip_id, event_type="stage", stage="cache_hit",
                               message=f"Using the {_n(len(places), 'place')} you organized")
        else:
            # PHASE 1+2: SCRAPE + EXTRACT, with a per-reel EXTRACTION CACHE. A repeat
            # reel (same normalized URL + EXTRACTOR_VERSION) skips BOTH scrape and
            # extract. Cache writes are best-effort for the existing trip flow.
            from genagents.place_extractor import EXTRACTOR_VERSION
            from pipeline.cache import cache_places, get_cached_places

            # Per-reel results indexed by reel_urls position, so `places` is assembled
            # in reel-URL order regardless of cache state.
            results: list[list[PlaceResult] | None] = [None] * len(reel_urls)
            miss_idx: list[int] = []
            n_hit = 0
            for i, url in enumerate(reel_urls):
                try:
                    cached = await get_cached_places(client, url, EXTRACTOR_VERSION)
                except Exception as exc:
                    # See organizer._process_item's mirror of this handler: unlogged, a real
                    # bug here is indistinguishable from a transient blip and shows up only as
                    # extra provider spend.
                    logger.warning(
                        "trip_cache_read_blip url=%s error=%s", url, type(exc).__name__
                    )
                    cached = None
                if cached is not None:
                    results[i] = cached
                    n_hit += 1
                else:
                    miss_idx.append(i)
            if n_hit:
                await record_event(client, trip_id, event_type="stage", stage="cache_hit",
                                   message=f"Reused {_n(n_hit, 'Reel')} Astrail had already read")

            if miss_idx:
                await record_event(client, trip_id, event_type="stage", stage="scrape",
                                   message=f"Reading {_n(len(miss_idx), 'Reel')}")
                scraped = await asyncio.gather(*[scrape(reel_urls[i]) for i in miss_idx],
                                               return_exceptions=True)
                to_extract: list[tuple[int, object]] = []
                for i, res in zip(miss_idx, scraped):
                    if isinstance(res, Exception):
                        degraded = True
                        await record_event(client, trip_id, event_type="warning", stage="scrape",
                                           message=f"Couldn't read one Reel: {reel_urls[i]}")
                    else:
                        to_extract.append((i, res))
                if to_extract:
                    await record_event(client, trip_id, event_type="stage", stage="extract",
                                       message=f"Finding places in {_n(len(to_extract), 'Reel')}")
                    extracted = await asyncio.gather(*[extract(reel) for _i, reel in to_extract],
                                                     return_exceptions=True)
                    for (i, reel), res in zip(to_extract, extracted):
                        if isinstance(res, Exception):
                            degraded = True
                            await record_event(client, trip_id, event_type="warning", stage="extract",
                                               message="Couldn't find places in one Reel")
                        else:
                            results[i] = res
                            try:
                                await cache_places(client, reel_urls[i], reel, res, EXTRACTOR_VERSION)
                            except Exception:
                                pass

            # `results[i]` is aligned to `reel_urls[i]` (see the per-reel loop above). Flattening
            # is where that provenance was being thrown away, which is why every reel-extracted
            # place carried a research URL under a `reel_quote` label. Capture it here.
            places = [
                p.model_copy(update={"source_reel_url": reel_urls[i]})
                for i, r in enumerate(results) if r
                for p in r
            ]
        if not places:
            return await _fail(client, trip_id, user_id, job_id, "extract",
                                "no verified places after extraction", lease_token=lease_token)

        await record_event(client, trip_id, event_type="stage", stage="dedup",
                            message=f"Checking {_n(len(places), 'place')} for duplicates")
        canonical = dedupe_places(places).places

        # NARRATE — route assembly (deterministic)
        await record_event(client, trip_id, event_type="stage", stage="narrate",
                            message="Putting your days in order")
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
                                   message="Checking the forecast")
                weather_reports = await weather(center[0], center[1], dates)
        except Exception as exc:
            weather_reports = []
            # Log the TYPE (never the exception text — a provider error body can echo the
            # request). Without this the only trace is a `generation_events` row, so the
            # failure is invisible in Render's logs and looks like the agent never ran.
            #
            # The overwhelmingly common cause is NOT a bug: Open-Meteo's forecast API has a
            # rolling ~16-day horizon and returns HTTP 400 beyond it. `fetch_weather` makes ONE
            # call spanning the whole trip, so a start date past the horizon fails EVERY day at
            # once — which is the default state for any trip planned more than two weeks ahead.
            # Verified live 2026-07-20: start_date=2026-08-14 -> 400 "out of allowed range from
            # 2026-04-18 to 2026-08-04". Degrading to no weather is guardrail #3 working, but it
            # means `trip_days.weather_summary` is null on the COMMON path, not an edge case.
            logger.warning("weather_unavailable trip_id=%s error=%s", trip_id, type(exc).__name__)
            try:
                # The common cause is the ~16-day horizon above, not a fault — say the
                # thing that is true rather than implying something broke.
                await record_event(client, trip_id, event_type="warning", stage="weather",
                                   message="No forecast available this far ahead")
            except Exception:
                pass   # best-effort: a warning-write failure must not fail the trip either

        # GATE — the cheap first layer. It rejects a lease ALREADY lost before any of the save
        # work starts, which the race below cannot: cancellation only lands at an await point
        # that actually suspends, so work that runs straight through would complete regardless.
        if lease_lost.is_set():
            raise LeaseLost(f"trip job {job_id} lease superseded")

        status = "saved_with_gaps" if degraded else "complete"
        await record_event(client, trip_id, event_type="stage", stage="save", message="Saving your trip")

        async def _save_and_enrich() -> None:
            nonlocal status
            try:
                dropped = await persist_itinerary(client, trip_id, canonical, dates,
                                                  job_id=job_id, lease_token=lease_token)
                # The FIRST moment the places are readable. `stage="save"` above is emitted before
                # this call, so no stage event has ever meant "the rows exist" — GenerationScene
                # fetched on the earliest places-bearing stage, found nothing, and latched, which
                # is why pins have never landed progressively while a trip is being built.
                # Best-effort: a failed event write must not fail a trip that is already saved.
                try:
                    await record_event(client, trip_id, event_type="decision", stage="save",
                                       message=f"Saved {_n(len(canonical) - dropped, 'stop')} to your map")
                except Exception:
                    pass
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
                                       message=f"Dropped {_n(dropped, 'place')} — no coordinates found, "
                                               "or already on your list")

                # TRADEOFF NOTES — the FeasibilityWarnings feasibility.py flagged as "the seam".
                # Computed here (warnings + groups in scope); WRITTEN once after the enrich gather.
                try:
                    _tradeoff_notes = warnings_to_notes(
                        itinerary.feasibility_warnings,
                        groups=group_places_by_day(canonical, dates))
                except Exception:
                    _tradeoff_notes = []

                if weather_reports:                       # weather AFTER persist created trip_days (ordering!)
                    try:
                        await persist_weather(client, trip_id, weather_reports)
                    except Exception:
                        try:
                            await record_event(client, trip_id, event_type="warning", stage="weather",
                                               message="Couldn't save the forecast")
                        except Exception:
                            pass   # best-effort — weather persist failure is non-critical

                # Compute the soft-guidance preference block ONCE, before the enrich gather — restaurant
                # and narrator are the only two stages that personalize toward it (Task 4). Self-contained
                # (guardrail #3): a failure here must degrade to no-injection, not skip the entire
                # enrich gather (transport/hotel/narration don't even use pref_block).
                try:
                    from pipeline.preferences import preference_block
                    pref_block = preference_block(pref_ctx)
                except Exception:
                    pref_block = None   # memory personalization is best-effort (guardrail #3): a hiccup
                                        # here must not disable the transport/hotel/narration stages

                # Enrich stages are INDEPENDENT (disjoint write tables) and best-effort (guardrail #3),
                # so run them CONCURRENTLY instead of sequentially (~halves the enrich block latency).
                # Weather is persisted ABOVE, sequentially, because narration reads
                # trip_days.weather_summary. Each coroutine is fully self-contained: it swallows its own
                # errors (a failure can't fail the trip), and return_exceptions=True additionally
                # guarantees one stage's raise never cancels its siblings.
                #
                # The event contract, stated honestly: an outcome signal on the ordinary paths —
                # and sometimes TWO, because a partial transport result has two complementary
                # things to say (what routed, and what did not). It is NOT "exactly one per
                # stage": a hotel LeaseLost returns silently on purpose, an unreadable status
                # leaves nothing true to say, and every outcome write is swallowed on failure
                # because guardrail #3 forbids failing a saved trip over an event row.
                async def _stage_transport():
                    try:
                        await record_event(client, trip_id, event_type="stage", stage="transport",
                                           message="Working out how to get between stops")
                        # persist_transport isolates per-day fetch failures internally (status="failed"
                        # rows, never raises) — surface a raise from HERE as the non-critical warning.
                        await persist_transport(client, trip_id, fetch_legs=transport)
                    except Exception:
                        try:
                            await record_event(client, trip_id, event_type="warning", stage="transport",
                                               message="Couldn't route some stops — check transit")
                        except Exception:
                            pass   # best-effort — transport failure is non-critical
                        return
                    # Everything below only OBSERVES work that is already persisted, so it gets its
                    # OWN handlers: the routing failure above is the only one entitled to say
                    # "Couldn't route".
                    try:
                        # Select `status` rather than `id`: its RETURN VALUE counts rows written, and
                        # a row is written for a leg that failed (status="failed") or found no route
                        # (status="no_route") just as much as for one that routed. Reporting that
                        # number as legs routed would claim work the traveller cannot use, so both
                        # counts come from the statuses — still one query, as before.
                        leg_rows = (await client.table("transport_legs").select("status")
                                    .eq("trip_id", trip_id).execute()).data or []
                    except Exception as exc:
                        # The routing SUCCEEDED and the legs are saved; only the read of their
                        # statuses failed. Sharing the handler above reported that as a routing
                        # failure, sending the traveller to check transit that is fine over a fault
                        # that was never theirs. There is nothing honest left to tell them — the
                        # counts are exactly what could not be read — so tell the engineer instead:
                        # the TYPE only, never the text (guardrail: an error body can echo the query).
                        logger.warning("transport_status_unreadable trip_id=%s error=%s",
                                       trip_id, type(exc).__name__)
                        return
                    # OUTSIDE the persistence try, deliberately: the legs are already persisted here,
                    # so a transient failure writing these events must not be reported as a routing
                    # failure. Reporting one would send the traveller to check transit that is fine.
                    try:
                        # `no_route` counts as unrouted, not just `failed`. Mapbox answering "there
                        # is no route" leaves a stop the traveller cannot reach exactly as a Mapbox
                        # outage does; warning only on `failed` left a whole class of trips saying
                        # nothing at all between dispatch and `result`.
                        unrouted = [r for r in leg_rows if r.get("status") in ("failed", "no_route")]
                        routed = sum(1 for r in leg_rows if r.get("status") == "ok")
                        if unrouted:
                            await record_event(client, trip_id, event_type="warning", stage="transport",
                                               message="Couldn't route some stops — check transit")
                        if routed:
                            await record_event(client, trip_id, event_type="decision", stage="transport",
                                               message=f"Routed {_n(routed, 'leg')} between your stops")
                        elif not leg_rows:
                            # A one-stop-per-day itinerary has no pair to route. That is a normal
                            # outcome, not a failure — but silence here is indistinguishable from a
                            # stage that hung, which is the whole defect this change exists to fix.
                            await record_event(client, trip_id, event_type="decision", stage="transport",
                                               message="No journeys to plan between stops")
                    except Exception:
                        pass   # best-effort — the legs are saved either way

                async def _stage_restaurants():
                    try:
                        await record_event(client, trip_id, event_type="stage", stage="restaurants",
                                           message="Looking for places to eat")
                        eats = await persist_restaurants(client, trip_id, suggest=restaurant,
                                                         preference_block=pref_block)
                    except Exception:
                        try:
                            await record_event(client, trip_id, event_type="warning", stage="restaurants",
                                               message="Couldn't find restaurants near your route")
                        except Exception:
                            pass   # best-effort — restaurant failure is non-critical
                        return
                    # OUTSIDE the persistence try, deliberately: the rows are already written, so a
                    # transient failure recording this event must never surface as a domain failure.
                    # `decision`, not `stage`: a second `stage` event with the same id makes the
                    # finished work read as the CURRENTLY RUNNING one — GenerationProgress pulses
                    # the last stage event, and get_trip_progress reports it as the live stage. A
                    # decision renders as its own beat, wakes the agent's poll, and claims nothing
                    # about what is still running.
                    try:
                        await record_event(client, trip_id, event_type="decision", stage="restaurants",
                                           message=f"Found {_n(eats, 'place')} to eat")
                    except Exception:
                        pass   # best-effort — the restaurants are saved either way

                async def _stage_hotels():
                    try:
                        await record_event(client, trip_id, event_type="stage", stage="hotels",
                                           message="Looking for somewhere to stay")
                        # Lease-fenced write (F3/B): thread the run's job_id + lease_token so the
                        # hotel rewrite rejects a superseded worker via replace_hotel_suggestions,
                        # the same guarantee persist_itinerary has. A lost lease surfaces as a
                        # swallowed LeaseLost here (best-effort stage) — the outer
                        # `_abort_when_lease_lost` race is what actually aborts the run.
                        written = await persist_hotels(client, trip_id, fetch=hotel,
                                                       job_id=job_id, lease_token=lease_token)
                    except LeaseLost:
                        # A superseded run: the fenced hotel RPC refused our write because a
                        # replacement worker owns this job. Return WITHOUT recording a warning — a
                        # "couldn't find hotels" event here would pollute the REPLACEMENT's live
                        # event stream. This is NOT a hotel-search failure; the run's lease backstops
                        # (`_abort_when_lease_lost` / the fenced completion) drive the actual abort.
                        return
                    except Exception:
                        try:
                            await record_event(client, trip_id, event_type="warning", stage="hotels",
                                               message="Couldn't find hotels near your route")
                        except Exception:
                            pass   # best-effort — hotel failure is non-critical
                        return
                    # OUTSIDE the persistence try, deliberately: the rows are already written, so a
                    # transient failure recording this event must never surface as a domain failure.
                    # `decision`, not `stage`: a second `stage` event with the same id makes the
                    # finished work read as the CURRENTLY RUNNING one — GenerationProgress pulses
                    # the last stage event, and get_trip_progress reports it as the live stage. A
                    # decision renders as its own beat, wakes the agent's poll, and claims nothing
                    # about what is still running.
                    try:
                        if not written:
                            # An empty result used to record NOTHING, so "we looked and found none"
                            # and "Travala failed silently" were indistinguishable from outside —
                            # for the traveller reading the trip and for anyone debugging it later.
                            # Weather already makes that distinction ("No forecast available this
                            # far ahead").
                            #
                            # Worded WITHOUT claiming a search happened, deliberately. Zero rows
                            # also means "no search ran": persist_hotels needs a city or a
                            # destination_hint plus both dates, and a trip whose places carry no
                            # city and whose hint is empty returns 0 having called nothing. "No
                            # hotels available for these dates" would report a result for a search
                            # that never occurred. `phase` in the log tells an engineer which it
                            # was; the event only has to make the absence visible.
                            #
                            # Out here rather than beside the persist call: a transient failure
                            # writing THIS warning used to fall into the generic handler and report
                            # "Couldn't find hotels near your route" — a search failure, for a
                            # search that ran fine and simply found nothing.
                            await record_event(client, trip_id, event_type="warning", stage="hotels",
                                               message="No hotel suggestions for this trip")
                        else:
                            await record_event(client, trip_id, event_type="decision", stage="hotels",
                                               message=f"Found {_n(written, 'place')} to stay")
                    except Exception:
                        pass   # best-effort — the hotels are saved either way

                async def _stage_narration():
                    # MUST run after persist_weather (above): reads trip_days.weather_summary.
                    try:
                        await record_event(client, trip_id, event_type="stage", stage="summarize",
                                           message="Writing your day summaries")
                        narrated = await persist_narration(client, trip_id, user_id, narrate=narrator,
                                                           preference_block=pref_block)
                    except Exception:
                        try:
                            await record_event(client, trip_id, event_type="warning", stage="summarize",
                                               message="Couldn't write the day summaries")
                        except Exception:
                            pass   # best-effort — narration failure is non-critical
                        return
                    # OUTSIDE the persistence try, deliberately: the rows are already written, so a
                    # transient failure recording this event must never surface as a domain failure.
                    # `decision`, not `stage`: a second `stage` event with the same id makes the
                    # finished work read as the CURRENTLY RUNNING one — GenerationProgress pulses
                    # the last stage event, and get_trip_progress reports it as the live stage. A
                    # decision renders as its own beat, wakes the agent's poll, and claims nothing
                    # about what is still running.
                    try:
                        await record_event(client, trip_id, event_type="decision", stage="summarize",
                                           message=f"Wrote summaries for {_n(narrated, 'day')}")
                    except Exception:
                        pass   # best-effort — the summaries are saved either way

                await asyncio.gather(_stage_transport(), _stage_restaurants(),
                                     _stage_hotels(), _stage_narration(), return_exceptions=True)

                # ONE tradeoffs write (notes computed pre-gather + comparisons from persisted hotels).
                # No read-modify-write; best-effort (a failure must never fail the trip, guardrail #3).
                _comparisons = []
                try:
                    _hotel_rows = (await client.table("hotel_suggestions")
                                   .select("id,name,star_rating,price_snapshot")
                                   .eq("trip_id", trip_id).execute()).data or []
                    _comparisons = build_hotel_comparisons(_hotel_rows)
                except Exception:
                    _comparisons = []   # a hotel-query blip must NOT discard the independently-valid notes
                try:
                    await persist_tradeoffs(client, trip_id, user_id,
                                            notes=_tradeoff_notes, comparisons=_comparisons)
                except Exception:
                    pass   # best-effort — tradeoffs must never fail the trip
            except LeaseLost:
                # NOT a degraded persistence outcome. `replace_trip_itinerary`'s fence rejected
                # us, which is an authoritative statement that a replacement owns this job — so
                # record what the heartbeat has not noticed yet and abort. Swallowed into the
                # handler below it would become `saved_with_gaps`, and this worker would go on
                # to stamp a terminal status over the live run's.
                lease_lost.set()
                raise
            except Exception:
                status = "saved_with_gaps"
                await record_event(client, trip_id, event_type="warning", stage="save",
                                    message="normalized persistence failed; itinerary saved to the result event only")

        # RACE the whole save+enrich section against the heartbeat instead of gating once in
        # front of it: everything above is a delete-reinsert of the itinerary plus four enrich
        # stages plus an unbounded narration call, and a worker superseded anywhere inside it
        # must stop there rather than at the far end.
        await _abort_when_lease_lost(_save_and_enrich(), lease_lost, job_id=job_id)

        if lease_lost.is_set():
            raise LeaseLost(f"trip job {job_id} lease superseded")
        await _set_status(client, trip_id, user_id, status)
        payload = {"itinerary": itinerary.model_dump()}
        if job_id is None:
            await record_event(client, trip_id, event_type="result", stage="save",
                                message="Your trip is ready", payload=payload)
        else:
            # The job status and the terminal result land together or not at all.
            superseded = False
            try:
                superseded = not await _complete_trip_run(
                    client, job_id, trip_id, lease_token, status="succeeded", stage="save",
                    message="Your trip is ready", payload=payload)
            except Exception:
                try:
                    await record_event(client, trip_id, event_type="warning", stage="save",
                                       message="job completion mark failed; recovery may re-sweep")
                except Exception:
                    pass   # post-persistence: a failure here must never re-enter _fail / flip the trip
            if superseded:
                # A replacement owns this run and has written (or will write) the real
                # terminal state. Emit nothing further — not even the memory write-back.
                logger.warning("trip_run_superseded job_id=%s", job_id)
                return payload

        # WRITE-BACK — AFTER the terminal `result` (stream already ended → invisible),
        # AWAITED (not create_task → no GC risk). Wrapped in its OWN try/except: memory
        # write-back is best-effort past the point of no return — a raise here must
        # never emit a second result or flip an already-succeeded trip (guardrail #3).
        # persist_trip_memory already swallows its own mem0/DB errors; this outer guard
        # covers an unexpected raise from the write-back itself.
        try:
            from pipeline.preferences import persist_trip_memory
            await persist_trip_memory(client, mem0, user_id=user_id, trip_id=trip_id,
                                      ctx=pref_ctx)
        except Exception:
            try:
                await record_event(client, trip_id, event_type="warning", stage="save",
                                   message="memory write-back unavailable")
            except Exception:
                pass   # best-effort: even the warning-write must not fail the (already-saved) trip
        return payload
    except Exception as exc:
        # Any unexpected error → terminal result, failed status, failed job (never hang the stream).
        # Capture the crash for monitoring (no-op unless SENTRY_DSN set) BEFORE the _fail branch, so
        # even the client-is-None re-raise is seen. Scrubbed en route — provider error bodies that
        # echo a token are redacted by observability._before_send.
        _sentry_capture(exc)
        if client is None:
            raise  # never got a client → BackgroundTasks logs it; startup recovery sweep re-picks the still-pending job
        return await _fail(client, trip_id, user_id, job_id, "save", "unexpected generation error",
                           lease_token=lease_token, lease_lost=lease_lost)
    finally:
        # A leaked beat would go on renewing the lease of a run that has already finished,
        # holding a completed job against the reaper. `lease_lost` doubles as the beat's
        # shutdown flag, so setting it stops the loop even if the cancel races the sleep.
        lease_lost.set()
        if beat is not None:
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat
