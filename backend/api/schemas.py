"""Request/response models for the generation API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    pace: str = "balanced"


class GenerateTripResponse(BaseModel):
    trip_id: str
