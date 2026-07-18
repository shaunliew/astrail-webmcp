-- Remove untrusted Saved Reels links without deleting shared location data.
-- This intentionally follows the trust-gate migration so cleanup failure cannot
-- roll back the verified-only read path.

create or replace function private.cleanup_unverified_saved_reel_locations()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  set local lock_timeout = '5s';

  lock table public.reel_cache in share row exclusive mode;
  lock table public.reel_place_mentions in share row exclusive mode;

  update public.reel_cache
  set extracted_places = '[]'::jsonb,
      extractor_version = 'invalidated-searchbox-2026-07-18'
  where exists (
    select 1
    from public.reel_place_mentions
    where reel_place_mentions.reel_cache_id = reel_cache.id
      and reel_place_mentions.verification_version is null
  )
    and (
      reel_cache.extracted_places is distinct from '[]'::jsonb
      or reel_cache.extractor_version is distinct from 'invalidated-searchbox-2026-07-18'
    );

  delete from public.reel_place_mentions
  where verification_version is null;
end;
$$;

revoke all on function private.cleanup_unverified_saved_reel_locations()
from public, anon, authenticated;
grant execute on function private.cleanup_unverified_saved_reel_locations()
to service_role;

select private.cleanup_unverified_saved_reel_locations();

alter table public.reel_place_mentions
  alter column verification_version set not null;
