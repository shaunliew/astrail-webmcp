"""Geocode query policy — choose (query, language) for a place. Pure, offline, no key.

Mapbox indexes Japan POIs in Japanese, so a Japanese-script query must be sent with
language="ja"; a Latin query uses "en". The query string itself may be either script
(a famous venue's `name` is often English; a creator tag is often Japanese), so the
language is detected from the chosen query's SCRIPT, not assumed from a constant.
"""
from __future__ import annotations

import unicodedata

from models.place import PlaceResult


def _has_japanese(text: str) -> bool:
    """True if `text` contains Japanese script: Hiragana/Katakana (U+3040-30FF) or CJK
    ideographs (U+4E00-9FFF, Kanji). NFKC-normalize first so compatibility forms map to
    their canonical code points — e.g. halfwidth katakana (ﾀ → タ) and fullwidth Latin
    (Ａ → A) — instead of being mis-routed to English."""
    norm = unicodedata.normalize("NFKC", text)
    return any(
        0x3040 <= ord(ch) <= 0x30FF or 0x4E00 <= ord(ch) <= 0x9FFF
        for ch in norm
    )


def query_language(query: str) -> str:
    """Pick the Mapbox query language from the query's script.

    Beta: Japanese script → "ja" (Mapbox indexes Japan POIs in Japanese); otherwise "en".
    SCALING: extend per added locale. Han (U+4E00-9FFF) is shared by Japanese and Chinese,
    so when China is added this must disambiguate via the trip destination, not script alone.
    """
    return "ja" if _has_japanese(query) else "en"


def choose_query(name: str, name_local: str | None = None) -> tuple[str, str]:
    """Choose (query, language) for a place known by `name` and, optionally, by its local-script
    `name_local`. Prefer the verbatim local name, then detect the language from that query.

    The local name is preferred because it is often the ONLY name the provider indexes. Verified
    against the live Search Box API: `q="Tokyo Disneyland"` under any language returns zero POI
    features in Japan, while `q="東京ディズニーランド"` resolves — Mapbox's Japan POI dataset
    carries Japanese names and no English ones. The language parameter cannot rescue an English
    query there (it makes Mapbox fuzzy-match English tokens against Japanese names and answer with
    a bar named "BAR of TOKYO ...tower branch"); only the query string can.

    Shared by both callers so the rule cannot drift: `geocode_query` for a pipeline PlaceResult,
    and `geocode.requested_place` for a name the agent hands to `add_place`.
    """
    query = (name_local or "").strip() or (name or "").strip()
    return query, query_language(query)


def geocode_query(place: PlaceResult) -> tuple[str, str]:
    """Choose (query, language) for geocoding `place`: prefer the verbatim local-script
    name_local over the (possibly English) name, then detect the language from that query."""
    return choose_query(place.name, place.name_local)
