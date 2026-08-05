"""Enrichment models (Phase 3/4). WeatherReport is live; the rest arrive with their agents."""
from __future__ import annotations

from pydantic import BaseModel, Field


class WeatherReport(BaseModel):
    date: str                # ISO yyyy-mm-dd, matches trip_days.day_date
    temp_min_c: float
    temp_max_c: float
    precipitation_mm: float
    weather_code: int        # raw WMO code (payload fidelity)
    summary: str             # human line, e.g. "Partly cloudy, 24-31°C"


class RestaurantLabel(BaseModel):
    """One LLM label over a PROVIDED Mapbox POI. The LLM returns only a poi_index (into the
    input list) + English text — it NEVER emits coordinates or a place, so it cannot invent a
    restaurant (guardrail #1 structural). poi_index anchors the label to a real POI."""
    poi_index: int
    name_en: str
    cuisine: str | None = None
    # No min_length here: a string length constraint on an output_type (strict Responses schema)
    # can raise "Invalid schema" 400s in some model/SDK versions, and the gpt-4o fallback would
    # hit the SAME 400 → silent no-op in prod (offline fake-runner tests would never catch it).
    # keep_grounded_restaurants enforces non-empty summary instead.
    summary: str


class RestaurantResult(BaseModel):
    """Agent output_type wrapper. NEVER a bare list — a bare list breaks the strict Responses
    schema (LESSONS-HACKATHON)."""
    suggestions: list[RestaurantLabel] = Field(default_factory=list)


class RestaurantCandidate(BaseModel):
    """A grounded restaurant suggestion (post-join): the LLM's English labels fused with the REAL
    Mapbox POI (coords / name_local / address / mapbox_id). What persist_restaurants consumes.
    Internal enrich model (like WeatherReport) — no 1:1 TS mirror; it maps onto a
    restaurant_suggestions row plus a places row (via restaurant_place_id)."""
    name: str                                              # English/romaji (LLM), or the POI name
    name_local: str | None = None                          # Japanese POI name (Mapbox)
    cuisine: str | None = None                             # English cuisine label (LLM)
    summary: str = Field(min_length=1)                     # "why this fits" (LLM)
    lat: float                                             # REAL Mapbox coords — never LLM
    lng: float
    address: str | None = None                             # Mapbox full_address
    mapbox_id: str | None = None                           # grounding id
    categories: list[str] = Field(default_factory=list)    # Mapbox poi_category (ja)
    distance_m: float | None = None


class DayNarration(BaseModel):
    """Per-day narration the LLM writes for ONE trip_day, anchored by day_number (like the restaurant
    poi_index — the LLM cannot narrate a day that isn't in the trip). No min_length on the strings:
    a length constraint on an output_type can 400 the strict Responses schema (and the gpt-4o fallback
    hits the same 400); keep_valid_narration enforces non-empty instead."""
    day_number: int
    title: str
    summary: str


class NarrationResult(BaseModel):
    """Narrator output_type wrapper (NEVER a bare list). trip_title/trip_summary are the read-only
    trip-level overview (-> trips.title/summary)."""
    days: list[DayNarration] = Field(default_factory=list)
    trip_title: str | None = None
    trip_summary: str = ""


class HotelLocalizationItem(BaseModel):
    """One localized hotel name anchored to a SERVER-ASSIGNED ordinal (like RestaurantLabel.poi_index).
    The model returns ONLY (ordinal, localized_name) — never a hotelId — so it cannot control WHICH
    server hotel a name is assigned to: the caller snaps localized_name back to hotels[ordinal]
    server-side (guardrail #11). This prevents MODEL-CONTROLLED ID REASSIGNMENT; it does NOT prevent a
    wrong localized NAME in a valid slot (that residual is accepted-and-watched — the poi_category gate
    doesn't catch it either). No `min_length` on localized_name: a string constraint on an output_type
    can 400 the strict Responses schema (and the gpt-4o fallback hits the same 400); blanks are dropped
    in code instead."""
    ordinal: int
    localized_name: str


class HotelLocalization(BaseModel):
    """Localizer output_type wrapper. NEVER a bare list — a bare list breaks the strict Responses
    schema (LESSONS-HACKATHON)."""
    localized: list[HotelLocalizationItem] = Field(default_factory=list)


# HotelSuggestion — added with its agent.
