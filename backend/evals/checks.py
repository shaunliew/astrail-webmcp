"""Active contractual checks — these GATE the runner exit code.

Each check takes the eval `ctx` dict and returns a CheckResult. A "fail" makes the
runner exit non-zero. "blocked" means the check could not run (missing fixture data,
e.g. uncaptured captions) — recorded, but NOT a failure. "skipped" is for pending checks.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from evals.util import evidence_in_corpus, in_japan, reel_corpus

# Pending checks: declared now, activated when their pipeline step lands (spec §7).
PENDING_CHECKS: tuple[str, ...] = (
    "restaurant_relevance",   # -> hotel/enrichment step
    "hotel_base_reasoning",   # -> hotel/base recommendation (Phase 1.2)
    "memory_use",             # -> mem0 preference memory (Phase 1.3)
    "transport_legs",         # -> Mapbox Directions step
)


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str   # "pass" | "fail" | "blocked" | "skipped"
    detail: str


def check_coords_present(ctx: dict) -> CheckResult:
    missing = [p["name"] for p in ctx["places"] if p.get("lat") is None or p.get("lng") is None]
    if missing:
        return CheckResult("coords_present", "fail", f"missing coords: {missing}")
    return CheckResult("coords_present", "pass", f"all {len(ctx['places'])} places have coords")


def check_japan_bbox(ctx: dict) -> CheckResult:
    out = [p["name"] for p in ctx["places"] if not in_japan(p.get("lat"), p.get("lng"))]
    if out:
        return CheckResult("japan_bbox", "fail", f"outside Japan bbox: {out}")
    return CheckResult("japan_bbox", "pass", "all places within Japan bbox")


def check_day_count(ctx: dict) -> CheckResult:
    start = date.fromisoformat(ctx["start_date"])
    end = date.fromisoformat(ctx["end_date"])
    expected = (end - start).days + 1
    actual = len(ctx["itinerary"]["days"])
    if actual != expected:
        return CheckResult("day_count", "fail", f"expected {expected} days, got {actual}")
    return CheckResult("day_count", "pass", f"{actual} days == date span")


def check_source_places_parity(ctx: dict) -> CheckResult:
    """Every itinerary place must trace to an extracted place (no hallucinated additions).

    Compared as a SUBSET, not exact equality: a pipeline may legitimately collapse
    duplicates via dedup, so `source_places` being smaller than the raw extraction set is
    expected. Only extra (untraceable) names or an empty set are contract violations.
    Silent under-coverage is a quality metric (recorded), not a hard gate.
    """
    known = {p["name"] for p in ctx["places"]}
    actual = set(ctx["itinerary"].get("source_places", []))
    extra = actual - known
    if extra:
        return CheckResult("source_places_parity", "fail",
                           f"itinerary places not traceable to extraction: {extra}")
    if not actual:
        return CheckResult("source_places_parity", "fail", "empty source_places")
    return CheckResult("source_places_parity", "pass",
                       f"{len(actual)} source_places all trace to extracted places")


def check_evidence_verbatim(ctx: dict) -> CheckResult:
    corpus = reel_corpus(ctx["reels"])
    if not corpus:
        return CheckResult(
            "evidence_verbatim", "blocked",
            "no reel captions captured — cannot verify substrings (run the one-time capture)",
        )
    bad = [p["name"] for p in ctx["places"]
           if not evidence_in_corpus(p.get("evidence_quote"), corpus)]
    if bad:
        return CheckResult("evidence_verbatim", "fail", f"evidence not verbatim in corpus: {bad}")
    return CheckResult("evidence_verbatim", "pass",
                       f"all {len(ctx['places'])} evidence quotes verbatim in corpus")


CONTRACTUAL_CHECKS: dict[str, object] = {
    "coords_present": check_coords_present,
    "japan_bbox": check_japan_bbox,
    "day_count": check_day_count,
    "source_places_parity": check_source_places_parity,
    "evidence_verbatim": check_evidence_verbatim,
}
