begin;

create extension if not exists pgtap with schema extensions;

select plan(85);

-- The entitlement arc rests on two atomic RPCs. This file proves, single-session and
-- deterministically, that:
--   * reserve_and_enqueue_trip_job charges exactly once (trial=lifetime, beta=daily), replays an
--     ACTIVE key without recharging, refuses at the limit, rolls its reservation back on any
--     non-unique error, and is service-role-only;
--   * complete_trip_run refunds exactly once behind the lease CAS (keyed on the STORED charge
--     metadata), is all-or-nothing, ignores a wrong lease / wrong trip, leaves a success charge
--     intact, and is service-role-only.
-- Every expected value is one only the guard under test can produce, so reverting any single guard
-- reddens at least one assertion.

-- ── Seed: accounts ────────────────────────────────────────────────────────────────────────────
-- Inserting into auth.users fires sync_auth_user_to_public_user, which creates the public.users
-- row (plan defaults 'trial', lifetime_trip_count 0). We then set the tiers/counters we need.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001701', 'trial-created@example.com'),
  ('00000000-0000-0000-0000-000000001702', 'beta-daily@example.com'),
  ('00000000-0000-0000-0000-000000001703', 'crun-fail@example.com'),
  ('00000000-0000-0000-0000-000000001704', 'crun-wrong-lease@example.com'),
  ('00000000-0000-0000-0000-000000001705', 'crun-wrong-trip@example.com'),
  ('00000000-0000-0000-0000-000000001706', 'crun-event-fail@example.com'),
  ('00000000-0000-0000-0000-000000001707', 'crun-daily@example.com'),
  ('00000000-0000-0000-0000-000000001708', 'crun-success@example.com'),
  ('00000000-0000-0000-0000-000000001709', 'crun-prearc@example.com'),
  ('00000000-0000-0000-0000-00000000170a', 'reserve-fault@example.com');

-- Beta tiers.
update public.users set plan = 'beta'
 where id in ('00000000-0000-0000-0000-000000001702', '00000000-0000-0000-0000-000000001707');

-- Trial accounts that already carry one charged (still-running) job → lifetime_trip_count = 1, so a
-- refund is observable as 1 → 0.
update public.users set lifetime_trip_count = 1
 where id in ('00000000-0000-0000-0000-000000001703', '00000000-0000-0000-0000-000000001704',
              '00000000-0000-0000-0000-000000001705', '00000000-0000-0000-0000-000000001706',
              '00000000-0000-0000-0000-000000001708', '00000000-0000-0000-0000-000000001709');

-- CD's daily ledger: the STORED charge is YESTERDAY (count 1); today already sits at 5 and must be
-- left alone by a refund keyed on the stored date.
insert into public.user_daily_usage (user_id, usage_date, generated_trip_count) values
  ('00000000-0000-0000-0000-000000001707', current_date - 1, 1),
  ('00000000-0000-0000-0000-000000001707', current_date, 5);

-- ── Seed: trips + running jobs for the complete_trip_run cases ─────────────────────────────────
insert into public.trips (id, user_id, status) values
  ('a3000000-0000-0000-0000-000000001703', '00000000-0000-0000-0000-000000001703', 'generating'),
  ('a3000000-0000-0000-0000-000000001704', '00000000-0000-0000-0000-000000001704', 'generating'),
  ('a3000000-0000-0000-0000-000000001705', '00000000-0000-0000-0000-000000001705', 'generating'),
  ('a4000000-0000-0000-0000-000000001705', '00000000-0000-0000-0000-000000001705', 'generating'),
  ('a3000000-0000-0000-0000-000000001706', '00000000-0000-0000-0000-000000001706', 'generating'),
  ('a3000000-0000-0000-0000-000000001707', '00000000-0000-0000-0000-000000001707', 'generating'),
  ('a3000000-0000-0000-0000-000000001708', '00000000-0000-0000-0000-000000001708', 'generating'),
  ('a3000000-0000-0000-0000-000000001709', '00000000-0000-0000-0000-000000001709', 'generating');

insert into public.jobs
  (id, trip_id, user_id, idempotency_key, status, lease_token, charge_kind, charge_date) values
  ('b3000000-0000-0000-0000-000000001703', 'a3000000-0000-0000-0000-000000001703',
   '00000000-0000-0000-0000-000000001703', 'ctrun-fail', 'running',
   'c3000000-0000-0000-0000-000000001703', 'lifetime', current_date),
  ('b3000000-0000-0000-0000-000000001704', 'a3000000-0000-0000-0000-000000001704',
   '00000000-0000-0000-0000-000000001704', 'ctrun-wrong-lease', 'running',
   'c3000000-0000-0000-0000-000000001704', 'lifetime', current_date),
  ('b3000000-0000-0000-0000-000000001705', 'a3000000-0000-0000-0000-000000001705',
   '00000000-0000-0000-0000-000000001705', 'ctrun-wrong-trip', 'running',
   'c3000000-0000-0000-0000-000000001705', 'lifetime', current_date),
  ('b3000000-0000-0000-0000-000000001706', 'a3000000-0000-0000-0000-000000001706',
   '00000000-0000-0000-0000-000000001706', 'ctrun-event-fail', 'running',
   'c3000000-0000-0000-0000-000000001706', 'lifetime', current_date),
  ('b3000000-0000-0000-0000-000000001707', 'a3000000-0000-0000-0000-000000001707',
   '00000000-0000-0000-0000-000000001707', 'ctrun-daily', 'running',
   'c3000000-0000-0000-0000-000000001707', 'daily', current_date - 1),
  ('b3000000-0000-0000-0000-000000001708', 'a3000000-0000-0000-0000-000000001708',
   '00000000-0000-0000-0000-000000001708', 'ctrun-success', 'running',
   'c3000000-0000-0000-0000-000000001708', 'lifetime', current_date),
  ('b3000000-0000-0000-0000-000000001709', 'a3000000-0000-0000-0000-000000001709',
   '00000000-0000-0000-0000-000000001709', 'ctrun-prearc', 'running',
   'c3000000-0000-0000-0000-000000001709', null, null);   -- pre-arc: no charge metadata

-- ── Migration structure probes ────────────────────────────────────────────────────────────────
-- The old GLOBAL unique must be gone (else a refunded attempt could never free its key).
select ok(
  not exists (select 1 from pg_constraint where conname = 'jobs_idempotency_key_unique'),
  'the old global unique constraint jobs_idempotency_key_unique is dropped'
);
select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'jobs_idempotency_key_active_uidx'),
  'the partial unique index jobs_idempotency_key_active_uidx exists'
);
-- The predicate is EXACTLY charge_refunded_at IS NULL — a refunded row must be invisible to the
-- unique guard so its key can be reused. RED if the predicate is dropped or inverted.
select is(
  (select regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[()]', '', 'g')
     from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname = 'jobs_idempotency_key_active_uidx'),
  'charge_refunded_at IS NULL',
  'the partial index predicate is exactly charge_refunded_at IS NULL'
);
select throws_ok(
  $$update public.users set plan = 'enterprise' where id = '00000000-0000-0000-0000-000000001708'$$,
  '23514', null,
  'users_plan_check rejects a plan outside (trial, beta)'
);
select throws_ok(
  $$update public.users set lifetime_trip_count = -1 where id = '00000000-0000-0000-0000-000000001708'$$,
  '23514', null,
  'users_lifetime_trip_count_nonnegative rejects a negative count'
);
select throws_ok(
  $$update public.jobs set charge_kind = 'weekly' where id = 'b3000000-0000-0000-0000-000000001708'$$,
  '23514', null,
  'jobs_charge_kind_check rejects a charge_kind outside (lifetime, daily)'
);

-- ══ reserve_and_enqueue_trip_job ══════════════════════════════════════════════════════════════

-- Trial user, first request → created; the WHOLE ledger lands in one txn.
create temporary table ra1 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001701', 'trial-key-A',
    'Tokyo', '2026-09-01', '2026-09-05', 'mid_range', 'SFO',
    'loves ramen', '[]'::jsonb, '{"reel_urls": ["r1"]}'::jsonb, 1, 5);
select is((select outcome from ra1), 'created', 'trial first request → created');
select ok((select trip_id from ra1) is not null, 'created returns a trip_id');
select ok((select job_id from ra1) is not null, 'created returns a job_id');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001701'),
  1, 'the trial lifetime counter is charged exactly once');
select is((select charge_kind from public.jobs where id = (select job_id from ra1)),
          'lifetime', 'the charged job records charge_kind = lifetime');
select is((select charge_date from public.jobs where id = (select job_id from ra1)),
          current_date, 'the charge_date is recorded as today, in the reservation txn');
select is((select status from public.jobs where id = (select job_id from ra1)),
          'pending', 'the charged job is pending (recovery can re-dispatch it)');
select is((select status from public.trips where id = (select trip_id from ra1)),
          'generating', 'the trip is created as generating');
select is(
  (select count(*)::int from public.generation_events
    where trip_id = (select trip_id from ra1)
      and event_type = 'stage' and stage = 'create_trip' and message = 'Starting your trip'),
  1, 'the create_trip event exists (recovery''s only input source)');

-- Second call, SAME key → replay: the active job is returned, nothing is charged, no job is made.
create temporary table ra2 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001701', 'trial-key-A',
    'Tokyo', '2026-09-01', '2026-09-05', 'mid_range', 'SFO',
    'loves ramen', '[]'::jsonb, '{"reel_urls": ["r1"]}'::jsonb, 1, 5);
select is((select outcome from ra2), 'replay', 'same-key second call → replay');
select is((select trip_id from ra2), (select trip_id from ra1), 'replay returns the original trip');
select ok((select job_id from ra2) is null, 'replay creates no new job');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001701'),
  1, 'replay charges nothing (counter stays 1)');
select is(
  (select count(*)::int from public.jobs where user_id = '00000000-0000-0000-0000-000000001701'),
  1, 'replay writes no new job row');

-- Second call, DIFFERENT key, already at limit 1 → trial_exhausted; no side effects.
create temporary table ra3 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001701', 'trial-key-B',
    'Osaka', '2026-10-01', '2026-10-05', 'mid_range', 'SFO',
    'loves ramen', '[]'::jsonb, '{}'::jsonb, 1, 5);
select is((select outcome from ra3), 'trial_exhausted', 'different key at limit 1 → trial_exhausted');
select ok((select trip_id from ra3) is null, 'trial_exhausted returns no trip');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001701'),
  1, 'trial_exhausted charges nothing (counter stays 1)');
select is(
  (select count(*)::int from public.jobs where user_id = '00000000-0000-0000-0000-000000001701'),
  1, 'trial_exhausted writes no job');
select is(
  (select count(*)::int from public.trips where user_id = '00000000-0000-0000-0000-000000001701'),
  1, 'trial_exhausted writes no trip');

-- Beta user rides the daily quota: increments each generation, then stops AT p_daily_limit.
create temporary table rb1 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001702', 'beta-key-1',
    'Bali', '2026-09-01', '2026-09-05', 'premium', 'SIN',
    'surf', '[]'::jsonb, '{}'::jsonb, 1, 2);
select is((select outcome from rb1), 'created', 'beta 1st generation → created (daily charge)');
select is(
  (select generated_trip_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001702' and usage_date = current_date),
  1, 'beta daily count is 1 after the first generation');
-- Assert the ledger ON the job rb1 actually created (not just the daily counter): complete_trip_run's
-- refund branch reads charge_kind/charge_date OFF this row, so a swapped beta branch must redden here.
select is((select charge_kind from public.jobs where id = (select job_id from rb1)),
          'daily', 'the charged job records charge_kind = daily');
select is((select charge_date from public.jobs where id = (select job_id from rb1)),
          current_date, 'the beta charge_date is recorded as today, in the reservation txn');
create temporary table rb2 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001702', 'beta-key-2',
    'Bali', '2026-09-10', '2026-09-14', 'premium', 'SIN',
    'surf', '[]'::jsonb, '{}'::jsonb, 1, 2);
select is((select outcome from rb2), 'created', 'beta 2nd generation → created');
select is(
  (select generated_trip_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001702' and usage_date = current_date),
  2, 'beta daily count is 2 after the second generation');
create temporary table rb3 as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-000000001702', 'beta-key-3',
    'Bali', '2026-09-20', '2026-09-24', 'premium', 'SIN',
    'surf', '[]'::jsonb, '{}'::jsonb, 1, 2);
select is((select outcome from rb3), 'daily_exhausted', 'beta stops AT the daily limit');
select ok((select trip_id from rb3) is null, 'daily_exhausted returns no trip');
select is(
  (select generated_trip_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001702' and usage_date = current_date),
  2, 'daily_exhausted charges nothing (count stays at the cap of 2)');

-- No public.users row → identity_unavailable (never a silent default, never trial_exhausted).
create temporary table rmu as
  select * from public.reserve_and_enqueue_trip_job(
    '00000000-0000-0000-0000-0000000017ff', 'ghost-key',
    'Nowhere', '2026-09-01', '2026-09-05', 'mid_range', 'SFO',
    's', '[]'::jsonb, '{}'::jsonb, 1, 5);
select is((select outcome from rmu), 'identity_unavailable', 'missing users row → identity_unavailable');
select ok((select trip_id from rmu) is null, 'identity_unavailable returns no trip');

-- Fault: a NON-unique error inside the savepoint block (bogus budget → trips_budget_level_check)
-- must NOT be swallowed as a replay — it re-raises, and the outer abort unwinds the reservation.
select throws_ok(
  $$select public.reserve_and_enqueue_trip_job(
      '00000000-0000-0000-0000-00000000170a', 'fault-key',
      'Bogusville', '2026-09-01', '2026-09-05', 'bogus', 'SFO',
      's', '[]'::jsonb, '{}'::jsonb, 1, 5)$$,
  '23514', null,
  'a non-unique constraint violation aborts the whole call (not misread as replay)');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-00000000170a'),
  0, 'the aborted reservation is rolled back (lifetime counter stays 0)');
select is(
  (select count(*)::int from public.trips where user_id = '00000000-0000-0000-0000-00000000170a'),
  0, 'the aborted call leaves no trip');
select is(
  (select count(*)::int from public.jobs where user_id = '00000000-0000-0000-0000-00000000170a'),
  0, 'the aborted call leaves no job');

-- Privilege contract: service-role only.
select ok(not has_function_privilege('authenticated',
  'public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)',
  'EXECUTE'), 'authenticated cannot execute reserve_and_enqueue_trip_job');
select ok(not has_function_privilege('anon',
  'public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)',
  'EXECUTE'), 'anon cannot execute reserve_and_enqueue_trip_job');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
     where p.oid = 'public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute reserve_and_enqueue_trip_job');
select ok(has_function_privilege('service_role',
  'public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)',
  'EXECUTE'), 'service_role can execute reserve_and_enqueue_trip_job');

-- ══ complete_trip_run ═════════════════════════════════════════════════════════════════════════

-- Trial failure: right lease + running → refund exactly once, fully fenced.
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001703', 'a3000000-0000-0000-0000-000000001703',
    'c3000000-0000-0000-0000-000000001703', 'failed', 'summarize', 'Astrail couldn''t finish this trip',
    '{"error": "boom"}'::jsonb),
  true, 'the CAS winner returns true');
select is((select status from public.jobs where id = 'b3000000-0000-0000-0000-000000001703'),
          'failed', 'the job is marked failed');
select ok((select charge_refunded_at from public.jobs where id = 'b3000000-0000-0000-0000-000000001703')
          is not null, 'charge_refunded_at is stamped (frees the key)');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001703'),
          'failed', 'the trip is marked failed');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001703'),
  0, 'the lifetime charge is refunded exactly once (1 → 0)');
select is(
  (select count(*)::int from public.generation_events
    where trip_id = 'a3000000-0000-0000-0000-000000001703' and event_type = 'result'),
  1, 'a terminal result event is written (terminates the SSE stream)');

-- Second call on the now-failed job → CAS finds no running row → false, no second refund.
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001703', 'a3000000-0000-0000-0000-000000001703',
    'c3000000-0000-0000-0000-000000001703', 'failed', 'summarize', 'again', '{}'::jsonb),
  false, 'a second terminal call finds no running row → false');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001703'),
  0, 'exactly-once: the counter is not refunded a second time');

-- Wrong lease → false, and NOTHING is written (no refund, no trips clobber, no event).
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001704', 'a3000000-0000-0000-0000-000000001704',
    'cfffffff-0000-0000-0000-000000001704', 'failed', 'summarize', 'msg', '{}'::jsonb),
  false, 'a wrong lease → false');
select is((select status from public.jobs where id = 'b3000000-0000-0000-0000-000000001704'),
          'running', 'wrong lease: the job stays running');
select ok((select charge_refunded_at from public.jobs where id = 'b3000000-0000-0000-0000-000000001704')
          is null, 'wrong lease: no refund is stamped');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001704'),
          'generating', 'wrong lease: the trip is not clobbered');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001704'),
  1, 'wrong lease: the counter is untouched');
select is(
  (select count(*)::int from public.generation_events where trip_id = 'a3000000-0000-0000-0000-000000001704'),
  0, 'wrong lease: no event is written (the fence precedes the event insert)');

-- Wrong p_trip_id (Fix 6): the CAS predicate trip_id = p_trip_id fails → false; the OTHER trip and
-- the job''s own trip are both untouched, and no refund happens.
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001705', 'a4000000-0000-0000-0000-000000001705',
    'c3000000-0000-0000-0000-000000001705', 'failed', 'summarize', 'msg', '{}'::jsonb),
  false, 'a mismatched p_trip_id → CAS false (mismatch surfaced, not silently swallowed)');
select is((select status from public.jobs where id = 'b3000000-0000-0000-0000-000000001705'),
          'running', 'wrong trip: the job stays running');
select is((select status from public.trips where id = 'a4000000-0000-0000-0000-000000001705'),
          'generating', 'wrong trip: the OTHER trip is not clobbered');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001705'),
          'generating', 'wrong trip: the job''s own trip is not touched either');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001705'),
  1, 'wrong trip: no refund');

-- Result-event failure (bad stage → generation_events_stage_check) rolls back the WHOLE txn:
-- all-or-nothing, so the CAS write + refund + charge_refunded_at all revert.
select throws_ok(
  $$select public.complete_trip_run('b3000000-0000-0000-0000-000000001706', 'a3000000-0000-0000-0000-000000001706',
      'c3000000-0000-0000-0000-000000001706', 'failed', 'not_a_valid_stage', 'msg', '{}'::jsonb)$$,
  '23514', null,
  'a bad terminal stage aborts the whole complete_trip_run txn');
select is((select status from public.jobs where id = 'b3000000-0000-0000-0000-000000001706'),
          'running', 'result-event failure: the job stays running (all-or-nothing)');
select ok((select charge_refunded_at from public.jobs where id = 'b3000000-0000-0000-0000-000000001706')
          is null, 'result-event failure: charge_refunded_at stays NULL');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001706'),
  1, 'result-event failure: the counter is NOT decremented');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001706'),
          'generating', 'result-event failure: the trip status is not changed');

-- Daily refund targets the STORED charge_date: a yesterday-dated charge fails today → yesterday''s
-- row is decremented, today''s row is left alone (kills midnight drift).
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001707', 'a3000000-0000-0000-0000-000000001707',
    'c3000000-0000-0000-0000-000000001707', 'failed', 'summarize', 'msg', '{}'::jsonb),
  true, 'a daily charge failure refunds');
select is(
  (select generated_trip_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001707' and usage_date = current_date - 1),
  0, 'the STORED (yesterday) charge_date row is decremented 1 → 0');
select is(
  (select generated_trip_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001707' and usage_date = current_date),
  5, 'today''s row is NOT touched (refund used the stored date, not current_date)');

-- Success path: leaves the charge intact and does NOT touch trips.status.
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001708', 'a3000000-0000-0000-0000-000000001708',
    'c3000000-0000-0000-0000-000000001708', 'succeeded', 'summarize', 'done', '{}'::jsonb),
  true, 'the success CAS winner returns true');
select is((select status from public.jobs where id = 'b3000000-0000-0000-0000-000000001708'),
          'succeeded', 'success: the job is marked succeeded');
select ok((select charge_refunded_at from public.jobs where id = 'b3000000-0000-0000-0000-000000001708')
          is null, 'success: no refund is stamped');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001708'),
  1, 'success: the charge is left intact');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001708'),
          'generating', 'success: complete_trip_run does NOT touch trips.status');
select is(
  (select count(*)::int from public.generation_events
    where trip_id = 'a3000000-0000-0000-0000-000000001708' and event_type = 'result'),
  1, 'success: a terminal result event is written');

-- Pre-arc job (charge_kind NULL): the failure stamps charge_refunded_at (frees the key) but
-- decrements NO counter — there was no arc charge to refund. Harmless, no error.
select is(
  public.complete_trip_run('b3000000-0000-0000-0000-000000001709', 'a3000000-0000-0000-0000-000000001709',
    'c3000000-0000-0000-0000-000000001709', 'failed', 'summarize', 'msg', '{}'::jsonb),
  true, 'a pre-arc (NULL charge) failure returns true, no error');
select ok((select charge_refunded_at from public.jobs where id = 'b3000000-0000-0000-0000-000000001709')
          is not null, 'pre-arc: charge_refunded_at is stamped so the key frees for retry');
select is(
  (select lifetime_trip_count from public.users where id = '00000000-0000-0000-0000-000000001709'),
  1, 'pre-arc: NO counter is decremented (charge_kind was NULL)');
select is((select status from public.trips where id = 'a3000000-0000-0000-0000-000000001709'),
          'failed', 'pre-arc: the trip is still marked failed');

-- Privilege contract: service-role only.
select ok(not has_function_privilege('authenticated',
  'public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)', 'EXECUTE'),
  'authenticated cannot execute complete_trip_run');
select ok(not has_function_privilege('anon',
  'public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)', 'EXECUTE'),
  'anon cannot execute complete_trip_run');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
     where p.oid = 'public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute complete_trip_run');
select ok(has_function_privilege('service_role',
  'public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)', 'EXECUTE'),
  'service_role can execute complete_trip_run');

select * from finish();

rollback;
