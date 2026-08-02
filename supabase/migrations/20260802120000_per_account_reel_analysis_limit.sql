-- Per-account daily Reel-analysis limit.
--
-- `reserve_organize_item_analysis` hardcoded a daily cap of `< 5`. The Telegram ingest bot runs
-- under ONE shared ingest service account, so every Telegram user's Reels would collectively hit
-- 5/day. Making the cap a per-account column lets the ingest account be raised while every human
-- user stays at 5.
--
-- A COLUMN, NOT A THIRD PARAMETER. PostgREST resolves an RPC by its named argument set, and
-- `create or replace function` cannot change an argument list — a 3-arg version is a new
-- *overload*, so PostgREST would report "function is not unique" and the only fix would be to DROP
-- the 2-arg function first. That opens a PGRST202 window on the live organize path every website
-- user's organize run goes through. It is also wrong on the merits: the limit must follow the
-- ACCOUNT, not the call, because the web reaper may run an ingest job.
--
-- So the signature is UNCHANGED and `create or replace` is sufficient — no drop, no window. The
-- body below is byte-identical to 20260719101000_saved_reels_exactly_once_quota.sql:38-101 except
-- for the one `where usage.reel_analysis_count < …` predicate.
--
-- `alter table … add column` with a CONSTANT default performs no table rewrite, but it is NOT
-- lock-free: it still takes a brief ACCESS EXCLUSIVE lock on public.users. The timeouts below make
-- it fail fast rather than queue behind a long read while blocking every reader behind it.

set lock_timeout = '3s';
set statement_timeout = '30s';

-- `20260701131304` grants select on public.users to authenticated, so a user can read their own
-- limit. Harmless — stated here so it is not later discovered as a surprise.
alter table public.users
  add column daily_reel_analysis_limit integer not null default 5,
  add constraint users_daily_reel_analysis_limit_range
    check (daily_reel_analysis_limit between 1 and 10000);

-- The body is transcribed verbatim; the `where usage.reel_analysis_count < …` predicate is the
-- ONLY changed line, and no comment is added inside the body so that a diff of the two definitions
-- stays a one-line diff. The `coalesce(…, 5)` in it is load-bearing: without the fallback a
-- p_user_id with no public.users row would make the subquery null, the comparison null, the
-- `where` false, and the item would fail mid-job with a misleading "quota reached". The fallback
-- preserves today's behaviour exactly for that case. A single `coalesce` also beats a
-- `select into` + `if not found`, which would need three more statements to say the same thing.
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
  where usage.reel_analysis_count
        < coalesce((select u.daily_reel_analysis_limit
                      from public.users u where u.id = p_user_id), 5)
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

-- `create or replace` preserves the existing privileges, so these two are re-assertions rather
-- than changes. Stating them in the same migration is what stops a future edit silently dropping
-- one — and 016_per_account_reel_analysis_limit.sql asserts all four halves of the contract
-- (`security definer`, `search_path = ''`, the revoke, the grant).
revoke all on function public.reserve_organize_item_analysis(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reserve_organize_item_analysis(uuid, uuid) to service_role;

-- PRECAUTIONARY, NOT REQUIRED: the signature does not change, so PostgREST's schema cache stays
-- valid across this migration. Do not read this line as evidence that a signature changed.
notify pgrst, 'reload schema';
