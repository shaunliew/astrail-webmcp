"""Tests for the hotel-geocode cache primitive (T3, plan decision #4/#6/#7/#8).

Offline + credential-free: a FAKE in-memory Supabase client (no real DB, no network) that honestly
stores rows on upsert and filters them on read, so these tests exercise the REAL read/write/single-flight
behaviour rather than asserting call patterns against a mock. The whole module is LIVE-ONLY in production
(never imported by the offline eval), but every primitive here is deterministic and client-injectable, so
it is fully testable offline.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from geocode.cache import (
    CACHE_TABLE,
    STRATEGY_VERSION,
    CacheRow,
    identity_key,
    lookup_many,
    resolve_cached,
)
from geocode.errors import CacheError, ResolveError
from models.geocode import GeocodeResult


# --------------------------------------------------------------------------------------------------
# A small, honest in-memory fake of the supabase-py v2 query chain the cache calls. It really stores
# rows on upsert and really filters them on eq/in/gt, so a "hit" means a row was actually persisted
# and matched — not that a method was called.
# --------------------------------------------------------------------------------------------------
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
        self.op = "upsert"
        self.row = row
        self.on_conflict = on_conflict
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
        # Postgres `NULL > v` is NULL (row does NOT match) — mirror that, don't invent a default.
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
            if not keys:
                raise ValueError("fake upsert requires on_conflict (Postgres needs a unique index)")
            existing = next(
                (r for r in rows if all(r.get(k) == self.row.get(k) for k in keys)), None
            )
            if existing is not None:
                existing.update(self.row)
                return _Result([existing])
            stored = {"id": f"{self.name}-{len(rows) + 1}", **self.row}
            rows.append(stored)
            return _Result([stored])
        matched = [r for r in rows if self._matches(r)]
        if self.single:
            return _Result(matched[0] if matched else None)
        return _Result(matched)


class _Client:
    def __init__(self, db=None, fail_ops=None):
        self.db = db if db is not None else {}
        self._fail_ops = set(fail_ops or ())

    def table(self, name):
        return _Table(name, self.db, self._fail_ops)


class _CountingResolver:
    """The whole-miss unit T4 injects, stubbed: returns a fixed outcome and counts calls."""

    def __init__(self, result):
        self.result, self.calls = result, 0

    async def __call__(self):
        self.calls += 1
        return self.result


class _RaisingResolver:
    def __init__(self, exc):
        self.exc, self.calls = exc, 0

    async def __call__(self):
        self.calls += 1
        raise self.exc


def _future_iso(days=1):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def _found_row(key, fp, *, lat=35.0, lng=139.0, cc="JP", expires=None):
    return {
        "cache_key": key, "status": "found",
        "lat": lat, "lng": lng, "country_code": cc,
        "name_fingerprint": fp, "expires_at": expires or _future_iso(),
    }


def _miss_row(key, fp, *, expires=None):
    return {
        "cache_key": key, "status": "miss",
        "lat": None, "lng": None, "country_code": None,
        "name_fingerprint": fp, "expires_at": expires or _future_iso(),
    }


# ---- identity_key ---------------------------------------------------------------------------------
def test_identity_key_is_deterministic_and_version_prefixed():
    a = identity_key("travala", "JP", "H123")
    b = identity_key("travala", "JP", "H123")
    assert a == b
    assert a.startswith(f"{STRATEGY_VERSION}:")
    # A different hotelId is a different identity.
    assert a != identity_key("travala", "JP", "H999")


def test_identity_key_requires_non_empty_hotel_id():
    for bad in (None, "", "   "):
        with pytest.raises(ValueError):
            identity_key("travala", "JP", bad)


def test_identity_key_normalizes_nfkc_and_casefold():
    # Case-insensitive: an uppercased id maps to the same identity (casefold).
    assert identity_key("travala", "JP", "abc") == identity_key("travala", "JP", "ABC")
    # NFKC folds compatibility forms: the fullwidth digits ("１２３") normalize to ASCII "123".
    assert identity_key("travala", "JP", "123") == identity_key("travala", "JP", "１２３")
    # Country is part of the identity — same hotelId in a different country is a different key.
    assert identity_key("travala", "JP", "abc") != identity_key("travala", "KR", "abc")


def test_identity_key_version_bump_invalidates(monkeypatch):
    """Bumping STRATEGY_VERSION invalidates every key en masse (mirrors verification_version)."""
    import geocode.cache as cache

    before = identity_key("travala", "JP", "H1")
    monkeypatch.setattr(cache, "STRATEGY_VERSION", "hotel-geocode-vNEXT")
    after = identity_key("travala", "JP", "H1")
    assert before != after
    assert after.startswith("hotel-geocode-vNEXT:")


# ---- CacheRow strict re-validation ----------------------------------------------------------------
def test_cache_row_accepts_a_well_formed_found_and_miss():
    found = CacheRow.model_validate(_found_row("k", "fp"))
    assert (found.status, found.lat, found.lng, found.country_code) == ("found", 35.0, 139.0, "JP")
    miss = CacheRow.model_validate(_miss_row("k", "fp"))
    assert miss.status == "miss" and miss.lat is None and miss.country_code is None


def test_cache_row_rejects_found_missing_coords_or_country():
    for bad in (
        {**_found_row("k", "fp"), "lat": None},
        {**_found_row("k", "fp"), "lng": None},
        {**_found_row("k", "fp"), "country_code": None},
    ):
        with pytest.raises(ValidationError):
            CacheRow.model_validate(bad)


def test_cache_row_rejects_miss_carrying_coords():
    with pytest.raises(ValidationError):
        CacheRow.model_validate({**_miss_row("k", "fp"), "lat": 1.0, "country_code": "JP"})


def test_cache_row_uppercases_and_validates_country_code():
    assert CacheRow.model_validate(_found_row("k", "fp", cc="jp")).country_code == "JP"
    with pytest.raises(ValidationError):
        CacheRow.model_validate(_found_row("k", "fp", cc="JPN"))


# ---- lookup_many (lock-free bulk read) ------------------------------------------------------------
async def test_lookup_many_returns_validated_hits_and_misses():
    client = _Client({CACHE_TABLE: [
        _found_row("k-found", "fp1"),
        _miss_row("k-miss", "fp2"),
        _found_row("k-expired", "fp3", expires=_future_iso(days=-1)),   # expired -> filtered out
        {**_found_row("k-bad", "fp4"), "lat": None},                    # malformed -> read-miss
    ]})
    out = await lookup_many(client, ["k-found", "k-miss", "k-expired", "k-bad", "k-absent"])

    assert isinstance(out["k-found"], CacheRow) and out["k-found"].name_fingerprint == "fp1"
    assert isinstance(out["k-miss"], CacheRow) and out["k-miss"].status == "miss"
    assert out["k-expired"] is None
    assert out["k-bad"] is None
    assert out["k-absent"] is None


async def test_lookup_many_read_failure_returns_all_misses_without_raising():
    client = _Client({}, fail_ops={"select"})
    out = await lookup_many(client, ["a", "b"])
    assert out == {"a": None, "b": None}


# ---- resolve_cached: hits ------------------------------------------------------------------------
async def test_hit_skips_resolver():
    client = _Client({CACHE_TABLE: [_found_row("k", "fp")]})
    resolver = _CountingResolver(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 0
    assert isinstance(result, GeocodeResult)
    assert (result.lat, result.lng, result.country_code) == (35.0, 139.0, "JP")


async def test_cached_miss_returns_none_without_resolver():
    client = _Client({CACHE_TABLE: [_miss_row("k", "fp")]})
    resolver = _CountingResolver(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert result is None
    assert resolver.calls == 0


async def test_malformed_cached_row_is_a_read_miss():
    """A row that fails CacheRow re-validation is re-resolved, never trusted and never raised on."""
    client = _Client({CACHE_TABLE: [{**_found_row("k", "fp"), "lat": None}]})   # found w/o coords
    resolver = _CountingResolver(GeocodeResult(lat=9.0, lng=8.0, country_code="JP"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 1
    assert (result.lat, result.lng) == (9.0, 8.0)


async def test_name_fingerprint_mismatch_re_resolves():
    """Travala ID-reuse / relocation: the coord is cached under the same key but the hotel changed."""
    client = _Client({CACHE_TABLE: [_found_row("k", "OLD")]})
    resolver = _CountingResolver(GeocodeResult(lat=9.0, lng=8.0, country_code="JP"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="NEW")

    assert resolver.calls == 1                       # the stale coord is NOT served
    assert (result.lat, result.lng) == (9.0, 8.0)


async def test_miss_row_fingerprint_mismatch_re_resolves():
    """A stale cached MISS whose fingerprint no longer matches is a READ-MISS, not a served miss:
    Travala ID-reuse / relocation must RE-RESOLVE, never serve the old negative-cached None."""
    client = _Client({CACHE_TABLE: [_miss_row("k", "OLD")]})
    resolver = _CountingResolver(GeocodeResult(lat=9.0, lng=8.0, country_code="JP"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="NEW")

    assert resolver.calls == 1                       # the stale miss is NOT served
    assert (result.lat, result.lng) == (9.0, 8.0)


# ---- resolve_cached: writes + TTL -----------------------------------------------------------------
async def test_found_write_uses_hit_ttl_and_carries_the_fingerprint():
    client = _Client()
    resolver = _CountingResolver(GeocodeResult(lat=35.0, lng=139.0, country_code="jp"))

    before = datetime.now(timezone.utc)
    await resolve_cached(client, "k", resolver, expected_fingerprint="fp")
    after = datetime.now(timezone.utc)

    row = client.db[CACHE_TABLE][0]
    assert row["status"] == "found"
    assert row["country_code"] == "JP"               # uppercased to satisfy the DB CHECK
    assert row["name_fingerprint"] == "fp"
    exp = datetime.fromisoformat(row["expires_at"])
    assert before + timedelta(days=365) <= exp <= after + timedelta(days=365)


async def test_miss_write_uses_miss_ttl_and_stores_all_none():
    client = _Client()
    resolver = _CountingResolver(None)               # valid-empty / unconfirmed -> cacheable miss

    before = datetime.now(timezone.utc)
    result = await resolve_cached(client, "k", resolver, expected_fingerprint="fp")
    after = datetime.now(timezone.utc)

    assert result is None
    row = client.db[CACHE_TABLE][0]
    assert row["status"] == "miss"
    assert row["lat"] is None and row["lng"] is None and row["country_code"] is None
    exp = datetime.fromisoformat(row["expires_at"])
    assert before + timedelta(days=14) <= exp <= after + timedelta(days=14)


async def test_custom_ttls_are_honoured():
    client = _Client()
    before = datetime.now(timezone.utc)
    await resolve_cached(
        client, "k", _CountingResolver(GeocodeResult(lat=1.0, lng=2.0, country_code="US")),
        expected_fingerprint="fp", hit_ttl_days=7,
    )
    after = datetime.now(timezone.utc)
    exp = datetime.fromisoformat(client.db[CACHE_TABLE][0]["expires_at"])
    assert before + timedelta(days=7) <= exp <= after + timedelta(days=7)


# ---- resolve_cached: client=None (cache disabled) -------------------------------------------------
async def test_client_none_always_resolves_and_touches_no_db():
    resolver = _CountingResolver(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    result = await resolve_cached(None, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 1
    assert (result.lat, result.lng) == (1.0, 2.0)


# ---- resolve_cached: read/write failure asymmetry -------------------------------------------------
async def test_write_failure_raises_cache_error():
    """Write-through durability (Guardrail #7): a failed persist is loud, not silently dropped."""
    client = _Client({}, fail_ops={"upsert"})
    resolver = _CountingResolver(GeocodeResult(lat=1.0, lng=2.0, country_code="US"))

    with pytest.raises(CacheError):
        await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 1                        # the failure is on WRITE, after resolving


async def test_read_failure_falls_through_to_resolver_not_raised():
    """The read side is blip-tolerant (mirrors grounding): a failed select is a MISS, never a raise."""
    client = _Client({}, fail_ops={"select"})         # reads fail, writes succeed
    resolver = _CountingResolver(GeocodeResult(lat=5.0, lng=6.0, country_code="JP"))

    result = await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 1
    assert (result.lat, result.lng) == (5.0, 6.0)
    assert len(client.db[CACHE_TABLE]) == 1           # resolved value still written through


async def test_resolver_error_propagates_and_writes_nothing():
    """A ResolveError (infra failure) is NOT cached and NOT a miss — it propagates untouched."""
    client = _Client()
    resolver = _RaisingResolver(ResolveError("translator down"))

    with pytest.raises(ResolveError):
        await resolve_cached(client, "k", resolver, expected_fingerprint="fp")

    assert resolver.calls == 1
    assert client.db.get(CACHE_TABLE, []) == []       # nothing negative-cached


# ---- resolve_cached: single-flight ----------------------------------------------------------------
async def test_two_concurrent_same_key_calls_resolve_exactly_once():
    """Single-flight: two concurrent callers of ONE key pay for exactly ONE resolve (Codex #7)."""
    client = _Client()
    calls = 0
    started = asyncio.Event()
    release = asyncio.Event()

    async def resolver():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return GeocodeResult(lat=35.0, lng=139.0, country_code="JP")

    t1 = asyncio.create_task(resolve_cached(client, "k", resolver, expected_fingerprint="fp"))
    t2 = asyncio.create_task(resolve_cached(client, "k", resolver, expected_fingerprint="fp"))
    await asyncio.wait_for(started.wait(), timeout=2)   # first resolver in-flight, holding the lock
    await asyncio.sleep(0)                              # let t2 reach the lock and block on it
    release.set()
    r1, r2 = await asyncio.wait_for(asyncio.gather(t1, t2), timeout=2)

    assert calls == 1                                  # the second caller reused the just-written row
    assert (r1.lat, r1.lng) == (35.0, 139.0)
    assert (r2.lat, r2.lng) == (35.0, 139.0)
    assert len(client.db[CACHE_TABLE]) == 1            # one row, one paid geocode


async def test_distinct_keys_do_not_share_a_lock():
    """Different keys resolve concurrently — a per-key lock, not a global one (would else deadlock)."""
    client = _Client()
    counter = {"n": 0}
    both_started = asyncio.Event()

    def make_resolver(lat):
        async def resolver():
            counter["n"] += 1
            if counter["n"] == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=2)   # needs BOTH to have started
            return GeocodeResult(lat=lat, lng=139.0, country_code="JP")
        return resolver

    ra, rb = await asyncio.wait_for(asyncio.gather(
        resolve_cached(client, "key-A", make_resolver(35.0), expected_fingerprint="fp"),
        resolve_cached(client, "key-B", make_resolver(36.0), expected_fingerprint="fp"),
    ), timeout=2)

    assert (ra.lat, rb.lat) == (35.0, 36.0)


# ---- import safety --------------------------------------------------------------------------------
def test_module_is_import_light():
    """geocode.cache is cache-opt-in and LIVE-ONLY: importing it must not drag in the Agents SDK,
    openai, httpx, or the supabase client (eval-safety rests on lazy/keyless imports)."""
    import importlib

    for heavy in ("agents", "openai", "httpx", "supabase"):
        sys.modules.pop(heavy, None)
    import geocode.cache  # noqa: F401

    importlib.reload(geocode.cache)
    for heavy in ("agents", "openai", "httpx", "supabase"):
        assert heavy not in sys.modules, f"geocode.cache pulled in {heavy}"
