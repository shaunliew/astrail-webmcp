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
