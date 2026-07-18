"""Write-through EXTRACTION cache on reel_cache — a version-keyed per-reel cache so a repeat reel
skips scrape+extract. Live-only (in the live runner path; the offline #16 eval uses fixtures, never
this). Import-keyless: no client at module scope. A non-reel URL is uncacheable (normalize raises) —
the caller falls through to scrape+extract with no cache write."""
from __future__ import annotations

import sys

from pydantic import ValidationError

from models.place import ExtractionResult, PlaceResult
from scrape.reel_url import normalize_reel_url

EXTRACTION_CACHE_TABLE = "reel_cache"


async def get_cached_places(client, url: str, extractor_version: str) -> list[PlaceResult] | None:
    """The cached extraction for one reel at THIS extractor_version, or None (miss). None on a
    non-reel URL or a URL/version mismatch. A stale-version row is a miss → re-extract."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return None
    rows = (await client.table(EXTRACTION_CACHE_TABLE).select("extracted_places")
            .eq("normalized_url", key).eq("extractor_version", extractor_version).execute()).data
    if not rows or rows[0].get("extracted_places") is None:
        return None
    try:
        places = ExtractionResult.model_validate({
            "places": rows[0]["extracted_places"],
        }).places
    except ValidationError:
        return None
    print(f"  [cache] HIT {key} -> {len(places)} places (skipped scrape+extract)", file=sys.stderr)
    return places


async def cache_places(client, url: str, reel, places: list[PlaceResult], extractor_version: str) -> None:
    """Write-through the extraction (guardrail #7): upsert the reel_cache row keyed on normalized_url,
    stamping extractor_version + the scrape fields (caption/location/transcript, for the frontend tray
    join). No-op on a non-reel URL. A 0-place result IS cached (avoids re-extracting a dry reel)."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return
    await client.table(EXTRACTION_CACHE_TABLE).upsert({
        "normalized_url": key,
        "source_platform": "instagram",
        "caption": getattr(reel, "caption", "") or "",
        "location_name": getattr(reel, "location_name", None),
        "transcript": getattr(reel, "transcript", None),
        "extracted_places": [p.model_dump() for p in places],
        "extractor_version": extractor_version,
    }, on_conflict="normalized_url").execute()
    print(f"  [cache] MISS {key} -> cached {len(places)} places (v={extractor_version})", file=sys.stderr)
