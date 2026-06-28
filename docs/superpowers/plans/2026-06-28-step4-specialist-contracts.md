# Step 4 — Specialist Agent Split: Freeze Core Pydantic Stage Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze the typed Pydantic I/O contracts for the **core pipeline spine** (reel → place → canonical → itinerary, plus user preferences) and wire them into the offline harness as typed stage boundaries — so Steps 5–7 (live Apify extraction, real dedup, feasibility/narrate) build real agents against stable, validated contracts. Fully offline; the #16 eval must stay green.

**Architecture:** Fill the `backend/models/` stubs with Pydantic v2 models whose shapes match the dict shapes the eval already consumes (anchored to the fixtures), validated against the PRD's field rules (lat/lng bounds, `source_type` enum, required evidence/confidence). Refactor `run_offline_pipeline` so each stage consumes/produces these typed models; serialize back to the eval-shaped dicts at the `PipelineOutput` boundary via `model_dump()`, so the eval (which reads dicts) is unchanged. `baseline.py` stays frozen and dict-based. No real agents, no live calls — the fixtures are validated into the contracts, proving they hold for real data.

**Tech Stack:** Python ≥3.14, Pydantic v2 (already a dependency — `pydantic>=2.0.0`). No new dependencies. No live OpenAI / Apify / Mapbox / mem0 / Supabase / Langfuse.

**Guiding principle (project policy): feasible first, not perfect.** Type only the **core spine** the current pipeline + Steps 5–7 need. **Defer** the enrichment models (weather, restaurant, transport, hotel, orchestrator summary) to the steps that build those agents. **Defer** drop-invalid extraction logic to Step 5 (the real extractor), and the `backend-types.ts` TS mirror to the frontend. Don't over-model speculative fields.

## Global Constraints

- **Offline + credential-free.** No live OpenAI / Apify / Mapbox / mem0 / Supabase / Langfuse. Unit suite passes with **no API key**.
- **The #16 eval stays green.** `run_eval` (baseline + pipeline) still ends `OVERALL: PASS`, exit 0; the Step 2 parity anchor (`test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`) still passes (the typed models serialize to the same name/lat/lng/evidence_quote/source_url values the metrics read).
- **No `legacy/` imports.** Reproduce the field shapes/validators; never import from `legacy/`. (Guardrail #9.)
- **`baseline.py` stays frozen + dict-based.** Only the *pipeline* path uses typed models; the baseline path is untouched.
- **Contracts anchored to the fixtures.** Field names match what the eval consumes: `evidence_quote` (NOT `evidence_caption_quote`), `source_type`, etc. Both `expected_places.json` and `mini_places.json` must validate into `PlaceResult` without error.
- **Validation per PRD/CLAUDE.md.** lat `ge=-90, le=90`; lng `ge=-180, le=180`; confidence `ge=0, le=1`; `source_type` ∈ `{reel_extracted, user_requested, agent_suggested}`. (CLAUDE.md hard-won lessons + PRD §11/§12.)
- **No new dependencies.** Pydantic only.
- **No real agents / live Apify / real dedup / routing / SSE / Supabase / frontend.** Models + harness rewiring only.
- **Style:** PEP 8, type annotations, frozen/immutable where natural, files <200 lines.

---

## The Contract — typed models ↔ the dict shapes the eval consumes

Each model `model_dump()`s to an **eval-compatible** dict — a *superset* of what the eval reads: it adds defaulted keys the eval ignores (`source_type`, `times_referenced`, `None` optionals), while preserving the eval-read keys (`name`, `lat`, `lng`, `evidence_quote`, `source_url`) **value-for-value**. Anchored to `backend/evals/fixtures/*` + `backend/pipeline/fixtures/*`.

```
ReelData            ← japan_demo_reels.json / mini_reels.json
  reel_url, short_code?, caption, location_name?, capture_status, transcript?

PlaceResult         ← expected_places.json / mini_places.json   (eval reads name, lat, lng, evidence_quote, source_url)
  name, category, lat?(±90), lng?(±180), confidence(0..1), evidence_quote,
  source_type(enum, default reel_extracted), source_url?, city_or_region_guess?, formatted_address?
ExtractionResult    = {places: list[PlaceResult]}               (Step 5 extractor output_type)
CanonicalPlace(PlaceResult) + times_referenced=1                (dedup boundary; Step 6 fills the flywheel)

ItineraryOutput     ← the pipeline's current itinerary dict      (eval reads days[].place_names, source_places, source)
  title, source, source_places: [str], days: [ItineraryDay]
ItineraryDay
  day_number, date, place_names: [str]

UserPreferences     ← japan_second_trip.json user_profile + legacy  (contract only; wired at Step 9)
  start_date, end_date, budget_style(enum), pace?, food_preference[], transport_tolerance?, avoid[], free_text, origin_city?
```

The eval boundary stays dicts — `PipelineOutput.reels/places/itinerary` are `model_dump()` outputs. The eval, checks, and metrics do not change.

---

## File Structure

```
backend/models/
├── reel.py        # FILL stub — ReelData
├── place.py       # FILL stub — PlaceResult, ExtractionResult, CanonicalPlace, PlaceSourceType
├── trip.py        # FILL stub — ItineraryDay, ItineraryOutput
├── prefs.py       # FILL stub — UserPreferences
├── test_reel.py   # NEW
├── test_place.py  # NEW — validation: bounds, enum, required, extra-ignore
├── test_trip.py   # NEW
└── test_prefs.py  # NEW

backend/pipeline/
├── offline_harness.py       # MODIFY — typed stages; serialize to eval dicts at PipelineOutput
└── test_offline_harness.py  # MODIFY — fixtures validate into models; output still eval-shaped

# DEFERRED stubs (untouched this step):
#   models/enrichment.py (WeatherReport/RestaurantSuggestion/TransportLeg) → Phase-4 steps
#   models/summary.py    (OrchestratorSummary)                              → Phase-5 step
```

`backend/models/__init__.py` — create if absent (package marker), like `pipeline/`.

No changes to `evals/*` (the eval reads dicts and is unaffected), `baseline.py`, `output.py`, `sources.py`, `timing.py`, `tracing.py`, fixtures, or `pyproject.toml`.

---

## Active vs Deferred

| Concern | Step 4 (active) | Deferred to |
|---|---|---|
| Reel / Place / Canonical / Itinerary / Prefs contracts | typed Pydantic, validated | — |
| `ExtractionResult` SDK output_type wrapper | defined now | consumed by the real extractor → **Step 5** |
| Typed stage boundaries in the offline harness | refactored | real agents behind them → **Steps 5–7** |
| Drop-invalid / confidence-floor extraction logic | — (fixtures are curated + valid) | real extractor → **Step 5** |
| `CanonicalPlace.times_referenced` flywheel increment | field defined (=1) | semantic dedup increments it → **Step 6** |
| `UserPreferences` wired into the pipeline | contract defined only | preference context + mem0 → **Step 9** |
| Enrichment models (weather/restaurant/transport/hotel) | — | their Phase-4 steps |
| `OrchestratorSummary` | — | Phase-5 step |
| `backend-types.ts` TS mirror | — | frontend |

---

### Task 1: ReelData model

**Files:**
- Modify: `backend/models/reel.py` (currently a 1-line stub)
- Create: `backend/models/__init__.py` (if absent — empty package marker)
- Test: `backend/models/test_reel.py`

**Interfaces:**
- Produces: `ReelData` (Pydantic `BaseModel`, `model_config = ConfigDict(extra="ignore")`). Fields: `reel_url: str`, `short_code: str | None = None`, `caption: str = ""`, `location_name: str | None = None`, `capture_status: str = "NEEDS_CAPTURE"`, `transcript: str | None = None`.

- [ ] **Step 1: Create the package marker (if absent)**

If `backend/models/__init__.py` does not exist, create it:

```python
"""Astrail typed pipeline contracts (Pydantic v2). Step 4 fills the core spine."""
```

- [ ] **Step 2: Write the failing test**

Create `backend/models/test_reel.py`:

```python
"""ReelData contract — validates the recorded reel fixtures."""
import json
from pathlib import Path

from models.reel import ReelData

EVAL_FIX = Path(__file__).parents[1] / "evals" / "fixtures" / "japan_demo_reels.json"
MINI_FIX = Path(__file__).parents[1] / "pipeline" / "fixtures" / "mini_reels.json"


def test_validates_the_japan_demo_reels_fixture():
    reels = json.loads(EVAL_FIX.read_text(encoding="utf-8"))["reels"]
    models = [ReelData.model_validate(r) for r in reels]
    assert len(models) == 4
    assert models[0].reel_url.startswith("https://www.instagram.com/reel/")
    assert models[0].caption  # non-empty


def test_validates_the_mini_reels_fixture():
    reels = json.loads(MINI_FIX.read_text(encoding="utf-8"))["reels"]
    models = [ReelData.model_validate(r) for r in reels]
    assert [m.short_code for m in models] == ["MINI_AAA", "MINI_BBB"]


def test_defaults_and_extra_ignored():
    rd = ReelData.model_validate({"reel_url": "x", "unexpected_field": 1})
    assert rd.caption == ""
    assert rd.location_name is None
    assert rd.capture_status == "NEEDS_CAPTURE"
    assert not hasattr(rd, "unexpected_field")  # extra="ignore"
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && uv run pytest models/test_reel.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'models.reel'` (the stub has no `ReelData`).

- [ ] **Step 4: Write the model**

Replace `backend/models/reel.py` (the `# ReelData` stub) with:

```python
"""ReelData — the scrape-stage contract (Phase 1 output).

Matches the recorded reel fixtures (reel_url + caption + location_name).
`extra="ignore"` tolerates wider Apify payloads (Step 5) without re-declaring
every field. The optional `transcript` is the opt-in caption-thin fallback.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ReelData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reel_url: str
    short_code: str | None = None
    caption: str = ""
    location_name: str | None = None
    capture_status: str = "NEEDS_CAPTURE"
    transcript: str | None = None
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest models/test_reel.py -v`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/models/__init__.py backend/models/reel.py backend/models/test_reel.py
git commit -m "feat(models): ReelData scrape-stage contract (step 4: specialist agent split)"
```

---

### Task 2: PlaceResult / ExtractionResult / CanonicalPlace models

**Files:**
- Modify: `backend/models/place.py` (1-line stub)
- Test: `backend/models/test_place.py`

**Interfaces:**
- Produces:
  - `PlaceSourceType = Literal["reel_extracted", "user_requested", "agent_suggested"]`
  - `PlaceResult` (`extra="ignore"`): `name: str`, `category: str`, `lat: float | None = Field(None, ge=-90, le=90)`, `lng: float | None = Field(None, ge=-180, le=180)`, `confidence: float = Field(ge=0, le=1)`, `evidence_quote: str`, `source_type: PlaceSourceType = "reel_extracted"`, `source_url: str | None = None`, `city_or_region_guess: str | None = None`, `formatted_address: str | None = None`
  - `ExtractionResult` = `{places: list[PlaceResult]}`
  - `CanonicalPlace(PlaceResult)` + `times_referenced: int = 1`

- [ ] **Step 1: Write the failing test**

Create `backend/models/test_place.py`:

```python
"""PlaceResult contract — validation + fixture round-trip."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.place import CanonicalPlace, ExtractionResult, PlaceResult

EXPECTED = Path(__file__).parents[1] / "evals" / "fixtures" / "expected_places.json"
MINI = Path(__file__).parents[1] / "pipeline" / "fixtures" / "mini_places.json"


def test_validates_expected_places_fixture():
    places = json.loads(EXPECTED.read_text(encoding="utf-8"))["places"]
    models = [PlaceResult.model_validate(p) for p in places]
    assert len(models) == 8
    assert models[0].name == "Tokyo Dream Park"
    assert models[0].source_type == "reel_extracted"
    # model_dump preserves the keys the eval reads
    d = models[0].model_dump()
    assert {"name", "lat", "lng", "evidence_quote", "source_url"} <= set(d)


def test_validates_minimal_place_fixture():
    # mini_places.json omits city/formatted/source_type — optional fields + default fill in
    places = json.loads(MINI.read_text(encoding="utf-8"))["places"]
    models = [PlaceResult.model_validate(p) for p in places]
    assert [m.name for m in models] == ["Cafe Alpha", "Beta Ramen"]
    assert models[0].source_type == "reel_extracted"  # default
    assert models[0].city_or_region_guess is None


def test_lat_lng_bounds_reject_hallucinated_coords():
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x", lat=200.0)
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x", lng=-999.0)


def test_confidence_bounds_and_source_type_enum():
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=1.5, evidence_quote="x")
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x",
                    source_type="from_thin_air")


def test_required_fields():
    with pytest.raises(ValidationError):
        PlaceResult(category="other", confidence=0.5, evidence_quote="x")  # missing name


def test_extraction_result_wraps_places():
    er = ExtractionResult(places=[PlaceResult(name="A", category="other",
                                              confidence=0.9, evidence_quote="A")])
    assert er.places[0].name == "A"


def test_canonical_place_adds_times_referenced():
    cp = CanonicalPlace(name="A", category="other", confidence=0.9, evidence_quote="A")
    assert cp.times_referenced == 1
    assert "times_referenced" in cp.model_dump()


def test_round_trip_preserves_eval_read_values():
    # model_validate + model_dump must preserve every value the eval reads, for EVERY
    # fixture place (review finding, Codex P3) — this is the parity-anchor guarantee.
    places = json.loads(EXPECTED.read_text(encoding="utf-8"))["places"]
    for original in places:
        dumped = PlaceResult.model_validate(original).model_dump()
        for key in ("name", "lat", "lng", "evidence_quote", "source_url"):
            assert dumped.get(key) == original.get(key), (original["name"], key)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest models/test_place.py -v`
Expected: FAIL — `ImportError: cannot import name 'PlaceResult' from 'models.place'`.

- [ ] **Step 3: Write the models**

Replace `backend/models/place.py` (the stub) with:

```python
"""Place contracts — extract → dedup boundary.

PlaceResult is the extractor output (Phase 2). Field names match the eval
fixtures (`evidence_quote`, `source_type`) so model_dump() round-trips to the
dict shape the #16 eval consumes. lat/lng/confidence bounds reproduce the
legacy validators (CLAUDE.md hard-won lessons). `extra="ignore"` tolerates
wider payloads. ExtractionResult is the SDK output_type wrapper (Step 5).
CanonicalPlace is the dedup output; `times_referenced` is the data-flywheel
counter incremented by semantic dedup (Step 6).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PlaceSourceType = Literal["reel_extracted", "user_requested", "agent_suggested"]


class PlaceResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    category: str = Field(description="restaurant | hotel | attraction | transport | other")
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_quote: str
    source_type: PlaceSourceType = "reel_extracted"
    source_url: str | None = None
    city_or_region_guess: str | None = None
    formatted_address: str | None = None


class ExtractionResult(BaseModel):
    """Single-model SDK output_type wrapper for the extractor agent (Step 5)."""

    places: list[PlaceResult]


class CanonicalPlace(PlaceResult):
    """A deduplicated place. `times_referenced` is the data-flywheel counter
    (Step 6's semantic+geo dedup increments it on a merge)."""

    times_referenced: int = 1
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest models/test_place.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/models/place.py backend/models/test_place.py
git commit -m "feat(models): PlaceResult/ExtractionResult/CanonicalPlace contracts (step 4: specialist agent split)"
```

---

### Task 3: ItineraryOutput / ItineraryDay models

**Files:**
- Modify: `backend/models/trip.py` (1-line stub)
- Test: `backend/models/test_trip.py`

**Interfaces:**
- Produces:
  - `ItineraryDay`: `day_number: int`, `date: str`, `place_names: list[str]`
  - `ItineraryOutput`: `title: str`, `source: str`, `source_places: list[str]`, `days: list[ItineraryDay]`

> Note: this is the pipeline's CURRENT itinerary shape (simple day/place_names), which the eval consumes — NOT the legacy narration-rich shape (activities/narration/hotel). The richer narrator output is Step 7's concern; freezing the richer shape now would be speculative.

- [ ] **Step 1: Write the failing test**

Create `backend/models/test_trip.py`:

```python
"""ItineraryOutput contract — matches the dict shape the eval consumes."""
from models.trip import ItineraryDay, ItineraryOutput


def _itin() -> ItineraryOutput:
    return ItineraryOutput(
        title="Tokyo",
        source="pipeline",
        source_places=["A", "B"],
        days=[ItineraryDay(day_number=1, date="2026-06-10", place_names=["A"]),
              ItineraryDay(day_number=2, date="2026-06-11", place_names=["B"])],
    )


def test_dumps_to_eval_itinerary_shape():
    d = _itin().model_dump()
    assert d["source"] == "pipeline"
    assert d["source_places"] == ["A", "B"]
    assert d["days"][0] == {"day_number": 1, "date": "2026-06-10", "place_names": ["A"]}


def test_day_requires_its_fields():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ItineraryDay(date="2026-06-10", place_names=[])  # missing day_number
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest models/test_trip.py -v`
Expected: FAIL — `ImportError: cannot import name 'ItineraryOutput' from 'models.trip'`.

- [ ] **Step 3: Write the models**

Replace `backend/models/trip.py` (the stub) with:

```python
"""Itinerary contracts — narrate-stage output (Phase 5).

Matches the pipeline's current itinerary dict shape (the #16 eval reads
days[].place_names, source_places, source). The narration-rich day shape
(activities/narration/hotel) belongs to the real narrator (Step 7); typing it
now would be speculative.
"""
from __future__ import annotations

from pydantic import BaseModel


class ItineraryDay(BaseModel):
    day_number: int
    date: str
    place_names: list[str]


class ItineraryOutput(BaseModel):
    title: str
    source: str
    source_places: list[str]
    days: list[ItineraryDay]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest models/test_trip.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/models/trip.py backend/models/test_trip.py
git commit -m "feat(models): ItineraryOutput/ItineraryDay narrate-stage contract (step 4: specialist agent split)"
```

---

### Task 4: UserPreferences model

**Files:**
- Modify: `backend/models/prefs.py` (1-line stub)
- Test: `backend/models/test_prefs.py`

**Interfaces:**
- Produces: `UserPreferences` (`extra="ignore"`): `start_date: str`, `end_date: str`, `budget_style: Literal["budget","mid_range","luxury"] = "mid_range"`, `pace: Literal["relaxed","balanced","packed"] | None = None`, `food_preference: list[str] = []`, `transport_tolerance: str | None = None`, `avoid: list[str] = []`, `free_text: str = ""`, `origin_city: str | None = None`.

> Contract-only this step (the offline pipeline has no preference flow yet). Wired into the pipeline at Step 9 (mem0 preference context). Shape merges the legacy `UserPreferences` (start/end_date, budget, free_text, origin) with the `japan_second_trip` case's `user_profile` (budget_style, pace, food_preference, transport_tolerance, avoid).

- [ ] **Step 1: Write the failing test**

Create `backend/models/test_prefs.py`:

```python
"""UserPreferences contract — covers the japan_second_trip user_profile fixture."""
import json
from pathlib import Path

from models.prefs import UserPreferences

CASE = Path(__file__).parents[1] / "evals" / "cases" / "japan_second_trip.json"


def test_validates_second_trip_user_profile():
    profile = json.loads(CASE.read_text(encoding="utf-8"))["user_profile"]
    prefs = UserPreferences.model_validate({"start_date": "2026-06-10",
                                            "end_date": "2026-06-12", **profile})
    assert prefs.budget_style == "mid_range"
    assert prefs.pace == "relaxed"
    assert prefs.food_preference == ["ramen", "cafes"]
    assert prefs.avoid == ["theme_parks"]


def test_defaults():
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-12")
    assert prefs.budget_style == "mid_range"
    assert prefs.pace is None
    assert prefs.food_preference == []
    assert prefs.free_text == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest models/test_prefs.py -v`
Expected: FAIL — `ImportError: cannot import name 'UserPreferences' from 'models.prefs'`.

- [ ] **Step 3: Write the model**

Replace `backend/models/prefs.py` (the stub) with:

```python
"""UserPreferences — the preference-context contract (Phase 3).

Contract-only at Step 4 (the offline pipeline has no preference flow yet); wired
in at Step 9 (mem0). Merges the legacy prefs (dates, budget, free_text, origin)
with the returning-user dimensions the japan_second_trip case asserts
(budget_style, pace, food_preference, avoid). `extra="ignore"` tolerates
future memory-derived fields.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class UserPreferences(BaseModel):
    model_config = ConfigDict(extra="ignore")

    start_date: str
    end_date: str
    budget_style: Literal["budget", "mid_range", "luxury"] = "mid_range"
    pace: Literal["relaxed", "balanced", "packed"] | None = None
    food_preference: list[str] = Field(default_factory=list)
    transport_tolerance: str | None = None
    avoid: list[str] = Field(default_factory=list)
    free_text: str = ""
    origin_city: str | None = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest models/test_prefs.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/models/prefs.py backend/models/test_prefs.py
git commit -m "feat(models): UserPreferences preference-context contract (step 4: specialist agent split)"
```

---

### Task 5: Wire typed contracts into the offline harness

**Files:**
- Modify: `backend/pipeline/offline_harness.py`
- Test: `backend/pipeline/test_offline_harness.py`

**Interfaces:**
- Consumes: `ReelData` (T1), `PlaceResult`/`CanonicalPlace` (T2), `ItineraryOutput`/`ItineraryDay` (T3).
- Produces: `run_offline_pipeline(...)` unchanged signature, but stages now go through typed models; `dedup_passthrough(places: list[PlaceResult]) -> list[CanonicalPlace]`; a new `assemble_itinerary(places, dates) -> ItineraryOutput`. `PipelineOutput.reels/places/itinerary` are `model_dump()` dicts (eval boundary unchanged).

- [ ] **Step 1: Update the broken unit tests + write the new ones**

The typed refactor changes `dedup_passthrough`'s signature and **renames** `assemble_days_naive` → `assemble_itinerary`. Three existing tests call those with raw dicts and **must be updated** — they are NOT kept as-is (review finding, P1 — confirmed by Codex; `pytest pipeline/test_offline_harness.py` would otherwise fail).

In `backend/pipeline/test_offline_harness.py`:

(1) Update the import line (rename `assemble_days_naive` → `assemble_itinerary`; add the models):

```python
from pipeline.offline_harness import (
    assemble_itinerary,
    dedup_passthrough,
    run_offline_pipeline,
)
from models.place import CanonicalPlace, PlaceResult
```

(2) Replace the three dict-based tests (`test_dedup_passthrough_is_identity`, `test_assemble_days_naive_chunks_in_input_order`, `test_assemble_days_naive_rejects_zero_dates`) with their typed equivalents:

```python
def test_dedup_passthrough_wraps_as_canonical():
    places = [PlaceResult(name="A", category="other", confidence=0.9, evidence_quote="A"),
              PlaceResult(name="B", category="other", confidence=0.8, evidence_quote="B")]
    out = dedup_passthrough(places)
    assert [p.name for p in out] == ["A", "B"]
    assert all(isinstance(p, CanonicalPlace) for p in out)
    assert all(p.times_referenced == 1 for p in out)


def test_assemble_itinerary_chunks_in_input_order():
    places = [CanonicalPlace(name=n, category="other", confidence=0.9, evidence_quote=n)
              for n in ("A", "B", "C")]
    itin = assemble_itinerary(places, ["2026-06-10", "2026-06-11"])
    assert [d.day_number for d in itin.days] == [1, 2]
    assert itin.days[0].place_names == ["A", "B"]  # extra goes to the earlier day
    assert itin.days[1].place_names == ["C"]


def test_assemble_itinerary_rejects_zero_dates():
    with pytest.raises(ValueError):
        assemble_itinerary([], [])
```

(3) Add the new end-to-end typed test:

```python
def test_pipeline_places_validate_and_carry_canonical_fields():
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
    )
    # places are serialized CanonicalPlace dicts — carry the flywheel counter + default source_type
    assert all("times_referenced" in p for p in out.places)
    assert all(p["source_type"] == "reel_extracted" for p in out.places)
    # the keys the eval reads are still present + correct
    assert [p["name"] for p in out.places] == ["Cafe Alpha", "Beta Ramen"]
    assert all({"name", "lat", "lng", "evidence_quote", "source_url"} <= set(p) for p in out.places)
    # reels round-trip through ReelData
    assert [r["short_code"] for r in out.reels] == ["MINI_AAA", "MINI_BBB"]
    # itinerary unchanged shape
    assert out.itinerary["source"] == "pipeline"
    assert out.itinerary["days"][0]["place_names"] == ["Cafe Alpha"]
```

The timing tests (`test_run_offline_pipeline_records_deterministic_timings`, `..._default_clock_records_floats`) and `test_run_offline_pipeline_returns_eval_shaped_output` / `..._rejects_reversed_dates` are kept — they assert names/structure/timings, which the typed refactor preserves.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: FAIL — `ImportError: cannot import name 'assemble_itinerary'` (the harness still has `assemble_days_naive` + dict-based `dedup_passthrough`).

- [ ] **Step 3: Refactor the harness to typed stages**

In `backend/pipeline/offline_harness.py`: add imports and rewrite the stages. New imports:

```python
from models.place import CanonicalPlace, PlaceResult
from models.reel import ReelData
from models.trip import ItineraryDay, ItineraryOutput
```

Replace `dedup_passthrough` and `assemble_days_naive` and the body of `run_offline_pipeline`:

```python
def dedup_passthrough(places: list[PlaceResult]) -> list[CanonicalPlace]:
    """Identity dedup (Step 2/4 placeholder): wrap each PlaceResult as a
    CanonicalPlace (times_referenced=1). Step 6 replaces this with two-gate
    semantic+geo dedup that merges duplicates and increments the counter.
    Returns a NEW list — never mutate the caller's (immutability).
    """
    return [CanonicalPlace.model_validate(p.model_dump()) for p in places]


def assemble_itinerary(places: list[CanonicalPlace], dates: list[str]) -> ItineraryOutput:
    """Split places in input order into len(dates) near-even contiguous chunks.

    Pipeline-owned naive narrate (placeholder). Step 7 replaces it with
    route-aware feasibility ordering. Kept separate from evals/baseline.py.
    """
    n, d = len(places), len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    base, extra = divmod(n, d)
    days: list[ItineraryDay] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        days.append(ItineraryDay(day_number=i + 1, date=day_date,
                                 place_names=[p.name for p in group]))
    return ItineraryOutput(
        title="Tokyo (offline pipeline skeleton)",
        source="pipeline",
        source_places=[p.name for p in places],
        days=days,
    )


def run_offline_pipeline(
    reels_path: Path,
    places_path: Path,
    start_date: str,
    end_date: str,
    *,
    live_reels: Source | None = None,
    live_places: Source | None = None,
    clock: Clock = time.perf_counter,
) -> PipelineOutput:
    """Run the fixture-backed pipeline end-to-end, offline, deterministically.

    Stages now go through typed contracts (ReelData, PlaceResult, CanonicalPlace,
    ItineraryOutput); the eval boundary stays dicts via model_dump(). `clock` is
    injectable for deterministic timing tests.
    """
    sw = Stopwatch(clock=clock)
    t0 = clock()
    with sw.stage("scrape"):
        reels = [ReelData.model_validate(r)
                 for r in resolve(live_reels, FixtureReelSource(reels_path))]
    with sw.stage("extract"):
        extracted = [PlaceResult.model_validate(p)
                     for p in resolve(live_places, FixturePlaceSource(places_path))]
    with sw.stage("dedup"):
        canonical = dedup_passthrough(extracted)
    with sw.stage("narrate"):
        dates = _date_range(start_date, end_date)
        itinerary = assemble_itinerary(canonical, dates)
    sw.mark_total(t0)
    return PipelineOutput(
        reels=[r.model_dump() for r in reels],
        places=[p.model_dump() for p in canonical],
        itinerary=itinerary.model_dump(),
        timings=sw.timings,
    )
```

> The deterministic-timing test still holds: exactly 10 clock reads (t0 + 4 stages × 2 + mark_total). `model_validate`/`model_dump` and `_date_range` read no clock.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: PASS (existing + 1 new).

- [ ] **Step 5: Full verification — the eval must stay green**

Run:
```bash
cd backend
uv run pytest models/ pipeline/ evals/ -q
uv run python -m evals.run_eval
uv run python -m evals.run_eval --subject pipeline
```
Expected:
- all tests pass, no API key
- both `run_eval` runs end `OVERALL: PASS`, exit 0
- the Step 2 parity anchor still passes (typed models preserve name/lat/lng/evidence_quote/source_url, so the metrics are identical)

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/offline_harness.py backend/pipeline/test_offline_harness.py
git commit -m "feat(pipeline): route offline harness through typed stage contracts (step 4: specialist agent split)"
```

---

## Non-Goals (out of scope for Step 4)

- No real agents, live Apify/OpenAI/Mapbox/mem0/Supabase, no Langfuse.
- No enrichment models (`WeatherReport`, `RestaurantSuggestion`, `TransportLeg`, hotel) — their Phase-4 steps. `OrchestratorSummary` — Phase-5 step.
- No drop-invalid / confidence-floor extraction logic (the real extractor, Step 5). Step 4 fixtures are curated + all-valid.
- No semantic dedup (`times_referenced` is defined =1; Step 6 increments it).
- No wiring of `UserPreferences` into the pipeline (Step 9 / mem0).
- No changes to `evals/*`, `baseline.py`, `output.py`, `sources.py`, `timing.py`, `tracing.py`, fixtures, or `pyproject.toml`.
- No `backend-types.ts` TS mirror (frontend). No new dependencies. No board edits, no PR.

## Acceptance Criteria

- [ ] `backend/models/` has typed Pydantic contracts: `ReelData`, `PlaceResult` + `ExtractionResult` + `CanonicalPlace`, `ItineraryOutput` + `ItineraryDay`, `UserPreferences`.
- [ ] Validation enforced: lat `±90`, lng `±180`, confidence `0..1`, `source_type` enum; required `name`/`category`/`confidence`/`evidence_quote`; `extra="ignore"`.
- [ ] Every recorded fixture validates into its model: `japan_demo_reels.json` + `mini_reels.json` → `ReelData`; `expected_places.json` + `mini_places.json` → `PlaceResult`; `japan_second_trip` `user_profile` → `UserPreferences`.
- [ ] `run_offline_pipeline` routes all stages through the typed models and serializes to eval dicts at `PipelineOutput`.
- [ ] **The #16 eval is unchanged-green:** `uv run python -m evals.run_eval` and `--subject pipeline` both `OVERALL: PASS`; the Step 2 parity anchor still passes.
- [ ] `uv run pytest models/ pipeline/ evals/ -q` all pass with **no API key**.
- [ ] No `legacy/` imports; no new dependencies; `baseline.py` untouched.

## Local Run / Verification Commands

```bash
cd backend
uv run pytest models/ pipeline/ evals/ -q
uv run python -m evals.run_eval
uv run python -m evals.run_eval --subject pipeline
```

## Parallelization (for multi-agent execution)

- **Lane A / B / C / D (parallel, disjoint files):** Task 1 (`reel.py`), Task 2 (`place.py`), Task 3 (`trip.py`), Task 4 (`prefs.py`) — independent new models in `backend/models/`.
- Then **Task 5** (`pipeline/offline_harness.py`) — needs Tasks 1–3 (reel/place/trip). Task 4 (prefs) is independent of Task 5.
- The four model tasks write disjoint files; run them in parallel (no git in the sub-agents; serialize commits). Task 5 last.

## Risks / Rollback

- **`model_dump()` adds default keys to the place dicts** (e.g. `source_type`, `times_referenced`, `city_or_region_guess=None`). The eval reads only `name/lat/lng/evidence_quote/source_url`, so checks + metrics are unchanged; the regression guard is the parity anchor (metric equality), NOT byte-identical dicts. The new harness test asserts the eval-read keys are present + correct.
- **A fixture failing validation** would crash the harness. Mitigation: Tasks 1–4 validate every fixture into its model before Task 5 wires them in; if a fixture is malformed, that surfaces in the model test, not at eval time.
- **Field-name drift** (`evidence_quote` vs legacy `evidence_caption_quote`): the contract is anchored to the fixtures/eval, not legacy. Tests validate the real fixtures, so drift fails loudly.
- **Rollback:** every task is an isolated commit. Tasks 1–4 add unreferenced models (no effect on the pipeline). Reverting Task 5 restores the dict-based harness exactly.

## Self-Review Notes

- **Spec coverage:** "freeze Pydantic I/O between stages" → Tasks 1–4 (core spine); "specialist split / typed stage boundaries" → Task 5; "source_type + evidence fields (PRD §11/§12)" → Task 2; "feasible-first / defer enrichment" → Active-vs-Deferred table + Non-Goals; "eval stays green" → Task 5 Step 5 + parity anchor.
- **Type consistency:** `PlaceResult`/`CanonicalPlace`/`ExtractionResult` names identical across Task 2 def, Task 5 usage, tests. `ItineraryOutput`/`ItineraryDay` identical Task 3 ↔ Task 5. `dedup_passthrough(list[PlaceResult]) -> list[CanonicalPlace]` and `assemble_itinerary(list[CanonicalPlace], dates) -> ItineraryOutput` match between Task 5 def and the harness body.
- **Placeholder scan:** every code step has complete code; no TBD.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 1 P1 (broken existing tests) folded; Step-0 scope accepted (include prefs) |
| Outside Voice | Codex (`codex exec`, read-only, high effort) | Independent plan review | 1 | issues_found | 1 P1 (confirmed) + 2 P3 — all folded |

**CODEX:** confirmed the P1 — Task 5 renames `assemble_days_naive` → `assemble_itinerary` and retypes `dedup_passthrough`, which breaks three existing dict-based unit tests; the plan now updates them to typed signatures. Verified: every fixture validates into its model (required `name/category/confidence/evidence_quote` present; `source_type` all `reel_extracted`; `mini_places`' missing fields are optional/defaulted), the eval-read keys survive `model_dump()` value-for-value (`checks.py` + `metrics.py` + the parity anchor hold), the deterministic timing (`total=9`) is unaffected (validate/dump add no clock reads), `CanonicalPlace` subclassing has no validation surprise, and the `source_type` enum matches the fixtures. Folded P3s: corrected "exact dict" → "eval-compatible superset" wording, and added an all-fixture round-trip value-preservation test.

**CROSS-MODEL:** no tension — planner review + Codex agree; the one P1 was found by both reviewers.

**Step-0 scope:** complexity gate tripped on file count (~11) but accepted as-is (feasible-first: 7 small Pydantic models + tests; enrichment/summary/drop-invalid/TS-mirror all deferred). `UserPreferences` included now per roadmap §7 (cheap; validates the `japan_second_trip` fixture).

**Failure modes:** a malformed fixture → `model_validate` raises, surfacing in the Task 1–4 model tests *before* Task 5 wires them in. No drop-invalid yet (Step 5). No silent-failure gaps.

**Parallelization:** Lanes A/B/C/D = the four model files (`reel.py`/`place.py`/`trip.py`/`prefs.py`, parallel, disjoint), then Task 5 (`offline_harness.py`, needs reel/place/trip).

**VERDICT:** ENG REVIEW CLEARED — plan is final + ready to implement (5 tasks, TDD, offline, no new deps). Ready to hand to Codex for verification, then implement.

NO UNRESOLVED DECISIONS
