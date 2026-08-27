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

from pydantic import BaseModel, ConfigDict, Field, model_validator

PlaceSourceType = Literal["reel_extracted", "user_requested", "agent_suggested"]
MAX_EXTRACTED_PLACES = 10


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
    # The Instagram Reel this place was extracted FROM.
    #
    # Distinct from `source_url`, which is deliberately a third-party venue/research page: the
    # extractor prompt requires it (place_extractor.py) and `is_independent_source_url()` drops
    # any place whose source_url is not independent research. So the reel URL never had anywhere
    # to live, and every reel-extracted place ended up labelled `reel_quote` while carrying a
    # research link. Populated after extraction, in the runner, where the reel index is still in
    # scope — so no EXTRACTOR_VERSION bump, which would cold-invalidate every cache row and
    # re-charge every user's quota.
    source_reel_url: str | None = None
    city_or_region_guess: str | None = None
    formatted_address: str | None = None
    name_local: str | None = Field(
        default=None,
        description="Venue name in the local language/script, verbatim from the caption "
                    "(e.g. '東京タワー'), or None when the caption has no local-script name. "
                    "Used to ground coords in providers that index POIs in the local script.",
    )
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    country_name: str | None = None

    @model_validator(mode="after")
    def country_fields_are_a_pair(self) -> "PlaceResult":
        if (self.country_code is None) != (self.country_name is None):
            raise ValueError("country_code and country_name must be set together")
        if self.country_name is not None and not self.country_name.strip():
            raise ValueError("country_name must be nonblank")
        return self


class ExtractionResult(BaseModel):
    """Single-model SDK output_type wrapper for the extractor agent (Step 5)."""

    places: list[PlaceResult] = Field(max_length=MAX_EXTRACTED_PLACES)


class CanonicalPlace(PlaceResult):
    """A deduplicated place. `times_referenced` is the data-flywheel counter (Step 6's
    two-gate dedup increments it on a merge). `aliases` are the distinct names/local-names
    of all merged mentions; `evidence_quotes` keeps each merged source's evidence."""

    times_referenced: int = 1
    aliases: list[str] = Field(default_factory=list)
    evidence_quotes: list[str] = Field(default_factory=list)
