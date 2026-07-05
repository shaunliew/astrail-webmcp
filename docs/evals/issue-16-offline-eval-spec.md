# Issue #16 — Offline Japan Eval Baseline: Implementation Spec (MERGED)

> **PLANNING ONLY. No production code in this doc.** This is the single reconciled contract for what GitHub Project board item **#16 "Backend P0: offline eval set for Japan beta planning"** (astrail, In progress, Phase 1.1) will implement. Approve this before any code.

**Reconciles:** GitHub issue #16 · `docs/evals/japan-beta-input-template.md` (Codex) · `docs/superpowers/plans/2026-06-28-backend-revamp-roadmap.md` (§4–§6) · `docs/superpowers/plans/2026-06-28-agent-pipeline-spine.md` (Task 9 metrics) · `docs/PRD.md` (§12, §17, §25) · `.claude/CLAUDE.md` (guardrails #1–#3, #9; data flywheel).

**Task tracking note:** the GitHub **Project #1 board** is the source of truth; #16 is the only In-progress backend item. Do not edit the board from the implementing session.

---

## 1. What #16 is (one paragraph)

Build a **fully offline** evaluation harness that scores Astrail trip-generation output against a fixed Japan-first golden set, and **records the current/legacy output's weaknesses as the baseline to beat**. It runs with **no live calls** (no OpenAI, Apify, Mapbox, mem0, or Supabase) by default — it evaluates **recorded output fixtures** against pure check functions. It is the measurable target that every later pipeline step (extraction, dedupe, feasibility, memory) lands against. It does **not** build or rewrite any agent.

```
#16 OFFLINE EVAL (no live calls by default)

  fixtures/japan_demo_reels.json ─┐
  (4 demo reels: url+caption)     │
                                  ├─► cases/*.json ─► run_eval ─► CONTRACTUAL checks ─► pass/fail ─► exit code
  fixtures/baseline_output.json ──┘   (active+pending)   │       (hard gates)
  (legacy captured output =                              ├─────► QUALITY metrics ─────► recorded baseline numbers
   the bar to beat)                                      │       (non-gating: the weaknesses)
                                                         └─────► PENDING checks ───────► skipped (await Steps 7-9)
```

---

## 2. V1 beta scope confirmation (from Codex template + PRD, agreed)

**In scope for v1 beta backend agent** (what the eval targets): Japan-first (Tokyo primary), 1–5 Reel URLs / requested places, optional dates+budget+origin+free-text, evidence-backed places & recommendations, partial success when non-critical enrichment fails, returning-user preference memory **as an eval dimension** (mem0 build is later).

**Out of scope (v1 + this ticket):** booking/payment, flights, Instagram account import, full itinerary-edit chat, Google Places / Convex / Clerk / hackathon payment-booking flows.

---

## 3. Eval directory convention (decided)

- **`docs/evals/`** — human-facing planning + inputs: this spec, Codex's `japan-beta-input-template.md`, and the recorded-weaknesses notes. **You edit these.**
- **`backend/evals/`** — the runnable harness (the only code #16 ships):

```
backend/evals/
├── __init__.py
├── fixtures/
│   ├── japan_demo_reels.json     # INPUT: 4 demo reels (reel_url + caption + location_name)  ← you fill captions/URLs
│   ├── expected_places.json      # GROUND TRUTH: known places + evidence + coords (from legacy data/places.json)
│   └── baseline_output.json      # BASELINE: legacy captured itinerary+places output (the bar to beat)
├── cases/
│   ├── japan_first_trip.json     # case 1: first-time user, no memory
│   └── japan_second_trip.json    # case 2: returning user — memory-use is a PENDING check
├── checks.py                     # active CONTRACTUAL checks + the active/pending registry
├── metrics.py                    # pure QUALITY metric functions (recorded, non-gating)
├── baseline.py                   # legacy-equivalent reference (name-only dedup + naive day order) — NO legacy/ import
└── run_eval.py                   # local runner: load cases → run checks → report → exit code
```

(#16 issue body allowed `backend/evals` OR `backend/tests/fixtures` — we pick **`backend/evals/`**.)

---

## 4. Demo Reel fixture — the 4 Reel URLs

**The 4 Reel URLs are already provided** in `docs/evals/japan-beta-input-template.md` (Case 1):

```
reel_1  https://www.instagram.com/reel/DYbmT-SNzVK/
reel_2  https://www.instagram.com/reel/DYM_I5IvLSv/
reel_3  https://www.instagram.com/reel/DYGH3jFBZHz/
reel_4  https://www.instagram.com/reel/DXwcVVliX3B/
```

The one remaining input gap: the **scraped `caption` + `location_name` per reel**. The offline runner cannot scrape, so this content must be **captured once** and frozen into the fixture — either a one-time Apify scrape of the 4 URLs (a manual capture step, NOT part of the offline runner), or filled by hand from the reels. The fixture shape (`fixtures/japan_demo_reels.json`), one entry per reel:

```json
{
  "reels": [
    {
      "reel_url": "https://www.instagram.com/reel/DYbmT-SNzVK/",
      "caption": "<CAPTURE ONCE: verbatim caption text, incl. emoji/📍 tags>",
      "location_name": "<CAPTURE ONCE: Instagram location tag, or null>",
      "short_code": "DYbmT-SNzVK"
    }
    // ... 4 total
  ]
}
```

> Why captions matter: the **evidence-verbatim contractual check** (§6a) verifies each place's `evidence_quote` is a substring of `caption + location_name`. Without captions that check can't run on the demo set. Capturing them once keeps the runner fully offline thereafter.

**Ground truth for those reels is already known** — captured in legacy `data/places.json` (8 extracted places). `fixtures/expected_places.json` records them as the expected extraction target:

| # | name | category | lat, lng | evidence_quote | note |
|---|---|---|---|---|---|
| 1 | Tokyo Dream Park | attraction | 35.6291, 139.7880 | `📍Tokyo Dream Park` | clean tier-1 pin |
| 2 | Grand Hyatt Tokyo | hotel | 35.6594, 139.7291 | `📍 @grandhyatttokyo , Japan` | |
| 3 | Akasaka Station | transport | 35.6724, 139.7365 | `HARRY POTTER TRAIN STATION IN TOKYO!` | **~80m from #4 → same spot** |
| 4 | Harry Potter Cafe | restaurant | 35.6731, 139.7364 | `Harry Potter Cafe` | **dup of #3's location** |
| 5 | SANDO LAB TOKYO | restaurant | 35.7008, 139.7717 | `Sando Lab Tokyo` | |
| 6 | Popo | restaurant | 35.7316, 139.7654 | `Popo` | thin evidence |
| 7 | CHERMSIDE SANDWICH … | restaurant | 35.6708, 139.7058 | `Chermside Sandwich` | name ≠ evidence (long-form) |
| 8 | Pelican Café Asakusa | restaurant | 35.7070, 139.7912 | `Pelican Cafe` | |

---

## 5. Observed / current-output weaknesses to record (the baseline)

`run_eval` measures these against the recorded legacy output and **records them as the baseline numbers** (do not "fix" them in #16 — #16 only measures). Capture in `docs/evals/baseline-weaknesses.md` + as metric outputs:

1. **Dedup miss (geo):** #3 Akasaka Station (transport) and #4 Harry Potter Cafe (restaurant) are ~80m apart = one spot, but legacy name-only dedup keeps both. → `dedup_error` ≥ 1. Two-gate semantic+geo dedup (Step 6) should merge/flag.
2. **Source quality:** several `source_url`s are `google.co.jp/maps`, `google.com/maps/search` links (banned Google + search-page, not a real venue page). → record `weak_source_url_rate`. New pipeline resolves via Mapbox + research (later).
3. **Route sanity:** places span ~12 km (Ariake → Harajuku → Nishi-Nippori). Naive day-ordering → high intra-day travel. → record `mean_intra_day_travel_m`. Feasibility ordering (Step 7) should lower it.
4. **No personalization:** legacy has zero returning-user memory. → second-trip case asserts memory SHOULD change output (PENDING until Step 9 / mem0).
5. **Latency:** legacy demo run was ~215–500 s (spike timeouts). → record as the latency bar (offline mode records N/A; live mode later captures real timing).

---

## 6. Active checks NOW

Two tiers. **Contractual checks gate the exit code; quality metrics are recorded, non-gating.**

### 6a. Active CONTRACTUAL checks (hard gate — runner exits non-zero if any fail)
Run against any itinerary output (legacy baseline passes these today — they encode "a valid itinerary"):
- **Evidence verbatim** — every place's `evidence_quote` is a case-insensitive substring of its reel `caption + " " + location_name`. (PRD §12, guardrail #1)
- **Coordinates present** — every place has non-null `lat`, `lng` within Pydantic bounds.
- **Japan bbox** — every place falls in Japan bbox `lat 24–46, lng 122–146` (Japan-first sanity).
- **Day count** — `len(days) == (end_date − start_date).days + 1`.
- **Source-places parity** — `set(itinerary.source_places) == {place names}`.
- **Partial-failure tolerance** — a missing/failed PENDING section does not fail the run (PRD §17, guardrail #3).

### 6b. Active QUALITY metrics (recorded baseline — non-gating)
- `dedup_error` = |produced canonical count − known unique count|.
- `mean_intra_day_travel_m` = avg metres between consecutive same-day stops (route sanity; lower better).
- `hallucination_rate` = fraction of places missing coords OR with placeholder/search `source_url`.
- `evidence_coverage` = fraction of places with verbatim evidence.
- `weak_source_url_rate` = fraction whose `source_url` is a Google-maps/search/placeholder page.
- `latency_s` per stage + total — recorded only when present in the fixture (offline = N/A).

---

## 7. Pending checks for later (defined now, SKIPPED until their step lands)

Each is declared in `cases/*.json` and reported as **skipped**, never failed:

| Pending check | Asserts | Unlocked by (board card / step) |
|---|---|---|
| restaurant relevance | suggested restaurants match prefs + sit near the route | hotel/enrichment phase (Step 10) |
| hotel/base reasoning | a single base/hotel chosen with evidence + proximity rationale | "hotel/base recommendation" (Phase 1.2 / Step 8) |
| **memory-use (second trip)** | returning user's stored budget/pace/food prefs measurably change output vs first trip | "mem0 preference memory" (Phase 1.3 / Step 9) |
| transport legs | inter-stop legs from real routing, not straight-line | Mapbox step (Step 10) |

---

## 8. Returning-user memory eval scaffolding (NO mem0 implementation)

`cases/japan_second_trip.json` defines a returning user with a **fixed preference profile fixture** (no mem0 call):

```json
{
  "case": "japan_second_trip",
  "user_profile": { "budget_style": "mid_range", "pace": "relaxed",
                    "food_preference": ["ramen", "cafes"], "avoid": ["theme_parks"] },
  "expected_memory_effects": [
    "pace=relaxed → fewer stops/day than first trip",
    "food_preference=ramen/cafes → ramen/cafe places ranked/kept over theme-park-adjacent",
    "avoid theme_parks → Tokyo Dream Park deprioritized vs first trip"
  ],
  "memory_check": "PENDING"   // becomes active when mem0 lands (Step 9)
}
```

Memory dimensions (from Codex template): **budget_style + pace required; food_preference + avoid when known.** #16 only records these as a fixture + a pending assertion — it does **not** read/write mem0.

---

## 9. Local run command

```bash
cd backend
uv run python -m evals.run_eval                 # offline: checks vs recorded baseline_output.json
uv run python -m evals.run_eval --case japan_first_trip
uv run pytest evals/ -v                          # unit tests for checks.py + metrics.py (no API key)
```

Offline by default (no env keys needed). A future `--live` flag (NOT in #16) would regenerate output from the real pipeline.

**Output:** a comparison table (contractual pass/fail, quality metrics vs baseline, pending=skipped) + non-zero exit on any failed contractual check.

---

## 10. Acceptance criteria

- [ ] `backend/evals/` exists with fixtures, cases, `checks.py`, `metrics.py`, `baseline.py`, `run_eval.py`.
- [ ] `fixtures/japan_demo_reels.json` holds the 4 demo reels; `expected_places.json` + `baseline_output.json` capture the legacy ground truth/output.
- [ ] ≥ 2 cases: `japan_first_trip` and `japan_second_trip`; the second-trip case asserts personalization SHOULD use stored memory (memory_check = PENDING).
- [ ] Each case defines: input, expected **active** checks, **pending** checks (marked), and the known legacy weakness it targets.
- [ ] Runner reports contractual pass/fail + quality metrics + per-stage timing slot; **exits non-zero** on a failed *contractual* check; pending checks report **skipped**, never failed.
- [ ] `checks.py` + `metrics.py` are pure and unit-tested; the test suite runs with **no API key**.
- [ ] Baseline weakness numbers are recorded (`docs/evals/baseline-weaknesses.md`) as the bar to beat.
- [ ] Runs fully **offline** — zero live OpenAI/Apify/Mapbox/mem0/Supabase calls.

---

## 11. Non-goals for #16

- No agent build/rewrite (extractor, enricher, narrator, restaurant, hotel, transport, orchestrator).
- No full backend revamp; no Supabase / auth / frontend / SSE / durable jobs.
- No live OpenAI, Apify, Mapbox, mem0, or Supabase by default.
- No mem0 implementation — returning-user memory is scaffolding (fixtures + pending check) only.
- No `legacy/` imports in `backend/evals/` (guardrail #9) — `baseline.py` re-implements the two behaviours to beat.
- No GitHub Project board edits from the implementing session.

---

## 12. Follow-up tickets (keep as board drafts; activate one at a time)

`offline pipeline harness` + `fixture/cache fallback path` → Step 2 · `latency instrumentation+traces` → Step 3 · `specialist agent split` → Step 4 · `direct Apify Reel extraction` → Step 5 · `place dedupe + confidence` → Step 6 (consumes #16 dedup checks) · `itinerary feasibility checks` → Step 7 (consumes #16 route-sanity metric) · `hotel/base recommendation` → Step 8 (activates a pending check) · `mem0 preference memory` → Step 9 (activates the memory pending check) · new draft "Mapbox Search/Directions" → Step 10.

---

## 13. Implementation prompt (use AFTER you approve this spec)

> Read `.claude/CLAUDE.md`, `docs/PRD.md` §12/§17/§25, and `docs/evals/issue-16-offline-eval-spec.md`.
> Implement **issue #16 only** exactly as that spec defines: build `backend/evals/`
> (fixtures, cases, `checks.py`, `metrics.py`, `baseline.py`, `run_eval.py`) — a fully
> **offline** eval harness. The 4 demo Reel URLs are in `docs/evals/japan-beta-input-template.md`;
> the captions/location_name must be captured into `japan_demo_reels.json` first (one-time
> scrape or manual). Use the legacy ground truth in `legacy/.../data/places.json` +
> `planner_output.json` as `expected_places.json` / `baseline_output.json` (copy the data;
> do NOT import from `legacy/`). Implement the active CONTRACTUAL checks (gating) and active
> QUALITY metrics (recorded, non-gating) from spec §6; declare the PENDING checks from §7
> as skipped. Record baseline weakness numbers to `docs/evals/baseline-weaknesses.md`.
> TDD: write pure `checks.py`/`metrics.py` tests first; the unit suite must pass with NO API key.
> Do NOT build any agent, Supabase, SSE, Mapbox, mem0, or live Apify. Do NOT exceed #16.
> Do NOT edit the GitHub Project board. Reference `MalaysiaKaki/astrail#16` in commits.
```
