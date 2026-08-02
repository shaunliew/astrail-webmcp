"""Telegram Bot API — direct HTTP over four methods, with token-safe errors.

Three status codes are given their own exception class — 429, 409 and 401 — because this
is the only module that sees a status code at all, and each means something a caller must
act on differently. The rest collapse into `TelegramAPIError`.

Endpoints: core.telegram.org/bots/api — getUpdates, setMessageReaction, getMe,
getChatMember. Four endpoints do not justify a framework dependency, and adding one would
land it in the *shared* pyproject.toml that the web service also builds from.

TOKEN SAFETY — the whole point of this module. The bot token sits in the URL PATH
(`/bot<token>/<method>`), so anything that formats a request, a URL, or an httpx exception
leaks a live credential into a log line. Therefore:
  - every raise goes through `_safe` / `_raise_api_failure`, which build the message from
    the method name and the status or exception TYPE only — never `exc`, `str(exc)`,
    `repr(exc)`, `exc.request`, or any URL;
  - the ONE exception is `TelegramAPIError.description`, and it is an exception to the
    *field*, not to the rule: what escapes is an allowlisted constant this module owns
    (`_SAFE_DESCRIPTIONS`), matched against the envelope's `description`, never the
    server's text itself. It exists because the 2026-08-02 `REACTION_INVALID` incident
    took a manual live API call to diagnose from `error=TelegramAPIError` alone;
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

# What `description` becomes when the envelope carried none, or carried one we do not
# recognise. The two cases are deliberately indistinguishable: "we are not printing this"
# and "there was nothing to print" are the same thing to a reader, and collapsing them
# means no code path can be tricked into treating an unmatched description as data.
UNKNOWN_DESCRIPTION = "unknown"

# The allowlist. Telegram's `description` is server-generated English and carries no URL,
# which is what makes carrying ANY of it defensible — but "carries no URL today" is a
# property of Telegram's current release, not an invariant we control, so nothing leaves
# this module unless we recognise it by name.
#
# Entries are the bare uppercase MTProto constants Telegram embeds in the description
# (`Bad Request: REACTION_INVALID`), never the surrounding prose.
#
# UNLIKE THE EMOJI, AN UNVERIFIED ENTRY HERE IS SAFE — and the asymmetry is worth stating,
# because ✅ got into this file by exactly the reasoning this list would otherwise repeat.
# The emoji is a LIVE-PATH value: wrong, and the feature breaks. An allowlist entry is a
# FILTER: wrong, and it simply never matches, so the caller logs `unknown` — today's
# behaviour exactly. It cannot break a call or leak a byte. What it can do is quietly buy
# nothing, so treat an entry as unproven until you have seen it in a log line.
_SAFE_DESCRIPTIONS = frozenset({
    "REACTION_INVALID",      # MEASURED live 2026-08-02 — the emoji is not in Telegram's set
    "MESSAGE_NOT_MODIFIED",  # unmeasured — the reaction is already on the message
    "CHAT_WRITE_FORBIDDEN",  # unmeasured — the bot may not write in this chat
    "MESSAGE_ID_INVALID",    # unmeasured — the message was deleted before we reacted
})


class TelegramAPIError(RuntimeError):
    """Token-safe Bot API failure. The message NEVER contains the bot token.

    `description` is an allowlisted `_SAFE_DESCRIPTIONS` constant or `UNKNOWN_DESCRIPTION`
    — never the server's raw text, and never whatever a caller happened to pass in. It is
    a separate attribute rather than part of the message so the message stays exactly
    "method + status", which every existing token-safety assertion depends on.

    DELIBERATELY A PLAIN ATTRIBUTE, not a read-only property, though the clamp then only
    runs at construction and `exc.description = <raw text>` would defeat the `isinstance`
    gate in `ingest._react`. A property would close that, and it was declined: the read
    it would protect is already pinned from the AST
    (`test_ingest.py::test_the_module_formats_no_exception_and_reads_exactly_one_vetted_attribute`
    rejects any WRITE to an `exc` attribute), and unlike the `getattr` mistake — which
    reads as correct code and is why that check exists — assigning server text onto
    somebody else's exception has no plausible accidental form. Anyone doing it has
    already decided to log raw text and does not need this attribute to do so.
    """

    def __init__(self, message: str, *, description: str = UNKNOWN_DESCRIPTION) -> None:
        super().__init__(message)
        # Clamped in the CONSTRUCTOR, not at the single call site that has a payload. The
        # invariant a caller logs against — "this attribute is one of ours" — has to hold
        # for every construction path, including one written later by someone who never
        # read `_matched_description` and reaches for `payload["description"]` directly.
        #
        # `isinstance` FIRST, and not redundant: the membership test is against a frozenset,
        # so an unhashable value (a `list`, a `dict` — both perfectly possible in a JSON
        # payload) raised `TypeError` here instead of clamping. That crashed the very path
        # the paragraph above promises to cover. `_matched_description` guards the same way
        # at the parse site; this module must not trust the payload's type in one place and
        # distrust it in the other.
        self.description = (
            description
            if isinstance(description, str) and description in _SAFE_DESCRIPTIONS
            else UNKNOWN_DESCRIPTION
        )


class TelegramRetryAfter(TelegramAPIError):
    """429. Carries `retry_after` seconds parsed from `parameters.retry_after`."""

    def __init__(
        self, message: str, retry_after: float, *,
        description: str = UNKNOWN_DESCRIPTION,
    ) -> None:
        super().__init__(message, description=description)
        self.retry_after = retry_after


class TelegramConflict(TelegramAPIError):
    """409 — a second getUpdates consumer, or a webhook is still set. Not transient."""


class TelegramUnauthorized(TelegramAPIError):
    """401 — the bot token is wrong or has been revoked. Not transient.

    Discriminated for the same reason 409 is: a caller that treats it as a blip backs off
    politely forever on an error that will never clear, and the poller's heartbeat keeps
    reporting a healthy worker that can never ingest anything.

    Deliberately NOT 403. A 403 is "the bot was kicked from this chat" — per chat and
    recoverable — and widening this class would make one removed group look like a dead
    deployment.
    """


def _safe(method: str, exc: Exception) -> TelegramAPIError:
    """Rebuild a transport failure from the method name and the exception TYPE only."""
    return TelegramAPIError(f"Telegram {method} failed: {type(exc).__name__}")


def _matched_description(payload: dict[str, Any]) -> str:
    """The allowlisted constant the envelope's `description` names, else `unknown`.

    Substring rather than equality because Telegram wraps the constant in prose
    (`Bad Request: REACTION_INVALID`). That is safe in a way a prose match would not be:
    the return value is ALWAYS one of our own literals, so the worst a hostile description
    could achieve is naming the wrong one of four constants — never printing itself.

    `sorted` so a description containing two of them resolves identically on every run;
    `frozenset` iteration order is not a thing to build a log line on.
    """
    description = payload.get("description")
    if not isinstance(description, str):
        return UNKNOWN_DESCRIPTION
    matches = sorted(known for known in _SAFE_DESCRIPTIONS if known in description)
    return matches[0] if matches else UNKNOWN_DESCRIPTION


def _retry_after_seconds(payload: dict[str, Any]) -> float:
    """`parameters.retry_after`, or the documented fallback — never a KeyError."""
    parameters = payload.get("parameters")
    value = parameters.get("retry_after") if isinstance(parameters, dict) else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return _RETRY_AFTER_FALLBACK_S
    return float(value)


def _raise_api_failure(method: str, status: int, payload: dict[str, Any]) -> NoReturn:
    """Raise the right token-free error for a failed call: method + status only.

    The envelope's `description` still never reaches the MESSAGE — it is server-controlled
    text — but it is matched against `_SAFE_DESCRIPTIONS` and the matched constant rides
    along as an attribute. Diagnosing the 2026-08-02 `REACTION_INVALID` incident from
    `error=TelegramAPIError` alone took a manual call to the live API; that is the cost of
    dropping it entirely, and an allowlist buys the diagnosis without a passthrough.

    `from None` on every raise even though there is no active exception here today: it
    holds the no-chaining invariant if a future caller ever raises this from inside an
    `except` block, where implicit `__context__` would put a URL back in the traceback.
    """
    code = payload.get("error_code")
    if isinstance(code, bool) or not isinstance(code, int):
        code = status
    message = f"Telegram {method} failed: HTTP {status} (error_code={code})"
    described = _matched_description(payload)
    if code == 429 or status == 429:
        raise TelegramRetryAfter(
            message, _retry_after_seconds(payload), description=described
        ) from None
    if code == 409 or status == 409:
        raise TelegramConflict(message, description=described) from None
    if code == 401 or status == 401:
        raise TelegramUnauthorized(message, description=described) from None
    raise TelegramAPIError(message, description=described) from None


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
    emoji: str = "👍",
) -> None:
    """React to one message.

    THE EMOJI IS NOT FREE TEXT. Telegram permits only a fixed, server-defined set of
    reaction emoji and answers anything else with `Bad Request: REACTION_INVALID`. This
    shipped as ✅ (U+2705), which is NOT in that set, so between deploy and 2026-08-02
    every acknowledgement this bot sent failed while ingestion looked perfect — and the
    reaction is the bot's entire user-facing surface. 👍 was measured `ok=True` against the
    live API and reads as "accepted" rather than celebratory. Verify any replacement
    against the live API BEFORE changing this; `test_api.py` pins it against the measured
    set so an unverified edit fails CI.

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
