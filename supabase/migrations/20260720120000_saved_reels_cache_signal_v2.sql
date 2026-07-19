-- REVERT PATH (no rollback file, deliberately). Unlike A3's re-key, this migration is a pure
-- view + function swap: it destroys no data and changes no key. To revert, re-run the
-- `create or replace function private.can_select_verified_saved_reel_place` and the
-- `drop view public.saved_reel_cards; create view ...` blocks from
-- 20260720100000_reel_place_mentions_user_scope.sql verbatim — that file still contains the
-- complete pre-B3 definitions of both. A3 ships a scripted rollback because its backfill
-- DELETES rows; nothing here does. Recorded because the EXTRACTOR_VERSION bump makes this a
-- deliberately-timed merge, and whoever times it should not have to derive the undo.
-- Two coupled read-surface changes, one view swap.
--
-- (1) EXTRACTOR_VERSION bump → '2026-07-20.1'. `has_current_cache` embeds the literal, so the
--     view must be re-created or every card keeps reporting freshness against the retired
--     version. The extractor's coordinate-echo filter got stricter (1e-3 tolerance + path
--     scanning on non-Google hosts), and extractions validated under the OLD contract must not
--     be trusted — that is the whole reason the cache keys on the version.
--
-- (2) The read surface now matches authorization. `authorize_place_ids` (backend/organizer.py)
--     requires saved_reels.analysis_status = 'organized'; the card view and the places RLS
--     predicate did not. A3 closed the cross-user half of that gap (a user who merely SAVED
--     someone else's organized Reel owns no mention rows). What remains is the SAME-USER
--     stale-status case: a user who organized successfully once, then re-organized into
--     'failed' / 'location_not_found', still owns their earlier mention rows — so they still
--     saw pins that authorize_place_ids rejects, failing trip generation terminally. Showing a
--     pin the user cannot build a trip from is worse than showing none.
--
--     Tightening the read surface is the conservative direction; relaxing authorize_place_ids
--     would widen access instead. PRODUCT NOTE: after a failed re-organize a Reel's pins
--     disappear from the card until the next successful organize (cache-hit, Mapbox-cached,
--     quota-free).
--
-- Definition copied verbatim from 20260720100000_reel_place_mentions_user_scope.sql — the
-- migration that last re-created this view — with only the version literal and the
-- analysis_status predicate changed. Copying the older 20260719103000 definition would
-- silently revert A3's owner-scoped mention join.

create or replace function private.can_select_verified_saved_reel_place(p_place_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.reel_place_mentions m
      join public.saved_reels sr
        on sr.reel_cache_id = m.reel_cache_id
       and sr.user_id = m.user_id                      -- A3: owner-scoped
     where m.place_id = p_place_id
       and m.verification_version = 'mapbox-country-v1'
       and sr.analysis_status = 'organized'            -- NEW: matches authorize_place_ids
       and sr.user_id = (select auth.uid())
  );
$$;

-- Never CREATE OR REPLACE: this adds a join predicate, and any column-list drift makes the
-- replace an illegal rename (the bug 0216a0e had to fix). Drop and recreate.
drop view public.saved_reel_cards;

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
  ) as places,
  coalesce(reel_cache.extractor_version = '2026-07-20.1', false) as has_current_cache
from public.saved_reels
left join public.reel_cache
  on reel_cache.id = saved_reels.reel_cache_id
left join public.reel_place_mentions
  on reel_place_mentions.reel_cache_id = saved_reels.reel_cache_id
 and reel_place_mentions.verification_version = 'mapbox-country-v1'
 and reel_place_mentions.user_id = saved_reels.user_id
 and saved_reels.analysis_status = 'organized'
left join public.places
  on places.id = reel_place_mentions.place_id
where saved_reels.user_id = (select auth.uid())
group by
  saved_reels.id,
  saved_reels.user_id,
  saved_reels.normalized_url,
  saved_reels.source_platform,
  saved_reels.reel_cache_id,
  reel_cache.extractor_version,
  saved_reels.analysis_status,
  saved_reels.personal_label,
  saved_reels.retry_after,
  saved_reels.analyzed_at,
  saved_reels.created_at,
  saved_reels.updated_at,
  reel_cache.caption,
  reel_cache.thumbnail_url;

revoke all on public.saved_reel_cards from public, anon;
grant select on public.saved_reel_cards to authenticated, service_role;
