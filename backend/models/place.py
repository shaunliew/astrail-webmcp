"""Place contracts — extract → dedup boundary.

PlaceResult is the extractor output (Phase 2). Field names match the eval
fixtures (`evidence_quote`, `source_type`) so model_dump() round-trips to the
dict shape the #16 eval consumes. lat/lng/confidence bounds reproduce the
legacy validators (CLAUDE.md hard-won lessons). `extra="ignore"` tolerates
wider payloads. ExtractionResult is the SDK output_type wrapper (Step 5).
CanonicalPlace is the dedup output; `times_referenced` is the data-flywheel
counter incremented by semantic dedup (Step 6).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PlaceSourceType = Literal["reel_extracted", "user_requested", "agent_suggested"]


class PlaceResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    category: str = Field(description="restaurant | hotel | attraction | transport | other")
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_quote: str
    source_type: PlaceSourceType = "reel_extracted"
    source_url: str | None = None
    city_or_region_guess: str | None = None
    formatted_address: str | None = None
    name_local: str | None = Field(
        default=None,
        description="Venue name in the local language/script, verbatim from the caption "
                    "(e.g. '東京タワー'), or None when the caption has no local-script name. "
                    "Used to ground coords in providers that index POIs in the local script.",
    )


class ExtractionResult(BaseModel):
    """Single-model SDK output_type wrapper for the extractor agent (Step 5)."""

    places: list[PlaceResult]


class CanonicalPlace(PlaceResult):
    """A deduplicated place. `times_referenced` is the data-flywheel counter
    (Step 6's semantic+geo dedup increments it on a merge)."""

    times_referenced: int = 1
