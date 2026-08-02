"""One Telegram update -> durable organize jobs. The bot's orchestration core.

Four statements per URL, hung off persistence seams that already exist. Deliberately NOT
here: a queue, a retry policy, a dedupe set, a state machine, a quota ledger, a throttle,
or any `send_message`. Every one of those is already provided by the system this module
calls into, and the plan spent four review rounds deleting the duplicates.

THE PINNED PROMISE, which is the whole design: *"✅ means every reel in that message was
accepted. No ✅ means re-share it or ping the operator."* One reaction per MESSAGE, and
only when the message is wholly clean — no rejected shape, no truncation, and every URL
durable. Reacting per URL (so a partial failure still looks accepted) and reacting on a
message that mixed a valid `/reel/` with an unsupported `/share/reel/` were both shipped
and both rejected in review. Absence of a tick is the signal, so the tick must be rare
and honest rather than encouraging.

NOT SILENT is the bar, not NEVER LOST (plan §3.1). ~100 reels/day, no user-facing surface,
and every containment path here logs at ERROR: a dropped reel is dropped *loudly* and a
human re-shares it. Guardrail #12 forbids the silent drop, which is the opposite.

TOKEN + CONTENT SAFETY. This module logs `type(exc).__name__`, never `str(exc)`, and
never calls `logger.exception` or passes `exc_info` — pinned structurally in
`test_ingest.py`. Python sets `__context__` on anything raised inside an `except` block
and the logging formatter prints that chain exactly like an explicit `__cause__`, so a
swallowed `APIError` carrying a URL, a row, or a service-role detail leaks through the
traceback even though the message looks clean. Swallowing does not erase.

Guardrail #11 — group chat content is untrusted, and `reel_filter` is its ONLY reader.
This module touches `chat`, `id`, `type` and `message_id`: envelope fields, never `text`,
`caption`, `from.username`, `from.first_name` or `chat.title`. Asserted from the AST. The
one non-scalar this module logs is a `url`, and it is always T2's normalized output —
`^https://www\\.instagram\\.com/reel/[A-Za-z0-9_-]+$`, rebuilt from a capture group, never
a string a group member wrote.

`handle_update` never raises. The poller has a backstop, but this is the layer that knows
enough to write a *useful* error line, so this is the layer that writes it.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from organizer import create_organize_job
from saved_reels import capture_saved_reel
from telegram_ingest.api import set_message_reaction
from telegram_ingest.config import TelegramConfig
from telegram_ingest.reel_filter import extract_reel_urls

logger = logging.getLogger(__name__)

# A bot in a private chat or a channel is a bot somewhere nobody agreed it should be. The
# allowlist is necessary but NOT sufficient: both must hold.
_GROUP_CHAT_TYPES = frozenset({"group", "supergroup"})

# Chat ids already reported as rejected. An unknown group that chats all day must cost one
# WARN, not one per message — the flood is what buries the `telegram_reel_dropped` lines
# somebody actually has to read. Process-local and never pruned: an entry is one int, and
# growing it requires a human to add the bot to another group.
_LOGGED_REJECTED_CHATS: set[int | None] = set()


def _chat_id(chat: dict) -> int | None:
    """The chat id, or None if the envelope does not carry a usable one.

    `bool` is excluded for the reason `reel_filter._entity_int` excludes it: `True == 1`
    in Python, so an untyped id would be admitted by any allowlist containing 1. Narrowing
    here also makes the id unconditionally hashable (the seen-set below) and a scalar safe
    to log — a raw `chat["id"]` could be a list, and `x in set()` on one raises.
    """
    value = chat.get("id")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _allowed_chat_id(message: dict, config: TelegramConfig) -> int | None:
    """The chat id if this message may be ingested, else None — logged once per chat.

    THIS GATE PRECEDES EVERY WRITE. Moving it after any DB call means a stranger's group
    spends Apify and OpenAI credits before anyone notices the bot was added, which is the
    worst failure mode this feature has. Nothing is ever sent back to a rejected chat:
    replying would confirm the bot is listening and turn an unknown group into a
    conversation.
    """
    chat = message.get("chat")
    chat = chat if isinstance(chat, dict) else {}
    chat_id = _chat_id(chat)
    if chat.get("type") in _GROUP_CHAT_TYPES and config.is_allowed_chat(chat_id):
        return chat_id
    if chat_id not in _LOGGED_REJECTED_CHATS:
        _LOGGED_REJECTED_CHATS.add(chat_id)
        logger.warning("telegram_chat_rejected chat_id=%s", chat_id)
    return None


def _enqueue(job_id: str, queue: asyncio.Queue) -> None:
    """Hand a created job to the worker's consumer. A full queue is NOT a failure.

    The job row already exists and is leased; `main._reap_loop` (120 s, global) picks up
    anything the in-process queue never carried. Treating `QueueFull` as a drop would cost
    the ✅ and make a human re-share a reel that was already durable.
    """
    try:
        queue.put_nowait(job_id)
    except asyncio.QueueFull:
        logger.warning("telegram_queue_full job_id=%s", job_id)


async def _ingest_url(
    url: str, *, config: TelegramConfig, db: Any, queue: asyncio.Queue, chat_id: int
) -> bool:
    """Make one URL durable. Returns True when it is; never raises (guardrail #3).

    The exception is contained HERE, per URL, rather than around the loop: one bad reel
    must not touch the next. It costs the message its ✅ and nothing else.

    `create_organize_job` gets a list of exactly ONE id, always. A batch resurrects the
    AS409 class the plan deleted — two reels shared in one message would each be
    "already being organized" by the other's job — and AS409 has no safe recovery here:
    the SQL counts `initializing` as active (`20260720130000:73`) while
    `recover_organize_jobs` lists only `pending` (`organizer.py:374`), so the claim that
    the reaper guarantees it runs is false. Hence no special case for it either: an
    unexpected AS409 takes the ordinary ERROR path and costs the tick.
    """
    try:
        row = await capture_saved_reel(db, config.ingest_user_id, url)
        job_id = await create_organize_job(db, config.ingest_user_id, [row["id"]])
        _enqueue(job_id, queue)
    except Exception as exc:  # noqa: BLE001 — containment is the contract, not a smell
        # Type name only. `str(exc)` on a postgrest APIError embeds the request detail.
        logger.error(
            "telegram_reel_dropped chat_id=%d url=%s error=%s",
            chat_id, url, type(exc).__name__,
        )
        return False
    # Folded `telegram_job_created` into this line: a second INFO carrying a strict subset
    # of these fields is noise at ~100 reels/day, and one record per accepted reel is the
    # unit an operator actually greps for.
    logger.info(
        "telegram_reel_accepted chat_id=%d url=%s job_id=%s", chat_id, url, job_id
    )
    return True


async def _react(
    message: dict, *, config: TelegramConfig, http: httpx.AsyncClient, chat_id: int
) -> None:
    """Tick the message. Best-effort, but a failure is LOGGED, never swallowed.

    A swallowed reaction error is indistinguishable from a real rejection: the operator
    sees no ✅ and re-shares. That re-share is harmless — a single-item job re-run is a
    cache hit with zero Apify/OpenAI charge — but an undiagnosable missing tick slowly
    turns the pinned promise into folklore.
    """
    message_id = message.get("message_id")
    try:
        await set_message_reaction(
            client=http, token=config.bot_token, chat_id=chat_id, message_id=message_id
        )
    except Exception as exc:  # noqa: BLE001 — a reaction must never abort ingestion
        logger.warning(
            "telegram_reaction_failed chat_id=%d message_id=%s error=%s",
            chat_id, message_id, type(exc).__name__,
        )


async def handle_update(
    update: dict,
    *,
    config: TelegramConfig,
    db: Any,
    http: httpx.AsyncClient,
    queue: asyncio.Queue,
) -> None:
    """Ingest one Telegram update. Never raises: every failure is logged and contained.

    Unconditionally, with no carve-out for a callee's contract: every call this function
    makes sits inside a containment boundary. `extract_reel_urls` is total by construction
    — pure, stdlib-only, pinned by `reel_filter`'s `_must_not_raise` suite — so its `try`
    catches a regression rather than an input; that context is worth knowing but is not
    what makes the claim true. Relying on it would have made the guarantee conditional on
    another module today and on the poller's unwritten loop tomorrow.

    `db` and `http` are separate because they are genuinely different clients — Supabase's
    and Telegram's — and keyword-only because the worker's wiring should read as a list of
    named dependencies rather than a positional tuple.
    """
    message = update.get("message") if isinstance(update, dict) else None
    # `message` ONLY. An `edited_message` re-triggering ingestion is a free duplicate-spend
    # path, and `channel_post` / `my_chat_member` are surfaces nobody reviewed.
    if not isinstance(message, dict) or not message:
        return
    chat_id = _allowed_chat_id(message, config)
    if chat_id is None:
        return

    try:
        result = extract_reel_urls(message)
    except Exception as exc:  # noqa: BLE001 — "never raises" has no carve-out
        # `reel_filter` is pure, stdlib-only and total by construction, so nothing an
        # envelope can contain reaches this line: what it catches is a REGRESSION in T2,
        # not an input. That is precisely why it belongs here. An unhandled crash makes
        # the blast radius depend on how the caller happens to wrap its loop, while this
        # is a loud, located ERROR (guardrail #12) from the layer that knows the chat id.
        # Type name only: a T2 failure can carry the candidate URL (its own §4.1 finding).
        logger.error(
            "telegram_reel_filter_failed chat_id=%d error=%s", chat_id, type(exc).__name__
        )
        return

    # ~99% of group traffic, and it must not log: chatter in the log is how the ERROR
    # lines below stop being read. `overflowed` is a SIGNAL, not an absence, so it must not
    # be swallowed here — an over-budget message looks exactly like chatter (`urls` and
    # `rejected_shapes` both empty) and may have carried real reels.
    if not result.urls and not result.rejected_shapes and not result.overflowed:
        return

    # The entity budget refused to parse the message, so any reel in it is gone. Loud, not
    # silent (guardrail #12): no count, because `FilterResult` reports the fact and not the
    # size, and 101 versus 5000 changes nothing the operator does about it.
    if result.overflowed:
        logger.error("telegram_reel_entities_overflowed chat_id=%d", chat_id)

    # REGARDLESS of whether `urls` is also non-empty. Consulting the shapes only when
    # `urls` is empty is the bug two review rounds shipped: it makes the T0 spike's blind
    # spot — Instagram's `/share/reel/` wrapper, which nobody can resolve offline —
    # disappear into a `ValueError` swallow instead of surfacing in production.
    if result.rejected_shapes:
        logger.error(
            "telegram_reel_unsupported_url chat_id=%d shapes=%s",
            chat_id, ",".join(result.rejected_shapes),
        )
    # `kept`, not `discarded`: FilterResult caps `urls` before returning and deliberately
    # does not carry the pre-cap count, so the number thrown away is not recoverable here.
    if result.truncated:
        logger.error(
            "telegram_reel_truncated chat_id=%d kept=%d", chat_id, len(result.urls)
        )

    all_durable = True
    for url in result.urls:
        if not await _ingest_url(url, config=config, db=db, queue=queue, chat_id=chat_id):
            all_durable = False

    # The conditions of the pinned promise, plus a non-empty `urls` so a message that
    # contained no reel at all is never ticked. Both `not result.overflowed` and the
    # `result.urls` clause are belt-and-braces — an overflow always empties `urls` — but
    # they state the rule here instead of depending on a return three branches away.
    if (result.urls and all_durable and not result.rejected_shapes
            and not result.truncated and not result.overflowed):
        await _react(message, config=config, http=http, chat_id=chat_id)
