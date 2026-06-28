"""Legacy-equivalent baseline — the behaviour the new pipeline must beat.

Reproduces the two legacy behaviours WITHOUT importing from legacy/ (guardrail #9):
  1. name-only dedup (lowercase exact-name match, keep highest confidence)
  2. proximity-blind day chunking (split places in input order, no route ordering)

Produces a structured itinerary so the offline checks + metrics can score it.
"""
from __future__ import annotations

from datetime import date, timedelta


def date_range(start_date: str, end_date: str) -> list[str]:
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if end < start:
        raise ValueError(f"end_date {end_date} < start_date {start_date}")
    n = (end - start).days + 1
    return [(start + timedelta(days=i)).isoformat() for i in range(n)]


def name_only_dedup(places: list[dict]) -> list[dict]:
    """Legacy `_flatten_and_dedup_by_name`: lowercase exact-name match, keep highest confidence."""
    seen: dict[str, dict] = {}
    for p in places:
        if p.get("lat") is None or p.get("lng") is None:
            continue
        key = p["name"].strip().lower()
        if key not in seen or p.get("confidence", 0) > seen[key].get("confidence", 0):
            seen[key] = p
    return list(seen.values())


def naive_day_plan(places: list[dict], dates: list[str]) -> list[dict]:
    """Proximity-blind: split places in input order into len(dates) near-even contiguous chunks."""
    n, d = len(places), len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    base, extra = divmod(n, d)
    days: list[dict] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        days.append({
            "day_number": i + 1,
            "date": day_date,
            "place_names": [p["name"] for p in group],
        })
    return days


def build_baseline_itinerary(places: list[dict], start_date: str, end_date: str) -> dict:
    """Legacy-equivalent structured itinerary from extracted places (offline, deterministic)."""
    dates = date_range(start_date, end_date)
    canonical = name_only_dedup(places)
    days = naive_day_plan(canonical, dates)
    return {
        "title": "Tokyo (legacy-equivalent baseline)",
        "days": days,
        "source_places": [p["name"] for p in canonical],
        "source": "baseline",
    }
