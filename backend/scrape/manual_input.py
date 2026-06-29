"""Manual-paste reel ingestion — the Apify IG-block contingency.

When Instagram block waves take the logged-out Apify actor down globally (see
scrape/probe_apify.py), the scrape stage cannot produce a ReelData. The downstream
pipeline depends only on the *text* (caption + location_name), not on where it came
from — so a human can paste the reel's caption (and optional location tag) and the
extractor runs unchanged. Posture-neutral: no scraping, no Apify token, no login.

Pure + offline: importing this module needs no key, pulls in no SDK, makes no call.
"""
from __future__ import annotations

import hashlib

from models.reel import ReelData
from scrape.reel_url import is_reel_url, normalize_reel_url

MANUAL_CAPTURE_STATUS = "MANUAL"


def manual_reeldata(
    caption: str, *, location_name: str | None = None, source_url: str | None = None
) -> ReelData:
    """Build a ReelData from manually-pasted reel text (Apify-block contingency).

    `caption` is required (the pasted reel text). `location_name` is the optional
    Instagram location tag (a blank/whitespace tag is normalized to None so it can't
    become a spurious highest-confidence signal in build_extractor_input). When
    `source_url` is a real reel URL it is normalized and used as the provenance key;
    otherwise reel_url is a deterministic `manual:<digest>` sentinel so re-pasting the
    same text is idempotent (stable cache/fixture key).

    Raises ValueError on empty/blank caption (fail fast at the boundary).
    """
    if not caption or not caption.strip():
        raise ValueError("manual capture requires non-empty caption text")
    location = (location_name or "").strip() or None  # blank tag → None
    if source_url and is_reel_url(source_url):
        reel_url = normalize_reel_url(source_url)
    else:
        digest = hashlib.sha256(
            f"{caption}\n{location or ''}".encode("utf-8")
        ).hexdigest()[:12]
        reel_url = f"manual:{digest}"
    return ReelData(
        reel_url=reel_url,
        caption=caption,
        location_name=location,
        capture_status=MANUAL_CAPTURE_STATUS,
    )
