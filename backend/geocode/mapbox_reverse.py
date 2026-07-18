"""Mapbox Geocoding v6 reverse-country verification with permanent storage mode."""
from __future__ import annotations

import asyncio

import httpx
from pydantic import ValidationError

from models.geocode import CountryResult

_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse"
_MAX_REVERSE_ATTEMPTS = 2


def parse_reverse_country_response(data: object) -> CountryResult | None:
    if not isinstance(data, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    features = data.get("features")
    if not isinstance(features, list):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    if not features:
        if data.get("type") == "FeatureCollection":
            return None
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    if not isinstance(features[0], dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    properties = features[0].get("properties")
    if not isinstance(properties, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    context = properties.get("context")
    country = context.get("country") if isinstance(context, dict) else None
    if not isinstance(country, dict):
        country = properties if properties.get("feature_type") == "country" else None
    if not isinstance(country, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    code = country.get("country_code") or country.get("short_code")
    name = country.get("name")
    if isinstance(code, str):
        code = code.upper()
    try:
        return CountryResult(country_code=code, country_name=name)
    except ValidationError:
        raise RuntimeError("Mapbox reverse-country returned malformed data") from None


async def reverse_country(
    lat: float,
    lng: float,
    *,
    token: str,
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 15,
    retry_delay_s: float = 0.25,
) -> CountryResult | None:
    params = {
        "longitude": lng,
        "latitude": lat,
        "types": "country",
        "limit": 1,
        "language": "en",
        "permanent": "true",
        "access_token": token,
    }
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    try:
        for attempt in range(_MAX_REVERSE_ATTEMPTS):
            try:
                response = await http.get(_REVERSE_URL, params=params, timeout=timeout_s)
            except httpx.RequestError as exc:
                if attempt == 0:
                    await asyncio.sleep(retry_delay_s)
                    continue
                raise RuntimeError(
                    f"Mapbox reverse-country error: {type(exc).__name__}"
                ) from None
            if response.status_code // 100 == 5 and attempt == 0:
                await asyncio.sleep(retry_delay_s)
                continue
            if response.status_code // 100 != 2:
                raise RuntimeError(
                    f"Mapbox reverse-country failed: status {response.status_code}"
                )
            try:
                payload = response.json()
            except ValueError:
                raise RuntimeError("Mapbox reverse-country returned invalid response") from None
            return parse_reverse_country_response(payload)
        raise RuntimeError("Mapbox reverse-country failed after retry")
    finally:
        if owns_client:
            await http.aclose()
