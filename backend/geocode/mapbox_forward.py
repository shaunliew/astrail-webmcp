"""Mapbox Search Box /forward geocoder → GeocodeResult; pure apply_geocode transform.

Endpoint: https://api.mapbox.com/search/searchbox/v1/forward
Params: q, language, country, types="poi", limit=1, proximity="{lng},{lat}", access_token

TOKEN SAFETY: access_token travels in the query string — the Mapbox Search Box API
has no header-auth alternative, so the token MUST be a query param. This module
never logs request URLs and raises only sanitized errors; do NOT enable httpx
request-logging / APM URL capture / a logging event-hook on an injected client,
or the token would be captured externally.
- NEVER call resp.raise_for_status() — its message embeds the full URL + token.
- Check resp.status_code manually and raise a sanitized RuntimeError.
- Catch httpx.RequestError and re-raise a sanitized RuntimeError — never let
  an httpx message (URL-bearing) escape this module.

Only called by the capture command with MAPBOX_SECRET_TOKEN present.
Unit tests inject httpx.MockTransport — no network, no key required.
"""
from __future__ import annotations

import httpx
from pydantic import ValidationError

from geocode.errors import ResolveError
from models.geocode import GeocodeResult
from models.place import PlaceResult

# (lng, lat) — Tokyo Station; used as the /forward proximity default for Japan queries.
TOKYO: tuple[float, float] = (139.7671, 35.6812)

_FORWARD_URL = "https://api.mapbox.com/search/searchbox/v1/forward"


def parse_forward_response(data: dict) -> GeocodeResult | None:
    """Parse a Mapbox Search Box GeoJSON FeatureCollection → GeocodeResult or None.

    geometry.coordinates is [lng, lat] (GeoJSON lon-first convention):
      coordinates[0] → lng
      coordinates[1] → lat
    Do NOT swap.

    Returns None for any missing/malformed shape (empty features, null geometry,
    non-list or non-numeric coordinates, out-of-range coords) — a bad response is
    a miss, never a crash.
    """
    if not isinstance(data, dict):
        return None
    features = data.get("features")
    if not isinstance(features, list) or not features:
        return None
    feature = features[0]
    if not isinstance(feature, dict):
        return None
    geometry = feature.get("geometry")
    if not isinstance(geometry, dict):  # also covers geometry: null
        return None
    coords = geometry.get("coordinates")
    if not isinstance(coords, (list, tuple)) or len(coords) < 2:
        return None
    lng, lat = coords[0], coords[1]
    # bool is an int subclass — reject it; coords must be real numbers, not strings.
    if isinstance(lng, bool) or isinstance(lat, bool):
        return None
    if not isinstance(lng, (int, float)) or not isinstance(lat, (int, float)):
        return None
    props = feature.get("properties")
    if not isinstance(props, dict):
        props = {}
    name: str | None = props.get("name")
    # full_address is the primary field; fall back to place_formatted (also seen in docs).
    formatted_address: str | None = props.get("full_address") or props.get("place_formatted")
    mapbox_id: str | None = props.get("mapbox_id")
    # Structured identity signals Search Box returns and we already pay for (plan decision #2c/#7).
    # feature_type: "poi" | "address" | …; poi_category: a list of strings ["lodging", "hotel"]
    # (empty for address-type results). Kept purely so the hotel identity gate can read them; a
    # malformed / non-list poi_category degrades to [] (never a crash).
    raw_feature_type = props.get("feature_type")
    feature_type: str | None = raw_feature_type if isinstance(raw_feature_type, str) else None
    raw_poi_category = props.get("poi_category")
    poi_category: list[str] = (
        [c for c in raw_poi_category if isinstance(c, str)]
        if isinstance(raw_poi_category, list)
        else []
    )
    country_code = country_name = None
    context = props.get("context") or feature.get("context") or []
    if isinstance(context, dict):
        # Search Box returns context as a keyed object in live responses
        # (country: {country_code, name}), while older fixtures use a list of
        # {id, short_code, text} entries.
        country = context.get("country")
        if isinstance(country, dict):
            country_code = country.get("country_code") or country.get("short_code")
            country_name = country.get("name") or country.get("text")
        context = list(context.values())
    if isinstance(context, list):
        for entry in context:
            if not isinstance(entry, dict) or not str(entry.get("id", "")).startswith("country"):
                continue
            country_code = entry.get("short_code") or entry.get("shortCode")
            country_name = entry.get("text") or entry.get("name")
            break
    try:
        return GeocodeResult(
            lat=lat,
            lng=lng,
            name=name,
            formatted_address=formatted_address,
            mapbox_id=mapbox_id,
            country_code=country_code,
            country_name=country_name,
            feature_type=feature_type,
            poi_category=poi_category,
        )
    except ValidationError:
        return None  # out-of-range coords from a bad response → miss


async def _forward_fetch(
    query: str,
    *,
    token: str,
    proximity_lng_lat: tuple[float, float] | None,
    country: str | None,
    language: str,
    types: str,
    client: httpx.AsyncClient | None,
    timeout_s: int,
) -> httpx.Response:
    """Build params + GET Mapbox Search Box /forward, returning the raw response.

    Shared by the lenient `forward_geocode` and the strict `strict_forward_geocode` so both build
    the SAME request and honour the same token-safety rules. Raises a sanitized RuntimeError on a
    network error (the httpx message embeds the URL+token, so it is never surfaced). The caller
    inspects `resp.status_code` itself — never `raise_for_status()` (it embeds the URL+token).
    """
    params = {
        "q": query,
        "language": language,
        "types": types,
        "limit": 1,
        "access_token": token,
    }
    if proximity_lng_lat is not None:
        lng, lat = proximity_lng_lat
        params["proximity"] = f"{lng},{lat}"
    if country:
        params["country"] = country

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    try:
        # Pass timeout per-request so the contract holds even for an injected client.
        return await http.get(_FORWARD_URL, params=params, timeout=timeout_s)
    except httpx.RequestError as exc:
        # Sanitize: re-raise without the original message (which contains the URL+token).
        raise RuntimeError(
            f"Mapbox forward error for {query!r}: {type(exc).__name__}"
        ) from None
    finally:
        if owns_client:
            await http.aclose()


async def forward_geocode(
    query: str,
    *,
    token: str,
    proximity_lng_lat: tuple[float, float] | None = TOKYO,
    country: str | None = "jp",
    language: str = "en",
    types: str = "poi",
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 15,
) -> GeocodeResult | None:
    """GET Mapbox Search Box /forward → GeocodeResult or None on a miss (LENIENT).

    On success (2xx + at least one feature), returns a GeocodeResult.
    On a 2xx with no features OR a malformed 2xx body/shape (miss), returns None without raising.
    On a non-2xx or network error, raises RuntimeError with a sanitized message
    that never contains the token. Used by the capture CLI + the current reel-place path — its
    miss/None-swallowing behaviour is FROZEN; the hotel path uses `strict_forward_geocode` instead.

    Args:
        query: Place name string to geocode.
        token: Mapbox secret token (sk.*, Search Box scope). Never logged.
        proximity_lng_lat: (lng, lat) bias point — defaults to Tokyo Station.
        country: ISO-3166-1 alpha-2 country filter (default "jp").
        language: BCP-47 language for results (default "en").
        client: Optional injected httpx.AsyncClient (for testing / connection reuse).
        timeout_s: Request timeout in seconds.
    """
    resp = await _forward_fetch(
        query, token=token, proximity_lng_lat=proximity_lng_lat, country=country,
        language=language, types=types, client=client, timeout_s=timeout_s,
    )
    # Manual status check — never call resp.raise_for_status() (embeds URL+token).
    if resp.status_code // 100 != 2:
        raise RuntimeError(
            f"Mapbox forward failed for {query!r} (HTTP {resp.status_code})"
        )
    try:
        payload = resp.json()
    except ValueError:
        return None  # malformed 2xx body (non-JSON / proxy HTML) → treat as a miss
    return parse_forward_response(payload)


def _strict_parse_forward(data: object) -> GeocodeResult | None:
    """Strict parse for the hotel path (plan decision #7): distinguish a VALID-EMPTY response
    (a genuine geocode miss) from a MALFORMED one (an infra fault).

      * a well-formed FeatureCollection with `features == []`  → None  (cacheable miss)
      * a well-formed feature                                  → GeocodeResult
      * anything else (not a dict, features not a list, or a non-empty response whose first
        feature has a broken geometry / non-numeric / out-of-range coords) → ResolveError

    This is the piece the lenient `parse_forward_response` deliberately does NOT do: it returns
    None for BOTH empty AND malformed, which the cache would wrongly negative-cache as a miss.
    """
    if not isinstance(data, dict):
        raise ResolveError("Mapbox forward: malformed response (not an object)")
    features = data.get("features")
    if not isinstance(features, list):
        raise ResolveError("Mapbox forward: malformed response (features not a list)")
    if not features:
        return None  # valid FeatureCollection, no hits → a genuine miss
    result = parse_forward_response(data)
    if result is None:
        # features present but the first feature is malformed / out-of-range → infra fault, not a miss
        raise ResolveError("Mapbox forward: malformed feature in a non-empty response")
    return result


async def strict_forward_geocode(
    query: str,
    *,
    token: str,
    proximity_lng_lat: tuple[float, float] | None = TOKYO,
    country: str | None = "jp",
    language: str = "en",
    types: str = "poi",
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 15,
) -> GeocodeResult | None:
    """STRICT Mapbox /forward for the hotel resolver (plan decision #7). Same request as
    `forward_geocode`, but a SHARP failure taxonomy the cache can trust:

      * a valid FeatureCollection with no features → None  (cacheable geocode miss)
      * a valid hit                                → GeocodeResult
      * a network error / non-2xx / malformed-2xx body / malformed feature → ResolveError

    A ResolveError is NEVER cached and NEVER a miss (Guardrail #7 / plan decision #7); it propagates
    so a transient Mapbox outage can't be negative-cached and can't clobber prior hotel rows. Token
    safety is unchanged — the sanitized messages never carry the URL or token.
    """
    try:
        resp = await _forward_fetch(
            query, token=token, proximity_lng_lat=proximity_lng_lat, country=country,
            language=language, types=types, client=client, timeout_s=timeout_s,
        )
    except RuntimeError as exc:
        # A network fault (already sanitized by _forward_fetch) is INFRA, not a miss.
        raise ResolveError(str(exc)) from None
    if resp.status_code // 100 != 2:
        raise ResolveError(f"Mapbox forward failed for {query!r} (HTTP {resp.status_code})")
    try:
        payload = resp.json()
    except ValueError:
        raise ResolveError(f"Mapbox forward: malformed 2xx body for {query!r}") from None
    return _strict_parse_forward(payload)


def apply_geocode(place: PlaceResult, geo: GeocodeResult | None) -> PlaceResult:
    """Immutably override a PlaceResult's coords/address from a Mapbox GeocodeResult.

    On a hit (geo is not None): returns a new PlaceResult with lat + lng from the
    Mapbox result. formatted_address is overridden ONLY when Mapbox actually provides
    one — a hit with no address keeps the place's existing (LLM) address rather than
    deleting it. All other fields are preserved.
    On a miss (geo is None): returns the original place unchanged (LLM coords kept).

    This is a pure function — no mutation of the input place.
    """
    if geo is None:
        return place
    update: dict = {"lat": geo.lat, "lng": geo.lng}
    if geo.formatted_address:
        update["formatted_address"] = geo.formatted_address
    return place.model_copy(update=update)
