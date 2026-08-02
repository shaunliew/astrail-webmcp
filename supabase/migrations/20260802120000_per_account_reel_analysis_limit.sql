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
-- APPLY THIS WITH `psql -X -1 -v ON_ERROR_STOP=1 -f <this file>`. Same instruction, and the same
-- reason, as rollback/20260802120000_down.sql — read that header too; the two files are a pair and
-- this repo's schema is applied BY HAND (.claude/docs/STACK.md), so psql is the tool that matters.
-- Without `-1`, psql runs each statement in its own autocommit transaction: a failed `alter table`
-- (the 3-second lock_timeout below firing is the realistic way) does NOT stop the file, and the
-- `create or replace function` further down then installs a body referencing a column that does not
-- exist — on the live path every website organize run goes through. `-1` makes the whole file
-- all-or-nothing, so that intermediate state cannot be reached or observed, and a lock it cannot
-- get aborts cleanly and is simply retried.
--
-- DELIBERATELY NOT an in-file `begin;`/`commit;`, which looks like the tidier fix and is worse.
-- MEASURED against this repo's CLI (v2.109.1), not assumed: `supabase db reset` already wraps each
-- migration file in one transaction — a probe migration that created a table and then divided by
-- zero left NO table behind. Add `begin; … commit;` inside the file and the `commit` ENDS the CLI's
-- transaction early: the same probe, wrapped, DID leave its table behind after the later failure.
-- So the explicit spelling would REMOVE the atomicity the CLI already provides while adding none for
-- psql, where `-1` is the switch that does the job. Statement order stays as it is either way — the
-- column before the function that reads it — as the backstop for whoever runs this without `-1`.
--
-- `alter table … add column` with a CONSTANT default performs no table rewrite, but it is NOT
-- lock-free: it still takes a brief ACCESS EXCLUSIVE lock on public.users. The timeouts below make
-- it fail fast rather than queue behind a long read while blocking every reader behind it. They are
-- RESET at the end of the file: these are session-level, not `set local`, so if the CLI applies
-- several migrations over one session they would otherwise leak into whatever runs next and fail a
-- legitimately slower operation for a reason living in a different file. `reset` rather than
-- `set local` deliberately — `set local` would rest on an assumption about how the runner wraps
-- each migration, and this guard should not.

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

-- PRECAUTIONARY, NOT REQUIRED. The signature does not change, so PostgREST's schema cache stays
-- valid across this migration and this line is a no-op in effect. It is also the FIRST migration in
-- this repo to use it — `grep -rln "notify pgrst" supabase/migrations/` returns nothing else — so do
-- not read it as either an existing house convention or as evidence that a signature changed.
notify pgrst, 'reload schema';

-- Hand the session back as we found it. See the header: session-level `set` leaks to whatever the
-- CLI applies next, and this file sorting last today is a property of the directory listing, not of
-- the code.
reset lock_timeout;
reset statement_timeout;
