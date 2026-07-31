"""Write-through EXTRACTION cache on reel_cache — a version-keyed per-reel cache so a repeat reel
skips scrape+extract. Live-only (in the live runner path; the offline #16 eval uses fixtures, never
this). Import-keyless: no client at module scope. A non-reel URL is uncacheable (normalize raises) —
the caller falls through to scrape+extract with no cache write."""
from __future__ import annotations

import hashlib
import sys

from pydantic import ValidationError

from models.place import ExtractionResult, PlaceResult
from pipeline.thumbnails import rehost_cover
from scrape.reel_url import normalize_reel_url, short_code_of

EXTRACTION_CACHE_TABLE = "reel_cache"


def _cover_key(normalized_url: str) -> str:
    """Path-safe Storage key from the VALIDATED normalized URL (never the unvalidated Apify short_code —
    prevents `../bucket` path traversal). Hash fallback if a code can't be extracted."""
    try:
        code = short_code_of(normalized_url)
    except Exception:
        code = None
    return code or hashlib.sha1(normalized_url.encode()).hexdigest()[:16]


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


async def cache_places(
    client, url: str, reel, places: list[PlaceResult], extractor_version: str, *, rehost=rehost_cover,
) -> None:
    """Write-through the extraction (guardrail #7): upsert the reel_cache row keyed on normalized_url,
    stamping extractor_version + the scrape fields (caption/location/transcript, for the frontend tray
    join). No-op on a non-reel URL. A 0-place result IS cached (avoids re-extracting a dry reel).

    Also persists the raw display_url (durable repair pointer, decision B) and re-hosts the cover
    (best-effort) into public Storage -> thumbnail_url. A failed/absent cover OMITS thumbnail_url so a
    re-cache never nulls an existing value (PostgREST updates only supplied columns — Codex-verified).
    `rehost` is injected (default rehost_cover); a reel with `display_url is None` never calls it, so the
    offline fake client (which implements no `.storage`) stays valid."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return

    payload = {
        "normalized_url": key,
        "source_platform": "instagram",
        "caption": getattr(reel, "caption", "") or "",
        "location_name": getattr(reel, "location_name", None),
        "transcript": getattr(reel, "transcript", None),
        "extracted_places": [p.model_dump() for p in places],
        "extractor_version": extractor_version,
    }

    display_url = getattr(reel, "display_url", None)
    if display_url:
        payload["raw_payload"] = {"display_url": display_url}   # durable repair pointer (decision B)
        thumb = await rehost(client, display_url, _cover_key(key))
        if thumb:
            payload["thumbnail_url"] = thumb                    # omit on failure => preserve prior value

    await client.table(EXTRACTION_CACHE_TABLE).upsert(payload, on_conflict="normalized_url").execute()
    print(f"  [cache] MISS {key} -> cached {len(places)} places (v={extractor_version})", file=sys.stderr)
