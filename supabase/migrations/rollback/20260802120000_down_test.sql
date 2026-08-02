-- Proves `20260802120000_down.sql` genuinely puts the hardcoded `< 5` cap back, without
-- disturbing the live organize path it shares with every website user.
--
-- NOT RUN BY `supabase test db`, and it cannot be. That harness mounts ONLY `supabase/tests` into
-- its pg_prove container, so a test living there resolves `\ir ../migrations/...` to a path that
-- does not exist inside the container. Copying the rollback's SQL into a mounted test would test
-- the copy — the exact failure mode where a divergent script ships green (BUILD-LOOP.md). So this
-- runs from the HOST, where both paths are real, against the same local DB:
--
--   supabase db reset && \
--   PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
--     -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -f supabase/migrations/rollback/20260802120000_down_test.sql
--
-- `finish(true)` raises on any failed assertion, so ON_ERROR_STOP makes the exit code the gate.
-- Everything runs inside one transaction that ROLLS BACK, so it neither leaves the rollback
-- applied nor disturbs the pgTAP suite — it is re-runnable and order-independent.
--
-- Run it as step 0, before the forward migration ships.

begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-0000000017a1', 'rollback-raised@example.com'),
  ('00000000-0000-0000-0000-0000000017b1', 'rollback-under-cap@example.com'),
  ('00000000-0000-0000-0000-0000000017c1', 'rollback-at-cap@example.com');

insert into public.organize_jobs (id, user_id, idempotency_key, status)
values
  ('85000000-0000-0000-0000-0000000017a1', '00000000-0000-0000-0000-0000000017a1', 'rollback-raised', 'processing'),
  ('85000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017b1', 'rollback-under-cap', 'processing'),
  ('85000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017c1', 'rollback-at-cap', 'processing');

insert into public.saved_reels (id, user_id, normalized_url)
values
  ('86000000-0000-0000-0000-0000000017a1', '00000000-0000-0000-0000-0000000017a1', 'https://www.instagram.com/reel/ROLLBACK-RAISED-1'),
  ('86000000-0000-0000-0000-0000000017a2', '00000000-0000-0000-0000-0000000017a1', 'https://www.instagram.com/reel/ROLLBACK-RAISED-2'),
  ('86000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017b1', 'https://www.instagram.com/reel/ROLLBACK-UNDER-CAP'),
  ('86000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017c1', 'https://www.instagram.com/reel/ROLLBACK-AT-CAP');

insert into public.organize_job_items (id, user_id, job_id, saved_reel_id)
values
  ('87000000-0000-0000-0000-0000000017a1', '00000000-0000-0000-0000-0000000017a1', '85000000-0000-0000-0000-0000000017a1', '86000000-0000-0000-0000-0000000017a1'),
  ('87000000-0000-0000-0000-0000000017a2', '00000000-0000-0000-0000-0000000017a1', '85000000-0000-0000-0000-0000000017a1', '86000000-0000-0000-0000-0000000017a2'),
  ('87000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017b1', '85000000-0000-0000-0000-0000000017b1', '86000000-0000-0000-0000-0000000017b1'),
  ('87000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017c1', '85000000-0000-0000-0000-0000000017c1', '86000000-0000-0000-0000-0000000017c1');

insert into public.user_daily_usage (user_id, usage_date, reel_analysis_count)
values
  ('00000000-0000-0000-0000-0000000017a1', current_date, 5),
  ('00000000-0000-0000-0000-0000000017b1', current_date, 4),
  ('00000000-0000-0000-0000-0000000017c1', current_date, 5);

-- --- the forward state is real, and the fixture actually reaches it -----------------------------
--
-- Both halves matter. If account A were already refused for some unrelated reason, the
-- post-rollback "refused" assertions would pass against a rollback that changed nothing — a
-- fixture whose natural state already satisfies the assertion. Granting A a 6th reservation HERE
-- is what rules that out: the same seed is granted before and refused after, so the rollback is
-- doing the work and nothing else.

select has_column('public', 'users', 'daily_reel_analysis_limit',
  'forward: the migration under rollback is actually applied');

update public.users set daily_reel_analysis_limit = 7 where id = '00000000-0000-0000-0000-0000000017a1';
select is(
  public.reserve_organize_item_analysis('87000000-0000-0000-0000-0000000017a1', '00000000-0000-0000-0000-0000000017a1'),
  current_date,
  'forward: a raised account is granted a 6th reservation the old cap would refuse'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-0000000017a1' and usage_date = current_date),
  6,
  'forward: that 6th reservation really charged, so the account now sits above the old cap'
);

-- --- apply the real rollback script, in this transaction ----------------------------------------

\ir 20260802120000_down.sql

-- --- the column and its constraint are gone ------------------------------------------------------
--
-- Also the proof the include EXECUTED. Without these, a mistyped path or a silently skipped file
-- would leave the forward schema in place and every assertion below would be re-testing the
-- forward migration — green, and proving nothing about the rollback at all.

select hasnt_column('public', 'users', 'daily_reel_analysis_limit',
  'rollback dropped the per-account limit column');
select ok(
  not exists (
    select 1 from pg_constraint
     where conrelid = 'public.users'::regclass
       and conname = 'users_daily_reel_analysis_limit_range'
  ),
  'rollback dropped the limit range constraint'
);

-- --- the hardcoded 5 is genuinely back -----------------------------------------------------------

select is(
  public.reserve_organize_item_analysis('87000000-0000-0000-0000-0000000017a2', '00000000-0000-0000-0000-0000000017a1'),
  null,
  'rollback: the previously-raised account is refused again — the raise is gone, not merely hidden'
);
select is(
  public.reserve_organize_item_analysis('87000000-0000-0000-0000-0000000017b1', '00000000-0000-0000-0000-0000000017b1'),
  current_date,
  'rollback: an account under the cap still gets its 5th reservation — not refused into uselessness'
);
select is(
  public.reserve_organize_item_analysis('87000000-0000-0000-0000-0000000017c1', '00000000-0000-0000-0000-0000000017c1'),
  null,
  'rollback: an account at 5 is refused its 6th — the hardcoded cap is back'
);

-- --- the function survives intact ----------------------------------------------------------------
--
-- The rollback restores the body with `create or replace`, so the signature and the privileges
-- must come through untouched. A rollback that opened a PGRST202 window, or handed the RPC to a
-- browser role on the way out, would be a worse outage than the thing it aborts away from.

select ok(
  to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)') is not null,
  'rollback: the 2-arg reservation RPC PostgREST resolves is still there'
);
select is(
  (select count(*)::integer
     from pg_proc
     join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'public'
      and pg_proc.proname = 'reserve_organize_item_analysis'),
  1,
  'rollback: still exactly one reserve_organize_item_analysis — no overload left behind'
);
select ok(
  (select prosecdef from pg_proc where oid = to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)')),
  'rollback: the reservation RPC is still security definer'
);
select ok(
  (select proconfig from pg_proc where oid = to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)'))
    @> array['search_path=""'],
  'rollback: the reservation RPC still pins an empty search_path'
);
select ok(
  not has_function_privilege('authenticated', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'rollback: authenticated still cannot reserve an organize item analysis'
);
select ok(
  not has_function_privilege('anon', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'rollback: anon still cannot reserve an organize item analysis'
);
select ok(
  has_function_privilege('service_role', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'rollback: service role can still reserve an organize item analysis'
);

select * from finish(true);

rollback;
