"""Eval-safety contract (T6 / plan decision #9 / eng E6).

The offline eval MUST stay credential-free AND must never import the LIVE hotel-resolution modules —
`genagents.hotel_translate`, `geocode.cache`, `geocode.hotel_resolver`. Those are reached ONLY inside
the LIVE `persist_hotels` branch, behind lazy in-function imports; the offline pipeline skeleton
(`pipeline.offline_harness`) has no hotel stage at all. Keeping them out of `sys.modules` on the offline
path is the testable guarantee behind the two guardrails they would otherwise violate: the offline eval
staying keyless + green (#16), and the import-time invariant that no module import needs a key, pulls a
heavy SDK, or makes a network call (#9).

NOTE — this does NOT rest on `runner=None`. `localize_hotel_names(..., runner=None)` selects the REAL
OpenAI runner (there is no offline fake default), so eval-safety rests entirely on these modules NEVER
being IMPORTED on the offline path — if any entered `sys.modules`, a live OpenAI / Mapbox / Supabase
seam would be one call away from the "offline" eval. This test proves the import boundary itself holds.

Runs in a FRESH SUBPROCESS with credentials ABSENT — not an in-process `importlib.reload` — so a heavy
module another test already imported into this interpreter can never mask a real regression (mirrors
`geocode/test_errors.py` + `genagents/test_hotel_translate.py`). The subprocess RUNS the offline eval
subject end-to-end, then inspects that SAME process's `sys.modules`.
"""
from __future__ import annotations

import os
import subprocess
import sys

# The LIVE-only hotel-resolution modules that must NEVER load on the offline eval path.
_LIVE_HOTEL_MODULES = (
    "genagents.hotel_translate",
    "geocode.cache",
    "geocode.hotel_resolver",
)

# Credentials stripped from the child env: a keyless run must still succeed, proving the offline path
# neither needs a key nor reaches a live seam.
_STRIPPED_CREDENTIALS = (
    "OPENAI_API_KEY",
    "MAPBOX_SECRET_TOKEN",
    "APIFY_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_JWT_SECRET",
    "MEM0_API_KEY",
)


def test_offline_eval_never_imports_live_hotel_modules():
    """A keyless run of the offline pipeline eval subject imports NONE of the live hotel modules."""
    backend_dir = os.path.dirname(os.path.dirname(__file__))
    live = "[" + ", ".join(repr(m) for m in _LIVE_HOTEL_MODULES) + "]"
    code = (
        "import sys, importlib\n"
        # The offline pipeline skeleton itself (it has no hotel stage) ...
        "import pipeline.offline_harness\n"
        # ... and the FULL offline eval subject end-to-end (build_ctx -> run_offline_pipeline over every
        # case). runner=None would select the REAL runner here, so safety rests on NOT importing, below.
        "from evals.run_eval import gather_case_names, run_case\n"
        "names = gather_case_names()\n"
        "assert names, 'no eval cases found — cannot prove import-safety'\n"
        "for n in names:\n"
        "    run_case(n, 'pipeline')\n"
        f"live = {live}\n"
        "leaked = [m for m in live if m in sys.modules]\n"
        "assert not leaked, 'LIVE hotel modules imported on the offline eval path: ' + repr(leaked)\n"
        # Prove the module NAMES are real (importable, keyless) so the absence-check can never pass
        # VACUOUSLY after a rename/typo. This runs AFTER the assertion, so it cannot affect it — it only
        # fails the test loudly if a watched module was renamed out from under this contract.
        "for m in live:\n"
        "    importlib.import_module(m)\n"
        "print('OK')\n"
    )
    env = {k: v for k, v in os.environ.items()}
    for secret in _STRIPPED_CREDENTIALS:
        env.pop(secret, None)
    result = subprocess.run([sys.executable, "-c", code], cwd=backend_dir,
                            capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout
