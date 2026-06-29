"""In-trip place dedup — two-gate: name/alias overlap AND geographic proximity.

Both gates must pass to merge (acceptance: semantic-only and geo-only are each
insufficient; distinct chain branches like Shibuya vs Shinjuku stay separate via the
geo gate). Pure + offline — no embeddings, no Supabase. The embedding semantic gate and
the persistent cross-trip pgvector cache (the data flywheel) are a later Supabase step.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from models.place import CanonicalPlace, PlaceResult
from pipeline.geo import haversine_m

DEFAULT_DISTANCE_M = 500.0   # PLACE_LATLNG_DISTANCE_M
DEFAULT_MAX_PLACES = 8       # MAX_PLACES_PER_TRIP

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)   # \w + re.UNICODE keeps CJK; drops punctuation/emoji
_WS = re.compile(r"\s+")


def _normalize(name: str | None) -> str:
    """Lowercase, drop punctuation/emoji, collapse whitespace. '' for blank/None."""
    if not name:
        return ""
    return _WS.sub(" ", _NON_WORD.sub(" ", name.lower())).strip()


def _aliases(place: PlaceResult) -> set[str]:
    """Normalized match keys for a place: its name and its local-language name."""
    return {a for a in (_normalize(place.name), _normalize(place.name_local)) if a}


def _semantic_match(a: PlaceResult, b: PlaceResult) -> bool:
    return bool(_aliases(a) & _aliases(b))


def _geo_match(a: PlaceResult, b: PlaceResult, distance_m: float) -> bool:
    if None in (a.lat, a.lng, b.lat, b.lng):
        return False  # geo gate requires coordinates on BOTH places
    return haversine_m(a.lat, a.lng, b.lat, b.lng) < distance_m


@dataclass(frozen=True)
class DedupeResult:
    places: list[CanonicalPlace]
    notes: list[str]


def _merge_cluster(cluster: list[PlaceResult]) -> CanonicalPlace:
    """Build one CanonicalPlace from a cluster: representative = highest confidence
    (ties → earliest, preserving creator-tag priority), with merged aliases + evidence."""
    rep = max(cluster, key=lambda p: p.confidence)
    seen_alias, aliases = set(), []
    for m in cluster:
        for nm in (m.name, m.name_local):
            if nm and nm not in seen_alias:
                seen_alias.add(nm)
                aliases.append(nm)
    canonical = CanonicalPlace.model_validate(rep.model_dump())
    update: dict = {
        "times_referenced": len(cluster),
        "aliases": aliases,
        "evidence_quotes": [m.evidence_quote for m in cluster],
    }
    # User-requested protection is CLUSTER-level: if ANY merged mention was user-requested,
    # the canonical is user-requested (so the cap never drops it) — even when a higher-
    # confidence reel mention is the representative.
    if any(m.source_type == "user_requested" for m in cluster):
        update["source_type"] = "user_requested"
    return canonical.model_copy(update=update)


def dedupe_places(
    places: list[PlaceResult], *, distance_m: float = DEFAULT_DISTANCE_M,
    max_places: int = DEFAULT_MAX_PLACES,
) -> DedupeResult:
    """Cluster duplicates (two-gate), build canonical places, then cap to max_places by
    dropping the lowest-confidence non-user-requested places — preserving input order
    among survivors. Returns the canonical places + human-readable keep/drop notes.
    Never mutates the input list."""
    clusters: list[list[PlaceResult]] = []
    for p in places:
        for cl in clusters:
            # Match against ANY member (not just the first) so transitive duplicates
            # (A~B, B~C, but A not~C) still land in one cluster.
            if any(_semantic_match(m, p) and _geo_match(m, p, distance_m) for m in cl):
                cl.append(p)
                break
        else:
            clusters.append([p])

    canonical = [_merge_cluster(cl) for cl in clusters]   # first-occurrence (input) order
    notes = [
        (f"kept '{c.name}' (conf {c.confidence}; {c.times_referenced} mention(s) merged: {c.aliases})"
         if c.times_referenced > 1 else f"kept '{c.name}' (conf {c.confidence})")
        for c in canonical
    ]

    if len(canonical) > max_places:
        required = [c for c in canonical if c.source_type == "user_requested"]
        optional = [c for c in canonical if c.source_type != "user_requested"]
        slots = max(0, max_places - len(required))
        keep_ids = {id(c) for c in required}
        keep_ids |= {id(c) for c in sorted(optional, key=lambda c: c.confidence, reverse=True)[:slots]}
        for c in canonical:
            if id(c) not in keep_ids:
                notes.append(f"dropped '{c.name}' (over cap {max_places}, conf {c.confidence})")
        canonical = [c for c in canonical if id(c) in keep_ids]   # preserves input order

    return DedupeResult(places=canonical, notes=notes)
