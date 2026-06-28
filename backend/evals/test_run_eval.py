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
    # default (baseline) CLI output is byte-for-byte unchanged: no SUBJECT banner
    monkeypatch.setattr(sys, "argv", ["run_eval", "--case", "japan_first_trip"])
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "SUBJECT:" not in out
    assert "baseline days:" in out  # label unchanged from today


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
