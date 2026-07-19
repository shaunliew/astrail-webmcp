"""Organize-job lease reclaim (A2 / A-II I2).

The fake-fidelity tests come FIRST and are load-bearing. `recover_organize_jobs` pushes its
whole reclaim predicate into ONE PostgREST `update().eq().or_()`, so every reclaim test below
is really a test of the fake's filter evaluation. If the fake ignored `.lt`, `.is.null` or
`.or_()` — or evaluated them with Python's `None` semantics instead of Postgres's — all five
reclaim tests would pass while asserting nothing.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from organizer import (
    ORGANIZE_LEASE_TTL_S,
    _pg_timestamp,
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
