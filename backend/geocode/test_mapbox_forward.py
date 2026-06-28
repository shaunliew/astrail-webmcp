"""Mapbox forward geocoder — offline, mocked httpx transport (no network, no key).

Mirror of scrape/test_apify_direct.py: all tests use httpx.MockTransport;
no real API calls, no MAPBOX_SECRET_TOKEN required.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from geocode.mapbox_forward import TOKYO, apply_geocode, forward_geocode, parse_forward_response
from models.geocode import GeocodeResult
from models.place import PlaceResult

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_FEATURE_COLLECTION = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [139.77, 35.68]},
            "properties": {
                "name": "Tokyo Tower",
                "full_address": "4-2-8 Shibakoen, Minato-ku, Tokyo 105-0011",
                "mapbox_id": "dXJuOm1ieHBvaTo0NzI1NjI3",
                "feature_type": "poi",
            },
        }
    ],
}

_EMPTY_FEATURE_COLLECTION: dict = {"type": "FeatureCollection", "features": []}


def _make_place(**overrides) -> PlaceResult:
    defaults = dict(
        name="Senso-ji Temple",
        category="attraction",
        lat=0.0,
        lng=0.0,
        confidence=0.9,
        evidence_quote="gorgeous temple in Asakusa",
    )
    defaults.update(overrides)
    return PlaceResult(**defaults)


# ---------------------------------------------------------------------------
# parse_forward_response
# ---------------------------------------------------------------------------


def test_parse_forward_response_lng_lat_not_swapped():
    """coordinates[0]→lng, coordinates[1]→lat — swap guard."""
    result = parse_forward_response(_FEATURE_COLLECTION)
    assert result is not None
    assert abs(result.lng - 139.77) < 1e-6, f"lng should be ~139.77, got {result.lng}"
    assert abs(result.lat - 35.68) < 1e-6, f"lat should be ~35.68, got {result.lat}"


def test_parse_forward_response_extracts_properties():
    result = parse_forward_response(_FEATURE_COLLECTION)
    assert result is not None
    assert result.name == "Tokyo Tower"
    assert "Minato" in (result.formatted_address or "")
    assert result.mapbox_id == "dXJuOm1ieHBvaTo0NzI1NjI3"


def test_parse_forward_response_empty_features_returns_none():
    assert parse_forward_response(_EMPTY_FEATURE_COLLECTION) is None


def test_parse_forward_response_missing_features_key_returns_none():
    assert parse_forward_response({}) is None


def test_parse_forward_response_falls_back_to_place_formatted():
    """If full_address is absent, use place_formatted for formatted_address."""
    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [135.5, 34.7]},
                "properties": {
                    "name": "Osaka Castle",
                    "place_formatted": "Osaka, Japan",
                    "mapbox_id": "xyz",
                },
            }
        ],
    }
    result = parse_forward_response(fc)
    assert result is not None
    assert result.formatted_address == "Osaka, Japan"


# ---------------------------------------------------------------------------
# forward_geocode — request params
# ---------------------------------------------------------------------------


async def test_forward_geocode_request_params():
    """Request must carry country=jp, types=poi, language=en, proximity=TOKYO, q=query."""
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=_FEATURE_COLLECTION)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await forward_geocode("Tokyo Tower", token="TKN", client=client)

    parsed = urlparse(seen["url"])
    qs = parse_qs(parsed.query)

    assert qs.get("country") == ["jp"], f"country param wrong: {qs}"
    assert qs.get("types") == ["poi"], f"types param wrong: {qs}"
    assert qs.get("language") == ["en"], f"language param wrong: {qs}"
    assert qs.get("q") == ["Tokyo Tower"], f"q param wrong: {qs}"
    assert qs.get("proximity") == ["139.7671,35.6812"], f"proximity param wrong: {qs}"
    assert "searchbox/v1/forward" in seen["url"]

    assert result is not None
    assert abs(result.lng - 139.77) < 1e-6
    assert abs(result.lat - 35.68) < 1e-6


async def test_forward_geocode_empty_features_returns_none():
    """A valid 200 with no features is a miss — return None, not an error."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(200, json=_EMPTY_FEATURE_COLLECTION)
    ))
    result = await forward_geocode("Totally Nonexistent Place XYZ", token="TKN", client=client)
    assert result is None


# ---------------------------------------------------------------------------
# forward_geocode — token safety
# ---------------------------------------------------------------------------


async def test_forward_geocode_403_raises_runtime_error_without_token():
    """403 from Mapbox raises RuntimeError; token must NOT appear in the message."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        await forward_geocode("secret place", token="SECRET", client=client)

    err = str(exc_info.value)
    assert "403" in err, f"expected '403' in error message, got: {err!r}"
    assert "SECRET" not in err, f"token leaked into error message: {err!r}"


async def test_forward_geocode_connect_timeout_raises_sanitized():
    """httpx.ConnectTimeout is caught and re-raised as RuntimeError without the token."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("boom", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        await forward_geocode("secret place", token="SECRET", client=client)

    err = str(exc_info.value)
    assert "ConnectTimeout" in err, f"expected exception type name in message: {err!r}"
    assert "SECRET" not in err, f"token leaked into error message: {err!r}"


async def test_forward_geocode_500_raises_without_token():
    """Any non-2xx must raise RuntimeError without the token."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        await forward_geocode("place", token="SECRET", client=client)

    err = str(exc_info.value)
    assert "500" in err
    assert "SECRET" not in err


# ---------------------------------------------------------------------------
# TOKYO constant
# ---------------------------------------------------------------------------


def test_tokyo_constant_is_lng_lat_order():
    """TOKYO must be (lng, lat) matching the Mapbox proximity= format."""
    lng, lat = TOKYO
    assert abs(lng - 139.7671) < 1e-4, f"TOKYO[0] should be lng ~139.7671, got {lng}"
    assert abs(lat - 35.6812) < 1e-4, f"TOKYO[1] should be lat ~35.6812, got {lat}"


# ---------------------------------------------------------------------------
# apply_geocode — pure immutable transform
# ---------------------------------------------------------------------------


def test_apply_geocode_overrides_lat_lng_formatted_address():
    place = _make_place(lat=0.0, lng=0.0, formatted_address=None)
    geo = GeocodeResult(lat=35.71, lng=139.80, formatted_address="Asakusa, Tokyo")
    result = apply_geocode(place, geo)

    assert result is not place, "apply_geocode must return a new PlaceResult (immutable)"
    assert abs(result.lat - 35.71) < 1e-9
    assert abs(result.lng - 139.80) < 1e-9
    assert result.formatted_address == "Asakusa, Tokyo"


def test_apply_geocode_preserves_other_fields():
    place = _make_place(lat=0.0, lng=0.0, confidence=0.95, evidence_quote="beautiful temple")
    geo = GeocodeResult(lat=35.71, lng=139.80, formatted_address="Asakusa, Tokyo")
    result = apply_geocode(place, geo)

    assert result.name == "Senso-ji Temple"
    assert result.confidence == 0.95
    assert result.evidence_quote == "beautiful temple"
    assert result.category == "attraction"


def test_apply_geocode_none_returns_place_unchanged():
    place = _make_place(lat=12.34, lng=56.78)
    result = apply_geocode(place, None)

    assert result is place, "apply_geocode(place, None) must return the same object"
    assert result.lat == 12.34
    assert result.lng == 56.78


def test_apply_geocode_geo_none_formatted_address_overrides_with_none():
    """When geo is a hit but formatted_address=None, set formatted_address=None on place."""
    place = _make_place(lat=0.0, lng=0.0, formatted_address="original address")
    geo = GeocodeResult(lat=35.0, lng=135.0, formatted_address=None)
    result = apply_geocode(place, geo)
    assert result.formatted_address is None
