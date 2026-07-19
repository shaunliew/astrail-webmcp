"""A static gate against undefined names (ruff F821) across the backend.

This exists because of a defect the 727-test suite could not see. B6 moved code out of
`organizer.py` into `grounding.py` and left `os`, `PlaceResult` and `ValidationError`
referenced but unimported — every test still passed, because the only reference to `os` was
inside a nested function body that no test ever called. Tests can only guard code they
execute; a static pass over the source has no such blind spot. So there are two independent
guards on that one defect: this file, and
`test_saved_reels_organize.py::test_default_scrape_seam_fails_closed_without_an_apify_token`.

SCOPED TO F821 AND NOTHING ELSE, deliberately. Full-default `ruff check` currently reports
54 pre-existing errors across 8 backend files — 16 in `test_saved_reels_organize.py` and 24 in
`pipeline/test_persist.py`, almost all E702 (semicolon-joined one-liners in the test fakes),
plus a few E402/E741/F401. Widening this gate would redden the suite on unrelated pre-existing
style rather than on a real defect, and the point of a gate is that it only ever fires for the
thing it names. Cleaning those 54 up is a separate change; widen the select list only once
they are gone.

Invokes the `ruff` installed as a dev dependency, never `uvx` — the offline suite must not
need the network.
"""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

BACKEND_DIR = Path(__file__).resolve().parent


def _ruff_executable() -> Path:
    """Locate ruff in the interpreter's own environment.

    Resolving off `sys.executable` rather than PATH keeps the gate pinned to the venv running
    the tests, so it cannot silently pass against some other ruff (or a stale global one).
    """
    suffix = ".exe" if sys.platform == "win32" else ""
    return Path(sys.executable).parent / f"ruff{suffix}"


def test_backend_has_no_undefined_names():
    ruff = _ruff_executable()
    assert ruff.exists(), (
        f"ruff is not installed in this environment ({ruff}). It is a dev dependency in "
        "backend/pyproject.toml — run `uv sync`. This test FAILS rather than skips: a lint "
        "gate that silently disables itself is not a gate."
    )
    result = subprocess.run(
        [str(ruff), "check", "--select", "F821", "--no-cache", str(BACKEND_DIR)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        "ruff found undefined names (F821) in the backend — a name is referenced that no "
        "import or assignment provides. This is a NameError waiting for the right code path "
        f"to run.\n\n{result.stdout}{result.stderr}"
    )
