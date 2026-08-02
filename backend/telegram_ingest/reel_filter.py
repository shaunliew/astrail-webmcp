"""The security boundary: the ONLY code in the bot allowed to read Telegram message text.

Everything downstream is typed to canonical reel URLs, and this module is what makes that
true. Guardrail #11 — group chat content is untrusted — so the only strings that leave here
are `https://www.instagram.com/reel/<code>` (built by `normalize_reel_url`, never guessed)
and sanitized path SHAPES. Never `text`, `caption`, a failed slice, `from.username`,
`from.first_name`, or `chat.title`.

Pure by construction: no network, no file I/O, no clock, no randomness, and — deliberately
— no `import logging` anywhere in this module. A module with no logger cannot leak through
one, which is what makes the caplog canary in the tests a hard structural assertion rather
than a review convention.

Entities, not a regex: the entity list is Telegram's OWN parse of the message. Hand-rolling
a URL scanner would mean writing a parser for untrusted content plus a ReDoS/obfuscation
surface. The only regex in play is the one already inside `normalize_reel_url`.

Offsets are UTF-16 code units, not Python characters. A single 📍 or 🔥 before a URL shifts
the two unit systems apart, and 📍-prefixed captions are the real-world case, so every slice
here goes through `_slice_utf16`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from scrape.reel_url import normalize_reel_url

# A message carrying more entities than this is not a human sharing reels. Checked on the
# SUM of `entities` + `caption_entities`: a per-list check is gamed by splitting a payload.
_MAX_ENTITIES = 100
# One share is a handful of reels. Past this the surplus is dropped and `truncated` says so.
_MAX_URLS = 10
# `rejected_shapes` is a diagnostic for the caller's log line, not a ledger — bound it.
_MAX_SHAPES = 10
_MAX_SHAPE_SEGMENTS = 4

_ELLIPSIS = "…"
# Path segments safe to echo into a log: Instagram's own vocabulary, a closed set. Anything
# else is a code, a slug, or a username and becomes `…`.
_PATH_KEYWORDS = frozenset({"reel", "reels", "p", "tv", "share", "stories", "s"})


@dataclass(frozen=True, slots=True)
class FilterResult:
    """What one Telegram message yielded. The caller's ENTIRE view of that message.

    A bare tuple of URLs is not enough: the caller must log that an Instagram URL was
    rejected, and must know a ✅ would be a lie — and it may not re-read message text to
    find either out, because this module is the single reader.
    """

    urls: tuple[str, ...]
    """Normalized, order-preserving, deduped `https://www.instagram.com/reel/<code>`."""

    rejected_shapes: tuple[str, ...]
    """Sanitized PATH SHAPES of Instagram-looking URLs that `normalize_reel_url` refused,
    e.g. `/share/reel/…`, `/p/…`. Never the URL, the code, or any surrounding text."""

    truncated: bool
    """True when the 10-URL cap discarded valid reels. Without it an 11-reel message
    ingests 10 and still earns a ✅ claiming every reel was accepted."""


def _entity_list(message: dict, key: str) -> list[Any]:
    """`message[key]` if it is a list, else `[]` — a malformed field is not a crash."""
    value = message.get(key)
    return value if isinstance(value, list) else []


def _entity_int(entity: dict, key: str) -> int | None:
    """A non-negative integer field, or None. `bool` is rejected: it is not an offset."""
    value = entity.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def _slice_utf16(src: str, offset: int, length: int) -> str | None:
    """`src[offset:offset+length]` measured in UTF-16 code units, Telegram's own unit.

    Returns None when the slice lands mid surrogate pair — a hostile or malformed offset,
    never a URL.
    """
    units = src.encode("utf-16-le")
    try:
        return units[offset * 2 : (offset + length) * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def _candidate_url(entity: Any, src: str) -> str | None:
    """The URL one entity contributes, or None. Never raises on a malformed entity.

    `url` entities point INTO the visible text; `text_link` entities carry a URL that is not
    in the text at all. Every other type — bold, mention, hashtag — is ignored entirely.
    """
    if not isinstance(entity, dict):
        return None
    kind = entity.get("type")
    if kind == "text_link":
        url = entity.get("url")
        return url if isinstance(url, str) else None
    if kind != "url":
        return None
    offset = _entity_int(entity, "offset")
    length = _entity_int(entity, "length")
    if offset is None or length is None:
        return None
    return _slice_utf16(src, offset, length)


def _is_instagram_host(url: str) -> bool:
    """Host-based, never `"instagram.com" in url`.

    The substring form accepts `instagram.com.evil.com` and `notinstagram.com`; the
    exact-or-dotted-suffix form rejects both while accepting `m.` and `www.`. A URL that
    does not parse at all (`urlparse` raises ValueError on a malformed IPv6 literal) is not
    Instagram-looking.
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host == "instagram.com" or host.endswith(".instagram.com")


def _path_shape(url: str) -> str:
    """The sanitized shape of `url`'s PATH — never its query, fragment, host, or context.

    Every segment outside `_PATH_KEYWORDS` becomes `…`; consecutive `…` collapse so the
    shape describes the route, not the arity. The segment cap is applied AFTER collapsing,
    so a run of unknown segments does not consume the whole budget.
    """
    try:
        path = urlparse(url).path
    except ValueError:
        return "/"
    segments: list[str] = []
    for raw in path.split("/"):
        if not raw:
            continue
        segment = raw if raw.lower() in _PATH_KEYWORDS else _ELLIPSIS
        if segment == _ELLIPSIS and segments and segments[-1] == _ELLIPSIS:
            continue
        segments.append(segment)
    if not segments:
        return "/"
    return "/" + "/".join(segments[:_MAX_SHAPE_SEGMENTS])


def extract_reel_urls(message: dict) -> FilterResult:
    """Normalized IG reel URLs from one Telegram message, plus the shapes we had to reject.

    Pure: no I/O, no LLM, no network, stdlib + `scrape.reel_url` only.
    """
    entities = _entity_list(message, "entities")
    caption_entities = _entity_list(message, "caption_entities")
    if len(entities) + len(caption_entities) > _MAX_ENTITIES:
        return FilterResult((), (), False)

    urls: list[str] = []
    shapes: list[str] = []
    sources = ((message.get("text"), entities), (message.get("caption"), caption_entities))
    for src, group in sources:
        text = src if isinstance(src, str) else ""
        for entity in group:
            candidate = _candidate_url(entity, text)
            if candidate is None:
                continue
            try:
                normalized = normalize_reel_url(candidate)
            except ValueError:
                # An Instagram URL we refused to guess at (`/share/…`, `/p/…`) is reported
                # as a shape so the caller can log it. Anything else is ordinary chat.
                if _is_instagram_host(candidate):
                    shape = _path_shape(candidate)
                    if shape not in shapes:
                        shapes.append(shape)
                continue
            if normalized not in urls:
                urls.append(normalized)

    return FilterResult(
        tuple(urls[:_MAX_URLS]),
        tuple(shapes[:_MAX_SHAPES]),
        truncated=len(urls) > _MAX_URLS,
    )
