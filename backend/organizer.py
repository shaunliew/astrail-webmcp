"""Durable Saved Reel organizer: cache, extraction, grounding, and safe persistence."""
from __future__ import annotations

import hashlib
import inspect
import json
import logging
import os
from datetime import datetime, timedelta, timezone

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


async def recover_organize_jobs(client, stale_after_s: int = 900) -> list[dict]:
    """Requeue prior-process organize work and return pending jobs for boot dispatch."""
    initializing_cutoff = (
        datetime.now(timezone.utc) - timedelta(seconds=INITIALIZING_STALE_AFTER_S)
    ).isoformat()
    abandoned = (await client.table("organize_jobs").select("id,user_id")
                 .eq("status", "initializing").lt("created_at", initializing_cutoff).execute()).data or []
    for row in abandoned:
        await (client.table("organize_jobs").delete().eq("id", row["id"])
               .eq("user_id", row["user_id"]).eq("status", "initializing").execute())
    interrupted = (await client.table("organize_jobs").select("id")
                   .eq("status", "processing").execute()).data or []
    for row in interrupted:
        await client.table("organize_jobs").update({
            "status": "pending", "status_message": "Requeued after restart",
            "locked_at": None, "lock_expires_at": None,
        }).eq("id", row["id"]).execute()
    return (await client.table("organize_jobs").select("id,user_id").eq("status", "pending")
            .order("created_at").execute()).data or []


async def _ground_and_persist(
    client, reel: dict, cache_id: str | None, places: list[PlaceResult], *, ground
) -> tuple[str, int]:
    """Verify researched places and rewrite this Reel's canonical mentions.

    Returns `(terminal, place_count)` where terminal is "organized" or
    "location_not_found". `reel` identifies the Saved Reel the mentions belong to.
    """
    grounded = [
        resolved
        for place in places
        if (resolved := await _maybe_await(ground(place))) is not None
    ]
    if cache_id:
        await (client.table("reel_place_mentions").delete()
               .eq("reel_cache_id", cache_id).execute())
    if not grounded or not cache_id:
        return "location_not_found", len(grounded)
    for resolved in grounded:
        place_id = await _persist_place(client, resolved)
        await _persist_mention(client, cache_id, place_id, resolved["place"])
    return "organized", len(grounded)


async def _process_item(client, job_id: str, user_id: str, item: dict, *, scrape, extract, ground) -> None:
    """Organize one Saved Reel. Failures stay inside this item (guardrail #3)."""
    phase = "database"
    reel_result = await (client.table("saved_reels").select(
        "id,normalized_url,reel_cache_id"
    ).eq("id", item["saved_reel_id"]).eq("user_id", user_id).maybe_single().execute())
    reel = reel_result.data if reel_result is not None else None
    if reel is None:
        return
    await client.table("organize_job_items").update({"status": "processing"}).eq("id", item["id"]).eq("user_id", user_id).execute()
    cache_id = reel.get("reel_cache_id")
    if cache_id is None:
        phase = "database"
        cache_id = await _find_cache_id(client, reel["normalized_url"])
    try:
        phase = "database"
        places = await _maybe_await(get_cached_places(client, reel["normalized_url"], EXTRACTOR_VERSION))
        if places is None:
            quota_state = item.get("analysis_charge_state", "not_charged")
            if quota_state in {"not_charged", "refunded"}:
                phase = "quota"
                if await reserve_organize_item_analysis(client, item["id"], user_id) is None:
                    raise RuntimeError("analysis quota reached")
                quota_state = "reserved"
            try:
                phase = "apify"
                scraped = await _maybe_await(scrape(reel["normalized_url"]))
                phase = "extractor"
                places = await _maybe_await(extract(scraped))
                # The cache stores research provenance before provider verification. A
                # Mapbox retry can therefore reuse research without paying for Apify again.
                phase = "database"
                await cache_places(
                    client,
                    reel["normalized_url"],
                    scraped,
                    places,
                    EXTRACTOR_VERSION,
                )
                if quota_state == "reserved":
                    phase = "quota"
                    await _consume_organize_item_analysis(client, item["id"], user_id)
                    quota_state = "consumed"
            except Exception:
                if quota_state == "reserved":
                    phase = "quota"
                    await refund_organize_item_analysis(client, item["id"], user_id)
                raise
        else:
            if item.get("analysis_charge_state") == "reserved":
                phase = "quota"
                await _consume_organize_item_analysis(client, item["id"], user_id)
        phase = "database"
        if cache_id is None:
            cache_id = await _find_cache_id(client, reel["normalized_url"])
        phase = "mapbox"
        terminal, place_count = await _ground_and_persist(
            client, reel, cache_id, places, ground=ground
        )
        phase = "database"
        await client.table("organize_job_items").update({
            "status": terminal, "place_count": place_count, "error_message": None, "completed_at": _now()
        }).eq("id", item["id"]).eq("user_id", user_id).execute()
        await client.table("saved_reels").update({
            "reel_cache_id": cache_id, "analysis_status": terminal,
            "analyzed_at": _now(), "retry_after": None,
        }).eq("id", reel["id"]).eq("user_id", user_id).execute()
        await _record_organize_event(client, job_id, user_id, "stage", "Reel organized", {"saved_reel_id": reel["id"], "place_count": place_count})
    except Exception:
        logger.error(
            "saved_reel_organize_item_failed phase=%s job_id=%s item_id=%s",
            phase, job_id, item["id"],
        )
        await client.table("organize_job_items").update({
            "status": "failed", "error_message": "Reel organization failed", "completed_at": _now()
        }).eq("id", item["id"]).eq("user_id", user_id).execute()
        await client.table("saved_reels").update({
            "analysis_status": "failed", "retry_after": None,
        }).eq("id", reel["id"]).eq("user_id", user_id).execute()
        await _record_organize_event(client, job_id, user_id, "error", "Reel organization failed", {"saved_reel_id": reel["id"]})


async def run_organize_job(job_id: str, user_id: str, *, client=None, scrape=None, extract=None, ground=None) -> dict:
    """Claim and run one organize job. All external clients are injectable for offline tests."""
    if client is None:
        from supabase_client import get_supabase_client
        client = await get_supabase_client()
    current = await (client.table("organize_jobs").select("attempt_count")
                     .eq("id", job_id).eq("user_id", user_id).maybe_single().execute())
    attempt_count = int((current.data if current is not None else {}).get("attempt_count", 0)) + 1
    now = datetime.now(timezone.utc)
    claimed = await (client.table("organize_jobs").update({
        "status": "processing", "status_message": "Finding places", "locked_at": now.isoformat(),
        "started_at": now.isoformat(),
        "attempt_count": attempt_count,
    }).eq("id", job_id).eq("user_id", user_id).eq("status", "pending").execute())
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
        for item in items:
            await _process_item(client, job_id, user_id, item, scrape=scrape, extract=extract, ground=ground)
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
