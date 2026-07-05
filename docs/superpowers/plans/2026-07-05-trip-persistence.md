# Normalized Trip Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** After the deterministic pipeline generates a trip, persist it into the normalized Supabase schema — `places` (global, dedup-on-write), `trip_places` (link + day assignment + evidence), and `trip_days` — so the trip is relationally queryable (and the frontend can read it straight from Supabase).

**Architecture:** A new pure-ish `backend/pipeline/persist.py` exposing `async def persist_itinerary(client, trip_id, canonical, itinerary)`, called from `runner.py`'s existing `save` stage. It (1) filters to coord-bearing canonical places and normalizes `category → place_type`; (2) for retry-safety, deletes this trip's `trip_places`+`trip_days` before writing; (3) **dedup-on-write**: for each place, reuses an existing global `places` row that matches by name/alias AND haversine < 500m (the same two-gate `dedup.py` uses in-trip, now against the DB), else inserts a new one; (4) inserts `trip_places` links carrying `source_type`, `evidence_json`, and `day_number`/`sort_order` reconstructed from the itinerary; (5) inserts `trip_days`. A persist failure **degrades** the trip to `saved_with_gaps` (the itinerary is still durable in the terminal `result` event), never fails the whole run.

**Tech Stack:** async `supabase-py` (service-role), `pipeline.geo.haversine_m`, existing `models` (CanonicalPlace, ItineraryOutput), pytest + the fake-client harness already in `pipeline/test_runner.py`.

## Global Constraints

- **Match the schema exactly** (verified against `supabase/migrations/`):
  - `places`: `name` (NOT NULL), `place_type` (NOT NULL, CHECK ∈ `attraction,restaurant,hotel,area,city,country,station,shop,other`), `lat`/`lng` (`double precision` **NOT NULL**, ranges), `country`/`city`/`area` (nullable), `aliases` (`text[]`), `source_summary` (jsonb, **must be an object and must NOT contain** keys `caption, mem0_memory_id, normalized_reel_url, preference_notes, raw_payload, reel_cache_id, transcript, trip_id, user_id`), `embedding` (nullable — leave NULL).
  - `trip_places`: `trip_id`, `place_id` (FK→places **ON DELETE RESTRICT**), `source_type` (NOT NULL, CHECK ∈ `reel_extracted,user_requested,agent_suggested`), `evidence_json` (jsonb, must be an object), `day_number` (nullable, >0), `sort_order` (nullable, ≥0), `UNIQUE(trip_id, place_id)`.
  - `trip_days`: `trip_id`, `day_number` (NOT NULL, >0), `day_date` (nullable date), `title`/`summary` (nullable), `UNIQUE(trip_id, day_number)`.
- **All three tables are service-role-write** (authenticated has SELECT-only). The runner already uses the service-role async client — reuse it; never expose it.
- **Coord filter is mandatory**: `places.lat/lng` are NOT NULL but `CanonicalPlace.lat/lng` are `float | None`. Drop no-coord places before insert (guardrail #1 already wants them dropped upstream; this is the backstop).
- **`place_type` normalize, not passthrough**: the extractor emits `category` free-text including `"transport"`, which is NOT in the enum. Map `transport → station`; pass through already-valid values; everything else → `other`.
- **Evidence lives in `trip_places.evidence_json`, NOT `places.source_summary`** (the source_summary CHECK forbids per-trip/per-user keys; `places` is global).
- **Dedup-on-write keeps `places` canonical across trips** (the data-flywheel decision): reuse an existing row on name/alias match AND haversine < 500m, else insert.
- **Retry-safe**: a job retry re-runs `persist_itinerary`; delete this trip's `trip_places`+`trip_days` first so we never hit the `UNIQUE(trip_id, place_id)` violation or duplicate day rows. Do NOT delete `places` (global; shared; ON DELETE RESTRICT).
- **Async**: every `.execute()` is `await`ed (async client). Keyless import held — no module-scope env/network.
- **Do NOT touch the #16 eval anchor**: `ItineraryOutput`/`ItineraryDay` shape stays frozen (name→day mapping happens in `persist.py`, not by enriching the model). `offline_harness.py`/`evals/` unchanged.
- **Async `.execute()` error handling**: a persist DB error must degrade (warning + `saved_with_gaps`), never a bare 500 or a silently-lost run.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `backend/pipeline/persist.py` | pure mappers (`_place_type`, coord filter, name→day lookup, name-match) + `_find_or_create_place` (dedup-on-write) + `persist_itinerary` | 1 |
| `backend/pipeline/test_persist.py` | unit tests with an async fake client | 1 |
| `backend/pipeline/runner.py` | call `persist_itinerary` in the `save` stage; degrade to `saved_with_gaps` on failure | 2 |
| `backend/test_main_integration.py` | extend the live gate to assert `places`/`trip_places`/`trip_days` rows land | 3 |

**Deferred (with triggers):** `transport_legs`/`restaurant_suggestions`/`hotel_suggestions`/`trip_days.weather_*` (no producers until the enrich agents land — the same `persist.py` gains additive inserts then); `places.embedding`/pgvector semantic dedup (needs the embedding pipeline); `reel_cache` write-through (separate scrape-stage seam); alias-merge on a dedup hit (reuse id only for now); `trips.inferred_destination`/`preference_summary` (no pipeline source).

---

### Task 1: `pipeline/persist.py` — mappers + dedup-on-write + persist_itinerary

**Files:**
- Create: `backend/pipeline/persist.py`
- Test: `backend/pipeline/test_persist.py`

**Interfaces:**
- Consumes: `CanonicalPlace` (`models/place.py`), `ItineraryOutput` (`models/trip.py`), `haversine_m` (`pipeline/geo.py`).
- Produces:
  - `_place_type(category: str) -> str` — map extractor category → the `places` CHECK enum.
  - `_evidence_json(place) -> dict` — `{evidence_quote, evidence_quotes, source_url, confidence}`.
  - `_source_summary(place) -> dict` — `{"formatted_address": ...}` when present else `{}` (never a blocked key).
  - `_day_lookup(itinerary) -> dict[str, tuple[int, int]]` — place name → (day_number, sort_order).
  - `_place_matches(place, row) -> bool` — normalized name/alias overlap.
  - `async def _find_or_create_place(client, place) -> str` — dedup-on-write → place id.
  - `async def persist_itinerary(client, trip_id, canonical, itinerary) -> None`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/pipeline/test_persist.py
import pytest

from models.place import CanonicalPlace
from models.trip import ItineraryDay, ItineraryOutput
from pipeline import persist


def _cp(name, lat, lng, *, category="attraction", source_type="reel_extracted",
        aliases=None, name_local=None):
    return CanonicalPlace(
        name=name, name_local=name_local, category=category, source_type=source_type,
        lat=lat, lng=lng, confidence=0.9, evidence_quote=f"📍{name}",
        source_url="https://example.org/a", formatted_address=None,
        city_or_region_guess="Tokyo", aliases=aliases or [name],
        evidence_quotes=[f"📍{name}"], times_referenced=1,
    )


def _itin(days):
    return ItineraryOutput(title="t", source="pipeline", source_places=[],
                           days=days, feasibility_warnings=[])


# --- pure mappers -----------------------------------------------------------
def test_place_type_maps_transport_to_station_and_unknown_to_other():
    assert persist._place_type("transport") == "station"
    assert persist._place_type("restaurant") == "restaurant"
    assert persist._place_type("Attraction") == "attraction"   # case-insensitive
    assert persist._place_type("station") == "station"          # already valid passes through
    assert persist._place_type("nonsense") == "other"


def test_source_summary_never_contains_blocked_keys():
    p = _cp("X", 1.0, 2.0)
    ss = persist._source_summary(p)
    assert isinstance(ss, dict)
    for blocked in ("caption", "transcript", "trip_id", "user_id", "raw_payload"):
        assert blocked not in ss


def test_day_lookup_maps_name_to_day_and_sort_order():
    itin = _itin([
        ItineraryDay(day_number=1, date="2026-08-01", place_names=["A", "B"]),
        ItineraryDay(day_number=2, date="2026-08-02", place_names=["C"]),
    ])
    lu = persist._day_lookup(itin)
    assert lu["A"] == (1, 0) and lu["B"] == (1, 1) and lu["C"] == (2, 0)


# --- async fake client ------------------------------------------------------
class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, name, db):
        self.name, self.db = name, db
        self._op = None; self._f = {}; self._range = {}

    def insert(self, row): self._op = ("insert", row); return self
    def delete(self): self._op = ("delete", None); return self
    def select(self, *_): self._op = ("select", None); return self
    def eq(self, c, v): self._f[c] = v; return self
    def gte(self, c, v): self._range[(c, "gte")] = v; return self
    def lte(self, c, v): self._range[(c, "lte")] = v; return self

    def _match(self, r):
        if not all(r.get(k) == v for k, v in self._f.items()):
            return False
        for (c, op), v in self._range.items():
            if op == "gte" and not r.get(c, 0) >= v: return False
            if op == "lte" and not r.get(c, 0) <= v: return False
        return True

    async def execute(self):
        op, arg = self._op
        rows = self.db.setdefault(self.name, [])
        if op == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row); return _Result([row])
        if op == "delete":
            keep = [r for r in rows if not self._match(r)]
            self.db[self.name] = keep; return _Result([])
        return _Result([r for r in rows if self._match(r)])


class _Client:
    def __init__(self, db=None): self.db = db if db is not None else {}
    def table(self, name): return _Table(name, self.db)


@pytest.mark.asyncio
async def test_persist_writes_places_trip_places_and_days():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454),
                 _cp("Senso-ji", 35.7148, 139.7967)]
    itin = _itin([ItineraryDay(day_number=1, date="2026-08-01",
                               place_names=["Tokyo Tower", "Senso-ji"])])
    await persist.persist_itinerary(c, "trip-1", canonical, itin)

    assert len(c.db["places"]) == 2
    tps = c.db["trip_places"]
    assert len(tps) == 2
    assert {tp["source_type"] for tp in tps} == {"reel_extracted"}
    assert all(tp["trip_id"] == "trip-1" and tp["place_id"] for tp in tps)
    assert {tp["day_number"] for tp in tps} == {1}
    assert {tp["sort_order"] for tp in tps} == {0, 1}
    assert len(c.db["trip_days"]) == 1 and c.db["trip_days"][0]["day_number"] == 1


@pytest.mark.asyncio
async def test_persist_drops_no_coord_places():
    c = _Client()
    canonical = [_cp("Has Coords", 35.0, 139.0), _cp("No Coords", None, None)]
    itin = _itin([ItineraryDay(day_number=1, date="2026-08-01",
                               place_names=["Has Coords", "No Coords"])])
    await persist.persist_itinerary(c, "trip-1", canonical, itin)
    assert len(c.db["places"]) == 1 and c.db["places"][0]["name"] == "Has Coords"
    assert len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_dedup_on_write_reuses_existing_nearby_place():
    # A pre-existing global place ~10m away with the same name → reused, not re-inserted.
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower"], "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541)]  # ~1m away
    itin = _itin([ItineraryDay(day_number=1, date="2026-08-01", place_names=["Tokyo Tower"])])
    await persist.persist_itinerary(c, "trip-1", canonical, itin)
    assert len(c.db["places"]) == 1  # NOT a new row — flywheel reuse
    assert c.db["trip_places"][0]["place_id"] == "existing-1"


@pytest.mark.asyncio
async def test_two_canonical_resolving_to_same_place_link_once():
    # Both canonical places match the SAME existing global place (name/alias overlap + <500m) →
    # exactly ONE trip_places row (guards trip_places UNIQUE(trip_id, place_id)).
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower", "東京タワー"],
                             "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541),
                 _cp("東京タワー", 35.65859, 139.74539, name_local="東京タワー",
                     aliases=["東京タワー"])]
    itin = _itin([ItineraryDay(day_number=1, date="2026-08-01",
                               place_names=["Tokyo Tower", "東京タワー"])])
    await persist.persist_itinerary(c, "trip-1", canonical, itin)
    assert len(c.db.get("places", [])) == 1
    assert len(c.db["trip_places"]) == 1  # both resolved to existing-1 → linked once, no UNIQUE crash


@pytest.mark.asyncio
async def test_persist_is_retry_safe_deletes_prior_rows():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454)]
    itin = _itin([ItineraryDay(day_number=1, date="2026-08-01", place_names=["Tokyo Tower"])])
    await persist.persist_itinerary(c, "trip-1", canonical, itin)
    await persist.persist_itinerary(c, "trip-1", canonical, itin)  # retry
    assert len(c.db["trip_places"]) == 1   # not doubled
    assert len(c.db["trip_days"]) == 1
    assert len(c.db["places"]) == 1        # dedup reused the place from attempt 1
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_persist.py -v`
Expected: FAIL — `pipeline.persist` does not exist.

- [ ] **Step 3: Implement `pipeline/persist.py`**

```python
# backend/pipeline/persist.py
"""Persist a generated trip into the normalized Supabase schema.

Writes the deterministic-spine output — places (global, dedup-on-write),
trip_places (link + day assignment + evidence), and trip_days. The enrich
tables (transport_legs / restaurant_suggestions / hotel_suggestions /
trip_days.weather_*) get additive inserts here once their agents exist.

Reuses the pure route/dedup helpers' spirit: an existing global `places` row is
reused when it matches by name/alias AND haversine < 500m (the same two-gate
`pipeline/dedup.py` applies in-trip), so `places` stays canonical across trips.
"""
from __future__ import annotations

import math
import re

from models.place import CanonicalPlace
from models.trip import ItineraryOutput
from pipeline.geo import haversine_m

_GEO_GATE_M = 500.0            # same threshold as pipeline/dedup.DEFAULT_DISTANCE_M

_VALID_PLACE_TYPES = {"attraction", "restaurant", "hotel", "area", "city",
                      "country", "station", "shop", "other"}
_CATEGORY_MAP = {"transport": "station"}   # extractor emits 'transport'; enum has 'station'

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def _norm(name: str | None) -> str:
    if not name:
        return ""
    return _WS.sub(" ", _NON_WORD.sub(" ", name.lower())).strip()


def _place_type(category: str) -> str:
    c = (category or "").lower().strip()
    if c in _VALID_PLACE_TYPES:
        return c
    return _CATEGORY_MAP.get(c, "other")


def _source_summary(place: CanonicalPlace) -> dict:
    # GLOBAL place metadata only — never per-trip/user (the source_summary CHECK forbids it).
    ss: dict = {}
    if getattr(place, "formatted_address", None):
        ss["formatted_address"] = place.formatted_address
    return ss


def _evidence_json(place: CanonicalPlace) -> dict:
    # Per-trip evidence lives here (an object), NOT in places.source_summary.
    return {
        "evidence_quote": place.evidence_quote,
        "evidence_quotes": list(getattr(place, "evidence_quotes", []) or []),
        "source_url": place.source_url,
        "confidence": place.confidence,
    }


def _day_lookup(itinerary: ItineraryOutput) -> dict[str, tuple[int, int]]:
    """name -> (day_number, sort_order) from the itinerary's per-day place_names."""
    lookup: dict[str, tuple[int, int]] = {}
    for day in itinerary.days:
        for i, name in enumerate(day.place_names):
            lookup.setdefault(name, (day.day_number, i))
    return lookup


def _place_matches(place: CanonicalPlace, row: dict) -> bool:
    keys = {_norm(place.name), _norm(getattr(place, "name_local", None))}
    keys |= {_norm(a) for a in (getattr(place, "aliases", []) or [])}
    keys.discard("")
    row_keys = {_norm(row.get("name"))} | {_norm(a) for a in (row.get("aliases") or [])}
    row_keys.discard("")
    return bool(keys & row_keys)


def _bbox_deltas(lat: float) -> tuple[float, float]:
    """lat/lng degree deltas that always ENCLOSE a 500m radius (globally safe — a fixed
    0.01° lng box is < 500m at high latitude and would exclude a true near-duplicate)."""
    lat_delta = _GEO_GATE_M / 111_320.0
    lng_delta = _GEO_GATE_M / (111_320.0 * max(math.cos(math.radians(lat)), 1e-6))
    return lat_delta, lng_delta


async def _find_or_create_place(client, place: CanonicalPlace) -> str:
    """Dedup-on-write: reuse a global places row matching by name/alias AND <500m, else insert.
    The bbox is a coarse indexable pre-filter (uses the (lat,lng) index); the exact haversine
    gate decides. NOTE: select-then-insert is not atomic — two DIFFERENT trips saving the same
    brand-new place concurrently can both insert (a rare cross-trip flywheel dup); full safety
    needs a UNIQUE key/upsert on places (a migration), deferred until measured."""
    lat_d, lng_d = _bbox_deltas(place.lat)
    candidates = (await client.table("places").select("id,name,aliases,lat,lng")
                  .gte("lat", place.lat - lat_d).lte("lat", place.lat + lat_d)
                  .gte("lng", place.lng - lng_d).lte("lng", place.lng + lng_d)
                  .execute()).data
    for row in candidates:
        if _place_matches(place, row) and \
                haversine_m(place.lat, place.lng, row["lat"], row["lng"]) < _GEO_GATE_M:
            return row["id"]
    inserted = (await client.table("places").insert({
        "name": place.name,
        "place_type": _place_type(place.category),
        "lat": place.lat, "lng": place.lng,
        "city": getattr(place, "city_or_region_guess", None),
        "aliases": list(getattr(place, "aliases", []) or []),
        "source_summary": _source_summary(place),
    }).execute()).data
    return inserted[0]["id"]


async def persist_itinerary(client, trip_id: str, canonical: list[CanonicalPlace],
                            itinerary: ItineraryOutput) -> None:
    """Persist the trip's normalized rows. Retry-safe (clears this trip's links/days first).

    Raises on a DB error — the caller (runner) degrades to saved_with_gaps.
    """
    places = [p for p in canonical if p.lat is not None and p.lng is not None]
    day_of = _day_lookup(itinerary)

    # Retry-safety: clear THIS trip's links/days (places are global — never deleted here).
    # The runner's atomic CAS claim makes this single-writer per job/trip, so the
    # non-transactional delete-then-reinsert is safe against the normal concurrency path.
    await client.table("trip_places").delete().eq("trip_id", trip_id).execute()
    await client.table("trip_days").delete().eq("trip_id", trip_id).execute()

    linked: set[str] = set()   # dedup place_ids within this trip
    for place in places:
        place_id = await _find_or_create_place(client, place)
        # Two distinct canonical places can resolve to the SAME global place_id (the DB's
        # accumulated aliases merge more than in-trip dedup). Guard the trip_places
        # UNIQUE(trip_id, place_id): keep the first link, skip the duplicate.
        if place_id in linked:
            continue
        linked.add(place_id)
        day_number, sort_order = day_of.get(place.name, (None, None))
        await client.table("trip_places").insert({
            "trip_id": trip_id, "place_id": place_id,
            "source_type": place.source_type,
            "evidence_json": _evidence_json(place),
            "day_number": day_number, "sort_order": sort_order,
        }).execute()

    for day in itinerary.days:
        await client.table("trip_days").insert({
            "trip_id": trip_id, "day_number": day.day_number, "day_date": day.date,
        }).execute()
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_persist.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Confirm the #16 eval + full offline suite untouched**

Run: `cd backend && uv run pytest pipeline/ evals/ -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS `mean_intra_day_travel_m=6229.0` (persist.py imports no eval code and doesn't touch `run_offline_pipeline`).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/persist.py backend/pipeline/test_persist.py
git commit -m "feat(pipeline): normalized trip persistence (places dedup-on-write + trip_places + trip_days)"
```

---

### Task 2: Wire `persist_itinerary` into the runner's save stage

**Files:**
- Modify: `backend/pipeline/runner.py` (the `save` stage block)
- Test: `backend/pipeline/test_runner.py` (extend)

**Interfaces:**
- Consumes: `persist_itinerary` (Task 1).
- Behavior: in the `save` stage, after computing `status` but before the terminal `result`, call `persist_itinerary(client, trip_id, canonical, itinerary)`. Wrap it in `try/except Exception`: on failure, emit a `warning` event (stage `save`) and force `status = "saved_with_gaps"` (the itinerary is still durable in the terminal `result` event). A persist failure must NOT fail the whole trip.

- [ ] **Step 1: Write the failing tests**

```python
# backend/pipeline/test_runner.py  (add these; keep existing tests)
# NOTE: the runner test's fake _Client must gain places/trip_places/trip_days tables
# (the existing fake already stores arbitrary tables by name, so insert/delete work).

@pytest.mark.asyncio
async def test_runner_persists_normalized_rows_on_success():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert c.db.get("places") and c.db["places"][0]["name"] == "Tokyo Tower"
    assert c.db.get("trip_places") and c.db["trip_places"][0]["trip_id"] == "trip-1"
    assert c.db.get("trip_days")
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_runner_degrades_to_saved_with_gaps_when_persist_fails(monkeypatch):
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def _boom(*a, **k): raise RuntimeError("persist db error")
    monkeypatch.setattr(runner, "persist_itinerary", _boom)
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                      "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert out["itinerary"]["days"]                       # itinerary still produced + returned
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"       # NOT failed — persist is non-critical
```

Note for the implementer (CONFIRMED gap): `pipeline/test_runner.py`'s fake `_Table` currently has only `insert`/`select`/`eq`/`update`, and its `insert` does NOT synthesize an `id`. Dedup-on-write needs `delete()`, `gte()`, `lte()`, and `insert()` must return a row carrying an `id` (persist reads `inserted[0]["id"]`). Extend the runner fake to match `test_persist.py`'s fake (which already has all of these) — do NOT weaken the existing runner assertions (`c.events`, `c.trip_updates`, `c.db["jobs"]`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_runner.py -k "persist or saved_with_gaps" -v`
Expected: FAIL — runner doesn't call `persist_itinerary` yet.

- [ ] **Step 3: Wire it into the `save` stage**

```python
# backend/pipeline/runner.py
# add to imports:
from pipeline.persist import persist_itinerary

# in run_generation, the success path's `save` stage — replace the existing block:
        status = "saved_with_gaps" if degraded else "complete"
        await record_event(client, trip_id, event_type="stage", stage="save", message="saving trip")
        try:
            # persist takes `dates` (identity-based day assignment via the shared
            # group_places_by_day helper) — NOT the itinerary. The narrate stage already
            # computes `dates = _date_range(start_date, end_date)`; reuse that variable here
            # (assign it once at narrate: `dates = _date_range(start_date, end_date)` then
            # `itinerary = assemble_itinerary(canonical, dates, pace=pace)`).
            await persist_itinerary(client, trip_id, canonical, dates)
        except Exception:
            status = "saved_with_gaps"   # itinerary is still durable in the result event below
            await record_event(client, trip_id, event_type="warning", stage="save",
                               message="normalized persistence failed; itinerary saved to the result event only")
        await _set_status(client, trip_id, user_id, status)   # async — MUST await (else trip stuck 'generating')
        payload = {"itinerary": itinerary.model_dump()}
        await record_event(client, trip_id, event_type="result", stage="save",
                           message="generation complete", payload=payload)
        if job_id:
            await mark_job_done(client, job_id, status="succeeded")
        return payload
```

(Only the `save`-stage block changes; the scrape/extract/dedup/narrate phases and `_fail` are untouched.)

- [ ] **Step 4: Run to verify they pass + no regression**

Run: `cd backend && uv run pytest pipeline/test_runner.py -v && uv run pytest pipeline/ evals/ -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS 6229.0.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(pipeline): persist normalized trip in the save stage (degrade to saved_with_gaps on failure)"
```

---

### Task 3: Extend the live integration gate to assert normalized rows

**Files:**
- Modify: `backend/test_main_integration.py`

**Behavior:** after the existing end-to-end assertions (a `result` event + terminal job), also assert the normalized rows landed for the real trip: at least one `places` row referenced by a `trip_places` row for this `trip_id`, and at least one `trip_days` row. Cleanup already cascades (`trips` delete → `trip_places`/`trip_days` cascade); `places` rows are global and intentionally left (dedup-on-write reuses them next run).

- [ ] **Step 1: Add assertions to the integration test**

```python
# backend/test_main_integration.py  (inside the existing try:, after the job-status assert)
        trip_places = (await client.table("trip_places").select("place_id,day_number,source_type")
                       .eq("trip_id", trip_id).execute()).data
        assert trip_places, "expected trip_places rows for the generated trip"
        assert all(tp["place_id"] for tp in trip_places)
        assert any(tp["day_number"] for tp in trip_places)           # day assignment persisted
        place_ids = [tp["place_id"] for tp in trip_places]
        places = (await client.table("places").select("id,name,lat,lng")
                  .in_("id", place_ids).execute()).data
        assert places and all(p["lat"] is not None and p["lng"] is not None for p in places)
        trip_days = (await client.table("trip_days").select("day_number")
                     .eq("trip_id", trip_id).execute()).data
        assert trip_days, "expected trip_days rows for the generated trip"
```

- [ ] **Step 2: Run the live gate**

Run: `cd backend && RUN_DB_INTEGRATION=1 uv run --env-file .env pytest test_main_integration.py -v -m integration`
Expected: PASS — the real trip now has `places` + `trip_places` (with day assignment) + `trip_days` rows, cleaned up on teardown.

- [ ] **Step 3: Commit**

```bash
git add backend/test_main_integration.py
git commit -m "test(api): assert normalized places/trip_places/trip_days land in the live integration gate"
```

---

## Self-Review

**Spec coverage:** places (dedup-on-write, coord-filtered, place_type-normalized, source_summary-safe) ✅ · trip_places (source_type passthrough, evidence_json, day_number/sort_order from the itinerary) ✅ · trip_days ✅ · retry-safety (delete-then-reinsert this trip's links/days) ✅ · degrade-not-fail on persist error ✅ · eval anchor untouched (ItineraryOutput frozen; name→day in persist.py) ✅ · live-DB verification ✅.

**Placeholder scan:** every step has complete code + exact commands. No TBD.

**Type consistency:** `persist_itinerary(client, trip_id, canonical: list[CanonicalPlace], itinerary: ItineraryOutput)` identical in Task 1/2/3. `_find_or_create_place(client, place) -> str`, `_day_lookup -> dict[str, tuple[int,int]]`, `_place_type(str) -> str` consistent.

**Codex plan-review folded (fixes applied above):** `await _set_status` (was missing → the trip would be stuck `generating`); dedup `place_id`s within a trip (two canonical → same global place would violate `trip_places` UNIQUE — a crasher); globally-safe `_bbox_deltas` (a fixed 0.01° box is <500m at high latitude and would exclude a true near-dup); the runner-fake extension (delete/gte/lte/id) made explicit.

**Remaining documented limitations (v1, non-blocking — reviewer to confirm acceptable):**
1. **Concurrent cross-trip new-place insert** — `_find_or_create_place` is select-then-insert (not atomic); two *different* trips saving the same brand-new place at the same instant can each insert a global `places` dup. The runner's per-job atomic CAS makes the *same-trip* path single-writer; the cross-trip race is rare at v1-beta and fully fixed only by a UNIQUE key/upsert on `places` (a migration) — deferred until measured.
2. **Duplicate coord-bearing place names in one trip** — `_day_lookup` keys by name, so two DISTINCT canonical places sharing an identical name string (same name, >500m apart — `dedup.py` keeps them separate) both map to the first's day/sort. Rare (bounded ≤8 places), non-crashing. The robust fix threads place identity through narrate, but `ItineraryOutput` is the frozen #16-eval subject, so it's deferred behind an eval-safe refactor.
3. **`_place_matches` is intentionally broader than in-trip dedup** (it also matches the stored row's accumulated aliases) — that is the flywheel merging variants ("Senso-ji" ≡ "浅草寺") across trips; the 500m geo gate bounds false merges.
4. **`.in_()` in Task 3** runs against the REAL client (has it); the unit fakes don't need it.
