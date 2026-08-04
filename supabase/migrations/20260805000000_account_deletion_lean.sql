-- Lean self-serve account deletion — soft-delete state + request/cancel RPCs (Task 2).
--
-- SCHEMA-FIRST, GATED OFF. This ships the columns, the FK-free audit/work-queue log, and the two
-- security-definer RPCs that move an account into and out of a 7-day cancellable grace. NOTHING
-- here is destructive: the delete engine + sweep that acts on `pending_deletion`/`deleting` is
-- Task 3, and the request/cancel ENDPOINTS are hard-gated behind `_DELETION_EXECUTION_READY=False`
-- (main.py) until Task 6 flips them live. Deploying this migration ahead of the code is therefore a
-- no-op for the running version — nothing reads or writes these objects until the gate flips.
--
-- account_status lifecycle: 'active' → 'pending_deletion' (request, reversible for 7 days) →
-- 'deleting' (Task 3's atomic point of no return — a concurrent cancel loses here) → row gone
-- (auth.users hard-delete cascades public.users away). Cancel returns 'pending_deletion' → 'active'
-- and CLEARS the timestamps, so a later re-request computes a brand-new 7-day schedule.
--
-- PRIVILEGE PIN (Codex must-fix). Both RPCs take a p_user_id and mutate another user's row, so
-- EXECUTE is REVOKED from public/anon/authenticated and granted ONLY to service_role — the exact
-- posture of request_seat / reserve_and_enqueue_trip_job. Without it an authenticated user could
-- POST straight to PostgREST and schedule or cancel deletion for an arbitrary uuid. The backend
-- calls these with the caller's own JWT sub (self-serve only); the pin is the boundary that makes
-- that the ONLY reachable path.

-- ── State on public.users (service-role-write-only by construction) ───────────────────────────
-- `users` has only a users_select_own SELECT policy (no client UPDATE policy), so these columns
-- can be written solely by the service_role backend / the security-definer RPCs below — no
-- client-facing policy is added, deliberately.
alter table public.users
  add column account_status text not null default 'active'
    check (account_status in ('active', 'pending_deletion', 'deleting')),
  add column deletion_requested_at timestamptz,
  add column deletion_scheduled_for timestamptz;

-- ── FK-free audit + work-queue log (survives the auth.users cascade) ──────────────────────────
-- No FK to users ON PURPOSE: the final hard-delete cascades public.users away, and this row must
-- outlive it to carry the completion state + best-effort completion email. Same service-role-only
-- posture as geocode_country_cache (20260720110000).
create table public.account_deletion_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  recipient_email text,                     -- captured at request; cleared after the completion send (Task 4)
  requested_at timestamptz not null default now(),
  scheduled_for timestamptz not null,
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  purged_verified_at timestamptz,
  completed_at timestamptz,
  outcome text not null default 'pending'
    check (outcome in ('pending', 'deleting', 'completed', 'failed', 'cancelled'))
);

comment on table public.account_deletion_log is
  'FK-free audit + work-queue for self-serve account deletion; survives the auth.users hard-delete '
  'cascade. RETENTION: rows are kept ~24 months from requested_at, then purged by a hand-run/cron '
  'cleanup (no automatic TTL) — long enough to answer a "did you delete my data" dispute, short '
  'enough not to hoard a deleted user''s email indefinitely.';

alter table public.account_deletion_log enable row level security;
revoke all on public.account_deletion_log from public, anon, authenticated;
grant all on public.account_deletion_log to service_role;

-- ── request_account_deletion — enter the 7-day grace (CAS active→pending_deletion) ────────────
-- Returns the scheduled deletion time on success, or NULL when the account was not 'active'
-- (already pending/deleting, or absent) — the endpoint maps NULL to 409. The CAS makes a
-- concurrent double-request safe: only the first matches 'active'; the second returns NULL and
-- writes no log row (so there is at most one open 'pending' log row per user).
create or replace function public.request_account_deletion(p_user_id uuid)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_scheduled_for timestamptz;
begin
  update public.users
     set account_status = 'pending_deletion',
         deletion_requested_at = now(),
         deletion_scheduled_for = now() + interval '7 days'
   where id = p_user_id and account_status = 'active'
  returning deletion_scheduled_for into v_scheduled_for;

  if not found then
    return null;
  end if;

  -- Capture the email NOW: auth.users survives until grace-end, but the notices (Task 4) read it
  -- from the log so a race with the cascade can't lose it. now() is the frozen transaction time,
  -- so requested_at == users.deletion_requested_at.
  insert into public.account_deletion_log (user_id, recipient_email, requested_at, scheduled_for, outcome)
    values (p_user_id,
            (select email from auth.users where id = p_user_id),
            now(), v_scheduled_for, 'pending');

  return v_scheduled_for;
end $$;

revoke all on function public.request_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.request_account_deletion(uuid) to service_role;

-- ── cancel_account_deletion — leave the grace (CAS pending_deletion→active ONLY) ──────────────
-- Returns 'cancelled' | 'already_deleting' | 'not_pending' so the endpoint can 409 precisely. The
-- CAS refuses once the sweeper has claimed the account into 'deleting' (Task 3's point of no
-- return) — the cancel loses that race by design. On success it clears the timestamps (so a later
-- re-request gets a fresh 7-day schedule) and marks the open log row 'cancelled'.
create or replace function public.cancel_account_deletion(p_user_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_status text;
begin
  update public.users
     set account_status = 'active',
         deletion_requested_at = null,
         deletion_scheduled_for = null
   where id = p_user_id and account_status = 'pending_deletion';

  if found then
    update public.account_deletion_log
       set outcome = 'cancelled'
     where user_id = p_user_id and outcome = 'pending';
    return 'cancelled';
  end if;

  -- CAS missed: report WHY. 'deleting' is the irreversible claim (→ deletion_already_started);
  -- anything else means there is simply nothing pending to cancel.
  select account_status into v_status from public.users where id = p_user_id;
  if v_status = 'deleting' then
    return 'already_deleting';
  end if;
  return 'not_pending';
end $$;

revoke all on function public.cancel_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.cancel_account_deletion(uuid) to service_role;
