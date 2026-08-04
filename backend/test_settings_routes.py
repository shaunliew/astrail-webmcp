"""Keyless tests for the mem0 settings surface — no network, no DB.

Task 2 adds the /readiness coverage; Task 4 adds the GET /settings/preferences
coverage plus a shared _client() helper and an autouse reset fixture.
"""
import httpx
import pytest
from fastapi import Request


class _Mem0:
    def __init__(self, rows=None):
        self.rows, self.read_calls = rows or [], []

    async def get_all(self, **kw):
        self.read_calls.append(kw)          # recorded; asserted below
        return {"results": self.rows}


def _client(monkeypatch, *, mem0, uid_box):
    import main, mem0_client

    async def _fake_mem0(): return mem0
    monkeypatch.setattr(mem0_client, "get_mem0_client", _fake_mem0)

    from rate_limit import get_current_user_id_stashed

    # Production stashes request.state.user_id (rate_limit.py:50) and the limiter keys on
    # it. A bare `lambda: "u1"` would silently key on IP, so the tests would not exercise
    # per-user limiting at all. uid_box makes the identity switchable mid-test
    # (pattern: test_main.py::test_burst_limit_is_per_user_not_shared).
    async def _override(request: Request) -> str:
        request.state.user_id = uid_box["uid"]
        return uid_box["uid"]

    main.app.dependency_overrides[get_current_user_id_stashed] = _override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                             base_url="http://test")


@pytest.fixture(autouse=True)
def _reset():
    import main
    from rate_limit import limiter
    limiter.reset()
    yield
    main.app.dependency_overrides.clear()
    limiter.reset()


async def test_readiness_reports_mem0_state(monkeypatch):
    import main, mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "configured")

    class _Supabase:
        def table(self, name):
            class _T:
                def select(self, *_a, **_k): return self
                def limit(self, *_a, **_k): return self
                async def execute(self): return None
            return _T()

    async def _sb(): return _Supabase()
    monkeypatch.setattr(main, "get_supabase_client", _sb)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/readiness")
    assert r.status_code == 200
    assert r.json() == {"ready": True, "mem0": "configured"}


async def test_readiness_still_reports_mem0_when_db_is_down(monkeypatch):
    import main, mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "init_failed")

    class _Boom:
        def table(self, name): raise RuntimeError("db down")

    async def _sb(): return _Boom()
    monkeypatch.setattr(main, "get_supabase_client", _sb)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/readiness")
    assert r.status_code == 503
    assert r.json() == {"ready": False, "mem0": "init_failed"}


async def test_get_preferences_returns_facts(monkeypatch):
    mem = _Mem0(rows=[{"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07"}])
    async with _client(monkeypatch, mem0=mem, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "facts": [
        {"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07", "source": "mem0"}]}
    # guardrail #6: scoped to the TOKEN's user, never anything client-supplied.
    assert mem.read_calls[0]["filters"] == {"AND": [{"user_id": "u1"}]}


async def test_get_preferences_degrades_to_200_when_memory_disabled(monkeypatch):
    async with _client(monkeypatch, mem0=None, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 200
    assert r.json() == {"status": "disabled", "facts": []}


async def test_get_preferences_requires_auth(monkeypatch):
    # No dependency override: the real auth dependency must reject before mem0 is touched.
    import main, mem0_client
    mem = _Mem0(rows=[])

    async def _fake_mem0(): return mem
    monkeypatch.setattr(mem0_client, "get_mem0_client", _fake_mem0)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 401
    assert mem.read_calls == []          # mem0 never consulted for an anonymous caller


async def test_burst_limit_is_per_user_not_shared(monkeypatch):
    # Codex P2.3: four requests from ONE user 429 whether the limiter keys on the user or
    # the IP, so that proves nothing. Exhaust user A, then switch to user B on the SAME
    # client and prove B has a fresh bucket. (pattern: test_main.py::test_burst_limit_is_per_user_not_shared)
    box = {"uid": "user-A"}
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box=box) as c:
        a = [(await c.get("/settings/preferences")).status_code for _ in range(4)]
        box["uid"] = "user-B"
        b = (await c.get("/settings/preferences")).status_code
    assert a[:3] == [200, 200, 200]
    assert a[3] == 429                  # A exhausted 3/minute
    assert b == 200                     # B unaffected -> keyed on user, not IP


async def test_get_preferences_reports_unavailable_not_disabled_during_an_outage(monkeypatch):
    """A None client means EITHER no key OR construction failed. Only the first is
    `disabled`. During a mem0 OUTAGE (key set, construct failed) the Settings surface must
    NOT tell the user memory is switched off — that is the exact misdiagnosis this arc
    exists to remove, and it would contradict /readiness, which reports `init_failed`."""
    import mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "init_failed")
    async with _client(monkeypatch, mem0=None, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.status_code == 200
    assert r.json() == {"status": "unavailable", "facts": []}


async def test_get_preferences_still_reports_disabled_when_there_is_no_key(monkeypatch):
    """The other side of the same fork: no key really is `disabled`, and must stay so."""
    import mem0_client
    monkeypatch.setattr(mem0_client, "mem0_status", lambda: "disabled")
    async with _client(monkeypatch, mem0=None, uid_box={"uid": "u1"}) as c:
        r = await c.get("/settings/preferences")
    assert r.json() == {"status": "disabled", "facts": []}


# --- POST /settings/memory/clear ---------------------------------------------------
# The deliberate inverse of GET /settings/preferences: that read degrades (guardrail #3),
# this one fails loudly with two DISTINCT codes. So the spy CONTROLS the engine's outcome
# and each test asserts the HTTP response flipped with it -- "clear_memory was called" is
# satisfied by a route that discards the result, and a shared "returns 503" assertion
# cannot tell `memory_unavailable` from `memory_clear_unknown`, which is the whole reason
# the route returns build_error_response instead of raising HTTPException(503).


class _ClearSpy:
    def __init__(self, outcome):
        self.outcome, self.calls = outcome, []

    async def __call__(self, client, mem0, *, user_id):
        self.calls.append({"client": client, "mem0": mem0, "user_id": user_id})
        return self.outcome

    @property
    def uids(self):
        return [c["user_id"] for c in self.calls]


def _install_clear(monkeypatch, spy, *, supabase_fails=False):
    """Point the route's late-bound `clear_memory` at the spy and control the DB client.

    `from pipeline.memory_clear import clear_memory` runs INSIDE the handler, so the
    module attribute is what each request resolves -- patching it here is what the route
    actually calls.

    ALSO enables `_CLEAR_RECONCILIATION_READY`, because the route is gated OFF in
    production (see main.py). Every test using this helper is asserting what the endpoint
    does WHEN ENABLED, so it must opt in explicitly. Note the gate returns the same
    `503 memory_unavailable` as the A7 Supabase-failure path -- without this opt-in
    `test_clear_memory_reports_unavailable_when_supabase_client_fails` would pass while
    exercising the gate instead of the path it names (BUILD-LOOP trap: a green test that
    no longer tests its subject). `test_the_clear_route_is_gated_off_by_default` is the
    one test that deliberately does NOT enable it.
    """
    import main
    import pipeline.memory_clear as memory_clear

    monkeypatch.setattr(main, "_CLEAR_RECONCILIATION_READY", True)
    monkeypatch.setattr(memory_clear, "clear_memory", spy)

    async def _sb():
        if supabase_fails:
            raise RuntimeError("supabase unreachable")
        return object()

    monkeypatch.setattr(main, "get_supabase_client", _sb)


async def test_clear_memory_returns_cleared_on_success(monkeypatch):
    spy, mem = _ClearSpy("cleared"), _Mem0(rows=[])
    _install_clear(monkeypatch, spy)
    async with _client(monkeypatch, mem0=mem, uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    assert r.status_code == 200
    assert r.json() == {"cleared": True}
    # guardrail #6: the id is token-derived, never client-supplied; and the live mem0
    # client is handed through (passing None would make every clear a no-op upstream).
    assert spy.uids == ["u1"]
    assert spy.calls[0]["mem0"] is mem


async def test_clear_memory_reports_memory_unavailable_code(monkeypatch):
    """`unavailable` means NOTHING was deleted -- a safe retry. It must not be collapsed
    into the `unknown` code, whose advice to the user is the opposite (do not retry)."""
    spy = _ClearSpy("unavailable")
    _install_clear(monkeypatch, spy)
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    body = r.json()
    assert r.status_code == 503
    assert body["error"]["code"] == "memory_unavailable"
    # the shared envelope (api/errors.py), NOT FastAPI's raw {"detail": ...}
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert body["error"]["message"]
    assert spy.uids == ["u1"]


async def test_clear_memory_reports_memory_clear_unknown_code(monkeypatch):
    """The other half of the fork: `unknown` means the outcome could not be verified."""
    spy = _ClearSpy("unknown")
    _install_clear(monkeypatch, spy)
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    body = r.json()
    assert r.status_code == 503
    assert body["error"]["code"] == "memory_clear_unknown"
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert body["error"]["message"]
    assert spy.uids == ["u1"]


async def test_clear_memory_requires_auth(monkeypatch):
    # No dependency override: the real auth dependency must reject BEFORE anything
    # reaches mem0 or the DB. An anonymous caller must never delete a thing.
    import main
    spy = _ClearSpy("cleared")
    _install_clear(monkeypatch, spy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.post("/settings/memory/clear")
    assert r.status_code == 401
    assert spy.calls == []


async def test_clear_memory_reports_unavailable_when_supabase_client_fails(monkeypatch):
    """A7: without a client the concurrency guard cannot be armed, so nothing is deleted.
    That is `memory_unavailable` inside the documented contract -- an unwrapped
    get_supabase_client() would surface the global handler's 500 internal_error, which is
    outside it. The spy would report success if it were ever reached."""
    spy = _ClearSpy("cleared")
    _install_clear(monkeypatch, spy, supabase_fails=True)
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    body = r.json()
    assert r.status_code == 503
    assert body["error"]["code"] == "memory_unavailable"
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert spy.calls == []               # never attempted: nothing was deleted


async def test_clear_burst_limit_is_per_user_not_shared(monkeypatch):
    # Four requests from ONE user 429 whether the limiter keys on the user or the IP, so
    # that alone proves nothing. Exhaust user A, then switch to user B on the SAME client
    # and prove B has a fresh bucket. (pattern: test_main.py::test_burst_limit_is_per_user_not_shared)
    spy = _ClearSpy("cleared")
    _install_clear(monkeypatch, spy)
    box = {"uid": "user-A"}
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box=box) as c:
        a = [(await c.post("/settings/memory/clear")).status_code for _ in range(4)]
        box["uid"] = "user-B"
        b = (await c.post("/settings/memory/clear")).status_code
    assert a[:3] == [200, 200, 200]
    assert a[3] == 429                  # A exhausted 3/minute
    assert b == 200                     # B unaffected -> keyed on user, not IP
    assert spy.uids == ["user-A"] * 3 + ["user-B"]   # the 429 never reached the engine


async def test_the_clear_route_is_gated_off_by_default(monkeypatch):
    """The SHIPPING behaviour: the route is gated OFF and must not attempt anything.

    Deliberately does NOT call `_install_clear` -- that helper enables the gate. This is
    the one test asserting production's real posture.

    `memory_unavailable`, not `memory_clear_unknown`: that code means "CONFIRMED nothing
    was deleted", which is provably true when we never attempt. `unknown` would claim an
    uncertainty we do not have.
    """
    import main
    import pipeline.memory_clear as memory_clear

    spy = _ClearSpy("cleared")            # answers 200 if the gate ever lets it through
    monkeypatch.setattr(memory_clear, "clear_memory", spy)

    # A HEALTHY Supabase stub, deliberately. An earlier draft made this RAISE to "prove"
    # the DB is never touched -- and the test passed with the gate flipped ON, because the
    # route's A7 handler catches every exception from get_supabase_client and returns the
    # SAME 503 memory_unavailable the gate returns. Both assertions then held for the wrong
    # reason (clear_memory is unreachable when the client fails, so `spy.calls == []` too).
    # Found by fault injection, not by reading. The outcome must be one ONLY the gate can
    # produce: with a healthy client and a "cleared" spy, an ungated route answers 200.
    sb_calls: list = []

    async def _sb():
        sb_calls.append(1)
        return object()

    monkeypatch.setattr(main, "get_supabase_client", _sb)

    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    body = r.json()
    assert r.status_code == 503           # ungated + healthy client + "cleared" spy => 200
    assert body["error"]["code"] == "memory_unavailable"
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert spy.calls == []                # nothing attempted
    assert sb_calls == []                 # returned BEFORE spending a DB round-trip


async def test_the_clear_gate_is_the_only_thing_disabling_the_route(monkeypatch):
    """Flipping the flag restores the full contract -- so the gate is a deployment switch,
    not a rewrite. Pins that the engine ships intact and re-enabling is one line."""
    spy = _ClearSpy("cleared")
    _install_clear(monkeypatch, spy)      # enables the flag
    async with _client(monkeypatch, mem0=_Mem0(rows=[]), uid_box={"uid": "u1"}) as c:
        r = await c.post("/settings/memory/clear")
    assert r.status_code == 200
    assert r.json() == {"cleared": True}
    assert spy.uids == ["u1"]             # token-derived, and it really ran
