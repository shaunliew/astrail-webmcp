# Step 7 — Itinerary Feasibility: route-aware ordering + warnings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the naive input-order day chunking with a **route-aware** itinerary that the pipeline produces *better* than the frozen legacy baseline — deterministic geographic day ordering + brute-force intra-day TSP — and attach **feasibility warnings** (long legs, overpacked days) instead of silently emitting impossible days. This is the step where the offline pipeline starts beating the #16 baseline on `mean_intra_day_travel_m`.

**Architecture:** A pure, offline `pipeline/feasibility.py`: (1) `geo_order` — a deterministic nearest-neighbor chain over all coord-bearing places; (2) split that geo-ordered chain into near-even contiguous day groups; (3) `optimal_day_order` — brute-force open-path TSP within each day (≤7 stops → optimal, microseconds); (4) `assess_feasibility` — flag long legs (haversine ≥2 km warn / ≥4 km flag) and overpacked days (vs a pace cap). The narrate stage (`assemble_itinerary`) orchestrates these and attaches `feasibility_warnings` to `ItineraryOutput`. All haversine, no external calls.

**Scope decision (Shaun, 2026-06-30):** Option **C** — flag + density-cap + **reorder**. The pipeline produces a measurably shorter route than baseline (not just warnings). Deferred (feasible-first): real road/transit legs via **Mapbox Directions** (the warnings use haversine now; Directions is the injected live provider later), and **narrator/orchestrator consumption** of the warnings (`narrator.py`/`orchestrator.py` are 1-line stubs — the `feasibility_warnings` field is the seam they'll read when built). `pace` threading from `UserPreferences` is Step 9; Step 7 takes a `pace` param defaulting to `"balanced"`.

**Tech Stack:** Python 3.14, Pydantic v2, stdlib (`itertools.permutations`), `pipeline.geo.haversine_m`, pytest. No new dependencies. No Mapbox/OpenAI/Supabase calls.

## Global Constraints

- **Determinism (hard — the eval must be reproducible).** No `random`, no `Date`/time in the ordering. `geo_order` anchors on `min (lat, lng)` and breaks nearest-neighbor ties by index; `optimal_day_order` uses `min(permutations(...))` (first-minimal wins). Same input → same itinerary, every run.
- **The pipeline now BEATS the baseline (parity anchor converts, not breaks-silently).** Reordering lowers `mean_intra_day_travel_m` below baseline's `8163.7` on `japan_first_trip`. The harness docstring already anticipates this ("Steps 6-7 make the pipeline diverge via routing; the equality is updated then"). Convert `test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`: for `mean_intra_day_travel_m` assert `pipeline <= baseline`; for every OTHER metric keep `==`. Add a dedicated test asserting `pipeline < baseline` on `japan_first_trip` (proves the reorder works).
- **#16 baseline subject stays green.** `evals/baseline.py` is FROZEN — do not touch it. Do NOT add any gating long-leg/overpacked contractual check to `japan_first_trip`/`japan_second_trip` (baseline scores 8163.7 m and has no warnings → would fail). New gating checks live only in a `diverges_from_baseline` regression case, or as pytest tests (pipeline-only). Feasibility warnings + new metrics are additive/non-gating.
- **Additive contract only.** `ItineraryOutput` gains `feasibility_warnings: list[FeasibilityWarning] = []`; `ItineraryDay.place_names`/`source_places` shapes are unchanged (the 6 contractual checks key on them). Reordering keeps the SAME place names → `source_places_parity` + `day_places_traceable` still pass.
- **Partial failure tolerance (acceptance):** a place with missing coords must not crash ordering or the trip — it's appended after the coord-bearing chain and skipped in leg math (never bridged).
- **Pure + offline + import-keyless:** `import pipeline.feasibility` needs no key, no SDK, no network.
- **Style:** PEP 8, type annotations, immutability (return new lists; never mutate inputs).

---

### Task 1: Pure feasibility module (geo-ordering + intra-day TSP + warnings) + model

**Files:**
- Modify: `backend/models/trip.py` (`FeasibilityWarning` + `ItineraryOutput.feasibility_warnings`)
- Create: `backend/pipeline/feasibility.py`
- Test: `backend/pipeline/test_feasibility.py`

**Interfaces:**
- Produces: `FeasibilityWarning(kind, day_number, detail, leg_m)`; `geo_order(places) -> list[CanonicalPlace]`; `optimal_day_order(day_places) -> list[CanonicalPlace]`; `assess_feasibility(numbered_days, *, pace) -> list[FeasibilityWarning]`; constants `LONG_LEG_WARN_M=2000.0`, `LONG_LEG_FLAG_M=4000.0`, `PACE_STOP_CAP`, `DEFAULT_PACE="balanced"`.

- [ ] **Step 1: Write the failing tests**

Create `backend/pipeline/test_feasibility.py`:

```python
"""Itinerary feasibility — pure, offline, deterministic."""
from models.place import CanonicalPlace
from pipeline.feasibility import (
    LONG_LEG_FLAG_M, assess_feasibility, geo_order, optimal_day_order,
)


def _p(name, lat, lng):
    return CanonicalPlace(name=name, category="attraction", confidence=0.9,
                          evidence_quote=name, lat=lat, lng=lng)


def _total(order):
    from pipeline.geo import haversine_m
    return sum(haversine_m(order[i].lat, order[i].lng, order[i + 1].lat, order[i + 1].lng)
               for i in range(len(order) - 1))


def test_geo_order_is_deterministic():
    pts = [_p("A", 35.0, 139.0), _p("B", 35.9, 139.9), _p("C", 35.1, 139.1)]
    assert [p.name for p in geo_order(pts)] == [p.name for p in geo_order(list(reversed(pts)))]


def test_geo_order_beats_input_order_total_distance():
    # input order zig-zags; geo_order should chain neighbors → shorter total
    pts = [_p("A", 35.0, 139.0), _p("Z", 35.9, 139.9), _p("B", 35.05, 139.05), _p("Y", 35.85, 139.85)]
    assert _total(geo_order(pts)) <= _total(pts)


def test_geo_order_appends_no_coord_places_last():
    a = _p("A", 35.0, 139.0)
    nc = CanonicalPlace(name="NoCoord", category="other", confidence=0.5,
                        evidence_quote="NoCoord", lat=None, lng=None)
    out = geo_order([nc, a])
    assert out[-1].name == "NoCoord"  # coord-bearing first, no-coord appended last


def test_optimal_day_order_minimizes_intra_day_travel():
    # a deliberately bad order; brute-force should find a shorter one
    bad = [_p("A", 35.0, 139.0), _p("Far", 35.5, 139.5), _p("B", 35.01, 139.01)]
    out = optimal_day_order(bad)
    assert _total(out) <= _total(bad)
    assert {p.name for p in out} == {"A", "Far", "B"}  # same set, reordered


def test_assess_feasibility_flags_long_leg():
    days = [(1, [_p("A", 35.0, 139.0), _p("B", 35.9, 139.9)])]  # ~120 km apart
    w = assess_feasibility(days, pace="balanced")
    assert any(x.kind == "long_leg" and x.leg_m and x.leg_m >= LONG_LEG_FLAG_M for x in w)


def test_assess_feasibility_flags_overpacked_day():
    day = (1, [_p(f"P{i}", 35.0 + i * 0.001, 139.0) for i in range(5)])  # 5 stops
    w = assess_feasibility([day], pace="balanced")  # cap 4
    assert any(x.kind == "overpacked_day" and x.day_number == 1 for x in w)


def test_assess_feasibility_clean_day_no_warnings():
    day = (1, [_p("A", 35.000, 139.0), _p("B", 35.005, 139.0)])  # ~550 m, 2 stops
    assert assess_feasibility([day], pace="balanced") == []


def test_no_coords_place_never_crashes_ordering_or_legs():
    a = _p("A", 35.0, 139.0)
    nc = CanonicalPlace(name="NC", category="other", confidence=0.5, evidence_quote="NC",
                        lat=None, lng=None)
    assert len(geo_order([a, nc])) == 2
    assert assess_feasibility([(1, [a, nc])], pace="balanced") == []  # leg skipped, no crash
```

- [ ] **Step 2: Run → fail**

Run: `cd backend && uv run pytest pipeline/test_feasibility.py -q` → FAIL (`No module named 'pipeline.feasibility'`).

- [ ] **Step 3: Add the model**

In `backend/models/trip.py`, add (import `Literal` + `Field`):

```python
from typing import Literal
from pydantic import BaseModel, Field


class FeasibilityWarning(BaseModel):
    kind: Literal["long_leg", "overpacked_day"]
    day_number: int
    detail: str
    leg_m: float | None = None
```

And add to `ItineraryOutput` (after `days`):

```python
    feasibility_warnings: list[FeasibilityWarning] = Field(default_factory=list)
```

- [ ] **Step 4: Implement `pipeline/feasibility.py`**

```python
"""Itinerary feasibility — deterministic geographic ordering + warnings. Pure, offline.

Replaces naive input-order chunking: a nearest-neighbor geo-chain over all coord-bearing
places, split into near-even day groups, with a brute-force optimal intra-day order; then
flags long legs + overpacked days. Real road/transit legs (Mapbox Directions) and LLM
narrator/orchestrator consumption of the warnings are deferred — the warnings are the seam.
"""
from __future__ import annotations

from itertools import permutations

from models.place import CanonicalPlace
from models.trip import FeasibilityWarning
from pipeline.geo import haversine_m

LONG_LEG_WARN_M = 2000.0    # haversine ≥ this between consecutive stops → warn (walkable-city heuristic)
LONG_LEG_FLAG_M = 4000.0    # ≥ this → hard flag (transit required, not walkable)
PACE_STOP_CAP = {"relaxed": 3, "balanced": 4, "packed": 6}
DEFAULT_PACE = "balanced"
_BRUTE_FORCE_MAX = 7        # n! permutations: 7! = 5040 is instant; NN/geo-order fallback above


def _has_coords(p: CanonicalPlace) -> bool:
    return p.lat is not None and p.lng is not None


def _leg_m(a: CanonicalPlace, b: CanonicalPlace) -> float | None:
    if not (_has_coords(a) and _has_coords(b)):
        return None
    return haversine_m(a.lat, a.lng, b.lat, b.lng)


def _path_distance(order: list[CanonicalPlace]) -> float:
    """Total haversine of consecutive coord-bearing legs (no-coord stops break the chain)."""
    return sum(d for i in range(len(order) - 1)
               if (d := _leg_m(order[i], order[i + 1])) is not None)


def geo_order(places: list[CanonicalPlace]) -> list[CanonicalPlace]:
    """Deterministic nearest-neighbor chain over coord-bearing places; no-coord places are
    appended (input order) at the end. Anchor = smallest (lat, lng); nearest ties broken by
    index — so the result is reproducible regardless of input order. Never mutates input."""
    coorded = [p for p in places if _has_coords(p)]
    no_coord = [p for p in places if not _has_coords(p)]
    if len(coorded) <= 1:
        return coorded + no_coord
    remaining = list(coorded)
    start = min(range(len(remaining)), key=lambda i: (remaining[i].lat, remaining[i].lng))
    chain = [remaining.pop(start)]
    while remaining:
        last = chain[-1]
        nxt = min(range(len(remaining)),
                  key=lambda i: (haversine_m(last.lat, last.lng, remaining[i].lat, remaining[i].lng), i))
        chain.append(remaining.pop(nxt))
    return chain + no_coord


def optimal_day_order(day_places: list[CanonicalPlace]) -> list[CanonicalPlace]:
    """Minimize total intra-day leg distance (open-path TSP). Brute-force optimal for small
    days; for >_BRUTE_FORCE_MAX coord stops keep the (already geo-ordered) input. Deterministic
    (min() returns the first-minimal permutation). No-coord stops kept at the end."""
    coorded = [p for p in day_places if _has_coords(p)]
    no_coord = [p for p in day_places if not _has_coords(p)]
    if len(coorded) <= 2 or len(coorded) > _BRUTE_FORCE_MAX:
        return day_places
    best = min(permutations(coorded), key=_path_distance)
    return list(best) + no_coord


def assess_feasibility(
    numbered_days: list[tuple[int, list[CanonicalPlace]]], *, pace: str = DEFAULT_PACE
) -> list[FeasibilityWarning]:
    """Flag overpacked days (stops > pace cap) and long legs (≥WARN / ≥FLAG metres). A
    missing-coord leg is skipped (no warning, no crash)."""
    cap = PACE_STOP_CAP.get(pace, PACE_STOP_CAP[DEFAULT_PACE])
    warnings: list[FeasibilityWarning] = []
    for day_number, day in numbered_days:
        if len(day) > cap:
            warnings.append(FeasibilityWarning(
                kind="overpacked_day", day_number=day_number,
                detail=f"{len(day)} stops exceeds the {pace} pace cap of {cap}"))
        for i in range(len(day) - 1):
            d = _leg_m(day[i], day[i + 1])
            if d is not None and d >= LONG_LEG_WARN_M:
                level = "flag" if d >= LONG_LEG_FLAG_M else "warn"
                warnings.append(FeasibilityWarning(
                    kind="long_leg", day_number=day_number, leg_m=d,
                    detail=f"{d:.0f} m {day[i].name} -> {day[i + 1].name} ({level})"))
    return warnings
```

- [ ] **Step 5: Run → pass**

Run: `cd backend && uv run pytest pipeline/test_feasibility.py -q` → PASS (8 tests).

- [ ] **Step 6: Confirm import-keyless invariant**

Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import pipeline.feasibility; print('keyless import OK')"`

- [ ] **Step 7: Commit**

```bash
cd backend && git add models/trip.py pipeline/feasibility.py pipeline/test_feasibility.py
git commit -m "feat(feasibility): geographic day ordering + intra-day TSP + warnings model"
```

---

### Task 2: Wire route-aware assembly into the harness + convert parity anchor + regression case

**Files:**
- Modify: `backend/pipeline/offline_harness.py` (`assemble_itinerary` → route-aware + warnings)
- Modify: `backend/pipeline/test_offline_harness.py` (update the now-stale input-order assertions)
- Modify: `backend/evals/metrics.py` (`max_single_leg_m`, `feasibility_warning_count`)
- Modify: `backend/evals/test_run_eval.py` (convert the parity anchor → "beats baseline")
- Create: `backend/evals/fixtures/japan_feasibility_places.json` + `backend/evals/cases/japan_feasibility.json`

**Interfaces:**
- `assemble_itinerary(places, dates, *, pace="balanced")` now geo-orders, splits, intra-day-optimizes, and attaches `feasibility_warnings`. Return shape unchanged except the additive warnings field (carried in `itinerary` dict via `model_dump`).

- [ ] **Step 1: Write/adjust the failing tests**

In `backend/pipeline/test_offline_harness.py`: the existing `test_assemble_itinerary_chunks_in_input_order` asserts input-order chunking — that contract is GONE (now geo-order). Replace it with a route-aware assertion + a feasibility-field assertion:

```python
from pipeline.feasibility import assemble_itinerary  # if moved; else keep harness import


def test_assemble_itinerary_geo_orders_and_carries_warnings():
    # three places; geo-ordering + per-day TSP should not exceed input-order travel,
    # and the itinerary carries a (possibly empty) feasibility_warnings list
    places = [CanonicalPlace(name=n, category="other", confidence=0.9, evidence_quote=n, lat=la, lng=lo)
              for n, la, lo in [("A", 35.0, 139.0), ("Far", 35.5, 139.5), ("B", 35.01, 139.01)]]
    itin = assemble_itinerary(places, ["2026-06-10"])
    assert {n for d in itin.days for n in d.place_names} == {"A", "Far", "B"}  # all present
    assert isinstance(itin.feasibility_warnings, list)
```

Update `test_pipeline_places_validate_and_carry_canonical_fields` if it asserts a specific day-0 name order on the mini fixture — assert membership/day-count instead of an exact order (geo-ordering may reorder the 2 mini places).

- [ ] **Step 2: Run → fail**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -q` → FAIL (old input-order assertions / import).

- [ ] **Step 3: Rewrite `assemble_itinerary` (route-aware + warnings)**

In `backend/pipeline/offline_harness.py`, replace `assemble_itinerary` (import the feasibility helpers):

```python
from pipeline.feasibility import assess_feasibility, geo_order, optimal_day_order, DEFAULT_PACE


def assemble_itinerary(
    places: list[CanonicalPlace], dates: list[str], *, pace: str = DEFAULT_PACE
) -> ItineraryOutput:
    """Route-aware narrate (Step 7): geo-order all places, split into near-even contiguous
    day groups, optimize intra-day order, and attach feasibility warnings. Replaces the naive
    input-order chunking. `pace` defaults to 'balanced' (Step 9 threads it from prefs)."""
    d = len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    ordered = geo_order(places)
    base, extra = divmod(len(ordered), d)
    days: list[ItineraryDay] = []
    numbered: list[tuple[int, list[CanonicalPlace]]] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = optimal_day_order(ordered[idx:idx + size])
        idx += size
        days.append(ItineraryDay(day_number=i + 1, date=day_date,
                                 place_names=[p.name for p in group]))
        numbered.append((i + 1, group))
    return ItineraryOutput(
        title="Tokyo (offline pipeline skeleton)",
        source="pipeline",
        source_places=[p.name for p in places],   # all input names (set-checked by parity)
        days=days,
        feasibility_warnings=assess_feasibility(numbered, pace=pace),
    )
```

Update the module docstring's `narrate` line to "route-aware geo-order + intra-day TSP + feasibility warnings (Step 7)".

- [ ] **Step 4: Add the new non-gating metrics**

In `backend/evals/metrics.py`, add (reuse `haversine_m` from `evals/util`):

```python
def max_single_leg_m(ctx: dict) -> float:
    """Longest single consecutive intra-day leg (m). A high value = a transit-heavy day."""
    coords = {p["name"]: (p["lat"], p["lng"]) for p in ctx["places"]
              if p.get("lat") is not None and p.get("lng") is not None}
    longest = 0.0
    for day in ctx["itinerary"]["days"]:
        names = day["place_names"]
        for i in range(len(names) - 1):
            a, b = coords.get(names[i]), coords.get(names[i + 1])
            if a and b:
                longest = max(longest, haversine_m(a[0], a[1], b[0], b[1]))
    return round(longest, 1)


def feasibility_warning_count(ctx: dict) -> int:
    """Number of feasibility warnings the pipeline attached (0 for the baseline subject)."""
    return len(ctx["itinerary"].get("feasibility_warnings", []))
```

Register both in `QUALITY_METRICS`. Add them ONLY to the new `japan_feasibility` regression case (Step 6) — do NOT add them to `japan_first_trip`/`japan_second_trip`. Reason: the reorder minimizes the MEAN leg but can raise a single MAX leg, so a `max_single_leg_m <= baseline` parity assertion on the anchors could spuriously fail. Keep the anchor cases on their existing metrics; only `mean_intra_day_travel_m` is relaxed (Step 5). (`feasibility_warning_count` is always 0 for the baseline subject anyway.)

- [ ] **Step 5: Convert the parity-anchor test (pipeline now BEATS baseline)**

In `backend/evals/test_run_eval.py`, convert `test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`:

```python
def test_pipeline_route_beats_or_matches_baseline_on_parity_anchors():
    # Step 7: the pipeline reorders for shorter routes, so it no longer EQUALS the baseline.
    # mean_intra_day_travel_m must be <= baseline (route is no worse); every OTHER metric is
    # unchanged (==). Cases flagged diverges_from_baseline are skipped (e.g. japan_dedupe).
    IMPROVE = {"mean_intra_day_travel_m"}
    for name in gather_case_names():
        case = load_case(name)
        if case.get("diverges_from_baseline"):
            continue
        base_ctx, pipe_ctx = build_ctx(case, "baseline"), build_ctx(case, "pipeline")
        for m in case["active_quality_metrics"]:
            b, p = QUALITY_METRICS[m](base_ctx), QUALITY_METRICS[m](pipe_ctx)
            if m in IMPROVE:
                assert p <= b, f"{name}/{m}: pipeline {p} > baseline {b}"
            else:
                assert p == b, f"{name}/{m}: pipeline {p} != baseline {b}"


def test_pipeline_strictly_improves_route_on_japan_first_trip():
    # proves the reorder actually shortens the route (not just matches)
    base = QUALITY_METRICS["mean_intra_day_travel_m"](build_ctx(load_case("japan_first_trip"), "baseline"))
    pipe = QUALITY_METRICS["mean_intra_day_travel_m"](build_ctx(load_case("japan_first_trip"), "pipeline"))
    assert pipe < base, f"expected pipeline route ({pipe}) shorter than baseline ({base})"
```

(The parity-anchor cases keep their existing `active_quality_metrics`; only `mean_intra_day_travel_m` is relaxed to `<=`. The new `max_single_leg_m`/`feasibility_warning_count` metrics live only on the `japan_feasibility` case, which the parity test skips via `diverges_from_baseline` — so no risk of a max-leg assertion failing the anchors.)

- [ ] **Step 6: Add the long-leg/overpacked regression case + fixture**

Create `backend/evals/fixtures/japan_feasibility_places.json` — places where ONE stop is unavoidably far (a long leg survives even optimal ordering) and/or a day is overpacked. E.g. 5 Tokyo-clustered places + 1 place ~30 km out (Yokohama-ish, still in Japan bbox) so any day containing it has a `long_leg` flag. All in-bbox, valid coords, full PlaceResult field shape.

Create `backend/evals/cases/japan_feasibility.json`:

```json
{
  "case": "japan_feasibility",
  "description": "Long-leg + overpacked regression. One far-flung stop (~30km) forces a long_leg flag even after optimal ordering; a packed day exceeds the balanced cap. Pipeline attaches feasibility_warnings (baseline does not). diverges_from_baseline so the parity anchor test skips it.",
  "reels_fixture": "fixtures/japan_demo_reels.json",
  "places_fixture": "fixtures/japan_feasibility_places.json",
  "start_date": "2026-06-10",
  "end_date": "2026-06-11",
  "expected_unique_places": 6,
  "diverges_from_baseline": true,
  "active_contractual_checks": ["coords_present", "japan_bbox", "day_count", "source_places_parity", "day_places_traceable"],
  "active_quality_metrics": ["dedup_error", "max_single_leg_m", "feasibility_warning_count", "hallucination_rate"],
  "pending_checks": []
}
```

Add a pytest gate (pipeline-only — baseline emits no warnings, so this can't be a contractual check) in `test_run_eval.py`:

```python
def test_pipeline_flags_long_leg_on_feasibility_case():
    ctx = build_ctx(load_case("japan_feasibility"), "pipeline")
    kinds = {w["kind"] for w in ctx["itinerary"]["feasibility_warnings"]}
    assert "long_leg" in kinds          # the ~30km stop is flagged even after optimal ordering
    assert QUALITY_METRICS["feasibility_warning_count"](ctx) >= 1
```

- [ ] **Step 7: Run full suite + both eval subjects + import invariant**

Run: `cd backend && uv run pytest -q` → all pass, 1 live skip (test count up).
Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import capture, pipeline.offline_harness, pipeline.feasibility; print('keyless import OK')"`
Run: `cd backend && uv run python -m evals.run_eval --subject baseline` → `OVERALL: PASS` (frozen baseline unchanged; `japan_feasibility` baseline records `feasibility_warning_count=0`, `max_single_leg_m` large — non-gating).
Run: `cd backend && uv run python -m evals.run_eval --subject pipeline` → `OVERALL: PASS`; `japan_first_trip` `mean_intra_day_travel_m` now **< 8163.7** (route improved); `japan_feasibility` shows `feasibility_warning_count >= 1`.

- [ ] **Step 8: Commit**

```bash
cd backend && git add pipeline/offline_harness.py pipeline/test_offline_harness.py evals/metrics.py evals/test_run_eval.py evals/cases/japan_feasibility.json evals/fixtures/japan_feasibility_places.json
git commit -m "feat(pipeline): route-aware itinerary + feasibility warnings (pipeline beats baseline)"
```

---

## Manual verification (optional)

See the route improvement + warnings on the demo set:
```bash
cd backend && uv run python -m evals.run_eval --subject pipeline --case japan_first_trip | grep -iE "mean_intra|OVERALL"
cd backend && uv run python -m evals.run_eval --subject pipeline --case japan_feasibility | grep -iE "feasibility|max_single|OVERALL"
```

## NOT in scope / deferred

- **Mapbox Directions live legs** — warnings use haversine now; Directions (`/directions/v5/mapbox/driving`, 1 request for ≤8 stops, existing `sk` token) is the injected live provider, deferred (the transport-legs step / `transport_legs` pending check).
- **k-means day clustering** — nearest-neighbor chain + split is deterministic, simpler, and beats baseline; k-means is a possible future refinement (needs deterministic seeding for the eval).
- **narrator / orchestrator consumption** — `narrator.py`/`orchestrator.py` are stubs; they read `feasibility_warnings` when built. Step 7 only produces the field.
- **`pace` from `UserPreferences`** — threaded at Step 9 (mem0/prefs); Step 7 defaults `pace="balanced"`.
- **2-opt / Optimization API reorder** — brute-force is optimal at this N; the Mapbox Optimization API (≤12 coords) is the live-routing upgrade later.

## Rollback / risk

- **Blast radius:** one new pure module + an additive model field + the `assemble_itinerary` rewrite + new metrics/case/fixture + the parity-test conversion. Revert = drop the two commits.
- **Risk:** Moderate — this is the first step that intentionally changes the pipeline's itinerary output. Mitigations: ordering is deterministic (eval reproducible); the parity test converts to "beats/matches baseline" (anticipated by the harness docstring), with a strict-improvement test proving the win; the frozen baseline + the 6 contractual checks are untouched; reordering preserves place names so traceability holds. Main review focus: the parity-test conversion is correct (only `mean_intra_day_travel_m` relaxed to `<=`, everything else `==`), and the regression fixture genuinely produces a surviving long leg after optimal ordering.
