"""Offline pipeline skeleton — runs the (eventual) generation pipeline from
recorded fixtures, producing output in the shape backend/evals/ scores.

Step 2 scope: PLUMBING ONLY. Every stage is a fixture-backed placeholder —
no LLM agents, no live Apify / Mapbox / Supabase. Real stages replace them later:
  * scrape  -> FixtureReelSource now;  live Apify direct HTTP (Step 5)
  * extract -> FixturePlaceSource now; place_extractor agent (Step 5/6)
  * dedup   -> identity passthrough now; two-gate semantic+geo (Step 6)
  * narrate -> naive input-order day chunking now; feasibility ordering (Step 7)

The naive day chunking is deliberately a SEPARATE implementation from
evals/baseline.py: baseline.py is the frozen legacy bar to beat and must not
change as this pipeline improves. They coincide today on the Japan demo set
(8 distinct-name, all-coords places) — that equality is the regression anchor
proving the eval seam is wired with zero behaviour drift.
"""
from __future__ import annotations

import time
from datetime import date, timedelta
from pathlib import Path

from pipeline.output import PipelineOutput
from pipeline.sources import (
    FixturePlaceSource,
    FixtureReelSource,
    Source,
    resolve,
)
from pipeline.timing import Clock, Stopwatch


def _date_range(start_date: str, end_date: str) -> list[str]:
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if end < start:
        raise ValueError(f"end_date {end_date} < start_date {start_date}")
    return [
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    ]


def dedup_passthrough(places: list[dict]) -> list[dict]:
    """Identity dedup (Step 2 placeholder). Step 6 replaces it with semantic+geo.

    Returns a NEW list — never mutate the caller's list (immutability).
    """
    return list(places)


def assemble_days_naive(places: list[dict], dates: list[str]) -> list[dict]:
    """Split places in input order into len(dates) near-even contiguous chunks.

    Pipeline-owned naive narrate (Step 2 placeholder). Step 7 replaces it with
    route-aware feasibility ordering. Kept separate from evals/baseline.py on
    purpose (the legacy bar stays frozen; this stage evolves).
    """
    n, d = len(places), len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    base, extra = divmod(n, d)
    days: list[dict] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        days.append({
            "day_number": i + 1,
            "date": day_date,
            "place_names": [p["name"] for p in group],
        })
    return days


def run_offline_pipeline(
    reels_path: Path,
    places_path: Path,
    start_date: str,
    end_date: str,
    *,
    live_reels: Source | None = None,
    live_places: Source | None = None,
    clock: Clock = time.perf_counter,
) -> PipelineOutput:
    """Run the fixture-backed pipeline end-to-end, offline, deterministically.

    `live_*` are seams for Step 5's live sources; in Step 2 they are always None.
    `clock` is injectable so timing is deterministic in tests (default perf_counter).
    Records per-stage + total wall-clock into the returned PipelineOutput.timings.
    """
    sw = Stopwatch(clock=clock)
    t0 = clock()
    with sw.stage("scrape"):
        reels = resolve(live_reels, FixtureReelSource(reels_path))
    with sw.stage("extract"):
        extracted = resolve(live_places, FixturePlaceSource(places_path))
    with sw.stage("dedup"):
        canonical = dedup_passthrough(extracted)
    with sw.stage("narrate"):
        dates = _date_range(start_date, end_date)
        days = assemble_days_naive(canonical, dates)
        itinerary = {
            "title": "Tokyo (offline pipeline skeleton)",
            "source": "pipeline",
            "source_places": [p["name"] for p in canonical],
            "days": days,
        }
    sw.mark_total(t0)
    return PipelineOutput(reels=reels, places=canonical, itinerary=itinerary, timings=sw.timings)
