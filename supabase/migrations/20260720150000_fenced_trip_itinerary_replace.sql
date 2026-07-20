-- Fence the trip pipeline's one DESTRUCTIVE write.
--
-- `persist_itinerary` clears this trip's trip_places/trip_days and rebuilds them. Until now
-- that ran as N unfenced PostgREST statements behind a single in-process `lease_lost` check,
-- which is a TOCTOU: the check passes, then the delete-reinsert plus four enrich stages plus
-- an unbounded Agents SDK narration call follow. A worker superseded anywhere in that window
-- deleted the replacement's itinerary and reinserted its own — and unlike the job row
-- (complete_trip_run's CAS) and the terminal event (streaming.py returns on the first
-- `result`), NOTHING ever corrects trip_places/trip_days.
--
-- Arc A's accepted scope limit is "a worker parked in one provider call still lands THAT
-- item" — bounded by one item. This was unbounded and destructive, so it gets a real fence:
-- the lease check and the rewrite are ONE transaction, exactly as append_organize_event and
-- complete_trip_run already do (20260720090000_job_leases.sql).
--
-- Three constraints this signature encodes; do not "simplify" them back:
--   1. `p_lease_token uuid`, NOT text — jobs.lease_token is uuid and plpgsql defers
--      "operator does not exist: uuid = text" to RUNTIME, so `supabase db reset` alone does
--      NOT catch a text parameter. Only an execution test does.
--   2. The fence matches on `trip_id = p_trip_id` as well as the token, so a lease on job X
--      can only ever rewrite job X's OWN trip (guardrail #6, enforced through the job row
--      rather than by trusting a caller-supplied user_id).
--   3. `set search_path = ''` plus the revoke/grant block, matching both existing RPCs.
create or replace function public.replace_trip_itinerary(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_places jsonb, p_days jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- FENCE FIRST, and take the row lock: `for update` is what makes this safe against a
  -- concurrent reclaim rather than merely narrow. Under READ COMMITTED the predicate is
  -- re-evaluated after the lock is granted, so a reclaim that commits while we wait (it NULLs
  -- lease_token) leaves us matching zero rows — we abort instead of deleting the rows the
  -- replacement is about to write. The lock is held to COMMIT, so the delete-reinsert below
  -- cannot interleave with another worker's claim of the same job.
  perform 1 from public.jobs
   where id = p_job_id
     and trip_id = p_trip_id
     and lease_token = p_lease_token
     and status = 'running'
     for update;
  if not found then
    return false;
  end if;

  -- Retry-safety: clear THIS trip's links/days. `places` is GLOBAL (the dedup-on-write
  -- flywheel, shared across trips) and is never deleted here — the caller resolves place ids
  -- before calling, and those inserts are additive, so leaving them outside the fence costs
  -- nothing a superseded worker could destroy.
  delete from public.trip_places where trip_id = p_trip_id;
  delete from public.trip_days where trip_id = p_trip_id;

  insert into public.trip_places
    (trip_id, place_id, source_type, evidence_json, day_number, sort_order)
  select p_trip_id,
         (row_value->>'place_id')::uuid,
         row_value->>'source_type',
         coalesce(row_value->'evidence_json', '{}'::jsonb),
         (row_value->>'day_number')::integer,
         (row_value->>'sort_order')::integer
    from jsonb_array_elements(coalesce(p_places, '[]'::jsonb)) as row_value;

  insert into public.trip_days (trip_id, day_number, day_date)
  select p_trip_id,
         (row_value->>'day_number')::integer,
         (row_value->>'day_date')::date
    from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) as row_value;

  return true;
end $$;

revoke all on function public.replace_trip_itinerary(uuid, uuid, uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_trip_itinerary(uuid, uuid, uuid, jsonb, jsonb)
  to service_role;
