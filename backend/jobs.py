"""Durable generation jobs backed by a Supabase `jobs` table.

Enqueue a job row before any work begins, key it with an idempotency key, and
run a startup recovery sweep so a Render restart never orphans an in-flight
pipeline. See CLAUDE.md guardrail #12.
"""


# TODO: enqueue / claim / complete jobs and recover in-flight runs on startup.
async def enqueue_job(trip_id: str, idempotency_key: str) -> str:
    """Persist a pending job row and return its id (idempotent on the key)."""
    raise NotImplementedError


async def recover_inflight_jobs() -> None:
    """Re-sweep jobs left in a running state by a crashed/restarted process."""
    raise NotImplementedError
