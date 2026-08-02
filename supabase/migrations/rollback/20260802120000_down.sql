-- Rollback for 20260802120000_per_account_reel_analysis_limit.sql.
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up
-- (it globs timestamped files at the top level of supabase/migrations only) — it is the escape
-- hatch, applied by hand with psql, and it exists before the deploy rather than being written
-- under pressure.
--
-- NO CODE COORDINATION IS NEEDED. Nothing in backend/ or frontend/ reads
-- `daily_reel_analysis_limit` — the limit lives entirely inside the SQL function body, and
-- backend/telegram_ingest/test_worker.py asserts the ingest worker never probes the column. So
-- rolling this back is a database-only step: no revert, no redeploy, no ordering against a code
-- release. Suspending the ingest worker is the separate, independent lever.
--
-- ORDER IS LOAD-BEARING. Restore the function FIRST, then drop the constraint and the column. The
-- reverse order leaves the function referencing a dropped column for the length of one statement,
-- and any concurrent organize call landing in that window errors — on the live path every website
-- user's organize run goes through. Restoring the function first means the column is unreferenced
-- before it is dropped, so the window does not exist.
--
-- THAT WINDOW ONLY EXISTS IF THIS RUNS STATEMENT-BY-STATEMENT IN AUTOCOMMIT, which is psql's
-- default. RUN IT WITH `psql -1`: Postgres DDL is transactional, so one transaction makes the
-- intermediate state invisible to every concurrent session, makes the ordering above moot, and
-- makes a failure all-or-nothing instead of half-applied — with `lock_timeout` set, a rollback that
-- cannot get its lock aborts cleanly and is simply retried. The ordering is kept anyway, as the
-- backstop for whoever runs this without `-1` at 3am.
--
-- The function below is the byte-for-byte definition from
-- 20260719101000_saved_reels_exactly_once_quota.sql:38-101, hardcoded `< 5` and all. Copied from
-- that file, not from memory. `create or replace` keeps the signature, so PostgREST's cache stays
-- valid here too — this rollback opens no PGRST202 window either.
--
-- Proven by `20260802120000_down_test.sql` beside this file — run it before the deploy.

set lock_timeout = '3s';
set statement_timeout = '30s';

create or replace function public.reserve_organize_item_analysis(
  p_item_id uuid,
  p_user_id uuid
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_usage_date date;
begin
  select analysis_charge_state, analysis_usage_date
  into v_state, v_usage_date
  from public.organize_job_items
  where id = p_item_id
    and user_id = p_user_id
  for update;

  if not found then
    return null;
  end if;

  if v_state in ('reserved', 'consumed') then
    return v_usage_date;
  end if;

  if v_state not in ('not_charged', 'refunded') then
    return null;
  end if;

  insert into public.user_daily_usage as usage (
    user_id,
    usage_date,
    reel_analysis_count
  )
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set
    reel_analysis_count = usage.reel_analysis_count + 1,
    updated_at = now()
  where usage.reel_analysis_count < 5
  returning usage_date into v_usage_date;

  if not found then
    return null;
  end if;

  update public.organize_job_items
  set analysis_charge_state = 'reserved',
      analysis_usage_date = v_usage_date,
      analysis_reserved_at = now(),
      analysis_refunded_at = null,
      analysis_consumed_at = null
  where id = p_item_id
    and user_id = p_user_id;

  return v_usage_date;
end;
$$;

revoke all on function public.reserve_organize_item_analysis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_organize_item_analysis(uuid, uuid) to service_role;

-- Only now is the column unreferenced. `if exists` on both so a partial rollback is re-runnable.
alter table public.users drop constraint if exists users_daily_reel_analysis_limit_range;
alter table public.users drop column if exists daily_reel_analysis_limit;

-- Precautionary, not required: the signature does not change here either, and as in the forward
-- migration this is the only `notify pgrst` in the repo rather than a house convention.
notify pgrst, 'reload schema';

-- Same reasoning as the forward migration: these are session-level, and this file is applied BY HAND
-- into an operator's psql session that keeps going afterwards. Hand it back as we found it.
reset lock_timeout;
reset statement_timeout;
