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
    # (pattern: test_main.py:487 test_burst_limit_is_per_user_not_shared).
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
    # client and prove B has a fresh bucket. (pattern: test_main.py:487)
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
