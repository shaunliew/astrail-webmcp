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

**Backend gets an exact Pydantic `TripPlaceEvidence` model** (new `models/evidence.py`)
mirroring the TS type field-for-field (`confidence, source_url, quote, quotes, rationale,
evidence_kind`). `_evidence_json` builds and returns `TripPlaceEvidence(...).model_dump()`,
so the contract is typed on both sides (guardrail #4) and a parity test can assert the model
fields equal the TS shape. The DB migration also refreshes the stale
`trip_places.evidence_json` column comment to name the exact keys.

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

### 4b. Comparisons — derived from persisted `hotel_suggestions` rows (deterministic, no LLM)

**Axis is `price_vs_rating`, NOT `price_vs_location`.** Hotels have no coordinates or
`distance_m`: `persist_hotels` sets `base_place_id = NULL` ("Travala gives no coords") and
returns an `int` count, not in-memory models. So comparisons are derived from the **persisted
`hotel_suggestions` rows** (`id`, `name`, `star_rating`, `price_snapshot`) — the only fields
that actually exist — comparing price against star rating.

`build_hotel_comparisons(hotel_rows) -> list[TripTradeoffComparison]`:
- Extract a numeric price per row: prefer `price_snapshot.pricePerNight` (labeled "/night");
  else `price_snapshot.totalPrice` (labeled "total"). Rows with neither are excluded.
- If `< 2` priced rows → return `[]`.
- `option_a` = cheapest row; `option_b` = highest-rated **distinct** row.
- Emit one comparison on axis `"price_vs_rating"`: `option_a`/`option_b` carry
  `label = hotel name`, `value = price summary`, templated `pro`/`con`
  (A: pro "cheaper (…)", con "N-star"; B: pro "higher rated (M-star)", con "pricier (…)").
- `recommendation`: prefer the cheaper row when the rating gap is ≤ 1 star; `None` when
  ratings AND prices tie (no clear winner). Deterministic.

Templated `pro`/`con` text is fixed-string interpolation of numeric fields — no model call.
This supersedes the earlier `price_vs_location`/`distance_m` design (not grounded in code).

## 5. Persistence + migration

One migration, one column (RLS on `trips` already enforces owner-check — guardrail #6 — so
no new policy):

```sql
-- supabase/migrations/<ts>_trip_tradeoffs.sql
alter table public.trips add column if not exists tradeoffs jsonb not null
  default '{"notes": [], "comparisons": []}'::jsonb;   -- full empty shape: failed trips still read a valid contract
comment on column public.trips.tradeoffs is
  'Trip-level tradeoffs contract: { notes: TripTradeoffNote[], comparisons: TripTradeoffComparison[] }. '
  'notes = deterministic feasibility gaps; comparisons = derived hotel A-vs-B. See '
  'docs/superpowers/specs/2026-07-15-evidence-tradeoff-contract-design.md.';
```

Writer — **one write, no read-modify-write** (avoids the transient-read-failure erase bug):
`persist_tradeoffs(client, trip_id, user_id, *, notes, comparisons)` writes
`{"notes": …, "comparisons": …}` in a single owner-checked UPDATE. It never reads the column
back, so a read failure can't wipe a sibling field, and there is no lost-update surface.
- Compute `notes` from `itinerary.feasibility_warnings` right after `persist_itinerary`
  (warnings in scope), hold them in a local.
- Run the enrich gather (hotels persist inside it).
- **After** the gather, build `comparisons` from the persisted `hotel_suggestions` rows and
  do the ONE `persist_tradeoffs(..., notes=notes, comparisons=comparisons)` write.
- Best-effort (guardrail #3): the whole tradeoff write is wrapped so a failure never fails
  the trip; write-through before the terminal result (guardrail #7).

TS mirror (`backend-types.ts`): add `TripTradeoffNote`, `TradeoffOption`,
`TripTradeoffComparison`, `TripTradeoffs`, and `tradeoffs: TripTradeoffs` on the trip row type.

## 6. Schema parity (guardrail #4 — all three in this PR)

| Layer | Change |
|---|---|
| Pydantic | new `models/evidence.py` (`TripPlaceEvidence`) + `models/tradeoff.py`; `_evidence_json` returns `TripPlaceEvidence(...).model_dump()`; new `_evidence_kind` |
| TypeScript | `TripPlaceEvidence.quotes` (+ update the 6 `tokyo-trip.ts` TripPlace literals AND `EvidenceChip.test.tsx`); `TripTradeoff*` types; **`tradeoffs: TripTradeoffs` on the `Trip` row type** |
| SQL | migration adding `trips.tradeoffs jsonb` default `{"notes":[],"comparisons":[]}` + comment; refresh the stale `trip_places.evidence_json` comment to name the exact keys |

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
- **Legacy `evidence_json` backfill** (Codex cross-model finding #1) — existing `trip_places`
  rows written before this migration keep the old `{evidence_quote, evidence_quotes}` shape,
  so a future frontend reading real rows would see blank chips for pre-migration trips. NOT
  backfilled here because: (a) the frontend still renders from fixtures, not real
  `evidence_json`, so there is no live consumer today; (b) pre-beta, trip data is disposable;
  (c) shipping untested backfill SQL on a migration is riskier than the stale rows it fixes.
  Trigger: the frontend switches to real `evidence_json` AND pre-migration trip data must
  survive — then add a guarded `update … where evidence_json ? 'evidence_quote'` backfill
  (mapping `evidence_quote→quote`, `evidence_quotes→quotes`, `source_type→evidence_kind`),
  validated against staging first.
- **Per-evidence-item provenance** (Codex cross-model finding #2) — `dedup._merge_cluster`
  forces `source_type="user_requested"` cluster-wide (intentional user-requested protection),
  so a place the user requested that ALSO appears in a Reel emits `evidence_kind=requested_by_you`
  alongside the representative's Reel `quote`/`source_url`. Accepted as-is: "requested_by_you"
  is the defensible *primary* provenance (the user's explicit ask is the strongest signal, which
  is why dedup protects it), and the `quotes` list still preserves the Reel evidence. A true
  fix (evidence as a list of per-source typed items instead of one `evidence_kind`) is a
  contract redesign. Trigger: product decides a single primary kind is misleading in practice.

## 9. Collision boundaries (overnight parallel work)

Claude owns: `backend/pipeline/persist.py`, `backend/models/tradeoff.py`, the migration,
and the `TripPlaceEvidence` + tradeoff region of `backend-types.ts`. Codex's concurrent
frontend↔backend integration task is explicitly excluded from those files and from
evidence/tradeoff rendering. See the two Codex prompts issued 2026-07-14.
