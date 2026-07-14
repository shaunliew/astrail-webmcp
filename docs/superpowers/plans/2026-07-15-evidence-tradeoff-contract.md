# Evidence & Tradeoff Frontend Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the backend emit place evidence that conforms to the frozen frontend `TripPlaceEvidence` contract, and add a structured `trips.tradeoffs` contract (deterministic feasibility *notes* + hotel *comparisons*) — so real trips render evidence chips/quotes and tradeoffs instead of blank fixtures.

**Architecture:** Deterministic-first, single-PR schema parity. Rewrite the `evidence_json` writer to compute `evidence_kind` from `source_type`; wire the already-computed-but-dropped `FeasibilityWarning`s into `trips.tradeoffs.notes`; derive `trips.tradeoffs.comparisons` from persisted `hotel_suggestions` rows. No new LLM calls — the deterministic dedup/assembly path and the frozen eval anchor are untouched.

**Tech Stack:** Python 3.14 + Pydantic v2 + pytest (backend, `uv`); TypeScript (frontend contract types); Supabase Postgres migration (SQL). FastAPI/SSE runner in `backend/pipeline/runner.py`.

## Global Constraints

- **Schema parity (guardrail #4):** every Pydantic field has a TypeScript mirror in `frontend/lib/trip/backend-types.ts`; DB schema in `supabase/migrations/*.sql`. All three sides ship in this PR.
- **No hallucinated places (guardrail #1):** additive only — never drop/alter a place's identity.
- **Partial failure is acceptable (guardrail #3):** tradeoff writes are best-effort; a failure must NEVER fail the trip.
- **Caches/writes are write-through (guardrail #7):** persist before returning.
- **Owner check (guardrail #6):** every `trips` write is `.eq("id", trip_id).eq("user_id", user_id)` — RLS + app-code.
- **No new LLM in this feature.** Notes come from `FeasibilityWarning`; comparisons from numeric hotel fields. Eval-safety: the frozen `mean_intra_day_travel_m = 6229.0` anchor and `dedupe`/`assemble_itinerary` are untouched.
- **No `requirements.txt`** — `uv` only. Run backend tests with `cd backend && uv run pytest`.
- **Spec:** `docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md`.
- **Spec deviation (locked here):** hotels have NO `distance_m`/coords (`persist_hotels` sets `base_place_id=NULL`), so the comparison axis is **`price_vs_rating`** (price_snapshot + star_rating), NOT the spec's `price_vs_location`. Update the spec §4b when this lands.

---

### Task 1: Tradeoff types (Pydantic + TypeScript)

**Files:**
- Create: `backend/models/tradeoff.py`
- Create: `backend/models/test_tradeoff.py`
- Modify: `frontend/lib/trip/backend-types.ts` (add tradeoff types; append near the evidence region ~line 55)

**Interfaces:**
- Produces (Python): `TripTradeoffNote`, `TradeoffOption`, `TripTradeoffComparison`, `TripTradeoffs` (all `pydantic.BaseModel`).
- Produces (TS): `TripTradeoffNote`, `TradeoffOption`, `TripTradeoffComparison`, `TripTradeoffs`.

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

- [ ] **Step 5: Add the TypeScript mirror**

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

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend/models/tradeoff.py backend/models/test_tradeoff.py frontend/lib/trip/backend-types.ts
git commit -m "feat(tradeoff): TripTradeoff Pydantic models + TS mirror"
```

---

### Task 2: Evidence emission reconciliation

**Files:**
- Modify: `backend/pipeline/persist.py:48-55` (`_evidence_json`; add `_evidence_kind`)
- Modify: `backend/pipeline/test_persist.py` (add evidence tests)
- Modify: `frontend/lib/trip/backend-types.ts:49-55` (`TripPlaceEvidence` — add `quotes`)
- Modify: `frontend/lib/trip/fixtures/tokyo-trip.ts` (add `quotes` to each `evidence_json`)

**Interfaces:**
- Produces (Python): `persist._evidence_kind(source_type: str) -> str`; `persist._evidence_json(place: CanonicalPlace) -> dict` now returns keys `{confidence, source_url, quote, quotes, rationale, evidence_kind}`.
- Consumes: `CanonicalPlace.source_type` ∈ `{reel_extracted, user_requested, agent_suggested}`; `.evidence_quote` (str), `.evidence_quotes` (list[str]).

- [ ] **Step 1: Write the failing test**

```python
# backend/pipeline/test_persist.py  (append; _cp helper already defined at top)
def test_evidence_kind_maps_source_type():
    assert persist._evidence_kind("reel_extracted") == "reel_quote"
    assert persist._evidence_kind("user_requested") == "requested_by_you"
    assert persist._evidence_kind("agent_suggested") == "suggested_by_astrail"
    assert persist._evidence_kind("nonsense") == "suggested_by_astrail"  # safe fallback


def test_evidence_json_conforms_to_TripPlaceEvidence_contract():
    p = _cp("Senso-ji", 35.71, 139.79, source_type="reel_extracted")
    ev = persist._evidence_json(p)
    assert set(ev.keys()) == {"confidence", "source_url", "quote", "quotes",
                              "rationale", "evidence_kind"}
    assert ev["quote"] == "📍Senso-ji"           # primary verbatim quote
    assert ev["quotes"] == ["📍Senso-ji"]         # multi-source flywheel list
    assert ev["rationale"] is None
    assert ev["evidence_kind"] == "reel_quote"
    assert ev["confidence"] == 0.9
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k evidence -v`
Expected: FAIL — `AttributeError: module 'pipeline.persist' has no attribute '_evidence_kind'` and the key-set assertion (current `_evidence_json` emits `evidence_quote`/`evidence_quotes`, not `quote`/`quotes`/`rationale`/`evidence_kind`).

- [ ] **Step 3: Write minimal implementation**

Replace `_evidence_json` at `backend/pipeline/persist.py:48-55` with:

```python
def _evidence_kind(source_type: str) -> str:
    # trip_places only ever holds these 3 source types (restaurants/hotels have their own tables).
    return {
        "reel_extracted": "reel_quote",
        "user_requested": "requested_by_you",
        "agent_suggested": "suggested_by_astrail",
    }.get(source_type, "suggested_by_astrail")


def _evidence_json(place: CanonicalPlace) -> dict:
    # Per-trip evidence — conforms to frontend TripPlaceEvidence (guardrail #4). `quote` is the
    # primary verbatim quote; `quotes` preserves the dedup flywheel's merged multi-source quotes.
    return {
        "confidence": place.confidence,
        "source_url": place.source_url,
        "quote": place.evidence_quote,
        "quotes": list(getattr(place, "evidence_quotes", []) or []),
        "rationale": None,   # seam: populated when agent_suggested places carry a "why"
        "evidence_kind": _evidence_kind(place.source_type),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_persist.py -v`
Expected: PASS (all persist tests, including the two new ones; the existing `test_persist` row-shape assertions still hold — `evidence_json` is still a dict written to `trip_places`).

- [ ] **Step 5: Update the TS contract + fixtures**

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

In `frontend/lib/trip/fixtures/tokyo-trip.ts`, add `quotes: [<the same quote>]` next to every `quote:` in an `evidence_json`/`TripPlaceEvidence` literal (e.g. `quote: 'you HAVE to see Senso-ji at sunrise', quotes: ['you HAVE to see Senso-ji at sunrise'], ...`). For the `evidence_json: { evidence_kind: 'suggested_by_astrail' }` shorthand at `tokyo-trip.ts:123`, expand to the full shape: `{ confidence: 0.8, source_url: 'https://ichiran.com/', quote: null, quotes: [], rationale: 'Ramen near Shibuya Sky…', evidence_kind: 'suggested_by_astrail' }`.

- [ ] **Step 6: Run frontend typecheck + tests**

Run: `cd frontend && npx tsc --noEmit && npm test`
Expected: `tsc` clean; frontend tests green (the `EvidenceChip`/`tokyo-trip` tests still pass with the added field).

- [ ] **Step 7: Commit**

```bash
git add backend/pipeline/persist.py backend/pipeline/test_persist.py frontend/lib/trip/backend-types.ts frontend/lib/trip/fixtures/tokyo-trip.ts
git commit -m "feat(evidence): emit TripPlaceEvidence-conformant evidence_json (quote/quotes/rationale/evidence_kind)"
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
from models.tradeoff import TripTradeoffComparison, TripTradeoffNote
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
    class P:  # minimal place-like stub with .name
        def __init__(self, name): self.name = name
    groups = [(2, [P("Senso-ji"), P("Tokyo Tower")])]
    notes = warnings_to_notes([_w("overpacked_day", 2, "…", "warn")], groups=groups)
    assert notes[0].refs == ["Senso-ji", "Tokyo Tower"]


def _hotel(id_, name, price, star):
    return {"id": id_, "name": name, "star_rating": star,
            "price_snapshot": {"pricePerNight": price, "currency": "JPY"}}


def test_build_hotel_comparisons_price_vs_rating():
    rows = [_hotel("a", "Cheap Inn", 8000, 3), _hotel("b", "Grand", 12000, 5)]
    comps = build_hotel_comparisons(rows)
    assert len(comps) == 1
    c = comps[0]
    assert c.axis == "price_vs_rating" and c.scope == "hotel"
    assert set(c.refs) == {"a", "b"}
    assert "8000" in c.option_a.value and c.option_a.label == "Cheap Inn"


def test_build_hotel_comparisons_needs_two_priced_hotels():
    assert build_hotel_comparisons([]) == []
    assert build_hotel_comparisons([_hotel("a", "Solo", 8000, 3)]) == []
    # both priced-none -> no comparison
    assert build_hotel_comparisons(
        [{"id": "a", "name": "X", "star_rating": 3, "price_snapshot": {}},
         {"id": "b", "name": "Y", "star_rating": 4, "price_snapshot": {}}]) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_tradeoffs.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.tradeoffs'`

- [ ] **Step 3: Write minimal implementation**

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


def _price(row: dict) -> float | None:
    snap = row.get("price_snapshot") or {}
    val = snap.get("pricePerNight", snap.get("totalPrice"))
    try:
        return float(val) if val is not None else None
    except (TypeError, ValueError):
        return None


def _fmt(price: float, snap_currency: str | None) -> str:
    cur = snap_currency or ""
    return f"{int(price)} {cur}/night".strip()


def build_hotel_comparisons(hotel_rows) -> list[TripTradeoffComparison]:
    priced = [(r, p) for r in hotel_rows if (p := _price(r)) is not None]
    if len(priced) < 2:
        return []
    cheapest, cheapest_p = min(priced, key=lambda rp: rp[1])
    # highest-rated distinct from cheapest (fall back to priciest if star ties are unhelpful)
    others = [rp for rp in priced if rp[0]["id"] != cheapest["id"]]
    best, best_p = max(others, key=lambda rp: (rp[0].get("star_rating") or 0, rp[1]))
    c_cur = (cheapest.get("price_snapshot") or {}).get("currency")
    b_cur = (best.get("price_snapshot") or {}).get("currency")
    c_star = cheapest.get("star_rating")
    b_star = best.get("star_rating")
    option_a = TradeoffOption(
        label=cheapest["name"], value=_fmt(cheapest_p, c_cur),
        pro=f"cheaper ({_fmt(cheapest_p, c_cur)})",
        con=f"{c_star or '?'}-star")
    option_b = TradeoffOption(
        label=best["name"], value=_fmt(best_p, b_cur),
        pro=f"higher rated ({b_star or '?'}-star)",
        con=f"pricier ({_fmt(best_p, b_cur)})")
    # deterministic recommendation: prefer the cheaper one when the rating gap is small (<=1 star)
    rec = None
    if b_star is not None and c_star is not None and (b_star - c_star) <= 1:
        rec = cheapest["name"]
    return [TripTradeoffComparison(
        axis="price_vs_rating", option_a=option_a, option_b=option_b,
        recommendation=rec, refs=[cheapest["id"], best["id"]])]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_tradeoffs.py -v`
Expected: PASS (5 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/tradeoffs.py backend/pipeline/test_tradeoffs.py
git commit -m "feat(tradeoff): deterministic warnings_to_notes + build_hotel_comparisons"
```

---

### Task 4: Migration + `persist_tradeoffs`

**Files:**
- Create: `supabase/migrations/20260715120000_trip_tradeoffs.sql`
- Modify: `backend/pipeline/persist.py` (add `persist_tradeoffs`, near the other enrich persisters)
- Modify: `backend/pipeline/test_persist.py` (add persist_tradeoffs tests, using the existing `_Table`/`_Result` fake)

**Interfaces:**
- Produces: `persist.persist_tradeoffs(client, trip_id: str, user_id: str, *, notes=None, comparisons=None) -> None` — read-modify-write merge of `trips.tradeoffs`, owner-checked, idempotent.
- Consumes: `TripTradeoffNote` / `TripTradeoffComparison` lists (or their `.model_dump()` dicts).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260715120000_trip_tradeoffs.sql
alter table public.trips add column if not exists tradeoffs jsonb not null default '{}'::jsonb;

comment on column public.trips.tradeoffs is
  'Trip-level tradeoffs contract: { notes: TripTradeoffNote[], comparisons: TripTradeoffComparison[] }. '
  'notes = deterministic feasibility gaps; comparisons = derived hotel A-vs-B (price_vs_rating). See '
  'docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md.';
```

- [ ] **Step 2: Write the failing test**

```python
# backend/pipeline/test_persist.py  (append)
import asyncio

from models.tradeoff import TripTradeoffNote


def test_persist_tradeoffs_merges_notes_then_comparisons(fake_client_factory=None):
    from pipeline.persist import persist_tradeoffs
    from pipeline.test_persist import _FakeClient  # defined in Step 4 if absent
    client = _FakeClient({"trips": [{"id": "t1", "user_id": "u1", "tradeoffs": {}}]})
    note = TripTradeoffNote(kind="empty_day", scope="day", severity="flag",
                            detail="day has no stops", day_number=3)
    asyncio.run(persist_tradeoffs(client, "t1", "u1", notes=[note]))
    row = client.db["trips"][0]
    assert row["tradeoffs"]["notes"][0]["kind"] == "empty_day"
    assert row["tradeoffs"]["comparisons"] == []
    # second call merges comparisons without clobbering notes
    from models.tradeoff import TradeoffOption, TripTradeoffComparison
    comp = TripTradeoffComparison(
        axis="price_vs_rating",
        option_a=TradeoffOption(label="A", value="8000 JPY/night", pro="cheaper", con="3-star"),
        option_b=TradeoffOption(label="B", value="12000 JPY/night", pro="4-star", con="pricier"),
        refs=["a", "b"])
    asyncio.run(persist_tradeoffs(client, "t1", "u1", comparisons=[comp]))
    assert row["tradeoffs"]["notes"][0]["kind"] == "empty_day"     # preserved
    assert row["tradeoffs"]["comparisons"][0]["axis"] == "price_vs_rating"
```

> If `test_persist.py` does not already expose a reusable `_FakeClient` wrapper around
> `_Table`/`_Result` with a public `.db` dict and `.table(name)` method, add a minimal one
> in Step 4 alongside `persist_tradeoffs`. Mirror the existing `_Table` (`select/eq/update/execute`).

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k tradeoffs -v`
Expected: FAIL — `ImportError: cannot import name 'persist_tradeoffs'`

- [ ] **Step 4: Write minimal implementation**

Add to `backend/pipeline/persist.py`:

```python
from models.tradeoff import TripTradeoffComparison, TripTradeoffNote   # top-of-file import


def _dump(items) -> list[dict]:
    out = []
    for it in items or []:
        out.append(it.model_dump() if hasattr(it, "model_dump") else dict(it))
    return out


async def persist_tradeoffs(client, trip_id: str, user_id: str, *,
                            notes=None, comparisons=None) -> None:
    """Additive, owner-checked (guardrail #6), best-effort (guardrail #3): merge the given
    notes and/or comparisons into trips.tradeoffs. Read-modify-write — a single sequential
    caller per field (notes before the enrich gather; comparisons only inside _stage_hotels),
    so no lost update. A missing/failed read degrades to {} (never fails the trip)."""
    try:
        rows = (await client.table("trips").select("tradeoffs")
                .eq("id", trip_id).eq("user_id", user_id).execute()).data
        current = (rows[0].get("tradeoffs") if rows else None) or {}
    except Exception:
        current = {}
    merged = {
        "notes": _dump(notes) if notes is not None else (current.get("notes") or []),
        "comparisons": _dump(comparisons) if comparisons is not None
        else (current.get("comparisons") or []),
    }
    await client.table("trips").update({"tradeoffs": merged}) \
        .eq("id", trip_id).eq("user_id", user_id).execute()
```

Add a `_FakeClient` to `test_persist.py` only if one is not already present (reuse `_Table`/`_Result`):

```python
class _FakeClient:
    def __init__(self, db): self.db = db
    def table(self, name): return _Table(name, self.db)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_persist.py -k tradeoffs -v`
Expected: PASS (1 passed). Then full file: `cd backend && uv run pytest pipeline/test_persist.py -v` — all green.

> If `_Table.update(...).eq(...).eq(...).execute()` in the existing fake does not persist into
> `self.db`, extend `_Table` minimally so `update` writes the row it matched by `id` — mirror
> how the existing weather/hotel tests observe writes. Keep the change additive.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260715120000_trip_tradeoffs.sql backend/pipeline/persist.py backend/pipeline/test_persist.py
git commit -m "feat(tradeoff): trips.tradeoffs migration + owner-checked persist_tradeoffs merge"
```

---

### Task 5: Runner wiring + integration test

**Files:**
- Modify: `backend/pipeline/runner.py` (import; notes after `persist_itinerary` ~line 218; comparisons inside `_stage_hotels` ~line 290)
- Modify: `backend/pipeline/test_runner.py` (or the existing runner integration test file — add a tradeoffs assertion)

**Interfaces:**
- Consumes: `itinerary.feasibility_warnings` (in scope from `assemble_itinerary`, runner.py:190); `group_places_by_day(canonical, dates)`; `warnings_to_notes`, `build_hotel_comparisons`, `persist_tradeoffs`; `hotel_suggestions` rows re-read after `persist_hotels`.

- [ ] **Step 1: Add imports at the top of `runner.py`**

```python
from pipeline.feasibility import group_places_by_day
from pipeline.tradeoffs import build_hotel_comparisons, warnings_to_notes
from pipeline.persist import persist_tradeoffs   # if persist_* are imported individually; else `from pipeline import persist`
```

- [ ] **Step 2: Persist notes after `persist_itinerary`**

Immediately after the `dropped = await persist_itinerary(...)` block succeeds (runner.py ~line 218-231, inside the existing `try`), add (best-effort, guardrail #3):

```python
            # TRADEOFF NOTES — the FeasibilityWarnings feasibility.py flagged as "the seam".
            try:
                _groups = group_places_by_day(canonical, dates)
                _notes = warnings_to_notes(itinerary.feasibility_warnings, groups=_groups)
                await persist_tradeoffs(client, trip_id, user_id, notes=_notes)
            except Exception:
                pass   # best-effort — a tradeoff-note write must never fail the trip
```

- [ ] **Step 3: Persist hotel comparisons inside `_stage_hotels`**

In `_stage_hotels()` (runner.py ~line 290), after `await persist_hotels(client, trip_id, fetch=hotel)`:

```python
                    rows = (await client.table("hotel_suggestions")
                            .select("id,name,star_rating,price_snapshot")
                            .eq("trip_id", trip_id).execute()).data
                    comps = build_hotel_comparisons(rows or [])
                    if comps:
                        await persist_tradeoffs(client, trip_id, user_id, comparisons=comps)
```

(Keep it inside the stage's existing `try/except` so a failure stays a non-critical warning.)

- [ ] **Step 4: Write the failing integration test**

Mirror the existing runner integration test (offline, injected agents, fake client). Assert that after a run with a flaggable itinerary, `trips.tradeoffs.notes` is populated. Example assertion to add to the existing runner test that already drives `_run`/`generate` with a fake client:

```python
def test_run_persists_tradeoff_notes(...):
    # ... existing setup that runs the pipeline offline with injected agents + fake client ...
    trip = fake.db["trips"][0]
    assert "tradeoffs" in trip
    # an itinerary with a >=2000m leg or empty day yields at least one note
    assert isinstance(trip["tradeoffs"].get("notes"), list)
```

> Follow the existing runner test's construction exactly (same fake client, same injected
> `weather=/transport=/restaurant=/hotel=/narrator=` fakes). If the existing offline fixture
> produces no flag/warn legs, add two far-apart coord places so `assess_feasibility` emits a
> `long_leg`, guaranteeing a non-empty `notes` list.

- [ ] **Step 5: Run the integration test to verify it fails, then passes**

Run: `cd backend && uv run pytest pipeline/test_runner.py -k tradeoff -v`
Expected: FAIL first (notes not yet wired / assertion), then PASS after Steps 2-3.

- [ ] **Step 6: Run the full backend + eval-safety check**

Run: `cd backend && uv run pytest`
Expected: all green (previously 431 passed, 6 skipped — now +new tests). Confirm the #16 eval / `mean_intra_day_travel_m` tests are unchanged (this feature is additive to the deterministic path).

- [ ] **Step 7: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(tradeoff): wire feasibility notes + hotel comparisons into the runner (best-effort)"
```

---

## Self-Review

**Spec coverage:**
- Evidence reconciliation (`_evidence_json`→`TripPlaceEvidence`, computed `evidence_kind`) → Task 2. ✅
- `quotes` multi-source preservation → Task 2 (Pydantic + TS + fixtures). ✅
- Tradeoff note type + comparison type → Task 1 (Pydantic + TS). ✅
- Notes from `FeasibilityWarning` → Task 3 `warnings_to_notes` + Task 5 wiring. ✅
- Comparisons from hotels → Task 3 `build_hotel_comparisons` + Task 5 wiring. ✅
- `trips.tradeoffs` migration + column comment → Task 4. ✅
- `persist_tradeoffs` owner-checked, best-effort, merge → Task 4. ✅
- Three-side schema parity in one PR → Tasks 1, 2, 4 (Pydantic + TS + SQL). ✅
- Eval-safety (no LLM, deterministic path untouched) → Task 5 Step 6 full-suite check. ✅
- Narrator title/summary = out of scope (already persisted) → not a task, by design. ✅

**Spec deviation logged:** comparison axis is `price_vs_rating` (hotels have no coords), not the spec's `price_vs_location` — recorded in Global Constraints; update spec §4b on landing.

**Placeholder scan:** every code step contains full code; no TBD/TODO. The two `>` notes (fake-client reuse in Tasks 4/5) instruct the implementer to reuse the existing `_Table` fake rather than invent one — they are guardrails, not gaps.

**Type consistency:** `_evidence_kind`/`_evidence_json` (Task 2) match their calls; `warnings_to_notes`/`build_hotel_comparisons` (Task 3) signatures match the runner calls (Task 5) and the `persist_tradeoffs(client, trip_id, user_id, *, notes=, comparisons=)` signature (Task 4) matches both runner call sites. `TripTradeoff*` field names match across Pydantic (Task 1), TS (Task 1), and the pure functions (Task 3).
