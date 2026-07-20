-- One clock decides who owns a job.
--
-- A lease exists so that exactly one worker is live per job. Until now BOTH halves of that
-- decision were made on the worker's own host clock: `mark_job_running` / the organize claim
-- computed `lock_expires_at` as `datetime.now(utc) + TTL` in Python, and the reapers compared
-- it against a Python `now` they passed into the PostgREST filter. Postgres evaluated the
-- comparison, but the VALUES on both sides came from two different machines.
--
-- Render runs multiple instances, and nothing there guarantees their clocks agree. Worker A
-- six minutes slow claims a five-minute lease whose stored expiry is already a minute in the
-- past by worker B's reckoning; B's next sweep reclaims it and a replacement claims a fresh
-- token while A is still executing. The per-write CAS still preserves ONE database token, so
-- the job row and the terminal event stay consistent -- but two workers are doing application
-- work at once, which is the one thing the lease exists to prevent. Skew the other way and a
-- genuinely dead worker's lease outlives its TTL by the skew, so the reclaim that guardrail
-- #12 promises is simply late.
--
-- Claim, renewal and the expiry comparison therefore all move here. Python still owns the
-- TTL: a DURATION does not skew, only an INSTANT does, so `p_ttl_seconds` stays a parameter
-- and `JOB_LEASE_TTL_S` / `ORGANIZE_LEASE_TTL_S` stay the single definition. User-facing
-- copy (`status_message`) stays a parameter for the same reason -- product strings belong
-- with the rest of the product strings, not in a migration.
--
-- clock_timestamp() AND NOT now(), everywhere, deliberately:
--   * `now()` is `transaction_timestamp()` -- fixed for the whole transaction. Under
--     PostgREST each of these calls is its own transaction, so the two usually agree, and
--     that "usually" is exactly what makes it the wrong default to write down.
--   * The difference is real precisely when it hurts. These statements can WAIT on a row lock
--     (a renewal queued behind a reclaim of the same row). With `now()` the granted expiry is
--     measured from BEFORE the wait, so a renewal that waited 30s buys only TTL-30s -- the
--     lease shortens exactly when the database is slow and the run most needs it to hold.
--     `clock_timestamp()` in the SET clause is re-evaluated when the row is actually written
--     (READ COMMITTED re-executes the update against the updated tuple), so the expiry is
--     measured from the moment the write lands.
--   * In the reclaim predicate `clock_timestamp()` is volatile and so re-read per row. That
--     is harmless -- it advances monotonically within the statement -- and it is the same
--     "compare against the instant this row is actually examined" property.
--
-- No isolation level is set anywhere below: these run in the caller's transaction at the
-- default READ COMMITTED, which 20260720160000's re-check-under-lock depends on.

-- --- trip generation (backend/jobs.py) -------------------------------------------------------

-- Claim: pending|retryable -> running, minting this attempt's lease token.
-- `started_at` is re-stamped on every claim, matching the Python it replaces. That differs
-- from the organize claim below (which coalesces) and the difference is deliberate on the
-- organize side, not a bug here; changing trip semantics is not this migration's job.
create or replace function public.claim_trip_job(
  p_job_id uuid, p_lease_token uuid, p_ttl_seconds integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- Boundary validation, mirroring append_organize_event's AS400 on a null token. A claim
  -- with no token would write a row nothing can later fence on, and a null/non-positive TTL
  -- would mint a lease that is already expired -- both fail toward "two live workers".
  if p_lease_token is null then
    raise exception 'Trip job claim requires a lease token' using errcode = 'AS400';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Trip job lease TTL must be positive' using errcode = 'AS400';
  end if;
  update public.jobs
     set status = 'running',
         locked_at = clock_timestamp(),
         started_at = clock_timestamp(),
         lock_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds),
         lease_token = p_lease_token,
         completed_at = null,
         error_message = null
   where id = p_job_id
     and status in ('pending', 'retryable');
  return found;
end $$;

revoke all on function public.claim_trip_job(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_trip_job(uuid, uuid, integer) to service_role;

-- Renewal. Same CAS as before -- id + our token + `status = 'running'` -- with the new expiry
-- taken from the database's clock instead of the worker's. The status predicate is part of
-- the fence, not decoration: a job already reclaimed to `retryable` and re-dispatched must
-- not be renewable by the run that lost it.
create or replace function public.renew_trip_job_lease(
  p_job_id uuid, p_lease_token uuid, p_ttl_seconds integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_lease_token is null then
    raise exception 'Trip lease renewal requires a lease token' using errcode = 'AS400';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Trip job lease TTL must be positive' using errcode = 'AS400';
  end if;
  update public.jobs
     set lock_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds)
   where id = p_job_id
     and status = 'running'
     and lease_token = p_lease_token;
  return found;
end $$;

revoke all on function public.renew_trip_job_lease(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_trip_job_lease(uuid, uuid, integer) to service_role;

-- Reclaim. Returns the COUNT, which is all the caller logs; the list of jobs to re-dispatch
-- is a separate read, unchanged.
--
-- THE LEGACY-NULL BRANCH IS LOAD-BEARING -- do not simplify to the expiry test alone. Rows
-- claimed by a container running the pre-lease code carry `lock_expires_at IS NULL`, and
-- `NULL < clock_timestamp()` is NULL, not true, so an expiry-only predicate would skip them
-- forever: the silent drop guardrail #12 forbids, reintroduced at a rollout boundary. The
-- `is null` conjunct keeps that branch gated -- a long run whose heartbeat holds a future
-- expiry also has a stale `locked_at`, and must NOT be reclaimed on age alone.
create or replace function public.reclaim_expired_trip_jobs(p_ttl_seconds integer)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_reclaimed integer;
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Trip job lease TTL must be positive' using errcode = 'AS400';
  end if;
  with reclaimed as (
    update public.jobs
       set status = 'retryable',
           lease_token = null,
           lock_expires_at = null,
           locked_at = null
     where status = 'running'
       and (
         lock_expires_at < clock_timestamp()
         or (lock_expires_at is null
             and locked_at < clock_timestamp() - make_interval(secs => p_ttl_seconds))
       )
    returning 1
  )
  select count(*) into v_reclaimed from reclaimed;
  return v_reclaimed;
end $$;

revoke all on function public.reclaim_expired_trip_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.reclaim_expired_trip_jobs(integer) to service_role;

-- --- saved-reel organize (backend/organizer.py) ----------------------------------------------

-- Claim: pending -> processing, scoped to the owner.
--
-- `started_at` COALESCES rather than re-stamping, preserving the Python conditional it
-- replaces: it is the run's user-visible elapsed time, and re-stamping on every retry makes a
-- job stuck in a retry loop for an hour report as though it had just begun. `attempt_count`
-- still arrives from the caller, which keeps this a faithful translation -- the pre-claim read
-- that supplies it also distinguishes "job vanished" from "another worker holds it", and
-- collapsing that read into this function is a different change.
create or replace function public.claim_organize_job(
  p_job_id uuid, p_user_id uuid, p_lease_token uuid, p_ttl_seconds integer,
  p_status_message text, p_attempt_count integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_lease_token is null then
    raise exception 'Organize job claim requires a lease token' using errcode = 'AS400';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Organize job lease TTL must be positive' using errcode = 'AS400';
  end if;
  update public.organize_jobs
     set status = 'processing',
         status_message = p_status_message,
         locked_at = clock_timestamp(),
         started_at = coalesce(public.organize_jobs.started_at, clock_timestamp()),
         lock_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds),
         lease_token = p_lease_token,
         attempt_count = p_attempt_count
   where id = p_job_id
     and user_id = p_user_id
     and status = 'pending';
  return found;
end $$;

revoke all on function public.claim_organize_job(uuid, uuid, uuid, integer, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_organize_job(uuid, uuid, uuid, integer, text, integer)
  to service_role;

create or replace function public.renew_organize_job_lease(
  p_job_id uuid, p_user_id uuid, p_lease_token uuid, p_ttl_seconds integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_lease_token is null then
    raise exception 'Organize lease renewal requires a lease token' using errcode = 'AS400';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Organize job lease TTL must be positive' using errcode = 'AS400';
  end if;
  update public.organize_jobs
     set lock_expires_at = clock_timestamp() + make_interval(secs => p_ttl_seconds)
   where id = p_job_id
     and user_id = p_user_id
     and status = 'processing'
     and lease_token = p_lease_token;
  return found;
end $$;

revoke all on function public.renew_organize_job_lease(uuid, uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.renew_organize_job_lease(uuid, uuid, uuid, integer)
  to service_role;

create or replace function public.reclaim_expired_organize_jobs(
  p_ttl_seconds integer, p_status_message text
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_reclaimed integer;
begin
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'Organize job lease TTL must be positive' using errcode = 'AS400';
  end if;
  with reclaimed as (
    update public.organize_jobs
       set status = 'pending',
           status_message = p_status_message,
           locked_at = null,
           lock_expires_at = null,
           lease_token = null
     where status = 'processing'
       and (
         lock_expires_at < clock_timestamp()
         or (lock_expires_at is null
             and locked_at < clock_timestamp() - make_interval(secs => p_ttl_seconds))
       )
    returning 1
  )
  select count(*) into v_reclaimed from reclaimed;
  return v_reclaimed;
end $$;

revoke all on function public.reclaim_expired_organize_jobs(integer, text)
  from public, anon, authenticated;
grant execute on function public.reclaim_expired_organize_jobs(integer, text)
  to service_role;
