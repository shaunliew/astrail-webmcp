# Evidence & Tradeoff Frontend Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend emit place evidence that conforms to the frozen frontend `TripPlaceEvidence` contract, and add a structured `trips.tradeoffs` contract (deterministic feasibility *notes* + hotel *comparisons*) — so real trips render evidence chips/quotes and tradeoffs instead of blank fixtures.

**Architecture:** Deterministic-first, single-PR schema parity. Rewrite the `evidence_json` writer to emit a typed `TripPlaceEvidence` with a computed `evidence_kind`; wire the already-computed-but-dropped `FeasibilityWarning`s into `trips.tradeoffs.notes`; derive `trips.tradeoffs.comparisons` from persisted `hotel_suggestions` rows. **One post-gather `trips.tradeoffs` write** (no read-modify-write). No new LLM calls — the deterministic dedup/assembly path and the frozen eval anchor are untouched.

**Tech Stack:** Python 3.14 + Pydantic v2 + pytest (backend, `uv`); TypeScript (frontend contract types + vitest); Supabase Postgres migration (SQL). FastAPI/SSE runner in `backend/pipeline/runner.py`.

## Global Constraints

- **Schema parity (guardrail #4):** every Pydantic field has a TypeScript mirror in `frontend/lib/trip/backend-types.ts`; DB schema in `supabase/migrations/*.sql`. All three sides ship in this PR. This includes the containing rows: `tradeoffs` on the `Trip` row type, and a Pydantic `TripPlaceEvidence` mirroring the TS type exactly.
- **No hallucinated places (guardrail #1):** additive only — never drop/alter a place's identity.
- **Partial failure is acceptable (guardrail #3):** tradeoff writes are best-effort; a failure must NEVER fail the trip.
- **Writes are write-through (guardrail #7):** persist before the terminal result.
- **Owner check (guardrail #6):** every `trips` write is `.eq("id", trip_id).eq("user_id", user_id)`.
- **No new LLM in this feature.** Notes come from `FeasibilityWarning`; comparisons from numeric hotel fields. Eval-safety: the frozen `mean_intra_day_travel_m = 6229.0` anchor and `dedupe`/`assemble_itinerary` are untouched, AND this plan adds an exact-value regression test that freezes `6229.0` (the existing eval only asserts `<=` baseline).
- **No `requirements.txt`** — `uv` only. Backend tests: `cd backend && uv run pytest`.
- **Spec:** `docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md` (amended §4b: hotel comparison axis is `price_vs_rating` from persisted rows — hotels have NO coords/`distance_m`).
- **One-write invariant:** `trips.tradeoffs` is written ONCE, after the enrich gather, with the full `{notes, comparisons}` object. No read-modify-write (a transient read failure must never erase a sibling field). All other `trips` writes are column-scoped and disjoint.

---

### Task 1: Tradeoff types (Pydantic + TypeScript, incl. the `Trip` row field)

**Files:**
- Create: `backend/models/tradeoff.py`
- Create: `backend/models/test_tradeoff.py`
- Modify: `frontend/lib/trip/backend-types.ts` (add tradeoff types after the evidence region ~line 55; add `tradeoffs` to the `Trip` type at ~line 166)

**Interfaces:**
- Produces (Python): `TripTradeoffNote`, `TradeoffOption`, `TripTradeoffComparison`, `TripTradeoffs` (`pydantic.BaseModel`).
- Produces (TS): `TripTradeoffNote`, `TradeoffOption`, `TripTradeoffComparison`, `TripTradeoffs`, and `Trip.tradeoffs: TripTradeoffs`.

- [ ] **Step 1: Write the failing test**

```python
# backend/models/test_tradeoff.py
from models.tradeoff import (
    TripTradeoffNote, TradeoffOption, TripTradeoffComparison, TripTradeoffs,
)


def test_note_defaults_and_fields():
    n = TripTradeoffNote(kind="long_leg", scope="day", severity="flag",
                         detail="4200 m A -> B", day_number=2, leg_m=4200.0)
    assert n.refs == [] and n.day_number == 2 and n.severity == "flag"


def test_comparison_roundtrips_options():
    a = TradeoffOption(label="Hotel A", value="¥8000/night", pro="cheaper", con="3-star")
    b = TradeoffOption(label="Hotel B", value="¥12000/night", pro="4-star", con="pricier")
    c = TripTradeoffComparison(axis="price_vs_rating", option_a=a, option_b=b,
                               recommendation="Hotel A", refs=["id-a", "id-b"])
    assert c.scope == "hotel" and c.option_a.label == "Hotel A"


def test_tradeoffs_container_defaults_empty():
    t = TripTradeoffs()
    assert t.notes == [] and t.comparisons == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest models/test_tradeoff.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'models.tradeoff'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/models/tradeoff.py
"""Trip-level tradeoffs contract (mirrors frontend backend-types.ts, guardrail #4).

Two deterministic shapes: notes (gaps, from FeasibilityWarning) and comparisons
(hotel A-vs-B, from numeric hotel_suggestions fields). No LLM. Persisted to the
trips.tradeoffs jsonb column as {notes, comparisons}.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class TripTradeoffNote(BaseModel):
    kind: Literal["long_leg", "overpacked_day", "empty_day", "note"]
    scope: Literal["trip", "day", "place"]
    severity: Literal["info", "warn", "flag"]
    detail: str
    day_number: int | None = None
    refs: list[str] = Field(default_factory=list)
    leg_m: float | None = None


class TradeoffOption(BaseModel):
    label: str
    value: str
    pro: str
    con: str


class TripTradeoffComparison(BaseModel):
    axis: str
    scope: Literal["hotel"] = "hotel"
    option_a: TradeoffOption
    option_b: TradeoffOption
    recommendation: str | None = None
    refs: list[str] = Field(default_factory=list)


class TripTradeoffs(BaseModel):
    notes: list[TripTradeoffNote] = Field(default_factory=list)
    comparisons: list[TripTradeoffComparison] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest models/test_tradeoff.py -v`
Expected: PASS (3 passed)

- [ ] **Step 5: Add the TypeScript mirror + wire the `Trip` row**

In `frontend/lib/trip/backend-types.ts`, immediately after the `TripPlaceEvidence` block (~line 55), add:

```ts
// Trip-level tradeoffs (PRD §667/§894). Deterministic: notes from feasibility, comparisons from hotels.
export type TripTradeoffNote = {
  kind: 'long_leg' | 'overpacked_day' | 'empty_day' | 'note'
  scope: 'trip' | 'day' | 'place'
  severity: 'info' | 'warn' | 'flag'
  detail: string
  day_number: number | null
  refs: string[]
  leg_m: number | null
}
export type TradeoffOption = { label: string; value: string; pro: string; con: string }
export type TripTradeoffComparison = {
  axis: string
  scope: 'hotel'
  option_a: TradeoffOption
  option_b: TradeoffOption
  recommendation: string | null
  refs: string[]
}
export type TripTradeoffs = { notes: TripTradeoffNote[]; comparisons: TripTradeoffComparison[] }
```

Then add the field to the `Trip` type (after `summary` at ~line 166):

```ts
  summary: string | null          // read-only orchestrator summary (narrator)
  tradeoffs: TripTradeoffs         // deterministic notes + hotel comparisons (backend emission)
  created_at: string
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: The new `Trip.tradeoffs` is a required field — any object literal building a `Trip` without it now errors. If `tokyo-trip.ts` (or another fixture) constructs a `Trip`, add `tradeoffs: { notes: [], comparisons: [] }` there. Re-run until clean.

- [ ] **Step 7: Commit**

```bash
git add backend/models/tradeoff.py backend/models/test_tradeoff.py frontend/lib/trip/backend-types.ts frontend/lib/trip/fixtures/tokyo-trip.ts
git commit -m "feat(tradeoff): TripTradeoff Pydantic models + TS mirror + Trip.tradeoffs"
```

---

### Task 2: Evidence contract (typed Pydantic model + conformant emission)

**Files:**
- Create: `backend/models/evidence.py`
- Create: `backend/models/test_evidence.py`
- Modify: `backend/pipeline/persist.py:48-55` (`_evidence_json`; add `_evidence_kind`; import `TripPlaceEvidence`)
- Modify: `backend/pipeline/test_persist.py` (evidence tests)
- Modify: `frontend/lib/trip/backend-types.ts:49-55` (`TripPlaceEvidence` — add `quotes`)
- Modify: `frontend/lib/trip/fixtures/tokyo-trip.ts` (add `quotes` to the SIX `TripPlace` evidence literals at lines 47–72 ONLY — NOT the restaurant at line 123)
- Modify: `frontend/components/trip/__tests__/EvidenceChip.test.tsx:6-9` (add `quotes` to the typed `TripPlaceEvidence` literal)

**Interfaces:**
- Produces (Python): `models.evidence.TripPlaceEvidence` (BaseModel, fields `confidence, source_url, quote, quotes, rationale, evidence_kind`); `persist._evidence_kind(source_type: str) -> str`; `persist._evidence_json(place) -> dict` returns `TripPlaceEvidence(...).model_dump()`.
- Consumes: `CanonicalPlace.source_type` ∈ `{reel_extracted, user_requested, agent_suggested}`; `.evidence_quote` (str), `.evidence_quotes` (list[str]), `.source_url`, `.confidence`.

- [ ] **Step 1: Write the failing evidence-model test**

```python
# backend/models/test_evidence.py
from models.evidence import TripPlaceEvidence


def test_evidence_model_fields_match_the_contract():
    assert set(TripPlaceEvidence.model_fields) == {
        "confidence", "source_url", "quote", "quotes", "rationale", "evidence_kind"}


def test_evidence_model_defaults():
    ev = TripPlaceEvidence(confidence=0.9, evidence_kind="reel_quote")
    assert ev.quote is None and ev.quotes == [] and ev.rationale is None and ev.source_url is None
```

- [ ] **Step 2: Run it (fails), then implement the model**

Run: `cd backend && uv run pytest models/test_evidence.py -v` → FAIL (`No module named 'models.evidence'`).

```python
# backend/models/evidence.py
"""Per-trip place evidence contract — mirrors frontend TripPlaceEvidence (guardrail #4).

This is the object stored in trip_places.evidence_json. `quote` is the primary verbatim
quote; `quotes` preserves the dedup flywheel's merged multi-source quotes.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

EvidenceKind = Literal[
    "reel_quote", "requested_by_you", "research", "mapbox_route", "open_meteo",
    "travala_hotel_search", "memory_preference", "inferred_default", "suggested_by_astrail",
]


class TripPlaceEvidence(BaseModel):
    confidence: float
    source_url: str | None = None
    quote: str | None = None
    quotes: list[str] = Field(default_factory=list)
    rationale: str | None = None
    evidence_kind: EvidenceKind
```

Run again → PASS (2 passed).

- [ ] **Step 3: Write the failing persist test**

```python
# backend/pipeline/test_persist.py  (append; _cp helper already defined at top)
import pytest


def test_evidence_kind_maps_source_type():
    assert persist._evidence_kind("reel_extracted") == "reel_quote"
    assert persist._evidence_kind("user_requested") == "requested_by_you"
    assert persist._evidence_kind("agent_suggested") == "suggested_by_astrail"
    assert persist._evidence_kind("nonsense") == "suggested_by_astrail"  # safe fallback


@pytest.mark.parametrize("src,kind", [
    ("reel_extracted", "reel_quote"),
    ("user_requested", "requested_by_you"),
    ("agent_suggested", "suggested_by_astrail"),
])
def test_evidence_json_conforms_to_TripPlaceEvidence(src, kind):
    p = _cp("Senso-ji", 35.71, 139.79, source_type=src)
    ev = persist._evidence_json(p)
    # exact contract key set — no legacy keys (evidence_quote/evidence_quotes must be GONE)
    assert set(ev.keys()) == {"confidence", "source_url", "quote", "quotes",
                              "rationale", "evidence_kind"}
    assert "evidence_quote" not in ev and "evidence_quotes" not in ev
    assert ev["quote"] == "📍Senso-ji"
    assert ev["quotes"] == ["📍Senso-ji"]
    assert ev["rationale"] is None
    assert ev["evidence_kind"] == kind
    assert ev["confidence"] == 0.9
```

- [ ] **Step 4: Run it (fails), then implement**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k evidence -v` → FAIL (`_evidence_kind` missing; key-set mismatch).

Add the import near the other model imports at the top of `backend/pipeline/persist.py`:

```python
from models.evidence import TripPlaceEvidence
```

Replace `_evidence_json` at `backend/pipeline/persist.py:48-55` with:

```python
def _evidence_kind(source_type: str) -> str:
    # trip_places holds only these 3 source types (restaurants/hotels have their own tables).
    return {
        "reel_extracted": "reel_quote",
        "user_requested": "requested_by_you",
        "agent_suggested": "suggested_by_astrail",
    }.get(source_type, "suggested_by_astrail")


def _evidence_json(place: CanonicalPlace) -> dict:
    # Per-trip evidence — typed to the frontend TripPlaceEvidence contract (guardrail #4).
    return TripPlaceEvidence(
        confidence=place.confidence,
        source_url=place.source_url,
        quote=place.evidence_quote,                                   # primary verbatim quote
        quotes=list(getattr(place, "evidence_quotes", []) or []),     # dedup flywheel
        rationale=None,                                               # seam for agent_suggested "why"
        evidence_kind=_evidence_kind(place.source_type),
    ).model_dump()
```

Run: `cd backend && uv run pytest pipeline/test_persist.py -v` → PASS (all persist tests; existing `test_persist` row-shape assertions still hold — `evidence_json` is still a dict on `trip_places`).

- [ ] **Step 5: Update the TS contract + fixtures (evidence side)**

In `frontend/lib/trip/backend-types.ts`, add one field to `TripPlaceEvidence` (line ~52):

```ts
export type TripPlaceEvidence = {
  confidence: number
  source_url: string | null
  quote: string | null            // primary verbatim reel/user quote (PRD §11/§12)
  quotes: string[]                // all merged-source quotes (dedup flywheel)
  rationale: string | null        // agent_suggested rationale
  evidence_kind: EvidenceKind
}
```

In `frontend/lib/trip/fixtures/tokyo-trip.ts`, add `quotes` to EACH of the SIX `TripPlace` evidence literals (lines 47–72). The value is `[quote]` when `quote` is a string, `[]` when `quote` is `null`:

```ts
// tp_senso   (reel):  quote: 'you HAVE to see Senso-ji at sunrise', quotes: ['you HAVE to see Senso-ji at sunrise'], rationale: null, ...
// tp_teamlab (reel):  quotes: ['teamLab Planets is unreal 🌊']
// tp_shibuya (reel):  quotes: ['Shibuya Sky at golden hour']
// tp_ichiran (agent): quote: null, quotes: [], rationale: 'Ramen near Shibuya Sky…', ...
// tp_disney  (user):  quote: 'Also want to go Tokyo Disneyland', quotes: ['Also want to go Tokyo Disneyland'], ...
// tp_hotelbase(agent):quote: null, quotes: [], rationale: 'Central Shinjuku base…', ...
```

DO NOT touch the `restaurants` block (line 118) — `rest_1.evidence_json` at line 123 is a `RestaurantSuggestion`, a different type; leave it as-is.

In `frontend/components/trip/__tests__/EvidenceChip.test.tsx`, add `quotes` to the typed `reel` literal (line 6-9):

```ts
const reel: TripPlaceEvidence = {
  confidence: 0.82, source_url: 'https://instagram.com/reel/abc',
  quote: 'the temple at dawn is unreal', quotes: ['the temple at dawn is unreal'],
  rationale: null, evidence_kind: 'reel_quote',
}
```

- [ ] **Step 6: Run frontend typecheck + tests**

Run: `cd frontend && npx tsc --noEmit && npm test`
Expected: `tsc` clean (the required `quotes` is now present in every `TripPlaceEvidence` literal); frontend tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/models/evidence.py backend/models/test_evidence.py backend/pipeline/persist.py backend/pipeline/test_persist.py frontend/lib/trip/backend-types.ts frontend/lib/trip/fixtures/tokyo-trip.ts frontend/components/trip/__tests__/EvidenceChip.test.tsx
git commit -m "feat(evidence): typed TripPlaceEvidence emission (quote/quotes/rationale/evidence_kind)"
```

---

### Task 3: Tradeoff pure functions (notes + comparisons)

**Files:**
- Create: `backend/pipeline/tradeoffs.py`
- Create: `backend/pipeline/test_tradeoffs.py`

**Interfaces:**
- Consumes: `models.trip.FeasibilityWarning(kind, day_number, detail, leg_m, severity)`; `group_places_by_day` output `list[tuple[int, list[CanonicalPlace]]]`; `hotel_suggestions` rows (dicts with `id`, `name`, `star_rating`, `price_snapshot={pricePerNight,totalPrice,currency}`).
- Produces: `warnings_to_notes(warnings, groups=None) -> list[TripTradeoffNote]`; `build_hotel_comparisons(hotel_rows) -> list[TripTradeoffComparison]`.

- [ ] **Step 1: Write the failing test**

```python
# backend/pipeline/test_tradeoffs.py
from models.trip import FeasibilityWarning
from pipeline.tradeoffs import build_hotel_comparisons, warnings_to_notes


def _w(kind, day, detail, sev, leg_m=None):
    return FeasibilityWarning(kind=kind, day_number=day, detail=detail, severity=sev, leg_m=leg_m)


def test_warnings_to_notes_maps_fields_and_severity_none_to_info():
    ws = [_w("long_leg", 2, "4200 m A -> B (flag)", "flag", leg_m=4200.0),
          _w("empty_day", 3, "day has no stops", None)]
    notes = warnings_to_notes(ws)
    assert [n.kind for n in notes] == ["long_leg", "empty_day"]
    assert notes[0].scope == "day" and notes[0].leg_m == 4200.0 and notes[0].severity == "flag"
    assert notes[1].severity == "info"          # None -> info
    assert all(n.refs == [] for n in notes)     # no groups passed


def test_warnings_to_notes_fills_refs_from_groups():
    class P:
        def __init__(self, name): self.name = name
    groups = [(2, [P("Senso-ji"), P("Tokyo Tower")])]
    notes = warnings_to_notes([_w("overpacked_day", 2, "…", "warn")], groups=groups)
    assert notes[0].refs == ["Senso-ji", "Tokyo Tower"]


def _hotel(id_, name, price, star, *, key="pricePerNight"):
    return {"id": id_, "name": name, "star_rating": star,
            "price_snapshot": {key: price, "currency": "JPY"}}


def test_build_hotel_comparisons_price_vs_rating():
    rows = [_hotel("a", "Cheap Inn", 8000, 3), _hotel("b", "Grand", 12000, 5)]
    comps = build_hotel_comparisons(rows)
    assert len(comps) == 1
    c = comps[0]
    assert c.axis == "price_vs_rating" and c.scope == "hotel"
    assert set(c.refs) == {"a", "b"}
    assert c.option_a.label == "Cheap Inn" and "8000" in c.option_a.value
    assert "/night" in c.option_a.value          # pricePerNight labeled per-night
    assert c.recommendation is None              # 2-star gap (>1) -> no clear winner


def test_build_hotel_comparisons_recommends_cheaper_on_small_rating_gap():
    rows = [_hotel("a", "Cheap", 8000, 4), _hotel("b", "Grand", 12000, 5)]
    comps = build_hotel_comparisons(rows)
    assert comps[0].recommendation == "Cheap"    # gap == 1 -> recommend cheaper


def test_build_hotel_comparisons_total_price_labeled_total():
    rows = [_hotel("a", "A", 40000, 3, key="totalPrice"),
            _hotel("b", "B", 60000, 4, key="totalPrice")]
    comps = build_hotel_comparisons(rows)
    assert "total" in comps[0].option_a.value    # totalPrice NOT mislabeled as /night


def test_build_hotel_comparisons_edge_cases():
    assert build_hotel_comparisons([]) == []
    assert build_hotel_comparisons([_hotel("a", "Solo", 8000, 3)]) == []
    # both unpriced -> no comparison
    assert build_hotel_comparisons(
        [{"id": "a", "name": "X", "star_rating": 3, "price_snapshot": {}},
         {"id": "b", "name": "Y", "star_rating": 4, "price_snapshot": {}}]) == []
```

- [ ] **Step 2: Run it (fails), then implement**

Run: `cd backend && uv run pytest pipeline/test_tradeoffs.py -v` → FAIL (`No module named 'pipeline.tradeoffs'`).

```python
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
    cheapest = min(priced, key=lambda t: t[1])
    others = [t for t in priced if t[0]["id"] != cheapest[0]["id"]]
    # highest-rated distinct row; ties broken by higher price (a clearly different option)
    best = max(others, key=lambda t: (t[0].get("star_rating") or 0, t[1]))
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
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_tradeoffs.py -v`
Expected: PASS (6 passed)

- [ ] **Step 4: Commit**

```bash
git add backend/pipeline/tradeoffs.py backend/pipeline/test_tradeoffs.py
git commit -m "feat(tradeoff): deterministic warnings_to_notes + build_hotel_comparisons (price_vs_rating)"
```

---

### Task 4: Migration + single-write `persist_tradeoffs`

**Files:**
- Create: `supabase/migrations/20260715120000_trip_tradeoffs.sql`
- Modify: `backend/pipeline/persist.py` (add `persist_tradeoffs`, near the other enrich persisters)
- Modify: `backend/pipeline/test_persist.py` (persist_tradeoffs tests, using the existing `_Client` at `test_persist.py:94`)

**Interfaces:**
- Produces: `persist.persist_tradeoffs(client, trip_id: str, user_id: str, *, notes, comparisons) -> None` — ONE owner-checked UPDATE writing `{notes, comparisons}`. No read (no read-modify-write). Accepts model lists OR dicts.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260715120000_trip_tradeoffs.sql
alter table public.trips
  add column if not exists tradeoffs jsonb not null
  default '{"notes": [], "comparisons": []}'::jsonb;

comment on column public.trips.tradeoffs is
  'Trip-level tradeoffs contract: { notes: TripTradeoffNote[], comparisons: TripTradeoffComparison[] }. '
  'notes = deterministic feasibility gaps; comparisons = derived hotel A-vs-B (price_vs_rating). See '
  'docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md.';

-- refresh the stale evidence comment to name the exact TripPlaceEvidence keys
comment on column public.trip_places.evidence_json is
  'Per-trip place evidence contract (TripPlaceEvidence): '
  '{ confidence, source_url, quote, quotes, rationale, evidence_kind }.';
```

- [ ] **Step 2: Write the failing test**

```python
# backend/pipeline/test_persist.py  (append; reuse the existing _Client at line 94)
import asyncio

from models.tradeoff import TradeoffOption, TripTradeoffComparison, TripTradeoffNote


def test_persist_tradeoffs_writes_full_object_in_one_update():
    from pipeline.persist import persist_tradeoffs
    c = _Client({"trips": [{"id": "t1", "user_id": "u1",
                            "tradeoffs": {"notes": [], "comparisons": []}}]})
    note = TripTradeoffNote(kind="empty_day", scope="day", severity="flag",
                            detail="day has no stops", day_number=3)
    comp = TripTradeoffComparison(
        axis="price_vs_rating",
        option_a=TradeoffOption(label="A", value="8000 JPY/night", pro="cheaper", con="3-star"),
        option_b=TradeoffOption(label="B", value="12000 JPY/night", pro="4-star", con="pricier"),
        refs=["a", "b"])
    asyncio.run(persist_tradeoffs(c, "t1", "u1", notes=[note], comparisons=[comp]))
    row = c.db["trips"][0]
    assert row["tradeoffs"]["notes"][0]["kind"] == "empty_day"
    assert row["tradeoffs"]["comparisons"][0]["axis"] == "price_vs_rating"


def test_persist_tradeoffs_is_owner_scoped():
    from pipeline.persist import persist_tradeoffs
    c = _Client({"trips": [{"id": "t1", "user_id": "u1",
                            "tradeoffs": {"notes": [], "comparisons": []}}]})
    # wrong user -> no row matches -> nothing written
    asyncio.run(persist_tradeoffs(c, "t1", "WRONG", notes=[], comparisons=[]))
    assert c.db["trips"][0]["tradeoffs"] == {"notes": [], "comparisons": []}
```

> Verify the `_Client`/`_Table` fake at `test_persist.py:53-96` applies `update(...).eq("id").eq("user_id")` by writing into the matched row (the weather/hotel persist tests already rely on update-then-observe). If `update` does not mutate `self.db`, extend `_Table.execute` minimally so an `("update", patch)` op writes `patch` into every row matching the accumulated `.eq` filters. Keep it additive.

- [ ] **Step 3: Run it (fails), then implement**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k tradeoffs -v` → FAIL (`ImportError: cannot import name 'persist_tradeoffs'`).

Add to `backend/pipeline/persist.py`:

```python
def _dump(items) -> list[dict]:
    return [it.model_dump() if hasattr(it, "model_dump") else dict(it) for it in (items or [])]


async def persist_tradeoffs(client, trip_id: str, user_id: str, *, notes, comparisons) -> None:
    """Additive, owner-checked (guardrail #6): write the FULL tradeoffs object in ONE update.

    Deliberately NO read-modify-write — a transient read failure must never erase a sibling
    field. The runner computes notes before the enrich gather and comparisons after it, then
    calls this ONCE with both. Best-effort is the caller's responsibility (guardrail #3)."""
    payload = {"notes": _dump(notes), "comparisons": _dump(comparisons)}
    await client.table("trips").update({"tradeoffs": payload}) \
        .eq("id", trip_id).eq("user_id", user_id).execute()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_persist.py -v`
Expected: PASS (all persist tests including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260715120000_trip_tradeoffs.sql backend/pipeline/persist.py backend/pipeline/test_persist.py
git commit -m "feat(tradeoff): trips.tradeoffs migration + single-write owner-checked persist_tradeoffs"
```

---

### Task 5: Runner wiring + integration test + frozen-eval guard

**Files:**
- Modify: `backend/pipeline/runner.py` (imports; compute notes after `persist_itinerary` ~line 218; single tradeoffs write after `asyncio.gather` ~line 316)
- Modify: `backend/pipeline/test_runner.py` (integration test) — if the runner integration test lives in a differently-named file, add the test there instead (grep for the existing offline `_run`/`generate` test that injects `weather=/transport=/restaurant=/hotel=/narrator=`).
- Modify: `backend/evals/test_run_eval.py` (frozen-anchor regression)

**Interfaces:**
- Consumes: `itinerary.feasibility_warnings` (in scope from `assemble_itinerary`, runner.py:190); `group_places_by_day(canonical, dates)`; `warnings_to_notes`, `build_hotel_comparisons`, `persist_tradeoffs`; `hotel_suggestions` rows re-read after the gather.

- [ ] **Step 1: Add imports at the top of `runner.py`**

```python
from pipeline.feasibility import group_places_by_day
from pipeline.tradeoffs import build_hotel_comparisons, warnings_to_notes
from pipeline.persist import persist_tradeoffs   # or add to the existing `from pipeline.persist import ...`
```

- [ ] **Step 2: Compute notes after `persist_itinerary` (do NOT write yet)**

Immediately after the `dropped = await persist_itinerary(...)` block (runner.py ~line 218-231, inside the existing `try`), add:

```python
            # TRADEOFF NOTES — the FeasibilityWarnings feasibility.py flagged as "the seam".
            # Computed here (warnings + groups in scope); WRITTEN once after the enrich gather.
            try:
                _tradeoff_notes = warnings_to_notes(
                    itinerary.feasibility_warnings,
                    groups=group_places_by_day(canonical, dates))
            except Exception:
                _tradeoff_notes = []
```

- [ ] **Step 3: Single tradeoffs write AFTER the enrich gather**

Immediately after `await asyncio.gather(_stage_transport(), _stage_restaurants(), _stage_hotels(), _stage_narration(), return_exceptions=True)` (runner.py ~line 315-316, still inside the same `try`), add:

```python
            # ONE tradeoffs write (notes computed pre-gather + comparisons from persisted hotels).
            # No read-modify-write; best-effort (a failure must never fail the trip, guardrail #3).
            try:
                _hotel_rows = (await client.table("hotel_suggestions")
                               .select("id,name,star_rating,price_snapshot")
                               .eq("trip_id", trip_id).execute()).data or []
                _comparisons = build_hotel_comparisons(_hotel_rows)
                await persist_tradeoffs(client, trip_id, user_id,
                                        notes=_tradeoff_notes, comparisons=_comparisons)
            except Exception:
                pass   # best-effort — tradeoffs must never fail the trip
```

- [ ] **Step 4: Write the integration test (proves BOTH contracts are wired)**

Mirror the existing runner integration test (offline, injected agents, `_Client` fake). Drive a run whose itinerary has a guaranteed `long_leg` (two coord places >4000 m apart → `assess_feasibility` emits a `flag`), and inject a hotel fake returning TWO priced hotels. Then assert the persisted `trips.tradeoffs`:

```python
def test_run_persists_tradeoff_notes_and_comparisons(...):
    # ... existing offline setup with _Client fake + injected weather/transport/restaurant/narrator ...
    # inject a hotel fake returning two priced hotels:
    async def _fake_hotels(location, check_in, check_out, rooms):
        return "sess", [
            {"name": "Cheap Inn", "star": 3, "pricePerNight": 8000, "currency": "JPY", "hotelId": 1},
            {"name": "Grand", "star": 5, "pricePerNight": 12000, "currency": "JPY", "hotelId": 2},
        ]
    # ... run generation with two far-apart places (e.g. Tokyo + Osaka coords) and hotel=_fake_hotels ...
    trip = fake.db["trips"][0]
    notes = trip["tradeoffs"]["notes"]
    comps = trip["tradeoffs"]["comparisons"]
    assert any(n["kind"] == "long_leg" for n in notes)        # notes are wired, not empty
    assert comps and comps[0]["axis"] == "price_vs_rating"    # comparisons are wired
    assert set(comps[0]["refs"]) and comps[0]["option_a"]["label"] and comps[0]["option_b"]["label"]
```

> Follow the existing runner test's construction exactly (same `_Client` fake, same injected agent fakes, same `generate`/`_run` entry point). If the shipped offline fixture yields no flag leg, use two far-apart coord places so `assess_feasibility` emits `long_leg`.

- [ ] **Step 5: Add the frozen-eval regression (freezes 6229.0)**

The existing `test_pipeline_route_beats_or_matches_baseline_on_parity_anchors` (`backend/evals/test_run_eval.py:60`) only asserts `mean_intra_day_travel_m <= baseline`. Add a sibling test that freezes the exact value (confirmed `6229.0` by a live eval run), using the same `load_case`/`build_ctx` + metric helpers that test already imports:

```python
def test_pipeline_mean_intra_day_travel_is_frozen_anchor():
    # Freezes the deterministic route anchor. This feature is additive (evidence + tradeoffs
    # emitted AFTER assembly); if this value moves, dedup/assemble_itinerary changed — investigate.
    case = load_case("japan_first_trip")
    pipe_ctx = build_ctx(case, "pipeline")
    # reuse the same metric accessor the parity-anchor test uses to read mean_intra_day_travel_m
    assert metric_value(pipe_ctx, "mean_intra_day_travel_m") == 6229.0
```

> Read `test_run_eval.py:60-90` to use the ACTUAL metric accessor (the parity-anchor test already computes `mean_intra_day_travel_m` for `pipe_ctx` — call it the same way; `metric_value` above is a placeholder for whatever that test uses). The frozen value is `6229.0`.

- [ ] **Step 6: Run the integration test + full backend suite + eval**

Run: `cd backend && uv run pytest pipeline/ evals/ -v` then `cd backend && uv run pytest`
Expected: all green (previously 431 passed, 6 skipped — now +new tests). The frozen-anchor test passes at exactly `6229.0`.

- [ ] **Step 7: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py backend/evals/test_run_eval.py
git commit -m "feat(tradeoff): wire feasibility notes + hotel comparisons (one write); freeze eval anchor 6229.0"
```

---

## Self-Review

**Spec coverage:**
- Evidence reconciliation + typed `TripPlaceEvidence` Pydantic model → Task 2. ✅
- `quotes` multi-source preservation → Task 2 (Pydantic + TS + all 7 fixtures). ✅
- Tradeoff note + comparison types + `TripTradeoffs` → Task 1. ✅
- `Trip.tradeoffs` TS row field → Task 1 Step 5. ✅ (was the schema-parity gap Codex flagged)
- Notes from `FeasibilityWarning` → Task 3 + Task 5. ✅
- Comparisons from persisted hotel rows, `price_vs_rating`, price/total labeling, ties → Task 3 (matches amended spec §4b). ✅
- `trips.tradeoffs` migration, full-shape default, evidence-comment refresh → Task 4. ✅
- Single-write `persist_tradeoffs` (no read-modify-write) → Task 4 + Task 5. ✅ (kills the erase bug)
- Integration test proving BOTH contracts wired (non-empty note + real comparison) → Task 5 Step 4. ✅
- Frozen eval anchor `6229.0` regression → Task 5 Step 5. ✅
- Three-side schema parity in one PR → Tasks 1, 2, 4. ✅

**Placeholder scan:** every code step has full code. Two `>` notes (verify the `_Client` fake's `update`; use the real metric accessor in the eval test) instruct the implementer to ground against actual code — they are verification guardrails, not gaps.

**Type consistency:** `_evidence_json`/`_evidence_kind`/`TripPlaceEvidence` (Task 2) match. `warnings_to_notes`/`build_hotel_comparisons` (Task 3) signatures match the runner call sites (Task 5) and `persist_tradeoffs(client, trip_id, user_id, *, notes, comparisons)` (Task 4). `TripTradeoff*` field names match across Pydantic (Task 1), TS (Task 1), and the pure functions (Task 3). No `_FakeClient` — uses the real `_Client`.
