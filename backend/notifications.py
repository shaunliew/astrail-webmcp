"""Best-effort transactional email via Resend — account-deletion notices (Task 4).

The FIRST email integration in the repo. Two notices ride this module:
  * ``send_deletion_scheduled_email`` — fired the instant a 7-day deletion grace starts; the
    load-bearing safety net (plan §3.5) that lets a user cancel a wrong/malicious request.
  * ``send_deletion_completed_email`` — fired once the account + data are actually gone.

Both are STRICTLY best-effort and DORMANT-safe:
  * Every failure is swallowed — a caught exception logs only the exception TYPE name (never its
    message or a traceback, which could carry the ``RESEND_API_KEY`` or the recipient address —
    token safety), and NEVER propagates into the delete flow. A missing notice must never block
    or fail an account deletion.
  * With ``RESEND_API_KEY`` unset the send is a logged no-op, so the whole feature is safe to
    ship dormant with no configuration (matching the still-gated deletion engine + endpoints).

Import-safe: ``httpx`` is imported lazily inside the sender and the environment is read at call
time (not import time), so importing this module needs no key, imports no heavy SDK, and makes no
network call — the repo import-time invariant holds.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_RESEND_ENDPOINT = "https://api.resend.com/emails"

# Default sender on the ROOT domain, which is the verified Resend sending identity. Override with
# RESEND_FROM_EMAIL. Only ever used when RESEND_API_KEY is set.
#
# NOT the ``send.`` subdomain, despite its name. Resend runs on SES and asks for THREE records when
# you verify a domain: DKIM at ``resend._domainkey.<domain>``, plus an MX + SPF on ``send.<domain>``
# purely as the Return-Path/bounce address. So ``send.astrail.xyz`` is bounce plumbing for the root
# registration, NOT a sending identity — it carries no DKIM selector of its own. This default was
# ``no-reply@send.astrail.xyz`` until 2026-08-07; verified live against the real API, that address
# returns:
#     403 "The send.astrail.xyz domain is not verified."
# which ``_send_email`` then SWALLOWS into a single ``HTTPStatusError`` line — leaving a user in a
# 7-day deletion grace whose cancel-by notice never arrives. Prove any change here with
# ``scripts/preflight_resend.py`` against the real API; the httpx fake in the tests accepts every
# from-address and therefore cannot catch this class of bug.
_DEFAULT_FROM = "Astrail <no-reply@astrail.xyz>"

_CANCEL_HOWTO = "cancel any time before then from Settings, and nothing will be deleted"


def resend_configured() -> bool:
    """True when RESEND_API_KEY is set — read at CALL time, matching the senders' env discipline
    (the environment is never read at import). The account-deletion request endpoint uses this to
    fail closed rather than start a 7-day grace it cannot send the scheduled-deletion notice for
    (plan §3.5, the safety net)."""
    return bool(os.environ.get("RESEND_API_KEY"))


def _friendly_date(scheduled_for: str) -> str:
    """Render the ISO-8601 ``scheduled_for`` as a human date (e.g. 'August 5, 2026'). Falls back to
    the raw string if it can't be parsed — a courtesy email must never fail on date formatting.
    ``%-d`` is avoided for portability; the day is interpolated directly."""
    from datetime import datetime

    try:
        dt = datetime.fromisoformat(scheduled_for)
    except (TypeError, ValueError):
        return scheduled_for
    return f"{dt.strftime('%B')} {dt.day}, {dt.year}"


async def send_deletion_scheduled_email(email: str | None, scheduled_for: str) -> bool:
    """Best-effort notice that a 7-day deletion grace has started (plan §3.5, the safety net).

    Returns True ONLY on a confirmed 2xx send — the durable signal the request endpoint and the
    sweep stamp `account_deletion_log.notified_at` on (C2). A no-op (no key / no recipient) and any
    failure return False, so an unstamped row is retried until the notice genuinely lands."""
    subject = "Your Astrail account is scheduled for deletion"
    body = (
        f"Your Astrail account and its travel data are scheduled to be deleted on "
        f"{_friendly_date(scheduled_for)}.\n\n"
        f"If you didn't mean to do this, you can {_CANCEL_HOWTO}.\n\n"
        "After that date your account and everything Astrail remembers are permanently removed."
    )
    return await _send_email(email, subject, body)


async def send_deletion_completed_email(email: str | None) -> bool:
    """Best-effort notice that the account + its data have been deleted. Returns True on a confirmed
    2xx send (the caller ignores it — the account is already gone; a lost notice is acceptable)."""
    subject = "Your Astrail account has been deleted"
    body = (
        "Your Astrail account and its associated travel data have been permanently deleted.\n\n"
        "Thanks for trying Astrail — you're welcome back any time with a fresh account."
    )
    return await _send_email(email, subject, body)


async def _send_email(email: str | None, subject: str, body: str) -> bool:
    """POST one email to Resend, swallowing EVERY failure (best-effort). Returns True ONLY on a
    confirmed 2xx send; a no-op (no key / no recipient) or any failure returns False.

    A logged no-op when ``RESEND_API_KEY`` is unset or the recipient is missing, so the feature
    ships safely dormant. Secret-safe: the caught exception's MESSAGE/traceback is never logged
    (httpx embeds the request URL / headers there — the bearer key), nor the API key or recipient.
    Visibility (C2): a Resend rejection carries a response whose ``status_code`` + small JSON error
    body ("The <domain> is not verified", 4xx/5xx) contain NEITHER the key (request header) nor the
    recipient (request payload), so both are logged — that is exactly what was silently swallowed
    before (Shaun's 2026-08-07 403 was invisible; fixed sender in 9862629). Transport / non-HTTP
    errors have no response and fall back to the TYPE name only.
    """
    try:
        api_key = os.environ.get("RESEND_API_KEY")
        if not api_key:
            logger.info("deletion email skipped: RESEND_API_KEY unset (no-op)")
            return False
        if not email:
            logger.warning("deletion email skipped: no recipient address")
            return False

        import httpx  # lazy: keeps the import path key-free and network-free

        sender = os.environ.get("RESEND_FROM_EMAIL") or _DEFAULT_FROM
        payload = {"from": sender, "to": [email], "subject": subject, "text": body}
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.post(
                _RESEND_ENDPOINT,
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            resp.raise_for_status()
        return True
    except Exception as exc:  # noqa: BLE001 — best-effort; a notice must NEVER break a deletion
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None)
        if status is None:
            # Transport / non-HTTP error: no response to read. TYPE name only (the exception
            # message embeds the request URL / headers — the bearer key).
            logger.warning("deletion email send failed: %s", type(exc).__name__)
            return False
        # Visibility WITHOUT dumping the free-form body (Codex P1): a proxy/provider body could pad
        # its error with echoed request data. Parse Resend's JSON error and log ONLY the allowlisted
        # `name`/`message` fields (bounded); a non-JSON body logs the status alone. Never the raw
        # body, never the exception message, never the key/recipient. `message` names the config
        # problem (e.g. "The <domain> is not verified") — the recipient is an auth.users.email so it
        # is valid by construction and does not appear in a Resend validation message.
        detail = ""
        try:
            import json

            parsed = json.loads(getattr(resp, "text", "") or "")
            if isinstance(parsed, dict):
                detail = (f"name={str(parsed.get('name', ''))[:64]} "
                          f"message={str(parsed.get('message', ''))[:200]}")
        except Exception:  # noqa: BLE001 — a non-JSON error body must not break logging
            detail = ""
        logger.warning("deletion email send failed: type=%s status=%s %s",
                       type(exc).__name__, status, detail)
        return False
