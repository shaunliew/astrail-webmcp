"""Mapbox Geocoding v6 reverse-country verification with permanent storage mode."""
from __future__ import annotations

import asyncio

import httpx
from pydantic import ValidationError

from models.geocode import CountryResult

_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse"
_MAX_REVERSE_ATTEMPTS = 2
MAX_REVERSE_RETRY_DELAY_S = 2.0
_RETRYABLE_STATUS_CODES = {408, 429}


def _retry_delay(response: httpx.Response | None, fallback_s: float) -> float:
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after is not None:
            try:
                return min(max(float(retry_after), 0.0), MAX_REVERSE_RETRY_DELAY_S)
            except ValueError:
                pass
    return min(max(fallback_s, 0.0), MAX_REVERSE_RETRY_DELAY_S)


def parse_reverse_country_response(data: object) -> CountryResult:
    """Return the verified country, or raise. It never reports "no country" as a value.

    A well-formed but EMPTY FeatureCollection used to return None, which `_ground_place` read
    as "this coordinate does not verify" and settled the item at `location_not_found` — a
    TERMINAL state. An empty-but-valid collection is far more likely a Mapbox brownout than a
    real country-less venue, so raising is the right bias: the item settles at `failed`, which
    is retryable, instead of freezing a wrong terminal answer. Accepted consequence: a genuine
    open-ocean coordinate now reports `failed` rather than `location_not_found`.
    """
    if not isinstance(data, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    features = data.get("features")
    if not isinstance(features, list):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    if not features:
        if data.get("type") == "FeatureCollection":
            raise RuntimeError("Mapbox reverse-country returned no country for coordinate")
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
) -> CountryResult:
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
                    await asyncio.sleep(_retry_delay(None, retry_delay_s))
                    continue
                raise RuntimeError(
                    f"Mapbox reverse-country error: {type(exc).__name__}"
                ) from None
            retryable = response.status_code in _RETRYABLE_STATUS_CODES or response.status_code // 100 == 5
            if retryable and attempt == 0:
                await asyncio.sleep(_retry_delay(response, retry_delay_s))
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
