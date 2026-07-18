"""GeocodeResult — Mapbox Search Box /forward response contract.

Models the resolved coordinate + address from a single Mapbox POI hit.
Used by geocode/mapbox_forward.py; imported by apply_geocode and the
capture resolve stage. No runtime deps beyond pydantic.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class GeocodeResult(BaseModel):
    """Resolved coordinates + metadata from a Mapbox Search Box /forward call."""

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    formatted_address: str | None = None
    name: str | None = None
    mapbox_id: str | None = None
    country_code: str | None = None
    country_name: str | None = None


class CountryResult(BaseModel):
    """Normalized administrative country returned by Mapbox reverse geocoding."""

    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    country_name: str = Field(min_length=1)
