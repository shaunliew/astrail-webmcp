"""The long-poll loop: getUpdates -> handle every update -> advance the offset. Repeat.

THE OFFSET RULE, which is the whole module. `offset` advances to `max(update_id) + 1`
only after EVERY update in the batch has been handled. Not per update, not before the
loop. A crash mid-batch therefore leaves the offset where it was and Telegram redelivers
the whole batch within 24 h, into upserts that are idempotent by construction
(`capture_saved_reel`, `create_organize_job`). `max`, never `len(updates)` and never
`updates[-1]["update_id"] + 1`: the Bot API does not contractually sort the list, and both
shortcuts are silently wrong on the day it does not.

NOT SILENT is the bar, not NEVER LOST (plan §3.1). A per-update failure is caught, logged
at ERROR, and the offset STILL advances — the reel is dropped *loudly* and a human
re-shares the URL. Never advancing on a poison update is an infinite redelivery loop, and
at ~100 reels/day with no user-facing surface that is strictly worse. Guardrail #12 forbids
the *silent* drop; every containment path here writes an ERROR, so deleting one of those
`logger.error` calls does not simplify this module, it repeals the decision it implements.

`handle` is caught anyway even though `handle_update` is specified never to raise. That is
a BACKSTOP, deliberately redundant: it costs one `try` and is the difference between one
bad update and a dead worker on the day T4's contract regresses or the worker binds a
different callable. `except Exception`, never `BaseException` — `asyncio.CancelledError`
derives from `BaseException` (verified on the pinned 3.14), so shutdown passes straight
through, and widening the catch would turn `task.cancel()` into a hang.

The poll has the same backstop, and that one is not redundant at all: `api._call` wraps
`httpx.HTTPError` and nothing else, so a closed `AsyncClient` (a bare `RuntimeError`, an
ordinary shutdown race) reaches this loop unclassified. Two more things here are total
rather than trusting: `_update_id` refuses a malformed batch element — `_expect_result`
guarantees a list, never the shape of its members, and a bare `u["update_id"]` would raise
OUTSIDE the per-update backstop and kill the worker — and a batch in which nothing carries
a usable id takes the transport backoff rather than re-requesting the same offset in a hot
loop.

409 CONFLICT is special-cased at ERROR. It means a second `getUpdates` consumer (a Render
`numInstances > 1` misconfiguration, or a local worker someone left running) or a webhook
that is still set. It is not transient and will not clear on its own. The loop keeps going
with backoff rather than exiting: exiting crash-loops the Render service, which reads as a
code fault and buries the one message that names the actual cause.

TOKEN + CONTENT SAFETY. This module logs `type(exc).__name__`, never `str(exc)`, and never
calls `logger.exception` or passes `exc_info` — pinned structurally in `test_poller.py`.
Python sets `__context__` on anything raised inside an `except` block and the formatter
prints that chain, so a swallowed error carrying chat content or a URL leaks through the
traceback even when the message looks clean. `update_id` is a scalar and is safe; the
update dict itself never reaches a log line.

`sleep`, `monotonic` and `random_` are injected so the suite exercises a 123-second backoff
ladder and a 60-second heartbeat without spending either. `handle` arrives already bound to
its `db`/`queue`/`http` dependencies, which is what keeps this module — and its tests —
ignorant of Supabase entirely.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from collections.abc import Awaitable, Callable, Sequence
from functools import partial
from typing import Any

import httpx

from telegram_ingest.api import (
    TelegramAPIError,
    TelegramConflict,
    TelegramRetryAfter,
    get_updates,
)
from telegram_ingest.config import TelegramConfig

logger = logging.getLogger(__name__)

_BACKOFF_START_S = 1.0
_BACKOFF_MAX_S = 60.0
# ±20 %. Small, because there is exactly one instance of this worker and nothing to
# thunder against; it exists so a Telegram-side outage does not produce a perfectly
# periodic retry pattern that an edge rate-limiter treats as a signature.
_JITTER_FRACTION = 0.2
# Telegram tells us exactly how long to wait on a 429. One second over is the friendlier
# direction to be wrong in; jitter is not applied at all, because guessing around a
# server-dictated delay can only make it wrong.
_RETRY_AFTER_MARGIN_S = 1.0
# A Render *worker* has no `healthCheckPath`. This line is the only liveness signal the
# service has, so it must fire on an idle loop too: "alive and idle" and "dead" are
# otherwise the same silence.
_HEARTBEAT_INTERVAL_S = 60.0

_CONFLICT_MESSAGE = (
    "telegram_poll_conflict backoff=%.1f: HTTP 409, a second getUpdates consumer "
    "(Render numInstances > 1, or a local worker still running) or a webhook is still set "
    "(call deleteWebhook). NOT transient - this will not clear on its own."
)


def _jitter(delay: float, random_: Callable[[], float]) -> float:
    """`delay` ±20 %. `random_()` in [0, 1) maps across the whole band."""
    return delay * (1.0 - _JITTER_FRACTION + 2.0 * _JITTER_FRACTION * random_())


def _log_poll_error(error: str, delay: float) -> None:
    """A transient transport failure. Type name only: `str(exc)` on a Bot API error is
    server-controlled text, and T1 already guarantees the type name is token-free."""
    logger.warning("telegram_poll_error error=%s backoff=%.1f", error, delay)


def _log_conflict(delay: float) -> None:
    """409 at ERROR, naming BOTH causes: an operator who has to guess spends an hour."""
    logger.error(_CONFLICT_MESSAGE, delay)


def _log_poll_unexpected(error: str, delay: float) -> None:
    """Anything `api.py` did not classify. NOT hypothetical: `api._call` wraps
    `httpx.HTTPError`, and an `AsyncClient` whose owner has already closed it raises a bare
    `RuntimeError` — precisely what a racy shutdown produces. Verified empirically.

    Type name only, and here it matters most: an unwrapped httpx exception is the one class
    of error whose `str()` can still be the request URL, and the bot token is IN that URL.
    """
    logger.error("telegram_poll_unexpected error=%s backoff=%.1f", error, delay)


def _log_offset_unresolved(size: int, delay: float) -> None:
    logger.error("telegram_poll_offset_unresolved size=%d backoff=%.1f", size, delay)


async def _back_off(
    backoff: float,
    *,
    sleep: Callable[[float], Awaitable[None]],
    random_: Callable[[], float],
    log: Callable[[float], None],
) -> float:
    """Log the delay we are about to take, take it, and return the NEXT rung.

    `log` is a callable rather than a level-and-message pair because the three paths that
    back off log three different events — a 409 is not a blip and must not read as one —
    while all three climb the same ladder: 1, 2, 4, 8, 16, 32, 60, 60, …
    """
    delay = _jitter(backoff, random_)
    log(delay)
    await sleep(delay)
    return min(backoff * 2.0, _BACKOFF_MAX_S)


def _maybe_heartbeat(
    last_beat: float, *, offset: int | None, monotonic: Callable[[], float]
) -> float:
    """Emit the liveness line if the interval has elapsed; return the new `last_beat`.

    Carries the offset so the log shows forward *progress*, not just a pulse: an offset
    frozen across heartbeats is a bot that is polling fine and ingesting nothing.
    """
    now = monotonic()
    if now - last_beat < _HEARTBEAT_INTERVAL_S:
        return last_beat
    logger.info("telegram_poller_alive offset=%s", offset)
    return now


def _update_id(update: Any) -> int | None:
    """The `update_id`, or None if this element does not carry a usable one.

    `_expect_result` guarantees `getUpdates` returned a LIST; it says nothing about the
    elements. Reaching straight into `update["update_id"]` therefore raises out of the
    poll loop — outside the per-update backstop, which is why it would kill the worker
    rather than drop one update. `bool` is excluded for the reason `ingest._chat_id`
    excludes it: `True == 1`, so `True` would be admitted as update id 1 and the offset
    would jump to 2.
    """
    if not isinstance(update, dict):
        return None
    value = update.get("update_id")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _next_offset(updates: Sequence[Any]) -> int | None:
    """`max(update_id) + 1` over the usable elements, or None if there are none."""
    ids = [i for i in (_update_id(u) for u in updates) if i is not None]
    return max(ids) + 1 if ids else None


async def _handle_batch(
    updates: Sequence[Any], handle: Callable[[dict], Awaitable[None]]
) -> None:
    """Run every update through `handle`. One failure never touches the next.

    The `except` is a BACKSTOP — `handle_update` is specified never to raise — and the
    `logger.error` is not optional decoration: it IS §3.1's "loud, not lossless" trade.
    A caught exception with no ERROR record is the silent drop guardrail #12 forbids.
    """
    for update in updates:
        try:
            await handle(update)
        except Exception as exc:  # noqa: BLE001 - containment is the contract, not a smell
            # Type name only, and `update_id` rather than the update: the exception was
            # raised while handling untrusted group content and may carry it.
            logger.error(
                "telegram_update_failed update_id=%s error=%s",
                _update_id(update), type(exc).__name__,
            )


async def poll_forever(
    *,
    config: TelegramConfig,
    http: httpx.AsyncClient,
    handle: Callable[[dict], Awaitable[None]],
    stop: asyncio.Event,
    allowed_updates: tuple[str, ...] = ("message",),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    random_: Callable[[], float] = random.random,
) -> None:
    """Long-poll Telegram until `stop` is set. Returns only on a clean stop.

    `backoff` holds the NEXT delay to use on failure, and is reset on a successful poll
    *before* the batch is handled: a handler failure is not a transport failure, and
    without the reset one blip pins the poller at 60 s polling for the life of the process.

    `allowed_updates` is FORWARDED rather than left to `get_updates`' identical default.
    A default two layers down pins nothing: if it ever widened, `edited_message` and
    `channel_post` would silently start reaching `handle` — a free duplicate-spend path
    and a surface nobody reviewed. `worker._ALLOWED_UPDATES` is where the subscription is
    stated, because the process that constructs the dependencies is what owns it.
    """
    offset: int | None = None
    backoff = _BACKOFF_START_S
    last_beat = monotonic()

    while not stop.is_set():
        last_beat = _maybe_heartbeat(last_beat, offset=offset, monotonic=monotonic)
        try:
            updates = await get_updates(
                client=http,
                token=config.bot_token,
                offset=offset,
                timeout_s=config.poll_timeout_s,
                allowed_updates=allowed_updates,
            )
        # Ordered narrowest-first: both are subclasses of TelegramAPIError, and a generic
        # clause above them would silently swallow the 409's diagnosis.
        except TelegramConflict:
            backoff = await _back_off(
                backoff, sleep=sleep, random_=random_, log=_log_conflict
            )
        except TelegramRetryAfter as exc:
            # Bypasses the ladder entirely and does not advance it.
            delay = exc.retry_after + _RETRY_AFTER_MARGIN_S
            _log_poll_error(type(exc).__name__, delay)
            await sleep(delay)
        except TelegramAPIError as exc:
            backoff = await _back_off(
                backoff, sleep=sleep, random_=random_,
                log=partial(_log_poll_error, type(exc).__name__),
            )
        except Exception as exc:  # noqa: BLE001 - the loop must outlive its transport
            # The symmetric partner of `_handle_batch`'s backstop, and reachable for the
            # same kind of reason: `api._call` classifies `httpx.HTTPError` and nothing
            # else, so a closed client, an anyio error or a bug in T1 arrives here
            # unclassified. Without this the worker dies on it, and Render restarts a
            # process whose logs end mid-sentence. `Exception`, never `BaseException`.
            backoff = await _back_off(
                backoff, sleep=sleep, random_=random_,
                log=partial(_log_poll_unexpected, type(exc).__name__),
            )
        else:
            backoff = _BACKOFF_START_S
            if not updates:
                continue
            await _handle_batch(updates, handle)
            next_offset = _next_offset(updates)
            if next_offset is None:
                # Nothing in the batch carried a usable id, so no offset can be computed.
                # Keeping the old one would redeliver this batch immediately and forever
                # (pending updates return without waiting out the long-poll timeout), so
                # this takes the transport backoff — loudly, never silently.
                backoff = await _back_off(
                    backoff, sleep=sleep, random_=random_,
                    log=partial(_log_offset_unresolved, len(updates)),
                )
                continue
            offset = next_offset

    logger.info("telegram_poller_stopped offset=%s", offset)
