# Step 2 — Offline Agent Pipeline Harness + Fixture/Cache Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully offline, fixture-backed pipeline skeleton that produces an itinerary in the exact shape `backend/evals/` consumes, so the issue #16 eval can score *real pipeline output* — not just the frozen legacy baseline.

**Architecture:** Add a `backend/pipeline/` package with three small modules — a minimal output contract (`output.py`), a fixture/cache source layer that cleanly replaces legacy's `USE_CACHE` env-var hack (`sources.py`), and an offline pipeline skeleton that chains fixture-backed stages (`offline_harness.py`). Then make the eval's "subject under test" pluggable via a new `--subject baseline|pipeline` runner flag. Default subject stays `baseline`, so the existing #16 gate is unchanged; `pipeline` runs the offline harness from the same recorded case fixtures. On the Japan demo set the two subjects produce identical metrics today — that equality is the regression anchor that proves the seam works before any real agent is built.

**Tech Stack:** Python ≥3.14, stdlib only (`json`, `dataclasses`, `datetime`, `pathlib`, `typing`), `uv` for running, `pytest` for tests. No new dependencies. No live OpenAI / Apify / Mapbox / mem0 / Supabase.

## Global Constraints

- **Offline only.** Zero live calls to OpenAI, Apify, Mapbox, mem0, or Supabase on the default path. Unit suite must pass with **no API key**. (CLAUDE.md guardrails; #16 spec §11.)
- **No agent rewrites.** Extractor/enricher/narrator/restaurant/hotel/transport stay empty stubs; Step 2 builds plumbing + a fixture-backed skeleton only. Real stages land in Steps 4–7.
- **No `legacy/` imports.** Reproduce behaviour; never `import` from `legacy/tripcanvas-hackathon/`. (CLAUDE.md guardrail #9.)
- **Do not modify `backend/evals/baseline.py`, `metrics.py`, `util.py`.** They are the frozen #16 legacy bar + measuring helpers. Step 2 edits exactly these eval files: `run_eval.py` (pluggable subject), `checks.py` (one added contractual check — `day_places_traceable`, closes a gate hole found in review), `cases/*.json` (wire that check in), and the matching test files. `baseline.py` stays frozen.
- **Keep #16 green.** `cd backend && uv run python -m evals.run_eval` (default subject) must still print `OVERALL: PASS`, and the existing 33 tests must still pass, unchanged.
- **Immutability.** New value objects are `@dataclass(frozen=True)`; never mutate the lists/dicts a stage receives — return new ones. (User coding-style rule.)
- **No Supabase / auth / SSE / durable jobs / frontend / board edits** in this step.
- **Python style:** PEP 8, type annotations on every signature, files small and focused (<400 lines; these are all <100). (User python coding-style rule.)

---

## Output Contract — the shape `backend/evals/` consumes (read this first)

`backend/evals/run_eval.py::build_ctx` produces a `ctx` dict that `checks.py` and `metrics.py` read. Step 2's pipeline output **must** be convertible into exactly this shape. Verified against the current harness:

```python
ctx = {
    "places":   list[dict],   # each: name, lat, lng, evidence_quote, source_url, confidence, category, ...
    "reels":    list[dict],   # each: reel_url, caption, location_name, short_code, capture_status
    "itinerary": {            # the SUBJECT under test
        "title":          str,
        "source":         str,                  # "baseline" | "pipeline"
        "source_places":  list[str],            # place names traceable to extraction
        "days": [ {"day_number": int, "date": "YYYY-MM-DD", "place_names": list[str]} ],
    },
    "start_date":     "YYYY-MM-DD",
    "end_date":       "YYYY-MM-DD",
    "expected_unique": int,
}
```

Which fields each scorer reads (so the pipeline output cannot drift):
- `check_coords_present` / `check_japan_bbox` → `places[i]["lat"|"lng"|"name"]`
- `check_day_count` → `len(itinerary["days"])` vs `start_date..end_date`
- `check_source_places_parity` → `set(itinerary["source_places"])` ⊆ `{p["name"]}`
- `check_day_places_traceable` **(NEW — added in Task 4)** → every `itinerary["days"][k]["place_names"]` member ∈ `source_places`. Closes the gate hole: today `source_places` is checked but day-level names are not, and `mean_intra_day_travel_m` silently skips unknown day names — so a fabricated day place would pass every gate.
- `check_evidence_verbatim` / `evidence_coverage` → `places[i]["evidence_quote"]` ⊆ `reels` corpus (`caption + " " + location_name`)
- `mean_intra_day_travel_m` → `itinerary["days"][k]["place_names"]` + `places[i]["lat"|"lng"]`
- `hallucination_rate` / `weak_source_url_rate` → `places[i]["source_url"|"lat"|"lng"]`
- `dedup_error` → `len(places)` vs `expected_unique`

**Implication:** the pipeline reuses the recorded place-dict shape verbatim (same keys as `fixtures/expected_places.json`, which already uses `evidence_quote` / `source_url`). No field renaming needed.

---

## File Structure

```
backend/pipeline/                  # package already exists as stubs (runner.py/cache.py/dedup.py)
├── __init__.py            # NEW — package marker added BESIDE the existing stubs (not a new package)
├── output.py              # NEW — PipelineOutput frozen dataclass (reels, places, itinerary)
├── sources.py             # NEW — fixture/cache source layer (clean USE_CACHE) + resolve() + record_fixture()
├── offline_harness.py     # NEW — run_offline_pipeline(): fixture-backed scrape→extract→dedup→narrate
├── fixtures/
│   ├── mini_reels.json    # NEW — 2-reel self-contained fixture (pipeline unit tests only)
│   └── mini_places.json   # NEW — 2-place self-contained fixture (pipeline unit tests only)
├── test_output.py         # NEW — output contract: shape + frozen immutability
├── test_sources.py        # NEW — fixture load, fallback ladder, record round-trip, missing + bad-shape errors
└── test_offline_harness.py# NEW — skeleton produces eval-shaped output on mini fixtures

backend/evals/
├── checks.py                     # MODIFY — add check_day_places_traceable + register it (close gate hole)
├── cases/japan_first_trip.json   # MODIFY — add "day_places_traceable" to active_contractual_checks
├── cases/japan_second_trip.json  # MODIFY — add "day_places_traceable" to active_contractual_checks
├── test_checks.py                # MODIFY — test new check (pass + fabricated-day-place fail)
├── run_eval.py                   # MODIFY — --subject baseline|pipeline; build_ctx branch; subject-aware report label
└── test_run_eval.py              # MODIFY — pipeline-subject parity (BOTH cases) + unknown-subject guard
```

Existing stubs `pipeline/runner.py` (4-phase parallel orchestration), `pipeline/cache.py` (Supabase cache), `pipeline/dedup.py` (semantic dedup) are **left untouched** — they belong to later steps (full orchestration / Supabase / Step 6). Step 2 only adds the `__init__.py` marker + new modules beside them; it does **not** create the package from scratch and does **not** claim `runner.py`.

**Test placement** follows the #16 precedent: tests live next to the code (`pipeline/test_*.py`), exactly as `evals/test_*.py` does. Run them with explicit paths (`uv run pytest evals/ pipeline/`), since the repo has no `[tool.pytest.ini_options]` testpaths.

---

## Active in Step 2 vs Deferred

| Concern | Step 2 (active) | Deferred to |
|---|---|---|
| Output contract (eval shape) | `PipelineOutput` (reels, places, itinerary) — minimal | Rich typed stage contracts (PlaceResult/EnrichedPlace/ItineraryOutput) → **Step 4** |
| Scrape stage | `FixtureReelSource` (recorded ReelData) | Live Apify direct HTTP → **Step 5** |
| Extract stage | `FixturePlaceSource` (recorded places) | `place_extractor` LLM agent → **Step 5/6** |
| Dedup stage | `dedup_passthrough` (identity) | Two-gate semantic+geo dedup → **Step 6** |
| Narrate stage | `assemble_days_naive` (input-order chunks) | Route-aware feasibility ordering → **Step 7** |
| Fixture/cache fallback | `resolve(primary, fixture)` seam + `record_fixture()` | Live `primary` source wired in (+ logged, narrowed error handling) → **Step 5** |
| Eval gate hardening | `check_day_places_traceable` closes the day-place hole for all future subjects | — (instrument hardening, done now) |
| Eval integration | `--subject pipeline` scores offline output | Live-regeneration `--live` flag → later |

---

### Task 1: Pipeline package + minimal output contract

**Files:**
- Create: `backend/pipeline/__init__.py`
- Create: `backend/pipeline/output.py`
- Test: `backend/pipeline/test_output.py`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces: `PipelineOutput(reels: list[dict], places: list[dict], itinerary: dict)` — a `@dataclass(frozen=True)`. Later tasks construct it; the eval reads `.reels`, `.places`, `.itinerary`.

- [ ] **Step 1: Create the package marker**

Create `backend/pipeline/__init__.py`:

```python
"""Astrail generation pipeline.

Step 2 ships the offline, fixture-backed skeleton (output contract + fixture/cache
sources + a runnable harness the issue #16 eval can score). Real LLM stages
(extractor, enricher, narrator) replace the fixture-backed placeholders in later steps.
Fully offline: no live OpenAI / Apify / Mapbox / mem0 / Supabase on the default path.
"""
```

- [ ] **Step 2: Write the failing test**

Create `backend/pipeline/test_output.py`:

```python
"""Output contract tests — the boundary the offline eval scores."""
import dataclasses

import pytest

from pipeline.output import PipelineOutput


def _sample() -> PipelineOutput:
    return PipelineOutput(
        reels=[{"reel_url": "https://example/reel/AAA", "caption": "x", "location_name": None}],
        places=[{"name": "A", "lat": 35.0, "lng": 139.0,
                 "evidence_quote": "A", "source_url": "https://a.jp", "confidence": 0.9}],
        itinerary={"title": "t", "source": "pipeline", "source_places": ["A"],
                   "days": [{"day_number": 1, "date": "2026-06-10", "place_names": ["A"]}]},
    )


def test_pipeline_output_exposes_reels_places_itinerary():
    out = _sample()
    assert out.reels[0]["reel_url"].endswith("AAA")
    assert out.places[0]["name"] == "A"
    assert out.itinerary["days"][0]["place_names"] == ["A"]


def test_pipeline_output_is_frozen():
    out = _sample()
    with pytest.raises(dataclasses.FrozenInstanceError):
        out.places = []  # type: ignore[misc]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_output.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.output'`.

- [ ] **Step 4: Write minimal implementation**

Create `backend/pipeline/output.py`:

```python
"""Minimal pipeline output contract — the boundary the offline eval scores.

Intentionally small: it mirrors ONLY the shape backend/evals/ consumes
(ctx["reels"] + ctx["places"] + ctx["itinerary"]). The rich, typed stage-to-stage
Pydantic contracts (PlaceResult, EnrichedPlace, ItineraryOutput) are frozen later
in Step 4 (specialist agent contracts) — do NOT grow them here.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PipelineOutput:
    """What one offline pipeline run produces, in the eval's consumption shape.

    Attributes:
        reels: the recorded ReelData the run scraped — each carries reel_url,
            caption, location_name, short_code. (The eval verifies evidence
            quotes against this corpus.)
        places: produced/deduped place dicts — each carries at least name, lat,
            lng, evidence_quote, source_url, confidence (same dict shape as the
            recorded expected_places fixture).
        itinerary: {title, source, source_places: [name],
            days: [{day_number, date, place_names: [name]}]} — the exact shape
            backend/evals consumes as the subject under test.

    Frozen: fields cannot be rebound. Treat the contained lists/dict as
    read-only (immutability by convention) — never mutate in place.
    """

    reels: list[dict]
    places: list[dict]
    itinerary: dict
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_output.py -v`
Expected: PASS (2 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/__init__.py backend/pipeline/output.py backend/pipeline/test_output.py
git commit -m "feat(pipeline): minimal offline output contract (step 2, #16)"
```

---

### Task 2: Fixture/cache source layer (clean `USE_CACHE`)

**Files:**
- Create: `backend/pipeline/sources.py`
- Create: `backend/pipeline/fixtures/mini_reels.json`
- Create: `backend/pipeline/fixtures/mini_places.json`
- Test: `backend/pipeline/test_sources.py`

**Interfaces:**
- Consumes: nothing from earlier tasks (stdlib only).
- Produces:
  - `Source` (Protocol) with `load(self) -> list[dict]`
  - `FixtureReelSource(path: Path)` → `.load()` returns the `reels` array
  - `FixturePlaceSource(path: Path)` → `.load()` returns the `places` array
  - `resolve(primary: Source | None, fixture: Source) -> list[dict]` — fixture-fallback ladder
  - `record_fixture(path: Path, key: str, items: list[dict]) -> None` — write-through capture
  - `FixtureMissing(FileNotFoundError)` — raised on absent fixture

- [ ] **Step 1: Create the self-contained mini fixtures**

Create `backend/pipeline/fixtures/mini_reels.json` (2 reels; evidence quotes are substrings of these captions):

```json
{
  "reels": [
    {
      "reel_url": "https://www.instagram.com/reel/MINI_AAA/",
      "short_code": "MINI_AAA",
      "caption": "Best coffee in Tokyo at Cafe Alpha. 📍 Cafe Alpha",
      "location_name": "Tokyo, Japan",
      "capture_status": "CAPTURED"
    },
    {
      "reel_url": "https://www.instagram.com/reel/MINI_BBB/",
      "short_code": "MINI_BBB",
      "caption": "Late-night ramen at Beta Ramen. 📍 Beta Ramen",
      "location_name": null,
      "capture_status": "CAPTURED"
    }
  ]
}
```

Create `backend/pipeline/fixtures/mini_places.json` (2 distinct-name, Tokyo, all-coords places):

```json
{
  "places": [
    {
      "name": "Cafe Alpha",
      "category": "restaurant",
      "lat": 35.66,
      "lng": 139.70,
      "confidence": 0.9,
      "evidence_quote": "Cafe Alpha",
      "source_url": "https://cafealpha.example.jp"
    },
    {
      "name": "Beta Ramen",
      "category": "restaurant",
      "lat": 35.70,
      "lng": 139.77,
      "confidence": 0.8,
      "evidence_quote": "Beta Ramen",
      "source_url": "https://betaramen.example.jp"
    }
  ]
}
```

> Note: `*.example.jp` source_urls are non-placeholder real-looking hosts (so the mini set isn't accidentally flagged weak); the harness never fetches them.

- [ ] **Step 2: Write the failing test**

Create `backend/pipeline/test_sources.py`:

```python
"""Fixture/cache source tests — the clean replacement for legacy USE_CACHE.

All offline: reads/writes JSON fixtures only, no network, no API key.
"""
import json
from pathlib import Path

import pytest

from pipeline.sources import (
    FixtureMissing,
    FixturePlaceSource,
    FixtureReelSource,
    record_fixture,
    resolve,
)

FIX = Path(__file__).parent / "fixtures"


def test_fixture_reel_source_loads_recorded_reels():
    reels = FixtureReelSource(FIX / "mini_reels.json").load()
    assert [r["short_code"] for r in reels] == ["MINI_AAA", "MINI_BBB"]


def test_fixture_place_source_loads_recorded_places():
    places = FixturePlaceSource(FIX / "mini_places.json").load()
    assert [p["name"] for p in places] == ["Cafe Alpha", "Beta Ramen"]


def test_missing_fixture_raises_clear_error(tmp_path):
    with pytest.raises(FixtureMissing) as exc:
        FixturePlaceSource(tmp_path / "nope.json").load()
    assert "offline fixture not found" in str(exc.value)


def test_bad_shape_fixture_raises_value_error(tmp_path):
    # present but missing its 'places' array — a contract violation, not empty data
    path = tmp_path / "bad.json"
    path.write_text('{"not_places": []}', encoding="utf-8")
    with pytest.raises(ValueError):
        FixturePlaceSource(path).load()


def test_resolve_uses_fixture_when_primary_is_none():
    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(None, fixture) == fixture.load()


def test_resolve_falls_back_when_primary_empty():
    class _Empty:
        def load(self):
            return []

    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(_Empty(), fixture) == fixture.load()


def test_resolve_falls_back_when_primary_raises():
    class _Boom:
        def load(self):
            raise RuntimeError("live source down")

    fixture = FixtureReelSource(FIX / "mini_reels.json")
    assert resolve(_Boom(), fixture) == fixture.load()


def test_resolve_prefers_primary_when_it_returns_data():
    class _Live:
        def load(self):
            return [{"name": "Live Place"}]

    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(_Live(), fixture) == [{"name": "Live Place"}]


def test_record_fixture_round_trips(tmp_path):
    path = tmp_path / "sub" / "out.json"
    items = [{"name": "X"}, {"name": "Y"}]
    record_fixture(path, "places", items)
    assert json.loads(path.read_text(encoding="utf-8")) == {"places": items}
    assert FixturePlaceSource(path).load() == items
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_sources.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.sources'`.

- [ ] **Step 4: Write minimal implementation**

Create `backend/pipeline/sources.py`:

```python
"""Offline reel/place sources — the clean replacement for legacy USE_CACHE.

Legacy `spike_e2e_planner.py` toggled a live scrape vs a committed
`data/places.json` with an env var (`USE_CACHE=true`) and ad-hoc file reads.
This module makes the same idea explicit, typed, and immutable:

  * a Source loads a recorded fixture (offline, deterministic, no network),
  * `resolve()` prefers a primary source (e.g. a future live Apify source,
    Step 5) and falls back to the fixture on absence / empty / error,
  * `record_fixture()` is the write-through capture (clean `_write_cached_places`)
    used only by a one-time live capture — NEVER called on the default offline path.

No live OpenAI / Apify / Mapbox / mem0 / Supabase. Stdlib + typing only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class FixtureMissing(FileNotFoundError):
    """Raised when a required offline fixture file is absent."""


class Source(Protocol):
    def load(self) -> list[dict]: ...


def _read_list(path: Path, key: str) -> list[dict]:
    if not path.exists():
        raise FixtureMissing(
            f"offline fixture not found: {path} "
            f"(expected a JSON object with a '{key}' array)"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get(key)
    if not isinstance(items, list):
        raise ValueError(f"fixture {path} missing '{key}' array")
    return items


@dataclass(frozen=True)
class FixtureReelSource:
    """Loads recorded ReelData (caption + location_name) from a JSON fixture."""

    path: Path

    def load(self) -> list[dict]:
        return _read_list(self.path, "reels")


@dataclass(frozen=True)
class FixturePlaceSource:
    """Loads recorded extracted places from a JSON fixture."""

    path: Path

    def load(self) -> list[dict]:
        return _read_list(self.path, "places")


def resolve(primary: Source | None, fixture: Source) -> list[dict]:
    """Fixture-fallback resolution — the clean USE_CACHE ladder.

    Prefer `primary` (a future live source); fall back to `fixture` when primary
    is absent, returns empty, or raises. Step 2 always passes primary=None
    (offline). Step 5 plugs a live Apify source in as `primary` behind this
    same seam — without changing the harness or the eval.

    NOTE (review finding, Codex P3): Step 5 MUST narrow this bare ``except`` and
    log the fallback reason. Silently swallowing a live-source error here would
    mask schema / auth / parser regressions once a real `primary` exists. The
    broad catch is acceptable ONLY while `primary` is always None (Step 2).
    """
    if primary is None:
        return fixture.load()
    try:
        items = primary.load()
    except Exception:
        return fixture.load()
    return items if items else fixture.load()


def record_fixture(path: Path, key: str, items: list[dict]) -> None:
    """Write-through capture: persist `items` under {key} to a JSON fixture.

    The offline-equivalent of legacy `_write_cached_places`. Used only by a
    one-time live capture step (out of the default offline path) to freeze
    scraped reels / extracted places into a fixture. Creates parent dirs.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({key: items}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_sources.py -v`
Expected: PASS (8 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/sources.py backend/pipeline/fixtures/
git add backend/pipeline/test_sources.py
git commit -m "feat(pipeline): offline fixture/cache source layer (clean USE_CACHE) (step 2, #16)"
```

---

### Task 3: Offline pipeline skeleton

**Files:**
- Create: `backend/pipeline/offline_harness.py`
- Test: `backend/pipeline/test_offline_harness.py`

**Interfaces:**
- Consumes: `PipelineOutput` (Task 1); `FixtureReelSource`, `FixturePlaceSource`, `Source`, `resolve` (Task 2).
- Produces:
  - `run_offline_pipeline(reels_path: Path, places_path: Path, start_date: str, end_date: str, *, live_reels: Source | None = None, live_places: Source | None = None) -> PipelineOutput`
  - `dedup_passthrough(places: list[dict]) -> list[dict]`
  - `assemble_days_naive(places: list[dict], dates: list[str]) -> list[dict]`

- [ ] **Step 1: Write the failing test**

Create `backend/pipeline/test_offline_harness.py`:

```python
"""Offline pipeline skeleton tests — produces eval-shaped output, no API key."""
from pathlib import Path

from pipeline.offline_harness import (
    assemble_days_naive,
    dedup_passthrough,
    run_offline_pipeline,
)
from pipeline.output import PipelineOutput

FIX = Path(__file__).parent / "fixtures"


def test_dedup_passthrough_is_identity():
    places = [{"name": "A"}, {"name": "B"}]
    out = dedup_passthrough(places)
    assert out == places
    assert out is not places  # returns a new list (immutability)


def test_assemble_days_naive_chunks_in_input_order():
    places = [{"name": "A"}, {"name": "B"}, {"name": "C"}]
    days = assemble_days_naive(places, ["2026-06-10", "2026-06-11"])
    assert [d["day_number"] for d in days] == [1, 2]
    assert days[0]["place_names"] == ["A", "B"]  # extra goes to earlier day
    assert days[1]["place_names"] == ["C"]


def test_assemble_days_naive_rejects_zero_dates():
    import pytest
    with pytest.raises(ValueError):
        assemble_days_naive([{"name": "A"}], [])


def test_run_offline_pipeline_returns_eval_shaped_output():
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
    )
    assert isinstance(out, PipelineOutput)
    # reels surfaced from the scrape seam
    assert [r["short_code"] for r in out.reels] == ["MINI_AAA", "MINI_BBB"]
    # places surfaced from the extract seam (identity dedup -> both kept)
    assert [p["name"] for p in out.places] == ["Cafe Alpha", "Beta Ramen"]
    # itinerary shape matches what backend/evals consumes
    it = out.itinerary
    assert it["source"] == "pipeline"
    assert it["source_places"] == ["Cafe Alpha", "Beta Ramen"]
    assert len(it["days"]) == 2
    assert it["days"][0]["place_names"] == ["Cafe Alpha"]
    assert it["days"][1]["place_names"] == ["Beta Ramen"]


def test_run_offline_pipeline_rejects_reversed_dates():
    import pytest
    with pytest.raises(ValueError):
        run_offline_pipeline(
            reels_path=FIX / "mini_reels.json",
            places_path=FIX / "mini_places.json",
            start_date="2026-06-12",
            end_date="2026-06-10",
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.offline_harness'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/pipeline/offline_harness.py`:

```python
"""Offline pipeline skeleton — runs the (eventual) generation pipeline from
recorded fixtures, producing output in the shape backend/evals/ scores.

Step 2 scope: PLUMBING ONLY. Every stage is a fixture-backed placeholder —
no LLM agents, no live Apify / Mapbox / Supabase. Real stages replace them later:
  * scrape  -> FixtureReelSource now;  live Apify direct HTTP (Step 5)
  * extract -> FixturePlaceSource now; place_extractor agent (Step 5/6)
  * dedup   -> identity passthrough now; two-gate semantic+geo (Step 6)
  * narrate -> naive input-order day chunking now; feasibility ordering (Step 7)

The naive day chunking is deliberately a SEPARATE implementation from
evals/baseline.py: baseline.py is the frozen legacy bar to beat and must not
change as this pipeline improves. They coincide today on the Japan demo set
(8 distinct-name, all-coords places) — that equality is the regression anchor
proving the eval seam is wired with zero behaviour drift.
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

from pipeline.output import PipelineOutput
from pipeline.sources import (
    FixturePlaceSource,
    FixtureReelSource,
    Source,
    resolve,
)


def _date_range(start_date: str, end_date: str) -> list[str]:
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if end < start:
        raise ValueError(f"end_date {end_date} < start_date {start_date}")
    return [
        (start + timedelta(days=i)).isoformat()
        for i in range((end - start).days + 1)
    ]


def dedup_passthrough(places: list[dict]) -> list[dict]:
    """Identity dedup (Step 2 placeholder). Step 6 replaces it with semantic+geo.

    Returns a NEW list — never mutate the caller's list (immutability).
    """
    return list(places)


def assemble_days_naive(places: list[dict], dates: list[str]) -> list[dict]:
    """Split places in input order into len(dates) near-even contiguous chunks.

    Pipeline-owned naive narrate (Step 2 placeholder). Step 7 replaces it with
    route-aware feasibility ordering. Kept separate from evals/baseline.py on
    purpose (the legacy bar stays frozen; this stage evolves).
    """
    n, d = len(places), len(dates)
    if d <= 0:
        raise ValueError("need at least one date")
    base, extra = divmod(n, d)
    days: list[dict] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        days.append({
            "day_number": i + 1,
            "date": day_date,
            "place_names": [p["name"] for p in group],
        })
    return days


def run_offline_pipeline(
    reels_path: Path,
    places_path: Path,
    start_date: str,
    end_date: str,
    *,
    live_reels: Source | None = None,
    live_places: Source | None = None,
) -> PipelineOutput:
    """Run the fixture-backed pipeline end-to-end, offline, deterministically.

    `live_*` are seams for Step 5's live sources; in Step 2 they are always None,
    so the run reads only recorded fixtures. Returns output in the eval shape
    (reels + places + itinerary).
    """
    reels = resolve(live_reels, FixtureReelSource(reels_path))          # scrape (fixture)
    extracted = resolve(live_places, FixturePlaceSource(places_path))   # extract (fixture)
    canonical = dedup_passthrough(extracted)                            # dedup (identity)
    dates = _date_range(start_date, end_date)
    days = assemble_days_naive(canonical, dates)                        # narrate (naive)
    itinerary = {
        "title": "Tokyo (offline pipeline skeleton)",
        "source": "pipeline",
        "source_places": [p["name"] for p in canonical],
        "days": days,
    }
    return PipelineOutput(reels=reels, places=canonical, itinerary=itinerary)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/offline_harness.py backend/pipeline/test_offline_harness.py
git commit -m "feat(pipeline): offline fixture-backed pipeline skeleton (step 2, #16)"
```

---

### Task 4: Harden the eval gate — close the day-place hole

**Files:**
- Modify: `backend/evals/checks.py`
- Modify: `backend/evals/cases/japan_first_trip.json`
- Modify: `backend/evals/cases/japan_second_trip.json`
- Test: `backend/evals/test_checks.py`

**Interfaces:**
- Consumes: nothing from the pipeline tasks (independent instrument hardening — can land before or after Tasks 1–3).
- Produces: `check_day_places_traceable(ctx: dict) -> CheckResult`, registered as `"day_places_traceable"` in `CONTRACTUAL_CHECKS`, and listed in both cases' `active_contractual_checks`.

**Why (review finding, Codex P1b — confirmed):** `check_source_places_parity` validates only `itinerary["source_places"]`; nothing validates that each `days[*]["place_names"]` member traces to a real place, and `mean_intra_day_travel_m` silently `continue`s on an unknown day name (`metrics.py:32`). A future narrator (Step 7) could place a fabricated name in a day and pass every gate. Close it now; both subjects stay green (their days are built from the same canonical set the `source_places` come from).

- [ ] **Step 1: Write the failing test**

Append to `backend/evals/test_checks.py`, and add `check_day_places_traceable` to the existing import block at the top of that file:

```python
def test_day_places_traceable_pass_and_fail():
    ctx = {"places": [_place("A"), _place("B")],
           "itinerary": {"source_places": ["A", "B"],
                         "days": [{"place_names": ["A"]}, {"place_names": ["B"]}]}}
    assert check_day_places_traceable(ctx).status == "pass"
    # a day naming a place absent from source_places (narrator fabrication) must fail
    ctx["itinerary"]["days"] = [{"place_names": ["A", "Ghost Cafe"]}, {"place_names": ["B"]}]
    assert check_day_places_traceable(ctx).status == "fail"
    # an empty day list is vacuously fine (no untraceable names)
    ctx["itinerary"]["days"] = [{"place_names": []}]
    assert check_day_places_traceable(ctx).status == "pass"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest evals/test_checks.py -v`
Expected: FAIL — `ImportError: cannot import name 'check_day_places_traceable'`.

- [ ] **Step 3: Add the check + register it**

In `backend/evals/checks.py`, add the function after `check_source_places_parity`:

```python
def check_day_places_traceable(ctx: dict) -> CheckResult:
    """Every place named in an itinerary day must be one of the declared source_places.

    check_source_places_parity validates `source_places` against extraction, but nothing
    validates the day-level `place_names`; mean_intra_day_travel_m silently skips an
    unknown day name (coords.get -> None -> continue). Without this check, a narrator that
    drops a fabricated name into a day passes every gate. Pairs with parity
    (source_places subset of extracted) to give: day place in source_places subset of extracted.
    """
    source = set(ctx["itinerary"].get("source_places", []))
    bad = sorted({
        name
        for day in ctx["itinerary"]["days"]
        for name in day.get("place_names", [])
        if name not in source
    })
    if bad:
        return CheckResult("day_places_traceable", "fail",
                           f"itinerary day places not in source_places: {bad}")
    total = sum(len(day.get("place_names", [])) for day in ctx["itinerary"]["days"])
    return CheckResult("day_places_traceable", "pass",
                       f"all {total} day place references trace to source_places")
```

Then add it to the `CONTRACTUAL_CHECKS` registry (between `source_places_parity` and `evidence_verbatim`):

```python
CONTRACTUAL_CHECKS: dict[str, object] = {
    "coords_present": check_coords_present,
    "japan_bbox": check_japan_bbox,
    "day_count": check_day_count,
    "source_places_parity": check_source_places_parity,
    "day_places_traceable": check_day_places_traceable,
    "evidence_verbatim": check_evidence_verbatim,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest evals/test_checks.py -v`
Expected: PASS.

- [ ] **Step 5: Wire the check into both cases**

In `backend/evals/cases/japan_first_trip.json` AND `backend/evals/cases/japan_second_trip.json`, add `"day_places_traceable"` to `active_contractual_checks`, right after `"source_places_parity"`:

```json
  "active_contractual_checks": [
    "coords_present",
    "japan_bbox",
    "day_count",
    "source_places_parity",
    "day_places_traceable",
    "evidence_verbatim"
  ],
```

- [ ] **Step 6: Verify the baseline gate is still green with the new check**

Run: `cd backend && uv run python -m evals.run_eval`
Expected: `OVERALL: PASS` — baseline days are built from the deduped place set, so every day place is a `source_place`; the new check passes for both cases.

- [ ] **Step 7: Commit**

```bash
git add backend/evals/checks.py backend/evals/test_checks.py \
        backend/evals/cases/japan_first_trip.json backend/evals/cases/japan_second_trip.json
git commit -m "feat(evals): gate day-level place traceability (close hallucination hole) (step 2, #16)"
```

---

### Task 5: Wire the eval to score the pipeline subject (regression anchor)

**Files:**
- Modify: `backend/evals/run_eval.py`
- Test: `backend/evals/test_run_eval.py`

**Interfaces:**
- Consumes: `run_offline_pipeline` (Task 3); the hardened gate (Task 4).
- Produces: `build_ctx(case: dict, subject: str = "baseline") -> dict`; `run_case(name: str, subject: str = "baseline") -> dict`; a `--subject {baseline,pipeline}` CLI flag (default `baseline`).

- [ ] **Step 1: Write the failing tests (pipeline-subject parity + unknown-subject guard)**

Add to `backend/evals/test_run_eval.py` (append; keep existing imports/tests):

```python
import sys

import pytest

from evals.metrics import QUALITY_METRICS
from evals.run_eval import build_ctx, load_case, main


def test_pipeline_subject_passes_all_contractual_checks():
    # the offline pipeline output must satisfy the same gate as the baseline (no API key),
    # across BOTH cases the runner actually executes — not just the first.
    for name in gather_case_names():
        result = run_case(name, subject="pipeline")
        assert count_contractual_failures(result["contractual"]) == 0, name
        assert result["contractual"], f"expected contractual checks to run for {name}"


def test_pipeline_subject_matches_baseline_metrics_on_current_fixtures():
    # Regression anchor — fixture-scoped, NOT a forever invariant. On the CURRENT demo
    # fixtures (distinct names, all coords) the offline pipeline (identity dedup + naive
    # narrate) reproduces the baseline metrics exactly, proving the seam is wired with zero
    # behaviour drift. Steps 6-7 deliberately make the pipeline diverge (geo-dedup, routing);
    # when that lands, this equality is expected to break and the test is updated then.
    for name in gather_case_names():
        case = load_case(name)
        base_ctx = build_ctx(case, subject="baseline")
        pipe_ctx = build_ctx(case, subject="pipeline")
        metric_names = case["active_quality_metrics"]
        base = {m: QUALITY_METRICS[m](base_ctx) for m in metric_names}
        pipe = {m: QUALITY_METRICS[m](pipe_ctx) for m in metric_names}
        assert pipe == base, name


def test_default_subject_is_baseline():
    # existing #16 behaviour is unchanged unless --subject pipeline is passed
    base_ctx = build_ctx(load_case("japan_first_trip"))
    assert base_ctx["itinerary"]["source"] == "baseline"


def test_unknown_subject_raises():
    # the subject guard must reject typos rather than silently scoring nothing
    with pytest.raises(ValueError):
        build_ctx(load_case("japan_first_trip"), subject="bogus")


def test_baseline_run_prints_no_subject_banner(capsys, monkeypatch):
    # baseline keeps its prior semantics: no SUBJECT banner, OVERALL PASS, exit 0.
    # (The gate gained the approved day_places_traceable line, so output is NOT
    # byte-for-byte identical to pre-Step-2 — but pass/fail + exit code are.)
    monkeypatch.setattr(sys, "argv", ["run_eval", "--case", "japan_first_trip"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "SUBJECT:" not in out
    assert "baseline days:" in out  # label unchanged from today
    assert "OVERALL: PASS" in out
    assert "day_places_traceable" in out  # the gate runs on the baseline too


def test_pipeline_run_prints_subject_banner(capsys, monkeypatch):
    # opt-in pipeline subject announces itself and is scored green
    monkeypatch.setattr(sys, "argv",
                        ["run_eval", "--case", "japan_first_trip", "--subject", "pipeline"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "SUBJECT: pipeline" in out
    assert "pipeline days:" in out
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest evals/test_run_eval.py -v`
Expected: FAIL — `TypeError: run_case() got an unexpected keyword argument 'subject'` / `build_ctx()` rejects the `subject` kwarg (the functions exist but don't yet accept `subject`).

- [ ] **Step 3: Modify `build_ctx` to support the pipeline subject**

In `backend/evals/run_eval.py`, replace the current `build_ctx`:

```python
def build_ctx(case: dict) -> dict:
    """Build the eval context. Subject under test = legacy-equivalent baseline itinerary."""
    places = _load_json(EVALS_DIR / case["places_fixture"])["places"]
    reels = _load_json(EVALS_DIR / case["reels_fixture"])["reels"]
    itinerary = build_baseline_itinerary(places, case["start_date"], case["end_date"])
    return {
        "places": places,
        "reels": reels,
        "itinerary": itinerary,
        "start_date": case["start_date"],
        "end_date": case["end_date"],
        "expected_unique": case["expected_unique_places"],
    }
```

with the subject-aware version:

```python
def build_ctx(case: dict, subject: str = "baseline") -> dict:
    """Build the eval context for a subject under test.

    subject="baseline" (default): score the frozen legacy-equivalent itinerary —
        the #16 bar to beat. The ctx it builds is identical to today; the only
        baseline report change is the approved day_places_traceable line (Task 4).
    subject="pipeline": score the offline, fixture-backed pipeline skeleton
        (Step 2). Fully offline — no live OpenAI / Apify / Mapbox / mem0 / Supabase.
    """
    reels_path = EVALS_DIR / case["reels_fixture"]
    places_path = EVALS_DIR / case["places_fixture"]
    if subject == "pipeline":
        from pipeline.offline_harness import run_offline_pipeline

        out = run_offline_pipeline(
            reels_path=reels_path,
            places_path=places_path,
            start_date=case["start_date"],
            end_date=case["end_date"],
        )
        places, reels, itinerary = out.places, out.reels, out.itinerary
    elif subject == "baseline":
        places = _load_json(places_path)["places"]
        reels = _load_json(reels_path)["reels"]
        itinerary = build_baseline_itinerary(
            places, case["start_date"], case["end_date"]
        )
    else:
        raise ValueError(f"unknown subject {subject!r} (expected 'baseline' or 'pipeline')")
    return {
        "places": places,
        "reels": reels,
        "itinerary": itinerary,
        "start_date": case["start_date"],
        "end_date": case["end_date"],
        "expected_unique": case["expected_unique_places"],
    }
```

- [ ] **Step 4: Thread `subject` through `run_case`**

In `backend/evals/run_eval.py`, replace `run_case`:

```python
def run_case(name: str) -> dict:
    case = load_case(name)
    ctx = build_ctx(case)
    contractual = [CONTRACTUAL_CHECKS[c](ctx) for c in case["active_contractual_checks"]]
    metrics = {m: QUALITY_METRICS[m](ctx) for m in case["active_quality_metrics"]}
    pending = list(case.get("pending_checks", []))
    return {"case": case, "ctx": ctx, "contractual": contractual,
            "metrics": metrics, "pending": pending}
```

with:

```python
def run_case(name: str, subject: str = "baseline") -> dict:
    case = load_case(name)
    ctx = build_ctx(case, subject)
    contractual = [CONTRACTUAL_CHECKS[c](ctx) for c in case["active_contractual_checks"]]
    metrics = {m: QUALITY_METRICS[m](ctx) for m in case["active_quality_metrics"]}
    pending = list(case.get("pending_checks", []))
    return {"case": case, "ctx": ctx, "subject": subject, "contractual": contractual,
            "metrics": metrics, "pending": pending}
```

- [ ] **Step 5: Add the `--subject` CLI flag and surface it in the report**

In `backend/evals/run_eval.py`, replace `main`:

```python
def main() -> None:
    parser = argparse.ArgumentParser(description="Offline Japan eval runner (issue #16)")
    parser.add_argument("--case", default=None, help="run a single case by name")
    parser.add_argument("--subject", default="baseline", choices=["baseline", "pipeline"],
                        help="subject under test: legacy baseline (default) or offline pipeline")
    args = parser.parse_args()

    names = gather_case_names(args.case)
    if not names:
        print(f"ERROR: no eval cases found under {CASES_DIR} — nothing to evaluate.")
        sys.exit(1)
    if args.subject != "baseline":
        # Banner announces an opt-in non-default subject only; the baseline keeps
        # its prior pass/fail semantics + exit code (review finding, Codex).
        print(f"SUBJECT: {args.subject}")
    total_failed = 0
    for name in names:
        total_failed += print_report(name, run_case(name, args.subject))

    print("\n" + "=" * 66)
    verdict = "PASS (no contractual failures)" if total_failed == 0 else f"FAIL ({total_failed} contractual)"
    print(f"OVERALL: {verdict}")
    print("=" * 66)
    sys.exit(1 if total_failed else 0)
```

Then de-hardcode the report's `baseline days:` label so it reflects the actual subject (review finding, Codex P3 — `print_report` currently always prints `baseline days`). In `print_report`, change:

```python
    print(f"  reels: {len(reels)} ({_captured_count(reels)} captured) | "
          f"places: {len(ctx['places'])} | baseline days: {len(ctx['itinerary']['days'])}")
```

to:

```python
    print(f"  reels: {len(reels)} ({_captured_count(reels)} captured) | "
          f"places: {len(ctx['places'])} | "
          f"{ctx['itinerary'].get('source', 'baseline')} days: {len(ctx['itinerary']['days'])}")
```

(`print_report` otherwise reads `result["contractual"]/["metrics"]/["pending"]` unchanged; the new `subject` key it ignores is harmless.)

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `cd backend && uv run pytest evals/test_run_eval.py -v`
Expected: PASS (existing 4 + new 3 = 7 passed).

- [ ] **Step 7: Verify both runner subjects are green and the full suite passes**

Run:
```bash
cd backend
uv run python -m evals.run_eval                       # default baseline subject
uv run python -m evals.run_eval --subject pipeline    # offline pipeline subject
uv run pytest evals/ pipeline/ -q
```
Expected:
- both `run_eval` invocations end with `OVERALL: PASS (no contractual failures)` and exit 0
- the pipeline run prints `SUBJECT: pipeline` and per-case `pipeline days: N` (subject-aware label); the baseline run prints **no** `SUBJECT` line, `baseline days: N`, and the new `[PASS] day_places_traceable` line (the approved gate check, Task 4). `OVERALL: PASS` and exit 0 are unchanged. Baseline pass/fail semantics + exit code are unchanged — output is not literally byte-for-byte vs pre-Step-2 because the gate gained one line.
- pytest: all tests pass (the prior 33 — now including the new `day_places_traceable` check — plus the new `pipeline/` and `run_eval` tests), no API key, in well under a second

- [ ] **Step 8: Commit**

```bash
git add backend/evals/run_eval.py backend/evals/test_run_eval.py
git commit -m "feat(evals): pluggable subject — score offline pipeline output (step 2, #16)"
```

---

## Non-Goals (explicitly out of scope for Step 2)

- **No real agents.** No `place_extractor`, `place_enricher`, `narrator`, `restaurant`, `hotel`, `transport`, or `orchestrator` implementation. Stubs stay stubs.
- **No live calls.** No OpenAI, Apify, Mapbox, mem0, or Supabase on the default path. No `--live` flag.
- **No rich typed stage contracts.** `PipelineOutput` is the minimal eval-boundary shape only. The full Pydantic `PlaceResult`/`EnrichedPlace`/`ItineraryOutput` belong to **Step 4**.
- **No real dedup or routing.** Dedup is identity; narrate is naive input-order chunking. Step 6 (semantic+geo dedup) and Step 7 (feasibility ordering) replace them.
- **No `pipeline/runner.py`, `cache.py`, `dedup.py` work** — those are later steps' files; untouched here.
- **No edits to `evals/baseline.py`, `metrics.py`, `util.py`, or the `fixtures/*.json`.** `baseline.py` (the frozen legacy bar) and the recorded fixtures stay frozen. Step 2 *does* edit `checks.py` (one added gate check, Task 4), `cases/*.json` (wire it in), and `run_eval.py` (subject switch + subject-aware label, Task 5) — a deliberate, reviewed exception, not a free-for-all on the instrument.
- **No Supabase / auth / RLS / SSE / durable jobs / frontend.**
- **No GitHub Project board edits** (Codex owns board mutations — see board updates below).
- **No mem0 / second-trip memory implementation.** The `japan_second_trip` memory check stays PENDING.

---

## Acceptance Criteria

- [ ] `backend/pipeline/` exists with `__init__.py`, `output.py`, `sources.py`, `offline_harness.py`, and `fixtures/mini_reels.json` + `fixtures/mini_places.json`.
- [ ] `run_offline_pipeline(reels_path, places_path, start_date, end_date)` returns a `PipelineOutput` (reels + places + itinerary) in the exact shape `backend/evals/` consumes — verified by `mean_intra_day_travel_m`, `dedup_error`, evidence, coords, day-count, and source-parity scorers running against it without modification.
- [ ] The fixture/cache fallback (`resolve(primary, fixture)` + `record_fixture()`) is the clean `USE_CACHE` replacement: fixture-first, prefers a (future) primary, falls back on absent/empty/error, write-through recorder — all unit-tested.
- [ ] `evals/run_eval.py` accepts `--subject baseline|pipeline`; **default is `baseline`** with its pass/fail semantics + exit code unchanged (the `SUBJECT` banner prints only for non-baseline subjects; the `… days:` label resolves to `baseline days:` for the baseline subject). The baseline report gains exactly one line — the approved `day_places_traceable` check (Task 4) — so it is not literally byte-for-byte vs pre-Step-2. Asserted by `test_baseline_run_prints_no_subject_banner`.
- [ ] `cd backend && uv run python -m evals.run_eval` → `OVERALL: PASS`, exit 0 (unchanged).
- [ ] `cd backend && uv run python -m evals.run_eval --subject pipeline` → `OVERALL: PASS`, exit 0 — the offline pipeline output passes all active contractual checks (run from `backend/`; the runner is not importable from the repo root).
- [ ] The gate now includes `check_day_places_traceable`: both subjects pass it, a fabricated day place fails it (unit test), and the baseline `run_eval` stays `OVERALL: PASS` after wiring it into both cases.
- [ ] **Regression anchor (fixture-scoped, not a forever invariant):** across BOTH cases, the pipeline subject reproduces the baseline subject's quality metrics exactly on the current fixtures (`test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`). The plan documents that Steps 6–7 will deliberately break this equality.
- [ ] `cd backend && uv run pytest evals/ pipeline/ -q` → all pass with **no API key** (the prior 33 still pass; new tests added).
- [ ] No `legacy/` imports; no live network calls; no new dependencies in `pyproject.toml`.

---

## Local Run Command

```bash
cd backend
uv run python -m evals.run_eval                       # offline, baseline subject (the #16 gate) — unchanged
uv run python -m evals.run_eval --subject pipeline     # offline, NEW: score the fixture-backed pipeline skeleton
uv run python -m evals.run_eval --subject pipeline --case japan_first_trip
uv run pytest evals/ pipeline/ -q                      # full offline unit suite (no API key)
```

---

## Board Updates to Flag (do NOT apply — Codex owns board mutations)

Tell Shaun to have these applied to GitHub Project #1 (`MalaysiaKaki`, id `PVT_kwDOEXlARc4BanGs`):
1. Move **astrail #16 "Backend P0: offline eval set for Japan beta planning"** (Phase 1.1) — `In progress → Done`.
2. Activate the draft **"Backend P0: offline agent pipeline harness"** (Phase 1.1) — `Todo → In progress` for Step 2.
3. Note that the companion draft **"Backend P0: fixture/cache fallback generation path"** (Phase 1.1) is delivered together by this plan (the `sources.py` / `resolve()` / `record_fixture()` layer) — either fold it into the harness card's scope or mark it Done alongside Step 2.

---

## Risks / Rollback

- **Scope drift into Step 4 (typed contracts).** Mitigation: `PipelineOutput` is deliberately the minimal eval-boundary shape (3 dict-bearing fields), not the rich Pydantic stage models. Documented in `output.py`.
- **Accidental DRY-merge of `baseline.py` and the pipeline narrate.** This would couple the frozen legacy bar to the evolving pipeline. Mitigation: the plan keeps them as two separate implementations and the regression-anchor test asserts they coincide *today* (not that they share code). Reviewer note called out in `offline_harness.py` docstring.
- **`pipeline` import resolution (review finding, Codex P2).** `from pipeline.offline_harness import …` resolves **only when commands run from `backend/`** — cwd is on `sys.path` for `python -m`; pytest inserts its rootdir. It does NOT resolve from the repo root, exactly like the existing `from evals.…` imports. Mitigation: every command in this plan is prefixed `cd backend`; do not run the suite from the repo root. The import is lazy (inside the `subject == "pipeline"` branch) so baseline runs never touch `pipeline/`.
- **Regression-anchor over-claim (review finding, Codex P1a).** The pipeline↔baseline metric equality holds only because the current fixtures have distinct names + full coords; it is fixture-scoped, not contractual, and Steps 6–7 will deliberately break it. Mitigation: the parity test is named and commented as fixture-scoped, iterates both cases, and the plan states the equality is expected to break later.
- **Rollback:** every task is an isolated commit. Reverting Task 5 restores the exact prior runner (default-baseline) behaviour; reverting Task 4 restores the prior gate (the added check is independent of the pipeline). Tasks 1–3 add an unreferenced package with no effect on the default path. Low blast radius — additive only.

---

## Self-Review Notes (done by planner)

- **Spec coverage:** "offline pipeline harness" → Tasks 1+3; "fixture/cache fallback path" → Task 2; "runnable skeleton the eval can score" → Task 5; "output contract that matches backend/evals/" → the Output Contract section + Task 1; "active vs deferred" → the table; "TDD, unit tests pass with no API key" → every task is test-first, stdlib-only. Review additions: gate hardening → Task 4. All present.
- **Placeholder scan:** every code step contains complete code; no TBD/TODO/"handle edge cases".
- **Type consistency:** `run_offline_pipeline(reels_path, places_path, start_date, end_date)` signature is identical in Task 3 (definition), Task 5 (call), and the acceptance criteria. `PipelineOutput(reels, places, itinerary)` field names are identical in Task 1, Task 3, and the harness. `resolve(primary, fixture)` and `record_fixture(path, key, items)` signatures match between Task 2 definition and Task 3 usage / tests. `check_day_places_traceable(ctx)` matches between Task 4's definition, registry, and test.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES_RESOLVED | 5 issues (2 P1, 2 P2, 1 P3) — all folded into the plan |
| Outside Voice | Codex (`codex exec`, read-only, high effort) | Independent 2nd opinion + code review | 3 | issues_found | plan rounds 1–2 (2 P1, 3 P2, 3 P3 + 1 blocker) + code review round 3 (1 P1, 1 P2, 1 P3) — all resolved |

**CODEX:** verified each finding against the real code. Two P1s landed: the day-place gate hole (`checks.py:54` + `metrics.py:32`) → new `check_day_places_traceable` (Task 4); the regression-anchor over-claim → parity test scoped to fixtures + both cases. P2/P3s applied: import-only-from-`backend/` wording, "package marker beside existing stubs" framing, subject-aware report label, `resolve()` Step-5 logging note, bad-shape + unknown-subject tests.

**CODEX (round 2 — pre-approval, resolved):** Codex flagged that the plan claimed default output "byte-for-byte unchanged" while Task 5 printed `SUBJECT: baseline` unconditionally. Resolved via Codex Option 1: the `SUBJECT` banner now prints only for non-baseline subjects. Added `test_baseline_run_prints_no_subject_banner` + `test_pipeline_run_prints_subject_banner` (capsys).

**CODEX (round 3 — post-implementation code review of `99421fc..HEAD`, resolved):** Codex caught that "byte-for-byte unchanged" was still wrong — the approved `day_places_traceable` gate check (Task 4) adds a `[PASS] day_places_traceable` line to the baseline report. The two approved decisions (harden the gate; keep default output unchanged) genuinely conflict; the gate check wins (it must gate both subjects), so the claim was corrected everywhere to the accurate guarantee: **baseline pass/fail semantics + exit code are unchanged; the report gains exactly the one approved gate line.** Strengthened the test to assert `OVERALL: PASS` + the gate line appear for baseline. Code logic was correct; only the over-claim was fixed. P3 (`resolve()` bare-except) confirmed not a Step 2 bug (primary always None) and already documented as a Step 5 TODO. Codex verified: `baseline.py` untouched, no new deps, no `legacy/` imports, lazy pipeline import. No remaining blockers.

**CROSS-MODEL:** no tension — Codex reinforced the planner's immutability finding and added the gate hole + anchor findings. Both reviewers agree on the design (pluggable subject + frozen baseline + fixture-backed skeleton).

**Completion summary:**
- Step 0 Scope Challenge — scope accepted as-is (file count trips the smell, but it's tests + data + tiny value objects; already the minimal shape).
- Architecture Review — 1 issue (immutability, P3) → user chose "document the convention".
- Code Quality Review — 2 issues (DRY P2 → "keep separate, scope the anchor"; immutability P3 → above).
- Test Review — coverage diagram produced; 2 gaps (bad-shape fixture, unknown subject) → both added to the plan.
- Performance Review — 0 issues (offline, stdlib, ≤8-element lists).
- Outside voice — ran (Codex), 2 P1 / 3 P2 / 3 P3, all folded or applied.
- Lake Score: 3/3 user decisions chose the complete option (add the gate check, scope+cover-both-cases, document-convention).

**What already exists (reused, not rebuilt):** `backend/evals/` (the #16 instrument) — reused untouched except a pluggable `--subject` and one added gate check. Recorded fixtures (`japan_demo_reels.json`, `expected_places.json`) — reused as pipeline input via the case JSON's existing `reels_fixture`/`places_fixture` keys (zero duplication). Legacy `USE_CACHE` (`spike_e2e_planner.py:137-218`) — cleaned up into `sources.py`, reproduced not imported (guardrail #9). Existing `pipeline/` stubs (`runner.py`/`cache.py`/`dedup.py`) — left untouched.

**NOT in scope:** see the **Non-Goals** section — real agents, live calls, rich Step-4 contracts, real dedup/routing, `runner.py`/`cache.py`/`dedup.py`, Supabase/auth/SSE/jobs/frontend, mem0, board edits. Each deferred with a target step.

**Failure modes (per new codepath):** fixture missing → `FixtureMissing` (tested, clear msg, not silent); fixture present but wrong shape → `ValueError` (tested); reversed dates → `ValueError` (tested); unknown subject → `ValueError` (tested); fabricated day place → gate `fail` (tested). `resolve()` silent fallback is the one swallow-path, acceptable only while `primary is None` (Step 2) and flagged for Step 5 to narrow+log. **No critical silent-failure gaps.**

**Worktree parallelization:** Lane A = pipeline package `pipeline/` (Task 1 → Task 2 → Task 3, sequential, shared dir). Lane B = eval gate `evals/checks.py` + cases (Task 4, independent of `pipeline/`). **Launch A + B in parallel worktrees.** Then Task 5 (`evals/run_eval.py`, needs Task 3's harness + Task 4's wired cases) runs last. Conflict flag: Tasks 4 and 5 both touch `evals/` but disjoint files — sequence T4 before T5.

**Implementation Tasks (synthesized from findings — all already folded into the plan above):**
- [ ] **T1 (P1)** — evals gate — add `check_day_places_traceable` + register + wire into both cases (Task 4).
- [ ] **T2 (P1)** — evals test — scope the parity test as fixture-only and iterate both cases (Task 5, Step 1).
- [ ] **T3 (P2)** — pipeline/evals — "package marker beside stubs" + "import only from `backend/`" wording (File Structure, Risks).
- [ ] **T4 (P3)** — evals runner — subject-aware `… days:` report label (Task 5, Step 5).
- [ ] **T5 (P3)** — pipeline sources — `resolve()` Step-5 narrow+log note + bad-shape test (Task 2).

**VERDICT:** ENG REVIEW CLEARED — plan is ready to implement (all findings resolved in-plan; 5 separate commits, additive, default path unchanged). Implementation is gated on the user's explicit approval per the task instruction.

NO UNRESOLVED DECISIONS
