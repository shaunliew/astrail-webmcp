"""ingest — the orchestration core. Offline, credential-free, no network, no real DB.

Three conventions carry most of the weight here:

  - **Fakes implement the real interface.** `_FakeCapture` calls the same
    `normalize_reel_url` the real `capture_saved_reel` calls, and `_FakeCreateJob`
    reproduces the RPC's AS422 validation and its idempotency-while-active branch
    (`20260720130000_organize_job_error_codes.sql:38-79`). A no-op fake would make
    "exactly one id is passed" and "one URL's failure is contained" assert nothing.
  - **The queue is real.** `_RecordingQueue` subclasses `asyncio.Queue`, so `QueueFull`
    is raised by the stdlib rather than by a mock configured to raise it.
  - **Fixtures are verified by construction, not by reasoning.** Every test that depends
    on a particular `FilterResult` shape asserts that shape from the real
    `extract_reel_urls` first (`_precondition`). A canary that cannot reach the branch it
    claims to test is the exact defect that shipped green in T3.

The seams are monkeypatched onto the module rather than injected as parameters: the
brief pins `handle_update`'s signature, and three more keyword-only dependencies would be
machinery that exists only for the tests. Module attributes are the seam the repo already
uses for module-level function references.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from organizer import ActiveOrganizeConflict, InvalidOrganizeRequest
from scrape.reel_url import normalize_reel_url, short_code_of
from telegram_ingest import ingest
from telegram_ingest.api import UNKNOWN_DESCRIPTION, TelegramAPIError, set_message_reaction
from telegram_ingest.config import TelegramConfig
from telegram_ingest.reel_filter import extract_reel_urls

GROUP_CHAT_ID = -1001234567890
SECOND_CHAT_ID = -1009876543210
STRANGER_CHAT_ID = -1005555555555
INGEST_USER_ID = "11111111-2222-3333-4444-555555555555"
MESSAGE_ID = 4242

# Every field the module is forbidden to log, all carrying the same greppable canary.
CANARY_TEXT = "CANARY-SECRET"
CANARY_USER = "CANARY-USER"
CANARY_TITLE = "CANARY-TITLE"

# Read off the real signature so `_FakeReact` stays a faithful stand-in (the file's first
# convention). The VALUE is pinned in `test_api.py` against Telegram's permitted set — the
# only place that can be, since a fake cannot tell you what Telegram accepts. What it buys
# here is the other half: RED if `_react` ever starts passing an emoji of its own.
REACTION_EMOJI = inspect.signature(set_message_reaction).parameters["emoji"].default


def _reel(code: str) -> str:
    return f"https://www.instagram.com/reel/{code}"


def _utf16_len(text: str) -> int:
    """Length in UTF-16 code units — Telegram's offset/length unit, never hand-counted."""
    return len(text.encode("utf-16-le")) // 2


def _message(
    *urls: str,
    chat_id: Any = GROUP_CHAT_ID,
    chat_type: Any = "supergroup",
    message_id: int = MESSAGE_ID,
    lead: str = "",
    chat_extra: dict | None = None,
    from_user: dict | None = None,
) -> dict:
    """One Telegram message whose `url` entities point at `urls`."""
    body = lead
    entities: list[dict] = []
    for url in urls:
        entities.append(
            {"type": "url", "offset": _utf16_len(body), "length": _utf16_len(url)}
        )
        body = f"{body}{url} "
    chat: dict[str, Any] = {"id": chat_id, "type": chat_type}
    if chat_extra:
        chat.update(chat_extra)
    message: dict[str, Any] = {
        "message_id": message_id,
        "chat": chat,
        "text": body,
        "entities": entities,
    }
    if from_user:
        message["from"] = from_user
    return message


def _update(message: dict, *, key: str = "message") -> dict:
    return {"update_id": 99, key: message}


def _precondition(message: dict, *, urls: tuple[str, ...], shapes: tuple[str, ...],
                  truncated: bool = False, overflowed: bool = False) -> None:
    """Assert the fixture really produces the FilterResult the test is about.

    Without this a fixture can drift — a mis-computed offset, a URL shape the filter
    normalizes differently — and the test still passes while exercising nothing.
    """
    result = extract_reel_urls(message)
    assert result.urls == urls
    assert result.rejected_shapes == shapes
    assert result.truncated is truncated
    assert result.overflowed is overflowed


def _formatted(caplog: pytest.LogCaptureFixture) -> str:
    """Every record as `logging` would emit it, INCLUDING any attached traceback.

    Asserting on `record.getMessage()` alone is the hole the whole T1-T3 arc kept falling
    into: `exc_info=True` (and `logger.exception`) print the exception's `__context__`
    chain, which carries whatever the swallowed DB error embedded. `Formatter.format`
    appends `formatException(record.exc_info)`, so a leak through that channel lands in
    this string.
    """
    formatter = logging.Formatter("%(levelname)s %(message)s")
    return "\n".join(formatter.format(record) for record in caplog.records)


def _records(caplog: pytest.LogCaptureFixture, event: str) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.getMessage().startswith(event)]


class _FakeCapture:
    """`saved_reels.capture_saved_reel` — normalizes like the real one, returns one row.

    The id is derived from the reel short code so a test can name the exact id it expects
    to reach `create_organize_job`; a random or opaque id would let a wrong-id bug pass.
    """

    def __init__(self, *, raises: dict[str, Exception] | None = None) -> None:
        self.calls: list[tuple[Any, str, str]] = []
        self._raises = raises or {}

    async def __call__(self, client: Any, user_id: str, raw_url: str) -> dict:
        self.calls.append((client, user_id, raw_url))
        normalized = normalize_reel_url(raw_url)   # the real seam's first statement
        if raw_url in self._raises:
            raise self._raises[raw_url]
        return {
            "id": f"saved-{short_code_of(normalized)}",
            "user_id": user_id,
            "normalized_url": normalized,
            "analysis_status": "not_analyzed",
        }


class _FakeCreateJob:
    """`organizer.create_organize_job` — the RPC's validation and idempotency, in Python.

    Mirrors `create_saved_reels_organize_job`: AS422 on an empty, oversized, null-bearing
    or duplicated id list, and a returning-the-live-job branch keyed the way
    `organizer._request_key` keys it. It does NOT reject a batch of >1 distinct ids —
    the real RPC accepts up to five — because a fake that refused one would hide the
    batching regression behind a fake-only error instead of failing the length assertion.
    """

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.calls: list[tuple[Any, str, list[str]]] = []
        self._raises = raises
        self._active: dict[tuple[str, tuple[str, ...]], str] = {}

    async def __call__(self, client: Any, user_id: str, saved_reel_ids: list[str]) -> str:
        self.calls.append((client, user_id, list(saved_reel_ids)))
        if self._raises is not None:
            raise self._raises
        ids = list(saved_reel_ids)
        if not 1 <= len(ids) <= 5 or any(i is None for i in ids) or len(set(ids)) != len(ids):
            raise InvalidOrganizeRequest("Saved Reel organize request is invalid")
        key = (user_id, tuple(sorted(set(ids))))
        return self._active.setdefault(key, f"job-{'+'.join(sorted(set(ids)))}")


class _FakeReact:
    """`api.set_message_reaction` — keyword-only, exactly like the real one."""

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.calls: list[dict] = []
        self._raises = raises

    async def __call__(self, *, client: Any, token: str, chat_id: int, message_id: int,
                       emoji: str = REACTION_EMOJI) -> None:
        self.calls.append({"client": client, "token": token, "chat_id": chat_id,
                           "message_id": message_id, "emoji": emoji})
        if self._raises is not None:
            raise self._raises


class _RecordingQueue(asyncio.Queue):
    """A REAL `asyncio.Queue` that also traces successful puts."""

    def __init__(self, trace: list[tuple[str, Any]], maxsize: int = 0) -> None:
        super().__init__(maxsize=maxsize)
        self._trace = trace

    def put_nowait(self, item: Any) -> None:
        super().put_nowait(item)        # the stdlib raises the real QueueFull
        self._trace.append(("enqueue", item))


class _Seams:
    """The three patched seams plus the queue, sharing one ordered call trace."""

    def __init__(self, capture: _FakeCapture, create_job: _FakeCreateJob,
                 react: _FakeReact, queue: _RecordingQueue,
                 trace: list[tuple[str, Any]]) -> None:
        self.capture = capture
        self.create_job = create_job
        self.react = react
        self.queue = queue
        self.trace = trace

    @property
    def call_count(self) -> int:
        return len(self.capture.calls) + len(self.create_job.calls) + len(self.react.calls)


DB = object()          # opaque: handle_update must forward it, never introspect it
HTTP = object()


@pytest.fixture(autouse=True)
def _reset_rejected_chats() -> None:
    """`_LOGGED_REJECTED_CHATS` is process state; a leaked entry silences a later test."""
    ingest._LOGGED_REJECTED_CHATS.clear()


@pytest.fixture
def config() -> TelegramConfig:
    return TelegramConfig(
        bot_token="123456:CANARY-BOT-TOKEN",
        allowed_chat_ids=frozenset({GROUP_CHAT_ID}),
        ingest_user_id=INGEST_USER_ID,
    )


def _install(monkeypatch: pytest.MonkeyPatch, *, capture: _FakeCapture | None = None,
             create_job: _FakeCreateJob | None = None, react: _FakeReact | None = None,
             maxsize: int = 0) -> _Seams:
    trace: list[tuple[str, Any]] = []
    capture = capture or _FakeCapture()
    create_job = create_job or _FakeCreateJob()
    react = react or _FakeReact()

    async def traced_capture(client: Any, user_id: str, raw_url: str) -> dict:
        trace.append(("capture", raw_url))
        return await capture(client, user_id, raw_url)

    async def traced_create(client: Any, user_id: str, ids: list[str]) -> str:
        trace.append(("create_job", tuple(ids)))
        return await create_job(client, user_id, ids)

    async def traced_react(**kwargs: Any) -> None:
        trace.append(("react", kwargs["message_id"]))
        await react(**kwargs)

    monkeypatch.setattr(ingest, "capture_saved_reel", traced_capture)
    monkeypatch.setattr(ingest, "create_organize_job", traced_create)
    monkeypatch.setattr(ingest, "set_message_reaction", traced_react)
    return _Seams(capture, create_job, react, _RecordingQueue(trace, maxsize), trace)


@pytest.fixture
def seams(monkeypatch: pytest.MonkeyPatch) -> _Seams:
    return _install(monkeypatch)


async def _run(update: dict, config: TelegramConfig, seams: _Seams) -> None:
    await ingest.handle_update(update, config=config, db=DB, http=HTTP, queue=seams.queue)


# --------------------------------------------------------------------------------------
# 1. The mixed message. Named in the plan because two review rounds got it wrong.
# --------------------------------------------------------------------------------------
async def test_mixed_valid_and_unsupported_url_ingests_and_withholds_the_reaction(
    config, seams, caplog
):
    """RED if the reaction condition reads only `urls`, or if `rejected_shapes` is
    consulted only when `urls` is empty: both acknowledge a message whose `/share/reel/`
    was never ingested, breaking the pinned promise."""
    message = _message(_reel("ABC123"), "https://www.instagram.com/share/reel/XYZ/")
    _precondition(message, urls=(_reel("ABC123"),), shapes=("/share/reel/…",))

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert seams.capture.calls == [(DB, INGEST_USER_ID, _reel("ABC123"))]
    assert seams.create_job.calls == [(DB, INGEST_USER_ID, ["saved-ABC123"])]
    assert seams.queue.get_nowait() == "job-saved-ABC123"
    assert seams.react.calls == []

    unsupported = _records(caplog, "telegram_reel_unsupported_url")
    assert len(unsupported) == 1
    assert unsupported[0].levelno == logging.ERROR
    assert "/share/reel/…" in unsupported[0].getMessage()
    assert len(_records(caplog, "telegram_reel_accepted")) == 1


async def test_unsupported_url_alone_logs_error_and_writes_nothing(config, seams, caplog):
    """The `urls`-empty half of the same branch. RED if an all-rejected message returns
    silently — that is the T0 spike's blind spot vanishing into a `ValueError` swallow."""
    message = _message("https://www.instagram.com/stories/someone/123/")
    _precondition(message, urls=(), shapes=("/stories/…",))

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert seams.call_count == 0
    assert len(_records(caplog, "telegram_reel_unsupported_url")) == 1


# --------------------------------------------------------------------------------------
# 2-4. The gate.
# --------------------------------------------------------------------------------------
async def test_allowlist_gate_precedes_every_write(config, seams, caplog):
    """RED if the gate moves after any write: a stranger's group would spend Apify and
    OpenAI credits before anyone noticed the bot had been added."""
    message = _message(
        _reel("ABC123"), chat_id=STRANGER_CHAT_ID, lead=f"{CANARY_TEXT} ",
        chat_extra={"title": CANARY_TITLE},
        from_user={"id": 7, "username": CANARY_USER},
    )
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert seams.call_count == 0
    assert seams.trace == []
    assert seams.queue.qsize() == 0
    rejected = _records(caplog, "telegram_chat_rejected")
    assert len(rejected) == 1
    assert rejected[0].levelno == logging.WARNING
    assert str(STRANGER_CHAT_ID) in rejected[0].getMessage()
    # "chat_id ONLY": the rejection path is the one that runs for chats nobody vetted, so
    # it is the last place a `chat.title` belongs. The canary test below never reaches it.
    assert "CANARY" not in _formatted(caplog)


@pytest.mark.parametrize("chat_type", ["private", "channel", "sender", None, ""])
async def test_non_group_chat_types_are_rejected_even_when_allowlisted(
    config, seams, chat_type
):
    """The allowlist is necessary, not sufficient. RED if the type check is dropped: the
    same id as a private chat would let a DM to the bot ingest."""
    message = _message(_reel("ABC123"), chat_type=chat_type)
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    await _run(_update(message), config, seams)

    assert seams.call_count == 0


@pytest.mark.parametrize("key", ["edited_message", "channel_post", "my_chat_member",
                                 "edited_channel_post", "business_message"])
async def test_only_the_message_key_is_handled(config, seams, key):
    """An edit re-triggering ingestion is a free duplicate-spend path, and every other
    envelope is a surface nobody reviewed. RED if `handle_update` widens its key."""
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    await _run(_update(message, key=key), config, seams)

    assert seams.call_count == 0


async def test_chat_rejection_logs_once_per_chat_per_process(config, seams, caplog):
    """RED if the seen-set is dropped: an unknown group that chats all day floods the
    log, and the flood is what buries the real `telegram_reel_dropped` lines."""
    with caplog.at_level(logging.DEBUG):
        await _run(_update(_message(chat_id=STRANGER_CHAT_ID)), config, seams)
        await _run(_update(_message(chat_id=STRANGER_CHAT_ID)), config, seams)
        await _run(_update(_message(chat_id=SECOND_CHAT_ID)), config, seams)

    messages = [r.getMessage() for r in _records(caplog, "telegram_chat_rejected")]
    assert len(messages) == 2
    assert str(STRANGER_CHAT_ID) in messages[0]
    assert str(SECOND_CHAT_ID) in messages[1]


# --------------------------------------------------------------------------------------
# 5-7. The per-URL loop.
# --------------------------------------------------------------------------------------
async def test_one_urls_failure_does_not_touch_the_next(config, monkeypatch, caplog):
    """Guardrail #3. RED if the loop aborts on the first failure, and RED if the 👍 still
    fires: a 👍 on a message whose middle reel was dropped is the lie the contract is
    written against."""
    boom = RuntimeError("second reel exploded")
    capture = _FakeCapture(raises={_reel("TWO"): boom})
    seams = _install(monkeypatch, capture=capture)
    message = _message(_reel("ONE"), _reel("TWO"), _reel("THREE"))
    _precondition(message, urls=(_reel("ONE"), _reel("TWO"), _reel("THREE")), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert [c[2] for c in capture.calls] == [_reel("ONE"), _reel("TWO"), _reel("THREE")]
    assert [c[2] for c in seams.create_job.calls] == [["saved-ONE"], ["saved-THREE"]]
    assert [seams.queue.get_nowait() for _ in range(2)] == ["job-saved-ONE", "job-saved-THREE"]
    assert seams.react.calls == []

    dropped = _records(caplog, "telegram_reel_dropped")
    assert len(dropped) == 1
    assert _reel("TWO") in dropped[0].getMessage()
    assert dropped[0].levelno == logging.ERROR
    assert [r.getMessage() for r in _records(caplog, "telegram_reel_accepted")] != []


async def test_create_organize_job_always_receives_exactly_one_id(config, seams):
    """RED if the implementation ever batches. A batch of >1 resurrects AS409 — two reels
    from one message would collide with each other's active job — and the plan deleted
    that whole class by making every job single-item (F1)."""
    codes = ["AA1", "BB2", "CC3", "DD4", "EE5"]
    message = _message(*[_reel(c) for c in codes])
    _precondition(message, urls=tuple(_reel(c) for c in codes), shapes=())

    await _run(_update(message), config, seams)

    assert len(seams.create_job.calls) == 5
    assert all(len(call[2]) == 1 for call in seams.create_job.calls)
    assert [call[2][0] for call in seams.create_job.calls] == [f"saved-{c}" for c in codes]


async def test_queue_full_is_not_a_failure(config, monkeypatch, caplog):
    """The job row already exists and `main._reap_loop` will run it. RED if `QueueFull`
    is treated as a drop: the human would re-share a reel that was already durable."""
    seams = _install(monkeypatch, maxsize=1)
    seams.queue.put_nowait("occupied")
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    full = _records(caplog, "telegram_queue_full")
    assert len(full) == 1
    assert full[0].levelno == logging.WARNING
    assert "job-saved-ABC123" in full[0].getMessage()
    assert _records(caplog, "telegram_reel_dropped") == []
    assert len(_records(caplog, "telegram_reel_accepted")) == 1
    assert len(seams.react.calls) == 1          # still durable, so still acknowledged


async def test_active_organize_conflict_gets_no_special_case(config, monkeypatch, caplog):
    """RED if AS409 is caught and treated as accepted. It is unreachable for single-item
    jobs, so if it ever fires the "the reaper guarantees it runs" claim is false: the SQL
    counts `initializing` as active while `recover_organize_jobs` lists only `pending`."""
    conflict = ActiveOrganizeConflict("Saved Reel is already being organized")
    seams = _install(monkeypatch, create_job=_FakeCreateJob(raises=conflict))
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    dropped = _records(caplog, "telegram_reel_dropped")
    assert len(dropped) == 1
    assert "ActiveOrganizeConflict" in dropped[0].getMessage()
    assert seams.react.calls == []
    assert _records(caplog, "telegram_reel_accepted") == []


# --------------------------------------------------------------------------------------
# Fix 2 — generation freeze (plan §3.6): the ingest account is the third generation entrypoint.
# --------------------------------------------------------------------------------------
class _FrozenAccountDb:
    """A `db` whose users read reports the ingest account as pending deletion. The real
    `deletion.account_is_pending_deletion` (NOT monkeypatched) runs against this chain."""

    class _Query:
        def select(self, *_a):
            return self

        def eq(self, *_a):
            return self

        def maybe_single(self):
            return self

        async def execute(self):
            return type("_R", (), {"data": {"account_status": "pending_deletion"}})()

    def table(self, name):
        assert name == "users"
        return self._Query()


async def test_a_pending_deletion_ingest_account_is_refused_before_any_spend(config, seams, caplog):
    """Fix 2: if the ingest account has entered the deletion grace, no reel is ingested — no
    capture, no organize job, no reaction — and the drop is logged LOUDLY (costing the 👍)."""
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await ingest.handle_update(
            _update(message), config=config, db=_FrozenAccountDb(), http=HTTP, queue=seams.queue
        )

    assert seams.capture.calls == []          # nothing captured
    assert seams.create_job.calls == []       # no organize job (no Apify/OpenAI spend)
    assert seams.react.calls == []            # not durable -> no acknowledgement
    dropped = _records(caplog, "telegram_reel_dropped")
    assert len(dropped) == 1
    assert "account_pending_deletion" in dropped[0].getMessage()
    assert dropped[0].levelno == logging.ERROR


# --------------------------------------------------------------------------------------
# 8-10. Silence, truncation, and the reaction.
# --------------------------------------------------------------------------------------
async def test_ordinary_chatter_produces_no_log_records_at_all(config, seams, caplog):
    """~99% of group traffic. RED if the both-empty early return is dropped: the real
    `telegram_reel_dropped` lines drown in chatter and nobody reads the log again."""
    message = _message("https://example.com/holiday", lead="look at this ")
    _precondition(message, urls=(), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert caplog.records == []
    assert seams.call_count == 0


async def test_a_reel_filter_regression_is_contained_and_logged_not_propagated(
    config, seams, monkeypatch, caplog
):
    """The last uncontained call in `handle_update`, closed on review.

    `extract_reel_urls` cannot raise on any envelope — it is pure and has a
    `_must_not_raise` suite — so this simulates a REGRESSION in T2, which is the only
    thing the guard can catch. RED by *erroring*, not by failing an assert: without the
    `try` the exception leaves `handle_update` entirely, which is what "never raises"
    forbids unconditionally. The canary also pins the leak channel — a T2 failure can
    carry the candidate URL, so only the type name may be logged.
    """
    boom = RuntimeError(f"{CANARY_TEXT} https://www.instagram.com/reel/LEAKED")

    def exploding_filter(_message: dict) -> object:
        raise boom

    monkeypatch.setattr(ingest, "extract_reel_urls", exploding_filter)
    message = _message(_reel("ABC123"))

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    failed = _records(caplog, "telegram_reel_filter_failed")
    assert len(failed) == 1
    assert failed[0].levelno == logging.ERROR
    assert "RuntimeError" in failed[0].getMessage()
    assert str(GROUP_CHAT_ID) in failed[0].getMessage()
    assert "CANARY" not in _formatted(caplog)
    assert seams.call_count == 0
    assert seams.react.calls == []


async def test_the_same_reel_shared_twice_hits_idempotency_not_a_conflict(config, seams):
    """F1, end to end: a re-share must be free, not a conflict.

    Two messages carrying the same reel produce the same saved_reel id, so
    `create_organize_job` computes the same `_request_key` and the RPC's
    idempotency-key lookup (`20260720130000:66-79`) returns the LIVE job before the
    active-item check that would raise AS409 can run. Both messages therefore earn a 👍.
    This is the branch that makes single-item jobs safe to re-share; it was the one part
    of `_FakeCreateJob` no test reached.
    """
    await _run(_update(_message(_reel("TWICE"), message_id=1)), config, seams)
    await _run(_update(_message(_reel("TWICE"), message_id=2)), config, seams)

    assert [call[2] for call in seams.create_job.calls] == [["saved-TWICE"], ["saved-TWICE"]]
    assert [seams.queue.get_nowait() for _ in range(2)] == ["job-saved-TWICE"] * 2
    assert [call["message_id"] for call in seams.react.calls] == [1, 2]


async def test_an_over_budget_message_is_dropped_LOUDLY_not_silently(
    config, seams, caplog
):
    """The one input class that used to vanish without a trace.

    101 entities trips `reel_filter`'s budget, which returns empty `urls` and empty
    `rejected_shapes` — byte-identical to ordinary chatter — while a real
    `/reel/OVERFLOW` sits inside the message. Before `overflowed` existed this update
    produced ZERO log records: a silent drop, which guardrail #12 forbids outright.

    RED in two distinct ways, and both matter: dropping `not result.overflowed` from the
    both-empty early return sends this message down the chatter path and the ERROR is
    never reached, and deleting the ERROR itself restores the silence. The `caplog` shape
    below cannot tell those apart, which is exactly why both are fault-injected.
    """
    url = _reel("OVERFLOW")
    message = {
        "message_id": MESSAGE_ID,
        "chat": {"id": GROUP_CHAT_ID, "type": "supergroup"},
        "text": url,
        "entities": ([{"type": "url", "offset": 0, "length": _utf16_len(url)}]
                     + [{"type": "bold", "offset": 0, "length": 1}] * 100),
    }
    _precondition(message, urls=(), shapes=(), overflowed=True)

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    overflowed = _records(caplog, "telegram_reel_entities_overflowed")
    assert len(overflowed) == 1
    assert overflowed[0].levelno == logging.ERROR
    assert str(GROUP_CHAT_ID) in overflowed[0].getMessage()
    assert seams.call_count == 0            # nothing was parsed, so nothing is durable
    assert seams.react.calls == []          # absence of the reaction is the human signal


async def test_truncation_withholds_the_reaction_and_logs_an_error(config, seams, caplog):
    """An 11-reel message ingests 10. RED if `truncated` is not consulted: the 👍 would
    claim every reel in that message was accepted, and one silently was not."""
    codes = [f"CODE{n}" for n in range(11)]
    message = _message(*[_reel(c) for c in codes])
    _precondition(message, urls=tuple(_reel(c) for c in codes[:10]), shapes=(),
                  truncated=True)

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert len(seams.capture.calls) == 10
    truncated = _records(caplog, "telegram_reel_truncated")
    assert len(truncated) == 1
    assert truncated[0].levelno == logging.ERROR
    assert seams.react.calls == []


async def test_a_reaction_failure_does_not_abort_and_is_only_a_warning(
    config, monkeypatch, caplog
):
    """A swallowed reaction error is indistinguishable from a real rejection. RED if the
    failure is silent (a missing 👍 becomes undiagnosable) or if it escalates to ERROR /
    propagates (a durable reel would look dropped)."""
    seams = _install(monkeypatch, react=_FakeReact(raises=RuntimeError("no reaction rights")))
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    failed = _records(caplog, "telegram_reaction_failed")
    assert len(failed) == 1
    assert failed[0].levelno == logging.WARNING
    assert str(MESSAGE_ID) in failed[0].getMessage()
    assert _records(caplog, "telegram_reel_dropped") == []
    assert len(_records(caplog, "telegram_reel_accepted")) == 1


async def test_a_reaction_failure_leaks_neither_the_bot_token_nor_the_error_text(
    config, monkeypatch, caplog
):
    """The one leak path the main canary test cannot reach.

    `_react` is the only caller holding `config.bot_token` (the canary token in the
    fixture) and the only one formatting an exception raised by the Telegram client — and
    `httpx.HTTPStatusError.__str__` IS the request URL, which carries the token in its
    path. Both channels are asserted at once: the failing seam's message carries the
    content canary and the fixture's token carries its own.
    """
    boom = RuntimeError(f"{CANARY_TEXT} 123456:CANARY-BOT-TOKEN/setMessageReaction")
    seams = _install(monkeypatch, react=_FakeReact(raises=boom))
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    assert "RuntimeError" in _records(caplog, "telegram_reaction_failed")[0].getMessage()


async def test_a_reaction_failure_names_the_allowlisted_telegram_reason(
    config, monkeypatch, caplog
):
    """The diagnosability half of the 2026-08-02 incident.

    `telegram_reaction_failed … error=TelegramAPIError` was the whole log line, so working
    out that Telegram rejects ✅ took a manual call against the live API. `api` matches the
    envelope's `description` against its allowlist; this asserts the matched constant
    reaches the operator. RED if `_react` goes back to logging only the type name.
    """
    boom = TelegramAPIError(
        "Telegram setMessageReaction failed: HTTP 400 (error_code=400)",
        description="REACTION_INVALID",
    )
    seams = _install(monkeypatch, react=_FakeReact(raises=boom))
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    failed = _records(caplog, "telegram_reaction_failed")
    assert len(failed) == 1
    assert failed[0].levelno == logging.WARNING
    assert "detail=REACTION_INVALID" in failed[0].getMessage()
    assert "TelegramAPIError" in failed[0].getMessage()


async def test_a_foreign_exceptions_description_attribute_never_reaches_the_log(
    config, monkeypatch, caplog
):
    """Fault injection for the obvious wrong implementation of the line above.

    `getattr(exc, "description", "unknown")` reads plausibly and is a leak: `.description`
    is a common attribute name (werkzeug's `HTTPException`, click, botocore-style wrappers),
    and NONE of those went through the api layer's allowlist. Only a `TelegramAPIError`
    carries a description this module may print, so the check is `isinstance`, not `getattr`.
    """
    class _ForeignError(Exception):
        description = f"{CANARY_TEXT} 123456:CANARY-BOT-TOKEN/setMessageReaction"

    seams = _install(monkeypatch, react=_FakeReact(raises=_ForeignError()))
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    failed = _records(caplog, "telegram_reaction_failed")
    assert f"detail={UNKNOWN_DESCRIPTION}" in failed[0].getMessage()


async def test_an_unmatched_description_cannot_reach_the_log_through_the_real_api_layer(
    config, monkeypatch, caplog
):
    """The end-to-end version: no fake exception, the REAL `set_message_reaction` against a
    mocked transport that answers with a description carrying the bot token.

    Both guards have to hold at once for this to pass — the api layer must refuse to attach
    an unmatched description, and `_react` must print only what the api layer attached. The
    two previous tests each prove one half against a hand-built exception; this one proves
    the composition, which is what actually ships.
    """
    token = "123456:CANARY-BOT-TOKEN"                      # the `config` fixture's token
    leaky = f"Bad Request: {CANARY_TEXT} https://api.telegram.org/bot{token}/x"

    def handler(request: httpx.Request) -> httpx.Response:
        assert token in str(request.url)                   # the token really is in flight
        return httpx.Response(400, json={"ok": False, "error_code": 400,
                                         "description": leaky})

    seams = _install(monkeypatch)
    monkeypatch.setattr(ingest, "set_message_reaction", set_message_reaction)
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    # httpx logs `HTTP Request: POST <url>` at INFO and the bot token is in that path;
    # `worker._NOISY_TRANSPORT_LOGGERS` (worker.py:101) pins it to WARNING in production for
    # exactly that reason. Raising the ROOT logger to DEBUG below would undo the production
    # posture, so reproduce it — otherwise this test drowns in a leak that belongs to a
    # different module and is proved separately (`test_worker.py`, deploy checklist item 3).
    caplog.set_level(logging.WARNING, logger="httpx")

    with caplog.at_level(logging.DEBUG):
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            await ingest.handle_update(
                _update(message), config=config, db=DB, http=http, queue=seams.queue,
            )

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    assert token not in emitted
    failed = _records(caplog, "telegram_reaction_failed")
    assert len(failed) == 1
    assert f"detail={UNKNOWN_DESCRIPTION}" in failed[0].getMessage()


async def test_a_reel_in_a_caption_ingests_exactly_like_one_in_the_text(config, seams):
    """A reel forwarded as a video lands in `caption`, not `text` — the ordinary way
    people share on mobile. `reel_filter` reads both; RED if `handle_update` ever
    pre-selects a field instead of handing the whole message over."""
    url = _reel("CAP123")
    message = {
        "message_id": MESSAGE_ID,
        "chat": {"id": GROUP_CHAT_ID, "type": "supergroup"},
        "caption": f"found this {url}",
        "caption_entities": [
            {"type": "url", "offset": _utf16_len("found this "), "length": _utf16_len(url)}
        ],
    }
    _precondition(message, urls=(url,), shapes=())

    await _run(_update(message), config, seams)

    assert seams.create_job.calls == [(DB, INGEST_USER_ID, ["saved-CAP123"])]
    assert len(seams.react.calls) == 1


async def test_happy_path_calls_the_seams_in_order_and_reacts_once(config, seams, caplog):
    """The whole contract in one line of trace. RED if the reaction fires per URL rather
    than per message, or if the enqueue happens before the job exists."""
    message = _message(_reel("ABC123"))
    _precondition(message, urls=(_reel("ABC123"),), shapes=())

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    assert seams.trace == [
        ("capture", _reel("ABC123")),
        ("create_job", ("saved-ABC123",)),
        ("enqueue", "job-saved-ABC123"),
        ("react", MESSAGE_ID),
    ]
    assert seams.react.calls == [{
        "client": HTTP, "token": "123456:CANARY-BOT-TOKEN", "chat_id": GROUP_CHAT_ID,
        "message_id": MESSAGE_ID, "emoji": REACTION_EMOJI,
    }]
    accepted = _records(caplog, "telegram_reel_accepted")
    assert len(accepted) == 1
    assert "job-saved-ABC123" in accepted[0].getMessage()


async def test_two_reels_in_one_message_earn_exactly_one_reaction(config, seams):
    """RED if the 👍 moves back inside the loop (rev 4's bug): a partial failure would
    still have looked accepted, once per surviving URL."""
    message = _message(_reel("ONE"), _reel("TWO"))
    _precondition(message, urls=(_reel("ONE"), _reel("TWO")), shapes=())

    await _run(_update(message), config, seams)

    assert len(seams.react.calls) == 1


# --------------------------------------------------------------------------------------
# 14. Content containment.
# --------------------------------------------------------------------------------------
async def test_no_message_content_or_exception_message_reaches_any_log(
    config, monkeypatch, caplog
):
    """Guardrail #11 + the implicit-`__context__` leak that shipped three times this week.

    Both log paths fire on one message: an INFO for the reel that lands, an ERROR for the
    one whose seam raises, and an ERROR for the `/share/` shape. The raising seam's
    message carries the canary, so an `exc_info=True`, a `logger.exception`, or a
    `str(exc)` anywhere in the module puts it in `_formatted`.
    """
    boom = RuntimeError(f"{CANARY_TEXT} in the exception")
    capture = _FakeCapture(raises={_reel("BAD"): boom})
    seams = _install(monkeypatch, capture=capture)
    message = _message(
        _reel("GOOD"), _reel("BAD"), "https://www.instagram.com/share/reel/XYZ/",
        lead=f"{CANARY_TEXT} ",
        chat_extra={"title": CANARY_TITLE},
        from_user={"id": 7, "username": CANARY_USER, "first_name": CANARY_USER},
    )
    _precondition(message, urls=(_reel("GOOD"), _reel("BAD")), shapes=("/share/reel/…",))

    with caplog.at_level(logging.DEBUG):
        await _run(_update(message), config, seams)

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    assert all(record.exc_info is None for record in caplog.records)

    dropped = _records(caplog, "telegram_reel_dropped")
    assert len(dropped) == 1
    assert "RuntimeError" in dropped[0].getMessage()
    assert len(_records(caplog, "telegram_reel_accepted")) == 1
    assert len(_records(caplog, "telegram_reel_unsupported_url")) == 1


async def test_the_canary_reaches_the_log_when_the_module_is_careless(config, caplog):
    """Proves the previous test's canary CAN travel — the assertion is not vacuous.

    T3 shipped a leak test whose canary `uuid.UUID` never echoed: it asserted nothing
    while looking impeccable. This reproduces the exact leak shape (`logger.error` with
    `exc_info=True` on the same exception the fake raises) against a throwaway logger and
    asserts the canary lands, so `_formatted` is proven able to see it.
    """
    logger = logging.getLogger("telegram_ingest.test_canary_reachability")
    with caplog.at_level(logging.DEBUG):
        try:
            try:
                raise RuntimeError(f"{CANARY_TEXT} in the exception")
            except RuntimeError:
                raise ValueError("wrapped")   # no `from`: implicit __context__ chains
        except ValueError:
            logger.error("telegram_reel_dropped url=x", exc_info=True)

    assert CANARY_TEXT in _formatted(caplog)


# --------------------------------------------------------------------------------------
# 15. Containment of malformed input.
# --------------------------------------------------------------------------------------
@pytest.mark.parametrize("update", [
    {},
    {"message": None},
    {"message": {}},
    {"message": {"chat": {}}},
    {"message": {"chat": {"id": None, "type": "supergroup"}}},
    {"message": {"chat": {"id": GROUP_CHAT_ID, "type": "supergroup"}, "entities": "nope"}},
    {"message": {"chat": "not-a-dict"}},
    {"message": {"chat": {"id": [GROUP_CHAT_ID], "type": "supergroup"}}},
    {"message": {"chat": {"id": True, "type": "supergroup"}}},
    {"message": []},
    [],
    None,
    "nope",
])
async def test_handle_update_never_raises(config, seams, update):
    """T5 has a backstop, but a `handle_update` that raises means the useful log line was
    never written. RED if any envelope check is dropped: `getUpdates` only guarantees a
    list, so a malformed element reaches here intact."""
    await _run(update, config, seams)

    assert seams.call_count == 0


async def test_a_bool_chat_id_is_never_admitted(config, monkeypatch, seams):
    """`True == 1` in Python, so an int-typed membership test admits `True` whenever the
    allowlist holds 1. RED if the id is taken straight from the envelope: `bool` is not a
    chat id, exactly as `reel_filter._entity_int` refuses it for an offset."""
    permissive = TelegramConfig(
        bot_token="t", allowed_chat_ids=frozenset({1}), ingest_user_id=INGEST_USER_ID,
    )
    message = _message(_reel("ABC123"), chat_id=True)

    await _run(_update(message), permissive, seams)

    assert seams.call_count == 0


# --------------------------------------------------------------------------------------
# Structural guards — properties a behavioural test cannot pin.
# --------------------------------------------------------------------------------------
def _module_tree() -> ast.Module:
    return ast.parse(inspect.getsource(ingest))


def test_the_module_reads_only_envelope_keys():
    """Guardrail #11, asserted from the AST rather than by grepping during review.

    `reel_filter` is the single reader of message content. Every key this module names —
    in a subscript or a `.get()` — must be an envelope field. RED the moment someone
    reaches for `message["text"]` to make an error line "more useful".
    """
    allowed = {"message", "chat", "id", "type", "message_id"}
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
    assert named <= allowed, f"unexpected message keys read: {sorted(named - allowed)}"


def test_the_module_never_calls_logger_exception_or_passes_exc_info():
    """`logger.exception` and `exc_info=True` print the exception's `__context__` chain,
    and this module wraps DB calls whose errors embed a URL, a row, or a service-role
    detail. Swallowing an exception does not erase what it carried."""
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute):
                assert node.func.attr != "exception", "logger.exception leaks __context__"
            assert not any(kw.arg == "exc_info" for kw in node.keywords)


def test_the_module_formats_no_exception_and_reads_exactly_one_vetted_attribute():
    """`test_worker.py:1279`'s guard, plus the half this module now needs on its own.

    `_react` reads `exc.description`, and may, for one reason: `api` builds that value
    through `_SAFE_DESCRIPTIONS` and `_react` gates the read behind `isinstance`. EVERY
    other attribute of an exception is raw — `.args`, `.message`, `.detail`, `.request`,
    `.response` carry whatever the callee put there, which on this module's call paths
    means a URL with the bot token in it, a Postgrest row, or a service-role detail.

    RED the moment a second attribute is read, which is the shape "let's make this error
    line more useful" always takes, and RED on `getattr(exc, …)`, which reaches the same
    attributes while stepping around the `isinstance` that makes the one read safe.

    ALSO RED ON ANY WRITE. `api` clamps `description` in its constructor, but the attribute
    is plain and mutable, so `exc.description = <raw server text>` between the raise and
    this log would satisfy the `isinstance` gate — which checks the exception's TYPE, not
    that the value is still allowlisted. A read-only property on the exception was the
    other way to close that; this is the cheaper one and it fails at CI rather than at
    runtime. See the note in `api.TelegramAPIError` for why the property was declined.
    """
    vetted = {"description"}
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {"str", "repr"} or not any(
                isinstance(arg, ast.Name) and arg.id == "exc" for arg in node.args
            ), "an exception value must never be formatted"
            assert not (
                node.func.id == "getattr" and node.args
                and isinstance(node.args[0], ast.Name) and node.args[0].id == "exc"
            ), "getattr on an exception steps around the isinstance check"
        # `type(exc).__name__` is an Attribute on a Call, not on the name `exc`, so the
        # permitted idiom does not need an exemption here.
        if (isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name)
                and node.value.id == "exc"):
            assert node.attr in vetted, f"unvetted exception attribute: exc.{node.attr}"
            assert isinstance(node.ctx, ast.Load), (
                f"exc.{node.attr} is written to; the clamp only runs in the constructor"
            )


def test_import_ingest_is_keyless_and_sdk_free_in_fresh_interpreter():
    """The repo's import-time invariant, in the shape `test_capture.py:157` established.

    A FRESH interpreter, not this one: by the time the full suite reaches this file some
    other module has already pulled `openai` into `sys.modules`, so an in-process
    assertion passes or fails on test ORDER and proves nothing about `ingest`. `ingest`
    imports `organizer`, which is one import away from the whole pipeline — a top-level
    `from agents import ...` added there would make the credential-free suite need a key.
    """
    code = (
        "import sys; from telegram_ingest import ingest; "
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
