"""Durable generation jobs backed by a Supabase `jobs` table.

Enqueue a pending job before any work; the runner owns the lifecycle
(pending -> running -> succeeded/failed). Ownership is a LEASE:
`(status, lease_token, lock_expires_at)`. A claim mints the token, a heartbeat renews the
expiry, every terminal write is a CAS on that token, and a reclaim (at boot and on a timer)
takes back runs whose lease expired. Idempotency keys are request-derived so a retried POST
never double-runs. See CLAUDE.md guardrail #12.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from postgrest.exceptions import APIError

from supabase_client import get_supabase_client

_UNIQUE_VIOLATION = "23505"   # Postgres unique_violation (stable; use exc.code, NOT str(exc))

JOB_LEASE_TTL_S = 300      # short on purpose: the heartbeat renews a live run, so a real
                           # crash is reclaimed in ~5 min rather than ~15.
JOB_LEASE_RENEW_S = 60     # comfortably under the TTL: several renewals may blip and be
                           # retried before the lease is genuinely at risk of expiring.

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pg_timestamp(value: datetime) -> str:
    """`Z`-suffixed ISO-8601 for use inside a PostgREST filter string.

    `datetime.isoformat()` emits `+00:00`, and a raw `+` inside an `or=` filter can be decoded
    as a space — which either 400s or silently matches nothing. The tz assertion is what makes
    the encoding right by construction: `.replace()` is a no-op on a naive or non-UTC value,
    so accepting one would reintroduce the raw `+` this exists to prevent, and the reaper
    injects its own `now`. Twin of `organizer._pg_timestamp` (same rationale in full there);
    the two stay separate only because `jobs` must not depend on `organizer`.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"_pg_timestamp requires a UTC-aware datetime, got {value!r}")
    return value.isoformat().replace("+00:00", "Z")


def compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str,
                            *, preferences: str | None = None, pace: str = "balanced",
                            destination_hint: str | None = None,
                            place_ids: list[str] | None = None) -> str:
    """Deterministic key from the REQUEST (not the trip id) so retries dedupe. Folds in
    every output-affecting field (A4): same reels+dates but CHANGED preferences/pace/
    destination_hint must produce a NEW trip, not replay the old one.

    JSON-encoded (not raw `|`/`,`-joined): free-text `preferences`/`destination_hint` can
    contain "|" and reel URLs can contain ",", so a naive delimiter-join lets two DIFFERENT
    requests produce the SAME material (a collision -- an idempotent replay would then
    return the WRONG trip). JSON's quoting/escaping makes each field boundary unambiguous.
    `preferences` is stripped to match the runtime's `merge_preferences`, so a
    whitespace-only difference doesn't spawn a duplicate trip."""
    material = json.dumps(
        [user_id, sorted(reel_urls), sorted(place_ids or []), start_date, end_date,
         (preferences or "").strip(), (pace or "balanced"), (destination_hint or "")],
        separators=(",", ":"), ensure_ascii=True)
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


async def mark_job_running(client, job_id: str) -> str | None:
    """Atomic CAS claim: pending/retryable -> running in ONE statement, minting this
    attempt's LEASE TOKEN. Returns the token iff THIS caller won, else None (already
    claimed → the caller must abort). The token fences every later write for this attempt.

    Minted PER ATTEMPT, never reused: a token shared across attempts would let a superseded
    worker pass the very fence its replacement installed.
    (attempt_count increment is deferred — postgrest can't do `col = col + 1`; not load-bearing.)
    """
    lease_token = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    result = await (client.table("jobs").update(
        {"status": "running", "locked_at": now.isoformat(), "started_at": now.isoformat(),
         "lock_expires_at": (now + timedelta(seconds=JOB_LEASE_TTL_S)).isoformat(),
         "lease_token": lease_token,
         "completed_at": None, "error_message": None})
        .eq("id", job_id).in_("status", ["pending", "retryable"]).execute())
    return lease_token if result.data else None


async def mark_job_done(client, job_id: str, *, status: str, lease_token: str) -> bool:
    """running -> succeeded|failed, fenced on our lease so a superseded worker cannot
    overwrite the replacement's terminal state. The token is REQUIRED: an optional-token
    form is a fencing bypass, and a caller with no token never owned the job.

    RETURNS bool — True iff we still held the lease and the write landed. Callers MUST check
    it: `False` means we were superseded, and the caller must then suppress its terminal
    `generation_events` result too. Returning None would make the fence unobservable to the
    one caller that has to react to it.

    No `status='running'` guard, deliberately: `reclaim_expired_jobs` NULLs the token when it
    takes a job back, so a reclaimed row already excludes us.
    """
    result = await (client.table("jobs").update({"status": status, "completed_at": _now()})
                    .eq("id", job_id).eq("lease_token", lease_token).execute())
    return bool(result.data)


async def _renew_job_lease(client, job_id: str, lease_token: str) -> bool:
    """Extend our trip lease. `False` means we LOST it (reaped, then reclaimed elsewhere).

    The CAS is the exact mirror of `reclaim_expired_jobs`, and the pair cannot both win.
    Whichever transaction commits first decides, in either order, with no third outcome: if
    this renewal commits first, `lock_expires_at` is back in the future and the reclaim's
    predicate no longer matches. If the reclaim commits first it NULLs `lease_token`, so
    `.eq("lease_token", ...)` here matches zero rows and the worker learns it was superseded.

    `status='running'` is part of the fence, not decoration: a job already reclaimed to
    `retryable` and re-dispatched must not be renewable by the run that lost it.
    """
    now = datetime.now(timezone.utc)
    renewed = await (client.table("jobs").update(
        {"lock_expires_at": (now + timedelta(seconds=JOB_LEASE_TTL_S)).isoformat()})
        .eq("id", job_id).eq("status", "running").eq("lease_token", lease_token).execute())
    return bool(renewed.data)


async def _heartbeat(client, job_id: str, lease_token: str, lost: asyncio.Event) -> None:
    """Renew this run's lease on an interval until it is lost, or the run cancels us.

    The trip pipeline has NO upper time bound — extraction runs an agent loop with no timeout
    over `web_search` calls — so a measured 76.8s cold run is a measurement, not a bound. One
    wedged upstream connection puts a live run past the TTL, and without this the reaper would
    reclaim a job that is still writing.
    """
    while not lost.is_set():
        await asyncio.sleep(JOB_LEASE_RENEW_S)
        try:
            if not await _renew_job_lease(client, job_id, lease_token):
                lost.set()          # someone else owns the job now
                return
        except Exception:
            # A renewal BLIP IS NOT A LOST LEASE — keep working. Losing the lease is an
            # authoritative statement about ownership and only a zero-row CAS makes it; a
            # transport error says nothing about who holds the token. Setting `lost` here
            # would let one flaky moment against PostgREST abort a healthy run. If blips
            # persist past the TTL the reaper reclaims us anyway, and the next renewal that
            # DOES reach Postgres returns zero rows → lost, the honest way.
            logger.warning("trip_lease_renew_failed job_id=%s", job_id)


async def reclaim_expired_jobs(*, client=None, now=None) -> list[dict]:
    """Reclaim runs whose LEASE HAS EXPIRED (running -> retryable), then return reclaimable
    jobs. ONE atomic UPDATE, no select-then-CAS loop: the expiry and the status live in the
    update's own predicate, so a concurrent heartbeat renewal makes the row stop matching and
    a concurrent completion is excluded by `status='running'`.

    The previous implementation SELECTed stale rows and then UPDATEd by id alone, which had
    two live bugs. A worker that finished between the two statements had its `succeeded`
    RESURRECTED as `retryable` — a completed trip re-running at full provider cost — and a
    freshly claimed `running` row was erased. `mark_job_running`'s CAS cannot fix either: it
    only guards the pending->running transition, and both of these races happen after it.
    Restart-with-cache-reuse, NOT resume (#12).
    """
    client = client or await get_supabase_client()
    now = now or datetime.now(timezone.utc)
    # LEGACY-NULL BRANCH IS LOAD-BEARING — do not simplify to `.lt("lock_expires_at", ...)`.
    # The old `mark_job_running` never wrote `lock_expires_at`, so every row claimed by the
    # OLD container during this deploy's overlap has NULL there — and `NULL < now()` is NULL,
    # not true. An expiry-only predicate skips those rows FOREVER, which is exactly the silent
    # drop guardrail #12 forbids, reintroduced at this task's own rollout boundary. The
    # `is null` conjunct keeps it gated: a long run whose heartbeat holds a future expiry has
    # a stale `locked_at` too, and must NOT be reclaimed on age alone.
    legacy_cutoff = _pg_timestamp(now - timedelta(seconds=JOB_LEASE_TTL_S))
    # Clear the lease fields — do NOT leave the stale token in place. `mark_job_done` fences
    # on the token with NO status guard, so a row that kept its token would let an
    # expired-but-still-alive old worker firing between this reclaim and the redispatch's
    # claim flip `retryable` -> `failed` and cancel the retry just scheduled.
    #
    # Scope, stated honestly: the runner's own terminal path goes through `complete_trip_run`,
    # whose predicate ALSO requires `status = 'running'`, so that path is already excluded on
    # a reclaimed row; likewise `_renew_job_lease`. Nulling therefore protects the
    # `mark_job_done` primitive specifically, and is defense in depth for the rest.
    reclaimed = (await client.table("jobs").update({
        "status": "retryable", "lease_token": None,
        "lock_expires_at": None, "locked_at": None,
    }).eq("status", "running").or_(
        f"lock_expires_at.lt.{_pg_timestamp(now)},"
        f"and(lock_expires_at.is.null,locked_at.lt.{legacy_cutoff})"
    ).execute()).data or []
    if reclaimed:
        logger.info("trip_leases_reclaimed count=%d", len(reclaimed))
    return (await client.table("jobs").select("id,trip_id,user_id")
            .in_("status", ["pending", "retryable"]).execute()).data or []
