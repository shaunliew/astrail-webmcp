"""Tests for the runner's gating wire-up — the core contract of an eval gate.

Without these, a typo in the `status == "fail"` count or a broken exit code would
ship silently (gstack review P1 finding).
"""
from evals.checks import CheckResult
from evals.run_eval import count_contractual_failures, gather_case_names, run_case


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
