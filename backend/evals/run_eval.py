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
    return json.loads(path.read_text())


def load_case(name: str) -> dict:
    return _load_json(CASES_DIR / f"{name}.json")


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


def run_case(name: str) -> dict:
    case = load_case(name)
    ctx = build_ctx(case)
    contractual = [CONTRACTUAL_CHECKS[c](ctx) for c in case["active_contractual_checks"]]
    metrics = {m: QUALITY_METRICS[m](ctx) for m in case["active_quality_metrics"]}
    pending = list(case.get("pending_checks", []))
    return {"case": case, "ctx": ctx, "contractual": contractual,
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
          f"places: {len(ctx['places'])} | baseline days: {len(ctx['itinerary']['days'])}")
    print("-" * 66)

    print("  ACTIVE CONTRACTUAL CHECKS (gating):")
    failed = 0
    for c in result["contractual"]:
        print(f"    [{_STATUS_GLYPH[c.status]:<5}] {c.name:<22} {c.detail}")
        if c.status == "fail":
            failed += 1

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
    args = parser.parse_args()

    names = [args.case] if args.case else [p.stem for p in sorted(CASES_DIR.glob("*.json"))]
    total_failed = 0
    for name in names:
        total_failed += print_report(name, run_case(name))

    print("\n" + "=" * 66)
    verdict = "PASS (no contractual failures)" if total_failed == 0 else f"FAIL ({total_failed} contractual)"
    print(f"OVERALL: {verdict}")
    print("=" * 66)
    sys.exit(1 if total_failed else 0)


if __name__ == "__main__":
    main()
