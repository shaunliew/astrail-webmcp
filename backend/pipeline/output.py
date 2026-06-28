"""Minimal pipeline output contract — the boundary the offline eval scores.

Intentionally small: it mirrors ONLY the shape backend/evals/ consumes
(ctx["reels"] + ctx["places"] + ctx["itinerary"]). The rich, typed stage-to-stage
Pydantic contracts (PlaceResult, EnrichedPlace, ItineraryOutput) are frozen later
in Step 4 (specialist agent contracts) — do NOT grow them here.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PipelineOutput:
    """What one offline pipeline run produces, in the eval's consumption shape.

    Attributes:
        reels: the recorded ReelData the run scraped — each carries reel_url,
            caption, location_name, short_code. (The eval verifies evidence
            quotes against this corpus.)
        places: produced/deduped place dicts — each carries at least name, lat,
            lng, evidence_quote, source_url, confidence (same dict shape as the
            recorded expected_places fixture).
        itinerary: {title, source, source_places: [name],
            days: [{day_number, date, place_names: [name]}]} — the exact shape
            backend/evals consumes as the subject under test.

    Frozen: fields cannot be rebound. Treat the contained lists/dict as
    read-only (immutability by convention) — never mutate in place.
    """

    reels: list[dict]
    places: list[dict]
    itinerary: dict
