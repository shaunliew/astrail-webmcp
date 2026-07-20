"""Organize-job lease reclaim (A2 / A-II I2).

The fake-fidelity tests come FIRST and are load-bearing. `recover_organize_jobs` pushes its
whole reclaim predicate into ONE PostgREST `update().eq().or_()`, so every reclaim test below
is really a test of the fake's filter evaluation. If the fake ignored `.lt`, `.is.null` or
`.or_()` — or evaluated them with Python's `None` semantics instead of Postgres's — all five
reclaim tests would pass while asserting nothing.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import sys
from datetime import datetime, timedelta, timezone

import pytest

from postgrest.exceptions import APIError

import organizer
from organizer import (
    ORGANIZE_LEASE_TTL_S,
    _update_job_counts,
    get_organize_status,
    LeaseLost,
    _heartbeat,
    _mark_organize_job_failed,
    _pg_timestamp,
    _record_organize_event,
    recover_organize_jobs,
    run_organize_job,
)
from test_saved_reels_organize import _Client, _eval_filter_term, _place


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def minutes_ago(minutes: int) -> str:
    return _iso(_now_utc() - timedelta(minutes=minutes))


def in_minutes(minutes: int) -> str:
    return _iso(_now_utc() + timedelta(minutes=minutes))


def seed_job(client, **fields) -> None:
    client.db.setdefault("organize_jobs", []).append({
        "id": "j1",
        "user_id": "u1",
        "status_message": "Finding places",
        "locked_at": minutes_ago(2),
        "lock_expires_at": None,
        "lease_token": None,
        "created_at": minutes_ago(30),
        **fields,
    })


def job_row(client, job_id: str = "j1") -> dict:
    return next(row for row in client.db["organize_jobs"] if row["id"] == job_id)


def job_status(client, job_id: str = "j1") -> str:
    return job_row(client, job_id)["status"]


@pytest.fixture
def fake_client() -> _Client:
    return _Client({"organize_jobs": []})


# --- fake fidelity ------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fake_lt_skips_null_columns_like_postgres(fake_client):
    """`NULL < value` is NULL in Postgres, so the row does NOT match.

    Guards two opposite mistakes. Raw `row.get(k) < v` raises TypeError on a NULL
    `lock_expires_at`; the tempting patch `row.get(k, "") < v` makes NULL rows ALWAYS match
    (`"" < "2026-..."` is True), which would silently invert the legacy-orphan test below into
    asserting the opposite of production behaviour while still looking green.
    """
    fake_client.db["organize_jobs"] = [
        {"id": "null-expiry", "lock_expires_at": None},
        {"id": "past-expiry", "lock_expires_at": minutes_ago(1)},
    ]

    matched = (await fake_client.table("organize_jobs").update({"status": "pending"})
               .lt("lock_expires_at", _iso(_now_utc())).execute()).data

    assert [row["id"] for row in matched] == ["past-expiry"]


@pytest.mark.asyncio
async def test_fake_or_is_a_real_disjunction_over_an_and_group(fake_client):
    """Each branch of the reclaim `or=` must select on its own, a row satisfying neither must
    be left alone, and the `is.null` conjunct must genuinely constrain the legacy branch.

    `live-but-long-running` is the row that makes this test non-decorative. It has a non-NULL
    future expiry (so branch 1 is False) and a `locked_at` older than the TTL. If `is.null`
    were evaluated as anything but a real NULL check, the and-group would collapse to
    `locked_at.lt.<cutoff>` alone and this row would be reclaimed — i.e. the reaper stealing a
    live lease from a job that has simply been running longer than one TTL while its heartbeat
    renews. Without this row, a broken `is.null` passes every other assertion here.
    """
    fake_client.db["organize_jobs"] = [
        {"id": "expired", "lock_expires_at": minutes_ago(1), "locked_at": minutes_ago(1)},
        {"id": "legacy-null", "lock_expires_at": None, "locked_at": minutes_ago(20)},
        {"id": "live", "lock_expires_at": in_minutes(4), "locked_at": minutes_ago(1)},
        {"id": "live-but-long-running", "lock_expires_at": in_minutes(4),
         "locked_at": minutes_ago(20)},
    ]
    cutoff = _iso(_now_utc() - timedelta(seconds=ORGANIZE_LEASE_TTL_S))

    matched = (await fake_client.table("organize_jobs").update({"status": "pending"}).or_(
        f"lock_expires_at.lt.{_iso(_now_utc())},"
        f"and(lock_expires_at.is.null,locked_at.lt.{cutoff})"
    ).execute()).data

    assert [row["id"] for row in matched] == ["expired", "legacy-null"]


@pytest.mark.asyncio
async def test_fake_evaluates_filters_at_execute_time_against_the_current_row(fake_client):
    """The predicate must be applied to the row as it stands when the statement runs, not
    snapshotted when the filter was registered. This is what makes the reclaim-vs-heartbeat
    race meaningful: a lease renewed after the query is built must stop matching."""
    fake_client.db["organize_jobs"] = [{"id": "j1", "lock_expires_at": minutes_ago(1)}]
    query = (fake_client.table("organize_jobs").update({"status": "pending"})
             .lt("lock_expires_at", _iso(_now_utc())))

    job_row(fake_client)["lock_expires_at"] = in_minutes(5)   # heartbeat renews underneath us

    assert (await query.execute()).data == []


@pytest.mark.asyncio
async def test_fake_rejects_postgrest_operators_it_does_not_implement(fake_client):
    """Fail loudly rather than vacuously. An unimplemented operator that silently evaluated to
    True (or was dropped) is exactly how a later increment gets a green test that proves
    nothing."""
    fake_client.db["organize_jobs"] = [{"id": "j1", "attempt_count": 3}]

    with pytest.raises(ValueError, match="gte"):
        await (fake_client.table("organize_jobs").update({"status": "pending"})
               .or_("attempt_count.gte.1").execute())


def append_event(client, **overrides):
    """Call the fake's `append_organize_event` the way `_record_organize_event` does."""
    return client.rpc("append_organize_event", {
        "p_job_id": "j1", "p_user_id": "u1", "p_lease_token": "t-live",
        "p_event_type": "stage", "p_message": "Finding places", "p_payload": {},
        **overrides,
    }).execute()


@pytest.mark.asyncio
async def test_fake_append_organize_event_rejects_a_superseded_token(fake_client):
    """THE FENCE'S FIDELITY PROOF. A fake that always inserted would make every fencing test
    in this file green against an implementation with no fence at all.

    Pins all three of the migration's error codes AND their precedence, because the wrapper
    reacts to exactly one of them: AS409 is swallowed (a superseded worker must never crash a
    terminal path), while AS400 and AS404 are real defects that must keep propagating. Get the
    codes wrong here and the wrapper would swallow — or re-raise — the wrong thing.
    """
    seed_job(fake_client, status="processing", lease_token="t-live")

    assert (await append_event(fake_client)).data == 1

    with pytest.raises(APIError) as superseded:
        await append_event(fake_client, p_lease_token="t-stale")
    assert superseded.value.code == "AS409"

    with pytest.raises(APIError) as tokenless:
        await append_event(fake_client, p_lease_token=None)
    assert tokenless.value.code == "AS400"

    # AS404 outranks the null-token check: the real function locks the row FIRST.
    with pytest.raises(APIError) as missing:
        await append_event(fake_client, p_job_id="gone", p_lease_token=None)
    assert missing.value.code == "AS404"

    assert len(fake_client.db["organize_events"]) == 1     # only the fenced-and-valid append


# --- reclaim semantics --------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unexpired_processing_job_is_not_reclaimed(fake_client):
    # lock_expires_at in the FUTURE → a live instance owns it mid-deploy; leave it alone
    seed_job(fake_client, status="processing", lease_token="t-old", lock_expires_at=in_minutes(4))
    assert await recover_organize_jobs(fake_client) == []
    assert job_status(fake_client) == "processing"


@pytest.mark.asyncio
async def test_expired_lease_is_reclaimed_to_pending(fake_client):
    seed_job(fake_client, status="processing", lease_token="t-old", lock_expires_at=minutes_ago(1))
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]
    assert job_status(fake_client) == "pending"
    row = job_row(fake_client)
    assert row["lease_token"] is None and row["lock_expires_at"] is None
    assert row["locked_at"] is None
    assert row["status_message"] == "Requeued after restart"


@pytest.mark.asyncio
async def test_legacy_null_token_processing_row_is_reclaimable(fake_client):
    # rows written before this migration have lease_token IS NULL — they must not be orphaned
    seed_job(fake_client, status="processing", lease_token=None, lock_expires_at=minutes_ago(1))
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]


@pytest.mark.asyncio
async def test_legacy_NULL_EXPIRY_processing_row_is_reclaimable(fake_client):
    """THE ROLLOUT-BOUNDARY ORPHAN. No production code has EVER written a non-null
    lock_expires_at (the organize claim and the trip claim in jobs.py both omit it; the only
    writes anywhere are None). So a job claimed by the OLD container during the A-II/A-III
    deploy overlap has lock_expires_at IS NULL, and `NULL < now()` is NULL — an expiry-only
    predicate skips it FOREVER. That is the silent drop guardrail #12 forbids, reintroduced by
    the very task meant to prevent it. Distinct from the test above: that one seeds a null
    TOKEN with a populated EXPIRY and would pass either way."""
    seed_job(fake_client, status="processing", lease_token=None,
             lock_expires_at=None, locked_at=minutes_ago(20))     # older than the TTL
    assert [j["id"] for j in await recover_organize_jobs(fake_client)] == ["j1"]


@pytest.mark.asyncio
async def test_legacy_null_expiry_row_INSIDE_ttl_is_not_reclaimed(fake_client):
    # the NULL branch must still respect the TTL — a live old-container job is not stolen
    seed_job(fake_client, status="processing", lease_token=None,
             lock_expires_at=None, locked_at=minutes_ago(1))
    assert await recover_organize_jobs(fake_client) == []
    assert job_status(fake_client) == "processing"


@pytest.mark.asyncio
async def test_long_running_job_with_a_renewed_lease_is_not_reclaimed(fake_client):
    """A run legitimately outliving one TTL must survive on its expiry alone.

    `locked_at` records the FIRST claim and is never bumped by a renewal, so any job running
    longer than ORGANIZE_LEASE_TTL_S has a stale `locked_at` while its heartbeat keeps
    `lock_expires_at` in the future. The legacy branch must therefore stay gated on
    `lock_expires_at IS NULL` — degrade it to a bare `locked_at` age check and the reaper
    requeues healthy long runs, double-executing them (guardrail #12's other half).
    """
    seed_job(fake_client, status="processing", lease_token="t-live",
             lock_expires_at=in_minutes(4), locked_at=minutes_ago(20))
    assert await recover_organize_jobs(fake_client) == []
    assert job_status(fake_client) == "processing"


@pytest.mark.asyncio
async def test_reclaim_honours_an_injected_now(fake_client):
    """`now` is the seam A-III's reaper drives the sweep from, so it must actually reach the
    predicate rather than being accepted and ignored."""
    seed_job(fake_client, status="processing", lease_token="t-old", lock_expires_at=in_minutes(4))

    assert await recover_organize_jobs(fake_client, now=_now_utc()) == []
    assert [j["id"] for j in
            await recover_organize_jobs(fake_client, now=_now_utc() + timedelta(minutes=10))] == ["j1"]


@pytest.mark.parametrize("malformed", [
    "and(lock_expires_at.is.null",           # unbalanced — the dangerous one
    "or(locked_at.lt.2026-07-19T00:00:00Z",  # unbalanced or-group
    "lock_expires_at.is.null)",              # stray close paren
])
def test_fake_rejects_a_malformed_filter_group_instead_of_evaluating_it_true(malformed):
    """A malformed group must RAISE, never silently satisfy the filter.

    Without the paren guard these fall through to `term.split(".", 2)`:
    `"and(lock_expires_at.is.null"` parses as key=`"and(lock_expires_at"`, op=`is`,
    value=`null` — and that key is absent from every row, so `is null` holds and the term
    evaluates TRUE. A typo'd predicate in any later increment would then match every row,
    and every test built on it would pass while asserting nothing. Fails toward green is
    the one direction test infrastructure must never fail in.
    """
    with pytest.raises(ValueError):
        _eval_filter_term({"lock_expires_at": None, "locked_at": "2026-07-19T00:00:00Z"}, malformed)


@pytest.mark.parametrize("bad", [
    datetime(2026, 7, 19, 12, 0, 0),                                          # naive
    datetime(2026, 7, 19, 12, 0, 0, tzinfo=timezone(timedelta(hours=8))),     # non-UTC offset
])
def test_pg_timestamp_rejects_a_non_utc_datetime(bad):
    """The Z-suffix guarantee only holds for UTC-aware input — enforce it.

    `.replace("+00:00", "Z")` is a no-op on a naive or +08:00 datetime, so the raw `+` this
    function exists to eliminate would survive into the `or=` filter. Offline tests cannot
    catch that (the fake accepts any string), and A-III's reaper injects its own `now`.
    """
    with pytest.raises(ValueError):
        _pg_timestamp(bad)


def test_pg_timestamp_emits_a_z_suffix_for_utc():
    stamped = _pg_timestamp(datetime(2026, 7, 19, 12, 0, 0, tzinfo=timezone.utc))
    assert stamped.endswith("Z") and "+" not in stamped


# --- claim ---------------------------------------------------------------------------------


FIRST_ATTEMPT_STARTED_AT = "2026-07-19T00:00:00+00:00"


def seed_claimable_job(client) -> None:
    """A pending job with one queued item, ready for `run_organize_job` to claim.

    `started_at` is pre-populated: this job has already had a first attempt, which is the
    only state in which the preserve-vs-overwrite distinction is observable.
    """
    seed_job(client, status="pending", started_at=FIRST_ATTEMPT_STARTED_AT)
    client.db["organize_job_items"] = [{
        "id": "i1", "job_id": "j1", "user_id": "u1", "saved_reel_id": "r1", "status": "queued",
    }]
    client.db["saved_reels"] = [{
        "id": "r1", "user_id": "u1", "normalized_url": "https://www.instagram.com/reel/A",
        "reel_cache_id": "cache-1", "analysis_status": "queued",
    }]


def crash_after_snapshotting_the_row(client, snapshots):
    """A `ground` that records the claimed row, then dies the way a SIGTERM'd worker does.

    Two things make this shape load-bearing rather than fussy. The claim's `lock_expires_at`
    is nulled again by the job's own finalization, so a post-run assertion would silently
    check the teardown instead of the claim — the row has to be read mid-run. And
    `CancelledError` is a `BaseException`, so it slips both `except Exception` handlers and
    leaves the job `processing` with an unrenewed lease and its item mid-flight: exactly the
    state the reaper exists to find, produced rather than hand-forged.
    """
    async def ground(_place_result):
        snapshots.append(dict(job_row(client)))
        raise asyncio.CancelledError()

    return ground


@pytest.mark.asyncio
async def test_claim_mints_a_fresh_token_and_preserves_started_at(fake_client, monkeypatch):
    """Every claim attempt mints its OWN token; only the first one stamps `started_at`.

    Both halves are what the rest of A2 rests on. A token minted once and reused across
    attempts would let a superseded worker satisfy the `.eq("lease_token", ...)` CAS its
    replacement installed — fencing that admits the exact writer it exists to exclude, while
    every single-attempt test stays green. And `started_at` is the run's user-visible elapsed
    time: re-stamping it on each retry makes a job that has been grinding for an hour report
    as though it had just begun, hiding the retry loop it is actually stuck in.
    """
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_claimable_job(fake_client)
    snapshots: list[dict] = []

    with pytest.raises(asyncio.CancelledError):
        await run_organize_job("j1", "u1", client=fake_client,
                               ground=crash_after_snapshotting_the_row(fake_client, snapshots))

    # Ten minutes on the lease is past its TTL, so the reaper takes the abandoned job back.
    assert [j["id"] for j in await recover_organize_jobs(
        fake_client, now=_now_utc() + timedelta(minutes=10))] == ["j1"]

    with pytest.raises(asyncio.CancelledError):
        await run_organize_job("j1", "u1", client=fake_client,
                               ground=crash_after_snapshotting_the_row(fake_client, snapshots))

    first, second = snapshots
    assert first["lease_token"] and second["lease_token"]
    assert first["lease_token"] != second["lease_token"]
    assert datetime.fromisoformat(first["lock_expires_at"]) > _now_utc()
    assert datetime.fromisoformat(second["lock_expires_at"]) > _now_utc()
    assert first["started_at"] == second["started_at"] == FIRST_ATTEMPT_STARTED_AT
    assert (first["attempt_count"], second["attempt_count"]) == (1, 2)


@pytest.mark.asyncio
async def test_claiming_a_vanished_job_skips_instead_of_crashing():
    """A job deleted between recovery listing it and the claim must skip, not raise.

    `maybe_single()` returns a result whose `.data` is None when no row matches. Without the
    `or {}` at the pre-claim read, the following `.get("attempt_count")` raises AttributeError
    — which the outer handler would then try to convert into `_mark_organize_job_failed`
    against a row that no longer exists. Skipping is the correct outcome: the CAS finds
    nothing to claim.
    """
    client = _Client({"organize_jobs": []})     # the job is gone

    result = await run_organize_job(
        "vanished-job", "u1", client=client, scrape=None, extract=None, ground=None,
    )

    assert result == {"skipped": "job not found"}


@pytest.mark.asyncio
async def test_claiming_a_job_another_worker_holds_reports_already_claimed():
    """The sibling of the vanished-job case: the row EXISTS but is no longer `pending`.

    Distinguishing these two is the point — A-III logs this path, and reporting "already
    claimed" for a job that was deleted would send a reader hunting a competing worker that
    never existed.
    """
    client = _Client({"organize_jobs": [{
        "id": "j1", "user_id": "u1", "status": "processing",      # someone else won the CAS
        "attempt_count": 1, "started_at": "2026-07-19T00:00:00+00:00",
    }]})

    result = await run_organize_job("j1", "u1", client=client, scrape=None, extract=None, ground=None)

    assert result == {"skipped": "job already claimed"}


# --- heartbeat -----------------------------------------------------------------------------


async def _spin_until(predicate, *, ticks: int = 5000) -> None:
    """Yield to the event loop until `predicate` holds.

    Every heartbeat test drives the beat with a monkeypatched `ORGANIZE_LEASE_RENEW_S` of 0,
    so progress is measured in event-loop ticks rather than wall-clock time. A real 60s sleep
    (or even a 0.1s one, multiplied across these tests) is not worth it in a suite that runs
    in under two seconds.
    """
    for _ in range(ticks):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError(f"condition never held within {ticks} event-loop ticks")


async def _tick(count: int) -> None:
    """Hand the event loop `count` turns so background tasks can make progress."""
    for _ in range(count):
        await asyncio.sleep(0)


def _expiry(row: dict) -> datetime:
    return datetime.fromisoformat(row["lock_expires_at"])


async def _grounded(place):
    return {"place": place, "country_code": "JP", "country_name": "Japan"}


def seed_two_item_job(client) -> None:
    """A claimable job with TWO queued items.

    Two is the minimum that can distinguish "the run stopped" from "the run stopped in the
    right place": the lease check sits between items, so only a second item can show that the
    abort happened before it rather than after everything had already been written.
    """
    seed_job(client, status="pending", started_at=FIRST_ATTEMPT_STARTED_AT)
    client.db["organize_job_items"] = [
        {"id": "i1", "job_id": "j1", "user_id": "u1", "saved_reel_id": "r1", "status": "queued"},
        {"id": "i2", "job_id": "j1", "user_id": "u1", "saved_reel_id": "r2", "status": "queued"},
    ]
    client.db["saved_reels"] = [
        {"id": "r1", "user_id": "u1", "normalized_url": "https://www.instagram.com/reel/A",
         "reel_cache_id": "cache-1", "analysis_status": "queued"},
        {"id": "r2", "user_id": "u1", "normalized_url": "https://www.instagram.com/reel/B",
         "reel_cache_id": "cache-2", "analysis_status": "queued"},
    ]


def item_row(client, item_id: str) -> dict:
    return next(row for row in client.db["organize_job_items"] if row["id"] == item_id)


def reel_row(client, reel_id: str) -> dict:
    return next(row for row in client.db["saved_reels"] if row["id"] == reel_id)


@pytest.mark.asyncio
async def test_heartbeat_renews_the_lease_and_detects_loss(fake_client, monkeypatch):
    """The beat pushes `lock_expires_at` forward, and stops the moment the CAS finds no row.

    Renewal is what makes a 300s TTL safe for a run that legitimately takes longer: without
    it, `recover_organize_jobs` reclaims a healthy job and two workers run it. Detection is
    the other half — once a replacement owns the token, our CAS matches zero rows, and the
    beat must say so rather than looping forever against a job it no longer holds.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    seed_job(fake_client, status="processing", lease_token="t1", lock_expires_at=minutes_ago(1))
    lost = asyncio.Event()
    beat = asyncio.create_task(_heartbeat(fake_client, "j1", "u1", "t1", lost))

    await _spin_until(lambda: _expiry(job_row(fake_client)) > _now_utc())
    assert not lost.is_set()

    job_row(fake_client)["lease_token"] = "t-replacement"    # reaped, then claimed by another worker

    await _spin_until(lost.is_set)
    await asyncio.wait_for(beat, timeout=5)
    assert not beat.cancelled()      # it RETURNED on loss; it did not have to be killed


@pytest.mark.asyncio
async def test_lease_expiry_during_a_blocked_provider_call_aborts_the_run(fake_client, monkeypatch):
    """THE LIVENESS PROOF. Only a *running* beat can notice a token replaced underneath it.

    A heartbeat is the easiest guard in this task to ship broken and green: a coroutine that
    is created but never scheduled, or whose task is created and dropped, renews nothing —
    and every direct `_renew_organize_lease(...)` call still passes, because that proves the
    function works, not that anything calls it. So this test never calls the renewal itself.
    It parks the run inside `ground` (where a real Mapbox call would sit), swaps the row's
    token the way the reaper plus a replacement worker would, and requires the abort to come
    from the beat that the run started on its own.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_two_item_job(fake_client)

    renewals: list[bool] = []
    real_renew = organizer._renew_organize_lease

    async def watched_renew(*args):
        outcome = await real_renew(*args)
        renewals.append(outcome)
        return outcome

    monkeypatch.setattr(organizer, "_renew_organize_lease", watched_renew)

    # `LeaseLost` is raised inside the loop and handled by the job-level `except`, so the
    # only honest place to observe WHICH exception aborted the run is at that boundary.
    raised: list[BaseException | None] = []
    real_mark_failed = organizer._mark_organize_job_failed

    async def watched_mark_failed(*args, **kwargs):
        raised.append(sys.exc_info()[1])
        return await real_mark_failed(*args, **kwargs)

    monkeypatch.setattr(organizer, "_mark_organize_job_failed", watched_mark_failed)

    entered, release = asyncio.Event(), asyncio.Event()

    async def blocking_ground(place):
        entered.set()
        await release.wait()
        return await _grounded(place)

    run = asyncio.create_task(
        run_organize_job("j1", "u1", client=fake_client, ground=blocking_ground)
    )
    await _spin_until(entered.is_set)

    job_row(fake_client)["lease_token"] = "t-replacement"
    await _spin_until(lambda: False in renewals)     # the RUNNING beat saw the zero-row CAS

    release.set()
    await asyncio.wait_for(run, timeout=5)

    assert isinstance(raised[0], LeaseLost)
    item2 = item_row(fake_client, "i2")
    assert item2["status"] == "queued" and "completed_at" not in item2
    assert reel_row(fake_client, "r2")["analysis_status"] == "queued"


@pytest.mark.asyncio
async def test_a_renewal_blip_does_not_abort_a_healthy_run(fake_client, monkeypatch):
    """A transport error is NOT lease loss. Getting this backwards cancels healthy runs.

    Losing a lease is an authoritative statement — a CAS that matched zero rows because
    somebody else owns the token. A `ConnectionError` says nothing about ownership, so
    treating it as loss means one flaky moment against PostgREST destroys a run that still
    holds its job perfectly well. The safe direction is to keep working: if the blips truly
    persist past the TTL, the reaper reclaims us and the next *successful* renewal returns
    zero rows, which is the authoritative signal.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_two_item_job(fake_client)

    attempts: list[int] = []

    async def always_blips(*_args):
        attempts.append(len(attempts))
        raise ConnectionError("transient PostgREST failure")

    monkeypatch.setattr(organizer, "_renew_organize_lease", always_blips)

    entered, release = asyncio.Event(), asyncio.Event()

    async def ground_blocking_once(place):
        if not entered.is_set():
            entered.set()
            await release.wait()
        return await _grounded(place)

    run = asyncio.create_task(
        run_organize_job("j1", "u1", client=fake_client, ground=ground_blocking_once)
    )
    await _spin_until(entered.is_set)
    await _spin_until(lambda: len(attempts) >= 1)    # the beat is running
    await _tick(200)                                 # blips pile up while we sit in the provider call
    release.set()

    status = await asyncio.wait_for(run, timeout=5)

    # The harm this pins is the run itself, not the beat's bookkeeping: read the blip as loss
    # and this job dies at item 2 having done nothing wrong.
    assert status["status"] == "succeeded"
    assert status["organized_items"] == 2
    assert len(attempts) > 1                         # and the beat kept trying, rather than giving up


@pytest.mark.asyncio
async def test_a_heartbeat_that_cannot_reach_postgres_past_the_ttl_declares_the_lease_lost(
    fake_client, monkeypatch
):
    """FAIL SAFE, not fail open — the other half of the blip rule above.

    Tolerating blips was right; tolerating them FOREVER was not. The swallow rested on "the
    next renewal that DOES reach Postgres returns zero rows → lost, the honest way", which
    silently assumes a next renewal gets through. When Postgres stays unreachable there is no
    such renewal: `recover_organize_jobs` reclaims on schedule, a replacement claims the job,
    and this worker runs on with `lost` never set — sailing past the loop's between-items gate
    with only the per-write token fences between it and the replacement's work.

    Past the TTL our lease has certainly expired, so "we still own this" is no longer a claim
    the worker is entitled to make. The pairing with the test above is the whole point: under
    the TTL a blip must NOT abort a healthy run, past it the run must stop. A guard that fires
    on the first error would fail that test; one that never fires fails this one.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_TTL_S", 0)   # every attempt lands past the deadline
    seed_job(fake_client, status="processing", lease_token="t1", lock_expires_at=minutes_ago(1))

    async def unreachable(*_args):
        raise ConnectionError("PostgREST is unreachable")

    monkeypatch.setattr(organizer, "_renew_organize_lease", unreachable)
    lost = asyncio.Event()
    beat = asyncio.create_task(_heartbeat(fake_client, "j1", "u1", "t1", lost))

    await asyncio.wait_for(beat, timeout=5)

    assert lost.is_set()              # the run is told to stop
    assert not beat.cancelled()       # it RETURNED on its own; nothing had to kill it


@pytest.mark.asyncio
async def test_the_heartbeat_task_does_not_outlive_the_run(fake_client, monkeypatch):
    """A leaked beat keeps renewing a lease for a run that has already finished.

    The consequence is not cosmetic: the job's own finalization nulls `lock_expires_at`, and
    a surviving beat would go on CASing against a completed job — and on a real event loop,
    an un-awaited task that outlives its parent surfaces as a "Task was destroyed but it is
    pending" warning at shutdown rather than anything a test would catch.
    """
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_claimable_job(fake_client)

    outcomes: list[str] = []
    real_heartbeat = organizer._heartbeat

    async def watched_heartbeat(*args):
        try:
            await real_heartbeat(*args)
        except asyncio.CancelledError:
            outcomes.append("cancelled")
            raise
        outcomes.append("returned")

    monkeypatch.setattr(organizer, "_heartbeat", watched_heartbeat)

    async def yielding_ground(place):
        # A real provider call yields; the fake client never does. Without one yield here the
        # beat would be cancelled before it ever ran, and this test would pass vacuously
        # against an implementation that leaks a *scheduled* task.
        await asyncio.sleep(0)
        return await _grounded(place)

    status = await run_organize_job("j1", "u1", client=fake_client, ground=yielding_ground)

    assert status["status"] == "succeeded"
    assert outcomes == ["cancelled"]     # the run's `finally` reaped it, and awaited it


@pytest.mark.asyncio
async def test_renewal_cas_is_scoped_to_our_own_live_lease(fake_client, monkeypatch):
    """The CAS must be predicated on BOTH `status='processing'` and OUR token.

    Dropping the status guard lets a run keep renewing a job that has already been reclaimed
    to `pending` and re-dispatched; dropping the token guard makes the fence meaningless,
    since any worker's renewal would match any other worker's row.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    expired = minutes_ago(1)
    seed_job(fake_client, status="processing", lease_token="t1", lock_expires_at=expired)

    assert await organizer._renew_organize_lease(fake_client, "j1", "u1", "t-other") is False
    assert job_row(fake_client)["lock_expires_at"] == expired           # untouched

    job_row(fake_client)["status"] = "pending"
    assert await organizer._renew_organize_lease(fake_client, "j1", "u1", "t1") is False

    job_row(fake_client)["status"] = "processing"
    assert await organizer._renew_organize_lease(fake_client, "j1", "u1", "t1") is True
    assert _expiry(job_row(fake_client)) > _now_utc()


@pytest.mark.asyncio
async def test_heartbeat_stops_when_the_run_signals_it_is_done(fake_client, monkeypatch):
    """`lost` is also the run's shutdown flag — the loop must honour it, not only cancellation."""
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    expired = minutes_ago(1)
    seed_job(fake_client, status="processing", lease_token="t1", lock_expires_at=expired)
    lost = asyncio.Event()
    lost.set()

    beat = asyncio.create_task(_heartbeat(fake_client, "j1", "u1", "t1", lost))
    with contextlib.suppress(asyncio.CancelledError):
        await asyncio.wait_for(beat, timeout=5)

    assert job_row(fake_client)["lock_expires_at"] == expired           # never renewed


# --- fenced terminal writes -----------------------------------------------------------------


def parked_ground(entered: asyncio.Event, release: asyncio.Event):
    """A `ground` that parks the run inside the provider call until released.

    A real Mapbox/Apify call is where a superseded worker actually sits, and it is the only
    state in which a worker can be both replaced and still alive to write. Every test below
    needs a worker in exactly that state, produced rather than hand-forged.
    """
    async def ground(place):
        entered.set()
        await release.wait()
        return await _grounded(place)

    return ground


@pytest.mark.asyncio
async def test_a_superseded_worker_cannot_force_fail_the_worker_that_replaced_it(
    fake_client, monkeypatch
):
    """THE CASCADE — reproduced against the real organizer before this fence existed.

    Two workers, both alive: A superseded, B legitimately leased. A's `LeaseLost` reaches the
    outer `except` and calls `_mark_organize_job_failed`; unfenced, that write lands
    `status='failed'` on B's row. B's OWN renewal CAS is predicated on `status='processing'`,
    so B's next heartbeat matches zero rows, B reads it as lease loss, and B abandons a run it
    was entitled to finish. Observed before the fix: B organized item 1, then `status='failed'`,
    `organized_items=1`, item 2 left `queued`.

    Worse than a wrong status value, and worth its own regression test for that reason: the
    renewal CAS's `status` predicate turns ANY unfenced write to `status` into an implicit
    "you lost your lease" aimed at whoever legitimately holds it. One worker reaching into
    another's control flow is something no pre-heartbeat worker could do at all, and the
    heartbeat is what makes it fire reliably — a worker stuck in a provider call now has a
    guaranteed exit one renewal interval after being superseded.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_two_item_job(fake_client)

    renewals: list[bool] = []
    real_renew = organizer._renew_organize_lease

    async def watched_renew(*args):
        outcome = await real_renew(*args)
        renewals.append(outcome)
        return outcome

    monkeypatch.setattr(organizer, "_renew_organize_lease", watched_renew)

    a_entered, a_release = asyncio.Event(), asyncio.Event()
    b_entered, b_release = asyncio.Event(), asyncio.Event()

    worker_a = asyncio.create_task(run_organize_job(
        "j1", "u1", client=fake_client, ground=parked_ground(a_entered, a_release)))
    await _spin_until(a_entered.is_set)

    # The reaper finds A's lease expired and worker B claims — the deploy-overlap sequence in
    # full, driven through the real reclaim rather than by editing the row.
    assert [j["id"] for j in await recover_organize_jobs(
        fake_client, now=_now_utc() + timedelta(minutes=10))] == ["j1"]
    worker_b = asyncio.create_task(run_organize_job(
        "j1", "u1", client=fake_client, ground=parked_ground(b_entered, b_release)))
    await _spin_until(b_entered.is_set)
    b_token = job_row(fake_client)["lease_token"]
    assert b_token and job_status(fake_client) == "processing"

    await _spin_until(lambda: False in renewals)     # A's beat has learned it was superseded
    a_release.set()
    await asyncio.wait_for(worker_a, timeout=5)

    # A has now run its ENTIRE terminal cleanup while B is still parked mid-provider-call.
    row = job_row(fake_client)
    assert (row["status"], row["lease_token"]) == ("processing", b_token)

    b_release.set()
    status = await asyncio.wait_for(worker_b, timeout=5)

    # B finishes on its own terms: the whole job, not the one item it had done when A aborted.
    assert status["status"] == "succeeded"
    assert status["organized_items"] == 2
    assert item_row(fake_client, "i2")["status"] == "organized"


@pytest.mark.asyncio
async def test_fenced_writer_cannot_finalize_the_job(fake_client, monkeypatch):
    """NEITHER terminal `organize_jobs` write may land from a worker that lost the lease —
    not the failure cleanup, and not the SUCCESS finalization.

    The success half is not symmetry for its own sake. The loop's `lease_lost` gate sits
    BEFORE each item, so a superseded worker parked in its LAST item never reaches a gate at
    all — the loop simply ends and it falls straight through to the final-status update.
    Fence only the failure path and that worker stamps its own `succeeded`/`Organized` over
    the replacement's terminal state, which is why the replacement here deliberately fails:
    `succeeded` is then a value only the stale writer could possibly have written.
    """
    seed_job(fake_client, status="processing", lease_token="new-owner")

    await _mark_organize_job_failed(fake_client, "j1", "u1", lease_token="stale-owner")

    assert job_status(fake_client) == "processing"       # untouched by the fenced writer

    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    client = _Client({"organize_jobs": []})
    seed_claimable_job(client)                           # ONE item, so the loop never gates
    entered, release = asyncio.Event(), asyncio.Event()

    old = asyncio.create_task(run_organize_job(
        "j1", "u1", client=client, ground=parked_ground(entered, release)))
    await _spin_until(entered.is_set)

    async def failing_ground(_place_result):
        raise RuntimeError("Mapbox is down for the replacement")

    await recover_organize_jobs(client, now=_now_utc() + timedelta(minutes=10))
    replacement = await run_organize_job("j1", "u1", client=client, ground=failing_ground)
    assert replacement["status"] == "failed"
    new_token = job_row(client)["lease_token"]

    release.set()
    await asyncio.wait_for(old, timeout=5)

    row = job_row(client)
    assert (row["status"], row["status_message"]) == ("failed", "Organization failed")
    assert row["lease_token"] == new_token
    # The old worker DID run to the end — only the fence stopped it, so this is not vacuous.
    assert item_row(client, "i1")["status"] == "organized"


@pytest.mark.asyncio
async def test_old_worker_resuming_after_replacement_cannot_finalize_the_job(
    fake_client, monkeypatch, caplog
):
    """The full old-vs-new sequence, asserting EXACTLY the hard-fenced set.

    Deliberately does NOT assert that no item row moved. Item terminal statuses,
    `saved_reels.analysis_status` and mention replacement are bounded, not fenced — the
    `lease_lost` gate sits between items, so a worker parked in one provider call still lands
    THAT item. Asserting otherwise would pin a guarantee this task does not ship.

    The AS409 log line is the observable for the fence itself: `_record_organize_event`
    swallows a superseded append so a terminal path never crashes, which means the log is the
    only place that rejection surfaces. Without it, "the event simply never appeared" would be
    equally consistent with the append silently doing nothing at all.
    """
    monkeypatch.setattr("organizer.ORGANIZE_LEASE_RENEW_S", 0)
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    caplog.set_level(logging.WARNING, logger="organizer")
    seed_two_item_job(fake_client)
    entered, release = asyncio.Event(), asyncio.Event()

    old = asyncio.create_task(run_organize_job(
        "j1", "u1", client=fake_client, ground=parked_ground(entered, release)))
    await _spin_until(entered.is_set)

    assert [j["id"] for j in await recover_organize_jobs(
        fake_client, now=_now_utc() + timedelta(minutes=10))] == ["j1"]
    replacement = await run_organize_job("j1", "u1", client=fake_client, ground=_grounded)
    assert replacement["status"] == "succeeded"
    new_token = job_row(fake_client)["lease_token"]

    release.set()
    await asyncio.wait_for(old, timeout=5)

    row = job_row(fake_client)
    assert (row["status"], row["status_message"]) == ("succeeded", "Organized")
    assert row["lease_token"] == new_token
    events = fake_client.db["organize_events"]
    assert [event["sequence"] for event in events] == list(range(1, len(events) + 1))
    assert [event["message"] for event in events].count(organizer.ORGANIZE_FAILURE_MESSAGE) == 0
    assert "organize_event_lease_superseded" in caplog.text


@pytest.mark.asyncio
async def test_a_transient_read_after_success_cannot_flip_the_job_to_failed(
    fake_client, monkeypatch
):
    """SSE SAYS SUCCESS, POLLING LATER SAYS FAILURE — worse than either answer alone.

    The success update and the terminal `result` event both commit, and then the final status
    read at the end of the try block fails transiently. That exception reaches the outer
    handler, which calls `_mark_organize_job_failed`. Its fence checks only `lease_token`, and
    the token is UNCHANGED — this worker legitimately still holds the lease, which is exactly
    why the guard passes. So it overwrites its own `succeeded` with `failed` and appends a
    second, contradictory `result`. The user has already been told it worked.

    Fencing on the lease cannot catch this, because nothing about the lease is wrong. The
    predicate has to also require the job is not already FINISHED. Both halves are asserted:
    the terminal row, and the single result event — a fix that guarded only the row would still
    leave two result rows, and `stream_organize_events` replays them.
    """
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_claimable_job(fake_client)

    real_status = organizer.get_organize_status
    calls: list[int] = []

    async def flaky_status(*args, **kwargs):
        # Call 1 computes `final_status`, call 2 is the post-success read that returns to the
        # caller, call 3 is the outer handler's. Only call 2 lands AFTER both terminal writes
        # have committed, which is the whole reason this bug is reachable.
        calls.append(len(calls))
        if len(calls) == 2:
            raise ConnectionError("transient PostgREST failure")
        return await real_status(*args, **kwargs)

    monkeypatch.setattr(organizer, "get_organize_status", flaky_status)

    polled = await run_organize_job("j1", "u1", client=fake_client, ground=_grounded)

    assert len(calls) >= 3, "the transient read must actually have been reached and handled"
    row = job_row(fake_client)
    assert (row["status"], row["status_message"]) == ("succeeded", "Organized"), \
        "a committed success must survive a failure on the read that follows it"
    results = [event for event in fake_client.db["organize_events"]
               if event["event_type"] == "result"]
    assert [event["payload"]["status"] for event in results] == ["succeeded"], \
        "no second, contradictory terminal event"
    assert polled["status"] == "succeeded", "polling must not contradict what SSE reported"


@pytest.mark.asyncio
async def test_a_live_workers_genuine_failure_is_still_recorded(fake_client, monkeypatch):
    """The terminal guard must not swallow the failures it exists alongside.

    `_mark_organize_job_failed` is the ONLY thing that reports a mid-run crash, so a predicate
    that refused to write on a `processing` job would silently strand every genuine failure as
    `processing` forever — a guard that "passes" by never doing its job.
    """
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_claimable_job(fake_client)

    async def failing_ground(_place_result):
        raise RuntimeError("Mapbox is down")

    status = await run_organize_job("j1", "u1", client=fake_client, ground=failing_ground)

    row = job_row(fake_client)
    assert (row["status"], row["status_message"]) == ("failed", organizer.ORGANIZE_FAILURE_MESSAGE)
    assert status["status"] == "failed"
    results = [event for event in fake_client.db["organize_events"]
               if event["event_type"] == "result"]
    assert [event["payload"]["status"] for event in results] == ["failed"]


@pytest.mark.asyncio
async def test_a_superseded_workers_stale_counts_write_cannot_land():
    """The counts aggregate is decision-bearing, so it must be fenced like the terminal writes.

    `get_organize_status` reads the aggregate COLUMNS rather than re-deriving from
    `organize_job_items`, and `run_organize_job` computes `final_status` from that read. An
    unfenced counts write from a superseded worker, landing after the live worker's, therefore
    makes the LIVE worker persist `failed` on a job whose items all succeeded — the same
    false-terminal outcome the rest of I5 prevents, via a different write path.

    The seeded divergence (stored counts say 2 organized, items say 1 organized + 1 failed)
    stands in for temporal skew: the live worker has already written its final counts, and the
    superseded worker is about to write the ones IT computed from an earlier read. Reproducing
    the skew literally is not possible through this helper, which couples its SELECT and UPDATE
    — so the test pins the property that matters instead: a write bearing a stale token must
    not land, whatever it computed.
    """
    def _client():
        return _Client({
            "organize_jobs": [{
                "id": "j1", "user_id": "u1", "status": "processing",
                "lease_token": "live-token",
                "processed_count": 2, "organized_count": 2,
                "location_not_found_count": 0, "failed_count": 0,
            }],
            "organize_job_items": [
                {"id": "i1", "job_id": "j1", "user_id": "u1", "status": "organized"},
                {"id": "i2", "job_id": "j1", "user_id": "u1", "status": "failed"},
            ],
        })

    stale = _client()
    await _update_job_counts(stale, "j1", "u1", lease_token="superseded-token")
    job = stale.db["organize_jobs"][0]
    assert (job["organized_count"], job["failed_count"]) == (2, 0), \
        "a stale worker's counts must not overwrite the live worker's"

    status = await get_organize_status(stale, "j1", "u1")
    decided = "failed" if status["failed_items"] and not status["organized_items"] else "succeeded"
    assert decided == "succeeded", "a job the live worker organized must not report failed"

    # ...and the fence must not block the LIVE worker, or counts would freeze entirely
    live = _client()
    await _update_job_counts(live, "j1", "u1", lease_token="live-token")
    job = live.db["organize_jobs"][0]
    assert (job["organized_count"], job["failed_count"]) == (1, 1), \
        "the lease holder's own recompute must land"


# --- ISSUES-B5: the event-sequencing invariant ----------------------------------------------
#
# CHARACTERIZATION, NOT RED->GREEN. All three pass against the code exactly as A2 shipped it;
# none of them had a red phase and this section does not claim one. They exist because
# `_record_organize_event` now carries a comment asserting a safety property, and an asserted
# property nothing tests is the failure mode B5 was originally filed about — ISSUES.md claimed
# a single-writer invariant that did not hold.
#
# WHAT THIS FILE CAN AND CANNOT PROVE. These pin the CONTROL FLOW around the RPC: who reaches
# it, with which token, and how many rows come out. They cannot prove SERIALIZATION, because
# the fake has no true concurrency — every `execute()` runs straight through without awaiting,
# so gathered callers interleave between calls and never inside one. That is faithful to a
# database statement being atomic, and it is exactly why deleting `for update` from the real
# function leaves everything here green. Serialization is pinned where it is observable, in
# `supabase/tests/010_organize_event_sequencing.sql`, against a real Postgres.


@pytest.mark.asyncio
async def test_only_the_worker_that_won_the_claim_emits_events(fake_client, monkeypatch):
    """B5's own regression test: race two claims, and only the winner may write events.

    This is the property the original issue asked for and never got. The existing claim test
    asserts the loser's RETURN VALUE (`{"skipped": "job already claimed"}`) — but a skip string
    says nothing about whether the loser went on to write, and writing is the part that
    corrupts the sequence. The two are asserted together here.

    The loser is proven silent by counting, not by inspecting its return: every
    `append_organize_event` call made during the whole race must have produced exactly one row.
    A loser that emitted would show up as either an extra row (unfenced) or a call with no row
    (an AS409 the wrapper swallowed) — the count catches both, and neither is visible from the
    skip string alone.
    """
    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: [_place()])
    seed_two_item_job(fake_client)

    first, second = await asyncio.gather(
        run_organize_job("j1", "u1", client=fake_client, ground=_grounded),
        run_organize_job("j1", "u1", client=fake_client, ground=_grounded),
    )

    skipped = [r for r in (first, second) if r == {"skipped": "job already claimed"}]
    winners = [r for r in (first, second) if r.get("status") == "succeeded"]
    assert len(skipped) == 1, "exactly one worker must lose the CAS"
    assert len(winners) == 1, "exactly one worker must run the job"
    assert winners[0]["organized_items"] == 2, "the winner ran the whole job, not part of it"

    events = fake_client.db["organize_events"]
    sequences = [event["sequence"] for event in events]
    assert sequences == sorted(sequences), "events are appended in sequence order"
    assert len(set(sequences)) == len(sequences), "no two events share a sequence"
    assert sequences == list(range(1, len(events) + 1)), "sequences are gapless from one"

    appends = [call for call in fake_client.rpc_calls if call[0] == "append_organize_event"]
    assert len(appends) == len(events), \
        "every append in the race produced exactly one row — the loser never even tried"


@pytest.mark.asyncio
async def test_concurrent_appends_under_one_lease_allocate_unique_gapless_sequences(fake_client):
    """N appends holding the SAME valid lease each get their own sequence, with no collision.

    Scoped honestly: this pins the ALLOCATION CONTRACT — N calls in, N rows out, sequences
    1..N, every return value matching the row it wrote — which is what `_record_organize_event`
    and `stream_organize_events` are entitled to assume. It does NOT pin the row lock that
    makes the contract hold under real contention (see this section's header). Both halves
    matter: a second event producer added later would rely on this contract, and on the lock
    proven in `supabase/tests/010_organize_event_sequencing.sql`.
    """
    seed_job(fake_client, status="processing", lease_token="t-live")

    sequences = [result.data for result in await asyncio.gather(*(
        append_event(fake_client, p_message=f"Organizing reel {n}") for n in range(8)
    ))]

    assert sorted(sequences) == list(range(1, 9)), "each caller got its own sequence"
    events = fake_client.db["organize_events"]
    assert len(events) == 8, "eight appends wrote exactly eight events"
    assert sorted(event["sequence"] for event in events) == list(range(1, 9))
    assert [event["sequence"] for event in events] == sequences, \
        "each call's return value names the row it actually wrote"


@pytest.mark.asyncio
async def test_a_superseded_worker_writes_no_event_and_does_not_crash(fake_client, caplog):
    """The fence, at its smallest scope: a stale token writes nothing and raises nothing.

    Both halves are load-bearing in opposite directions and neither is redundant with the
    integration tests above. If the write landed, a superseded worker's terminal `result` row
    would end the user's SSE session on an outcome that never happened. If the AS409 escaped
    instead, it would crash a terminal cleanup path on a job the replacement is already
    finishing correctly. The swallow is silent by design, so the log line is the only evidence
    the rejection happened at all rather than the append quietly doing nothing.
    """
    caplog.set_level(logging.WARNING, logger="organizer")
    seed_job(fake_client, status="processing", lease_token="t-live")
    await _record_organize_event(
        fake_client, "j1", "u1", "stage", "Finding places", lease_token="t-live")

    await _record_organize_event(
        fake_client, "j1", "u1", "result", "Organized", {"status": "succeeded"},
        lease_token="t-superseded")

    assert [event["message"] for event in fake_client.db["organize_events"]] == ["Finding places"], \
        "the superseded worker's terminal event must not land"
    assert "organize_event_lease_superseded" in caplog.text
