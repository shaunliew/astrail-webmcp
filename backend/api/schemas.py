"""Request/response models for the generation API."""
from __future__ import annotations

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


class GenerateTripResponse(BaseModel):
    trip_id: str
