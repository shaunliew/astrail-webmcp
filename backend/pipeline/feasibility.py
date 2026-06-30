"""Itinerary feasibility — deterministic geographic ordering + warnings. Pure, offline.

Replaces naive input-order chunking: a nearest-neighbor geo-chain over all coord-bearing
places, split into near-even day groups, with a brute-force optimal intra-day order; then
flags long legs + overpacked days. Real road/transit legs (Mapbox Directions) and LLM
narrator/orchestrator consumption of the warnings are deferred — the warnings are the seam.
"""
from __future__ import annotations

from itertools import permutations

from models.place import CanonicalPlace
from models.trip import FeasibilityWarning
from pipeline.geo import haversine_m

LONG_LEG_WARN_M = 2000.0    # haversine ≥ this between consecutive stops → warn (walkable-city heuristic)
LONG_LEG_FLAG_M = 4000.0    # ≥ this → hard flag (transit required, not walkable)
PACE_STOP_CAP = {"relaxed": 3, "balanced": 4, "packed": 6}
DEFAULT_PACE = "balanced"
_BRUTE_FORCE_MAX = 7        # n! permutations: 7! = 5040 is instant; NN/geo-order fallback above


def _has_coords(p: CanonicalPlace) -> bool:
    return p.lat is not None and p.lng is not None


def _leg_m(a: CanonicalPlace, b: CanonicalPlace) -> float | None:
    if not (_has_coords(a) and _has_coords(b)):
        return None
    return haversine_m(a.lat, a.lng, b.lat, b.lng)


def _path_distance(order: list[CanonicalPlace]) -> float:
    """Total haversine of consecutive coord-bearing legs (no-coord stops break the chain)."""
    return sum(d for i in range(len(order) - 1)
               if (d := _leg_m(order[i], order[i + 1])) is not None)


def geo_order(places: list[CanonicalPlace]) -> list[CanonicalPlace]:
    """Deterministic nearest-neighbor chain over coord-bearing places; no-coord places are
    appended (input order) at the end. Anchor = smallest (lat, lng, name); nearest ties broken
    by (lat, lng, name) — stable PLACE identity, not list index — so the chain is
    INPUT-ORDER-INDEPENDENT (any ordering of the same places → the same chain). Never mutates input."""
    coorded = [p for p in places if _has_coords(p)]
    no_coord = [p for p in places if not _has_coords(p)]
    if len(coorded) <= 1:
        return coorded + no_coord
    remaining = list(coorded)
    start = min(range(len(remaining)),
                key=lambda i: (remaining[i].lat, remaining[i].lng, remaining[i].name))
    chain = [remaining.pop(start)]
    while remaining:
        last = chain[-1]
        nxt = min(range(len(remaining)),
                  key=lambda i: (haversine_m(last.lat, last.lng, remaining[i].lat, remaining[i].lng),
                                 remaining[i].lat, remaining[i].lng, remaining[i].name))
        chain.append(remaining.pop(nxt))
    return chain + no_coord


def optimal_day_order(day_places: list[CanonicalPlace]) -> list[CanonicalPlace]:
    """Minimize total intra-day leg distance (open-path TSP). Brute-force optimal for small
    days; for >_BRUTE_FORCE_MAX coord stops keep the (already geo-ordered) input. Deterministic
    (min() returns the first-minimal permutation). No-coord stops kept at the end."""
    coorded = [p for p in day_places if _has_coords(p)]
    no_coord = [p for p in day_places if not _has_coords(p)]
    if len(coorded) <= 2 or len(coorded) > _BRUTE_FORCE_MAX:
        return list(coorded) + no_coord   # no-coord places consistently last on all paths
    # secondary key (name tuple) canonicalizes equal-cost paths (a route and its reverse
    # have identical distance) so the result is stable, not "whichever permutation came first".
    best = min(permutations(coorded),
               key=lambda perm: (_path_distance(perm), tuple(p.name for p in perm)))
    return list(best) + no_coord


def assess_feasibility(
    numbered_days: list[tuple[int, list[CanonicalPlace]]], *, pace: str = DEFAULT_PACE
) -> list[FeasibilityWarning]:
    """Flag empty days, overpacked days (stops > pace cap), and long legs (≥WARN / ≥FLAG metres).
    A missing-coord leg is skipped (no warning, no crash). Every warning carries a severity field:
    empty_day → 'flag'; overpacked_day → 'warn'; long_leg → 'flag' if ≥LONG_LEG_FLAG_M else 'warn'."""
    cap = PACE_STOP_CAP.get(pace, PACE_STOP_CAP[DEFAULT_PACE])
    warnings: list[FeasibilityWarning] = []
    for day_number, day in numbered_days:
        if len(day) == 0:
            warnings.append(FeasibilityWarning(
                kind="empty_day", day_number=day_number,
                detail="day has no stops", severity="flag"))
            continue
        if len(day) > cap:
            warnings.append(FeasibilityWarning(
                kind="overpacked_day", day_number=day_number,
                detail=f"{len(day)} stops exceeds the {pace} pace cap of {cap}",
                severity="warn"))
        for i in range(len(day) - 1):
            d = _leg_m(day[i], day[i + 1])
            if d is not None and d >= LONG_LEG_WARN_M:
                severity = "flag" if d >= LONG_LEG_FLAG_M else "warn"
                warnings.append(FeasibilityWarning(
                    kind="long_leg", day_number=day_number, leg_m=d,
                    detail=f"{d:.0f} m {day[i].name} -> {day[i + 1].name} ({severity})",
                    severity=severity))
    return warnings
