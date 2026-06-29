"""Geocode query policy — choose (query, language) for a place. Pure, offline, no key.

Mapbox indexes Japan POIs in Japanese, so a Japanese-script query must be sent with
language="ja"; a Latin query uses "en". The query string itself may be either script
(a famous venue's `name` is often English; a creator tag is often Japanese), so the
language is detected from the chosen query's SCRIPT, not assumed from a constant.
"""
from __future__ import annotations

from models.place import PlaceResult


def _has_japanese(text: str) -> bool:
    """True if `text` contains Hiragana/Katakana (U+3040-30FF) or CJK ideographs
    (U+4E00-9FFF, i.e. Kanji)."""
    return any(
        0x3040 <= ord(ch) <= 0x30FF or 0x4E00 <= ord(ch) <= 0x9FFF
        for ch in text
    )


def query_language(query: str) -> str:
    """Pick the Mapbox query language from the query's script.

    Beta: Japanese script → "ja" (Mapbox indexes Japan POIs in Japanese); otherwise "en".
    SCALING: extend per added locale. Han (U+4E00-9FFF) is shared by Japanese and Chinese,
    so when China is added this must disambiguate via the trip destination, not script alone.
    """
    return "ja" if _has_japanese(query) else "en"


def geocode_query(place: PlaceResult) -> tuple[str, str]:
    """Choose (query, language) for geocoding `place`: prefer the verbatim local-script
    name_local over the (possibly English) name, then detect the language from that query."""
    query = place.name_local or place.name
    return query, query_language(query)
