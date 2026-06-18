"""
Phase 2 spike — end-to-end driver chaining spike_e2e + spike_planner.

  reel URLs ──► Apify MCP scrape ──► place_extractor ──► enricher ──► narrator
                                                                       │
                                                                       ▼
                                                              ItineraryOutput
                                                              + per-attraction URLs

Three-layer cache fallback (ordered):
  1. USE_CACHE=true env var ⇒ skip extraction entirely, load data/places.json
  2. Extraction timeout (>30s per CLAUDE.md) OR empty result ⇒ load data/places.json
  3. Pipeline timeout OR planner exception ⇒ return last cached ItineraryOutput

Usage:
    uv run python backend/spike_e2e_planner.py

Required env vars:
    OPENAI_API_KEY
    APIFY_TOKEN
    DEMO_REEL_URLS  (comma-separated)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Optional

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

from agents.mcp import MCPServerStreamableHttp

from spike_e2e import (
    PlaceResult as ExtractedPlace,
    ReelData,
    _extract_for_reel,
    _scrape_reel,
)
from spike_planner import (
    ItineraryOutput,
    PlaceResult as PlannerPlace,
    UserPreferences,
    run_planner,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

_EXTRACTION_TIMEOUT = 280.0  # empirical: spike_e2e.py takes ~215s for 4 reels through MCP+agent loop; 280s gives 65s buffer before cache fallback
_PIPELINE_TIMEOUT = 500.0    # 280s extraction + 215s planner (_GLOBAL_TIMEOUT) + 5s overhead — covers happy-path live run
_MAX_PLACES = 5              # cap places passed to planner — keeps enricher within its 155s budget (5+2+1=8 searches matches Phase 1.5 tuning)


# ---------------------------------------------------------------------------
# Stage 1+2 — reels → flat deduped place list
# ---------------------------------------------------------------------------


async def run_extraction(reel_urls: list[str]) -> list[ExtractedPlace]:
    """Reels → flat, deduped list of ExtractedPlace. Reuses spike_e2e internals.

    Stage 1: Apify MCP scrapes sequentially inside one MCP context (~4s/reel).
    Stage 2: place_extractor runs in PARALLEL via asyncio.gather; latency = max(single_reel).
    """
    async with MCPServerStreamableHttp(
        name="Apify MCP Server",
        params={
            "url": "https://mcp.apify.com/?tools=actors,docs,apify/instagram-reel-scraper",
            "headers": {"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
            "timeout": 120,
        },
        cache_tools_list=True,
        max_retry_attempts=3,
        client_session_timeout_seconds=300,
    ) as server:
        scrapes: list[tuple[str, ReelData, int]] = []
        for url in reel_urls:
            try:
                scrapes.append(await _scrape_reel(server, url))
            except Exception as exc:
                logger.warning("Reel scrape failed %s: %s", url, exc)

    valid = [r for r in scrapes if r[1].caption or r[1].location_name]
    if not valid:
        return []

    extractions = await asyncio.gather(
        *[_extract_for_reel(reel, url) for url, reel, _ in valid],
        return_exceptions=True,
    )
    per_reel: list[list[ExtractedPlace]] = []
    for record in extractions:
        if isinstance(record, BaseException):
            logger.warning("Extraction failed: %s", record)
            continue
        per_reel.append(record[0].places)
    return _flatten_and_dedup_by_name(per_reel)


def _flatten_and_dedup_by_name(
    per_reel: list[list[ExtractedPlace]],
) -> list[ExtractedPlace]:
    """Flatten per-reel results; dedup by lowercase name; keep highest-confidence copy."""
    seen: dict[str, ExtractedPlace] = {}
    for places in per_reel:
        for p in places:
            key = p.name.strip().lower()
            if key not in seen or p.confidence > seen[key].confidence:
                seen[key] = p
    return list(seen.values())


def _top_n_by_confidence(places: list[ExtractedPlace], n: int) -> list[ExtractedPlace]:
    """Keep the top-n highest-confidence places. Stable sort preserves dedup order on ties.

    Why cap: planner's _ENRICHER_TIMEOUT was tuned for 4-6 places (8 web searches).
    Each extra place adds one search. Low-confidence places (<0.7) were inferred from
    free text — dropping them first preserves explicit caption/location signals (📍, @).
    """
    return sorted(places, key=lambda p: -p.confidence)[:n]


# ---------------------------------------------------------------------------
# Cache fallbacks
# ---------------------------------------------------------------------------


def _cache_path(filename: str) -> str:
    return os.path.join(os.path.dirname(__file__), "data", filename)


def _load_cached_places() -> list[ExtractedPlace]:
    """Replay committed backend/data/places.json. Raises FileNotFoundError if not seeded."""
    with open(_cache_path("places.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    return [ExtractedPlace.model_validate(p) for p in data["places"]]


def _write_cached_places(places: list[ExtractedPlace]) -> None:
    """Self-seed backend/data/places.json after a successful live extraction.

    First live success populates the cache; every subsequent live run refreshes it.
    Removes the manual pre-extract step from the demo prep checklist.
    """
    os.makedirs(os.path.dirname(_cache_path("places.json")), exist_ok=True)
    payload = {"places": [p.model_dump(mode="json") for p in places]}
    with open(_cache_path("places.json"), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
    logger.info("Cached %d extracted places to %s", len(places), _cache_path("places.json"))


def _load_cached_itinerary() -> Optional[ItineraryOutput]:
    """Return last successful planner output (with source='cache'); None if not seeded."""
    path = _cache_path("planner_output.json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    out = ItineraryOutput.model_validate(data)
    return out.model_copy(update={"source": "cache"})


# ---------------------------------------------------------------------------
# Pipeline orchestration
# ---------------------------------------------------------------------------


async def run_pipeline(
    reel_urls: list[str], prefs: UserPreferences
) -> ItineraryOutput:
    """End-to-end: extraction + planning, with three-layer cache fallback."""

    async def _inner() -> ItineraryOutput:
        if os.environ.get("USE_CACHE", "").lower() == "true":
            logger.info("USE_CACHE=true — skipping extraction, loading data/places.json")
            places: list[ExtractedPlace] = _load_cached_places()
        else:
            try:
                places = await asyncio.wait_for(
                    run_extraction(reel_urls), timeout=_EXTRACTION_TIMEOUT
                )
                if places:
                    _write_cached_places(places)  # self-seed cache on every live success
            except asyncio.TimeoutError:
                logger.warning(
                    "Extraction >%.0fs — falling back to cached places",
                    _EXTRACTION_TIMEOUT,
                )
                places = _load_cached_places()
            if not places:
                logger.warning("Extraction returned 0 places — falling back to cached places")
                places = _load_cached_places()
        # Cap places — planner's enricher timeout assumes ~5 places (~8 web searches).
        # Drop lowest-confidence first; high-confidence places came from explicit 📍/@ signals.
        if len(places) > _MAX_PLACES:
            logger.info(
                "Capping places: %d → %d by confidence (planner tuned for ~%d)",
                len(places), _MAX_PLACES, _MAX_PLACES,
            )
            places = _top_n_by_confidence(places, _MAX_PLACES)

        # ExtractedPlace carries extras (formatted_address, evidence_frame_index).
        # Explicit model_validate exercises PlannerPlace.model_config (extra="ignore")
        # instead of duck-typing — bridges the two schemas cleanly.
        planner_places = [PlannerPlace.model_validate(p.model_dump()) for p in places]
        return await run_planner(planner_places, prefs)

    # Outer try covers BOTH the planner exception path AND the _PIPELINE_TIMEOUT.
    # If anything fails AND we have a prior successful itinerary on disk, the demo continues.
    try:
        return await asyncio.wait_for(_inner(), timeout=_PIPELINE_TIMEOUT)
    except Exception as exc:
        cached = _load_cached_itinerary()
        if cached is None:
            logger.error("Pipeline failed and no cached itinerary available: %s", exc)
            raise
        logger.warning("Pipeline failed (%s) — returning last cached itinerary", exc)
        return cached


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    raw = os.environ.get("DEMO_REEL_URLS") or os.environ.get("DEMO_REEL_URL", "")
    reel_urls = [u.strip() for u in raw.split(",") if u.strip()]
    if not reel_urls:
        raise EnvironmentError("set DEMO_REEL_URLS (comma-separated) or DEMO_REEL_URL in .env")

    prefs = UserPreferences(
        start_date="2026-06-10",
        end_date="2026-06-13",
        budget_level="mid_range",
        free_text="love ramen and onsen, prefer walking-friendly areas",
        origin_city="Singapore",
    )

    print("=" * 65)
    print("Phase 2 — E2E Driver (reels → itinerary)")
    print("=" * 65)
    print(f"Reels ({len(reel_urls)}):")
    for u in reel_urls:
        print(f"  - {u}")
    print(f"Dates : {prefs.start_date} → {prefs.end_date}")
    print(f"Budget: {prefs.budget_level}  |  {prefs.free_text}")
    print(f"From  : {prefs.origin_city or '(no origin)'}")
    print()

    t0 = time.monotonic()
    result = asyncio.run(run_pipeline(reel_urls, prefs))
    elapsed = time.monotonic() - t0

    print(f"\n{'─' * 65}")
    print(f"Title  : {result.title}")
    print(f"Days   : {len(result.days)}")
    print(f"Places : {result.source_places}")
    print(f"Source : {result.source}")
    print(f"Time   : {elapsed:.1f}s")
    print(f"\nRecommended Hotel  : {result.recommended_hotel or '(none)'}")
    print(f"Hotel Booking URL  : {result.hotel_booking_url or '(no direct link)'}")
    print(f"Recommended Flight : {result.recommended_flight or '(skipped)'}")
    print(f"Flight Booking URL : {result.flight_booking_url or '(no direct link)'}")
    print()
    print(f"Per-attraction URLs ({len(result.places)}):")
    for pi in result.places:
        print(f"  - {pi.name:<35} {pi.source_url or '(no direct link)'}")
    print()

    # Persist BOTH paths:
    #   planner_output.json — canonical cache read by _load_cached_itinerary fallback
    #   e2e_planner_output.json — extra debug artifact for this spike
    out_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(out_dir, exist_ok=True)
    canonical = os.path.join(out_dir, "planner_output.json")
    debug = os.path.join(out_dir, "e2e_planner_output.json")
    serialized = result.model_dump_json(indent=2)
    for path in (canonical, debug):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(serialized)
    print(f"Output saved to:\n  {canonical}  (canonical cache)\n  {debug}  (debug)")
