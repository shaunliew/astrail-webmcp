"""Durable generation jobs backed by a Supabase `jobs` table.

Enqueue a pending job before any work; the runner owns the lifecycle
(pending -> running -> succeeded/failed); a startup recovery sweep re-queues
runs a crash left mid-flight. Idempotency keys are request-derived so a retried
POST never double-runs. See CLAUDE.md guardrail #12.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from supabase_client import get_supabase_client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str) -> str:
    """Deterministic key from the REQUEST (not the trip id) so retries dedupe."""
    material = "|".join([user_id, ",".join(sorted(reel_urls)), start_date, end_date])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def enqueue_job(trip_id: str, user_id: str, idempotency_key: str, *, client=None) -> str:
    """Persist a pending job and return its id (idempotent on the key)."""
    client = client or get_supabase_client()
    row = {"trip_id": trip_id, "user_id": user_id,
           "idempotency_key": idempotency_key, "status": "pending"}
    try:
        return client.table("jobs").insert(row).execute().data[0]["id"]
    except Exception as exc:
        if "idempotency_key" not in str(exc) and "duplicate key" not in str(exc):
            raise
        existing = (client.table("jobs").select("id")
                    .eq("idempotency_key", idempotency_key).execute())
        return existing.data[0]["id"]


async def mark_job_running(client, job_id: str) -> None:
    """pending/retryable -> running; stamp locked_at + started_at, bump attempt_count."""
    current = client.table("jobs").select("attempt_count,started_at").eq("id", job_id).execute().data
    attempt = (current[0].get("attempt_count", 0) if current else 0) + 1
    started = (current[0].get("started_at") if current else None) or _now()
    client.table("jobs").update({
        "status": "running", "locked_at": _now(), "started_at": started,
        "attempt_count": attempt, "completed_at": None, "error_message": None,
    }).eq("id", job_id).execute()


async def mark_job_done(client, job_id: str, *, status: str) -> None:
    """running -> succeeded|failed; stamp completed_at."""
    client.table("jobs").update({"status": status, "completed_at": _now()}).eq("id", job_id).execute()


async def recover_inflight_jobs(*, client=None, stale_after_s: int = 900) -> list[dict]:
    """Re-queue runs a crash left mid-flight (implemented in Task 5)."""
    raise NotImplementedError  # Task 5
