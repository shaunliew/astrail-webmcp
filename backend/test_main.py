"""POST /generate-trip route tests: async fakes for the create+persist path,
the idempotent-replay path, the idempotency-race path (a concurrent POST wins
the same key -> we delete our orphan trip and redirect without dispatching),
and the auth gate. GET /generate-trip/stream is exercised end-to-end via
api/test_streaming.py (the generator) plus the owner-check here is a thin
FastAPI wrapper around trips lookups already covered by the runner's owner
filters in pipeline/test_runner.py.

Drives the ASGI app with an async httpx client over ASGITransport (NOT the sync
`starlette.testclient.TestClient`, which is deprecated with httpx and spins a
separate portal loop). ASGITransport awaits the full ASGI call, including the
Starlette BackgroundTask, so `run_generation` dispatch is observable by the time
the POST resolves.
"""
import os

import httpx
import pytest

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

import main  # noqa: E402
from auth import get_current_user_id  # noqa: E402


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

    def select(self, *_cols):
        self._op = ("select", None)
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row):
        return all(row.get(k) == v for k, v in self._filters.items())

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
            return _Result(matched)
        if op == "delete":
            matched = [r for r in rows if self._matches(r)]
            self.db[self.name] = [r for r in rows if r not in matched]
            return _Result(matched)
        matched = [r for r in rows if self._matches(r)]
        if self._single:
            return _Result(matched[0] if matched else None)
        return _Result(matched)


class _Client:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return _Table(name, self.db)


def _async_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


@pytest.fixture
async def ctx(monkeypatch):
    db: dict = {}
    client = _Client(db)

    async def _get_client():
        return client

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    async def _default_enqueue(trip_id, user_id, key, **_kw):
        # Mirrors the real jobs.enqueue_job enough for route-level tests: records
        # the idempotency key against this trip so a replayed POST's precheck
        # (client.table("jobs")...maybe_single()) finds it.
        db.setdefault("jobs", []).append(
            {"id": "job-1", "trip_id": trip_id, "user_id": user_id, "idempotency_key": key}
        )
        return "job-1", trip_id

    monkeypatch.setattr(main, "enqueue_job", _default_enqueue)

    calls: list = []

    async def _run_generation(*args, **kwargs):
        calls.append((args, kwargs))
        return {"itinerary": {"days": []}}

    monkeypatch.setattr(main, "run_generation", _run_generation)

    main.app.dependency_overrides[get_current_user_id] = lambda: "user-1"
    async with _async_client() as ac:
        yield ac, db, calls
    main.app.dependency_overrides.clear()


_PAYLOAD = {"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01", "end_date": "2026-08-02"}


async def test_generate_trip_creates_trip_and_persists_create_trip_event(ctx):
    ac, db, calls = ctx
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    trip_id = r.json()["trip_id"]
    assert len(db["trips"]) == 1
    create_trip_events = [e for e in db["generation_events"] if e["stage"] == "create_trip"]
    assert len(create_trip_events) == 1
    assert create_trip_events[0]["payload"]["reel_urls"] == ["https://ig/r1"]
    assert create_trip_events[0]["payload"]["start_date"] == "2026-08-01"
    assert len(calls) == 1  # dispatched exactly once
    assert calls[0][0][0] == trip_id  # dispatched for the trip that was created


async def test_generate_trip_replays_same_trip_for_same_idempotency_key(ctx):
    ac, db, calls = ctx
    first = await ac.post("/generate-trip", json=_PAYLOAD)
    second = await ac.post("/generate-trip", json=_PAYLOAD)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["trip_id"] == second.json()["trip_id"]
    assert len(db["trips"]) == 1  # no second insert
    assert len(calls) == 1  # dispatched only once; replay never dispatches again


async def test_generate_trip_marks_trip_failed_when_create_trip_event_fails(ctx, monkeypatch):
    """A failure recording the create_trip event (between trip-insert and enqueue)
    must not leave the trip stuck `generating` with no job to recover it — Fix 3."""
    from postgrest.exceptions import APIError

    ac, db, calls = ctx

    async def _failing_record_event(*_args, **_kwargs):
        raise APIError({"message": "boom", "code": "500", "details": None, "hint": None})

    monkeypatch.setattr(main, "record_event", _failing_record_event)

    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 500
    assert len(db["trips"]) == 1
    assert db["trips"][0]["status"] == "failed"
    assert db.get("jobs", []) == []  # enqueue_job never ran
    assert calls == []  # never dispatched


async def test_generate_trip_idempotency_race_deletes_orphan_and_redirects(ctx, monkeypatch):
    ac, db, calls = ctx

    async def _racing_enqueue(_trip_id, _user_id, _key, **_kw):
        return "job-winner", "winner-trip-id"  # a concurrent POST already won the race

    monkeypatch.setattr(main, "enqueue_job", _racing_enqueue)

    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["trip_id"] == "winner-trip-id"
    assert db["trips"] == []  # our orphan trip was deleted, not left behind
    assert calls == []  # never dispatched for the losing trip


async def test_generate_trip_requires_auth():
    main.app.dependency_overrides.clear()
    async with _async_client() as ac:
        r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 401


async def test_boot_time_recovery_failure_does_not_down_the_app(monkeypatch):
    """A DB blip during the startup recovery sweep must DEGRADE, not crash the app —
    the lifespan must not raise, and /health must still serve (Fix 2)."""

    async def _get_client():
        return object()  # never touched further; recover_inflight_jobs raises first

    async def _failing_recover(**_kwargs):
        raise RuntimeError("boot-time db blip")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "recover_inflight_jobs", _failing_recover)

    # The lifespan startup must swallow the recovery error (not propagate it).
    async with main.lifespan(main.app):
        pass

    # And the app still serves /health.
    async with _async_client() as ac:
        r = await ac.get("/health")
    assert r.status_code == 200


async def test_redispatch_threads_preferences_and_destination_hint(monkeypatch):
    """Finding 1 / guardrail #12: a crash-reclaimed run MUST replay preferences and
    destination_hint from the create_trip payload, or a Render restart mid-run
    silently re-personalizes the trip (source flips explicit -> memory/inferred_default)."""
    db: dict = {
        "generation_events": [
            {"trip_id": "trip-1", "stage": "create_trip",
             "payload": {"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01",
                        "end_date": "2026-08-02", "pace": "relaxed",
                        "preferences": "ramen", "destination_hint": "Tokyo"}},
        ],
    }
    client = _Client(db)

    calls: list = []

    async def _fake_run_generation(*args, **kwargs):
        calls.append((args, kwargs))
        return {"itinerary": {"days": []}}

    monkeypatch.setattr(main, "run_generation", _fake_run_generation)

    job = {"id": "job-1", "trip_id": "trip-1", "user_id": "user-1"}
    await main._redispatch(client, job)

    assert len(calls) == 1
    _args, kwargs = calls[0]
    assert kwargs["preferences"] == "ramen"
    assert kwargs["destination_hint"] == "Tokyo"
