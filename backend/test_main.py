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
import rate_limit  # noqa: E402
from fastapi import Request  # noqa: E402
from rate_limit import get_current_user_id_stashed  # noqa: E402

# Sentinel: configure a fake RPC to raise on .execute() (refund-failure paths).
_RAISE = object()


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder over a shared in-memory db."""

    def __init__(self, name, db, fail_ops=None):
        self.name = name
        self.db = db
        self._op = None
        self._filters: dict = {}
        self._single = False
        self._fail_ops = fail_ops if fail_ops is not None else set()

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

    def limit(self, *_args, **_kwargs):
        return self

    def _matches(self, row):
        return all(row.get(k) == v for k, v in self._filters.items())

    async def execute(self):
        op, arg = self._op
        if (self.name, op) in self._fail_ops:
            raise RuntimeError(f"forced {op} failure on {self.name}")
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


class _Rpc:
    """Async fake of supabase-py's rpc() builder: records the call on the client and
    returns a configurable .data from .execute() (or raises)."""

    def __init__(self, client, name):
        self._client = client
        self._name = name

    async def execute(self):
        if self._name in self._client.rpc_results:
            result = self._client.rpc_results[self._name]
        else:
            # Sensible defaults: increment allows (a positive count), decrement returns 0.
            result = 0 if self._name.startswith("decrement") else 1
        if result is _RAISE:
            raise RuntimeError(f"forced rpc failure: {self._name}")
        return _Result(result)


class _Client:
    def __init__(self, db):
        self.db = db
        self.rpc_calls: list = []      # [(name, params), ...] — assert (non-)consumption of quota
        self.rpc_results: dict = {}    # name -> canned .data value, or _RAISE to raise on execute
        self.fail_ops: set = set()     # {(table_name, op)} whose .execute() raises

    def table(self, name):
        return _Table(name, self.db, self.fail_ops)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _Rpc(self, name)


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

    # The route now depends on get_current_user_id_stashed (which calls get_current_user_id
    # DIRECTLY, not via Depends), so overriding get_current_user_id would no longer intercept.
    # Override the stashed dep, and stash request.state.user_id so slowapi's burst key_func
    # keys on the authenticated user id (not the shared test-client IP).
    async def _stashed(request: Request):
        request.state.user_id = "user-1"
        return "user-1"

    main.app.dependency_overrides[get_current_user_id_stashed] = _stashed
    async with _async_client() as ac:
        yield ac, db, calls, client
    main.app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _reset_limiter():
    """slowapi's in-memory burst counts are process-global — reset between tests so one
    test's burst exhaustion doesn't leak into the next."""
    rate_limit.limiter.reset()
    yield


_PAYLOAD = {"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01", "end_date": "2026-08-02"}


async def test_generate_trip_creates_trip_and_persists_create_trip_event(ctx):
    ac, db, calls, client = ctx
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
    ac, db, calls, client = ctx
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

    ac, db, calls, client = ctx

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
    ac, db, calls, client = ctx

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


# ---------------------------------------------------------------------------
# Two-layer rate limiting (Task 4): burst (slowapi) + durable daily quota + refunds.
# ---------------------------------------------------------------------------


async def test_burst_limit_returns_enveloped_429(ctx):
    """Layer 2 (burst): BURST_LIMIT is 3/minute. One real create + two idempotent
    replays consume the window; the 4th call trips the burst limit BEFORE the handler
    body (the @limiter.limit decorator fires ahead of the replay logic)."""
    ac, db, calls, client = ctx
    for _ in range(3):
        r = await ac.post("/generate-trip", json=_PAYLOAD)
        assert r.status_code == 200
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"


async def test_daily_quota_full_returns_429_before_insert(ctx):
    """Layer 1 (durable quota): increment_daily_trip_usage returns None (at/over quota)
    -> the gate rejects with 429 BEFORE any trip insert or dispatch."""
    ac, db, calls, client = ctx
    client.rpc_results["increment_daily_trip_usage"] = None
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"
    assert db.get("trips", []) == []   # rejected before the insert
    assert calls == []                 # never dispatched


async def test_idempotent_replay_does_not_consume_quota(ctx):
    """A retried POST (existing job for the idempotency key) replays the trip WITHOUT
    calling increment_daily_trip_usage — the quota gate sits after the replay short-circuit."""
    ac, db, calls, client = ctx
    first = await ac.post("/generate-trip", json=_PAYLOAD)
    assert first.status_code == 200
    client.rpc_calls.clear()   # ignore the first call's (legitimate) increment
    second = await ac.post("/generate-trip", json=_PAYLOAD)
    assert second.status_code == 200
    assert first.json()["trip_id"] == second.json()["trip_id"]
    assert "increment_daily_trip_usage" not in [c[0] for c in client.rpc_calls]


async def test_burst_limit_is_per_user_not_shared(monkeypatch):
    """F4 (review fold): keying on request.state.user_id (not the IP) means user A
    exhausting the 3/min burst must NOT rate-limit user B on the same test-client IP."""
    db: dict = {}
    client = _Client(db)

    async def _get_client():
        return client

    async def _enqueue(trip_id, user_id, key, **_kw):
        db.setdefault("jobs", []).append(
            {"id": "job-1", "trip_id": trip_id, "user_id": user_id, "idempotency_key": key}
        )
        return "job-1", trip_id

    async def _run_generation(*_args, **_kwargs):
        return {"itinerary": {"days": []}}

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "enqueue_job", _enqueue)
    monkeypatch.setattr(main, "run_generation", _run_generation)

    current = {"uid": "user-A"}

    async def _stashed(request: Request):
        request.state.user_id = current["uid"]
        return current["uid"]

    main.app.dependency_overrides[get_current_user_id_stashed] = _stashed
    try:
        async with _async_client() as ac:
            for _ in range(3):
                await ac.post("/generate-trip", json=_PAYLOAD)
            assert (await ac.post("/generate-trip", json=_PAYLOAD)).status_code == 429  # A exhausted
            current["uid"] = "user-B"
            assert (await ac.post("/generate-trip", json=_PAYLOAD)).status_code != 429  # B fresh bucket
    finally:
        main.app.dependency_overrides.clear()


async def test_insert_failure_refunds_quota_without_stranding(ctx):
    """Codex HIGH #2 fold: trips.insert raises AFTER the quota increment. Expect a 500
    envelope, a best-effort refund (decrement called), and NO orphan trip left
    'generating' (none was created -> trip_id stayed None -> fail-mark correctly skipped)."""
    ac, db, calls, client = ctx
    client.fail_ops.add(("trips", "insert"))
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    rpc_names = [c[0] for c in client.rpc_calls]
    assert "increment_daily_trip_usage" in rpc_names   # quota was consumed
    assert "decrement_daily_trip_usage" in rpc_names   # then best-effort refunded
    assert db.get("trips", []) == []                   # no orphan trip created
    assert calls == []                                 # never dispatched


async def test_refund_exception_after_creation_still_marks_trip_failed(ctx, monkeypatch):
    """Codex HIGH #3 PROOF: the trip IS created, then enqueue_job raises AND the refund
    RPC then raises. The fail-mark runs BEFORE the swallowed refund, so the trip must STILL
    end 'failed' — a refund error must never strand a trip in 'generating'."""
    ac, db, calls, client = ctx

    async def _boom_enqueue(*_args, **_kwargs):
        raise RuntimeError("enqueue boom")

    monkeypatch.setattr(main, "enqueue_job", _boom_enqueue)
    client.rpc_results["decrement_daily_trip_usage"] = _RAISE  # refund itself raises

    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    assert len(db["trips"]) == 1
    assert db["trips"][0]["status"] == "failed"   # fail-marked before the swallowed refund
    assert calls == []                            # never dispatched


async def test_fail_mark_failure_still_refunds_quota(ctx, monkeypatch):
    """Codex MEDIUM fold: enqueue_job raises AND the fail-mark trips.update ITSELF
    raises (a second, independent DB error). The fail-mark failure must not skip the
    quota refund below it — both side effects are now individually best-effort."""
    ac, db, calls, client = ctx

    async def _boom_enqueue(*_args, **_kwargs):
        raise RuntimeError("enqueue boom")

    monkeypatch.setattr(main, "enqueue_job", _boom_enqueue)
    client.fail_ops.add(("trips", "update"))  # the fail-mark update itself raises

    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 500
    rpc_names = [c[0] for c in client.rpc_calls]
    assert "decrement_daily_trip_usage" in rpc_names   # refund still runs despite fail-mark failure
    assert calls == []                                 # never dispatched


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


async def test_cors_allows_astrail_origin():
    async with _async_client() as ac:
        r = await ac.options(
            "/generate-trip",
            headers={
                "Origin": "https://astrail.xyz",
                "Access-Control-Request-Method": "POST",
            },
        )
    assert r.headers.get("access-control-allow-origin") == "https://astrail.xyz"


async def test_cors_rejects_unknown_origin():
    async with _async_client() as ac:
        r = await ac.options(
            "/generate-trip",
            headers={
                "Origin": "https://evil.example.com",
                "Access-Control-Request-Method": "POST",
            },
        )
    # Starlette does not echo a disallowed origin.
    assert r.headers.get("access-control-allow-origin") != "https://evil.example.com"


# ---------------------------------------------------------------------------
# GET /readiness (Task 6): deep DB probe, separate from the dumb /health liveness.
# ---------------------------------------------------------------------------


async def test_readiness_ok_when_db_reachable(monkeypatch):
    db: dict = {}
    client = _Client(db)

    async def _get_client():
        return client

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    async with _async_client() as ac:
        r = await ac.get("/readiness")
    assert r.status_code == 200
    assert r.json() == {"ready": True}


async def test_readiness_503_when_db_unreachable(monkeypatch):
    async def _get_client():
        raise RuntimeError("db unreachable")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    async with _async_client() as ac:
        r = await ac.get("/readiness")
    assert r.status_code == 503
    assert r.json()["ready"] is False
