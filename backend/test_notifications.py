"""Keyless, no-network tests for the best-effort Resend sender (Task 4).

httpx is monkeypatched, so no real request ever leaves. Each test drives one branch of the
best-effort contract: a configured send POSTs the right shape; an unset RESEND_API_KEY is a
logged no-op; a missing recipient is a logged no-op; and EVERY failure (transport error, non-2xx)
is swallowed — never raised into the delete flow — and logs only the exception TYPE name so the
API key / recipient can never leak (token safety).
"""
from __future__ import annotations

import logging

import httpx
import pytest

import notifications


class _FakeResponse:
    def __init__(self, status_code: int = 200, text: str = "") -> None:
        self.status_code = status_code
        self.text = text

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            # Message deliberately embeds the secret-looking bits httpx errors really carry, so the
            # secret-safety test proves the logger drops them. `response=self` mirrors real httpx so
            # the C2 visibility branch reads the (secret-free) status_code + body off the response.
            raise httpx.HTTPStatusError(
                "Bearer sekret-key-DO-NOT-LOG leaked in url ?token=abc",
                request=None,  # type: ignore[arg-type]
                response=self,  # type: ignore[arg-type]
            )


class _FakeAsyncClient:
    """Records POSTs on a shared list; scriptable to raise. Replaces httpx.AsyncClient."""

    posted: list[dict] = []
    raise_on_post: Exception | None = None
    response_status: int = 200
    response_text: str = ""

    def __init__(self, *_a, **_k) -> None:
        pass

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, *_a) -> bool:
        return False

    async def post(self, url, headers=None, json=None):
        type(self).posted.append({"url": url, "headers": headers, "json": json})
        if type(self).raise_on_post is not None:
            raise type(self).raise_on_post
        return _FakeResponse(type(self).response_status, type(self).response_text)


@pytest.fixture
def fake_httpx(monkeypatch):
    _FakeAsyncClient.posted = []
    _FakeAsyncClient.raise_on_post = None
    _FakeAsyncClient.response_status = 200
    _FakeAsyncClient.response_text = ""
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


# --- resend_configured: the notification-readiness gate (Fix 4) ---------------------------


def test_resend_configured_reads_the_key_at_call_time(monkeypatch):
    """Fix 4: the request endpoint fail-closes on this. True only when RESEND_API_KEY is a
    non-empty value, read at CALL time (never at import), matching the senders' env discipline."""
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    assert notifications.resend_configured() is False
    monkeypatch.setenv("RESEND_API_KEY", "")
    assert notifications.resend_configured() is False       # empty string is not configured
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    assert notifications.resend_configured() is True


# --- configured happy path ----------------------------------------------------------------


async def test_scheduled_email_posts_the_right_resend_shape(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    monkeypatch.setenv("RESEND_FROM_EMAIL", "Astrail <no-reply@send.astrail.xyz>")

    await notifications.send_deletion_scheduled_email(
        "traveler@example.com", "2026-08-12T00:00:00+00:00")

    assert len(fake_httpx.posted) == 1
    sent = fake_httpx.posted[0]
    assert sent["url"] == "https://api.resend.com/emails"
    assert sent["headers"]["Authorization"] == "Bearer re_test_key"
    assert sent["json"]["from"] == "Astrail <no-reply@send.astrail.xyz>"
    assert sent["json"]["to"] == ["traveler@example.com"]
    # The scheduled date (HUMAN-friendly, not raw ISO) and a cancel instruction are load-bearing
    # (the safety net, plan §3.5).
    assert "August 12, 2026" in sent["json"]["text"]
    assert "2026-08-12T00:00:00+00:00" not in sent["json"]["text"]   # rendered, never raw ISO
    assert "cancel" in sent["json"]["text"].lower()
    assert "Settings" in sent["json"]["text"]


async def test_completed_email_posts_and_reads_key_at_call_time(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    # HERMETIC: conftest.py does load_dotenv(), and a developer may also export RESEND_FROM_EMAIL.
    # Either would shadow _DEFAULT_FROM and make the assertions below describe the environment
    # rather than the code, so the regression they exist to catch could pass unnoticed on someone
    # else's machine. Delete it so the default is genuinely what is under test.
    monkeypatch.delenv("RESEND_FROM_EMAIL", raising=False)
    await notifications.send_deletion_completed_email("traveler@example.com")

    assert len(fake_httpx.posted) == 1
    sent = fake_httpx.posted[0]
    assert sent["json"]["to"] == ["traveler@example.com"]
    assert "deleted" in sent["json"]["text"].lower()
    # A default from-address is used when RESEND_FROM_EMAIL is unset — on the ROOT domain, which is
    # the verified Resend sending identity.
    #
    # This assertion pinned "send.astrail.xyz" until 2026-08-07, i.e. the suite was GREEN over an
    # address the real API rejects with 403 "The send.astrail.xyz domain is not verified" (proven
    # live). `fake_httpx` accepts any `from`, so no test at this layer can catch a wrong sending
    # identity — only scripts/preflight_resend.py can. Asserting the ROOT domain here at least stops
    # the broken value being re-pinned by a future edit.
    # EXACT equality, not a substring: `"no-reply@astrail.xyz" in "…@astrail.xyz.evil>"` is True, so
    # a containment check would accept a lookalike sending domain.
    assert sent["json"]["from"] == "Astrail <no-reply@astrail.xyz>"
    assert "send.astrail.xyz" not in sent["json"]["from"]


# --- dormant / no-op branches (safe without config) ---------------------------------------


async def test_no_api_key_is_a_noop_and_never_posts(monkeypatch, fake_httpx):
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    # Must not raise, must not touch the network.
    await notifications.send_deletion_scheduled_email("x@example.com", "2026-08-12T00:00:00+00:00")
    await notifications.send_deletion_completed_email("x@example.com")
    assert fake_httpx.posted == []


async def test_missing_recipient_is_a_noop_even_with_a_key(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    await notifications.send_deletion_completed_email(None)
    await notifications.send_deletion_completed_email("")
    assert fake_httpx.posted == []


# --- best-effort: failures are swallowed and secret-safe -----------------------------------


async def test_transport_error_is_swallowed_and_never_raises(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    fake_httpx.raise_on_post = RuntimeError("connection reset")
    # The whole point: a send failure must NEVER propagate into the delete flow.
    await notifications.send_deletion_completed_email("x@example.com")  # no raise = pass


async def test_non_2xx_response_is_swallowed(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    fake_httpx.response_status = 422
    await notifications.send_deletion_scheduled_email("x@example.com", "2026-08-12T00:00:00+00:00")


async def test_a_failure_is_secret_safe_and_surfaces_the_resend_status(
    monkeypatch, fake_httpx, caplog):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    fake_httpx.response_status = 500  # -> raise_for_status raises an HTTPStatusError carrying secrets
    fake_httpx.response_text = '{"statusCode":500,"message":"internal error","name":"application_error"}'
    with caplog.at_level(logging.WARNING, logger="notifications"):
        result = await notifications.send_deletion_completed_email("traveler@example.com")

    assert result is False                           # a failed send reports False (C2 durable signal)
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "HTTPStatusError" in blob                 # the TYPE name is logged
    assert "500" in blob                             # C2: the status IS now visible (was swallowed)
    assert "sekret-key-DO-NOT-LOG" not in blob       # the exception message/secret is NOT
    assert "re_test_key" not in blob                 # the API key is NOT
    assert "traveler@example.com" not in blob        # the recipient is NOT


async def test_a_403_domain_not_verified_is_visible(monkeypatch, fake_httpx, caplog):
    # C2 / the exact shape Shaun hit 2026-08-07: an unverified sending domain returns 403 with a
    # JSON body naming the problem. Before this fix it was swallowed to a bare type name — a user
    # in a 7-day countdown got no cancel-by notice and no trace. The status + body must be visible.
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    fake_httpx.response_status = 403
    fake_httpx.response_text = '{"statusCode":403,"message":"The send.astrail.xyz domain is not verified.","name":"validation_error"}'
    with caplog.at_level(logging.WARNING, logger="notifications"):
        result = await notifications.send_deletion_scheduled_email(
            "traveler@example.com", "2026-08-12T00:00:00+00:00")

    assert result is False
    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "403" in blob                             # the operator can now SEE the rejection
    assert "not verified" in blob                    # …and exactly why
    assert "re_test_key" not in blob                 # still no key
    assert "traveler@example.com" not in blob        # still no recipient


async def test_send_returns_true_only_on_a_confirmed_2xx(monkeypatch, fake_httpx):
    # The bool is the durable signal notified_at is stamped on (C2): True ONLY on a real 2xx send.
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    assert await notifications.send_deletion_scheduled_email(
        "x@example.com", "2026-08-12T00:00:00+00:00") is True
    # …and a no-op (no key) reports False so the row stays unnotified and is retried.
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    assert await notifications.send_deletion_scheduled_email(
        "x@example.com", "2026-08-12T00:00:00+00:00") is False
