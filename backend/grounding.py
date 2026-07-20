"""Grounding a researched place against Mapbox, and persisting the canonical `places` row.

Split out of `organizer.py` in B6, which had grown past the 800-line ceiling. The seam is
concern, not size: everything here answers "is this place real, and which canonical row is
it?" — coordinate->country verification, its write-through cache, and dedup-on-write —
while `organizer.py` keeps the durable-job lifecycle (claim, lease, events, counts, recovery).
Nothing here knows about jobs, leases or items; `organizer` depends on this module, never the
reverse.

The dedup half is a THIN CALLER: the reuse rule and the insert live inside
`public.find_or_create_place`, where an advisory lock serializes them (20260720160000, widened
to null-country legacy rows by 20260720180000). What stays here is only the shape of the
call — so a change to how canonical identity is decided belongs in those migrations, not in
this file.

Guardrail #1 lives here: a place with no verified country, no coordinates, or a placeholder
source URL is dropped rather than guessed at.
"""
from __future__ import annotations

import logging
import os

from genagents.place_extractor import is_placeholder_url
from models.geocode import CountryResult
from models.place import PlaceResult
from pipeline.dedup import DEFAULT_DISTANCE_M
from pydantic import ValidationError

LOCATION_VERIFICATION_VERSION = "mapbox-country-v1"
GEOCODE_CACHE_TABLE = "geocode_country_cache"
logger = logging.getLogger(__name__)


def _coord_cache_key(lat: float, lng: float) -> str:
    """Lossless, stable cache key for one coordinate.

    Python's float `repr` is the shortest string that round-trips exactly, so the key is a
    faithful record of the coordinate Mapbox was actually asked about, and it is stable across
    platforms. `+ 0.0` normalizes -0.0 to 0.0 so the two spellings of the same point share a
    row; every other distinct float gets its own row BY DESIGN.

    Do NOT bucket this (an earlier draft used `round(lat * 1e4)`, ~11 m cells). A hit must mean
    Mapbox verified THIS coordinate, not a neighbour: two points ~11 m apart can straddle a
    border, and a cached country that happens to match the extractor's CLAIMED country would
    then pass `_ground_place`'s fail-closed comparison for a coordinate nobody verified.
    Rounding also buys ZERO hit rate — the warm path hits on byte-identical coordinates
    replayed from the extraction cache, not on re-derived ones.
    """
    return f"{lat + 0.0!r},{lng + 0.0!r}"


async def _lookup_cached_country(client, lat: float, lng: float) -> CountryResult | None:
    """The verified country for this exact coordinate at THIS verification version, or None.

    Blip-tolerant on purpose: a read failure is a MISS, never an item failure — the caller
    falls through to the live provider call. The write side (`_store_cached_country`) is the
    opposite, and that asymmetry is the point: a cache is an optimization on the way in and a
    durability guarantee on the way out.
    """
    try:
        result = await (client.table(GEOCODE_CACHE_TABLE)
                        .select("country_code,country_name")
                        .eq("coord_key", _coord_cache_key(lat, lng))
                        .eq("verification_version", LOCATION_VERIFICATION_VERSION)
                        .maybe_single().execute())
    except Exception as exc:
        # Type only — never the exception text, which can carry connection strings.
        logger.warning("geocode_country_cache_read_failed error=%s", type(exc).__name__)
        return None
    row = (result.data if result is not None else None) or {}
    if not row:
        return None
    try:
        return CountryResult(
            country_code=row.get("country_code"), country_name=row.get("country_name")
        )
    except ValidationError:
        return None     # a malformed cached row is a MISS; re-verify rather than trust it


async def _store_cached_country(client, lat: float, lng: float, country: CountryResult) -> None:
    """Persist one verified coordinate→country answer. RAISES on failure, by design.

    Strict write-through (guardrail #7: persist before returning) — we do not hand back a
    verified result we could not persist. `cache_places` at the equivalent seam in
    `_process_item` is likewise unwrapped, so this matches the precedent exactly. Guardrail #3
    bounds the blast radius: one item fails, it is retryable, and the retry reuses the
    extraction cache.
    """
    await client.table(GEOCODE_CACHE_TABLE).upsert({
        "coord_key": _coord_cache_key(lat, lng),
        "verification_version": LOCATION_VERIFICATION_VERSION,
        "country_code": country.country_code,
        "country_name": country.country_name,
    }, on_conflict="coord_key,verification_version").execute()


async def _ground_place(client, place: PlaceResult, *, verify_country=None) -> dict | None:
    """Verify one researched place against Mapbox, reusing a cached answer when we have one.

    Every `reverse_country` call sets `permanent: "true"` — the storable-results tier — and
    this is its only call site, so an uncached warm organize cost exactly as much as a cold
    one and was quota-exempt besides (the daily quota charges on extraction-cache MISS). The
    cache closes both.

    A hit skips ONLY the provider question, which is pure in its inputs: the coordinates come
    from the extraction cache, frozen per `EXTRACTOR_VERSION`. The load-bearing country
    comparison below still runs on EVERY organize, on a cached answer as much as a live one.
    """
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
    country = await _lookup_cached_country(client, place.lat, place.lng)
    if country is None:
        if verify_country is None:
            from geocode.mapbox_reverse import reverse_country
            verify_country = reverse_country
        country = await verify_country(place.lat, place.lng, token=token)
        if country is not None:
            # Only a SUCCESS is cached. A raise never reaches this line, and a `None` — "this
            # coordinate does not verify" — is not an answer worth freezing for every later run.
            await _store_cached_country(client, place.lat, place.lng, country)
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
    # ONE round trip, and the database serializes it (20260720160000). This was a SELECT here
    # and an INSERT there, with no unique key anywhere on `places` to catch what fell between:
    # an expired worker and its replacement both looked, both saw nothing, and both inserted.
    #
    # That is worse than the same select-then-insert deferred in `pipeline/persist.py`. There
    # one trip ends up pointing at one of two rows. Here `places` is the CROSS-TRIP dedup
    # flywheel — the orphan is global and permanent, and every later organize resolves the same
    # venue to an arbitrary one of the duplicates. Fencing the mention row cannot help; it only
    # decides which duplicate gets referenced.
    #
    # The reuse rule lives inside the function: same name, a country that either MATCHES the
    # freshly verified one or is still NULL (ISSUES-B2 — rows predating the country migration,
    # which an equality predicate structurally excludes, so the organizer kept inserting a
    # second canonical row for a venue it already had), inside DEFAULT_DISTANCE_M, repairing the
    # reused row's country labels. Coordinates and never the name license the reuse: the 500 m
    # gate is what stops two different venues sharing a name from being merged, and the country
    # is only ever filled in from the Mapbox-verified result (guardrail #1). It stays a distance
    # gate rather than a unique constraint because no constraint can express "within 500 m" —
    # see 20260720160000 for why an advisory lock is the route and what it does not cover, and
    # 20260720180000 for the null-country widening and the ordering that keeps it deterministic.
    #
    # The insert's omitted `embedding` moved into the function with the rest (ISSUES-B3): it is
    # a decision, not an oversight, and the migration's column list is now where that contract
    # lives. `test_persist_place_omits_embedding_deliberately` is what reddens if it changes.
    return (await client.rpc("find_or_create_place", {
        "p_name": place.name,
        # The local-script name, verbatim from the caption. Persisted since 20260720190000 —
        # before that it lived only for the duration of this run, so a place reused from the
        # canonical table came back without it and re-grounded against its English name, which
        # is what `geocode/policy.py` needs the local name to avoid. Fill-if-null on reuse: the
        # country labels beside it are overwritten because this run re-verified them, and
        # nothing re-verifies this one.
        "p_name_local": place.name_local,
        "p_place_type": place_type,
        "p_lat": place.lat,
        "p_lng": place.lng,
        "p_country": grounded["country_name"],
        "p_country_code": grounded["country_code"],
        "p_country_name": grounded["country_name"],
        "p_city": place.city_or_region_guess,
        "p_max_distance_m": DEFAULT_DISTANCE_M,
    }).execute()).data
