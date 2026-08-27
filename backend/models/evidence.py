"""Per-trip place evidence contract — mirrors frontend TripPlaceEvidence (guardrail #4).

This is the object stored in trip_places.evidence_json. `quote` is the primary verbatim
quote; `quotes` preserves the dedup flywheel's merged multi-source quotes.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

EvidenceKind = Literal[
    "reel_quote", "requested_by_you", "research", "mapbox_route", "open_meteo",
    "travala_hotel_search", "memory_preference", "inferred_default", "suggested_by_astrail",
]


class TripPlaceEvidence(BaseModel):
    confidence: float
    source_url: str | None = None      # third-party research/venue page (see PlaceResult)
    source_reel_url: str | None = None # the Instagram Reel it came from, when there is one
    quote: str | None = None
    quotes: list[str] = Field(default_factory=list)
    rationale: str | None = None
    evidence_kind: EvidenceKind
