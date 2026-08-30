"""Resolve a user-requested place NAME to a provider-verified coordinate (WebMCP `add_place`).

Guardrail #1 in the one place it was still inverted. When `add_place` could not match a name to a
place the trip already knew, it asked the AGENT for lat/lng — and stored whatever came back. A model
reciting a landmark's coordinates from memory is exactly the hallucinated place the guardrail exists
to stop, and we were trusting it MORE than our own geocoder. This module makes Mapbox the resolver
of record for that path; asking the agent survives only as the LAST resort.

COST — a paid call is the third thing tried, never the first. Mapbox forward geocoding bills the
permanent (storable-results) tier at $5/1,000 with no free tier, so `main.add_trip_place` runs the
FREE local reuse first (`_find_requested_place_coordinates`: an exact-name `places` row that shares
this trip's city or country) and only geocodes on a miss. The write-through half closes the loop:
`_find_or_create_place` persists the resolved coordinate — and the country this module recovered —
into `places` BEFORE the 201 returns (Guardrail #7), so the next add of the same name on any trip in
that country reads it back for free. `places` IS the cache for this path.

The hotel identity cache (`geocode.cache.resolve_cached`) is deliberately NOT reused: its key is a
Travala hotel id (`identity_key` RAISES without one), its table is hotel-shaped down to the
`name_fingerprint` column, and its docstring scopes it to `persist_hotels`. A user-requested place
has no such identity, and giving it one would mean writing non-hotel rows into a hotel table.

WRONG > MISSING. A coordinate in the wrong country is worse than no coordinate, so a result is
trusted only after `accept_geocode` can positively verify it against the trip: same country, and
within `MAX_TRIP_DISTANCE_M` of one of the trip's existing stops. A result nothing can check is
rejected. A rejection, a provider miss, a timeout and a provider fault all end identically — the
caller falls back to asking the agent, which still works.

`strict_forward_geocode` (not the lenient `forward_geocode`) is the entry point: the lenient one
returns None for BOTH "no such place" and "malformed 2xx body", so a broken provider is
indistinguishable from a genuine miss; and only the strict one backfills `country_code` from the
pinned `country` filter, which the country half of the gate needs in order to run at all.

Import discipline (Guardrail #9): nothing heavy at module scope — `geocode.mapbox_forward` (httpx)
is imported INSIDE the call, so `import geocode.requested_place` needs no key and makes no call.
Pure and deterministic apart from the injected provider call; the offline eval never reaches here.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Awaitable, Callable, Iterable

from geocode.policy import query_language
from models.geocode import GeocodeResult
from pipeline.geo import haversine_m

logger = logging.getLogger(__name__)

# Search Box feature types. A user adds a landmark, not a street address, and the reel-place path
# pins the same value — widening this trades a miss (safe: we ask) for a wrong pin (not safe).
GEOCODE_TYPES = "poi"

# The add is a hot-path, user-approved action: bound the provider rather than hold the request open.
GEOCODE_TIMEOUT_S: float = 6.0
# Hard deadline slack over the provider's own per-request timeout, in case an injected/odd client
# does not honour it. Both are module constants so a test can shrink the bound without sleeping.
GEOCODE_DEADLINE_SLACK_S: float = 1.0

# How far from the trip's NEAREST existing stop a result may sit and still be believed. Sized to
# accept a real second city on a multi-city trip (Osaka->Tokyo is ~400 km) while rejecting a
# same-name venue an archipelago away (Osaka->Sapporo is ~1,000 km).
MAX_TRIP_DISTANCE_M = 500_000.0


@dataclass(frozen=True, slots=True)
class TripGeoContext:
    """Everything one trip's existing places say about WHERE the trip is.

    Read once per add and shared by both resolution steps: `cities`/`countries` gate the free
    local-name reuse, `country_codes`/`coordinates` bias and then verify the paid geocode.
    Frozen — the route never mutates it.
    """

    cities: frozenset[str] = frozenset()
    countries: frozenset[str] = frozenset()
    country_codes: frozenset[str] = frozenset()
    coordinates: tuple[tuple[float, float], ...] = ()

    @property
    def has_bias(self) -> bool:
        """True when the trip can steer a geocode at all. Without a country AND without a
        coordinate, `accept_geocode` could never verify the answer, so we never make the call."""
        return bool(self.country_codes or self.coordinates)


EMPTY_TRIP_GEO_CONTEXT = TripGeoContext()


def _coordinate(value: object) -> float | None:
    """A real numeric coordinate, or None. `bool` is an `int` subclass — reject it explicitly."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def build_trip_geo_context(rows: Iterable[dict]) -> TripGeoContext:
    """Fold this trip's `places` rows into the trip's geographic context. Pure.

    Cities/countries are casefolded for the exact-name gate; country codes are upcased to the
    `^[A-Z]{2}$` shape the `places` CHECK and every downstream consumer assume, and anything that
    is not alpha-2 is dropped rather than passed on as a bogus filter.
    """
    cities: set[str] = set()
    countries: set[str] = set()
    country_codes: set[str] = set()
    coordinates: list[tuple[float, float]] = []
    for row in rows:
        city = str(row.get("city") or "").strip()
        if city:
            cities.add(city.casefold())
        country = str(row.get("country") or "").strip()
        if country:
            countries.add(country.casefold())
        code = str(row.get("country_code") or "").strip().upper()
        if len(code) == 2 and code.isalpha():
            country_codes.add(code)
        lat, lng = _coordinate(row.get("lat")), _coordinate(row.get("lng"))
        if lat is not None and lng is not None:
            coordinates.append((lat, lng))
    return TripGeoContext(
        cities=frozenset(cities),
        countries=frozenset(countries),
        country_codes=frozenset(country_codes),
        # Sorted so the centroid and every log line are reproducible for a given trip.
        coordinates=tuple(sorted(coordinates)),
    )


def country_filter(context: TripGeoContext) -> str | None:
    """The Mapbox `country` filter for this trip: its single ISO alpha-2 code, or None.

    Mapbox accepts a comma-separated list, but `strict_forward_geocode` backfills a MISSING
    `country_code` straight from this parameter — a joined "JP,KR" would be written into a field
    every consumer expects to match `^[A-Z]{2}$`. A multi-country trip therefore geocodes
    unfiltered and leans on proximity plus `accept_geocode` instead.
    """
    if len(context.country_codes) != 1:
        return None
    return next(iter(context.country_codes)).lower()


def proximity_bias(context: TripGeoContext) -> tuple[float, float] | None:
    """The trip centroid as Mapbox's (lng, lat) bias point, or None with no coordinates.

    This is what makes an ambiguous name ("Chinatown", "Central Park") resolve near the trip
    rather than anywhere on earth. Mapbox orders this pair lng-first — do NOT swap.
    """
    if not context.coordinates:
        return None
    count = len(context.coordinates)
    lat = sum(lat for lat, _ in context.coordinates) / count
    lng = sum(lng for _, lng in context.coordinates) / count
    return (lng, lat)


def accept_geocode(result: GeocodeResult, context: TripGeoContext) -> bool:
    """True only when the trip can POSITIVELY verify this coordinate. Pure.

    Two gates, and at least one of them must actually have run: a result in a country the trip
    does not visit is rejected, and so is one farther than `MAX_TRIP_DISTANCE_M` from every stop
    the trip already has. A result neither gate could evaluate is rejected too — an unverifiable
    coordinate is exactly the model-asserted pin this whole path exists to stop, and falling back
    to asking the agent still works.
    """
    checked = False
    code = (result.country_code or "").strip().upper()
    if context.country_codes and code:
        checked = True
        if code not in context.country_codes:
            return False
    if context.coordinates:
        checked = True
        nearest = min(
            haversine_m(result.lat, result.lng, lat, lng) for lat, lng in context.coordinates
        )
        if nearest > MAX_TRIP_DISTANCE_M:
            return False
    return checked


async def geocode_requested_place(
    name: str,
    context: TripGeoContext,
    *,
    token: str | None,
    geocode: Callable[..., Awaitable[GeocodeResult | None]] | None = None,
    timeout_s: float | None = None,
) -> GeocodeResult | None:
    """One bounded, trip-biased, provider-verified lookup — or None, meaning "ask the agent".

    Returns None WITHOUT spending anything when there is no name, no token, or no trip bias to
    steer and check the answer with. Otherwise makes exactly one paid Search Box call and returns
    its result only if `accept_geocode` verifies it.

    Every failure mode collapses to None on purpose: a miss, a rejected result, a timeout, a
    non-2xx and a malformed body all leave the caller in the same place (ask for lat/lng), and an
    add that would otherwise 500 on a provider blip instead completes. Only the exception TYPE is
    logged — a Mapbox message can carry the URL, and the token rides in the query string.
    """
    query = name.strip()
    if not query or not token or not context.has_bias:
        return None

    resolver = geocode
    if resolver is None:
        # Lazy: keeps httpx (and the token-bearing module) off the import path of `main`.
        from geocode.mapbox_forward import strict_forward_geocode

        resolver = strict_forward_geocode

    timeout = GEOCODE_TIMEOUT_S if timeout_s is None else timeout_s
    try:
        result = await asyncio.wait_for(
            resolver(
                query,
                token=token,
                proximity_lng_lat=proximity_bias(context),
                country=country_filter(context),
                language=query_language(query),
                types=GEOCODE_TYPES,
                timeout_s=timeout,
            ),
            timeout=timeout + GEOCODE_DEADLINE_SLACK_S,
        )
    except Exception as exc:
        # Type only (token safety). TimeoutError, ResolveError and any provider/parse fault alike:
        # the add falls back to asking rather than failing.
        logger.warning("requested_place_geocode_failed error=%s", type(exc).__name__)
        return None

    if result is None:
        return None
    if not accept_geocode(result, context):
        logger.info("requested_place_geocode_rejected reason=outside_trip_context")
        return None
    return result
