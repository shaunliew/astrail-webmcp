"""Mapbox Matrix (Directions Matrix) client — many-to-many travel-time/distance matrix.
Direct HTTP, no LLM, no Agents SDK (structured API data, not untrusted reel content).
Import-keyless: the token is read and the httpx client built inside the function, never at
module scope. Live-only — never imported by the offline eval / offline_harness.

Endpoint: https://api.mapbox.com/directions-matrix/v1/mapbox/{profile}/{coordinates}
Coordinates are `lng,lat` pairs joined by ';'. `sources`/`destinations` are 0-based index
arrays into that single coordinate list; the response is row-major, so `durations[i][j]` /
`distances[i][j]` is the ith-source → jth-destination travel time / distance.

TOKEN SAFETY: access_token travels in the query string (Mapbox has no header-auth here). This
module never logs request URLs. On any non-2xx or network error it returns None (honest
degrade — Guardrail #3) instead of raising a URL-bearing exception, so the token can never
leak through an error message or log (mirrors transport.py / mapbox_forward.py). The only
raise is a ValueError for the caller-side over-cap bug — it carries counts, never the token.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import httpx

_BASE = "https://api.mapbox.com/directions-matrix/v1/mapbox"

# The Matrix coordinate cap for the driving/walking/cycling profiles (driving-traffic is 10,
# unused here). sources + destinations share ONE coordinate list, so their COMBINED length is
# what the cap governs.
_MAX_COORDS = 25


@dataclass(frozen=True)
class Matrix:
    """A parsed Mapbox Matrix response (immutable). Row-major: `durations[i][j]` /
    `distances[i][j]` is the source-i → destination-j travel time (seconds) / distance
    (metres). A cell is None when Mapbox reports no route for that pair. A matrix is `[]`
    when its annotation wasn't requested — the caller reads only what it asked for.
    """
    durations: list[list[float | None]]
    distances: list[list[float | None]]


def _clean_matrix(rows) -> list[list[float | None]] | None:
    """Validate a Mapbox matrix (list of numeric/None rows) → cleaned floats, or None if the
    shape is malformed. A None cell (unreachable pair) is preserved; a bool or non-numeric cell
    voids the whole matrix (bool is an int subclass — reject it explicitly, mirroring
    transport._clean_coord). Never raises.
    """
    if not isinstance(rows, list):
        return None
    out: list[list[float | None]] = []
    for row in rows:
        if not isinstance(row, list):
            return None
        cleaned: list[float | None] = []
        for v in row:
            if v is None:
                cleaned.append(None)
            elif isinstance(v, bool) or not isinstance(v, (int, float)):
                return None
            else:
                cleaned.append(float(v))
        out.append(cleaned)
    return out


async def fetch_matrix(
    sources,
    destinations,
    *,
    profile: str = "walking",
    annotations: str = "duration,distance",
    token: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> Matrix | None:
    """ONE Mapbox Matrix call for `sources` × `destinations` `(lat, lng)` points.

    Builds a single coordinate list `sources + destinations` and passes `sources`/`destinations`
    as 0-based index arrays into it, so `Matrix.durations[i][j]` is source-i → destination-j.
    Returns a Matrix on success, or None on any non-2xx / network error / malformed body
    (honest degrade — Guardrail #3). Never raises for a runtime failure and never leaks the
    token (see the module docstring).

    `profile` defaults to "walking" to match `transport.fetch_directions_legs` — a constant,
    easily changed. `token` falls back to os.environ["MAPBOX_SECRET_TOKEN"] (KeyError if unset →
    the caller isolates it, same as transport.py).

    Raises ValueError if len(sources)+len(destinations) exceeds the 25-coordinate Matrix cap — a
    caller bug (the caller must trim to fit before calling), distinct from a runtime degrade.
    """
    n_src, n_dst = len(sources), len(destinations)
    if n_src + n_dst > _MAX_COORDS:
        raise ValueError(
            f"Matrix cap exceeded: {n_src}+{n_dst} coordinates > {_MAX_COORDS}"
        )
    token = token if token is not None else os.environ["MAPBOX_SECRET_TOKEN"]
    coords = list(sources) + list(destinations)
    path = ";".join(f"{lng},{lat}" for lat, lng in coords)   # Mapbox wants lng,lat
    url = f"{_BASE}/{profile}/{path}"
    src_idx = ";".join(str(i) for i in range(n_src))
    dst_idx = ";".join(str(i) for i in range(n_src, n_src + n_dst))
    owns = client is None
    http = client or httpx.AsyncClient(timeout=30)
    try:
        resp = await http.get(url, params={
            "access_token": token,
            "sources": src_idx,
            "destinations": dst_idx,
            "annotations": annotations,
        })
    except httpx.RequestError:
        # A ConnectError/timeout str() carries the request URL (with the token). Degrade to None
        # WITHOUT re-raising, so nothing token-bearing is ever constructed or logged.
        return None
    finally:
        if owns:
            await http.aclose()
    if resp.status_code != 200:
        return None                    # honest degrade; no url/token surfaced
    try:
        data = resp.json()
    except ValueError:
        return None                    # malformed 2xx body (non-JSON / proxy HTML) → degrade
    if not isinstance(data, dict) or data.get("code") != "Ok":
        return None
    wanted = {a.strip() for a in annotations.split(",")}
    durations = _clean_matrix(data.get("durations")) if "duration" in wanted else []
    distances = _clean_matrix(data.get("distances")) if "distance" in wanted else []
    if durations is None or distances is None:
        return None                    # requested annotation missing/malformed → degrade
    return Matrix(durations=durations, distances=distances)
