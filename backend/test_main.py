"""POST /generate-trip route tests: async fakes for the create+persist path,
the idempotent-replay path, the idempotency-race path (a concurrent POST wins
the same key -> we delete our orphan trip and redirect without dispatching),
and the auth gate. GET /generate-trip/stream is covered HERE at the route level
(owner check + happy path); api/test_streaming.py covers stream_trip_events, the
generator the route mounts, which is not the same thing. Believing otherwise —
that the route is a thin wrapper over lookups already covered elsewhere — hid a
500 AND left the whole route deletable with every test still green.

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
from config_validation import REQUIRED_SECRETS  # noqa: E402
from fastapi import Request  # noqa: E402
from rate_limit import get_current_user_id_stashed  # noqa: E402

# Sentinel: configure a fake RPC to raise on .execute() (refund-failure paths).
_RAISE = object()
_PLACE_ID = "11111111-1111-1111-1111-111111111111"
_SAVED_REEL_ID = "22222222-2222-2222-2222-222222222222"


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder over a shared in-memory db."""

    def __init__(self, name, db, fail_ops=None, empty_result_ops=None):
        self.name = name
        self.db = db
        self._op = None
        self._filters: dict = {}
        self._is_filters: dict = {}
        self._order_keys: list = []
        self._single = False
        self._fail_ops = fail_ops if fail_ops is not None else set()
        self._empty_result_ops = empty_result_ops if empty_result_ops is not None else set()

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

    def is_(self, col, val):
        # IS NULL filter: `.is_(col, "null")` matches rows where row.get(col) is None (the
        # repo's `charge_refunded_at IS NULL` form, used by the partial-index-safe replay
        # lookups). Only "null" is modeled; anything else fails loudly, matching the .order
        # fake's philosophy — a silent no-op here would let a broken filter look honoured.
        if val != "null":
            raise ValueError(f"fake .is_() models only the IS NULL form, got .is_({col!r}, {val!r})")
        self._is_filters[col] = val
        return self

    def maybe_single(self):
        self._single = True
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def order(self, column, *, desc=False, **unsupported):
        # This MUST sort. A bare `return self` is the worst kind of fake: every caller's
        # `.order()` looks honoured while rows come back in insertion order, so a test
        # asserting on ordering passes whether or not production ordered anything
        # (test_saved_reels_organize.py's fake carries the same warning, learned the hard way).
        # Ascending-only, matching every call site in the codebase; anything else fails loudly
        # rather than silently sorting on nothing. Caveat if you trip that raise from a stream
        # test: api/streaming.py wraps its query in `except Exception` (transient-blip retry),
        # so the ValueError surfaces as a 300s poll-out, not a traceback. Read it as this raise.
        if desc or unsupported:
            raise ValueError(
                f"fake implements only ascending .order(column), got "
                f".order({column!r}, desc={desc!r}, **{unsupported!r})"
            )
        self._order_keys.append(column)
        return self

    def _ordered(self, rows):
        # PostgREST reads chained `.order()` calls left-to-right, first call primary. Stable
        # sorts applied last-key-first compose into exactly that. `None` sorts last, matching
        # Postgres NULLS LAST on an ascending order, and the two-element key means two nulls
        # compare equal instead of raising on `None < None`.
        ordered = list(rows)
        for key in reversed(self._order_keys):
            ordered.sort(key=lambda row: (row.get(key) is None, row.get(key)))
        return ordered

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        return all(row.get(col) is None for col in self._is_filters)

    async def execute(self):
        op, arg = self._op
        if (self.name, op) in self._fail_ops:
            raise RuntimeError(f"forced {op} failure on {self.name}")
        if (self.name, op) in self._empty_result_ops:
            return _Result([])
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
        matched = self._ordered(r for r in rows if self._matches(r))
        if self._single:
            # Faithful to postgrest 2.31.0: AsyncMaybeSingleRequestBuilder.execute() returns a
            # bare None when zero rows match (request_builder.py:167), NOT a result whose .data
            # is None. A forgiving fake here hid a real 500 in the stream owner check.
            return _Result(matched[0]) if matched else None
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
        self.empty_result_ops: set = set()   # {(table, op)} whose execute() returns _Result([])

    def table(self, name):
        return _Table(name, self.db, self.fail_ops, self.empty_result_ops)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        return _Rpc(self, name)


def _async_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


@pytest.fixture
async def ctx(monkeypatch):
    db: dict = {}
    client = _Client(db)

    # LEGACY/RPC split (Task 4): ENTITLEMENTS_ENABLED=False routes every /generate-trip test
    # that uses `ctx` through _generate_trip_legacy — the pre-arc Python orchestration these
    # tests were written against (behaviour-identical to today bar the one `.is_()` replay
    # filter). The new atomic-RPC path gets its own coverage via `rpc_ctx` below.
    monkeypatch.setattr(main, "ENTITLEMENTS_ENABLED", False)

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


@pytest.fixture
async def rpc_ctx(monkeypatch):
    """RPC-path counterpart to `ctx` (Task 4): ENTITLEMENTS_ENABLED=True routes /generate-trip
    through reserve_and_enqueue_trip_job. Drive each outcome by setting
    client.rpc_results["reserve_and_enqueue_trip_job"] = [{"outcome": ..., "trip_id": ...,
    "job_id": ...}] — a ONE-element list, since the wrapper reads resp.data[0].
    compute_idempotency_key runs for real (not mocked). The httpx client uses
    raise_app_exceptions=False so the enveloped 4xx/5xx outcomes surface as responses
    (matching production) instead of re-raising into the test. The RPC path never touches
    enqueue_job, so it is deliberately not overridden here."""
    db: dict = {}
    client = _Client(db)
    monkeypatch.setattr(main, "ENTITLEMENTS_ENABLED", True)

    async def _get_client():
        return client

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    calls: list = []

    async def _run_generation(*args, **kwargs):
        calls.append((args, kwargs))
        return {"itinerary": {"days": []}}

    monkeypatch.setattr(main, "run_generation", _run_generation)

    async def _stashed(request: Request):
        request.state.user_id = "user-1"
        return "user-1"

    main.app.dependency_overrides[get_current_user_id_stashed] = _stashed
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        yield ac, db, calls, client
    main.app.dependency_overrides.clear()


@pytest.fixture
def stream_auth():
    """The `stream` route's Depends(get_user_id_from_query_or_header) is not overridden by
    ctx. Same function object as auth's, so keying on main.* resolves correctly."""
    async def _user() -> str:
        return "user-1"

    main.app.dependency_overrides[main.get_user_id_from_query_or_header] = _user
    yield
    main.app.dependency_overrides.pop(main.get_user_id_from_query_or_header, None)


@pytest.fixture(autouse=True)
def _reset_limiter():
    """slowapi's in-memory burst counts are process-global — reset between tests so one
    test's burst exhaustion doesn't leak into the next."""
    rate_limit.limiter.reset()
    yield


_PAYLOAD = {"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01", "end_date": "2026-08-02"}


async def test_generate_trip_rejects_malformed_place_id_before_db_or_background(ctx):
    ac, db, calls, client = ctx
    response = await ac.post(
        "/generate-trip",
        json={"reel_urls": [], "place_ids": ["not-a-uuid"], "start_date": "2026-08-01", "end_date": "2026-08-02"},
    )

    assert response.status_code == 422
    assert db == {}
    assert calls == []
    assert client.rpc_calls == []


async def test_generate_trip_rejects_mixed_reel_urls_and_place_ids(ctx):
    """ISSUES-B6: both fields populated -> 422 with ZERO side effects. Pydantic rejects
    before the handler body runs, so nothing downstream is reachable: no trip row, no job,
    no quota RPC, and no background dispatch (which is the only path to an Apify call or
    to authorize_place_ids -- both live inside run_generation)."""
    ac, db, calls, client = ctx
    response = await ac.post(
        "/generate-trip",
        json={"reel_urls": ["https://ig/r1"], "place_ids": [_PLACE_ID],
              "start_date": "2026-08-01", "end_date": "2026-08-02"},
    )

    assert response.status_code == 422
    assert db == {}
    assert calls == []
    assert client.rpc_calls == []


async def test_generate_trip_stringifies_uuid_place_ids_before_db_and_background(ctx):
    ac, db, calls, _client = ctx
    response = await ac.post(
        "/generate-trip",
        json={"reel_urls": [], "place_ids": [_PLACE_ID], "start_date": "2026-08-01", "end_date": "2026-08-02"},
    )

    assert response.status_code == 200
    event = next(event for event in db["generation_events"] if event["stage"] == "create_trip")
    assert event["payload"]["place_ids"] == [_PLACE_ID]
    assert calls[0][1]["place_ids"] == [_PLACE_ID]


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


async def test_saved_reels_organize_has_per_user_burst_limit(ctx, monkeypatch):
    ac, _db, _calls, _client = ctx
    created = []

    async def create_job(_client, user_id, saved_reel_ids):
        created.append((user_id, saved_reel_ids))
        return f"organize-{len(created)}"

    async def run_job(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(main, "create_organize_job", create_job)
    monkeypatch.setattr(main, "run_organize_job", run_job)

    for _ in range(3):
        response = await ac.post(
            "/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID]}
        )
        assert response.status_code == 200
    response = await ac.post(
        "/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID]}
    )

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "rate_limited"
    assert len(created) == 3


async def test_saved_reels_organize_rejects_malformed_id_before_db_or_background(ctx, monkeypatch):
    ac, db, _calls, client = ctx
    background_calls = []
    monkeypatch.setattr(main, "run_organize_job", lambda *args, **kwargs: background_calls.append((args, kwargs)))

    response = await ac.post("/saved-reels/organize", json={"saved_reel_ids": ["not-a-uuid"]})

    assert response.status_code == 422
    assert db == {}
    assert client.rpc_calls == []
    assert background_calls == []


async def test_saved_reels_organize_stringifies_uuid_ids_before_db_and_background(ctx, monkeypatch):
    ac, _db, _calls, _client = ctx
    created = []
    background_calls = []

    async def create_job(_client, _user_id, saved_reel_ids):
        created.append(saved_reel_ids)
        return "organize-1"

    monkeypatch.setattr(main, "create_organize_job", create_job)
    monkeypatch.setattr(main, "run_organize_job", lambda *args, **kwargs: background_calls.append((args, kwargs)))

    response = await ac.post("/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID]})

    assert response.status_code == 200
    assert created == [[_SAVED_REEL_ID]]
    assert background_calls == [(("organize-1", "user-1"), {"client": _client})]


async def test_saved_reels_organize_rejects_duplicate_ids_before_the_rpc(ctx, monkeypatch):
    """Duplicate saved_reel_ids must be a 422 at the boundary, not a 500 out of the RPC.
    The fake mirrors the real guard (20260719102000_saved_reels_active_item_guard.sql): a
    generic P0001 whose message create_organize_job does NOT map, so reaching it surfaces
    as an unhandled APIError -> 500. Rejecting in Pydantic means it is never reached."""
    from postgrest.exceptions import APIError

    _ac, db, _calls, client = ctx
    background_calls = []

    async def create_job(_client, _user_id, saved_reel_ids):
        if len(set(saved_reel_ids)) != len(saved_reel_ids):
            raise APIError({"code": "P0001", "message": "Saved Reel organize request is invalid",
                            "details": None, "hint": None})
        return "organize-1"

    monkeypatch.setattr(main, "create_organize_job", create_job)
    monkeypatch.setattr(main, "run_organize_job",
                        lambda *args, **kwargs: background_calls.append((args, kwargs)))

    # raise_app_exceptions=False so an unmapped APIError surfaces as the 500 the
    # unhandled_exception_handler actually returns in production, rather than being
    # re-raised into the test -- the 422-vs-500 distinction is the whole point here.
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        response = await ac.post(
            "/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID, _SAVED_REEL_ID]}
        )

    assert response.status_code == 422
    assert db == {}
    assert client.rpc_calls == []
    assert background_calls == []


async def test_saved_reels_organize_active_overlap_is_a_conflict(ctx, monkeypatch):
    from organizer import ActiveOrganizeConflict

    async def create_job(*_args, **_kwargs):
        raise ActiveOrganizeConflict("Saved Reel is already being organized")

    monkeypatch.setattr(main, "create_organize_job", create_job)
    response = await ctx[0].post(
        "/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID]}
    )

    assert response.status_code == 409
    assert response.json() == {
        "error": {
            "code": "conflict",
            "message": "Saved Reel is already being organized",
        }
    }


async def test_saved_reels_organize_requires_auth(monkeypatch):
    called = False

    async def create_job(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("unauthenticated request must not create a job")

    monkeypatch.setattr(main, "create_organize_job", create_job)
    main.app.dependency_overrides.clear()

    async with _async_client() as ac:
        response = await ac.post(
            "/saved-reels/organize", json={"saved_reel_ids": [_SAVED_REEL_ID]}
        )

    assert response.status_code == 401
    assert called is False


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

    monkeypatch.setattr(main, "ENTITLEMENTS_ENABLED", False)   # exercises the legacy path (as before Task 4)
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


# ---------------------------------------------------------------------------
# Request schema parity + profile/per-trip preference merge (beta wiring plan Task 1).
# ---------------------------------------------------------------------------


async def test_generate_trip_persists_preference_fields(ctx):
    ac, db, _calls, _client = ctx
    db["traveler_profiles"] = [{
        "id": "user-1", "origin_city": "Kuala Lumpur",
        "travel_style_tags": ["food-led"], "preference_tags": ["ramen"],
        "preference_notes": "no early mornings",
    }]
    payload = {**_PAYLOAD, "budget_level": "mid_range", "origin_city": "Penang",
               "preferences": "vegetarian this trip", "requested_places": ["Tokyo Tower"]}
    r = await ac.post("/generate-trip", json=payload)
    assert r.status_code == 200
    trip = db["trips"][0]
    assert trip["budget_level"] == "mid_range"
    assert trip["origin_city"] == "Penang"  # explicit request wins over profile
    assert "Travel style: food-led." in trip["preference_summary"]
    assert "This trip: vegetarian this trip" in trip["preference_summary"]
    assert trip["preference_sources"] == ["memory", "explicit"]
    create_trip_events = [e for e in db["generation_events"] if e["stage"] == "create_trip"]
    assert create_trip_events[0]["payload"]["requested_places"] == ["Tokyo Tower"]


async def test_generate_trip_origin_city_falls_back_to_profile(ctx):
    ac, db, _calls, _client = ctx
    db["traveler_profiles"] = [{
        "id": "user-1", "origin_city": "Kuala Lumpur",
        "travel_style_tags": [], "preference_tags": [], "preference_notes": None,
    }]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    assert db["trips"][0]["origin_city"] == "Kuala Lumpur"


async def test_generate_trip_old_shape_payload_still_succeeds(ctx):
    """CRITICAL REGRESSION TEST: the pre-parity minimal body (reel_urls + dates only,
    no traveler_profiles row) must keep working — all new fields are optional."""
    ac, db, _calls, _client = ctx
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    trip = db["trips"][0]
    assert trip["budget_level"] is None
    assert trip["origin_city"] is None
    assert trip["preference_summary"] is None
    assert trip["preference_sources"] == []


# ---------------------------------------------------------------------------
# budget_level: a client error must read as one (422), not as a 500.
# ---------------------------------------------------------------------------


async def test_generate_trip_rejects_unknown_budget_level_before_the_db(ctx):
    """`budget_level: "mid"` used to reach Postgres, violate trips_budget_level_check
    (23514), hit the broad handler and surface as a 500 — a client error reported as a
    server error. Pydantic must reject it first, with ZERO side effects: no trip row, no
    quota RPC, no dispatch."""
    ac, db, calls, client = ctx
    r = await ac.post("/generate-trip", json={**_PAYLOAD, "budget_level": "mid"})

    assert r.status_code == 422
    assert db == {}                # never reached the database
    assert client.rpc_calls == []  # no quota consumed
    assert calls == []             # never dispatched


@pytest.mark.parametrize("budget_level", ["budget", "mid_range", "premium", "luxury", None])
async def test_generate_trip_accepts_every_db_valid_budget_level(ctx, budget_level):
    """The accepted set must be exactly the SQL CHECK's set (guardrail #4 — the same four
    values as BudgetLevel in frontend/lib/trip/backend-types.ts). Narrowing the type must
    not reject a value the database would have taken."""
    ac, db, _calls, _client = ctx
    r = await ac.post("/generate-trip", json={**_PAYLOAD, "budget_level": budget_level})

    assert r.status_code == 200
    assert db["trips"][0]["budget_level"] == budget_level


async def test_generate_trip_still_accepts_unrecognized_pace(ctx):
    """The budget_level fix must NOT be over-applied to `pace`. `pace` has no DB CHECK, so
    an unknown value is accepted and merely flows into a prompt — deliberately permissive
    (schemas.py). Only a field the database is guaranteed to reject gets a Literal."""
    ac, db, _calls, _client = ctx
    r = await ac.post("/generate-trip", json={**_PAYLOAD, "pace": "hyperspeed"})

    assert r.status_code == 200
    create_trip_events = [e for e in db["generation_events"] if e["stage"] == "create_trip"]
    assert create_trip_events[0]["payload"]["pace"] == "hyperspeed"


# ---------------------------------------------------------------------------
# The enqueue handler must not be silent: Render logged only `POST 500`.
# ---------------------------------------------------------------------------


async def test_generate_trip_enqueue_failure_logs_the_real_exception(ctx, monkeypatch, caplog):
    """The broad handler swallowed the exception entirely, so a 500 was undiagnosable from
    Render's logs. It must log the traceback server-side while the CLIENT response stays
    the same opaque envelope."""
    ac, _db, _calls, _client = ctx

    async def _boom_enqueue(*_args, **_kwargs):
        raise RuntimeError("distinctive-enqueue-boom")

    monkeypatch.setattr(main, "enqueue_job", _boom_enqueue)

    with caplog.at_level("ERROR", logger="main"):
        r = await ac.post("/generate-trip", json=_PAYLOAD)

    assert r.status_code == 500
    assert "generate_trip_enqueue_failed" in caplog.text
    assert "distinctive-enqueue-boom" in caplog.text  # the traceback, not just the event name
    assert "distinctive-enqueue-boom" not in r.text   # never leaked to the client
    assert r.json()["error"]["message"] == "Could not enqueue generation job"


async def test_generate_trip_swallowed_fail_mark_and_refund_failures_are_logged(
    ctx, monkeypatch, caplog
):
    """The two `except Exception: pass` siblings were silent too. A failed fail-mark strands
    a trip in `generating`; a failed refund costs the user a day's quota. Both stay
    best-effort (the 500 is still raised, the refund still runs) but must leave a trace —
    error TYPE only, matching organizer.py, since these carry DB-error text."""
    ac, _db, _calls, client = ctx

    async def _boom_enqueue(*_args, **_kwargs):
        raise RuntimeError("enqueue boom")

    monkeypatch.setattr(main, "enqueue_job", _boom_enqueue)
    client.fail_ops.add(("trips", "update"))                    # fail-mark raises
    client.rpc_results["decrement_daily_trip_usage"] = _RAISE   # refund raises too

    with caplog.at_level("WARNING", logger="main"):
        r = await ac.post("/generate-trip", json=_PAYLOAD)

    assert r.status_code == 500
    assert "generate_trip_fail_mark_failed" in caplog.text
    assert "generate_trip_quota_refund_failed" in caplog.text


# ---------------------------------------------------------------------------
# ENTITLEMENTS_ENABLED=True: the atomic-RPC entitlement path (Task 4). `ctx` above pins the
# flag False so the legacy tests keep validating _generate_trip_legacy unchanged; these use
# `rpc_ctx` (flag True) and drive reserve_and_enqueue_trip_job's six outcomes. One extra
# legacy test below (flag OFF) proves the rollback path is partial-index-safe.
# ---------------------------------------------------------------------------

_RESERVE = "reserve_and_enqueue_trip_job"


async def test_generate_trip_rpc_created_dispatches_once(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "created", "trip_id": "trip-9", "job_id": "job-9"}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["trip_id"] == "trip-9"
    assert len(calls) == 1                        # dispatched exactly once
    assert calls[0][0][0] == "trip-9"             # run_generation(res.trip_id, ...)
    assert calls[0][1]["job_id"] == "job-9"       # threaded res.job_id
    assert [c[0] for c in client.rpc_calls] == [_RESERVE]   # the RPC is the only DB write


async def test_generate_trip_rpc_replay_returns_trip_without_dispatch(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "replay", "trip_id": "trip-existing", "job_id": None}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["trip_id"] == "trip-existing"
    assert calls == []                            # replay charges nothing and creates no job


async def test_generate_trip_rpc_trial_exhausted_returns_403_envelope(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "trial_exhausted", "trip_id": None, "job_id": None}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 403
    body = r.json()["error"]
    assert body["code"] == "trial_exhausted"
    assert "only 25 exist" in body["message"]     # the user-facing beta-seat copy
    assert calls == []


async def test_generate_trip_rpc_daily_exhausted_returns_429(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "daily_exhausted", "trip_id": None, "job_id": None}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"
    assert calls == []


async def test_generate_trip_rpc_conflict_retry_returns_409(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "conflict_retry", "trip_id": None, "job_id": None}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "conflict_retry"
    assert calls == []


async def test_generate_trip_rpc_identity_unavailable_returns_503(rpc_ctx):
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "identity_unavailable", "trip_id": None, "job_id": None}]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "identity_unavailable"
    assert calls == []


async def test_generate_trip_rpc_budget_level_change_is_not_a_replay(rpc_ctx):
    """Fix 9: two POSTs differing ONLY in budget_level must produce two DIFFERENT
    p_idempotency_key values on the RPC (compute_idempotency_key runs for real here), so a
    genuinely different request can never collide into the other's replay."""
    ac, _db, _calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "created", "trip_id": "trip-x", "job_id": "job-x"}]
    r1 = await ac.post("/generate-trip", json={**_PAYLOAD, "budget_level": "budget"})
    r2 = await ac.post("/generate-trip", json={**_PAYLOAD, "budget_level": "luxury"})
    assert r1.status_code == 200 and r2.status_code == 200
    reserve_params = [params for name, params in client.rpc_calls if name == _RESERVE]
    assert len(reserve_params) == 2
    assert reserve_params[0]["p_idempotency_key"] != reserve_params[1]["p_idempotency_key"]


async def test_generate_trip_rpc_created_after_refund_dispatches_again(rpc_ctx):
    """Refunded-failure retry (endpoint level): once a refund frees the key (proven at the
    DB layer by pgTAP/1a), a same-input re-POST that the RPC answers `created` again gets a
    fresh dispatch — the endpoint must treat `created` as a new job, never as a replay."""
    ac, _db, calls, client = rpc_ctx
    client.rpc_results[_RESERVE] = [{"outcome": "created", "trip_id": "trip-a", "job_id": "job-a"}]
    first = await ac.post("/generate-trip", json=_PAYLOAD)
    second = await ac.post("/generate-trip", json=_PAYLOAD)   # same key; RPC issues a fresh job
    assert first.status_code == 200 and second.status_code == 200
    assert len(calls) == 2                        # dispatched twice, not deduped as a replay


async def test_generate_trip_legacy_replay_returns_active_row_with_refunded_sibling(ctx):
    """Migrated-DB rollback (flag OFF): the partial unique index permits one ACTIVE row + a
    refunded sibling under one key. The legacy replay lookup is `.is_()`-filtered, so it
    returns exactly the ACTIVE trip (never >1 -> no 500), consumes no quota, inserts no trip."""
    from api.schemas import GenerateTripRequest
    from jobs import compute_idempotency_key

    ac, db, calls, client = ctx
    req = GenerateTripRequest(**_PAYLOAD)
    place_ids = [str(p) for p in req.place_ids]
    idem = compute_idempotency_key(
        "user-1", req.reel_urls, req.start_date, req.end_date,
        preferences=req.preferences, pace=req.pace, destination_hint=req.destination_hint,
        place_ids=place_ids, budget_level=req.budget_level, origin_city=req.origin_city,
        requested_places=req.requested_places,
    )
    db["jobs"] = [
        {"id": "job-refunded", "trip_id": "trip-refunded", "user_id": "user-1",
         "idempotency_key": idem, "charge_refunded_at": "2026-08-01T00:00:00+00:00"},
        {"id": "job-active", "trip_id": "trip-active", "user_id": "user-1",
         "idempotency_key": idem, "charge_refunded_at": None},
    ]
    r = await ac.post("/generate-trip", json=_PAYLOAD)
    assert r.status_code == 200
    assert r.json()["trip_id"] == "trip-active"        # the .is_()-filtered lookup returns exactly one
    assert db.get("trips", []) == []                   # no new trip inserted
    assert "increment_daily_trip_usage" not in [c[0] for c in client.rpc_calls]   # quota untouched
    assert calls == []                                 # never dispatched


async def test_boot_time_recovery_failure_does_not_down_the_app(monkeypatch):
    """A DB blip during the startup recovery sweep must DEGRADE, not crash the app —
    the lifespan must not raise, and /health must still serve (Fix 2)."""
    # `lifespan` now validates required secrets BEFORE its broad try, so entering it needs a
    # complete config. Only tests that ENTER the lifespan need this — importing `main` stays
    # credential-free, which the whole offline suite and the #16 eval depend on.
    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")

    async def _get_client():
        return object()  # never touched further; reclaim_expired_jobs raises first

    async def _failing_recover(**_kwargs):
        raise RuntimeError("boot-time db blip")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "reclaim_expired_jobs", _failing_recover)

    # The lifespan startup must swallow the recovery error (not propagate it).
    async with main.lifespan(main.app):
        pass

    # And the app still serves /health.
    async with _async_client() as ac:
        r = await ac.get("/health")
    assert r.status_code == 200


async def test_boot_time_db_blip_still_warms_mem0(monkeypatch):
    """The mem0 warm must survive a boot-time DB blip.

    It used to sit INSIDE the Supabase try, so a failing sweep skipped it entirely and
    /readiness then reported `not_initialized` with a perfectly good key until the first
    trip lazily built the client — misleading in exactly the way the mem0 readiness field
    exists to prevent. The warm now lives in its own try AFTER that block (kept after, so
    its 8s construction timeout never delays guardrail #12 job recovery).
    """
    import mem0_client

    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")

    async def _get_client():
        return object()

    async def _failing_recover(**_kwargs):
        raise RuntimeError("boot-time db blip")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "reclaim_expired_jobs", _failing_recover)

    warmed = {"n": 0}

    async def _fake_warm():
        warmed["n"] += 1
        return None

    monkeypatch.setattr(mem0_client, "get_mem0_client", _fake_warm)

    async with main.lifespan(main.app):
        pass

    # The DB blip must NOT have cost us the warm.
    assert warmed["n"] == 1


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
    assert r.json()["ready"] is True
    # mem0's configuration state rides along on every probe (see test_settings_routes.py);
    # its VALUE depends on ambient env, so pin only that the field is reported at all.
    assert "mem0" in r.json()


async def test_readiness_503_when_db_unreachable(monkeypatch):
    async def _get_client():
        raise RuntimeError("db unreachable")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    async with _async_client() as ac:
        r = await ac.get("/readiness")
    assert r.status_code == 503
    assert r.json()["ready"] is False


# ---------------------------------------------------------------------------
# GET /generate-trip/stream/{trip_id}: the guardrail #6 owner check + the
# happy path (200, text/event-stream, ordered frames, `data: [DONE]` last).
# ---------------------------------------------------------------------------

_TRIP_ID = "11111111-1111-4111-8111-111111111111"
_OTHER_TRIP_ID = "22222222-2222-4222-8222-222222222222"


async def test_stream_on_a_nonexistent_trip_is_404_not_500(ctx, stream_auth):
    # Regression (Codex plan review 2026-08-02): maybe_single() returns a bare None when no
    # row matches, so `owner.data` AttributeErrors into a 500. 500-vs-404 is an existence
    # oracle: it tells an unauthenticated-to-this-trip caller which trip ids are real.
    ac, db, _calls, _client = ctx

    response = await ac.get(f"/generate-trip/stream/{_TRIP_ID}?token=t")

    assert response.status_code == 404


async def test_stream_on_another_users_trip_is_404(ctx, stream_auth):
    ac, db, _calls, _client = ctx
    db.setdefault("trips", []).append({"id": _OTHER_TRIP_ID, "user_id": "user-2"})

    response = await ac.get(f"/generate-trip/stream/{_OTHER_TRIP_ID}?token=t")

    assert response.status_code == 404


def _seed_stream_events(db, trip_id=_TRIP_ID):
    """Seed generation_events for `trip_id`, INSERTED IN REVERSE of (created_at, id) ascending.

    Two things ride on the scramble. (1) Frame order below then proves the route really
    orders — under an unsorted fake the `result` row comes back first, the generator
    terminates on it, and the earlier stages never reach the wire at all. (2) `ev-1`/`ev-2`
    share a created_at, so the `.order("id")` tiebreak is what separates them.

    The `result` row is seeded UP FRONT on purpose: stream_trip_events returns the moment it
    sees one, so the first poll terminates and nothing sleeps. Omit it and httpx waits out
    600 polls at 0.5s.
    """
    db.setdefault("generation_events", []).extend([
        {"id": "ev-4", "trip_id": trip_id, "event_type": "result", "stage": "save",
         "message": "done", "payload": {"itinerary": {"days": []}},
         "created_at": "2026-08-02T00:00:02Z"},
        {"id": "ev-3", "trip_id": trip_id, "event_type": "stage", "stage": "narrate",
         "message": "narrating", "payload": {}, "created_at": "2026-08-02T00:00:01Z"},
        {"id": "ev-2", "trip_id": trip_id, "event_type": "stage", "stage": "extract",
         "message": "extracting", "payload": {}, "created_at": "2026-08-02T00:00:00Z"},
        {"id": "ev-1", "trip_id": trip_id, "event_type": "stage", "stage": "scrape",
         "message": "scraping", "payload": {}, "created_at": "2026-08-02T00:00:00Z"},
    ])


async def test_stream_for_the_owner_is_an_event_stream_terminated_by_done(ctx, stream_auth):
    """The route's ONLY happy-path coverage. Without it, deleting the whole route leaves the
    two 404 tests above green: their expected 404 is indistinguishable from FastAPI's
    framework 404 for a route that isn't registered (Codex cross-model review 2026-08-02).
    api/test_streaming.py covers stream_trip_events, never the route that mounts it."""
    ac, db, _calls, _client = ctx
    db.setdefault("trips", []).append({"id": _TRIP_ID, "user_id": "user-1"})
    _seed_stream_events(db)

    response = await ac.get(f"/generate-trip/stream/{_TRIP_ID}?token=t")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    body = response.text
    # The repo's most breaking contract: a `result` frame, then `data: [DONE]` LAST (CLAUDE.md
    # "SSE termination"). The frontend breaks on the sentinel, so nothing may follow it.
    assert '"type": "result"' in body
    assert body.endswith("data: [DONE]\n\n")
    # result.content is a JSON *string*, not a nested object — same frozen contract.
    assert '"content": "{\\"itinerary\\": {\\"days\\": []}}"' in body
    # Every stage frame reaches the client, in (created_at, id) order — NOT insertion order.
    assert (
        body.index("scraping")
        < body.index("extracting")
        < body.index("narrating")
        < body.index('"type": "result"')
    )
    # The terminal event was in the first batch, so the generator returned without sleeping —
    # this is what keeps the test off the 600-poll / 5-minute path.
    assert ": heartbeat\n\n" not in body


# --- POST /trips/{trip_id}/feedback ------------------------------------------------
# _TRIP_ID and _OTHER_TRIP_ID were added in Task 2 — do not redefine them here.


def _seed_trip(db, trip_id=_TRIP_ID, user_id="user-1", status="completed"):
    db.setdefault("trips", []).append({"id": trip_id, "user_id": user_id, "status": status})


async def test_feedback_rating_is_stored_for_the_owner(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "rating", "rating": 4, "comment": "loved day 2"},
    )

    assert response.status_code == 201
    body = response.json()["feedback"]
    assert body["trip_id"] == _TRIP_ID
    assert body["artifact_type"] == "trip"
    assert body["rating"] == 4
    assert body["comment"] == "loved day 2"

    rows = db["feedback"]
    assert len(rows) == 1
    assert rows[0]["trip_id"] == _TRIP_ID          # STORED trip_id, from the path (gap found in review)
    assert rows[0]["user_id"] == "user-1"          # from the token, never the body
    assert rows[0]["artifact_type"] == "trip"
    assert rows[0]["artifact_id"] is None
    # PRD:1035 columns are deliberately deferred for trip-level feedback.
    assert rows[0]["source_type"] is None
    assert rows[0]["generation_stage"] is None
    assert rows[0]["preference_source"] is None


@pytest.mark.parametrize(
    "payload",
    [
        {"feedback_type": "thumbs_up"},
        {"feedback_type": "thumbs_down", "comment": "too much walking"},
        {"feedback_type": "free_text", "comment": "great but rushed"},
        {"feedback_type": "correction", "comment": "the museum is closed Mondays"},
    ],
)
async def test_feedback_accepts_every_non_rating_type(ctx, payload):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json=payload)

    assert response.status_code == 201
    assert db["feedback"][0]["feedback_type"] == payload["feedback_type"]


async def test_feedback_on_another_users_trip_is_404_and_writes_nothing(ctx):
    # THE owner-check test (guardrail #6). service_role bypasses RLS, so this app-code
    # check is the ONLY thing standing between a caller and someone else's trip.
    ac, db, _calls, _client = ctx
    _seed_trip(db, trip_id=_OTHER_TRIP_ID, user_id="user-2")

    response = await ac.post(
        f"/trips/{_OTHER_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
    )

    assert response.status_code == 404          # 404 not 403 — do not confirm the trip exists
    assert db.get("feedback", []) == []         # the write must not have happened


async def test_feedback_on_a_nonexistent_trip_is_404(ctx):
    ac, db, _calls, _client = ctx

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
    )

    assert response.status_code == 404
    assert db.get("feedback", []) == []


async def test_feedback_is_accepted_on_a_failed_trip(ctx):
    # Deliberate: "this didn't work" is the most valuable beta signal we can collect.
    ac, db, _calls, _client = ctx
    _seed_trip(db, status="failed")

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_down", "comment": "failed"}
    )

    assert response.status_code == 201


async def test_feedback_is_append_only(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    first = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "rating", "rating": 2})
    second = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "rating", "rating": 5})

    assert first.status_code == 201
    assert second.status_code == 201
    assert [r["rating"] for r in db["feedback"]] == [2, 5]
    assert first.json()["feedback"]["id"] != second.json()["feedback"]["id"]


async def test_feedback_rejects_a_client_supplied_user_id(ctx):
    # user_id must come from the token. extra="forbid" makes smuggling it a 422.
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "thumbs_up", "user_id": "user-2"},
    )

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_rejects_a_client_supplied_artifact_target(ctx):
    # Aiming feedback at an arbitrary artifact must not be possible on this endpoint.
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    response = await ac.post(
        f"/trips/{_TRIP_ID}/feedback",
        json={"feedback_type": "thumbs_up", "artifact_type": "place", "artifact_id": _OTHER_TRIP_ID},
    )

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_rejects_a_malformed_trip_id_before_touching_the_db(ctx):
    ac, db, _calls, client = ctx

    response = await ac.post("/trips/not-a-uuid/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 422
    assert db.get("feedback", []) == []


async def test_feedback_requires_authentication():
    # No ctx fixture: the real auth dependency runs, so no Authorization header -> 401.
    async with _async_client() as ac:
        response = await ac.post(
            f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"}
        )
    assert response.status_code == 401


async def test_feedback_burst_limit_returns_429(ctx):
    ac, db, _calls, _client = ctx
    _seed_trip(db)

    codes = []
    for _ in range(4):
        r = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})
        codes.append(r.status_code)

    assert codes[:3] == [201, 201, 201]   # BURST_LIMIT default is 3/minute
    assert codes[3] == 429


async def test_feedback_insert_raising_surfaces_as_500_not_a_silent_success(ctx):
    # A LOCAL transport with raise_app_exceptions=False. The shared `ac` from ctx defaults to
    # True, so Starlette's error middleware sends the 500 AND re-raises -- httpx then re-raises
    # into the test, which crashes before the assert instead of failing it. Same reason and
    # same pattern as test_main.py:405.
    _ac, db, _calls, client = ctx
    _seed_trip(db)
    client.fail_ops.add(("feedback", "insert"))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 500
    assert db.get("feedback", []) == []


async def test_feedback_insert_returning_no_rows_is_a_500(ctx):
    # Distinct from the raising case: this is the ONLY test that makes the explicit
    # `if not inserted.data` guard load-bearing.
    #
    # THE STATUS CODE CANNOT TELL THE TWO PATHS APART (Codex round 2, demonstrated by
    # execution). Delete the guard and `inserted.data[0]` raises IndexError, which the global
    # unhandled_exception_handler ALSO renders as a 500 with an empty db -- so asserting
    # `status_code == 500` and `db == []` stays green either way. Only the MESSAGE differs:
    #   guard present -> {"code": "internal_error", "message": "Failed to store feedback"}
    #   guard deleted -> {"code": "internal_error", "message": "Internal server error"}
    # The message assertion below is therefore the whole test. Do not drop it.
    _ac, db, _calls, client = ctx
    _seed_trip(db)
    client.empty_result_ops.add(("feedback", "insert"))

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as ac:
        response = await ac.post(f"/trips/{_TRIP_ID}/feedback", json={"feedback_type": "thumbs_up"})

    assert response.status_code == 500
    assert response.json()["error"]["message"] == "Failed to store feedback"
    assert db.get("feedback", []) == []


# ---------------------------------------------------------------------------
# POST /request-seat (Task 6): idempotent beta-seat stamp via the request_seat RPC.
# request_seat RETURNS a scalar timestamptz, so the fake client hands it back as resp.data
# directly (the repo's scalar-RPC convention — check_and_increment_daily_quota reads
# increment_daily_trip_usage's `returns int` the same way). Reuses `rpc_ctx`: a fake
# supabase client (rpc_results drives the RPC's answer) + a stashed authenticated user +
# raise_app_exceptions=False so the enveloped 5xx surfaces as a response.
# ---------------------------------------------------------------------------

_REQUEST_SEAT = "request_seat"
_SEAT_STAMP = "2026-08-03T13:00:00+00:00"


async def test_request_seat_requires_auth():
    # No override: the real auth dependency runs, so no Authorization header -> 401
    # (mirrors test_generate_trip_requires_auth).
    main.app.dependency_overrides.clear()
    async with _async_client() as ac:
        r = await ac.post("/request-seat")
    assert r.status_code == 401


async def test_request_seat_returns_stamp(rpc_ctx):
    from datetime import datetime

    ac, _db, _calls, client = rpc_ctx
    client.rpc_results[_REQUEST_SEAT] = _SEAT_STAMP
    r = await ac.post("/request-seat")
    assert r.status_code == 200
    # Response envelope is exactly {"requested_at": <stamp>}; the value round-trips to the
    # stamp the RPC returned (format-agnostic compare — Pydantic may emit 'Z' or '+00:00').
    assert list(r.json().keys()) == ["requested_at"]
    assert datetime.fromisoformat(r.json()["requested_at"]) == datetime.fromisoformat(_SEAT_STAMP)
    # The RPC is called once, keyed on the token-derived user id (never a body value).
    assert client.rpc_calls == [(_REQUEST_SEAT, {"p_user_id": "user-1"})]


async def test_request_seat_is_idempotent(rpc_ctx):
    # coalesce(seat_requested_at, now()) means repeat clicks return the ORIGINAL stamp: the RPC
    # hands back the same value each call, so two POSTs return an identical requested_at.
    ac, _db, _calls, client = rpc_ctx
    client.rpc_results[_REQUEST_SEAT] = _SEAT_STAMP
    first = await ac.post("/request-seat")
    second = await ac.post("/request-seat")
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["requested_at"] == second.json()["requested_at"]


async def test_request_seat_missing_row_returns_503_identity_unavailable(rpc_ctx):
    # No users row -> the RPC's UPDATE matches nothing -> returns NULL -> resp.data is None.
    # The endpoint maps that to 503 identity_unavailable (never a silent 200 with no stamp).
    ac, _db, _calls, client = rpc_ctx
    client.rpc_results[_REQUEST_SEAT] = None
    r = await ac.post("/request-seat")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "identity_unavailable"


async def test_request_seat_pgrst202_fails_closed_503(rpc_ctx, monkeypatch):
    # RPC absent from the live DB (a migration that lagged the code deploy) -> PGRST202 ->
    # fail CLOSED with a distinct 503 seat_request_unavailable (its OWN code/message — the
    # seat endpoint must not reuse the generate wrapper's "generation_unavailable" copy).
    # Any other APIError would propagate as a 500.
    from postgrest.exceptions import APIError

    ac, _db, _calls, client = rpc_ctx

    class _RaisingRpc:
        async def execute(self):
            raise APIError({"code": "PGRST202", "message": "function not found"})

    def _rpc(name, params):
        client.rpc_calls.append((name, params))
        return _RaisingRpc()

    monkeypatch.setattr(client, "rpc", _rpc)
    r = await ac.post("/request-seat")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "seat_request_unavailable"
