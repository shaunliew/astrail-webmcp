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

import asyncio
import re
import time
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


def _client(monkeypatch, *, uid_box, ready, request_spy=None, cancel_spy=None, resend_key=True):
    """ASGI client with auth overridden to uid_box['uid'] and the deletion service spied.

    `main.get_supabase_client` is counted so the gated path can be proven to touch no DB.

    `resend_key` (Fix 4): the request endpoint now fail-closes with 503 unless RESEND_API_KEY is
    configured (the scheduled-deletion email is the safety net). Default True so every existing
    request-path test still reaches the RPC; the notification-readiness test passes False.
    """
    import deletion
    import main
    from rate_limit import get_current_user_id_stashed

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", ready)
    if resend_key:
        monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    else:
        monkeypatch.delenv("RESEND_API_KEY", raising=False)
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


async def test_request_deletion_503_when_execution_ready_but_resend_unconfigured(monkeypatch):
    """Fix 4: flipping _DELETION_EXECUTION_READY while RESEND_API_KEY is UNSET must FAIL CLOSED.
    The scheduled-deletion email is the load-bearing safety net (plan §3.5), so a grace we cannot
    notify must not start — and the fail-close is BEFORE any DB work (no RPC, no get_supabase_client)."""
    spy = _DeletionSpy(returns="2026-08-12T00:00:00+00:00")   # would 200 if the gate were reached
    async with _client(monkeypatch, uid_box={"uid": "u1"}, ready=True, request_spy=spy,
                       resend_key=False) as c:
        r = await c.post("/account/deletion")
    body = r.json()
    assert r.status_code == 503
    assert body["error"]["code"] == "deletion_unavailable"
    assert spy.calls == []              # never reached the RPC
    assert c._sb_calls == []            # fail-closed before any DB round-trip


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


# --- POST /account/deletion — the scheduled "safety net" email (Task 4) -------------------
# The load-bearing notice (plan §3.5). These drive the endpoint with a fake service-role client
# whose admin API returns the caller's email, and prove: (a) a successful request fires the notice
# to the LOOKED-UP address with the scheduled date; (b) an email failure NEVER blocks the 200 or
# the already-scheduled deletion (best-effort).


class _FakeAdmin:
    def __init__(self, email, raises=None):
        self.email, self.raises, self.calls = email, raises, []

    async def get_user_by_id(self, uid):
        self.calls.append(uid)
        if self.raises is not None:
            raise self.raises
        return type("_Resp", (), {"user": type("_U", (), {"email": self.email})()})()


class _FakeClientWithAuth:
    def __init__(self, admin):
        self.auth = type("_Auth", (), {"admin": admin})()


def _email_client(monkeypatch, *, uid, admin, send_spy, request_returns="2026-08-12T00:00:00+00:00",
                  request_raises=None):
    import deletion
    import main
    import notifications
    from rate_limit import get_current_user_id_stashed

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", True)
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")   # Fix 4: past the notification-readiness gate

    req_spy = _DeletionSpy(returns=request_returns, raises=request_raises)
    monkeypatch.setattr(deletion, "request_account_deletion", req_spy)
    monkeypatch.setattr(notifications, "send_deletion_scheduled_email", send_spy)

    async def _sb():
        return _FakeClientWithAuth(admin)

    monkeypatch.setattr(main, "get_supabase_client", _sb)

    async def _override(request: Request) -> str:
        request.state.user_id = uid
        return uid

    main.app.dependency_overrides[get_current_user_id_stashed] = _override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


async def test_request_deletion_fires_the_scheduled_email_to_the_looked_up_address(monkeypatch):
    sent: list = []

    async def _send(email, scheduled_for):
        sent.append((email, scheduled_for))

    admin = _FakeAdmin("traveler@example.com")
    async with _email_client(monkeypatch, uid="u1", admin=admin, send_spy=_send) as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 200
    assert r.json() == {"scheduled_for": "2026-08-12T00:00:00Z"}
    # The notice went to the address resolved for the TOKEN's sub, with the scheduled date.
    assert admin.calls == ["u1"]
    assert sent == [("traveler@example.com", "2026-08-12T00:00:00+00:00")]


async def test_request_deletion_still_200_when_the_email_lookup_raises(monkeypatch):
    """Best-effort: a failing auth.users lookup must NOT fail an already-scheduled deletion."""
    sent: list = []

    async def _send(email, scheduled_for):
        sent.append((email, scheduled_for))

    admin = _FakeAdmin(None, raises=RuntimeError("gotrue down"))
    async with _email_client(monkeypatch, uid="u1", admin=admin, send_spy=_send) as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 200                     # the deletion is scheduled regardless
    assert r.json() == {"scheduled_for": "2026-08-12T00:00:00Z"}
    assert sent == []                               # the lookup failed before a send


async def test_request_deletion_still_200_when_the_email_send_raises(monkeypatch):
    """Best-effort: even if the notice send itself raised, the endpoint must still return 200."""
    async def _send(email, scheduled_for):
        raise RuntimeError("resend unreachable")

    admin = _FakeAdmin("traveler@example.com")
    async with _email_client(monkeypatch, uid="u1", admin=admin, send_spy=_send) as c:
        r = await c.post("/account/deletion")
    assert r.status_code == 200
    assert r.json() == {"scheduled_for": "2026-08-12T00:00:00Z"}


async def test_request_deletion_bounds_a_slow_email_and_still_200(monkeypatch):
    """T6 fold (#4): a degraded GoTrue/Resend must NOT add its latency to the 200. The best-effort
    lookup+send is wait_for-bounded (`_EMAIL_BUDGET_S`); the resulting TimeoutError is swallowed
    like any notice failure, so the request returns 200 well inside the budget, not after the send
    would have finished. Shrinking the budget here proves the bound is load-bearing without sleeping
    the real 6s."""
    import main
    monkeypatch.setattr(main, "_EMAIL_BUDGET_S", 0.1)

    async def _slow_send(email, scheduled_for):
        await asyncio.sleep(5)                          # would blow the request budget if unbounded
        raise AssertionError("send should have been cancelled by the wait_for bound")

    admin = _FakeAdmin("traveler@example.com")
    async with _email_client(monkeypatch, uid="u1", admin=admin, send_spy=_slow_send) as c:
        start = time.perf_counter()
        r = await c.post("/account/deletion")
        elapsed = time.perf_counter() - start
    assert r.status_code == 200                         # bounded timeout is best-effort, never fatal
    assert r.json() == {"scheduled_for": "2026-08-12T00:00:00Z"}
    assert elapsed < 2.0, f"email was not bounded: request took {elapsed:.2f}s (send sleeps 5s)"


# --- C2: request-time notified_at stamp (_send_scheduled_deletion_email) -------------------
# On a CONFIRMED send the request endpoint stamps account_deletion_log.notified_at so the sweep's
# durable retry does not re-send; a failed/false send leaves it NULL for the sweep to pick up.


class _RecordingTable:
    def __init__(self, sink):
        self.sink, self._patch, self._eq = sink, None, {}

    def update(self, patch):
        self._patch = dict(patch)
        return self

    def eq(self, col, value):
        self._eq[col] = value
        return self

    async def execute(self):
        self.sink.append({"patch": self._patch, "eq": dict(self._eq)})
        return type("_R", (), {"data": [{}]})()


class _FakeClientAuthAndTable:
    def __init__(self, admin, sink):
        self.auth = type("_Auth", (), {"admin": admin})()
        self._sink = sink

    def table(self, _name):
        return _RecordingTable(self._sink)


async def test_scheduled_email_stamps_notified_at_on_a_confirmed_send(monkeypatch):
    import main
    import notifications
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")

    async def _send_ok(email, scheduled_for):
        return True                                      # confirmed 2xx

    monkeypatch.setattr(notifications, "send_deletion_scheduled_email", _send_ok)
    sink: list = []
    client = _FakeClientAuthAndTable(_FakeAdmin("traveler@example.com"), sink)
    await main._send_scheduled_deletion_email(client, "u1", "2026-08-12T00:00:00+00:00")

    assert len(sink) == 1                                # exactly one stamp write
    assert set(sink[0]["patch"]) == {"notified_at"}
    assert sink[0]["patch"]["notified_at"] is not None
    # Bound to THIS request's row: user + pending + the exact scheduled_for the RPC returned, so a
    # racing cancel+re-request (which gets a fresh scheduled_for) can't be stamped by this cycle.
    assert sink[0]["eq"] == {"user_id": "u1", "outcome": "pending",
                             "scheduled_for": "2026-08-12T00:00:00+00:00"}


async def test_scheduled_email_does_not_stamp_when_the_send_fails(monkeypatch):
    import main
    import notifications
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")

    async def _send_fail(email, scheduled_for):
        return False                                     # swallowed failure

    monkeypatch.setattr(notifications, "send_deletion_scheduled_email", _send_fail)
    sink: list = []
    client = _FakeClientAuthAndTable(_FakeAdmin("traveler@example.com"), sink)
    await main._send_scheduled_deletion_email(client, "u1", "2026-08-12T00:00:00+00:00")

    assert sink == []                                    # NOT stamped -> the sweep retries


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


# --- GET /account/deletion/status (cross-session read, T6) --------------------------------
# Fail-safe by contract: any read error / missing row / bad value -> {active, null} so a returning
# user defaults to the banner HIDDEN, never a 500 and never another user's status (sub only).


class _FakeUsersQuery:
    """Records the read chain and returns a fixed result (or raises on execute)."""

    def __init__(self, box, *, raises=None, result=None):
        self._box, self._raises, self._result = box, raises, result

    def select(self, cols):
        self._box["select"] = cols
        return self

    def eq(self, col, val):
        self._box.setdefault("eq", []).append((col, val))
        return self

    def maybe_single(self):
        self._box["maybe_single"] = True
        return self

    async def execute(self):
        if self._raises is not None:
            raise self._raises
        return self._result


class _FakeUsersClient:
    def __init__(self, box, *, raises=None, result=None):
        self._box, self._raises, self._result = box, raises, result

    def table(self, name):
        self._box["table"] = name
        return _FakeUsersQuery(self._box, raises=self._raises, result=self._result)


def _result(data):
    return type("_Res", (), {"data": data})()


def _status_client(monkeypatch, *, uid, ready=False, raises=None, result=None, box=None):
    """ASGI client for GET /account/deletion/status: auth -> uid, the users read faked.

    `ready` defaults to False (the SHIPPING posture) to prove the read is UNGATED — it works
    regardless of `_DELETION_EXECUTION_READY`.
    """
    import main
    from auth import get_current_user_id

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", ready)

    async def _sb():
        return _FakeUsersClient(box if box is not None else {}, raises=raises, result=result)

    monkeypatch.setattr(main, "get_supabase_client", _sb)

    async def _override() -> str:
        return uid

    main.app.dependency_overrides[get_current_user_id] = _override
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test")


async def test_status_reports_pending_and_scheduled_for_the_jwt_sub(monkeypatch):
    box: dict = {}
    result = _result({"account_status": "pending_deletion",
                      "deletion_scheduled_for": "2026-08-12T00:00:00+00:00"})
    async with _status_client(monkeypatch, uid="u1", result=result, box=box) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "pending_deletion",
                        "deletion_scheduled_for": "2026-08-12T00:00:00Z"}
    # sub-only (guardrails #5/#6): the row read is filtered by the TOKEN's uid, never a client id.
    assert box["eq"] == [("id", "u1")]
    assert box["table"] == "users"


async def test_status_reports_active_null_for_an_active_account(monkeypatch):
    result = _result({"account_status": "active", "deletion_scheduled_for": None})
    async with _status_client(monkeypatch, uid="u1", result=result) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "active", "deletion_scheduled_for": None}


async def test_status_is_ungated_and_returns_active_while_the_flag_is_off(monkeypatch):
    """UNGATED: the read is NOT tied to `_DELETION_EXECUTION_READY`. With the flag False (shipping)
    every account is 'active', so the endpoint answers 200 active/null — never a 503."""
    result = _result({"account_status": "active", "deletion_scheduled_for": None})
    async with _status_client(monkeypatch, uid="u1", ready=False, result=result) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "active", "deletion_scheduled_for": None}


async def test_status_read_failure_reports_unknown_not_a_false_active(monkeypatch):
    """Fix 5: a genuine READ FAILURE (the read raised) must surface as 'unknown', NOT masquerade as
    'active' — a false 'active' would hide the Cancel banner from a genuinely-pending user with no
    route to cancel. Still a 200 (never a 500), and secret-safe (TYPE-only log)."""
    async with _status_client(monkeypatch, uid="u1",
                              raises=RuntimeError("column does not exist")) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "unknown", "deletion_scheduled_for": None}


async def test_status_fail_safe_when_the_row_is_missing(monkeypatch):
    """A missing users row (maybe_single -> data None) -> the safe default, never a 500."""
    async with _status_client(monkeypatch, uid="u1", result=_result(None)) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "active", "deletion_scheduled_for": None}


async def test_status_fail_safe_when_maybe_single_returns_bare_none(monkeypatch):
    """postgrest 2.31.0 `maybe_single()` returns a BARE None (not an object with `.data`) on zero
    rows — a footgun this codebase has hit before (see main.py / deletion_engine.py). The read must
    collapse THAT shape to the safe default too, never a 500. `result=None` makes the fake's
    execute() return bare None (vs `_result(None)`, which returns an object with `.data=None`)."""
    async with _status_client(monkeypatch, uid="u1", result=None) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "active", "deletion_scheduled_for": None}


async def test_status_fail_safe_on_unexpected_status_value(monkeypatch):
    """A status outside the known set (schema drift) collapses to the safe default, not a 500."""
    result = _result({"account_status": "banned", "deletion_scheduled_for": None})
    async with _status_client(monkeypatch, uid="u1", result=result) as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 200
    assert r.json() == {"account_status": "active", "deletion_scheduled_for": None}


async def test_status_requires_auth(monkeypatch):
    # No dependency override: the real auth dependency must reject an anonymous caller.
    import main
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app),
                                 base_url="http://test") as c:
        r = await c.get("/account/deletion/status")
    assert r.status_code == 401


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
