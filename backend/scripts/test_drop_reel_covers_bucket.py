"""Unit tests for the reel-covers rollback helper.

Seams are injected (a fake service-role client + an in-argv parser), so no real
network and no env/keys are needed — the default (offline) suite stays credential-free.

The guarded properties:
  * WITH `--confirm`, the destructive path calls `empty_bucket("reel-covers")` THEN
    `delete_bucket("reel-covers")` — objects before bucket (a bucket with objects can't be
    deleted; reversing the order would always fail).
  * WITHOUT `--confirm`, the script refuses and calls NEITHER method (nothing is destroyed).
  * Re-running when the bucket is already gone is idempotent (a 404 from `empty_bucket`
    degrades to a clean success, `delete_bucket` is not called).

Exercising both branches also guards against a NameError hiding in an un-invoked closure
(a real past failure mode) — the refusal branch and the destructive branch both execute here.
"""
from __future__ import annotations

import pytest

from scripts.drop_reel_covers_bucket import BUCKET, main


class _FakeStorage:
    """Records the order of bucket operations; optionally raises a preset error per method."""

    def __init__(self, *, empty_error: Exception | None = None, delete_error: Exception | None = None) -> None:
        self.calls: list[tuple[str, str]] = []
        self._empty_error = empty_error
        self._delete_error = delete_error

    async def empty_bucket(self, bucket_id: str) -> dict[str, str]:
        self.calls.append(("empty_bucket", bucket_id))
        if self._empty_error is not None:
            raise self._empty_error
        return {"message": "Successfully emptied"}

    async def delete_bucket(self, bucket_id: str) -> dict[str, str]:
        self.calls.append(("delete_bucket", bucket_id))
        if self._delete_error is not None:
            raise self._delete_error
        return {"message": "Successfully deleted"}


class _FakeQuery:
    """Records the `.update(...).like(...).execute()` chain used to null the dead thumbnail pointers."""

    def __init__(self, table: "_FakeTable") -> None:
        self._t = table
        self._values: dict | None = None
        self._filters: list[tuple[str, str, str]] = []

    def update(self, values: dict) -> "_FakeQuery":
        self._values = values
        return self

    def like(self, col: str, pattern: str) -> "_FakeQuery":
        self._filters.append(("like", col, pattern))
        return self

    async def execute(self) -> dict:
        self._t.updates.append((self._values, list(self._filters)))
        return {"data": []}


class _FakeTable:
    def __init__(self) -> None:
        self.updates: list[tuple[dict | None, list]] = []

    def update(self, values: dict) -> _FakeQuery:
        return _FakeQuery(self).update(values)


class _FakeClient:
    def __init__(self, storage: _FakeStorage) -> None:
        self.storage = storage
        self.reel_cache = _FakeTable()

    def table(self, name: str) -> _FakeTable:
        assert name == "reel_cache"
        return self.reel_cache


class _FakeStorageApiError(Exception):
    """Duck-types storage3.StorageApiError's `.status` attribute for the idempotency path."""

    def __init__(self, status: int) -> None:
        super().__init__(f"status={status}")
        self.status = status


def _factory_for(client: _FakeClient):
    calls = {"n": 0}

    async def _make():
        calls["n"] += 1
        return client

    _make.calls = calls
    return _make


async def test_confirm_empties_then_deletes_in_order() -> None:
    client = _FakeClient(_FakeStorage())
    rc = await main(["--confirm"], client_factory=_factory_for(client))
    assert rc == 0
    assert client.storage.calls == [("empty_bucket", BUCKET), ("delete_bucket", BUCKET)]


async def test_confirm_nulls_dead_pointers_after_delete() -> None:
    """After emptying+deleting the bucket, the rollback also nulls the now-dead thumbnail_url pointers
    (scoped by the `%/reel-covers/%` LIKE) so the UI reverts to placeholders instead of 404 tiles."""
    client = _FakeClient(_FakeStorage())
    rc = await main(["--confirm"], client_factory=_factory_for(client))
    assert rc == 0
    assert client.reel_cache.updates == [
        ({"thumbnail_url": None}, [("like", "thumbnail_url", f"%/{BUCKET}/%")]),
    ]


async def test_without_confirm_refuses_and_touches_nothing() -> None:
    client = _FakeClient(_FakeStorage())
    factory = _factory_for(client)
    rc = await main([], client_factory=factory)
    assert rc != 0
    assert factory.calls["n"] == 0            # no client even built
    assert client.storage.calls == []         # no storage op
    assert client.reel_cache.updates == []    # no DB pointer nulling


async def test_already_gone_is_idempotent() -> None:
    client = _FakeClient(_FakeStorage(empty_error=_FakeStorageApiError(404)))
    rc = await main(["--confirm"], client_factory=_factory_for(client))
    assert rc == 0
    # empty_bucket ran and 404'd; delete_bucket is skipped — the bucket is already absent.
    assert client.storage.calls == [("empty_bucket", BUCKET)]
    # pointers are still cleared (idempotent) even when the bucket had already vanished.
    assert client.reel_cache.updates == [
        ({"thumbnail_url": None}, [("like", "thumbnail_url", f"%/{BUCKET}/%")]),
    ]


async def test_unexpected_error_propagates() -> None:
    client = _FakeClient(_FakeStorage(empty_error=_FakeStorageApiError(500)))
    with pytest.raises(_FakeStorageApiError):
        await main(["--confirm"], client_factory=_factory_for(client))
    # a genuine (non-404) storage error propagates BEFORE any DB pointer clearing.
    assert client.reel_cache.updates == []
