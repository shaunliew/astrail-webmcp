"""Offline pipeline skeleton tests — produces eval-shaped output, no API key."""
from pathlib import Path

import pytest

from pipeline.offline_harness import (
    assemble_days_naive,
    dedup_passthrough,
    run_offline_pipeline,
)
from pipeline.output import PipelineOutput

FIX = Path(__file__).parent / "fixtures"


def test_dedup_passthrough_is_identity():
    places = [{"name": "A"}, {"name": "B"}]
    out = dedup_passthrough(places)
    assert out == places
    assert out is not places  # returns a new list (immutability)


def test_assemble_days_naive_chunks_in_input_order():
    places = [{"name": "A"}, {"name": "B"}, {"name": "C"}]
    days = assemble_days_naive(places, ["2026-06-10", "2026-06-11"])
    assert [d["day_number"] for d in days] == [1, 2]
    assert days[0]["place_names"] == ["A", "B"]  # extra goes to earlier day
    assert days[1]["place_names"] == ["C"]


def test_assemble_days_naive_rejects_zero_dates():
    with pytest.raises(ValueError):
        assemble_days_naive([{"name": "A"}], [])


def test_run_offline_pipeline_returns_eval_shaped_output():
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
    )
    assert isinstance(out, PipelineOutput)
    # reels surfaced from the scrape seam
    assert [r["short_code"] for r in out.reels] == ["MINI_AAA", "MINI_BBB"]
    # places surfaced from the extract seam (identity dedup -> both kept)
    assert [p["name"] for p in out.places] == ["Cafe Alpha", "Beta Ramen"]
    # itinerary shape matches what backend/evals consumes
    it = out.itinerary
    assert it["source"] == "pipeline"
    assert it["source_places"] == ["Cafe Alpha", "Beta Ramen"]
    assert len(it["days"]) == 2
    assert it["days"][0]["place_names"] == ["Cafe Alpha"]
    assert it["days"][1]["place_names"] == ["Beta Ramen"]


def test_run_offline_pipeline_rejects_reversed_dates():
    with pytest.raises(ValueError):
        run_offline_pipeline(
            reels_path=FIX / "mini_reels.json",
            places_path=FIX / "mini_places.json",
            start_date="2026-06-12",
            end_date="2026-06-10",
        )


class _Ticker:
    def __init__(self, step: float = 1.0) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self._step
        return v


def test_run_offline_pipeline_records_deterministic_timings():
    # clock calls in order: total_start, scrape(start,end), extract(start,end),
    # dedup(start,end), narrate(start,end), total_end -> values 0..9
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
        clock=_Ticker(),
    )
    assert out.timings == {
        "scrape": 1.0, "extract": 1.0, "dedup": 1.0, "narrate": 1.0, "total": 9.0,
    }


def test_run_offline_pipeline_default_clock_records_floats():
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
    )
    assert set(out.timings) == {"scrape", "extract", "dedup", "narrate", "total"}
    assert all(isinstance(v, float) and v >= 0.0 for v in out.timings.values())
