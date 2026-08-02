"""The process entrypoint: `python -m telegram_ingest.worker`, a Render `type: worker`.

ASSEMBLY, NOT LOGIC. T1-T5 are the parts; this file constructs them, hands each one its
dependencies, and owns the process lifecycle. Deliberately NOT here: persistence,
reconciliation, a recovery sweep, a retry policy, or any state. The in-process queue is a
LATENCY optimization, not a durability mechanism — the `organize_jobs` row exists before
anything is enqueued, so a `QueueFull` or a worker crash simply means the EXISTING web
reaper (`main._reap_loop`, 120 s, global, unchanged) runs that job. Nothing to reconcile,
nothing to mark. If a later reader feels the urge to add recovery code here, that is the
answer: it already exists, globally, for every pending job including this worker's.

BOOT ORDERING IS LOAD-BEARING. `validate_required_secrets()` and `load_telegram_config()`
are the first two statements and sit outside every `try` — read the docstring of
`config_validation.py`, which explains at length why. A swallowed config error boots a
worker that fails on every reel with no clue why, while Render keeps the broken process
alive. Nothing is caught around them, so BOTH the loader's `RuntimeError` (an operator
error) and `TelegramConfig.__post_init__`'s `ValueError` (a fail-open allowlist) kill the
process; an `except RuntimeError` there would look careful and let the second one through.

Everything after the config is fatal-on-raise too, with exactly two exceptions: the admin
check (a Telegram blip must not stop a worker whose job is to poll Telegram) and the
per-job containment in `_consume` (guardrail #3). There is no broad `try` in this file.

TOKEN + CONTENT SAFETY. This process holds BOTH the bot token and the service-role key. It
logs `type(exc).__name__`, never `str(exc)`, never calls `logger.exception` and never
passes `exc_info` — pinned structurally in `test_worker.py`. Python sets `__context__` on
anything raised inside an `except` block and both the logging formatter and the interpreter's
own traceback print that chain, so a swallowed error leaks through even when the message
looks clean. The one `raise` inside an `except` here uses `from None` for that reason.

SHUTDOWN. SIGTERM -> stop polling -> drain with a deadline -> exit 0. A clean shutdown is
not a failure, and a non-zero exit makes Render's dashboard report a crash on every routine
deploy. Whatever is still in flight when the deadline passes holds a job lease that expires
in <=300 s and is reclaimed by the existing web reaper. That is the designed behaviour, not
a leak — do not "fix" it.
"""
from __future__ import annotations

import asyncio
import logging
import signal
from functools import partial
from typing import Any

import httpx

from config_validation import validate_required_secrets
from organizer import run_organize_job
from supabase_client import get_supabase_client
from telegram_ingest.api import get_chat_member, get_me
from telegram_ingest.config import TelegramConfig, load_telegram_config
from telegram_ingest.ingest import handle_update
from telegram_ingest.poller import poll_forever

logger = logging.getLogger(__name__)

# Long polling holds the socket open for the whole server-side timeout, so a client
# timeout of `poll_timeout_s` exactly would abort every idle poll. T1's functions take
# this client as a required keyword and never create or close one.
_HTTP_TIMEOUT_MARGIN_S = 15

# 60 s of Render's 120 s `maxShutdownDelaySeconds` (T9). The poller is cancelled outright
# rather than awaited, so the whole budget belongs to the drain, and the other 60 s is
# headroom for closing the HTTP client and for Render's own teardown. Longer buys almost
# nothing: one organize job outlives any deadline settable here, and whatever is still
# running holds a lease that the existing web reaper reclaims.
_DRAIN_DEADLINE_S = 60.0

# THE subscription, pinned at the wiring layer. `api.get_updates` defaults to the same
# tuple, but a default two layers down pins nothing: if it ever widened, `edited_message`
# and `channel_post` would silently start reaching `handle_update` — a free duplicate-spend
# path and a surface nobody reviewed. The process that constructs the dependencies is the
# place to say what the bot subscribes to.
_ALLOWED_UPDATES: tuple[str, ...] = ("message",)

# Telegram's own value. A bot cannot be a group's `creator`, so `administrator` is the only
# status that lifts privacy mode.
_ADMIN_STATUS = "administrator"

# `httpx` logs `HTTP Request: POST <url> "HTTP/1.1 200 OK"` at INFO — and the bot token is
# IN that URL (`/bot<token>/getUpdates`, api.py's whole docstring). Raising the root logger
# to INFO, which this worker MUST do to see its own events, would therefore print a live
# credential on every poll: ~1700 lines a day into Render's log retention. Verified
# empirically against the pinned httpx, not assumed. `httpcore` only logs at DEBUG today
# and carries no path, but it rides along so a root DEBUG session stays safe too.
_NOISY_TRANSPORT_LOGGERS = ("httpx", "httpcore")

_NOT_ADMIN_MESSAGE = (
    "telegram_bot_not_admin chat_id=%d status=%s: Telegram privacy mode hides plain-URL "
    "messages from a non-administrator bot, so this chat will deliver NOTHING and raise no "
    "error anywhere. Promote the bot to administrator in the group."
)


def _configure_logging() -> None:
    """A Render `type: worker` has no uvicorn and no `healthCheckPath`.

    Without this the root logger stays at WARNING and every INFO event this feature emits
    is invisible — including `telegram_poller_alive`, which is the ONLY liveness signal the
    service has. "Alive and idle" and "dead" would be the same silence.

    Called from `__main__`, never at import: a module that reconfigures logging on import
    would reach into the web service's own configuration the moment anything imports it.
    """
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    # NOT optional tidying — see `_NOISY_TRANSPORT_LOGGERS`. Deleting this line puts the
    # bot token in Render's logs on every poll.
    for name in _NOISY_TRANSPORT_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def _make_http_client(config: TelegramConfig) -> httpx.AsyncClient:
    """ONE long-lived client for the whole process, created once and closed on shutdown."""
    return httpx.AsyncClient(
        timeout=float(config.poll_timeout_s + _HTTP_TIMEOUT_MARGIN_S)
    )


async def _probe_ingest_user(db: Any, user_id: str) -> None:
    """The ONE boot probe: does `public.users` hold the ingest account?

    A wrong or absent UUID must kill the process here rather than fail on every reel for
    the life of the deploy. This feature has no user-facing surface, so "every reel fails
    silently" is a state nobody discovers for days.

    Exactly one probe, and deliberately NOT a probe of the per-user daily reel-analysis
    limit column or of the quota RPC — the worker reads neither. That decoupling is what
    lets T7's migration and T8's rollback ship with zero code coordination; probing that
    column here would make the rollback a code change and would silently destroy it. Do
    not add one "for safety". Its NAME is deliberately absent from this file so the
    invariant survives a grep, which is what `test_worker.py` asserts.

    A transport failure is fatal too (plan §T6 controller resolution): booting into a poll
    loop that will fail every reel is worse than crash-looping visibly, and Render's
    restart backoff already handles a transient outage.

    `.limit(1)`, not `.maybe_single()`: the latter's zero-row behaviour has version-to-
    version variation this repo already works around (`organizer.py:651`), while a plain
    list is unambiguous on every version — and this is a boot gate, not a read.
    """
    try:
        response = await (
            db.table("users").select("id").eq("id", user_id).limit(1).execute()
        )
        rows = response.data or []
    except Exception as exc:  # noqa: BLE001 — re-raised token-free as a fatal boot error
        # Type name only, and `from None`. A postgrest `APIError` embeds the request
        # detail and an unwrapped httpx error's `str()` can be the request URL; the
        # implicit `__context__` chain would print either above our clean-looking message
        # on the stderr of a process that is about to die.
        raise RuntimeError(f"Ingest user probe failed: {type(exc).__name__}") from None
    if not rows:
        # OUTSIDE the `except`, so nothing chains — `config.py`'s rule, same reason.
        raise RuntimeError("ASTRAIL_INGEST_USER_ID does not name a row in public.users")


async def _check_admin(*, config: TelegramConfig, http: httpx.AsyncClient) -> None:
    """Plan risk #2, and the single most valuable line in this file. WARNING, never fatal.

    Without administrator status, Telegram's privacy mode hides every plain-URL message
    from the bot: `getUpdates` returns nothing, no error is raised anywhere, and the
    deployment is indistinguishable from one that never happened. This WARNING turns that
    into a three-second diagnosis.

    Not fatal, at either granularity: a Telegram blip at boot must not stop a worker whose
    entire job is to poll Telegram until Telegram comes back.
    """
    try:
        me = await get_me(client=http, token=config.bot_token)
        bot_id = me.get("id")
    except Exception as exc:  # noqa: BLE001 — a blip must not block startup
        logger.warning("telegram_admin_check_failed error=%s", type(exc).__name__)
        return
    if isinstance(bot_id, bool) or not isinstance(bot_id, int):
        # `bool` excluded for the reason `ingest._chat_id` excludes it. Without this a
        # malformed getMe sends `user_id=None` to every getChatMember below and the
        # resulting failures read as "the bot is not an admin" — a confident diagnosis
        # pointing at the wrong problem, which is worse than none.
        logger.warning("telegram_admin_check_failed error=MalformedGetMe")
        return

    for chat_id in sorted(config.allowed_chat_ids):
        # Contained PER CHAT, not merely around the loop: one chat the bot was removed
        # from would otherwise abort the check for every chat after it, and an unchecked
        # chat is exactly the silent privacy-mode failure this check exists to catch.
        try:
            member = await get_chat_member(
                client=http, token=config.bot_token, chat_id=chat_id, user_id=bot_id
            )
            status = member.get("status")
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "telegram_admin_check_failed chat_id=%d error=%s",
                chat_id, type(exc).__name__,
            )
            continue
        if status != _ADMIN_STATUS:
            logger.warning(_NOT_ADMIN_MESSAGE, chat_id, status)


async def _consume(queue: asyncio.Queue, *, db: Any, user_id: str) -> None:
    """The single consumer. Runs one organize job at a time until cancelled.

    ONE consumer task = concurrency 1. No semaphore, no worker pool, no `gather` over N: a
    second consumer buys nothing (`run_organize_job` processes its items sequentially
    anyway) at a ceiling of ~100 reels/day, and would only widen the blast radius.

    A failed job is NOT re-enqueued. Its row is already in `organize_jobs` and the existing
    web reaper picks it up; re-enqueueing would start a private retry loop competing with
    the reaper. One failure never touches the next (guardrail #3).
    """
    while True:
        job_id = await queue.get()
        try:
            await run_organize_job(job_id, user_id, client=db)
        except Exception as exc:  # noqa: BLE001 — containment is the contract, not a smell
            # Type name only: this exception was raised while processing untrusted reel
            # content against the service-role client. `job_id` is a scalar and is safe.
            logger.error(
                "telegram_job_failed job_id=%s error=%s", job_id, type(exc).__name__
            )
        finally:
            # In a `finally`, always: `queue.join()` is what the drain waits on, so a
            # `task_done` skipped on the failure path burns the whole shutdown deadline on
            # a queue that is actually empty.
            queue.task_done()


def _install_signal_handlers(
    stop: asyncio.Event, *, loop: asyncio.AbstractEventLoop
) -> None:
    """SIGTERM (Render's deploy and scale-down signal) and SIGINT (a local Ctrl-C).

    `loop.add_signal_handler`, not `signal.signal`: the latter runs its callback in an
    interrupt context outside the loop's control. `loop` is a parameter rather than a
    `get_running_loop()` call inside, so the suite can prove both signals are registered
    without installing a real handler in the pytest process.
    """
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)


async def _cancel(task: asyncio.Task, *, event: str) -> None:
    """Cancel `task` and absorb its outcome. A NON-cancellation failure is loud.

    Both tasks this cancels contain their own failures, so `event` should never fire — but
    a background task that died silently leaves a process that is alive and doing nothing,
    which is the same undiagnosable silence as risk #2.
    """
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception as exc:  # noqa: BLE001 — shutdown must not raise; it must report
        logger.error("%s error=%s", event, type(exc).__name__)


async def _drain(queue: asyncio.Queue, *, deadline_s: float) -> None:
    """Wait for the consumer to finish what is already queued, but not forever."""
    try:
        await asyncio.wait_for(queue.join(), timeout=deadline_s)
    except TimeoutError:
        # Loud, never silent. What is left holds a lease that expires in <=300 s and is
        # reclaimed by the existing web reaper — designed behaviour, not a leak.
        logger.warning("telegram_drain_deadline_exceeded queued=%d", queue.qsize())


async def _run(
    config: TelegramConfig,
    *,
    http: httpx.AsyncClient,
    drain_deadline_s: float = _DRAIN_DEADLINE_S,
) -> None:
    """Boot, poll until stopped, drain, return. Returning IS the clean exit."""
    db = await get_supabase_client()
    await _probe_ingest_user(db, config.ingest_user_id)
    logger.info("telegram_ingest_user_ok")
    await _check_admin(config=config, http=http)

    stop = asyncio.Event()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=config.queue_maxsize)
    _install_signal_handlers(stop, loop=asyncio.get_running_loop())
    consumer = asyncio.create_task(_consume(queue, db=db, user_id=config.ingest_user_id))
    poller = asyncio.create_task(poll_forever(
        config=config,
        http=http,
        stop=stop,
        allowed_updates=_ALLOWED_UPDATES,
        handle=partial(handle_update, config=config, db=db, http=http, queue=queue),
    ))
    # A poller that returns or dies on its own must end the run too. Without this, a dead
    # poll loop leaves the process alive and silent forever — which reads to an operator
    # exactly like the privacy-mode failure `_check_admin` exists to prevent.
    poller.add_done_callback(lambda _task: stop.set())

    await stop.wait()

    logger.info("telegram_worker_draining queued=%d", queue.qsize())
    # CANCELLED, not awaited. `poll_forever` cannot observe `stop` until its in-flight
    # `getUpdates` returns, which is up to `poll_timeout_s` — most of Render's 120 s budget,
    # and that budget belongs to the drain. Abandoning the read loses nothing: the offset
    # only advances after a whole batch, so Telegram redelivers into idempotent upserts.
    await _cancel(poller, event="telegram_worker_poller_failed")
    await _drain(queue, deadline_s=drain_deadline_s)
    await _cancel(consumer, event="telegram_worker_consumer_failed")
    logger.info("telegram_worker_stopped")


async def main() -> None:
    """Boot the worker. Raises on a fatal misconfiguration; otherwise returns on SIGTERM."""
    validate_required_secrets()        # 1. FATAL. Outside every `try` — see the docstring.
    config = load_telegram_config()    # 2. FATAL. Outside every `try`, same reason.
    # Count, never the ids: the boot log is the one place a copy of the configuration
    # would sit forever.
    logger.info(
        "telegram_worker_starting chats=%d poll_timeout_s=%d queue_maxsize=%d",
        len(config.allowed_chat_ids), config.poll_timeout_s, config.queue_maxsize,
    )
    http = _make_http_client(config)
    try:
        await _run(config, http=http)
    finally:
        # In a `finally`: a worker that crash-loops on a boot failure would otherwise leak
        # a connection pool per restart.
        await http.aclose()


if __name__ == "__main__":   # pragma: no cover - the process entrypoint
    _configure_logging()
    asyncio.run(main())
