create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated;

create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  role text not null default 'traveler',
  beta_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_role_check check (role in ('traveler', 'creator', 'admin')),
  constraint users_beta_status_check check (beta_status in ('active', 'waitlisted', 'disabled'))
);

create trigger users_set_updated_at
before update on public.users
for each row execute function private.set_updated_at();

create or replace function private.sync_auth_user_to_public_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (
    id,
    email,
    full_name,
    avatar_url,
    updated_at
  )
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url',
    now()
  )
  on conflict (id) do update
  set
    email = excluded.email,
    full_name = coalesce(excluded.full_name, public.users.full_name),
    avatar_url = coalesce(excluded.avatar_url, public.users.avatar_url),
    updated_at = now();

  return new;
end;
$$;

revoke all on function private.sync_auth_user_to_public_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_inserted on auth.users;
create trigger on_auth_user_inserted
after insert on auth.users
for each row execute function private.sync_auth_user_to_public_user();

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email, raw_user_meta_data on auth.users
for each row execute function private.sync_auth_user_to_public_user();

create table public.traveler_profiles (
  id uuid primary key references public.users(id) on delete cascade,
  origin_city text,
  travel_style_tags text[] not null default '{}',
  preference_tags text[] not null default '{}',
  preference_notes text,
  onboarding_completed boolean not null default false,
  onboarding_version integer not null default 1,
  profile_revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint traveler_profiles_onboarding_version_positive check (onboarding_version > 0),
  constraint traveler_profiles_profile_revision_positive check (profile_revision > 0)
);

create trigger traveler_profiles_set_updated_at
before update on public.traveler_profiles
for each row execute function private.set_updated_at();

create table public.user_preference_facts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null,
  fact_key text not null,
  fact_value jsonb not null,
  source text not null,
  confidence numeric not null default 1,
  status text not null default 'active',
  source_trip_id uuid,
  mem0_memory_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_preference_facts_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint user_preference_facts_status_check check (status in ('active', 'superseded', 'rejected', 'deleted')),
  constraint user_preference_facts_source_check check (source in ('onboarding', 'explicit_input', 'generation', 'feedback', 'mem0', 'manual'))
);

create trigger user_preference_facts_set_updated_at
before update on public.user_preference_facts
for each row execute function private.set_updated_at();

create table public.memory_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  trip_id uuid,
  event_type text not null,
  learned_facts_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint memory_events_event_type_check check (event_type in ('learned', 'updated', 'cleared', 'reconciled', 'failed'))
);

create table public.user_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  usage_date date not null default current_date,
  generated_trip_count integer not null default 0,
  reel_scrape_count integer not null default 0,
  hotel_search_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_daily_usage_counts_nonnegative check (
    generated_trip_count >= 0
    and reel_scrape_count >= 0
    and hotel_search_count >= 0
  ),
  constraint user_daily_usage_user_date_unique unique (user_id, usage_date)
);

create trigger user_daily_usage_set_updated_at
before update on public.user_daily_usage
for each row execute function private.set_updated_at();

create index user_preference_facts_user_id_idx on public.user_preference_facts (user_id);
create index user_preference_facts_user_status_category_idx on public.user_preference_facts (user_id, status, category);
create index user_preference_facts_mem0_memory_id_idx on public.user_preference_facts (mem0_memory_id)
where mem0_memory_id is not null;
create index memory_events_user_id_created_at_idx on public.memory_events (user_id, created_at desc);

alter table public.users enable row level security;
alter table public.traveler_profiles enable row level security;
alter table public.user_preference_facts enable row level security;
alter table public.memory_events enable row level security;
alter table public.user_daily_usage enable row level security;

grant usage on schema public to authenticated, service_role;

grant select on public.users to authenticated;
grant all on public.users to service_role;

grant select, insert, update, delete on public.traveler_profiles to authenticated;
grant all on public.traveler_profiles to service_role;

grant select, insert, update, delete on public.user_preference_facts to authenticated;
grant all on public.user_preference_facts to service_role;

grant select on public.memory_events to authenticated;
grant all on public.memory_events to service_role;

grant select on public.user_daily_usage to authenticated;
grant all on public.user_daily_usage to service_role;

create policy users_select_own
on public.users
for select
to authenticated
using ((select auth.uid()) = id);

create policy traveler_profiles_select_own
on public.traveler_profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy traveler_profiles_insert_own
on public.traveler_profiles
for insert
to authenticated
with check ((select auth.uid()) = id);

create policy traveler_profiles_update_own
on public.traveler_profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy traveler_profiles_delete_own
on public.traveler_profiles
for delete
to authenticated
using ((select auth.uid()) = id);

create policy user_preference_facts_select_own
on public.user_preference_facts
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy user_preference_facts_insert_own
on public.user_preference_facts
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and source in ('onboarding', 'explicit_input')
  and status = 'active'
  and source_trip_id is null
  and mem0_memory_id is null
);

create policy user_preference_facts_update_own
on public.user_preference_facts
for update
to authenticated
using ((select auth.uid()) = user_id)
with check (
  (select auth.uid()) = user_id
  and source in ('onboarding', 'explicit_input')
  and status = 'active'
  and source_trip_id is null
  and mem0_memory_id is null
);

create policy user_preference_facts_delete_own
on public.user_preference_facts
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy memory_events_select_own
on public.memory_events
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy user_daily_usage_select_own
on public.user_daily_usage
for select
to authenticated
using ((select auth.uid()) = user_id);
