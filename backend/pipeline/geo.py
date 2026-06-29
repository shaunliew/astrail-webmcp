"""Great-circle distance — shared geo helper for the pipeline layer (dedup) and capture.
Pure, stdlib-only. (evals/util keeps its own copy on purpose: it is the frozen #16 bar
and must stay independent of pipeline code.)"""
from __future__ import annotations

import math

_EARTH_RADIUS_M = 6_371_000


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two (lat, lng) points."""
    rlat1, rlng1, rlat2, rlng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    dlat, dlng = rlat2 - rlat1, rlng2 - rlng1
    h = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    h = min(1.0, h)  # clamp to guard against math domain error on near-antipodal/hallucinated coords
    return 2 * _EARTH_RADIUS_M * math.asin(math.sqrt(h))
