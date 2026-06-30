"""Itinerary contracts — narrate-stage output (Phase 5).

Matches the pipeline's current itinerary dict shape (the #16 eval reads
days[].place_names, source_places, source). The narration-rich day shape
(activities/narration/hotel) belongs to the real narrator (Step 7); typing it
now would be speculative.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ItineraryDay(BaseModel):
    day_number: int
    date: str
    place_names: list[str]


class FeasibilityWarning(BaseModel):
    kind: Literal["long_leg", "overpacked_day"]
    day_number: int
    detail: str
    leg_m: float | None = None


class ItineraryOutput(BaseModel):
    title: str
    source: str
    source_places: list[str]
    days: list[ItineraryDay]
    feasibility_warnings: list[FeasibilityWarning] = Field(default_factory=list)
