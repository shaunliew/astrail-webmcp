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


def test_pipeline_route_beats_or_matches_baseline_on_parity_anchors():
    # Step 7: the pipeline reorders for shorter routes, so it no longer EQUALS the baseline.
    # mean_intra_day_travel_m must be <= baseline (route is no worse); every OTHER metric is
    # unchanged (==). Cases flagged diverges_from_baseline are skipped (e.g. japan_dedupe).
    LOWER_IS_BETTER = {"mean_intra_day_travel_m"}   # metrics where pipeline should improve on baseline
    for name in gather_case_names():
        case = load_case(name)
        if case.get("diverges_from_baseline"):
            continue
        base_ctx, pipe_ctx = build_ctx(case, "baseline"), build_ctx(case, "pipeline")
        for m in case["active_quality_metrics"]:
            b, p = QUALITY_METRICS[m](base_ctx), QUALITY_METRICS[m](pipe_ctx)
            if m in LOWER_IS_BETTER:
                assert p <= b, f"{name}/{m}: pipeline {p} > baseline {b}"
            else:
                assert p == b, f"{name}/{m}: pipeline {p} != baseline {b}"


def test_pipeline_mean_intra_day_travel_is_frozen_anchor():
    # Freezes the deterministic route anchor. This feature is additive (evidence + tradeoffs
    # emitted AFTER assembly); if this value moves, dedup/assemble_itinerary changed — investigate.
    ctx = build_ctx(load_case("japan_first_trip"), "pipeline")
    assert QUALITY_METRICS["mean_intra_day_travel_m"](ctx) == 6229.0


def test_pipeline_flags_long_leg_and_overpacked_on_feasibility_case():
    ctx = build_ctx(load_case("japan_feasibility"), "pipeline")
    kinds = {w["kind"] for w in ctx["itinerary"]["feasibility_warnings"]}
    assert "long_leg" in kinds        # the ~30km stop is flagged even after optimal ordering
    assert "overpacked_day" in kinds  # 5 stops in 1 day > balanced cap 4
    assert QUALITY_METRICS["feasibility_warning_count"](ctx) == 2


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


def test_pipeline_zero_dedup_error_on_japan_dedupe():
    # Eval-level regression guard for the union-find dedup fix (issue #16 Step 6).
    # The 9 raw japan_dedup_places → 8 canonical after two-gate dedup → dedup_error==0.
    # The baseline subject intentionally scores 1 (no dedup); do NOT add a contractual
    # check to the case — that would fail the baseline subject which loads 9 raw places.
    result = run_case("japan_dedupe", subject="pipeline")
    assert QUALITY_METRICS["dedup_error"](result["ctx"]) == 0
    assert len(result["ctx"]["places"]) == 8
