"""Write-through coordinate→country cache: kill the warm-path Mapbox spend and the
quota-exempt billable loop.

`reverse_country` has exactly one call site (`_ground_place`) and every call sets
`permanent: "true"` — Mapbox's storable-results tier. Before this cache, a warm organize cost
EXACTLY as much as a cold one: the extraction-cache hit skips Apify+OpenAI but still re-grounds
every place, so re-organizing an already-organized Reel paid full price again. Worse, the daily
quota charges only on an extraction-cache MISS, so a warm re-organize loop ran the whole
grounding loop bounded only by `BURST_LIMIT` — permanent geocodes outside the daily limit.

This does NOT weaken guardrail #1. The only thing a hit skips is re-asking Mapbox the same
deterministic question: `reverse(lat,lng) → country` is a pure function of coordinates frozen by
`EXTRACTOR_VERSION` in the extraction cache. The load-bearing comparison —
`country.country_code != place.country_code → reject` — still runs on EVERY organize, on the
cached answer as much as on a live one (pinned by
`test_cached_country_still_rejects_a_research_mismatch`).
"""
from __future__ import annotations

import pytest

from models.geocode import CountryResult
from organizer import (
    GEOCODE_CACHE_TABLE,
    LOCATION_VERIFICATION_VERSION,
    _coord_cache_key,
    _ground_place,
    run_organize_job,
)
from test_saved_reels_organize import _Client, _Table, _place


@pytest.fixture(autouse=True)
def _mapbox_token(monkeypatch):
    """`_ground_place` refuses to run without a token — even on a cache hit, on purpose."""
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")


class _CountingVerifier:
    """A `verify_country` stub that counts provider calls — the whole point of this module.

    Every assertion about cost in here is an assertion about `.calls`.
    """

    def __init__(self, country=CountryResult(country_code="JP", country_name="Japan")):
        self.country, self.calls, self.coords = country, 0, []

    async def __call__(self, lat, lng, *, token):
        self.calls += 1
        self.coords.append((lat, lng))
        return self.country


class _FaultTable(_Table):
    """Raise on the injected operation; behave normally otherwise."""

    def __init__(self, name, db, failing_ops):
        super().__init__(name, db)
        self._failing_ops = failing_ops

    async def execute(self):
        op = self.op[0] if isinstance(self.op, tuple) else self.op
        if op in self._failing_ops:
            raise RuntimeError(f"supabase {op} failed")
        return await super().execute()


class _FaultClient(_Client):
    """`_Client` that fails one operation against one table, to separate the read side's
    blip tolerance (a failed read is a MISS) from the write side's strictness (a failed
    write fails the item)."""

    def __init__(self, db=None):
        super().__init__(db)
        self._failing = {}

    def fail_on_select(self, table):
        self._failing.setdefault(table, set()).add("select")
        return self

    def fail_on_upsert(self, table):
        self._failing.setdefault(table, set()).add("upsert")
        return self

    def table(self, name):
        failing_ops = self._failing.get(name)
        return _FaultTable(name, self.db, failing_ops) if failing_ops else super().table(name)


def _cache_rows(client):
    return client.db.get(GEOCODE_CACHE_TABLE, [])


def _tokyo(lat=35.6586, lng=139.7454):
    return _place().model_copy(update={"lat": lat, "lng": lng})


def test_coord_cache_key_is_lossless_and_normalizes_negative_zero():
    """Two coordinates ~11 m apart are DIFFERENT questions and must get different keys.

    This is the test that dies if anyone reintroduces `round(lat * 1e4)` bucketing: two points
    on opposite sides of a border can share an 11 m cell, and if the cached country happens to
    match the extractor's CLAIMED country, `_ground_place`'s fail-closed comparison passes for
    a coordinate Mapbox never verified. Rounding also buys zero hit rate — the warm path hits
    on byte-identical coordinates replayed from the frozen extraction cache.
    """
    assert _coord_cache_key(35.6586, 139.7454) != _coord_cache_key(35.65861, 139.74543)
    assert _coord_cache_key(-0.0, -0.0) == _coord_cache_key(0.0, 0.0)
    assert _coord_cache_key(35.6586, 139.7454) == _coord_cache_key(35.6586, 139.7454)


def test_coord_cache_key_round_trips_every_coordinate_exactly():
    """Lossless means the key is a faithful record of the coordinate Mapbox was asked about,
    for every float — including the long decimal expansions an extractor emits."""
    for lat, lng in [(35.6586, 139.7454), (-33.8688, 151.2093), (0.0, 0.0),
                     (1 / 3, -2 / 7), (90.0, -180.0)]:
        recovered = tuple(float(part) for part in _coord_cache_key(lat, lng).split(","))
        assert recovered == (lat, lng)


async def test_second_ground_of_same_coordinate_skips_provider():
    """THE cost fix: the warm path makes ZERO billable permanent-geocode calls."""
    client = _Client({})
    verify = _CountingVerifier()
    place = _tokyo()

    assert await _ground_place(client, place, verify_country=verify) is not None
    assert await _ground_place(client, place, verify_country=verify) is not None

    assert verify.calls == 1
    assert len(_cache_rows(client)) == 1


async def test_cache_write_records_the_lossless_key_and_current_version():
    client = _Client({})

    await _ground_place(client, _tokyo(), verify_country=_CountingVerifier())

    assert _cache_rows(client)[0] | {
        "coord_key": _coord_cache_key(35.6586, 139.7454),
        "verification_version": LOCATION_VERIFICATION_VERSION,
        "country_code": "JP",
        "country_name": "Japan",
    } == _cache_rows(client)[0]


async def test_neighbouring_coordinate_does_not_hit_the_cache():
    """~11 m away is a different question, and may be a different country."""
    client = _Client({})
    verify = _CountingVerifier()

    await _ground_place(client, _tokyo(35.6586, 139.7454), verify_country=verify)
    await _ground_place(client, _tokyo(35.65861, 139.74543), verify_country=verify)

    assert verify.calls == 2
    assert len(_cache_rows(client)) == 2


async def test_cached_country_still_rejects_a_research_mismatch():
    """Guardrail #1 is untouched: the country comparison runs on a HIT exactly as on a miss.

    The cache answers "what country is this coordinate in"; it never answers "is this place
    trustworthy". Delete the comparison and this goes red on the second call, where no provider
    runs at all — i.e. the cached path is not a way around the check.
    """
    client = _Client({})
    verify = _CountingVerifier()
    await _ground_place(client, _tokyo(), verify_country=verify)

    liar = _tokyo().model_copy(update={"country_code": "MX", "country_name": "Mexico"})

    assert await _ground_place(client, liar, verify_country=verify) is None
    assert verify.calls == 1


async def test_stale_verification_version_rows_are_ignored():
    """Bump-to-invalidate: rows written under an older verification contract are a MISS.

    This is the invalidation mechanism (there is deliberately no TTL) — the same lever that
    invalidates `reel_place_mentions`, so the cache and the evidence it justified can never
    disagree about which contract they were written under.
    """
    client = _Client({GEOCODE_CACHE_TABLE: [{
        "coord_key": _coord_cache_key(35.6586, 139.7454),
        "verification_version": "mapbox-country-v0",
        "country_code": "MX", "country_name": "Mexico",
    }]})
    verify = _CountingVerifier()

    result = await _ground_place(client, _tokyo(), verify_country=verify)

    assert verify.calls == 1
    assert result["country_code"] == "JP"


async def test_provider_failure_is_never_cached():
    """A failure is not an answer. Caching one would freeze a brownout into every later run."""
    client = _Client({})

    async def verify(_lat, _lng, *, token):
        raise RuntimeError("Mapbox reverse-country failed: status 500")

    with pytest.raises(RuntimeError, match="reverse-country"):
        await _ground_place(client, _tokyo(), verify_country=verify)

    assert _cache_rows(client) == []


async def test_empty_provider_result_is_never_cached():
    """`None` is "this coordinate does not verify", not a country. Caching it would make one
    soft rejection permanent for that coordinate."""
    client = _Client({})

    async def verify(_lat, _lng, *, token):
        return None

    assert await _ground_place(client, _tokyo(), verify_country=verify) is None
    assert _cache_rows(client) == []


async def test_cache_lookup_blip_falls_through_to_provider():
    """The READ side is blip-tolerant: a failed select is a MISS, never an item failure.

    Same asymmetry the extraction cache has — a cache is an optimization on the way in and a
    durability guarantee on the way out.
    """
    client = _FaultClient({}).fail_on_select(GEOCODE_CACHE_TABLE)
    verify = _CountingVerifier()

    result = await _ground_place(client, _tokyo(), verify_country=verify)

    assert result is not None and result["country_code"] == "JP"
    assert verify.calls == 1


async def test_cache_write_failure_fails_the_item():
    """Strict write-through (#7): we never hand back a verified result we failed to persist.

    Matches `cache_places` in `_process_item`, which is likewise unwrapped — an extraction-cache
    write failure already propagates and fails the item today. Guardrail #3 bounds the blast
    radius: one item fails, it is retryable, and the retry reuses the extraction cache.
    """
    client = _FaultClient({}).fail_on_upsert(GEOCODE_CACHE_TABLE)

    with pytest.raises(RuntimeError, match="upsert failed"):
        await _ground_place(client, _tokyo(), verify_country=_CountingVerifier())


async def test_incomplete_research_is_rejected_before_any_cache_read():
    """The completeness checks stay in front of the cache, so an incomplete place costs
    neither a provider call nor a lookup."""
    client = _FaultClient({}).fail_on_select(GEOCODE_CACHE_TABLE).fail_on_upsert(GEOCODE_CACHE_TABLE)
    verify = _CountingVerifier()

    assert await _ground_place(client, _tokyo().model_copy(update={"lat": None}),
                               verify_country=verify) is None
    assert verify.calls == 0


async def test_default_ground_binds_the_jobs_client(monkeypatch):
    """Guards the WIRING, not the cache. `run_organize_job`'s default `ground` must bind the
    job's client so `_ground_place` can reach the cache at all; drop the binding and the
    grounding call loses its only route to Supabase."""
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{"id": "item-1", "job_id": "job-1", "user_id": "user-a",
                                "saved_reel_id": "reel-1", "status": "queued"}],
        "saved_reels": [{"id": "reel-1", "user_id": "user-a",
                         "normalized_url": "https://www.instagram.com/reel/abc123/",
                         "reel_cache_id": "cache-1"}],
    })
    seen = []

    async def fake_ground_place(got_client, place, **_kwargs):
        seen.append(got_client)
        return None

    monkeypatch.setattr("organizer._ground_place", fake_ground_place)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_a, **_k: [_place()])

    await run_organize_job("job-1", "user-a", client=client)

    assert seen == [client]
