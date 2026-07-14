"""Trip-level tradeoffs contract (mirrors frontend backend-types.ts, guardrail #4).

Two deterministic shapes: notes (gaps, from FeasibilityWarning) and comparisons
(hotel A-vs-B, from numeric hotel_suggestions fields). No LLM. Persisted to the
trips.tradeoffs jsonb column as {notes, comparisons}.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TripTradeoffNote(BaseModel):
    kind: Literal["long_leg", "overpacked_day", "empty_day", "note"]
    scope: Literal["trip", "day", "place"]
    severity: Literal["info", "warn", "flag"]
    detail: str
    day_number: int | None = None
    refs: list[str] = Field(default_factory=list)
    leg_m: float | None = None


class TradeoffOption(BaseModel):
    label: str
    value: str
    pro: str
    con: str


class TripTradeoffComparison(BaseModel):
    axis: str
    scope: Literal["hotel"] = "hotel"
    option_a: TradeoffOption
    option_b: TradeoffOption
    recommendation: str | None = None
    refs: list[str] = Field(default_factory=list)


class TripTradeoffs(BaseModel):
    notes: list[TripTradeoffNote] = Field(default_factory=list)
    comparisons: list[TripTradeoffComparison] = Field(default_factory=list)
