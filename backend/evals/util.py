"""Pure helpers for the offline eval harness — geo, URL hygiene, evidence corpus.

Stdlib only. No network, no live API.
"""
from __future__ import annotations

import math
from urllib.parse import urlparse

# Japan bounding box (lat_min, lat_max, lng_min, lng_max) — Japan-first sanity gate.
JAPAN_BBOX: tuple[float, float, float, float] = (24.0, 46.0, 122.0, 146.0)

_PLACEHOLDER_DOMAINS: frozenset[str] = frozenset(
    {"example.com", "example.org", "example.net", "test.com", "placeholder.com"}
)
_SEARCH_URL_MARKERS: tuple[str, ...] = (
    "/search", "/maps/search", "searchresults", "/results",
)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two points, in metres."""
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def in_japan(lat: float | None, lng: float | None) -> bool:
    """True if (lat, lng) falls inside the Japan bounding box."""
    if lat is None or lng is None:
        return False
    lat_min, lat_max, lng_min, lng_max = JAPAN_BBOX
    return lat_min <= lat <= lat_max and lng_min <= lng <= lng_max


def is_placeholder_url(url: str | None) -> bool:
    """True when url is empty, non-http(s), localhost, or a known placeholder domain."""
    if not url or not url.strip():
        return True
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return True
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return True
    if host in ("localhost", "127.0.0.1", "0.0.0.0"):
        return True
    if host in _PLACEHOLDER_DOMAINS or any(host.endswith("." + d) for d in _PLACEHOLDER_DOMAINS):
        return True
    return False


def is_weak_source_url(url: str | None) -> bool:
    """True for low-trust sources: placeholders, search-result pages, or Google Maps links.

    A Google Maps link counts as weak because Google is a banned source (CLAUDE.md) and
    a maps/search link is not a real venue page that proves the place exists.
    """
    if is_placeholder_url(url):
        return True
    low = (url or "").lower()
    parsed = urlparse(low)
    host = parsed.hostname or ""
    if "google." in host and "/maps" in parsed.path:
        return True
    return any(marker in low for marker in _SEARCH_URL_MARKERS)


def reel_corpus(reels: list[dict]) -> str:
    """Lower-cased concatenation of every reel's caption + location_name. '' if none captured."""
    parts: list[str] = []
    for r in reels:
        if r.get("caption"):
            parts.append(str(r["caption"]))
        if r.get("location_name"):
            parts.append(str(r["location_name"]))
    return " ".join(parts).lower()


def evidence_in_corpus(quote: str | None, corpus: str) -> bool:
    """True if quote is a (case-insensitive) verbatim substring of the corpus."""
    if not quote:
        return False
    return quote.lower() in corpus
