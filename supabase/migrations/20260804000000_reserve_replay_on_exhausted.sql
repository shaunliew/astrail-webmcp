-- Concurrent double-submit on a 1-trip trial returned 403 trial_exhausted (2026-08-04).
--
-- Two simultaneous POSTs compute the SAME server-derived idempotency key
-- (main.py's compute_idempotency_key). Both pass step 1's replay check -- neither sees the
-- other's uncommitted job. A reserves (lifetime_trip_count 0 -> 1); B blocks on A's row
-- lock, then evaluates `1 < 1` and returns trial_exhausted. The user is told their free
-- trip is gone while it is, in fact, generating.
--
-- Step 3 ALREADY recovers from a same-key race (unique_violation -> undo -> replay), but B
-- dies at step 2 and never reaches it. This adds the same recovery at the exhausted branch.
-- Function body is otherwise byte-identical to 20260803120000; only the two recovery blocks
-- are new. REPLACE-only: no schema change, so the column-only pre-deploy gate cannot see it
-- -- apply this to production BEFORE merging.

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
      -- CONCURRENT DOUBLE-SUBMIT RECOVERY (2026-08-04). Step 1's replay check ran before
      -- the winner committed, so it MISSED. But the reserve above is a row lock: by the time
      -- we observe the limit as consumed, the winner IS committed, and READ COMMITTED gives
      -- this statement a fresh snapshot that can see it. An active job with our key therefore
      -- means this request IS that request -- replay it instead of telling the user their
      -- trial is gone. Mirrors the identical lookup the unique_violation handler already does.
      -- Without this, two simultaneous clicks on a 1-trip trial return 403 trial_exhausted,
      -- because the loser dies HERE and never reaches that handler.
      select j.trip_id into v_trip_id from public.jobs j
        where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
        limit 1;
      if v_trip_id is not null then
        return query select 'replay'::text, v_trip_id, null::uuid;
        return;
      end if;
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
      -- CONCURRENT DOUBLE-SUBMIT RECOVERY (2026-08-04). Step 1's replay check ran before
      -- the winner committed, so it MISSED. But the reserve above is a row lock: by the time
      -- we observe the limit as consumed, the winner IS committed, and READ COMMITTED gives
      -- this statement a fresh snapshot that can see it. An active job with our key therefore
      -- means this request IS that request -- replay it instead of telling the user their
      -- trial is gone. Mirrors the identical lookup the unique_violation handler already does.
      -- Without this, two simultaneous clicks on a 1-trip trial return 403 trial_exhausted,
      -- because the loser dies HERE and never reaches that handler.
      select j.trip_id into v_trip_id from public.jobs j
        where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
        limit 1;
      if v_trip_id is not null then
        return query select 'replay'::text, v_trip_id, null::uuid;
        return;
      end if;
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
