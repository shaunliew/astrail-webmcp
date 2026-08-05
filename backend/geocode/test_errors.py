"""Tests for the shared geocode error taxonomy (plan decision #7).

These are the cycle-free typed exceptions the whole hotel-resolution chain (T1/T3/T4/T5)
consumes; the module must import with no key and no heavy SDK.
"""
from __future__ import annotations

import os
import subprocess
import sys


def test_errors_are_plain_exception_subclasses():
    from geocode.errors import CacheError, ResolveError

    assert issubclass(ResolveError, Exception)
    assert issubclass(CacheError, Exception)
    # Distinct types — an infra resolve failure must never be caught as a cache-durability failure.
    assert ResolveError is not CacheError
    assert not issubclass(ResolveError, CacheError)
    assert not issubclass(CacheError, ResolveError)


def test_errors_carry_a_message():
    from geocode.errors import CacheError, ResolveError

    assert str(ResolveError("openai down")) == "openai down"
    assert str(CacheError("write failed")) == "write failed"


def test_errors_module_is_import_light():
    """The taxonomy is a leaf module: a FRESH-interpreter import must not drag in the Agents SDK,
    openai, httpx, or supabase — it is imported by both geocode.* and genagents.hotel_translate.
    Runs in a subprocess (not an in-process importlib.reload) so a heavy dep pulled in by another
    test can never mask a real regression here (mirrors test_hotel_translate's fresh-interpreter check)."""
    backend_dir = os.path.dirname(os.path.dirname(__file__))
    code = (
        "import sys; import geocode.errors;"
        "assert 'agents' not in sys.modules, 'agents imported at module load';"
        "assert 'openai' not in sys.modules, 'openai imported at module load';"
        "assert 'httpx' not in sys.modules, 'httpx imported at module load';"
        "assert 'supabase' not in sys.modules, 'supabase imported at module load';"
        "print('OK')"
    )
    env = {k: v for k, v in os.environ.items()}
    env.pop("OPENAI_API_KEY", None)
    env.pop("MAPBOX_SECRET_TOKEN", None)
    result = subprocess.run([sys.executable, "-c", code], cwd=backend_dir,
                            capture_output=True, text=True, env=env)
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout
