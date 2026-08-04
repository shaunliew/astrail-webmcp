"""Behavioral tests for backend/erasure.py (lean account-deletion, Task 1).

Each guard must redden ALONE — remove one guard and exactly one test fails. No
vacuous "the mock was called" assertions: every test asserts the OUTCOME (a raise, a
specific exception TYPE, or a clean return). Uses FAKE clients / mem0 only — never the
real mem0 SDK, never the network.
"""
from __future__ import annotations

import pytest

import erasure
from erasure import (
    ErasureError,
    InvalidUserId,
    MemoryBackendUnavailable,
    MemoryPurgeError,
    _assert_real_uuid,
    purge_account_memory,
)

# Canonical, lowercase, and containing hex letters (a-f) so that .upper() actually
# changes it — an all-digit UUID would uppercase to itself and defeat the case test.
_VALID_UUID = "f47ac10b-58cc-4372-a567-0e02b2c3d479"


# --------------------------------------------------------------------------- #
# _assert_real_uuid — the strict value guard
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "bad",
    [
        None,                                          # non-str -> TypeError path
        12345,                                         # non-str int -> AttributeError path
        "",                                            # empty -> ValueError
        "*",                                           # garbage -> ValueError
        "not-a-real-uuid",                             # garbage -> ValueError
        "f47ac10b-58cc-4372",                          # truncated -> ValueError
        "{f47ac10b-58cc-4372-a567-0e02b2c3d479}",      # brace-form -> str(UUID) != input
        _VALID_UUID.upper(),                           # uppercased -> str(UUID) != input
        "urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479",  # urn: spelling -> != input
    ],
)
def test_assert_real_uuid_rejects_non_canonical(bad):
    with pytest.raises(InvalidUserId):
        _assert_real_uuid(bad)


def test_assert_real_uuid_accepts_canonical_lowercase():
    # Must NOT raise; the guard returns None on the one accepted spelling.
    assert _assert_real_uuid(_VALID_UUID) is None


def test_uppercase_case_is_actually_a_different_string():
    # Guards the test itself: the chosen UUID must have letters, so .upper() differs.
    assert _VALID_UUID.upper() != _VALID_UUID


# --------------------------------------------------------------------------- #
# purge_account_memory — guard precedes the purge call
# --------------------------------------------------------------------------- #
class _ExplodingMem0:
    """Any attribute access explodes — proves mem0 is never touched on a bad id."""

    def __getattr__(self, name):  # pragma: no cover - must never be reached
        raise AssertionError(f"mem0.{name} must not be touched for an invalid user_id")


@pytest.mark.parametrize("bad", ["*", None])
async def test_purge_guards_before_calling_clear_memory(monkeypatch, bad):
    async def _exploding_clear_memory(*args, **kwargs):
        raise AssertionError("clear_memory must not be called for an invalid user_id")

    monkeypatch.setattr(erasure, "clear_memory", _exploding_clear_memory)

    with pytest.raises(InvalidUserId):
        await purge_account_memory(client=object(), mem0=_ExplodingMem0(), user_id=bad)


# --------------------------------------------------------------------------- #
# purge_account_memory — tri-state translation (monkeypatched clear_memory)
# --------------------------------------------------------------------------- #
def _fake_clear_memory_returning(value):
    async def _fake(client, mem0, *, user_id):
        return value

    return _fake


async def test_purge_returns_when_cleared(monkeypatch):
    monkeypatch.setattr(erasure, "clear_memory", _fake_clear_memory_returning("cleared"))
    result = await purge_account_memory(client=object(), mem0=object(), user_id=_VALID_UUID)
    assert result is None  # returns normally, does not raise


async def test_purge_raises_backend_unavailable(monkeypatch):
    monkeypatch.setattr(erasure, "clear_memory", _fake_clear_memory_returning("unavailable"))
    with pytest.raises(MemoryBackendUnavailable):
        await purge_account_memory(client=object(), mem0=object(), user_id=_VALID_UUID)


async def test_purge_raises_purge_error_on_unknown(monkeypatch):
    monkeypatch.setattr(erasure, "clear_memory", _fake_clear_memory_returning("unknown"))
    with pytest.raises(MemoryPurgeError):
        await purge_account_memory(client=object(), mem0=object(), user_id=_VALID_UUID)


async def test_purge_raises_purge_error_on_unexpected_value(monkeypatch):
    # Defensive: any value other than the three known ones is treated as unconfirmed.
    monkeypatch.setattr(erasure, "clear_memory", _fake_clear_memory_returning("weird-new-state"))
    with pytest.raises(MemoryPurgeError):
        await purge_account_memory(client=object(), mem0=object(), user_id=_VALID_UUID)


# --------------------------------------------------------------------------- #
# purge_account_memory — one REAL-path test (no monkeypatch of the translation)
# --------------------------------------------------------------------------- #
class _StubClient:
    """Trivial client whose .table() explodes — proves mem0=None short-circuits in
    clear_memory (memory_clear.py:164) BEFORE the Supabase client is ever touched."""

    def table(self, *args, **kwargs):  # pragma: no cover - must never be reached
        raise AssertionError("client must not be touched when mem0 is None")


async def test_purge_real_path_unavailable_when_mem0_none():
    # The REAL clear_memory runs here: mem0=None -> returns 'unavailable' before any
    # client use -> purge must raise MemoryBackendUnavailable.
    with pytest.raises(MemoryBackendUnavailable):
        await purge_account_memory(client=_StubClient(), mem0=None, user_id=_VALID_UUID)


# --------------------------------------------------------------------------- #
# Exception taxonomy — guard error is NOT a purge error (and vice-versa)
# --------------------------------------------------------------------------- #
def test_guard_error_is_distinct_from_purge_errors():
    # No subclass relationship in EITHER direction between the guard error and the
    # two purge errors, nor between the two purge errors themselves.
    assert not issubclass(InvalidUserId, (MemoryBackendUnavailable, MemoryPurgeError))
    assert not issubclass(MemoryBackendUnavailable, (InvalidUserId, MemoryPurgeError))
    assert not issubclass(MemoryPurgeError, (InvalidUserId, MemoryBackendUnavailable))

    # An InvalidUserId instance must never register as a purge error.
    assert not isinstance(InvalidUserId("x"), (MemoryBackendUnavailable, MemoryPurgeError))
    assert not isinstance(MemoryBackendUnavailable("x"), InvalidUserId)
    assert not isinstance(MemoryPurgeError("x"), InvalidUserId)


def test_all_three_share_the_erasure_base():
    # Distinct concrete types, but all catchable as one family.
    for exc_cls in (InvalidUserId, MemoryBackendUnavailable, MemoryPurgeError):
        assert issubclass(exc_cls, ErasureError)
    assert InvalidUserId is not MemoryBackendUnavailable is not MemoryPurgeError
