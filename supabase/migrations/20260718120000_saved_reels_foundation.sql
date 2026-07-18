create table public.saved_reels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  normalized_url text not null,
  source_platform text not null default 'instagram',
  reel_cache_id uuid,
  analysis_status text not null default 'not_analyzed',
  personal_label text,
  retry_after timestamptz,
  analyzed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint saved_reels_user_normalized_url_unique unique (user_id, normalized_url),
  constraint saved_reels_user_id_id_unique unique (user_id, id),
  constraint saved_reels_reel_cache_id_fkey foreign key (reel_cache_id) references public.reel_cache(id) on delete set null,
  constraint saved_reels_normalized_url_nonblank_check check (btrim(normalized_url) <> ''),
  constraint saved_reels_source_platform_check check (source_platform in ('instagram', 'tiktok', 'manual')),
  constraint saved_reels_analysis_status_check check (analysis_status in ('not_analyzed', 'queued', 'processing', 'organized', 'location_not_found', 'failed')),
  constraint saved_reels_personal_label_check check (personal_label is null or (btrim(personal_label) <> '' and char_length(personal_label) <= 120)),
  constraint saved_reels_analyzed_at_state_check check (
    (analysis_status in ('organized', 'location_not_found') and analyzed_at is not null)
    or (analysis_status in ('not_analyzed', 'queued', 'processing') and analyzed_at is null)
    or analysis_status = 'failed'
  )
);

create trigger saved_reels_set_updated_at
before update on public.saved_reels
for each row execute function private.set_updated_at();

create table public.reel_collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reel_collections_user_id_id_unique unique (user_id, id),
  constraint reel_collections_name_trimmed_length_check check (name = btrim(name) and char_length(name) between 1 and 80),
  constraint reel_collections_sort_order_nonnegative_check check (sort_order >= 0)
);

create trigger reel_collections_set_updated_at
before update on public.reel_collections
for each row execute function private.set_updated_at();

create table public.reel_collection_items (
  user_id uuid not null,
  collection_id uuid not null,
  saved_reel_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (collection_id, saved_reel_id),
  constraint reel_collection_items_user_collection_fkey foreign key (user_id, collection_id) references public.reel_collections(user_id, id) on delete cascade,
  constraint reel_collection_items_user_saved_reel_fkey foreign key (user_id, saved_reel_id) references public.saved_reels(user_id, id) on delete cascade
);

create index saved_reels_user_created_id_idx
  on public.saved_reels (user_id, created_at desc, id);

create index saved_reels_user_status_created_id_idx
  on public.saved_reels (user_id, analysis_status, created_at, id);

create index saved_reels_reel_cache_id_idx
  on public.saved_reels (reel_cache_id)
  where reel_cache_id is not null;

create unique index reel_collections_user_normalized_name_unique_idx
  on public.reel_collections (user_id, lower(btrim(name)));

create index reel_collections_user_sort_idx
  on public.reel_collections (user_id, sort_order, created_at, id);

create index reel_collection_items_user_collection_idx
  on public.reel_collection_items (user_id, collection_id);

create index reel_collection_items_user_saved_reel_idx
  on public.reel_collection_items (user_id, saved_reel_id);

alter table public.saved_reels enable row level security;
alter table public.reel_collections enable row level security;
alter table public.reel_collection_items enable row level security;

revoke all on public.saved_reels from public, anon, authenticated;
grant select, delete on public.saved_reels to authenticated;
grant update (personal_label) on public.saved_reels to authenticated;
grant all on public.saved_reels to service_role;

revoke all on public.reel_collections from public, anon, authenticated;
grant select, insert, update, delete on public.reel_collections to authenticated;
grant all on public.reel_collections to service_role;

revoke all on public.reel_collection_items from public, anon, authenticated;
grant select, insert, delete on public.reel_collection_items to authenticated;
grant all on public.reel_collection_items to service_role;

create policy saved_reels_select_own
on public.saved_reels
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy saved_reels_update_own
on public.saved_reels
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy saved_reels_delete_own
on public.saved_reels
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy reel_collections_select_own
on public.reel_collections
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy reel_collections_insert_own
on public.reel_collections
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy reel_collections_update_own
on public.reel_collections
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy reel_collections_delete_own
on public.reel_collections
for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy reel_collection_items_select_own
on public.reel_collection_items
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy reel_collection_items_insert_own
on public.reel_collection_items
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy reel_collection_items_delete_own
on public.reel_collection_items
for delete
to authenticated
using ((select auth.uid()) = user_id);

create function public.capture_saved_reel(p_user_id uuid, p_normalized_url text, p_source_platform text default 'instagram')
returns setof public.saved_reels
language sql
set search_path = ''
as $$
  insert into public.saved_reels (
    user_id,
    normalized_url,
    source_platform,
    reel_cache_id
  )
  select
    p_user_id,
    p_normalized_url,
    p_source_platform,
    cache.id
  from (values (1)) as singleton(n)
  left join public.reel_cache as cache
    on cache.normalized_url = p_normalized_url
  on conflict (user_id, normalized_url) do update
  set reel_cache_id = coalesce(
    public.saved_reels.reel_cache_id,
    excluded.reel_cache_id
  )
  returning public.saved_reels.*;
$$;

revoke all on function public.capture_saved_reel(uuid, text, text) from public, anon, authenticated;
grant execute on function public.capture_saved_reel(uuid, text, text) to service_role;
