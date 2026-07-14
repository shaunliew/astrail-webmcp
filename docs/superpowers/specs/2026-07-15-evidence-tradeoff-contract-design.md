# Evidence & Tradeoff Frontend Contract — Design

> Board card: **Phase 1 · Both P1 — "evidence and tradeoff frontend contract"**.
> Owner (backend emission): Shaun. Frontend rendering: Zhi Hao. Date: 2026-07-15.
> Scope decision: **A** (evidence emission + BOTH tradeoff shapes — note + comparison).
> Architecture: **Approach 1** (DB-column contract, deterministic-first, single-PR schema parity).

## 1. Problem

The frontend UI is already built against a frozen contract, but the backend emits a
different shape — so the moment the frontend swaps its fixtures for real Supabase rows,
the core "evidence-backed itinerary" pitch breaks silently.

Concretely, three gaps:

1. **Evidence parity break.** `backend/pipeline/persist.py::_evidence_json()` writes
   `{evidence_quote, evidence_quotes, source_url, confidence}`. The frontend
   `frontend/lib/trip/backend-types.ts::TripPlaceEvidence` expects
   `{confidence, source_url, quote, rationale, evidence_kind}`. The quote field is renamed
   (`evidence_quote` → reads `undefined` as `quote`), and `rationale` + `evidence_kind`
   are never emitted. `evidence_kind` is what `EvidenceChip.tsx` renders
   (`KIND_LABEL[evidence.evidence_kind]`) — with it absent, every chip renders blank. The
   TS file header even says: *"Draft frozen contract — reconcile with backend/models before
   real integration."* This card is that reconciliation. There is no frontend
   `evidence_kind` derivation function — the frontend expects it pre-computed (fixtures
   hardcode it), so the **backend must own computing it**.

2. **Tradeoffs have no structured form.** They exist only as free-text inside narrator
   prose (`backend/genagents/narrator.py:38`). The PRD wants them visible: hotel tradeoffs
   (§667 "closer to nightlife vs quieter, cheaper vs further from route") and orchestrator
   gaps/tradeoffs (§894). Meanwhile the backend already computes a deterministic structured
   gap signal — `FeasibilityWarning` (`backend/models/trip.py`) — and **drops it on the
   floor**: `persist.py` imports only `group_places_by_day` from `pipeline/feasibility.py`,
   never the warnings. `feasibility.py` flags this: *"narrator/orchestrator consumption of
   the warnings are deferred — the warnings are the seam."*

3. **(Already done — no backend work.)** Narrator `title`/`summary` ARE persisted: the
   `trips.title` + `trips.summary` columns exist (migration `20260706080000_trip_narration.sql`)
   and `persist_narration()` UPDATEs them from `NarrationResult`. The TS type already
   mirrors them (`backend-types.ts:165-166`). The only remaining gap there is
   `OrchestratorSummary.tsx` ignoring the data — a Zhi Hao rendering task, out of scope here.

## 2. Scope

**In scope (backend emission, this PR):**
- Reconcile `trip_places.evidence_json` to conform to `TripPlaceEvidence`, computing
  `evidence_kind` (from `source_type`) and preserving multi-source quotes.
- Two new structured tradeoff types (`TripTradeoffNote`, `TripTradeoffComparison`),
  persisted to a new `trips.tradeoffs` JSONB column.
- Wire the already-computed `FeasibilityWarning`s into `trips.tradeoffs.notes`.
- Derive `trips.tradeoffs.comparisons` deterministically from `hotel_suggestions`.
- Schema parity across all three sides in one PR (Pydantic + TS + SQL — guardrail #4).

**Out of scope:**
- Frontend rendering (`OrchestratorSummary.tsx`, `EvidenceChip.tsx`, `PlaceIntelPanel.tsx`
  real-data wiring) — Zhi Hao's lane; blocked on this contract.
- Narrator `title`/`summary` — already persisted; no backend change.
- LLM-authored tradeoff prose — deferred behind a concrete trigger (see §8).
- Restaurant/hotel evidence chips on their own tables — they carry `source`; the frontend
  derives their kind from it. Only `trip_places` place evidence is reconciled here.
- Requested-place resolution (a separate Shaun card) — composes via `source_type` only.

## 3. Evidence contract

`trip_places` only ever holds the three deterministic place types (`reel_extracted`,
`user_requested`, `agent_suggested`); restaurants/hotels live in their own tables. So the
`evidence_kind` mapping is a clean 3-case function.

```python
# backend/pipeline/persist.py
def _evidence_kind(source_type: str) -> str:
    return {
        "reel_extracted": "reel_quote",
        "user_requested": "requested_by_you",
        "agent_suggested": "suggested_by_astrail",
    }.get(source_type, "suggested_by_astrail")

def _evidence_json(place: CanonicalPlace) -> dict:
    return {
        "confidence":    place.confidence,
        "source_url":    place.source_url,
        "quote":         place.evidence_quote,               # primary verbatim quote
        "quotes":        list(getattr(place, "evidence_quotes", []) or []),  # multi-source flywheel
        "rationale":     None,   # populated when agent_suggested places carry a "why"
        "evidence_kind": _evidence_kind(place.source_type),
    }
```

**TS change** — `TripPlaceEvidence` gains one field, `quotes: string[]`, to preserve the
dedup flywheel's multi-reel evidence. Existing `quote`, `rationale`, `evidence_kind`,
`confidence`, `source_url` already match.

```ts
export type TripPlaceEvidence = {
  confidence: number
  source_url: string | null
  quote: string | null            // primary verbatim reel/user quote
  quotes: string[]                // NEW — all merged-source quotes (dedup flywheel)
  rationale: string | null        // agent_suggested rationale
  evidence_kind: EvidenceKind
}
```

`rationale` stays `null` for `reel_extracted`/`user_requested` (they carry a quote, not a
rationale); it is the seam for future `agent_suggested` places that carry a "why".

## 4. Tradeoff contract

```python
# new module: backend/models/tradeoff.py
from typing import Literal
from pydantic import BaseModel

class TripTradeoffNote(BaseModel):
    kind: Literal["long_leg", "overpacked_day", "empty_day", "note"]
    scope: Literal["trip", "day", "place"]
    severity: Literal["info", "warn", "flag"]
    detail: str                      # human sentence (from FeasibilityWarning.detail)
    day_number: int | None = None
    refs: list[str] = []             # place names involved
    leg_m: float | None = None

class TradeoffOption(BaseModel):
    label: str
    value: str
    pro: str
    con: str

class TripTradeoffComparison(BaseModel):
    axis: str                        # e.g. "price_vs_location"
    scope: Literal["hotel"] = "hotel"
    option_a: TradeoffOption
    option_b: TradeoffOption
    recommendation: str | None = None
    refs: list[str] = []             # hotel_suggestions ids

class TripTradeoffs(BaseModel):
    notes: list[TripTradeoffNote] = []
    comparisons: list[TripTradeoffComparison] = []
```

### 4a. Notes — from `FeasibilityWarning` (deterministic, no LLM)

`FeasibilityWarning(kind, day_number, detail, leg_m, severity)` maps 1:1:

| FeasibilityWarning | TripTradeoffNote |
|---|---|
| `kind` | `kind` |
| `day_number` | `day_number` |
| `detail` | `detail` |
| `leg_m` | `leg_m` |
| `severity` (`warn`/`flag`) | `severity` (pass-through) |
| — | `scope = "day"` |
| — | `refs` (see below) |

`FeasibilityWarning.severity` is `"warn" | "flag" | None`; a `None` maps to `"info"`.
`FeasibilityWarning` has no `place_names` field, so `refs` is filled best-effort from the
day's place group at the persist seam (where the grouped places are already in scope), not
from the warning; `[]` when unavailable.

### 4b. Comparisons — derived from the hotel enrichment result (deterministic, no LLM)

Built from the **in-memory hotel enrichment objects** produced by the hotel agent (which
carry `distance_m`, price, `star_rating`, `area`, `name`, and the persisted row id), NOT by
re-reading `hotel_suggestions` rows — the table has no `distance_m` column. `build_hotel_comparisons`
runs at the enrich seam right after the hotels are produced/persisted, so it has both the
enrichment fields and the row ids for `refs`.

`build_hotel_comparisons(hotels) -> list[TripTradeoffComparison]`:
- If `< 2` hotels with a comparable price → return `[]`.
- Pick the two most-relevant candidates (e.g. cheapest vs closest-to-route).
- Emit one comparison on axis `"price_vs_location"`: `option_a`/`option_b` carry
  `label=hotel name`, `value=price/distance summary`, and templated `pro`/`con`
  (e.g. A: pro "cheaper (¥X/night)", con "farther from your stops (Ym)"; B inverse).
- `recommendation` is a deterministic pick (cheapest within a distance threshold, else
  closest) or `None` on a tie.

Templated `pro`/`con` text is fixed-string interpolation of numeric fields — no model call.

## 5. Persistence + migration

One migration, one column (RLS on `trips` already enforces owner-check — guardrail #6 — so
no new policy):

```sql
-- supabase/migrations/<ts>_trip_tradeoffs.sql
alter table public.trips add column if not exists tradeoffs jsonb not null default '{}'::jsonb;
comment on column public.trips.tradeoffs is
  'Trip-level tradeoffs contract: { notes: TripTradeoffNote[], comparisons: TripTradeoffComparison[] }. '
  'notes = deterministic feasibility gaps; comparisons = derived hotel A-vs-B. See '
  'docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md.';
```

Writers:
- **Notes**: thread `ItineraryOutput.feasibility_warnings` (currently dropped) into a new
  `persist_tradeoffs(client, trip_id, notes)` that writes `trips.tradeoffs` with `notes`
  set. Called from the itinerary-assembly/persist seam where the warnings are in scope.
  Write-through (guardrail #7): persist before returning.
- **Comparisons**: after hotel enrich persists `hotel_suggestions`, call
  `build_hotel_comparisons()` and UPDATE `trips.tradeoffs` merging in `comparisons`
  (additive, runs AFTER `persist_itinerary` — matches the enrich-agent template). Best-effort
  (guardrail #3): a hotel-comparison failure must never fail the trip.

TS mirror (`backend-types.ts`): add `TripTradeoffNote`, `TradeoffOption`,
`TripTradeoffComparison`, `TripTradeoffs`, and `tradeoffs: TripTradeoffs` on the trip row type.

## 6. Schema parity (guardrail #4 — all three in this PR)

| Layer | Change |
|---|---|
| Pydantic | new `backend/models/tradeoff.py`; rewritten `_evidence_json` + `_evidence_kind` |
| TypeScript | `TripPlaceEvidence.quotes`; `TripTradeoff*` types + `trips.tradeoffs` |
| SQL | migration adding `trips.tradeoffs jsonb` + contract comment |

## 7. Testing + eval-safety

Everything is **additive to the deterministic path** — dedup/assembly and the frozen eval
anchor `mean_intra_day_travel_m = 6229.0` are untouched. **No LLM in the test path.**

- Unit: `_evidence_kind` (3 cases + fallback); `_evidence_json` shape conformance per
  `source_type`; `FeasibilityWarning → TripTradeoffNote` mapping (incl. `severity=None → info`);
  `build_hotel_comparisons` (2 hotels → 1 comparison; tie → no recommendation; 1 hotel → `[]`;
  0 hotels → `[]`).
- **Parity guard test**: assert the emitted `evidence_json` key set == the `TripPlaceEvidence`
  fields, and `TripTradeoffs` serialization == the TS shape — a drift tripwire.
- Fixtures: reconcile `frontend/lib/trip/fixtures/tokyo-trip.ts` so frontend tests exercise
  the real emitted shape (add `quotes`); keep frontend tests green (123 passing) + `tsc` clean.
- Backend tests stay green (431 passing); new tests injected per the enrich-agent template
  (no network at module scope).

## 8. Deferred (behind concrete triggers)

- **LLM-authored tradeoff prose** (narrator emits richer notes/comparison language) —
  trigger: the templated `detail`/`pro`/`con` reads too mechanical on real trips. Keeps the
  current path deterministic + eval-safe (guardrail #11 injection surface stays closed).
- **Normalized `trip_tradeoffs` table** — trigger: a query pattern needs per-tradeoff access.
  Today tradeoffs are always read as one list per trip → a JSONB column is strictly simpler
  and reversible.
- **`agent_suggested` rationale population** — trigger: the pipeline starts emitting
  agent-suggested places (the `rationale` seam is already in the contract).

## 9. Collision boundaries (overnight parallel work)

Claude owns: `backend/pipeline/persist.py`, `backend/models/tradeoff.py`, the migration,
and the `TripPlaceEvidence` + tradeoff region of `backend-types.ts`. Codex's concurrent
frontend↔backend integration task is explicitly excluded from those files and from
evidence/tradeoff rendering. See the two Codex prompts issued 2026-07-14.
