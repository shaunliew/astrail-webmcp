"""Live runner tests: fully offline, async fake Supabase client (execute() is
awaitable). Covers happy path, partial failure (degraded), critical failure (no
places/reels survive), an unexpected exception outside the per-reel isolation,
a blank-day feasibility flag downgrading status even with no scrape/extract
failures, and the atomic CAS claim guard that aborts a double-dispatched run."""
from datetime import datetime, timedelta, timezone

import pytest

from models.enrichment import WeatherReport
from models.place import PlaceResult
from models.reel import ReelData
from pipeline import runner
# Reuse the organize fake's PostgREST filter evaluator rather than growing a second one: its
# Postgres-faithful `NULL < value` semantics and its refusal to evaluate an unimplemented
# operator are pinned by fidelity tests in `test_organizer_lease.py`. A second, subtly
# different evaluator here is how a lease test passes while proving nothing.
from test_saved_reels_organize import (_LEASE_RPCS, _eval_filter_term, _gt, _lt,
                                       _split_top_level)


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder over a shared in-memory db."""

    def __init__(self, name, db):
        self.name = name
        self.db = db
        self._op = None
        self._filters: dict = {}
        self._in_filters: dict = {}
        self._range: dict = {}
        self._lt_filters: dict = {}
        self._gt_filters: dict = {}
        self._or_filters: list = []
        self._single = False

    def insert(self, row):
        self._op = ("insert", row)
        return self

    def update(self, row):
        self._op = ("update", row)
        return self

    def delete(self):
        self._op = ("delete", None)
        return self

    def select(self, cols):
        self._op = ("select", cols)
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def in_(self, col, values):
        self._in_filters[col] = values
        return self

    def gte(self, col, val):
        self._range[(col, "gte")] = val
        return self

    def lte(self, col, val):
        self._range[(col, "lte")] = val
        return self

    def lt(self, col, val):
        self._lt_filters[col] = val
        return self

    def gt(self, col, val):
        # The write-back guard (preferences.py) pushes the trip's start down as
        # `.gt("created_at", started_at)`. Real filtering via the organize fake's `_gt`, not
        # a `return self` no-op: unfiltered, EVERY 'cleared' row would match and the guard
        # would suppress learning forever.
        if val is None:
            raise ValueError(".gt(col, None) is never valid against postgrest; use .is_(col, 'null')")
        self._gt_filters[col] = val
        return self

    def maybe_single(self):
        self._single = True
        return self

    def or_(self, expr):
        self._or_filters.append(expr)
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        if not all(row.get(k) in v for k, v in self._in_filters.items()):
            return False
        for (col, op), val in self._range.items():
            if op == "gte" and not row.get(col, 0) >= val:
                return False
            if op == "lte" and not row.get(col, 0) <= val:
                return False
        if not all(_lt(row, k, v) for k, v in self._lt_filters.items()):
            return False
        if not all(_gt(row, k, v) for k, v in self._gt_filters.items()):
            return False
        return all(
            any(_eval_filter_term(row, term) for term in _split_top_level(expr))
            for expr in self._or_filters
        )

    async def execute(self):
        op, arg = self._op
        rows = self.db.setdefault(self.name, [])
        if op == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row)
            return _Result([row])
        if op == "update":
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(arg)
            self.db.setdefault(self.name + "_updates", []).append(arg)
            return _Result(matched)
        if op == "delete":
            keep = [r for r in rows if not self._matches(r)]
            self.db[self.name] = keep
            return _Result([])
        matched = [r for r in rows if self._matches(r)]
        if self._single:
            if len(matched) > 1:
                raise ValueError("maybe_single() matched multiple rows")
            # Faithful to postgrest 2.31.0: a BARE None on zero rows, not a result whose
            # .data is None (test_main.py's fake carries the same note — a forgiving fake
            # there hid a real 500).
            return _Result(matched[0]) if matched else None
        return _Result(matched)


class _CompleteTripRunRpc:
    """Mirror of `public.complete_trip_run` (extended in 20260803120000_entitlement_free_trial.sql).

    The fence and the insert are ONE unit here for the same reason they are one transaction
    there: a superseded worker must write NEITHER the job status NOR the terminal `result`
    event. A fake that inserted unconditionally would leave the caller's `False` branch dead
    under test while the real fence could be missing entirely — and every fencing test in
    `test_runner_lease.py` would pass while proving nothing.

    Fix 5 (entitlement arc): the failure branch of the RPC now owns `trips.status='failed'`
    INSIDE the fence, so the fake writes it here too — otherwise `_fail`'s leased path (which no
    longer issues an unfenced `_set_status`) would leave `trips` untouched in the fake and the
    runner-level "the trip is marked failed" property would silently stop being tested. Only
    `trips.status` is mirrored: the counter refund + `charge_refunded_at` are RPC-internal
    entitlement effects owned by pgTAP (`supabase/tests/017_entitlement_rpcs.sql`), not asserted
    at the runner level, so mirroring them here would be dead scaffolding.
    """

    def __init__(self, client, params):
        self.client, self.params = client, params

    async def execute(self):
        params = self.params
        job = next((row for row in self.client.db.get("jobs", [])
                    if row.get("id") == params["p_job_id"]
                    and row.get("lease_token") == params["p_lease_token"]
                    and row.get("status") == "running"), None)
        if job is None:
            return _Result(False)
        job.update({"status": params["p_status"], "completed_at": "2026-07-20T00:00:00+00:00"})
        if params["p_status"] == "failed":
            # Fenced terminal write (RPC B): trips.status='failed' rides the same transaction as
            # the job mark + result event. Routed through the trips table so `trip_updates` records
            # it exactly as an unfenced `_set_status` would have — the property moves writers, not
            # visibility.
            await self.client.table("trips").update({"status": "failed"}).eq(
                "id", params["p_trip_id"]).execute()
        events = self.client.db.setdefault("generation_events", [])
        events.append({
            "id": f"generation_events-{len(events) + 1}",
            "trip_id": params["p_trip_id"], "event_type": "result", "stage": params["p_stage"],
            "message": params["p_message"], "payload": params.get("p_payload") or {},
        })
        return _Result(True)


class _ReplaceTripItineraryRpc:
    """Mirror of `public.replace_trip_itinerary` (20260720150000).

    The fence and the delete-reinsert are ONE unit here for the same reason they are one
    transaction there: a superseded worker must destroy NEITHER the replacement's trip_places
    NOR its trip_days. A fake that deleted first and only then checked the lease — or that
    ignored the lease entirely — would leave the caller's `LeaseLost` branch dead under test
    while the real fence could be missing, and every fencing test in `test_runner_lease.py`
    would pass while proving nothing.

    The predicate mirrors the SQL exactly, `trip_id` included: a lease on job X may only
    rewrite job X's own trip.
    """

    def __init__(self, client, params):
        self.client, self.params = client, params

    async def execute(self):
        params = self.params
        job = next((row for row in self.client.db.get("jobs", [])
                    if row.get("id") == params["p_job_id"]
                    and row.get("trip_id") == params["p_trip_id"]
                    and row.get("lease_token") == params["p_lease_token"]
                    and row.get("status") == "running"), None)
        if job is None:
            return _Result(False)
        trip_id = params["p_trip_id"]
        for table in ("trip_places", "trip_days"):
            rows = self.client.db.setdefault(table, [])
            self.client.db[table] = [r for r in rows if r.get("trip_id") != trip_id]
        for table, key in (("trip_places", "p_places"), ("trip_days", "p_days")):
            rows = self.client.db.setdefault(table, [])
            for row in params.get(key) or []:
                rows.append({"id": f"{table}-{len(rows) + 1}", "trip_id": trip_id, **row})
        return _Result(True)


class _ReplaceHotelSuggestionsRpc:
    """Mirror of `public.replace_hotel_suggestions` (20260804120000).

    persist_hotels now routes its delete-reinsert through this fenced RPC on the leased runner
    path (F3/B), so the runner's fake must implement it — otherwise every leased run's hotel
    write raises `fake does not implement rpc` (swallowed by the best-effort stage) and the
    hotel/tradeoff-comparison properties below silently stop being tested. The fence predicate
    mirrors the SQL exactly, `trip_id` included; each inserted row gets `trip_id` from the RPC
    (the caller's row dicts carry none), matching the SQL's `select p_trip_id, ...`."""

    def __init__(self, client, params):
        self.client, self.params = client, params

    async def execute(self):
        params = self.params
        job = next((row for row in self.client.db.get("jobs", [])
                    if row.get("id") == params["p_job_id"]
                    and row.get("trip_id") == params["p_trip_id"]
                    and row.get("lease_token") == params["p_lease_token"]
                    and row.get("status") == "running"), None)
        if job is None:
            return _Result(False)
        trip_id = params["p_trip_id"]
        rows = self.client.db.setdefault("hotel_suggestions", [])
        self.client.db["hotel_suggestions"] = [r for r in rows if r.get("trip_id") != trip_id]
        for row in params.get("p_rows") or []:
            self.client.db["hotel_suggestions"].append(
                {"id": f"hotel_suggestions-{len(self.client.db['hotel_suggestions']) + 1}",
                 "trip_id": trip_id, **row})
        return _Result(True)


# This generation's `trips.created_at`, as Postgres stamped it at POST /generate-trip.
# A LITERAL, never a derived offset or a wall clock: the write-back guard compares clear
# markers against it, and a reference that moved with the fixtures would let a broken
# comparison stay green. `_CLEARED_MID_RUN` is deliberately LATER — a clear that landed
# while the generation was still running.
_TRIP_CREATED_AT = "2026-08-03T12:00:00+00:00"
_CLEARED_MID_RUN = "2026-08-03T12:01:00+00:00"
_CLEARED_BEFORE_RUN = "2026-08-03T11:59:00+00:00"


class _Client:
    def __init__(self, jobs=None):
        # The runner only UPDATEs trips, never inserts, so the row is seeded here: the
        # write-back guard READS trips.created_at, and with no row it can find no reference,
        # skips the write, and every memory assertion below would silently stop proving
        # anything (the guard's fail-safe swallows the miss).
        self.db: dict = {
            "jobs": jobs or [],
            "trips": [{"id": "trip-1", "user_id": "user-1", "created_at": _TRIP_CREATED_AT}],
            # persist_trip_memory reads users.account_status (the §3.6 generation freeze) before
            # the add; seed the acting user 'active' so the freeze is inert and the write-back
            # assertions still exercise the real add (a missing row would read as "frozen").
            "users": [{"id": "user-1", "account_status": "active"}],
        }
        self.rpc_calls: list = []
        # The DATABASE's clock, as the organize fake documents at length: every lease instant
        # is `clock_timestamp()` inside Postgres, so the mirrors must read this and never
        # `datetime.now()`.
        self.clock_skew = timedelta(0)

    def db_now(self) -> datetime:
        return datetime.now(timezone.utc) + self.clock_skew

    def table(self, name):
        return _Table(name, self.db)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        if name == "complete_trip_run":
            return _CompleteTripRunRpc(self, params)
        if name == "replace_trip_itinerary":
            return _ReplaceTripItineraryRpc(self, params)
        if name == "replace_hotel_suggestions":
            return _ReplaceHotelSuggestionsRpc(self, params)
        if name in _LEASE_RPCS:
            mirror, table = _LEASE_RPCS[name]
            return mirror(self, params, self.db.setdefault(table, []))
        raise AssertionError(f"fake does not implement rpc {name!r}")

    @property
    def events(self):
        return self.db.get("generation_events", [])

    @property
    def trip_updates(self):
        return self.db.get("trips_updates", [])


def _reel(url):
    return ReelData(reel_url=url, caption="📍Tokyo Tower", location_name="Tokyo",
                     short_code="x", capture_status="CAPTURED", transcript=None)


def _place(name, lat=35.6586, lng=139.7454):
    return PlaceResult(name=name, name_local=None, category="attraction",
                        source_type="reel_extracted", lat=lat, lng=lng,
                        confidence=0.9, evidence_quote="📍Tokyo Tower",
                        source_url="https://example.org/a", formatted_address=None)


async def _no_weather(*_a, **_k):
    return []


async def _no_transport(*_a, **_k):
    return []


async def _no_restaurant(*_a, **_k):
    return []


async def _no_narrator(*_a, **_k):
    from models.enrichment import NarrationResult
    return NarrationResult(days=[], trip_title=None, trip_summary="")


async def _no_hotel(*_a, **_k):
    return (None, [])


def _event_stages(c):
    return [e["stage"] for e in c.events]


class _RaisingMem0:
    async def search(self, *_a, **_k):
        raise RuntimeError("mem0 down")


class _AddRaisingMem0:
    """search succeeds (explicit input skips it anyway); add always raises — exercises
    the awaited write-back's best-effort failure path (Task 5)."""

    async def search(self, *_a, **_k):
        return {"results": []}

    async def add(self, *_a, **_k):
        raise RuntimeError("mem0 add failed")


class _RecordingMem0:
    """add RECORDS instead of raising, so a suppressed write-back is observable as the
    absence of a mem0 call and not merely the absence of an audit row."""

    def __init__(self):
        self.added: list = []

    async def search(self, *_a, **_k):
        return {"results": []}

    async def add(self, messages, **kwargs):
        self.added.append((messages, kwargs))
        return {"status": "PENDING", "event_id": "evt-1"}


@pytest.mark.asyncio
async def test_happy_path_completes_marks_job_and_emits_result():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"][0]["place_names"] == ["Tokyo Tower"]
    stages = [e["stage"] for e in c.events]
    assert stages[:5] == ["preferences", "scrape", "extract", "dedup", "narrate"]
    assert [e for e in c.events if e["event_type"] == "result"]
    assert c.db["jobs"][0]["status"] == "succeeded"
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_place_only_trip_uses_authorized_canonical_place_without_scrape(monkeypatch):
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def authorize(_client, _user_id, _place_ids):
        return [{
            "id": "place-1", "name": "Tokyo Tower", "place_type": "attraction",
            "lat": 35.6586, "lng": 139.7454, "city": "Tokyo",
            "confidence": 0.95, "evidence_quote": "Tokyo Tower", "source_url": None,
        }]

    monkeypatch.setattr(runner, "authorize_place_ids", authorize)
    out = await runner.run_generation(
        "trip-1", "user-1", [], "2026-08-01", "2026-08-01", job_id="job-1",
        place_ids=["place-1"], client=c, mem0=None, weather=_no_weather,
        transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel,
    )

    assert out["itinerary"]["days"][0]["place_names"] == ["Tokyo Tower"]
    assert "scrape" not in _event_stages(c)
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_one_reel_fails_saves_with_gaps():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        if url.endswith("bad"):
            raise RuntimeError("Apify scrape failed (HTTP 500)")
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/ok", "https://ig/bad"],
                                       "2026-08-01", "2026-08-01", job_id="job-1", client=c,
                                       scrape=scrape, extract=extract, mem0=None, weather=_no_weather,
                                       transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_all_reels_fail_is_critical_failure():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        raise RuntimeError("Apify scrape failed (HTTP 500)")

    async def extract(reel):
        return []

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/bad"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"][0]["payload"]["error"]
    assert c.db["jobs"][0]["status"] == "failed"
    # Fix 5: on the leased path `trips.status='failed'` now rides the FENCED CAS
    # (`complete_trip_run`), not an unfenced `_set_status` — the property is unchanged, the writer
    # moved. The last trips write is still `failed` (the CAS runs after the `generating` mark).
    assert c.trip_updates[-1]["status"] == "failed"


@pytest.mark.asyncio
async def test_unexpected_exception_still_writes_terminal_result():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    def boom(reel):
        raise ValueError("unexpected non-async boom")  # wrong shape → raises before gather()

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=boom,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"]  # never a hanging stream
    assert c.db["jobs"][0]["status"] == "failed"


@pytest.mark.asyncio
async def test_blank_day_reports_saved_with_gaps():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-03", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert len(out["itinerary"]["days"]) == 3
    assert out["itinerary"]["days"][1]["place_names"] == []
    assert out["itinerary"]["days"][2]["place_names"] == []
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_normalized_rows_on_success():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                 "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                 mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert c.db.get("places") and c.db["places"][0]["name"] == "Tokyo Tower"
    trip_places = c.db.get("trip_places")
    assert trip_places and all(tp["trip_id"] == "trip-1" for tp in trip_places)
    assert c.db.get("trip_days")
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_each_place_records_the_reel_it_was_extracted_from():
    """The flatten is where provenance was being thrown away.

    `results[i]` is aligned to `reel_urls[i]`, and the old `[p for r in results if r for p in r]`
    collapsed that index away. Every reel-extracted place then reached the popup labelled
    `reel_quote` while carrying only `source_url` — which is the RESEARCH page by construction
    (`is_independent_source_url` drops places whose source_url is not independent). The result a
    user saw was "From your Instagram Reel" above a link to a scraped venue directory.

    Two reels, two distinct places, so this fails on a mis-ALIGNMENT and not merely on a missing
    field: asserting "some reel url is present" would pass even if every place got reel 1's URL.
    """
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])
    reels = ["https://ig/r1", "https://ig/r2"]
    by_reel = {"https://ig/r1": "Tokyo Tower", "https://ig/r2": "Senso-ji"}

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        # Distinct coords too: dedup clusters on distance, and two places at the same point would
        # merge into one canonical row, quietly destroying what this test is trying to observe.
        name = by_reel[reel.reel_url]
        return [_place(name, lat=35.6586 if name == "Tokyo Tower" else 35.7148,
                       lng=139.7454 if name == "Tokyo Tower" else 139.7967)]

    await runner.run_generation("trip-1", "user-1", reels, "2026-08-01", "2026-08-02",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport,
                                restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)

    places_by_id = {row["id"]: row["name"] for row in c.db["places"]}
    attribution = {
        places_by_id[tp["place_id"]]: tp["evidence_json"].get("source_reel_url")
        for tp in c.db["trip_places"]
    }
    assert attribution == {"Tokyo Tower": "https://ig/r1", "Senso-ji": "https://ig/r2"}
    # And the research URL is still its own separate field — the two must never be conflated.
    for tp in c.db["trip_places"]:
        assert tp["evidence_json"]["source_url"] == "https://example.org/a"
        assert tp["evidence_json"]["evidence_kind"] == "reel_quote"


@pytest.mark.asyncio
async def test_runner_degrades_to_saved_with_gaps_when_persist_fails(monkeypatch):
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def _boom(*args, **kwargs):
        raise RuntimeError("persist db error")

    monkeypatch.setattr(runner, "persist_itinerary", _boom)
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]                       # itinerary still produced + returned
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"       # NOT failed — persist is non-critical


@pytest.mark.asyncio
async def test_runner_degrades_when_persist_drops_a_place():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower"),
                PlaceResult(name="No Coords Spot", name_local=None, category="attraction",
                            source_type="reel_extracted", lat=None, lng=None,
                            confidence=0.9, evidence_quote="📍No Coords Spot",
                            source_url="https://example.org/a", formatted_address=None)]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]                       # itinerary still shows both places
    # Assert the CONTRACT (a save-stage warning is emitted), not the prose — this line
    # previously pinned the exact wording and broke when the copy moved into DESIGN.md §7 voice.
    assert any(e["event_type"] == "warning" and e["stage"] == "save" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"        # a dropped place is non-critical


@pytest.mark.asyncio
async def test_cas_abort_skips_when_job_already_claimed():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "running"}])  # already claimed by another run

    async def scrape(url):
        raise AssertionError("scrape must not run when the CAS claim is lost")

    async def extract(reel):
        raise AssertionError("extract must not run when the CAS claim is lost")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out == {"skipped": "job already claimed by another run"}
    assert c.events == []
    assert c.trip_updates == []
    assert c.db["jobs"][0]["status"] == "running"  # untouched — not re-claimed


@pytest.mark.asyncio
async def test_runner_persists_weather_on_trip_days():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def weather(lat, lng, dates):
        return [WeatherReport(date=d, temp_min_c=24.0, temp_max_c=31.0, precipitation_mm=0.0,
                              weather_code=2, summary="Partly cloudy, 24-31°C") for d in dates]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract, mem0=None, weather=weather,
                                transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    td = c.db["trip_days"]
    assert td and td[0].get("weather_source") == "open_meteo"
    assert td[0].get("weather_summary")
    assert any(e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # weather success does not degrade


@pytest.mark.asyncio
async def test_weather_failure_is_logged_not_only_evented(caplog):
    """A swallowed weather failure must reach the LOGS, not only `generation_events`.

    The overwhelmingly common cause is not a bug: Open-Meteo's forecast API has a rolling
    ~16-day horizon and returns HTTP 400 past it, and `fetch_weather` makes ONE call spanning
    the whole trip — so a start date beyond the horizon fails EVERY day at once. That is the
    default for any trip planned more than two weeks ahead, which makes a null
    `weather_summary` the COMMON path rather than an edge case.

    Guardrail #3 means the trip must still complete, so the failure is invisible by design.
    Before this log the only trace was a `generation_events` row, and the symptom in Render's
    logs was indistinguishable from the weather agent never running at all — which is exactly
    the wrong conclusion, and one that was actually drawn from a production trip.

    Asserts the TYPE is logged and the exception TEXT is not: a provider error body can echo
    the request back.
    """
    import logging
    caplog.set_level(logging.WARNING, logger="pipeline.runner")
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def weather(lat, lng, dates):
        raise RuntimeError("out of allowed range from 2026-04-18 to 2026-08-04")

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-09-15", "2026-09-17",
                                job_id="job-1", client=c, scrape=scrape, extract=extract, mem0=None, weather=weather,
                                transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)

    assert "weather_unavailable" in caplog.text, "a swallowed weather failure must be visible in logs"
    assert "RuntimeError" in caplog.text, "the error TYPE names what failed"
    assert "out of allowed range" not in caplog.text, "the provider's message can echo the request; log the type only"
    # guardrail #3: the trip still completes, and the durable event is still written
    assert any(e["stage"] == "weather" and e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] in ("complete", "saved_with_gaps")


@pytest.mark.asyncio
async def test_runner_skips_weather_when_all_places_lack_coords():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [PlaceResult(name="No Coords Spot", name_local=None, category="attraction",
                             source_type="reel_extracted", lat=None, lng=None,
                             confidence=0.9, evidence_quote="📍No Coords Spot",
                             source_url="https://example.org/a", formatted_address=None)]

    async def weather(lat, lng, dates):
        raise AssertionError("weather must not be called when centroid is None")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract, mem0=None, weather=weather,
                                      transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]                            # itinerary still produced
    assert not any(e["stage"] == "weather" for e in c.events)  # centroid is None → weather skipped entirely
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"   # the no-coord place is dropped by persist
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_weather_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def weather(lat, lng, dates):
        raise RuntimeError("open-meteo down")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract, mem0=None, weather=weather,
                                      transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]                        # trip still produced
    assert any(e["event_type"] == "warning" and e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # weather failure does NOT degrade or fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_transport_legs():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 400, "code": "Ok"} for _ in range(len(coords) - 1)]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert c.db["transport_legs"], "expected transport_legs written"
    assert any(e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # transport success does not degrade


@pytest.mark.asyncio
async def test_runner_transport_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"): raise RuntimeError("mapbox down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather, transport=transport, restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"       # transport failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_transport_missing_token_is_non_critical(monkeypatch):
    # transport NOT injected -> the REAL fetch_directions_legs runs and reads
    # os.environ["MAPBOX_SECRET_TOKEN"] -> KeyError (before any network) -> absorbed -> warning + complete.
    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather,   # transport intentionally NOT injected
                                      restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_restaurant_suggestions():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def restaurant(places, *, city=None, preference_block=None):
        from models.enrichment import RestaurantCandidate
        return [RestaurantCandidate(name="Ramen X", name_local="ラーメンX", cuisine="ramen",
                                    summary="Great tonkotsu near A", lat=35.601, lng=139.701,
                                    address="Tokyo", mapbox_id="poi.1", categories=["レストラン"], distance_m=20)]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport, restaurant=restaurant, narrator=_no_narrator, hotel=_no_hotel)
    rs = c.db.get("restaurant_suggestions")
    assert rs and rs[0]["summary"] == "Great tonkotsu near A"
    assert rs[0]["restaurant_place_id"] and rs[0]["near_place_id"]
    assert any(p["name"] == "Ramen X" and p["place_type"] == "restaurant" for p in c.db["places"])
    assert any(e["stage"] == "restaurants" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # restaurant success does not degrade


@pytest.mark.asyncio
async def test_runner_restaurant_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def restaurant(places, *, city=None, preference_block=None): raise RuntimeError("mapbox/openai down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather, transport=_no_transport, restaurant=restaurant, narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "restaurants" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # restaurant failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_narration():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def narrator(days, *, city=None, preference_block=None):
        from models.enrichment import NarrationResult, DayNarration
        return NarrationResult(days=[DayNarration(day_number=1, title="Day 1: Icons",
                                                  summary="Tokyo Tower first.")],
                               trip_title="Tokyo in a Day", trip_summary="A compact highlights run.")
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=narrator, hotel=_no_hotel)
    td = c.db["trip_days"]
    assert td and td[0].get("title") == "Day 1: Icons" and td[0].get("summary")
    assert any("summary" in u and u.get("summary") == "A compact highlights run." for u in c.trip_updates)
    assert any(e["stage"] == "summarize" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # narration success does not degrade


@pytest.mark.asyncio
async def test_runner_narration_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def narrator(days, *, city=None, preference_block=None): raise RuntimeError("openai down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "summarize" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # narration failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_uses_extraction_cache_skips_scrape_and_extract():
    # A cached reel (real reel URL + a seeded reel_cache row at the current EXTRACTOR_VERSION) is a
    # HIT: scrape+extract are NEVER called, a `cache_hit` event fires, and the cached place is used.
    from genagents.place_extractor import EXTRACTOR_VERSION
    reel_url = "https://www.instagram.com/reel/ABC123/"
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["reel_cache"] = [{"id": "rc-1", "normalized_url": "https://www.instagram.com/reel/ABC123",
                           "extractor_version": EXTRACTOR_VERSION,
                           "extracted_places": [_place("Tokyo Tower").model_dump()]}]

    async def scrape(url): raise AssertionError("scrape must not run on a cache hit")
    async def extract(reel): raise AssertionError("extract must not run on a cache hit")

    await runner.run_generation("trip-1", "user-1", [reel_url], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=_no_narrator, hotel=_no_hotel)
    assert any(e["stage"] == "cache_hit" for e in c.events)
    assert c.db.get("places") and c.db["places"][0]["name"] == "Tokyo Tower"   # cached place persisted
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_runner_persists_hotel_suggestions():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
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
                                mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=_no_narrator, hotel=hotel)
    hs = c.db.get("hotel_suggestions")
    assert hs and hs[0]["name"] == "Park Hyatt Tokyo" and hs[0]["source"] == "travala"
    assert any(e["stage"] == "hotels" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # 2 places / 1 day -> no blank day -> not degraded


@pytest.mark.asyncio
async def test_runner_says_so_when_the_hotel_search_finds_nothing():
    """A search that RAN and returned nothing is not a search that broke.

    Only the broken case said anything: an empty result emitted no event at all, so
    "searched, found nothing" and "Travala failed silently" were indistinguishable from outside —
    for the traveller reading the trip and for anyone debugging it weeks later. Weather already
    makes this distinction ("No forecast available this far ahead").
    """
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 2, "room_count": 1,
                      "destination_hint": "Tokyo"}]

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]

    async def hotel(location, check_in, check_out, rooms):
        return "sess-1", []          # ran fine, nothing available

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport,
                                restaurant=_no_restaurant, narrator=_no_narrator, hotel=hotel)

    warnings = [e for e in c.events if e["stage"] == "hotels" and e["event_type"] == "warning"]
    assert warnings, "an empty hotel search recorded nothing at all"
    assert "No hotel suggestions" in warnings[0]["message"]
    # Deliberately NOT "available for these dates": zero rows also means no search ran at all
    # (persist_hotels needs a city or destination_hint plus both dates), and claiming a result for
    # a search that never happened is its own wrong answer.
    assert "available" not in warnings[0]["message"]
    # ...and it stays non-critical: an empty hotel list must not degrade the trip.
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_runner_stays_silent_when_hotels_were_found():
    """The warning must mark an ABSENCE, not fire on every run."""
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
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
                                mem0=None, weather=_no_weather, transport=_no_transport,
                                restaurant=_no_restaurant, narrator=_no_narrator, hotel=hotel)

    assert not [e for e in c.events if e["stage"] == "hotels" and e["event_type"] == "warning"]


@pytest.mark.asyncio
async def test_runner_hotel_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 1, "room_count": 1,
                      "destination_hint": "Tokyo"}]
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def hotel(location, check_in, check_out, rooms): raise RuntimeError("travala down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=hotel)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "hotels" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # hotel failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_hotel_lease_lost_emits_no_warning(monkeypatch):
    # A LeaseLost from the fenced hotel RPC (persist_hotels raises it when replace_hotel_suggestions
    # returns false) means a REPLACEMENT worker owns this run. Unlike a real hotel-search failure,
    # this superseded worker must NOT record a "couldn't find hotels" warning — that would pollute
    # the replacement's live event stream. Contrast with the RuntimeError case above, which DOES warn.
    from organizer import LeaseLost
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 1, "room_count": 1,
                      "destination_hint": "Tokyo"}]
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def _lease_lost_persist(*_a, **_k):
        raise LeaseLost("hotel job job-1 lease superseded during persist")
    monkeypatch.setattr(runner, "persist_hotels", _lease_lost_persist)
    async def hotel(location, check_in, check_out, rooms): return "sess-1", []
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=hotel)
    assert out["itinerary"]["days"]                                      # the run still completed
    assert any(e["stage"] == "hotels" and e["event_type"] == "stage" for e in c.events)  # stage ran
    # the LeaseLost was swallowed WITHOUT a hotel warning
    assert not any(e["event_type"] == "warning" and e["stage"] == "hotels" for e in c.events)


@pytest.mark.asyncio
async def test_runner_records_preferences_stage_and_mem0_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=_RaisingMem0(), preferences="",
                                      weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert "preferences" in _event_stages(c)
    assert c.trip_updates[-1]["status"] in ("complete", "saved_with_gaps")  # never failed for a memory reason
    assert c.db["jobs"][0]["status"] == "succeeded"
    # Owner-checked (guardrail #6) trip-level write landed despite the mem0 blip
    # (it degrades to inferred_default rather than raising).
    assert any(u.get("preference_summary") for u in c.trip_updates)
    assert any(u.get("preference_sources") == ["inferred_default"] for u in c.trip_updates)


@pytest.mark.asyncio
async def test_runner_forwards_preference_block_to_restaurant_and_narrator():
    # Regression for the forwarding value itself (not just that the kwarg is accepted):
    # capture what persist_restaurants/persist_narration actually pass down to the
    # restaurant/narrator fakes. If `preference_block=pref_block` were ever dropped from
    # either runner._stage_* call, the fake would receive the kwarg's default (None) and
    # this test would fail on the `is not None` assertion below.
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    captured: dict[str, str | None] = {}

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    async def restaurant(places, *, city=None, preference_block=None):
        captured["restaurant"] = preference_block
        return []

    async def narrator(days, *, city=None, preference_block=None):
        from models.enrichment import NarrationResult
        captured["narrator"] = preference_block
        return NarrationResult(days=[], trip_title=None, trip_summary="")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=None, preferences="ramen",
                                      weather=_no_weather, transport=_no_transport,
                                      restaurant=restaurant, narrator=narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert captured["restaurant"] is not None and "ramen" in captured["restaurant"]
    assert captured["narrator"] is not None and "ramen" in captured["narrator"]


@pytest.mark.asyncio
async def test_runner_write_back_failure_is_non_critical():
    # The write-back (Task 5) is awaited AFTER the terminal result — a hung/erroring
    # mem0.add must not fail the already-saved trip, and a memory_events "failed" row
    # is the observability receipt (persist_trip_memory swallows the error internally;
    # test_write_back_swallows_add_error in test_preferences.py covers the unit itself).
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=_AddRaisingMem0(), preferences="loves ramen",
                                      weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    assert c.trip_updates[-1]["status"] != "failed"
    assert [e for e in c.events if e["event_type"] == "result"]
    assert c.db["jobs"][0]["status"] == "succeeded"
    memory_events = c.db.get("memory_events")
    assert memory_events and memory_events[-1]["event_type"] == "failed"


@pytest.mark.asyncio
async def test_runner_write_back_raise_does_not_double_result_or_flip_status(monkeypatch):
    # Finding 1: the write-back sits AFTER _set_status/result/mark_job_done inside
    # run_generation's outermost try. If persist_trip_memory raises uncaught, the outer
    # `except Exception: _fail(...)` would emit a SECOND `result` event and flip the
    # already-`succeeded` trip/job to `failed`. The runner tail must wrap the write-back
    # in its own try/except so a raise here is fully absorbed.
    # Patched at the DEFINITION site: runner.py imports persist_trip_memory inside the
    # function body, so the patch is resolved at call time (a module-level import would
    # have needed runner's own binding patched instead).
    from pipeline import preferences as prefs_mod

    async def _boom_write_back(*_a, **_k):
        raise RuntimeError("write-back boom")

    monkeypatch.setattr(prefs_mod, "persist_trip_memory", _boom_write_back)

    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      mem0=_AddRaisingMem0(), preferences="loves ramen",
                                      weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=_no_narrator, hotel=_no_hotel)
    assert out["itinerary"]["days"]
    result_events = [e for e in c.events if e["event_type"] == "result"]
    assert len(result_events) == 1   # never a second (error) result event
    assert result_events[0]["message"] == "Your trip is ready"
    assert c.trip_updates[-1]["status"] != "failed"
    assert c.db["jobs"][0]["status"] == "succeeded"   # never flipped to failed
    # Finding (Important, re-review): the write-back guard must not be a silent
    # `except: pass` — it must emit the same warning-event observability convention
    # as every other best-effort stage in this function.
    warning_events = [e for e in c.events if e["event_type"] == "warning" and e["stage"] == "save"]
    assert any(e["message"] == "memory write-back unavailable" for e in warning_events)


@pytest.mark.asyncio
async def test_runner_write_back_proceeds_when_the_clear_predates_the_trip():
    # Keeps `_Table.gt` honest. Without this case the fake's `.gt` wiring could be a
    # `return self` no-op and every runner test would stay green (verified: deleting the
    # `_gt` line from `_matches` came back GREEN before this test existed) — the whole
    # suite would then be blind to a guard that suppresses learning forever.
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    c.db["memory_events"] = [{"id": "evt-clear", "user_id": "user-1", "trip_id": None,
                              "event_type": "cleared", "created_at": _CLEARED_BEFORE_RUN}]
    mem = _RecordingMem0()

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=mem, preferences="loves ramen",
                                weather=_no_weather, transport=_no_transport,
                                restaurant=_no_restaurant, narrator=_no_narrator, hotel=_no_hotel)

    assert mem.added and mem.added[0][1]["user_id"] == "user-1"
    assert [e["event_type"] for e in c.db["memory_events"]] == ["cleared", "learned"]


@pytest.mark.asyncio
async def test_runner_recovery_rerun_still_honours_a_clear_from_the_first_attempt():
    # C9's recovery-replay case, end-to-end through the runner rather than the unit.
    # Guardrail #12: recovery is restart-with-cache-reuse, so a crashed generation
    # re-executes from Phase 1 — but trips.created_at still marks the ORIGINAL start (the
    # row is INSERTed once in POST /generate-trip and only ever `.update()`d). A clear that
    # landed during the first attempt must therefore keep suppressing on the re-run; a guard
    # keyed on "this attempt started now" would resurrect exactly what the user cleared.
    c = _Client(jobs=[
        {"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"},
        {"id": "job-2", "trip_id": "trip-1", "attempt_count": 1, "started_at": None, "status": "pending"},
    ])
    c.db["memory_events"] = [{"id": "evt-clear", "user_id": "user-1", "trip_id": None,
                              "event_type": "cleared", "created_at": _CLEARED_MID_RUN}]
    mem = _RecordingMem0()

    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]

    for job_id in ("job-1", "job-2"):   # the crashed attempt, then the re-queued one
        out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                          "2026-08-01", job_id=job_id, client=c, scrape=scrape,
                                          extract=extract, mem0=mem, preferences="loves ramen",
                                          weather=_no_weather, transport=_no_transport,
                                          restaurant=_no_restaurant, narrator=_no_narrator,
                                          hotel=_no_hotel)
        assert out["itinerary"]["days"]   # the trip still renders; only the write-back is skipped

    assert mem.added == []               # nothing re-added to mem0 on either attempt
    # No audit row on either attempt either: nothing was learned and nothing failed.
    assert [e["event_type"] for e in c.db["memory_events"]] == ["cleared"]


@pytest.mark.asyncio
async def test_run_persists_tradeoff_notes_and_comparisons():
    # Integration proof that BOTH tradeoff halves are wired: notes from feasibility
    # warnings (computed pre-gather) and comparisons from persisted hotel rows
    # (computed post-gather), written together in ONE persist_tradeoffs call.
    c = _Client(jobs=[{"id": "job-1", "trip_id": "trip-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    # LOAD-BEARING: persist_hotels (persist.py:498-503) reads the trips row for dates +
    # a location and returns 0 (never calling the hotel fake) if the row is missing. The
    # runner only UPDATEs trips, never inserts — so SEED the row first, exactly like
    # test_runner_persists_hotel_suggestions (~line 565). Fake places carry no city, so
    # destination_hint is the location fallback that lets the hotel search run.
    c.db["trips"] = [{"id": "trip-1", "user_id": "user-1", "start_date": "2026-08-01",
                      "end_date": "2026-08-01", "adult_count": 2, "room_count": 1,
                      "destination_hint": "Tokyo",
                      "tradeoffs": {"notes": [], "comparisons": []}}]

    async def scrape(url): return _reel(url)

    async def extract(reel):
        # Two far-apart coord places (Tokyo, Osaka) land in the same 1-day group ->
        # assess_feasibility emits a "flag" long_leg warning (haversine ~400km >> 4000m).
        return [_place("Tokyo Tower", lat=35.68, lng=139.76),
                _place("Osaka Castle", lat=34.69, lng=135.50)]

    async def hotel(location, check_in, check_out, rooms):
        return "sess-1", [
            {"name": "Cheap Inn", "star": 3, "pricePerNight": 8000, "currency": "JPY", "hotelId": 1},
            {"name": "Grand", "star": 5, "pricePerNight": 12000, "currency": "JPY", "hotelId": 2},
        ]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                mem0=None, weather=_no_weather, transport=_no_transport,
                                restaurant=_no_restaurant, narrator=_no_narrator, hotel=hotel)

    trip = c.db["trips"][0]
    notes = trip["tradeoffs"]["notes"]
    comps = trip["tradeoffs"]["comparisons"]
    assert any(n["kind"] == "long_leg" for n in notes)         # notes are wired, not empty
    assert comps and comps[0]["axis"] == "price_vs_rating"     # comparisons are wired
    assert set(comps[0]["refs"]) and comps[0]["option_a"]["label"] and comps[0]["option_b"]["label"]
