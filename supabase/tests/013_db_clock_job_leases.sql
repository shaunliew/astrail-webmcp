-- The six lease functions against real Postgres (20260720170000).
--
-- The point of this migration is WHOSE CLOCK decides, and that is not observable from Python:
-- the offline mirrors in `backend/test_saved_reels_organize.py` can prove the callers stopped
-- computing instants, but only Postgres can prove the function bodies compute the right one.
-- plpgsql also defers every operator and cast error to RUNTIME, so `supabase db reset` reports
-- a perfectly healthy function whose `make_interval(secs => ...)` raises on its first call.
--
-- THE CENTREPIECE is the `clock_timestamp()`-not-`now()` pair (marked below). A pgTAP file runs
-- inside ONE transaction, so `transaction_timestamp()` — which is exactly what `now()` returns —
-- is frozen for the whole file while `clock_timestamp()` keeps advancing. One `pg_sleep` at the
-- top opens a gap between them, and after that every assertion comparing a written expiry
-- against `transaction_timestamp()` distinguishes the two functions outright. Swap any
-- `clock_timestamp()` in the migration for `now()` and the marked tests fail; nothing else in
-- the repo can catch that substitution.
--
-- Why it matters beyond pedantry: these statements can WAIT on a row lock (a renewal queued
-- behind a reclaim of the same row). With `now()` the granted expiry is measured from before
-- the wait, so a renewal that waited 30s buys only TTL-30s — the lease shrinks exactly when the
-- database is slow and the run most needs it to hold.

begin;

create extension if not exists pgtap with schema extensions;

select plan(42);

-- --- fixtures ---------------------------------------------------------------------------------

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000913', 'lease-clock@example.com'),
       ('00000000-0000-0000-0000-000000000914', 'lease-clock-other@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values ('93000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000913', 'generating', 'Tokyo');

insert into public.jobs (id, trip_id, user_id, idempotency_key, status)
values ('94000000-0000-0000-0000-000000000001',
        '93000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000913', 'lease-clock-a', 'pending'),
       ('94000000-0000-0000-0000-000000000002',
        '93000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000913', 'lease-clock-b', 'retryable');

insert into public.organize_jobs (id, user_id, idempotency_key, status, started_at)
values ('95000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000913', 'lease-clock-org-a', 'pending', null),
       ('95000000-0000-0000-0000-000000000002',
        '00000000-0000-0000-0000-000000000913', 'lease-clock-org-b', 'pending',
        timestamptz '2026-07-19 00:00:00+00');

create temporary table lease_fn (sig text);
insert into lease_fn values
  ('public.claim_trip_job(uuid,uuid,integer)'),
  ('public.renew_trip_job_lease(uuid,uuid,integer)'),
  ('public.reclaim_expired_trip_jobs(integer)'),
  ('public.claim_organize_job(uuid,uuid,uuid,integer,text,integer)'),
  ('public.renew_organize_job_lease(uuid,uuid,uuid,integer)'),
  ('public.reclaim_expired_organize_jobs(integer,text)');

-- Open the gap between `transaction_timestamp()` and `clock_timestamp()` that every marked
-- assertion below depends on. Without it the two are within microseconds and the
-- `clock_timestamp()`-vs-`now()` tests would pass either way — vacuous, and expensively so.
select pg_sleep(2);

-- --- shape and privileges ---------------------------------------------------------------------
--
-- Asserted over all six at once rather than seven times each: `is_empty` names the offending
-- signature in its diagnostic, so a failure is just as attributable and a seventh function
-- cannot be added without inheriting every check.

select is(
  (select count(*) from lease_fn where to_regprocedure(sig) is not null)::integer, 6,
  'all six lease functions exist with the expected signatures'
);
select is_empty(
  $$ select sig from lease_fn
      where not coalesce((select prosecdef from pg_proc where oid = to_regprocedure(sig)), false) $$,
  'every lease function is security definer'
);
select is_empty(
  $$ select sig from lease_fn
      where not coalesce((select 'search_path=""' = any(proconfig) from pg_proc
                           where oid = to_regprocedure(sig)), false) $$,
  'every lease function has an empty search path'
);
select is_empty(
  $$ select sig from lease_fn
      where exists (
        select 1 from pg_proc
        cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
        where oid = to_regprocedure(lease_fn.sig)
          and privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE') $$,
  'PUBLIC cannot execute any lease function'
);
select is_empty(
  $$ select sig from lease_fn
      where coalesce(has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE'), false) $$,
  'anon cannot execute any lease function'
);
select is_empty(
  $$ select sig from lease_fn
      where coalesce(has_function_privilege('authenticated', to_regprocedure(sig), 'EXECUTE'),
                     false) $$,
  'authenticated cannot execute any lease function'
);
select is_empty(
  $$ select sig from lease_fn
      where not coalesce(has_function_privilege('service_role', to_regprocedure(sig), 'EXECUTE'),
                         false) $$,
  'service_role can execute every lease function'
);

-- --- trip claim --------------------------------------------------------------------------------

select ok(
  public.claim_trip_job('94000000-0000-0000-0000-000000000001',
                        '96000000-0000-0000-0000-00000000000a', 300),
  'claim_trip_job claims a pending job'
);

select is(
  (select status from public.jobs where id = '94000000-0000-0000-0000-000000000001'),
  'running',
  'the claimed job is running'
);

-- The expiry is the DATABASE's instant plus the TTL, not anything a caller supplied. A window
-- rather than an equality because `clock_timestamp()` has advanced since the claim executed.
select ok(
  (select lock_expires_at from public.jobs where id = '94000000-0000-0000-0000-000000000001')
    between clock_timestamp() + interval '295 seconds'
        and clock_timestamp() + interval '300 seconds',
  'claim_trip_job sets lock_expires_at from the database clock plus the TTL'
);

-- *** clock_timestamp() NOT now() ***
-- This transaction has been open for over two seconds. `now()` would have stamped
-- `transaction_timestamp() + 300s` exactly; `clock_timestamp()` stamps strictly later.
select ok(
  (select lock_expires_at from public.jobs where id = '94000000-0000-0000-0000-000000000001')
    > transaction_timestamp() + interval '300 seconds',
  'claim_trip_job measures the expiry from clock_timestamp(), not the transaction start'
);

select ok(
  not public.claim_trip_job('94000000-0000-0000-0000-000000000001',
                            '96000000-0000-0000-0000-00000000000b', 300),
  'a second claim on a running job loses the CAS'
);

select is(
  (select lease_token from public.jobs where id = '94000000-0000-0000-0000-000000000001'),
  '96000000-0000-0000-0000-00000000000a'::uuid,
  'the loser did not overwrite the winner''s token'
);

-- `retryable` is claimable too: it is the state a reclaim leaves behind, so a job that is not
-- re-claimable from it is a job the reaper requeued and nothing can ever pick up.
select ok(
  public.claim_trip_job('94000000-0000-0000-0000-000000000002',
                        '96000000-0000-0000-0000-00000000000c', 300),
  'claim_trip_job claims a retryable job'
);

select ok(
  (select started_at from public.jobs where id = '94000000-0000-0000-0000-000000000002')
    is not null,
  'claim_trip_job stamps started_at'
);

-- --- trip renewal ------------------------------------------------------------------------------

select ok(
  not public.renew_trip_job_lease('94000000-0000-0000-0000-000000000001',
                                  '96000000-0000-0000-0000-0000000000ff', 300),
  'a renewal with a superseded token matches nothing'
);

select ok(
  public.renew_trip_job_lease('94000000-0000-0000-0000-000000000001',
                              '96000000-0000-0000-0000-00000000000a', 600),
  'the lease holder renews'
);

-- *** clock_timestamp() NOT now() ***
-- The renewal is where the distinction bites hardest: with `now()` a renewal that waited on a
-- row lock would extend from before the wait, silently shortening the lease.
select ok(
  (select lock_expires_at from public.jobs where id = '94000000-0000-0000-0000-000000000001')
    > transaction_timestamp() + interval '600 seconds',
  'renew_trip_job_lease measures the new expiry from clock_timestamp(), not the transaction start'
);

update public.jobs set status = 'retryable'
 where id = '94000000-0000-0000-0000-000000000001';
select ok(
  not public.renew_trip_job_lease('94000000-0000-0000-0000-000000000001',
                                  '96000000-0000-0000-0000-00000000000a', 300),
  'a job already reclaimed to retryable is not renewable by the run that lost it'
);
update public.jobs set status = 'running'
 where id = '94000000-0000-0000-0000-000000000001';

-- --- trip reclaim ------------------------------------------------------------------------------

select is(
  public.reclaim_expired_trip_jobs(300), 0,
  'a live lease is not reclaimed'
);

-- *** clock_timestamp() NOT now() ***
-- The expiry is one second past this transaction's start, and more than two seconds have
-- elapsed since. Under `now()` the predicate reads `txn_start + 1s < txn_start`, which is
-- false forever: a lease that expires while a sweep's transaction is open would never be
-- reclaimed by it.
update public.jobs
   set lock_expires_at = transaction_timestamp() + interval '1 second'
 where id = '94000000-0000-0000-0000-000000000001';
select is(
  public.reclaim_expired_trip_jobs(300), 1,
  'reclaim compares against clock_timestamp(), so a lease expired mid-transaction is taken'
);

select is(
  (select (status, lease_token, lock_expires_at, locked_at)::text from public.jobs
    where id = '94000000-0000-0000-0000-000000000001'),
  ('retryable', null::uuid, null::timestamptz, null::timestamptz)::text,
  'the reclaim requeues the job and clears every lease field'
);

-- The legacy-NULL branch. Rows claimed by a container running the pre-lease code carry
-- `lock_expires_at IS NULL`, and `NULL < clock_timestamp()` is NULL — an expiry-only predicate
-- would skip them forever, which is the guardrail-#12 silent drop.
update public.jobs
   set status = 'running', lease_token = '96000000-0000-0000-0000-00000000000d',
       lock_expires_at = null, locked_at = clock_timestamp() - interval '20 minutes'
 where id = '94000000-0000-0000-0000-000000000001';
select is(
  public.reclaim_expired_trip_jobs(300), 1,
  'a legacy row with no expiry and a locked_at past the TTL is reclaimed'
);

update public.jobs
   set status = 'running', lease_token = '96000000-0000-0000-0000-00000000000e',
       lock_expires_at = null, locked_at = clock_timestamp() - interval '1 minute'
 where id = '94000000-0000-0000-0000-000000000001';
select is(
  public.reclaim_expired_trip_jobs(300), 0,
  'a legacy row still inside the TTL is left alone'
);

-- The `is null` conjunct on the legacy branch, which is what stops the reaper stealing a lease
-- from a job that has simply been running longer than one TTL while its heartbeat renews.
update public.jobs
   set status = 'running', lease_token = '96000000-0000-0000-0000-00000000000f',
       lock_expires_at = clock_timestamp() + interval '4 minutes',
       locked_at = clock_timestamp() - interval '20 minutes'
 where id = '94000000-0000-0000-0000-000000000001';
select is(
  public.reclaim_expired_trip_jobs(300), 0,
  'a long-running job with a renewed expiry is not reclaimed on its stale locked_at'
);

-- --- boundary validation -------------------------------------------------------------------------
--
-- Not defensive noise: a claim with no token writes a row nothing can later fence on, and a
-- non-positive TTL mints a lease that is expired the instant it is written. Both fail toward
-- two live workers, which is the failure the whole mechanism exists to prevent.

select throws_ok(
  $$ select public.claim_trip_job('94000000-0000-0000-0000-000000000002', null, 300) $$,
  'AS400', 'Trip job claim requires a lease token',
  'a claim with no lease token is rejected'
);
select throws_ok(
  $$ select public.claim_trip_job('94000000-0000-0000-0000-000000000002',
                                  '96000000-0000-0000-0000-000000000010', 0) $$,
  'AS400', 'Trip job lease TTL must be positive',
  'a zero TTL is rejected rather than minting an already-expired lease'
);
select throws_ok(
  $$ select public.renew_trip_job_lease('94000000-0000-0000-0000-000000000002', null, 300) $$,
  'AS400', 'Trip lease renewal requires a lease token',
  'a renewal with no lease token is rejected'
);
select throws_ok(
  $$ select public.reclaim_expired_organize_jobs(-1, 'Requeued after restart') $$,
  'AS400', 'Organize job lease TTL must be positive',
  'a negative TTL is rejected by the organize reclaim'
);

-- --- organize claim ------------------------------------------------------------------------------

select ok(
  not public.claim_organize_job('95000000-0000-0000-0000-000000000001',
                                '00000000-0000-0000-0000-000000000914',
                                '97000000-0000-0000-0000-00000000000a', 300, 'Finding places', 1),
  'the owner scope is part of the claim predicate, not a courtesy'
);

select ok(
  public.claim_organize_job('95000000-0000-0000-0000-000000000001',
                            '00000000-0000-0000-0000-000000000913',
                            '97000000-0000-0000-0000-00000000000a', 300, 'Finding places', 1),
  'the owner claims a pending organize job'
);

-- *** clock_timestamp() NOT now() ***
select ok(
  (select lock_expires_at from public.organize_jobs
    where id = '95000000-0000-0000-0000-000000000001')
    > transaction_timestamp() + interval '300 seconds',
  'claim_organize_job measures the expiry from clock_timestamp(), not the transaction start'
);

select ok(
  (select started_at from public.organize_jobs
    where id = '95000000-0000-0000-0000-000000000001') is not null,
  'a first attempt stamps started_at'
);

-- COALESCE, not overwrite. `started_at` is the run's user-visible elapsed time: re-stamping on
-- every retry makes a job stuck in a retry loop for an hour report as though it had just begun,
-- hiding the loop it is actually in.
select ok(
  public.claim_organize_job('95000000-0000-0000-0000-000000000002',
                            '00000000-0000-0000-0000-000000000913',
                            '97000000-0000-0000-0000-00000000000b', 300, 'Finding places', 2),
  'a retry claims the job whose first attempt already stamped started_at'
);
select is(
  (select started_at from public.organize_jobs
    where id = '95000000-0000-0000-0000-000000000002'),
  timestamptz '2026-07-19 00:00:00+00',
  'the retry PRESERVES the first attempt''s started_at'
);
select is(
  (select attempt_count from public.organize_jobs
    where id = '95000000-0000-0000-0000-000000000002'), 2,
  'the retry records its attempt number'
);

-- --- organize renewal and reclaim ------------------------------------------------------------------

select ok(
  not public.renew_organize_job_lease('95000000-0000-0000-0000-000000000001',
                                      '00000000-0000-0000-0000-000000000914',
                                      '97000000-0000-0000-0000-00000000000a', 300),
  'an organize renewal is scoped to the owner as well as the token'
);

select ok(
  public.renew_organize_job_lease('95000000-0000-0000-0000-000000000001',
                                  '00000000-0000-0000-0000-000000000913',
                                  '97000000-0000-0000-0000-00000000000a', 600),
  'the organize lease holder renews'
);

-- *** clock_timestamp() NOT now() ***
select ok(
  (select lock_expires_at from public.organize_jobs
    where id = '95000000-0000-0000-0000-000000000001')
    > transaction_timestamp() + interval '600 seconds',
  'renew_organize_job_lease measures the new expiry from clock_timestamp()'
);

select is(
  public.reclaim_expired_organize_jobs(300, 'Requeued after restart'), 0,
  'live organize leases are not reclaimed'
);

-- *** clock_timestamp() NOT now() *** — organize side of the mid-transaction expiry.
update public.organize_jobs
   set lock_expires_at = transaction_timestamp() + interval '1 second'
 where id = '95000000-0000-0000-0000-000000000001';
select is(
  public.reclaim_expired_organize_jobs(300, 'Requeued after restart'), 1,
  'the organize reclaim compares against clock_timestamp() too'
);

select is(
  (select (status, status_message, lease_token, lock_expires_at, locked_at)::text
     from public.organize_jobs where id = '95000000-0000-0000-0000-000000000001'),
  ('pending', 'Requeued after restart', null::uuid,
   null::timestamptz, null::timestamptz)::text,
  'the organize reclaim requeues with the caller''s message and clears every lease field'
);

select * from finish();
rollback;
