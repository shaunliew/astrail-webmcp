-- Entitlement ledger: free trial (1 lifetime generation) + beta seats (daily quota).
--
-- The jobs row IS the charge ledger: a charge exists iff a durable job records it, and a
-- terminal failure refunds it exactly once behind the lease CAS. Two atomic RPCs enforce this:
--   * reserve_and_enqueue_trip_job (new)   — reserve = enqueue, all in one transaction.
--   * complete_trip_run           (extend) — fail = refund, exactly once, fully fenced.
--
-- Forward-only / additive: new columns + swap the unconditional idempotency unique for a
-- partial unique index that excludes refunded attempts. No data reversal.

-- 1. Entitlement columns on users (leave beta_status untouched — different axis).
alter table public.users
  add column plan text not null default 'trial'
    constraint users_plan_check check (plan in ('trial', 'beta')),
  add column lifetime_trip_count integer not null default 0
    constraint users_lifetime_trip_count_nonnegative check (lifetime_trip_count >= 0),
  add column seat_requested_at timestamptz;

-- 2. Charge ledger ON the jobs row (charge exists iff a job row records it).
alter table public.jobs
  add column charge_kind text
    constraint jobs_charge_kind_check check (charge_kind in ('lifetime', 'daily')),
  add column charge_date date,
  add column charge_refunded_at timestamptz;

-- 3. Retryable-after-refund: a refunded (reversed) attempt frees its idempotency key.
--    Existing rows all have charge_refunded_at NULL and (under the old global unique) distinct
--    keys, so the partial index builds cleanly.
alter table public.jobs drop constraint jobs_idempotency_key_unique;
create unique index jobs_idempotency_key_active_uidx
  on public.jobs (idempotency_key) where charge_refunded_at is null;

-- ── RPC A (new) — reserve_and_enqueue_trip_job — the atomic reserve = enqueue ──────────────────
-- security definer set search_path = '', EXECUTE revoked from public/anon/authenticated, granted
-- to service_role (exact posture of increment_daily_trip_usage). Returns one row.
create or replace function public.reserve_and_enqueue_trip_job(
  p_user_id uuid, p_idempotency_key text,
  p_destination_hint text, p_start_date date, p_end_date date,
  p_budget_level text, p_origin_city text,
  p_preference_summary text, p_preference_sources jsonb,
  p_event_payload jsonb,
  p_trial_limit integer, p_daily_limit integer
)
returns table (outcome text, trip_id uuid, job_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan text;
  v_charge_kind text;
  v_charge_date date := current_date;   -- recorded ONCE, in this txn (kills midnight drift)
  v_reserved integer;
  v_trip_id uuid;
  v_job_id uuid;
  v_constraint text;
begin
  -- 0. Identity. A missing row is an anomaly (the auth trigger normally creates it).
  select u.plan into v_plan from public.users u where u.id = p_user_id;
  if not found then
    return query select 'identity_unavailable'::text, null::uuid, null::uuid;
    return;
  end if;

  -- 1. Idempotent replay: an ACTIVE (non-refunded) job with this key already exists → return its
  --    trip, charge nothing. Refunded attempts are invisible here (partial-index semantics).
  select j.trip_id into v_trip_id
    from public.jobs j
   where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
   limit 1;
  if found then
    return query select 'replay'::text, v_trip_id, null::uuid;
    return;
  end if;

  -- 2. Reserve the entitlement atomically (row-locked; concurrent first-requests serialize here).
  if v_plan = 'beta' then
    v_charge_kind := 'daily';
    insert into public.user_daily_usage as d (user_id, usage_date, generated_trip_count)
      values (p_user_id, v_charge_date, 1)
      on conflict (user_id, usage_date)
      do update set generated_trip_count = d.generated_trip_count + 1, updated_at = now()
      where d.generated_trip_count < p_daily_limit
      returning d.generated_trip_count into v_reserved;
    if v_reserved is null then
      return query select 'daily_exhausted'::text, null::uuid, null::uuid;
      return;
    end if;
  else
    v_charge_kind := 'lifetime';
    update public.users
       set lifetime_trip_count = lifetime_trip_count + 1
     where id = p_user_id and lifetime_trip_count < p_trial_limit
     returning lifetime_trip_count into v_reserved;
    if v_reserved is null then
      return query select 'trial_exhausted'::text, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 3. Create trip + create_trip event + charged job, all in this txn. A same-key race that lost
  --    the partial-unique index raises unique_violation on the job insert; the block's savepoint
  --    rolls back trip+event+job, we undo the reservation (step 2 is OUTSIDE the block), and replay.
  begin
    insert into public.trips (user_id, status, destination_hint, start_date, end_date,
                              budget_level, origin_city, preference_summary, preference_sources)
      values (p_user_id, 'generating', p_destination_hint, p_start_date, p_end_date,
              p_budget_level, p_origin_city, p_preference_summary, coalesce(p_preference_sources, '[]'::jsonb))
      returning id into v_trip_id;

    insert into public.generation_events (trip_id, event_type, stage, message, payload)
      values (v_trip_id, 'stage', 'create_trip', 'Starting your trip',
              coalesce(p_event_payload, '{}'::jsonb));

    insert into public.jobs (trip_id, user_id, idempotency_key, status, charge_kind, charge_date)
      values (v_trip_id, p_user_id, p_idempotency_key, 'pending', v_charge_kind, v_charge_date)
      returning id into v_job_id;
  exception when unique_violation then
    -- Fix 2: only OUR active-key insert may collide here. Any other unique violation (a real bug,
    -- a future constraint) must NOT be swallowed as a replay — re-raise it. `is distinct from`
    -- re-raises on a NULL constraint name too (fail loud on uncertainty).
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint is distinct from 'jobs_idempotency_key_active_uidx' then
      raise;
    end if;
    -- Undo the reservation we made OUTSIDE this block (the savepoint already rolled back
    -- trip+event+job). Beta decrements the locked date row; trial decrements lifetime.
    if v_charge_kind = 'daily' then
      update public.user_daily_usage
         set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
       where user_id = p_user_id and usage_date = v_charge_date;
    else
      update public.users set lifetime_trip_count = greatest(lifetime_trip_count - 1, 0)
       where id = p_user_id;
    end if;
    -- Fix 1 (Rev 5, reverted from Rev 4): return the ACTIVE conflicting winner only. The partial
    -- index guarantees at most ONE row with this key has charge_refunded_at IS NULL, so this is
    -- unambiguous (no ordering / tie-breaker needed). Returning a refunded/failed trip would be
    -- wrong — the workspace can't resume it. If the winner has ALREADY refunded (no active row
    -- left), return a distinct non-charging `conflict_retry` (409), NEVER replay-with-NULL and
    -- NEVER a dead refunded trip.
    select j.trip_id into v_trip_id from public.jobs j
      where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
      limit 1;
    if v_trip_id is null then
      return query select 'conflict_retry'::text, null::uuid, null::uuid;
      return;
    end if;
    return query select 'replay'::text, v_trip_id, null::uuid;
    return;
  end;

  return query select 'created'::text, v_trip_id, v_job_id;
end $$;

revoke all on function public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)
  to service_role;

-- ── RPC B (extended) — complete_trip_run — fail = refund, exactly once, fully fenced ───────────
-- Same signature and grants as today (so _complete_trip_run and both call sites are unchanged).
-- The CAS now RETURNINGs the charge ledger AND the fenced trip_id; a failure-only branch owns
-- trips.status='failed' + the counter refund + charge_refunded_at, all in the one transaction the
-- CAS already fences. Fix 6: trip_id = p_trip_id is part of the CAS predicate.
create or replace function public.complete_trip_run(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_status text, p_stage text, p_message text, p_payload jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_trip_id uuid;      -- authoritative: read from the fenced job row, NOT p_trip_id (Fix 6)
  v_charge_kind text;
  v_charge_date date;
  v_user_id uuid;
begin
  -- Fence FIRST. CAS: id + lease + status='running' + trip_id=p_trip_id (Fix 6 — a caller passing
  -- the wrong trip matches zero rows → clean `false`, never a silent write to another trip; it is
  -- NOT silently ignored). A superseded worker also matches zero rows and writes NOTHING. RETURNING
  -- hands us the fenced trip_id + ledger so every terminal effect below is in THIS transaction and
  -- bound to the job we actually own (v_trip_id is now provably == p_trip_id).
  update public.jobs
     set status = p_status, completed_at = now()
   where id = p_job_id and lease_token = p_lease_token and status = 'running'
     and trip_id = p_trip_id
   returning trip_id, charge_kind, charge_date, user_id
        into v_trip_id, v_charge_kind, v_charge_date, v_user_id;
  if not found then
    return false;
  end if;

  -- Failure-only terminal effects. Exactly-once by construction: a 'running' job always has
  -- charge_refunded_at IS NULL (set only here), and only the CAS winner reaches this branch.
  if p_status = 'failed' then
    update public.trips set status = 'failed' where id = v_trip_id;
    update public.jobs set charge_refunded_at = now() where id = p_job_id;
    if v_charge_kind = 'lifetime' then
      update public.users
         set lifetime_trip_count = greatest(lifetime_trip_count - 1, 0)
       where id = v_user_id;
    elsif v_charge_kind = 'daily' then
      update public.user_daily_usage
         set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
       where user_id = v_user_id and usage_date = v_charge_date;   -- STORED date (kills midnight drift)
    end if;
    -- v_charge_kind NULL (pre-arc job): no counter to refund; charge_refunded_at is still set so
    -- the key frees for retry. Harmless.
  end if;

  -- Terminal result event (unchanged shape; terminates the SSE stream). Bound to v_trip_id.
  insert into public.generation_events (trip_id, event_type, stage, message, payload)
  values (v_trip_id, 'result', p_stage, p_message, coalesce(p_payload, '{}'::jsonb));
  return true;
end $$;

revoke all on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;
