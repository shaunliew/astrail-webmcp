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
    def __init__(self, status_code: int = 200) -> None:
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            # Message deliberately embeds the secret-looking bits httpx errors really carry, so the
            # secret-safety test proves the logger drops them.
            raise httpx.HTTPStatusError(
                "Bearer sekret-key-DO-NOT-LOG leaked in url ?token=abc",
                request=None,  # type: ignore[arg-type]
                response=None,  # type: ignore[arg-type]
            )


class _FakeAsyncClient:
    """Records POSTs on a shared list; scriptable to raise. Replaces httpx.AsyncClient."""

    posted: list[dict] = []
    raise_on_post: Exception | None = None
    response_status: int = 200

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
        return _FakeResponse(type(self).response_status)


@pytest.fixture
def fake_httpx(monkeypatch):
    _FakeAsyncClient.posted = []
    _FakeAsyncClient.raise_on_post = None
    _FakeAsyncClient.response_status = 200
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    return _FakeAsyncClient


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
    # The scheduled date and a cancel instruction are load-bearing (the safety net, plan §3.5).
    assert "2026-08-12T00:00:00+00:00" in sent["json"]["text"]
    assert "cancel" in sent["json"]["text"].lower()
    assert "Settings" in sent["json"]["text"]


async def test_completed_email_posts_and_reads_key_at_call_time(monkeypatch, fake_httpx):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    await notifications.send_deletion_completed_email("traveler@example.com")

    assert len(fake_httpx.posted) == 1
    sent = fake_httpx.posted[0]
    assert sent["json"]["to"] == ["traveler@example.com"]
    assert "deleted" in sent["json"]["text"].lower()
    # A default from-address is used when RESEND_FROM_EMAIL is unset — on the send. subdomain.
    assert "send.astrail.xyz" in sent["json"]["from"]


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


async def test_a_failure_logs_only_the_exception_type_never_the_secret(
    monkeypatch, fake_httpx, caplog):
    monkeypatch.setenv("RESEND_API_KEY", "re_test_key")
    fake_httpx.response_status = 500  # -> raise_for_status raises an HTTPStatusError carrying secrets
    with caplog.at_level(logging.WARNING, logger="notifications"):
        await notifications.send_deletion_completed_email("traveler@example.com")

    blob = " ".join(r.getMessage() for r in caplog.records)
    assert "HTTPStatusError" in blob                 # the TYPE name is logged
    assert "sekret-key-DO-NOT-LOG" not in blob       # the message/secret is NOT
    assert "re_test_key" not in blob                 # the API key is NOT
    assert "traveler@example.com" not in blob        # the recipient is NOT
