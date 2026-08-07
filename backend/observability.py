"""Optional Sentry error monitoring — dormant unless SENTRY_DSN is set.

Re-adds sentry-sdk (removed under ISSUES-B1) WITH the mandatory PII scrubber the removal
comment in pyproject.toml demands. Sentry's default integrations capture full request URLs,
and the SSE stream routes carry `?token=<JWT>`, so `before_send`/`before_breadcrumb` scrub
every outgoing event before it leaves the process. Over-redaction is deliberate — same posture
as log_redaction: a credential-shaped value that gets REDACTED is safe; one that slips through
is the bug. `send_default_pii=False` + `traces_sample_rate=0.0` (errors only, no URL-bearing
perf spans) are the belt to the scrubber's braces.

Dormant by default: `init_sentry()` is a no-op unless SENTRY_DSN is set (the same pattern as
the Resend integration), so nothing ships anywhere until an operator opts in from Render, and
`capture_exception()` is a no-op until then. This module needs no test through log_redaction
(Sentry ships to its own backend, not a log handler — the pyproject comment's point); the guard
is `test_observability.py`, which exercises the scrubber directly.
"""
from __future__ import annotations

import logging
import os
import re

from log_redaction import _TOKEN_RE  # reuse the `token=<val>` scrubber — single source of truth

logger = logging.getLogger(__name__)

# Credential shapes a Sentry event/traceback can carry that log_redaction never sees (it only
# guards uvicorn.access URLs). Redacting a value that merely LOOKS like one of these is safe.
_JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")   # legacy user JWT + HS256 keys
_PG_DSN_RE = re.compile(r"(postgres(?:ql)?://[^:/@\s]+:)[^@\s]+(@)")          # redact the DSN password only
# Provider key shapes. sb_secret_ is the CURRENT Supabase service-role key (RLS-bypass — the highest-
# value secret in the system) and sb_publishable_ its anon counterpart; sk./pk. are Mapbox tokens.
# These are NOT eyJ-JWTs, so _JWT_RE misses them — they must be enumerated here (review P2).
_APIKEY_RE = re.compile(
    r"(sk-[A-Za-z0-9_-]{8,}|sk\.[A-Za-z0-9._-]{20,}"          # OpenAI + Mapbox SECRET token
    r"|sb_secret_[A-Za-z0-9_-]{8,}|sb_publishable_[A-Za-z0-9_-]{8,}"   # Supabase service-role + anon
    r"|re_[A-Za-z0-9_-]{8,}|apify_api_[A-Za-z0-9]{8,})")      # Resend + Apify

_enabled = False


def _scrub_text(s: str) -> str:
    s = _TOKEN_RE.sub(r"\1REDACTED", s)
    s = _JWT_RE.sub("REDACTED_JWT", s)
    s = _PG_DSN_RE.sub(r"\1REDACTED\2", s)
    s = _APIKEY_RE.sub("REDACTED_KEY", s)
    return s


def _scrub(obj):
    """Recursively redact credential-shaped substrings in every string within an event."""
    if isinstance(obj, str):
        return _scrub_text(obj)
    if isinstance(obj, dict):
        return {k: _scrub(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return type(obj)(_scrub(v) for v in obj)
    return obj


def _before_send(event, hint):
    # Fail CLOSED: if we cannot fully scrub, drop the event rather than ship an unscrubbed one.
    try:
        req = event.get("request")
        if isinstance(req, dict):
            # Authorization/session cookies + raw query string + posted body are the highest-risk
            # PII vectors; drop them structurally before the substring scrub runs.
            for k in ("headers", "cookies", "env", "data", "query_string"):
                req.pop(k, None)
        event.pop("server_name", None)   # hostname adds no signal and can leak infra detail
        return _scrub(event)
    except Exception:
        return None


def _before_breadcrumb(crumb, hint):
    try:
        return _scrub(crumb)
    except Exception:
        return None


def init_sentry() -> bool:
    """Initialise Sentry IFF SENTRY_DSN is set. Returns True when active, False when dormant."""
    global _enabled
    dsn = (os.environ.get("SENTRY_DSN") or "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
    except ImportError:
        logger.warning("sentry_dsn_set_but_sdk_missing")   # never fatal — monitoring is best-effort
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=(os.environ.get("SENTRY_ENVIRONMENT") or "production").strip(),
        send_default_pii=False,     # never auto-attach user/request PII
        traces_sample_rate=0.0,     # errors only — no URL-bearing performance spans
        before_send=_before_send,
        before_breadcrumb=_before_breadcrumb,
    )
    _enabled = True
    logger.info("sentry_initialised")
    return True


def capture_exception(exc: BaseException) -> None:
    """Send an exception to Sentry when active; a no-op when dormant (no DSN configured)."""
    if not _enabled:
        return
    try:
        import sentry_sdk

        sentry_sdk.capture_exception(exc)
    except Exception:
        pass   # observability must never raise into the caller's error path
