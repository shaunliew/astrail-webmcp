# backend/pipeline/tradeoffs.py
"""Deterministic tradeoff derivation — no LLM, no network. Pure functions.

notes  <- FeasibilityWarning (the seam feasibility.py flagged as deferred)
comparisons <- persisted hotel_suggestions rows (price_snapshot + star_rating).
Hotels have no coords/distance (base_place_id NULL), so the axis is price_vs_rating.
"""
from __future__ import annotations

from models.tradeoff import (
    TradeoffOption, TripTradeoffComparison, TripTradeoffNote,
)

_SEVERITY = {"warn": "warn", "flag": "flag"}   # FeasibilityWarning.severity -> note severity


def warnings_to_notes(warnings, groups=None) -> list[TripTradeoffNote]:
    refs_by_day: dict[int, list[str]] = {}
    if groups:
        refs_by_day = {day: [p.name for p in places] for day, places in groups}
    notes: list[TripTradeoffNote] = []
    for w in warnings:
        notes.append(TripTradeoffNote(
            kind=w.kind,
            scope="day",
            severity=_SEVERITY.get(w.severity, "info"),   # None/unknown -> info
            detail=w.detail,
            day_number=w.day_number,
            refs=refs_by_day.get(w.day_number, []),
            leg_m=w.leg_m,
        ))
    return notes


def _price(row: dict) -> tuple[float, str] | None:
    """(price, unit_label) preferring per-night; falls back to total. None when unpriced."""
    snap = row.get("price_snapshot") or {}
    for key, unit in (("pricePerNight", "/night"), ("totalPrice", " total")):
        val = snap.get(key)
        if val is not None:
            try:
                return float(val), unit
            except (TypeError, ValueError):
                continue
    return None


def _value(price: float, unit: str, currency: str | None) -> str:
    cur = currency or ""
    return f"{int(price)} {cur}{unit}".replace("  ", " ").strip()


def build_hotel_comparisons(hotel_rows) -> list[TripTradeoffComparison]:
    priced = []
    for r in hotel_rows:
        p = _price(r)
        if p is not None:
            priced.append((r, p[0], p[1]))
    if len(priced) < 2:
        return []
    # id is the final tiebreaker so A/B selection is deterministic regardless of DB row order
    # (the hotel re-query has no ORDER BY): idempotent re-runs emit the same pairing.
    cheapest = min(priced, key=lambda t: (t[1], str(t[0]["id"])))
    others = [t for t in priced if t[0]["id"] != cheapest[0]["id"]]
    # highest-rated distinct row; ties broken by higher price then id (a clearly different option)
    best = max(others, key=lambda t: (t[0].get("star_rating") or 0, t[1], str(t[0]["id"])))
    (c_row, c_price, c_unit) = cheapest
    (b_row, b_price, b_unit) = best
    c_cur = (c_row.get("price_snapshot") or {}).get("currency")
    b_cur = (b_row.get("price_snapshot") or {}).get("currency")
    c_star, b_star = c_row.get("star_rating"), b_row.get("star_rating")
    c_val, b_val = _value(c_price, c_unit, c_cur), _value(b_price, b_unit, b_cur)
    option_a = TradeoffOption(label=c_row["name"], value=c_val,
                              pro=f"cheaper ({c_val})", con=f"{c_star or '?'}-star")
    option_b = TradeoffOption(label=b_row["name"], value=b_val,
                              pro=f"higher rated ({b_star or '?'}-star)", con=f"pricier ({b_val})")
    # deterministic recommendation: cheaper wins when the rating gap is small (<=1 star);
    # None when ratings AND prices tie (no clear winner).
    rec = None
    if c_star is not None and b_star is not None:
        if (b_star - c_star) <= 1 and not (b_star == c_star and b_price == c_price):
            rec = c_row["name"]
    return [TripTradeoffComparison(
        axis="price_vs_rating", option_a=option_a, option_b=option_b,
        recommendation=rec, refs=[c_row["id"], b_row["id"]])]
