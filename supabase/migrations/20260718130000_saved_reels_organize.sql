-- Saved Reels organization, safe source proof, country grouping, and analysis quota.

alter table public.places
  add column if not exists country_code text,
  add column if not exists country_name text;

alter table public.places
  add constraint places_country_code_shape_check
  check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  add constraint places_country_name_nonblank_check
  check (country_name is null or btrim(country_name) <> ''),
  add constraint places_country_fields_pair_check
  check ((country_code is null) = (country_name is null));

create index places_country_code_name_idx
  on public.places (country_code, country_name);

alter table public.user_daily_usage
  add column if not exists reel_analysis_count integer not null default 0;

alter table public.user_daily_usage
  add constraint user_daily_usage_reel_analysis_count_nonnegative
  check (reel_analysis_count >= 0);

create table public.reel_place_mentions (
  reel_cache_id uuid not null references public.reel_cache(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete cascade,
  evidence_quote text not null,
  source_url text,
  confidence numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (reel_cache_id, place_id),
  constraint reel_place_mentions_evidence_nonblank_check check (btrim(evidence_quote) <> ''),
  constraint reel_place_mentions_source_url_nonblank_check check (source_url is null or btrim(source_url) <> ''),
  constraint reel_place_mentions_confidence_range_check check (confidence >= 0 and confidence <= 1)
);

create trigger reel_place_mentions_set_updated_at
before update on public.reel_place_mentions
for each row execute function private.set_updated_at();

create index reel_place_mentions_place_id_idx
  on public.reel_place_mentions (place_id);

create table public.organize_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'pending',
  status_message text not null default 'Queued',
  request_json jsonb not null default '{}'::jsonb,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  attempt_count integer not null default 0,
  total_count integer not null default 0,
  processed_count integer not null default 0,
  organized_count integer not null default 0,
  location_not_found_count integer not null default 0,
  failed_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint organize_jobs_user_id_id_unique unique (user_id, id),
  constraint organize_jobs_user_idempotency_key_unique unique (user_id, idempotency_key),
  constraint organize_jobs_status_check check (status in ('pending', 'processing', 'succeeded', 'failed')),
  constraint organize_jobs_request_json_object_check check (jsonb_typeof(request_json) = 'object'),
  constraint organize_jobs_counts_nonnegative_check check (
    attempt_count >= 0
    and
    total_count >= 0
    and processed_count >= 0
    and organized_count >= 0
    and location_not_found_count >= 0
    and failed_count >= 0
    and processed_count <= total_count
    and organized_count + location_not_found_count + failed_count <= processed_count
  )
);

create trigger organize_jobs_set_updated_at
before update on public.organize_jobs
for each row execute function private.set_updated_at();

create index organize_jobs_user_created_at_idx
  on public.organize_jobs (user_id, created_at desc, id);

create index organize_jobs_status_created_at_idx
  on public.organize_jobs (status, created_at);

create table public.organize_job_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  saved_reel_id uuid not null,
  status text not null default 'queued',
  place_count integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint organize_job_items_job_reel_unique unique (job_id, saved_reel_id),
  constraint organize_job_items_user_job_fkey
    foreign key (user_id, job_id)
    references public.organize_jobs(user_id, id)
    on delete cascade,
  constraint organize_job_items_user_saved_reel_fkey
    foreign key (user_id, saved_reel_id)
    references public.saved_reels(user_id, id)
    on delete cascade,
  constraint organize_job_items_status_check check (status in ('queued', 'processing', 'organized', 'location_not_found', 'failed')),
  constraint organize_job_items_place_count_nonnegative_check check (place_count >= 0)
);

create trigger organize_job_items_set_updated_at
before update on public.organize_job_items
for each row execute function private.set_updated_at();

create index organize_job_items_job_id_idx
  on public.organize_job_items (user_id, job_id, created_at, id);

create index organize_job_items_saved_reel_id_idx
  on public.organize_job_items (user_id, saved_reel_id);

alter table public.organize_job_items
  add column analysis_charge_state text not null default 'not_charged',
  add column analysis_reserved_at timestamptz,
  add column analysis_refunded_at timestamptz,
  add column analysis_consumed_at timestamptz;

alter table public.organize_job_items
  add constraint organize_job_items_analysis_charge_state_check
  check (
    (analysis_charge_state = 'not_charged' and analysis_reserved_at is null and analysis_refunded_at is null and analysis_consumed_at is null)
    or (analysis_charge_state = 'reserved' and analysis_reserved_at is not null and analysis_refunded_at is null and analysis_consumed_at is null)
    or (analysis_charge_state = 'refunded' and analysis_reserved_at is not null and analysis_refunded_at is not null and analysis_consumed_at is null)
    or (analysis_charge_state = 'consumed' and analysis_reserved_at is not null and analysis_refunded_at is null and analysis_consumed_at is not null)
  );

create table public.organize_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  job_id uuid not null,
  sequence integer not null,
  event_type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint organize_events_job_sequence_unique unique (job_id, sequence),
  constraint organize_events_user_job_fkey
    foreign key (user_id, job_id)
    references public.organize_jobs(user_id, id)
    on delete cascade,
  constraint organize_events_sequence_positive_check check (sequence > 0),
  constraint organize_events_message_nonblank_check check (btrim(message) <> ''),
  constraint organize_events_payload_object_check check (jsonb_typeof(payload) = 'object')
);

create index organize_events_job_sequence_idx
  on public.organize_events (user_id, job_id, sequence, created_at);

alter table public.reel_place_mentions enable row level security;
alter table public.organize_jobs enable row level security;
alter table public.organize_job_items enable row level security;

alter table public.organize_events enable row level security;

revoke all on public.reel_place_mentions from public, anon, authenticated;
grant all on public.reel_place_mentions to service_role;

revoke all on public.organize_jobs from public, anon, authenticated;
grant select on public.organize_jobs to authenticated;
grant all on public.organize_jobs to service_role;

revoke all on public.organize_job_items from public, anon, authenticated;
grant select on public.organize_job_items to authenticated;
grant all on public.organize_job_items to service_role;

revoke all on public.organize_events from public, anon, authenticated;
grant select on public.organize_events to authenticated;
grant all on public.organize_events to service_role;

-- The browser projection is owner-executed and explicitly filters by the JWT owner.
-- reel_cache and mentions remain service-role-only; unsafe cache columns are never
-- granted to authenticated and are not selected by this view.
revoke all on public.reel_cache from public, anon, authenticated;

create policy organize_jobs_select_own
on public.organize_jobs
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy organize_job_items_select_own
on public.organize_job_items
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy organize_events_select_own
on public.organize_events
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy places_select_when_used_in_own_saved_reel
on public.places
for select
to authenticated
using (
  exists (
    select 1
    from public.reel_place_mentions
    join public.saved_reels
      on saved_reels.reel_cache_id = reel_place_mentions.reel_cache_id
    where reel_place_mentions.place_id = places.id
      and saved_reels.user_id = (select auth.uid())
  )
);

create view public.saved_reel_cards as
select
  saved_reels.id,
  saved_reels.user_id,
  saved_reels.normalized_url,
  saved_reels.source_platform,
  saved_reels.reel_cache_id,
  saved_reels.analysis_status,
  saved_reels.personal_label,
  saved_reels.retry_after,
  saved_reels.analyzed_at,
  saved_reels.created_at,
  saved_reels.updated_at,
  reel_cache.caption,
  reel_cache.thumbnail_url,
  coalesce(
    jsonb_agg(
      jsonb_build_object(
        'place_id', reel_place_mentions.place_id,
        'name', places.name,
        'lat', places.lat,
        'lng', places.lng,
        'country_code', places.country_code,
        'country_name', places.country_name,
        'evidence_quote', reel_place_mentions.evidence_quote,
        'source_url', reel_place_mentions.source_url,
        'source_reel_url', saved_reels.normalized_url,
        'confidence', reel_place_mentions.confidence
      ) order by places.name
    ) filter (where reel_place_mentions.place_id is not null),
    '[]'::jsonb
  ) as places
from public.saved_reels
left join public.reel_cache
  on reel_cache.id = saved_reels.reel_cache_id
left join public.reel_place_mentions
  on reel_place_mentions.reel_cache_id = saved_reels.reel_cache_id
left join public.places
  on places.id = reel_place_mentions.place_id
where saved_reels.user_id = (select auth.uid())
group by
  saved_reels.id,
  saved_reels.user_id,
  saved_reels.normalized_url,
  saved_reels.source_platform,
  saved_reels.reel_cache_id,
  saved_reels.analysis_status,
  saved_reels.personal_label,
  saved_reels.retry_after,
  saved_reels.analyzed_at,
  saved_reels.created_at,
  saved_reels.updated_at,
  reel_cache.caption,
  reel_cache.thumbnail_url;

-- The aggregate projection is one safe card per owner-owned Saved Reel. It does
-- not use security_invoker because reel_cache and mentions intentionally remain
-- service-role-only; the explicit owner predicate is the browser boundary.

revoke all on public.saved_reel_cards from public, anon;
grant select on public.saved_reel_cards to authenticated, service_role;

create or replace function public.reserve_daily_reel_analysis(
  p_user_id uuid,
  p_usage_date date default current_date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count integer;
begin
  insert into public.user_daily_usage as usage (user_id, usage_date, reel_analysis_count)
  values (p_user_id, p_usage_date, 1)
  on conflict (user_id, usage_date)
  do update set
    reel_analysis_count = usage.reel_analysis_count + 1,
    updated_at = now()
  where usage.reel_analysis_count < 5
  returning reel_analysis_count into v_new_count;

  return v_new_count;
end;
$$;

revoke all on function public.reserve_daily_reel_analysis(uuid, date) from public, anon, authenticated;
grant execute on function public.reserve_daily_reel_analysis(uuid, date) to service_role;

create or replace function public.refund_daily_reel_analysis(
  p_user_id uuid,
  p_usage_date date default current_date
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count integer;
begin
  update public.user_daily_usage
  set reel_analysis_count = greatest(reel_analysis_count - 1, 0),
      updated_at = now()
  where user_id = p_user_id
    and usage_date = p_usage_date
  returning reel_analysis_count into v_new_count;

  return v_new_count;
end;
$$;

revoke all on function public.refund_daily_reel_analysis(uuid, date) from public, anon, authenticated;
grant execute on function public.refund_daily_reel_analysis(uuid, date) to service_role;
