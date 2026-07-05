"""Enrichment models (Phase 3/4). WeatherReport is live; the rest arrive with their agents."""
from __future__ import annotations

from pydantic import BaseModel


class WeatherReport(BaseModel):
    date: str                # ISO yyyy-mm-dd, matches trip_days.day_date
    temp_min_c: float
    temp_max_c: float
    precipitation_mm: float
    weather_code: int        # raw WMO code (payload fidelity)
    summary: str             # human line, e.g. "Partly cloudy, 24-31°C"

# RestaurantSuggestion, TransportLeg, HotelSuggestion — added with their agents.
