"""Trip-run lease fencing: the terminal write, the heartbeat, and the loop gates (A2 / A-III).

Why the terminal `result` event needs fencing at all, and not just the job row.
`api/streaming.py` ends the SSE stream on the FIRST row with `event_type == "result"`, and
its seen-set dedupes by row **id** — so a second writer's row is a different id and is not
deduped. A superseded worker appending its own terminal result therefore ends the user's
session on a failure that isn't real, or on an itinerary the replacement has already
superseded, and the replacement's genuine result is never delivered. `mark_job_done`'s fence
alone does not stop that: it guards the JOB row, not the EVENT. `complete_trip_run` makes
them one transaction, so "no job write => no event write" is true rather than probable.

`trips.status` is GATED, not fenced — and the gate now covers `_fail` too. It has no CAS to
reject a stale write, and no read of it gates a decision anywhere in the backend, so it was
argued as "bounded". That was half right: bounding the window only helps if the superseded
worker aborts BEFORE the replacement finishes. A worker parked in a call with no timeout
(extraction's agent loop over `web_search` — the reason the heartbeat exists) can finish
aborting AFTER, stamping `failed` over a completed trip with nothing to correct it. `_fail`
now takes `lease_lost` and skips its unfenced writes when set. The normalized-persistence
block remains gated-not-fenced, which this file still does not assert a guarantee about.
"""
from __future__ import annotations

import asyncio
import logging

import pytest

import jobs
from organizer import LeaseLost
from pipeline import persist, runner
from pipeline.test_runner import (
    _Client,
    _no_hotel,
    _no_narrator,
    _no_restaurant,
    _no_transport,
    _no_weather,
    _place,
    _reel,
)
from test_organizer_lease import _expiry, _now_utc, _spin_until, advance_db_clock, minutes_ago


def seeded_client(**fields) -> _Client:
    return _Client(jobs=[{
        "id": "job-1", "trip_id": "trip-1", "user_id": "user-1", "status": "pending",
        "lease_token": None, "lock_expires_at": None, "locked_at": minutes_ago(1),
        **fields,
    }])


async def _scrape(url):
    return _reel(url)


async def _extract(_reel_data):
    return [_place("Tokyo Tower")]


async def run(client, **overrides):
    """`run_generation` with every live provider stubbed out — only the lease matters here."""
    kwargs = dict(
        job_id="job-1", client=client, scrape=_scrape, extract=_extract, mem0=None,
        weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
        narrator=_no_narrator, hotel=_no_hotel,
    )
    kwargs.update(overrides)
    return await runner.run_generation(
        "trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01", **kwargs)


def results(client) -> list[dict]:
    return [event for event in client.events if event["event_type"] == "result"]


def job_row(client) -> dict:
    return client.db["jobs"][0]


# --- the terminal write ------------------------------------------------------------------


async def test_the_terminal_result_and_the_job_status_land_together_through_one_rpc():
    """The single-worker path still writes exactly one result and completes the job.

    Routing both terminal writes through one RPC is the whole change here, so the ordinary
    path is worth pinning explicitly: a fence that also broke the happy path would be caught
    by the wider suite, but not attributed.
    """
    client = seeded_client()

    out = await run(client)

    assert out["itinerary"]["days"][0]["place_names"] == ["Tokyo Tower"]
    assert [event["message"] for event in results(client)] == ["generation complete"]
    assert job_row(client)["status"] == "succeeded"
    # The claim, then BOTH fenced writes, in order. The claim leads because every lease
    # instant is the database's now; the itinerary rewrite is a destructive delete-reinsert
    # and goes through its own fence, not just the terminal one.
    assert [name for name, _params in client.rpc_calls] == [
        "claim_trip_job", "replace_trip_itinerary", "complete_trip_run"]


async def test_a_run_without_a_job_id_still_writes_its_terminal_result():
    """No durable job means nothing to fence — but the terminal result is still REQUIRED.

    The SSE stream ends on it (`data: [DONE]` follows), so dropping it for the jobless path
    while routing the leased path through the RPC would hang every such stream until the
    client gave up — silently, and against the most breaking contract in the repo.
    """
    client = _Client(jobs=[])

    await run(client, job_id=None)

    assert [event["message"] for event in results(client)] == ["generation complete"]
    assert client.rpc_calls == []


async def test_a_superseded_worker_writes_neither_the_job_status_nor_a_result_event(monkeypatch):
    """THE FENCE. An old worker that reaches its terminal path must write nothing.

    The renewal is stubbed to keep succeeding, which is not a contrivance: a renewal BLIP is
    deliberately not treated as lease loss, so a worker whose heartbeat cannot reach Postgres
    sails past every in-process gate and arrives here holding a token the row no longer
    carries. That is the state in which only the DB-side fence can save the replacement's
    result — and the SUCCESS terminal is the one that matters, since a superseded worker
    reaching it would otherwise end the user's stream on a stale itinerary.

    The replacement is deliberately left MID-RUN when the old worker finalizes. That is what
    makes this a test of the LEASE TOKEN rather than of the status guard: with the
    replacement already finished the row would read `succeeded` and `status = 'running'`
    alone would reject the stale write, so the token predicate could be deleted outright and
    this test would stay green. Held mid-run, the row is `running` with the replacement's
    token, and the token is the only thing that can tell the two workers apart.
    """
    client = seeded_client()
    old_entered, old_release = asyncio.Event(), asyncio.Event()
    new_entered, new_release = asyncio.Event(), asyncio.Event()

    def parked_extract(entered, release):
        async def extract(reel_data):
            entered.set()
            await release.wait()
            return await _extract(reel_data)
        return extract

    async def never_notices(*_args):
        return True                     # the beat's CAS never reaches Postgres

    monkeypatch.setattr(jobs, "_renew_job_lease", never_notices)

    old = asyncio.create_task(run(client, extract=parked_extract(old_entered, old_release)))
    await _spin_until(old_entered.is_set)
    old_token = job_row(client)["lease_token"]

    # The reaper finds the lease expired and a replacement claims — the deploy-overlap
    # sequence in full, driven through the real reclaim rather than by editing the row.
    advance_db_clock(client, minutes=10)
    assert [job["id"] for job in await jobs.reclaim_expired_jobs(client=client)] == ["job-1"]
    new = asyncio.create_task(run(client, extract=parked_extract(new_entered, new_release)))
    await _spin_until(new_entered.is_set)
    new_token = job_row(client)["lease_token"]
    assert new_token and new_token != old_token

    old_release.set()
    await asyncio.wait_for(old, timeout=5)

    # The old worker has now run its ENTIRE terminal path while the replacement is still
    # parked mid-provider-call. Nothing of its terminal state may have landed.
    assert job_row(client)["status"] == "running"
    assert job_row(client)["lease_token"] == new_token
    assert results(client) == []

    new_release.set()
    replacement = await asyncio.wait_for(new, timeout=5)

    # The replacement finishes on its own terms, and the stream sees its result and only its.
    assert replacement["itinerary"]["days"]
    assert job_row(client)["status"] == "succeeded"
    assert [event["message"] for event in results(client)] == ["generation complete"]


async def test_a_superseded_workers_failure_terminal_is_fenced_too(monkeypatch):
    """The failure half of the same fence — and the one that actually fires in production.

    A superseded worker's usual exit is `LeaseLost` from a gate, which lands in `_fail`. If
    only the success terminal were fenced, that path would append a `generation failed`
    result and end the user's stream on a failure while the replacement was still working.
    """
    client = seeded_client()
    token = await jobs.mark_job_running(client, "job-1")
    job_row(client)["lease_token"] = "someone-else"      # reaped, then claimed by another

    out = await runner._fail(client, "trip-1", "user-1", "job-1", "save", "boom",
                             lease_token=token)

    assert out == {"error": "boom"}
    assert results(client) == []                          # the stale result never lands
    assert job_row(client)["status"] == "running"         # the replacement's state stands


async def test_fail_without_a_lease_token_does_not_write_job_status():
    """A run that died BEFORE the claim never owned the job.

    Writing `failed` from there would stamp a terminal state over a live run holding the
    lease. The row belongs to the reaper, which requeues it; the deterministic
    pre-claim failures that would otherwise loop on that requeue are what
    `config_validation` closes at boot.
    """
    client = seeded_client(status="running", lease_token="live-worker")

    out = await runner._fail(client, "trip-1", "user-1", "job-1", "scrape", "no token here")

    assert out == {"error": "no token here"}
    assert job_row(client)["status"] == "running"         # untouched
    assert client.rpc_calls == []
    assert results(client) == []


async def test_a_blipped_terminal_write_leaves_the_job_for_the_reaper(monkeypatch):
    """A transport failure on the terminal RPC must not re-enter `_fail`.

    Successor to `test_runner_mark_job_done_raise_does_not_double_result_or_flip_status`
    (a gstack /review cross-model High), which injected its blip through a fake table that
    fired on the jobs UPDATE carrying `completed_at`. That write no longer exists as a
    separate statement, so the injection point moves to the RPC — the finding it guards does
    not: the terminal write sits inside `run_generation`'s outermost try, after the trip has
    been persisted, and an unguarded raise would reach `except Exception: _fail(...)` and
    flip an already-saved trip to `failed`.

    What DID change is the honest outcome. The job write and the result event are now atomic,
    so a blip leaves BOTH unwritten rather than a result with no job completion: the job
    stays `running`, the reaper reclaims it, and a later attempt writes the pair together.
    """
    client = seeded_client()

    async def boom(*_args, **_kwargs):
        raise RuntimeError("db blip on the terminal write")

    monkeypatch.setattr(runner, "_complete_trip_run", boom)

    out = await run(client)

    assert out["itinerary"]["days"]                        # the run itself succeeded
    assert results(client) == []                           # atomic: neither half landed
    assert job_row(client)["status"] == "running"          # left for the reaper
    warnings = [event for event in client.events if event["event_type"] == "warning"]
    assert any(event["message"] == "job completion mark failed; recovery may re-sweep"
               for event in warnings)


# --- heartbeat + gates -------------------------------------------------------------------


async def test_the_running_heartbeat_renews_a_long_runs_lease(monkeypatch):
    """Liveness, half one: a beat that is created but never scheduled renews nothing.

    The trip pipeline has no upper time bound — extraction runs an agent loop with no timeout
    — so without a live beat the reaper reclaims a healthy run and two workers execute it.
    This parks the run where a real provider call sits and requires the expiry to move
    forward on its own, with nothing in the test touching the renewal.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    client = seeded_client()
    entered, release = asyncio.Event(), asyncio.Event()

    async def parked_extract(reel_data):
        entered.set()
        await release.wait()
        return await _extract(reel_data)

    task = asyncio.create_task(run(client, extract=parked_extract))
    await _spin_until(entered.is_set)

    job_row(client)["lock_expires_at"] = minutes_ago(1)          # let the lease go stale
    await _spin_until(lambda: _expiry(job_row(client)) > _now_utc())

    release.set()
    await asyncio.wait_for(task, timeout=5)
    assert job_row(client)["status"] == "succeeded"


async def test_lease_expiry_during_a_blocked_provider_call_aborts_the_run(monkeypatch, caplog):
    """LIVENESS, half two — and the reason the gates exist.

    A heartbeat is the easiest guard here to ship broken and green: a task created but never
    scheduled renews nothing, and every direct `_renew_job_lease(...)` call still passes,
    because that proves the function works, not that anything calls it. So this test never
    calls the renewal itself. It parks the run inside `extract`, replaces the row's token the
    way the reaper plus a replacement would, and requires the abort to come from the beat the
    run started on its own — observed through the save block never running.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    caplog.set_level(logging.WARNING, logger="pipeline.runner")
    client = seeded_client()
    entered, release = asyncio.Event(), asyncio.Event()

    async def parked_extract(reel_data):
        entered.set()
        await release.wait()
        return await _extract(reel_data)

    renewals: list[bool] = []
    real_renew = jobs._renew_job_lease

    async def watched_renew(*args):
        outcome = await real_renew(*args)
        renewals.append(outcome)
        return outcome

    monkeypatch.setattr(jobs, "_renew_job_lease", watched_renew)

    # `LeaseLost` is raised at the gate and handled by the run's outer `except`, so the only
    # honest place to observe WHICH exception aborted it is at that boundary. The type is
    # load-bearing: a bare `RuntimeError` would make "we were superseded" indistinguishable
    # from a genuine pipeline error at exactly the moment an operator must tell them apart.
    raised: list[BaseException | None] = []
    real_fail = runner._fail

    async def watched_fail(*args, **kwargs):
        import sys
        raised.append(sys.exc_info()[1])
        return await real_fail(*args, **kwargs)

    monkeypatch.setattr(runner, "_fail", watched_fail)

    task = asyncio.create_task(run(client, extract=parked_extract))
    await _spin_until(entered.is_set)

    job_row(client)["lease_token"] = "t-replacement"
    await _spin_until(lambda: False in renewals)     # the RUNNING beat saw the zero-row CAS

    release.set()
    out = await asyncio.wait_for(task, timeout=5)

    assert out == {"error": "unexpected generation error"}
    assert isinstance(raised[0], LeaseLost)
    assert client.db.get("trip_places") is None      # the save block never ran
    assert results(client) == []                     # and no terminal result was appended


async def test_the_heartbeat_task_does_not_outlive_the_run(monkeypatch):
    """A leaked beat keeps renewing the lease of a run that has already finished.

    Not cosmetic: it would hold a completed job's lease against the reaper, and on a real
    event loop an un-awaited task outliving its parent surfaces only as a "Task was destroyed
    but it is pending" warning at shutdown — nothing a test would otherwise catch.
    """
    client = seeded_client()
    outcomes: list[str] = []
    real_heartbeat = jobs._heartbeat

    async def watched_heartbeat(*args):
        try:
            await real_heartbeat(*args)
        except asyncio.CancelledError:
            outcomes.append("cancelled")
            raise
        outcomes.append("returned")

    monkeypatch.setattr(runner, "_heartbeat", watched_heartbeat)

    async def yielding_extract(reel_data):
        # A real provider call yields; the fake client never does. Without one yield the beat
        # would be cancelled before it ever ran, and this would pass vacuously against an
        # implementation that leaks a *scheduled* task.
        await asyncio.sleep(0)
        return await _extract(reel_data)

    await run(client, extract=yielding_extract)

    assert outcomes == ["cancelled"]        # the run's `finally` reaped it, and awaited it


async def test_no_heartbeat_is_started_for_a_run_that_lost_the_claim():
    """A run that never won the CAS owns nothing and must renew nothing.

    Starting a beat before knowing the claim succeeded would have the loser renewing the
    WINNER's lease — the double-run guard inverted into a double-run enabler.
    """
    client = seeded_client(status="running", lease_token="someone-else")

    out = await run(client)

    assert out == {"skipped": "job already claimed by another run"}
    assert job_row(client)["lease_token"] == "someone-else"
    # The claim is attempted and LOSES; nothing follows it — no renewal, no terminal write.
    assert [name for name, _params in client.rpc_calls] == ["claim_trip_job"]


async def test_a_superseded_worker_does_not_stamp_failed_over_a_completed_trip():
    """`trips.status` has no CAS — the gate is the only thing protecting it.

    Reverse-ordering race: the replacement finishes and writes `complete`, and only THEN does
    the superseded worker's blocking call return and carry it into `_fail`. "Bounded to one
    renewal interval" does not help here — the stale write simply lands last, and unlike the
    job row (rejected by `complete_trip_run`'s CAS) and the stray `error` event (unreachable,
    `api/streaming.py` returns on the first `result`), nothing ever corrects `trips.status`.

    Asserted on `trip_updates` — the writes the code actually issues. An earlier draft of this
    test asserted a `client.trips` list nothing writes to, so it passed vacuously.
    """
    client = seeded_client()
    token = await jobs.mark_job_running(client, "job-1")
    job_row(client)["lease_token"] = "someone-else"       # reaped, then claimed by a replacement

    lease_lost = asyncio.Event()
    lease_lost.set()                                      # our beat already observed the loss

    out = await runner._fail(client, "trip-1", "user-1", "job-1", "save", "boom",
                             lease_token=token, lease_lost=lease_lost)

    assert out == {"error": "boom"}
    assert client.trip_updates == [], \
        "a superseded worker must issue NO trips write — there is no CAS to reject it"
    assert results(client) == []                          # terminal result still fenced


# --- the destructive write ----------------------------------------------------------------


def sharing(client: _Client) -> _Client:
    """A second worker's client over the SAME rows.

    Separate `rpc_calls` per worker is the point: both workers legitimately call
    `replace_trip_itinerary`, so a shared call list could not tell whose write was attempted.
    """
    other = _Client()
    other.db = client.db
    return other


def parked_at_first_place_lookup(entered: asyncio.Event, release: asyncio.Event):
    """Park the FIRST worker to reach the save path, inside `persist_itinerary`.

    That is the window this file did not previously cover: past the pre-save gate, before the
    rewrite. `_find_or_create_place` is a real per-place round trip, so it is where a worker
    actually sits — produced rather than hand-forged. One-shot, so the replacement's own
    lookups run free instead of deadlocking against a barrier meant for the old worker.
    """
    real = persist._find_or_create_place
    armed = [True]

    async def hook(client, place):
        if armed[0]:
            armed[0] = False
            entered.set()
            await release.wait()
        return await real(client, place)

    return hook


def place_names_on(client: _Client) -> list[str]:
    by_id = {row["id"]: row["name"] for row in client.db.get("places", [])}
    return sorted(by_id[tp["place_id"]] for tp in client.db.get("trip_places", []))


async def test_a_superseded_worker_cannot_overwrite_the_replacements_itinerary(monkeypatch):
    """THE UNBOUNDED OVERWRITE. `persist_itinerary` delete-reinserts the whole trip.

    Arc A's accepted scope limit is "a worker parked in one provider call still lands THAT
    item" — bounded, additive, one item. This was neither: past the single pre-save gate came
    a destructive rewrite of every trip_places/trip_days row, four enrich stages, and an
    unbounded narration call. A worker superseded anywhere in there deleted the replacement's
    itinerary and inserted its own, and nothing anywhere corrects that — not
    `complete_trip_run`'s CAS (it guards the JOB row) and not `api/streaming.py` (it guards
    the event stream).

    Two contrivance-avoidances make this test load-bearing rather than decorative:

    1. The renewal is stubbed to keep succeeding, so `lease_lost` NEVER fires. The in-process
       race cannot fire either, and the old worker walks all the way to the write. Only the
       DB-side fence can stop it here — which is exactly the state a worker whose heartbeat
       cannot reach Postgres arrives in.
    2. The replacement is deliberately left MID-RUN, parked in narration. With it already
       finished the job row would read `succeeded` and the RPC's `status = 'running'`
       predicate would reject the stale write on its own — so the lease-token predicate could
       be deleted outright and this test would still pass. Held mid-run, the row is `running`
       carrying the replacement's token, and the token is the only thing telling them apart.

    The two workers extract DIFFERENT places so the surviving rows identify their author.
    """
    client = seeded_client()
    old_entered, old_release = asyncio.Event(), asyncio.Event()
    narrating, finish_narration = asyncio.Event(), asyncio.Event()

    async def never_notices(*_args):
        return True                     # the beat's CAS never reaches Postgres

    monkeypatch.setattr(jobs, "_renew_job_lease", never_notices)
    monkeypatch.setattr(persist, "_find_or_create_place",
                        parked_at_first_place_lookup(old_entered, old_release))

    async def extract_tokyo_tower(_reel_data):
        return [_place("Tokyo Tower", lat=35.6586, lng=139.7454)]

    async def extract_sensoji(_reel_data):
        return [_place("Senso-ji", lat=35.7148, lng=139.7967)]

    async def parked_narrator(*_args, **_kwargs):
        narrating.set()
        await finish_narration.wait()
        return await _no_narrator()

    old = asyncio.create_task(run(client, extract=extract_tokyo_tower))
    await _spin_until(old_entered.is_set)        # the old worker is INSIDE the save path
    old_token = job_row(client)["lease_token"]

    # The reaper finds the lease expired and a replacement claims — the deploy-overlap
    # sequence in full, driven through the real reclaim rather than by editing the row.
    replacement_client = sharing(client)
    advance_db_clock(replacement_client, minutes=10)
    assert [job["id"] for job in await jobs.reclaim_expired_jobs(
        client=replacement_client)] == ["job-1"]
    new = asyncio.create_task(run(replacement_client, extract=extract_sensoji,
                                  narrator=parked_narrator))
    await _spin_until(narrating.is_set)          # it has PERSISTED and is still running
    new_token = job_row(client)["lease_token"]
    assert new_token and new_token != old_token
    assert place_names_on(client) == ["Senso-ji"]

    old_release.set()
    out = await asyncio.wait_for(old, timeout=5)

    # THE ASSERTION THIS TEST EXISTS FOR, first so a regression names the damage it caused.
    assert place_names_on(client) == ["Senso-ji"], \
        "the superseded worker deleted or overwrote the replacement's itinerary"
    assert [row["day_number"] for row in client.db["trip_days"]] == [1]
    # And it is not vacuous: the old worker DID run its entire save path and reach the write —
    # only the fence refused it, which is also why it ends in the error branch.
    assert "replace_trip_itinerary" in [name for name, _p in client.rpc_calls]
    assert out == {"error": "unexpected generation error"}
    assert results(client) == []

    finish_narration.set()
    replacement = await asyncio.wait_for(new, timeout=5)

    # The replacement finishes on its own terms, with its own itinerary intact.
    assert replacement["itinerary"]["days"][0]["place_names"] == ["Senso-ji"]
    assert place_names_on(client) == ["Senso-ji"]
    assert job_row(client)["status"] == "succeeded"


async def test_losing_the_lease_mid_save_cancels_the_worker_before_it_writes(monkeypatch):
    """The RACE: a lost lease must stop the save path where it stands, not at the far end.

    A single `if lease_lost.is_set()` in front of the save block is a TOCTOU — the check
    passes and then the rewrite, four enrich stages and an unbounded narration call follow.
    The worker here is parked INSIDE `persist_itinerary` when the beat observes the loss, and
    it must unwind from there: nothing released it, and it must not need releasing.

    That is what makes this test discriminate. Swap the race back for the pre-save gate and
    the worker sits parked until something releases it — nothing does — and then walks on to
    attempt the write. The fence would still refuse that write, which is precisely why the
    surviving-rows assertion cannot carry this test: the observable has to be that the attempt
    was never made, and that the run ended without one.

    Also asserts the run does not report success. `CancelledError` is a BaseException, so the
    save block's `except Exception` cannot swallow it into `saved_with_gaps` — but that is a
    property of the code as written, not a guarantee, and a `except BaseException` slipped in
    anywhere in that block would turn an abort into a silently "saved" trip.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    client = seeded_client()
    entered, release = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(persist, "_find_or_create_place",
                        parked_at_first_place_lookup(entered, release))

    renewals: list[bool] = []
    real_renew = jobs._renew_job_lease

    async def watched_renew(*args):
        outcome = await real_renew(*args)
        renewals.append(outcome)
        return outcome

    monkeypatch.setattr(jobs, "_renew_job_lease", watched_renew)

    task = asyncio.create_task(run(client, extract=_extract))
    await _spin_until(entered.is_set)                # parked INSIDE the save path

    job_row(client)["lease_token"] = "t-replacement"
    await _spin_until(lambda: False in renewals)     # the RUNNING beat saw the zero-row CAS

    out = await asyncio.wait_for(task, timeout=5)    # unwinds with NOTHING releasing it

    assert not release.is_set()
    assert out == {"error": "unexpected generation error"}       # not a payload, not "saved"
    assert "replace_trip_itinerary" not in [name for name, _params in client.rpc_calls], \
        "a cancelled worker must not have attempted the destructive rewrite"
    assert client.db.get("trip_places") is None                  # no half-written state
    assert client.db.get("trip_days") is None
    # `_fail` still runs its FENCED terminal (that is its job) — and the fence refuses it,
    # which is what keeps "aborted" from surfacing to the user as a real outcome.
    assert results(client) == []


async def test_a_worker_whose_heartbeat_cannot_reach_postgres_stops(monkeypatch):
    """Sustained unreachability must abort the run, not be swallowed into "keep working".

    The runner-level half of
    `test_a_heartbeat_that_cannot_reach_postgres_past_the_ttl_declares_the_lease_lost`. The
    beat is the only component that can tell a parked worker it has been superseded, so a beat
    that swallows every error forever leaves the worker running with `lease_lost` clear — past
    the gate, past the race, into the save path — on a job the reaper has already handed on.
    Here nothing edits the row and no CAS returns zero: the ONLY signal is that renewal cannot
    reach Postgres at all, and the run must still stop.
    """
    monkeypatch.setattr(jobs, "JOB_LEASE_RENEW_S", 0)
    client = seeded_client()
    entered, release = asyncio.Event(), asyncio.Event()

    real_claim = jobs.mark_job_running

    async def claim_then_collapse_the_ttl(*args, **kwargs):
        """Claim on a REAL TTL, then collapse it so the beat's deadline is immediately past.

        Setting `JOB_LEASE_TTL_S = 0` up front — which is what this test used to do — now asks
        `claim_trip_job` to mint a lease the database considers expired the instant it is
        written, and the RPC rejects that outright. Rightly so: the scenario here is a worker
        that HOLDS a lease and cannot renew it, so it must genuinely hold one first. The beat
        reads the constant when it starts, which is after this returns.
        """
        token = await real_claim(*args, **kwargs)
        monkeypatch.setattr(jobs, "JOB_LEASE_TTL_S", 0)
        return token

    monkeypatch.setattr(runner, "mark_job_running", claim_then_collapse_the_ttl)

    attempts: list[int] = []

    async def unreachable(*_args):
        attempts.append(len(attempts))
        raise ConnectionError("PostgREST is unreachable")

    monkeypatch.setattr(jobs, "_renew_job_lease", unreachable)

    async def parked_extract(reel_data):
        entered.set()
        await release.wait()
        return await _extract(reel_data)

    task = asyncio.create_task(run(client, extract=parked_extract))
    await _spin_until(entered.is_set)
    await _spin_until(lambda: len(attempts) >= 1)

    release.set()
    out = await asyncio.wait_for(task, timeout=5)

    assert out == {"error": "unexpected generation error"}
    assert client.db.get("trip_places") is None      # the save block never ran
    # No replacement has claimed yet — the reaper has not run — so the row still carries OUR
    # token and the terminal CAS legitimately matches. That is the fence working, not leaking:
    # had a replacement claimed, the token would differ and this worker would write nothing.
    # It also matters that SOMETHING terminal lands, because the SSE stream ends on it
    # (guardrail #12: re-queued or explicitly failed, never silently dropped).
    assert [event["message"] for event in results(client)] == ["generation failed"]
    assert job_row(client)["status"] == "failed"


async def test_a_live_worker_still_writes_its_own_failure():
    """The gate must not silence a legitimate failure — that would hide every real error."""
    client = seeded_client()
    token = await jobs.mark_job_running(client, "job-1")

    out = await runner._fail(client, "trip-1", "user-1", "job-1", "save", "boom",
                             lease_token=token, lease_lost=asyncio.Event())   # NOT set

    assert out == {"error": "boom"}
    assert any(u.get("status") == "failed" for u in client.trip_updates), \
        "a live worker's own failure must still reach trips.status"
