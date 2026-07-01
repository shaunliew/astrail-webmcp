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
