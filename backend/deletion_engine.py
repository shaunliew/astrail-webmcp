"""Two-pass, idempotent, honest-or-flag account-delete engine + sweep (Task 3).

GATED OFF. `sweep_due_deletions` runs ONLY from `_reap_loop` when `_DELETION_EXECUTION_READY`
is True (main.py), which Task 6 flips. Until then nothing here executes — no account is ever
touched. It builds strictly on the already-committed contract:

  * `erasure.purge_account_memory` (Task 1) — the strict mem0 purge wrapper that RAISES unless
    mem0 is CONFIRMED cleared. REUSED, never reimplemented. Its success is NOT terminal proof
    (plan §3.4), which is exactly why this engine runs a two-pass verify on top of it.
  * `claim_account_for_deletion` (20260805010000) — the atomic pending_deletion→deleting CAS,
    the point of no return; a concurrent cancel loses.
  * `account_deletion_log` (Task 2) — the FK-free, service-role-only work-queue + audit row.

Two passes, driven off the log row's `(outcome, purged_verified_at)`:

  Pass A (outcome='pending'):  claim → quiesce → purge + verify. NEVER hard-deletes. On an
    UNCONFIRMED purge it stays retryable (backoff), never advancing; on a CONFIRMED clear it
    records `purged_verified_at` + advances outcome to 'deleting'.
  Pass B (outcome='deleting', purged_verified_at set, a settle tick later):  RE-verify mem0 still
    empty (catches a late-materialized add), then hard-delete auth.users (cascade). A 404 /
    already-absent = success. Crash recovery: a 'deleting' row whose public.users is already gone
    is treated as done.

Exception discipline (plan §3.4, T1-review note): the backoff path catches ONLY the two Memory*
exceptions. `InvalidUserId` (a corrupted user_id) propagates as a HARD, non-retryable failure —
the sweep terminalizes that row to 'failed' rather than looping on it forever.

Determinism / clock: deletion timings are coarse (a 7-day grace, a ~120s settle, minute-scale
backoffs), so host-clock comparisons here are fine — unlike the job lease's tight, skew-sensitive
window, which compares in Postgres. The mem0 RE-verify, not the settle clock, is the load-bearing
guard against a late add; the settle gap only keeps Pass B out of the same tick as the Pass A
purge.

Import-safe: only `erasure` (→ pipeline.memory_clear) is imported at module load — no key, no
heavy SDK, no network. mem0 and the admin auth client are fetched lazily inside functions.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from erasure import (
    InvalidUserId,
    MemoryBackendUnavailable,
    MemoryPurgeError,
    _assert_real_uuid,
    purge_account_memory,
)

logger = logging.getLogger(__name__)

# Non-terminal work that must have drained before we hard-delete (quiescence). After a 7-day
# grace these are near-certainly empty; a straggler makes Pass A back off, never delete.
_NONTERMINAL_TRIP_JOB_STATUSES = ("pending", "running", "retryable")
_NONTERMINAL_ORGANIZE_JOB_STATUSES = ("pending", "processing")

# Settle gap between a confirmed Pass A purge and the Pass B hard-delete: at least one sweep tick,
# so a mem0 add that was still materializing at purge time has surfaced and Pass B's re-verify can
# catch it. Kept >= the reaper's REAP_INTERVAL_S (120s) so "one tick later" is honoured even if a
# row is somehow reprocessed within a tick.
_SETTLE_GAP_S = 120

# Backoff for an unconfirmed purge / non-quiescence / auth-delete blip. Exponential, capped. The
# row STAYS retryable (never marked completed/deleted); after _MAX_ATTEMPTS each further attempt
# also logs a loud error so a human notices a wedged deletion (plan §6: founder fixes by hand).
_BACKOFF_BASE_S = 120
_BACKOFF_CAP_S = 3600
_MAX_ATTEMPTS = 5


def _now_utc() -> datetime:
    """The single time source for settle/backoff. A function so tests can freeze it."""
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now_utc().isoformat()


async def _get_mem0():
    """Lazy: keeps the mem0 SDK off the import path (import-time invariant)."""
    from mem0_client import get_mem0_client

    return await get_mem0_client()


async def claim_account_for_deletion(client, user_id: str) -> bool:
    """The atomic point of no return: CAS pending_deletion→deleting via the security-definer RPC.

    Returns True when THIS call won the claim, False otherwise (a concurrent cancel already
    flipped the row to 'active', the row is absent, or it is already 'deleting'). The caller
    disambiguates a false via a status re-read.
    """
    from deletion import DeletionRPCUnavailable  # reused; not modified
    from postgrest.exceptions import APIError

    try:
        resp = await client.rpc("claim_account_for_deletion", {"p_user_id": user_id}).execute()
    except APIError as exc:
        if getattr(exc, "code", None) == "PGRST202":
            raise DeletionRPCUnavailable("claim_account_for_deletion RPC is not deployed") from None
        raise
    return bool(resp.data)


async def _read_account_status(client, user_id: str) -> str | None:
    """Read public.users.account_status, or None when the row is ABSENT (the auth-delete cascade
    already removed it — the crash-recovery signal). maybe_single() yields a bare None on zero
    rows; both that and a None `.data` mean 'gone'."""
    res = await (
        client.table("users").select("account_status").eq("id", user_id).maybe_single().execute()
    )
    row = getattr(res, "data", None) if res is not None else None
    return row.get("account_status") if isinstance(row, dict) else None


async def _has_nonterminal_work(client, user_id: str) -> bool:
    """True if any trip or organize job for this user is still in flight (quiescence check).
    Near-certainly False after a 7-day grace; a straggler makes Pass A back off, never delete."""
    trip = await (
        client.table("jobs").select("id").eq("user_id", user_id)
        .in_("status", list(_NONTERMINAL_TRIP_JOB_STATUSES)).limit(1).execute()
    )
    if getattr(trip, "data", None):
        return True
    org = await (
        client.table("organize_jobs").select("id").eq("user_id", user_id)
        .in_("status", list(_NONTERMINAL_ORGANIZE_JOB_STATUSES)).limit(1).execute()
    )
    return bool(getattr(org, "data", None))


async def _admin_hard_delete(client, user_id: str) -> None:
    """Hard-delete the auth user (cascade wipes the user-scoped public tables). A 404 /
    already-absent is SUCCESS (idempotent re-run). Any other error propagates so the caller backs
    off — never assume success on an unknown failure, which could mark a still-present account
    completed. should_soft_delete=False is the real, non-recoverable delete."""
    try:
        await client.auth.admin.delete_user(user_id, should_soft_delete=False)
    except Exception as exc:  # noqa: BLE001 — classified by status, re-raised otherwise
        if getattr(exc, "status", None) == 404:
            return  # already gone = the desired end state
        raise


def _backoff_seconds(attempts: int) -> int:
    return min(_BACKOFF_BASE_S * (2 ** max(attempts - 1, 0)), _BACKOFF_CAP_S)


async def _backoff(client, log_row: dict, reason: str) -> None:
    """Record a RETRYABLE stall on the log row: bump attempts, schedule next_attempt_at, and store
    the reason. Leaves outcome untouched (never advances, never terminalizes) — the row stays in
    the sweep's `outcome IN ('pending','deleting')` set. After _MAX_ATTEMPTS, each attempt also
    logs a loud error so a wedged deletion is visible for a human (plan §6). `reason` is a short,
    secret-free string (only exception TYPE names ever flow in — token safety)."""
    attempts = int(log_row.get("attempts") or 0) + 1
    next_at = (_now_utc() + timedelta(seconds=_backoff_seconds(attempts))).isoformat()
    await (
        client.table("account_deletion_log")
        .update({"attempts": attempts, "next_attempt_at": next_at, "last_error": reason})
        .eq("id", log_row["id"]).execute()
    )
    if attempts >= _MAX_ATTEMPTS:
        logger.error(
            "account_deletion_stalled log_id=%s attempts=%s reason=%s — FLAGGED for manual review",
            log_row.get("id"), attempts, reason,
        )


async def _mark_purged(client, log_row: dict) -> None:
    """Pass A confirmed clear: record the verified purge and advance outcome to 'deleting'. Clears
    the retry fields so Pass B is not gated behind a stale backoff."""
    await (
        client.table("account_deletion_log")
        .update({"purged_verified_at": _now_iso(), "outcome": "deleting",
                 "next_attempt_at": None, "last_error": None})
        .eq("id", log_row["id"]).execute()
    )


async def _mark_completed(client, log_row: dict) -> None:
    """Terminal success: the auth user is gone (or already was). Task 4 will send the completion
    email to recipient_email and then clear it; deliberately NOT touched here."""
    await (
        client.table("account_deletion_log")
        .update({"outcome": "completed", "completed_at": _now_iso(),
                 "next_attempt_at": None, "last_error": None})
        .eq("id", log_row["id"]).execute()
    )
    # TODO(Task 4): fire the best-effort "your account has been deleted" completion email to
    # log_row["recipient_email"], then clear recipient_email once the send is accepted.


async def _mark_failed(client, log_row: dict, reason: str) -> None:
    """Terminal, NON-retryable failure (e.g. a corrupted user_id). Distinct from _backoff: this
    stops the sweep from re-selecting the row forever. `reason` is secret-free."""
    await (
        client.table("account_deletion_log")
        .update({"outcome": "failed", "last_error": reason})
        .eq("id", log_row["id"]).execute()
    )


def _settle_gap_elapsed(purged_verified_at: str | None) -> bool:
    """True once at least _SETTLE_GAP_S has passed since the Pass A purge — the gap that lets a
    late-materializing mem0 add surface for Pass B's re-verify. Conservative on an unparseable
    reference: return False (wait) rather than delete early. Postgres timestamptz is always
    parseable, so this is a defensive backstop, not an expected path."""
    if not purged_verified_at:
        return False
    try:
        ref = datetime.fromisoformat(purged_verified_at)
    except (TypeError, ValueError):
        logger.warning("account_deletion settle gap: unparseable purged_verified_at")
        return False
    return (_now_utc() - ref) >= timedelta(seconds=_SETTLE_GAP_S)


async def _erase_pass_a(client, mem0, log_row: dict, user_id: str) -> None:
    """Claim → quiesce → purge + verify. NEVER hard-deletes; on an unconfirmed purge it stays
    retryable without advancing."""
    won = await claim_account_for_deletion(client, user_id)
    if not won:
        # A false claim is ambiguous: a cancel may have won (→ never delete), OR we already
        # claimed this account into 'deleting' on a prior tick and are here to retry the purge
        # (the log row is still 'pending' because that prior purge was unconfirmed). Re-read the
        # status to tell them apart — the RPC stays a pure CAS.
        status = await _read_account_status(client, user_id)
        if status is None:
            # public.users is gone — the auth-delete cascaded it already. Reconcile to done.
            await _mark_completed(client, log_row)
            return
        if status != "deleting":
            # 'active' (a cancel won) or a transient 'pending_deletion' race. Do NOT delete;
            # leave the row. A cancel also marks the log 'cancelled', so the sweep stops
            # selecting it; a race is retried next tick.
            return
        # status == 'deleting': this account is ours from a prior claim — fall through and retry.

    if await _has_nonterminal_work(client, user_id):
        # Not quiet yet (near-impossible after 7 days). Back off; the in-flight job will finish.
        await _backoff(client, log_row, "quiescence: non-terminal job in flight")
        return

    try:
        await purge_account_memory(client, mem0, user_id)
    except (MemoryBackendUnavailable, MemoryPurgeError) as exc:
        # ONLY these two — an unconfirmed purge stays retryable and NEVER hard-deletes. Do not
        # advance outcome. InvalidUserId is deliberately NOT caught (it propagated at line 1 of
        # erase_user anyway); a corrupted id is a hard failure, never a backoff loop.
        await _backoff(client, log_row, f"purge unconfirmed: {type(exc).__name__}")
        return

    # Confirmed clear — but NOT terminal proof (plan §3.4). Record it and advance to Pass B.
    await _mark_purged(client, log_row)


async def _erase_pass_b(client, mem0, log_row: dict, user_id: str) -> None:
    """Re-verify mem0 still empty (settle gap has passed), then hard-delete. Handles crash
    recovery (public.users already gone) as success."""
    status = await _read_account_status(client, user_id)
    if status is None:
        # Crash recovery: outcome='deleting' but public.users is MISSING — a prior Pass B already
        # ran the auth-delete (which re-verified mem0 first) and crashed before marking the log.
        # The user is gone; finish the log. Re-verifying/re-deleting here is neither needed nor
        # safe (a mem0 blip must not wedge an account that is already deleted).
        await _mark_completed(client, log_row)
        return

    if not _settle_gap_elapsed(log_row.get("purged_verified_at")):
        # Too soon after the Pass A purge. Wait for a later tick (no backoff — this is not a
        # failure); the row stays selected until the gap elapses.
        return

    try:
        # Re-verify: a late-queued add that landed after Pass A now makes this RAISE, sending us
        # back to retry instead of deleting over live data.
        await purge_account_memory(client, mem0, user_id)
    except (MemoryBackendUnavailable, MemoryPurgeError) as exc:
        await _backoff(client, log_row, f"pass B re-verify unconfirmed: {type(exc).__name__}")
        return

    try:
        await _admin_hard_delete(client, user_id)
    except Exception as exc:  # noqa: BLE001 — 404 handled inside; other failures back off
        await _backoff(client, log_row, f"auth delete failed: {type(exc).__name__}")
        return

    await _mark_completed(client, log_row)


async def erase_user(client, mem0, log_row: dict) -> None:
    """Run one two-pass step for a due deletion-log row. Idempotent: safe to call repeatedly for
    the same row across sweep ticks.

    Raises InvalidUserId (does NOT catch it) when log_row['user_id'] is not a canonical UUID — a
    corrupted id is a hard, non-retryable failure that the SWEEP terminalizes, never a backoff
    loop. Everything else is handled internally (backoff / advance / complete).
    """
    # Coerce to str (plan §3.4: a native uuid.UUID would fail closed correctly, but pass a str)
    # and validate OUTSIDE any try — a bad id must raise before any RPC, purge, or delete.
    user_id = str(log_row["user_id"])
    _assert_real_uuid(user_id)

    outcome = log_row.get("outcome")
    if outcome == "pending":
        await _erase_pass_a(client, mem0, log_row, user_id)
    elif outcome == "deleting":
        await _erase_pass_b(client, mem0, log_row, user_id)
    # completed/failed/cancelled: nothing to do. The sweep query already excludes them; this is a
    # defensive no-op for a row that changed state between select and dispatch.


async def sweep_due_deletions(client) -> None:
    """The reaper's deletion branch body (plan §3.4). Selects due, not-in-backoff deletion-log
    rows and runs the two-pass erase_user for each. Sequential is fine for beta.

    Callers (main._run_deletion_sweep) gate on `_DELETION_EXECUTION_READY` and wrap this in their
    OWN try, so a deletion failure never skips trip/organize job recovery.
    """
    now = _now_utc()
    rows = (
        await client.table("account_deletion_log").select("*")
        .in_("outcome", ["pending", "deleting"])
        .lte("scheduled_for", now.isoformat())
        .execute()
    ).data or []

    mem0 = await _get_mem0()
    for row in rows:
        # next_attempt_at gate (backoff). PostgREST can't cleanly express "col IS NULL OR
        # col <= now" in one filter, so gate here over the already-bounded row set.
        nxt = row.get("next_attempt_at")
        if nxt is not None:
            try:
                if datetime.fromisoformat(nxt) > now:
                    continue  # still in backoff
            except (TypeError, ValueError):
                pass  # unparseable → don't let it gate; process the row
        try:
            await erase_user(client, mem0, row)
        except InvalidUserId:
            # Hard, non-retryable: a corrupted user_id must not be retried forever. Terminalize
            # the row and shout — never a delete, never a loop.
            logger.error("account_deletion invalid user_id log_id=%s — FLAGGED", row.get("id"))
            await _mark_failed(client, row, "invalid_user_id")
        except Exception as exc:  # noqa: BLE001 — one row's transient failure must not stop the rest
            # Type only, never the message/traceback: a postgrest/supabase error can carry
            # connection details. The row stays selected and retries on the next tick.
            logger.warning("account_deletion row failed log_id=%s error=%s",
                           row.get("id"), type(exc).__name__)
