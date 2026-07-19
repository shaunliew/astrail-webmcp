"""Trip-job leases and the deterministic interleavings that pin them (A2 / A-III).

The bug this file exists for: `recover_inflight_jobs` SELECTed stale `running` jobs and then
UPDATEd **by id alone, with no status guard**. Between the two statements the old worker could
finish, so a `succeeded` job was flipped to `retryable` and re-ran — a completed trip
re-executed and the user double-charged. Its docstring claimed the select-then-flip was safe
because "flipping to retryable twice is idempotent"; that argument covers *repeated flips* and
says nothing at all about the resurrect.

Every race below is replayed through a `BarrierClient` that parks one statement at a named
point, so the interleaving is exact rather than timing-dependent: no sleeps, no flake. The
barrier's own fidelity test comes first — a fake that snapshotted its matches when the query
was built (instead of re-checking them on resume) would make every race test here green while
proving nothing at all.
"""
from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest

import jobs
from jobs import (
    JOB_LEASE_TTL_S,
    _heartbeat,
    _renew_job_lease,
    mark_job_done,
    mark_job_running,
    reclaim_expired_jobs,
)
from test_organizer_lease import _now_utc, _spin_until, in_minutes, minutes_ago
from test_saved_reels_organize import _Client, _Table


# --- the barrier fake -----------------------------------------------------------------------


class _BarrierTable(_Table):
    """`_Table` that can park ONE statement mid-flight so a race can be replayed exactly."""

    def __init__(self, name, db, client):
        super().__init__(name, db)
        self._client = client

    async def execute(self):
        op = self.op[0] if isinstance(self.op, tuple) else self.op
        client = self._client
        if op == "update" and self.name == client.pause_before_update_on:
            client.pause_before_update_on = None      # arm once; later statements run free
            client.at_barrier.set()
            await client.resume.wait()
            return await super().execute()            # predicate evaluated HERE, on resume
        if op == "select" and self.name == client.pause_after_select_on:
            client.pause_after_select_on = None
            result = await super().execute()
            client.selected.set()
            await client.resume.wait()
            return result
        return await super().execute()


class BarrierClient(_Client):
    """A `_Client` that parks one statement so the other worker can act in the gap.

    Arms exactly once: the statement that trips the barrier disarms it, so a sweep's later
    statements — and everything the *other* worker runs while we are parked — proceed
    normally. Without that, the second worker would deadlock against a barrier meant for the
    first.
    """

    def __init__(self, db, *, pause_before_update_on=None, pause_after_select_on=None):
        super().__init__(db)
        self.pause_before_update_on = pause_before_update_on
        self.pause_after_select_on = pause_after_select_on
        self.at_barrier = asyncio.Event()
        self.selected = asyncio.Event()
        self.resume = asyncio.Event()

    def table(self, name):
        return _BarrierTable(name, self.db, self)


def seed_trip_job(client, **fields) -> None:
    client.db.setdefault("jobs", []).append({
        "id": "j1",
        "trip_id": "t1",
        "user_id": "u1",
        "locked_at": minutes_ago(2),
        "lock_expires_at": None,
        "lease_token": None,
        **fields,
    })


def job_row(client, job_id: str = "j1") -> dict:
    return next(row for row in client.db["jobs"] if row["id"] == job_id)


@pytest.fixture
def fake_client() -> _Client:
    return _Client({"jobs": []})


# --- barrier fidelity -----------------------------------------------------------------------


async def test_barrier_client_evaluates_a_parked_update_against_the_row_it_finds_on_resume():
    """THE FIDELITY PROOF for every race below.

    A parked UPDATE must re-check its predicate against the row as it stands when the
    statement finally runs. A fake that matched rows when the query was *built* would let the
    parked write land on a row that had since changed underneath it — which is precisely the
    behaviour these tests exist to prove production does NOT have. Every race assertion in
    this file would then pass against an implementation with no status guard at all.
    """
    client = BarrierClient({"jobs": [{"id": "j1", "status": "running"}]},
                           pause_before_update_on="jobs")

    parked = asyncio.create_task(
        client.table("jobs").update({"status": "retryable"}).eq("status", "running").execute())
    await client.at_barrier.wait()

    job_row(client)["status"] = "succeeded"       # the old worker finishes while we are parked
    client.resume.set()

    assert (await parked).data == []              # matched nothing — the predicate was re-checked
    assert job_row(client)["status"] == "succeeded"


async def test_barrier_disarms_after_one_statement_so_the_sweeps_later_reads_run_free():
    """Arm-once is load-bearing, not an optimization: `reclaim_expired_jobs` runs an UPDATE
    and then a SELECT, and the second worker runs its own statements while we are parked. A
    barrier that re-armed would park those too and deadlock the test instead of failing it.
    """
    client = BarrierClient({"jobs": []}, pause_before_update_on="jobs")
    seed_trip_job(client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))

    sweep = asyncio.create_task(reclaim_expired_jobs(client=client))
    await client.at_barrier.wait()
    client.resume.set()

    assert [job["id"] for job in await asyncio.wait_for(sweep, timeout=5)] == ["j1"]


# --- claim, fence, renew ---------------------------------------------------------------------


async def test_mark_job_running_mints_a_fresh_token_and_a_second_claim_loses(fake_client):
    """The claim returns the TOKEN, not a bool — it is what fences every later write.

    A second claimant must get `None` rather than a token of its own: the CAS is the
    double-run guard, and a claim that handed out a second valid token would let two workers
    both pass every downstream fence.
    """
    seed_trip_job(fake_client, status="pending")

    token = await mark_job_running(fake_client, "j1")
    row = job_row(fake_client)

    assert token and row["lease_token"] == token
    assert row["status"] == "running"
    assert row["locked_at"] is not None
    assert row["lock_expires_at"] > _now_utc().isoformat()      # the lease actually expires
    assert await mark_job_running(fake_client, "j1") is None    # already claimed


async def test_mark_job_done_requires_a_token_and_a_stale_one_is_a_no_op(fake_client):
    """Fencing-bypass regression. There is no unfenced form of `mark_job_done`.

    An optional `lease_token=None` default is exactly the bypass a superseded worker would
    take, so omitting the argument must be a `TypeError` rather than an unfenced write. And
    the bool return is not cosmetic: it is how the one caller that must react to being
    superseded learns it, so it can suppress its terminal `result` event too.
    """
    seed_trip_job(fake_client, status="running", lease_token="new-owner")

    with pytest.raises(TypeError):
        await mark_job_done(fake_client, "j1", status="succeeded")

    assert await mark_job_done(fake_client, "j1", status="failed", lease_token="stale") is False
    assert job_row(fake_client)["status"] == "running"          # the replacement's state stands

    assert await mark_job_done(fake_client, "j1", status="succeeded",
                               lease_token="new-owner") is True
    assert job_row(fake_client)["status"] == "succeeded"
    assert job_row(fake_client)["completed_at"] is not None


async def test_renew_job_lease_is_scoped_to_our_own_live_lease(fake_client):
    """The renewal CAS is predicated on BOTH `status='running'` and OUR token.

    Drop the status guard and a run keeps renewing a job already reclaimed to `retryable` and
    re-dispatched; drop the token guard and any worker's renewal matches any other worker's
    row, which makes the fence decorative.
    """
    expired = minutes_ago(1)
    seed_trip_job(fake_client, status="running", lease_token="t1", lock_expires_at=expired)

    assert await _renew_job_lease(fake_client, "j1", "t-other") is False
    assert job_row(fake_client)["lock_expires_at"] == expired    # untouched

    job_row(fake_client)["status"] = "retryable"
    assert await _renew_job_lease(fake_client, "j1", "t1") is False

    job_row(fake_client)["status"] = "running"
    assert await _renew_job_lease(fake_client, "j1", "t1") is True
    assert job_row(fake_client)["lock_expires_at"] > _now_utc().isoformat()


async def test_trip_heartbeat_renews_the_lease_and_detects_loss(fake_client, monkeypatch):
    """The beat pushes the expiry forward, and STOPS the moment the CAS finds no row.

    Renewal is what makes a 300s TTL safe for a pipeline with no upper time bound (extraction
    runs an agent loop with no timeout). Detection is the other half: once a replacement owns
    the token our CAS matches zero rows, and the beat must say so rather than looping forever
    against a job it no longer holds.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    seed_trip_job(fake_client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))
    lost = asyncio.Event()
    beat = asyncio.create_task(_heartbeat(fake_client, "j1", "t1", lost))

    await _spin_until(lambda: job_row(fake_client)["lock_expires_at"] > _now_utc().isoformat())
    assert not lost.is_set()

    job_row(fake_client)["lease_token"] = "t-replacement"   # reaped, then claimed by another
    await _spin_until(lost.is_set)
    await asyncio.wait_for(beat, timeout=5)

    assert not beat.cancelled()      # it RETURNED on loss; it did not have to be killed


async def test_a_trip_renewal_blip_does_not_abort_a_healthy_run(fake_client, monkeypatch):
    """A transport error is NOT lease loss — mirror of the organize-side rule.

    Losing a lease is an authoritative statement: a CAS that matched zero rows because someone
    else owns the token. A `ConnectionError` says nothing about ownership, so treating it as
    loss lets one flaky moment against PostgREST abort a run that still holds its job.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    seed_trip_job(fake_client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))

    attempts: list[int] = []

    async def always_blips(*_args):
        attempts.append(len(attempts))
        raise ConnectionError("transient PostgREST failure")

    monkeypatch.setattr(jobs, "_renew_job_lease", always_blips)
    lost = asyncio.Event()
    beat = asyncio.create_task(_heartbeat(fake_client, "j1", "t1", lost))

    await _spin_until(lambda: len(attempts) >= 5)
    assert not lost.is_set()         # blips piled up and the run was left alone

    lost.set()
    beat.cancel()
    with pytest.raises(asyncio.CancelledError):
        await beat


# --- reclaim semantics -----------------------------------------------------------------------


async def test_expired_trip_lease_is_reclaimed_to_retryable(fake_client):
    seed_trip_job(fake_client, status="running", lease_token="t-old",
                  lock_expires_at=minutes_ago(1))

    assert [job["id"] for job in await reclaim_expired_jobs(client=fake_client)] == ["j1"]

    row = job_row(fake_client)
    assert row["status"] == "retryable"
    assert row["lease_token"] is None and row["lock_expires_at"] is None
    assert row["locked_at"] is None


async def test_unexpired_running_job_is_not_reclaimed(fake_client):
    # lock_expires_at in the FUTURE → a live instance owns it mid-deploy; leave it alone
    seed_trip_job(fake_client, status="running", lease_token="t-old",
                  lock_expires_at=in_minutes(4))

    assert await reclaim_expired_jobs(client=fake_client) == []
    assert job_row(fake_client)["status"] == "running"


async def test_legacy_NULL_EXPIRY_running_row_is_reclaimable(fake_client):
    """THE ROLLOUT-BOUNDARY ORPHAN, trip side.

    No production code has ever written a non-null `lock_expires_at` — the old
    `mark_job_running` set `locked_at` and nothing else. A job claimed by the OLD container
    during this deploy's overlap therefore has `lock_expires_at IS NULL`, and in SQL
    `NULL < now()` is NULL, not true. An expiry-only predicate skips those rows FOREVER: the
    silent drop guardrail #12 forbids, reintroduced by the very task meant to prevent it.
    """
    seed_trip_job(fake_client, status="running", lease_token=None,
                  lock_expires_at=None, locked_at=minutes_ago(20))     # older than the TTL

    assert [job["id"] for job in await reclaim_expired_jobs(client=fake_client)] == ["j1"]
    assert job_row(fake_client)["status"] == "retryable"


async def test_legacy_null_expiry_row_INSIDE_ttl_is_not_reclaimed(fake_client):
    # the NULL branch must still respect the TTL — a live old-container job is not stolen
    seed_trip_job(fake_client, status="running", lease_token=None,
                  lock_expires_at=None, locked_at=minutes_ago(1))

    assert await reclaim_expired_jobs(client=fake_client) == []
    assert job_row(fake_client)["status"] == "running"


async def test_long_running_trip_with_a_renewed_lease_is_not_reclaimed(fake_client):
    """A run legitimately outliving one TTL must survive on its expiry alone.

    `locked_at` records the FIRST claim and no renewal ever bumps it, so any job running
    longer than JOB_LEASE_TTL_S has a stale `locked_at` while its heartbeat keeps
    `lock_expires_at` in the future. Degrade the legacy branch to a bare `locked_at` age check
    and the reaper requeues healthy long runs — double-execution, guardrail #12's other half.
    """
    seed_trip_job(fake_client, status="running", lease_token="t-live",
                  lock_expires_at=in_minutes(4), locked_at=minutes_ago(20))

    assert await reclaim_expired_jobs(client=fake_client) == []
    assert job_row(fake_client)["status"] == "running"


async def test_reclaim_honours_an_injected_now(fake_client):
    """`now` is the seam the periodic reaper drives its sweep from, so it must reach the
    predicate rather than being accepted and ignored."""
    seed_trip_job(fake_client, status="running", lease_token="t-old",
                  lock_expires_at=in_minutes(4))

    assert await reclaim_expired_jobs(client=fake_client, now=_now_utc()) == []
    assert [job["id"] for job in await reclaim_expired_jobs(
        client=fake_client, now=_now_utc() + timedelta(minutes=10))] == ["j1"]


async def test_reclaim_returns_pending_and_retryable_jobs_to_redispatch(fake_client):
    seed_trip_job(fake_client, status="pending", id="j-pending")
    seed_trip_job(fake_client, status="retryable", id="j-retryable")
    seed_trip_job(fake_client, status="succeeded", id="j-done")
    seed_trip_job(fake_client, status="running", id="j-live", lease_token="t",
                  lock_expires_at=in_minutes(4))

    reclaimable = await reclaim_expired_jobs(client=fake_client)

    assert {job["id"] for job in reclaimable} == {"j-pending", "j-retryable"}
    assert all({"id", "trip_id", "user_id"} <= set(job) for job in reclaimable)


async def test_trip_reclaim_clears_the_stale_lease_token(fake_client):
    """An expired-but-alive old worker must NOT be able to finalize a reclaimed job.

    `mark_job_done` fences on `lease_token` with NO status guard, so leaving the token on the
    row lets the old worker's `_fail` flip `retryable` -> `failed` and cancel the retry this
    reclaim just scheduled. Nulling the token is what makes the fence exclude it.
    """
    seed_trip_job(fake_client, status="running", lease_token="t1",
                  lock_expires_at=minutes_ago(1))

    await reclaim_expired_jobs(client=fake_client)

    row = job_row(fake_client)
    assert row["status"] == "retryable" and row["lease_token"] is None
    assert await mark_job_done(fake_client, "j1", status="failed", lease_token="t1") is False
    assert job_row(fake_client)["status"] == "retryable"        # the retry survives


# --- the interleavings ------------------------------------------------------------------------


async def test_recovery_does_not_resurrect_a_job_that_succeeded_mid_sweep():
    """THE BUG. The old worker completes in the window the sweep is parked in.

    The pre-fix code SELECTed stale `running` rows and then UPDATEd by id with no status
    guard, so a `succeeded` job written in that window was flipped back to `retryable` and
    re-ran — a completed trip re-executed end to end, at full provider cost. Pushing the whole
    predicate into the UPDATE is what closes it: `status='running'` is re-evaluated against
    the row as it stands on resume, and `succeeded` no longer matches.
    """
    client = BarrierClient({"jobs": []}, pause_before_update_on="jobs")
    seed_trip_job(client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))

    sweep = asyncio.create_task(reclaim_expired_jobs(client=client))
    await client.at_barrier.wait()

    assert await mark_job_done(client, "j1", status="succeeded", lease_token="t1") is True
    client.resume.set()
    reclaimable = await asyncio.wait_for(sweep, timeout=5)

    assert job_row(client)["status"] == "succeeded"            # NOT resurrected as retryable
    assert [job["id"] for job in reclaimable] == []


async def test_recovery_does_not_erase_a_fresh_claim():
    """A second reaper's parked sweep must not steal a lease claimed while it waited.

    Two instances boot together (or a boot sweep overlaps a periodic one). Reaper A reclaims
    and the redispatch claims fresh, minting a new token and a future expiry. Reaper B's
    UPDATE then lands: `lock_expires_at < now` is re-evaluated against the renewed row, so it
    matches nothing and the live run keeps its claim.
    """
    client = BarrierClient({"jobs": []}, pause_before_update_on="jobs")
    seed_trip_job(client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))
    other = _Client(client.db)      # reaper A + the redispatch, sharing the same rows

    sweep_b = asyncio.create_task(reclaim_expired_jobs(client=client))
    await client.at_barrier.wait()

    assert [job["id"] for job in await reclaim_expired_jobs(client=other)] == ["j1"]
    fresh_token = await mark_job_running(other, "j1")
    assert fresh_token is not None

    client.resume.set()
    await asyncio.wait_for(sweep_b, timeout=5)

    row = job_row(client)
    assert row["status"] == "running"                 # the fresh claim stands
    assert row["lease_token"] == fresh_token


async def test_reaper_does_not_reset_a_lease_the_heartbeat_just_renewed():
    """THE RENEWAL/REAPER RACE.

    The heartbeat deliberately keeps the SAME token, so a select-then-CAS reaper would still
    match it on resume and reset a lease that is demonstrably alive. Only pushing the expiry
    into the UPDATE's own predicate makes the renewal win: `lock_expires_at < now` is
    re-evaluated against the renewed row and matches zero rows. The worker must also not
    observe a lost lease — a reaper that reset it would make the next renewal return False
    and abort a healthy run.
    """
    client = BarrierClient({"jobs": []}, pause_before_update_on="jobs")
    seed_trip_job(client, status="running", lease_token="t1", lock_expires_at=minutes_ago(1))
    worker = _Client(client.db)

    sweep = asyncio.create_task(reclaim_expired_jobs(client=client))
    await client.at_barrier.wait()

    assert await _renew_job_lease(worker, "j1", "t1") is True      # the heartbeat wins
    client.resume.set()
    await asyncio.wait_for(sweep, timeout=5)

    row = job_row(client)
    assert row["status"] == "running"                              # NOT reset
    assert row["lease_token"] == "t1"                              # lease intact
    assert await _renew_job_lease(worker, "j1", "t1") is True      # and still renewable


async def test_reclaimed_job_is_dispatchable_again_and_the_old_token_is_dead():
    """End to end: expire -> reclaim -> re-claim -> the old worker can finalize nothing.

    Ties the pieces together in the order a Render deploy actually produces them, so a
    regression in any single one of them surfaces here as well as in its own test.
    """
    client = _Client({"jobs": []})
    seed_trip_job(client, status="running", lease_token="t-old",
                  lock_expires_at=minutes_ago(1))

    assert [job["id"] for job in await reclaim_expired_jobs(client=client)] == ["j1"]
    new_token = await mark_job_running(client, "j1")
    assert new_token is not None and new_token != "t-old"

    assert await _renew_job_lease(client, "j1", "t-old") is False
    assert await mark_job_done(client, "j1", status="failed", lease_token="t-old") is False
    assert job_row(client)["status"] == "running"

    assert await mark_job_done(client, "j1", status="succeeded", lease_token=new_token) is True
    assert job_row(client)["status"] == "succeeded"


def test_lease_ttl_leaves_room_for_several_renewals():
    """A renew interval close to the TTL means one blip loses a healthy lease."""
    assert jobs.JOB_LEASE_RENEW_S * 4 <= JOB_LEASE_TTL_S
