"""Offline pipeline skeleton — runs the (eventual) generation pipeline from
recorded fixtures, producing output in the shape backend/evals/ scores.

Step 2 scope: PLUMBING ONLY. Every stage is a fixture-backed placeholder —
no LLM agents, no live Apify / Mapbox / Supabase. Real stages replace them later:
  * scrape  -> FixtureReelSource now;  live Apify direct HTTP (Step 5)
  * extract -> FixturePlaceSource now; place_extractor agent (Step 5/6)
  * dedup   -> two-gate alias+geo (Step 6)
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

from models.place import CanonicalPlace, PlaceResult
from models.reel import ReelData
from models.trip import ItineraryDay, ItineraryOutput
from pipeline.dedup import dedupe_places
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


def assemble_itinerary(places: list[CanonicalPlace], dates: list[str]) -> ItineraryOutput:
    """Split places in input order into len(dates) near-even contiguous chunks.

    Pipeline-owned naive narrate (placeholder). Step 7 replaces it with
    route-aware feasibility ordering. Kept separate from evals/baseline.py.
    """
    n, d = len(places), len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    base, extra = divmod(n, d)
    days: list[ItineraryDay] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        days.append(ItineraryDay(day_number=i + 1, date=day_date,
                                 place_names=[p.name for p in group]))
    return ItineraryOutput(
        title="Tokyo (offline pipeline skeleton)",
        source="pipeline",
        source_places=[p.name for p in places],
        days=days,
    )


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

    Stages now go through typed contracts (ReelData, PlaceResult, CanonicalPlace,
    ItineraryOutput); the eval boundary stays dicts via model_dump(). `clock` is
    injectable for deterministic timing tests.
    """
    sw = Stopwatch(clock=clock)
    t0 = clock()
    with sw.stage("scrape"):
        reels = [ReelData.model_validate(r)
                 for r in resolve(live_reels, FixtureReelSource(reels_path))]
    with sw.stage("extract"):
        extracted = [PlaceResult.model_validate(p)
                     for p in resolve(live_places, FixturePlaceSource(places_path))]
    with sw.stage("dedup"):
        canonical = dedupe_places(extracted).places   # two-gate alias+geo, confidence-capped
    with sw.stage("narrate"):
        dates = _date_range(start_date, end_date)
        itinerary = assemble_itinerary(canonical, dates)
    sw.mark_total(t0)
    return PipelineOutput(
        reels=[r.model_dump() for r in reels],
        places=[p.model_dump() for p in canonical],
        itinerary=itinerary.model_dump(),
        timings=sw.timings,
    )
