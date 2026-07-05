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
import re

from models.place import CanonicalPlace
from models.trip import ItineraryOutput
from pipeline.geo import haversine_m

_GEO_GATE_M = 500.0            # same threshold as pipeline/dedup.DEFAULT_DISTANCE_M

_VALID_PLACE_TYPES = {"attraction", "restaurant", "hotel", "area", "city",
                      "country", "station", "shop", "other"}
_CATEGORY_MAP = {"transport": "station"}   # extractor emits 'transport'; enum has 'station'

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_WS = re.compile(r"\s+")


def _norm(name: str | None) -> str:
    if not name:
        return ""
    return _WS.sub(" ", _NON_WORD.sub(" ", name.lower())).strip()


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


def _day_lookup(itinerary: ItineraryOutput) -> dict[str, tuple[int, int]]:
    """name -> (day_number, sort_order) from the itinerary's per-day place_names."""
    lookup: dict[str, tuple[int, int]] = {}
    for day in itinerary.days:
        for i, name in enumerate(day.place_names):
            lookup.setdefault(name, (day.day_number, i))
    return lookup


def _place_matches(place: CanonicalPlace, row: dict) -> bool:
    keys = {_norm(place.name), _norm(getattr(place, "name_local", None))}
    keys |= {_norm(a) for a in (getattr(place, "aliases", []) or [])}
    keys.discard("")
    row_keys = {_norm(row.get("name"))} | {_norm(a) for a in (row.get("aliases") or [])}
    row_keys.discard("")
    return bool(keys & row_keys)


def _bbox_deltas(lat: float) -> tuple[float, float]:
    """lat/lng degree deltas that always ENCLOSE a 500m radius (globally safe — a fixed
    0.01° lng box is < 500m at high latitude and would exclude a true near-duplicate)."""
    lat_delta = _GEO_GATE_M / 111_320.0
    lng_delta = _GEO_GATE_M / (111_320.0 * max(math.cos(math.radians(lat)), 1e-6))
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
                haversine_m(place.lat, place.lng, row["lat"], row["lng"]) < _GEO_GATE_M:
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
                            itinerary: ItineraryOutput) -> None:
    """Persist the trip's normalized rows. Retry-safe (clears this trip's links/days first).

    Raises on a DB error — the caller (runner) degrades to saved_with_gaps.
    """
    places = [p for p in canonical if p.lat is not None and p.lng is not None]
    day_of = _day_lookup(itinerary)

    # Retry-safety: clear THIS trip's links/days (places are global — never deleted here).
    # The runner's atomic CAS claim makes this single-writer per job/trip, so the
    # non-transactional delete-then-reinsert is safe against the normal concurrency path.
    await client.table("trip_places").delete().eq("trip_id", trip_id).execute()
    await client.table("trip_days").delete().eq("trip_id", trip_id).execute()

    linked: set[str] = set()   # dedup place_ids within this trip
    for place in places:
        place_id = await _find_or_create_place(client, place)
        # Two distinct canonical places can resolve to the SAME global place_id (the DB's
        # accumulated aliases merge more than in-trip dedup). Guard the trip_places
        # UNIQUE(trip_id, place_id): keep the first link, skip the duplicate.
        if place_id in linked:
            continue
        linked.add(place_id)
        day_number, sort_order = day_of.get(place.name, (None, None))
        await client.table("trip_places").insert({
            "trip_id": trip_id, "place_id": place_id,
            "source_type": place.source_type,
            "evidence_json": _evidence_json(place),
            "day_number": day_number, "sort_order": sort_order,
        }).execute()

    for day in itinerary.days:
        await client.table("trip_days").insert({
            "trip_id": trip_id, "day_number": day.day_number, "day_date": day.date,
        }).execute()
