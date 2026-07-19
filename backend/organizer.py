"""Durable Saved Reel organizer: cache, extraction, grounding, and safe persistence."""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from genagents.place_extractor import EXTRACTOR_VERSION, is_placeholder_url
from models.place import PlaceResult
from postgrest.exceptions import APIError
from pipeline.cache import cache_places, get_cached_places
from pipeline.dedup import DEFAULT_DISTANCE_M
from pipeline.geo import haversine_m
from scrape.apify_direct import scrape_reel
from usage import refund_organize_item_analysis, reserve_organize_item_analysis

LOCATION_VERIFICATION_VERSION = "mapbox-country-v1"
INITIALIZING_STALE_AFTER_S = 120
ORGANIZE_LEASE_TTL_S = 300      # short on purpose: the heartbeat renews a live run, so a
                                # real crash is reclaimed in ~5 min rather than ~15.
ORGANIZE_FAILURE_MESSAGE = "Organization failed"
logger = logging.getLogger(__name__)


class ActiveOrganizeConflict(RuntimeError):
    """The selected Saved Reel is already part of another active job."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _request_key(user_id: str, saved_reel_ids: list[str]) -> str:
    material = json.dumps([user_id, sorted(set(saved_reel_ids))], separators=(",", ":"))
    return hashlib.sha256(material.encode()).hexdigest()


async def _maybe_await(value):
    return await value if inspect.isawaitable(value) else value


def _initializing_job_is_stale(job: dict) -> bool:
    if job.get("status") != "initializing" or not job.get("created_at"):
        return False
    try:
        created_at = datetime.fromisoformat(str(job["created_at"]).replace("Z", "+00:00"))
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    return created_at <= datetime.now(timezone.utc) - timedelta(seconds=INITIALIZING_STALE_AFTER_S)


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
        message = getattr(exc, "message", str(exc))
        if exc.code == "P0001" and message == "Saved Reel is already being organized":
            raise ActiveOrganizeConflict(message) from exc
        if exc.code == "P0001" and message == "Saved Reel not found":
            raise PermissionError(message) from exc
        raise
    return result.data


async def _record_organize_event(client, job_id: str, user_id: str, event_type: str, message: str, payload=None) -> None:
    existing = await (client.table("organize_events").select("sequence")
                      .eq("job_id", job_id).eq("user_id", user_id).execute())
    sequence = max((row.get("sequence", 0) for row in (existing.data or [])), default=0) + 1
    await client.table("organize_events").insert({
        "job_id": job_id, "user_id": user_id, "sequence": sequence, "event_type": event_type,
        "message": message, "payload": payload or {},
    }).execute()


async def authorize_place_ids(client, user_id: str, place_ids: list[str]) -> list[dict]:
    """Return places only when each has safe evidence through this user's organized Reel."""
    mentions = (await client.table("reel_place_mentions").select(
        "place_id,reel_cache_id,evidence_quote,source_url,confidence,verification_version"
    ).in_("place_id", place_ids).execute()).data or []
    mentions = [
        row for row in mentions
        if row.get("verification_version") == LOCATION_VERIFICATION_VERSION
    ]
    cache_ids = {row["reel_cache_id"] for row in mentions}
    owned = (await client.table("saved_reels").select("reel_cache_id").eq("user_id", user_id)
             .eq("analysis_status", "organized").in_("reel_cache_id", list(cache_ids)).execute()).data or []
    owned_cache_ids = {row["reel_cache_id"] for row in owned}
    allowed_mentions = [row for row in mentions if row["reel_cache_id"] in owned_cache_ids]
    allowed_ids = {row["place_id"] for row in allowed_mentions}
    if allowed_ids != set(place_ids):
        raise PermissionError("Canonical place not available from an organized Saved Reel")
    places = (await client.table("places").select("*").in_("id", list(allowed_ids)).execute()).data or []
    by_id = {row["id"]: row for row in places}
    if set(by_id) != allowed_ids:
        raise PermissionError("Canonical place not found")
    evidence = {row["place_id"]: row for row in allowed_mentions}
    return [{**by_id[place_id], **{k: evidence[place_id].get(k) for k in ("evidence_quote", "source_url", "confidence")}}
            for place_id in place_ids]


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


async def _ground_place(place: PlaceResult, *, verify_country=None) -> dict | None:
    token = os.environ.get("MAPBOX_SECRET_TOKEN")
    if not token:
        raise RuntimeError("Mapbox reverse-country verification is unavailable")
    if (
        place.lat is None
        or place.lng is None
        or is_placeholder_url(place.source_url)
        or not place.country_code
        or not place.country_name
    ):
        return None
    if verify_country is None:
        from geocode.mapbox_reverse import reverse_country
        verify_country = reverse_country
    country = await verify_country(place.lat, place.lng, token=token)
    if country is None or country.country_code != place.country_code:
        return None
    verified_place = place.model_copy(update={"country_name": country.country_name})
    return {
        "place": verified_place,
        "country_code": country.country_code,
        "country_name": country.country_name,
    }


async def _persist_place(client, grounded: dict) -> str:
    place: PlaceResult = grounded["place"]
    place_type = (place.category or "").lower().strip()
    if place_type == "transport":
        place_type = "station"
    if place_type not in {"attraction", "restaurant", "hotel", "area", "city", "country", "station", "shop", "other"}:
        place_type = "other"
    existing = await (client.table("places").select("id,lat,lng").eq("name", place.name)
                      .eq("country_code", grounded["country_code"]).execute())
    for row in existing.data or []:
        if (
            place.lat is not None
            and place.lng is not None
            and row.get("lat") is not None
            and row.get("lng") is not None
            and haversine_m(place.lat, place.lng, row["lat"], row["lng"])
            < DEFAULT_DISTANCE_M
        ):
            await client.table("places").update({
                "country": grounded["country_name"],
                "country_code": grounded["country_code"],
                "country_name": grounded["country_name"],
            }).eq("id", row["id"]).execute()
            return row["id"]
    row = (await client.table("places").insert({
        "name": place.name,
        "place_type": place_type,
        "lat": place.lat,
        "lng": place.lng,
        "country": grounded["country_name"],
        "country_code": grounded["country_code"],
        "country_name": grounded["country_name"],
        "city": place.city_or_region_guess,
    }).execute()).data[0]
    return row["id"]


async def _persist_mention(client, cache_id: str, place_id: str, place: PlaceResult) -> None:
    row = {
        "reel_cache_id": cache_id,
        "place_id": place_id,
        "evidence_quote": place.evidence_quote,
        "source_url": place.source_url,
        "confidence": place.confidence,
        "verification_version": LOCATION_VERIFICATION_VERSION,
    }
    table = client.table("reel_place_mentions")
    if hasattr(table, "upsert"):
        await table.upsert(row, on_conflict="reel_cache_id,place_id").execute()
    else:
        await table.insert(row).execute()


async def _update_job_counts(client, job_id: str, user_id: str) -> None:
    rows = (await client.table("organize_job_items").select("status").eq("job_id", job_id)
            .eq("user_id", user_id).execute()).data or []
    counts = {
        "processed_count": sum(r.get("status") in {"organized", "location_not_found", "failed"} for r in rows),
        "organized_count": sum(r.get("status") == "organized" for r in rows),
        "location_not_found_count": sum(r.get("status") == "location_not_found" for r in rows),
        "failed_count": sum(r.get("status") == "failed" for r in rows),
    }
    await client.table("organize_jobs").update(counts).eq("id", job_id).eq("user_id", user_id).execute()


async def _consume_organize_item_analysis(client, item_id: str, user_id: str) -> None:
    await (client.table("organize_job_items").update({
        "analysis_charge_state": "consumed",
        "analysis_consumed_at": _now(),
    }).eq("id", item_id).eq("user_id", user_id)
     .eq("analysis_charge_state", "reserved").execute())


async def _mark_organize_job_failed(client, job_id: str, user_id: str) -> None:
    """Best-effort terminal cleanup for errors outside the per-item boundary."""
    try:
        await (client.table("organize_jobs").update({
            "status": "failed",
            "status_message": ORGANIZE_FAILURE_MESSAGE,
            "completed_at": _now(),
            "locked_at": None,
            "lock_expires_at": None,
        }).eq("id", job_id).eq("user_id", user_id).execute())
    except Exception:
        pass
    try:
        await _record_organize_event(
            client, job_id, user_id, "result", ORGANIZE_FAILURE_MESSAGE, {"status": "failed"}
        )
    except Exception:
        pass


def _pg_timestamp(value: datetime) -> str:
    """`Z`-suffixed ISO-8601 for use inside a PostgREST filter string.

    `datetime.isoformat()` emits `+00:00`; a raw `+` inside an `or=` filter can be decoded as
    a space, which either 400s or silently matches nothing. Offline tests cannot catch that —
    the fake accepts any string — so the encoding has to be right by construction.

    The tz assertion is what makes "by construction" actually true. The `.replace()` only fires
    on a UTC-aware value; hand this a naive or non-UTC-offset datetime and it becomes a silent
    no-op, reintroducing the exact raw-`+` bug this function exists to prevent. Today's only
    callers pass `datetime.now(timezone.utc)`, but A-III's reaper injects its own `now` — fail
    loudly there rather than shipping a mis-encoded filter that offline tests cannot see.
    """
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"_pg_timestamp requires a UTC-aware datetime, got {value!r}")
    return value.isoformat().replace("+00:00", "Z")


async def recover_organize_jobs(client, *, now=None) -> list[dict]:
    """Reclaim organize jobs whose LEASE HAS EXPIRED, then return pending jobs to dispatch.

    ONE atomic UPDATE, no select-then-CAS loop. `lock_expires_at < now` is evaluated by
    Postgres as part of the update's own predicate, so a heartbeat that renews the lease
    concurrently makes the row stop matching (READ COMMITTED re-checks the predicate against
    the updated row version) and the reclaim skips it. A select-then-update version CANNOT do
    this: it would compare a token it observed BEFORE the renewal, and since the heartbeat
    deliberately keeps the same token, the stale-but-matching token would let the reaper reset
    a live lease to pending. Collapsing to one statement removes that race and the
    null-token branch fork at the same time — legacy rows match on expiry alone.
    """
    now = now or datetime.now(timezone.utc)
    # LEGACY-NULL BRANCH IS LOAD-BEARING — do not simplify to `.lt("lock_expires_at", ...)`.
    # NO production code today writes a non-null lock_expires_at: the organize claim and the
    # trip claim (jobs.py) never set it, and the only writes anywhere are `None`. During the
    # A-II/A-III deploy overlap the OLD container can claim jobs right up to SIGTERM, leaving
    # lock_expires_at NULL. In SQL `NULL < now()` is NULL, not true — so an expiry-only
    # predicate skips those rows FOREVER, which is precisely the silent drop guardrail #12
    # forbids, reintroduced at this task's own rollout boundary. Fall back to locked_at + TTL.
    legacy_cutoff = _pg_timestamp(now - timedelta(seconds=ORGANIZE_LEASE_TTL_S))
    reclaimed = (await client.table("organize_jobs").update({
        "status": "pending", "status_message": "Requeued after restart",
        "locked_at": None, "lock_expires_at": None, "lease_token": None,
    }).eq("status", "processing").or_(
        f"lock_expires_at.lt.{_pg_timestamp(now)},"
        f"and(lock_expires_at.is.null,locked_at.lt.{legacy_cutoff})"
    ).execute()).data or []
    if reclaimed:
        logger.info("organize_leases_reclaimed count=%d", len(reclaimed))
    return (await client.table("organize_jobs").select("id,user_id").eq("status", "pending")
            .order("created_at").execute()).data or []


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

    `set_phase` reports which phase we are in so the caller's error log stays accurate.
    This spans TWO phases, not one: the grounding call is "mapbox", but the mention
    delete and the persist loop below it are "database". Tagging the whole unit "mapbox"
    (as the first extraction did) sends an on-call engineer to check Mapbox health for
    what is actually a Supabase write failure.
    """
    set_phase = set_phase or (lambda _phase: None)
    set_phase("mapbox")
    grounded = [
        resolved
        for place in places
        if (resolved := await _maybe_await(ctx.ground(place))) is not None
    ]
    set_phase("database")
    if cache_id:
        # A3 scopes this delete to ctx.user_id — today it is cross-user destructive.
        await (ctx.client.table("reel_place_mentions").delete()
               .eq("reel_cache_id", cache_id).execute())
    if not grounded or not cache_id:
        return "location_not_found", len(grounded)
    for resolved in grounded:
        place_id = await _persist_place(ctx.client, resolved)
        await _persist_mention(ctx.client, cache_id, place_id, resolved["place"])
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
        places = await _maybe_await(get_cached_places(ctx.client, reel["normalized_url"], EXTRACTOR_VERSION))
        if places is None:
            quota_state = item.get("analysis_charge_state", "not_charged")
            if quota_state in {"not_charged", "refunded"}:
                phase = "quota"
                if await reserve_organize_item_analysis(ctx.client, item["id"], ctx.user_id) is None:
                    raise RuntimeError("analysis quota reached")
                quota_state = "reserved"
            try:
                phase = "apify"
                scraped = await _maybe_await(ctx.scrape(reel["normalized_url"]))
                phase = "extractor"
                places = await _maybe_await(ctx.extract(scraped))
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
                    phase = "quota"
                    await refund_organize_item_analysis(ctx.client, item["id"], ctx.user_id)
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
        await _record_organize_event(ctx.client, ctx.job_id, ctx.user_id, "stage", "Reel organized", {"saved_reel_id": reel["id"], "place_count": place_count})
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
        await _record_organize_event(ctx.client, ctx.job_id, ctx.user_id, "error", "Reel organization failed", {"saved_reel_id": reel["id"]})
    return True


async def run_organize_job(job_id: str, user_id: str, *, client=None, scrape=None, extract=None, ground=None) -> dict:
    """Claim and run one organize job. All external clients are injectable for offline tests."""
    if client is None:
        from supabase_client import get_supabase_client
        client = await get_supabase_client()
    current = await (client.table("organize_jobs").select("attempt_count,started_at")
                     .eq("id", job_id).eq("user_id", user_id).maybe_single().execute())
    current_row = current.data if current is not None else {}
    attempt_count = int(current_row.get("attempt_count", 0)) + 1
    # Minted PER ATTEMPT, never reused: this token is what every later write CASes on, so a
    # token shared across attempts would let a superseded worker pass the fence its own
    # replacement installed.
    lease_token = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    claim_update = {
        "status": "processing", "status_message": "Finding places", "locked_at": now.isoformat(),
        "lock_expires_at": (now + timedelta(seconds=ORGANIZE_LEASE_TTL_S)).isoformat(),
        "lease_token": lease_token,
        "attempt_count": attempt_count,
    }
    if not current_row.get("started_at"):
        # Only the FIRST attempt stamps it. `started_at` is the run's user-visible elapsed
        # time; re-stamping on every retry makes a job stuck in a retry loop for an hour
        # report as though it had just begun, hiding the loop it is actually in.
        claim_update["started_at"] = now.isoformat()
    claimed = await (client.table("organize_jobs").update(claim_update)
                     .eq("id", job_id).eq("user_id", user_id).eq("status", "pending").execute())
    if not claimed.data:
        return {"skipped": "job already claimed"}
    try:
        await _record_organize_event(client, job_id, user_id, "stage", "Finding places")
        if scrape is None:
            async def scrape(url):
                token = os.environ.get("APIFY_TOKEN")
                if not token:
                    raise RuntimeError("Reel extraction is unavailable")
                return await scrape_reel(url, token=token)
        if extract is None:
            from genagents.place_extractor import extract_places
            extract = extract_places
        ground = ground or _ground_place
        items = (await client.table("organize_job_items").select("*").eq("job_id", job_id)
                 .eq("user_id", user_id).in_("status", ["queued", "processing"]).execute()).data or []
        # Built ONCE per job: A2 adds the per-attempt lease token here, A3 reads user_id
        # from it inside _ground_and_persist — neither needs a new call-site parameter.
        ctx = _ItemContext(
            client=client, job_id=job_id, user_id=user_id,
            scrape=scrape, extract=extract, ground=ground, lease_token=lease_token,
        )
        for item in items:
            processed = await _process_item(ctx, item)
            if processed:   # a skipped orphan must not reach counts — pre-refactor this was `continue`
                await _update_job_counts(client, job_id, user_id)
        status = await get_organize_status(client, job_id, user_id)
        final_status = "failed" if status["failed_items"] and not status["organized_items"] and not status["location_not_found_items"] else "succeeded"
        await client.table("organize_jobs").update({
            "status": final_status,
            "status_message": "Organization failed" if final_status == "failed" else "Organized",
            "completed_at": _now(), "locked_at": None, "lock_expires_at": None,
        }).eq("id", job_id).eq("user_id", user_id).execute()
        await _record_organize_event(client, job_id, user_id, "result", "Organization failed" if final_status == "failed" else "Organized", {"status": final_status})
        return await get_organize_status(client, job_id, user_id)
    except Exception:
        await _mark_organize_job_failed(client, job_id, user_id)
        try:
            return await get_organize_status(client, job_id, user_id)
        except Exception:
            return {"job_id": job_id, "status": "failed", "status_message": ORGANIZE_FAILURE_MESSAGE}
