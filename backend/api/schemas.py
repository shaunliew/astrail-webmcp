"""Request/response models for the generation API."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(default_factory=list, max_length=5)
    place_ids: list[UUID] = Field(default_factory=list, max_length=5)
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

    @model_validator(mode="after")
    def require_reel_or_place(self):
        if not self.reel_urls and not self.place_ids:
            raise ValueError("At least one Reel URL or canonical place ID is required")
        if self.reel_urls and self.place_ids:
            raise ValueError("Provide either Reel URLs or canonical place IDs, not both")
        return self


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


class OrganizeSavedReelsRequest(BaseModel):
    saved_reel_ids: list[UUID] = Field(min_length=1, max_length=5)

    # The RPC rejects duplicates too (now as AS422 -> InvalidOrganizeRequest -> 422, since
    # B5(d)). This validator stops the bad input reaching the RPC at all; the SQLSTATE
    # mapping makes the RPC's own rejection read correctly if it ever does. Neither
    # replaces the other.
    @model_validator(mode="after")
    def reject_duplicate_ids(self):
        if len(set(self.saved_reel_ids)) != len(self.saved_reel_ids):
            raise ValueError("saved_reel_ids must not contain duplicates")
        return self


class OrganizeSavedReelsResponse(BaseModel):
    job_id: str


class OrganizeJobItem(BaseModel):
    saved_reel_id: str
    status: Literal["queued", "processing", "organized", "location_not_found", "failed"]
    place_count: int = 0
    error_message: str | None = None


class OrganizeJobStatus(BaseModel):
    job_id: str
    status: Literal["initializing", "pending", "processing", "succeeded", "failed"]
    status_message: str
    total_items: int
    processed_items: int = 0
    organized_items: int = 0
    location_not_found_items: int = 0
    failed_items: int = 0
    items: list[OrganizeJobItem] = Field(default_factory=list)
