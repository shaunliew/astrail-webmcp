"""Request/response models for the generation API."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    # Flows into LLM prompts (preference_block) and the mem0 synopsis; bounded like
    # `preferences` (A5) -- max_length, not Literal, so an unrecognized pace value is
    # still accepted (no breaking 422 for the frontend), just capped in cost/injection surface.
    pace: str = Field(default="balanced", max_length=32)
    # Free-text goes verbatim to mem0's cloud; bounded (A5).
    preferences: str | None = Field(default=None, max_length=2000)
    # Parity with frontend GenerateTripRequest (backend-types.ts, guardrail #4). The
    # frontend sends these three every request; requested_places is recorded on the
    # create_trip event but not yet resolved into the pipeline (deferred).
    requested_places: list[str] = Field(default_factory=list)
    budget_level: str | None = None
    origin_city: str | None = None


class GenerateTripResponse(BaseModel):
    trip_id: str


class CaptureSavedReelRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)


class SavedReel(BaseModel):
    id: str
    user_id: str
    normalized_url: str
    source_platform: Literal["instagram", "tiktok", "manual"]
    reel_cache_id: str | None
    analysis_status: Literal[
        "not_analyzed", "queued", "processing", "organized",
        "location_not_found", "failed",
    ]
    personal_label: str | None
    retry_after: datetime | None
    analyzed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class CaptureSavedReelResponse(BaseModel):
    saved_reel: SavedReel
