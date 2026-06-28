"""Offline Japan eval runner (issue #16).

Loads each case, builds the legacy-equivalent baseline itinerary, runs active
contractual checks (gating) + quality metrics (recorded baseline) + pending checks
(skipped), prints a report, and exits non-zero on any failed contractual check.

Fully offline: no live OpenAI / Apify / Mapbox / mem0 / Supabase.

Run:  cd backend && uv run python -m evals.run_eval [--case NAME]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

from evals.baseline import build_baseline_itinerary
from evals.checks import CONTRACTUAL_CHECKS, PENDING_CHECKS
from evals.metrics import QUALITY_METRICS

EVALS_DIR = pathlib.Path(__file__).parent
CASES_DIR = EVALS_DIR / "cases"

_STATUS_GLYPH = {"pass": "PASS", "fail": "FAIL", "blocked": "BLOCK", "skipped": "SKIP"}


def _load_json(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_case(name: str) -> dict:
    return _load_json(CASES_DIR / f"{name}.json")


def gather_case_names(only: str | None = None) -> list[str]:
    """Case names to run: a single name, or every case file under cases/."""
    if only:
        return [only]
    return [p.stem for p in sorted(CASES_DIR.glob("*.json"))]


def count_contractual_failures(contractual: list) -> int:
    """Number of contractual checks that FAILED (blocked/skipped do not count)."""
    return sum(1 for c in contractual if c.status == "fail")


def build_ctx(case: dict, subject: str = "baseline") -> dict:
    """Build the eval context for a subject under test.

    subject="baseline" (default): score the frozen legacy-equivalent itinerary —
        the #16 bar to beat. Behaviour is byte-for-byte unchanged.
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


def run_case(name: str, subject: str = "baseline") -> dict:
    case = load_case(name)
    ctx = build_ctx(case, subject)
    contractual = [CONTRACTUAL_CHECKS[c](ctx) for c in case["active_contractual_checks"]]
    metrics = {m: QUALITY_METRICS[m](ctx) for m in case["active_quality_metrics"]}
    pending = list(case.get("pending_checks", []))
    return {"case": case, "ctx": ctx, "subject": subject, "contractual": contractual,
            "metrics": metrics, "pending": pending}


def _captured_count(reels: list[dict]) -> int:
    return sum(1 for r in reels if r.get("capture_status") == "CAPTURED")


def print_report(name: str, result: dict) -> int:
    """Print one case's report. Returns the count of FAILED contractual checks."""
    case, ctx = result["case"], result["ctx"]
    reels = ctx["reels"]
    print("\n" + "=" * 66)
    print(f"CASE: {name}  ({case['start_date']} -> {case['end_date']})")
    print(f"  reels: {len(reels)} ({_captured_count(reels)} captured) | "
          f"places: {len(ctx['places'])} | "
          f"{ctx['itinerary'].get('source', 'baseline')} days: {len(ctx['itinerary']['days'])}")
    print("-" * 66)

    print("  ACTIVE CONTRACTUAL CHECKS (gating):")
    for c in result["contractual"]:
        print(f"    [{_STATUS_GLYPH[c.status]:<5}] {c.name:<22} {c.detail}")
    failed = count_contractual_failures(result["contractual"])

    print("  ACTIVE QUALITY METRICS (recorded baseline, non-gating):")
    for k, v in result["metrics"].items():
        print(f"    {k:<26} = {v}")

    print("  PENDING CHECKS (skipped until their step lands):")
    for p in result["pending"]:
        note = "PENDING" if p in PENDING_CHECKS else "PENDING (case-declared)"
        print(f"    [{_STATUS_GLYPH['skipped']:<5}] {p:<22} {note}")

    if case.get("memory_check") == "PENDING":
        print(f"    memory effects to verify later: {case.get('expected_memory_effects', [])}")

    return failed


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
        # Default (baseline) CLI output stays byte-for-byte unchanged; the banner
        # only announces an opt-in non-default subject (review finding, Codex).
        print(f"SUBJECT: {args.subject}")
    total_failed = 0
    for name in names:
        total_failed += print_report(name, run_case(name, args.subject))

    print("\n" + "=" * 66)
    verdict = "PASS (no contractual failures)" if total_failed == 0 else f"FAIL ({total_failed} contractual)"
    print(f"OVERALL: {verdict}")
    print("=" * 66)
    sys.exit(1 if total_failed else 0)


if __name__ == "__main__":
    main()
