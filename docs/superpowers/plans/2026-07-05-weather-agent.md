# Weather Enrich Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The first Phase-3 enrich agent — fetch per-day weather from Open-Meteo for a generated trip and persist it to `trip_days.weather_*`, run as a partial-failure-isolated stage that never fails the trip. Establishes the Phase-3-gather + additive-persist template the other enrich agents follow.

**Architecture:** `genagents/weather.py::fetch_weather(lat, lng, dates)` calls Open-Meteo's forecast endpoint (direct HTTP, no auth, no LLM) once for a trip-wide **centroid** over the canonical places, mapping WMO `weather_code` → a human summary. The runner calls it after narrate in its own `try/except` (guardrail #3 — weather failing degrades to no-weather, never aborts), and after `persist_itinerary` has created the `trip_days` rows, `persist_weather` does an additive `UPDATE trip_days SET weather_*`. Out of the offline #16 eval entirely (live HTTP); `httpx.MockTransport` for tests.

**Tech Stack:** `httpx.AsyncClient` (already a dep; direct HTTP like `scrape/apify_direct.py`), Open-Meteo `/v1/forecast`, async `supabase-py`, pytest + `httpx.MockTransport`.

## Global Constraints

- **Open-Meteo contract** (verified against open-meteo.com): `GET https://api.open-meteo.com/v1/forecast` with `latitude`, `longitude`, `daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code`, `start_date`, `end_date`, `timezone=auto`. No API key (free/non-commercial). Response `daily` has index-aligned arrays (`time[]`, `temperature_2m_max[]`, …). Forecast horizon ≤16 days — dates beyond it come back with `null`/absent values; skip those days (do NOT reach for the Climate API — deferred behind a "trips-created->16-days-out is measured" trigger).
- **`trip_days.weather_*` schema** (`supabase/migrations/20260702134839_...sql:1-11`): `weather_summary` (nullable text), `weather_source` (nullable, CHECK ∈ `open_meteo|manual|none`), `weather_payload` (jsonb **NOT NULL default `{}`**, CHECK `jsonb_typeof = 'object'`). Write `weather_source='open_meteo'`, `weather_payload` = a JSON object (a `WeatherReport.model_dump()`). Service-role write (the runner's async client).
- **Ordering (hard dependency):** `persist_itinerary` does delete-then-reinsert of `trip_days`, so `persist_weather` MUST run strictly AFTER `persist_itinerary` returns — an earlier weather write is wiped by the delete, and if the rows don't exist the UPDATE is a silent 0-row no-op.
- **Guardrail #3 (partial failure):** weather is a NON-critical stage. Both the fetch and the persist are wrapped so a failure emits a `warning` event and leaves weather empty — the trip still completes. Do NOT set `saved_with_gaps` for a weather failure (weather is optional enrichment, not a place gap).
- **Guardrail #11 does NOT apply:** Open-Meteo is structured API data, not untrusted reel content through an LLM — no Agents-SDK guardrail needed.
- **Eval-safety:** weather is a LIVE agent — it MUST NOT be imported by `offline_harness.py`/`evals/`; the #16 eval stays credential/network-free (`mean_intra_day_travel_m=6229.0` unchanged). Import-keyless: no module-scope network/`httpx.AsyncClient()`. Tests inject `httpx.AsyncClient(transport=httpx.MockTransport(handler))` (mirror `scrape/test_apify_direct.py`).
- **Injectable:** `run_generation` gains a `weather=None` param (defaults to the real `fetch_weather`), so runner tests inject a fake and never hit the network — same pattern as `scrape`/`extract`.
- **SSE:** emit a `"weather"` stage event (already in the documented stage set — additive, non-breaking).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `backend/models/enrichment.py` | `WeatherReport` Pydantic model (stub → real) | 1 |
| `backend/genagents/weather.py` | `fetch_weather` + WMO→summary map (stub → real) | 1 |
| `backend/pipeline/geo.py` | `centroid(places)` helper | 2 |
| `backend/pipeline/persist.py` | `persist_weather(client, trip_id, reports)` (additive UPDATE) | 2 |
| `backend/pipeline/runner.py` | Phase-3 weather stage + persist wiring (injectable, partial-failure) | 3 |
| `backend/test_main_integration.py` | assert weather lands on `trip_days` in the live gate | 4 |

**Deferred (triggers):** Climate API for >16-day-out trips; per-place / hourly weather; other enrich agents (restaurant/transport/hotel/narrator) — same Phase-3 template.

---

### Task 1: `WeatherReport` model + `genagents/weather.py`

**Files:**
- Modify: `backend/models/enrichment.py`
- Modify: `backend/genagents/weather.py` (currently a comment stub)
- Test: `backend/genagents/test_weather.py` (create)

**Interfaces:**
- Produces: `WeatherReport(date: str, temp_min_c: float, temp_max_c: float, precipitation_mm: float, weather_code: int, summary: str)`.
- Produces: `async def fetch_weather(lat: float, lng: float, dates: list[str], *, client: httpx.AsyncClient | None = None) -> list[WeatherReport]` — one WeatherReport per date with data; raises `httpx.HTTPError`/`RuntimeError` on a bad response (caller isolates it).

- [ ] **Step 1: Write the failing tests**

```python
# backend/genagents/test_weather.py
import httpx
import pytest

from genagents.weather import _wmo_summary, fetch_weather


def test_wmo_summary_buckets():
    assert _wmo_summary(0) == "Clear"
    assert _wmo_summary(2) == "Partly cloudy"
    assert _wmo_summary(63) == "Rain"
    assert _wmo_summary(75) == "Snow"
    assert _wmo_summary(95) == "Thunderstorm"
    assert _wmo_summary(9999) == "Unknown"


def _mock(daily: dict) -> httpx.AsyncClient:
    def handler(request):
        assert "open-meteo.com" in str(request.url)
        return httpx.Response(200, json={"daily": daily})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_weather_maps_daily_arrays():
    async with _mock({
        "time": ["2026-08-01", "2026-08-02"],
        "temperature_2m_max": [31.2, 29.0],
        "temperature_2m_min": [24.1, 23.5],
        "precipitation_sum": [0.0, 4.2],
        "weather_code": [2, 63],
    }) as client:
        reports = await fetch_weather(35.66, 139.75, ["2026-08-01", "2026-08-02"], client=client)
    assert len(reports) == 2
    assert reports[0].date == "2026-08-01" and reports[0].weather_code == 2
    assert reports[0].summary.startswith("Partly cloudy")
    assert reports[1].summary.startswith("Rain")
    assert reports[1].precipitation_mm == 4.2


@pytest.mark.asyncio
async def test_fetch_weather_skips_null_days_beyond_horizon():
    async with _mock({
        "time": ["2026-08-01", "2026-08-02"],
        "temperature_2m_max": [31.2, None],
        "temperature_2m_min": [24.1, None],
        "precipitation_sum": [0.0, None],
        "weather_code": [2, None],
    }) as client:
        reports = await fetch_weather(35.66, 139.75, ["2026-08-01", "2026-08-02"], client=client)
    assert len(reports) == 1 and reports[0].date == "2026-08-01"


@pytest.mark.asyncio
async def test_fetch_weather_empty_dates_returns_empty():
    reports = await fetch_weather(35.66, 139.75, [])   # no network call
    assert reports == []


@pytest.mark.asyncio
async def test_fetch_weather_raises_on_http_error():
    def handler(request): return httpx.Response(500)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await fetch_weather(35.66, 139.75, ["2026-08-01"], client=client)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest genagents/test_weather.py -v`
Expected: FAIL — `genagents.weather` has no `fetch_weather`/`_wmo_summary`.

- [ ] **Step 3: Implement the model + agent**

```python
# backend/models/enrichment.py
"""Enrichment models (Phase 3/4). WeatherReport is live; the rest arrive with their agents."""
from __future__ import annotations

from pydantic import BaseModel


class WeatherReport(BaseModel):
    date: str                # ISO yyyy-mm-dd, matches trip_days.day_date
    temp_min_c: float
    temp_max_c: float
    precipitation_mm: float
    weather_code: int        # raw WMO code (payload fidelity)
    summary: str             # human line, e.g. "Partly cloudy, 24-31°C"

# RestaurantSuggestion, TransportLeg, HotelSuggestion — added with their agents.
```

```python
# backend/genagents/weather.py
"""Weather enrich agent — Open-Meteo forecast via direct HTTP. No LLM, no auth, no
Agents SDK (structured API data, not untrusted reel content). Import-keyless: httpx
clients are built inside the function, never at module scope. Live-only — never
imported by the offline eval / offline_harness.
"""
from __future__ import annotations

import httpx

from models.enrichment import WeatherReport

_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_DAILY = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code"


def _wmo_summary(code: int) -> str:
    """Bucket a WMO weather_code (table 4677) to a short human label."""
    if code == 0:
        return "Clear"
    if code in (1, 2, 3):
        return "Partly cloudy"
    if code in (45, 48):
        return "Fog"
    if code in (51, 53, 55, 56, 57):
        return "Drizzle"
    if code in (61, 63, 65, 66, 67):
        return "Rain"
    if code in (71, 73, 75, 77):
        return "Snow"
    if code in (80, 81, 82):
        return "Showers"
    if code in (85, 86):
        return "Snow showers"
    if code in (95, 96, 99):
        return "Thunderstorm"
    return "Unknown"


async def fetch_weather(lat, lng, dates, *, client: httpx.AsyncClient | None = None) -> list[WeatherReport]:
    """Per-day forecast for lat/lng across the trip's date range. Returns a WeatherReport
    per date that has data (dates beyond the ~16-day horizon come back null → skipped).
    Raises on a non-2xx response — the caller isolates weather as a non-critical stage."""
    if not dates:
        return []
    params = {"latitude": lat, "longitude": lng, "daily": _DAILY,
              "start_date": dates[0], "end_date": dates[-1], "timezone": "auto"}
    owns = client is None
    http = client or httpx.AsyncClient(timeout=30)
    try:
        resp = await http.get(_FORECAST_URL, params=params)
    finally:
        if owns:
            await http.aclose()
    resp.raise_for_status()
    daily = resp.json().get("daily", {})
    times = daily.get("time", []) or []
    tmax = daily.get("temperature_2m_max", []) or []
    tmin = daily.get("temperature_2m_min", []) or []
    precip = daily.get("precipitation_sum", []) or []
    codes = daily.get("weather_code", []) or []
    reports: list[WeatherReport] = []
    for i, day in enumerate(times):
        if i >= len(codes) or codes[i] is None or i >= len(tmax) or tmax[i] is None \
                or i >= len(tmin) or tmin[i] is None:
            continue                                   # skip out-of-horizon / missing days
        code = int(codes[i])
        p = precip[i] if i < len(precip) and precip[i] is not None else 0.0
        reports.append(WeatherReport(
            date=day, temp_min_c=float(tmin[i]), temp_max_c=float(tmax[i]),
            precipitation_mm=float(p), weather_code=code,
            summary=f"{_wmo_summary(code)}, {round(tmin[i])}-{round(tmax[i])}°C"))
    return reports
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest genagents/test_weather.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Keyless import + eval untouched**

Run: `cd backend && env -i PATH="$PATH" HOME="$HOME" uv run python -c "import genagents.weather, models.enrichment"` (OK, no network) && `uv run python -m evals.run_eval --subject pipeline` (still PASS 6229.0 — weather isn't in the offline path).

- [ ] **Step 6: Commit**

```bash
git add backend/models/enrichment.py backend/genagents/weather.py backend/genagents/test_weather.py
git commit -m "feat(genagents): weather agent — Open-Meteo forecast → WeatherReport (direct HTTP, no auth)"
```

---

### Task 2: `centroid` helper + `persist_weather`

**Files:**
- Modify: `backend/pipeline/geo.py` (add `centroid`)
- Modify: `backend/pipeline/persist.py` (add `persist_weather`)
- Test: `backend/pipeline/test_geo.py` (extend), `backend/pipeline/test_persist.py` (extend)

**Interfaces:**
- Produces: `centroid(places) -> tuple[float, float] | None` — mean (lat, lng) over coord-bearing places; `None` if none have coords.
- Produces: `async def persist_weather(client, trip_id: str, reports: list[WeatherReport]) -> None` — additive `UPDATE trip_days SET weather_summary/source/payload WHERE trip_id AND day_date`.

- [ ] **Step 1: Write the failing tests**

```python
# backend/pipeline/test_geo.py  (add)
from pipeline.geo import centroid


class _P:
    def __init__(self, lat, lng): self.lat, self.lng = lat, lng


def test_centroid_mean_of_coord_bearing():
    assert centroid([_P(0.0, 0.0), _P(2.0, 4.0)]) == (1.0, 2.0)


def test_centroid_ignores_no_coord_and_none_when_empty():
    assert centroid([_P(10.0, 20.0), _P(None, None)]) == (10.0, 20.0)
    assert centroid([_P(None, None)]) is None
    assert centroid([]) is None
```

```python
# backend/pipeline/test_persist.py  (add; reuse the file's async fake _Client/_Table)
from models.enrichment import WeatherReport
from pipeline import persist as _persist


@pytest.mark.asyncio
async def test_persist_weather_updates_trip_days_by_date():
    c = _Client({"trip_days": [
        {"id": "d1", "trip_id": "trip-1", "day_number": 1, "day_date": "2026-08-01"},
        {"id": "d2", "trip_id": "trip-1", "day_number": 2, "day_date": "2026-08-02"},
    ]})
    reports = [WeatherReport(date="2026-08-01", temp_min_c=24.0, temp_max_c=31.0,
                             precipitation_mm=0.0, weather_code=2, summary="Partly cloudy, 24-31°C")]
    await _persist.persist_weather(c, "trip-1", reports)
    d1 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-01"][0]
    assert d1["weather_source"] == "open_meteo"
    assert d1["weather_summary"].startswith("Partly cloudy")
    assert d1["weather_payload"]["weather_code"] == 2
    d2 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-02"][0]
    assert "weather_source" not in d2  # untouched day (no report)
```

Note: the persist test's fake `_Table.update()` must apply to the matched rows and its `execute()` return them (the file's fake already supports `update`+`eq`; confirm it filters correctly on two `.eq(...)`).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_geo.py -k centroid pipeline/test_persist.py -k persist_weather -v`
Expected: FAIL — `centroid`/`persist_weather` undefined.

- [ ] **Step 3: Implement**

```python
# backend/pipeline/geo.py  (add)
def centroid(places) -> tuple[float, float] | None:
    """Mean (lat, lng) over places that have coordinates; None if none do."""
    pts = [(p.lat, p.lng) for p in places if p.lat is not None and p.lng is not None]
    if not pts:
        return None
    return (sum(la for la, _ in pts) / len(pts), sum(ln for _, ln in pts) / len(pts))
```

```python
# backend/pipeline/persist.py  (add; import WeatherReport at top)
from models.enrichment import WeatherReport   # add to imports


async def persist_weather(client, trip_id: str, reports: list[WeatherReport]) -> None:
    """Additive: write each day's weather onto the existing trip_days row (matched by
    day_date). MUST run AFTER persist_itinerary has (re)created the trip_days rows —
    an earlier write is wiped by persist's delete, and a missing row is a silent no-op."""
    for r in reports:
        await client.table("trip_days").update({
            "weather_summary": r.summary,
            "weather_source": "open_meteo",
            "weather_payload": r.model_dump(),
        }).eq("trip_id", trip_id).eq("day_date", r.date).execute()
```

- [ ] **Step 4: Run to verify they pass + eval untouched**

Run: `cd backend && uv run pytest pipeline/test_geo.py pipeline/test_persist.py -v && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS 6229.0.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/geo.py backend/pipeline/persist.py backend/pipeline/test_geo.py backend/pipeline/test_persist.py
git commit -m "feat(pipeline): centroid helper + additive persist_weather (UPDATE trip_days.weather_*)"
```

---

### Task 3: Wire the weather stage into the runner (Phase 3, partial-failure)

**Files:**
- Modify: `backend/pipeline/runner.py`
- Test: `backend/pipeline/test_runner.py` (extend)

**Interfaces:**
- Consumes: `fetch_weather` (Task 1), `centroid` (Task 2), `persist_weather` (Task 2).
- Behavior: `run_generation` gains `weather=None` (defaults to `fetch_weather`, injected inside the function). After narrate: emit a `weather` stage event, compute the `centroid(canonical)`, and (if a centroid exists) `await weather(lat, lng, dates)` in a `try/except` → on failure emit a `warning` (stage `weather`) and continue with no reports. After `persist_itinerary` succeeds in the save stage, if there are reports, `await persist_weather(...)` in its own `try/except` (a weather-persist failure emits a warning, does NOT change `status` — weather is optional enrichment).

- [ ] **Step 1: Write the failing tests**

```python
# backend/pipeline/test_runner.py  (add)
from models.enrichment import WeatherReport


@pytest.mark.asyncio
async def test_runner_persists_weather_on_trip_days():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def weather(lat, lng, dates):
        return [WeatherReport(date=d, temp_min_c=24.0, temp_max_c=31.0, precipitation_mm=0.0,
                              weather_code=2, summary="Partly cloudy, 24-31°C") for d in dates]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract, weather=weather)
    td = c.db["trip_days"]
    assert td and td[0].get("weather_source") == "open_meteo"
    assert td[0].get("weather_summary")
    assert any(e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # weather success does not degrade


@pytest.mark.asyncio
async def test_runner_weather_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def weather(lat, lng, dates): raise RuntimeError("open-meteo down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract, weather=weather)
    assert out["itinerary"]["days"]                        # trip still produced
    assert any(e["event_type"] == "warning" and e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # weather failure does NOT degrade or fail
    assert c.db["jobs"][0]["status"] == "succeeded"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_runner.py -k weather -v`
Expected: FAIL — runner has no weather stage.

- [ ] **Step 3: Wire the runner**

```python
# backend/pipeline/runner.py
# imports (add):
from pipeline.geo import centroid
from pipeline.persist import persist_itinerary, persist_weather

# run_generation signature: add `weather=None` alongside scrape/extract.
async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                         *, job_id=None, pace="balanced", client=None, scrape=None, extract=None, weather=None):
    ...
    # inside the try, after the default-injection of scrape/extract:
    if weather is None:
        from genagents.weather import fetch_weather
        weather = fetch_weather
    ...
    # NARRATE stage stays; it assigns `dates = _date_range(start_date, end_date)`.
    # NEW — WEATHER stage, after narrate, before the save stage:
        await record_event(client, trip_id, event_type="stage", stage="weather", message="fetching weather")
        weather_reports = []
        center = centroid(canonical)
        if center is not None:
            try:
                weather_reports = await weather(center[0], center[1], dates)
            except Exception:
                await record_event(client, trip_id, event_type="warning", stage="weather",
                                   message="weather unavailable")
    # SAVE stage — after persist_itinerary + the dropped-count handling, before _set_status:
        try:
            dropped = await persist_itinerary(client, trip_id, canonical, dates)
            if dropped:
                status = "saved_with_gaps"
                await record_event(client, trip_id, event_type="warning", stage="save",
                                   message=f"{dropped} place(s) shown in the itinerary were not saved "
                                           "(missing coordinates or merged with an existing place)")
            if weather_reports:                       # weather AFTER persist created trip_days (ordering!)
                try:
                    await persist_weather(client, trip_id, weather_reports)
                except Exception:
                    await record_event(client, trip_id, event_type="warning", stage="weather",
                                       message="weather persist failed")
        except Exception:
            status = "saved_with_gaps"
            await record_event(client, trip_id, event_type="warning", stage="save",
                               message="normalized persistence failed; itinerary saved to the result event only")
        await _set_status(client, trip_id, user_id, status)
        ...
```

(Only the narrate/save region changes; scrape/extract/dedup and `_fail` are untouched. `persist_weather` is inside the `persist_itinerary` try so a persist-layer exception still routes correctly, but the weather-persist has its own inner try so its failure is a warning, not a trip failure.)

- [ ] **Step 4: Run to verify they pass + eval untouched**

Run: `cd backend && uv run pytest pipeline/test_runner.py -v && uv run pytest pipeline/ evals/ -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all PASS; eval OVERALL PASS 6229.0; keyless `import pipeline.runner`.

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(pipeline): Phase-3 weather stage — fetch + additive persist, partial-failure isolated"
```

---

### Task 4: Extend the live gate to assert weather lands

**Files:**
- Modify: `backend/test_main_integration.py`

**Behavior:** the live integration test injects fake scrape/extract but should use the REAL `fetch_weather` (Open-Meteo is free/no-auth, so a live weather call is cheap and proves the end-to-end path) OR inject a fake weather to stay hermetic. Recommend: inject a **fake weather** (deterministic, no dependency on Open-Meteo uptime in CI) and assert `trip_days.weather_source == 'open_meteo'` + a non-empty `weather_summary`. Add an optional second assertion path (behind an env flag) that uses real Open-Meteo if desired.

- [ ] **Step 1: Add weather to the integration test**

```python
# backend/test_main_integration.py — inject a fake weather into the monkeypatched run, and assert
    from models.enrichment import WeatherReport

    async def weather(lat, lng, dates):
        return [WeatherReport(date=d, temp_min_c=24.0, temp_max_c=31.0, precipitation_mm=0.0,
                              weather_code=2, summary="Partly cloudy, 24-31°C") for d in dates]

    async def run(trip_id, uid, urls, sd, ed, **kw):
        return await runner.run_generation(trip_id, uid, urls, sd, ed, job_id=kw.get("job_id"),
                                           scrape=scrape, extract=extract, weather=weather)
    # ... after the trip_days assertion:
        trip_days = (await client.table("trip_days").select("day_number,weather_source,weather_summary")
                     .eq("trip_id", trip_id).execute()).data
        assert trip_days, "expected trip_days rows"
        assert any(d["weather_source"] == "open_meteo" and d["weather_summary"] for d in trip_days)
```

- [ ] **Step 2: Run the live gate**

Run: `cd backend && RUN_DB_INTEGRATION=1 uv run --env-file .env pytest test_main_integration.py -v -m integration`
Expected: PASS — the real trip's `trip_days` carry `weather_source='open_meteo'` + a summary.

- [ ] **Step 3: Commit**

```bash
git add backend/test_main_integration.py
git commit -m "test(api): assert weather lands on trip_days in the live integration gate"
```

---

## Self-Review

**Spec coverage:** Open-Meteo forecast fetch (centroid, WMO→summary, horizon-null skip) ✅ · `trip_days.weather_*` additive UPDATE with the correct source enum + jsonb-object payload ✅ · ordering (persist_weather strictly after persist_itinerary) ✅ · partial-failure isolation (fetch + persist both non-critical, weather failure ≠ degrade/fail) ✅ · eval-safety (weather out of the offline path; import-keyless; MockTransport tests) ✅ · injectable weather (no network in unit/runner tests) ✅ · live-verified ✅.

**Placeholder scan:** complete code + exact commands throughout.

**Type consistency:** `fetch_weather(lat, lng, dates, *, client)`, `centroid(places) -> tuple|None`, `persist_weather(client, trip_id, reports)`, `WeatherReport(date, temp_min_c, temp_max_c, precipitation_mm, weather_code, summary)` consistent across tasks.

**Risks for review:**
1. **Weather-persist ordering** — the single most important correctness point: `persist_weather` matches `trip_days` by `(trip_id, day_date)` and MUST run after `persist_itinerary` recreated them. If persist failed (its `except`), `weather_reports` are simply never written (the `if weather_reports` is inside the persist try) — acceptable (no trip_days to attach to).
2. **Centroid over a spread-out trip** — a single centroid point can be far from an outlier place's actual location; acceptable for a trip-level weather line at ≤8 places (per-place weather is the deferred enhancement).
3. **>16-day horizon** — handled by skipping null days in `fetch_weather`; a fully-out-of-horizon trip yields `[]` reports (no weather rows), trip still completes. The Climate API fallback is deferred behind a measured trigger.
