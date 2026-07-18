-- Trust only research coordinates independently country-verified by Mapbox.

alter table public.reel_place_mentions
  add column verification_version text;

alter table public.reel_place_mentions
  add constraint reel_place_mentions_verification_version_nonblank_check
  check (verification_version is null or btrim(verification_version) <> '');

alter table public.organize_jobs
  drop constraint organize_jobs_user_idempotency_key_unique;

alter table public.organize_jobs
  drop constraint organize_jobs_status_check;

alter table public.organize_jobs
  add constraint organize_jobs_status_check
  check (status in ('initializing', 'pending', 'processing', 'succeeded', 'failed'));

create unique index organize_jobs_active_idempotency_key_unique
  on public.organize_jobs (user_id, idempotency_key)
  where status in ('initializing', 'pending', 'processing');

create or replace function private.can_select_verified_saved_reel_place(
  p_place_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.reel_place_mentions
    join public.saved_reels
      on saved_reels.reel_cache_id = reel_place_mentions.reel_cache_id
    where reel_place_mentions.place_id = p_place_id
      and reel_place_mentions.verification_version = 'mapbox-country-v1'
      and saved_reels.user_id = (select auth.uid())
  );
$$;

revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

revoke all on function private.can_select_verified_saved_reel_place(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.can_select_verified_saved_reel_place(uuid)
to authenticated, service_role;

drop policy places_select_when_used_in_own_saved_reel on public.places;

create policy places_select_when_used_in_own_saved_reel
on public.places
for select
to authenticated
using (
  private.can_select_verified_saved_reel_place(places.id)
);

-- The browser projection is owner-executed and explicitly filters by the JWT owner.
-- reel_cache and mentions remain service-role-only; unsafe cache columns are never
-- granted to authenticated and are not selected by this view.
create or replace view public.saved_reel_cards as
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
 and reel_place_mentions.verification_version = 'mapbox-country-v1'
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
