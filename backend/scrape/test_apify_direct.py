"""Apify direct-HTTP scraper — offline, mocked httpx transport (no network)."""
import json

import httpx
import pytest

from scrape.apify_direct import ApifyScrapeError, map_item_to_reeldata, scrape_reel

_ITEM = {"caption": "📍Tokyo Dream Park", "locationName": "Tokyo, Japan",
         "shortCode": "DYbmT-SNzVK", "url": "https://www.instagram.com/reel/DYbmT-SNzVK/",
         "displayUrl": "https://cdn.example/cover.jpg"}
_URL = "https://www.instagram.com/reel/DYbmT-SNzVK/"


def test_map_item_to_reeldata():
    rd = map_item_to_reeldata(_ITEM, _URL)
    assert rd.caption.startswith("📍Tokyo Dream Park")
    assert rd.location_name == "Tokyo, Japan"
    assert rd.short_code == "DYbmT-SNzVK"
    assert rd.reel_url == _URL
    assert rd.capture_status == "CAPTURED"
    assert rd.display_url == "https://cdn.example/cover.jpg"


def test_map_item_to_reeldata_without_display_url_is_none():
    item = {k: v for k, v in _ITEM.items() if k != "displayUrl"}
    rd = map_item_to_reeldata(item, _URL)
    assert rd.display_url is None


async def test_scrape_reel_posts_to_run_sync_and_maps():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = request.read().decode()
        return httpx.Response(201, json=[_ITEM])

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    rd = await scrape_reel(_URL, token="TKN", client=client)
    assert "acts/apify~instagram-reel-scraper/run-sync-get-dataset-items" in seen["url"]
    assert seen["auth"] == "Bearer TKN"
    assert _URL in seen["body"]
    assert rd.short_code == "DYbmT-SNzVK"


async def test_scrape_reel_empty_dataset_raises():
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(201, json=[])))
    with pytest.raises(ValueError):
        await scrape_reel(_URL, token="T", client=client)


async def test_scrape_reel_error_item_raises():
    # the actor returns a non-2xx-less error ITEM when the reel is private/blocked/empty
    err_item = {"error": "no_items", "errorDescription": "Empty or private data for provided input",
                "inputUrl": _URL}
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(201, json=[err_item])))
    with pytest.raises(ValueError) as e:
        await scrape_reel(_URL, token="SECRET", client=client)
    assert "no_items" in str(e.value)
    assert "SECRET" not in str(e.value)


async def test_scrape_reel_blocked_error_item_mentions_block_without_token():
    err_item = {
        "error": "no_items",
        "errorDescription": "Empty or private data for provided input",
        "inputUrl": _URL,
        "requestErrorMessages": ["Error: Request blocked, retrying it again with different session"],
    }
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(201, json=[err_item])))
    with pytest.raises(ApifyScrapeError) as e:
        await scrape_reel(_URL, token="SECRET", client=client)
    assert "blocked by Instagram" in str(e.value)
    assert "SECRET" not in str(e.value)


async def test_scrape_reel_408_is_clear_and_tokenless():
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(408)))
    with pytest.raises(Exception) as e:
        await scrape_reel(_URL, token="SECRET", client=client)
    assert "SECRET" not in str(e.value)
    assert "408" in str(e.value)


# --- T2: URL-kind actor routing (posts -> instagram-post-scraper) ---

_POST_URL = "https://www.instagram.com/p/DQwdZ8ZCWZx/"
_SIDECAR_ITEM = {
    "type": "Sidecar",
    "caption": "3 days in Kyoto 🇯🇵",
    "shortCode": "DQwdZ8ZCWZx",
    "displayUrl": "https://cdn.example/carousel-cover.jpg",
}


def _capturing_client(item: dict, seen: dict) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = request.read().decode()
        return httpx.Response(201, json=[item])

    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_scrape_post_url_routes_to_post_scraper():
    seen: dict = {}
    await scrape_reel(_POST_URL, token="TKN", client=_capturing_client(_SIDECAR_ITEM, seen))
    assert "acts/apify~instagram-post-scraper/run-sync-get-dataset-items" in seen["url"]


async def test_scrape_reel_url_still_routes_to_reel_scraper():
    seen: dict = {}
    await scrape_reel(_URL, token="TKN", client=_capturing_client(_ITEM, seen))
    assert "acts/apify~instagram-reel-scraper/run-sync-get-dataset-items" in seen["url"]


async def test_post_url_omits_include_transcript_even_when_requested():
    seen: dict = {}
    await scrape_reel(
        _POST_URL, token="TKN", include_transcript=True,
        client=_capturing_client(_SIDECAR_ITEM, seen),
    )
    assert "includeTranscript" not in json.loads(seen["body"])


async def test_reel_url_sends_include_transcript_true_when_requested():
    seen: dict = {}
    await scrape_reel(
        _URL, token="TKN", include_transcript=True,
        client=_capturing_client(_ITEM, seen),
    )
    assert json.loads(seen["body"])["includeTranscript"] is True


async def test_sidecar_item_maps_to_captured_reeldata_without_transcript_or_location():
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(201, json=[_SIDECAR_ITEM])))
    rd = await scrape_reel(_POST_URL, token="TKN", client=client)
    assert rd.capture_status == "CAPTURED"
    assert rd.transcript is None
    assert rd.location_name is None
    assert rd.short_code == "DQwdZ8ZCWZx"
    assert rd.display_url == "https://cdn.example/carousel-cover.jpg"


async def test_post_error_item_raises_apify_scrape_error():
    err_item = {"error": "no_items", "errorDescription": "Empty or private data for provided input",
                "inputUrl": _POST_URL}
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda r: httpx.Response(201, json=[err_item])))
    with pytest.raises(ApifyScrapeError):
        await scrape_reel(_POST_URL, token="SECRET", client=client)
