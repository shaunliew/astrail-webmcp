# Baseline Weaknesses — Japan Demo Set (issue #16)

> Recorded from the offline eval (`backend/evals/run_eval.py`) on the 4-reel Japan demo set.
> These are the numbers the new pipeline (Steps 4–9) must beat. Captured 2026-06-28.

**Input:** 4 demo reels (captions captured via one-time Apify scrape) → 8 extracted places (legacy ground truth, `backend/evals/fixtures/expected_places.json`). 3-day window.

## Recorded baseline metrics (case `japan_first_trip`)

| Metric | Baseline | Reading |
|---|---|---|
| `dedup_error` | **0** | This demo set has 8 distinct-name places — dedup is **not stressed** here. Add an "Ichiran Shibuya / Ichiran Ramen Shibuya" style case to exercise it. |
| `mean_intra_day_travel_m` | **8163.7** (~8.2 km/day) | **Weakness.** Naive input-order day chunking ignores geography across a ~12 km Tokyo spread. Feasibility ordering (Step 7) must lower this. |
| `hallucination_rate` | **0.0** | Legacy extraction had real coordinates — not a weakness. |
| `evidence_coverage` | **1.0** | All 8 evidence quotes are verbatim substrings of the captured captions — strong. |
| `weak_source_url_rate` | **0.625** (5/8) | **Weakness.** 5 of 8 `source_url`s are Google Maps / search-result links (banned Google source + not a real venue page). New pipeline must resolve via Mapbox + research (Steps 5–6, 10). |

Contractual checks: all **PASS** (coords present, Japan bbox, day count, source-places parity, evidence verbatim). Runner exit 0.

## Qualitative weaknesses (from the legacy itinerary `legacy_planner_output.json`)

1. **Silent place drop** — extraction found **8** places; the legacy planner's itinerary used only **4** (`Tokyo Dream Park, Grand Hyatt Tokyo, Harry Potter Cafe, Sando Lab Tokyo`). 4 places (Akasaka Station, Popo, Chermside Sandwich, Pelican Café) were dropped with no user-facing signal. New pipeline should surface drops, not hide them.
2. **Weak evidence sources** — Google Maps/search URLs (see metric above).
3. **Geography-blind routing** — high intra-day travel (see metric above).
4. **No personalization** — legacy has zero returning-user memory. The `japan_second_trip` case scaffolds the expected memory effects as a PENDING check (activated at Phase 1.3 / mem0).

## Pending checks (defined, not yet measurable)

`restaurant_relevance`, `hotel_base_reasoning`, `memory_use`, `transport_legs` — skipped until their pipeline step lands. The second-trip case records the expected memory effects to verify once mem0 exists.

## Targets for the new pipeline (the bar to beat)

- `mean_intra_day_travel_m` **< 8163.7** (lower = more coherent days).
- `weak_source_url_rate` **< 0.625** → ideally 0 (Mapbox/research sources, no Google links).
- Place coverage: **0 silent drops** (8/8 surfaced or explicitly explained).
- `evidence_coverage` stays **1.0**; `hallucination_rate` stays **0.0**.
- Add a dedup-stress case so `dedup_error` becomes a meaningful signal.
