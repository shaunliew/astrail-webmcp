"""Two-session concurrency race test for reserve_and_enqueue_trip_job — exercises the
unique_violation / undo / re-read branch that NO single-session pgTAP test can reach.

Why this needs two sessions (per supabase/tests/017_entitlement_rpcs.sql, which documents the
gap): single-session, a visible ACTIVE row short-circuits at the replay SELECT → `replay`, and an
only-refunded row lets the job INSERT succeed → `created`; neither path reaches the code AFTER a
23505 on the partial unique index. Only two racers colliding on that index exercise the undo.

Choreography: a `winner` holds an UNCOMMITTED active job for key K; a `loser` calls the RPC and
passes its active-only replay SELECT (the winner's row is uncommitted → invisible; a seeded
*refunded* row is filtered out by `charge_refunded_at is null`), reserves the entitlement
(counter 1→2), then BLOCKS inserting its own job for K on jobs_idempotency_key_active_uidx. When
the winner commits, the loser hits 23505, runs the undo branch (reservation rolled back to 1, its
trip+event+job discarded by the savepoint), re-reads the ACTIVE winner, and returns `replay` with
the winner's trip — NOT the later-created_at refunded row.

DEVIATION FROM PLAN PATH: the plan (docs/superpowers/plans/2026-08-02-free-trial-beta-seats.md
L554) names this file `backend/tests/test_reserve_enqueue_race.py`, but `backend/tests/` does not
exist — every other integration test (test_main_integration.py, test_saved_reels_integration.py)
lives in the backend ROOT and is collected there. This file follows that proven convention
(backend root) so pytest collects it with the rest of the suite and the skip-marker discipline
matches; the plan's subdir was never created.

Integration-only: skipped unless RUN_DB_INTEGRATION=1, so the default keyless offline suite stays
green (no key, no DB, no network). Uses async psycopg 3 (psycopg.AsyncConnection) because the
suite is asyncio_mode="auto" and the choreography needs a concurrent task awaiting a blocked query
while an autocommit observer polls the lock graph.
"""
from __future__ import annotations

import asyncio
import os
import uuid

import psycopg
import pytest

pytestmark = pytest.mark.integration
RUN = os.environ.get("RUN_DB_INTEGRATION") == "1"

# Direct, non-pooled Postgres DSN. Defaults to the local `supabase start` value; override via
# SUPABASE_DB_URL. Never a production DSN — the test writes then deletes fixture rows.
DSN = os.environ.get("SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres")

# Deterministic fixed timestamps make the created_at ORDER unambiguous: the refunded row is LATER
# than the winner's active row, so a naive `ORDER BY created_at DESC` would pick the WRONG
# (refunded) row. The RPC's `charge_refunded_at is null` filter is what makes the re-read correct,
# and the `trip_id != refunded` assertion below is what proves that filter is load-bearing.
WINNER_JOB_CREATED_AT = "2020-01-01 00:00:00+00"    # earlier
REFUNDED_JOB_CREATED_AT = "2020-06-01 00:00:00+00"  # later

# Wall-clock ceiling for the whole barrier + loser orchestration: a hang fails loudly, never blocks
# the suite forever.
ORCHESTRATION_TIMEOUT_S = 15
# Per-racer statement timeout: a blocked query self-aborts (loud error) rather than waiting forever
# if the choreography ever breaks.
STATEMENT_TIMEOUT = "10s"

_LANES = [
    pytest.param(
        {
            "user_id": "00000000-0000-0000-0000-0000000019a1",
            "email": "race-trial@example.test",
            "plan": "trial",
            "charge_kind": "lifetime",
            "key": "race-trial-K",
            # trial_limit=2 so the loser RESERVES 1→2 before colliding. At limit 1 it would be
            # rejected AT reservation (trial_exhausted) and never reach the undo branch.
            "trial_limit": 2,
            "daily_limit": 5,  # irrelevant on the trial path
        },
        id="trial-lifetime",
    ),
    pytest.param(
        {
            "user_id": "00000000-0000-0000-0000-0000000019a2",
            "email": "race-beta@example.test",
            "plan": "beta",
            "charge_kind": "daily",
            "key": "race-beta-K",
            "trial_limit": 1,  # irrelevant on the beta path
            # daily_limit=5 so the loser RESERVES 1→2 before colliding (same reason as trial above).
            "daily_limit": 5,
        },
        id="beta-daily",
    ),
]


async def _cleanup(conn: psycopg.AsyncConnection, uid: uuid.UUID) -> None:
    """Idempotent teardown in FK-safe order — children first, then the auth row (its ON DELETE
    CASCADE reaches public.users and anything left). Run before seeding AND after asserting so
    every rerun starts from a clean slate."""
    async with conn.cursor() as cur:
        await cur.execute(
            "delete from public.generation_events where trip_id in "
            "(select id from public.trips where user_id = %s)",
            (uid,),
        )
        await cur.execute("delete from public.jobs where user_id = %s", (uid,))
        await cur.execute("delete from public.trips where user_id = %s", (uid,))
        await cur.execute("delete from public.user_daily_usage where user_id = %s", (uid,))
        await cur.execute("delete from public.users where id = %s", (uid,))
        await cur.execute("delete from auth.users where id = %s", (uid,))


async def _read_counter(conn: psycopg.AsyncConnection, lane: dict, uid: uuid.UUID) -> int:
    """The lane's live entitlement counter: trial → users.lifetime_trip_count; beta → today's
    user_daily_usage.generated_trip_count."""
    async with conn.cursor() as cur:
        if lane["charge_kind"] == "lifetime":
            await cur.execute(
                "select lifetime_trip_count from public.users where id = %s", (uid,)
            )
        else:
            await cur.execute(
                "select generated_trip_count from public.user_daily_usage "
                "where user_id = %s and usage_date = current_date",
                (uid,),
            )
        row = await cur.fetchone()
        assert row is not None, "counter row missing"
        return row[0]


@pytest.mark.skipif(not RUN, reason="set RUN_DB_INTEGRATION=1 to run against local Supabase")
@pytest.mark.parametrize("lane", _LANES)
async def test_reserve_enqueue_race_undo_branch(lane: dict):
    uid = uuid.UUID(lane["user_id"])
    key = lane["key"]

    # THREE direct, non-pooled connections. observer is autocommit because a pg_stat_activity /
    # pg_blocking_pids snapshot is cached inside an open txn — an observer polling from within the
    # winner's txn would see stale state forever (Rev 6 Fix 2).
    winner = await psycopg.AsyncConnection.connect(DSN, autocommit=False)
    loser = await psycopg.AsyncConnection.connect(DSN, autocommit=False)
    observer = await psycopg.AsyncConnection.connect(DSN, autocommit=True)
    loser_task: asyncio.Task | None = None
    try:
        # ── 0. Clean slate ──────────────────────────────────────────────────────────────────
        await _cleanup(observer, uid)

        # ── 1. Seed EVERYTHING, committed, BEFORE any racer txn opens ────────────────────────
        # (so the only lock the loser can wait on is the partial-index insert, not a fixture row).
        async with observer.cursor() as cur:
            # public.users via the auth trigger (mirrors supabase/tests/017_entitlement_rpcs.sql).
            await cur.execute(
                "insert into auth.users (id, email) values (%s, %s)", (uid, lane["email"])
            )
            await cur.execute(
                "update public.users set plan = %s where id = %s", (lane["plan"], uid)
            )
            # The winner's seeded counter = 1 (the charge the winner already holds).
            if lane["charge_kind"] == "lifetime":
                await cur.execute(
                    "update public.users set lifetime_trip_count = 1 where id = %s", (uid,)
                )
            else:
                await cur.execute(
                    "insert into public.user_daily_usage "
                    "(user_id, usage_date, generated_trip_count) values (%s, current_date, 1)",
                    (uid,),
                )
            # Adversarial refunded historical job for key K: its own trip + a jobs row with
            # charge_refunded_at NON-null (so it is invisible to the partial index and to the
            # active-only re-read) whose created_at is LATER than the winner's active job.
            await cur.execute(
                "insert into public.trips (user_id, status) values (%s, 'failed') returning id",
                (uid,),
            )
            refunded_trip_id = (await cur.fetchone())[0]
            await cur.execute(
                "insert into public.jobs (trip_id, user_id, idempotency_key, status, "
                "charge_kind, charge_date, charge_refunded_at, created_at) "
                "values (%s, %s, %s, 'failed', %s, current_date, now(), %s::timestamptz)",
                (refunded_trip_id, uid, key, lane["charge_kind"], REFUNDED_JOB_CREATED_AT),
            )

        # ── 2. winner: BEGIN, insert the ACTIVE trip + job for K, do NOT commit ──────────────
        async with winner.cursor() as cur:
            await cur.execute(f"set statement_timeout = '{STATEMENT_TIMEOUT}'")
            await cur.execute("select pg_backend_pid()")
            winner_pid = (await cur.fetchone())[0]
            await cur.execute(
                "insert into public.trips (user_id, status) values (%s, 'generating') returning id",
                (uid,),
            )
            winner_trip_id = (await cur.fetchone())[0]
            await cur.execute(
                "insert into public.jobs (trip_id, user_id, idempotency_key, status, "
                "charge_kind, charge_date, created_at) "
                "values (%s, %s, %s, 'pending', %s, current_date, %s::timestamptz)",
                (winner_trip_id, uid, key, lane["charge_kind"], WINNER_JOB_CREATED_AT),
            )
        # winner txn stays OPEN — it holds the partial-index entry lock on key K.

        # ── 3. loser: record its PID (can't query a mid-statement conn), then launch the RPC ──
        async with loser.cursor() as cur:
            await cur.execute(f"set statement_timeout = '{STATEMENT_TIMEOUT}'")
            await cur.execute("select pg_backend_pid()")
            loser_pid = (await cur.fetchone())[0]

        async def _run_loser():
            async with loser.cursor() as cur:
                await cur.execute(
                    "select outcome, trip_id, job_id from public.reserve_and_enqueue_trip_job("
                    "%s::uuid, %s::text, %s::text, %s::date, %s::date, %s::text, %s::text, "
                    "%s::text, %s::jsonb, %s::jsonb, %s::integer, %s::integer)",
                    (
                        uid, key, "Tokyo", "2026-09-01", "2026-09-05", "mid_range", "SFO",
                        "loves ramen", "[]", "{}", lane["trial_limit"], lane["daily_limit"],
                    ),
                )
                return await cur.fetchone()

        loser_task = asyncio.create_task(_run_loser())

        # ── 4→6. barrier → winner COMMIT → await loser, all under one wall-clock ceiling ─────
        async def _orchestrate():
            # Barrier: poll from the autocommit observer until the loser is blocked SPECIFICALLY
            # by the winner on the index insert. That proves the loser already passed its
            # active-only replay SELECT and made its reservation.
            while True:
                async with observer.cursor() as cur:
                    await cur.execute(
                        "select %s::int = any(pg_blocking_pids(%s::int))",
                        (winner_pid, loser_pid),
                    )
                    blocked_by_winner = (await cur.fetchone())[0]
                if blocked_by_winner:
                    break
                await asyncio.sleep(0.05)
            # Release the lock: the loser now hits 23505 and runs the undo branch.
            await winner.commit()
            return await loser_task

        outcome, trip_id, job_id = await asyncio.wait_for(
            _orchestrate(), ORCHESTRATION_TIMEOUT_S
        )
        await loser.commit()  # make the loser's net-zero txn durable + release its row locks

        # ── Assertions — each can RED if the branch is wrong ─────────────────────────────────
        # The loser lost the index race, undid its reservation, and re-read the ACTIVE winner.
        assert outcome == "replay", f"expected replay, got {outcome!r}"
        assert trip_id == winner_trip_id, "loser must return the ACTIVE winner's trip"
        assert trip_id != refunded_trip_id, (
            "loser must NOT return the later-created_at refunded trip — proves the active-only "
            "re-read, not created_at ordering"
        )
        assert job_id is None, "a replay creates no new job"

        # Exactly one net charge: the loser's 1→2 reservation was undone back to 1.
        assert await _read_counter(observer, lane, uid) == 1, "exactly one net charge must remain"

        # No orphan from the loser (its savepoint rolled back trip + event + job).
        async with observer.cursor() as cur:
            await cur.execute(
                "select count(*) from public.jobs where idempotency_key = %s", (key,)
            )
            assert (await cur.fetchone())[0] == 2, (
                "only the refunded + winner-active jobs for K (none from the loser)"
            )
            await cur.execute(
                "select count(*) from public.trips where user_id = %s", (uid,)
            )
            assert (await cur.fetchone())[0] == 2, (
                "only the refunded + winner trips (the loser's trip was rolled back)"
            )
    finally:
        if loser_task is not None and not loser_task.done():
            loser_task.cancel()
            try:
                await loser_task
            except (asyncio.CancelledError, Exception):
                pass
        for conn in (winner, loser):
            try:
                await conn.rollback()
            except Exception:
                pass
        try:
            await _cleanup(observer, uid)
        except Exception:
            pass
        await winner.close()
        await loser.close()
        await observer.close()
