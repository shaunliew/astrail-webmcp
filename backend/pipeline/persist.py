"""Persist a generated trip into the normalized Supabase schema.

Writes the deterministic-spine output — places (global, dedup-on-write),
trip_places (link + day assignment + evidence), and trip_days. The enrich
tables (transport_legs / restaurant_suggestions / hotel_suggestions /
trip_days.weather_*) get additive inserts here once their agents exist.

Reuses the pure route/dedup helpers' spirit: an existing global `places` row is
reused when it matches by name/alias AND haversine < 500m (the same two-gate
`pipeline/dedup.py` applies in-trip), so `places` stays canonical across trips.
Enrich RESTAURANTS instead dedup by the Mapbox POI's stable `mapbox_id` (see
`_find_or_create_restaurant_place`): dense chain branches share an English label
but not a POI id, so the name+geo gate would wrongly merge them.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import math
from collections import defaultdict

from genagents.place_extractor import is_placeholder_url   # keyless import (no network at module scope)
from genagents.transport import VALID_PROFILES, profile_to_mode   # keyless import (no network at module scope)
from grounding import _coord_cache_key, _ground_place
from models.enrichment import WeatherReport
from models.evidence import TripPlaceEvidence
from models.place import CanonicalPlace
from pipeline.dedup import DEFAULT_DISTANCE_M, normalize_name
from pipeline.feasibility import group_places_by_day
from pipeline.geo import haversine_m

_VALID_PLACE_TYPES = {"attraction", "restaurant", "hotel", "area", "city",
                      "country", "station", "shop", "other"}
_CATEGORY_MAP = {"transport": "station"}   # extractor emits 'transport'; enum has 'station'
logger = logging.getLogger(__name__)


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


def _evidence_kind(source_type: str) -> str:
    # trip_places holds only these 3 source types (restaurants/hotels have their own tables).
    return {
        "reel_extracted": "reel_quote",
        "user_requested": "requested_by_you",
        "agent_suggested": "suggested_by_astrail",
    }.get(source_type, "suggested_by_astrail")


def _evidence_json(place: CanonicalPlace) -> dict:
    # Per-trip evidence — typed to the frontend TripPlaceEvidence contract (guardrail #4).
    return TripPlaceEvidence(
        confidence=place.confidence,
        source_url=place.source_url,
        quote=place.evidence_quote,                                   # primary verbatim quote
        quotes=list(getattr(place, "evidence_quotes", []) or []),     # dedup flywheel
        rationale=None,                                               # seam for agent_suggested "why"
        evidence_kind=_evidence_kind(place.source_type),
    ).model_dump()


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


async def _safe_ground(client, place: CanonicalPlace, verify_country,
                       failures: dict[int, str]) -> dict | None:
    """One place's country verification, best-effort (guardrail #3): ANY failure -> None -> the
    place persists with `country` NULL, which is exactly the behaviour that shipped before this
    function existed. A Mapbox outage degrades `"Tokyo, Japan"` to `"Tokyo"`; it never fails a trip.

    `Exception`, never `BaseException`: a `CancelledError` from a lost job lease must keep
    propagating out of the gather rather than being absorbed into a silent NULL.

    A verified answer whose CACHE WRITE failed is discarded too, and that is deliberate rather
    than an accident of a broad `except` — `_store_cached_country` raises by design (guardrail
    #7, strict write-through: we do not hand back a verified result we could not persist).
    """
    try:
        return await _ground_place(client, place, verify_country=verify_country)
    except Exception as exc:
        # Type only, never the message — a Mapbox error can carry the access token.
        failures[id(place)] = type(exc).__name__
        return None


async def _ground_group(client, group: list[CanonicalPlace], verify_country,
                        failures: dict[int, str]) -> list[tuple[int, dict | None]]:
    """Ground one coordinate's places SEQUENTIALLY — every member, no exceptions.

    The first member seeds `geocode_country_cache`; the later ones hit it. Firing them
    concurrently instead would have every member observe a cache miss before any upsert lands,
    so every member pays Mapbox — not incorrect (the cache PK makes the upsert idempotent) but
    it defeats the cache entirely.

    NO MEMOIZATION OF ANY KIND inside the group: not the first member's verdict, not keyed by
    claim, not keyed by anything. Caching is `_ground_place`'s own job and it is already correct
    there. A caller-side shortcut is always wrong, because `_ground_place` applies PER-PLACE
    gates — coordinates present, source URL not a placeholder, claim present — plus a per-place
    comparison against that member's own LLM claim, none of which can be inferred from a sibling
    sharing the coordinate.

    Results are returned as `(id(input_place), grounded)` pairs rather than positionally:
    `_ground_place` returns a `model_copy`, so keying off the grounded place's id would key a
    DIFFERENT object and every lookup would silently miss.
    """
    out: list[tuple[int, dict | None]] = []
    for place in group:
        out.append((id(place), await _safe_ground(client, place, verify_country, failures)))
    return out


def _is_eligible_for_grounding(place: CanonicalPlace) -> bool:
    """Mirror of `_ground_place`'s gate — FOR THE LOG LINE ONLY.

    This never influences a persisted value: the only thing that decides a country is
    `_ground_place` itself, per member. It exists so the aggregate log can say "eight
    mismatches" (working as designed — coordinates that legitimately disagree with their claim)
    apart from "eight HTTPStatusErrors" (a revoked credential), which a single
    "zero verified" counter cannot.
    """
    return not (place.lat is None or place.lng is None
                or is_placeholder_url(place.source_url)
                or not place.country_code or not place.country_name)


def _log_grounding(canonical: list[CanonicalPlace], grounded_by_id: dict[int, dict | None],
                   failures: dict[int, str]) -> None:
    """ONE aggregate line per trip. A missing token cannot reach production (it is a required
    boot secret), so what stays silent here is a revoked credential, a 401/429, an outage, or
    plain programming error — all of which look identical in the persisted rows (NULL)."""
    counts = {"grounded": 0, "failed": 0, "ineligible": 0, "mismatched": 0}
    for place in canonical:
        if grounded_by_id.get(id(place)) is not None:
            counts["grounded"] += 1
        elif id(place) in failures:
            counts["failed"] += 1          # an exception is what ACTUALLY happened to this place
        elif not _is_eligible_for_grounding(place):
            counts["ineligible"] += 1
        else:
            counts["mismatched"] += 1
    logger.info(
        "trip_place_grounding grounded=%d ineligible=%d mismatched=%d failed=%d failure_types=%s",
        counts["grounded"], counts["ineligible"], counts["mismatched"], counts["failed"],
        ",".join(sorted(set(failures.values()))) or "-",
    )


async def _ground_all(client, canonical: list[CanonicalPlace], *,
                      verify_country) -> dict[int, dict | None]:
    """Verify every canonical place's country: parallel ACROSS coordinates, sequential WITHIN one.

    `dedupe_places` caps `canonical` at DEFAULT_MAX_PLACES = 8, so the fan-out is at most 8
    distinct coordinates — no semaphore (a per-trip limiter would not bound aggregate
    concurrency across simultaneous jobs anyway; the trigger for a process-wide one is observed
    429s). The one way `canonical` exceeds 8 is the `user_requested`-only edge case in
    `pipeline/dedup.py`. Most of those short-circuit before any network call — a user-typed
    place has no source_url, so `is_placeholder_url` rejects it — but NOT all: `_merge_cluster`
    marks a cluster `user_requested` if ANY member is, while the canonical inherits its
    highest-confidence representative's `source_url`, which can be a real reel URL. So an
    over-cap trip can still make calls. Harmless at this scale (the DEFAULT Geocoding rate limit
    is 1000/min, adjustable per account), but do not read the cap as a hard bound on provider calls.

    Keyed by `id(place)`, matching `group_places_by_day`'s existing identity contract so two
    distinct places sharing a name stay distinct. Safe ONLY because `canonical` holds a strong
    reference for the whole call — no object can be freed and its id reused. Returns a map, and
    never filters or mutates `canonical`: which places survive is not grounding's business.
    """
    by_coord: dict[tuple[float, float], list[CanonicalPlace]] = {}
    for place in canonical:
        if place.lat is not None and place.lng is not None:
            by_coord.setdefault((place.lat, place.lng), []).append(place)
    failures: dict[int, str] = {}
    results = await asyncio.gather(
        *[_ground_group(client, group, verify_country, failures) for group in by_coord.values()],
        return_exceptions=True,
    )
    grounded_by_id: dict[int, dict | None] = {}
    for result in results:
        # `return_exceptions=True` is kept for its OTHER property — it waits for every group
        # instead of returning on the first raise and leaving the siblings running detached,
        # mid-cache-write, on a trip nobody is going to save. But it captures `CancelledError`
        # too, and DISCARDING one here (`if not isinstance(r, BaseException)`) absorbs a lost
        # lease's abort into a group of silent NULLs: those places are counted `mismatched` and
        # the superseded worker walks on into the destructive rewrite. `_safe_ground` already
        # absorbs every ordinary per-place `Exception`, so nothing reaching this point is
        # best-effort material — it is that cancellation or a programming error, and both must
        # propagate. Deterministic when several groups raise: `by_coord` is insertion-ordered,
        # so the first raiser in canonical order always wins.
        if isinstance(result, BaseException):
            raise result
        grounded_by_id.update(result)
    _log_grounding(canonical, grounded_by_id, failures)
    return grounded_by_id


async def _repair_null_country(client, row: dict, grounded: dict) -> bool:
    """Fill a reused row's NULL country from the verified receipt for THIS coordinate.

    Returns whether the caller may still link to `row` — True to return its id, False to fall
    through to the next candidate. It NEVER repairs and then falls through: a repair that landed
    is a repair of the row we are about to use.

    The write is a compare-and-swap (`.is_("country_code", "null")`) rather than a plain update,
    because between the candidate SELECT and this statement a racer — another pipeline worker,
    or `find_or_create_place` on the organize path — can fill the same row. `.eq(col, None)` is
    NOT the same predicate: PostgREST serializes it as `eq.None`, which matches zero NULL rows,
    so the CAS would silently touch nothing in production.

    Zero matched rows means exactly that race, and the reconciliation re-read is what keeps R1
    intact: a racer that wrote a CONTRADICTING country turns this candidate into the wrong venue,
    so it must be rejected rather than linked. Every UNCERTAIN outcome falls through too — a row
    deleted between the select and the re-read would hand back an id that no longer exists (an FK
    failure on trip_places), and a re-read that raises knows nothing at all.

    Best-effort, narrowly scoped (guardrail #3): only the two round trips are wrapped, and the
    response unwrapping sits INSIDE the `try` with them — `maybe_single()` returns a BARE `None`
    on zero rows, so reading `.data` outside the catch is an AttributeError that would fail the
    whole trip. `Exception`, never `BaseException`: a lost job lease's `CancelledError` must keep
    propagating instead of being absorbed into a silent no-repair.
    """
    patch = {
        # ALL THREE, from the PROVIDER receipt and never the LLM's claim (guardrail #1) —
        # `country` carries the country NAME, matching `find_or_create_place`'s `p_country`.
        "country": grounded["country_name"],
        "country_code": grounded["country_code"],
        "country_name": grounded["country_name"],
    }
    try:
        repaired = (await client.table("places").update(patch)
                    .eq("id", row["id"]).is_("country_code", "null").execute()).data
    except Exception as exc:
        # Type only, never the message — a Supabase error can carry connection details.
        logger.warning("place_country_repair_failed error=%s", type(exc).__name__)
        return True     # no repair; the place still links and the trip still saves
    if repaired:
        return True
    try:
        result = await (client.table("places").select("id,country_code")
                        .eq("id", row["id"]).maybe_single().execute())
        current = result.data if result is not None else None
    except Exception as exc:
        logger.warning("place_country_reread_failed error=%s", type(exc).__name__)
        return False    # fail closed: we cannot say this row is still the right one
    if current is None:
        return False    # deleted between the select and now — never hand back a dead id
    code = current.get("country_code")
    return not (code and code != grounded["country_code"])


async def _find_or_create_place(client, place: CanonicalPlace, *, grounded: dict | None) -> str:
    """Dedup-on-write: reuse a global places row matching by name/alias AND <500m — and, when we
    hold a verified country, whose own non-NULL `country_code` does not contradict it — else insert.
    The bbox is a coarse indexable pre-filter (uses the (lat,lng) index); the exact haversine
    gate decides. NOTE: select-then-insert is not atomic — two DIFFERENT trips saving the same
    brand-new place concurrently can both insert (a rare cross-trip flywheel dup); full safety
    needs a UNIQUE key/upsert on places (a migration), deferred until measured.

    `grounded` is `_ground_place`'s verified result or None, and it is a REQUIRED keyword with
    no default: a defaulted None is exactly the bypass a forgetful call site would take, and it
    would be silent — the row would just come back country-less again.

    Reuse can also WRITE: a reused row whose country is NULL and whose stored coordinate is the
    same one we just verified gets that receipt filled in (`_repair_null_country`). Otherwise
    this function only ever reads or inserts."""
    lat_d, lng_d = _bbox_deltas(place.lat)
    candidates = (await client.table("places").select("id,name,aliases,lat,lng,country_code")
                  .gte("lat", place.lat - lat_d).lte("lat", place.lat + lat_d)
                  .gte("lng", place.lng - lng_d).lte("lng", place.lng + lng_d)
                  .execute()).data
    for row in candidates:
        if _place_matches(place, row) and \
                haversine_m(place.lat, place.lng, row["lat"], row["lng"]) < DEFAULT_DISTANCE_M:
            # A row whose VERIFIED country contradicts this place's verified one is a different
            # venue, however close and however alike the names: name + 500m alone links a
            # Malaysian venue to a Singapore row across the strait, and the trip then renders the
            # wrong country and the wrong canonical pin. Skipping the WRITE would not help — the
            # id still comes back. Fall through to the next candidate, and insert if none fits.
            #
            # Only against a verified country, and only against a non-NULL one: a NULL is an
            # ABSENT claim (87% of the corpus) rather than a conflicting one, and with
            # `grounded is None` there is nothing to compare, so a provider outage must leave
            # dedup exactly as it is rather than forking `places` (guardrail #1, #3).
            if grounded is not None and row.get("country_code") \
                    and row["country_code"] != grounded["country_code"]:
                continue
            # F, and it runs HERE — after both gates and after R1's conflict check, never
            # before. A NULL-country candidate stored at the same binary64 coordinate as the
            # place we just verified is a row our receipt literally describes, so fill it in
            # rather than discard the answer (the measured case: 4/4 of a re-run trip's places
            # dedup onto NULL rows created from the same cached coordinate). A DIFFERENT
            # coordinate — even one metre away — stays unrepaired: that is R3, deferred.
            if grounded is not None and row.get("country_code") is None \
                    and _coord_cache_key(place.lat, place.lng) == \
                    _coord_cache_key(row["lat"], row["lng"]):
                if not await _repair_null_country(client, row, grounded):
                    continue
            return row["id"]
    new_row = {
        "name": place.name,
        # The local-script name, verbatim from the caption (20260720190000). `_place_matches`
        # above already reads this field for alias dedup, so a row inserted without it stays
        # unmatched by the exact name the next reel is most likely to caption it with.
        "name_local": getattr(place, "name_local", None),
        "place_type": _place_type(place.category),
        "lat": place.lat, "lng": place.lng,
        "city": getattr(place, "city_or_region_guess", None),
        "aliases": list(getattr(place, "aliases", []) or []),
        "source_summary": _source_summary(place),
    }
    if grounded is not None:
        # ALL THREE OR NONE — `places_country_fields_pair_check` (20260718130000) requires code
        # and name to be set together. `country` carries the country NAME, the same value
        # `find_or_create_place` binds to `p_country` on the organize path (grounding.py), so
        # one column never holds "JP" for some rows and "Japan" for others; PlaceIntelPanel
        # renders it joined with area/city and would show both spellings side by side.
        new_row["country"] = grounded["country_name"]
        new_row["country_code"] = grounded["country_code"]
        new_row["country_name"] = grounded["country_name"]
    inserted = (await client.table("places").insert(new_row).execute()).data
    return inserted[0]["id"]


async def _replace_trip_rows(client, trip_id: str, place_rows: list[dict], day_rows: list[dict],
                             *, job_id: str | None, lease_token: str | None) -> None:
    """Swap this trip's trip_places/trip_days for the given rows — FENCED on our job lease.

    This is the pipeline's only DESTRUCTIVE write, and the fence has to be part of the write
    rather than a check in front of it. A superseded worker that merely *checked* an
    in-process flag can still be superseded a microsecond later and go on to delete the
    replacement's itinerary; `replace_trip_itinerary` re-reads the lease under a row lock in
    the SAME transaction as the delete-reinsert, so being superseded means writing nothing.
    Unlike the job row (`complete_trip_run`'s CAS) and the terminal event (`api/streaming.py`
    returns on the first `result`), nothing anywhere corrects a clobbered itinerary.

    `job_id`/`lease_token` are REQUIRED keyword arguments with no defaults, mirroring
    `mark_job_done`: a defaulted `None` is exactly the bypass a forgetful call site would take,
    and it would be silent. Passing both as None is the explicit "this run has no durable job"
    declaration — the jobless path has no lease, no reaper, and therefore no supersession to
    fence against. A job_id WITHOUT a token is not a third mode, it is a bug: the token is
    minted by the same statement that claims the job, so a caller holding one and not the
    other never owned it.
    """
    if job_id is None:
        if lease_token is not None:
            raise ValueError("lease_token without job_id: this run never claimed a job")
        # No durable job => nothing to be superseded BY. Same statements the fenced path runs,
        # in the same order.
        await client.table("trip_places").delete().eq("trip_id", trip_id).execute()
        await client.table("trip_days").delete().eq("trip_id", trip_id).execute()
        for row in place_rows:
            await client.table("trip_places").insert({"trip_id": trip_id, **row}).execute()
        for row in day_rows:
            await client.table("trip_days").insert({"trip_id": trip_id, **row}).execute()
        return
    if lease_token is None:
        raise ValueError(f"job {job_id} has no lease token: refusing an unfenced trip rewrite")

    fenced = await client.rpc("replace_trip_itinerary", {
        "p_job_id": job_id, "p_trip_id": trip_id, "p_lease_token": lease_token,
        "p_places": place_rows, "p_days": day_rows,
    }).execute()
    if not fenced.data:
        # A zero-row fence is an AUTHORITATIVE statement that a replacement owns this job —
        # the same signal `_renew_job_lease` returning False carries. Raise the type the
        # runner's gates raise so it takes the identical abort path.
        from organizer import LeaseLost      # local: keeps pipeline.persist off organizer's imports

        raise LeaseLost(f"trip job {job_id} lease superseded during persist")


async def persist_itinerary(client, trip_id: str, canonical: list[CanonicalPlace],
                            dates: list[str], *, job_id: str | None,
                            lease_token: str | None, verify_country=None) -> int:
    """Persist the trip's normalized rows. Retry-safe (replaces this trip's links/days).

    Day assignment is IDENTITY-based: `group_places_by_day` produces the same geo-order +
    contiguous-split grouping the itinerary narrator uses, keyed by CanonicalPlace object
    identity — not by matching place NAMES against the rendered itinerary. Two distinct
    places sharing a name (e.g. two "7-Eleven") land on whichever day their own position in
    the geo-chain puts them, not both on the same day.

    Returns the count of places shown in the itinerary but NOT persisted to trip_places —
    either dropped for missing coordinates, or skipped because a distinct canonical place
    resolved to an already-linked global place_id (the flywheel collision). The caller
    degrades trip status to saved_with_gaps when this is > 0.

    Every row is resolved BEFORE anything is deleted, so the whole swap is one fenced
    statement (see `_replace_trip_rows`). The old ordering deleted first and then resolved
    place ids one round-trip at a time, which left the trip with no itinerary at all for the
    length of that loop — and left it that way permanently if a lookup raised mid-loop.

    A non-NULL `places.country` is a VERIFICATION RECEIPT, not a label: it means the coordinate
    reverse-geocoded AND the answer agreed with the extractor's independent claim. So every
    place is grounded here, at the persistence boundary, before the insert that writes it —
    filling the column from the LLM's unverified claim instead would make an unchecked row look
    verified, with no way to tell the two apart afterwards (guardrail #1). Unverifiable stays
    NULL, which is the honest answer and today's behaviour.

    `verify_country` is DEPENDENCY SUBSTITUTION FOR TESTS, never a feature switch. There is
    exactly one grounding path and the default is it: `None` means `_ground_place` resolves the
    real `reverse_country` itself, so the live caller (which passes nothing) grounds like every
    other caller. Do not add a branch that skips grounding when it is absent — that ships as a
    complete no-op in production while the suite stays green.

    Raises on a DB error — the caller (runner) degrades to saved_with_gaps — or `LeaseLost`
    if a replacement claimed the job, which the runner must NOT degrade but abort on.
    """
    grounded_by_id = await _ground_all(client, canonical, verify_country=verify_country)
    groups = group_places_by_day(canonical, dates)   # identity-preserving, same grouping as the itinerary

    linked: set[str] = set()   # dedup place_ids within this trip
    dropped = 0
    place_rows: list[dict] = []
    for day_number, group in groups:
        sort_order = 0
        for place in group:
            if place.lat is None or place.lng is None:   # coord filter (places.lat/lng NOT NULL)
                dropped += 1
                continue
            # `groups` order, never gather-completion order — the day/sort_order assignment is
            # the itinerary's, and grounding is only a lookup on the way past.
            place_id = await _find_or_create_place(client, place,
                                                   grounded=grounded_by_id.get(id(place)))
            # Two distinct canonical places can resolve to the SAME global place_id (the DB's
            # accumulated aliases merge more than in-trip dedup). Guard the trip_places
            # UNIQUE(trip_id, place_id): keep the first link, skip the duplicate.
            if place_id in linked:
                dropped += 1
                continue
            linked.add(place_id)
            place_rows.append({
                "place_id": place_id, "source_type": place.source_type,
                "evidence_json": _evidence_json(place),
                "day_number": day_number, "sort_order": sort_order,
            })
            sort_order += 1

    day_rows = [{"day_number": day_number, "day_date": dates[day_number - 1]}
                for day_number, _group in groups]

    await _replace_trip_rows(client, trip_id, place_rows, day_rows,
                             job_id=job_id, lease_token=lease_token)
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


def _nearest_place_id(lat: float, lng: float, anchors: list[tuple[str, float, float]]) -> str | None:
    """The place_id of the anchor closest to (lat,lng) by haversine — the place a restaurant
    suggestion is 'near'. `anchors` are (place_id, lat, lng)."""
    best_id, best_d = None, None
    for pid, plat, plng in anchors:
        d = haversine_m(lat, lng, plat, plng)
        if best_d is None or d < best_d:
            best_id, best_d = pid, d
    return best_id


async def _find_or_create_restaurant_place(client, cand, city) -> str:
    """Restaurants dedup on the Mapbox POI's stable `mapbox_id` (stored in source_summary), NOT the
    itinerary flywheel's name+geo — the latter mis-merges dense chain branches (e.g. two "ガスト"
    within 500m whose LLM English label both collapse to "Gusto") into one pin. Reuse a places row
    carrying the same mapbox_id, else insert a fresh restaurant row. The bbox pre-filter keeps the
    lookup on the (lat,lng) index; the mapbox_id equality decides. `mapbox_id` is allowed in
    source_summary (the public-shape CHECK blacklists per-trip/user keys, not POI ids)."""
    if cand.mapbox_id:
        lat_d, lng_d = _bbox_deltas(cand.lat)
        nearby = (await client.table("places").select("id,source_summary")
                  .gte("lat", cand.lat - lat_d).lte("lat", cand.lat + lat_d)
                  .gte("lng", cand.lng - lng_d).lte("lng", cand.lng + lng_d)
                  .execute()).data
        for row in nearby:
            if (row.get("source_summary") or {}).get("mapbox_id") == cand.mapbox_id:
                return row["id"]
    source_summary: dict = {}
    if cand.mapbox_id:
        source_summary["mapbox_id"] = cand.mapbox_id
    if cand.address:
        source_summary["formatted_address"] = cand.address
    inserted = (await client.table("places").insert({
        "name": cand.name,
        # Straight from the Mapbox POI — `genagents/restaurant.py` takes `name_local` from the
        # POI structurally and never from the LLM, so this is grounded provider data rather than
        # a transliteration (20260720190000).
        "name_local": cand.name_local,
        "place_type": "restaurant",
        "lat": cand.lat, "lng": cand.lng,
        "city": city,
        "aliases": [a for a in (cand.name, cand.name_local) if a],
        "source_summary": source_summary,
    }).execute()).data
    return inserted[0]["id"]


async def persist_restaurants(client, trip_id: str, *, suggest=None,
                              preference_block: str | None = None) -> int:
    """Additive: for each day, get grounded restaurant suggestions (Mapbox + LLM) near the day's
    places and INSERT them into restaurant_suggestions. MUST run AFTER persist_itinerary created
    trip_places/trip_days. Retry-safe (deletes this trip's rows first). Returns rows written.
    `suggest` is injectable (defaults to the real hybrid call). `preference_block` is optional soft
    ranking guidance forwarded to `suggest` (see genagents.restaurant.build_label_input).

    Each grounded restaurant becomes a first-class places row via _find_or_create_restaurant_place,
    deduped by the Mapbox POI's stable mapbox_id (NOT the itinerary flywheel's name+geo, which would
    mis-merge dense chain branches whose LLM English label collides), so restaurant_place_id is
    populated (name + map pin). near_place_id is the day's place nearest the suggestion;
    preference_match_json stays {} until prefs are wired (Step 9).

    No per-day failure isolation: restaurant_suggestions has no status column to record a failed day,
    so a `suggest` failure PROPAGATES and the runner turns it into one clean best-effort warning
    (guardrail #3). Rows written for earlier days are cleared by the delete-first on the next
    idempotent run."""
    if suggest is None:
        from genagents.restaurant import suggest_restaurants as suggest

    # Retry-safe: delete this trip's rows FIRST — before any early return. (trip_days delete only
    # SET-NULLs trip_day_id via the composite FK; it does NOT cascade-delete restaurant_suggestions.)
    await client.table("restaurant_suggestions").delete().eq("trip_id", trip_id).execute()

    tps = (await client.table("trip_places").select("place_id,day_number,sort_order")
           .eq("trip_id", trip_id).execute()).data
    if not tps:
        return 0
    tds = (await client.table("trip_days").select("id,day_number").eq("trip_id", trip_id).execute()).data
    day_to_id = {d["day_number"]: d["id"] for d in tds}
    pids = list({tp["place_id"] for tp in tps})
    places = (await client.table("places").select("id,name,lat,lng,city").in_("id", pids).execute()).data
    by_id = {p["id"]: p for p in places}

    by_day: dict[int, list] = defaultdict(list)
    for tp in tps:
        by_day[tp["day_number"]].append(tp)

    written = 0
    for day_number, rows in by_day.items():
        entries = [by_id[r["place_id"]] for r in rows if r["place_id"] in by_id]
        entries = [p for p in entries if p.get("lat") is not None and p.get("lng") is not None]
        if not entries:
            continue
        trip_day_id = day_to_id.get(day_number)
        day_places = [(p["name"], p["lat"], p["lng"]) for p in entries]
        anchors = [(p["id"], p["lat"], p["lng"]) for p in entries]
        city = next((p.get("city") for p in entries if p.get("city")), None)
        candidates = await suggest(day_places, city=city, preference_block=preference_block)   # a failure here propagates -> runner warns
        for cand in candidates:
            restaurant_place_id = await _find_or_create_restaurant_place(client, cand, city)
            await client.table("restaurant_suggestions").insert({
                "trip_id": trip_id,
                "trip_day_id": trip_day_id,
                "restaurant_place_id": restaurant_place_id,
                "near_place_id": _nearest_place_id(cand.lat, cand.lng, anchors),
                "cuisine": cand.cuisine,
                "summary": cand.summary,
                "source_url": None,                          # Mapbox POIs have no review URL
                "evidence_json": {"source": "mapbox_searchbox", "mapbox_id": cand.mapbox_id,
                                  "categories": cand.categories, "distance_m": cand.distance_m,
                                  "address": cand.address},
                "preference_match_json": {},
            }).execute()
            written += 1
    return written


async def persist_narration(client, trip_id: str, user_id: str, *, narrate=None,
                            preference_block: str | None = None) -> int:
    """Additive: narrate the enriched trip (per-day title/summary + trip title/summary) and UPDATE the
    persisted rows. MUST run AFTER persist_itinerary (+ ideally weather/transport/restaurant so it can
    narrate them). Idempotent UPDATE-in-place (a re-run overwrites; no delete-first). Returns the
    count of days narrated. `narrate` is injectable (defaults to the real LLM call).
    `preference_block` is optional prose-only tone guidance forwarded to `narrate` (see
    genagents.narrator.build_narrator_input).

    Structured-only (guardrail #11): the agent sees only persisted place names/types + weather, never
    raw reel text. Additive prose ONLY — it never re-clusters or reorders days/places."""
    if narrate is None:
        from genagents.narrator import narrate_trip as narrate

    tps = (await client.table("trip_places").select("place_id,day_number,sort_order")
           .eq("trip_id", trip_id).execute()).data
    if not tps:
        return 0
    tds = (await client.table("trip_days").select("day_number,day_date,weather_summary")
           .eq("trip_id", trip_id).execute()).data
    pids = list({tp["place_id"] for tp in tps})
    places = (await client.table("places").select("id,name,place_type,city").in_("id", pids).execute()).data
    by_id = {p["id"]: p for p in places}

    by_day: dict[int, list] = defaultdict(list)
    for tp in tps:
        by_day[tp["day_number"]].append(tp)
    day_meta = {d["day_number"]: d for d in tds}
    city = next((p.get("city") for p in places if p.get("city")), None)

    days_input: list[dict] = []
    for day_number in sorted(day_meta):
        rows = sorted(by_day.get(day_number, []),
                      key=lambda r: r["sort_order"] if r["sort_order"] is not None else 0)
        stops = [{"name": by_id[r["place_id"]]["name"], "place_type": by_id[r["place_id"]].get("place_type")}
                 for r in rows if r["place_id"] in by_id]
        meta = day_meta[day_number]
        days_input.append({"day_number": day_number, "day_date": meta.get("day_date"),
                           "weather_summary": meta.get("weather_summary"), "places": stops})

    result = await narrate(days_input, city=city, preference_block=preference_block)

    written = 0
    for d in result.days:
        await client.table("trip_days").update({"title": d.title, "summary": d.summary}) \
            .eq("trip_id", trip_id).eq("day_number", d.day_number).execute()
        written += 1
    trip_patch: dict = {}
    if result.trip_title:
        trip_patch["title"] = result.trip_title
    if result.trip_summary:
        trip_patch["summary"] = result.trip_summary
    if trip_patch:
        # Owner check (guardrail #6): service_role bypasses RLS, so filter on id AND user_id — this is
        # the persist layer's only direct trips write; mirrors runner._set_status.
        await client.table("trips").update(trip_patch).eq("id", trip_id).eq("user_id", user_id).execute()
    return written


def _hotel_rooms(adult_count, room_count) -> list[str]:
    """Occupancy -> Travala `rooms` param (adults-only v1; child ages aren't stored). Split adults
    across rooms, clamp to Travala's 8-room max. Defaults (1 adult/1 room) -> ["1"]."""
    adults = max(1, adult_count or 1)
    n = max(1, min(room_count or 1, 8))
    per = max(1, round(adults / n))
    return [str(per)] * n


def _hotel_star(star) -> float | None:
    """star_rating CHECK is `null OR 0..5`. Coerce to float; out-of-range/unparseable -> None
    (star=0 is legal / unrated)."""
    try:
        s = float(star)
    except (TypeError, ValueError):
        return None
    return s if 0 <= s <= 5 else None


async def persist_hotels(client, trip_id: str, *, fetch=None) -> int:
    """Additive: search Travala for hotels for THIS trip (destination + dates + occupancy) and INSERT
    into hotel_suggestions. Per-TRIP (one search), NOT per-day. Retry-safe (delete-first). Returns
    rows written. `fetch` is injectable (defaults to the real keyless Travala call).

    Reads the trip row for dates/occupancy and derives the search city from the persisted places'
    city ("Tokyo"), falling back to destination_hint. Skip-on-missing (PRD/DECISIONS LOG): if location
    or dates are missing, return 0 WITHOUT searching — hotel search must never block trip generation.
    base_place_id stays NULL (Travala returns no coords; place-linking deferred). No LLM, no reel
    content. A `fetch` failure propagates -> the runner turns it into one clean warning."""
    if fetch is None:
        from genagents.hotel import search_hotels as fetch

    # Retry-safe: clear this trip's rows FIRST (trip_days delete only SET-NULLs trip_day_id).
    await client.table("hotel_suggestions").delete().eq("trip_id", trip_id).execute()

    trip_rows = (await client.table("trips")
                 .select("start_date,end_date,adult_count,room_count,destination_hint")
                 .eq("id", trip_id).execute()).data
    trip = trip_rows[0] if trip_rows else None   # not .maybe_single() — the offline test fake lacks it
    if not trip:
        return 0
    start_date, end_date = trip.get("start_date"), trip.get("end_date")

    # Location: prefer a persisted place's city ("Tokyo"), fall back to destination_hint ("Japan").
    tps = (await client.table("trip_places").select("place_id").eq("trip_id", trip_id).execute()).data
    location = None
    if tps:
        pids = list({tp["place_id"] for tp in tps})
        places = (await client.table("places").select("city").in_("id", pids).execute()).data
        location = next((p.get("city") for p in places if p.get("city")), None)
    location = location or trip.get("destination_hint")

    if not location or not start_date or not end_date:
        return 0   # skip gracefully — never block trip generation

    check_out = end_date
    if end_date <= start_date:   # single-day trip -> force >=1 night (Travala rejects 0 nights)
        check_out = (_dt.date.fromisoformat(start_date) + _dt.timedelta(days=1)).isoformat()
    rooms = _hotel_rooms(trip.get("adult_count"), trip.get("room_count"))

    session_id, hotels = await fetch(location, start_date, check_out, rooms)   # failure -> runner warns

    written = 0
    for h in hotels:
        name = h.get("name")
        if not name:
            continue   # hotel_suggestions.name is NOT NULL
        await client.table("hotel_suggestions").insert({
            "trip_id": trip_id,
            "base_place_id": None,            # Travala gives no coords; place-linking deferred
            "name": name,
            "area": h.get("headline") or h.get("address") or h.get("location"),
            "star_rating": _hotel_star(h.get("star")),
            "price_snapshot": {"pricePerNight": h.get("pricePerNight"),
                               "totalPrice": h.get("totalPrice"), "currency": h.get("currency")},
            "travala_hotel_id": str(h["hotelId"]) if h.get("hotelId") is not None else None,
            "travala_session_id": session_id,
            "travala_package_id": h.get("packageId"),
            "travala_result_json": h,
            "source": "travala",
            "status": "suggested",
        }).execute()
        written += 1
    return written


def _dump(items) -> list[dict]:
    return [it.model_dump() if hasattr(it, "model_dump") else dict(it) for it in (items or [])]


async def persist_tradeoffs(client, trip_id: str, user_id: str, *, notes, comparisons) -> None:
    """Additive, owner-checked (guardrail #6): write the FULL tradeoffs object in ONE update.

    Deliberately NO read-modify-write — a transient read failure must never erase a sibling
    field. The runner computes notes before the enrich gather and comparisons after it, then
    calls this ONCE with both. Best-effort is the caller's responsibility (guardrail #3)."""
    payload = {"notes": _dump(notes), "comparisons": _dump(comparisons)}
    await client.table("trips").update({"tradeoffs": payload}) \
        .eq("id", trip_id).eq("user_id", user_id).execute()
