"""Extraction-cache unit tests. Offline: an in-memory fake client with select/eq/upsert. No network,
no key. Covers hit / miss / version-mismatch / non-reel-URL / round-trip / 0-place caching."""
import pytest

from models.place import PlaceResult
from pipeline.cache import cache_places, get_cached_places

_REEL = "https://www.instagram.com/reel/ABC123/"
_KEY = "https://www.instagram.com/reel/ABC123"   # normalized (no trailing slash)


class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, name, db):
        self.name, self.db, self._op, self._f, self._conflict = name, db, None, {}, None

    def select(self, *_): self._op = ("select", None); return self
    def upsert(self, row, on_conflict=None): self._op = ("upsert", row); self._conflict = on_conflict; return self
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
    def __init__(self, db=None): self.db = db if db is not None else {}
    def table(self, name): return _Table(name, self.db)


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


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    import pipeline.cache as m
    importlib.reload(m)
    assert m.EXTRACTION_CACHE_TABLE == "reel_cache"
