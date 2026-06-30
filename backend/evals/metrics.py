"""Quality metrics — recorded baseline numbers, NON-gating (do not fail the run).

Each metric takes the eval `ctx` dict and returns a number. Pure; stdlib only.
ctx keys: places, itinerary, reels, start_date, end_date, expected_unique.
"""
from __future__ import annotations

from evals.util import (
    evidence_in_corpus,
    haversine_m,
    is_meaningful_quote,
    is_placeholder_url,
    is_weak_source_url,
    reel_corpus,
)


def dedup_error(ctx: dict) -> int:
    """|produced canonical place count − known unique count|. 0 = perfect dedup."""
    produced = len(ctx["places"])
    return abs(produced - int(ctx["expected_unique"]))


def mean_intra_day_travel_m(ctx: dict) -> float:
    """Average metres travelled within a day across the itinerary. Lower = more coherent.

    Legs are counted only between consecutive stops that BOTH have coordinates. A
    no-coords stop breaks the chain — it is NOT bridged over (which would silently
    fabricate an adjacency between its neighbours). In practice the `coords_present`
    contractual check gates the run before this matters; this guard prevents masking.
    """
    coords = {p["name"]: (p["lat"], p["lng"]) for p in ctx["places"]
              if p.get("lat") is not None and p.get("lng") is not None}
    per_day: list[float] = []
    for day in ctx["itinerary"]["days"]:
        names = day["place_names"]
        legs = 0.0
        for i in range(len(names) - 1):
            a, b = coords.get(names[i]), coords.get(names[i + 1])
            if a is None or b is None:
                continue  # broken leg: do not bridge over a no-coords stop
            legs += haversine_m(a[0], a[1], b[0], b[1])
        per_day.append(legs)
    return round(sum(per_day) / len(per_day), 1) if per_day else 0.0


def hallucination_rate(ctx: dict) -> float:
    """Fraction of places missing coordinates OR carrying a placeholder source_url."""
    places = ctx["places"]
    if not places:
        return 0.0
    bad = sum(
        1 for p in places
        if p.get("lat") is None or p.get("lng") is None or is_placeholder_url(p.get("source_url"))
    )
    return round(bad / len(places), 3)


def evidence_coverage(ctx: dict) -> float:
    """Fraction of places whose evidence_quote is a verbatim substring of the reel corpus.

    When no captions are captured (corpus empty), falls back to the fraction with a
    non-empty evidence_quote so the metric still reports something offline.
    """
    places = ctx["places"]
    if not places:
        return 0.0
    corpus = reel_corpus(ctx["reels"])
    if corpus:
        hits = sum(1 for p in places if evidence_in_corpus(p.get("evidence_quote"), corpus))
    else:
        hits = sum(1 for p in places if is_meaningful_quote(p.get("evidence_quote")))
    return round(hits / len(places), 3)


def weak_source_url_rate(ctx: dict) -> float:
    """Fraction of places whose source_url is a placeholder, search page, or Google Maps link."""
    places = ctx["places"]
    if not places:
        return 0.0
    weak = sum(1 for p in places if is_weak_source_url(p.get("source_url")))
    return round(weak / len(places), 3)


def max_single_leg_m(ctx: dict) -> float:
    """Longest single consecutive intra-day leg (m). A high value = a transit-heavy day."""
    coords = {p["name"]: (p["lat"], p["lng"]) for p in ctx["places"]
              if p.get("lat") is not None and p.get("lng") is not None}
    longest = 0.0
    for day in ctx["itinerary"]["days"]:
        names = day["place_names"]
        for i in range(len(names) - 1):
            a, b = coords.get(names[i]), coords.get(names[i + 1])
            if a is not None and b is not None:   # explicit None check, matching mean_intra_day_travel_m
                longest = max(longest, haversine_m(a[0], a[1], b[0], b[1]))
    return round(longest, 1)


def feasibility_warning_count(ctx: dict) -> int:
    """Number of feasibility warnings the pipeline attached (0 for the baseline subject)."""
    return len(ctx["itinerary"].get("feasibility_warnings", []))


QUALITY_METRICS: dict[str, object] = {
    "dedup_error": dedup_error,
    "mean_intra_day_travel_m": mean_intra_day_travel_m,
    "hallucination_rate": hallucination_rate,
    "evidence_coverage": evidence_coverage,
    "weak_source_url_rate": weak_source_url_rate,
    "max_single_leg_m": max_single_leg_m,
    "feasibility_warning_count": feasibility_warning_count,
}
