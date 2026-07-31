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


class _FakeClient:
    def __init__(self, storage: _FakeStorage) -> None:
        self.storage = storage


class _FakeStorageApiError(Exception):
    """Duck-types storage3.StorageApiError's `.status` attribute for the idempotency path."""

    def __init__(self, status: int) -> None:
        super().__init__(f"status={status}")
        self.status = status


def _factory_for(storage: _FakeStorage):
    async def _make():
        return _FakeClient(storage)

    return _make


async def test_confirm_empties_then_deletes_in_order() -> None:
    storage = _FakeStorage()
    rc = await main(["--confirm"], client_factory=_factory_for(storage))
    assert rc == 0
    assert storage.calls == [("empty_bucket", BUCKET), ("delete_bucket", BUCKET)]


async def test_without_confirm_refuses_and_touches_nothing() -> None:
    storage = _FakeStorage()
    rc = await main([], client_factory=_factory_for(storage))
    assert rc != 0
    assert storage.calls == []


async def test_already_gone_is_idempotent() -> None:
    storage = _FakeStorage(empty_error=_FakeStorageApiError(404))
    rc = await main(["--confirm"], client_factory=_factory_for(storage))
    assert rc == 0
    # empty_bucket ran and 404'd; delete_bucket is skipped — the bucket is already absent.
    assert storage.calls == [("empty_bucket", BUCKET)]


async def test_unexpected_error_propagates() -> None:
    storage = _FakeStorage(empty_error=_FakeStorageApiError(500))
    with pytest.raises(_FakeStorageApiError):
        await main(["--confirm"], client_factory=_factory_for(storage))
