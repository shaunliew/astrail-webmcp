"""Persist a generated trip into the normalized Supabase schema.

Writes the deterministic-spine output — places (global, dedup-on-write),
trip_places (link + day assignment + evidence), and trip_days. The enrich
tables (transport_legs / restaurant_suggestions / hotel_suggestions /
trip_days.weather_*) get additive inserts here once their agents exist.

Reuses the pure route/dedup helpers' spirit: an existing global `places` row is
reused when it matches by name/alias AND haversine < 500m (the same two-gate
`pipeline/dedup.py` applies in-trip), so `places` stays canonical across trips.
"""
from __future__ import annotations

import math
from collections import defaultdict

from genagents.transport import VALID_PROFILES, profile_to_mode   # keyless import (no network at module scope)
from models.enrichment import WeatherReport
from models.place import CanonicalPlace
from pipeline.dedup import DEFAULT_DISTANCE_M, normalize_name
from pipeline.feasibility import group_places_by_day
from pipeline.geo import haversine_m

_VALID_PLACE_TYPES = {"attraction", "restaurant", "hotel", "area", "city",
                      "country", "station", "shop", "other"}
_CATEGORY_MAP = {"transport": "station"}   # extractor emits 'transport'; enum has 'station'


def _place_type(category: str) -> str:
    c = (category or "").lower().strip()
    if c in _VALID_PLACE_TYPES:
        return c
    return _CATEGORY_MAP.get(c, "other")


def _source_summary(place: CanonicalPlace) -> dict:
    # GLOBAL place metadata only — never per-trip/user (the source_summary CHECK forbids it).
    ss: dict = {}
    if getattr(place, "formatted_address", None):
        ss["formatted_address"] = place.formatted_address
    return ss


def _evidence_json(place: CanonicalPlace) -> dict:
    # Per-trip evidence lives here (an object), NOT in places.source_summary.
    return {
        "evidence_quote": place.evidence_quote,
        "evidence_quotes": list(getattr(place, "evidence_quotes", []) or []),
        "source_url": place.source_url,
        "confidence": place.confidence,
    }


def _place_matches(place: CanonicalPlace, row: dict) -> bool:
    keys = {normalize_name(place.name), normalize_name(getattr(place, "name_local", None))}
    keys |= {normalize_name(a) for a in (getattr(place, "aliases", []) or [])}
    keys.discard("")
    row_keys = {normalize_name(row.get("name"))} | {normalize_name(a) for a in (row.get("aliases") or [])}
    row_keys.discard("")
    return bool(keys & row_keys)


def _bbox_deltas(lat: float) -> tuple[float, float]:
    """lat/lng degree deltas that always ENCLOSE a 500m radius (globally safe — a fixed
    0.01° lng box is < 500m at high latitude and would exclude a true near-duplicate)."""
    lat_delta = DEFAULT_DISTANCE_M / 111_320.0
    lng_delta = DEFAULT_DISTANCE_M / (111_320.0 * max(math.cos(math.radians(lat)), 1e-6))
    return lat_delta, lng_delta


async def _find_or_create_place(client, place: CanonicalPlace) -> str:
    """Dedup-on-write: reuse a global places row matching by name/alias AND <500m, else insert.
    The bbox is a coarse indexable pre-filter (uses the (lat,lng) index); the exact haversine
    gate decides. NOTE: select-then-insert is not atomic — two DIFFERENT trips saving the same
    brand-new place concurrently can both insert (a rare cross-trip flywheel dup); full safety
    needs a UNIQUE key/upsert on places (a migration), deferred until measured."""
    lat_d, lng_d = _bbox_deltas(place.lat)
    candidates = (await client.table("places").select("id,name,aliases,lat,lng")
                  .gte("lat", place.lat - lat_d).lte("lat", place.lat + lat_d)
                  .gte("lng", place.lng - lng_d).lte("lng", place.lng + lng_d)
                  .execute()).data
    for row in candidates:
        if _place_matches(place, row) and \
                haversine_m(place.lat, place.lng, row["lat"], row["lng"]) < DEFAULT_DISTANCE_M:
            return row["id"]
    inserted = (await client.table("places").insert({
        "name": place.name,
        "place_type": _place_type(place.category),
        "lat": place.lat, "lng": place.lng,
        "city": getattr(place, "city_or_region_guess", None),
        "aliases": list(getattr(place, "aliases", []) or []),
        "source_summary": _source_summary(place),
    }).execute()).data
    return inserted[0]["id"]


async def persist_itinerary(client, trip_id: str, canonical: list[CanonicalPlace],
                            dates: list[str]) -> int:
    """Persist the trip's normalized rows. Retry-safe (clears this trip's links/days first).

    Day assignment is IDENTITY-based: `group_places_by_day` produces the same geo-order +
    contiguous-split grouping the itinerary narrator uses, keyed by CanonicalPlace object
    identity — not by matching place NAMES against the rendered itinerary. Two distinct
    places sharing a name (e.g. two "7-Eleven") land on whichever day their own position in
    the geo-chain puts them, not both on the same day.

    Returns the count of places shown in the itinerary but NOT persisted to trip_places —
    either dropped for missing coordinates, or skipped because a distinct canonical place
    resolved to an already-linked global place_id (the flywheel collision). The caller
    degrades trip status to saved_with_gaps when this is > 0.

    Raises on a DB error — the caller (runner) degrades to saved_with_gaps.
    """
    groups = group_places_by_day(canonical, dates)   # identity-preserving, same grouping as the itinerary

    # Retry-safety: clear THIS trip's links/days (places are global — never deleted here).
    # The runner's atomic CAS claim makes this single-writer per job/trip, so the
    # non-transactional delete-then-reinsert is safe against the normal concurrency path.
    await client.table("trip_places").delete().eq("trip_id", trip_id).execute()
    await client.table("trip_days").delete().eq("trip_id", trip_id).execute()

    linked: set[str] = set()   # dedup place_ids within this trip
    dropped = 0
    for day_number, group in groups:
        sort_order = 0
        for place in group:
            if place.lat is None or place.lng is None:   # coord filter (places.lat/lng NOT NULL)
                dropped += 1
                continue
            place_id = await _find_or_create_place(client, place)
            # Two distinct canonical places can resolve to the SAME global place_id (the DB's
            # accumulated aliases merge more than in-trip dedup). Guard the trip_places
            # UNIQUE(trip_id, place_id): keep the first link, skip the duplicate.
            if place_id in linked:
                dropped += 1
                continue
            linked.add(place_id)
            await client.table("trip_places").insert({
                "trip_id": trip_id, "place_id": place_id, "source_type": place.source_type,
                "evidence_json": _evidence_json(place),
                "day_number": day_number, "sort_order": sort_order,
            }).execute()
            sort_order += 1

    for day_number, _group in groups:
        await client.table("trip_days").insert({
            "trip_id": trip_id, "day_number": day_number, "day_date": dates[day_number - 1],
        }).execute()

    return dropped


async def persist_weather(client, trip_id: str, reports: list[WeatherReport]) -> None:
    """Additive: write each day's weather onto the existing trip_days row (matched by
    day_date). MUST run AFTER persist_itinerary has (re)created the trip_days rows —
    an earlier write is wiped by persist's delete, and a missing row is a silent no-op."""
    for r in reports:
        await client.table("trip_days").update({
            "weather_summary": r.summary,
            "weather_source": "open_meteo",
            "weather_payload": r.model_dump(),
        }).eq("trip_id", trip_id).eq("day_date", r.date).execute()


# A WALKING leg longer than this (metres) is likely too far to walk — the transport agent
# re-tags it as a `transit_hint` (the schema's transport_mode value) with an explanatory
# warning, instead of presenting a multi-hour walk as the plan. The leg's distance/duration
# stay the REAL Mapbox walking figures (routing_profile="walking" discloses that); only the
# mode + warning change. A real transit ROUTE (line/time) waits for a grounded transit source.
_TRANSIT_HINT_M = 2000.0


def _leg_mode_and_warning(distance_m, base_mode: str) -> tuple[str, str | None]:
    """Classify one leg: a walking leg past the transit-hint threshold becomes a `transit_hint`
    with a warning; every other case (short walk, non-walking profile, unknown distance) passes
    the base mode through unchanged with no warning."""
    if base_mode == "walk" and distance_m is not None and distance_m > _TRANSIT_HINT_M:
        km = round(distance_m / 1000, 1)
        return "transit_hint", f"~{km} km — likely too far to walk; consider public transit"
    return base_mode, None


async def _insert_leg(client, *, trip_id: str, trip_day_id, from_id: str, to_id: str, leg_order: int,
                       mode: str, profile: str, status: str,
                       duration: int | None = None, distance: int | None = None,
                       warning: str | None = None) -> None:
    await client.table("transport_legs").insert({
        "trip_id": trip_id,
        "trip_day_id": trip_day_id,
        "from_place_id": from_id,
        "to_place_id": to_id,
        "leg_order": leg_order,
        "transport_mode": mode,
        "routing_provider": "mapbox",
        "routing_profile": profile,
        "status": status,
        "duration_seconds": duration,
        "distance_meters": distance,
        "warning": warning,
    }).execute()


async def persist_transport(client, trip_id: str, *, profile: str = "walking", fetch_legs=None) -> int:
    """Additive: compute per-day route legs (Mapbox Directions) between consecutive persisted
    trip_places and INSERT them into transport_legs. MUST run AFTER persist_itinerary created
    trip_places/trip_days. Retry-safe (deletes this trip's legs first). Returns legs written.
    fetch_legs is injectable (defaults to the real Mapbox call).

    Per-day failure isolation: a raise from `fetch_legs` for ONE day inserts `status="failed"`
    rows for that day's consecutive pairs and continues to the next day — a transient Mapbox
    blip on day 2 must not silently drop day 3+'s real legs (or abort day 1's already-fetched
    legs)."""
    # Normalize once, early: an invalid `profile` would otherwise flow both into the Mapbox
    # Directions URL (fetch_directions_legs) AND fail the routing_profile CHECK — validate
    # here so both consumers get the same safe, always-valid value.
    profile = profile if profile in VALID_PROFILES else "walking"

    if fetch_legs is None:
        from genagents.transport import fetch_directions_legs as fetch_legs

    # Retry-safe: delete this trip's legs FIRST — before any early return — so a re-run that
    # now yields zero legs (e.g. all places dropped) still clears stale rows. (trip_days delete
    # only SET NULLs trip_day_id, it does NOT cascade-delete transport_legs.)
    await client.table("transport_legs").delete().eq("trip_id", trip_id).execute()

    tps = (await client.table("trip_places").select("place_id,day_number,sort_order")
           .eq("trip_id", trip_id).execute()).data
    if not tps:
        return 0
    tds = (await client.table("trip_days").select("id,day_number").eq("trip_id", trip_id).execute()).data
    day_to_id = {d["day_number"]: d["id"] for d in tds}
    pids = list({tp["place_id"] for tp in tps})
    places = (await client.table("places").select("id,lat,lng").in_("id", pids).execute()).data
    coord = {p["id"]: (p["lat"], p["lng"]) for p in places}

    by_day: dict[int, list] = defaultdict(list)
    for tp in tps:
        by_day[tp["day_number"]].append(tp)

    mode = profile_to_mode(profile)
    written = 0
    for day_number, rows in by_day.items():
        # Filter to coord-bearing rows FIRST, then use the SAME filtered list for both the
        # Mapbox coords AND the from/to place_ids — so legs[i] aligns with rows[i]/rows[i+1].
        rows = [r for r in sorted(rows, key=lambda r: (r["sort_order"] if r["sort_order"] is not None else 0))
                if r["place_id"] in coord]
        if len(rows) < 2:
            continue
        coords = [coord[r["place_id"]] for r in rows]
        trip_day_id = day_to_id.get(day_number)
        try:
            legs = await fetch_legs(coords, profile=profile)
        except Exception:
            # This day's fetch failed — record a failed row per consecutive pair and move on
            # to the NEXT day, instead of aborting the whole function (silent partial state).
            for i in range(len(rows) - 1):
                await _insert_leg(client, trip_id=trip_id, trip_day_id=trip_day_id,
                                   from_id=rows[i]["place_id"], to_id=rows[i + 1]["place_id"],
                                   leg_order=i, mode=mode, profile=profile, status="failed")
                written += 1
            continue
        for i, leg in enumerate(legs):
            # Per-leg mode: a long walking leg is re-tagged transit_hint (the per-leg-mode seam
            # that a future real transit provider will also use, rather than a day-level constant).
            leg_mode, warning = _leg_mode_and_warning(leg.get("distance_m"), mode)
            await _insert_leg(client, trip_id=trip_id, trip_day_id=trip_day_id,
                               from_id=rows[i]["place_id"], to_id=rows[i + 1]["place_id"], leg_order=i,
                               mode=leg_mode, profile=profile,
                               status="ok" if leg.get("code") == "Ok" else "no_route",
                               duration=leg.get("duration_s"), distance=leg.get("distance_m"),
                               warning=warning)
            written += 1
    return written
