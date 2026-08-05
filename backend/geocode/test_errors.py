"""Tests for the shared geocode error taxonomy (plan decision #7).

These are the cycle-free typed exceptions the whole hotel-resolution chain (T1/T3/T4/T5)
consumes; the module must import with no key and no heavy SDK.
"""
from __future__ import annotations

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
    """The taxonomy is a leaf module: importing it must not drag in the Agents SDK, openai,
    httpx, or supabase — it is imported by both geocode.* and genagents.hotel_translate."""
    import importlib

    for heavy in ("agents", "openai", "httpx", "supabase"):
        sys.modules.pop(heavy, None)
    import geocode.errors  # noqa: F401

    importlib.reload(geocode.errors)
    for heavy in ("agents", "openai", "httpx", "supabase"):
        assert heavy not in sys.modules, f"geocode.errors pulled in {heavy}"
