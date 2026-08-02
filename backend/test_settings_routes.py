"""Keyless tests for the mem0 settings surface — no network, no DB.

Task 2 adds the /readiness coverage; Task 4 adds the GET /settings/preferences
coverage plus a shared _client() helper and an autouse reset fixture.
"""
import httpx


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
