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


class TransportLeg(BaseModel):
    day_number: int
    leg_order: int
    from_place_id: str
    to_place_id: str
    transport_mode: str                    # walk|drive|cycle|transit_hint|unknown
    routing_provider: str = "mapbox"
    routing_profile: str | None = None     # walking|driving|driving-traffic|cycling
    status: str = "ok"                     # pending|ok|no_route|failed|skipped
    duration_seconds: int | None = None
    distance_meters: int | None = None
    route_geometry: dict | None = None     # deferred — null in v1
    warning: str | None = None

# RestaurantSuggestion, HotelSuggestion — added with their agents.
