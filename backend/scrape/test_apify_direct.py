"""Apify direct-HTTP scraper — offline, mocked httpx transport (no network)."""
import httpx
import pytest

from scrape.apify_direct import ApifyScrapeError, map_item_to_reeldata, scrape_reel

_ITEM = {"caption": "📍Tokyo Dream Park", "locationName": "Tokyo, Japan",
         "shortCode": "DYbmT-SNzVK", "url": "https://www.instagram.com/reel/DYbmT-SNzVK/"}
_URL = "https://www.instagram.com/reel/DYbmT-SNzVK/"


def test_map_item_to_reeldata():
    rd = map_item_to_reeldata(_ITEM, _URL)
    assert rd.caption.startswith("📍Tokyo Dream Park")
    assert rd.location_name == "Tokyo, Japan"
    assert rd.short_code == "DYbmT-SNzVK"
    assert rd.reel_url == _URL
    assert rd.capture_status == "CAPTURED"


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
