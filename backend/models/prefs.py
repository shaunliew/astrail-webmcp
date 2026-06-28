"""UserPreferences — the preference-context contract (Phase 3).

Contract-only at Step 4 (the offline pipeline has no preference flow yet); wired
in at Step 9 (mem0). Merges the legacy prefs (dates, budget, free_text, origin)
with the returning-user dimensions the japan_second_trip case asserts
(budget_style, pace, food_preference, avoid). `extra="ignore"` tolerates
future memory-derived fields.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class UserPreferences(BaseModel):
    model_config = ConfigDict(extra="ignore")

    start_date: str
    end_date: str
    budget_style: Literal["budget", "mid_range", "luxury"] = "mid_range"
    pace: Literal["relaxed", "balanced", "packed"] | None = None
    food_preference: list[str] = Field(default_factory=list)
    transport_tolerance: str | None = None
    avoid: list[str] = Field(default_factory=list)
    free_text: str = ""
    origin_city: str | None = None
