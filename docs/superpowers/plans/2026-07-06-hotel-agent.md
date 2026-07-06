# Hotel Enrich Agent Implementation Plan (Travala search)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Astrail's hotel enrich agent — a keyless HTTP call to the Travala Travel MCP `travala_search_hotel` (search/suggestions only) that finds hotels for the trip's destination + dates + occupancy and persists them to the existing `hotel_suggestions` table, as a best-effort per-trip stage.

**Architecture:** The simplest enrich agent — NO LLM, NO new Pydantic model, NO migration. A keyless `httpx` JSON-RPC POST to the hosted Travala MCP (SSE-framed response) returns `(session_id, list[dict])`; `persist_hotels` reads the trip row for dates/occupancy, derives the search city from `places.city`, maps the hotel dicts to `hotel_suggestions` columns, and the runner wires it as a best-effort `hotels` stage (guardrail #3). Per-trip (one search), not per-day/place.

**Tech Stack:** Python 3.14 · `httpx` (already a dep) · async supabase-py · pytest + `httpx.MockTransport`. Travala hotel *search* is keyless (no key/OAuth/wallet) — the `hotel_suggestions` table + `HotelSuggestion` TS type already shipped in the foundation.

## Global Constraints

- **Search-only (STACK.md / PRD):** call ONLY `travala_search_hotel` (optionally `travala_search_package` later). NEVER `travala_book` / booking / payment / cancellation / x402 tools in v1.
- **Keyless:** Travala search needs no key/OAuth — call via a DIRECT `httpx` JSON-RPC POST (the Apify direct-HTTP pattern, guardrail #10), NOT an MCP client / session MCP. No env var; do NOT add Travala to `.mcp.json`.
- **Guardrail #3 (partial failure):** best-effort stage — a hotel-search failure (network, malformed response, DB error) NEVER fails or degrades the trip. Warning event only; does not set `saved_with_gaps`/`failed`.
- **Skip-on-missing (PRD §17 / DECISIONS LOG 2026-06-23):** if destination/dates are missing, SKIP hotel search (return 0, no fetch) — never block trip generation.
- **No new dependency, no migration, no frontend change:** the `hotel_suggestions` table + CHECKs (star_rating `null|0..5`, source `travala|manual|agent`, status `suggested|unavailable|skipped|failed`) + `HotelSuggestion` TS mirror + the `hotels` SSE stage are all already shipped.
- **#16 eval-safety:** live-only, import-keyless; `genagents/hotel.py` + `persist_hotels` never imported by `offline_harness.py` / `evals/*`; `mean_intra_day_travel_m` untouched.
- **No secrets in logs/exceptions.** (Travala is keyless, so there's no token — but still sanitize errors to a token-free `RuntimeError`.) No commit attribution line.

## File Structure

- **Create** `backend/genagents/hotel.py` — the keyless Travala fetch + SSE parse.
- **Create** `backend/genagents/test_hotel.py` — offline tests (`httpx.MockTransport`).
- **Modify** `backend/pipeline/persist.py` — `persist_hotels` + two pure helpers.
- **Modify** `backend/pipeline/test_persist.py` — `persist_hotels` tests.
- **Modify** `backend/pipeline/runner.py` — `hotel=None` + best-effort `hotels` stage.
- **Modify** `backend/pipeline/test_runner.py` — inject `hotel=_no_hotel` into every call + 2 new tests.
- **Modify** `backend/test_main_integration.py` — hotel fake + assert hotel_suggestions land.
- **Modify** `backend/scripts/live_run.py` — `_inspect` prints hotel_suggestions.

---

### Task 1: Travala fetch module

**Files:**
- Create: `backend/genagents/hotel.py`
- Create: `backend/genagents/test_hotel.py`

**Interfaces:**
- Produces: `search_hotels(location: str, check_in: str, check_out: str, rooms: list[str], *, client=None) -> tuple[str|None, list[dict]]` — consumed by `persist_hotels` (Task 2); `_parse_sse` (pure helper).

- [ ] **Step 1: Write the failing tests** — `backend/genagents/test_hotel.py`

```python
"""Hotel-search tests. Pure SSE parse + injected-client logic stay offline (Travala is keyless, but
MockTransport keeps pytest network-free). The real call is one @pytest.mark.live test, skipped by default."""
import httpx
import pytest

from genagents.hotel import _parse_sse, search_hotels

# One SSE-framed JSON-RPC response: result.content[0].text = a JSON string with hotels + sessionId.
_HOTELS_TEXT = (
    '{"sessionId":"sess-1","totalFound":2,"hotels":['
    '{"name":"Park Hyatt Tokyo","star":5,"rating":9.6,"pricePerNight":1176,"totalPrice":1176,'
    '"currency":"USD","hotelId":13278,"packageId":"pkg-a","headline":"In Tokyo (Shinjuku)"},'
    '{"name":"APA Nishishinjuku","star":3,"pricePerNight":181,"totalPrice":181,"currency":"USD",'
    '"hotelId":44978,"packageId":"pkg-b","address":"Nishishinjuku"}]}'
)
_SSE_BODY = ('event: message\n'
             'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":'
             + __import__("json").dumps(_HOTELS_TEXT) + '}]}}\n\n')


def _mock_client(text=None, *, status=200, payload=None):
    def handler(request):
        if payload is not None:
            return httpx.Response(status, json=payload)
        return httpx.Response(status, text=text)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_parse_sse_concats_data_lines():
    msg = _parse_sse('event: message\ndata: {"a":\ndata: 1}\n\n')
    assert msg == {"a": 1}


def test_parse_sse_empty_raises():
    with pytest.raises(RuntimeError):
        _parse_sse("event: ping\n\n")


async def test_search_hotels_parses():
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(_SSE_BODY))
    assert session == "sess-1"
    assert [h["name"] for h in hotels] == ["Park Hyatt Tokyo", "APA Nishishinjuku"]
    assert hotels[0]["star"] == 5 and hotels[0]["hotelId"] == 13278


async def test_search_hotels_non_200_raises():
    with pytest.raises(RuntimeError) as exc:
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                            client=_mock_client("nope", status=502))
    assert "502" in str(exc.value)


async def test_search_hotels_request_error_sanitized():
    def boom(request):
        raise httpx.ConnectError("boom")
    client = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    with pytest.raises(RuntimeError) as exc:
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"], client=client)
    assert "ConnectError" in str(exc.value)


async def test_search_hotels_jsonrpc_error_raises():
    body = 'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"bad"}}\n\n'
    with pytest.raises(RuntimeError):
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"], client=_mock_client(body))


async def test_search_hotels_empty_content_returns_empty():
    body = 'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(body))
    assert session is None and hotels == []


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    import genagents.hotel as h
    importlib.reload(h)
    assert h._parse_sse('data: {"x":1}\n') == {"x": 1}


@pytest.mark.live
async def test_live_search_hotels_tokyo():
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"])
    assert hotels and all(h.get("name") for h in hotels)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest genagents/test_hotel.py -q`
Expected: FAIL (`No module named 'genagents.hotel'`).

- [ ] **Step 3: Write `backend/genagents/hotel.py`**

```python
"""Hotel enricher — Travala Travel MCP hotel search (SEARCH-ONLY, keyless HTTP).

Import discipline (mirrors transport/restaurant, guardrail #9): imports `httpx` lazily inside the
function; `import genagents.hotel` loads nothing heavy and needs no key.

Live-only — never imported by the offline eval / offline_harness.

Travala hotel SEARCH is KEYLESS (no key/OAuth/wallet) — a hosted Streamable-HTTP MCP. We call it as a
DIRECT httpx JSON-RPC POST (the Apify direct-HTTP pattern, guardrail #10), NOT an MCP client. The
response is SSE-framed (concat `data:` lines). Guardrail: SEARCH ONLY — NEVER travala_book / booking /
payment / x402. No LLM, no reel content → no guardrail #11.
"""
from __future__ import annotations

import json
import sys

_ENDPOINT = "https://travel-mcp.travala.com/mcp"


def _parse_sse(text: str) -> dict:
    """The server answers SSE-framed (data: {...}); concat all `data:` lines into one JSON-RPC msg."""
    data_lines = [ln[len("data:"):].strip() for ln in text.splitlines() if ln.startswith("data:")]
    if not data_lines:
        raise RuntimeError("travala: empty/non-SSE response")
    return json.loads("".join(data_lines))


async def search_hotels(location: str, check_in: str, check_out: str, rooms: list[str],
                        *, client=None) -> tuple[str | None, list[dict]]:
    """Search Travala for hotels in `location` for the dates + rooms. Returns (session_id, hotels),
    hotels = the compact list (each a dict: name/star/pricePerNight/totalPrice/currency/hotelId/
    packageId/headline/…). `client` is injectable (an httpx.AsyncClient) for offline tests.

    Sanitizes transport/HTTP errors into a token-free RuntimeError (there IS no token — keyless);
    a malformed-but-200 body or 0 hotels returns (None/…, []). A propagated error → the runner warns."""
    import httpx

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "travala_search_hotel",
                       "arguments": {"location": location, "checkIn": check_in, "checkOut": check_out,
                                     "rooms": rooms, "response_format": "json"}}}
    owns = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=45)
    try:
        try:
            resp = await client.post(_ENDPOINT, json=body,
                                     headers={"Accept": "application/json, text/event-stream"})
        except httpx.RequestError as e:
            raise RuntimeError(f"travala request failed: {type(e).__name__}") from None
        if resp.status_code != 200:
            raise RuntimeError(f"travala HTTP {resp.status_code}")
        try:
            msg = _parse_sse(resp.text)
        except (ValueError, RuntimeError):
            raise RuntimeError("travala: unparseable response") from None
    finally:
        if owns:
            await client.aclose()

    if "error" in msg:
        raise RuntimeError("travala: JSON-RPC error")   # no payload — avoid leaking anything
    content = (msg.get("result") or {}).get("content") or []
    if not content:
        return None, []
    try:
        payload = json.loads(content[0]["text"])
    except (ValueError, KeyError, IndexError, TypeError):
        return None, []
    hotels = payload.get("hotels") or payload.get("results") or []
    session_id = payload.get("sessionId")
    print(f"  [hotels] location={location} {check_in}..{check_out} -> {len(hotels)} hotels", file=sys.stderr)
    return session_id, hotels
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest genagents/test_hotel.py -q` → PASS (live test deselected).
Run: `cd backend && uv run pytest genagents/ -q` → no collateral.

- [ ] **Step 5: Commit**

```bash
git add backend/genagents/hotel.py backend/genagents/test_hotel.py
git commit -m "feat(hotel): keyless Travala hotel-search fetch (SSE JSON-RPC, search-only)"
```

---

### Task 2: `persist_hotels`

**Files:**
- Modify: `backend/pipeline/persist.py`
- Test: `backend/pipeline/test_persist.py`

**Interfaces:**
- Consumes: `search_hotels` (Task 1, injectable via `fetch=`).
- Produces: `persist_hotels(client, trip_id: str, *, fetch=None) -> int` — consumed by the runner (Task 3); `_hotel_rooms`, `_hotel_star` (pure helpers).

**Design notes:** per-trip (one search). Reads the trip row for dates/occupancy + `places.city` for the location. Skip-on-missing → `return 0`. Delete-first retry-safe (insert-based). `base_place_id=NULL` (Travala has no coords). `check_out ≥ check_in + 1 day` (Travala rejects 0-night). `star_rating` null-safe. A `fetch` failure PROPAGATES → the runner warns (best-effort).

- [ ] **Step 1: Write the failing tests** — append to `backend/pipeline/test_persist.py`

```python
# --- persist_hotels ---------------------------------------------------------
@pytest.mark.asyncio
async def test_persist_hotels_writes_rows_from_trip_and_city():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-03", "adult_count": 2, "room_count": 1,
                            "destination_hint": "Japan"}]})
    await _seed_two_places_one_day(c)   # places carry city="Tokyo" (from _cp)
    seen = {}

    async def fetch(location, check_in, check_out, rooms):
        seen.update(location=location, check_in=check_in, check_out=check_out, rooms=rooms)
        return "sess-1", [{"name": "Park Hyatt Tokyo", "star": 5, "pricePerNight": 900,
                           "totalPrice": 900, "currency": "USD", "hotelId": 13278,
                           "packageId": "pkg-a", "headline": "In Tokyo (Shinjuku)"}]

    written = await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert written == 1
    assert seen["location"] == "Tokyo"                 # derived from places.city, NOT "Japan"
    assert seen["check_in"] == "2026-08-01" and seen["check_out"] == "2026-08-03"
    assert seen["rooms"] == ["2"]
    h = c.db["hotel_suggestions"][0]
    assert h["name"] == "Park Hyatt Tokyo" and h["star_rating"] == 5.0
    assert h["source"] == "travala" and h["status"] == "suggested" and h["base_place_id"] is None
    assert h["travala_hotel_id"] == "13278" and h["travala_session_id"] == "sess-1"
    assert h["price_snapshot"]["currency"] == "USD" and h["travala_result_json"]["name"] == "Park Hyatt Tokyo"


@pytest.mark.asyncio
async def test_persist_hotels_single_day_forces_one_night():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-01", "adult_count": 1, "room_count": 1}]})
    await _seed_two_places_one_day(c)
    seen = {}

    async def fetch(location, check_in, check_out, rooms):
        seen["check_out"] = check_out
        return None, []

    await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert seen["check_out"] == "2026-08-02"            # 0-night -> forced to >=1 night


@pytest.mark.asyncio
async def test_persist_hotels_skips_when_no_location_or_dates():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": None, "end_date": None}]})

    async def fetch(*a, **k):
        raise AssertionError("fetch must not run when dates/location are missing")

    assert await persist.persist_hotels(c, "trip-1", fetch=fetch) == 0


@pytest.mark.asyncio
async def test_persist_hotels_retry_safe_and_star_nullsafe():
    c = _Client({"trips": [{"id": "trip-1", "user_id": "u1", "start_date": "2026-08-01",
                            "end_date": "2026-08-03", "adult_count": 1, "room_count": 1}],
                 "hotel_suggestions": [{"id": "stale", "trip_id": "trip-1", "name": "old"}]})
    await _seed_two_places_one_day(c)

    async def fetch(location, check_in, check_out, rooms):
        return "s", [{"name": "No Star Inn", "star": 9, "pricePerNight": 50, "currency": "USD"},
                     {"star": 3, "pricePerNight": 40}]   # 2nd has NO name -> skipped

    written = await persist.persist_hotels(c, "trip-1", fetch=fetch)
    assert written == 1                                  # stale cleared; no-name row skipped
    rows = c.db["hotel_suggestions"]
    assert len(rows) == 1 and rows[0]["name"] == "No Star Inn"
    assert rows[0]["star_rating"] is None                # star=9 out of [0,5] -> NULL (CHECK-safe)
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_persist.py -q -k hotel`
Expected: FAIL (`persist_hotels` not defined).

- [ ] **Step 3: Add helpers + `persist_hotels` to `backend/pipeline/persist.py`**

Add `import datetime as _dt` to the imports (top of file, next to `import math`), then append after `persist_restaurants`:

```python
def _hotel_rooms(adult_count, room_count) -> list[str]:
    """Occupancy -> Travala `rooms` param (adults-only v1; child ages aren't stored). Split adults
    across rooms, clamp to Travala's 8-room max. Defaults (1 adult/1 room) -> ["1"]."""
    adults = max(1, adult_count or 1)
    n = max(1, min(room_count or 1, 8))
    per = max(1, round(adults / n))
    return [str(per)] * n


def _hotel_star(star) -> float | None:
    """star_rating CHECK is `null OR 0..5`. Coerce to float; out-of-range/unparseable -> None
    (star=0 is legal / unrated)."""
    try:
        s = float(star)
    except (TypeError, ValueError):
        return None
    return s if 0 <= s <= 5 else None


async def persist_hotels(client, trip_id: str, *, fetch=None) -> int:
    """Additive: search Travala for hotels for THIS trip (destination + dates + occupancy) and INSERT
    into hotel_suggestions. Per-TRIP (one search), NOT per-day. Retry-safe (delete-first). Returns
    rows written. `fetch` is injectable (defaults to the real keyless Travala call).

    Reads the trip row for dates/occupancy and derives the search city from the persisted places'
    city ("Tokyo"), falling back to destination_hint. Skip-on-missing (PRD/DECISIONS LOG): if location
    or dates are missing, return 0 WITHOUT searching — hotel search must never block trip generation.
    base_place_id stays NULL (Travala returns no coords; place-linking deferred). No LLM, no reel
    content. A `fetch` failure propagates -> the runner turns it into one clean warning."""
    if fetch is None:
        from genagents.hotel import search_hotels as fetch

    # Retry-safe: clear this trip's rows FIRST (trip_days delete only SET-NULLs trip_day_id).
    await client.table("hotel_suggestions").delete().eq("trip_id", trip_id).execute()

    trip_rows = (await client.table("trips")
                 .select("start_date,end_date,adult_count,room_count,destination_hint")
                 .eq("id", trip_id).execute()).data
    trip = trip_rows[0] if trip_rows else None   # not .maybe_single() — the offline test fake lacks it
    if not trip:
        return 0
    start_date, end_date = trip.get("start_date"), trip.get("end_date")

    # Location: prefer a persisted place's city ("Tokyo"), fall back to destination_hint ("Japan").
    tps = (await client.table("trip_places").select("place_id").eq("trip_id", trip_id).execute()).data
    location = None
    if tps:
        pids = list({tp["place_id"] for tp in tps})
        places = (await client.table("places").select("city").in_("id", pids).execute()).data
        location = next((p.get("city") for p in places if p.get("city")), None)
    location = location or trip.get("destination_hint")

    if not location or not start_date or not end_date:
        return 0   # skip gracefully — never block trip generation

    check_out = end_date
    if end_date <= start_date:   # single-day trip -> force >=1 night (Travala rejects 0 nights)
        check_out = (_dt.date.fromisoformat(start_date) + _dt.timedelta(days=1)).isoformat()
    rooms = _hotel_rooms(trip.get("adult_count"), trip.get("room_count"))

    session_id, hotels = await fetch(location, start_date, check_out, rooms)   # failure -> runner warns

    written = 0
    for h in hotels:
        name = h.get("name")
        if not name:
            continue   # hotel_suggestions.name is NOT NULL
        await client.table("hotel_suggestions").insert({
            "trip_id": trip_id,
            "base_place_id": None,            # Travala gives no coords; place-linking deferred
            "name": name,
            "area": h.get("headline") or h.get("address") or h.get("location"),
            "star_rating": _hotel_star(h.get("star")),
            "price_snapshot": {"pricePerNight": h.get("pricePerNight"),
                               "totalPrice": h.get("totalPrice"), "currency": h.get("currency")},
            "travala_hotel_id": str(h["hotelId"]) if h.get("hotelId") is not None else None,
            "travala_session_id": session_id,
            "travala_package_id": h.get("packageId"),
            "travala_result_json": h,
            "source": "travala",
            "status": "suggested",
        }).execute()
        written += 1
    return written
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_persist.py -q` → PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/persist.py backend/pipeline/test_persist.py
git commit -m "feat(hotel): persist_hotels — per-trip Travala search, city-from-places, CHECK-safe, retry-safe"
```

---

### Task 3: Runner wiring + integration + smoke inspect

**Files:**
- Modify: `backend/pipeline/runner.py`
- Test: `backend/pipeline/test_runner.py`
- Modify: `backend/test_main_integration.py`
- Modify: `backend/scripts/live_run.py`

**Interfaces:**
- Consumes: `persist_hotels` (Task 2).
- Produces: `run_generation(..., restaurant=None, narrator=None, hotel=None)`.

- [ ] **Step 1: Update the tests** — `backend/pipeline/test_runner.py`

Add the fake beside `_no_narrator`:

```python
async def _no_hotel(*_a, **_k):
    return (None, [])
```

Add `hotel=_no_hotel` to the kwargs of EVERY existing `runner.run_generation(...)` call in the file. Then append two tests:

```python
@pytest.mark.asyncio
async def test_runner_persists_hotel_suggestions():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    # persist_hotels READS the trips row (dates/occupancy) — the runner only UPDATEs trips, never
    # inserts, so seed it. destination_hint is the location fallback (the fake places carry no city).
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 2, "room_count": 1,
                      "destination_hint": "Tokyo"}]
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def hotel(location, check_in, check_out, rooms):
        return "sess-1", [{"name": "Park Hyatt Tokyo", "star": 5, "pricePerNight": 900,
                           "currency": "USD", "hotelId": 13278, "packageId": "pkg-a"}]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=_no_narrator, hotel=hotel)
    hs = c.db.get("hotel_suggestions")
    assert hs and hs[0]["name"] == "Park Hyatt Tokyo" and hs[0]["source"] == "travala"
    assert any(e["stage"] == "hotels" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # 2 places / 1 day -> no blank day -> not degraded


@pytest.mark.asyncio
async def test_runner_hotel_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 1, "room_count": 1,
                      "destination_hint": "Tokyo"}]
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def hotel(location, check_in, check_out, rooms): raise RuntimeError("travala down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "hotels" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # hotel failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"
```

Note: both tests use 2 coord-bearing places over a SINGLE day so there is no blank-day degradation (status stays `complete`), and they seed a `trips` row because `persist_hotels` reads it (the runner only UPDATEs trips). The single-day span exercises `persist_hotels`' night-force (`check_out = start+1`) — fine, that's the search's checkout, not the itinerary.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_runner.py -q`
Expected: FAIL (no `hotels` stage / no hotel_suggestions).

- [ ] **Step 3: Wire the runner** — `backend/pipeline/runner.py`

(a) Import (line 24): add `persist_hotels`:
```python
from pipeline.persist import persist_hotels, persist_itinerary, persist_narration, persist_restaurants, persist_transport, persist_weather
```

(b) Signature (line 69): `restaurant=None, narrator=None, hotel=None) -> dict:`

(c) Insert the hotels stage AFTER the restaurant stage's `except` block and BEFORE the narration stage (order: weather → transport → restaurant → **hotels** → narration; narration stays last so it can eventually summarize hotels too):

```python
            try:
                await record_event(client, trip_id, event_type="stage", stage="hotels",
                                   message="searching hotels")
                await persist_hotels(client, trip_id, fetch=hotel)
            except Exception:
                try:
                    await record_event(client, trip_id, event_type="warning", stage="hotels",
                                       message="hotel suggestions unavailable")
                except Exception:
                    pass   # best-effort — hotel failure is non-critical, never fails the trip
```

(d) Update the module docstring: "Weather, transport, restaurants, and narration (Phase-3) are live" → "Weather, transport, restaurants, hotels, and narration (Phase-3) are live"; drop "Remaining: hotel search (Travala)." (now done).

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_runner.py -q` → PASS.

- [ ] **Step 5: Integration test** — `backend/test_main_integration.py`

Add a fake beside `narrator_fn`:

```python
    async def hotel_fn(location, check_in, check_out, rooms):
        # Deterministic fake (real Travala needs network) — proves persist -> hotel_suggestions.
        return "sess-int", [{"name": "Grand Hyatt Tokyo", "star": 5, "pricePerNight": 500,
                             "totalPrice": 1000, "currency": "USD", "hotelId": 18119,
                             "packageId": "pkg-int", "headline": "In Tokyo (Roppongi)"}]
```

**Make the location resolvable:** give the two fake extract `PlaceResult`s `city_or_region_guess="Tokyo"` (in the `extract` fake, `test_main_integration.py:~74-82`) — otherwise `places.city` is None AND the request sends no `destination_hint`, so `persist_hotels` derives no location and skips (returns 0), and the hotel assertion below fails at `RUN_DB_INTEGRATION`/live-verify. (Alternatively add `"destination_hint": "Tokyo"` to the request JSON — but adding the city exercises the primary `places.city` derivation path.)

Inject `hotel=hotel_fn` in the `run` wrapper's `run_generation(...)` call. After the narration assertions, add:

```python
        # Hotel suggestions landed additively (Phase-3): per-trip Travala search.
        hs = (await client.table("hotel_suggestions")
              .select("name,source,status,star_rating,travala_hotel_id").eq("trip_id", trip_id).execute()).data
        assert hs and all(h["source"] == "travala" and h["status"] == "suggested" for h in hs)
        assert hs[0]["name"] and hs[0]["travala_hotel_id"]
```

- [ ] **Step 6: Extend the smoke tool** — `backend/scripts/live_run.py`

Add a `hotel_suggestions` block to `_inspect` (after the restaurant block):

```python
    hotels = (
        await client.table("hotel_suggestions")
        .select("name,area,star_rating,price_snapshot,status").eq("trip_id", trip_id).execute()
    ).data
    print(f"=== hotel_suggestions: {len(hotels)}")
    for h in hotels:
        price = (h.get("price_snapshot") or {})
        star = h.get("star_rating")
        print(f"    {h.get('name')}  ★{star if star is not None else '-'}  "
              f"{price.get('pricePerNight')}/{price.get('currency')}  [{h.get('area') or ''}]")
```

(No automated test — verified by the live smoke run.)

- [ ] **Step 7: Full suite + eval-safety**

Run: `cd backend && uv run pytest -q` → PASS.
Run: `cd backend && uv run pytest evals/ -q` → PASS (hotel absent from the eval import graph; `mean_intra_day_travel_m` unchanged).
Run: `cd backend && python -c "import ast; ast.parse(open('test_main_integration.py').read())"` → OK.

- [ ] **Step 8: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py backend/test_main_integration.py backend/scripts/live_run.py
git commit -m "feat(hotel): wire Travala hotel search as a best-effort hotels stage + integration + smoke inspect"
```

---

## Deferred (documented, with triggers)

- **Place-linking (`base_place_id`):** Travala returns no coords, so hotels aren't map-pinned in v1. Trigger = geocode the hotel name/area (Mapbox) or Travala adds coords → resolve `base_place_id`.
- **Child-age occupancy:** v1 is adults-only (`rooms=[str(adult_count)]`). Trigger = the Trip Brief captures child ages → build the `"2,age"` room tokens.
- **Multi-city hotel search:** v1 searches the first `places.city`. Trigger = multi-city trips → search per city cluster.
- **`travala_search_package`:** richer rate-plan detail for a selected hotel — deferred (search-only v1). Booking/OAuth/USDC/x402 tools are OUT of v1 entirely.
- **`preference_match_json`:** stays `{}` until user preferences are wired (Step 9 / mem0).

## Arc verification (after all tasks)

1. **Final whole-branch review** — dispatch `astrail-reviewer` (spec, guardrails #3 / search-only / #10 direct-HTTP, CHECK-safety, eval-safety, the single-day night-force + skip-on-missing paths).
2. **Codex review** — `/codex:review` (or `codex exec -s read-only`) on the branch diff.
3. **Live-verify** — `cd backend && uv run --env-file .env python -m scripts.live_run --start <D> --end <D+2>` (use fresh dates to avoid the idempotency short-circuit). Confirm the `=== hotel_suggestions:` block prints real Tokyo hotels (names, ★, prices) and the trip still completes if hotel search warns.
4. **PR to `dev`** — backend-only, NO migration, NO frontend change (`hotel_suggestions` table + TS type already shipped). Hand Codex the board update (hotel card → Done).
