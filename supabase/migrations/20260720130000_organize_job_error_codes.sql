-- Raise organize-job validation errors with custom SQLSTATEs instead of a generic P0001.
--
-- `create_organize_job` (backend/organizer.py) previously distinguished "already being
-- organized" (409) from "not found" (404) by comparing `exc.message` to an exact English
-- string. Rewording a message in this file — or Postgres/PostgREST altering how it is
-- surfaced — silently turned a 409 into a 500, with no test able to see it because both
-- sides shared the same literal.
--
-- The codes follow the AS4xx convention established by 20260720090000_job_leases.sql:
--   AS409  conflict        -> ActiveOrganizeConflict -> HTTP 409
--   AS404  not found       -> PermissionError        -> HTTP 404
--   AS422  invalid request -> InvalidOrganizeRequest -> HTTP 422
-- The message text is now presentation only. Pinned by
-- supabase/tests/014_organize_job_error_codes.sql (real Postgres) and
-- backend/test_saved_reels_organize.py's reworded-message tests (the mapping).
--
-- Body copied verbatim from 20260719102000_saved_reels_active_item_guard.sql; the ONLY
-- changes are the four `using errcode` clauses.

create or replace function public.create_saved_reels_organize_job(
  p_user_id uuid,
  p_saved_reel_ids uuid[],
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id uuid;
  v_owned_ids uuid[];
begin
  -- SQLSTATE SCHEME — do not invent a new one below this line. Custom codes are `AS` + the
  -- HTTP status the API maps them to; 20260720090000_job_leases.sql established AS400/AS404/
  -- AS409 and this migration adds AS422 by the same rule. Python matches on the CODE
  -- (`organizer._ORGANIZE_JOB_ERRORS`), so these messages are free to be reworded and a NEW
  -- code is a two-sided change: add it there in the same PR or it surfaces as a 500.
  if p_saved_reel_ids is null
     or cardinality(p_saved_reel_ids) < 1
     or cardinality(p_saved_reel_ids) > 5
     or p_idempotency_key is null
     or btrim(p_idempotency_key) = '' then
    raise exception 'Saved Reel organize request is invalid' using errcode = 'AS422';
  end if;

  if exists (select 1 from unnest(p_saved_reel_ids) as requested(id) where requested.id is null)
     or (select count(*) from (select distinct id from unnest(p_saved_reel_ids) as requested(id)) unique_ids)
        <> cardinality(p_saved_reel_ids) then
    raise exception 'Saved Reel organize request is invalid' using errcode = 'AS422';
  end if;

  select coalesce(array_agg(owned.id order by owned.id), '{}'::uuid[])
  into v_owned_ids
  from (
    select id
    from public.saved_reels
    where user_id = p_user_id
      and id = any(p_saved_reel_ids)
    order by id
    for update
  ) owned;

  if cardinality(v_owned_ids) <> cardinality(p_saved_reel_ids) then
    raise exception 'Saved Reel not found' using errcode = 'AS404';
  end if;

  select id
  into v_job_id
  from public.organize_jobs
  where user_id = p_user_id
    and idempotency_key = p_idempotency_key
    and status in ('initializing', 'pending', 'processing')
  for update;

  if found then
    return v_job_id;
  end if;

  if exists (
    select 1
    from public.organize_jobs jobs
    join public.organize_job_items items
      on items.user_id = jobs.user_id
     and items.job_id = jobs.id
    where jobs.user_id = p_user_id
      and jobs.status in ('initializing', 'pending', 'processing')
      and items.saved_reel_id = any(p_saved_reel_ids)
  ) then
    raise exception 'Saved Reel is already being organized' using errcode = 'AS409';
  end if;

  insert into public.organize_jobs (
    user_id,
    idempotency_key,
    request_json,
    status,
    status_message,
    total_count,
    processed_count,
    organized_count,
    location_not_found_count,
    failed_count
  )
  values (
    p_user_id,
    p_idempotency_key,
    jsonb_build_object('saved_reel_ids', p_saved_reel_ids),
    'pending',
    'Queued',
    cardinality(p_saved_reel_ids),
    0,
    0,
    0,
    0
  )
  returning id into v_job_id;

  insert into public.organize_job_items (
    user_id,
    job_id,
    saved_reel_id,
    status,
    place_count,
    analysis_charge_state
  )
  select p_user_id, v_job_id, requested.id, 'queued', 0, 'not_charged'
  from unnest(p_saved_reel_ids) as requested(id);

  insert into public.organize_events (
    user_id,
    job_id,
    sequence,
    event_type,
    message,
    payload
  )
  values (p_user_id, v_job_id, 1, 'stage', 'Queued', '{}'::jsonb);

  return v_job_id;
end;
$$;

revoke all on function public.create_saved_reels_organize_job(uuid, uuid[], text)
from public, anon, authenticated;
grant execute on function public.create_saved_reels_organize_job(uuid, uuid[], text)
to service_role;
