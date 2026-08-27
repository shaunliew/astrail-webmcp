"""Durable Saved Reel organize job: claim, lease, per-item work, events and recovery.

Grounding a place against Mapbox and persisting the canonical `places` row live in
`grounding.py` — this module owns the job lifecycle around them (B6 split).
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from genagents.place_extractor import EXTRACTOR_VERSION
from grounding import LOCATION_VERIFICATION_VERSION, _ground_place, _persist_place
from models.place import PlaceResult
from postgrest.exceptions import APIError
from pipeline.cache import cache_places, get_cached_places
from scrape.apify_direct import scrape_reel
from usage import refund_organize_item_analysis, reserve_organize_item_analysis

ORGANIZE_LEASE_TTL_S = 300      # short on purpose: the heartbeat renews a live run, so a
                                # real crash is reclaimed in ~5 min rather than ~15.
ORGANIZE_LEASE_RENEW_S = 60     # comfortably under the TTL: several renewals may blip and be
                                # retried before the lease is genuinely at risk of expiring.
ORGANIZE_FAILURE_MESSAGE = "Organization failed"
ORGANIZE_SUCCESS_MESSAGE = "Organized"
ORGANIZE_NO_LOCATIONS_MESSAGE = "No locations found"     # succeeded, but zero places found
logger = logging.getLogger(__name__)


class ActiveOrganizeConflict(RuntimeError):
    """The selected Saved Reel is already part of another active job."""


class InvalidOrganizeRequest(ValueError):
    """The RPC rejected the request itself (empty, oversized, null or duplicated ids)."""


class LeaseLost(RuntimeError):
    """Another worker holds this job's lease; this run must stop writing immediately."""


# SQLSTATE -> outcome, per 20260720130000_organize_job_error_codes.sql. Codes, never message
# text: the prose in that migration is presentation, and an editor who reworded it used to
# turn a 409 into a 500 with nothing able to catch it. P0001 is deliberately absent — after
# this mapping it means "some other validation the RPC rejects", which must surface as a 500
# rather than be absorbed into one of these three.
_ORGANIZE_JOB_ERRORS: dict[str, type[Exception]] = {
    "AS409": ActiveOrganizeConflict,
    "AS404": PermissionError,
    "AS422": InvalidOrganizeRequest,
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _request_key(user_id: str, saved_reel_ids: list[str]) -> str:
    material = json.dumps([user_id, sorted(set(saved_reel_ids))], separators=(",", ":"))
    return hashlib.sha256(material.encode()).hexdigest()


async def _find_cache_id(client, normalized_url: str) -> str | None:
    result = await (client.table("reel_cache").select("id")
                    .eq("normalized_url", normalized_url)
                    .eq("extractor_version", EXTRACTOR_VERSION)
                    .maybe_single().execute())
    return ((result.data if result is not None else None) or {}).get("id")


async def create_organize_job(client, user_id: str, saved_reel_ids: list[str]) -> str:
    """Create one complete organize job through the atomic service-role RPC."""
    ids = list(saved_reel_ids)
    key = _request_key(user_id, ids)
    try:
        result = await client.rpc(
            "create_saved_reels_organize_job",
            {
                "p_user_id": user_id,
                "p_saved_reel_ids": ids,
                "p_idempotency_key": key,
            },
        ).execute()
    except APIError as exc:
        error = _ORGANIZE_JOB_ERRORS.get(exc.code)
        if error is None:
            raise
        raise error(getattr(exc, "message", str(exc))) from exc
    return result.data


# LOAD-BEARING INVARIANT (ISSUES-B5): event sequences are allocated INSIDE
# append_organize_event, which takes `select ... for update` on the parent organize_jobs
# row. That row lock — not any assumption of a single live writer — is what makes
# MAX(sequence)+1 collision-free, and the p_lease_token fence is what stops a superseded
# worker writing at all. A second event producer is therefore SAFE to add, provided it
# goes through this RPC with a valid lease. Allocating a sequence anywhere else reopens
# organize_events_job_sequence_unique. There is no unfenced form to reach for instead:
# p_lease_token=None is rejected outright with AS400, by design and with no boot-path
# exception (20260720090000_job_leases.sql:59-69 records why that escape hatch was removed).
#
# ISSUES.md's original B5 said this was safe because a CAS made exactly one writer exist.
# That was FALSE when written — a superseded worker could still write — and the fix was not
# to document the weaker claim but to remove the dependency on it. Pinned by
# `supabase/tests/010_organize_event_sequencing.sql` (the row lock and the unique backstop,
# against real Postgres) and `backend/test_organizer_lease.py` "--- ISSUES-B5 ---" (the
# control flow: a worker that lost the claim emits nothing).
async def _record_organize_event(
    client, job_id: str, user_id: str, event_type: str, message: str, payload=None,
    *, lease_token: str,
) -> None:
    """Append one organize event through the fenced, sequence-assigning RPC.

    The RPC replaces a select-MAX-then-insert that was neither atomic (two writers could
    compute the same sequence and violate `organize_events_job_sequence_unique`) nor fenced
    (a superseded worker's terminal `result` row ends the user's SSE session on an outcome
    that never happened — `stream_organize_events` returns on the FIRST result by sequence,
    and the seen-set dedupes by row id, so a second writer's row is not deduped).

    `lease_token` is REQUIRED, mirroring the RPC: `append_organize_event` raises AS400 on a
    null token because there is no unfenced form and no caller that legitimately lacks one —
    every event writer runs after the claim has returned. A defaulted `None` would turn that
    design into a runtime surprise at whichever call site forgot it.

    AS409 means a replacement owns the job. That is NOT an error to propagate: both terminal
    paths append an event, so raising here would convert "we were superseded" — the expected
    outcome of a deploy overlap — into a crash inside cleanup, on a job another worker is
    already finishing correctly. Log it and return; the replacement writes the real events.
    """
    try:
        await client.rpc("append_organize_event", {
            "p_job_id": job_id, "p_user_id": user_id, "p_lease_token": lease_token,
            "p_event_type": event_type, "p_message": message, "p_payload": payload or {},
        }).execute()
    except APIError as exc:
        if exc.code != "AS409":
            raise
        logger.warning("organize_event_lease_superseded job_id=%s event_type=%s", job_id, event_type)


async def authorize_place_ids(client, user_id: str, place_ids: list[str]) -> list[dict]:
    """Return places only when each has safe evidence through this user's organized Reel.

    `user_id` on the mention is the PRIMARY trust boundary — the table is service-role-only,
    so RLS cannot scope it, and before A3 it carried no owner at all: any user who had merely
    organized the same Reel could build a trip from another user's evidence. The
    `saved_reels` organized-check below stays as defense in depth, not as the boundary.
    """
    mentions = (await client.table("reel_place_mentions").select(
        "place_id,reel_cache_id,evidence_quote,source_url,confidence,verification_version"
    ).eq("user_id", user_id).in_("place_id", place_ids).execute()).data or []
    mentions = [
        row for row in mentions
        if row.get("verification_version") == LOCATION_VERIFICATION_VERSION
    ]
    cache_ids = {row["reel_cache_id"] for row in mentions}
    # `normalized_url` rides along on a query that already runs for the ownership check, so the
    # originating Reel costs no extra round-trip. Without it, organized places land with a
    # research URL under a `reel_quote` label — the same defect as the direct-reel branch.
    owned = (await client.table("saved_reels").select("reel_cache_id,normalized_url").eq("user_id", user_id)
             .eq("analysis_status", "organized").in_("reel_cache_id", list(cache_ids)).execute()).data or []
    owned_cache_ids = {row["reel_cache_id"] for row in owned}
    reel_url_by_cache_id = {row["reel_cache_id"]: row.get("normalized_url") for row in owned}
    allowed_mentions = [row for row in mentions if row["reel_cache_id"] in owned_cache_ids]
    allowed_ids = {row["place_id"] for row in allowed_mentions}
    if allowed_ids != set(place_ids):
        raise PermissionError("Canonical place not available from an organized Saved Reel")
    places = (await client.table("places").select("*").in_("id", list(allowed_ids)).execute()).data or []
    by_id = {row["id"]: row for row in places}
    if set(by_id) != allowed_ids:
        raise PermissionError("Canonical place not found")
    evidence = {row["place_id"]: row for row in allowed_mentions}
    return [
        {
            **by_id[place_id],
            **{k: evidence[place_id].get(k) for k in ("evidence_quote", "source_url", "confidence")},
            "source_reel_url": reel_url_by_cache_id.get(evidence[place_id].get("reel_cache_id")),
        }
        for place_id in place_ids
    ]


async def get_organize_status(client, job_id: str, user_id: str) -> dict:
    job_result = await (client.table("organize_jobs").select("*").eq("id", job_id)
                        .eq("user_id", user_id).maybe_single().execute())
    if job_result is None or job_result.data is None:
        raise PermissionError("Organize job not found")
    job = job_result.data
    items = await (client.table("organize_job_items").select(
        "saved_reel_id,status,place_count,error_message"
    ).eq("job_id", job_id).eq("user_id", user_id).execute())
    return {
        "job_id": job_id,
        "status": job.get("status", "pending"),
        "status_message": job.get("status_message", "Queued"),
        "total_items": job.get("total_count", len(items.data or [])),
        "processed_items": job.get("processed_count", 0),
        "organized_items": job.get("organized_count", 0),
        "location_not_found_items": job.get("location_not_found_count", 0),
        "failed_items": job.get("failed_count", 0),
        "items": items.data or [],
    }


async def _update_job_counts(client, job_id: str, user_id: str, *, lease_token: str) -> None:
    """Recompute the aggregate counts, FENCED on our lease.

    An earlier draft left this unfenced on the reasoning that it "recomputes from live status,
    so a stale write is self-correcting". That holds at SELECT time and NOT against two workers
    reordering: this is a blind SELECT-then-UPDATE with no version guard, so a superseded
    worker's earlier-issued write can land AFTER the live worker's.

    That is not a cosmetic counter. `get_organize_status` reads these aggregate COLUMNS rather
    than re-deriving from `organize_job_items`, and `run_organize_job` computes `final_status`
    from that read — so a stale counts write landing in the window between the live worker's
    own counts write and its own status read makes the LIVE worker persist `failed` on a job
    whose items all succeeded. Reproduced: A's stale write lands last -> organized_items=0,
    failed_items=1, while the item rows read [('i1','organized'), ('i2','organized')].

    Per-item writes stay deliberately unfenced — item status does not feed `final_status` and
    is independently re-derivable. The counts aggregate is the one "bounded" write that is
    decision-bearing, which is why it gets the fence and they do not.
    """
    rows = (await client.table("organize_job_items").select("status").eq("job_id", job_id)
            .eq("user_id", user_id).execute()).data or []
    counts = {
        "processed_count": sum(r.get("status") in {"organized", "location_not_found", "failed"} for r in rows),
        "organized_count": sum(r.get("status") == "organized" for r in rows),
        "location_not_found_count": sum(r.get("status") == "location_not_found" for r in rows),
        "failed_count": sum(r.get("status") == "failed" for r in rows),
    }
    await (client.table("organize_jobs").update(counts)
           .eq("id", job_id).eq("user_id", user_id)
           .eq("lease_token", lease_token).execute())


async def _consume_organize_item_analysis(client, item_id: str, user_id: str) -> None:
    await (client.table("organize_job_items").update({
        "analysis_charge_state": "consumed",
        "analysis_consumed_at": _now(),
    }).eq("id", item_id).eq("user_id", user_id)
     .eq("analysis_charge_state", "reserved").execute())


async def _mark_organize_job_failed(client, job_id: str, user_id: str, *, lease_token: str) -> None:
    """Best-effort terminal cleanup for errors outside the per-item boundary.

    FENCED, and the fence is not cosmetic tidiness — it closes a cascade that was reproduced
    against the real organizer. Worker A is superseded and aborts with `LeaseLost`, which
    lands here. Unfenced, this write flips `status` to `failed` on a row worker B legitimately
    leases. B's own renewal CAS requires `status='processing'`, so B's next heartbeat matches
    zero rows, B reads that as ITS lease being lost, and B abandons a run it was entitled to
    finish — observed as `status='failed'` on a job whose second item was never even started.

    Note the shape of that bug: the renewal CAS's `status` predicate turns any unfenced write
    to `status` into an implicit "you lost your lease" aimed at the rightful owner. The
    heartbeat is also what makes it fire in practice, by giving a worker parked in a slow
    provider call a guaranteed exit one renewal interval after being superseded. So this fence
    is not optional relative to the heartbeat — the two must ship together.

    ALSO GATED ON `status='processing'`, which the lease token cannot cover. The final status
    read at the end of `run_organize_job` runs AFTER the success update and the terminal
    `result` event have both committed. A transient failure on that read reaches the same outer
    handler and lands here — with a token that is entirely valid, because this worker really
    does still hold the lease. That is precisely why a token-only fence passes: nothing about
    the lease is wrong. Without the status predicate the job flips from `succeeded` to
    `failed` after the user has already been told, via SSE, that it worked. Polling then
    contradicts the stream, which is worse than either answer alone.

    The event append is gated on the update having MATCHED A ROW, for the same reason the
    trip runner makes its job write and its terminal event one transaction: "no job write =>
    no event write". The RPC's own AS409 fence cannot substitute here — it rejects a stale
    token, and in this cascade the token is good, so an ungated append would add a second,
    contradictory `result` that `stream_organize_events` replays. When the update instead
    fails transiently, `landed` stays False and nothing is written: the row is left
    `processing` for the reaper to reclaim and re-dispatch, which is guardrail #12's
    re-queued-not-silently-dropped direction rather than a fabricated terminal state.
    """
    landed = False
    try:
        failed = await (client.table("organize_jobs").update({
            "status": "failed",
            "status_message": ORGANIZE_FAILURE_MESSAGE,
            "completed_at": _now(),
            "locked_at": None,
            "lock_expires_at": None,
        }).eq("id", job_id).eq("user_id", user_id).eq("lease_token", lease_token)
         .eq("status", "processing").execute())
        landed = bool(failed.data)
    except Exception:
        pass
    if not landed:
        return
    try:
        await _record_organize_event(
            client, job_id, user_id, "result", ORGANIZE_FAILURE_MESSAGE, {"status": "failed"},
            lease_token=lease_token,
        )
    except Exception:
        pass


_TERMINAL_ITEM_STATUSES = ("organized", "location_not_found", "failed")


async def _refund_dangling_reservations(client) -> None:
    """Release quota units held by reservations on items that already finished.

    An item reaches this state when `refund_organize_item_analysis` ITSELF fails inside
    `_process_item`'s except-handler: the item is written terminal `failed`, the reservation
    survives, and nothing else in the system ever revisits it. The user has been charged one
    analysis forever, and the next organize of that Reel charges again.

    BOTH predicates are load-bearing. `analysis_charge_state = 'reserved'` alone would refund
    items a live worker is mid-run on — a legitimate reservation it is about to consume — so
    the terminal-status filter is what makes this reconciliation rather than a quota giveaway.
    (`refund_organize_item_analysis` is itself a CAS on `reserved`, so a concurrent consume
    still cannot double-release; the filter is what stops us racing it in the first place.)

    ENTIRELY best-effort, including the SELECT. This runs inside `recover_organize_jobs`,
    whose real job is re-dispatching interrupted work (guardrail #12) — letting a janitorial
    quota sweep raise would trade a leaked quota unit for a dropped job, which is the worse
    bug by a wide margin. It re-runs on every reaper tick, so a blip costs at most one
    interval. Log the error TYPE only: these exceptions can carry connection strings.
    """
    try:
        dangling = (await client.table("organize_job_items").select("id,user_id")
                    .eq("analysis_charge_state", "reserved")
                    .in_("status", list(_TERMINAL_ITEM_STATUSES)).execute()).data or []
    except Exception as exc:
        logger.warning("organize_dangling_charge_scan_failed error=%s", type(exc).__name__)
        return
    for row in dangling:
        try:
            await refund_organize_item_analysis(client, row["id"], row["user_id"])
        except Exception as exc:
            logger.warning(
                "organize_dangling_charge_refund_failed item_id=%s error=%s",
                row["id"], type(exc).__name__,
            )
    if dangling:
        logger.info("organize_dangling_charges_swept count=%d", len(dangling))


async def recover_organize_jobs(client) -> list[dict]:
    """Reclaim organize jobs whose LEASE HAS EXPIRED, then return pending jobs to dispatch.

    ONE atomic UPDATE, no select-then-CAS loop. `lock_expires_at < clock_timestamp()` is the
    update's own predicate, so a heartbeat that renews the lease concurrently makes the row
    stop matching (READ COMMITTED re-checks the predicate against the updated row version) and
    the reclaim skips it. A select-then-update version CANNOT do this: it would compare a token
    it observed BEFORE the renewal, and since the heartbeat deliberately keeps the same token,
    the stale-but-matching token would let the reaper reset a live lease to pending.

    THE INSTANT IS THE DATABASE'S, and there is deliberately no `now` parameter — an injectable
    one is the defect this closes. Postgres always evaluated the comparison, but the value on
    the right came from whichever instance was sweeping, so a reaper whose host clock ran fast
    reclaimed leases that were still live, and a slow one left dead ones held past their TTL.
    Twin of `jobs.reclaim_expired_jobs`; the two stay separate only because `organizer` and
    `jobs` must not depend on each other.
    """
    # The RPC keeps the legacy-NULL branch that PostgREST expressed as `or=`. Rows claimed by a
    # container running the pre-lease code carry `lock_expires_at IS NULL`, and in SQL
    # `NULL < clock_timestamp()` is NULL, not true — so an expiry-only predicate would skip
    # them FOREVER, which is precisely the silent drop guardrail #12 forbids. It falls back to
    # `locked_at + TTL` for exactly those rows, still gated on the expiry being NULL so a long
    # run whose heartbeat holds a future expiry is not reclaimed on its stale `locked_at`.
    reclaimed = (await client.rpc("reclaim_expired_organize_jobs", {
        "p_ttl_seconds": ORGANIZE_LEASE_TTL_S, "p_status_message": "Requeued after restart",
    }).execute()).data or 0
    if reclaimed:
        logger.info("organize_leases_reclaimed count=%d", reclaimed)
    # After the reclaim, and on every reaper tick rather than only at boot: an item whose
    # refund failed has no other reader anywhere in the system.
    await _refund_dangling_reservations(client)
    return (await client.table("organize_jobs").select("id,user_id").eq("status", "pending")
            .order("created_at").execute()).data or []


async def _renew_organize_lease(client, job_id: str, user_id: str, lease_token: str) -> bool:
    """Extend our lease. `False` means we LOST it (reaped, then reclaimed by another worker).

    The CAS is the exact mirror of `recover_organize_jobs`, and the pair cannot both win.
    Whichever transaction commits first decides, in either order, with no third outcome: if
    this renewal commits first, `lock_expires_at` is back in the future and the reclaim's
    predicate no longer matches, so the live lease survives. If the reclaim commits first it
    nulls `lease_token`, so `.eq("lease_token", ...)` here matches zero rows and the worker
    learns it has been superseded.

    `status='processing'` is part of the fence, not decoration: a job already reclaimed to
    `pending` and re-dispatched must not be renewable by the run that lost it.

    The new expiry is `clock_timestamp() + TTL` inside the RPC, so a renewal from a host whose
    clock lags cannot write an expiry that is already in the past by the reaper's reckoning —
    a heartbeat renewing successfully every minute while the reaper reclaims the job anyway is
    the worst shape of that bug, because the worker holds positive evidence of an ownership it
    does not have.
    """
    renewed = await client.rpc("renew_organize_job_lease", {
        "p_job_id": job_id, "p_user_id": user_id, "p_lease_token": lease_token,
        "p_ttl_seconds": ORGANIZE_LEASE_TTL_S,
    }).execute()
    return bool(renewed.data)


async def _heartbeat(client, job_id: str, user_id: str, lease_token: str, lost: asyncio.Event) -> None:
    """Renew this run's lease on an interval until it is lost, or the run cancels us.

    FAILS SAFE past the TTL. A blip is tolerated; sustained unreachability is not. The earlier
    version swallowed every renewal error on the reasoning that "the next renewal that DOES
    reach Postgres returns zero rows → lost, the honest way" — which assumes a next renewal
    ever gets through. When it does not, `recover_organize_jobs` reclaims us on schedule, a
    replacement claims the job, and this worker keeps running with `lost` never set: it sails
    through the item loop's between-items gate and only the per-write token fences stand
    between it and the replacement's work. Once `deadline` has passed our lease has certainly
    expired, so continuing is indistinguishable from running without one.
    """
    # We hold the lease until here: the claim in `run_organize_job` set exactly this expiry
    # moments ago. `monotonic`, not wall-clock — a clock step must not fabricate or mask a loss.
    deadline = time.monotonic() + ORGANIZE_LEASE_TTL_S
    while not lost.is_set():
        await asyncio.sleep(ORGANIZE_LEASE_RENEW_S)
        try:
            renewed = await _renew_organize_lease(client, job_id, user_id, lease_token)
        except Exception:
            # A renewal BLIP IS NOT A LOST LEASE — keep working. Losing the lease is an
            # authoritative statement about ownership, and only a zero-row CAS makes it; a
            # transport error says nothing about who holds the token. Aborting here would let
            # one flaky moment against PostgREST kill a healthy run, which is why the TTL —
            # not the first error — is the threshold.
            if time.monotonic() < deadline:
                logger.warning("organize_lease_renew_failed job_id=%s", job_id)
                continue
            # Past the TTL with no renewal through: the reaper has had its window, so assume
            # we no longer own the job rather than assuming we still do.
            logger.warning("organize_lease_unrenewable_past_ttl job_id=%s", job_id)
            lost.set()
            return
        if not renewed:
            lost.set()              # someone else owns the job now
            return
        deadline = time.monotonic() + ORGANIZE_LEASE_TTL_S


@dataclass(frozen=True)
class _ItemContext:
    """Per-job context threaded through the item loop.

    Frozen — the loop must never mutate what it was handed.

    Its purpose is forward-looking, not cosmetic. A2 threads a per-attempt fencing token
    through every per-item write, and A3 needs `user_id` inside `_ground_and_persist` to
    scope the mention rewrite (today that delete is unscoped — the cross-user destruction
    defect). Both arrive as ONE new field here instead of an eighth, then ninth, positional
    parameter at every call site. Bundling before that work lands is the whole point.
    """

    client: Any
    job_id: str
    user_id: str
    scrape: Callable[[str], Any]
    extract: Callable[[Any], Any]
    ground: Callable[[PlaceResult], Any]
    lease_token: str


async def _ground_and_persist(
    ctx: _ItemContext, reel: dict, cache_id: str | None, places: list[PlaceResult], *,
    set_phase=None,
) -> tuple[str, int]:
    """Verify researched places and rewrite this Reel's canonical mentions.

    Returns `(terminal, place_count)` where terminal is "organized" or
    "location_not_found". `reel` identifies the Saved Reel the mentions belong to.

    The rewrite is the LAST write and replaces exactly `ctx.user_id`'s set for the Reel, in
    one transaction. Nothing here deletes: a failed grounding returns without touching the
    table at all, and another owner's evidence is unreachable by construction.

    `set_phase` reports which phase we are in so the caller's error log stays accurate.
    This spans TWO phases, not one: the grounding call is "mapbox", but the persist loop and
    the rewrite below it are "database". Tagging the whole unit "mapbox" (as the first
    extraction did) sends an on-call engineer to check Mapbox health for what is actually a
    Supabase write failure.
    """
    set_phase = set_phase or (lambda _phase: None)
    set_phase("mapbox")
    grounded = [
        resolved
        for place in places
        if (resolved := await ctx.ground(place)) is not None
    ]
    set_phase("database")
    if not grounded or not cache_id:
        # NEVER touch mentions on an empty grounding. The pre-A3 code deleted by
        # `reel_cache_id` BEFORE this check, so a Mapbox brownout destroyed every user's
        # verified evidence for the Reel and `authorize_place_ids` then rejected places
        # they legitimately used — a partial failure turned into a data-loss event
        # (guardrails #1 and #3).
        return "location_not_found", 0
    mentions = []
    for resolved in grounded:
        place_id = await _persist_place(ctx.client, resolved)
        place = resolved["place"]
        mentions.append({"place_id": place_id, "evidence_quote": place.evidence_quote,
                         "source_url": place.source_url, "confidence": place.confidence})
    # Duplicate place_ids are left in the payload ON PURPOSE — the RPC's DISTINCT ON is the
    # single place that handles them, so there is no second dedupe to drift out of sync.
    # ONE transaction: upsert this owner's set and prune only this owner's superseded rows.
    # A crash before this line leaves the previous verified set fully intact; a crash during
    # it rolls back. Other users' evidence is out of reach by construction (user_id is in
    # the PK and in the RPC's delete predicate).
    await ctx.client.rpc("replace_reel_place_mentions", {
        "p_user_id": ctx.user_id, "p_reel_cache_id": cache_id,
        "p_verification_version": LOCATION_VERIFICATION_VERSION, "p_mentions": mentions,
    }).execute()
    return "organized", len(grounded)


async def _process_item(ctx: _ItemContext, item: dict) -> bool:
    """Organize one Saved Reel. Failures stay inside this item (guardrail #3).

    Returns True if the item was processed, False if it was SKIPPED because its
    `saved_reels` row is gone. The caller must not run `_update_job_counts` for a
    skipped item: pre-refactor this path was a bare `continue`, which skipped both the
    item and the trailing counts call. Calling counts here changes no committed value
    (it recomputes from live status columns), but it lets a transient DB error on an
    ORPHANED item propagate to the job-level handler and fail the WHOLE job — a
    scenario that previously never reached that line.
    """
    phase = "database"

    def _set_phase(new_phase: str) -> None:
        nonlocal phase
        phase = new_phase

    reel_result = await (ctx.client.table("saved_reels").select(
        "id,normalized_url,reel_cache_id"
    ).eq("id", item["saved_reel_id"]).eq("user_id", ctx.user_id).maybe_single().execute())
    reel = reel_result.data if reel_result is not None else None
    if reel is None:
        return False
    await ctx.client.table("organize_job_items").update({"status": "processing"}).eq("id", item["id"]).eq("user_id", ctx.user_id).execute()
    cache_id = reel.get("reel_cache_id")
    if cache_id is None:
        phase = "database"
        cache_id = await _find_cache_id(ctx.client, reel["normalized_url"])
    try:
        phase = "database"
        try:
            places = await get_cached_places(ctx.client, reel["normalized_url"], EXTRACTOR_VERSION)
        except Exception as exc:
            # LOG IT. Without this the handler is indistinguishable from a real programming
            # error: a None client (AttributeError) or a renamed column (APIError) degrades
            # PERMANENTLY into "always MISS, always re-scrape", and the only symptom is a
            # quiet rise in Apify/OpenAI spend. A transient blip logs once; a broken cache
            # read logs on every item of every job, which is the signal worth having.
            logger.warning(
                "organize_cache_read_blip item_id=%s error=%s", item["id"], type(exc).__name__
            )
            # A cache-READ blip is a MISS, never an item failure — the trip runner's exact
            # behavior (`pipeline/runner.py:208-211`). ACCEPTED TRADE-OFF: on a reel we had
            # cached, this triggers a fresh, quota-charged scrape. That is strictly cheaper
            # than failing an item the user must retry, and consistency with the runner
            # matters more than saving one scrape on a transient error. The WRITE side stays
            # strict (`cache_places`, `_store_cached_country`) — a cache is an optimization
            # on the way in and a durability guarantee on the way out.
            places = None
        if places is None:
            quota_state = item.get("analysis_charge_state", "not_charged")
            if quota_state in {"not_charged", "refunded"}:
                phase = "quota"
                if await reserve_organize_item_analysis(ctx.client, item["id"], ctx.user_id) is None:
                    raise RuntimeError("analysis quota reached")
                quota_state = "reserved"
            try:
                phase = "apify"
                scraped = await ctx.scrape(reel["normalized_url"])
                phase = "extractor"
                places = await ctx.extract(scraped)
                # The cache stores research provenance before provider verification. A
                # Mapbox retry can therefore reuse research without paying for Apify again.
                phase = "database"
                await cache_places(
                    ctx.client,
                    reel["normalized_url"],
                    scraped,
                    places,
                    EXTRACTOR_VERSION,
                )
                if quota_state == "reserved":
                    phase = "quota"
                    await _consume_organize_item_analysis(ctx.client, item["id"], ctx.user_id)
                    quota_state = "consumed"
            except Exception:
                if quota_state == "reserved":
                    # `phase` must name what the ESCAPING exception broke, and which one
                    # escapes depends on the refund. Overwriting it unconditionally (what
                    # this replaced) logged `phase=quota` for every apify/extractor/
                    # database failure — and since cache MISS is the common path, that was
                    # MOST real failures, sending on-call to the quota system for an Apify
                    # outage. Deleting the overwrite installs the mirror bug: a refund that
                    # throws replaces the original exception, and a genuine quota-system
                    # outage would then log `phase=apify`. So: claim "quota" for the
                    # duration of the refund, and hand the phase back only once the refund
                    # has RETURNED — if it raises, its own exception propagates and the
                    # phase it leaves behind is already the correct one.
                    failed_phase, phase = phase, "quota"
                    await refund_organize_item_analysis(ctx.client, item["id"], ctx.user_id)
                    phase = failed_phase
                raise
        else:
            if item.get("analysis_charge_state") == "reserved":
                phase = "quota"
                await _consume_organize_item_analysis(ctx.client, item["id"], ctx.user_id)
        phase = "database"
        if cache_id is None:
            cache_id = await _find_cache_id(ctx.client, reel["normalized_url"])
        terminal, place_count = await _ground_and_persist(
            ctx, reel, cache_id, places, set_phase=_set_phase
        )
        phase = "database"
        await ctx.client.table("organize_job_items").update({
            "status": terminal, "place_count": place_count, "error_message": None, "completed_at": _now()
        }).eq("id", item["id"]).eq("user_id", ctx.user_id).execute()
        await ctx.client.table("saved_reels").update({
            "reel_cache_id": cache_id, "analysis_status": terminal,
            "analyzed_at": _now(), "retry_after": None,
        }).eq("id", reel["id"]).eq("user_id", ctx.user_id).execute()
        await _record_organize_event(ctx.client, ctx.job_id, ctx.user_id, "stage", "Reel organized", {"saved_reel_id": reel["id"], "place_count": place_count}, lease_token=ctx.lease_token)
    except Exception:
        logger.error(
            "saved_reel_organize_item_failed phase=%s job_id=%s item_id=%s",
            phase, ctx.job_id, item["id"],
        )
        await ctx.client.table("organize_job_items").update({
            "status": "failed", "error_message": "Reel organization failed", "completed_at": _now()
        }).eq("id", item["id"]).eq("user_id", ctx.user_id).execute()
        await ctx.client.table("saved_reels").update({
            "analysis_status": "failed", "retry_after": None,
        }).eq("id", reel["id"]).eq("user_id", ctx.user_id).execute()
        await _record_organize_event(ctx.client, ctx.job_id, ctx.user_id, "error", "Reel organization failed", {"saved_reel_id": reel["id"]}, lease_token=ctx.lease_token)
    return True


async def run_organize_job(job_id: str, user_id: str, *, client=None, scrape=None, extract=None, ground=None) -> dict:
    """Claim and run one organize job. All external clients are injectable for offline tests."""
    if client is None:
        from supabase_client import get_supabase_client
        client = await get_supabase_client()
    current = await (client.table("organize_jobs").select("attempt_count")
                     .eq("id", job_id).eq("user_id", user_id).maybe_single().execute())
    # `or {}` is load-bearing, not defensive noise. maybe_single() returns a result whose
    # `.data` is None when NO row matches — a job deleted between recovery listing it and this
    # claim, or a job_id/user_id mismatch. Without it the next `.get()` raises AttributeError
    # instead of falling through to the CAS, which then returns empty and skips cleanly.
    current_row = (current.data if current is not None else None) or {}
    attempt_count = int(current_row.get("attempt_count", 0)) + 1
    # Minted PER ATTEMPT, never reused: this token is what every later write CASes on, so a
    # token shared across attempts would let a superseded worker pass the fence its own
    # replacement installed.
    lease_token = str(uuid.uuid4())
    # Through the RPC because every lease INSTANT is the database's: `locked_at` and
    # `lock_expires_at` are `clock_timestamp()`-derived, so a claim from a host whose clock
    # lags cannot mint a lease the reaper already considers expired. `started_at` keeps the
    # "only the FIRST attempt stamps it" rule as a `coalesce` in SQL — it is the run's
    # user-visible elapsed time, and re-stamping on every retry makes a job stuck in a retry
    # loop for an hour report as though it had just begun, hiding the loop it is in.
    claimed = await client.rpc("claim_organize_job", {
        "p_job_id": job_id, "p_user_id": user_id, "p_lease_token": lease_token,
        "p_ttl_seconds": ORGANIZE_LEASE_TTL_S, "p_status_message": "Finding places",
        "p_attempt_count": attempt_count,
    }).execute()
    if not claimed.data:
        # Two distinct outcomes, distinguishable by whether the pre-claim read found a row:
        # the job is GONE (deleted between recovery listing it and now) versus another worker
        # holds it. A-III adds logging on this path; "already claimed" for a deleted job would
        # send whoever reads that log looking for a competing worker that never existed.
        return {"skipped": "job already claimed" if current_row else "job not found"}
    try:
        await _record_organize_event(client, job_id, user_id, "stage", "Finding places", lease_token=lease_token)
        if scrape is None:
            async def scrape(url):
                token = os.environ.get("APIFY_TOKEN")
                if not token:
                    raise RuntimeError("Reel extraction is unavailable")
                return await scrape_reel(url, token=token)
        if extract is None:
            from genagents.place_extractor import extract_places
            extract = extract_places
        # The injectable seam keeps arity `ground(place)`; the default binds this job's client
        # so `_ground_place` can reach the coordinate→country cache.
        ground = ground or (lambda place: _ground_place(client, place))
        items = (await client.table("organize_job_items").select("*").eq("job_id", job_id)
                 .eq("user_id", user_id).in_("status", ["queued", "processing"]).execute()).data or []
        # Built ONCE per job: A2 adds the per-attempt lease token here, A3 reads user_id
        # from it inside _ground_and_persist — neither needs a new call-site parameter.
        ctx = _ItemContext(
            client=client, job_id=job_id, user_id=user_id,
            scrape=scrape, extract=extract, ground=ground, lease_token=lease_token,
        )
        lease_lost = asyncio.Event()
        beat = asyncio.create_task(_heartbeat(client, job_id, user_id, lease_token, lease_lost))
        try:
            for item in items:
                # Between items, not mid-item: a superseded worker parked inside one provider
                # call can still land THAT item's terminal write. The blast radius is one
                # item's status on a job being re-run from Phase 1 anyway; fencing every item
                # write behind an RPC is deliberately deferred.
                if lease_lost.is_set():
                    raise LeaseLost(f"organize job {job_id} lease superseded")
                processed = await _process_item(ctx, item)
                if processed:   # a skipped orphan must not reach counts — pre-refactor this was `continue`
                    await _update_job_counts(client, job_id, user_id, lease_token=lease_token)
        finally:
            lease_lost.set()
            beat.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await beat
        status = await get_organize_status(client, job_id, user_id)
        final_status = "failed" if status["failed_items"] and not status["organized_items"] and not status["location_not_found_items"] else "succeeded"
        # The MESSAGE carries a third case the two-valued `final_status` cannot. A run of
        # 4 failed + 1 location_not_found is `succeeded` — one item reached a terminal answer,
        # so the job completed rather than crashed — but it produced no place, and calling
        # that "Organized" is a lie the user reads twice (the polling status row and the
        # terminal SSE event both carry this string). `final_status` itself is untouched: it
        # is the frontend contract, and message content is non-breaking.
        if final_status == "failed":
            status_message = ORGANIZE_FAILURE_MESSAGE
        elif not status["organized_items"]:
            status_message = ORGANIZE_NO_LOCATIONS_MESSAGE
        else:
            status_message = ORGANIZE_SUCCESS_MESSAGE
        # FENCED. The loop's `lease_lost` gate sits BEFORE each item, so a superseded worker
        # parked in its LAST item never reaches a gate — the loop just ends and it arrives
        # here. Without the token predicate it would stamp its own terminal state over the
        # replacement's, which is the one organize write a user reads directly (the polling
        # status endpoint reads this row, not the event log).
        await client.table("organize_jobs").update({
            "status": final_status,
            "status_message": status_message,
            "completed_at": _now(), "locked_at": None, "lock_expires_at": None,
        }).eq("id", job_id).eq("user_id", user_id).eq("lease_token", lease_token).execute()
        await _record_organize_event(client, job_id, user_id, "result", status_message, {"status": final_status}, lease_token=lease_token)
        return await get_organize_status(client, job_id, user_id)
    except Exception:
        await _mark_organize_job_failed(client, job_id, user_id, lease_token=lease_token)
        try:
            return await get_organize_status(client, job_id, user_id)
        except Exception:
            return {"job_id": job_id, "status": "failed", "status_message": ORGANIZE_FAILURE_MESSAGE}
