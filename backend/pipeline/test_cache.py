"""Extraction-cache unit tests. Offline: an in-memory fake client with select/eq/upsert. No network,
no key. Covers hit / miss / version-mismatch / non-reel-URL / round-trip / 0-place caching, plus the
re-hosted-cover wiring (Task 4).

DI property (why the `.storage`-less fake client stays valid): `cache_places` only calls the injected
`rehost` when the reel carries a truthy `display_url`. The `_Reel` fixture defines no `display_url`, so
every EXISTING test skips the cover branch entirely — `rehost` (and thus `client.storage`, which this
fake never implements) is never touched. The cover tests inject a fake `rehost`, so they never hit
`.storage` either."""
import os

import pytest

from models.place import PlaceResult
from pipeline.cache import cache_places, get_cached_places
from scrape.reel_url import short_code_of

_REEL = "https://www.instagram.com/reel/ABC123/"
_KEY = "https://www.instagram.com/reel/ABC123"   # normalized (no trailing slash)


class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, name, db, upserts=None):
        self.name, self.db, self._op, self._f, self._conflict = name, db, None, {}, None
        self._upserts = upserts   # shared list; records each upserted payload for shape assertions

    def select(self, *_): self._op = ("select", None); return self

    def upsert(self, row, on_conflict=None):
        self._op = ("upsert", row); self._conflict = on_conflict
        if self._upserts is not None:
            self._upserts.append(row)
        return self

    def eq(self, c, v): self._f[c] = v; return self

    async def execute(self):
        rows = self.db.setdefault(self.name, [])
        op, arg = self._op
        if op == "select":
            return _Result([r for r in rows if all(r.get(k) == v for k, v in self._f.items())])
        # upsert on the conflict key: update in place, else insert
        match = [r for r in rows if r.get(self._conflict) == arg.get(self._conflict)]
        if match:
            match[0].update(arg)
        else:
            rows.append({"id": f"{self.name}-{len(rows) + 1}", **arg})
        return _Result([arg])


class _Client:
    def __init__(self, db=None): self.db = db if db is not None else {}; self.upserts = []
    def table(self, name): return _Table(name, self.db, self.upserts)


class _Reel:
    def __init__(self): self.caption = "cap"; self.location_name = "Tokyo"; self.transcript = None


def _place(name="Tokyo Tower"):
    return PlaceResult(name=name, category="attraction", confidence=0.9, evidence_quote=f"📍{name}",
                       lat=35.6586, lng=139.7454, source_type="reel_extracted")


@pytest.mark.asyncio
async def test_cache_miss_empty_returns_none():
    c = _Client()
    assert await get_cached_places(c, _REEL, "v1") is None


@pytest.mark.asyncio
async def test_cache_round_trip_hit():
    c = _Client()
    await cache_places(c, _REEL, _Reel(), [_place("Tokyo Tower"), _place("Senso-ji")], "v1")
    row = c.db["reel_cache"][0]
    assert row["normalized_url"] == _KEY and row["extractor_version"] == "v1"
    assert row["caption"] == "cap" and len(row["extracted_places"]) == 2
    hit = await get_cached_places(c, _REEL, "v1")
    assert hit is not None and [p.name for p in hit] == ["Tokyo Tower", "Senso-ji"]
    assert hit[0].lat == 35.6586 and isinstance(hit[0], PlaceResult)


@pytest.mark.asyncio
async def test_cache_round_trip_for_a_post_url():
    """Carousel `/p/` posts cache "for free" once the URL choke point widened (T1): both
    `cache_places` and `get_cached_places` normalize the `/p/` URL to a canonical key and round-trip
    it exactly like a reel. Pre-T1 both silently no-oped on `/p/` (normalize raised), so this test
    REDDENS if `_PATH_RE` is narrowed back to reels-only — the load-bearing proof of the widening."""
    post = "https://www.instagram.com/p/DQwdZ8ZCWZx/"
    post_key = "https://www.instagram.com/p/DQwdZ8ZCWZx"   # normalized (no trailing slash)
    c = _Client()
    await cache_places(c, post, _Reel(), [_place("Shibuya Sky")], "v1")
    row = c.db["reel_cache"][0]
    assert row["normalized_url"] == post_key and row["extractor_version"] == "v1"
    hit = await get_cached_places(c, post, "v1")
    assert hit is not None and [p.name for p in hit] == ["Shibuya Sky"]


@pytest.mark.asyncio
async def test_cache_version_mismatch_is_miss():
    c = _Client()
    await cache_places(c, _REEL, _Reel(), [_place()], "v1")
    assert await get_cached_places(c, _REEL, "v2") is None   # different version -> miss


@pytest.mark.asyncio
async def test_cache_upsert_overwrites_same_url():
    c = _Client()
    await cache_places(c, _REEL, _Reel(), [_place("Old")], "v1")
    await cache_places(c, _REEL, _Reel(), [_place("New")], "v2")   # same URL, new version
    assert len(c.db["reel_cache"]) == 1                            # upserted, not duplicated
    assert (await get_cached_places(c, _REEL, "v2"))[0].name == "New"


@pytest.mark.asyncio
async def test_cache_non_reel_url_uncacheable():
    c = _Client()
    assert await get_cached_places(c, "https://ig/r1", "v1") is None   # not a reel URL -> None
    await cache_places(c, "https://ig/r1", _Reel(), [_place()], "v1")  # no-op, no write
    assert c.db.get("reel_cache") is None


@pytest.mark.asyncio
async def test_cache_zero_places_is_cached_as_hit():
    c = _Client()
    await cache_places(c, _REEL, _Reel(), [], "v1")     # a dry reel is cached (avoid re-extract)
    hit = await get_cached_places(c, _REEL, "v1")
    assert hit == []                                     # HIT with 0 places (not None)


@pytest.mark.asyncio
async def test_cache_oversized_payload_is_a_miss():
    c = _Client({
        "reel_cache": [{
            "normalized_url": _KEY,
            "extractor_version": "v1",
            "extracted_places": [_place(f"Place {index}").model_dump() for index in range(11)],
        }],
    })

    assert await get_cached_places(c, _REEL, "v1") is None


@pytest.mark.asyncio
async def test_cache_malformed_payload_is_a_miss():
    c = _Client({
        "reel_cache": [{
            "normalized_url": _KEY,
            "extractor_version": "v1",
            "extracted_places": [{"name": "Missing required fields"}],
        }],
    })

    assert await get_cached_places(c, _REEL, "v1") is None


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    import pipeline.cache as m
    importlib.reload(m)
    assert m.EXTRACTION_CACHE_TABLE == "reel_cache"


# --- Task 4: re-hosted cover wiring ---------------------------------------------------------------

_COVER = "https://scontent.cdninstagram.com/v/t51/cover.jpg"


class _CoverRehost:
    """Records the args `cache_places` passes to the injected `rehost`, returns a fixed result."""
    def __init__(self, result):
        self.result, self.calls = result, []

    async def __call__(self, client, display_url, cover_key):
        self.calls.append((client, display_url, cover_key))
        return self.result


@pytest.mark.asyncio
async def test_cache_writes_rehosted_cover_and_pointer():
    c = _Client()
    reel = _Reel()
    reel.display_url = _COVER
    rehost = _CoverRehost("https://storage.example/reel-covers/x.jpg")

    await cache_places(c, _REEL, reel, [_place()], "v1", rehost=rehost)

    payload = c.upserts[-1]
    assert payload["thumbnail_url"] == "https://storage.example/reel-covers/x.jpg"
    assert payload["raw_payload"] == {"display_url": _COVER}          # durable repair pointer
    # cover key is derived from the VALIDATED normalized URL, and the raw display_url is forwarded
    assert rehost.calls == [(c, _COVER, short_code_of(_KEY))]
    assert short_code_of(_KEY) == "ABC123"


@pytest.mark.asyncio
async def test_cache_omits_thumbnail_when_rehost_fails():
    c = _Client()
    reel = _Reel()
    reel.display_url = _COVER
    rehost = _CoverRehost(None)                                       # cover download/upload failed

    await cache_places(c, _REEL, reel, [_place()], "v1", rehost=rehost)

    payload = c.upserts[-1]
    assert "thumbnail_url" not in payload            # OMIT on failure => a re-cache never nulls a prior value
    assert payload["raw_payload"] == {"display_url": _COVER}          # pointer still persisted
    assert rehost.calls[0][1] == _COVER


@pytest.mark.asyncio
async def test_cache_cover_key_is_validated_not_apify_short_code():
    c = _Client()
    reel = _Reel()
    reel.short_code = "../evil"                       # attacker-controlled Apify field — must NOT be the key
    reel.display_url = _COVER
    rehost = _CoverRehost("https://storage.example/reel-covers/x.jpg")

    await cache_places(c, _REEL, reel, [_place()], "v1", rehost=rehost)

    cover_key = rehost.calls[0][2]
    assert cover_key == short_code_of(_KEY) == "ABC123"   # URL-derived, NOT "../evil"
    assert ".." not in cover_key and "/" not in cover_key  # path-traversal guard is load-bearing


@pytest.mark.integration
@pytest.mark.skipif(
    os.environ.get("RUN_DB_INTEGRATION") != "1",
    reason="dev-DB round-trip: set RUN_DB_INTEGRATION=1 (+ SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) to run against dev Supabase",
)
async def test_cache_upsert_omit_preserves_thumbnail_on_dev_db():
    """Proves the real PostgREST 'omit-preserves-value' semantics the offline fake only mimics: an upsert
    that OMITS thumbnail_url must not null a previously-written value (§9 item 1, Codex-verified). Gated —
    skipped by default so CI spends no credits and needs no live DB. Lazy imports keep supabase out of the
    unit-test collection graph."""
    from uuid import uuid4

    from supabase import acreate_client

    key = f"https://www.instagram.com/reel/{uuid4().hex[:11]}"
    client = await acreate_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    table = client.table("reel_cache")
    try:
        # 1) seed a row WITH a non-NULL thumbnail_url
        await table.upsert(
            {"normalized_url": key, "source_platform": "instagram",
             "thumbnail_url": "https://storage.example/reel-covers/seed.jpg"},
            on_conflict="normalized_url",
        ).execute()
        # 2) re-cache the SAME normalized_url WITHOUT thumbnail_url (mirrors a cover-less re-scrape)
        await table.upsert(
            {"normalized_url": key, "source_platform": "instagram", "caption": "re-cached"},
            on_conflict="normalized_url",
        ).execute()
        # 3) the earlier value must survive
        rows = (await table.select("thumbnail_url,caption").eq("normalized_url", key).execute()).data
        assert rows and rows[0]["thumbnail_url"] == "https://storage.example/reel-covers/seed.jpg"
        assert rows[0]["caption"] == "re-cached"
    finally:
        await table.delete().eq("normalized_url", key).execute()
