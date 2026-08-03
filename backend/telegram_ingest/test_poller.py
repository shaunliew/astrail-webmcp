"""poller — the long-poll loop. Offline, credential-free, and with NO wall-clock time.

Four conventions carry the weight here:

  - **No test may sleep or read a real clock.** `sleep` and `monotonic` are injected, so
    the backoff ladder (which spans 123 real seconds) and the 60 s heartbeat are exercised
    in microseconds. `_FakeSleep` advances `_Clock` by exactly what it was asked to sleep,
    so the fake pair behaves like the real pair rather than like two unrelated dials.
  - **The script drives termination, not a counter.** `_FakeUpdates` sets `stop` when its
    script runs out, so a test says what the transport does and never has to keep a poll
    count in sync with it.
  - **One ordered trace.** Polls and handled updates append to the same list, so
    "the offset advanced only after the whole batch" is asserted from the interleaving
    rather than inferred.
  - **Canaries are proved reachable.** `test_the_canary_reaches_the_log_when_the_module_is_
    careless` reproduces the leak shape against a throwaway logger, so the containment
    test above it is not asserting a vacuous truth (the exact defect that shipped in T3).

`get_updates` is monkeypatched onto the module rather than injected as a parameter: the
brief pins `poll_forever`'s signature, `poller` holds it as a module-level name, and
module attributes are the seam `test_ingest.py` and `test_capture.py` already use for
module-level function references. `sleep`/`monotonic`/`random_` ARE parameters because
they are the poller's own dials, not a collaborator it happens to import.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import logging
import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from telegram_ingest import poller
from telegram_ingest.api import (
    TelegramAPIError,
    TelegramConflict,
    TelegramRetryAfter,
    TelegramUnauthorized,
)
from telegram_ingest.config import TelegramConfig

GROUP_CHAT_ID = -1001234567890
INGEST_USER_ID = "11111111-2222-3333-4444-555555555555"
POLL_TIMEOUT_S = 7          # not api.get_updates' default 50: proves config is consulted
PRODUCTION_POLL_TIMEOUT_S = 50   # TelegramConfig's default — what the worker really runs
CANARY_TEXT = "CANARY-SECRET"

HTTP = object()             # opaque: the poller forwards it and never introspects it


# --------------------------------------------------------------------------------------
# Fakes.
# --------------------------------------------------------------------------------------
class _Clock:
    """A hand-advanced monotonic clock. Nothing in this file reads wall time."""

    def __init__(self, now: float = 0.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class _FakeSleep:
    """Records what the poller WOULD have slept, and advances the clock by it.

    Advancing is not decoration: a real `asyncio.sleep(60)` moves `time.monotonic` by 60,
    so a fake that froze the clock would let a backoff test silently assert against a
    heartbeat schedule that cannot happen in production.
    """

    def __init__(self, clock: _Clock) -> None:
        self.durations: list[float] = []
        self._clock = clock

    async def __call__(self, seconds: float) -> None:
        self.durations.append(seconds)
        self._clock.advance(seconds)


class _BeatTimes(logging.Handler):
    """Stamps every `telegram_poller_alive` with the FAKE clock.

    `caplog` records carry wall-clock times, which are meaningless in a suite that never
    advances one. Counting beats is not enough for the cadence claim — "two beats" is
    equally true at 60 s and at 100 s — so the assertion needs the instants themselves.

    Given the rig's `trace` it also writes each beat into that ONE ordered list beside the
    polls, which is what lets a test say "the beat came BEFORE the first poll" rather than
    "a beat happened at t=0" — a beat at t=0 is also what a zero-duration first poll would
    produce, so the instant alone does not discriminate.
    """

    def __init__(self, clock: _Clock, trace: list[tuple[str, Any]] | None = None) -> None:
        super().__init__()
        self._clock = clock
        self._trace = trace
        self.times: list[float] = []

    def emit(self, record: logging.LogRecord) -> None:
        if record.getMessage().startswith("telegram_poller_alive"):
            self.times.append(self._clock.now)
            if self._trace is not None:
                self._trace.append(("beat", self._clock.now))


class _FakeUpdates:
    """`api.get_updates` — scripted per call, recording exactly what it was asked for.

    A step is either a list of updates to return or an exception to raise. When the script
    runs out it sets `stop` and returns `[]`, so every test terminates on its own script.
    That last call is not waste: it is how a test observes the offset the NEXT poll would
    have used, which is the only channel the offset is visible through.

    `stop_after` exists because that terminating success is a blind spot for any test about
    a permanently failing transport — found by fault injection, not by reading: moving the
    heartbeat into the success path left `test_heartbeat_keeps_firing_while_the_transport_
    is_failing` green, because the fake's own last call succeeded. With `stop_after=n` the
    nth call stops the loop and still runs its step, so a run can fail from end to end.
    """

    def __init__(
        self,
        script: Sequence[list[Any] | BaseException],
        *,
        stop: asyncio.Event,
        trace: list[tuple[str, Any]] | None = None,
        clock: _Clock | None = None,
        advance: float = 0.0,
        stop_after: int | None = None,
    ) -> None:
        self._script = list(script)
        self._stop = stop
        self._stop_after = stop_after
        self._trace = trace if trace is not None else []
        self._clock = clock
        self._advance = advance
        self.offsets: list[int | None] = []
        self.timeouts: list[int] = []
        self.tokens: list[str] = []
        self.clients: list[Any] = []
        self.subscriptions: list[tuple[str, ...]] = []

    async def __call__(
        self,
        *,
        client: Any,
        token: str,
        offset: int | None = None,
        timeout_s: int = 50,
        allowed_updates: tuple[str, ...] = ("message",),
    ) -> list[Any]:
        self.offsets.append(offset)
        self.timeouts.append(timeout_s)
        self.tokens.append(token)
        self.clients.append(client)
        self.subscriptions.append(allowed_updates)
        self._trace.append(("poll", offset))
        if self._clock is not None and self._advance:
            self._clock.advance(self._advance)   # the long poll held the socket this long
        if self._stop_after is not None and len(self.offsets) >= self._stop_after:
            self._stop.set()                     # this call still runs its step
        if not self._script:
            self._stop.set()
            return []
        step = self._script.pop(0)
        if isinstance(step, BaseException):
            raise step
        return step


class _FakeHandle:
    """The bound `handle_update`. Raises per `update_id` so one update can poison a batch."""

    def __init__(
        self,
        *,
        raises: dict[int | None, BaseException] | None = None,
        trace: list[tuple[str, Any]] | None = None,
    ) -> None:
        self.seen: list[Any] = []
        self._raises = raises or {}
        self._trace = trace if trace is not None else []

    async def __call__(self, update: dict) -> None:
        self.seen.append(update)
        key = update.get("update_id") if isinstance(update, dict) else None
        self._trace.append(("handle", key))
        exc = self._raises.get(key)
        if exc is not None:
            raise exc

    @property
    def ids(self) -> list[Any]:
        return [u.get("update_id") if isinstance(u, dict) else u for u in self.seen]


def _update(update_id: Any, *, text: str = "hello") -> dict:
    """A minimal envelope. The poller reads `update_id` and forwards the rest untouched."""
    return {
        "update_id": update_id,
        "message": {"message_id": 1, "chat": {"id": GROUP_CHAT_ID, "type": "supergroup"},
                    "text": text},
    }


def _formatted(caplog: pytest.LogCaptureFixture) -> str:
    """Every record as `logging` would emit it, INCLUDING any attached traceback.

    `Formatter.format` appends `formatException(record.exc_info)`, so a leak through
    `logger.exception` / `exc_info=True` — which print the whole `__context__` chain —
    lands in this string. `record.getMessage()` alone would not see it.
    """
    formatter = logging.Formatter("%(levelname)s %(message)s")
    return "\n".join(formatter.format(record) for record in caplog.records)


def _records(caplog: pytest.LogCaptureFixture, event: str) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.getMessage().startswith(event)]


@pytest.fixture
def config() -> TelegramConfig:
    return TelegramConfig(
        bot_token="123456:CANARY-BOT-TOKEN",
        allowed_chat_ids=frozenset({GROUP_CHAT_ID}),
        ingest_user_id=INGEST_USER_ID,
        poll_timeout_s=POLL_TIMEOUT_S,
    )


class _Rig:
    """Everything a test needs to drive one `poll_forever` run."""

    def __init__(self, config: TelegramConfig, monkeypatch: pytest.MonkeyPatch,
                 script: Sequence[list[Any] | BaseException], *,
                 raises: dict[int | None, BaseException] | None = None,
                 advance: float = 0.0,
                 stop_after: int | None = None,
                 random_: Any = None) -> None:
        self.trace: list[tuple[str, Any]] = []
        self.stop = asyncio.Event()
        self.clock = _Clock()
        self.sleep = _FakeSleep(self.clock)
        self.updates = _FakeUpdates(script, stop=self.stop, trace=self.trace,
                                    clock=self.clock, advance=advance,
                                    stop_after=stop_after)
        self.handle = _FakeHandle(raises=raises, trace=self.trace)
        self._config = config
        self._random = random_
        monkeypatch.setattr(poller, "get_updates", self.updates)

    async def run(self) -> None:
        kwargs: dict[str, Any] = {}
        if self._random is not None:
            kwargs["random_"] = self._random
        await poller.poll_forever(
            config=self._config,
            http=HTTP,
            handle=self.handle,
            stop=self.stop,
            sleep=self.sleep,
            monotonic=self.clock,
            **kwargs,
        )


def _rig(config: TelegramConfig, monkeypatch: pytest.MonkeyPatch,
         script: Sequence[list[Any] | BaseException], **kwargs: Any) -> _Rig:
    return _Rig(config, monkeypatch, script, **kwargs)


# --------------------------------------------------------------------------------------
# 1. The offset advances only after the whole batch is handled.
# --------------------------------------------------------------------------------------
async def test_offset_advances_only_after_the_whole_batch_is_handled(
    config, monkeypatch, caplog
):
    """★ The §3.1 decision, end to end: a poison update in the middle of a batch.

    RED if the per-update `except` is deleted (update 12 never handled, the loop dies),
    if its ERROR is deleted (the drop becomes silent, which guardrail #12 forbids), or if
    the offset is not advanced past the poison update (infinite redelivery).
    """
    batch = [_update(10), _update(11), _update(12)]
    rig = _rig(config, monkeypatch, [batch], raises={11: RuntimeError("poison")})

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert rig.handle.ids == [10, 11, 12]                     # the loop continued
    assert rig.trace == [("poll", None), ("handle", 10), ("handle", 11), ("handle", 12),
                         ("poll", 13)]                        # no poll mid-batch
    failed = _records(caplog, "telegram_update_failed")
    assert len(failed) == 1
    assert "update_id=11" in failed[0].getMessage()
    assert failed[0].levelno == logging.ERROR


def test_the_offset_is_assigned_after_the_batch_is_handled_in_source_order():
    """★ The half of rule 1 that no black-box test can see.

    Hoisting `offset = _next_offset(...)` above `await _handle_batch(...)` changes nothing
    observable in-process — the next `get_updates` still happens after the loop either
    way — but it is exactly the mid-batch-crash bug the rule exists to prevent: Telegram
    would not redeliver a batch the process died halfway through. So it is pinned from the
    source. RED the moment the two statements are swapped.
    """
    handled: list[int] = []
    assigned: list[int] = []
    for node in ast.walk(_poll_forever_tree()):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id == "_handle_batch":
                handled.append(node.lineno)
            if node.func.id == "_next_offset":
                assigned.append(node.lineno)
    assert handled, "poll_forever no longer calls _handle_batch"
    assert assigned, "poll_forever no longer calls _next_offset"
    assert max(handled) < min(assigned), "the offset is computed before the batch is handled"


async def test_the_offset_advances_past_the_update_the_handler_could_not_process(
    config, monkeypatch, caplog
):
    """★ Rule 3's actual consequence, and the half the mid-batch poison cannot show.

    The failing update carries the MAX id, so "advance past everything" and "advance past
    what succeeded" finally disagree: 202 versus 201. The second is the infinite
    redelivery loop §3.1 rejects — Telegram re-sends 201 forever, the handler fails on it
    forever, and no other reel in the group is ever ingested again.

    Found by fault injection, not by reading: an implementation that advanced only past
    successful updates passed the ENTIRE inherited suite, because every poison in it was
    either mid-batch (test 1: `max` is 12, which succeeded) or alone in its batch (where
    the empty result falls into the offset-unresolved path instead).
    """
    rig = _rig(config, monkeypatch, [[_update(200), _update(201)], []],
               raises={201: RuntimeError("poison")})

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert rig.updates.offsets == [None, 202, 202]
    failed = _records(caplog, "telegram_update_failed")
    assert len(failed) == 1 and "update_id=201" in failed[0].getMessage()


# --------------------------------------------------------------------------------------
# 2. max(update_id) + 1 — never len(), never updates[-1].
# --------------------------------------------------------------------------------------
async def test_offset_is_max_update_id_plus_one_on_an_out_of_order_batch(
    config, monkeypatch
):
    """★ A batch delivered out of order. `getUpdates` does not contractually sort.

    The max sits in the MIDDLE, which is the whole design of the fixture: the three wrong
    answers must all differ from the right one and from each other. `len(updates)` gives 3,
    `updates[-1]["update_id"] + 1` gives 105, `updates[0]["update_id"] + 1` gives 104, and
    only `max + 1` gives 106. Fault injection found this: with the max FIRST — the shape
    this fixture had — the `updates[0]` mutant passes, and the repo trap in the brief
    ("a fixture already in the asserted order proves nothing") applies to the first element
    exactly as much as to the last.
    """
    batch = [_update(103), _update(105), _update(104)]
    rig = _rig(config, monkeypatch, [batch])

    await rig.run()

    assert rig.updates.offsets == [None, 106]


# --------------------------------------------------------------------------------------
# 3-5. Backoff.
# --------------------------------------------------------------------------------------
async def test_backoff_resets_to_one_second_on_the_first_successful_poll(
    config, monkeypatch
):
    """★ The "permanently 60 s after one blip" bug.

    Three failures, a success, then a failure: the last sleep must be ~1 s, not ~8 s.
    RED when `backoff = _BACKOFF_START_S` is deleted from the success path.
    """
    boom = TelegramAPIError("Telegram getUpdates failed: HTTP 502 (error_code=502)")
    rig = _rig(config, monkeypatch, [boom, boom, boom, [], boom])

    await rig.run()

    ladder = rig.sleep.durations
    assert len(ladder) == 4
    for actual, base in zip(ladder, [1.0, 2.0, 4.0, 1.0], strict=True):
        assert 0.8 * base <= actual <= 1.2 * base, ladder


async def test_backoff_climbs_the_ladder_and_caps_at_sixty_seconds(config, monkeypatch):
    """The ladder `1,2,4,8,16,32,60,60,60` with ±20 % jitter, capped.

    RED if the cap is dropped (the 8th sleep would be 128 s) or the doubling is wrong.
    """
    boom = TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)")
    expected = [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 60.0, 60.0, 60.0]
    rig = _rig(config, monkeypatch, [boom] * len(expected))

    await rig.run()

    assert len(rig.sleep.durations) == len(expected)
    for actual, base in zip(rig.sleep.durations, expected, strict=True):
        assert 0.8 * base <= actual <= 1.2 * base, rig.sleep.durations
    assert max(rig.sleep.durations) <= 60.0 * 1.2


@pytest.mark.parametrize("draw, factor", [(0.0, 0.8), (0.5, 1.0), (0.9999999, 1.2)])
async def test_jitter_spans_exactly_plus_or_minus_twenty_percent(
    config, monkeypatch, draw, factor
):
    """The ±20 % band, pinned exactly by feeding the random source its extremes.

    The band tests above pass for ANY jitter inside it, including none at all; this one
    fails if the fraction is widened, narrowed, or made one-sided.
    """
    boom = TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)")
    rig = _rig(config, monkeypatch, [boom, boom], random_=lambda: draw)

    await rig.run()

    assert rig.sleep.durations == pytest.approx([1.0 * factor, 2.0 * factor])


async def test_retry_after_bypasses_the_ladder_and_does_not_advance_it(
    config, monkeypatch
):
    """Telegram named the delay: sleep `retry_after + 1` EXACTLY — no jitter, no ladder.

    Jittering a server-dictated delay can only make it wrong in one of two directions;
    guessing longer than Telegram asked is the friendlier error, hence `+1` and nothing
    else. The following generic failure must still sleep ~1 s: the 429 left the ladder
    where it found it. RED if 429 falls through to the generic branch (~1 s then ~2 s).
    """
    rig = _rig(config, monkeypatch, [
        TelegramRetryAfter("Telegram getUpdates failed: HTTP 429 (error_code=429)", 12.0),
        TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)"),
    ])

    await rig.run()

    assert rig.sleep.durations[0] == 13.0
    assert 0.8 <= rig.sleep.durations[1] <= 1.2, rig.sleep.durations


async def test_retry_after_is_logged_as_a_transient_poll_error(config, monkeypatch, caplog):
    """A 429 the operator cannot see is a rate limit nobody diagnoses. Type name only —
    never `str(exc)`, whose text is server-controlled."""
    rig = _rig(config, monkeypatch, [
        TelegramRetryAfter("Telegram getUpdates failed: HTTP 429 (error_code=429)", 3.0),
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    errors = _records(caplog, "telegram_poll_error")
    assert len(errors) == 1
    assert "TelegramRetryAfter" in errors[0].getMessage()
    assert errors[0].levelno == logging.WARNING


# --------------------------------------------------------------------------------------
# 6. 409 Conflict — not transient, and not a generic poll error.
# --------------------------------------------------------------------------------------
async def test_conflict_logs_its_own_error_event_and_keeps_looping(
    config, monkeypatch, caplog
):
    """★ 409 is a Render `numInstances > 1` or a leftover webhook — an operator action,
    not a blip. RED if it is folded into the generic `TelegramAPIError` branch: the event
    name is what a human greps for, and a WARN named `telegram_poll_error` sends them
    looking for a network problem that does not exist.
    """
    rig = _rig(config, monkeypatch, [
        TelegramConflict("Telegram getUpdates failed: HTTP 409 (error_code=409)"),
        [_update(1)],
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    conflicts = _records(caplog, "telegram_poll_conflict")
    assert len(conflicts) == 1
    assert conflicts[0].levelno == logging.ERROR
    named = conflicts[0].getMessage().lower()
    assert "getupdates" in named and "webhook" in named   # both causes, by name
    assert not _records(caplog, "telegram_poll_error")
    assert rig.handle.ids == [1]                          # the loop survived it
    assert 0.8 <= rig.sleep.durations[0] <= 1.2           # and backed off


async def test_unauthorized_logs_its_own_error_event_and_keeps_looping(
    config, monkeypatch, caplog
):
    """★ 401 is a wrong or revoked bot token — an operator action, not a blip, exactly
    like 409.

    RED if it folds into the generic `TelegramAPIError` branch. That fold is the whole
    defect: a typo'd token would WARN as `telegram_poll_error`, climb to a 60 s ladder,
    and keep the heartbeat firing — so the worker reads as alive on every dashboard while
    ingesting nothing, permanently. The event NAME and the ERROR level are what make it
    visible, so both are asserted here, and `telegram_poll_error` must NOT appear.
    """
    rig = _rig(config, monkeypatch, [
        TelegramUnauthorized("Telegram getUpdates failed: HTTP 401 (error_code=401)"),
        [_update(1)],
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    unauthorized = _records(caplog, "telegram_poll_unauthorized")
    assert len(unauthorized) == 1
    assert unauthorized[0].levelno == logging.ERROR
    named = unauthorized[0].getMessage().lower()
    assert "revoked" in named and "telegram_bot_token" in named   # both causes, by name
    assert not _records(caplog, "telegram_poll_error")
    assert not _records(caplog, "telegram_poll_conflict")
    assert rig.handle.ids == [1]                          # the loop survived it
    assert 0.8 <= rig.sleep.durations[0] <= 1.2           # and backed off
    assert "CANARY" not in _formatted(caplog), _formatted(caplog)


async def test_a_generic_api_error_is_still_a_transient_poll_error(
    config, monkeypatch, caplog
):
    """The other half of the 401 split, without which the test above would pass for a
    poller that logged `telegram_poll_unauthorized` for EVERY `TelegramAPIError`.

    A 500 from Telegram's edge really is a blip and must stay a WARNING: promoting every
    transport hiccup to ERROR is how the 401 line stops being read.
    """
    rig = _rig(config, monkeypatch, [
        TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)"),
        [_update(1)],
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    errors = _records(caplog, "telegram_poll_error")
    assert len(errors) == 1 and errors[0].levelno == logging.WARNING
    assert not _records(caplog, "telegram_poll_unauthorized")


async def test_an_unclassified_transport_exception_does_not_kill_the_loop(
    config, monkeypatch, caplog
):
    """★ An exception `api.py` never classified. Reachable, not hypothetical: `api._call`
    wraps `httpx.HTTPError` and nothing else, and posting on an `AsyncClient` its owner has
    already closed raises a bare `RuntimeError` — an ordinary shutdown race.

    RED if the `except Exception` on the poll is deleted: the worker dies mid-batch and
    Render restarts a process whose logs end mid-sentence. The canary is in the exception
    message because this is the one path whose `str(exc)` can be a URL — and the bot token
    lives in that URL.
    """
    rig = _rig(config, monkeypatch, [
        RuntimeError(f"Cannot send a request: {CANARY_TEXT}"),
        [_update(70)],
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    unexpected = _records(caplog, "telegram_poll_unexpected")
    assert len(unexpected) == 1 and unexpected[0].levelno == logging.ERROR
    assert "RuntimeError" in unexpected[0].getMessage()
    assert "CANARY" not in _formatted(caplog), _formatted(caplog)
    assert rig.handle.ids == [70]                         # the loop survived it
    assert 0.8 <= rig.sleep.durations[0] <= 1.2


# --------------------------------------------------------------------------------------
# 7. A handler exception never kills the loop and is never silent.
# --------------------------------------------------------------------------------------
async def test_a_handler_exception_is_contained_and_never_silent(
    config, monkeypatch, caplog
):
    """★ Two assertions, and the second is the one §3.1 depends on.

    Containment alone would satisfy "the worker stays up" while quietly losing reels —
    which is precisely the silent drop guardrail #12 forbids. RED if either the `except`
    or its `logger.error` is deleted.
    """
    rig = _rig(config, monkeypatch, [[_update(20)], [_update(21)]],
               raises={20: ValueError("bad row")})

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert rig.handle.ids == [20, 21]                     # continued to the next poll
    failed = _records(caplog, "telegram_update_failed")
    assert len(failed) == 1 and failed[0].levelno == logging.ERROR
    assert "ValueError" in failed[0].getMessage()


async def test_handler_failures_do_not_touch_the_backoff_ladder(config, monkeypatch):
    """A handler failure is not a transport failure (rule 5). RED if the reset moved below
    `_handle_batch`, or if a handler failure was routed into the backoff."""
    rig = _rig(config, monkeypatch, [
        [_update(30)],
        TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)"),
    ], raises={30: RuntimeError("poison")})

    await rig.run()

    assert len(rig.sleep.durations) == 1
    assert 0.8 <= rig.sleep.durations[0] <= 1.2           # still rung 1, not rung 2


# --------------------------------------------------------------------------------------
# 8-9. Heartbeat.
# --------------------------------------------------------------------------------------
async def test_heartbeat_fires_while_the_poller_is_idle(config, monkeypatch, caplog):
    """"Alive and idle" must not look like "dead". A Render WORKER has no
    `healthCheckPath`, so this line is the only liveness signal there is. RED if the
    heartbeat is only emitted on a non-empty batch — the state it exists to report is
    exactly the empty one."""
    rig = _rig(config, monkeypatch, [[], [], []], advance=61.0)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    alive = _records(caplog, "telegram_poller_alive")
    assert len(alive) == 4                                # loop entry, then polls 2, 3, 4
    assert alive[0].levelno == logging.INFO
    assert "offset=None" in alive[0].getMessage()


async def test_heartbeat_reports_the_current_offset(config, monkeypatch, caplog):
    """Forward progress, not just liveness: an offset frozen across heartbeats says the
    bot is polling and ingesting nothing.

    Three beats, not two: the first is the loop-entry beat, which necessarily reports
    `None` because no poll has happened yet. The script is unchanged — it already produced
    two settled `42` beats, and the repetition is the point of this test, so the entry beat
    is asserted ALONGSIDE them rather than replacing one of them.
    """
    rig = _rig(config, monkeypatch, [[_update(41)], []], advance=61.0)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    alive = _records(caplog, "telegram_poller_alive")
    assert [r.getMessage() for r in alive] == [
        "telegram_poller_alive offset=None",              # loop entry, nothing polled yet
        "telegram_poller_alive offset=42",
        "telegram_poller_alive offset=42",
    ]


async def test_heartbeat_fires_at_most_once_per_sixty_seconds(config, monkeypatch, caplog):
    """30 s per poll over four polls (120 s of clock): the entry beat, then ONE at t=60.

    RED if the interval check is dropped, or if `last_beat` is not moved forward — either
    turns the liveness line into per-poll noise, and noise is how the ERROR lines stop
    being read.

    Asserted as INSTANTS rather than a count. A count cannot tell "throttled to the
    interval" from "fired on polls 1 and 3 for some other reason", and the entry beat makes
    the count alone even weaker: `[0.0, 60.0]` says exactly which two.
    """
    rig = _rig(config, monkeypatch, [[], [], []], advance=30.0)
    beats = _BeatTimes(rig.clock)
    poller.logger.addHandler(beats)
    try:
        with caplog.at_level(logging.DEBUG):
            await rig.run()
    finally:
        poller.logger.removeHandler(beats)

    assert beats.times == [0.0, 60.0]          # entry, then throttled — NOT four
    assert rig.clock.now == 120.0              # four polls happened


async def test_the_first_beat_fires_at_loop_entry_before_the_first_poll(
    config, monkeypatch, caplog
):
    """★ The window where "is it alive?" is asked hardest: the first minutes of a deploy.

    `last_beat` starts ONE INTERVAL in the past, so the beat at the top of the first
    iteration fires immediately. Without it the first sign of life is the first beat of the
    ~100 s cadence below, and an operator watching a fresh worker for a crash-loop sees
    nothing at all for a minute and a half — the one moment the signal is both most needed
    and absent. It also makes T11's deploy check a glance instead of a stopwatch.

    Asserted from the INTERLEAVING, not from the instant. `beats.times[0] == 0.0` alone is
    satisfied by a first poll that takes no time, which is exactly what the fakes do; only
    the ordering against the poll distinguishes "beat at entry" from "beat after a free
    poll". RED the moment the one-interval offset is dropped from `last_beat`.
    """
    rig = _rig(config, monkeypatch, [[_update(41)]])
    beats = _BeatTimes(rig.clock, rig.trace)
    poller.logger.addHandler(beats)
    try:
        with caplog.at_level(logging.DEBUG):
            await rig.run()
    finally:
        poller.logger.removeHandler(beats)

    assert rig.trace[0] == ("beat", 0.0)                # BEFORE any poll, at t=0
    assert rig.trace[1] == ("poll", None)
    # It reports the offset it actually has, which at entry is none yet — the honest value.
    assert _records(caplog, "telegram_poller_alive")[0].getMessage() == (
        "telegram_poller_alive offset=None"
    )


async def test_the_real_idle_cadence_is_the_interval_rounded_up_to_a_poll(
    config, monkeypatch, caplog
):
    """★ What the operator actually sees, in production's numbers — and it is NOT 60 s.

    The beat is checked once per loop ITERATION, and on a healthy idle worker one iteration
    is one full long poll. With the deployed 50 s timeout the elapsed time at each check
    goes 50, 100 — so after the loop-entry beat the next lands at **t=100 s** and the
    cadence is 100 s, i.e. `_HEARTBEAT_INTERVAL_S` rounded UP to the next poll boundary.
    The entry beat buys the first one and nothing after it; the ~100 s spacing is what an
    alert threshold has to accommodate.

    Every other heartbeat test here uses a poll longer than the interval (61 s) or an exact
    divisor (30 s), which is why four of them could be green while the deploy-day check
    "expect `telegram_poller_alive` within 60 s" would have raised a false alarm against a
    perfectly healthy worker. A monitoring threshold under the true cadence is worse than no
    threshold, so the number is pinned here rather than left to the reader's arithmetic.
    """
    # The dial models the LONG POLL's duration, so it must be production's value and not
    # the fixture's deliberately-different 7 s. Pinned against the real default so this
    # test cannot quietly go on modelling a timeout the deployment no longer uses.
    assert TelegramConfig(
        bot_token="123456:CANARY-BOT-TOKEN",
        allowed_chat_ids=frozenset({GROUP_CHAT_ID}),
        ingest_user_id=INGEST_USER_ID,
    ).poll_timeout_s == PRODUCTION_POLL_TIMEOUT_S

    rig = _rig(config, monkeypatch, [[]] * 5, advance=float(PRODUCTION_POLL_TIMEOUT_S))
    beats = _BeatTimes(rig.clock)
    poller.logger.addHandler(beats)
    try:
        with caplog.at_level(logging.DEBUG):
            await rig.run()
    finally:
        poller.logger.removeHandler(beats)

    assert rig.clock.now == 300.0                       # six idle polls, 50 s each
    # Entry, then two beats in five minutes. At the interval's face value the two would
    # have been five, which is the threshold a 60 s alert would have been set against.
    assert beats.times == [0.0, 100.0, 200.0]


async def test_heartbeat_keeps_firing_while_the_transport_is_failing(
    config, monkeypatch, caplog
):
    """The state liveness matters MOST in. The beat is taken before the poll, not after it,
    so a bot that cannot reach Telegram at all still proves it is running rather than
    looking identical to a crashed one. RED if the heartbeat is moved into the success
    path — which needs `stop_after`, because the fake's own terminating poll would
    otherwise succeed and fire the beat from the very branch this test denies.

    The clock advances purely through the backoff sleeps here — no separate dial.
    """
    boom = TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)")
    # 1+2+4+8+16+32+60+60 s of backoff, and not one successful poll in the run.
    rig = _rig(config, monkeypatch, [boom] * 8, stop_after=8)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert _records(caplog, "telegram_poller_alive")
    assert len(_records(caplog, "telegram_poll_error")) == 8


# --------------------------------------------------------------------------------------
# 10-11. Offsets at the edges.
# --------------------------------------------------------------------------------------
async def test_an_empty_batch_moves_nothing_and_calls_the_handler_zero_times(
    config, monkeypatch
):
    """~99 % of polls. RED if `max()` is called on an empty sequence (ValueError kills the
    loop) or if the offset is reset to something on an empty batch.

    The empty `durations` is the third assertion and its own guard: long polling IS the
    wait, so a poller that sleeps between successful polls has doubled its latency and
    halved the window Telegram's 24 h retention gives us.
    """
    rig = _rig(config, monkeypatch, [[], [], []])

    await rig.run()

    assert rig.handle.seen == []
    assert rig.updates.offsets == [None, None, None, None]
    assert rig.sleep.durations == []


async def test_a_successful_poll_writes_no_log_records_at_all(config, monkeypatch, caplog):
    """A line per poll is ~1,700 records/day of nothing, and noise is how the ERROR lines
    stop being read. `handle_update` already logs one INFO per accepted reel; a second here
    would carry a strict subset of it. RED if a per-poll or per-update INFO is added.

    The two records that ARE here are both ONCE PER PROCESS, not per poll: the loop-entry
    beat and the stop line. That distinction is what this fixture now proves — four polls
    and five updates produce the same two records a single poll would, because the clock
    never advances (`advance=0`) so no further beat is due. The earlier one-batch fixture
    could not tell per-process from per-poll at all: with two polls, "2 records" and
    "1 record" were both consistent with the bug.
    """
    rig = _rig(config, monkeypatch, [
        [_update(80), _update(81)], [_update(82)], [_update(83), _update(84)],
    ])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert [r.getMessage() for r in caplog.records] == [
        "telegram_poller_alive offset=None",       # once per PROCESS, at loop entry
        "telegram_poller_stopped offset=85",
    ]
    assert len(rig.handle.ids) == 5                # five updates, still two records


async def test_no_failure_branch_moves_the_offset(config, monkeypatch):
    """A failed poll re-requests the SAME offset — across all three failure branches.

    The offset is the only durable state this loop has, and every containment path here
    runs `continue`. Resetting it to None on a 500 would re-ingest up to 24 h of already
    handled updates; advancing it would skip whatever the failed poll would have returned.
    Neither is caught by anything else in this file: fault injection showed an
    `offset = None` planted in the generic branch passing the entire inherited suite.

    All three branches are exercised in one run because the mutant only has to be planted
    in one of them, and the ladder is checked in passing: 500 takes rung 1, the 409 takes
    rung 2, and the 429 takes its own `retry_after + 1` without moving the ladder.
    """
    rig = _rig(config, monkeypatch, [
        [_update(300)],
        TelegramAPIError("Telegram getUpdates failed: HTTP 500 (error_code=500)"),
        TelegramConflict("Telegram getUpdates failed: HTTP 409 (error_code=409)"),
        TelegramRetryAfter("Telegram getUpdates failed: HTTP 429 (error_code=429)", 2.0),
        [],
    ])

    await rig.run()

    assert rig.updates.offsets == [None] + [301] * 5
    assert 0.8 <= rig.sleep.durations[0] <= 1.2
    assert 1.6 <= rig.sleep.durations[1] <= 2.4
    assert rig.sleep.durations[2] == 3.0


async def test_the_first_poll_sends_no_offset_at_all(config, monkeypatch):
    """`None`, never `0`: T1 omits `offset` from the request body when it is None, and
    `offset=0` is a different request. RED if the initial offset is seeded with 0."""
    rig = _rig(config, monkeypatch, [[]])

    await rig.run()

    assert rig.updates.offsets[0] is None


async def test_the_poll_uses_the_configs_token_and_timeout(config, monkeypatch):
    """RED if the poller hardcodes `timeout_s=50` — the api default is 50, so a
    config-ignoring poller passes any test that does not use a different value.

    An EMPTY script: the fake stops the loop on its first call, so exactly one poll
    happens and the assertions are lists of one rather than "whatever the script left".
    """
    rig = _rig(config, monkeypatch, [])

    await rig.run()

    assert rig.updates.tokens == [config.bot_token]
    assert rig.updates.timeouts == [POLL_TIMEOUT_S]
    assert rig.updates.clients == [HTTP]


# --------------------------------------------------------------------------------------
# 12-13. Shutdown.
# --------------------------------------------------------------------------------------
async def test_a_pre_set_stop_polls_nothing_and_exits_cleanly(config, monkeypatch, caplog):
    """`stop` is checked at the TOP of the iteration. RED for a do-while shape, which
    would spend one 50 s long poll after the worker asked the loop to stop."""
    rig = _rig(config, monkeypatch, [[_update(1)]])
    rig.stop.set()

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert rig.updates.offsets == []
    assert rig.handle.seen == []
    assert len(_records(caplog, "telegram_poller_stopped")) == 1


async def test_stop_mid_run_ends_the_loop_and_logs_the_stop(config, monkeypatch, caplog):
    """A clean exit is a LOGGED exit: silence at shutdown is indistinguishable from a
    crash, and Render restarts both the same way."""
    rig = _rig(config, monkeypatch, [[_update(50)], [_update(51)]])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert rig.handle.ids == [50, 51]
    stopped = _records(caplog, "telegram_poller_stopped")
    assert len(stopped) == 1 and stopped[0].levelno == logging.INFO


async def test_cancelled_error_from_a_handler_is_never_swallowed(config, monkeypatch):
    """★ Shutdown must not be catchable. `asyncio.CancelledError` derives from
    `BaseException` (verified on the pinned 3.14), so `except Exception` lets it through —
    RED the moment the per-update catch is widened to `BaseException`, which would turn
    `task.cancel()` into a hang the platform resolves with SIGKILL.
    """
    rig = _rig(config, monkeypatch, [[_update(60)]],
               raises={60: asyncio.CancelledError()})

    with pytest.raises(asyncio.CancelledError):
        await rig.run()


async def test_cancelled_error_from_the_transport_is_never_swallowed(config, monkeypatch):
    """The same property on the other await. `TelegramAPIError` is an `Exception`, so a
    catch-all on the poll would swallow cancellation just as readily."""
    rig = _rig(config, monkeypatch, [asyncio.CancelledError()])

    with pytest.raises(asyncio.CancelledError):
        await rig.run()


# --------------------------------------------------------------------------------------
# 14. Content containment.
# --------------------------------------------------------------------------------------
async def test_no_update_content_or_exception_message_reaches_any_log(
    config, monkeypatch, caplog
):
    """Guardrail #11 plus the implicit-`__context__` leak that hit three modules this week.

    The canary sits in BOTH the message text (so logging the update dict leaks it) and the
    handler's exception message (so `str(exc)`, `logger.exception` or `exc_info=True`
    leaks it). Only the type name and the scalar `update_id` may survive. The assertion is
    on `CANARY`, not `CANARY-SECRET`, so it also catches the bot token: the fixture's token
    is `123456:CANARY-BOT-TOKEN`, and the token is the one secret this module holds.
    """
    boom = RuntimeError(f"{CANARY_TEXT} leaked")
    rig = _rig(config, monkeypatch, [[_update(77, text=f"{CANARY_TEXT} in the text")]],
               raises={77: boom})

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    assert all(record.exc_info is None for record in caplog.records)
    failed = _records(caplog, "telegram_update_failed")
    assert len(failed) == 1
    assert "RuntimeError" in failed[0].getMessage()
    assert "update_id=77" in failed[0].getMessage()


async def test_the_canary_reaches_the_log_when_the_module_is_careless(caplog):
    """Proves the previous test's canary CAN travel — its assertion is not vacuous.

    T3 shipped a leak test whose canary could never echo: impeccable-looking, asserting
    nothing. This reproduces the exact leak shape against a throwaway logger.
    """
    logger = logging.getLogger("telegram_ingest.test_poller_canary")
    with caplog.at_level(logging.DEBUG):
        try:
            try:
                raise RuntimeError(f"{CANARY_TEXT} leaked")
            except RuntimeError:
                raise ValueError("wrapped")   # no `from`: implicit __context__ chains
        except ValueError:
            logger.error("telegram_update_failed update_id=77", exc_info=True)

    assert CANARY_TEXT in _formatted(caplog)


# --------------------------------------------------------------------------------------
# 15. A malformed batch element must not kill the worker.
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("garbage", [None, "nope", [], {}, {"update_id": None},
                                     {"update_id": "12"}, {"update_id": True}])
async def test_a_malformed_element_beside_a_valid_one_still_advances_the_offset(
    config, monkeypatch, garbage
):
    """`api._expect_result` guarantees a LIST, never the shape of its elements, and
    `test_ingest.py` already parametrizes exactly these envelopes as reachable.

    RED for a bare `max(u["update_id"] for u in updates)`: every case here raises
    `TypeError` or `KeyError` out of `poll_forever` and kills the worker — a crash the
    per-update backstop cannot catch, because it is not inside the per-update `try`.

    This proves only that a malformed element cannot crash the loop. It deliberately does
    NOT prove the `bool` rejection: paired with update 90 the max is 90 either way, so
    admitting `True` as id 1 changes nothing observable here. That guard is load-bearing in
    `test_a_wholly_unusable_batch_...` below, where `True` is the only candidate.
    """
    rig = _rig(config, monkeypatch, [[garbage, _update(90)]])

    await rig.run()

    assert rig.updates.offsets == [None, 91]


async def test_a_wholly_unusable_batch_is_loud_and_backs_off_instead_of_hot_looping(
    config, monkeypatch, caplog
):
    """No element carries a usable `update_id`, so no offset can be computed.

    Keeping the offset would redeliver the same batch immediately and forever — a hot
    loop, because `getUpdates` returns pending updates without waiting out its timeout.
    So it takes the transport backoff and says so at ERROR (guardrail #12). RED if this
    path is deleted: the suite would hang or spin.

    `{"update_id": True}` is in the batch to make the `bool` rejection load-bearing: it is
    the ONLY element here that could yield an id, so an implementation that let `True == 1`
    through would compute offset 2, skip the unresolved path entirely, and pass every other
    test in this file. Fault injection found that — with `True` only ever beside a real id,
    dropping `isinstance(value, bool)` from `_update_id` changed nothing anywhere.
    """
    rig = _rig(config, monkeypatch, [[None, "nope", {"update_id": True}], []])

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    unresolved = _records(caplog, "telegram_poll_offset_unresolved")
    assert len(unresolved) == 1 and unresolved[0].levelno == logging.ERROR
    assert rig.updates.offsets == [None, None, None]
    assert 0.8 <= rig.sleep.durations[0] <= 1.2


async def test_every_element_of_a_batch_is_handed_to_the_handler_untouched(
    config, monkeypatch
):
    """The poller is an envelope carrier: `handle_update` owns every content decision and
    is already proven total against these shapes. RED if the poller starts filtering."""
    batch: list[Any] = [None, {"update_id": 1}, _update(2)]
    rig = _rig(config, monkeypatch, [batch])

    await rig.run()

    assert rig.handle.seen == batch


async def test_the_subscription_is_forwarded_rather_than_defaulted(config, monkeypatch):
    """T6 handoff, closed. `get_updates` has an identical default, so this is invisible
    until the day that default widens — at which point `edited_message` and `channel_post`
    would silently start reaching `handle`. The caller states the subscription; a default
    two layers down pins nothing. RED if the forwarding is dropped: `channel_post` here
    would arrive as `("message",)`.
    """
    rig = _rig(config, monkeypatch, [[]])

    await poller.poll_forever(
        config=config, http=HTTP, handle=rig.handle, stop=rig.stop,
        allowed_updates=("message", "channel_post"),
        sleep=rig.sleep, monotonic=rig.clock,
    )

    assert rig.updates.subscriptions
    assert set(rig.updates.subscriptions) == {("message", "channel_post")}


# --------------------------------------------------------------------------------------
# Structural guards — properties a behavioural test cannot pin.
# --------------------------------------------------------------------------------------
def _module_tree() -> ast.Module:
    return ast.parse(inspect.getsource(poller))


def _poll_forever_tree() -> ast.AsyncFunctionDef:
    for node in _module_tree().body:
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "poll_forever":
            return node
    raise AssertionError("poll_forever is no longer a module-level async function")


def test_the_module_never_calls_logger_exception_or_passes_exc_info():
    """`logger.exception` and `exc_info=True` print the exception's `__context__` chain,
    and everything this module swallows was raised while handling untrusted content."""
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute):
                assert node.func.attr != "exception", "logger.exception leaks __context__"
            assert not any(kw.arg == "exc_info" for kw in node.keywords)


def test_the_module_reads_only_the_update_id_from_an_update():
    """Guardrail #11, from the AST. The poller moves envelopes; `reel_filter` is the only
    reader of content anywhere in the package. RED the moment someone reaches for
    `update["message"]["text"]` to make a log line "more useful"."""
    allowed = {"update_id"}
    named: set[str] = set()
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant):
            if isinstance(node.slice.value, str):
                named.add(node.slice.value)
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get" and node.args
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            named.add(node.args[0].value)
    assert named <= allowed, f"unexpected update keys read: {sorted(named - allowed)}"


def test_import_poller_is_keyless_and_sdk_free_in_fresh_interpreter():
    """The repo's import-time invariant, in the shape `test_capture.py:157` established.

    A FRESH interpreter, not this one: by the time the full suite reaches this file some
    other module has already pulled `openai` into `sys.modules`, so an in-process
    assertion would pass or fail on test ORDER and prove nothing (T4 hit exactly that).
    """
    code = (
        "import sys; from telegram_ingest import poller; "
        "assert 'agents' not in sys.modules, 'Agents SDK imported at import time'; "
        "assert 'openai' not in sys.modules, 'openai imported at import time'; "
        "print('IMPORT_OK')"
    )
    env = {
        k: v for k, v in os.environ.items()
        if k not in ("OPENAI_API_KEY", "APIFY_TOKEN", "MAPBOX_SECRET_TOKEN",
                     "SUPABASE_SERVICE_ROLE_KEY", "TELEGRAM_BOT_TOKEN")
    }
    result = subprocess.run(
        [sys.executable, "-c", code],
        cwd=str(Path(__file__).parent.parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, f"fresh import failed: {result.stderr}"
    assert "IMPORT_OK" in result.stdout
