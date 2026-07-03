# Supabase DB Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Astrail V1 database design as forward-only Supabase migrations with RLS, indexes, pgvector support, and database tests.

**Architecture:** Build the schema in four migration slices: identity/persona, trip/job backbone, global knowledge, and generated trip outputs. Every user-owned table gets RLS and ownership indexes; global cache tables are service-role write paths with tightly scoped authenticated reads where the frontend needs saved trip data.

**Tech Stack:** Supabase CLI, Supabase Auth, Postgres 15, pgvector, pgTAP database tests, public schema with RLS, private schema for trigger/worker helper functions.

---

## Sources Checked

- Repo PRD: `docs/PRD.md`, especially sections 9, 10, 14, 16, 18, 19, 21, 22, and 24.
- Repo engineering guide: `.claude/CLAUDE.md`.
- Diagram source: `docs/database/astrail-v1-erd.mmd`.
- Supabase docs via docs search:
  - Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
  - Database migrations: https://supabase.com/docs/guides/deployment/database-migrations
  - Managing environments: https://supabase.com/docs/guides/deployment/managing-environments
  - Testing and linting: https://supabase.com/docs/guides/local-development/cli/testing-and-linting
  - pgTAP testing: https://supabase.com/docs/guides/local-development/testing/overview
- Supabase Postgres best-practice files:
  - `security-rls-basics.md`
  - `security-rls-performance.md`
  - `security-privileges.md`
  - `schema-primary-keys.md`
  - `schema-foreign-key-indexes.md`
  - `schema-data-types.md`
  - `schema-constraints.md`
  - `schema-lowercase-identifiers.md`
  - `query-missing-indexes.md`
  - `query-composite-indexes.md`
  - `query-partial-indexes.md`
  - `advanced-jsonb-indexing.md`
  - `lock-skip-locked.md`

## Design Decisions Locked Into This Plan

- Use `public.users` as the app-owned mirror of Supabase `auth.users`.
- Keep app table names lowercase snake_case.
- Keep UUID IDs because Supabase Auth uses UUID user IDs and the current frontend/backend contracts expect UUID strings. Accept random UUID fragmentation for beta; revisit UUIDv7 only if the extension is available and write volume justifies it.
- Use `user_preference_facts` as the concrete implementation of the PRD's `user_preferences`.
- Store durable preference truth in Postgres; mem0 is a semantic retrieval layer, not the database of record.
- Let the backend service-role client write generation outputs and global caches.
- Let authenticated frontend clients read their own saved trips and own profile/preference data through RLS.
- Do not expose `service_role` outside the backend.
- Do not add booking/payment tables or Travala booking fields.
- Do not store private user preference data in global `location_graph_nodes` or `location_graph_edges`.

## File Structure

- Create migration files with `supabase migration new` followed by the migration name. Supabase requires CLI-created filenames, so this plan names them by stable labels:
  - `M1`: the file created by `supabase migration new identity_persona_foundation`
  - `M2`: the file created by `supabase migration new trip_job_backbone`
  - `M3`: the file created by `supabase migration new global_knowledge_foundation`
  - `M4`: the file created by `supabase migration new generated_trip_outputs`
- Create: `supabase/tests/001_identity_persona_rls.sql`
- Create: `supabase/tests/002_trip_job_rls.sql`
- Create: `supabase/tests/003_trip_outputs_rls.sql`
- Modify only if needed after SQL validation: `docs/database/astrail-v1-erd.mmd`
- Modify only if schema output differs from plan: `docs/database/README.md`

## Query And RLS Conventions

Use these patterns in every migration:

```sql
-- RLS policy predicates should wrap auth.uid() so Postgres can cache the value per statement.
using ((select auth.uid()) = user_id)

-- Update policies need both the old-row filter and the new-row check.
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id)

-- Foreign keys must get explicit indexes on the referencing side.
create index table_name_user_id_idx on public.table_name (user_id);

-- User-owned list views should usually get this index shape.
create index table_name_user_status_created_at_idx
  on public.table_name (user_id, status, created_at desc);
```

## Task 1: Supabase CLI Preflight

**Files:**
- Read: `supabase/config.toml`
- No code changes.

- [ ] **Step 1: Confirm CLI entry points before generating migrations**

Run:

```powershell
supabase --version
supabase --help
supabase migration new --help
supabase db reset --help
supabase test db --help
supabase db lint --help
```

Expected:

```text
Each command prints help text. If `supabase` is not recognized, install Supabase CLI before continuing.
```

- [ ] **Step 2: Start the local stack**

Run:

```powershell
supabase start
```

Expected:

```text
Local Supabase services start successfully and Studio is available.
```

- [ ] **Step 3: Commit checkpoint if the project config had to be changed**

Run only if `supabase/config.toml` changed:

```powershell
git add supabase/config.toml
git commit -m "chore(supabase): prepare local database config"
```

Expected:

```text
No commit is needed if `supabase/config.toml` was already usable.
```

## Task 2: Migration M1 - Identity And Persona Foundation

**Files:**
- Create: `M1`, generated by `supabase migration new identity_persona_foundation`
- Test later: `supabase/tests/001_identity_persona_rls.sql`

- [ ] **Step 1: Generate the migration with Supabase CLI**

Run:

```powershell
supabase migration new identity_persona_foundation
```

Expected:

```text
Created a timestamped migration path ending in `_identity_persona_foundation.sql`.
```

- [ ] **Step 2: Add the identity/persona SQL to M1**

Paste this full SQL into the generated M1 file:

```sql
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
create index user_daily_usage_user_id_usage_date_idx on public.user_daily_usage (user_id, usage_date desc);

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
with check ((select auth.uid()) = user_id);

create policy user_preference_facts_update_own
on public.user_preference_facts
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

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
```

- [ ] **Step 3: Apply M1 locally**

Run:

```powershell
supabase db reset
```

Expected:

```text
The local database resets and applies M1 without SQL errors.
```

- [ ] **Step 4: Commit M1**

Run:

```powershell
git add supabase/migrations
git commit -m "feat(database): add identity persona foundation"
```

Expected:

```text
Commit succeeds with only the M1 migration staged.
```

## Task 3: Test M1 RLS And Persona Tables

**Files:**
- Create: `supabase/tests/001_identity_persona_rls.sql`

- [ ] **Step 1: Create the test file**

Create `supabase/tests/001_identity_persona_rls.sql` with:

```sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

select has_table('public', 'users', 'users table exists');
select has_table('public', 'traveler_profiles', 'traveler_profiles table exists');
select has_table('public', 'user_preference_facts', 'user_preference_facts table exists');
select has_table('public', 'memory_events', 'memory_events table exists');
select has_table('public', 'user_daily_usage', 'user_daily_usage table exists');

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000101', 'traveler-a@example.com'),
  ('00000000-0000-0000-0000-000000000202', 'traveler-b@example.com');

select is(
  (select count(*) from public.users),
  2::bigint,
  'auth trigger mirrors users into public.users'
);

insert into public.traveler_profiles (id, origin_city, travel_style_tags, onboarding_completed)
values
  ('00000000-0000-0000-0000-000000000101', 'Kuala Lumpur', array['balanced', 'food-led'], true),
  ('00000000-0000-0000-0000-000000000202', 'Singapore', array['packed'], true);

insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence)
values
  ('00000000-0000-0000-0000-000000000101', 'food', 'likes', '{"value":"ramen"}', 'onboarding', 0.9),
  ('00000000-0000-0000-0000-000000000202', 'pace', 'prefers', '{"value":"packed"}', 'onboarding', 0.8);

insert into public.memory_events (user_id, event_type, learned_facts_json)
values
  ('00000000-0000-0000-0000-000000000101', 'learned', '[{"fact":"likes ramen"}]'),
  ('00000000-0000-0000-0000-000000000202', 'learned', '[{"fact":"packed pace"}]');

insert into public.user_daily_usage (user_id, usage_date, generated_trip_count)
values
  ('00000000-0000-0000-0000-000000000101', current_date, 1),
  ('00000000-0000-0000-0000-000000000202', current_date, 2);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated"}';

select results_eq(
  $$select email from public.users order by email$$,
  $$values ('traveler-a@example.com'::text)$$,
  'traveler A can only read their own public user row'
);

select results_eq(
  $$select origin_city from public.traveler_profiles$$,
  $$values ('Kuala Lumpur'::text)$$,
  'traveler A can only read their own traveler profile'
);

select lives_ok(
  $$insert into public.traveler_profiles (id, origin_city) values ('00000000-0000-0000-0000-000000000101', 'Tokyo') on conflict (id) do update set origin_city = excluded.origin_city$$,
  'traveler A can upsert their own traveler profile'
);

select throws_ok(
  $$insert into public.traveler_profiles (id, origin_city) values ('00000000-0000-0000-0000-000000000202', 'Osaka') on conflict (id) do update set origin_city = excluded.origin_city$$,
  '42501',
  'new row violates row-level security policy for table "traveler_profiles"',
  'traveler A cannot upsert traveler B profile'
);

select results_eq(
  $$select fact_value ->> 'value' from public.user_preference_facts order by fact_key$$,
  $$values ('ramen'::text)$$,
  'traveler A can only read their own preference facts'
);

select results_eq(
  $$select generated_trip_count from public.user_daily_usage$$,
  $$values (1::integer)$$,
  'traveler A can only read their own quota row'
);

select results_eq(
  $$select learned_facts_json -> 0 ->> 'fact' from public.memory_events$$,
  $$values ('likes ramen'::text)$$,
  'traveler A can only read their own memory event'
);

reset role;

select throws_ok(
  $$insert into public.user_daily_usage (user_id, usage_date) values ('00000000-0000-0000-0000-000000000101', current_date)$$,
  '23505',
  null,
  'one usage row per user per day is enforced'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run the M1 database test**

Run:

```powershell
supabase test db supabase/tests/001_identity_persona_rls.sql
```

Expected:

```text
All tests successful.
```

- [ ] **Step 3: Commit the M1 tests**

Run:

```powershell
git add supabase/tests/001_identity_persona_rls.sql
git commit -m "test(database): cover identity persona rls"
```

Expected:

```text
Commit succeeds with only the M1 test staged.
```

## Task 4: Migration M2 - Trip, Job, And Generation Event Backbone

**Files:**
- Create: `M2`, generated by `supabase migration new trip_job_backbone`
- Test later: `supabase/tests/002_trip_job_rls.sql`

- [ ] **Step 1: Generate the migration with Supabase CLI**

Run:

```powershell
supabase migration new trip_job_backbone
```

Expected:

```text
Created a timestamped migration path ending in `_trip_job_backbone.sql`.
```

- [ ] **Step 2: Add the trip/job SQL to M2**

Paste this full SQL into M2:

```sql
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
  trip_id uuid not null references public.trips(id) on delete cascade,
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

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'memory_events_trip_id_fkey'
      and conrelid = 'public.memory_events'::regclass
  ) then
    alter table public.memory_events
    add constraint memory_events_trip_id_fkey
    foreign key (trip_id) references public.trips(id) on delete set null;
  end if;
end $$;

create index trips_user_id_idx on public.trips (user_id);
create index trips_user_status_created_at_idx on public.trips (user_id, status, created_at desc);
create index jobs_trip_id_idx on public.jobs (trip_id);
create index jobs_user_id_idx on public.jobs (user_id);
create index jobs_status_created_at_idx on public.jobs (status, created_at);
create index jobs_pending_created_at_idx on public.jobs (created_at)
where status in ('pending', 'retryable');
create index generation_events_trip_id_created_at_idx on public.generation_events (trip_id, created_at);
create index memory_events_trip_id_idx on public.memory_events (trip_id)
where trip_id is not null;

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
```

- [ ] **Step 3: Apply M2 locally**

Run:

```powershell
supabase db reset
```

Expected:

```text
The local database resets and applies M1 and M2 without SQL errors.
```

- [ ] **Step 4: Commit M2**

Run:

```powershell
git add supabase/migrations
git commit -m "feat(database): add trip job backbone"
```

Expected:

```text
Commit succeeds with only the M2 migration staged.
```

## Task 5: Test M2 RLS And Job Constraints

**Files:**
- Create: `supabase/tests/002_trip_job_rls.sql`

- [ ] **Step 1: Create the M2 test file**

Create `supabase/tests/002_trip_job_rls.sql` with:

```sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000301', 'trip-a@example.com'),
  ('00000000-0000-0000-0000-000000000302', 'trip-b@example.com');

insert into public.trips (id, user_id, status, destination_hint, adult_count, child_count, room_count)
values
  ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'generating', 'Tokyo', 2, 0, 1),
  ('10000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000302', 'complete', 'Osaka', 1, 0, 1);

insert into public.jobs (id, trip_id, user_id, idempotency_key, status)
values
  ('20000000-0000-0000-0000-000000000301', '10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'trip-a-key', 'pending'),
  ('20000000-0000-0000-0000-000000000302', '10000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000302', 'trip-b-key', 'pending');

insert into public.generation_events (trip_id, event_type, stage, message)
values
  ('10000000-0000-0000-0000-000000000301', 'stage', 'scrape', 'Scraped 1 Reel.'),
  ('10000000-0000-0000-0000-000000000302', 'stage', 'scrape', 'Scraped 2 Reels.');

select has_table('public', 'trips', 'trips table exists');
select has_table('public', 'jobs', 'jobs table exists');
select has_table('public', 'generation_events', 'generation_events table exists');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000301';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000301","role":"authenticated"}';

select results_eq(
  $$select destination_hint from public.trips order by destination_hint$$,
  $$values ('Tokyo'::text)$$,
  'traveler A can only read their own trips'
);

select results_eq(
  $$select idempotency_key from public.jobs order by idempotency_key$$,
  $$values ('trip-a-key'::text)$$,
  'traveler A can only read their own jobs'
);

select results_eq(
  $$select message from public.generation_events order by created_at$$,
  $$values ('Scraped 1 Reel.'::text)$$,
  'traveler A can only read generation events for own trip'
);

select throws_ok(
  $$insert into public.trips (user_id, destination_hint) values ('00000000-0000-0000-0000-000000000301', 'Kyoto')$$,
  '42501',
  'permission denied for table trips',
  'authenticated clients cannot insert trips directly'
);

select throws_ok(
  $$insert into public.jobs (trip_id, user_id, idempotency_key) values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'frontend-job')$$,
  '42501',
  'permission denied for table jobs',
  'authenticated clients cannot insert jobs directly'
);

reset role;

select throws_ok(
  $$insert into public.jobs (trip_id, user_id, idempotency_key) values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'trip-a-key')$$,
  '23505',
  null,
  'job idempotency key is unique'
);

select throws_ok(
  $$insert into public.trips (user_id, status, adult_count, room_count) values ('00000000-0000-0000-0000-000000000301', 'draft', 0, 1)$$,
  '23514',
  null,
  'trip adult count must be positive'
);

select isnt_empty(
  $$select private.claim_next_generation_job()$$,
  'service-side claim helper can claim one pending job'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Run the M2 database test**

Run:

```powershell
supabase test db supabase/tests/002_trip_job_rls.sql
```

Expected:

```text
All tests successful.
```

- [ ] **Step 3: Commit the M2 tests**

Run:

```powershell
git add supabase/tests/002_trip_job_rls.sql
git commit -m "test(database): cover trip job rls"
```

Expected:

```text
Commit succeeds with only the M2 test staged.
```

## Task 6: Migration M3 - Global Knowledge Foundation

**Files:**
- Create: `M3`, generated by `supabase migration new global_knowledge_foundation`
- Test later through `supabase/tests/003_trip_outputs_rls.sql`

- [ ] **Step 1: Generate the migration with Supabase CLI**

Run:

```powershell
supabase migration new global_knowledge_foundation
```

Expected:

```text
Created a timestamped migration path ending in `_global_knowledge_foundation.sql`.
```

- [ ] **Step 2: Add global knowledge SQL to M3**

Paste this full SQL into M3:

```sql
create extension if not exists vector with schema extensions;

create table public.reel_cache (
  id uuid primary key default gen_random_uuid(),
  normalized_url text not null,
  source_platform text not null default 'instagram',
  caption text,
  location_name text,
  transcript text,
  thumbnail_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  scraped_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint reel_cache_normalized_url_unique unique (normalized_url),
  constraint reel_cache_source_platform_check check (source_platform in ('instagram', 'tiktok', 'manual'))
);

create table public.places (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  place_type text not null,
  lat double precision not null,
  lng double precision not null,
  country text,
  city text,
  area text,
  aliases text[] not null default '{}',
  source_summary jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint places_lat_range check (lat >= -90 and lat <= 90),
  constraint places_lng_range check (lng >= -180 and lng <= 180),
  constraint places_place_type_check check (place_type in ('attraction', 'restaurant', 'hotel', 'area', 'city', 'country', 'station', 'shop', 'other'))
);

create trigger places_set_updated_at
before update on public.places
for each row execute function private.set_updated_at();

create table public.trip_inspiration_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  item_type text not null,
  source text not null,
  normalized_reel_url text,
  reel_cache_id uuid references public.reel_cache(id) on delete set null,
  requested_place_text text,
  resolved_place_id uuid references public.places(id) on delete set null,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_inspiration_items_item_type_check check (item_type in ('reel_url', 'requested_place')),
  constraint trip_inspiration_items_source_check check (source in ('manual_paste', 'clipboard', 'web_share_target', 'manual_input')),
  constraint trip_inspiration_items_status_check check (
    status in (
      'valid',
      'invalid',
      'duplicate',
      'queued',
      'cached',
      'processing',
      'places_found',
      'needs_review',
      'failed',
      'pending_resolution',
      'resolved',
      'ambiguous',
      'unresolved'
    )
  ),
  constraint trip_inspiration_items_reel_shape_check check (
    (item_type = 'reel_url' and normalized_reel_url is not null)
    or (item_type = 'requested_place' and requested_place_text is not null)
  )
);

create trigger trip_inspiration_items_set_updated_at
before update on public.trip_inspiration_items
for each row execute function private.set_updated_at();

create table public.trip_places (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  place_id uuid not null references public.places(id) on delete restrict,
  source_type text not null,
  evidence_json jsonb not null default '{}'::jsonb,
  day_number integer,
  sort_order integer,
  created_at timestamptz not null default now(),
  constraint trip_places_source_type_check check (source_type in ('reel_extracted', 'user_requested', 'agent_suggested')),
  constraint trip_places_day_number_positive check (day_number is null or day_number > 0),
  constraint trip_places_sort_order_nonnegative check (sort_order is null or sort_order >= 0),
  constraint trip_places_trip_place_unique unique (trip_id, place_id)
);

create table public.location_graph_nodes (
  id uuid primary key default gen_random_uuid(),
  node_type text not null,
  ref_table text,
  ref_id uuid,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_graph_nodes_node_type_check check (node_type in ('reel', 'place', 'area', 'city', 'country', 'hotel_search_snapshot', 'restaurant_suggestion'))
);

create trigger location_graph_nodes_set_updated_at
before update on public.location_graph_nodes
for each row execute function private.set_updated_at();

create table public.location_graph_edges (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references public.location_graph_nodes(id) on delete cascade,
  to_node_id uuid not null references public.location_graph_nodes(id) on delete cascade,
  edge_type text not null,
  evidence_json jsonb not null default '{}'::jsonb,
  confidence numeric not null default 1,
  created_at timestamptz not null default now(),
  constraint location_graph_edges_edge_type_check check (edge_type in ('mentions_place', 'near', 'in_area', 'used_in_trip', 'has_hotel_search', 'suggested_with')),
  constraint location_graph_edges_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint location_graph_edges_no_self_edge check (from_node_id <> to_node_id)
);

create index reel_cache_normalized_url_idx on public.reel_cache (normalized_url);
create index reel_cache_expires_at_idx on public.reel_cache (expires_at)
where expires_at is not null;
create index places_type_city_area_idx on public.places (place_type, country, city, area);
create index places_lat_lng_idx on public.places (lat, lng);
create index places_embedding_hnsw_idx on public.places using hnsw (embedding vector_cosine_ops)
where embedding is not null;
create index trip_inspiration_items_trip_id_idx on public.trip_inspiration_items (trip_id);
create index trip_inspiration_items_reel_cache_id_idx on public.trip_inspiration_items (reel_cache_id)
where reel_cache_id is not null;
create index trip_inspiration_items_resolved_place_id_idx on public.trip_inspiration_items (resolved_place_id)
where resolved_place_id is not null;
create index trip_places_trip_id_idx on public.trip_places (trip_id);
create index trip_places_place_id_idx on public.trip_places (place_id);
create index location_graph_nodes_ref_idx on public.location_graph_nodes (ref_table, ref_id)
where ref_table is not null and ref_id is not null;
create index location_graph_nodes_properties_gin_idx on public.location_graph_nodes using gin (properties jsonb_path_ops);
create index location_graph_edges_from_node_id_idx on public.location_graph_edges (from_node_id);
create index location_graph_edges_to_node_id_idx on public.location_graph_edges (to_node_id);
create index location_graph_edges_type_created_at_idx on public.location_graph_edges (edge_type, created_at desc);

alter table public.reel_cache enable row level security;
alter table public.places enable row level security;
alter table public.trip_inspiration_items enable row level security;
alter table public.trip_places enable row level security;
alter table public.location_graph_nodes enable row level security;
alter table public.location_graph_edges enable row level security;

grant all on public.reel_cache to service_role;
grant select on public.places to authenticated;
grant all on public.places to service_role;
grant select on public.trip_inspiration_items to authenticated;
grant all on public.trip_inspiration_items to service_role;
grant select on public.trip_places to authenticated;
grant all on public.trip_places to service_role;
grant all on public.location_graph_nodes to service_role;
grant all on public.location_graph_edges to service_role;

create policy trip_inspiration_items_select_own_trip
on public.trip_inspiration_items
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = trip_inspiration_items.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy trip_places_select_own_trip
on public.trip_places
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = trip_places.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy places_select_when_used_in_own_trip
on public.places
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_places
    join public.trips on trips.id = trip_places.trip_id
    where trip_places.place_id = places.id
      and trips.user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.trip_inspiration_items
    join public.trips on trips.id = trip_inspiration_items.trip_id
    where trip_inspiration_items.resolved_place_id = places.id
      and trips.user_id = (select auth.uid())
  )
);
```

- [ ] **Step 3: Apply M3 locally**

Run:

```powershell
supabase db reset
```

Expected:

```text
The local database resets and applies M1, M2, and M3 without SQL errors.
```

- [ ] **Step 4: Commit M3**

Run:

```powershell
git add supabase/migrations
git commit -m "feat(database): add global knowledge schema"
```

Expected:

```text
Commit succeeds with only the M3 migration staged.
```

## Task 7: Migration M4 - Generated Trip Outputs

**Files:**
- Create: `M4`, generated by `supabase migration new generated_trip_outputs`
- Test later: `supabase/tests/003_trip_outputs_rls.sql`

- [ ] **Step 1: Generate the migration with Supabase CLI**

Run:

```powershell
supabase migration new generated_trip_outputs
```

Expected:

```text
Created a timestamped migration path ending in `_generated_trip_outputs.sql`.
```

- [ ] **Step 2: Add generated output SQL to M4**

Paste this full SQL into M4:

```sql
create table public.trip_days (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  day_number integer not null,
  day_date date,
  title text,
  summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trip_days_day_number_positive check (day_number > 0),
  constraint trip_days_trip_day_unique unique (trip_id, day_number)
);

create trigger trip_days_set_updated_at
before update on public.trip_days
for each row execute function private.set_updated_at();

create table public.transport_legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid references public.trip_days(id) on delete set null,
  from_place_id uuid references public.places(id) on delete set null,
  to_place_id uuid references public.places(id) on delete set null,
  leg_order integer not null,
  transport_mode text not null,
  routing_provider text not null default 'mapbox',
  routing_profile text,
  status text not null default 'pending',
  duration_seconds integer,
  distance_meters integer,
  route_geometry jsonb,
  warning text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint transport_legs_leg_order_nonnegative check (leg_order >= 0),
  constraint transport_legs_transport_mode_check check (transport_mode in ('walk', 'drive', 'cycle', 'transit_hint', 'unknown')),
  constraint transport_legs_routing_provider_check check (routing_provider in ('mapbox', 'manual', 'none')),
  constraint transport_legs_routing_profile_check check (routing_profile is null or routing_profile in ('walking', 'driving', 'driving-traffic', 'cycling')),
  constraint transport_legs_status_check check (status in ('pending', 'ok', 'no_route', 'failed', 'skipped')),
  constraint transport_legs_duration_nonnegative check (duration_seconds is null or duration_seconds >= 0),
  constraint transport_legs_distance_nonnegative check (distance_meters is null or distance_meters >= 0)
);

create table public.restaurant_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid references public.trip_days(id) on delete set null,
  restaurant_place_id uuid references public.places(id) on delete set null,
  near_place_id uuid references public.places(id) on delete set null,
  cuisine text,
  summary text not null,
  source_url text,
  evidence_json jsonb not null default '{}'::jsonb,
  preference_match_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.hotel_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid references public.trip_days(id) on delete set null,
  base_place_id uuid references public.places(id) on delete set null,
  name text not null,
  area text,
  star_rating numeric,
  price_snapshot jsonb not null default '{}'::jsonb,
  travala_hotel_id text,
  travala_session_id text,
  travala_package_id text,
  travala_result_json jsonb not null default '{}'::jsonb,
  preference_match_json jsonb not null default '{}'::jsonb,
  source text not null default 'travala',
  status text not null default 'suggested',
  searched_at timestamptz,
  created_at timestamptz not null default now(),
  constraint hotel_suggestions_star_rating_range check (star_rating is null or (star_rating >= 0 and star_rating <= 5)),
  constraint hotel_suggestions_source_check check (source in ('travala', 'manual', 'agent')),
  constraint hotel_suggestions_status_check check (status in ('suggested', 'unavailable', 'skipped', 'failed'))
);

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  artifact_type text not null,
  artifact_id uuid,
  feedback_type text not null,
  rating integer,
  comment text,
  source_type text,
  generation_stage text,
  preference_source text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint feedback_artifact_type_check check (artifact_type in ('trip', 'place', 'transport_leg', 'restaurant_suggestion', 'hotel_suggestion', 'generation_event')),
  constraint feedback_feedback_type_check check (feedback_type in ('rating', 'thumbs_up', 'thumbs_down', 'correction', 'free_text')),
  constraint feedback_rating_range check (rating is null or (rating >= 1 and rating <= 5)),
  constraint feedback_preference_source_check check (preference_source is null or preference_source in ('explicit', 'memory', 'inferred_default'))
);

create index trip_days_trip_id_idx on public.trip_days (trip_id);
create index transport_legs_trip_id_idx on public.transport_legs (trip_id);
create index transport_legs_trip_day_id_idx on public.transport_legs (trip_day_id)
where trip_day_id is not null;
create index transport_legs_from_place_id_idx on public.transport_legs (from_place_id)
where from_place_id is not null;
create index transport_legs_to_place_id_idx on public.transport_legs (to_place_id)
where to_place_id is not null;
create index transport_legs_trip_day_order_idx on public.transport_legs (trip_id, trip_day_id, leg_order);
create index restaurant_suggestions_trip_id_idx on public.restaurant_suggestions (trip_id);
create index restaurant_suggestions_trip_day_id_idx on public.restaurant_suggestions (trip_day_id)
where trip_day_id is not null;
create index restaurant_suggestions_restaurant_place_id_idx on public.restaurant_suggestions (restaurant_place_id)
where restaurant_place_id is not null;
create index restaurant_suggestions_near_place_id_idx on public.restaurant_suggestions (near_place_id)
where near_place_id is not null;
create index hotel_suggestions_trip_id_idx on public.hotel_suggestions (trip_id);
create index hotel_suggestions_trip_day_id_idx on public.hotel_suggestions (trip_day_id)
where trip_day_id is not null;
create index hotel_suggestions_base_place_id_idx on public.hotel_suggestions (base_place_id)
where base_place_id is not null;
create index hotel_suggestions_travala_hotel_id_idx on public.hotel_suggestions (travala_hotel_id)
where travala_hotel_id is not null;
create index feedback_trip_id_idx on public.feedback (trip_id);
create index feedback_user_id_created_at_idx on public.feedback (user_id, created_at desc);

alter table public.trip_days enable row level security;
alter table public.transport_legs enable row level security;
alter table public.restaurant_suggestions enable row level security;
alter table public.hotel_suggestions enable row level security;
alter table public.feedback enable row level security;

grant select on public.trip_days to authenticated;
grant all on public.trip_days to service_role;
grant select on public.transport_legs to authenticated;
grant all on public.transport_legs to service_role;
grant select on public.restaurant_suggestions to authenticated;
grant all on public.restaurant_suggestions to service_role;
grant select on public.hotel_suggestions to authenticated;
grant all on public.hotel_suggestions to service_role;
grant select, insert on public.feedback to authenticated;
grant all on public.feedback to service_role;

create policy trip_days_select_own_trip
on public.trip_days
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = trip_days.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy transport_legs_select_own_trip
on public.transport_legs
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = transport_legs.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy restaurant_suggestions_select_own_trip
on public.restaurant_suggestions
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = restaurant_suggestions.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy hotel_suggestions_select_own_trip
on public.hotel_suggestions
for select
to authenticated
using (
  exists (
    select 1
    from public.trips
    where trips.id = hotel_suggestions.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy feedback_select_own_trip
on public.feedback
for select
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.trips
    where trips.id = feedback.trip_id
      and trips.user_id = (select auth.uid())
  )
);

create policy feedback_insert_own_trip
on public.feedback
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.trips
    where trips.id = feedback.trip_id
      and trips.user_id = (select auth.uid())
  )
);

drop policy places_select_when_used_in_own_trip on public.places;

create policy places_select_when_used_in_own_trip
on public.places
for select
to authenticated
using (
  exists (
    select 1
    from public.trip_places
    join public.trips on trips.id = trip_places.trip_id
    where trip_places.place_id = places.id
      and trips.user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.trip_inspiration_items
    join public.trips on trips.id = trip_inspiration_items.trip_id
    where trip_inspiration_items.resolved_place_id = places.id
      and trips.user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.transport_legs
    join public.trips on trips.id = transport_legs.trip_id
    where trips.user_id = (select auth.uid())
      and (transport_legs.from_place_id = places.id or transport_legs.to_place_id = places.id)
  )
  or exists (
    select 1
    from public.restaurant_suggestions
    join public.trips on trips.id = restaurant_suggestions.trip_id
    where trips.user_id = (select auth.uid())
      and (
        restaurant_suggestions.restaurant_place_id = places.id
        or restaurant_suggestions.near_place_id = places.id
      )
  )
  or exists (
    select 1
    from public.hotel_suggestions
    join public.trips on trips.id = hotel_suggestions.trip_id
    where hotel_suggestions.base_place_id = places.id
      and trips.user_id = (select auth.uid())
  )
);
```

- [ ] **Step 3: Apply M4 locally**

Run:

```powershell
supabase db reset
```

Expected:

```text
The local database resets and applies all four migrations without SQL errors.
```

- [ ] **Step 4: Commit M4**

Run:

```powershell
git add supabase/migrations
git commit -m "feat(database): add generated trip output schema"
```

Expected:

```text
Commit succeeds with only the M4 migration staged.
```

## Task 8: Test M3 And M4 Output RLS

**Files:**
- Create: `supabase/tests/003_trip_outputs_rls.sql`

- [ ] **Step 1: Create the output RLS test file**

Create `supabase/tests/003_trip_outputs_rls.sql` with:

```sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000401', 'output-a@example.com'),
  ('00000000-0000-0000-0000-000000000402', 'output-b@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values
  ('10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000401', 'complete', 'Tokyo'),
  ('10000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000402', 'complete', 'Kyoto');

insert into public.reel_cache (id, normalized_url, caption)
values
  ('30000000-0000-0000-0000-000000000401', 'https://www.instagram.com/reel/a/', 'Tokyo reel'),
  ('30000000-0000-0000-0000-000000000402', 'https://www.instagram.com/reel/b/', 'Kyoto reel');

insert into public.places (id, name, place_type, lat, lng, country, city)
values
  ('40000000-0000-0000-0000-000000000401', 'Tokyo Tower', 'attraction', 35.6586, 139.7454, 'Japan', 'Tokyo'),
  ('40000000-0000-0000-0000-000000000402', 'Kyoto Tower', 'attraction', 34.9875, 135.7593, 'Japan', 'Kyoto'),
  ('40000000-0000-0000-0000-000000000403', 'Ramen Near Tokyo Tower', 'restaurant', 35.6590, 139.7460, 'Japan', 'Tokyo'),
  ('40000000-0000-0000-0000-000000000404', 'Tokyo Station Base', 'hotel', 35.6812, 139.7671, 'Japan', 'Tokyo');

insert into public.trip_inspiration_items (trip_id, item_type, source, normalized_reel_url, reel_cache_id, status)
values
  ('10000000-0000-0000-0000-000000000401', 'reel_url', 'manual_paste', 'https://www.instagram.com/reel/a/', '30000000-0000-0000-0000-000000000401', 'places_found'),
  ('10000000-0000-0000-0000-000000000402', 'reel_url', 'manual_paste', 'https://www.instagram.com/reel/b/', '30000000-0000-0000-0000-000000000402', 'places_found');

insert into public.trip_places (trip_id, place_id, source_type, day_number, sort_order)
values
  ('10000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000401', 'reel_extracted', 1, 1),
  ('10000000-0000-0000-0000-000000000402', '40000000-0000-0000-0000-000000000402', 'reel_extracted', 1, 1);

insert into public.trip_days (id, trip_id, day_number, day_date, title)
values
  ('50000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000401', 1, '2026-12-01', 'Tokyo arrival'),
  ('50000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000402', 1, '2026-12-02', 'Kyoto arrival');

insert into public.transport_legs (trip_id, trip_day_id, from_place_id, to_place_id, leg_order, transport_mode, routing_provider, routing_profile, status, duration_seconds, distance_meters)
values
  ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000404', 1, 'walk', 'mapbox', 'walking', 'ok', 900, 1200);

insert into public.restaurant_suggestions (trip_id, trip_day_id, restaurant_place_id, near_place_id, cuisine, summary)
values
  ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000403', '40000000-0000-0000-0000-000000000401', 'ramen', 'Good ramen near Tokyo Tower.');

insert into public.hotel_suggestions (trip_id, trip_day_id, base_place_id, name, area, source, status)
values
  ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000404', 'Tokyo Station Base', 'Tokyo Station', 'travala', 'suggested');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000401';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000401","role":"authenticated"}';

select results_eq(
  $$select count(*) from public.trip_inspiration_items$$,
  $$values (1::bigint)$$,
  'traveler A can read only own inspiration items'
);

select results_eq(
  $$select name from public.places order by name$$,
  $$values ('Ramen Near Tokyo Tower'::text), ('Tokyo Station Base'::text), ('Tokyo Tower'::text)$$,
  'traveler A can read places connected to own trip outputs'
);

select results_eq(
  $$select count(*) from public.trip_places$$,
  $$values (1::bigint)$$,
  'traveler A can read own trip places'
);

select results_eq(
  $$select title from public.trip_days$$,
  $$values ('Tokyo arrival'::text)$$,
  'traveler A can read own trip days'
);

select results_eq(
  $$select duration_seconds from public.transport_legs$$,
  $$values (900::integer)$$,
  'traveler A can read own transport legs'
);

select results_eq(
  $$select cuisine from public.restaurant_suggestions$$,
  $$values ('ramen'::text)$$,
  'traveler A can read own restaurant suggestions'
);

select results_eq(
  $$select source from public.hotel_suggestions$$,
  $$values ('travala'::text)$$,
  'traveler A can read own hotel suggestions'
);

select lives_ok(
  $$insert into public.feedback (trip_id, user_id, artifact_type, feedback_type, rating, preference_source) values ('10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000401', 'trip', 'rating', 5, 'explicit')$$,
  'traveler A can insert feedback on own trip'
);

select throws_ok(
  $$insert into public.feedback (trip_id, user_id, artifact_type, feedback_type, rating, preference_source) values ('10000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000401', 'trip', 'rating', 1, 'explicit')$$,
  '42501',
  'new row violates row-level security policy for table "feedback"',
  'traveler A cannot insert feedback on traveler B trip'
);

select throws_ok(
  $$select count(*) from public.reel_cache$$,
  '42501',
  'permission denied for table reel_cache',
  'authenticated clients cannot read global reel cache directly'
);

reset role;

select throws_ok(
  $$insert into public.places (name, place_type, lat, lng) values ('Bad lat', 'attraction', 120, 139)$$,
  '23514',
  null,
  'place latitude bounds are enforced'
);

select throws_ok(
  $$insert into public.transport_legs (trip_id, leg_order, transport_mode, routing_provider, status, duration_seconds) values ('10000000-0000-0000-0000-000000000401', 1, 'walk', 'mapbox', 'ok', -1)$$,
  '23514',
  null,
  'transport duration cannot be negative'
);

select has_index('public', 'places', 'places_lat_lng_idx', 'places lat/lng index exists');
select has_index('public', 'transport_legs', 'transport_legs_trip_day_order_idx', 'transport leg ordering index exists');
select has_index('public', 'feedback', 'feedback_user_id_created_at_idx', 'feedback owner index exists');

select * from finish();

rollback;
```

- [ ] **Step 2: Run the output RLS test**

Run:

```powershell
supabase test db supabase/tests/003_trip_outputs_rls.sql
```

Expected:

```text
All tests successful.
```

- [ ] **Step 3: Commit the output tests**

Run:

```powershell
git add supabase/tests/003_trip_outputs_rls.sql
git commit -m "test(database): cover trip output rls"
```

Expected:

```text
Commit succeeds with only the M3/M4 test staged.
```

## Task 9: Run Full Database Verification

**Files:**
- Read: `supabase/migrations/*.sql`
- Read: `supabase/tests/*.sql`

- [ ] **Step 1: Reset the database from all migrations**

Run:

```powershell
supabase db reset
```

Expected:

```text
The local database resets from all migrations with no errors.
```

- [ ] **Step 2: Run all database tests**

Run:

```powershell
supabase test db
```

Expected:

```text
All tests successful.
```

- [ ] **Step 3: Run database lint**

Run:

```powershell
supabase db lint
```

Expected:

```text
No errors. Review warnings individually before deciding whether to change SQL.
```

- [ ] **Step 4: Check migration status**

Run:

```powershell
supabase migration list
```

Expected:

```text
Local migrations are listed in timestamp order. If the project is not linked, the command should still confirm local migration files or explain that remote status requires `supabase link`.
```

- [ ] **Step 5: Inspect missing foreign-key indexes**

Run this in the local SQL editor or with a local SQL query command:

```sql
select
  conrelid::regclass as table_name,
  a.attname as fk_column
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
where c.contype = 'f'
  and c.connamespace = 'public'::regnamespace
  and not exists (
    select 1
    from pg_index i
    where i.indrelid = c.conrelid
      and a.attnum = any(i.indkey)
  )
order by table_name::text, a.attname;
```

Expected:

```text
Zero rows for app tables. Primary-key-backed one-to-one links such as traveler_profiles.id are acceptable if they appear because the PK already indexes the same column.
```

- [ ] **Step 6: Commit verification-only fixes**

Run only if verification forced a SQL/test fix:

```powershell
git add supabase/migrations supabase/tests
git commit -m "fix(database): tighten schema verification"
```

Expected:

```text
No commit is needed if verification passed without changes.
```

## Task 10: Backend Integration Plan Checkpoint

**Files:**
- Read: `backend/supabase_client.py`
- Read: `backend/auth.py`
- Read: `backend/jobs.py`
- Read: `backend/pipeline/cache.py`
- Read: `backend/pipeline/dedup.py`
- Read: `backend/api/schemas.py`
- Read: `frontend/lib/trip/backend-types.ts`

- [ ] **Step 1: Record backend contracts that now have database support**

Add this checklist to the issue or execution notes:

```markdown
Database contracts now available:

- `public.users`: app-owned Supabase Auth mirror.
- `public.traveler_profiles`: lightweight onboarding profile.
- `public.user_preference_facts`: structured preference source of truth.
- `public.trips`: saved trip artifact and preference snapshots.
- `public.jobs`: durable pipeline work ticket with idempotency key.
- `private.claim_next_generation_job()`: service-role job claim helper using `for update skip locked`.
- `public.generation_events`: user-visible decision timeline.
- `public.reel_cache`: service-role Reel scrape cache by normalized URL.
- `public.places`: canonical place cache with pgvector embedding.
- `public.trip_inspiration_items`: submitted Reels and requested places per trip.
- `public.trip_places`: final verified places per trip.
- `public.trip_days`: date-backed itinerary days.
- `public.transport_legs`: Mapbox route legs per trip/day.
- `public.restaurant_suggestions`: route-aware food suggestions.
- `public.hotel_suggestions`: Travala search snapshots and normalized cards.
- `public.feedback`: beta trip/artifact feedback.
- `public.user_daily_usage`: quota counters.
- `public.location_graph_nodes` and `public.location_graph_edges`: global reusable knowledge graph.
```

Expected:

```text
The next implementation plan can wire backend reads/writes against concrete table names instead of the Mermaid draft.
```

- [ ] **Step 2: Decide whether generated TypeScript DB types are in scope**

If the project installs Supabase CLI type generation in this sprint, run:

```powershell
supabase gen types typescript --local > frontend/lib/supabase/database.types.ts
```

Expected:

```text
`frontend/lib/supabase/database.types.ts` is created and checked into git only if frontend integration will consume it in the same sprint.
```

If type generation is deferred, record:

```markdown
Deferred: generated Supabase TypeScript DB types. Frontend still consumes `frontend/lib/trip/backend-types.ts` until direct table reads are wired.
```

- [ ] **Step 3: Final schema commit**

Run:

```powershell
git status --short
git log --oneline -5
```

Expected:

```text
Only intentional migration/test/type files are uncommitted. Recent commits show the database work in small reviewable slices.
```

Commit any remaining intentional schema/test files:

```powershell
git add supabase/migrations supabase/tests frontend/lib/supabase/database.types.ts
git commit -m "feat(database): finish v1 supabase schema"
```

Expected:

```text
Commit succeeds if there are remaining intentional files. If all files were committed in earlier tasks, this step produces no commit.
```

## Self-Review

### Spec Coverage

- Traveler onboarding: M1 creates `traveler_profiles`.
- Preference memory: M1 creates `user_preference_facts` and `memory_events`.
- Supabase Auth mirror: M1 creates `public.users` and auth triggers.
- Trip persistence: M2 creates `trips`.
- Durable jobs: M2 creates `jobs` and a `skip locked` claim helper.
- Generation timeline: M2 creates `generation_events`.
- Reel cache: M3 creates `reel_cache`.
- Canonical places and pgvector: M3 creates `places` with `vector(1536)`.
- Inspiration tray persistence: M3 creates `trip_inspiration_items`.
- Final trip places: M3 creates `trip_places`.
- Knowledge graph: M3 creates `location_graph_nodes` and `location_graph_edges`.
- Itinerary days with dates: M4 creates `trip_days.day_date`.
- Transport legs: M4 creates `transport_legs`.
- Restaurants: M4 creates `restaurant_suggestions`.
- Hotel search snapshots: M4 creates `hotel_suggestions`.
- Feedback: M4 creates `feedback`.
- Quotas: M1 creates `user_daily_usage`.
- RLS: all public tables enable RLS; user-owned read/write paths have policies.
- Indexes: FK columns and common owner/status/date lookup paths are indexed.

### Placeholder Scan

The only non-literal paths are `M1`, `M2`, `M3`, and `M4`, which are defined by Supabase CLI output because the Supabase skill requires `supabase migration new` rather than invented migration filenames. The SQL itself has no unfinished sections.

### Risk Notes

- `places_embedding_hnsw_idx` requires the Supabase local Postgres image to support pgvector HNSW indexes. If `supabase db reset` fails on this index, replace it with no vector index for beta or an IVFFlat index after checking the installed pgvector version. Do not remove the `embedding vector(1536)` column.
- The `public.users` mirror trigger is `security definer` in the private schema and has execution revoked from public roles. Keep it private.
- The plan gives authenticated clients read access to saved trip outputs, profile/preference rows, quota rows, and feedback insert. Generation writes and global cache writes remain service-role paths.
- The tests use raw pgTAP and JWT claim settings to avoid depending on network-installed test helpers.
- Apply migrations to remote Supabase only after local `db reset`, `test db`, and `db lint` pass.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
