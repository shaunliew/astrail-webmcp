"""Request/response models for the generation API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    pace: str = "balanced"
    # Parity with frontend GenerateTripRequest (backend-types.ts). requested_places is
    # accepted + recorded but not yet resolved into the pipeline (deferred; see plan).
    requested_places: list[str] = Field(default_factory=list)
    budget_level: str | None = None
    origin_city: str | None = None
    preferences: str | None = None


class GenerateTripResponse(BaseModel):
    trip_id: str
