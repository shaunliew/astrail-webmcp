# Transport Enrich Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The second Phase-3 enrich agent — compute per-day route legs (duration + distance) between consecutive places in a generated trip via Mapbox Directions, and persist them to `transport_legs`, run as a partial-failure-isolated stage that never fails the trip. Mirrors the weather agent's template exactly.

**Architecture:** `genagents/transport.py::fetch_directions_legs(coords, profile)` makes ONE Mapbox Directions call per day (all that day's ordered coords → `routes[0].legs[]` gives each consecutive leg's duration+distance). `pipeline/persist.py::persist_transport` runs AFTER `persist_itinerary` — it queries the persisted `trip_places`/`trip_days`/`places`, groups by day, calls the fetch once per day (≥2 stops), and INSERTs a `transport_legs` row per leg. The runner calls it in a self-contained best-effort block (guardrail #3 — a transport failure degrades to no-legs, never aborts). Out of the offline #16 eval (live HTTP); `httpx.MockTransport` for tests; injectable `transport=` so tests never hit Mapbox.

**Tech Stack:** `httpx.AsyncClient` (direct HTTP like `scrape/apify_direct.py` / `geocode/mapbox_forward.py`), Mapbox Directions v5, async `supabase-py`, pytest + `httpx.MockTransport`.

## Global Constraints

- **Mapbox Directions contract** (verified via Mapbox docs): `GET https://api.mapbox.com/directions/v5/mapbox/{profile}/{lng,lat;lng,lat;...}` with `access_token` + `overview=false`. Coordinates are `lng,lat` (NOT lat,lng), semicolon-joined, 2–25 per request, visited in order. Profiles: `walking` (v1 default — matches the sub-2km common case; long legs are already flagged by feasibility) / `driving` / `driving-traffic` / `cycling`. One request with N coords returns `routes[0].legs[]` (one leg per consecutive pair, each with `duration` s + `distance` m) — **one call per day, never per-pair** (multiple coords = 1 request; 300 req/min).
- **`code` must be checked:** `NoRoute`/`NoSegment` return **HTTP 200** with `code != "Ok"` — map to `transport_legs.status='no_route'` (null duration/distance), do NOT index `routes[0]` or crash.
- **NEVER `raise_for_status()`** — the token travels in the URL query string, so an httpx exception would leak it. Check `resp.status_code` manually and raise a sanitized `RuntimeError` that contains NO url/token (mirror `geocode/mapbox_forward.py`).
- **`transport_legs` schema** (`supabase/migrations/20260702012806_generated_trip_outputs.sql:19-44`): `trip_id` (FK→trips), `trip_day_id` (nullable, composite FK `(trip_day_id,trip_id)→trip_days(id,trip_id)`), `from_place_id`/`to_place_id` (FK→places), `leg_order` (int ≥0), `transport_mode` (CHECK `walk|drive|cycle|transit_hint|unknown` — NOT the raw profile), `routing_provider` (CHECK `mapbox|manual|none`), `routing_profile` (nullable, CHECK `walking|driving|driving-traffic|cycling`), `status` (CHECK `pending|ok|no_route|failed|skipped`), `duration_seconds`/`distance_meters` (nullable int ≥0), `route_geometry` (jsonb, **null in v1**), `warning` (text), `raw_payload` (jsonb default `{}`). Service-role write.
- **`transport_mode` ≠ profile:** map `walking→walk`, `driving`/`driving-traffic`→`drive`, `cycling→cycle`, else `unknown`.
- **Ordering (hard dependency):** `transport_legs` INSERTs must run strictly AFTER `persist_itinerary` created the `trip_places`/`trip_days` rows (persist_transport reads them). Retry-safe: DELETE this trip's `transport_legs` before re-inserting.
- **Guardrail #3 (partial failure):** transport is NON-critical. The fetch + persist are wrapped so any failure — Mapbox HTTP error, a missing `MAPBOX_SECRET_TOKEN` (`KeyError`), a failed warning-write — emits a `warning` event and leaves legs empty; the trip still completes. A transport failure does NOT change `status` to `saved_with_gaps` (transport is optional enrichment, not a place gap).
- **Guardrail #11 does NOT apply:** Mapbox Directions is structured API data, not untrusted reel content through an LLM.
- **Eval-safety:** transport is a LIVE agent — MUST NOT be imported by `offline_harness.py`/`evals/`; the #16 eval stays credential/network-free (`6229.0` unchanged). Import-keyless: no module-scope token read / `httpx.AsyncClient()`.
- **Injectable:** `run_generation` gains a `transport=None` param (a `fetch_legs` callable, defaults to the real `fetch_directions_legs`), so runner tests inject a fake and never hit Mapbox — same pattern as `weather=`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `backend/models/enrichment.py` | `TransportLeg` Pydantic model | 1 |
| `backend/genagents/transport.py` | `fetch_directions_legs` + `profile_to_mode` (new) | 1 |
| `backend/pipeline/persist.py` | `persist_transport` (query DB → fetch per day → INSERT legs) | 2 |
| `backend/pipeline/test_persist.py` | extend the fake `_Table` with `.in_()` | 2 |
| `backend/pipeline/runner.py` | best-effort transport stage after persist (injectable) | 3 |
| `backend/test_main_integration.py` | assert `transport_legs` land in the live gate | 4 |

**Deferred (triggers):** per-leg geometry/polyline (`route_geometry` stays null); `driving-traffic`/multi-profile selection; turn-by-turn steps; Matrix/Optimization APIs (feasibility already does the TSP ordering).

---

### Task 1: `TransportLeg` model + `genagents/transport.py`

**Files:**
- Modify: `backend/models/enrichment.py`
- Create: `backend/genagents/transport.py`
- Test: `backend/genagents/test_transport.py`

**Interfaces:**
- Produces: `TransportLeg(day_number, leg_order, from_place_id, to_place_id, transport_mode, routing_provider="mapbox", routing_profile=None, status="ok", duration_seconds=None, distance_meters=None, route_geometry=None, warning=None)`.
- Produces: `profile_to_mode(profile: str) -> str`.
- Produces: `async def fetch_directions_legs(coords: list[tuple[float, float]], *, profile: str = "walking", client: httpx.AsyncClient | None = None) -> list[dict]` — `coords` is ordered `(lat, lng)` tuples; returns one dict `{"duration_s": int|None, "distance_m": int|None, "code": str}` per consecutive leg (len == `len(coords)-1`), `[]` if <2 coords; raises `RuntimeError` (sanitized) on a non-2xx.

- [ ] **Step 1: Write the failing tests**

```python
# backend/genagents/test_transport.py
import httpx
import pytest

from genagents.transport import fetch_directions_legs, profile_to_mode


def test_profile_to_mode():
    assert profile_to_mode("walking") == "walk"
    assert profile_to_mode("driving") == "drive"
    assert profile_to_mode("driving-traffic") == "drive"
    assert profile_to_mode("cycling") == "cycle"
    assert profile_to_mode("rocket") == "unknown"


def _mock(payload: dict, status: int = 200) -> httpx.AsyncClient:
    def handler(request):
        assert "api.mapbox.com/directions" in str(request.url)
        return httpx.Response(status, json=payload)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_legs_maps_per_leg_duration_distance():
    payload = {"code": "Ok", "routes": [{"legs": [
        {"duration": 610.4, "distance": 820.9},
        {"duration": 300.0, "distance": 410.0},
    ]}]}
    async with _mock(payload) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76), (35.68, 139.77)], client=client)
    assert len(legs) == 2
    assert legs[0] == {"duration_s": 610, "distance_m": 821, "code": "Ok"}
    assert legs[1]["duration_s"] == 300


@pytest.mark.asyncio
async def test_fetch_legs_lng_lat_order_in_url():
    seen = {}
    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"code": "Ok", "routes": [{"legs": [{"duration": 1, "distance": 2}]}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    # coordinates must be lng,lat — longitude (139.x) FIRST
    assert "139.75,35.66" in seen["url"]


@pytest.mark.asyncio
async def test_fetch_legs_under_two_coords_returns_empty():
    legs = await fetch_directions_legs([(35.66, 139.75)])   # no network call
    assert legs == []


@pytest.mark.asyncio
async def test_fetch_legs_no_route_code_marks_all_legs():
    async with _mock({"code": "NoRoute", "routes": []}) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert len(legs) == 1 and legs[0]["code"] == "NoRoute"
    assert legs[0]["duration_s"] is None and legs[0]["distance_m"] is None


@pytest.mark.asyncio
async def test_fetch_legs_raises_sanitized_on_http_error():
    async with _mock({}, status=422) as client:
        with pytest.raises(RuntimeError) as exc:
            await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert "access_token" not in str(exc.value) and "mapbox.com" not in str(exc.value).lower()
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest genagents/test_transport.py -v`
Expected: FAIL — `genagents.transport` does not exist.

- [ ] **Step 3: Implement the model + agent**

```python
# backend/models/enrichment.py  (add alongside WeatherReport)
class TransportLeg(BaseModel):
    day_number: int
    leg_order: int
    from_place_id: str
    to_place_id: str
    transport_mode: str                    # walk|drive|cycle|transit_hint|unknown
    routing_provider: str = "mapbox"
    routing_profile: str | None = None     # walking|driving|driving-traffic|cycling
    status: str = "ok"                     # pending|ok|no_route|failed|skipped
    duration_seconds: int | None = None
    distance_meters: int | None = None
    route_geometry: dict | None = None     # deferred — null in v1
    warning: str | None = None
```

```python
# backend/genagents/transport.py
"""Transport enrich agent — Mapbox Directions per-day route legs. Direct HTTP, no LLM,
no Agents SDK (structured API data, not untrusted reel content). Import-keyless: the
token is read and the httpx client built inside the function, never at module scope.
Live-only — never imported by the offline eval / offline_harness.
"""
from __future__ import annotations

import os

import httpx

_BASE = "https://api.mapbox.com/directions/v5/mapbox"
_PROFILE_TO_MODE = {"walking": "walk", "driving": "drive", "driving-traffic": "drive", "cycling": "cycle"}


def profile_to_mode(profile: str) -> str:
    """Map a Mapbox routing profile → the transport_legs.transport_mode CHECK value."""
    return _PROFILE_TO_MODE.get(profile, "unknown")


async def fetch_directions_legs(coords, *, profile: str = "walking",
                                client: httpx.AsyncClient | None = None) -> list[dict]:
    """ONE Mapbox Directions call for a day's ordered `(lat, lng)` stops. Returns one
    {'duration_s','distance_m','code'} per consecutive leg (len == len(coords)-1), or []
    if <2 stops. A non-'Ok' top-level code (NoRoute/NoSegment) yields no-route legs (null
    metrics) rather than raising. Raises a SANITIZED RuntimeError on a non-2xx — never
    surfaces the URL/token (raise_for_status would leak the token in the query string)."""
    if len(coords) < 2:
        return []
    token = os.environ["MAPBOX_SECRET_TOKEN"]                 # KeyError if unset → caller isolates it
    path = ";".join(f"{lng},{lat}" for lat, lng in coords)   # Mapbox wants lng,lat
    url = f"{_BASE}/{profile}/{path}"
    owns = client is None
    http = client or httpx.AsyncClient(timeout=30)
    try:
        resp = await http.get(url, params={"access_token": token, "overview": "false"})
    finally:
        if owns:
            await http.aclose()
    if resp.status_code != 200:
        raise RuntimeError(f"Mapbox Directions failed: HTTP {resp.status_code}")   # no url/token
    data = resp.json()
    n_legs = len(coords) - 1
    if data.get("code") != "Ok" or not data.get("routes"):
        code = data.get("code", "NoRoute")
        return [{"duration_s": None, "distance_m": None, "code": code} for _ in range(n_legs)]
    legs = data["routes"][0].get("legs", [])
    out: list[dict] = []
    for leg in legs:
        dur, dist = leg.get("duration"), leg.get("distance")
        out.append({
            "duration_s": round(dur) if dur is not None else None,
            "distance_m": round(dist) if dist is not None else None,
            "code": "Ok",
        })
    return out
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest genagents/test_transport.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Keyless import + eval untouched**

Run: `cd backend && env -i PATH="$PATH" HOME="$HOME" uv run python -c "import genagents.transport, models.enrichment"` (OK) && `uv run python -m evals.run_eval --subject pipeline` (still PASS 6229.0).

- [ ] **Step 6: Commit**

```bash
git add backend/models/enrichment.py backend/genagents/transport.py backend/genagents/test_transport.py
git commit -m "feat(genagents): transport agent — Mapbox Directions per-day legs → TransportLeg (direct HTTP)"
```

---

### Task 2: `persist_transport`

**Files:**
- Modify: `backend/pipeline/persist.py`
- Test: `backend/pipeline/test_persist.py` (extend, incl. fake `_Table.in_()`)

**Interfaces:**
- Consumes: `fetch_directions_legs` (Task 1), `profile_to_mode` (Task 1).
- Produces: `async def persist_transport(client, trip_id: str, *, profile: str = "walking", fetch_legs=None) -> int` — reads the persisted `trip_places`/`trip_days`/`places`, groups coord-ordered stops by day, calls `fetch_legs` once per day (≥2 stops), INSERTs a `transport_legs` row per leg (retry-safe: deletes this trip's legs first), returns the number of legs written. `fetch_legs` defaults to the real `fetch_directions_legs` (injectable for tests).

- [ ] **Step 1: Write the failing tests** (the file's fake `_Table` currently lacks `.in_()` — add it first, see Step 3)

```python
# backend/pipeline/test_persist.py  (add)
from pipeline import persist as _p   # if not already imported as `persist`


@pytest.mark.asyncio
async def test_persist_transport_inserts_legs_per_consecutive_pair():
    # 3 stops on day 1 → 2 legs; day 2 has 1 stop → 0 legs.
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 1, "sort_order": 2},
            {"trip_id": "trip-1", "place_id": "pd", "day_number": 2, "sort_order": 0},
        ],
        "trip_days": [
            {"id": "d1", "trip_id": "trip-1", "day_number": 1},
            {"id": "d2", "trip_id": "trip-1", "day_number": 2},
        ],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.62, "lng": 139.72}, {"id": "pd", "lat": 35.70, "lng": 139.80},
        ],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 600, "distance_m": 800, "code": "Ok"} for _ in range(len(coords) - 1)]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 2
    legs = c.db["transport_legs"]
    assert len(legs) == 2
    assert {l["leg_order"] for l in legs} == {0, 1}
    assert all(l["trip_id"] == "trip-1" and l["trip_day_id"] == "d1" for l in legs)
    assert all(l["transport_mode"] == "walk" and l["routing_profile"] == "walking" for l in legs)
    assert all(l["status"] == "ok" and l["duration_seconds"] == 600 for l in legs)
    frm_to = {(l["from_place_id"], l["to_place_id"]) for l in legs}
    assert frm_to == {("pa", "pb"), ("pb", "pc")}


@pytest.mark.asyncio
async def test_persist_transport_marks_no_route():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 40.0, "lng": 145.0}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": None, "distance_m": None, "code": "NoRoute"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and c.db["transport_legs"][0]["status"] == "no_route"


@pytest.mark.asyncio
async def test_persist_transport_retry_safe_deletes_first():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 35.61, "lng": 139.71}],
        "transport_legs": [{"trip_id": "trip-1", "leg_order": 0, "from_place_id": "x", "to_place_id": "y"}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 1, "distance_m": 1, "code": "Ok"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and len(c.db["transport_legs"]) == 1   # stale leg deleted, not appended
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k transport -v`
Expected: FAIL — `persist_transport` undefined (and `_Table` has no `.in_()`).

- [ ] **Step 3: Add `.in_()` to the fake, then implement**

In `pipeline/test_persist.py`'s fake `_Table`, add an `in_` filter alongside `eq`:
```python
    def in_(self, col, values):
        self._filters.append(("in", col, list(values)))
        return self
```
and in `execute()` where filters are applied, handle the `"in"` op (row[col] in values). (Mirror the existing `eq` handling.)

```python
# backend/pipeline/persist.py  (add; import at top)
from collections import defaultdict
from genagents.transport import profile_to_mode   # keyless import (no network at module scope)


async def persist_transport(client, trip_id: str, *, profile: str = "walking", fetch_legs=None) -> int:
    """Additive: compute per-day route legs (Mapbox Directions) between consecutive persisted
    trip_places and INSERT them into transport_legs. MUST run AFTER persist_itinerary created
    trip_places/trip_days. Retry-safe (deletes this trip's legs first). Returns legs written.
    fetch_legs is injectable (defaults to the real Mapbox call)."""
    if fetch_legs is None:
        from genagents.transport import fetch_directions_legs as fetch_legs

    tps = (await client.table("trip_places").select("place_id,day_number,sort_order")
           .eq("trip_id", trip_id).execute()).data
    if not tps:
        return 0
    tds = (await client.table("trip_days").select("id,day_number").eq("trip_id", trip_id).execute()).data
    day_to_id = {d["day_number"]: d["id"] for d in tds}
    pids = list({tp["place_id"] for tp in tps})
    places = (await client.table("places").select("id,lat,lng").in_("id", pids).execute()).data
    coord = {p["id"]: (p["lat"], p["lng"]) for p in places}

    by_day: dict[int, list] = defaultdict(list)
    for tp in tps:
        by_day[tp["day_number"]].append(tp)

    await client.table("transport_legs").delete().eq("trip_id", trip_id).execute()   # retry-safe
    mode = profile_to_mode(profile)
    written = 0
    for day_number, rows in by_day.items():
        rows = sorted(rows, key=lambda r: (r["sort_order"] if r["sort_order"] is not None else 0))
        if len(rows) < 2:
            continue
        coords = [coord[r["place_id"]] for r in rows if r["place_id"] in coord]
        if len(coords) < 2:
            continue
        legs = await fetch_legs(coords, profile=profile)
        for i, leg in enumerate(legs):
            await client.table("transport_legs").insert({
                "trip_id": trip_id,
                "trip_day_id": day_to_id.get(day_number),
                "from_place_id": rows[i]["place_id"],
                "to_place_id": rows[i + 1]["place_id"],
                "leg_order": i,
                "transport_mode": mode,
                "routing_provider": "mapbox",
                "routing_profile": profile,
                "status": "ok" if leg.get("code") == "Ok" else "no_route",
                "duration_seconds": leg.get("duration_s"),
                "distance_meters": leg.get("distance_m"),
            }).execute()
            written += 1
    return written
```

- [ ] **Step 4: Run to verify they pass + eval untouched**

Run: `cd backend && uv run pytest pipeline/test_persist.py -v && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS 6229.0.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/persist.py backend/pipeline/test_persist.py
git commit -m "feat(pipeline): persist_transport — additive per-day transport_legs from persisted trip_places"
```

---

### Task 3: Wire the transport stage into the runner (Phase 3, partial-failure)

**Files:**
- Modify: `backend/pipeline/runner.py`
- Test: `backend/pipeline/test_runner.py` (extend)

**Interfaces:**
- Consumes: `persist_transport` (Task 2).
- Behavior: `run_generation` gains `transport=None` (a `fetch_legs` callable). In the SAVE stage, AFTER `persist_itinerary` (and `persist_weather`) inside the same `try`, a self-contained best-effort block emits a `transport` stage event, calls `persist_transport(client, trip_id, fetch_legs=transport)`, and on any exception writes a `warning` (stage `transport`) — a transport failure NEVER fails the trip or sets `saved_with_gaps`. Its warning-write is itself best-effort.

- [ ] **Step 1: Write the failing tests**

```python
# backend/pipeline/test_runner.py  (add)
@pytest.mark.asyncio
async def test_runner_persists_transport_legs():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 400, "code": "Ok"} for _ in range(len(coords) - 1)]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=transport)
    assert c.db["transport_legs"], "expected transport_legs written"
    assert any(e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # transport success does not degrade


@pytest.mark.asyncio
async def test_runner_transport_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"): raise RuntimeError("mapbox down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather, transport=transport)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"       # transport failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"
```

NOTE: `_place(...)` may need `lat=`/`lng=` kwargs — check the helper; if it hardcodes coords, extend it minimally or build the `PlaceResult` inline as the other tests do.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_runner.py -k transport -v`
Expected: FAIL — runner has no transport stage.

- [ ] **Step 3: Wire the runner**

```python
# backend/pipeline/runner.py
# imports (add):
from pipeline.persist import persist_itinerary, persist_transport, persist_weather

# run_generation signature: add `transport=None` alongside weather=None.
# In the SAVE stage, INSIDE the persist_itinerary try, AFTER the persist_weather block,
# add a self-contained best-effort transport block:
            try:
                await record_event(client, trip_id, event_type="stage", stage="transport",
                                   message="computing routes")
                await persist_transport(client, trip_id, fetch_legs=transport)
            except Exception:
                try:
                    await record_event(client, trip_id, event_type="warning", stage="transport",
                                       message="transport legs unavailable")
                except Exception:
                    pass   # best-effort — transport failure is non-critical, never fails the trip
```
(transport is inside the persist_itinerary `try`, so it only runs when persist_itinerary succeeded — it needs the trip_places/trip_days. Its own inner try isolates a transport failure into a warning, exactly like the weather-persist block.)

**CRITICAL test fix:** every EXISTING `run_generation(...)` call in `test_runner.py` must now also pass `transport=_no_transport` (else a run that produces ≥2 same-day places would call the real Mapbox). Add a module-level `async def _no_transport(*_a, **_k): return []` and pass `transport=_no_transport` to every existing `run_generation` call that doesn't already inject its own transport (alongside the existing `weather=_no_weather`).

- [ ] **Step 4: Run to verify they pass + eval untouched**

Run: `cd backend && uv run pytest pipeline/test_runner.py -v && uv run pytest pipeline/ evals/ -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS 6229.0; keyless `import pipeline.runner`.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(pipeline): Phase-3 transport stage — persist per-day route legs, partial-failure isolated"
```

---

### Task 4: Extend the live gate + smoke-verify

**Files:**
- Modify: `backend/test_main_integration.py`

**Behavior:** inject a fake `transport` into the integration test's run and assert `transport_legs` land for the trip.

- [ ] **Step 1: Add transport to the integration test**

```python
# backend/test_main_integration.py — inject a fake transport (extract already yields 1 place/reel,
# so ensure the fake extract used here yields >=2 same-day places, or assert 0 legs when <2/day).
    async def transport(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 400, "code": "Ok"} for _ in range(len(coords) - 1)]

    async def run(trip_id, uid, urls, sd, ed, **kw):
        return await runner.run_generation(trip_id, uid, urls, sd, ed, job_id=kw.get("job_id"),
                                           scrape=scrape, extract=extract, weather=weather, transport=transport)
    # ... after the trip_days assertion, if the fake extract yields >=2 places on a day:
        legs = (await client.table("transport_legs").select("status,duration_seconds,leg_order")
                .eq("trip_id", trip_id).execute()).data
        # extract yields >=2 same-day places → expect legs; assert the table is reachable + shaped
        assert all(l["status"] in ("ok", "no_route") for l in legs)
```
If the integration test's `extract` yields only 1 place (→ 0 legs), either extend it to yield 2 coord-bearing places on day 1, or assert `legs == []` explicitly (still proves the path runs without error). Prefer yielding 2 places so a real leg lands.

- [ ] **Step 2: Run the live gate**

Run: `cd backend && RUN_DB_INTEGRATION=1 uv run --env-file .env pytest test_main_integration.py -v -m integration`
Expected: PASS.

- [ ] **Step 3: Commit + real smoke**

```bash
git add backend/test_main_integration.py
git commit -m "test(api): assert transport_legs land in the live integration gate"
```
Then a real end-to-end check (spends credits): `uv run --env-file .env python -m scripts.live_run --start <today+5> --end <today+7>` and confirm `transport_legs` rows exist for the printed trip (query in Supabase or add a leg count to the smoke tool's inspect if desired).

---

## Self-Review

**Spec coverage:** Mapbox Directions one-call-per-day (lng,lat order, overview=false, code check, sanitized errors) ✅ · `transport_legs` schema (mode≠profile mapping, all CHECKs, composite trip_day_id, service-role) ✅ · ordering (persist_transport strictly after persist_itinerary; retry-safe delete) ✅ · partial-failure isolation (fetch + persist non-critical; transport failure ≠ degrade/fail) ✅ · eval-safety (out of offline path; import-keyless; MockTransport tests) ✅ · injectable transport (no network in unit/runner tests) ✅ · live-verified ✅.

**Placeholder scan:** complete code + commands throughout (Task 4's integration snippet notes the >=2-places condition explicitly).

**Type consistency:** `fetch_directions_legs(coords[(lat,lng)], *, profile, client) -> list[dict{duration_s,distance_m,code}]`, `persist_transport(client, trip_id, *, profile, fetch_legs) -> int`, `profile_to_mode(profile) -> str`, `TransportLeg(...)` consistent across tasks.

**Risks for review:**
1. **lng,lat inversion** — the single most common Mapbox bug; the URL-order test pins it (longitude first).
2. **Token leak** — `raise_for_status()` is banned; the sanitized-error test asserts no token/url in the message.
3. **code != Ok on HTTP 200** — NoRoute/NoSegment must become `status='no_route'`, not a crash; covered by a test.
4. **Existing runner tests hitting real Mapbox** — every `run_generation` call must inject `transport=_no_transport` (mirror `_no_weather`).
5. **Fake `.in_()`** — persist_transport reads `places` with `.in_()`; the test fake must support it (added in Task 2 Step 3).
