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

# Default sender on the ``send.`` subdomain (SPF/DKIM live there — see the astrail-domain-infra
# note). Override with RESEND_FROM_EMAIL. Only ever used when RESEND_API_KEY is set.
_DEFAULT_FROM = "Astrail <no-reply@send.astrail.xyz>"

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


async def send_deletion_scheduled_email(email: str | None, scheduled_for: str) -> None:
    """Best-effort notice that a 7-day deletion grace has started (plan §3.5, the safety net)."""
    subject = "Your Astrail account is scheduled for deletion"
    body = (
        f"Your Astrail account and its travel data are scheduled to be deleted on "
        f"{_friendly_date(scheduled_for)}.\n\n"
        f"If you didn't mean to do this, you can {_CANCEL_HOWTO}.\n\n"
        "After that date your account and everything Astrail remembers are permanently removed."
    )
    await _send_email(email, subject, body)


async def send_deletion_completed_email(email: str | None) -> None:
    """Best-effort notice that the account + its data have been deleted."""
    subject = "Your Astrail account has been deleted"
    body = (
        "Your Astrail account and its associated travel data have been permanently deleted.\n\n"
        "Thanks for trying Astrail — you're welcome back any time with a fresh account."
    )
    await _send_email(email, subject, body)


async def _send_email(email: str | None, subject: str, body: str) -> None:
    """POST one email to Resend, swallowing EVERY failure (best-effort).

    A logged no-op when ``RESEND_API_KEY`` is unset or the recipient is missing, so the feature
    ships safely dormant. Secret-safe: a caught exception logs only its TYPE name — never the
    message/traceback (which can embed the bearer key or the ``?token=`` URL), the API key, or
    the recipient address.
    """
    try:
        api_key = os.environ.get("RESEND_API_KEY")
        if not api_key:
            logger.info("deletion email skipped: RESEND_API_KEY unset (no-op)")
            return
        if not email:
            logger.warning("deletion email skipped: no recipient address")
            return

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
    except Exception as exc:  # noqa: BLE001 — best-effort; a notice must NEVER break a deletion
        # TYPE name only. An httpx error message can embed the request URL / headers (the bearer
        # key) or the recipient address — never log the message or a traceback.
        logger.warning("deletion email send failed: %s", type(exc).__name__)
