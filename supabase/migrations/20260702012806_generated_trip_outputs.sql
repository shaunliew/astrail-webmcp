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
  constraint trip_days_id_trip_id_unique unique (id, trip_id),
  constraint trip_days_trip_day_unique unique (trip_id, day_number)
);

create trigger trip_days_set_updated_at
before update on public.trip_days
for each row execute function private.set_updated_at();

create table public.transport_legs (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid,
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
  constraint transport_legs_distance_nonnegative check (distance_meters is null or distance_meters >= 0),
  constraint transport_legs_trip_day_trip_fkey foreign key (trip_day_id, trip_id) references public.trip_days(id, trip_id) on delete set null (trip_day_id)
);

create table public.restaurant_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid,
  restaurant_place_id uuid references public.places(id) on delete set null,
  near_place_id uuid references public.places(id) on delete set null,
  cuisine text,
  summary text not null,
  source_url text,
  evidence_json jsonb not null default '{}'::jsonb,
  preference_match_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint restaurant_suggestions_trip_day_trip_fkey foreign key (trip_day_id, trip_id) references public.trip_days(id, trip_id) on delete set null (trip_day_id)
);

create table public.hotel_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  trip_day_id uuid,
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
  constraint hotel_suggestions_status_check check (status in ('suggested', 'unavailable', 'skipped', 'failed')),
  constraint hotel_suggestions_trip_day_trip_fkey foreign key (trip_day_id, trip_id) references public.trip_days(id, trip_id) on delete set null (trip_day_id)
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
  and artifact_type = 'trip'
  and artifact_id is null
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
