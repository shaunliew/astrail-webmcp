"""POST /settings/memory/clear — the STRICT half of the mem0 settings surface.

Deliberate inverse of GET /settings/preferences: that read DEGRADES (guardrail #3), this
fails loudly. Guardrail #3 does NOT apply to a destructive user-facing action.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import datetime, timedelta

_CLEAR_TIMEOUT_S = 5             # ~13x the measured 374ms steady-state delete
_VERIFY_TIMEOUT_S = 4            # matches list_memory_facts' existing read timeout
# The window must cover the WHOLE interval in which a generation's add can still land, not
# just mem0's materialization (C12). 15s covered only the measured 4-8s PENDING -> readable
# latency, so an intent could age out of view while its own add was still pending — the clear
# then answered 'cleared' and the add landed behind it (Codex reproduced it). The budget it
# has to cover: preferences' bounded pre-add path (4 + 4 + 4 = 12s to issue the add) + the
# add's own 5s bound + 4-8s materialization ~= 25s. 30 leaves margin. Narrowing this without
# narrowing those bounds reopens the race.
_ADD_VISIBILITY_WINDOW_S = 30


def _minus_seconds(ts: str, seconds: int) -> str | None:
    """Subtract from a POSTGRES-sourced ISO timestamp. None when unparseable — callers
    MUST treat None as 'no reference', never as 'no add in flight'."""
    try:
        return (datetime.fromisoformat(ts) - timedelta(seconds=seconds)).isoformat()
    except (TypeError, ValueError):
        return None


def _confirmed_nothing_deleted(e: Exception) -> bool:
    """True ONLY when the request provably never reached mem0.

    Narrowed to NET_CONNECT alone (Codex R2). An HTTP status tells us which exception
    class the SDK raised, NOT that the server had no side effects: a 409 can mean "a
    deletion is already in progress" — possibly OUR retried request — and a 429 can come
    from a gateway. Everything else VERIFIES rather than asserting.
    """
    return getattr(e, "error_code", None) == "NET_CONNECT"


async def _write_clear_marker(client, user_id: str) -> tuple[str | None, str | None]:
    """Insert the 'cleared' audit row BEFORE the delete so persist_trip_memory's guard is
    armed before anything can be deleted (D4). Returns (row_id, created_at).

    created_at is POSTGRES-sourced and is the ONLY clock comparable against
    memory_events.created_at — stamping this host's clock is the skew bug jobs.py:94-97
    already documents for the job lease.
    """
    try:
        res = await client.table("memory_events").insert({
            "user_id": user_id, "trip_id": None, "event_type": "cleared",
            "learned_facts_json": [],
        }).execute()
        row = (getattr(res, "data", None) or [{}])[0]
        return row.get("id"), row.get("created_at")
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear aborted, audit insert failed: {type(e).__name__}", file=sys.stderr)
        return None, None


async def _mark_marker_failed(client, marker_id: str) -> None:
    """Flip the marker to 'failed' in ONE statement.

    Codex R2: delete-then-insert is not atomic — retraction-succeeds/insert-fails loses
    the attempt from the audit trail entirely, and retraction-fails leaves a stale marker
    that keeps suppressing. A single UPDATE either records the truth or leaves the
    conservative 'cleared' marker, which over-suppresses in a bounded way rather than
    resurrecting cleared data.

    UPDATE rather than DELETE on purpose: the marker records a real user action (they
    clicked Clear) which happened regardless of how the delete then turned out, so the row
    is worth keeping with a truthful event_type. Contrast persist_trip_memory's add-intent,
    which IS deleted when the guard fires — that row represents a plan cancelled before any
    external side effect, so there is no action to preserve, and keeping it would keep
    matching _add_possibly_in_flight for a whole _ADD_VISIBILITY_WINDOW_S, causing a false
    `unknown` on the next clear.
    """
    try:
        await client.table("memory_events").update({"event_type": "failed"}) \
            .eq("id", marker_id).execute()
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear marker retraction failed: {type(e).__name__}", file=sys.stderr)


async def _memory_is_empty(mem0, user_id: str) -> bool:
    """STRICT emptiness check — deliberately NOT list_memory_facts, which drops
    unparseable rows and still reports "ok" (a presentation reader and a destructive
    verifier have opposite biases).

    True ONLY on a well-formed envelope proving zero rows. The SDK documents
    `count: int` + `results: list`; anything else is shape drift, and for a destructive
    verifier drift must never read as empty.
    """
    try:
        res = await asyncio.wait_for(
            mem0.get_all(version="v2", filters={"AND": [{"user_id": user_id}]},
                         page=1, page_size=1),
            timeout=_VERIFY_TIMEOUT_S)
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear verify unavailable: {type(e).__name__}", file=sys.stderr)
        return False
    if not isinstance(res, dict):
        return False                        # legacy/list envelopes are NOT established here
    rows, count = res.get("results"), res.get("count")
    # `type(count) is int` on purpose: bool subclasses int, and False == 0 would sneak
    # a drifted payload through as "empty".
    return isinstance(rows, list) and not rows and type(count) is int and count == 0


async def _add_possibly_in_flight(client, *, user_id: str, now_ref: str | None) -> bool:
    """True if a generation's mem0.add may still be materializing, in which case an empty
    verification read is not trustworthy (add returns PENDING in ~570ms; the memory
    becomes readable ~4-8s later).

    Matches BOTH 'learned' AND 'failed': persist_trip_memory records 'failed' on any add
    error OR TIMEOUT, and a timed-out add is exactly the case most likely to still land.

    Requires trip_id IS NOT NULL so this never matches the clear endpoint's OWN audit
    rows (trip_id NULL) — otherwise one previously failed clear would make every later
    clear report 'unknown' forever.
    """
    cutoff = _minus_seconds(now_ref, _ADD_VISIBILITY_WINDOW_S) if now_ref else None
    if cutoff is None:
        # Conservative, and deliberately NOT "skip the check": without a reference we
        # cannot rule out an in-flight add, and claiming a confirmed clear anyway is the
        # exact overclaim this endpoint exists to prevent.
        print("[mem0] clear: no usable Postgres time reference; assuming an add may be "
              "in flight", file=sys.stderr)
        return True
    try:
        res = await client.table("memory_events").select("id") \
            .eq("user_id", user_id).in_("event_type", ["learned", "failed"]) \
            .not_.is_("trip_id", "null") \
            .gt("created_at", cutoff).execute()
    except Exception:                       # noqa: BLE001
        return True                         # cannot rule it out -> never claim cleared
    return bool(getattr(res, "data", None))


async def clear_memory(client, mem0, *, user_id: str) -> str:
    """Delete this user's mem0 memories. Returns 'cleared' | 'unavailable' | 'unknown'.

    'cleared' asserts a POSTCONDITION — this user's memory is now empty (C1). It does NOT
    assert that >=1 record was deleted; clearing an already-empty account succeeds. What
    it never does is report success while records remain, or may remain.

    Why verification runs even on the happy path: delete_all returns in ~374ms while the
    server-side DELETE_ALL event takes ~830-880ms, and its payload literally says
    "Delete in progress. This may take some time." A clean return is NOT evidence.
    """
    if mem0 is None:
        return "unavailable"                # nothing sent, so nothing deleted
    uid = (user_id or "").strip()
    if not uid:
        # delete_all() with no filter deletes EVERY memory in the account. user_id is
        # token-derived so this is unreachable today; the blast radius earns the guard.
        return "unavailable"

    marker_id, now_ref = await _write_clear_marker(client, uid)
    if marker_id is None:
        return "unavailable"                # guard unarmed -> never attempt the delete

    try:
        await asyncio.wait_for(mem0.delete_all(user_id=uid), timeout=_CLEAR_TIMEOUT_S)
    except asyncio.TimeoutError:
        pass                                # may still commit -> verify
    except Exception as e:                  # noqa: BLE001
        print(f"[mem0] clear delete raised: {type(e).__name__}", file=sys.stderr)
        if _confirmed_nothing_deleted(e):
            await _mark_marker_failed(client, marker_id)
            return "unavailable"

    if not await _memory_is_empty(mem0, uid):
        return "unknown"
    if await _add_possibly_in_flight(client, user_id=uid, now_ref=now_ref):
        return "unknown"
    return "cleared"
