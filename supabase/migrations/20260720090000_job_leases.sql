-- Job leases: you own a job only while your lease_token is the one on the row.

alter table public.organize_jobs add column lease_token uuid;
alter table public.jobs
  add column lease_token uuid,
  add column lock_expires_at timestamptz;

-- Existing in-flight rows predate leases: give them a computed expiry so the reaper can
-- reclaim them (lease_token stays NULL; the reclaim CAS has an explicit `is null` branch).
--
-- The two statements differ deliberately, for a reason that is NOT obvious:
--   * organize_jobs.lock_expires_at ALREADY EXISTED (added 20260718130000), so a row may
--     carry a real value worth preserving -> coalesce(existing, computed).
--   * jobs.lock_expires_at is created by THIS migration, so it is guaranteed NULL on every
--     row here; coalescing against it would be a no-op. Its final `now()` fallback covers
--     `locked_at IS NULL AND status = 'running'`, which makes such a row immediately
--     reclaimable rather than stranded forever.
--
-- That fallback is unreachable under current code and is defence-in-depth only: every writer
-- of either status sets locked_at in the SAME statement -- jobs via mark_job_running
-- (backend/jobs.py:69-73), organize_jobs via run_organize_job's claim (backend/organizer.py:
-- 447-451). `private.claim_next_generation_job()` (20260701151718:146-163) also sets it
-- atomically and has zero Python callers. If a future writer ever sets status without
-- locked_at, prefer the `now()` shape: stranding an in-flight row forever is the guardrail-#12
-- silent drop this whole arc exists to eliminate.
update public.organize_jobs
   set lock_expires_at = coalesce(lock_expires_at, locked_at + interval '300 seconds')
 where status = 'processing';
update public.jobs
   set lock_expires_at = coalesce(locked_at + interval '300 seconds', now())
 where status = 'running';

create index organize_jobs_lease_reap_idx
  on public.organize_jobs (lock_expires_at) where status = 'processing';
create index jobs_lease_reap_idx
  on public.jobs (lock_expires_at) where status = 'running';

create or replace function public.append_organize_event(
  p_job_id uuid, p_user_id uuid, p_lease_token uuid,
  p_event_type text, p_message text, p_payload jsonb default '{}'::jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_lease uuid;
  v_sequence integer;
begin
  -- One row lock serializes ALL event appends for this job: two concurrent callers cannot
  -- both compute the same MAX(sequence)+1, so organize_events_job_sequence_unique can no
  -- longer be violated by a legitimate racing writer.
  select lease_token into v_lease
    from public.organize_jobs
   where id = p_job_id and user_id = p_user_id
     for update;
  if not found then
    raise exception 'Organize job not found' using errcode = 'AS404';
  end if;
  -- FENCE: p_lease_token is REQUIRED — there is no unfenced form.
  -- An earlier draft allowed `p_lease_token is null` as an "unfenced caller (boot paths that
  -- legitimately have no lease yet)". No such caller exists: EVERY event writer runs after the
  -- claim returns (verified — organizer.py:422, :434, :455, :485, and _mark_organize_job_failed
  -- from run_organize_job's outer except; the claim early-returns at `if not claimed.data`).
  -- It was the same speculative unfenced form already deleted from mark_job_done, and left in
  -- it would be a standing bypass: a caller with no token writing to a row with no token
  -- (null IS NOT DISTINCT FROM null) sails straight through.
  if p_lease_token is null then
    raise exception 'Organize event requires a lease token' using errcode = 'AS400';
  end if;
  if v_lease is distinct from p_lease_token then
    raise exception 'Organize job lease superseded' using errcode = 'AS409';
  end if;
  select coalesce(max(sequence), 0) + 1 into v_sequence
    from public.organize_events where job_id = p_job_id;
  insert into public.organize_events (user_id, job_id, sequence, event_type, message, payload)
  values (p_user_id, p_job_id, v_sequence, p_event_type, p_message, coalesce(p_payload, '{}'::jsonb));
  return v_sequence;
end;
$$;

revoke all on function public.append_organize_event(uuid, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.append_organize_event(uuid, uuid, uuid, text, text, jsonb)
  to service_role;

-- Terminal trip completion. A superseded worker's stale `result` event would end the user's
-- SSE session on a wrong outcome (streaming.py ends on the first `result` row, and the
-- seen-set dedupes by row id, so a second writer's row is NOT deduped). Fencing the job
-- write alone does not stop that — only one transaction covering both does.
--
-- Three constraints this signature encodes; do not "simplify" them back:
--   1. `p_lease_token uuid`, NOT text — `jobs.lease_token` is uuid, and plpgsql defers
--      "operator does not exist: uuid = text" to RUNTIME, so `supabase db reset` alone does
--      NOT catch a text parameter. Only an execution test does.
--   2. The insert carries NO `user_id` — `public.generation_events` HAS NO SUCH COLUMN
--      (20260701151718_trip_job_backbone.sql: trip_id, event_type, stage, message, payload,
--      created_at only).
--   3. `set search_path = ''` plus the revoke/grant block, matching append_organize_event.
create or replace function public.complete_trip_run(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_status text, p_stage text, p_message text, p_payload jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- Fence FIRST: claim the terminal transition in one statement. A superseded worker fails
  -- here and writes NOTHING — that is what makes "no job write => no event write" true
  -- rather than merely probable.
  update public.jobs set status = p_status, completed_at = now()
   where id = p_job_id and lease_token = p_lease_token and status = 'running';
  if not found then return false; end if;

  -- coalesce is load-bearing, matching append_organize_event. generation_events.payload is
  -- `not null default '{}'::jsonb`, and naming the column explicitly in the INSERT means the
  -- DEFAULT never applies — an explicit null raises 23502 at runtime. runner.py always passes
  -- a payload today, so without this it is a latent trap for the first caller that does not.
  insert into public.generation_events (trip_id, event_type, stage, message, payload)
  values (p_trip_id, 'result', p_stage, p_message, coalesce(p_payload, '{}'::jsonb));
  return true;
end $$;

revoke all on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;
