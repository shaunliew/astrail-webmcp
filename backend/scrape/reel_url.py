"""Instagram post URL normalize + validate (reels + /p/ + /tv/). Pure, offline, stdlib only.

`normalize_reel_url` keeps its historic name for call-site stability; it accepts and
canonicalizes every supported shape:
  /reel/<code>, /reels/<code>  -> https://www.instagram.com/reel/<code>   (kind "reel")
  /p/<code>,    /tv/<code>     -> https://www.instagram.com/p/<code>      (kind "post")
"""
from __future__ import annotations

import re
from urllib.parse import urlparse

_PATH_RE = re.compile(r"^/(reels?|p|tv)/([A-Za-z0-9_-]+)/?$")
_HOSTS = frozenset({"instagram.com", "www.instagram.com"})
_KIND = {"reel": "reel", "reels": "reel", "p": "post", "tv": "post"}


def _match(url: str) -> re.Match[str] | None:
    parsed = urlparse((url or "").strip())
    if parsed.scheme not in ("http", "https"):
        return None
    try:
        parsed.port  # invalid or out-of-range port -> hostile/malformed netloc
    except ValueError:
        return None
    if (parsed.hostname or "").lower() not in _HOSTS:
        return None
    return _PATH_RE.match(parsed.path)


def is_supported_ig_url(url: str) -> bool:
    """True for an instagram.com /reel/, /reels/, /p/, or /tv/ URL."""
    return _match(url) is not None


def url_kind(url: str) -> str | None:
    """"reel" | "post" | None — drives Apify actor routing (see apify_direct.py)."""
    m = _match(url)
    return _KIND[m.group(1).lower()] if m else None


def short_code_of(url: str) -> str | None:
    """The post short code, or None if `url` is not a supported Instagram URL."""
    m = _match(url)
    return m.group(2) if m else None


def normalize_reel_url(url: str) -> str:
    """Canonical URL (drops query + trailing slash). Raises ValueError if unsupported.

    /tv/ canonicalizes into /p/ — IGTV is retired and Instagram serves those posts at
    /p/<code>; keeping a third canonical shape would leak into dedup keys for nothing.
    """
    m = _match(url)
    if not m:
        raise ValueError(f"not a supported Instagram post URL: {url!r}")
    kind_path = "reel" if _KIND[m.group(1).lower()] == "reel" else "p"
    return f"https://www.instagram.com/{kind_path}/{m.group(2)}"
