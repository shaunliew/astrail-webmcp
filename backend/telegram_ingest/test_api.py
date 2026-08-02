"""Telegram Bot API wrapper — offline, mocked httpx transport (no network, no token).

The literal token `SECRET123` is used in every test so the leak assertions are greppable:
the bot token travels in the URL PATH, so a leak here is a live credential in a log line.
"""
from __future__ import annotations

import inspect
import json
from pathlib import Path
import traceback

import httpx
import pytest

from telegram_ingest import api
from telegram_ingest.api import (
    _RETRY_AFTER_FALLBACK_S,
    UNKNOWN_DESCRIPTION,
    TelegramAPIError,
    TelegramConflict,
    TelegramRetryAfter,
    TelegramUnauthorized,
    get_chat_member,
    get_me,
    get_updates,
    set_message_reaction,
)

TOKEN = "SECRET123"

# Telegram permits only a FIXED set of reaction emoji. It is defined by Telegram's servers,
# is not fetchable from the Bot API, and rejects everything outside it with
# `Bad Request: REACTION_INVALID` — so this is a hardcoded copy and there is deliberately no
# runtime lookup.
#
# It is a copy of what was MEASURED against the live API on 2026-08-02 (real bot, real
# group), NOT a transcription of Telegram's whole set. Writing out ~80 emoji from memory
# would be the same unverified guess that shipped this bug. Consequence: a permitted emoji
# that nobody has measured yet fails this pin, and the fix is to measure it, not to widen
# the set on faith.
#
# TO RE-VERIFY OR EXTEND: call `setMessageReaction` on a real message with the candidate —
# `ok: true` means permitted, `Bad Request: REACTION_INVALID` means rejected. Move the emoji
# into the matching set below and date the line.
_VERIFIED_PERMITTED_REACTIONS = frozenset({
    "👍",   # ok=True, 2026-08-02
    "🎉",   # ok=True, 2026-08-02
    "👌",   # ok=True, 2026-08-02
})
_MEASURED_REJECTED_REACTIONS = frozenset({
    "✅",   # ok=False REACTION_INVALID, 2026-08-02 — what the worker shipped with
})


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _responder(response: httpx.Response):
    """A transport handler that always returns `response`."""
    return lambda request: response


def _formatted(exc: BaseException) -> str:
    """The full traceback text a caller's `logger.exception(...)` would emit."""
    return "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))


# --- token safety -----------------------------------------------------------------


async def test_transport_error_never_leaks_the_token_in_str_or_traceback():
    def handler(request: httpx.Request) -> httpx.Response:
        # the token really is in the URL of the request that is about to fail
        assert TOKEN in str(request.url)
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_updates(client=_client(handler), token=TOKEN)

    assert TOKEN not in str(excinfo.value)
    assert TOKEN not in _formatted(excinfo.value)
    assert "getUpdates" in str(excinfo.value)
    assert "ConnectError" in str(excinfo.value)


async def test_url_bearing_httpx_error_is_not_chained_into_the_traceback():
    """`httpx.HTTPStatusError`'s own string IS the request URL, token and all.

    Chaining it — explicitly with `from exc`, or implicitly by raising inside the
    `except` block without `from None` — puts it in the formatted traceback, which is
    exactly what a caller's `logger.exception(...)` prints.
    """
    def handler(request: httpx.Request) -> httpx.Response:
        response = httpx.Response(400, request=request)
        raise httpx.HTTPStatusError(
            f"Client error '400 Bad Request' for url '{request.url}'",
            request=request,
            response=response,
        )

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_updates(client=_client(handler), token=TOKEN)

    assert TOKEN not in _formatted(excinfo.value)
    assert excinfo.value.__cause__ is None
    assert excinfo.value.__suppress_context__ is True


async def test_http_400_names_the_method_and_status_without_the_token():
    client = _client(_responder(httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": "Bad Request: chat not found"})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_chat_member(client=client, token=TOKEN, chat_id=-1001, user_id=7)

    assert "getChatMember" in str(excinfo.value)
    assert "400" in str(excinfo.value)
    assert TOKEN not in str(excinfo.value)
    assert TOKEN not in _formatted(excinfo.value)


# --- the response envelope --------------------------------------------------------


async def test_ok_false_on_http_200_still_raises():
    """A Bot API failure can arrive as HTTP 200 with `ok: false`; 2xx is not success."""
    client = _client(_responder(httpx.Response(
        200, json={"ok": False, "error_code": 403, "description": "Forbidden"})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_me(client=client, token=TOKEN)

    assert "403" in str(excinfo.value)


async def test_429_raises_retry_after_parsed_from_parameters():
    client = _client(_responder(httpx.Response(
        429, json={"ok": False, "error_code": 429, "parameters": {"retry_after": 12}})))

    with pytest.raises(TelegramRetryAfter) as excinfo:
        await get_updates(client=client, token=TOKEN)

    assert excinfo.value.retry_after == 12
    assert TOKEN not in str(excinfo.value)


async def test_429_without_parameters_falls_back_instead_of_raising_keyerror():
    client = _client(_responder(httpx.Response(429, json={"ok": False, "error_code": 429})))

    with pytest.raises(TelegramRetryAfter) as excinfo:
        await get_updates(client=client, token=TOKEN)

    assert excinfo.value.retry_after == _RETRY_AFTER_FALLBACK_S
    assert _RETRY_AFTER_FALLBACK_S > 0


async def test_409_raises_conflict_which_is_still_a_telegram_api_error():
    client = _client(_responder(httpx.Response(
        409, json={"ok": False, "error_code": 409,
                   "description": "Conflict: terminated by other getUpdates request"})))

    with pytest.raises(TelegramConflict) as excinfo:
        await get_updates(client=client, token=TOKEN)

    assert isinstance(excinfo.value, TelegramAPIError)
    assert TOKEN not in str(excinfo.value)


async def test_401_raises_unauthorized_which_is_still_a_telegram_api_error():
    """A 401 is as non-transient as a 409: a wrong or revoked token never fixes itself.

    Classifying it as a generic transport blip is what lets the worker back off politely
    forever, looking alive on every dashboard while ingesting nothing.
    """
    client = _client(_responder(httpx.Response(
        401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})))

    with pytest.raises(TelegramUnauthorized) as excinfo:
        await get_updates(client=client, token=TOKEN)

    assert isinstance(excinfo.value, TelegramAPIError)
    assert TOKEN not in str(excinfo.value)


async def test_401_on_http_200_is_also_unauthorized():
    """Telegram can answer `ok: false` with HTTP 200, so the envelope's `error_code` must
    discriminate too — the same both-paths rule the 409 and 429 branches already follow."""
    client = _client(_responder(httpx.Response(
        200, json={"ok": False, "error_code": 401, "description": "Unauthorized"})))

    with pytest.raises(TelegramUnauthorized):
        await get_me(client=client, token=TOKEN)


async def test_a_403_is_not_unauthorized():
    """Narrow on purpose. A 403 is "the bot was kicked from this chat" — per-chat and
    recoverable — while a 401 is the credential itself. Widening this would make one
    removed group look like a dead deployment."""
    client = _client(_responder(httpx.Response(
        403, json={"ok": False, "error_code": 403, "description": "Forbidden"})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_updates(client=client, token=TOKEN)

    assert not isinstance(excinfo.value, TelegramUnauthorized)


async def test_ok_true_without_a_result_list_raises_instead_of_returning_none():
    client = _client(_responder(httpx.Response(200, json={"ok": True})))

    with pytest.raises(TelegramAPIError):
        await get_updates(client=client, token=TOKEN)


# --- the four methods -------------------------------------------------------------


async def test_get_updates_returns_result_and_sends_the_long_poll_body():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"ok": True, "result": [{"update_id": 1}]})

    updates = await get_updates(client=_client(handler), token=TOKEN, offset=42, timeout_s=50)

    assert updates == [{"update_id": 1}]
    assert seen["url"] == f"https://api.telegram.org/bot{TOKEN}/getUpdates"
    assert seen["body"] == {"offset": 42, "timeout": 50, "allowed_updates": ["message"]}


async def test_get_updates_omits_offset_entirely_when_none():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"ok": True, "result": []})

    await get_updates(client=_client(handler), token=TOKEN, offset=None)

    assert "offset" not in seen["body"]  # absent, not present-as-null
    assert seen["body"] == {"timeout": 50, "allowed_updates": ["message"]}


async def test_set_message_reaction_sends_the_emoji_reaction_shape():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"ok": True, "result": True})

    result = await set_message_reaction(
        client=_client(handler), token=TOKEN, chat_id=-1001, message_id=77)

    assert result is None
    assert seen["url"] == f"https://api.telegram.org/bot{TOKEN}/setMessageReaction"
    # The literal, on purpose: reading the value back out of the signature would make this
    # assert only that the function sends whatever its own default happens to be.
    assert seen["body"] == {"chat_id": -1001, "message_id": 77,
                            "reaction": [{"type": "emoji", "emoji": "👍"}]}


async def test_set_message_reaction_raises_rather_than_swallowing():
    """Reactions are best-effort, but the *caller* decides that — it logs the WARN."""
    client = _client(_responder(httpx.Response(400, json={"ok": False, "error_code": 400})))

    with pytest.raises(TelegramAPIError):
        await set_message_reaction(client=client, token=TOKEN, chat_id=-1001, message_id=77)


# --- the reaction emoji is a Telegram-defined enum, and we shipped a value not in it ---


def test_the_default_reaction_emoji_is_one_telegram_actually_permits():
    """The whole incident, pinned. Shipped default was ✅, which Telegram rejects with
    `REACTION_INVALID`, so every acknowledgement the bot sent failed while ingestion looked
    perfect — and the reaction is this bot's ENTIRE user-facing surface.

    A unit test cannot ask Telegram, so it asserts against the measured copy above. RED on
    any edit to the default that has not been verified against the live API first, which is
    the only thing that would have caught this before deploy.
    """
    default = inspect.signature(set_message_reaction).parameters["emoji"].default

    assert default in _VERIFIED_PERMITTED_REACTIONS
    assert default not in _MEASURED_REJECTED_REACTIONS


def test_the_tick_that_shipped_is_pinned_as_rejected_so_reverting_to_it_fails():
    """Proves the pin above bites rather than passing vacuously.

    "Let's use ✅, it reads clearer" is the exact edit that must fail CI instead of shipping,
    and it only fails if the two sets are real and disjoint.
    """
    assert "✅" in _MEASURED_REJECTED_REACTIONS
    assert not (_VERIFIED_PERMITTED_REACTIONS & _MEASURED_REJECTED_REACTIONS)
    assert _VERIFIED_PERMITTED_REACTIONS


# --- the error description: allowlisted, never raw ---------------------------------


async def test_a_known_error_description_is_carried_as_the_matched_constant():
    """Diagnosability. `error=TelegramAPIError` alone cost a manual live API call to work
    out that the emoji was the problem; `detail=REACTION_INVALID` would have said it."""
    client = _client(_responder(httpx.Response(
        400, json={"ok": False, "error_code": 400,
                   "description": "Bad Request: REACTION_INVALID"})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await set_message_reaction(client=client, token=TOKEN, chat_id=-1001, message_id=77)

    assert excinfo.value.description == "REACTION_INVALID"
    # The exception MESSAGE is still method + status only; the description rides beside it.
    assert "REACTION_INVALID" not in str(excinfo.value)
    assert TOKEN not in _formatted(excinfo.value)


async def test_an_unmatched_description_is_replaced_by_unknown_and_never_carried():
    """The leak guard, fault-injected with the worst payload the field could hold.

    `description` is server text. Today it holds no URL — that is why carrying it at all is
    defensible — but the module's rule is that nothing leaves here unless we recognise it.
    An allowlist MISS must be indistinguishable from having no description.
    """
    leaky = f"Bad Request: https://api.telegram.org/bot{TOKEN}/setMessageReaction failed"
    client = _client(_responder(httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": leaky})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await set_message_reaction(client=client, token=TOKEN, chat_id=-1001, message_id=77)

    assert excinfo.value.description == UNKNOWN_DESCRIPTION
    assert TOKEN not in excinfo.value.description
    assert TOKEN not in str(excinfo.value)
    assert TOKEN not in _formatted(excinfo.value)


@pytest.mark.parametrize("description", [
    None, 42, True, ["REACTION_INVALID"], {"d": "REACTION_INVALID"},
])
async def test_a_non_string_description_is_unknown_rather_than_a_crash(description):
    """Boundary validation: `description` is whatever the wire sent, not whatever the docs
    promise. A `TypeError` from `in` here would replace a handled error with a crash."""
    client = _client(_responder(httpx.Response(
        400, json={"ok": False, "error_code": 400, "description": description})))

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_me(client=client, token=TOKEN)

    assert excinfo.value.description == UNKNOWN_DESCRIPTION


async def test_a_transport_failure_carries_no_description():
    """There is no Bot API envelope at all when the socket fails, so `unknown` is honest."""
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    with pytest.raises(TelegramAPIError) as excinfo:
        await get_updates(client=_client(handler), token=TOKEN)

    assert excinfo.value.description == UNKNOWN_DESCRIPTION


async def test_the_discriminated_subclasses_forward_the_description_too():
    """RED if `TelegramRetryAfter.__init__` drops the keyword on its way to the base: a 429
    is exactly where a caller wants both the backoff and the reason."""
    client = _client(_responder(httpx.Response(
        429, json={"ok": False, "error_code": 429, "parameters": {"retry_after": 3},
                   "description": "Too Many Requests: CHAT_WRITE_FORBIDDEN"})))

    with pytest.raises(TelegramRetryAfter) as excinfo:
        await set_message_reaction(client=client, token=TOKEN, chat_id=-1001, message_id=77)

    assert excinfo.value.retry_after == 3
    assert excinfo.value.description == "CHAT_WRITE_FORBIDDEN"


def test_the_constructor_clamps_a_description_the_allowlist_does_not_contain():
    """The invariant is structural, not a property of one call site.

    `_raise_api_failure` is the only thing that builds these today. A `raise
    TelegramAPIError(msg, description=payload["description"])` written next year by someone
    who never read `_matched_description` must still be safe, so the clamp lives in the
    constructor rather than in the mapper.
    """
    direct = TelegramAPIError("boom", description=f"Bad Request: {TOKEN}")
    subclass = TelegramRetryAfter("boom", 5.0, description=f"raw {TOKEN} text")

    assert direct.description == UNKNOWN_DESCRIPTION
    assert subclass.description == UNKNOWN_DESCRIPTION
    assert TelegramAPIError("boom").description == UNKNOWN_DESCRIPTION


def test_every_allowlisted_description_is_a_bare_constant_not_server_prose():
    """Entries must be the uppercase MTProto constant Telegram embeds, nothing more.

    An entry like `Bad Request: chat not found` would turn the allowlist into a prose
    matcher whose output an operator cannot audit, and would put server-written English
    into a log line by the back door.
    """
    assert api._SAFE_DESCRIPTIONS
    for known in api._SAFE_DESCRIPTIONS:
        assert known.isascii() and known.isupper()
        assert known.replace("_", "").isalnum()
    assert UNKNOWN_DESCRIPTION not in api._SAFE_DESCRIPTIONS


async def test_get_me_returns_the_result_dict():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"ok": True, "result": {"id": 42, "is_bot": True}})

    me = await get_me(client=_client(handler), token=TOKEN)

    assert me == {"id": 42, "is_bot": True}
    assert seen["url"] == f"https://api.telegram.org/bot{TOKEN}/getMe"


async def test_get_chat_member_returns_the_result_dict():
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.read())
        return httpx.Response(200, json={"ok": True, "result": {"status": "administrator"}})

    member = await get_chat_member(client=_client(handler), token=TOKEN, chat_id=-1001, user_id=7)

    assert member == {"status": "administrator"}
    assert seen["url"] == f"https://api.telegram.org/bot{TOKEN}/getChatMember"
    assert seen["body"] == {"chat_id": -1001, "user_id": 7}


# --- design pins ------------------------------------------------------------------


def test_module_exposes_no_message_sending_endpoint():
    """The bot is write-only-to-reactions by design: nothing to throttle, nothing to spam."""
    assert not hasattr(api, "send_message")
    source = Path(api.__file__).read_text(encoding="utf-8")
    assert "sendMessage" not in source
