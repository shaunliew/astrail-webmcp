"""Output contract tests — the boundary the offline eval scores."""
import dataclasses

import pytest

from pipeline.output import PipelineOutput


def _sample() -> PipelineOutput:
    return PipelineOutput(
        reels=[{"reel_url": "https://example/reel/AAA", "caption": "x", "location_name": None}],
        places=[{"name": "A", "lat": 35.0, "lng": 139.0,
                 "evidence_quote": "A", "source_url": "https://a.jp", "confidence": 0.9}],
        itinerary={"title": "t", "source": "pipeline", "source_places": ["A"],
                   "days": [{"day_number": 1, "date": "2026-06-10", "place_names": ["A"]}]},
    )


def test_pipeline_output_exposes_reels_places_itinerary():
    out = _sample()
    assert out.reels[0]["reel_url"].endswith("AAA")
    assert out.places[0]["name"] == "A"
    assert out.itinerary["days"][0]["place_names"] == ["A"]


def test_pipeline_output_is_frozen():
    out = _sample()
    with pytest.raises(dataclasses.FrozenInstanceError):
        out.places = []  # type: ignore[misc]
