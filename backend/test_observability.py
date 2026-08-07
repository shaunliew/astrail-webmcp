"""Guards the Sentry PII scrubber — the path pyproject.toml warns is otherwise untested.

Sentry ships events to its own backend, not through a log handler, so test_log_redaction.py
cannot see this. These tests exercise `_before_send`/`_before_breadcrumb` directly to prove no
credential-shaped value survives into an outgoing event, and that the integration is dormant
(and safe) with no SENTRY_DSN.
"""
from __future__ import annotations

import importlib

import observability


def _reload():
    # _enabled is module-global; reload so each test starts from the dormant default.
    return importlib.reload(observability)


def test_before_send_redacts_token_query_param():
    obs = _reload()
    event = {"request": {"url": "https://api.astrail.xyz/generate-trip/stream/abc?token=eyJhbGciOiJFUzI1NiJ9.payload.sig"}}
    out = obs._before_send(event, None)
    assert "token=REDACTED" in out["request"]["url"]
    assert "eyJhbGci" not in out["request"]["url"]


def test_before_send_redacts_jwt_pg_dsn_and_api_keys_anywhere():
    obs = _reload()
    event = {
        "extra": {
            "note": "conn postgres://svc:s3cr3tpw@db.example.co:5432/postgres failed",
            "authz": "Bearer eyJhbGciOiJFUzI1NiJ9.abc.def",
            "openai": "sk-abcdEFGH1234567890",
            "resend": "re_abcdEFGH1234",
            "apify": "apify_api_ABCDEFGH12345678",
            # Supabase's CURRENT service-role (RLS-bypass) + anon key format, and Mapbox's SECRET
            # token — none are eyJ-JWTs, so they must be caught by _APIKEY_RE (review P2).
            "supabase_service": "sb_secret_AbCdEfGh12345678xyz",
            "supabase_anon": "sb_publishable_AbCdEfGh12345678",
            "mapbox": "sk.eyJ1IjoibWFwYm94Ijoic2VjcmV0In0.abcdefghijklmnop",
        },
        "breadcrumbs": [{"message": "GET https://x?token=eyJ.a.b"}],
    }
    out = obs._before_send(event, None)
    flat = repr(out)
    assert "s3cr3tpw" not in flat            # DSN password gone
    assert ":REDACTED@" in out["extra"]["note"]
    assert "eyJhbGci" not in flat            # JWT gone
    assert "sk-abcdEFGH1234567890" not in flat
    assert "re_abcdEFGH1234" not in flat
    assert "apify_api_ABCDEFGH12345678" not in flat
    assert "sb_secret_AbCdEfGh12345678xyz" not in flat        # Supabase service-role key gone
    assert "sb_publishable_AbCdEfGh12345678" not in flat
    assert "sk.eyJ1IjoibWFwYm94" not in flat                  # Mapbox secret token gone


def test_before_send_drops_headers_cookies_and_query_string():
    obs = _reload()
    event = {"request": {
        "url": "https://api.astrail.xyz/x",
        "headers": {"Authorization": "Bearer eyJ.a.b", "Cookie": "sb=xyz"},
        "cookies": {"sb": "xyz"},
        "query_string": "token=eyJ.a.b",
        "data": {"password": "hunter2"},
    }}
    out = obs._before_send(event, None)
    assert "headers" not in out["request"]
    assert "cookies" not in out["request"]
    assert "query_string" not in out["request"]
    assert "data" not in out["request"]
    assert "server_name" not in out


def test_before_breadcrumb_scrubs():
    obs = _reload()
    crumb = {"message": "streaming ?token=eyJ.a.b for user"}
    out = obs._before_breadcrumb(crumb, None)
    assert "token=REDACTED" in out["message"]
    assert "eyJ.a.b" not in out["message"]


def test_init_is_dormant_without_dsn(monkeypatch):
    obs = _reload()
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert obs.init_sentry() is False
    assert obs._enabled is False


def test_init_is_dormant_with_blank_dsn(monkeypatch):
    obs = _reload()
    monkeypatch.setenv("SENTRY_DSN", "   ")
    assert obs.init_sentry() is False


def test_capture_exception_is_noop_when_dormant():
    obs = _reload()
    # Must not raise even though Sentry was never initialised.
    obs.capture_exception(RuntimeError("boom"))
