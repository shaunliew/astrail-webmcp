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
    # Flows into LLM prompts (preference_block); bounded like
    # `preferences` (A5) -- max_length, not Literal, so an unrecognized pace value is
    # still accepted (no breaking 422 for the frontend), just capped in cost/injection surface.
    pace: str = Field(default="balanced", max_length=32)
    # Free-text goes verbatim to mem0's cloud; bounded (A5).
    preferences: str | None = Field(default=None, max_length=2000)
    # Parity with frontend GenerateTripRequest (backend-types.ts, guardrail #4). The
    # frontend sends these three every request; requested_places is recorded on the
    # create_trip event but not yet resolved into the pipeline (deferred).
    requested_places: list[str] = Field(default_factory=list)
    # Literal here, unlike `pace` above — deliberately asymmetric. `pace` has NO database
    # constraint, so an unrecognized value is accepted and merely flows into a prompt;
    # permissiveness costs nothing and spares the frontend a breaking 422. `budget_level`
    # has one (`trips_budget_level_check`, 20260701151718_trip_job_backbone.sql:23), so an
    # unrecognized value is GUARANTEED to fail — permissiveness there does not buy
    # tolerance, it buys a 500 (23514 -> the broad handler in main.py). Reject it at the
    # boundary instead, as the client error it is. These four values must stay in lockstep
    # with that CHECK and with BudgetLevel in frontend/lib/trip/backend-types.ts (#4).
    budget_level: Literal["budget", "mid_range", "premium", "luxury"] | None = None
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


class RequestSeatResponse(BaseModel):
    """POST /request-seat 200 body — the beta-seat request timestamp.

    Idempotent by construction: the RPC stamps coalesce(seat_requested_at, now()), so a
    repeat request echoes back the ORIGINAL time, never a fresh one. Mirrored in
    frontend/lib/trip/backend-types.ts (guardrail #4)."""
    requested_at: datetime


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


class MemoryFact(BaseModel):
    """One stored mem0 memory, verbatim.

    Deliberately NOT UserPreferenceFact: that shape carries fact_key/fact_value/
    confidence/status, none of which mem0 returns. Synthesising them to fit the type would
    be fabricating data (guardrail #1) -- a made-up confidence number shown to a user -- so
    the prose is passed through and the UI adapts. `source` is a constant, not an inference.
    """
    id: str
    memory: str
    created_at: str
    source: Literal["mem0"] = "mem0"


class SettingsPreferencesResponse(BaseModel):
    """GET /settings/preferences -- the user's STORED mem0 memories (first page).

    Not the same set as any generation's recall, which uses a semantic search with
    top_k=10 and only when preferences are blank. `status` lets the UI tell 'you have no
    saved preferences' (ok, []) apart from 'memory is broken' (unavailable, []) -- the
    ambiguity that made the 2026-08-02 report undiagnosable.
    """
    status: Literal["ok", "disabled", "unavailable"]
    facts: list[MemoryFact] = Field(default_factory=list)


class TripFeedbackRequest(BaseModel):
    """POST /trips/{trip_id}/feedback body -- trip-level feedback only.

    `artifact_type`/`artifact_id` are deliberately NOT accepted from the client: the
    route hardcodes ('trip', None). Accepting them would let a caller aim feedback at
    another trip's artifact, and service_role bypasses the RLS policy that would
    otherwise validate the artifact against its parent table (persist.py:515).

    Literal[...] on feedback_type mirrors the DB CHECK feedback_feedback_type_check;
    ge/le on rating mirrors feedback_rating_range. Keeping them in lockstep means a
    bad payload is a clean 422 instead of a Postgres constraint violation surfacing
    as a 500.
    """
    feedback_type: Literal["rating", "thumbs_up", "thumbs_down", "correction", "free_text"]
    # strict=True (Codex MINOR): non-strict Pydantic coerces JSON `true` -> 1, `"4"` -> 4 and
    # `5.0` -> 5. A boolean silently becoming a 1-star rating is analytics poison in the exact
    # dataset this endpoint exists to produce.
    rating: int | None = Field(default=None, ge=1, le=5, strict=True)
    comment: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def check_rating_matches_feedback_type(self):
        if self.feedback_type == "rating" and self.rating is None:
            raise ValueError("rating is required when feedback_type is 'rating'")
        if self.feedback_type != "rating" and self.rating is not None:
            raise ValueError("rating is only valid when feedback_type is 'rating'")
        # .strip() (Codex MINOR): a whitespace-only comment passes a bare truthiness check and
        # stores a row with no information -- the same defect as an empty comment.
        if self.feedback_type in ("free_text", "correction") and not (self.comment or "").strip():
            raise ValueError(f"comment is required when feedback_type is '{self.feedback_type}'")
        return self


class TripFeedback(BaseModel):
    """One stored feedback row, as echoed back to the client.

    No created_at: the in-memory test fake does not apply Postgres column defaults, so
    a default-populated field would be untestable (present in prod, absent in tests).
    """
    id: str
    trip_id: str
    artifact_type: Literal["trip"] = "trip"
    feedback_type: Literal["rating", "thumbs_up", "thumbs_down", "correction", "free_text"]
    rating: int | None = None
    comment: str | None = None


class TripFeedbackResponse(BaseModel):
    """201 body. Wraps the row to match CaptureSavedReelResponse's shape."""
    feedback: TripFeedback
