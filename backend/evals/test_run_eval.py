"""Tests for the runner's gating wire-up — the core contract of an eval gate.

Without these, a typo in the `status == "fail"` count or a broken exit code would
ship silently (gstack review P1 finding).
"""
import sys

import pytest

from evals.checks import CheckResult
from evals.metrics import QUALITY_METRICS
from evals.run_eval import (
    build_ctx,
    count_contractual_failures,
    gather_case_names,
    load_case,
    main,
    run_case,
)


def test_count_contractual_failures_counts_only_fail():
    results = [
        CheckResult("a", "pass", "x"),
        CheckResult("b", "fail", "x"),
        CheckResult("c", "blocked", "x"),   # missing data — NOT a failure
        CheckResult("d", "skipped", "x"),   # pending — NOT a failure
        CheckResult("e", "fail", "x"),
    ]
    assert count_contractual_failures(results) == 2


def test_no_failures_when_all_pass_or_nongating():
    results = [CheckResult("a", "pass", "x"), CheckResult("b", "blocked", "x"),
               CheckResult("c", "skipped", "x")]
    assert count_contractual_failures(results) == 0


def test_cases_dir_is_not_empty():
    # guards the empty-case fail-open: the runner must have cases to evaluate
    assert gather_case_names() != []


def test_real_first_trip_case_passes_all_contractual_checks():
    # integration over the shipped fixtures (no API key) — the gate must be green on real data
    result = run_case("japan_first_trip")
    assert count_contractual_failures(result["contractual"]) == 0
    assert result["contractual"], "expected contractual checks to actually run"


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
        if case.get("diverges_from_baseline"):
            continue  # e.g. japan_dedupe: dedup_error intentionally differs from baseline (Step 6)
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


def test_tracer_cannot_mutate_report_timings():
    # the defensive dict(ctx["timings"]) copy means a mutating tracer can't corrupt
    # the report data (review finding, Codex P3)
    class _Mutator:
        def record_timings(self, run_label, timings):
            timings["scrape"] = 999.0
            timings.clear()

    result = run_case("japan_first_trip", subject="pipeline", clock=_Ticker(), tracer=_Mutator())
    assert result["ctx"]["timings"] == {
        "scrape": 1.0, "extract": 1.0, "dedup": 1.0, "narrate": 1.0, "total": 9.0,
    }


def test_report_renders_stage_timings_section(capsys, monkeypatch):
    monkeypatch.setattr(sys, "argv",
                        ["run_eval", "--case", "japan_first_trip", "--subject", "pipeline"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "STAGE TIMINGS" in out
    assert "total" in out
