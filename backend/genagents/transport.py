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


def profile_to_mode(profile: str) -> str:
    """Map a Mapbox routing profile → the transport_legs.transport_mode CHECK value."""
    return _PROFILE_TO_MODE.get(profile, "unknown")


async def fetch_directions_legs(coords, *, profile: str = "walking",
                                client: httpx.AsyncClient | None = None) -> list[dict]:
    """ONE Mapbox Directions call for a day's ordered `(lat, lng)` stops. Returns one
    {'duration_s','distance_m','code'} per consecutive leg (len == len(coords)-1), or []
    if <2 stops. A non-'Ok' top-level code (NoRoute/NoSegment) yields no-route legs (null
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
        resp = await http.get(url, params={"access_token": token, "overview": "false"})
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
        return [{"duration_s": None, "distance_m": None, "code": code} for _ in range(n_legs)]
    legs = data["routes"][0].get("legs", [])
    out: list[dict] = []
    for leg in legs:
        dur, dist = leg.get("duration"), leg.get("distance")
        out.append({
            "duration_s": round(dur) if dur is not None else None,
            "distance_m": round(dist) if dist is not None else None,
            "code": "Ok",
        })
    return out
