"""Telegram Bot API — direct HTTP over four methods, with token-safe errors.

Endpoints: core.telegram.org/bots/api — getUpdates, setMessageReaction, getMe,
getChatMember. Four endpoints do not justify a framework dependency, and adding one would
land it in the *shared* pyproject.toml that the web service also builds from.

TOKEN SAFETY — the whole point of this module. The bot token sits in the URL PATH
(`/bot<token>/<method>`), so anything that formats a request, a URL, or an httpx exception
leaks a live credential into a log line. Therefore:
  - every raise goes through `_safe` / `_raise_api_failure`, which build the message from
    the method name and the status or exception TYPE only — never `exc`, `str(exc)`,
    `repr(exc)`, `exc.request`, or any URL;
  - nothing is chained. `raise ... from None`, not `from exc`, and not a bare `raise X`
    inside an `except` block: `httpx.HTTPStatusError.__str__` IS the request URL, and both
    explicit chaining and Python's implicit `__context__` put it in the formatted traceback
    that a caller's `logger.exception(...)` prints. Losing `__cause__` is the deliberate
    price;
  - `resp.raise_for_status()` is never called, and this module never logs. The callers
    (ingest/poller) own the log events.

Client is a REQUIRED keyword: the worker owns one long-lived `AsyncClient` for the process
(`timeout = poll_timeout + 15`, because long polling holds the socket open). This module
neither creates nor closes clients.

There is deliberately no message-sending wrapper. The bot is write-only-to-reactions, so
there is nothing to throttle and no throttle module anywhere in this feature.

Guardrail #11 — chat content is untrusted. This module moves envelopes: it never reads or
logs `message.text`, `caption`, `from.username`, `from.first_name` or `chat.title`.
`reel_filter.py` is the only module allowed to read message text.
"""
from __future__ import annotations

from typing import Any, NoReturn

import httpx

_BASE = "https://api.telegram.org/bot{token}/{method}"

# Telegram documents `parameters.retry_after` on 429 but does not always send it — a 429
# raised at the edge arrives with no Bot API envelope at all. 5s is the floor we back off
# by in that case: long enough to clear a burst, short enough not to stall a 50s long-poll
# loop. The poller sleeps `retry_after + 1`.
_RETRY_AFTER_FALLBACK_S = 5.0


class TelegramAPIError(RuntimeError):
    """Token-safe Bot API failure. The message NEVER contains the bot token."""


class TelegramRetryAfter(TelegramAPIError):
    """429. Carries `retry_after` seconds parsed from `parameters.retry_after`."""

    def __init__(self, message: str, retry_after: float) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class TelegramConflict(TelegramAPIError):
    """409 — a second getUpdates consumer, or a webhook is still set. Not transient."""


def _safe(method: str, exc: Exception) -> TelegramAPIError:
    """Rebuild a transport failure from the method name and the exception TYPE only."""
    return TelegramAPIError(f"Telegram {method} failed: {type(exc).__name__}")


def _retry_after_seconds(payload: dict[str, Any]) -> float:
    """`parameters.retry_after`, or the documented fallback — never a KeyError."""
    parameters = payload.get("parameters")
    value = parameters.get("retry_after") if isinstance(parameters, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _RETRY_AFTER_FALLBACK_S
    return float(value)


def _raise_api_failure(method: str, status: int, payload: dict[str, Any]) -> NoReturn:
    """Raise the right token-free error for a failed call: method + status only.

    The envelope's `description` is deliberately dropped — it is server-controlled text
    that would end up in our logs, and the rule here is method + status only.

    `from None` on every raise even though there is no active exception here today: it
    holds the no-chaining invariant if a future caller ever raises this from inside an
    `except` block, where implicit `__context__` would put a URL back in the traceback.
    """
    code = payload.get("error_code")
    if isinstance(code, bool) or not isinstance(code, int):
        code = status
    message = f"Telegram {method} failed: HTTP {status} (error_code={code})"
    if code == 429 or status == 429:
        raise TelegramRetryAfter(message, _retry_after_seconds(payload)) from None
    if code == 409 or status == 409:
        raise TelegramConflict(message) from None
    raise TelegramAPIError(message) from None


def _expect_result(method: str, result: Any, kind: type) -> Any:
    """Boundary-check an `ok: true` payload before handing it to a caller.

    Telegram's own contract says getUpdates returns a list and getMe a dict, but a caller
    that trusts that blind turns a malformed envelope into a `TypeError` deep inside the
    poll loop instead of a `TelegramAPIError` the poller already knows how to handle.
    """
    if not isinstance(result, kind):
        raise TelegramAPIError(f"Telegram {method} returned a malformed result")
    return result


async def _call(
    *, client: httpx.AsyncClient, token: str, method: str, body: dict[str, Any]
) -> Any:
    """POST one Bot API method and return its `result`, or raise a token-free error.

    A Bot API failure arrives EITHER as a non-2xx status OR as HTTP 200 with `ok: false`,
    so both go down the same path — 2xx is not success.
    """
    try:
        response = await client.post(_BASE.format(token=token, method=method), json=body)
    except httpx.HTTPError as exc:
        raise _safe(method, exc) from None  # `from None`: see the module docstring
    try:
        decoded = response.json()
    except ValueError:
        decoded = None  # an HTML error page from the edge, not a Bot API envelope
    payload: dict[str, Any] = decoded if isinstance(decoded, dict) else {}
    if payload.get("ok") is not True or response.status_code // 100 != 2:
        _raise_api_failure(method, response.status_code, payload)
    return payload.get("result")


async def get_updates(
    *,
    client: httpx.AsyncClient,
    token: str,
    offset: int | None = None,
    timeout_s: int = 50,
    allowed_updates: tuple[str, ...] = ("message",),
) -> list[dict]:
    """Long-poll for updates. `timeout_s` is Telegram's own long-poll hold, in seconds.

    `offset` is omitted from the body when None — absent, not present-as-null.
    """
    body: dict[str, Any] = {"timeout": timeout_s, "allowed_updates": list(allowed_updates)}
    if offset is not None:
        body["offset"] = offset
    result = await _call(client=client, token=token, method="getUpdates", body=body)
    return _expect_result("getUpdates", result, list)


async def set_message_reaction(
    *,
    client: httpx.AsyncClient,
    token: str,
    chat_id: int,
    message_id: int,
    emoji: str = "✅",
) -> None:
    """React to one message.

    Raises on failure. Reactions are best-effort, but that is the *caller's* call to make:
    swallowing the failure here would hide a revoked bot behind a silent no-op.
    """
    await _call(
        client=client,
        token=token,
        method="setMessageReaction",
        body={
            "chat_id": chat_id,
            "message_id": message_id,
            "reaction": [{"type": "emoji", "emoji": emoji}],
        },
    )


async def get_me(*, client: httpx.AsyncClient, token: str) -> dict:
    """Identify the bot — the worker's startup credential check."""
    result = await _call(client=client, token=token, method="getMe", body={})
    return _expect_result("getMe", result, dict)


async def get_chat_member(
    *, client: httpx.AsyncClient, token: str, chat_id: int, user_id: int
) -> dict:
    """One member's record. Callers read `["status"]` (creator/administrator/member/…)."""
    result = await _call(
        client=client,
        token=token,
        method="getChatMember",
        body={"chat_id": chat_id, "user_id": user_id},
    )
    return _expect_result("getChatMember", result, dict)
