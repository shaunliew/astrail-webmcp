"""Mapbox Search Box /forward geocoder → GeocodeResult; pure apply_geocode transform.

Endpoint: https://api.mapbox.com/search/searchbox/v1/forward
Params: q, language, country, types="poi", limit=1, proximity="{lng},{lat}", access_token

TOKEN SAFETY: access_token travels in the query string (Mapbox standard).
- NEVER call resp.raise_for_status() — its message embeds the full URL + token.
- Check resp.status_code manually and raise a sanitized RuntimeError.
- Catch httpx.RequestError and re-raise a sanitized RuntimeError — never let
  an httpx message (URL-bearing) escape this module.

Only called by the capture command with MAPBOX_SECRET_TOKEN present.
Unit tests inject httpx.MockTransport — no network, no key required.
"""
from __future__ import annotations

import httpx

from models.geocode import GeocodeResult
from models.place import PlaceResult

# (lng, lat) — Tokyo Station; used as the /forward proximity default for Japan queries.
TOKYO: tuple[float, float] = (139.7671, 35.6812)

_FORWARD_URL = "https://api.mapbox.com/search/searchbox/v1/forward"


def parse_forward_response(data: dict) -> GeocodeResult | None:
    """Parse a Mapbox Search Box GeoJSON FeatureCollection → GeocodeResult or None.

    geometry.coordinates is [lng, lat] (GeoJSON lon-first convention):
      coordinates[0] → lng
      coordinates[1] → lat
    Do NOT swap.

    Returns None when features is absent or empty.
    """
    features = data.get("features") or []
    if not features:
        return None
    feature = features[0]
    coords = feature.get("geometry", {}).get("coordinates") or []
    if len(coords) < 2:
        return None
    lng: float = coords[0]
    lat: float = coords[1]
    props: dict = feature.get("properties") or {}
    name: str | None = props.get("name")
    # full_address is the primary field; fall back to place_formatted (also seen in docs).
    formatted_address: str | None = props.get("full_address") or props.get("place_formatted")
    mapbox_id: str | None = props.get("mapbox_id")
    return GeocodeResult(
        lat=lat,
        lng=lng,
        name=name,
        formatted_address=formatted_address,
        mapbox_id=mapbox_id,
    )


async def forward_geocode(
    query: str,
    *,
    token: str,
    proximity_lng_lat: tuple[float, float] = TOKYO,
    country: str = "jp",
    language: str = "en",
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 15,
) -> GeocodeResult | None:
    """GET Mapbox Search Box /forward → GeocodeResult or None on a miss.

    On success (2xx + at least one feature), returns a GeocodeResult.
    On a 2xx with no features (miss), returns None without raising.
    On a non-2xx or network error, raises RuntimeError with a sanitized message
    that never contains the token.

    Args:
        query: Place name string to geocode.
        token: Mapbox secret token (sk.*, Search Box scope). Never logged.
        proximity_lng_lat: (lng, lat) bias point — defaults to Tokyo Station.
        country: ISO-3166-1 alpha-2 country filter (default "jp").
        language: BCP-47 language for results (default "en").
        client: Optional injected httpx.AsyncClient (for testing / connection reuse).
        timeout_s: Request timeout in seconds.
    """
    lng, lat = proximity_lng_lat
    params = {
        "q": query,
        "language": language,
        "country": country,
        "types": "poi",
        "limit": 1,
        "proximity": f"{lng},{lat}",
        "access_token": token,
    }

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)

    try:
        resp = await http.get(_FORWARD_URL, params=params)
    except httpx.RequestError as exc:
        # Sanitize: re-raise without the original message (which contains the URL+token).
        raise RuntimeError(
            f"Mapbox forward error for {query!r}: {type(exc).__name__}"
        ) from None
    finally:
        if owns_client:
            await http.aclose()

    # Manual status check — never call resp.raise_for_status() (embeds URL+token).
    if resp.status_code // 100 != 2:
        raise RuntimeError(
            f"Mapbox forward failed for {query!r} (HTTP {resp.status_code})"
        )
    return parse_forward_response(resp.json())


def apply_geocode(place: PlaceResult, geo: GeocodeResult | None) -> PlaceResult:
    """Immutably override a PlaceResult's coords/address from a Mapbox GeocodeResult.

    On a hit (geo is not None): returns a new PlaceResult with lat, lng, and
    formatted_address from the Mapbox result; all other fields are preserved.
    On a miss (geo is None): returns the original place unchanged (LLM coords kept).

    This is a pure function — no mutation of the input place.
    """
    if geo is None:
        return place
    return place.model_copy(
        update={
            "lat": geo.lat,
            "lng": geo.lng,
            "formatted_address": geo.formatted_address,
        }
    )
