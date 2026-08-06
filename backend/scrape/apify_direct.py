"""Direct-HTTP Apify Instagram reel scraper → ReelData. No MCP, no Agents SDK, no LLM.

Only called by the capture command (with APIFY_TOKEN); unit tests inject a mock
httpx transport. The actor `username` field accepts direct reel URLs (verified
against the actor input schema). The token is never placed in raised error text.
Endpoint: docs.apify.com/api/v2/act-run-sync-get-dataset-items-post
"""
from __future__ import annotations

import httpx

from models.reel import ReelData
from scrape.reel_url import url_kind

ACTOR = "apify~instagram-reel-scraper"
POST_ACTOR = "apify~instagram-post-scraper"


def _endpoint(actor: str) -> str:
    return f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items"


class ApifyScrapeError(ValueError):
    """Token-safe scrape failure from the Apify actor."""


def map_item_to_reeldata(item: dict, reel_url: str) -> ReelData:
    """Map one Apify dataset item to a captured ReelData."""
    return ReelData(
        reel_url=reel_url,
        caption=item.get("caption") or "",
        location_name=item.get("locationName"),
        short_code=item.get("shortCode"),
        capture_status="CAPTURED",
        transcript=item.get("transcript"),
        display_url=item.get("displayUrl"),   # cover frame (verified live 2026-07-31); `images` was empty — don't use it
    )


async def scrape_reel(
    reel_url: str,
    *,
    token: str,
    include_transcript: bool = False,
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 120,
) -> ReelData:
    """Scrape one reel via Apify run-sync-get-dataset-items → ReelData.

    Raises ValueError on an empty dataset, RuntimeError on a non-2xx response.
    Error messages reference the reel URL + status only — never the token.
    """
    kind = url_kind(reel_url)
    actor = POST_ACTOR if kind == "post" else ACTOR
    body: dict = {"username": [reel_url], "resultsLimit": 1}
    # The post-scraper does not document `includeTranscript`; never send undocumented
    # inputs. Posts carry no transcript anyway (guardrail #10 — reels-only field).
    if include_transcript and kind == "reel":
        body["includeTranscript"] = True
    headers = {"Authorization": f"Bearer {token}"}
    params = {"timeout": timeout_s}

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s + 10)
    try:
        resp = await http.post(_endpoint(actor), json=body, headers=headers, params=params)
    finally:
        if owns_client:
            await http.aclose()

    if resp.status_code // 100 != 2:
        raise RuntimeError(f"Apify scrape failed for {reel_url} (HTTP {resp.status_code})")
    items = resp.json()
    if not items:
        raise ApifyScrapeError(f"Apify returned no items for {reel_url}")
    item = items[0]
    # The actor signals a failed scrape (private/blocked/empty) as an error ITEM,
    # not an HTTP error. Detect it so we never feed the extractor an empty ReelData.
    if item.get("error"):
        detail = item.get("errorDescription") or "no detail"
        request_errors = item.get("requestErrorMessages") or []
        if any("request blocked" in str(msg).lower() for msg in request_errors):
            detail = "blocked by Instagram; actor request was blocked after retries"
        raise ApifyScrapeError(f"Apify could not scrape {reel_url}: {item.get('error')} ({detail})")
    return map_item_to_reeldata(item, reel_url)
