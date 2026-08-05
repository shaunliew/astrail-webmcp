"""Non-destructive account-erasure choke-point (lean account-deletion, Task 1).

The strict, self-contained safety layer for self-serve account deletion. It does
NOTHING destructive on its own and is imported by NOTHING yet — the delete engine
(Task 3) will wrap these. Two pieces:

- ``_assert_real_uuid`` — the value guard. Only a canonical lowercase UUID string is
  allowed near a destructive path (never ``"*"``, ``None``, ``""``, a brace-form, an
  ``urn:`` prefix, or an uppercased/truncated spelling). Deliberately STRICTER than
  ``telegram_ingest.config._parse_uuid`` (which normalizes those spellings): a delete
  target must be the exact value we stored, echoed back byte-for-byte.
- ``purge_account_memory`` — a strict wrapper over the existing ``clear_memory`` that
  RAISES unless mem0 is confirmed cleared. Its success is NOT terminal proof of
  erasure (plan §3.4): Task 3 runs a two-pass verify on top of it. This wrapper only
  reuses ``clear_memory``; it never reimplements a delete.

Import-safe: the only import is ``pipeline.memory_clear`` (asyncio/sys/datetime), so
importing this module needs no API key, imports no heavy SDK, and makes no network
call — the repo import-time invariant holds.
"""
from __future__ import annotations

import uuid

from pipeline.memory_clear import clear_memory


class ErasureError(Exception):
    """Base for erasure-path failures.

    Never raised directly — the three concrete subclasses below are DISTINCT types so
    a bad-input guard failure (``InvalidUserId``) can never be confused with a purge
    failure (``MemoryBackendUnavailable`` / ``MemoryPurgeError``).
    """


class InvalidUserId(ErasureError):
    """The ``user_id`` is not a canonical UUID — refuse before touching anything."""


class MemoryBackendUnavailable(ErasureError):
    """The mem0 purge could not run or be confirmed because the backend was
    unavailable. Nothing was necessarily deleted, and nothing was confirmed."""


class MemoryPurgeError(ErasureError):
    """The mem0 purge ran but could not be confirmed empty — memory may remain.
    NEVER treat this as a completed erasure."""


def _assert_real_uuid(u: object) -> None:
    """Raise ``InvalidUserId`` unless ``u`` is a canonical lowercase UUID string.

    The binding spec is STRICT round-trip equality: ``str(uuid.UUID(u)) == u``. That
    accepts only the one canonical spelling and rejects brace-form ``"{...}"``,
    uppercased/non-canonical forms, ``urn:`` prefixes, truncated/garbage, ``""``,
    ``"*"``, and non-string types (``None``, ``int``). Deliberately stricter than
    ``telegram_ingest.config._parse_uuid``, which normalizes those spellings — a
    delete target must match what we stored exactly.

    Safe to call as the FIRST line of a wrapper, OUTSIDE any try/except: it either
    returns ``None`` or raises ``InvalidUserId``, and touches nothing else.
    """
    try:
        canonical = str(uuid.UUID(u)) == u
    except (ValueError, TypeError, AttributeError) as exc:
        # uuid.UUID raises, empirically: ValueError (bad/short hex, "", "*"),
        # TypeError (None / no argument given), AttributeError (a non-str like an int,
        # whose missing .replace trips first). All mean "not a UUID" -> fail closed.
        raise InvalidUserId("user_id is not a UUID") from exc
    if not canonical:
        raise InvalidUserId("user_id is not the canonical UUID spelling")


async def purge_account_memory(client, mem0, user_id) -> None:
    """Purge this user's mem0 memory, raising unless it is CONFIRMED cleared.

    Line 1 (outside any try/except) is the value guard, so a bad ``user_id`` raises
    ``InvalidUserId`` BEFORE any mem0 / ``clear_memory`` call. Then it reuses the
    existing ``clear_memory`` (4 guards + verify-empty) and translates its tri-state
    return:

        'cleared'     -> return (ok)
        'unavailable' -> MemoryBackendUnavailable
        'unknown'     -> MemoryPurgeError
        anything else -> MemoryPurgeError (defensive)

    Confirmed-clear here is NOT terminal proof of erasure (plan §3.4) — Task 3 wraps
    this in a two-pass verify.
    """
    _assert_real_uuid(user_id)

    result = await clear_memory(client, mem0, user_id=user_id)
    if result == "cleared":
        return
    if result == "unavailable":
        raise MemoryBackendUnavailable("mem0 purge could not run or be confirmed")
    raise MemoryPurgeError(f"mem0 purge not confirmed cleared (result={result!r})")
