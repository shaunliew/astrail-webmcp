create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'draft',
  destination_hint text,
  inferred_destination text,
  start_date date,
  end_date date,
  origin_city text,
  budget_level text,
  adult_count integer not null default 1,
  child_count integer not null default 0,
  room_count integer not null default 1,
  occupancy_json jsonb not null default '{}'::jsonb,
  hotel_preference_json jsonb not null default '{}'::jsonb,
  persona_snapshot_json jsonb not null default '{}'::jsonb,
  preference_sources jsonb not null default '[]'::jsonb,
  preference_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_id_user_id_unique unique (id, user_id),
  constraint trips_status_check check (status in ('draft', 'generating', 'places_ready', 'complete', 'saved_with_gaps', 'failed')),
  constraint trips_budget_level_check check (budget_level is null or budget_level in ('budget', 'mid_range', 'premium', 'luxury')),
  constraint trips_occupancy_counts_check check (adult_count >= 1 and child_count >= 0 and room_count >= 1),
  constraint trips_date_order_check check (start_date is null or end_date is null or end_date >= start_date)
);

create trigger trips_set_updated_at
before update on public.trips
for each row execute function private.set_updated_at();

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_trip_user_fkey foreign key (trip_id, user_id) references public.trips(id, user_id) on delete cascade,
  constraint jobs_idempotency_key_unique unique (idempotency_key),
  constraint jobs_status_check check (status in ('pending', 'running', 'succeeded', 'failed', 'retryable', 'cancelled')),
  constraint jobs_attempt_count_nonnegative check (attempt_count >= 0)
);

create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function private.set_updated_at();

create table public.generation_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  event_type text not null,
  stage text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint generation_events_event_type_check check (event_type in ('stage', 'decision', 'warning', 'error', 'heartbeat', 'result')),
  constraint generation_events_stage_check check (
    stage in (
      'create_trip',
      'scrape',
      'cache_hit',
      'extract',
      'resolve',
      'preferences',
      'dedup',
      'enrich',
      'weather',
      'restaurants',
      'hotels',
      'transport',
      'narrate',
      'summarize',
      'save'
    )
  )
);

alter table public.memory_events
add constraint memory_events_trip_user_fkey
foreign key (trip_id, user_id) references public.trips(id, user_id) on delete set null (trip_id);

alter table public.user_preference_facts
add constraint user_preference_facts_source_trip_user_fkey
foreign key (source_trip_id, user_id) references public.trips(id, user_id) on delete set null (source_trip_id);

create index trips_user_id_idx on public.trips (user_id);
create index trips_user_status_created_at_idx on public.trips (user_id, status, created_at desc);
create index jobs_trip_id_idx on public.jobs (trip_id);
create index jobs_user_id_idx on public.jobs (user_id);
create index jobs_trip_user_id_idx on public.jobs (trip_id, user_id);
create index jobs_status_created_at_idx on public.jobs (status, created_at);
create index jobs_pending_created_at_idx on public.jobs (created_at)
where status in ('pending', 'retryable');
create index generation_events_trip_id_created_at_idx on public.generation_events (trip_id, created_at);
create index memory_events_trip_user_id_idx on public.memory_events (trip_id, user_id)
where trip_id is not null;
create index user_preference_facts_source_trip_user_id_idx on public.user_preference_facts (source_trip_id, user_id)
where source_trip_id is not null;

alter table public.trips enable row level security;
alter table public.jobs enable row level security;
alter table public.generation_events enable row level security;

grant select on public.trips to authenticated;
grant all on public.trips to service_role;

grant select on public.jobs to authenticated;
grant all on public.jobs to service_role;

grant select on public.generation_events to authenticated;
grant all on public.generation_events to service_role;

create policy trips_select_own
on public.trips
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy jobs_select_own
on public.jobs
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy generation_events_select_own_trip
on public.generation_events
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = generation_events.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create or replace function private.claim_next_generation_job()
returns public.jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_job public.jobs;
begin
  update public.jobs
  set
    status = 'running',
    locked_at = now(),
    started_at = coalesce(started_at, now()),
    attempt_count = attempt_count + 1,
    updated_at = now()
  where id = (
    select id
    from public.jobs
    where status in ('pending', 'retryable')
    order by created_at
    for update skip locked
    limit 1
  )
  returning * into claimed_job;

  return claimed_job;
end;
$$;

revoke all on function private.claim_next_generation_job() from public, anon, authenticated;
grant execute on function private.claim_next_generation_job() to service_role;
