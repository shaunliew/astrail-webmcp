"""Guards the operator delete-account script's safety contract with injected fakes (no live DB).

Proves: --dry-run touches nothing; a wrong confirmation aborts before any write; mem0 is purged
BEFORE the irreversible auth cascade; and a mem0 purge that cannot be confirmed blocks the delete.
"""
from __future__ import annotations

import erasure
from scripts import delete_account as da

_UID = "621ef3d1-2e91-46a8-be48-01a50b175ec1"


class _FakeClient:
    pass


def _wire(monkeypatch, *, status="active", absent=False):
    """Stub the engine primitives run() pulls from deletion_engine + the mem0 purge. Records calls."""
    calls: list[str] = []

    async def _read_account_status(client, user_id):
        return status

    async def _auth_user_absent(client, user_id):
        return absent

    async def _admin_hard_delete(client, user_id):
        calls.append("delete")

    async def _purge(client, mem0, user_id):
        calls.append("purge")

    monkeypatch.setattr("deletion_engine._read_account_status", _read_account_status)
    monkeypatch.setattr("deletion_engine._auth_user_absent", _auth_user_absent)
    monkeypatch.setattr("deletion_engine._admin_hard_delete", _admin_hard_delete)
    monkeypatch.setattr(da, "purge_account_memory", _purge)
    return calls


async def test_dry_run_touches_nothing(monkeypatch):
    calls = _wire(monkeypatch)
    out: list[str] = []
    rc = await da.run(_FakeClient(), object(), _UID, dry_run=True, assume_yes=True, out=out.append)
    assert rc == 0
    assert calls == []                              # neither purge nor delete ran
    assert any("[dry-run]" in line for line in out)


async def test_wrong_confirmation_aborts_before_any_write(monkeypatch):
    calls = _wire(monkeypatch)
    out: list[str] = []
    rc = await da.run(_FakeClient(), object(), _UID, dry_run=False, assume_yes=False,
                      confirm=lambda _p: "not-the-id", out=out.append)
    assert rc == 1
    assert calls == []                              # aborted before purge/delete
    assert any("did not match" in line for line in out)


async def test_purge_runs_before_delete(monkeypatch):
    calls = _wire(monkeypatch, status="active", absent=False)
    rc = await da.run(_FakeClient(), object(), _UID, dry_run=False, assume_yes=True, out=lambda _l: None)
    assert rc == 0
    assert calls == ["purge", "delete"]             # mem0 first, THEN auth cascade


async def test_unconfirmed_mem0_purge_blocks_the_delete(monkeypatch):
    calls = _wire(monkeypatch)

    async def _raising_purge(client, mem0, user_id):
        raise erasure.MemoryPurgeError("not confirmed empty")

    monkeypatch.setattr(da, "purge_account_memory", _raising_purge)
    out: list[str] = []
    try:
        await da.run(_FakeClient(), object(), _UID, dry_run=False, assume_yes=True, out=out.append)
        raised = False
    except erasure.MemoryPurgeError:
        raised = True
    assert raised                                   # propagated
    assert "delete" not in calls                     # never reached the auth cascade


async def test_absent_account_is_a_noop(monkeypatch):
    calls = _wire(monkeypatch, status=None, absent=True)
    out: list[str] = []
    rc = await da.run(_FakeClient(), object(), _UID, dry_run=False, assume_yes=True, out=out.append)
    assert rc == 0
    assert calls == []
    assert any("Already fully absent" in line for line in out)


def test_invalid_uuid_is_refused(monkeypatch):
    import pytest
    with pytest.raises(erasure.InvalidUserId):
        erasure._assert_real_uuid("not-a-uuid")
