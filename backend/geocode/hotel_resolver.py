"""Batch, country-aware, cached hotel resolution (T4) — the crux of the hotel-geocoding fix.

Turns a trip's raw Travala hotel dicts into a list of `GeocodeResult | None` **aligned with the
input order** (v3 #4 — a hotelId only gates cache eligibility + the key; ranking is index-based and a
dict-by-hotelId cannot represent a missing / duplicate id). For each hotel:

  * JP (country in `_NATIVE_SCRIPT_COUNTRIES`) — Mapbox indexes Japan POIs in Japanese script, and
    romaji `types="address"` returns 0 hits, so: localize the name (T1) -> a STRICT Japanese-script
    validator -> `strict_geocode(name, types="poi", language="ja", country=…)`.
  * else — the romaji street address already works: `strict_geocode("{address}, {city}",
    types="address", country=…)`. `country` is ALWAYS passed (v3 #1 — forward_geocode defaults to
    "jp", so omitting it mis-geocodes every non-JP hotel).

Then an IDENTITY GATE (plan decision #2c, trip-INDEPENDENT): a result is `found` ONLY if the country
matches AND — on the JP `types="poi"` path — Mapbox's own `poi_category` for the returned feature
contains a lodging value (unknown / absent → NOT lodging → miss, fail-safe). This closes the proven
"Hilton Tokyo Bay -> vending machine" hole the coord gate can't. The ≤60 km proximity gate is NOT here
— it is trip-specific and re-runs in `rank_hotels` (T5), never cached (v5 #2). Non-JP address results
carry no `poi_category`, so the resolver gate is country-only there (the accepted, documented residual).
The gate guarantees the pin is ALWAYS a real lodging in the right country — never invented / non-hotel
(Guardrail #1); it does NOT guarantee it is *this* Travala hotel (no Travala coord/brand/id, no Mapbox
confidence), so any wrong same-area real lodging is the ZH-approved accept-and-watch residual.

Caching (plan decisions #5/#6/#8): each cacheable hotel (a non-null, batch-UNIQUE hotelId) is keyed by
its stable Travala identity and resolved through `geocode.cache.resolve_cached`, which OWNS the per-key
single-flight lock. T4 does NOT acquire that lock (asyncio.Lock is not reentrant — a nested acquire
would DEADLOCK, v4 #3): it supplies the `resolver` closure (translate -> validate -> geocode -> gate)
that `resolve_cached` runs inside ONE lock hold, so two concurrent trips sharing a hotel pay for ONE
translate + ONE geocode. A missing / duplicate hotelId is not a stable identity → that hotel resolves
LIVE, uncached, so it can never poison a shared cache row. A typed `ResolveError` / `CacheError`
PROPAGATES (translator outage, malformed-2xx, cache-write failure) — never coerced to a miss — so the
caller (persist) preserves prior hotel rows rather than clobbering good coords.

Per-key translate is DELIBERATE — DO NOT re-batch it (v3 #3 / v4 #3). `translate` runs ONE localizer
call per MISSED hotel, from inside that hotel's `resolve_cached` single-flight (`_resolve_one` calls
`translate([hotel], ...)`, a 1-element batch); the calls run concurrently across hotels via
`asyncio.gather`, but each is fronted by its OWN per-key lock + cache read. Hoisting translate into a
single batch call OUTSIDE the per-key single-flight would reintroduce the cross-trip double-bill: two
trips sharing a hotel would each pre-translate before either wrote its cache row, so the localizer bill
(and outage blast radius) would no longer be deduplicated by the cache. A future maintainer must NOT
"optimize" the per-key localizer call back into a pre-batch outside `resolve_cached`.

LIVE-ONLY — like `genagents.hotel_translate` and `geocode.cache`, this module MUST NEVER be imported by
the offline eval / offline_harness (T6 asserts it never enters sys.modules on the offline path). All IO
is injected (`geocode`, `translate`, `cache_client`), so it holds no token and makes no network call.
Import discipline (Guardrail #9): nothing heavy at module scope — no Agents SDK, no `openai`, no
`httpx`, no supabase client — so `import geocode.hotel_resolver` loads nothing that needs a key.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import unicodedata
from collections import Counter
from typing import Any, Awaitable, Callable, Mapping, Sequence

from geocode.cache import identity_key, lookup_many, resolve_cached
from models.geocode import GeocodeResult

# Countries whose POIs Mapbox indexes in the LOCAL script, so a hotel must be localized before the
# `types="poi"` geocode. Extensible: Korea + Western markets geocode romaji-first, no LLM (Key Fact:
# a live Korea probe showed romaji address + English name both resolve, Hangul name returns 0).
_NATIVE_SCRIPT_COUNTRIES = frozenset({"JP"})

_PROVIDER = "travala"

# ---- JA-script-ratio validator (plan decision #2 — EXACT thresholds) ------------------------------
# The gate BEFORE any paid Mapbox call. `query_language(name) == "ja"` is TOO WEAK — it returns "ja"
# on a single CJK char, so "Imperial Hotel 東京" would pass and re-open the 125 km / vending-machine
# path. A localized name is Mapbox-eligible ONLY if, after NFKC: it is 1–120 code points, carries no
# control chars / prompt delimiters, has ≥ 2 Japanese chars, AND japanese/(japanese+latin) ≥ 0.70.
_JA_NAME_MIN_CP = 1
_JA_NAME_MAX_CP = 120
_JA_MIN_JAPANESE_CHARS = 2
_JA_MIN_RATIO = 0.70

# Hiragana/Katakana (U+3040–30FF) + CJK ideographs (U+4E00–9FFF, Kanji).
_JA_RANGES: tuple[tuple[int, int], ...] = ((0x3040, 0x30FF), (0x4E00, 0x9FFF))

# Prompt / field delimiters (guardrail #11 framing) a real venue name never contains — their presence
# means injected text is riding through, so the name is rejected. `<` `>` `|` also catch chat-template
# tokens (<system>, <|im_start|>). Parens/middle-dots in real JP names are intentionally allowed.
_DELIMITERS = frozenset("[]{}<>|")

# Mapbox Search Box `poi_category` values that confirm a lodging (plan decision #2c). The exact set is
# tuned from the T6 /qa capture (the full enumeration is unconfirmed); UNKNOWN / ABSENT → NOT lodging →
# miss (fail-safe: a false "couldn't place" costs recall, never a wrong pin). Canonicalized to
# lowercase, underscores→spaces, so "bed_and_breakfast" and "bed and breakfast" both match.
_LODGING_CATEGORIES = frozenset({
    "lodging", "hotel", "hostel", "motel", "resort", "inn",
    "guesthouse", "guest house", "bed and breakfast", "b&b", "bnb", "ryokan",
})


def _is_japanese(ch: str) -> bool:
    o = ord(ch)
    return any(lo <= o <= hi for lo, hi in _JA_RANGES)


def _is_latin(ch: str) -> bool:
    """A Latin-script LETTER (ASCII a–z/A–Z or the Latin-1/Extended letter blocks). Digits, spaces
    and punctuation count as NEITHER Japanese nor Latin, so they do not dilute the ratio."""
    o = ord(ch)
    if 0x41 <= o <= 0x5A or 0x61 <= o <= 0x7A:
        return True
    return 0x00C0 <= o <= 0x024F and ch.isalpha()


def is_valid_ja_name(name: object) -> bool:
    """True iff `name` is a valid LOCAL-script Japanese hotel query (plan decision #2). Rejects the
    English/mixed echoes ("Imperial Hotel", "Imperial Hotel 東京") that would otherwise geocode to a
    replica / vending machine — so a failed localization becomes a zero-Mapbox miss, never a wrong pin.
    """
    if not isinstance(name, str):
        return False
    norm = unicodedata.normalize("NFKC", name).strip()
    length = len(norm)
    if length < _JA_NAME_MIN_CP or length > _JA_NAME_MAX_CP:
        return False
    japanese = latin = 0
    for ch in norm:
        if unicodedata.category(ch)[0] == "C":  # control / format / surrogate / unassigned / private
            return False
        if ch in _DELIMITERS:
            return False
        if _is_japanese(ch):
            japanese += 1
        elif _is_latin(ch):
            latin += 1
    if japanese < _JA_MIN_JAPANESE_CHARS:
        return False
    denom = japanese + latin
    return denom > 0 and japanese / denom >= _JA_MIN_RATIO


# ---- identity fingerprint + gate ------------------------------------------------------------------


def _norm(value: object) -> str:
    """NFKC + casefold — compatibility forms and case variants of the same text collapse."""
    return unicodedata.normalize("NFKC", "" if value is None else str(value)).casefold()


def name_fingerprint(hotel: Mapping[str, Any]) -> str:
    """A digest of the hotel's name + address + `location` (plan decision #4/#6). Stored on the cache
    row and compared on read: if Travala reuses the hotelId for a DIFFERENT hotel, or the hotel
    relocates/rebrands, the fingerprint changes and the stale coord is re-resolved instead of served."""
    canonical = json.dumps(
        {
            "name": _norm(hotel.get("name")),
            "address": _norm(hotel.get("address")),
            "location": _norm(hotel.get("location")),
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _canon_category(value: str) -> str:
    return value.strip().lower().replace("_", " ")


def _is_lodging(poi_category: Sequence[str] | None) -> bool:
    """True iff Mapbox's poi_category list contains a known lodging value. Empty / unknown → False
    (fail-safe): the JP `types="poi"` gate never confirms a non-lodging (e.g. a vending machine)."""
    cats = {_canon_category(c) for c in (poi_category or []) if isinstance(c, str)}
    return bool(cats & _LODGING_CATEGORIES)


def _identity_confirmed(geo: GeocodeResult, country_cc: str, is_jp: bool) -> bool:
    """The trip-INDEPENDENT identity gate (plan decision #2c). Country must match; on the JP
    `types="poi"` path the returned feature must be a lodging. The ≤60 km proximity check is
    trip-specific and re-runs in `rank_hotels` (T5) — it is deliberately NOT here."""
    if geo.country_code is None or geo.country_code.upper() != country_cc:
        return False
    if is_jp and not _is_lodging(geo.poi_category):
        return False
    return True


# ---- orchestration --------------------------------------------------------------------------------


def _cacherow_to_result(row) -> GeocodeResult | None:
    """A fingerprint-matched cache hit from `lookup_many`. A `found` row was identity-gated when it was
    written, so only its coord + country are needed (the per-trip ≤60 km gate re-runs on them); a
    `miss` row → None (a genuine cached miss, do NOT re-resolve)."""
    if row.status == "found":
        return GeocodeResult(lat=row.lat, lng=row.lng, country_code=row.country_code)
    return None


async def resolve_hotels(
    hotels: Sequence[Mapping[str, Any]],
    country_code: str,
    city: str | None,
    proximity_lng_lat: tuple[float, float] | None,
    *,
    geocode: Callable[..., Awaitable[GeocodeResult | None]],
    translate: Callable[..., Awaitable[dict[int, str]]],
    cache_client,
    hit_ttl_days: int = 365,
    miss_ttl_days: int = 14,
) -> list[GeocodeResult | None]:
    """Resolve every hotel to a `GeocodeResult | None`, ALIGNED WITH INPUT ORDER. See the module
    docstring for the country routing, identity gate, caching and failure taxonomy.

    Args:
        hotels: raw Travala hotel dicts (name / address / location / hotelId).
        country_code: the trip's country (e.g. "JP"); routes JP↔non-JP AND is the geocode country
            filter + the identity gate's country match. Callers short-circuit before None reaches here.
        city: geocode query suffix for the non-JP `types="address"` path ("{address}, {city}").
        proximity_lng_lat: (lng, lat) disambiguation bias passed to geocode — NOT keyed, NOT persisted.
        geocode: async STRICT geocoder, token pre-bound —
            (query, *, types, country, language, proximity_lng_lat) -> GeocodeResult | None,
            raising ResolveError on any infra fault (never returning None for a fault).
        translate: async localizer (T1 `localize_hotel_names`) — (hotels, country_code) ->
            {ordinal: localized_name}; raises ResolveError on an OpenAI/infra fault.
        cache_client: a Supabase client, or None to disable caching (offline byte-identical).
        hit_ttl_days / miss_ttl_days: cache TTLs threaded to `resolve_cached`.
    """
    if not hotels:
        return []

    country_cc = (country_code or "").upper()
    is_jp = country_cc in _NATIVE_SCRIPT_COUNTRIES

    # Cacheability: a hotelId is a stable identity ONLY when present AND UNIQUE in this batch. A
    # missing / duplicated id resolves LIVE (no key, no cache) so it can never poison a shared row.
    ids = [str(h.get("hotelId")).strip() if isinstance(h, Mapping) and h.get("hotelId") else ""
           for h in hotels]
    id_counts = Counter(i for i in ids if i)

    keys: list[str | None] = []
    fps: list[str | None] = []
    for hotel, hid in zip(hotels, ids):
        if hid and id_counts[hid] == 1:
            keys.append(identity_key(_PROVIDER, country_cc, hid))
            fps.append(name_fingerprint(hotel))
        else:
            keys.append(None)
            fps.append(None)

    # One LOCK-FREE bulk read for every cacheable key (plan decision #8) — hits skip resolve_cached
    # entirely; only genuine misses take the per-key single-flight path.
    cacheable_keys = [k for k in keys if k is not None]
    bulk = (await lookup_many(cache_client, cacheable_keys)
            if cache_client is not None and cacheable_keys else {})

    async def _resolve_one(hotel: Mapping[str, Any]) -> GeocodeResult | None:
        """The whole miss unit for ONE hotel (translate -> validate -> geocode -> identity gate). Run
        inside `resolve_cached`'s single-flight for cacheable hotels; called directly for live ones.
        Returns a found GeocodeResult, None for a valid-empty / unconfirmed miss, or raises
        ResolveError on an infra fault (propagated, never cached)."""
        if is_jp:
            localized = await translate([hotel], country_code)  # 1-element batch; T1 prefilters unsafe
            name = localized.get(0)
            if not is_valid_ja_name(name):
                return None  # unlocalizable / English-or-mixed echo → miss, ZERO Mapbox call
            geo = await geocode(name, types="poi", language="ja", country=country_code,
                                proximity_lng_lat=proximity_lng_lat)
        else:
            address = hotel.get("address")
            if not address:
                return None  # no street address → cannot honestly geocode → miss
            query = ", ".join(part for part in (str(address), city) if part)
            geo = await geocode(query, types="address", country=country_code,
                                proximity_lng_lat=proximity_lng_lat)
        if geo is None:
            return None  # valid-empty Mapbox → cacheable miss
        return geo if _identity_confirmed(geo, country_cc, is_jp) else None

    async def _resolve_index(i: int) -> GeocodeResult | None:
        hotel = hotels[i]
        key = keys[i]
        if key is None:  # missing / duplicate hotelId → resolve LIVE, never cached
            return await _resolve_one(hotel)
        row = bulk.get(key)
        if row is not None and row.name_fingerprint == fps[i]:
            return _cacherow_to_result(row)  # clean, fingerprint-matching bulk hit
        # Miss / expired / malformed / fingerprint-mismatch → resolve_cached OWNS the single-flight
        # (T4 does NOT acquire the lock — v4 #3). Bind `hotel` per-call to avoid a late-binding closure.
        return await resolve_cached(
            cache_client, key, lambda hotel=hotel: _resolve_one(hotel),
            expected_fingerprint=fps[i], country_code=country_cc,
            hit_ttl_days=hit_ttl_days, miss_ttl_days=miss_ttl_days,
        )

    # A ResolveError / CacheError from any hotel propagates (return_exceptions=False) — never coerced
    # to a miss, so the caller preserves prior hotel rows.
    return list(await asyncio.gather(*[_resolve_index(i) for i in range(len(hotels))]))
