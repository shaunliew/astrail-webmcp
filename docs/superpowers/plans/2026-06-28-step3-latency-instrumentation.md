# Step 3 — Offline Latency Instrumentation + Optional Trace Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fully offline, deterministic-testable per-stage + total timing to the fixture-backed pipeline and the #16 eval runner (baseline and pipeline subjects), plus a minimal no-op-by-default trace seam — without any live OpenAI / Apify / Mapbox / mem0 / Supabase / Langfuse calls and without disturbing Step 2 semantics.

**Architecture:** A tiny stdlib `Stopwatch` (with an **injectable clock**, default `time.perf_counter`) records per-stage wall-clock into a `dict[str, float]`. `run_offline_pipeline` wraps each of its 4 stages (scrape/extract/dedup/narrate) plus a `total` span and returns them on a new `PipelineOutput.timings` field. `build_ctx` surfaces `timings` into `ctx` for **both** subjects (pipeline uses the harness timings; baseline times the legacy monolith as `load`/`build`/`total`). `print_report` prints a new non-gating `STAGE TIMINGS` section. Timings are **deliberately not** registered as quality metrics, so the Step 2 parity anchor stays valid. A `Tracer` protocol + `NullTracer` give an optional forwarding seam that no-ops by default (no Langfuse import, no creds).

**Tech Stack:** Python ≥3.14, stdlib only (`time.perf_counter`, `contextlib`, `dataclasses`, `typing`). No new dependencies. `langfuse` is already a dependency but is **not imported** on the default path.

**Guiding principle (project policy): feasible first, not perfect.** Ship the smallest *working* timing layer now (stdlib stopwatch + a no-op trace seam). Real agent-trace observability via **Langfuse is deferred to later** — it is the better tool for seeing how agent traces actually work, but it only pays off once the live agent loop exists, so it is wired then, not now. Do not gold-plate timing before the system works end-to-end.

## Global Constraints

- **Offline + credential-free by default.** No live OpenAI / Apify / Mapbox / mem0 / Supabase / **Langfuse** calls. The unit suite passes with **no API key** and no env vars. (User Step 3 scope.)
- **Deterministic tests.** Timing assertions use an **injected fake clock**, never wall-clock. Real-clock paths (`main()`/CLI) only assert that the timing *section* renders, never specific values.
- **Don't disturb Step 2 behavior** except to add timing metadata + reporting. Contractual failures still drive the exit code; pending checks still don't. The Step 2 regression anchor (`test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`) must still pass.
- **Timings are NOT quality metrics.** Do not add latency to `QUALITY_METRICS` or any case's `active_quality_metrics` (that would break the parity anchor and the non-gating rule). Timings get their own report section + `ctx["timings"]` channel.
- **No real agents, live Apify, real dedup, routing, Supabase, SSE, or frontend.** Trace support is a no-op seam only; real Langfuse emission is deferred to a live-run step.
- **`baseline.py` stays frozen.** Baseline timing wraps the existing `build_baseline_itinerary` call from *outside*; it does not modify `baseline.py`.
- **No new dependencies.** stdlib only.
- **Immutability + style.** New value objects `@dataclass(frozen=True)` where reasonable; PEP 8; type annotations on every signature; files small (<150 lines).

---

## Output Contract addition (what changes vs Step 2)

```python
# PipelineOutput gains one field:
PipelineOutput(reels=[...], places=[...], itinerary={...}, timings={...})

# timings shape — pipeline subject:
{"scrape": float, "extract": float, "dedup": float, "narrate": float, "total": float}
# timings shape — baseline subject (legacy monolith; baseline.py frozen, no inner stages):
{"load": float, "build": float, "total": float}

# ctx gains one key (both subjects):
ctx["timings"] = {<stage>: <seconds>, ..., "total": <seconds>}
```

`total` is a real outer wall-clock span (measured `clock()` before the first stage to after the last), **not** the sum of stages — so it stays correct if a future stage runs concurrently. All values rounded to 6 decimals (microsecond).

Stage-name alignment: `scrape`, `extract`, `narrate` match the canonical SSE stage names in CLAUDE.md; `dedup` is an internal sub-stage of the extract phase, recorded separately for visibility. This updates the #16 spec's `latency_s` slot ("offline = N/A") to **offline = measured** (cheap, deterministic-testable, and the scaffold live timing plugs into).

---

## File Structure

```
backend/pipeline/
├── timing.py              # NEW — Stopwatch(clock) + Clock type; per-stage + total recording
├── tracing.py             # NEW — Tracer protocol + NullTracer (no-op default); optional forward seam
├── output.py              # MODIFY — add `timings: dict` field to PipelineOutput
├── offline_harness.py     # MODIFY — clock param; wrap 4 stages + total; return timings
├── test_timing.py         # NEW — Stopwatch determinism with a fake clock
├── test_tracing.py        # NEW — NullTracer no-ops; a fake tracer receives timings
├── test_output.py         # MODIFY — timings field present + frozen
└── test_offline_harness.py# MODIFY — deterministic per-stage + total timings via fake clock

backend/evals/
├── run_eval.py            # MODIFY — build_ctx records timings (both subjects, injectable clock);
│                          #          print_report STAGE TIMINGS section; run_case threads clock + tracer
└── test_run_eval.py       # MODIFY — baseline+pipeline timings in ctx (fake clock); report renders section
```

No changes to `baseline.py`, `metrics.py`, `util.py`, `checks.py`, `cases/*.json`, or `fixtures/*`.

---

## Active vs Deferred

| Concern | Step 3 (active) | Deferred |
|---|---|---|
| Per-stage + total offline timing | `Stopwatch` + harness instrumentation + `ctx["timings"]` | — |
| Timing for both eval subjects | baseline (`load`/`build`/`total`) + pipeline (4 stages + total) | — |
| Deterministic timing tests | injectable clock | — |
| Report timings locally | `STAGE TIMINGS` section in `print_report` | — |
| Trace seam | `Tracer` protocol + `NullTracer` (no-op, no Langfuse import) | Real Langfuse emission → live-run step (when agents + creds exist) |
| Heartbeat / SSE `elapsed_s` events | — | SSE layer (Step 11) |
| Per-agent fine-grained traces | — | when real agents exist |

---

### Task 1: Stopwatch with injectable clock

**Files:**
- Create: `backend/pipeline/timing.py`
- Test: `backend/pipeline/test_timing.py`

**Interfaces:**
- Consumes: nothing (stdlib only).
- Produces:
  - `Clock = Callable[[], float]`
  - `Stopwatch(clock: Clock = time.perf_counter)` with `.timings: dict[str, float]`, a context manager `.stage(name: str)`, and `.mark_total(start: float)`.

- [ ] **Step 1: Write the failing test**

Create `backend/pipeline/test_timing.py`:

```python
"""Stopwatch determinism — timing assertions use an injected fake clock, never wall-clock."""
from pipeline.timing import Stopwatch


class _Ticker:
    """Deterministic clock: returns 0.0, 1.0, 2.0, ... on each call."""

    def __init__(self, step: float = 1.0) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self._step
        return v


def test_stage_records_elapsed_per_stage():
    clock = _Ticker()
    sw = Stopwatch(clock=clock)
    start = clock()              # 0.0
    with sw.stage("a"):          # start 1.0, end 2.0 -> 1.0
        pass
    with sw.stage("b"):          # start 3.0, end 4.0 -> 1.0
        pass
    sw.mark_total(start)         # end 5.0 - 0.0 -> 5.0
    assert sw.timings == {"a": 1.0, "b": 1.0, "total": 5.0}


def test_stage_records_even_when_body_raises():
    clock = _Ticker()
    sw = Stopwatch(clock=clock)
    try:
        with sw.stage("boom"):   # start 0.0, end 1.0 -> 1.0
            raise RuntimeError("x")
    except RuntimeError:
        pass
    assert sw.timings["boom"] == 1.0


def test_default_clock_is_perf_counter_monotonic():
    # real clock: don't assert a value, just that a stage records a non-negative float
    sw = Stopwatch()
    with sw.stage("real"):
        pass
    assert isinstance(sw.timings["real"], float)
    assert sw.timings["real"] >= 0.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_timing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.timing'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/pipeline/timing.py`:

```python
"""Offline timing — a tiny stopwatch with an INJECTABLE clock for deterministic tests.

Default clock is time.perf_counter (monotonic wall-clock). Tests inject a fake
clock so per-stage durations are exact and assertable. Stdlib only; no network.
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator

Clock = Callable[[], float]


class Stopwatch:
    """Records per-stage elapsed seconds into `.timings`, plus a total outer span.

    `total` is a real outer span (clock at first start -> clock at mark_total),
    NOT the sum of stages — so it stays correct if a stage later runs concurrently.
    """

    def __init__(self, clock: Clock = time.perf_counter) -> None:
        self._clock = clock
        self.timings: dict[str, float] = {}

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        start = self._clock()
        try:
            yield
        finally:
            self.timings[name] = round(self._clock() - start, 6)

    def mark_total(self, start: float) -> None:
        """Record the total span as clock_now - `start` (the clock value before stage 1)."""
        self.timings["total"] = round(self._clock() - start, 6)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_timing.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/timing.py backend/pipeline/test_timing.py
git commit -m "feat(pipeline): injectable-clock stopwatch for offline timing (step 3, #16)"
```

---

### Task 2: Add `timings` to the output contract

**Files:**
- Modify: `backend/pipeline/output.py`
- Test: `backend/pipeline/test_output.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `PipelineOutput(reels, places, itinerary, timings)` — `timings: dict` as a 4th frozen field.

- [ ] **Step 1: Update the failing test**

In `backend/pipeline/test_output.py`, update `_sample()` to pass `timings`, and add a field test:

```python
def _sample() -> PipelineOutput:
    return PipelineOutput(
        reels=[{"reel_url": "https://example/reel/AAA", "caption": "x", "location_name": None}],
        places=[{"name": "A", "lat": 35.0, "lng": 139.0,
                 "evidence_quote": "A", "source_url": "https://a.jp", "confidence": 0.9}],
        itinerary={"title": "t", "source": "pipeline", "source_places": ["A"],
                   "days": [{"day_number": 1, "date": "2026-06-10", "place_names": ["A"]}]},
        timings={"scrape": 0.1, "extract": 0.2, "dedup": 0.0, "narrate": 0.3, "total": 0.6},
    )


def test_pipeline_output_exposes_timings():
    out = _sample()
    assert out.timings["total"] == 0.6
    assert set(out.timings) >= {"scrape", "extract", "dedup", "narrate", "total"}
```

(Keep the existing `test_pipeline_output_exposes_reels_places_itinerary` and `test_pipeline_output_is_frozen` — they now build `_sample()` with the timings arg.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_output.py -v`
Expected: FAIL — `TypeError: PipelineOutput.__init__() got an unexpected keyword argument 'timings'`.

- [ ] **Step 3: Add the field**

In `backend/pipeline/output.py`, add `timings` to the dataclass and docstring:

```python
    reels: list[dict]
    places: list[dict]
    itinerary: dict
    timings: dict
```

And add to the Attributes docstring:

```
        timings: per-stage + total wall-clock seconds for this offline run, e.g.
            {"scrape": 0.1, "extract": 0.2, "dedup": 0.0, "narrate": 0.3, "total": 0.6}.
            Recorded, non-gating.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_output.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/output.py backend/pipeline/test_output.py
git commit -m "feat(pipeline): add timings field to PipelineOutput (step 3, #16)"
```

---

### Task 3: Instrument the offline harness

**Files:**
- Modify: `backend/pipeline/offline_harness.py`
- Test: `backend/pipeline/test_offline_harness.py`

**Interfaces:**
- Consumes: `Stopwatch`, `Clock` (Task 1); `PipelineOutput` (Task 2).
- Produces: `run_offline_pipeline(..., *, live_reels=None, live_places=None, clock: Clock = time.perf_counter) -> PipelineOutput` — now records `timings` for stages `scrape`, `extract`, `dedup`, `narrate`, `total`.

- [ ] **Step 1: Write the failing test**

Append to `backend/pipeline/test_offline_harness.py` (add the `_Ticker` helper at top or import from test_timing — duplicate the small class to keep tests independent):

```python
class _Ticker:
    def __init__(self, step: float = 1.0) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self._step
        return v


def test_run_offline_pipeline_records_deterministic_timings():
    # clock calls in order: total_start, scrape(start,end), extract(start,end),
    # dedup(start,end), narrate(start,end), total_end -> values 0..9
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
        clock=_Ticker(),
    )
    assert out.timings == {
        "scrape": 1.0, "extract": 1.0, "dedup": 1.0, "narrate": 1.0, "total": 9.0,
    }


def test_run_offline_pipeline_default_clock_records_floats():
    out = run_offline_pipeline(
        reels_path=FIX / "mini_reels.json",
        places_path=FIX / "mini_places.json",
        start_date="2026-06-10",
        end_date="2026-06-11",
    )
    assert set(out.timings) == {"scrape", "extract", "dedup", "narrate", "total"}
    assert all(isinstance(v, float) and v >= 0.0 for v in out.timings.values())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: FAIL — `TypeError: run_offline_pipeline() got an unexpected keyword argument 'clock'`.

- [ ] **Step 3: Instrument the harness**

In `backend/pipeline/offline_harness.py`: add imports and wrap each stage. New imports:

```python
import time

from pipeline.timing import Clock, Stopwatch
```

Replace the body of `run_offline_pipeline` (keep the signature additions). The full new function:

```python
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

    `live_*` are seams for Step 5's live sources; in Step 2 they are always None.
    `clock` is injectable so timing is deterministic in tests (default perf_counter).
    Records per-stage + total wall-clock into the returned PipelineOutput.timings.
    """
    sw = Stopwatch(clock=clock)
    t0 = clock()
    with sw.stage("scrape"):
        reels = resolve(live_reels, FixtureReelSource(reels_path))
    with sw.stage("extract"):
        extracted = resolve(live_places, FixturePlaceSource(places_path))
    with sw.stage("dedup"):
        canonical = dedup_passthrough(extracted)
    with sw.stage("narrate"):
        dates = _date_range(start_date, end_date)
        days = assemble_days_naive(canonical, dates)
        itinerary = {
            "title": "Tokyo (offline pipeline skeleton)",
            "source": "pipeline",
            "source_places": [p["name"] for p in canonical],
            "days": days,
        }
    sw.mark_total(t0)
    return PipelineOutput(reels=reels, places=canonical, itinerary=itinerary, timings=sw.timings)
```

> Note: `_date_range` moved inside the `narrate` stage so its (tiny) cost is attributed to narrate; this changes the clock-call count to exactly 10, matching the deterministic test (total_start + 4×(start,end) + total_end).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_offline_harness.py -v`
Expected: PASS (7 passed — 5 prior + 2 new).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/offline_harness.py backend/pipeline/test_offline_harness.py
git commit -m "feat(pipeline): record per-stage + total timing in offline harness (step 3, #16)"
```

---

### Task 4: Optional no-op trace seam

> **Decision (confirmed):** KEEP this task. It ships the "traces" half of the board card as a no-op seam (no Langfuse import, no creds, no network) — the **feasible-first** version. **Langfuse is the deferred real tracer**: it gives far better observability into how the agent traces actually behave, but that value only lands once the live agent loop exists, so it is wired into this seam *later* (a live-run step), not now. The seam is ~25 lines and gives that step a clean forwarding point so it won't re-plumb the call sites.

**Files:**
- Create: `backend/pipeline/tracing.py`
- Test: `backend/pipeline/test_tracing.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Tracer` (Protocol) with `record_timings(run_label: str, timings: dict) -> None`; `NullTracer` (no-op default).

- [ ] **Step 1: Write the failing test**

Create `backend/pipeline/test_tracing.py`:

```python
"""Trace seam — no-op by default (offline, credential-free), forwards when injected."""
from pipeline.tracing import NullTracer, Tracer


def test_null_tracer_is_a_noop():
    # must not raise, must not require any credentials, returns None
    assert NullTracer().record_timings("japan_first_trip:pipeline", {"total": 0.5}) is None


def test_a_real_tracer_receives_timings():
    class _Recorder:
        def __init__(self):
            self.calls = []

        def record_timings(self, run_label: str, timings: dict) -> None:
            self.calls.append((run_label, timings))

    rec: Tracer = _Recorder()
    rec.record_timings("japan_first_trip:pipeline", {"scrape": 0.1, "total": 0.4})
    assert rec.calls == [("japan_first_trip:pipeline", {"scrape": 0.1, "total": 0.4})]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest pipeline/test_tracing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.tracing'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/pipeline/tracing.py`:

```python
"""Optional, no-op-by-default tracing seam for pipeline timings.

Step 3 records timings offline. Forwarding them to Langfuse (the chosen
observability layer, already a dependency) is OPTIONAL and happens only when a
real Tracer is explicitly injected. The DEFAULT is a pure no-op: no langfuse
import, no network, no credentials. Real Langfuse emission is wired in a later
live-run step (when real agents + creds exist) by providing a Tracer
implementation — this seam means that step won't have to re-plumb the call sites.
"""
from __future__ import annotations

from typing import Protocol


class Tracer(Protocol):
    def record_timings(self, run_label: str, timings: dict) -> None: ...


class NullTracer:
    """Default tracer — does nothing. Keeps the offline path credential-free."""

    def record_timings(self, run_label: str, timings: dict) -> None:
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest pipeline/test_tracing.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/tracing.py backend/pipeline/test_tracing.py
git commit -m "feat(pipeline): no-op-by-default trace seam for timings (step 3, #16)"
```

---

### Task 5: Eval runner — record + report timings (both subjects)

**Files:**
- Modify: `backend/evals/run_eval.py`
- Test: `backend/evals/test_run_eval.py`

**Interfaces:**
- Consumes: `run_offline_pipeline` clock arg (Task 3); `Stopwatch` (Task 1); `NullTracer`/`Tracer` (Task 4).
- Produces:
  - `build_ctx(case, subject="baseline", *, clock=time.perf_counter)` — `ctx` now carries `"timings"` for both subjects.
  - `run_case(name, subject="baseline", *, clock=time.perf_counter, tracer=None)` — calls `tracer.record_timings(f"{name}:{subject}", ctx["timings"])`.
  - `print_report` — adds a `STAGE TIMINGS` section.

- [ ] **Step 1: Write the failing tests**

Append to `backend/evals/test_run_eval.py` (reuse the `_Ticker` pattern — add a local copy):

```python
class _Ticker:
    def __init__(self, step: float = 1.0) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self._step
        return v


def test_pipeline_subject_ctx_has_stage_timings():
    ctx = build_ctx(load_case("japan_first_trip"), subject="pipeline", clock=_Ticker())
    assert ctx["timings"] == {
        "scrape": 1.0, "extract": 1.0, "dedup": 1.0, "narrate": 1.0, "total": 9.0,
    }


def test_baseline_subject_ctx_has_timings():
    # baseline times the legacy monolith as load/build/total (baseline.py is frozen)
    ctx = build_ctx(load_case("japan_first_trip"), subject="baseline", clock=_Ticker())
    assert ctx["timings"] == {"load": 1.0, "build": 1.0, "total": 5.0}


def test_timings_are_not_quality_metrics():
    # the parity anchor compares active_quality_metrics; timing must NOT be in there
    # — check EVERY case, not just the first (review finding, Codex P3).
    for name in gather_case_names():
        metrics = load_case(name)["active_quality_metrics"]
        assert "total_latency_s" not in metrics, name
        assert not any("latency" in m or "timing" in m for m in metrics), name
    # also assert the QUALITY_METRICS registry itself stays timing-free (Codex P3)
    assert not any("latency" in m or "timing" in m for m in QUALITY_METRICS)


def test_exploding_tracer_does_not_break_eval():
    # a failing trace backend must not crash the eval or change its exit semantics
    class _Boom:
        def record_timings(self, run_label, timings):
            raise RuntimeError("trace backend down")

    result = run_case("japan_first_trip", subject="pipeline", clock=_Ticker(), tracer=_Boom())
    assert count_contractual_failures(result["contractual"]) == 0


def test_report_renders_stage_timings_section(capsys, monkeypatch):
    monkeypatch.setattr(sys, "argv",
                        ["run_eval", "--case", "japan_first_trip", "--subject", "pipeline"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "STAGE TIMINGS" in out
    assert "total" in out
```

(The Step 2 parity + byte-for-byte tests remain; the baseline report now also gains a STAGE TIMINGS section — `test_baseline_run_prints_no_subject_banner` still passes since it only asserts substrings that are still present.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest evals/test_run_eval.py -v`
Expected: FAIL — `build_ctx()` rejects `clock`; `ctx` has no `"timings"`.

- [ ] **Step 3: Record timings in `build_ctx`**

In `backend/evals/run_eval.py`, add imports near the top:

```python
import time

from pipeline.timing import Clock, Stopwatch
from pipeline.tracing import NullTracer, Tracer
```

Replace `build_ctx` with the timing-aware version (note the typed `clock` param):

```python
def build_ctx(case: dict, subject: str = "baseline", *, clock: Clock = time.perf_counter) -> dict:
    """Build the eval context for a subject under test, with offline stage timings.

    subject="baseline" (default): score the frozen legacy-equivalent itinerary —
        the #16 bar to beat. The ctx it builds is identical to today plus a
        `timings` key (load/build/total around the frozen build_baseline_itinerary).
    subject="pipeline": score the offline, fixture-backed pipeline skeleton; timings
        come from the harness (scrape/extract/dedup/narrate/total). Fully offline.
    `clock` is injectable so timing is deterministic in tests.
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
            clock=clock,
        )
        places, reels, itinerary, timings = out.places, out.reels, out.itinerary, out.timings
    elif subject == "baseline":
        sw = Stopwatch(clock=clock)
        t0 = clock()
        with sw.stage("load"):
            places = _load_json(places_path)["places"]
            reels = _load_json(reels_path)["reels"]
        with sw.stage("build"):
            itinerary = build_baseline_itinerary(
                places, case["start_date"], case["end_date"]
            )
        sw.mark_total(t0)
        timings = sw.timings
    else:
        raise ValueError(f"unknown subject {subject!r} (expected 'baseline' or 'pipeline')")
    return {
        "places": places,
        "reels": reels,
        "itinerary": itinerary,
        "timings": timings,
        "start_date": case["start_date"],
        "end_date": case["end_date"],
        "expected_unique": case["expected_unique_places"],
    }
```

- [ ] **Step 4: Thread clock + tracer through `run_case`**

Replace `run_case` (typed params; the tracer call is **guarded** so a failing tracer can never affect exit semantics — review finding, Codex P3):

```python
def run_case(name: str, subject: str = "baseline", *, clock: Clock = time.perf_counter,
             tracer: Tracer | None = None) -> dict:
    tracer = tracer if tracer is not None else NullTracer()
    case = load_case(name)
    ctx = build_ctx(case, subject, clock=clock)
    contractual = [CONTRACTUAL_CHECKS[c](ctx) for c in case["active_contractual_checks"]]
    metrics = {m: QUALITY_METRICS[m](ctx) for m in case["active_quality_metrics"]}
    pending = list(case.get("pending_checks", []))
    try:
        # defensive copy: a bad tracer must not mutate the report timings (Codex P3)
        tracer.record_timings(f"{name}:{subject}", dict(ctx["timings"]))
    except Exception:
        # Tracing is a best-effort, non-gating side channel — it must NEVER
        # affect eval exit semantics (review finding, Codex P3).
        pass
    return {"case": case, "ctx": ctx, "subject": subject, "contractual": contractual,
            "metrics": metrics, "pending": pending}
```

- [ ] **Step 5: Add the `STAGE TIMINGS` section to `print_report`**

In `print_report`, after the `ACTIVE QUALITY METRICS` block and before the `PENDING CHECKS` block, add:

```python
    print("  STAGE TIMINGS (offline wall-clock seconds — recorded, non-gating):")
    for stage, secs in ctx.get("timings", {}).items():
        print(f"    {stage:<26} = {secs}")
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && uv run pytest evals/test_run_eval.py -v`
Expected: PASS (existing + 4 new).

- [ ] **Step 7: Full verification — both subjects + whole suite, offline, no keys**

Run:
```bash
cd backend
uv run python -m evals.run_eval                       # baseline: STAGE TIMINGS section present, OVERALL: PASS
uv run python -m evals.run_eval --subject pipeline    # pipeline: scrape/extract/dedup/narrate/total, OVERALL: PASS
uv run pytest evals/ pipeline/ -q                     # whole offline suite, no API key
```
Expected:
- both `run_eval` runs end `OVERALL: PASS (no contractual failures)`, exit 0
- both print a `STAGE TIMINGS` section; baseline shows `load/build/total`, pipeline shows `scrape/extract/dedup/narrate/total`
- the Step 2 parity anchor (`test_pipeline_subject_matches_baseline_metrics_on_current_fixtures`) still passes (timings are not quality metrics)
- pytest: all pass with no API key

- [ ] **Step 8: Commit**

```bash
git add backend/evals/run_eval.py backend/evals/test_run_eval.py
git commit -m "feat(evals): record + report offline stage timings for both subjects (step 3, #16)"
```

---

## Non-Goals (out of scope for Step 3)

- No real agents, live Apify/OpenAI/Mapbox/mem0/Supabase, or live Langfuse emission. The trace seam is a no-op; real emission is deferred to a live-run step.
- No SSE `heartbeat`/`elapsed_s` streaming events (Step 11) and no `HEARTBEAT_INTERVAL` loop.
- No latency in `QUALITY_METRICS` / `active_quality_metrics` (would break the parity anchor + the non-gating rule).
- No changes to `baseline.py`, `metrics.py`, `util.py`, `checks.py`, `cases/*.json`, `fixtures/*`.
- No new dependencies. No env-var-driven behavior on the default path.
- No GitHub Project board edits, no PR.

## Acceptance Criteria

- [ ] `PipelineOutput` has a `timings: dict` field; `run_offline_pipeline` records `scrape/extract/dedup/narrate/total` with an injectable clock.
- [ ] `build_ctx` adds `ctx["timings"]` for **both** subjects (baseline `load/build/total`; pipeline 4 stages + total), clock injectable.
- [ ] `print_report` prints a non-gating `STAGE TIMINGS` section; `run_eval` reports timing for baseline and pipeline subjects **with no API keys**.
- [ ] Tests cover the timing fields (deterministic via fake clock) and the report section (capsys); the trace seam no-ops by default and forwards when injected.
- [ ] Existing commands still pass: `uv run python -m evals.run_eval`, `--subject pipeline`, `uv run pytest evals/ pipeline/ -q` (all from `backend/`).
- [ ] The Step 2 regression anchor still passes (timings excluded from quality metrics).
- [ ] No new dependencies; no `legacy/` imports; fully offline + credential-free by default.

## Local Run / Verification Commands

```bash
cd backend
uv run python -m evals.run_eval
uv run python -m evals.run_eval --subject pipeline
uv run pytest evals/ pipeline/ -q
```

## Parallelization (for multi-agent execution)

- **Lane A:** Task 1 (`timing.py`) → Task 3 (`offline_harness.py`, needs Task 1 + Task 2).
- **Lane B:** Task 2 (`output.py`, independent of Task 1).
- **Lane C:** Task 4 (`tracing.py`, fully independent).
- Then **Task 5** (`run_eval.py`, needs Tasks 1–4). Lanes A/B/C touch disjoint files (`pipeline/*`), so Tasks 1, 2, 4 can run in parallel worktrees; Task 3 joins after 1+2; Task 5 last.

## Risks / Rollback

- **Clock-call-count drift in the deterministic test.** The exact `total=9.0` assertion depends on 10 ordered clock calls (total_start + 4 stages × 2 + total_end). If a stage adds/removes a clock read, the test value changes. Mitigation: the harness reads the clock only via `Stopwatch.stage` + one `t0`/`mark_total` pair; the test documents the call order. Keep `_date_range` inside the `narrate` stage (no extra clock reads).
- **Baseline output gains a STAGE TIMINGS section.** Like Step 2's gate line, this is an intended, reviewed output change — the guarantee remains "pass/fail semantics + exit code unchanged," not byte-for-byte. `test_baseline_run_prints_no_subject_banner` still passes (asserts substrings still present).
- **Frozen dataclass is shallow (review finding, Codex P3).** `PipelineOutput.timings` is a mutable dict on a frozen dataclass, exactly like the existing `reels`/`places`/`itinerary`. Consistent with the Step 2 decision (document the read-only convention; don't deep-freeze an internal DTO). No deep-freeze.
- **`evals` → `pipeline` import coupling.** Step 3 imports `pipeline.timing`/`pipeline.tracing` at `run_eval.py` top level, so the baseline path now imports `pipeline/` (Step 2 kept it lazy). Both modules are pure stdlib utilities (no network, no heavy deps), so the coupling is benign; a strict-decoupling move (a neutral `common/` module) is deferred as not worth it for ~40 lines.
- **Rollback:** every task is an isolated commit; Tasks 1–4 are additive (an unused module / new field). Reverting Task 5 restores Step 2 runner behavior exactly.

## Self-Review Notes

- **Spec coverage:** "offline pipeline output includes stage timings" → Tasks 2+3; "eval runner reports timing for both subjects without keys" → Task 5; "tests cover timing fields + report output" → Tasks 1,3,5; "trace optional + no-op unless configured" → Task 4; "no Step 2 behavior change except timing" → timings excluded from metrics, parity anchor preserved.
- **Type consistency:** `Clock`/`Stopwatch(clock=...)` identical in Tasks 1, 3, 5. `run_offline_pipeline(..., clock=...)` identical in Task 3 def + Task 5 call. `PipelineOutput(..., timings=...)` identical in Tasks 2, 3. `Tracer.record_timings(run_label, timings)` identical in Task 4 def + Task 5 call.
- **Placeholder scan:** every code step has complete code; no TBD.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 0 new issues; Step-0 scope accepted as-is (feasible-first); prior P3s folded |
| Outside Voice | Codex (`codex exec`, read-only, high effort) | Independent plan review | 2 | issues_found | round 1: 0 P1/P2, 8 P3 (folded) · round 2 (final plan): 0 P1/P2, 3 P3 (folded) |

**CODEX:** across two passes, verified the deterministic clock math (pipeline exactly 10 clock reads → `{scrape,extract,dedup,narrate}=1, total=9`; baseline 6 reads → `{load,build}=1, total=5`, no hidden reads), the metric-parity anchor is preserved (timings never enter `QUALITY_METRICS` or `active_quality_metrics`), the guarded `try/except` tracer can't change exit semantics, the default path imports no Langfuse and needs no creds, and the new `STAGE TIMINGS` section doesn't break `test_baseline_run_prints_no_subject_banner`. Folded refinements: guard the tracer (+ exploding-tracer test), type-annotate the new params, iterate all cases in the parity-exclusion test, **also assert the `QUALITY_METRICS` registry stays timing-free**, **pass `dict(ctx["timings"])` to the tracer** (defensive copy), and fix a set-vs-dict docstring typo.

**CROSS-MODEL:** no tension — planner review + both Codex passes agree the plan is sound. Zero P1/P2 across all passes.

**Step-0 scope:** complexity gate tripped on file count (10 touches) but accepted as-is — 5 are TDD tests, the 3 new types are tiny stdlib value objects, no new deps; matches the project's **feasible-first** policy. Trace seam kept (the no-op half now; Langfuse deferred to a live-run step for richer agent-trace observability).

**Failure modes:** missing/bad fixture → clear error (inherited from Step 2); reversed dates → `ValueError`; exploding tracer → swallowed, eval unaffected (tested); non-deterministic real-clock values → never asserted (only the section renders). No silent-failure gaps.

**Parallelization:** Lane A `pipeline/timing.py` (T1) → harness (T3, needs T1+T2). Lane B `pipeline/output.py` (T2). Lane C `pipeline/tracing.py` (T4). T1/T2/T4 run in parallel worktrees (disjoint files); T3 joins after T1+T2; T5 (`evals/run_eval.py`) last.

**VERDICT:** ENG REVIEW CLEARED — plan is final and ready to implement (5 tasks, TDD, fully offline, no new deps). Ready to hand to Codex for verification, then implement.

NO UNRESOLVED DECISIONS
