"""Atomic persistence seam for one user's saved Instagram Reel."""
from __future__ import annotations

from scrape.reel_url import normalize_reel_url


async def capture_saved_reel(client, user_id: str, raw_url: str) -> dict:
    """Normalize one Reel URL and atomically persist the user's Saved Reel."""
    normalized_url = normalize_reel_url(raw_url)
    result = await client.rpc(
        "capture_saved_reel",
        {
            "p_user_id": user_id,
            "p_normalized_url": normalized_url,
            "p_source_platform": "instagram",
        },
    ).execute()
    rows = result.data
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("capture_saved_reel must return exactly one row")
    return rows[0]
