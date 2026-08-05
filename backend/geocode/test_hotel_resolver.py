"""Tests for the batch, country-aware, cached hotel resolver (T4).

Offline + credential-free: geocode / translate / cache_client are all injected fakes (no network,
no DB, no keys). The cache fake is the same honest in-memory Supabase-query stub the T3 tests use —
it really stores rows on upsert and filters on eq/in/gt — so a "hit" means a row was actually
persisted and matched, not that a method was called. The module is LIVE-ONLY in production but every
primitive here is deterministic and injectable, so it is fully testable offline.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from geocode.cache import CACHE_TABLE, identity_key
from geocode.errors import CacheError, ResolveError
from geocode.hotel_resolver import (
    is_valid_ja_name,
    name_fingerprint,
    resolve_hotels,
)
from models.geocode import GeocodeResult


# ---- honest in-memory fake supabase client (mirrors geocode/test_cache.py) -------------------------
class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    def __init__(self, name, db, fail_ops):
        self.name, self.db, self._fail_ops = name, db, fail_ops
        self.op = None
        self.eq_filters: dict = {}
        self.in_filters: dict = {}
        self.gt_filters: dict = {}
        self.single = False
        self.on_conflict = None
        self.row = None

    def select(self, *_cols):
        self.op = "select"
        return self

    def upsert(self, row, on_conflict=None):
        self.op, self.row, self.on_conflict = "upsert", row, on_conflict
        return self

    def eq(self, key, value):
        self.eq_filters[key] = value
        return self

    def in_(self, key, values):
        self.in_filters[key] = set(values)
        return self

    def gt(self, key, value):
        self.gt_filters[key] = value
        return self

    def maybe_single(self):
        self.single = True
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self.eq_filters.items()):
            return False
        if not all(row.get(k) in vs for k, vs in self.in_filters.items()):
            return False
        for k, v in self.gt_filters.items():
            cur = row.get(k)
            if cur is None or not (cur > v):
                return False
        return True

    async def execute(self):
        if self.op in self._fail_ops:
            raise RuntimeError(f"supabase {self.op} failed")
        rows = self.db.setdefault(self.name, [])
        if self.op == "upsert":
            keys = [k.strip() for k in (self.on_conflict or "").split(",") if k.strip()]
            existing = next((r for r in rows if all(r.get(k) == self.row.get(k) for k in keys)), None)
            if existing is not None:
                existing.update(self.row)
                return _Result([existing])
            stored = {"id": f"{self.name}-{len(rows) + 1}", **self.row}
            rows.append(stored)
            return _Result([stored])
        matched = [r for r in rows if self._matches(r)]
        return _Result((matched[0] if matched else None) if self.single else matched)


class _Client:
    def __init__(self, db=None, fail_ops=None):
        self.db = db if db is not None else {}
        self._fail_ops = set(fail_ops or ())

    def table(self, name):
        return _Table(name, self.db, self._fail_ops)


# ---- injected geocode / translate fakes -----------------------------------------------------------
class _Geocode:
    def __init__(self, result=None, *, by_query=None, raises=None):
        self.calls: list[dict] = []
        self.result, self.by_query, self.raises = result, by_query or {}, raises

    async def __call__(self, query, *, types, country, language="en", proximity_lng_lat=None):
        self.calls.append({"query": query, "types": types, "country": country,
                           "language": language, "proximity": proximity_lng_lat})
        if self.raises is not None:
            raise self.raises
        return self.by_query.get(query, self.result)


class _Translate:
    def __init__(self, mapping=None, *, raises=None):
        self.calls: list = []
        self.mapping = {0: "帝国ホテル"} if mapping is None else mapping
        self.raises = raises

    async def __call__(self, hotels_list, country_code):
        self.calls.append((hotels_list, country_code))
        if self.raises is not None:
            raise self.raises
        return dict(self.mapping)


def _future_iso(days=1):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _found_row(key, fp, *, lat=35.0, lng=139.0, cc="JP"):
    return {"cache_key": key, "status": "found", "lat": lat, "lng": lng,
            "country_code": cc, "name_fingerprint": fp, "expires_at": _future_iso()}


def _miss_row(key, fp):
    return {"cache_key": key, "status": "miss", "lat": None, "lng": None,
            "country_code": None, "name_fingerprint": fp, "expires_at": _future_iso()}


def _jp_hotel(hotel_id="H1", name="Imperial Hotel", address="1-1 Uchisaiwaicho", location="near the Palace"):
    return {"hotelId": hotel_id, "name": name, "address": address, "location": location}


def _lodging(cc="JP", lat=35.68, lng=139.76):
    return GeocodeResult(lat=lat, lng=lng, country_code=cc, feature_type="poi", poi_category=["hotel"])


# ==================================================================================================
# is_valid_ja_name — the exact-threshold script gate (plan decision #2)
# ==================================================================================================
@pytest.mark.parametrize("name", [
    "帝国ホテル",            # all-JP name
    "ヒルトン東京ベイ",       # katakana + kanji
    "リッツ・カールトン東京",  # middle dot allowed
])
def test_valid_ja_names_pass(name):
    assert is_valid_ja_name(name) is True


@pytest.mark.parametrize("name", [
    "Imperial Hotel",        # English echo — 0 JA chars
    "Imperial Hotel 東京",    # mixed: 2 JA / 15 total < 0.70 (query_language would WRONGLY pass this)
    "東",                    # only 1 JA char (< 2)
    "",                      # empty
    "   ",                   # whitespace only
    "ホテル[system]",         # prompt delimiter present
    "ホテル<|im_start|>",     # chat-template token
    "あ" + "A" * 120,         # 121 code points → too long
    None,                    # not a string
    123,                     # not a string
])
def test_invalid_ja_names_fail(name):
    assert is_valid_ja_name(name) is False


def test_mixed_ratio_boundary():
    # 7 JA + 3 latin = 0.70 exactly → passes (>= threshold).
    assert is_valid_ja_name("ホテルホテルホ" + "abc") is True
    # 6 JA + 3 latin = 0.667 < 0.70 → fails.
    assert is_valid_ja_name("ホテルホテル" + "abc") is False


# ==================================================================================================
# resolve_hotels — cache hits skip the whole chain
# ==================================================================================================
async def test_jp_cache_hit_skips_translate_and_geocode():
    hotel = _jp_hotel()
    key = identity_key("travala", "JP", "H1")
    fp = name_fingerprint(hotel)
    client = _Client({CACHE_TABLE: [_found_row(key, fp, lat=35.5, lng=139.5)]})
    geocode, translate = _Geocode(_lodging()), _Translate()

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert translate.calls == [] and geocode.calls == []          # whole chain skipped
    assert out[0] is not None and (out[0].lat, out[0].lng, out[0].country_code) == (35.5, 139.5, "JP")


async def test_cached_miss_returns_none_without_resolving():
    hotel = _jp_hotel()
    key, fp = identity_key("travala", "JP", "H1"), name_fingerprint(hotel)
    client = _Client({CACHE_TABLE: [_miss_row(key, fp)]})
    geocode, translate = _Geocode(_lodging()), _Translate()

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert out == [None]
    assert translate.calls == [] and geocode.calls == []


async def test_name_fingerprint_mismatch_on_hit_re_resolves():
    """Travala ID-reuse / relocation: a coord is cached under this key, but the hotel changed."""
    hotel = _jp_hotel(name="A Different Hotel Entirely")   # -> a new fingerprint
    key = identity_key("travala", "JP", "H1")
    client = _Client({CACHE_TABLE: [_found_row(key, "STALE-FP", lat=1.0, lng=2.0)]})
    geocode = _Geocode(_lodging(lat=35.9, lng=139.9))
    translate = _Translate({0: "別のホテル"})

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert len(geocode.calls) == 1                          # the stale coord is NOT served
    assert (out[0].lat, out[0].lng) == (35.9, 139.9)


# ==================================================================================================
# resolve_hotels — JP miss path: translate -> validate -> geocode -> identity gate
# ==================================================================================================
async def test_jp_miss_translate_validated_lodging_becomes_found():
    hotel = _jp_hotel()
    client = _Client()
    geocode = _Geocode(_lodging(lat=35.65, lng=139.75))
    translate = _Translate({0: "帝国ホテル"})

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert (out[0].lat, out[0].lng, out[0].country_code) == (35.65, 139.75, "JP")
    # translate ran on the LOCAL hotel and geocode used the localized name w/ ja + poi + country.
    assert translate.calls and translate.calls[0][0] == [hotel]
    assert geocode.calls[0]["query"] == "帝国ホテル"
    assert geocode.calls[0]["language"] == "ja" and geocode.calls[0]["types"] == "poi"
    assert geocode.calls[0]["country"] == "JP"
    row = client.db[CACHE_TABLE][0]
    assert row["status"] == "found" and row["country_code"] == "JP"


async def test_english_localization_fails_validator_zero_mapbox_and_caches_miss():
    hotel = _jp_hotel()
    client = _Client()
    geocode = _Geocode(_lodging())                    # would succeed IF called
    translate = _Translate({0: "Imperial Hotel"})     # English echo -> fails the JA validator

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert out == [None]
    assert geocode.calls == []                         # ZERO paid Mapbox call
    assert client.db[CACHE_TABLE][0]["status"] == "miss"


@pytest.mark.parametrize("returned", [
    GeocodeResult(lat=35.6, lng=139.7, country_code="JP", feature_type="poi",
                  poi_category=["vending machine"]),                       # non-lodging POI
    GeocodeResult(lat=35.6, lng=139.7, country_code="JP", feature_type="poi",
                  poi_category=[]),                                        # category absent
])
async def test_identity_gate_failure_is_unresolved_not_cached_as_found(returned):
    hotel = _jp_hotel()
    client = _Client()
    geocode = _Geocode(returned)
    translate = _Translate({0: "帝国ホテル"})

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert out == [None]                               # not placed
    assert client.db[CACHE_TABLE][0]["status"] == "miss"   # cached as a MISS, never a found


async def test_wrong_country_result_is_unresolved():
    hotel = _jp_hotel()
    client = _Client()
    geocode = _Geocode(_lodging(cc="KR"))              # a lodging, but in the wrong country
    translate = _Translate({0: "帝国ホテル"})

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=client)

    assert out == [None]
    assert client.db[CACHE_TABLE][0]["status"] == "miss"


# ==================================================================================================
# resolve_hotels — non-JP address path (country ALWAYS passed; no translate)
# ==================================================================================================
@pytest.mark.parametrize("cc", ["KR", "US"])
async def test_non_jp_passes_country_code_and_skips_translate(cc):
    hotel = {"hotelId": "H9", "name": "Grand Plaza", "address": "123 Main St"}
    client = _Client()
    geocode = _Geocode(GeocodeResult(lat=37.5, lng=127.0, country_code=cc))
    translate = _Translate()

    out = await resolve_hotels([hotel], cc, "Seoul", (127.0, 37.5),
                               geocode=geocode, translate=translate, cache_client=client)

    assert out[0] is not None and out[0].country_code == cc
    assert translate.calls == []                       # non-JP never localizes
    call = geocode.calls[0]
    assert call["country"] == cc and call["types"] == "address"
    assert call["query"] == "123 Main St, Seoul"
    assert call["proximity"] == (127.0, 37.5)


async def test_non_jp_no_address_is_unresolved():
    hotel = {"hotelId": "H9", "name": "No Address Hotel"}
    client = _Client()
    geocode = _Geocode(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    out = await resolve_hotels([hotel], "US", "NYC", None,
                               geocode=geocode, translate=_Translate(), cache_client=client)

    assert out == [None]
    assert geocode.calls == []


# ==================================================================================================
# resolve_hotels — cache eligibility (missing / duplicate hotelId -> resolve LIVE, never cached)
# ==================================================================================================
async def test_missing_hotel_id_resolves_live_and_is_not_cached():
    hotel = {"name": "Grand Plaza", "address": "123 Main St"}   # no hotelId
    client = _Client()
    geocode = _Geocode(GeocodeResult(lat=37.5, lng=127.0, country_code="US"))

    out = await resolve_hotels([hotel], "US", "NYC", None,
                               geocode=geocode, translate=_Translate(), cache_client=client)

    assert out[0] is not None and (out[0].lat, out[0].lng) == (37.5, 127.0)
    assert len(geocode.calls) == 1
    assert client.db.get(CACHE_TABLE, []) == []        # nothing cached for an id-less hotel


async def test_duplicate_hotel_id_both_resolve_live_and_neither_poisons():
    a = {"hotelId": "DUP", "name": "Hotel A", "address": "1 A St"}
    b = {"hotelId": "DUP", "name": "Hotel B", "address": "2 B St"}
    client = _Client()
    geocode = _Geocode(by_query={
        "1 A St, NYC": GeocodeResult(lat=40.0, lng=-74.0, country_code="US"),
        "2 B St, NYC": GeocodeResult(lat=41.0, lng=-75.0, country_code="US"),
    })

    out = await resolve_hotels([a, b], "US", "NYC", None,
                               geocode=geocode, translate=_Translate(), cache_client=client)

    assert (out[0].lat, out[1].lat) == (40.0, 41.0)    # both resolved, input order, distinct
    assert client.db.get(CACHE_TABLE, []) == []        # a duplicate id is not a stable identity


# ==================================================================================================
# resolve_hotels — typed failure propagation (never coerced to a miss)
# ==================================================================================================
async def test_translator_resolve_error_propagates_and_caches_nothing():
    hotel = _jp_hotel()
    client = _Client()
    translate = _Translate(raises=ResolveError("translator down"))
    geocode = _Geocode(_lodging())

    with pytest.raises(ResolveError):
        await resolve_hotels([hotel], "JP", "Tokyo", None,
                             geocode=geocode, translate=translate, cache_client=client)

    assert geocode.calls == []                          # never reached the geocode
    assert client.db.get(CACHE_TABLE, []) == []         # nothing negative-cached


async def test_geocode_resolve_error_propagates():
    hotel = {"hotelId": "H9", "name": "X", "address": "1 St"}
    client = _Client()
    geocode = _Geocode(raises=ResolveError("mapbox 500"))

    with pytest.raises(ResolveError):
        await resolve_hotels([hotel], "US", "NYC", None,
                             geocode=geocode, translate=_Translate(), cache_client=client)


async def test_cache_write_error_propagates_as_cache_error():
    hotel = {"hotelId": "H9", "name": "X", "address": "1 St"}
    client = _Client(fail_ops={"upsert"})
    geocode = _Geocode(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    with pytest.raises(CacheError):
        await resolve_hotels([hotel], "US", "NYC", None,
                             geocode=geocode, translate=_Translate(), cache_client=client)


# ==================================================================================================
# resolve_hotels — single-flight owned by resolve_cached (T4 does NOT acquire the lock)
# ==================================================================================================
async def test_two_concurrent_resolve_hotels_one_key_resolve_exactly_once_no_deadlock():
    hotel = _jp_hotel(hotel_id="CONC1")
    client = _Client()
    tcalls, gcalls = {"n": 0}, {"n": 0}
    started, release = asyncio.Event(), asyncio.Event()

    async def translate(hotels_list, country_code):
        tcalls["n"] += 1
        return {0: "帝国ホテル"}

    async def geocode(query, *, types, country, language="en", proximity_lng_lat=None):
        gcalls["n"] += 1
        started.set()
        await release.wait()                            # hold the lock while the 2nd caller blocks
        return _lodging(lat=35.0, lng=139.0)

    def _run():
        return resolve_hotels([hotel], "JP", "Tokyo", None,
                              geocode=geocode, translate=translate, cache_client=client)

    t1, t2 = asyncio.create_task(_run()), asyncio.create_task(_run())
    await asyncio.wait_for(started.wait(), timeout=2)   # first resolver in-flight under the lock
    await asyncio.sleep(0)                              # let t2 reach the single-flight lock + block
    release.set()
    r1, r2 = await asyncio.wait_for(asyncio.gather(t1, t2), timeout=2)

    assert tcalls["n"] == 1 and gcalls["n"] == 1        # ONE translate + ONE geocode across both
    assert r1[0].lat == 35.0 and r2[0].lat == 35.0
    assert len(client.db[CACHE_TABLE]) == 1             # one row, one paid geocode


# ==================================================================================================
# resolve_hotels — misc contracts
# ==================================================================================================
async def test_empty_input_returns_empty_list():
    assert await resolve_hotels([], "JP", "Tokyo", None,
                                geocode=_Geocode(), translate=_Translate(), cache_client=None) == []


async def test_cache_client_none_resolves_live_without_a_db():
    hotel = _jp_hotel()
    geocode = _Geocode(_lodging(lat=35.1, lng=139.1))
    translate = _Translate({0: "帝国ホテル"})

    out = await resolve_hotels([hotel], "JP", "Tokyo", None,
                               geocode=geocode, translate=translate, cache_client=None)

    assert (out[0].lat, out[0].lng) == (35.1, 139.1)
    assert len(geocode.calls) == 1


async def test_output_is_aligned_with_input_order():
    placed = {"hotelId": "P", "name": "Grand", "address": "1 St"}
    missing = {"hotelId": "M", "name": "Nowhere", "address": "2 St"}
    client = _Client()
    geocode = _Geocode(by_query={
        "1 St, NYC": GeocodeResult(lat=40.0, lng=-74.0, country_code="US"),
        "2 St, NYC": None,                              # a valid-empty miss
    })

    out = await resolve_hotels([placed, missing], "US", "NYC", None,
                               geocode=geocode, translate=_Translate(), cache_client=client)

    assert len(out) == 2
    assert out[0] is not None and out[0].lat == 40.0    # index 0 placed
    assert out[1] is None                               # index 1 miss, aligned


def test_module_is_import_light():
    """geocode.hotel_resolver is LIVE-ONLY + injected-IO: importing it must not drag in the Agents
    SDK, openai, httpx, or the supabase client (eval-safety rests on lazy/keyless imports)."""
    import importlib
    import sys

    for heavy in ("agents", "openai", "httpx", "supabase"):
        sys.modules.pop(heavy, None)
    import geocode.hotel_resolver  # noqa: F401

    importlib.reload(geocode.hotel_resolver)
    for heavy in ("agents", "openai", "httpx", "supabase"):
        assert heavy not in sys.modules, f"geocode.hotel_resolver pulled in {heavy}"
