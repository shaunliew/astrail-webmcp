"""worker — the process entrypoint. Offline, credential-free, no signals, no wall clock.

Five conventions carry the weight here, four of them bought by a defect this arc shipped:

  - **No test starts a real event loop with real signals, and none takes wall-clock time.**
    `_install_signal_handlers` takes its loop as a parameter so both signals can be proved
    registered against a fake; every other test monkeypatches it out. The drain deadline is
    a parameter, so its expiry is exercised with `deadline_s=0` in microseconds.
  - **Fakes prove sequencing, not counts.** `_FakeJobs` records enter/exit around real
    scheduler yields, so a worker pool interleaves visibly. A fake that only counted calls
    would pass with concurrency 4.
  - **Canaries are proved reachable.** Two companion tests reproduce the leak shapes — the
    `exc_info` chain into a log, and implicit `__context__` into a traceback — so the
    containment assertions above them are not vacuous truths.
  - **Instruments are proved to work.** `test_the_fake_db_records_an_rpc_call` exists
    because "no RPC was called at boot" is otherwise satisfied by a fake that cannot record
    one. Same for the admin fake: an `administrator` case proves the WARNING is conditional.
  - **A fresh interpreter, not this one,** for the import-time invariant — by the time the
    suite reaches this file `openai` is already in `sys.modules`, so an in-process
    assertion would pass on test ORDER (`test_capture.py:157` established the shape).

Seams: everything the worker calls is held as a MODULE-LEVEL name and monkeypatched here —
`get_supabase_client`, `get_me`, `get_chat_member`, `poll_forever`, `run_organize_job`,
`_install_signal_handlers`, `_make_http_client`, `_run`. That is the same seam
`test_poller.py` uses for `get_updates`, and it keeps every signature the plan pins
unchanged. `drain_deadline_s` IS a parameter because it is the worker's own dial.
"""
from __future__ import annotations

import ast
import asyncio
import inspect
import logging
import os
import signal
import subprocess
import sys
import traceback
from functools import partial
from pathlib import Path
from typing import Any

import pytest

from telegram_ingest import worker
from telegram_ingest.config import TelegramConfig

GROUP_CHAT_ID = -1001234567890
OTHER_CHAT_ID = -1009876543210
INGEST_USER_ID = "11111111-2222-3333-4444-555555555555"
BOT_ID = 424242
POLL_TIMEOUT_S = 7          # not the 50 default: proves the config is consulted
QUEUE_MAXSIZE = 5           # not the 100 default, same reason
CANARY = "CANARY-SECRET"


# --------------------------------------------------------------------------------------
# Fakes.
# --------------------------------------------------------------------------------------
class _FakeResponse:
    def __init__(self, data: Any) -> None:
        self.data = data


class _FakeQuery:
    """A postgrest query builder that records every link in the chain.

    It answers `maybe_single()` as well as `limit()` so the suite does not silently pin
    ONE query shape: the assertions below are about which TABLE and which COLUMNS were
    touched, which is what T7's migration and T8's rollback actually depend on.
    """

    def __init__(self, db: _FakeDB) -> None:
        self._db = db

    def select(self, *columns: str) -> _FakeQuery:
        self._db.chain.append(("select", columns))
        return self

    def eq(self, column: str, value: Any) -> _FakeQuery:
        self._db.chain.append(("eq", column, value))
        return self

    def limit(self, count: int) -> _FakeQuery:
        self._db.chain.append(("limit", count))
        return self

    def maybe_single(self) -> _FakeQuery:
        self._db.chain.append(("maybe_single",))
        return self

    async def execute(self) -> _FakeResponse:
        self._db.chain.append(("execute",))
        if self._db.raises is not None:
            raise self._db.raises
        return _FakeResponse(self._db.rows)


class _FakeDB:
    """The Supabase client. Records tables, columns and RPCs so "exactly one probe" is
    asserted from what was actually asked for, not from what the code looks like."""

    def __init__(self, *, rows: Any = None, raises: BaseException | None = None) -> None:
        self.rows = [] if rows is None else rows
        self.raises = raises
        self.chain: list[tuple] = []
        self.rpcs: list[tuple[str, Any]] = []

    def table(self, name: str) -> _FakeQuery:
        self.chain.append(("table", name))
        return _FakeQuery(self)

    def rpc(self, name: str, params: Any = None) -> _FakeQuery:
        self.rpcs.append((name, params))
        return _FakeQuery(self)


class _FakeTelegram:
    """`get_me` + `get_chat_member`. Statuses are per chat so a mixed allowlist is real."""

    def __init__(
        self,
        *,
        me: dict | None = None,
        statuses: dict[int, str] | None = None,
        me_error: BaseException | None = None,
        member_error: BaseException | dict[int, BaseException] | None = None,
    ) -> None:
        self.me = {"id": BOT_ID} if me is None else me
        self.statuses = statuses or {}
        self.me_error = me_error
        self.member_error = member_error
        self.me_calls = 0
        self.member_calls: list[tuple[int, Any]] = []

    async def get_me(self, *, client: Any, token: str) -> dict:
        self.me_calls += 1
        if self.me_error is not None:
            raise self.me_error
        return self.me

    async def get_chat_member(
        self, *, client: Any, token: str, chat_id: int, user_id: int
    ) -> dict:
        self.member_calls.append((chat_id, user_id))
        errors = self.member_error
        exc = errors.get(chat_id) if isinstance(errors, dict) else errors
        if exc is not None:
            raise exc
        return {"status": self.statuses.get(chat_id, "administrator")}


class _FakeHttp:
    """The long-lived client. Only `aclose` matters to the worker."""

    def __init__(self) -> None:
        self.closed = 0

    async def aclose(self) -> None:
        self.closed += 1


class _FakePoller:
    """`poll_forever`, scripted. Reaches the queue through the bound `handle` partial,
    which is also how the wiring assertions get at it."""

    def __init__(
        self,
        *,
        enqueue: tuple[str, ...] = (),
        fail: BaseException | None = None,
        hang: bool = False,
    ) -> None:
        self.kwargs: list[dict[str, Any]] = []
        self._enqueue = enqueue
        self._fail = fail
        self._hang = hang

    async def __call__(self, **kwargs: Any) -> None:
        self.kwargs.append(kwargs)
        queue = kwargs["handle"].keywords["queue"]
        for job_id in self._enqueue:
            queue.put_nowait(job_id)
        if self._fail is not None:
            raise self._fail
        # Setting `stop` IS the SIGTERM: the handler this fake replaces does exactly that.
        kwargs["stop"].set()
        if self._hang:
            # SIGTERM arrived mid-long-poll. The loop cannot observe `stop` until its
            # in-flight getUpdates returns, so shutdown must not depend on it returning.
            await asyncio.Event().wait()


class _FakeJobs:
    """`run_organize_job`. Records enter/exit AROUND real scheduler yields.

    The yields are the whole point: with them, two overlapping executions interleave in
    `trace` and `max_active` reaches 2. A fake that merely counted calls would be equally
    happy with a pool of four, which is the exact assertion-that-tests-nothing shape this
    package has already shipped once.
    """

    def __init__(
        self,
        *,
        raises: dict[str, BaseException] | None = None,
        hang: tuple[str, ...] = (),
    ) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.trace: list[tuple[str, str]] = []
        self.active = 0
        self.max_active = 0
        self._raises = raises or {}
        self._hang = set(hang)

    async def __call__(self, job_id: str, user_id: str, *, client: Any = None) -> dict:
        self.calls.append((job_id, user_id, client))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.trace.append(("enter", job_id))
        try:
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            if job_id in self._hang:
                await asyncio.Event().wait()
            exc = self._raises.get(job_id)
            if exc is not None:
                raise exc
            return {}
        finally:
            self.trace.append(("exit", job_id))
            self.active -= 1


class _FakeLoop:
    """`add_signal_handler` only. No real signal is ever installed by this suite."""

    def __init__(self) -> None:
        self.handlers: dict[int, Any] = {}

    def add_signal_handler(self, sig: int, callback: Any) -> None:
        self.handlers[sig] = callback


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
        bot_token=f"123456:{CANARY}-BOT-TOKEN",
        allowed_chat_ids=frozenset({GROUP_CHAT_ID, OTHER_CHAT_ID}),
        ingest_user_id=INGEST_USER_ID,
        poll_timeout_s=POLL_TIMEOUT_S,
        queue_maxsize=QUEUE_MAXSIZE,
    )


class _Rig:
    """Everything `_run` needs, with every collaborator faked."""

    def __init__(
        self,
        config: TelegramConfig,
        monkeypatch: pytest.MonkeyPatch,
        *,
        db: _FakeDB | None = None,
        telegram: _FakeTelegram | None = None,
        poller: _FakePoller | None = None,
        jobs: _FakeJobs | None = None,
    ) -> None:
        self.db = db if db is not None else _FakeDB(rows=[{"id": INGEST_USER_ID}])
        self.telegram = telegram or _FakeTelegram()
        self.poller = poller or _FakePoller()
        self.jobs = jobs or _FakeJobs()
        self.http = _FakeHttp()
        self.signal_installs: list[asyncio.Event] = []
        self._config = config

        async def _client() -> _FakeDB:
            return self.db

        monkeypatch.setattr(worker, "get_supabase_client", _client)
        monkeypatch.setattr(worker, "get_me", self.telegram.get_me)
        monkeypatch.setattr(worker, "get_chat_member", self.telegram.get_chat_member)
        monkeypatch.setattr(worker, "poll_forever", self.poller)
        monkeypatch.setattr(worker, "run_organize_job", self.jobs)
        monkeypatch.setattr(
            worker, "_install_signal_handlers",
            lambda stop, *, loop: self.signal_installs.append(stop),
        )

    async def run(self, *, drain_deadline_s: float = 5.0) -> None:
        await worker._run(
            self._config, http=self.http, drain_deadline_s=drain_deadline_s
        )


async def _drive_consumer(
    queue: asyncio.Queue, *, db: Any = None, user_id: str = INGEST_USER_ID
) -> None:
    """Run one `_consume` task until the queue is fully accounted for, then cancel it.

    `wait_for` rather than a bare `join()`: a regression that drops `task_done` should
    fail this suite in a second, not hang it forever.
    """
    consumer = asyncio.create_task(_consume_task(queue, db=db, user_id=user_id))
    try:
        await asyncio.wait_for(queue.join(), timeout=1.0)
    finally:
        consumer.cancel()
        await asyncio.gather(consumer, return_exceptions=True)


def _consume_task(queue: asyncio.Queue, *, db: Any, user_id: str):
    return worker._consume(queue, db=db, user_id=user_id)


# --------------------------------------------------------------------------------------
# 1. Config errors are fatal and precede everything.
# --------------------------------------------------------------------------------------
async def test_a_missing_secret_kills_boot_before_anything_is_constructed(monkeypatch):
    """`validate_required_secrets` is statement ONE, outside every `try`.

    RED if it moves inside one — which is the exact defect `config_validation.py`'s
    docstring exists to prevent: a swallowed missing secret boots a worker that fails on
    every reel with no clue why, and Render keeps the broken process alive.
    """
    touched: list[str] = []

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("Missing required environment variables: OPENAI_API_KEY")

    monkeypatch.setattr(worker, "validate_required_secrets", _boom)
    monkeypatch.setattr(worker, "load_telegram_config",
                        lambda *a, **k: touched.append("config"))
    monkeypatch.setattr(worker, "_make_http_client",
                        lambda *a, **k: touched.append("http"))
    monkeypatch.setattr(worker, "_run", lambda *a, **k: touched.append("run"))

    with pytest.raises(RuntimeError, match="Missing required environment variables"):
        await worker.main()

    assert touched == []


async def test_a_rejected_telegram_config_kills_boot_before_anything_is_constructed(
    monkeypatch,
):
    """Statement TWO, also outside every `try`. Same fatality, same reason."""
    touched: list[str] = []

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("Telegram worker configuration rejected.")

    monkeypatch.setattr(worker, "validate_required_secrets", lambda *a, **k: None)
    monkeypatch.setattr(worker, "load_telegram_config", _boom)
    monkeypatch.setattr(worker, "_make_http_client",
                        lambda *a, **k: touched.append("http"))
    monkeypatch.setattr(worker, "_run", lambda *a, **k: touched.append("run"))

    with pytest.raises(RuntimeError, match="configuration rejected"):
        await worker.main()

    assert touched == []


async def test_a_programmer_config_error_is_also_fatal_at_boot(monkeypatch):
    """T3 HANDOFF. `TelegramConfig.__post_init__` raises `ValueError`, not `RuntimeError`,
    for an allowlist that authorizes nothing.

    The loader cannot produce it today, so this pins the CONTAINMENT decision rather than
    a reachable path: boot catches nothing at all here, so both classes kill the process.
    RED the moment someone adds `except RuntimeError:` around the two boot statements —
    that wrapper would let a fail-open config through while looking careful.
    """
    touched: list[str] = []

    def _boom(*args: Any, **kwargs: Any) -> None:
        raise ValueError("allowed_chat_ids must name at least one chat")

    monkeypatch.setattr(worker, "validate_required_secrets", lambda *a, **k: None)
    monkeypatch.setattr(worker, "load_telegram_config", _boom)
    monkeypatch.setattr(worker, "_make_http_client",
                        lambda *a, **k: touched.append("http"))
    monkeypatch.setattr(worker, "_run", lambda *a, **k: touched.append("run"))

    with pytest.raises(ValueError, match="at least one chat"):
        await worker.main()

    assert touched == []


def test_the_two_validators_are_the_first_two_statements_of_main():
    """Structural, because behaviour cannot see PLACEMENT.

    A `try` wrapping them would still re-raise in the tests above if the handler re-raised,
    so this pins the shape the plan calls load-bearing: two bare statements, then the rest.
    """
    tree = _function_tree("main")
    first, second = tree.body[1], tree.body[2]        # body[0] is the docstring
    assert isinstance(first, ast.Expr) and isinstance(first.value, ast.Call)
    assert first.value.func.id == "validate_required_secrets"
    assert isinstance(second, ast.Assign) and isinstance(second.value, ast.Call)
    assert second.value.func.id == "load_telegram_config"


# --------------------------------------------------------------------------------------
# 2. The ingest-user probe fails boot.
# --------------------------------------------------------------------------------------
async def test_an_absent_ingest_user_fails_boot(config, monkeypatch):
    """A wrong or absent UUID must fail HERE, not on every reel for the life of a deploy.

    RED if the probe's result is ignored: the poller would start and the fake would record
    a call.
    """
    rig = _Rig(config, monkeypatch, db=_FakeDB(rows=[]))

    with pytest.raises(RuntimeError, match="ASTRAIL_INGEST_USER_ID"):
        await rig.run()

    assert rig.poller.kwargs == []


async def test_a_probe_transport_failure_is_fatal_too(config, monkeypatch):
    """Plan §T6 controller resolution: booting into a poll loop that will fail every reel
    is worse than crash-looping visibly, and Render's restart backoff covers a blip."""
    rig = _Rig(config, monkeypatch,
               db=_FakeDB(raises=ConnectionError("connection refused")))

    with pytest.raises(RuntimeError, match="ConnectionError"):
        await rig.run()

    assert rig.poller.kwargs == []


async def test_the_probe_failure_carries_no_value_into_the_traceback():
    """Defect class #1, at the one boundary that holds the service-role client.

    A postgrest `APIError` embeds request detail and an httpx error's `str()` can be the
    request URL. `from None` is what keeps the implicit `__context__` chain — which
    `traceback.format_exception` prints as "During handling of the above exception" — out
    of the stderr of a process that is about to die loudly.
    """
    db = _FakeDB(raises=RuntimeError(f"{CANARY} in the driver message"))

    with pytest.raises(RuntimeError) as caught:
        await worker._probe_ingest_user(db, INGEST_USER_ID)

    rendered = "".join(traceback.format_exception(caught.value))
    assert "CANARY" not in rendered, rendered
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__ is True
    assert "RuntimeError" in str(caught.value)


async def test_the_canary_reaches_the_traceback_when_the_raise_is_careless():
    """Proves the assertion above is not vacuous: without `from None` the value travels."""
    try:
        try:
            raise RuntimeError(f"{CANARY} in the driver message")
        except RuntimeError:
            raise RuntimeError("Ingest user probe failed: RuntimeError")
    except RuntimeError as exc:
        rendered = "".join(traceback.format_exception(exc))

    assert CANARY in rendered


async def test_a_present_ingest_user_boots_and_says_so(config, monkeypatch, caplog):
    rig = _Rig(config, monkeypatch)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    ok = _records(caplog, "telegram_ingest_user_ok")
    assert len(ok) == 1 and ok[0].levelno == logging.INFO


# --------------------------------------------------------------------------------------
# 3. The probe is the ONLY probe.
# --------------------------------------------------------------------------------------
async def test_boot_makes_exactly_one_probe_and_never_touches_the_quota_column(
    config, monkeypatch
):
    """T7's migration and T8's rollback need ZERO code coordination, and this is why.

    A probe of `daily_reel_analysis_limit` here would make the rollback a code change —
    and, worse, would silently destroy it (T8). "For safety" is exactly how that lands.
    """
    rig = _Rig(config, monkeypatch)

    await rig.run()

    assert rig.db.rpcs == []
    assert ("table", "users") in rig.db.chain
    assert ("eq", "id", INGEST_USER_ID) in rig.db.chain
    assert len([link for link in rig.db.chain if link[0] == "execute"]) == 1
    assert "daily_reel_analysis_limit" not in repr(rig.db.chain)


def test_the_module_never_mentions_the_quota_column_at_all():
    """The source, not just the calls: a commented-out probe is a probe waiting to return."""
    assert "daily_reel_analysis_limit" not in inspect.getsource(worker)


async def test_the_fake_db_records_an_rpc_call(config):
    """Proves `rig.db.rpcs == []` above is an assertion and not a tautology.

    An instrument that cannot register the thing it is checking for is the third defect
    class this arc hit: a canary that cannot reach the branch it claims to test.
    """
    db = _FakeDB()

    db.rpc("claim_organize_job", {"p_job_id": "x"})

    assert db.rpcs == [("claim_organize_job", {"p_job_id": "x"})]


# --------------------------------------------------------------------------------------
# 4. The admin check — WARNING, and boot continues.
# --------------------------------------------------------------------------------------
async def test_a_non_administrator_logs_a_warning_and_boot_continues(
    config, monkeypatch, caplog
):
    """Risk #2, and the single most valuable line in the file.

    Without administrator status Telegram's privacy mode hides every plain-URL message:
    the bot sees NOTHING, no error is raised anywhere, and the deploy is indistinguishable
    from one that never happened. RED if this becomes fatal, and RED if it becomes silent
    — the silent version reproduces risk #2 exactly.
    """
    telegram = _FakeTelegram(statuses={GROUP_CHAT_ID: "member"})
    rig = _Rig(config, monkeypatch, telegram=telegram)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    warned = _records(caplog, "telegram_bot_not_admin")
    assert len(warned) == 1 and warned[0].levelno == logging.WARNING
    assert f"chat_id={GROUP_CHAT_ID}" in warned[0].getMessage()
    assert len(rig.poller.kwargs) == 1          # boot continued


async def test_an_administrator_is_silent(config, monkeypatch, caplog):
    """The other half, without which the test above passes for a module that warns
    unconditionally — a fixture whose natural state satisfies the assertion."""
    rig = _Rig(config, monkeypatch)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert _records(caplog, "telegram_bot_not_admin") == []
    assert rig.telegram.member_calls == [(OTHER_CHAT_ID, BOT_ID), (GROUP_CHAT_ID, BOT_ID)]


async def test_the_admin_check_covers_every_allowlisted_chat(config, monkeypatch, caplog):
    """Two chats, one bad. The check is per chat, not "the first chat"."""
    telegram = _FakeTelegram(statuses={GROUP_CHAT_ID: "left", OTHER_CHAT_ID: "member"})
    rig = _Rig(config, monkeypatch, telegram=telegram)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert len(_records(caplog, "telegram_bot_not_admin")) == 2


# --------------------------------------------------------------------------------------
# 5. An admin-check exception is a WARNING, not fatal.
# --------------------------------------------------------------------------------------
async def test_a_get_me_blip_is_a_warning_and_boot_proceeds(config, monkeypatch, caplog):
    """A Telegram blip at boot must not stop a worker whose whole job is to poll Telegram
    until Telegram comes back."""
    telegram = _FakeTelegram(me_error=RuntimeError(f"{CANARY} getMe exploded"))
    rig = _Rig(config, monkeypatch, telegram=telegram)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    failed = _records(caplog, "telegram_admin_check_failed")
    assert len(failed) == 1 and failed[0].levelno == logging.WARNING
    assert "RuntimeError" in failed[0].getMessage()
    assert "CANARY" not in _formatted(caplog)
    assert len(rig.poller.kwargs) == 1
    assert telegram.member_calls == []


async def test_a_get_chat_member_blip_still_checks_the_remaining_chats(
    config, monkeypatch, caplog
):
    """Contained PER CHAT, not just around the loop.

    A bot removed from one allowlisted chat makes `getChatMember` fail for that chat. With
    one `try` around the loop, every chat after it goes unchecked — and an unchecked chat
    is exactly the silent privacy-mode failure this check exists to catch.
    """
    telegram = _FakeTelegram(
        statuses={GROUP_CHAT_ID: "member"},
        member_error={OTHER_CHAT_ID: RuntimeError("chat not found")},
    )
    rig = _Rig(config, monkeypatch, telegram=telegram)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert len(_records(caplog, "telegram_admin_check_failed")) == 1
    assert len(_records(caplog, "telegram_bot_not_admin")) == 1
    assert len(rig.poller.kwargs) == 1


async def test_a_malformed_get_me_does_not_query_chat_membership(
    config, monkeypatch, caplog
):
    """`bool` excluded for the reason `ingest._chat_id` excludes it.

    Without the guard a malformed getMe sends `user_id=None` to every getChatMember, and
    the resulting failures read as "the bot is not an admin" — a diagnosis pointing at the
    wrong problem is worse than none.
    """
    telegram = _FakeTelegram(me={"id": True})
    rig = _Rig(config, monkeypatch, telegram=telegram)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    assert len(_records(caplog, "telegram_admin_check_failed")) == 1
    assert telegram.member_calls == []
    assert len(rig.poller.kwargs) == 1


# --------------------------------------------------------------------------------------
# 6. One consumer, concurrency 1.
# --------------------------------------------------------------------------------------
async def test_jobs_run_strictly_one_at_a_time(config, monkeypatch):
    """One consumer task = concurrency 1. No semaphore, no pool, no `gather` over N.

    The fake yields to the scheduler twice inside each job, so a second consumer WOULD
    interleave here — `trace` would read enter/enter/exit/exit and `max_active` would
    reach 2. Asserting a call count instead would pass with a pool of four.
    """
    jobs = _FakeJobs()
    monkeypatch.setattr(worker, "run_organize_job", jobs)
    queue: asyncio.Queue[str] = asyncio.Queue()
    for job_id in ("job-1", "job-2", "job-3"):
        queue.put_nowait(job_id)

    await _drive_consumer(queue, db="DB")

    assert jobs.max_active == 1
    assert jobs.trace == [
        ("enter", "job-1"), ("exit", "job-1"),
        ("enter", "job-2"), ("exit", "job-2"),
        ("enter", "job-3"), ("exit", "job-3"),
    ]


async def test_the_consumer_passes_the_ingest_user_and_the_shared_client(
    config, monkeypatch
):
    """`run_organize_job(job_id, INGEST_USER_ID, client=db)` — the ingest account owns
    every job, and the client is the one the worker already built."""
    jobs = _FakeJobs()
    monkeypatch.setattr(worker, "run_organize_job", jobs)
    queue: asyncio.Queue[str] = asyncio.Queue()
    queue.put_nowait("job-1")

    await _drive_consumer(queue, db="SHARED-DB")

    assert jobs.calls == [("job-1", INGEST_USER_ID, "SHARED-DB")]


# --------------------------------------------------------------------------------------
# 7 + 8. A failed job is contained, is not re-enqueued, and always calls task_done.
# --------------------------------------------------------------------------------------
async def test_a_failed_job_neither_stops_the_consumer_nor_is_re_enqueued(
    config, monkeypatch, caplog
):
    """Guardrail #3, plus the reason there is no retry here.

    The row is already in `organize_jobs`; the EXISTING web reaper picks it up within
    120 s. Re-enqueueing would start a private retry loop competing with the reaper.
    """
    jobs = _FakeJobs(raises={"job-2": RuntimeError("boom")})
    monkeypatch.setattr(worker, "run_organize_job", jobs)
    queue: asyncio.Queue[str] = asyncio.Queue()
    for job_id in ("job-1", "job-2", "job-3"):
        queue.put_nowait(job_id)

    with caplog.at_level(logging.DEBUG):
        await _drive_consumer(queue, db="DB")

    assert [call[0] for call in jobs.calls] == ["job-1", "job-2", "job-3"]
    failed = _records(caplog, "telegram_job_failed")
    assert len(failed) == 1 and failed[0].levelno == logging.ERROR
    assert "job_id=job-2" in failed[0].getMessage()
    assert "RuntimeError" in failed[0].getMessage()
    assert queue.qsize() == 0


async def test_task_done_is_called_on_the_failure_path(config, monkeypatch):
    """RED if `task_done` sits outside a `finally`: `queue.join()` never completes and the
    drain below burns its whole deadline on a queue that is actually empty."""
    jobs = _FakeJobs(raises={"job-1": RuntimeError("boom")})
    monkeypatch.setattr(worker, "run_organize_job", jobs)
    queue: asyncio.Queue[str] = asyncio.Queue()
    queue.put_nowait("job-1")
    consumer = asyncio.create_task(worker._consume(queue, db="DB", user_id=INGEST_USER_ID))

    try:
        await asyncio.wait_for(queue.join(), timeout=1.0)
    finally:
        consumer.cancel()
        await asyncio.gather(consumer, return_exceptions=True)

    assert queue._unfinished_tasks == 0


async def test_task_done_is_called_when_the_consumer_is_cancelled_mid_job(monkeypatch):
    """RED if `task_done` sits after the `try` instead of inside a `finally`.

    Fault injection found this: moving it out is invisible on the failure path, because
    `except Exception` catches and execution falls through to the next statement anyway.
    The difference is CANCELLATION — `CancelledError` derives from `BaseException`, so it
    is not caught, and a consumer cancelled inside `run_organize_job` (exactly what the
    drain deadline does) would leave the item unaccounted for and `queue.join()` able to
    hang forever.
    """
    jobs = _FakeJobs(hang=("job-1",))
    monkeypatch.setattr(worker, "run_organize_job", jobs)
    queue: asyncio.Queue[str] = asyncio.Queue()
    queue.put_nowait("job-1")
    consumer = asyncio.create_task(worker._consume(queue, db="DB", user_id=INGEST_USER_ID))
    for _ in range(10):                      # let the consumer get INSIDE the job
        if jobs.trace:
            break
        await asyncio.sleep(0)
    assert jobs.trace == [("enter", "job-1")], "the consumer never entered the job"

    consumer.cancel()
    await asyncio.gather(consumer, return_exceptions=True)

    await asyncio.wait_for(queue.join(), timeout=1.0)


# --------------------------------------------------------------------------------------
# 9 + 10. Shutdown: drain, deadline, exit 0.
# --------------------------------------------------------------------------------------
async def test_sigterm_drains_the_queue_and_returns_cleanly(config, monkeypatch, caplog):
    """The whole shutdown path. `_run` returning normally IS exit 0 — nothing in this
    module calls `sys.exit`, and a non-zero exit makes Render report a crash on every
    routine deploy."""
    poller = _FakePoller(enqueue=("job-1", "job-2"))
    jobs = _FakeJobs()
    rig = _Rig(config, monkeypatch, poller=poller, jobs=jobs)

    with caplog.at_level(logging.DEBUG):
        assert await rig.run() is None

    draining = _records(caplog, "telegram_worker_draining")
    assert len(draining) == 1 and draining[0].levelno == logging.INFO
    assert "queued=" in draining[0].getMessage()
    # The full tuple, not just the ids. Fault injection found the hole: wiring the
    # consumer to any other user id leaves every job claiming nothing — the CAS in
    # `run_organize_job` filters on `user_id`, so a wrong one returns "job not found" and
    # the whole worker becomes a silent no-op that passes an ids-only assertion.
    assert jobs.calls == [
        ("job-1", INGEST_USER_ID, rig.db), ("job-2", INGEST_USER_ID, rig.db)
    ]
    stopped = _records(caplog, "telegram_worker_stopped")
    assert len(stopped) == 1 and stopped[0].levelno == logging.INFO


async def test_shutdown_does_not_wait_for_a_poller_still_holding_its_long_poll(
    config, monkeypatch, caplog
):
    """`hang=True` is SIGTERM arriving mid-`getUpdates`.

    `poll_forever` cannot observe `stop` until its in-flight long poll returns, which is
    up to `poll_timeout_s` — most of Render's 120 s budget. RED (a hang) if shutdown
    awaits the poller instead of cancelling it.
    """
    poller = _FakePoller(enqueue=("job-1",), hang=True)
    rig = _Rig(config, monkeypatch, poller=poller)

    with caplog.at_level(logging.DEBUG):
        await asyncio.wait_for(rig.run(), timeout=2.0)

    assert len(_records(caplog, "telegram_worker_stopped")) == 1


async def test_the_drain_deadline_is_honoured_and_the_exit_is_still_clean(
    config, monkeypatch, caplog
):
    """A job that never finishes is cancelled at the deadline and the process still exits
    cleanly. Anything still in flight holds a lease that expires in <=300 s and is
    reclaimed by the EXISTING web reaper — designed behaviour, not a leak."""
    poller = _FakePoller(enqueue=("job-1",))
    jobs = _FakeJobs(hang=("job-1",))
    rig = _Rig(config, monkeypatch, poller=poller, jobs=jobs)

    with caplog.at_level(logging.DEBUG):
        # `wait_for` so a regression that drops the deadline fails in two seconds instead
        # of hanging the suite forever on a job that never finishes.
        assert await asyncio.wait_for(rig.run(drain_deadline_s=0.0), timeout=2.0) is None

    exceeded = _records(caplog, "telegram_drain_deadline_exceeded")
    assert len(exceeded) == 1 and exceeded[0].levelno == logging.WARNING
    assert len(_records(caplog, "telegram_worker_stopped")) == 1


def test_the_drain_deadline_is_comfortably_under_rendered_shutdown_budget():
    """T9 sets `maxShutdownDelaySeconds: 120`. The deadline must leave room for closing
    the HTTP client and for Render's own teardown."""
    assert 0 < worker._DRAIN_DEADLINE_S <= 60.0


def test_nothing_in_the_module_exits_non_zero():
    """A clean shutdown is not a failure. RED if someone adds `sys.exit(1)` to the drain
    timeout path, which would make every routine deploy look like a crash."""
    assert "sys.exit" not in inspect.getsource(worker)


async def test_a_poller_that_dies_ends_the_run_loudly(config, monkeypatch, caplog):
    """Absence-pass finding: `poll_forever` contains its own failures, so a crash here is
    unlikely — and if it ever happens, a worker that stays alive with a dead poll loop is
    silent in exactly the way risk #2 is silent. It must end the run and say why."""
    poller = _FakePoller(fail=RuntimeError(f"{CANARY} poller died"))
    rig = _Rig(config, monkeypatch, poller=poller)

    with caplog.at_level(logging.DEBUG):
        await asyncio.wait_for(rig.run(), timeout=2.0)

    failed = _records(caplog, "telegram_worker_poller_failed")
    assert len(failed) == 1 and failed[0].levelno == logging.ERROR
    assert "RuntimeError" in failed[0].getMessage()
    assert "CANARY" not in _formatted(caplog)


# --------------------------------------------------------------------------------------
# 11. The HTTP client is closed on shutdown, including on the error path.
# --------------------------------------------------------------------------------------
async def test_the_http_client_is_closed_on_the_happy_path(config, monkeypatch):
    http = _FakeHttp()
    monkeypatch.setattr(worker, "validate_required_secrets", lambda *a, **k: None)
    monkeypatch.setattr(worker, "load_telegram_config", lambda *a, **k: config)
    monkeypatch.setattr(worker, "_make_http_client", lambda *a, **k: http)

    async def _run(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(worker, "_run", _run)

    assert await worker.main() is None
    assert http.closed == 1


async def test_the_http_client_is_closed_when_boot_fails(config, monkeypatch):
    """RED if the client is closed after `_run` returns rather than in a `finally`: a
    crash-looping worker would leak a connection pool per restart."""
    http = _FakeHttp()
    monkeypatch.setattr(worker, "validate_required_secrets", lambda *a, **k: None)
    monkeypatch.setattr(worker, "load_telegram_config", lambda *a, **k: config)
    monkeypatch.setattr(worker, "_make_http_client", lambda *a, **k: http)

    async def _run(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("ASTRAIL_INGEST_USER_ID does not name a row")

    monkeypatch.setattr(worker, "_run", _run)

    with pytest.raises(RuntimeError):
        await worker.main()

    assert http.closed == 1


async def test_the_http_client_timeout_outlives_the_long_poll(config):
    """Long polling holds the socket for the whole server-side timeout, so a client
    timeout of `poll_timeout_s` exactly would abort every idle poll."""
    client = worker._make_http_client(config)
    try:
        assert client.timeout.read == POLL_TIMEOUT_S + 15
        assert client.timeout.connect == POLL_TIMEOUT_S + 15
    finally:
        await client.aclose()


# --------------------------------------------------------------------------------------
# 12. No secret and no content in any log.
# --------------------------------------------------------------------------------------
async def test_no_secret_or_content_reaches_any_log_record(config, monkeypatch, caplog):
    """Defect class #1, at the process that holds BOTH the bot token and the service-role
    key. The assertion is on `CANARY`, not the full string, so it also catches the
    fixture's bot token (`123456:CANARY-SECRET-BOT-TOKEN`).
    """
    poller = _FakePoller(enqueue=("job-1",))
    jobs = _FakeJobs(raises={"job-1": RuntimeError(f"{CANARY} and CANARY-CONTENT")})
    rig = _Rig(config, monkeypatch, poller=poller, jobs=jobs)

    with caplog.at_level(logging.DEBUG):
        await rig.run()

    emitted = _formatted(caplog)
    assert "CANARY" not in emitted, emitted
    assert all(record.exc_info is None for record in caplog.records)
    failed = _records(caplog, "telegram_job_failed")
    assert len(failed) == 1
    assert "RuntimeError" in failed[0].getMessage()
    assert "job_id=job-1" in failed[0].getMessage()


async def test_the_canary_reaches_the_log_when_the_module_is_careless(caplog):
    """Proves the previous test's canary CAN travel — its assertion is not vacuous.

    T3 shipped a leak test whose canary could never echo: impeccable-looking, asserting
    nothing. This reproduces the exact leak shape against a throwaway logger.
    """
    logger = logging.getLogger("telegram_ingest.test_worker_canary")
    with caplog.at_level(logging.DEBUG):
        try:
            try:
                raise RuntimeError(f"{CANARY} and CANARY-CONTENT")
            except RuntimeError:
                raise ValueError("wrapped")   # no `from`: implicit __context__ chains
        except ValueError:
            logger.error("telegram_job_failed job_id=job-1", exc_info=True)

    assert CANARY in _formatted(caplog)


async def test_the_starting_line_carries_a_chat_COUNT_and_not_the_ids(
    config, monkeypatch, caplog
):
    """Scalars only, and the allowlist is a count. An operator needs to know the bot
    booted with two chats, not which two — and the log is the one place a copy of the
    configuration would sit forever."""
    monkeypatch.setattr(worker, "validate_required_secrets", lambda *a, **k: None)
    monkeypatch.setattr(worker, "load_telegram_config", lambda *a, **k: config)
    monkeypatch.setattr(worker, "_make_http_client", lambda *a, **k: _FakeHttp())

    async def _run(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(worker, "_run", _run)

    with caplog.at_level(logging.DEBUG):
        await worker.main()

    starting = _records(caplog, "telegram_worker_starting")
    assert len(starting) == 1 and starting[0].levelno == logging.INFO
    message = starting[0].getMessage()
    assert "chats=2" in message
    assert str(GROUP_CHAT_ID) not in message
    assert "CANARY" not in message


# --------------------------------------------------------------------------------------
# Wiring — the dependencies the worker constructs.
# --------------------------------------------------------------------------------------
async def test_the_worker_pins_the_update_subscription(config, monkeypatch):
    """T5 HANDOFF. `get_updates` defaults `allowed_updates` to `("message",)` and nothing
    pinned it, so widening that default would silently start delivering `edited_message`
    and `channel_post` to `handle_update`. The wiring layer owns the subscription."""
    rig = _Rig(config, monkeypatch)

    await rig.run()

    assert rig.poller.kwargs[0]["allowed_updates"] == ("message",)


async def test_the_handle_passed_to_the_poller_binds_every_dependency(
    config, monkeypatch
):
    """`handle` is `handle_update` with config/db/http/queue already bound — which is what
    keeps the poller ignorant of Supabase entirely."""
    rig = _Rig(config, monkeypatch)

    await rig.run()

    handle = rig.poller.kwargs[0]["handle"]
    assert isinstance(handle, partial)
    assert handle.func is worker.handle_update
    assert set(handle.keywords) == {"config", "db", "http", "queue"}
    assert handle.keywords["config"] is config
    assert handle.keywords["db"] is rig.db
    assert handle.keywords["http"] is rig.http


async def test_the_queue_is_bounded_by_the_configured_maxsize(config, monkeypatch):
    """`QueueFull` is not a failure — the job row already exists and the existing reaper
    runs it — but an UNBOUNDED queue would let a burst pin memory instead."""
    rig = _Rig(config, monkeypatch)

    await rig.run()

    assert rig.poller.kwargs[0]["handle"].keywords["queue"].maxsize == QUEUE_MAXSIZE


async def test_the_poller_and_the_telegram_calls_share_one_http_client(
    config, monkeypatch
):
    """One long-lived client for the process: T1's functions take it as a required keyword
    and never create or close one."""
    rig = _Rig(config, monkeypatch)

    await rig.run()

    assert rig.poller.kwargs[0]["http"] is rig.http
    assert rig.poller.kwargs[0]["handle"].keywords["http"] is rig.http


# --------------------------------------------------------------------------------------
# Signals — proved without installing one.
# --------------------------------------------------------------------------------------
def test_both_termination_signals_set_the_stop_event():
    """SIGTERM is Render's deploy/scale-down signal; SIGINT is a local Ctrl-C. RED if
    either is dropped: SIGTERM alone means Ctrl-C kills a local worker mid-job, and SIGINT
    alone means every Render deploy waits out the SIGKILL timer."""
    loop = _FakeLoop()
    stop = asyncio.Event()

    worker._install_signal_handlers(stop, loop=loop)

    assert set(loop.handlers) == {signal.SIGTERM, signal.SIGINT}
    for callback in loop.handlers.values():
        stop.clear()
        callback()
        assert stop.is_set()


async def test_the_run_installs_the_handlers_against_the_running_loop(
    config, monkeypatch
):
    """The stop event the handlers set must be the one the poller is watching."""
    rig = _Rig(config, monkeypatch)

    await rig.run()

    assert len(rig.signal_installs) == 1
    assert rig.signal_installs[0] is rig.poller.kwargs[0]["stop"]


# --------------------------------------------------------------------------------------
# Logging setup — a Render worker has no uvicorn to configure it.
# --------------------------------------------------------------------------------------
@pytest.fixture
def configured_logging():
    """Run `_configure_logging` for real, then put the process back exactly as it was.

    `basicConfig` mutates the ROOT logger, and pytest's own capture lives there — leaving
    it changed would leak into every test that runs after this file.
    """
    root = logging.getLogger()
    saved = (root.level, root.handlers[:])
    saved_transports = {
        name: logging.getLogger(name).level for name in worker._NOISY_TRANSPORT_LOGGERS
    }
    root.handlers.clear()
    try:
        worker._configure_logging()
        yield root
    finally:
        root.handlers[:] = saved[1]
        root.setLevel(saved[0])
        for name, level in saved_transports.items():
            logging.getLogger(name).setLevel(level)


def test_configure_logging_makes_info_visible(configured_logging):
    """Without this the root logger stays at WARNING and every INFO event in the table —
    including the heartbeat, the ONLY liveness signal a Render worker has — is invisible.
    "Alive and idle" and "dead" would look identical."""
    assert configured_logging.level == logging.INFO
    assert configured_logging.handlers


def test_configure_logging_keeps_the_bot_token_out_of_httpx_request_lines(
    configured_logging, caplog
):
    """Absence pass, and the worst thing this file could have shipped.

    `httpx` logs `HTTP Request: POST <url> "HTTP/1.1 200 OK"` at INFO, and the bot token
    is IN that URL. Raising the root logger to INFO — which the test above REQUIRES —
    would print a live credential on every poll, defeating everything `api.py` does. The
    two requirements are in direct tension, so both are pinned here.
    """
    leaky = f'HTTP Request: POST https://api.telegram.org/bot123456:{CANARY}/getMe "200"'
    with caplog.at_level(logging.INFO):
        logging.getLogger("httpx").info(leaky)

    assert "CANARY" not in _formatted(caplog), _formatted(caplog)


def test_an_ordinary_info_line_still_reaches_the_log(configured_logging, caplog):
    """Proves the assertion above is about `httpx` specifically and not about a caplog
    that captures nothing — the fixture-already-satisfies-the-assertion defect."""
    with caplog.at_level(logging.INFO):
        logging.getLogger("telegram_ingest.test_worker_visible").info(f"{CANARY} visible")

    assert CANARY in _formatted(caplog)


# --------------------------------------------------------------------------------------
# Structural guards — properties a behavioural test cannot pin.
# --------------------------------------------------------------------------------------
def _module_tree() -> ast.Module:
    return ast.parse(inspect.getsource(worker))


def _function_tree(name: str) -> ast.AsyncFunctionDef | ast.FunctionDef:
    for node in _module_tree().body:
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef)) and node.name == name:
            return node
    raise AssertionError(f"{name} is no longer a module-level function")


def test_the_module_never_calls_logger_exception_or_passes_exc_info():
    """`logger.exception` and `exc_info=True` print the exception's `__context__` chain,
    and this process holds both the bot token and the service-role key."""
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute):
                assert node.func.attr != "exception", "logger.exception leaks __context__"
            assert not any(kw.arg == "exc_info" for kw in node.keywords)


def test_the_module_never_formats_an_exception_value():
    """Only `type(exc).__name__` may reach a log line. RED on `str(exc)`, `repr(exc)` or a
    bare `%s` of the exception object — every one of which can carry a URL or a row."""
    for node in ast.walk(_module_tree()):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {"str", "repr"} or not any(
                isinstance(arg, ast.Name) and arg.id == "exc" for arg in node.args
            ), "an exception value must never be formatted"


def test_import_worker_is_keyless_and_sdk_free_in_fresh_interpreter():
    """The repo's import-time invariant, in the shape `test_capture.py:157` established.

    A FRESH interpreter, not this one: by the time the full suite reaches this file some
    other module has already pulled `openai` into `sys.modules`, so an in-process
    assertion would pass or fail on test ORDER (T4 hit exactly that). This also proves
    `python -m telegram_ingest.worker` can reach the module with `backend/` as cwd.
    """
    code = (
        "import sys; from telegram_ingest import worker; "
        "assert 'agents' not in sys.modules, 'Agents SDK imported at import time'; "
        "assert 'openai' not in sys.modules, 'openai imported at import time'; "
        "print('IMPORT_OK')"
    )
    env = {
        k: v for k, v in os.environ.items()
        if k not in ("OPENAI_API_KEY", "APIFY_TOKEN", "MAPBOX_SECRET_TOKEN",
                     "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                     "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS",
                     "ASTRAIL_INGEST_USER_ID")
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


def test_the_module_runs_as_python_m_and_dies_loudly_without_its_secrets():
    """The entrypoint itself — `python -m telegram_ingest.worker` with `backend/` as cwd,
    which is exactly what T9's `dockerCommand` runs.

    Absence-pass finding: the import test above proves the module LOADS, and every other
    test calls `main()` directly. Nothing exercised the `__main__` block, so a broken
    `-m` invocation, a missing `asyncio.run`, or a `_configure_logging` that raised would
    have shipped green and only failed on Render.

    A real bot token IS in the environment here and a required secret is not, so the run
    dies at statement one — and the assertion is that the crash output names the missing
    VARIABLE and never the token that was present.
    """
    env = {
        k: v for k, v in os.environ.items()
        if k not in ("OPENAI_API_KEY", "APIFY_TOKEN", "MAPBOX_SECRET_TOKEN",
                     "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
                     "TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS",
                     "ASTRAIL_INGEST_USER_ID")
    }
    env["TELEGRAM_BOT_TOKEN"] = f"123456:{CANARY}-BOT-TOKEN"
    result = subprocess.run(
        [sys.executable, "-m", "telegram_ingest.worker"],
        cwd=str(Path(__file__).parent.parent),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )

    assert result.returncode != 0
    assert "Missing required environment variables" in result.stderr
    assert "OPENAI_API_KEY" in result.stderr
    assert "CANARY" not in result.stdout + result.stderr, result.stderr
