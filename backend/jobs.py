"""Durable generation jobs backed by a Supabase `jobs` table.

Enqueue a pending job before any work; the runner owns the lifecycle
(pending -> running -> succeeded/failed); a startup recovery sweep re-queues
runs a crash left mid-flight. Idempotency keys are request-derived so a retried
POST never double-runs. See CLAUDE.md guardrail #12.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from postgrest.exceptions import APIError

from supabase_client import get_supabase_client

_UNIQUE_VIOLATION = "23505"   # Postgres unique_violation (stable; use exc.code, NOT str(exc))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str,
                            *, preferences: str | None = None, pace: str = "balanced",
                            destination_hint: str | None = None) -> str:
    """Deterministic key from the REQUEST (not the trip id) so retries dedupe. Folds in
    every output-affecting field (A4): same reels+dates but CHANGED preferences/pace/
    destination_hint must produce a NEW trip, not replay the old one."""
    material = "|".join([user_id, ",".join(sorted(reel_urls)), start_date, end_date,
                         (preferences or ""), (pace or "balanced"), (destination_hint or "")])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def enqueue_job(trip_id: str, user_id: str, idempotency_key: str, *, client=None) -> tuple[str, str]:
    """Insert a pending job; return (job_id, trip_id). On a duplicate key, return the
    EXISTING job's (id, trip_id) — which may be a DIFFERENT trip when two same-key POSTs
    race, so the caller MUST redirect to the returned trip_id (see main.py)."""
    client = client or await get_supabase_client()
    row = {"trip_id": trip_id, "user_id": user_id, "idempotency_key": idempotency_key, "status": "pending"}
    try:
        created = (await client.table("jobs").insert(row).execute()).data[0]
        return created["id"], created["trip_id"]
    except APIError as exc:
        if exc.code != _UNIQUE_VIOLATION:
            raise
        existing = await (client.table("jobs").select("id,trip_id")
                          .eq("idempotency_key", idempotency_key).maybe_single().execute())
        if existing is None or existing.data is None:
            raise                       # unique violation but no matching row → surface, don't mask
        return existing.data["id"], existing.data["trip_id"]


async def mark_job_running(client, job_id: str) -> bool:
    """Atomic CAS claim: pending/retryable -> running in ONE statement. Returns True iff
    THIS caller won (empty result = already claimed/running/done → caller must abort).
    (attempt_count increment is deferred — postgrest can't do `col = col + 1`; not load-bearing.)"""
    result = await (client.table("jobs").update(
        {"status": "running", "locked_at": _now(), "started_at": _now(),
         "completed_at": None, "error_message": None})
        .eq("id", job_id).in_("status", ["pending", "retryable"]).execute())
    return bool(result.data)


async def mark_job_done(client, job_id: str, *, status: str) -> None:
    """running -> succeeded|failed; stamp completed_at."""
    await client.table("jobs").update({"status": status, "completed_at": _now()}).eq("id", job_id).execute()


async def recover_inflight_jobs(*, client=None, stale_after_s: int = 900) -> list[dict]:
    """Flip STALE running (locked_at older than stale_after_s) -> retryable, then return
    reclaimable jobs. The atomic CAS in mark_job_running (on redispatch) is what prevents a
    double-run when two instances recover the same job — so this select-then-flip is safe
    (flipping to retryable twice is idempotent). Restart-with-cache-reuse, NOT resume (#12)."""
    client = client or await get_supabase_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_s)).isoformat()
    stale = (await client.table("jobs").select("id").eq("status", "running")
             .lt("locked_at", cutoff).execute()).data
    for r in stale:
        await client.table("jobs").update({"status": "retryable"}).eq("id", r["id"]).execute()
    reclaimable = (await client.table("jobs").select("id,trip_id,user_id")
                   .in_("status", ["pending", "retryable"]).execute()).data
    return reclaimable
