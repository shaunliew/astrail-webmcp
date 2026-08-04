"""Keyless tests for the gated account-deletion endpoints + the migration's privilege pins.

No network, no DB, no key. Two layers:
  * endpoint-handler tests — the RPC service layer (deletion.py) is spied, so each test drives
    exactly one HTTP outcome (503 gated / 200 / 409 / 401) and proves the handler passes the
    TOKEN's user id, never a client-supplied one;
  * static SQL assertions on the migration — the load-bearing privilege pin (revoke from
    public/anon/authenticated + grant to service_role for BOTH RPCs), the CHECK constraints,
    and the FK-free service-role-only log table.

The BEHAVIORAL RPC proof (a real anon/authenticated EXECUTE is rejected; request flips the
status + writes a pending log; cancel clears the timestamps; re-request gets a fresh 7-day
schedule; cancel loses to 'deleting') lives in supabase/tests/019_account_deletion.sql and runs
at the Task 6 live pgTAP gate — no local Postgres is reachable here to run it.
"""
from __future__ import annotations

import re
from pathlib import Path

import httpx
import pytest
from fastapi import Request

_MIGRATION = (Path(__file__).resolve().parents[1] / "supabase" / "migrations"
              / "20260805000000_account_deletion_lean.sql")


# --- helpers ------------------------------------------------------------------------------


class _DeletionSpy:
    """Stand-in for a deletion.py service function: returns a fixed value or raises, and
    records every user_id it was called with (the JWT-sub assertion)."""

    def __init__(self, *, returns=None, raises=None):
        self.returns, self.raises, self.calls = returns, raises, []

    async def __call__(self, client, user_id):
        self.calls.append({"client": client, "user_id": user_id})
        if self.raises is not None:
            raise self.raises
        return self.returns

    @property
    def uids(self):
        return [c["user_id"] for c in self.calls]


def _client(monkeypatch, *, uid_box, ready, request_spy=None, cancel_spy=None):
    """ASGI client with auth overridden to uid_box['uid'] and the deletion service spied.

    `main.get_supabase_client` is counted so the gated path can be proven to touch no DB.
    """
    import deletion
    import main
    from rate_limit import get_current_user_id_stashed

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", ready)
    if request_spy is not None:
        monkeypatch.setattr(deletion, "request_account_deletion", request_spy)
    if cancel_spy is not None:
        monkeypatch.setattr(deletion, "cancel_account_deletion", cancel_spy)

    sb_calls: list = []

    async def _sb():
        sb_calls.append(1)
        return object()

    monkeypatch.setattr(main, "get_supabase_client", _sb)

    # Production stashes request.state.user_id (rate_limit.py) and the limiter keys on it; a
    # bare lambda would key on IP. Mirror test_settings_routes._client.
    async def _override(request: Request) -> str:
        request.state.user_id = uid_box["uid"]
        return uid_box["uid"]

    main.app.dependency_overrides[get_current_user_id_stashed] = _override
    client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")
    client._sb_calls = sb_calls  # type: ignore[attr-defined]
    return client


@pytest.fixture(autouse=True)
def _reset():
    import main
    from rate_limit import limiter
    limiter.reset()
    yield
    main.app.dependency_overrides.clear()
    limiter.reset()


# --- POST /account/deletion ---------------------------------------------------------------


async def test_request_deletion_is_gated_off_by_default(monkeypatch):
    """SHIPPING posture: the flag is False, so the endpoint 503s BEFORE any DB round-trip and
    never reaches the RPC. A "cleared"-style spy that would answer 200 proves the gate, not luck."""
    spy = _DeletionSpy(returns="2026-08-12T00:00:00+00:00")   # would 200 if ever reached
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=False, request_spy=spy) as c:
        r = await c.post("/account/deletion")
    body = r.json()
    assert r.status_code == 503
    assert body["error"]["code"] == "deletion_unavailable"
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert spy.calls == []              # the RPC was never attempted
    assert c._sb_calls == []            # returned before spending a DB round-trip


async def test_request_deletion_returns_scheduled_date_and_uses_the_jwt_sub(monkeypatch):
    spy = _DeletionSpy(returns="2026-08-12T00:00:00+00:00")
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, request_spy=spy) as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 200
    assert r.json() == {"scheduled_for": "2026-08-12T00:00:00Z"}
    # guardrail #5/#6: the deleted account is the TOKEN's sub, never a client-supplied id (there
    # is no request body to supply one) — the handler must pass exactly the authenticated uid.
    assert spy.uids == ["u1"]


async def test_request_deletion_409_when_account_not_active(monkeypatch):
    """The RPC returns None when the CAS matched nothing (already pending/deleting)."""
    spy = _DeletionSpy(returns=None)
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, request_spy=spy) as c:
        r = await c.post("/account/deletion")
    body = r.json()
    assert r.status_code == 409
    assert body["error"]["code"] == "deletion_not_active"
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    assert spy.uids == ["u1"]


async def test_request_deletion_503_when_rpc_absent(monkeypatch):
    """A migration lagging a deploy (PGRST202) must fail closed as 503, not 500."""
    from deletion import DeletionRPCUnavailable
    spy = _DeletionSpy(raises=DeletionRPCUnavailable("not deployed"))
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, request_spy=spy) as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "deletion_unavailable"


async def test_request_deletion_requires_auth(monkeypatch):
    # No dependency override: the real auth dependency must reject BEFORE the handler body.
    import deletion
    import main
    spy = _DeletionSpy(returns="2026-08-12T00:00:00+00:00")
    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", True)
    monkeypatch.setattr(deletion, "request_account_deletion", spy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 401
    assert spy.calls == []              # an anonymous caller never reaches the RPC


# --- POST /account/deletion/cancel --------------------------------------------------------


async def test_cancel_deletion_is_gated_off_by_default(monkeypatch):
    spy = _DeletionSpy(returns="cancelled")
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=False, cancel_spy=spy) as c:
        r = await c.post("/account/deletion/cancel")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "deletion_unavailable"
    assert spy.calls == []
    assert c._sb_calls == []


async def test_cancel_deletion_200_when_cancelled_and_uses_the_jwt_sub(monkeypatch):
    spy = _DeletionSpy(returns="cancelled")
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, cancel_spy=spy) as c:
        r = await c.post("/account/deletion/cancel")
    assert r.status_code == 200
    assert r.json() == {"cancelled": True}
    assert spy.uids == ["u1"]


async def test_cancel_deletion_409_already_deleting(monkeypatch):
    """Once the sweeper claimed the account into 'deleting', cancel loses → 409."""
    spy = _DeletionSpy(returns="already_deleting")
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, cancel_spy=spy) as c:
        r = await c.post("/account/deletion/cancel")
    body = r.json()
    assert r.status_code == 409
    assert body["error"]["code"] == "deletion_already_started"


async def test_cancel_deletion_409_when_nothing_pending(monkeypatch):
    spy = _DeletionSpy(returns="not_pending")
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, cancel_spy=spy) as c:
        r = await c.post("/account/deletion/cancel")
    body = r.json()
    assert r.status_code == 409
    assert body["error"]["code"] == "no_pending_deletion"


async def test_cancel_deletion_requires_auth(monkeypatch):
    import deletion
    import main
    spy = _DeletionSpy(returns="cancelled")
    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", True)
    monkeypatch.setattr(deletion, "cancel_account_deletion", spy)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.post("/account/deletion/cancel")
    assert r.status_code == 401
    assert spy.calls == []


# --- Static migration assertions (the load-bearing privilege pin + constraints) -----------
# A column probe / mocked RPC can't see a GRANT, so these guard the SQL directly: a regression
# that drops the revoke/grant or the 'deleting'/'cancelled' states reds here in the keyless suite.
# The RUNTIME proof (a real anon EXECUTE is rejected) is the pgTAP file, run at the Task 6 gate.


def _normalized_sql() -> str:
    return re.sub(r"\s+", " ", _MIGRATION.read_text().lower())


@pytest.mark.parametrize("fn", ["request_account_deletion", "cancel_account_deletion"])
def test_both_rpcs_are_privilege_pinned_to_service_role(fn):
    sql = _normalized_sql()
    assert f"revoke all on function public.{fn}(uuid) from public, anon, authenticated" in sql, (
        f"{fn} is not revoked from public/anon/authenticated — an authenticated user could call "
        "it for ANOTHER uuid via PostgREST (Codex must-fix)")
    assert f"grant execute on function public.{fn}(uuid) to service_role" in sql
    # security-definer + empty search_path, once per function.
    assert sql.count("security definer set search_path = ''") == 2


def test_check_constraints_include_deleting_and_cancelled():
    sql = _normalized_sql()
    assert "check (account_status in ('active', 'pending_deletion', 'deleting'))" in sql
    assert ("check (outcome in ('pending', 'deleting', 'completed', 'failed', 'cancelled'))"
            in sql)


def test_log_table_is_service_role_only_and_fk_free():
    sql = _normalized_sql()
    assert "alter table public.account_deletion_log enable row level security" in sql
    assert ("revoke all on public.account_deletion_log from public, anon, authenticated" in sql)
    assert "grant all on public.account_deletion_log to service_role" in sql
    # FK-free is load-bearing: the log must OUTLIVE the auth.users cascade. Assert no `references`
    # inside the account_deletion_log CREATE TABLE block.
    raw = _MIGRATION.read_text().lower()
    start = raw.index("create table public.account_deletion_log (")
    block = raw[start:raw.index(");", start)]
    assert "references" not in block, "account_deletion_log must have NO FK (survives the cascade)"
