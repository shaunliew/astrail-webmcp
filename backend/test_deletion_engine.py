"""Keyless, behavioral tests for the two-pass account-delete engine + sweep (Task 3).

Injected fakes only — no network, no DB, no credentials, no real mem0 SDK, no real admin delete.
`purge_account_memory` (the reused Task 1 wrapper) is monkeypatched so each test drives a single
purge outcome (confirmed / unavailable / unconfirmed) without touching mem0. The FAKES genuinely
filter (a `return self` builder would make every quiescence / status / due-row case vacuous), and
assertions are exact outcomes, never disjunctions (a `in (...)` would make no single guard
attributable).

Coverage (each guard reddens ALONE via a paired positive control):
  * Pass A unconfirmed purge -> backoff + retry, NEVER hard-delete, outcome NOT advanced;
  * Pass A confirmed clear -> purged_verified_at + outcome='deleting', no delete yet;
  * cancel-lost claim (claim false, status 'active') -> skip, nothing touched;
  * claim false but status 'deleting' (our prior claim) -> keep retrying the purge;
  * quiescence: a non-terminal job -> backoff, no purge, no delete;
  * Pass B settle gap not elapsed -> wait, nothing touched;
  * Pass B re-verify catches a late add -> backoff, no delete;
  * Pass B happy path -> hard-delete (should_soft_delete=False) + completed;
  * Pass B auth-delete 404 = success; other auth error -> backoff;
  * crash recovery (public.users missing) -> completed, no re-verify, no delete;
  * InvalidUserId propagates (not retried), terminalized by the sweep to 'failed';
  * the sweep gate: _run_deletion_sweep is a NO-OP while _DELETION_EXECUTION_READY is False;
  * static SQL: the claim RPC's privilege pin + CAS predicate.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import deletion_engine
from erasure import InvalidUserId, MemoryBackendUnavailable, MemoryPurgeError

_UID = "11111111-1111-4111-8111-111111111111"
_NOW = datetime(2026, 8, 20, 12, 0, 0, tzinfo=timezone.utc)


# --- fakes --------------------------------------------------------------------------------


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """A PostgREST-shaped builder over one table of the fake db. Filters GENUINELY."""

    def __init__(self, client, table: str) -> None:
        self.client, self.table = client, table
        self.op = "select"
        self.payload = None
        self._eq: dict = {}
        self._in: dict = {}
        self._lte: dict = {}
        self._single = False
        self._limit = None

    def select(self, *_cols):
        self.op = "select"
        return self

    def update(self, patch):
        self.op, self.payload = "update", dict(patch)
        return self

    def eq(self, col, value):
        self._eq[col] = value
        return self

    def in_(self, col, values):
        self._in[col] = tuple(values)
        return self

    def lte(self, col, value):
        self._lte[col] = value
        return self

    def limit(self, n):
        self._limit = n
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row) -> bool:
        if any(row.get(c) != v for c, v in self._eq.items()):
            return False
        if any(row.get(c) not in vs for c, vs in self._in.items()):
            return False
        for c, v in self._lte.items():
            cur = row.get(c)
            if cur is None or not cur <= v:   # SQL: NULL <= x is NULL -> no match
                return False
        return True

    async def execute(self):
        self.client.ops.append(f"{self.op}:{self.table}")
        exc = self.client.raises.get((self.op, self.table))
        if exc is not None:
            raise exc
        rows = self.client.db.setdefault(self.table, [])
        if self.op == "update":
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(self.payload)
            self.client.updates.append((self.table, dict(self.payload)))
            return _Result([dict(r) for r in matched])
        matched = [dict(r) for r in rows if self._matches(r)]
        if self._limit is not None:
            matched = matched[: self._limit]
        if self._single:
            if len(matched) > 1:
                raise ValueError("maybe_single() matched multiple rows")
            return _Result(matched[0]) if matched else None   # bare None on zero rows
        return _Result(matched)


class _Rpc:
    def __init__(self, client, name, params) -> None:
        self.client, self.name, self.params = client, name, params

    async def execute(self):
        self.client.rpc_calls.append((self.name, self.params))
        beh = self.client.claim
        if callable(beh):
            return _Result(beh(self.params))
        return _Result(beh)


class _AdminAuth:
    def __init__(self, client) -> None:
        self.client = client

    async def delete_user(self, user_id, should_soft_delete=True):
        self.client.deleted.append((user_id, should_soft_delete))
        if self.client.delete_user_raises is not None:
            raise self.client.delete_user_raises


class _Auth:
    def __init__(self, client) -> None:
        self.admin = _AdminAuth(client)


class _AuthApiErrorLike(Exception):
    """Duck-typed gotrue AuthApiError — the engine classifies on `.status`, never imports it."""

    def __init__(self, status: int) -> None:
        super().__init__(f"status={status}")
        self.status = status


class _FakeClient:
    def __init__(self, *, log=None, users=None, jobs=None, organize_jobs=None,
                 claim=True, delete_user_raises=None, raises=None) -> None:
        self.db = {
            "account_deletion_log": [dict(r) for r in (log or [])],
            "users": [dict(r) for r in (users or [])],
            "jobs": [dict(r) for r in (jobs or [])],
            "organize_jobs": [dict(r) for r in (organize_jobs or [])],
        }
        self.claim = claim
        self.delete_user_raises = delete_user_raises
        self.raises = raises or {}
        self.ops: list[str] = []
        self.updates: list = []
        self.rpc_calls: list = []
        self.deleted: list = []
        self.auth = _Auth(self)

    def table(self, name):
        self.db.setdefault(name, [])
        return _Query(self, name)

    def rpc(self, name, params):
        return _Rpc(self, name, params)

    @property
    def log_row(self):
        return self.db["account_deletion_log"][0]


class _FakePurge:
    """Scripted stand-in for erasure.purge_account_memory: consumes one behaviour per call —
    None = confirmed clear (return), an Exception = raise it. Records call count so 'purge was
    reused' and 'purge was NOT reached' are both assertable."""

    def __init__(self, *behaviours) -> None:
        self.behaviours = list(behaviours)
        self.calls: list = []

    async def __call__(self, client, mem0, user_id):
        self.calls.append(user_id)
        beh = self.behaviours.pop(0) if self.behaviours else None
        if isinstance(beh, Exception):
            raise beh


def _log(**overrides) -> dict:
    row = {"id": "log-1", "user_id": _UID, "recipient_email": "gone@example.com",
           "requested_at": "2026-08-13T12:00:00+00:00", "scheduled_for": "2026-08-13T12:00:00+00:00",
           "attempts": 0, "next_attempt_at": None, "last_error": None,
           "purged_verified_at": None, "completed_at": None, "outcome": "pending"}
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _frozen_clock(monkeypatch):
    """Freeze the engine's single time source so settle/backoff are deterministic."""
    monkeypatch.setattr(deletion_engine, "_now_utc", lambda: _NOW)


@pytest.fixture(autouse=True)
def completion_emails(monkeypatch):
    """Record the best-effort completion email _mark_completed fires (Task 4) so no send ever
    leaves in the keyless suite, regardless of RESEND_API_KEY. `_mark_completed` does
    `from notifications import send_deletion_completed_email` at call time, so patching the module
    attribute is what it resolves. Returns the list of recipients sent to."""
    import notifications

    sends: list = []

    async def _record(email):
        sends.append(email)

    monkeypatch.setattr(notifications, "send_deletion_completed_email", _record)
    return sends


def _patch_purge(monkeypatch, *behaviours) -> _FakePurge:
    fake = _FakePurge(*behaviours)
    monkeypatch.setattr(deletion_engine, "purge_account_memory", fake)
    return fake


# --- Pass A -------------------------------------------------------------------------------


async def test_pass_a_unconfirmed_purge_backs_off_and_never_hard_deletes(monkeypatch):
    purge = _patch_purge(monkeypatch, MemoryBackendUnavailable("down"))
    client = _FakeClient(log=[_log()], claim=True)
    await deletion_engine.erase_user(client, object(), client.log_row)

    row = client.log_row
    assert purge.calls == [_UID]                 # the reused wrapper WAS called
    assert client.deleted == []                  # NEVER hard-deleted on an unconfirmed purge
    assert row["outcome"] == "pending"           # NOT advanced
    assert row["purged_verified_at"] is None
    assert row["attempts"] == 1
    assert row["next_attempt_at"] is not None    # scheduled for retry
    assert "purge unconfirmed" in row["last_error"]
    assert "MemoryBackendUnavailable" in row["last_error"]


async def test_pass_a_confirmed_clear_advances_to_deleting_without_deleting(monkeypatch):
    purge = _patch_purge(monkeypatch, None)      # confirmed clear
    client = _FakeClient(log=[_log()], claim=True)
    await deletion_engine.erase_user(client, object(), client.log_row)

    row = client.log_row
    assert purge.calls == [_UID]
    assert row["outcome"] == "deleting"          # advanced (but NOT terminal proof)
    assert row["purged_verified_at"] is not None
    assert row["next_attempt_at"] is None
    assert row["last_error"] is None
    assert client.deleted == []                  # Pass B, a settle tick later, does the delete


async def test_cancel_lost_claim_skips_without_touching_anything(monkeypatch):
    # claim() returns false AND the status is 'active' -> a cancel won. Never delete, never purge.
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_log()], users=[{"id": _UID, "account_status": "active"}], claim=False)
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == []                     # never purged
    assert client.deleted == []                  # never deleted
    assert client.updates == []                  # the log row is left untouched
    assert client.log_row["outcome"] == "pending"


async def test_claim_false_but_status_deleting_is_our_prior_claim_and_keeps_retrying(monkeypatch):
    # claim() false because WE already flipped it to 'deleting' on a prior tick; the log is still
    # 'pending' (that prior purge was unconfirmed). This must re-enter the purge, not be mistaken
    # for a cancel — proving the false-claim re-read disambiguation.
    purge = _patch_purge(monkeypatch, MemoryPurgeError("still not empty"))
    client = _FakeClient(log=[_log()], users=[{"id": _UID, "account_status": "deleting"}], claim=False)
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == [_UID]                 # continued into the purge retry
    assert client.deleted == []
    assert client.log_row["attempts"] == 1       # backed off, still retryable
    assert client.log_row["outcome"] == "pending"


async def test_quiescence_nonterminal_job_backs_off_without_purge_or_delete(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_log()], claim=True,
                         jobs=[{"id": "j1", "user_id": _UID, "status": "running"}])
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == []                     # did not purge while work is in flight
    assert client.deleted == []
    assert client.log_row["attempts"] == 1
    assert "quiescence" in client.log_row["last_error"]


async def test_quiescence_also_checks_organize_jobs(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_log()], claim=True,
                         organize_jobs=[{"id": "o1", "user_id": _UID, "status": "processing"}])
    await deletion_engine.erase_user(client, object(), client.log_row)
    assert purge.calls == []
    assert client.log_row["attempts"] == 1


# --- Pass B -------------------------------------------------------------------------------


def _deleting_log(**overrides) -> dict:
    # purged a settle gap AGO by default (so Pass B is due). Frozen clock -> deterministic.
    settled = (_NOW - timedelta(seconds=deletion_engine._SETTLE_GAP_S + 60)).isoformat()
    base = dict(outcome="deleting", purged_verified_at=settled)
    base.update(overrides)
    return _log(**base)


async def test_pass_b_settle_gap_not_elapsed_waits_and_touches_nothing(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    recent = (_NOW - timedelta(seconds=10)).isoformat()          # < _SETTLE_GAP_S
    client = _FakeClient(log=[_deleting_log(purged_verified_at=recent)],
                         users=[{"id": _UID, "account_status": "deleting"}])
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == []                     # no re-verify yet
    assert client.deleted == []                  # no delete yet
    assert client.updates == []                  # not a failure — no backoff either
    assert client.log_row["outcome"] == "deleting"


async def test_pass_b_reverify_catches_a_late_add_and_backs_off(monkeypatch):
    purge = _patch_purge(monkeypatch, MemoryPurgeError("a late add materialized"))
    client = _FakeClient(log=[_deleting_log()],
                         users=[{"id": _UID, "account_status": "deleting"}])
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == [_UID]                 # re-verified
    assert client.deleted == []                  # a late add stops the delete
    assert client.log_row["outcome"] == "deleting"
    assert client.log_row["attempts"] == 1
    assert "re-verify" in client.log_row["last_error"]


async def test_pass_b_happy_path_hard_deletes_and_completes(monkeypatch, completion_emails):
    purge = _patch_purge(monkeypatch, None)      # re-verify: still empty
    client = _FakeClient(log=[_deleting_log()],
                         users=[{"id": _UID, "account_status": "deleting"}])
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == [_UID]
    # the REAL, non-recoverable delete
    assert client.deleted == [(_UID, False)]
    row = client.log_row
    assert row["outcome"] == "completed"
    assert row["completed_at"] is not None
    # Task 4: the best-effort completion email fired to the CAPTURED address, then it was cleared
    # from the log in the terminal write (the row no longer retains the recipient).
    assert completion_emails == ["gone@example.com"]
    assert row["recipient_email"] is None


async def test_pass_b_auth_delete_404_is_success(monkeypatch):
    _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_deleting_log()],
                         users=[{"id": _UID, "account_status": "deleting"}],
                         delete_user_raises=_AuthApiErrorLike(404))
    await deletion_engine.erase_user(client, object(), client.log_row)
    # 404 = already gone = the desired end state
    assert client.log_row["outcome"] == "completed"


async def test_pass_b_auth_delete_other_error_backs_off(monkeypatch):
    _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_deleting_log()],
                         users=[{"id": _UID, "account_status": "deleting"}],
                         delete_user_raises=_AuthApiErrorLike(500))
    await deletion_engine.erase_user(client, object(), client.log_row)
    row = client.log_row
    assert row["outcome"] == "deleting"          # NOT completed on an unknown failure
    assert row["attempts"] == 1
    assert "auth delete failed" in row["last_error"]


async def test_pass_b_crash_recovery_missing_users_row_completes(monkeypatch):
    # outcome='deleting' but public.users is GONE (a prior Pass B auth-delete cascaded it, then
    # crashed before marking the log). Treat as done — no re-verify, no re-delete.
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_deleting_log()], users=[])      # no row for _UID
    await deletion_engine.erase_user(client, object(), client.log_row)

    assert purge.calls == []                     # never re-verified a gone account
    assert client.deleted == []                  # never re-deleted
    assert client.log_row["outcome"] == "completed"


# --- Exception discipline -----------------------------------------------------------------


async def test_invalid_user_id_propagates_and_is_not_retried(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_log(user_id="not-a-uuid")], claim=True)
    with pytest.raises(InvalidUserId):
        await deletion_engine.erase_user(client, object(), client.log_row)

    # A corrupted id fails BEFORE any RPC, purge, or write — never a backoff loop.
    assert purge.calls == []
    assert client.rpc_calls == []
    assert client.updates == []
    assert client.log_row["attempts"] == 0


# --- Sweep --------------------------------------------------------------------------------


async def test_sweep_runs_due_rows_and_advances_them(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    monkeypatch.setattr(deletion_engine, "_get_mem0", lambda: _async_none())
    client = _FakeClient(
        log=[_log(scheduled_for="2026-08-13T00:00:00+00:00")],  # due (< frozen now)
        claim=True)
    await deletion_engine.sweep_due_deletions(client)
    assert purge.calls == [_UID]
    assert client.log_row["outcome"] == "deleting"


async def test_sweep_skips_a_row_still_in_backoff(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    monkeypatch.setattr(deletion_engine, "_get_mem0", lambda: _async_none())
    future = (_NOW + timedelta(seconds=300)).isoformat()
    client = _FakeClient(
        log=[_log(scheduled_for="2026-08-13T00:00:00+00:00", next_attempt_at=future)],
        claim=True)
    await deletion_engine.sweep_due_deletions(client)
    assert purge.calls == []                     # backoff not elapsed -> skipped this tick
    assert client.log_row["outcome"] == "pending"


async def test_sweep_terminalizes_a_corrupted_row_to_failed(monkeypatch):
    # InvalidUserId escapes erase_user; the sweep must terminalize it (never retry a bad id).
    _patch_purge(monkeypatch, None)
    monkeypatch.setattr(deletion_engine, "_get_mem0", lambda: _async_none())
    client = _FakeClient(
        log=[_log(user_id="not-a-uuid", scheduled_for="2026-08-13T00:00:00+00:00")], claim=True)
    await deletion_engine.sweep_due_deletions(client)
    assert client.log_row["outcome"] == "failed"
    assert client.log_row["last_error"] == "invalid_user_id"


async def test_sweep_ignores_terminal_and_future_rows(monkeypatch):
    purge = _patch_purge(monkeypatch, None)
    monkeypatch.setattr(deletion_engine, "_get_mem0", lambda: _async_none())
    client = _FakeClient(log=[
        _log(id="done", outcome="completed", scheduled_for="2026-08-13T00:00:00+00:00"),
        _log(id="future", outcome="pending", scheduled_for="2026-09-01T00:00:00+00:00"),  # > now
    ], claim=True)
    await deletion_engine.sweep_due_deletions(client)
    assert purge.calls == []                     # neither row is due-and-actionable


async def _async_none():
    return None


# --- The sweep GATE (main._run_deletion_sweep) --------------------------------------------


async def test_run_deletion_sweep_is_a_noop_while_gated_off(monkeypatch):
    import main
    calls: list = []

    async def _spy(client):
        calls.append(client)

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", False)
    monkeypatch.setattr(deletion_engine, "sweep_due_deletions", _spy)
    await main._run_deletion_sweep(object())
    assert calls == []                           # gated off -> the sweep never runs


async def test_run_deletion_sweep_runs_when_gate_is_live(monkeypatch):
    import main
    calls: list = []

    async def _spy(client):
        calls.append(client)

    monkeypatch.setattr(main, "_DELETION_EXECUTION_READY", True)
    monkeypatch.setattr(deletion_engine, "sweep_due_deletions", _spy)
    sentinel = object()
    await main._run_deletion_sweep(sentinel)
    assert calls == [sentinel]                    # the positive control: it DOES run when live


# --- Generation entrypoint freeze (main._account_is_pending_deletion, plan §3.6) ----------


async def test_generate_entrypoint_blocks_pending_and_deleting():
    import main
    for status in ("pending_deletion", "deleting"):
        client = _FakeClient(users=[{"id": _UID, "account_status": status}])
        assert await main._account_is_pending_deletion(client, _UID) is True


async def test_generate_entrypoint_allows_active_and_fails_open():
    import main
    active = _FakeClient(users=[{"id": _UID, "account_status": "active"}])
    assert await main._account_is_pending_deletion(active, _UID) is False
    # A missing row reads as "not pending" (proceed) — the UX gate fails OPEN, unlike the
    # persist_trip_memory freeze which fails closed.
    assert await main._account_is_pending_deletion(_FakeClient(users=[]), _UID) is False
    # A status-read blip must NOT block generation for everyone (fail open).
    blip = _FakeClient(users=[], raises={("select", "users"): RuntimeError("db blip")})
    assert await main._account_is_pending_deletion(blip, _UID) is False


# --- Static migration assertions (the claim RPC's privilege pin + CAS predicate) ----------
# A mocked RPC can't see a GRANT or the CAS predicate, so these guard the SQL directly: a
# regression that drops the revoke/grant or broadens the CAS reds here in the keyless suite. The
# RUNTIME proof (the claim CASes pending->deleting, a false claim on active, service-role-only
# EXECUTE) is supabase/tests/020_claim_account_for_deletion.sql, run at the Task 6 live gate.

_MIGRATION = (Path(__file__).resolve().parents[1] / "supabase" / "migrations"
              / "20260805010000_account_deletion_engine.sql")


def _normalized_sql() -> str:
    return re.sub(r"\s+", " ", _MIGRATION.read_text().lower())


def test_claim_rpc_is_privilege_pinned_to_service_role():
    sql = _normalized_sql()
    assert ("revoke all on function public.claim_account_for_deletion(uuid) "
            "from public, anon, authenticated") in sql, (
        "claim_account_for_deletion is not revoked from public/anon/authenticated — an "
        "authenticated user could doom ANY uuid into 'deleting' via PostgREST")
    assert ("grant execute on function public.claim_account_for_deletion(uuid) to service_role"
            in sql)
    assert "security definer set search_path = ''" in sql


def test_claim_rpc_cas_predicate_is_pending_to_deleting():
    sql = _normalized_sql()
    assert "returns boolean" in sql
    assert "set account_status = 'deleting'" in sql
    # The CAS wins ONLY from a still-'pending_deletion' row — a cancel that flipped to 'active'
    # loses. Broadening this predicate is the load-bearing regression this guards.
    assert "where id = p_user_id and account_status = 'pending_deletion'" in sql


# --- T3 review folds: initializing quiescence + Pass B status self-guard --------------------


async def test_quiescence_treats_initializing_organize_job_as_in_flight(monkeypatch):
    # 'initializing' is in the repo-wide organize-jobs in-flight set (organize_jobs CHECK +
    # recover_organize_jobs et al.); a claimed account must back off, never delete, until it drains.
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_log()], claim=True,
                         organize_jobs=[{"id": "o1", "user_id": _UID, "status": "initializing"}])
    await deletion_engine.erase_user(client, object(), client.log_row)
    assert purge.calls == []                      # did not purge while an initializing job is live
    assert client.deleted == []
    assert client.log_row["attempts"] == 1


async def test_pass_b_refuses_to_delete_a_non_deleting_account(monkeypatch):
    # Defensive: outcome='deleting' but account_status has reverted (e.g. a future support tool).
    # Pass B must NOT hard-delete a non-'deleting' account — back off loudly instead.
    purge = _patch_purge(monkeypatch, None)
    client = _FakeClient(log=[_deleting_log()],
                         users=[{"id": _UID, "account_status": "active"}])
    await deletion_engine.erase_user(client, object(), client.log_row)
    assert purge.calls == []                      # never re-verified
    assert client.deleted == []                   # never deleted a non-'deleting' account
    assert client.log_row["outcome"] == "deleting"
    assert client.log_row["attempts"] == 1
    assert "unexpected status" in client.log_row["last_error"]
