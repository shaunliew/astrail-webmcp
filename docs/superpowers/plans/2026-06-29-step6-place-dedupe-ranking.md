# Step 6 — Place Dedupe + Confidence Ranking (in-trip, two-gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the `dedup_passthrough` placeholder with real in-trip place dedup so duplicate Reel mentions collapse and low-confidence places don't poison planning — using a **two-gate** rule (name/alias **AND** geographic proximity, both required) plus confidence-ranked capping that never drops user-requested places, with per-source evidence + `times_referenced` retained and a human-readable keep/drop rationale.

**Architecture:** A pure, offline `pipeline/dedup.py` clusters extracted `PlaceResult`s: two places merge only if their **alias sets intersect** (normalized `name` + `name_local`) **and** they are within `PLACE_LATLNG_DISTANCE_M` (haversine, requires coords on both). Each cluster becomes one `CanonicalPlace` (representative = highest-confidence member; merged aliases + per-source evidence + `times_referenced`). The result is capped to `MAX_PLACES_PER_TRIP` by dropping the lowest-confidence non-user-requested places, **preserving input order** among survivors. The offline harness swaps `dedup_passthrough` → `dedupe_places`; a new dup-bearing eval case demonstrates the metric improvement.

**Scope decision (Shaun, 2026-06-29):** **Name + alias matching** as the semantic gate (decision A) — no embeddings. Fully offline, zero new dependency. The embedding-based semantic gate (`SEMANTIC_DEDUP_THRESHOLD` cosine) and the **persistent cross-trip pgvector cache** (the "data flywheel") are the later **Supabase** step — out of scope here (Supabase isn't wired; agent-pipeline-before-Supabase sequencing).

**Tech Stack:** Python 3.14, Pydantic v2, stdlib (`re`, `math`, `dataclasses`), pytest. No new dependencies. No OpenAI, no Supabase.

## Global Constraints

- **#16 eval stays green on BOTH subjects.** The current Japan fixture is 8 distinct-name, all-coords places → dedup merges nothing (no alias overlap) and 8 ≤ cap 8 → no drop → **identical pipeline output + order** → `check_source_places_parity`, `day_count`, `dedup_error=0`, and the `test_offline_harness` parity test all hold. New dedup behavior is proven by unit tests + a NEW eval case, never by changing the frozen fixture.
- **Preserve input order among survivors.** `assemble_itinerary` chunks in input order; ranking decides only *which* places to drop at the cap, never reorders the kept set. (No-op on the 8-place fixture → order unchanged.)
- **Two-gate, both required** (acceptance): semantic-only (alias match, far apart) must NOT merge; geo-only (distinct names, same building) must NOT merge; "Ichiran Shibuya" vs "Ichiran Shinjuku" must NOT merge (geo gate). Gated by unit tests, NOT a new contractual check (a contractual check would fail the baseline subject, which doesn't dedup).
- **Never drop user-requested places** (`source_type == "user_requested"`) at the cap, even past `MAX_PLACES_PER_TRIP`.
- **Additive model fields only.** New `CanonicalPlace` fields default empty; `PlaceResult` and the eval-read keys (`name`, `lat`, `lng`, `evidence_quote`, `source_type`) are unchanged. Eval ignores unknown keys (verified). No TS mirror exists for these models yet (guardrail #4 — flag for Zhi Hao, not a task here).
- **Pure + offline + deterministic.** No randomness, no network, no key, no env-dependent thresholds in the eval path (use the documented constants `500.0` m / `8`). Import-time invariant holds (`import pipeline.dedup` pulls only stdlib + models).
- **Immutability + style:** dedup returns new objects (never mutates inputs); PEP 8; type annotations; small focused files.

---

### Task 1: Pure two-gate dedup module + model fields

**Files:**
- Create: `backend/pipeline/geo.py` (shared haversine)
- Test: `backend/pipeline/test_geo.py`
- Modify: `backend/models/place.py` (`CanonicalPlace` merge metadata)
- Create: `backend/pipeline/dedup.py` (real dedup; the file is currently a one-line stub — overwrite it)
- Test: `backend/pipeline/test_dedup.py`

**Interfaces:**
- Produces: `pipeline.geo.haversine_m(lat1, lng1, lat2, lng2) -> float`; `pipeline.dedup.dedupe_places(places, *, distance_m=500.0, max_places=8) -> DedupeResult` where `DedupeResult` (frozen dataclass) has `.places: list[CanonicalPlace]` and `.notes: list[str]`. `CanonicalPlace` gains `aliases: list[str]`, `evidence_quotes: list[str]` (plus existing `times_referenced`).

- [ ] **Step 1: Write the failing tests — geo helper**

Create `backend/pipeline/test_geo.py`:

```python
from pipeline.geo import haversine_m


def test_haversine_zero_distance():
    assert haversine_m(35.0, 139.0, 35.0, 139.0) == 0.0


def test_haversine_known_short_distance():
    # ~111 m per 0.001° latitude near Tokyo
    d = haversine_m(35.000, 139.000, 35.001, 139.000)
    assert 100 < d < 125
```

- [ ] **Step 2: Run → fail**

Run: `cd backend && uv run pytest pipeline/test_geo.py -q` → FAIL (`No module named 'pipeline.geo'`).

- [ ] **Step 3: Create `pipeline/geo.py`**

```python
"""Great-circle distance — shared geo helper for the pipeline layer (dedup) and capture.
Pure, stdlib-only. (evals/util keeps its own copy on purpose: it is the frozen #16 bar
and must stay independent of pipeline code.)"""
from __future__ import annotations

import math

_EARTH_RADIUS_M = 6_371_000


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres between two (lat, lng) points."""
    rlat1, rlng1, rlat2, rlng2 = map(math.radians, (lat1, lng1, lat2, lng2))
    dlat, dlng = rlat2 - rlat1, rlng2 - rlng1
    h = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * _EARTH_RADIUS_M * math.asin(math.sqrt(h))
```

Run: `cd backend && uv run pytest pipeline/test_geo.py -q` → PASS.

- [ ] **Step 4: Add merge metadata to `CanonicalPlace`**

In `backend/models/place.py`, change `CanonicalPlace`:

```python
class CanonicalPlace(PlaceResult):
    """A deduplicated place. `times_referenced` is the data-flywheel counter (Step 6's
    two-gate dedup increments it on a merge). `aliases` are the distinct names/local-names
    of all merged mentions; `evidence_quotes` keeps each merged source's evidence."""

    times_referenced: int = 1
    aliases: list[str] = Field(default_factory=list)
    evidence_quotes: list[str] = Field(default_factory=list)
```

(`Field` is already imported in `place.py`.)

- [ ] **Step 5: Write the failing tests — dedup**

Create `backend/pipeline/test_dedup.py`:

```python
"""Two-gate (alias + geo) in-trip dedup — pure, offline."""
from models.place import CanonicalPlace, PlaceResult
from pipeline.dedup import dedupe_places


def _p(name, lat, lng, conf=0.9, *, name_local=None, evidence=None, source_type="reel_extracted"):
    return PlaceResult(name=name, category="restaurant", confidence=conf,
                       evidence_quote=evidence or name, lat=lat, lng=lng,
                       name_local=name_local, source_type=source_type)


def test_merges_same_venue_close_and_alias_overlap():
    # English name in one mention, Japanese name_local bridging the other → alias overlap + ~same coords
    a = _p("Ichiran Shibuya", 35.6611, 139.7011, 0.85, name_local="一蘭 渋谷店", evidence="📍一蘭 渋谷店")
    b = _p("一蘭 渋谷店", 35.6612, 139.7012, 0.95, evidence="Ichiran 渋谷")
    res = dedupe_places([a, b])
    assert len(res.places) == 1
    c = res.places[0]
    assert isinstance(c, CanonicalPlace)
    assert c.times_referenced == 2
    assert c.confidence == 0.95                      # representative = highest confidence
    assert set(c.evidence_quotes) == {"📍一蘭 渋谷店", "Ichiran 渋谷"}
    assert "一蘭 渋谷店" in c.aliases and "Ichiran Shibuya" in c.aliases


def test_does_not_merge_same_chain_different_branches_geo_gate():
    # same chain root, but >500 m apart → geo gate blocks the merge (acceptance: Shibuya vs Shinjuku)
    a = _p("Ichiran", 35.6611, 139.7011)
    b = _p("Ichiran", 35.6938, 139.7035)            # Shinjuku, ~3.6 km away
    res = dedupe_places([a, b])
    assert len(res.places) == 2                     # NOT merged


def test_semantic_only_is_not_enough():
    # identical names but far apart → semantic matches, geo fails → no merge
    res = dedupe_places([_p("Cafe X", 35.0, 139.0), _p("Cafe X", 36.0, 140.0)])
    assert len(res.places) == 2


def test_geo_only_is_not_enough():
    # different venues in the same building (<500 m) → geo matches, semantic fails → no merge
    res = dedupe_places([_p("Ramen A", 35.6600, 139.7000), _p("Sushi B", 35.6601, 139.7001)])
    assert len(res.places) == 2


def test_no_coords_never_merges():
    a = PlaceResult(name="X", category="other", confidence=0.9, evidence_quote="X", lat=None, lng=None)
    b = PlaceResult(name="X", category="other", confidence=0.9, evidence_quote="X", lat=None, lng=None)
    assert len(dedupe_places([a, b]).places) == 2   # geo gate needs coords on both


def test_cap_drops_lowest_confidence_keeps_input_order():
    places = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=round(0.5 + i * 0.05, 2)) for i in range(10)]
    res = dedupe_places(places, max_places=8)
    assert len(res.places) == 8
    # the two lowest-confidence (P0=0.5, P1=0.55) are dropped; survivors stay in input order
    names = [p.name for p in res.places]
    assert names == ["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]
    assert any("dropped 'P0'" in n for n in res.notes)


def test_cap_never_drops_user_requested():
    places = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=0.99) for i in range(8)]
    places.append(_p("MyPick", 36.5, 140.5, conf=0.10, source_type="user_requested"))
    res = dedupe_places(places, max_places=8)
    assert "MyPick" in [p.name for p in res.places]   # kept despite lowest conf + over cap


def test_distinct_places_pass_through_unchanged_order():
    places = [_p("A", 35.0, 139.0), _p("B", 35.5, 139.5), _p("C", 36.0, 140.0)]
    res = dedupe_places(places)
    assert [p.name for p in res.places] == ["A", "B", "C"]
    assert all(p.times_referenced == 1 for p in res.places)


def test_user_requested_protected_even_when_merged_with_higher_conf_rep():
    # a low-conf user_requested mention merging with a higher-conf reel rep stays protected
    fillers = [_p(f"P{i}", 35.0 + i, 139.0 + i, conf=0.99) for i in range(8)]
    rep = _p("MyPick", 36.5, 140.5, conf=0.99)                                  # reel rep (higher conf)
    req = _p("MyPick", 36.5001, 140.5001, conf=0.10, source_type="user_requested")  # merges with rep
    res = dedupe_places(fillers + [rep, req], max_places=8)
    kept = {p.name: p for p in res.places}
    assert "MyPick" in kept                                  # survived the cap (8 fillers would fill it)
    assert kept["MyPick"].source_type == "user_requested"    # cluster-level protection


def test_transitive_cluster_merges_via_any_member():
    # A~B (~333 m) and B~C (~333 m) but A~C (~666 m) — all one cluster via B (any-member match)
    a, b, c = _p("Spot", 35.0000, 139.0), _p("Spot", 35.0030, 139.0), _p("Spot", 35.0060, 139.0)
    res = dedupe_places([a, b, c])
    assert len(res.places) == 1 and res.places[0].times_referenced == 3
```

- [ ] **Step 6: Run → fail**

Run: `cd backend && uv run pytest pipeline/test_dedup.py -q` → FAIL (`No module named 'pipeline.dedup'` / no `dedupe_places`).

- [ ] **Step 7: Implement `pipeline/dedup.py`** (overwrite the stub)

```python
"""In-trip place dedup — two-gate: name/alias overlap AND geographic proximity.

Both gates must pass to merge (acceptance: semantic-only and geo-only are each
insufficient; distinct chain branches like Shibuya vs Shinjuku stay separate via the
geo gate). Pure + offline — no embeddings, no Supabase. The embedding semantic gate and
the persistent cross-trip pgvector cache (the data flywheel) are a later Supabase step.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from models.place import CanonicalPlace, PlaceResult
from pipeline.geo import haversine_m

DEFAULT_DISTANCE_M = 500.0   # PLACE_LATLNG_DISTANCE_M
DEFAULT_MAX_PLACES = 8       # MAX_PLACES_PER_TRIP

_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)   # \w + re.UNICODE keeps CJK; drops punctuation/emoji
_WS = re.compile(r"\s+")


def _normalize(name: str | None) -> str:
    """Lowercase, drop punctuation/emoji, collapse whitespace. '' for blank/None."""
    if not name:
        return ""
    return _WS.sub(" ", _NON_WORD.sub(" ", name.lower())).strip()


def _aliases(place: PlaceResult) -> set[str]:
    """Normalized match keys for a place: its name and its local-language name."""
    return {a for a in (_normalize(place.name), _normalize(place.name_local)) if a}


def _semantic_match(a: PlaceResult, b: PlaceResult) -> bool:
    return bool(_aliases(a) & _aliases(b))


def _geo_match(a: PlaceResult, b: PlaceResult, distance_m: float) -> bool:
    if None in (a.lat, a.lng, b.lat, b.lng):
        return False  # geo gate requires coordinates on BOTH places
    return haversine_m(a.lat, a.lng, b.lat, b.lng) < distance_m


@dataclass(frozen=True)
class DedupeResult:
    places: list[CanonicalPlace]
    notes: list[str]


def _merge_cluster(cluster: list[PlaceResult]) -> CanonicalPlace:
    """Build one CanonicalPlace from a cluster: representative = highest confidence
    (ties → earliest, preserving creator-tag priority), with merged aliases + evidence."""
    rep = max(cluster, key=lambda p: p.confidence)
    seen_alias, aliases = set(), []
    for m in cluster:
        for nm in (m.name, m.name_local):
            if nm and nm not in seen_alias:
                seen_alias.add(nm)
                aliases.append(nm)
    canonical = CanonicalPlace.model_validate(rep.model_dump())
    update: dict = {
        "times_referenced": len(cluster),
        "aliases": aliases,
        "evidence_quotes": [m.evidence_quote for m in cluster],
    }
    # User-requested protection is CLUSTER-level: if ANY merged mention was user-requested,
    # the canonical is user-requested (so the cap never drops it) — even when a higher-
    # confidence reel mention is the representative.
    if any(m.source_type == "user_requested" for m in cluster):
        update["source_type"] = "user_requested"
    return canonical.model_copy(update=update)


def dedupe_places(
    places: list[PlaceResult], *, distance_m: float = DEFAULT_DISTANCE_M,
    max_places: int = DEFAULT_MAX_PLACES,
) -> DedupeResult:
    """Cluster duplicates (two-gate), build canonical places, then cap to max_places by
    dropping the lowest-confidence non-user-requested places — preserving input order
    among survivors. Returns the canonical places + human-readable keep/drop notes.
    Never mutates the input list."""
    clusters: list[list[PlaceResult]] = []
    for p in places:
        for cl in clusters:
            # Match against ANY member (not just the first) so transitive duplicates
            # (A~B, B~C, but A not~C) still land in one cluster.
            if any(_semantic_match(m, p) and _geo_match(m, p, distance_m) for m in cl):
                cl.append(p)
                break
        else:
            clusters.append([p])

    canonical = [_merge_cluster(cl) for cl in clusters]   # first-occurrence (input) order
    notes = [
        (f"kept '{c.name}' (conf {c.confidence}; {c.times_referenced} mention(s) merged: {c.aliases})"
         if c.times_referenced > 1 else f"kept '{c.name}' (conf {c.confidence})")
        for c in canonical
    ]

    if len(canonical) > max_places:
        required = [c for c in canonical if c.source_type == "user_requested"]
        optional = [c for c in canonical if c.source_type != "user_requested"]
        slots = max(0, max_places - len(required))
        keep_ids = {id(c) for c in required}
        keep_ids |= {id(c) for c in sorted(optional, key=lambda c: c.confidence, reverse=True)[:slots]}
        for c in canonical:
            if id(c) not in keep_ids:
                notes.append(f"dropped '{c.name}' (over cap {max_places}, conf {c.confidence})")
        canonical = [c for c in canonical if id(c) in keep_ids]   # preserves input order

    return DedupeResult(places=canonical, notes=notes)
```

- [ ] **Step 8: Run → pass**

Run: `cd backend && uv run pytest pipeline/test_dedup.py pipeline/test_geo.py -q` → PASS (all).

- [ ] **Step 9: Confirm import-keyless invariant**

Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import pipeline.dedup, pipeline.geo; print('keyless import OK')"`

- [ ] **Step 10: Commit**

```bash
cd backend && git add pipeline/geo.py pipeline/test_geo.py pipeline/dedup.py pipeline/test_dedup.py models/place.py
git commit -m "feat(dedup): two-gate (alias+geo) in-trip place dedup + confidence-capped ranking"
```

---

### Task 2: Wire dedup into the offline pipeline + new dup eval case

**Files:**
- Modify: `backend/pipeline/offline_harness.py` (replace `dedup_passthrough` with `dedupe_places`)
- Modify: `backend/pipeline/test_offline_harness.py` (update the passthrough test → dedup)
- Modify: `backend/capture.py` (repoint `_haversine_m` to `pipeline.geo` — DRY)
- Modify: `backend/evals/test_run_eval.py` (exclude `diverges_from_baseline` cases from the metric-parity anchor)
- Create: `backend/evals/fixtures/japan_dedup_places.json` + `backend/evals/cases/japan_dedupe.json`

**Interfaces:**
- Consumes: `pipeline.dedup.dedupe_places`, `pipeline.geo.haversine_m` (Task 1).
- The harness `dedup` stage now merges + caps. `PipelineOutput` is UNCHANGED — `dedupe_places` returns its keep/drop `notes` (unit-tested in Task 1), but they are NOT threaded into `PipelineOutput`, which by its own docstring mirrors ONLY the eval-consumption shape. Live surfacing of the rationale (tracer / SSE reasoning rail) is a later step.

- [ ] **Step 1: Write/adjust the failing test**

In `backend/pipeline/test_offline_harness.py`, replace `test_dedup_passthrough_wraps_as_canonical` (and its `dedup_passthrough` import) with a dedup test:

```python
from pipeline.dedup import dedupe_places  # replaces the dedup_passthrough import


def test_dedupe_distinct_places_pass_through_as_canonical():
    places = [PlaceResult(name="A", category="other", confidence=0.9, evidence_quote="A", lat=35.0, lng=139.0),
              PlaceResult(name="B", category="other", confidence=0.8, evidence_quote="B", lat=35.5, lng=139.5)]
    res = dedupe_places(places)
    assert [p.name for p in res.places] == ["A", "B"]
    assert all(isinstance(p, CanonicalPlace) and p.times_referenced == 1 for p in res.places)
```

(The existing `test_pipeline_places_validate_and_carry_canonical_fields` must still pass unchanged — the mini fixture's two places are distinct → no merge → names + order + `times_referenced=1` all hold.)

- [ ] **Step 2: Run → fail**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -q` → FAIL (`dedup_passthrough` import gone).

- [ ] **Step 3: Wire `dedupe_places` into the harness**

In `backend/pipeline/offline_harness.py`: delete the `dedup_passthrough` function and import `from pipeline.dedup import dedupe_places`. Change ONLY the `dedup` stage (the return shape is unchanged):

```python
    with sw.stage("dedup"):
        canonical = dedupe_places(extracted).places   # two-gate alias+geo, confidence-capped
```

Update the module docstring's `dedup` line to "two-gate alias+geo (Step 6)". (`CanonicalPlace`/`PlaceResult` imports stay; the return `PipelineOutput(...)` is untouched.)

- [ ] **Step 4: Repoint capture's haversine (DRY)**

In `backend/capture.py`, delete the local `_haversine_m` and import the shared one: `from pipeline.geo import haversine_m`, replacing the call site `_haversine_m(original_coords, (grounded.lat, grounded.lng))` with `haversine_m(original_coords[0], original_coords[1], grounded.lat, grounded.lng)`. (One canonical pipeline-layer haversine; `evals/util` stays independent.)

- [ ] **Step 5: Add the dedup eval case + fixture**

Create `backend/evals/fixtures/japan_dedup_places.json` — **9 raw** places collapsing to **8 unique**:
- **Merging pair** (cross-language same venue → 1): `{name:"Ichiran Shibuya", name_local:"一蘭 渋谷店", lat:35.6611, lng:139.7011}` + `{name:"一蘭 渋谷店", name_local:null, lat:35.6612, lng:139.7012}` — alias overlap on `一蘭 渋谷店` + ~15 m → merge.
- **Non-merging same-chain pair** (shared alias, geo-blocked → stays 2): `{name:"Ichiran", lat:35.6650, lng:139.7000}` + `{name:"Ichiran", lat:35.6938, lng:139.7035}` — alias overlap on `ichiran` but ~3.2 km apart → geo gate blocks. (Shared alias is REQUIRED to actually exercise the geo gate — distinct names would never reach it.)
- **5 distinct venues** (e.g. teamLab Planets, Senso-ji, Shibuya Sky, Tsukiji Outer Market, Meiji Jingu) → 5.

Total **2 + 2 + 5 = 9 raw → 8 unique** (only the first pair merges). Every place carries `name`, `category`, `lat`, `lng` (all inside the Japan bbox), `confidence`, `evidence_quote`, `source_type`, `source_url`, `name_local` (mirror `expected_places.json`'s shape).

Create `backend/evals/cases/japan_dedupe.json`:

```json
{
  "case": "japan_dedupe",
  "description": "9 raw mentions -> 8 unique. One cross-language same-venue pair merges (alias '一蘭 渋谷店' + ~15m); one same-chain pair shares alias 'Ichiran' but is ~3.2km apart so the geo gate keeps them separate. dedup_error: pipeline 0, baseline 1. diverges_from_baseline so the metric-parity anchor test skips it.",
  "reels_fixture": "fixtures/japan_demo_reels.json",
  "places_fixture": "fixtures/japan_dedup_places.json",
  "start_date": "2026-06-10",
  "end_date": "2026-06-12",
  "expected_unique_places": 8,
  "diverges_from_baseline": true,
  "active_contractual_checks": ["coords_present", "japan_bbox", "day_count", "source_places_parity", "day_places_traceable"],
  "active_quality_metrics": ["dedup_error", "mean_intra_day_travel_m", "hallucination_rate"],
  "pending_checks": []
}
```

NB on the case:
- **`dedup_error` distinguishes the subjects** (it reads `ctx["places"]`): pipeline → `0` (deduped to 8); baseline → `1` (`|9 − 8|`, baseline loads the 9 raw). Non-gating.
- **No gating "count == expected_unique" check** — it would fail the baseline subject (9 ≠ 8) and break `run_eval --subject baseline`. Dedup correctness is gated by `pipeline/test_dedup.py`; the eval records it via `dedup_error`.
- **`evidence_verbatim` omitted on purpose:** the case reuses `japan_demo_reels.json` as its corpus, and the dedup fixture's quotes are NOT in it, so the check would **fail** (captions present → not `block`). Omitting is correct.
- **Baseline is not "no dedup":** `evals/baseline.py` does lowercase exact-name dedup when building its itinerary, so the two `"Ichiran"` mentions collapse in the baseline *itinerary* — harmless, because `dedup_error` reads `ctx["places"]` (the raw 9), not the itinerary, and the contractual checks still pass.

- [ ] **Step 6: Exclude the dedup case from the metric-parity anchor test**

`evals/test_run_eval.py::test_pipeline_subject_matches_baseline_metrics_on_current_fixtures` loops every case asserting `pipeline metrics == baseline metrics` — its own docstring says Step 6 will make the pipeline diverge and the test gets updated then. Update it to skip cases that opt out via the new flag:

```python
    for name in gather_case_names():
        case = load_case(name)
        if case.get("diverges_from_baseline"):
            continue  # e.g. japan_dedupe: dedup_error intentionally differs from baseline (Step 6)
        base_ctx = build_ctx(case, subject="baseline")
        ...
```

(`test_pipeline_subject_passes_all_contractual_checks` still loops ALL cases — `japan_dedupe` must pass its contractual checks under the pipeline subject, which it does: 8 deduped places, all coords, in-bbox, 3 days, traceable. No change needed there.)

- [ ] **Step 7: Run the full suite + both eval subjects + import invariant**

Run: `cd backend && uv run pytest -q` → all pass, 1 live skip.
Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import capture, pipeline.offline_harness; print('keyless import OK')"`
Run: `cd backend && uv run python -m evals.run_eval --subject baseline` → `OVERALL: PASS`; on `japan_dedupe`, `dedup_error = 1` (baseline loads 9 raw) — recorded, non-gating.
Run: `cd backend && uv run python -m evals.run_eval --subject pipeline` → `OVERALL: PASS`; on `japan_dedupe`, `dedup_error = 0` (pipeline merged the cross-language pair to 8); on `japan_first_trip`, output + `dedup_error = 0` unchanged (parity anchor holds).

- [ ] **Step 8: Commit**

```bash
cd backend && git add pipeline/offline_harness.py pipeline/test_offline_harness.py evals/test_run_eval.py capture.py evals/fixtures/japan_dedup_places.json evals/cases/japan_dedupe.json
git commit -m "feat(pipeline): wire two-gate dedup into harness + dup eval case"
```

---

## NOT in scope / deferred

- **Embedding-based semantic gate** (`SEMANTIC_DEDUP_THRESHOLD` cosine via OpenAI `text-embedding-3-small`) — decision A chose name/alias for v1; embeddings are the upgrade when the pgvector cache lands.
- **Persistent cross-trip pgvector cache** (the data flywheel: match against prior trips, increment `times_referenced` across runs) — needs Supabase; later step.
- **TS mirror** for `CanonicalPlace`'s new fields — `backend-types.ts` doesn't mirror place models yet; flag for Zhi Hao.
- **A gating "dedup count" contractual check** — would fail the baseline subject; dedup correctness is gated by `pipeline/test_dedup.py` instead, with `dedup_error` as the recorded eval signal.
- **Consolidating evals/util's haversine** — left independent on purpose (frozen #16 bar).

## Rollback / risk

- **Blast radius:** two new pipeline modules + additive `CanonicalPlace`/`PipelineOutput` fields + a harness stage swap + one new eval case/fixture + a 1-line capture DRY repoint. Revert = drop the two commits.
- **Risk:** Low–moderate. The dedup logic is the only real behavior change; it's a **no-op on the existing fixtures** (distinct names, ≤ cap) so the #16 parity holds, and the new merge/cap/branch behavior is covered by `pipeline/test_dedup.py` + the new eval case. Main thing to verify in review: the order-preservation guarantee (rank decides drops, not order) and that the `japan_dedupe` fixture's coordinates make exactly one pair merge (and the branch pair stay separate).
