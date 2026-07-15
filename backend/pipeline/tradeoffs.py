# backend/pipeline/tradeoffs.py
"""Deterministic tradeoff derivation — no LLM, no network. Pure functions.

notes  <- FeasibilityWarning (the seam feasibility.py flagged as deferred)
comparisons <- persisted hotel_suggestions rows (price_snapshot + star_rating).
Hotels have no coords/distance (base_place_id NULL), so the axis is price_vs_rating.
"""
from __future__ import annotations

import math

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


def _num(val) -> float | None:
    """Finite float or None (rejects None, non-numeric, inf, nan)."""
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _priced_rows(hotel_rows, key: str) -> list[tuple[dict, float]]:
    """(row, price) for every row carrying a finite numeric `price_snapshot[key]`."""
    out: list[tuple[dict, float]] = []
    for r in hotel_rows:
        num = _num((r.get("price_snapshot") or {}).get(key))
        if num is not None:
            out.append((r, num))
    return out


def _value(price: float, unit: str, currency: str | None) -> str:
    cur = currency or ""
    # {:g} keeps decimals when present (8000.5) but drops them when whole (8000) — no int() truncation.
    return f"{price:g} {cur}{unit}".replace("  ", " ").strip()


def build_hotel_comparisons(hotel_rows) -> list[TripTradeoffComparison]:
    # Rank within ONE price unit — never compare a per-night price against a total-stay price.
    # Prefer per-night; fall back to total only if fewer than 2 rows carry per-night.
    priced: list[tuple[dict, float]] = []
    unit = "/night"
    for key, u in (("pricePerNight", "/night"), ("totalPrice", " total")):
        rows_p = _priced_rows(hotel_rows, key)
        if len(rows_p) >= 2:
            priced, unit = rows_p, u
            break
    if len(priced) < 2:
        return []
    # Rank within a SINGLE currency — never compare JPY vs USD as raw numbers, and don't let a
    # foreign-currency row distort the min/max ranking. All hotels from one Travala search share a
    # currency; if a set is mixed, compare the largest currency group (deterministic tiebreak on the
    # currency string). Guarding only the final pair (not the ranking) is insufficient (Codex #4).
    by_cur: dict = {}
    for row_p in priced:
        by_cur.setdefault((row_p[0].get("price_snapshot") or {}).get("currency"), []).append(row_p)
    _cur, priced = max(by_cur.items(), key=lambda kv: (len(kv[1]), str(kv[0])))
    if len(priced) < 2:
        return []   # no single currency has two comparable hotels
    # Tiebreak on hotel NAME, not row id: hotel_suggestions.id is gen_random_uuid(), regenerated on
    # every delete+reinsert in persist_hotels, so an id tiebreak would flip the A/B pairing across
    # idempotent re-runs. Name is stable per Travala hotel → deterministic across reruns.
    cheapest = min(priced, key=lambda t: (t[1], str(t[0].get("name") or "")))
    others = [t for t in priced if t[0]["id"] != cheapest[0]["id"]]
    if not others:
        return []
    best = max(others, key=lambda t: (t[0].get("star_rating") or 0, t[1], str(t[0].get("name") or "")))
    c_row, c_price = cheapest
    b_row, b_price = best
    c_cur = b_cur = _cur   # guaranteed identical: priced is a single-currency group
    c_star, b_star = c_row.get("star_rating"), b_row.get("star_rating")
    c_star_n, b_star_n = (c_star or 0), (b_star or 0)
    c_val, b_val = _value(c_price, unit, c_cur), _value(b_price, unit, b_cur)
    # Prose derives from the ACTUAL rating relationship (option_b is only "higher rated" when it is).
    option_a = TradeoffOption(
        label=c_row["name"], value=c_val, pro=f"cheaper ({c_val})",
        con=f"{c_star or '?'}-star" + ("" if c_star_n >= b_star_n else " (lower rated)"))
    if b_star_n > c_star_n:
        option_b = TradeoffOption(label=b_row["name"], value=b_val,
                                  pro=f"higher rated ({b_star or '?'}-star)",
                                  con=f"pricier ({b_val})")
    else:
        # the pricier option is NOT higher-rated → the cheaper hotel dominates; say so honestly
        option_b = TradeoffOption(label=b_row["name"], value=b_val,
                                  pro=f"{b_star or '?'}-star",
                                  con=f"pricier ({b_val}), not higher rated")
    # Recommend the cheaper hotel when the pricier one isn't meaningfully higher-rated (gap <= 1),
    # except an exact price+rating tie (no winner). A >=2-star premium is a real tradeoff → None.
    rec = None
    if c_star is not None and b_star is not None:
        gap = b_star_n - c_star_n
        exact_tie = (gap == 0 and b_price == c_price)
        if not exact_tie and gap <= 1:
            rec = c_row["name"]
    return [TripTradeoffComparison(
        axis="price_vs_rating", option_a=option_a, option_b=option_b,
        recommendation=rec, refs=[c_row["id"], b_row["id"]])]
