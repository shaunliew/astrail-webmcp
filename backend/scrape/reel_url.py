"""Instagram reel URL normalize + validate. Pure, offline, stdlib only."""
from __future__ import annotations

import re
from urllib.parse import urlparse

# /reel/<code> or /reels/<code>, optional trailing slash.
_REEL_RE = re.compile(r"^/reels?/([A-Za-z0-9_-]+)/?$")
_HOSTS = frozenset({"instagram.com", "www.instagram.com"})


def _reel_match(url: str) -> re.Match[str] | None:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        return None
    if (parsed.hostname or "").lower() not in _HOSTS:
        return None
    return _REEL_RE.match(parsed.path)


def is_reel_url(url: str) -> bool:
    """True for an instagram.com `/reel/<code>` or `/reels/<code>` URL."""
    return _reel_match(url) is not None


def short_code_of(url: str) -> str | None:
    """The reel short code, or None if `url` is not a reel URL."""
    m = _reel_match(url)
    return m.group(1) if m else None


def normalize_reel_url(url: str) -> str:
    """Canonical `https://www.instagram.com/reel/<code>` (drops query + trailing slash).

    Raises ValueError if `url` is not an Instagram reel URL.
    """
    code = short_code_of(url)
    if not code:
        raise ValueError(f"not an Instagram reel URL: {url!r}")
    return f"https://www.instagram.com/reel/{code}"
