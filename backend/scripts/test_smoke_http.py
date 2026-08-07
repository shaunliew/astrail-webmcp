"""Unit tests for the PURE half of the Phase-2 HTTP smoke. No network, no DB, no credits.

The smoke's own flow is live and destructive-ish (it provisions a real user and mutates plan /
counters), so nothing here runs it. What IS tested is what its verdict is *made of* — because a
smoke is only worth its assertions, and this one has now been wrong twice in ways that mattered:

  1. It pre-filled the DAILY counter and expected a TRIAL user to be gated by it. Trial users are
     gated by `lifetime_trip_count`, so the first POST was `created` — a real trip, real Apify and
     OpenAI credits — and the next two were idempotent `replay`s of it. Reported FAIL on a healthy
     backend.
  2. After that was fixed, `_fill_daily_to_cap` still took the cap from the LOCAL module while
     driving a REMOTE service. Local `.env` leaves DAILY_TRIP_QUOTA at the code default 5; Render
     sets 10. Filling to 5 left the remote user under its cap, so the request was accepted and a
     real trip was created again.

Both bugs are the same shape — a local constant used to describe a remote process — which is why
`_effective_daily_cap` gets the most tests here.
"""
from __future__ import annotations

import pytest

from scripts.smoke_http import _effective_daily_cap, _err_code, _err_msg


class _Resp:
    """Minimal httpx.Response stand-in: `.json()` may raise, `.text` always works."""

    def __init__(self, payload=None, text="", raises=False):
        self._payload, self.text, self._raises = payload, text, raises

    def json(self):
        if self._raises:
            raise ValueError("not json")
        return self._payload


# --- _effective_daily_cap: the local-constant-describes-a-remote-process trap ----------------

def test_remote_target_overfills_past_the_local_cap(monkeypatch) -> None:
    """THE regression for bug 2. Local cap 5, remote cap 10 -> filling to 5 does NOT gate the
    remote user, the POST is accepted, and a real trip is created. Must over-fill instead."""
    monkeypatch.delenv("SMOKE_DAILY_CAP", raising=False)
    assert _effective_daily_cap(5, remote=True) >= 50
    assert _effective_daily_cap(5, remote=True) > 10, "must exceed Render's DAILY_TRIP_QUOTA=10"


def test_local_target_trusts_the_local_cap(monkeypatch) -> None:
    """In-process, the local module IS the service under test, so its cap is authoritative and
    over-filling would just be wasted round-trips."""
    monkeypatch.delenv("SMOKE_DAILY_CAP", raising=False)
    assert _effective_daily_cap(5, remote=False) == 5


def test_a_local_cap_above_the_overfill_is_not_lowered(monkeypatch) -> None:
    """`max`, not a constant: a deployment with a genuinely high quota must not be under-filled."""
    monkeypatch.delenv("SMOKE_DAILY_CAP", raising=False)
    assert _effective_daily_cap(500, remote=True) == 500


@pytest.mark.parametrize("remote", [True, False])
def test_explicit_override_wins_everywhere(monkeypatch, remote: bool) -> None:
    """When the operator knows the target's real cap, exactness beats over-filling — it makes the
    restore loop shorter and the intent explicit."""
    monkeypatch.setenv("SMOKE_DAILY_CAP", "10")
    assert _effective_daily_cap(5, remote=remote) == 10


def test_override_of_zero_is_honoured_not_treated_as_unset(monkeypatch) -> None:
    """`"0"` is falsy-looking but a legitimate value; an `int(x or default)` would silently drop it."""
    monkeypatch.setenv("SMOKE_DAILY_CAP", "0")
    assert _effective_daily_cap(5, remote=True) == 0


# --- envelope readers: a smoke that cannot read the error body reports the wrong reason ------

def test_err_code_reads_the_standard_envelope() -> None:
    assert _err_code(_Resp({"error": {"code": "trial_exhausted", "message": "x"}})) == "trial_exhausted"


def test_err_msg_reads_the_standard_envelope() -> None:
    assert _err_msg(_Resp({"error": {"message": "Daily trip limit reached. Try again tomorrow."}})) \
        == "Daily trip limit reached. Try again tomorrow."


@pytest.mark.parametrize("resp", [
    _Resp(raises=True, text="<html>502</html>"),   # non-JSON body (a proxy/CDN error page)
    _Resp({}),                                     # JSON, but no envelope
    _Resp({"error": {}}),                          # envelope, but empty
    _Resp(None),                                   # null body
])
def test_readers_never_raise_on_a_malformed_body(resp) -> None:
    """A crash here would abort the smoke mid-run and skip the `finally` that restores the user's
    quota and plan — turning a reporting problem into a data problem."""
    assert isinstance(_err_code(resp), str)
    assert isinstance(_err_msg(resp), str)


def test_err_msg_falls_back_to_raw_text_when_not_json() -> None:
    """The raw body is what tells an operator a CDN/proxy answered instead of the app."""
    assert "502" in _err_msg(_Resp(raises=True, text="<html>502 Bad Gateway</html>"))
