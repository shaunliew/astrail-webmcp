"""Transport enrich agent — Mapbox Directions per-day route legs. Direct HTTP, no LLM,
no Agents SDK (structured API data, not untrusted reel content). Import-keyless: the
token is read and the httpx client built inside the function, never at module scope.
Live-only — never imported by the offline eval / offline_harness.
"""
from __future__ import annotations

import os

import httpx

_BASE = "https://api.mapbox.com/directions/v5/mapbox"
_PROFILE_TO_MODE = {"walking": "walk", "driving": "drive", "driving-traffic": "drive", "cycling": "cycle"}
# The exact profile strings the transport_legs.routing_profile CHECK allows.
VALID_PROFILES = frozenset(_PROFILE_TO_MODE)

# WGS84 bounds. A coordinate outside these is not a place on Earth.
_LNG_MIN, _LNG_MAX = -180.0, 180.0
_LAT_MIN, _LAT_MAX = -90.0, 90.0


def profile_to_mode(profile: str) -> str:
    """Map a Mapbox routing profile → the transport_legs.transport_mode CHECK value."""
    return _PROFILE_TO_MODE.get(profile, "unknown")


def _clean_coord(pt) -> tuple[float, float] | None:
    """One coordinate → validated (lng, lat), or None.

    The container check is load-bearing, not defensive: a 2-key dict unpacks its KEYS, so
    `{1: 'x', 2: 'y'}` would yield a valid-looking (1.0, 2.0) without it (verified by execution).
    NaN/inf need no separate test — every comparison against NaN is False, so the bounds check
    below rejects them. A `math.isfinite` call would be dead code no test could redden.
    """
    if not isinstance(pt, (list, tuple)) or len(pt) != 2:
        return None
    lng, lat = pt
    for v in (lng, lat):
        if isinstance(v, bool) or not isinstance(v, (int, float)):   # bool is an int subclass
            return None
    if not (_LNG_MIN <= lng <= _LNG_MAX and _LAT_MIN <= lat <= _LAT_MAX):
        return None
    return float(lng), float(lat)


def is_drawable_linestring(obj) -> bool:
    """D1's strict receipt, as ONE predicate. Public — FOUR call sites depend on it:

      1. `_leg_geometry`'s return gate (producer),
      2. `persist_transport`'s storage boundary (`fetch_legs` is injectable, so a future or
         test provider could hand us anything),
      3. `scripts/live_run.py`'s acceptance check (the smoke must judge by the same rule it
         claims to verify),
      4. `scripts/live_run.py`'s per-leg point-count print (so the count can never contradict
         the acceptance verdict printed beneath it).

    Each call site needs its OWN sentinel-spy test, and every such spy must CONTROL, not merely
    OBSERVE. Asserting "the predicate was called with X" is satisfied by:

        is_drawable_linestring(geom)          # spy sees the exact argument; result DISCARDED
        valid = local_weaker_validator(geom)  # production actually decides here

    So every consumer spy must: feed an otherwise-DRAWABLE geometry, force the spy to return
    False, and assert the PRODUCTION OUTCOME FLIPPED. A spy that cannot change the result cannot
    prove the result depends on it.

    Total: never raises, for any input.
    """
    if not isinstance(obj, dict) or obj.get("type") != "LineString":
        return False
    coords = obj.get("coordinates")
    # isinstance ONLY — no length check. The distinctness test below SUBSUMES it, verified by
    # execution: `any(...)` over an empty list is False, and over a single point compares it to
    # itself → False. A `len(coords) < 2` guard would be dead code no test could redden, the same
    # trap `math.isfinite` fell into. Removing it also makes the singleton, empty and
    # all-identical tests all attributable — to DISTINCTNESS, which is the one guard that
    # actually produces their result. The isinstance check IS load-bearing: a tuple
    # `([1,2],[3,4])` otherwise passes.
    if not isinstance(coords, list):
        return False
    # Compare NORMALIZED points, never the raw containers. `[[1,2], (1,2)]` compares unequal in
    # Python (list != tuple) but both serialize to `[1,2]`, so a raw comparison would accept a
    # physically all-identical, undrawable line — and because this predicate is shared, that one
    # false positive would pass the producer, the storage boundary AND the smoke.
    cleaned = [_clean_coord(pt) for pt in coords]
    if any(c is None for c in cleaned):
        return False
    # Written as an `if`-guard, NOT `return any(...)`, so that the prescribed fault injection
    # ("delete the guard") is actually executable. Deleting a trailing `return any(...)` makes the
    # function fall off the end and return None — which REJECTS everything, so the singleton and
    # all-identical tests would stay green and prove nothing. Deleting the two lines below instead
    # makes the predicate ACCEPT a 1-point line, which is the mutation the tests actually name.
    if not any(c != cleaned[0] for c in cleaned):     # empty, singleton, or all-identical
        return False
    return True


def _leg_geometry(leg) -> dict | None:
    """Concatenate ONE Directions leg's step geometries into a GeoJSON LineString.

    TOTALITY IS LOAD-BEARING, AND IS CHECKED WITH isinstance, NOT `or []`. `or []` is a
    TRUTHINESS guard: `{"steps": 1}` yields `1`, and `for step in 1` raises TypeError. A raise
    here is caught by persist_transport's per-day `except`, which marks the WHOLE DAY failed and
    discards duration/distance Mapbox returned successfully — violating D1.

    NO PARTIAL RESULTS. A step whose `coordinates` is missing or EMPTY voids the leg; skipping it
    would return earlier steps' points as though the leg were complete — a non-NULL,
    plausible-looking polyline ending in the wrong place.

    `code == "Ok"` is the caller's gate; this is the shape gate.
    """
    if not isinstance(leg, dict):
        return None
    steps = leg.get("steps")
    # isinstance ONLY — no `not steps`. An empty list needs no guard: the loop runs zero times and
    # the final predicate rejects it anyway, so a `not steps` check would be unprovable.
    if not isinstance(steps, list):
        return None
    coords: list[list[float]] = []
    for step in steps:
        if not isinstance(step, dict):
            return None
        geometry = step.get("geometry")
        if not isinstance(geometry, dict):
            return None
        pts = geometry.get("coordinates")
        if not isinstance(pts, list) or not pts:      # empty → void, never truncate
            return None
        for pt in pts:
            cleaned = _clean_coord(pt)
            if cleaned is None:
                return None                            # one bad point voids the leg
            point = [cleaned[0], cleaned[1]]
            if coords and coords[-1] == point:         # collapse consecutive duplicates
                continue
            coords.append(point)
    out = {"type": "LineString", "coordinates": coords}
    return out if is_drawable_linestring(out) else None


async def fetch_directions_legs(coords, *, profile: str = "walking",
                                client: httpx.AsyncClient | None = None) -> list[dict]:
    """ONE Mapbox Directions call for a day's ordered `(lat, lng)` stops. Returns one
    {'duration_s','distance_m','code','geometry'} per consecutive leg (len == len(coords)-1),
    or [] if <2 stops. 'geometry' is a drawable GeoJSON LineString or None — never a partial
    or malformed one. A non-'Ok' top-level code (NoRoute/NoSegment) yields no-route legs (null
    metrics) rather than raising. Raises a SANITIZED RuntimeError on a non-2xx — never
    surfaces the URL/token (raise_for_status would leak the token in the query string)."""
    if len(coords) < 2:
        return []
    token = os.environ["MAPBOX_SECRET_TOKEN"]                 # KeyError if unset → caller isolates it
    path = ";".join(f"{lng},{lat}" for lat, lng in coords)   # Mapbox wants lng,lat
    url = f"{_BASE}/{profile}/{path}"
    owns = client is None
    http = client or httpx.AsyncClient(timeout=30)
    try:
        resp = await http.get(url, params={
            "access_token": token,
            "steps": "true",          # per-leg geometry lives in legs[i].steps[j].geometry
            "geometries": "geojson",  # → {"type":"LineString","coordinates":[[lng,lat],…]}
            "overview": "false",      # route-level polyline is dead weight
        })
    except httpx.RequestError as exc:
        # A ConnectError/timeout str() includes the request URL (which carries the token) —
        # re-raise sanitized, dropping the original context (mirror geocode/mapbox_forward.py).
        raise RuntimeError(f"Mapbox Directions request failed: {type(exc).__name__}") from None
    finally:
        if owns:
            await http.aclose()
    if resp.status_code != 200:
        raise RuntimeError(f"Mapbox Directions failed: HTTP {resp.status_code}")   # no url/token
    data = resp.json()
    n_legs = len(coords) - 1
    if data.get("code") != "Ok" or not data.get("routes"):
        code = data.get("code", "NoRoute")
        return [{"duration_s": None, "distance_m": None, "code": code, "geometry": None}
                for _ in range(n_legs)]
    legs = data["routes"][0].get("legs", [])
    out: list[dict] = []
    for leg in legs:
        dur, dist = leg.get("duration"), leg.get("distance")
        out.append({
            "duration_s": round(dur) if dur is not None else None,
            "distance_m": round(dist) if dist is not None else None,
            "code": "Ok",
            "geometry": _leg_geometry(leg),
        })
    return out
