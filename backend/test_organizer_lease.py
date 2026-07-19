"""Organize-job lease reclaim (A2 / A-II I2).

The fake-fidelity tests come FIRST and are load-bearing. `recover_organize_jobs` pushes its
whole reclaim predicate into ONE PostgREST `update().eq().or_()`, so every reclaim test below
is really a test of the fake's filter evaluation. If the fake ignored `.lt`, `.is.null` or
`.or_()` — or evaluated them with Python's `None` semantics instead of Postgres's — all five
reclaim tests would pass while asserting nothing.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from organizer import ORGANIZE_LEASE_TTL_S, recover_organize_jobs
from test_saved_reels_organize import _Client


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
