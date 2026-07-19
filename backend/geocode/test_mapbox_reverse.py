from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlparse
from unittest.mock import AsyncMock

import httpx
import pytest

from geocode.mapbox_reverse import MAX_REVERSE_RETRY_DELAY_S, parse_reverse_country_response, reverse_country


_JP_RESPONSE = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {
            "feature_type": "address",
            "name": "5-3-1, Akasaka",
            "context": {
                "country": {
                    "name": "Japan",
                    "country_code": "JP",
                    "country_code_alpha_3": "JPN",
                }
            },
        },
    }],
}


def test_parse_reverse_country_response_reads_country_context():
    result = parse_reverse_country_response(_JP_RESPONSE)
    assert result is not None
    assert result.country_code == "JP"
    assert result.country_name == "Japan"


def test_parse_reverse_country_response_accepts_top_level_country_feature():
    payload = {
        "features": [{
            "properties": {
                "feature_type": "country",
                "name": "South Korea",
                "country_code": "KR",
            }
        }]
    }
    result = parse_reverse_country_response(payload)
    assert result is not None
    assert (result.country_code, result.country_name) == ("KR", "South Korea")


@pytest.mark.parametrize("payload", [
    None,
    {},
    {"features": "bad"},
    {"features": [None]},
    {"features": [{"properties": {"name": "Japan"}}]},
    {"features": [{"properties": {"country_code": "JPN", "name": "Japan"}}]},
])
def test_parse_reverse_country_response_rejects_malformed_shapes(payload):
    with pytest.raises(RuntimeError, match="malformed"):
        parse_reverse_country_response(payload)


def test_parse_empty_feature_collection_raises():
    """A well-formed but EMPTY FeatureCollection is treated as a provider fault, not an answer.

    It used to return None, which `_ground_place` read as "this place does not verify" and the
    item settled at `location_not_found` — a terminal state. An empty-but-valid collection is
    far more likely a Mapbox brownout than a real country-less venue, so raising is the right
    bias: the item settles at `failed`, which is retryable. Accepted consequence: a genuine
    open-ocean coordinate now reports `failed` instead of `location_not_found`.
    """
    with pytest.raises(RuntimeError):
        parse_reverse_country_response({"type": "FeatureCollection", "features": []})


@pytest.mark.parametrize("payload", [
    {"features": []},
    {"type": "Collection", "features": []},
    {"type": "FeatureCollection"},
])
def test_parse_reverse_country_response_rejects_malformed_empty_payloads(payload):
    with pytest.raises(RuntimeError, match="malformed"):
        parse_reverse_country_response(payload)


@pytest.mark.asyncio
async def test_reverse_country_sends_permanent_country_only_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    query = parse_qs(urlparse(seen["url"]).query)

    assert query["latitude"] == ["35.67311"]
    assert query["longitude"] == ["139.73625"]
    assert query["types"] == ["country"]
    assert query["limit"] == ["1"]
    assert query["language"] == ["en"]
    assert query["permanent"] == ["true"]
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_retries_one_network_failure():
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectTimeout("contains SECRET URL", request=request)
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(35.67311, 139.73625, token="SECRET", client=client, retry_delay_s=0)
    assert attempts == 2
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_4xx_is_sanitized_and_not_retried():
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(403)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    assert attempts == 1
    assert "403" in str(exc_info.value)
    assert "SECRET" not in str(exc_info.value)
    assert "http" not in str(exc_info.value).lower()
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_invalid_json_is_sanitized_provider_failure():
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda _request: httpx.Response(200, content=b"not-json")
    ))
    with pytest.raises(RuntimeError, match="invalid response") as exc_info:
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    assert "SECRET" not in str(exc_info.value)
    assert "http" not in str(exc_info.value).lower()
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_retries_then_raises_on_5xx():
    attempts = 0

    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(503)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="503"):
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client, retry_delay_s=0)
    assert attempts == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_retries_429_once_using_capped_retry_after(monkeypatch):
    attempts = 0
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)

    def handler(_request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, headers={"Retry-After": "9"})
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(35.67311, 139.73625, token="SECRET", client=client)

    assert attempts == 2
    sleep.assert_awaited_once_with(MAX_REVERSE_RETRY_DELAY_S)
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_408_uses_retry_delay_when_retry_after_is_absent(monkeypatch):
    attempts = 0
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)

    def handler(_request):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(408)
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(
        35.67311, 139.73625, token="SECRET", client=client, retry_delay_s=0.4
    )

    assert attempts == 2
    sleep.assert_awaited_once_with(0.4)
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_repeated_429_error_is_status_only(monkeypatch):
    sleep = AsyncMock()
    monkeypatch.setattr(asyncio, "sleep", sleep)
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda _request: httpx.Response(429, text="SECRET https://private.example")
    ))

    with pytest.raises(RuntimeError) as exc_info:
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client)

    assert "429" in str(exc_info.value)
    assert "SECRET" not in str(exc_info.value)
    assert "http" not in str(exc_info.value).lower()
    await client.aclose()
