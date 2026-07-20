"""Tripwire: production code must never branch on what a test double implements (B6).

`organizer.py` and `api/streaming.py` both used to fork on capability — `_maybe_await` on
whether an injected seam returned an awaitable, `hasattr(query, "gt")` on whether the client
implemented a filter. Every such fork hides real `supabase-py` API drift: the fake diverges
from the client, production silently takes the OTHER branch under test than it takes in
production, and no behavioural test can see the difference. The fakes implement the real
interface instead — see `_Table` in `test_saved_reels_organize.py`, whose `or_`/`is`/`lt`
evaluation RAISES on anything it does not genuinely support.

These are crude greps on purpose. They cannot prove the forks stay gone in spirit, only that
the two specific shapes do not come back unnoticed; a reviewer reading a diff that trips them
is the actual control.
"""
from __future__ import annotations

from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent

# The modules the forks lived in, plus `grounding.py` which B6 split out of `organizer.py` and
# which drives the same client. This is NOT a repo-wide ban: `pipeline/persist.py` legitimately
# uses `hasattr(it, "model_dump")` to accept either a Pydantic model or a plain dict, which is
# duck-typing over a REAL public API, not over a fake's gaps.
GUARDED = ("organizer.py", "grounding.py", "api/streaming.py")


@pytest.mark.parametrize("relative_path", GUARDED)
def test_production_does_not_probe_for_capabilities(relative_path):
    source = (BACKEND / relative_path).read_text(encoding="utf-8")

    assert "hasattr(" not in source, (
        f"{relative_path} probes an object for a method. If a fake is missing it, make the "
        f"fake implement it for real instead of forking production."
    )


def test_maybe_await_is_gone():
    """The injected `scrape`/`extract`/`ground` seams are async, so callers just await them."""
    source = (BACKEND / "organizer.py").read_text(encoding="utf-8")

    assert "_maybe_await" not in source
    assert "isawaitable" not in source
