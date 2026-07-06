# Reel Extraction Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a write-through extraction cache on `reel_cache` so a repeat reel skips BOTH scrape and extract — eliminating the ~44–65s extract stage (60% of the run) + the ~10–20s Apify scrape on a warm cache. Keyed on the normalized reel URL + an `EXTRACTOR_VERSION` (bump-to-invalidate).

**Architecture:** Per reel, the runner checks `reel_cache` for a version-matched extraction. **HIT** → use the cached `PlaceResult`s, skip scrape+extract (nothing downstream needs the raw `ReelData`). **MISS** → scrape → extract → write-through upsert the extraction → use it. A non-reel URL is uncacheable (falls through to scrape+extract). Correctness rests entirely on the `EXTRACTOR_VERSION` constant — bump it on any extractor change so stale entries auto-miss.

**Tech Stack:** async supabase-py (`reel_cache` upsert) · pytest. One additive migration (2 nullable columns on the existing `reel_cache`). Backend-only — `reel_cache` is not in the TS mirror, so no frontend change.

## Global Constraints

- **Correctness = version discipline (CRITICAL):** `EXTRACTOR_VERSION` (a constant beside the extractor prompt) MUST be bumped on ANY change to the extractor instructions, model, `keep_valid_places`, or the `PlaceResult` schema. A version mismatch is a MISS → re-extract + overwrite. This is the whole invalidation story (no TTL — reel captions are immutable).
- **Write-through (guardrail #7):** cache the extraction only AFTER a successful extract, upserting BEFORE the pipeline continues. A cache-write failure is best-effort — it NEVER fails the trip.
- **Cache READ is best-effort too (guardrail #3):** the per-reel `get_cached_places` call is wrapped in the runner so a Supabase-read blip OR a `model_validate` failure (schema drift without a version bump) degrades to a MISS (scrape+extract). A cache lookup runs on 100% of trips — it must NEVER fail an otherwise-valid trip. (Symmetry with the write: BOTH cache ops are best-effort.)
- **HIT skips scrape AND extract:** confirmed nothing after Phase 2 consumes `ReelData` — `dedupe_places`/`assemble_itinerary`/persist/enrich all operate on `PlaceResult`s.
- **Cache a 0-place extraction, NOT an extract that raised:** an empty result is cached (avoids re-running a dry reel; a version bump lets a better extractor retry). A raised extract caches nothing.
- **Non-reel URL = uncacheable:** `normalize_reel_url` raises `ValueError` → skip the cache (scrape+extract, no write). Reel URLs reach the runner RAW (no upstream normalization).
- **#16 eval-safety:** the cache lives entirely in the live `run_generation` scrape/extract path; the offline eval uses `FixtureReelSource`/`FixturePlaceSource` and never scrapes/extracts/caches. `pipeline/cache.py` is import-keyless (no client at module scope). Parity anchor untouched.
- **Global flywheel:** `reel_cache` is cross-user, `service_role`-write, no `authenticated` policy (like `places`) — unchanged. No RLS change.
- No commit attribution line.

## File Structure

- **Create** `supabase/migrations/<ts>_reel_extraction_cache.sql` — `alter table reel_cache add extracted_places jsonb, extractor_version text`.
- **Modify** `backend/genagents/place_extractor.py` — add the `EXTRACTOR_VERSION` constant.
- **Modify** `backend/pipeline/cache.py` (currently a 1-line stub) — `get_cached_places` + `cache_places`.
- **Create** `backend/pipeline/test_cache.py` — offline unit tests.
- **Modify** `backend/pipeline/runner.py` — cache-check → scrape/extract-misses → write-through.
- **Modify** `backend/pipeline/test_runner.py` — a cache-HIT test (existing tests use non-reel URLs → unaffected).

---

### Task 1: Migration + version + cache module

**Files:**
- Create: `supabase/migrations/<ts>_reel_extraction_cache.sql`
- Modify: `backend/genagents/place_extractor.py`
- Modify: `backend/pipeline/cache.py`
- Create: `backend/pipeline/test_cache.py`

**Interfaces:**
- Produces: `EXTRACTOR_VERSION: str`; `get_cached_places(client, url, extractor_version) -> list[PlaceResult]|None`; `cache_places(client, url, reel, places, extractor_version) -> None` — consumed by the runner (Task 2).

- [ ] **Step 1: Create the migration**

`supabase migration new reel_extraction_cache`, then write (or create a manually-timestamped file AFTER the newest existing migration, e.g. `20260706120000_reel_extraction_cache.sql`):

```sql
-- Extraction cache: store the validated PlaceResults per reel + the extractor version that produced
-- them (bump-to-invalidate). Both nullable/additive. reel_cache is already the per-reel,
-- normalized_url-unique, global service-role-write flywheel — the right key/grain. No RLS change.
alter table public.reel_cache add column if not exists extracted_places jsonb;
alter table public.reel_cache add column if not exists extractor_version text;
```

- [ ] **Step 2: Add `EXTRACTOR_VERSION` to `backend/genagents/place_extractor.py`**

Add beside `DEFAULT_MODEL`/`FALLBACK_MODEL` (near line 24-25):

```python
# Bump this on ANY change to the extractor (instructions, model, keep_valid_places, or the
# PlaceResult schema) — the extraction cache keys on it, so a bump auto-invalidates stale entries.
EXTRACTOR_VERSION = "2026-07-06.1"
```

- [ ] **Step 3: Write the failing tests** — `backend/pipeline/test_cache.py`

```python
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
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_cache.py -q`
Expected: FAIL (`get_cached_places`/`cache_places` not defined).

- [ ] **Step 5: Write `backend/pipeline/cache.py`** (replace the stub)

```python
"""Write-through EXTRACTION cache on reel_cache — a version-keyed per-reel cache so a repeat reel
skips scrape+extract. Live-only (in the live runner path; the offline #16 eval uses fixtures, never
this). Import-keyless: no client at module scope. A non-reel URL is uncacheable (normalize raises) —
the caller falls through to scrape+extract with no cache write."""
from __future__ import annotations

import sys

from models.place import PlaceResult
from scrape.reel_url import normalize_reel_url

EXTRACTION_CACHE_TABLE = "reel_cache"


async def get_cached_places(client, url: str, extractor_version: str) -> list[PlaceResult] | None:
    """The cached extraction for one reel at THIS extractor_version, or None (miss). None on a
    non-reel URL or a URL/version mismatch. A stale-version row is a miss → re-extract."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return None
    rows = (await client.table(EXTRACTION_CACHE_TABLE).select("extracted_places")
            .eq("normalized_url", key).eq("extractor_version", extractor_version).execute()).data
    if not rows or rows[0].get("extracted_places") is None:
        return None
    places = [PlaceResult.model_validate(d) for d in rows[0]["extracted_places"]]
    print(f"  [cache] HIT {key} -> {len(places)} places (skipped scrape+extract)", file=sys.stderr)
    return places


async def cache_places(client, url: str, reel, places: list[PlaceResult], extractor_version: str) -> None:
    """Write-through the extraction (guardrail #7): upsert the reel_cache row keyed on normalized_url,
    stamping extractor_version + the scrape fields (caption/location/transcript, for the frontend tray
    join). No-op on a non-reel URL. A 0-place result IS cached (avoids re-extracting a dry reel)."""
    try:
        key = normalize_reel_url(url)
    except ValueError:
        return
    await client.table(EXTRACTION_CACHE_TABLE).upsert({
        "normalized_url": key,
        "source_platform": "instagram",
        "caption": getattr(reel, "caption", "") or "",
        "location_name": getattr(reel, "location_name", None),
        "transcript": getattr(reel, "transcript", None),
        "extracted_places": [p.model_dump() for p in places],
        "extractor_version": extractor_version,
    }, on_conflict="normalized_url").execute()
    print(f"  [cache] MISS {key} -> cached {len(places)} places (v={extractor_version})", file=sys.stderr)
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_cache.py -q` → PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/*_reel_extraction_cache.sql backend/genagents/place_extractor.py backend/pipeline/cache.py backend/pipeline/test_cache.py
git commit -m "feat(cache): write-through reel extraction cache (get/cache_places + EXTRACTOR_VERSION + migration)"
```

---

### Task 2: Runner integration

**Files:**
- Modify: `backend/pipeline/runner.py`
- Test: `backend/pipeline/test_runner.py`

**Interfaces:**
- Consumes: `EXTRACTOR_VERSION`, `get_cached_places`, `cache_places` (Task 1).

- [ ] **Step 1: Write the failing test** — append to `backend/pipeline/test_runner.py`

```python
@pytest.mark.asyncio
async def test_runner_uses_extraction_cache_skips_scrape_and_extract():
    # A cached reel (real reel URL + a seeded reel_cache row at the current EXTRACTOR_VERSION) is a
    # HIT: scrape+extract are NEVER called, a `cache_hit` event fires, and the cached place is used.
    from genagents.place_extractor import EXTRACTOR_VERSION
    reel_url = "https://www.instagram.com/reel/ABC123/"
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["reel_cache"] = [{"id": "rc-1", "normalized_url": "https://www.instagram.com/reel/ABC123",
                           "extractor_version": EXTRACTOR_VERSION,
                           "extracted_places": [_place("Tokyo Tower").model_dump()]}]

    async def scrape(url): raise AssertionError("scrape must not run on a cache hit")
    async def extract(reel): raise AssertionError("extract must not run on a cache hit")

    await runner.run_generation("trip-1", "user-1", [reel_url], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=_no_narrator, hotel=_no_hotel)
    assert any(e["stage"] == "cache_hit" for e in c.events)
    assert c.db.get("places") and c.db["places"][0]["name"] == "Tokyo Tower"   # cached place persisted
    assert c.trip_updates[-1]["status"] == "complete"
```

Note: `_place` (test_runner.py) is a `PlaceResult` factory; `.model_dump()` seeds the cache row. The existing runner tests use `"https://ig/r1"` (NOT a reel URL) → `get_cached_places` returns None (uncacheable) → they hit the normal scrape+extract path unchanged.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_runner.py -q -k cache`
Expected: FAIL (`scrape must not run` — the runner doesn't check the cache yet).

- [ ] **Step 3: Wire the cache into `backend/pipeline/runner.py`**

Replace the current PHASE 1 + PHASE 2 blocks (the `# PHASE 1: SCRAPE` through the `if not places:` fail, ~lines 94-123) with:

```python
        # PHASE 1+2: SCRAPE + EXTRACT, with a per-reel EXTRACTION CACHE. A repeat reel (same
        # normalized URL + EXTRACTOR_VERSION) skips BOTH scrape and extract. Non-reel URLs are
        # uncacheable → normal scrape+extract. Cache writes are best-effort (never fail the trip).
        from genagents.place_extractor import EXTRACTOR_VERSION
        from pipeline.cache import cache_places, get_cached_places

        places: list[PlaceResult] = []
        miss_urls: list[str] = []
        n_hit = 0
        for url in reel_urls:
            try:
                cached = await get_cached_places(client, url, EXTRACTOR_VERSION)
            except Exception:
                cached = None   # cache READ is a pure optimization — a Supabase blip / model_validate
                                # drift = MISS (scrape+extract), NEVER fail the trip (guardrail #3).
            if cached is not None:
                places.extend(cached)
                n_hit += 1
            else:
                miss_urls.append(url)
        if n_hit:
            await record_event(client, trip_id, event_type="stage", stage="cache_hit",
                               message=f"{n_hit} reel(s) from cache (skipped scrape+extract)")

        if miss_urls:
            # SCRAPE (misses only, parallel, partial-failure isolated)
            await record_event(client, trip_id, event_type="stage", stage="scrape",
                               message=f"scraping {len(miss_urls)} reel(s)")
            scraped = await asyncio.gather(*[scrape(u) for u in miss_urls], return_exceptions=True)
            miss_reels: list[tuple[str, object]] = []
            for url, res in zip(miss_urls, scraped):
                if isinstance(res, Exception):
                    degraded = True
                    await record_event(client, trip_id, event_type="warning", stage="scrape",
                                       message=f"reel skipped: {url}")
                else:
                    miss_reels.append((url, res))
            # EXTRACT (misses only) + write-through cache each successful extraction
            if miss_reels:
                await record_event(client, trip_id, event_type="stage", stage="extract",
                                   message=f"extracting places from {len(miss_reels)} reel(s)")
                extracted = await asyncio.gather(*[extract(r) for _u, r in miss_reels],
                                                 return_exceptions=True)
                for (url, reel), res in zip(miss_reels, extracted):
                    if isinstance(res, Exception):
                        degraded = True
                        await record_event(client, trip_id, event_type="warning", stage="extract",
                                           message="extraction failed for one reel")
                    else:
                        places.extend(res)
                        try:
                            await cache_places(client, url, reel, res, EXTRACTOR_VERSION)
                        except Exception:
                            pass   # cache write is best-effort — never fail the trip on it

        if not places:
            return await _fail(client, trip_id, user_id, job_id, "extract",
                                "no verified places after extraction")
```

(The `dedup` stage event + everything after `if not places:` stays unchanged.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && uv run pytest pipeline/test_runner.py -q` → PASS (new cache test + all existing).

- [ ] **Step 5: Full suite + eval-safety**

Run: `cd backend && uv run pytest -q` → PASS.
Run: `cd backend && uv run pytest evals/ -q` → PASS (cache absent from the eval graph; `mean_intra_day_travel_m` unchanged).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(cache): wire extraction cache into the runner (repeat reels skip scrape+extract)"
```

---

## Deferred (documented, with triggers)

- **Auto-derived `EXTRACTOR_VERSION`** (hash of instructions+model+schema) — nice-to-have; the manual constant + a bump comment is feasible-first. Trigger = a stale-cache bug from a forgotten bump.
- **Scrape-only cache** (skip Apify but re-extract) — not needed; the extraction cache already skips scrape too.
- **`expires_at` TTL** — no expiry for extraction (captions immutable; version-only invalidation). The column is indexed and available if scrape-snapshot freshness ever matters.
- **`search_context_size="low"` extractor knob** — the second latency lever (helps cold runs), deferred pending an A/B.

## Arc verification (after all tasks)

1. **Apply the migration to dev** BEFORE any live run: `supabase db push` (or run the two `alter table` statements against the linked dev project). The offline suite doesn't need it; the live run does (the upsert writes `extracted_places`/`extractor_version`).
2. **Final whole-branch review** — dispatch `astrail-reviewer` (cache correctness, version-invalidation, write-through/guardrail-#7, HIT-skips-both, eval-safety, the runner phase restructure preserving scrape/extract/cache_hit events + partial-failure isolation).
3. **Codex review** — `/codex:review` on the branch diff.
4. **Live-verify the win (the whole point):** run the smoke tool TWICE on the SAME reels + dates —
   - Run 1 (cold): `uv run --env-file .env python -m scripts.live_run --start <D> --end <D+2>` → note the `[extract]` time + total (miss path; also writes the cache).
   - Run 2 (warm, DIFFERENT dates so the trip idempotency key differs but the reels are the SAME): another `live_run` → expect a `[cache] HIT` per reel, NO `[extract]`, and the total dropping by ~the whole scrape+extract (~50–85s). Confirm the trip still generates correctly from cached places.
5. **PR to `dev`** — backend + the one migration (no frontend change). Hand Codex the board update (extraction-cache card → Done).
