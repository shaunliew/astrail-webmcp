"""The periodic lease reaper and the bounded organize re-dispatch (A2 / A-III).

Boot-time recovery is NOT enough, and that gap is a guardrail #12 silent drop rather than a
latency nit. A job that crashed with an UNEXPIRED lease is skipped at boot — correctly, since
at that instant it is indistinguishable from a job another live instance owns — and before
this nothing ever rechecked it. It stayed `running` forever: no result event, so the stream
never ends; no reclaim, so no retry. Reclaiming on a timer is what turns "missed at boot" into
"picked up one tick later".

Concurrent reapers across instances are safe by construction: every reclaim is a single
atomic UPDATE whose predicate re-evaluates against the current row, and every claim after it
is a CAS.
"""
from __future__ import annotations

import asyncio

import pytest

import main
from config_validation import REQUIRED_SECRETS
from test_organizer_lease import (
    _spin_until,
    _tick,
    advance_db_clock,
    in_minutes,
    minutes_ago,
)
from test_saved_reels_organize import _Client


def crashed_job_db(**job_fields) -> dict:
    """One trip job mid-flight, plus the `create_trip` event `_redispatch` replays from."""
    return {
        "jobs": [{
            "id": "job-1", "trip_id": "trip-1", "user_id": "user-1", "status": "running",
            "lease_token": "t1", "locked_at": minutes_ago(1),
            "lock_expires_at": in_minutes(4),      # UNEXPIRED at boot → skipped there
            **job_fields,
        }],
        "organize_jobs": [],
        "generation_events": [{
            "trip_id": "trip-1", "stage": "create_trip",
            "payload": {"reel_urls": ["https://ig/r1"], "start_date": "2026-08-01",
                        "end_date": "2026-08-02", "pace": "balanced"},
        }],
    }


def job_row(client) -> dict:
    return client.db["jobs"][0]


async def test_fresh_crash_is_reclaimed_by_the_DELAYED_sweep_not_only_at_boot(monkeypatch):
    """THE SILENT DROP, closed. Reclaimed by a LATER sweep, not the one that first saw it.

    Driven by the DATABASE's clock rather than real sleeps, and sequenced on observed sweeps
    rather than elapsed time, so it is deterministic instead of a race dressed up as a test.
    The reaper has no clock of its own to inject any more: expiry is decided by
    `clock_timestamp()` inside Postgres, which is the whole point — a reaper that supplied its
    own instant is how a skewed instance reclaimed leases another instance still held.

    The early sweeps see a lease that has not yet expired and must leave the job alone. Only
    once the database's clock passes the expiry may a sweep reclaim and re-dispatch it.
    """
    monkeypatch.setattr(main, "REAP_INTERVAL_S", 0)
    client = _Client(crashed_job_db())

    dispatched: list[str] = []

    async def fake_run_generation(*_args, **_kwargs):
        dispatched.append("run")
        return {"itinerary": {"days": []}}

    monkeypatch.setattr(main, "run_generation", fake_run_generation)

    def sweeps() -> int:
        return sum(1 for name, _ in client.rpc_calls if name == "reclaim_expired_trip_jobs")

    reaper = asyncio.create_task(main._reap_loop(client))
    await _spin_until(lambda: sweeps() >= 2)
    assert not dispatched               # the lease was still live: hands off, twice over

    advance_db_clock(client, minutes=10)                # the database's clock passes the TTL

    await _spin_until(lambda: bool(dispatched))
    reaper.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reaper

    assert job_row(client)["lease_token"] is None      # the stale token was cleared


async def test_the_reaper_survives_a_db_blip_and_keeps_reaping(monkeypatch, caplog):
    """One failing iteration must not kill the loop — that would reinstate the silent drop.

    A reaper that dies on its first transient PostgREST error is strictly worse than no
    reaper, because the boot sweep at least ran once and the logs would show nothing after.
    """
    monkeypatch.setattr(main, "REAP_INTERVAL_S", 0)
    client = _Client(crashed_job_db())
    calls: list[int] = []

    async def blips_once_then_works(**kwargs):
        calls.append(len(calls))
        if len(calls) == 1:
            raise RuntimeError("transient PostgREST failure")
        return []

    monkeypatch.setattr(main, "reclaim_expired_jobs", blips_once_then_works)

    reaper = asyncio.create_task(main._reap_loop(client))
    await _spin_until(lambda: len(calls) >= 3)     # it kept going after the raise
    reaper.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reaper

    assert "reap_loop_iteration_failed" in caplog.text


async def test_the_reaper_and_its_redispatches_are_retained_against_garbage_collection():
    """Pins the RETENTION WIRING, and is honest that it cannot pin GC itself.

    `asyncio.create_task` returns the only strong reference to a task; the event loop does not
    keep one, so a fire-and-forget task can be collected mid-flight and simply stop. That is
    the failure mode `_spawn` exists to prevent. What a test can prove deterministically is
    that the reference is actually held and released on completion — CPython's collector
    cannot be forced to demonstrate the loss on demand, so a test asserting "the reaper still
    fires without the reference" would pass either way and prove nothing. Asserting the
    wiring is the honest substitute; keep `_spawn` as the single spawn path.
    """
    finished = asyncio.Event()

    async def work():
        await finished.wait()

    task = main._spawn(work())

    assert task in main._RECOVERY_TASKS
    finished.set()
    await task
    await _tick(2)
    assert task not in main._RECOVERY_TASKS      # released, so the set cannot grow forever


async def test_organize_recovery_respects_recovery_semaphore(monkeypatch):
    """ISSUES-B4: organize re-dispatch was unbounded while trips were bounded.

    A boot backlog of reclaimed organize jobs would fan out all at once and stampede
    Apify/OpenAI/Mapbox and the DB — the failure the trip-side bound already prevents. Both
    paths now share one semaphore.
    """
    client = _Client({"organize_jobs": []})
    live, peak, release = 0, [], asyncio.Event()

    async def fake_run_organize_job(_job_id, _user_id, *, client=None):
        nonlocal live
        live += 1
        peak.append(live)
        await release.wait()
        live -= 1

    monkeypatch.setattr(main, "run_organize_job", fake_run_organize_job)
    jobs = [{"id": f"j{index}", "user_id": "u1"} for index in range(5)]

    tasks = [asyncio.create_task(main._redispatch_organize(client, job)) for job in jobs]
    await _spin_until(lambda: len(peak) >= 3)
    await _tick(50)                       # give any unbounded 4th/5th entry room to appear

    assert max(peak) <= 3                 # never more than the semaphore allows

    release.set()
    await asyncio.gather(*tasks)
    assert len(peak) == 5                 # and every job still ran exactly once


async def test_lifespan_starts_the_reaper_and_cancels_it_on_shutdown(monkeypatch):
    """The lifespan had no shutdown half at all. Without one the reaper outlives the app's
    shutdown, holding a client and logging into a process that is going away."""
    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")
    monkeypatch.setattr(main, "REAP_INTERVAL_S", 3600)     # park it in the sleep
    client = _Client({"jobs": [], "organize_jobs": []})

    async def _get_client():
        return client

    monkeypatch.setattr(main, "get_supabase_client", _get_client)

    started: list[asyncio.Task] = []
    real_spawn = main._spawn

    def watched_spawn(coro):
        task = real_spawn(coro)
        started.append(task)
        return task

    monkeypatch.setattr(main, "_spawn", watched_spawn)

    async with main.lifespan(main.app):
        assert started, "the reaper must be spawned at startup"
        reaper = started[0]
        assert not reaper.done()

    assert reaper.cancelled() or reaper.done()      # cancelled and awaited in the finally


async def test_the_reaper_still_starts_when_the_boot_sweep_blips(monkeypatch):
    """The reaper is spawned BEFORE the boot sweeps, deliberately.

    A boot-time DB blip degrades rather than crashing (the broad `except` is load-bearing),
    but if the reaper were spawned after the sweeps a single blip would leave the process with
    NO periodic reclaim for its entire lifetime — reinstating the silent drop for as long as
    the container lives, invisibly.
    """
    for name in REQUIRED_SECRETS:
        monkeypatch.setenv(name, "set")
    monkeypatch.setattr(main, "REAP_INTERVAL_S", 3600)
    client = _Client({"jobs": [], "organize_jobs": []})

    async def _get_client():
        return client

    async def _blipping_sweep(**_kwargs):
        raise RuntimeError("boot-time db blip")

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "reclaim_expired_jobs", _blipping_sweep)

    started: list[asyncio.Task] = []
    real_spawn = main._spawn
    monkeypatch.setattr(main, "_spawn", lambda coro: started.append(real_spawn(coro)) or started[-1])

    async with main.lifespan(main.app):
        assert started and not started[0].done()    # reaper alive despite the failed sweep

    assert started[0].cancelled() or started[0].done()
