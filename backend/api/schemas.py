"""Request/response models for the generation API."""
from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

# Generous upper bound: a beta trip is days-to-weeks, so a >1-year span is a nonsense/abuse range
# that would inflate day-count + weather scaling. Well beyond any real request (or test).
_MAX_TRIP_SPAN_DAYS = 366


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(default_factory=list, max_length=5)
    place_ids: list[UUID] = Field(default_factory=list, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = Field(default=None, max_length=200)   # bounded (A5): row + prompt surface
    # Flows into LLM prompts (preference_block); bounded like
    # `preferences` (A5) -- max_length, not Literal, so an unrecognized pace value is
    # still accepted (no breaking 422 for the frontend), just capped in cost/injection surface.
    pace: str = Field(default="balanced", max_length=32)
    # Free-text goes verbatim to mem0's cloud; bounded (A5).
    preferences: str | None = Field(default=None, max_length=2000)
    # Parity with frontend GenerateTripRequest (backend-types.ts, guardrail #4). The
    # frontend sends these three every request; requested_places is recorded on the
    # create_trip event but not yet resolved into the pipeline (deferred).
    requested_places: list[Annotated[str, StringConstraints(max_length=500)]] = Field(
        default_factory=list, max_length=50)   # bounded list + per-item (A5): jsonb row bloat
    # Literal here, unlike `pace` above — deliberately asymmetric. `pace` has NO database
    # constraint, so an unrecognized value is accepted and merely flows into a prompt;
    # permissiveness costs nothing and spares the frontend a breaking 422. `budget_level`
    # has one (`trips_budget_level_check`, 20260701151718_trip_job_backbone.sql:23), so an
    # unrecognized value is GUARANTEED to fail — permissiveness there does not buy
    # tolerance, it buys a 500 (23514 -> the broad handler in main.py). Reject it at the
    # boundary instead, as the client error it is. These four values must stay in lockstep
    # with that CHECK and with BudgetLevel in frontend/lib/trip/backend-types.ts (#4).
    budget_level: Literal["budget", "mid_range", "premium", "luxury"] | None = None
    origin_city: str | None = Field(default=None, max_length=200)   # bounded (A5)

    @field_validator("start_date", "end_date")
    @classmethod
    def _valid_iso_date(cls, v: str) -> str:
        # Reject a malformed date at the boundary as a clean 422, instead of letting it reach the
        # trips insert / weather fetch and surface as a Postgres 22007 -> 500 (the broad handler).
        try:
            date.fromisoformat(v)
        except (ValueError, TypeError) as exc:
            raise ValueError("must be an ISO date (YYYY-MM-DD)") from exc
        return v

    @model_validator(mode="after")
    def require_reel_or_place(self):
        if not self.reel_urls and not self.place_ids:
            raise ValueError("At least one Reel URL or canonical place ID is required")
        if self.reel_urls and self.place_ids:
            raise ValueError("Provide either Reel URLs or canonical place IDs, not both")
        # Dates are valid ISO here (field validators ran first). A single-day trip (end == start)
        # is allowed; a reversed range or an absurd span is a client error, not a 500.
        start, end = date.fromisoformat(self.start_date), date.fromisoformat(self.end_date)
        if end < start:
            raise ValueError("end_date must be on or after start_date")
        if (end - start).days > _MAX_TRIP_SPAN_DAYS:
            raise ValueError(f"trip span exceeds {_MAX_TRIP_SPAN_DAYS} days")
        return self


class GenerateTripResponse(BaseModel):
    trip_id: str


class RequestSeatResponse(BaseModel):
    """POST /request-seat 200 body — the beta-seat request timestamp.

    Idempotent by construction: the RPC stamps coalesce(seat_requested_at, now()), so a
    repeat request echoes back the ORIGINAL time, never a fresh one. Mirrored in
    frontend/lib/trip/backend-types.ts (guardrail #4)."""
    requested_at: datetime


class AccountDeletionResponse(BaseModel):
    """POST /account/deletion 200 body — when the account is scheduled to be deleted.

    The account has entered a 7-day cancellable grace; `scheduled_for` is the date shown to
    the user (and named in the "deletion scheduled" email, Task 4). Failures use the standard
    error envelope (503 deletion_unavailable while gated, 409 deletion_not_active). TypeScript
    mirror in frontend/lib/trip/backend-types.ts is Task 5 (guardrail #4)."""
    scheduled_for: datetime


class AccountDeletionCancelResponse(BaseModel):
    """POST /account/deletion/cancel 200 body — success only. Failures use the standard error
    envelope (503 deletion_unavailable, 409 deletion_already_started / no_pending_deletion).
    TypeScript mirror is Task 5 (guardrail #4)."""
    cancelled: Literal[True] = True


class AccountDeletionStatusResponse(BaseModel):
    """GET /account/deletion/status 200 body — the cross-session deletion state for the
    AUTHENTICATED account, so a returning user's UI can show (or hide) the pending banner without
    an in-session request (the T5 gap, wired at T6).

    Never 500s the UI, but it separates two cases (Fix 5): a SUCCESSFUL read that is
    legitimately-absent (a missing row / unexpected value) returns 'active' (banner HIDDEN), while a
    genuine read FAILURE returns 'unknown' — a read-failure SENTINEL that is NOT a stored
    `users.account_status` value. Collapsing the failure to 'active' would hide the Cancel banner
    from a genuinely-pending user with no route to cancel; 'unknown' lets the UI preserve
    cancellation guidance. `deletion_scheduled_for` is the grace deadline (populated only while
    pending/deleting). Mirrored in frontend/lib/trip/backend-types.ts (guardrail #4)."""
    account_status: Literal["active", "pending_deletion", "deleting", "unknown"]
    deletion_scheduled_for: datetime | None = None


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


class MemoryClearResponse(BaseModel):
    """POST /settings/memory/clear — success only. Failures use the standard error
    envelope with code `memory_unavailable` or `memory_clear_unknown`."""
    cleared: Literal[True] = True


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


class TripPlaceEditRequest(BaseModel):
    """PATCH /trips/{trip_id}/places/{trip_place_id} body."""

    model_config = ConfigDict(extra="forbid")

    day_number: int | None = Field(default=None, ge=1, strict=True)
    sort_order: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def require_at_least_one_edit(self):
        if self.day_number is None and self.sort_order is None:
            raise ValueError("At least one of day_number or sort_order is required")
        return self


class TripPlaceCreateRequest(BaseModel):
    """POST /trips/{trip_id}/places body for a user-requested stop."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    day_number: int = Field(ge=1, strict=True)
    position: int | None = Field(default=None, ge=1, strict=True)
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)

    @field_validator("name")
    @classmethod
    def require_nonblank_name(cls, value: str) -> str:
        name = value.strip()
        if not name:
            raise ValueError("name must not be blank")
        return name

    @model_validator(mode="after")
    def require_coordinate_pair(self):
        if (self.lat is None) != (self.lng is None):
            raise ValueError("lat and lng must be supplied together")
        return self


class TripDateEditRequest(BaseModel):
    """PATCH /trips/{trip_id} body for changing an existing trip's dates."""

    model_config = ConfigDict(extra="forbid")

    start_date: date | None = None
    end_date: date | None = None

    @model_validator(mode="after")
    def validate_date_edit(self):
        if self.start_date is None and self.end_date is None:
            raise ValueError("At least one of start_date or end_date is required")
        if self.start_date is not None and self.end_date is not None \
                and self.end_date < self.start_date:
            raise ValueError("end_date must be on or after start_date")
        return self


class TripPlaceRow(BaseModel):
    """The persisted trip_places row returned after an itinerary edit."""

    id: str
    trip_id: str
    place_id: str
    source_type: Literal["reel_extracted", "user_requested", "agent_suggested"]
    evidence_json: dict[str, Any]
    day_number: int | None
    sort_order: int | None
    created_at: datetime


class TripPlaceEditResponse(BaseModel):
    trip_place: TripPlaceRow
    days_touched: list[int]
    routes_refreshed: bool


class TripPlaceCreateResponse(BaseModel):
    trip_place: TripPlaceRow
    days_touched: list[int]
    routes_refreshed: bool


class TripPlaceDeleteResponse(BaseModel):
    removed_id: str
    days_touched: list[int]
    routes_refreshed: bool


class TripReplanResponse(BaseModel):
    days_narrated: int
    routes_refreshed: bool


class TripRow(BaseModel):
    """The persisted trips row returned after a date edit."""

    id: str
    user_id: str
    status: Literal["draft", "generating", "places_ready", "complete", "saved_with_gaps", "failed"]
    destination_hint: str | None
    inferred_destination: str | None
    start_date: date | None
    end_date: date | None
    origin_city: str | None
    budget_level: Literal["budget", "mid_range", "premium", "luxury"] | None
    adult_count: int
    child_count: int
    room_count: int
    occupancy_json: dict[str, Any]
    hotel_preference_json: dict[str, Any]
    persona_snapshot_json: dict[str, Any]
    preference_sources: list[str]
    preference_summary: str | None
    title: str | None
    summary: str | None
    tradeoffs: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class TripDateEditResponse(BaseModel):
    trip: TripRow
    days_touched: list[int]
