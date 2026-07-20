-- Rollback for 20260720100000_reel_place_mentions_user_scope.sql.
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it
-- up (it globs timestamped files at the top level of supabase/migrations only) — it is the
-- maintenance window's step-6 escape hatch, applied by hand with psql, and it exists before
-- the window opens rather than being written under pressure.
--
-- Lossy BY DESIGN, in two named ways, both accepted:
--   1. The fan-out created N owner rows per (reel_cache_id, place_id); the old PK admits one,
--      so the oldest created_at wins. Deterministic, and it matches the pre-migration row.
--   2. Orphans deleted on the way in are NOT restored. They are regenerable from the frozen
--      extraction cache at zero provider spend — that is the Step 0 policy's justification
--      for deleting them in the first place.
--
-- `user_id` is left populated and nullable: harmless to the pre-A3 code, which never selects
-- it, and it means a re-apply does not have to re-derive owners it already knows.
--
-- DELIBERATELY NOT VERBATIM, in exactly one respect. The predicate and the view below keep
-- A3's `saved_reels.user_id = reel_place_mentions.user_id` join; their pre-A3 versions joined
-- on `reel_cache_id` ALONE. That verbatim form is the cross-user leak A3 exists to close: user
-- A organizes a Reel and owns the only surviving mention, user B saves the SAME Reel and never
-- organizes it, and B's `saved_reels` row reaches A's mention — B reads A's verified evidence.
-- An escape hatch that re-opens the vulnerability it is aborting away from is not an abort.
--
-- Retaining the equality costs nothing precisely BECAUSE of the paragraph above: the scoping
-- data survives the rollback. Rows written afterwards by the restored old `_persist_mention`
-- carry `user_id IS NULL`, and an equality join excludes NULL — so they are HIDDEN until a
-- forward repair rather than shared with every saver. That is the correct failure direction,
-- and it is asserted, so do not "correct" this back to match `20260718190000` on sight.
--
-- Proven by `20260720100000_down_test.sql` beside this file — run it before the window opens.

delete from public.reel_place_mentions m
 where exists (select 1 from public.reel_place_mentions k
                where k.reel_cache_id = m.reel_cache_id and k.place_id = m.place_id
                  and (k.created_at, k.user_id) < (m.created_at, m.user_id));

drop index if exists public.reel_place_mentions_cache_place_idx;
alter table public.reel_place_mentions drop constraint reel_place_mentions_pkey;
alter table public.reel_place_mentions drop constraint reel_place_mentions_user_fkey;
alter table public.reel_place_mentions alter column user_id drop not null;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_pkey primary key (reel_cache_id, place_id);

drop function if exists public.replace_reel_place_mentions(uuid, uuid, text, jsonb);

-- Restore the pre-A3 owner check from 20260718190000 — MINUS its leak. See the header: the
-- ownership equality is retained, everything else is the prior definition.
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
     and saved_reels.user_id = reel_place_mentions.user_id   -- RETAINED from A3
    where reel_place_mentions.place_id = p_place_id
      and reel_place_mentions.verification_version = 'mapbox-country-v1'
      and saved_reels.user_id = (select auth.uid())
  );
$$;

-- Restore the pre-A3 projection from 20260719103000 — again MINUS its leak, same reason.
-- Drop + create, never CREATE OR REPLACE (0216a0e) — this removes a join predicate.
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
  coalesce(reel_cache.extractor_version = '2026-07-19.1', false) as has_current_cache
from public.saved_reels
left join public.reel_cache
  on reel_cache.id = saved_reels.reel_cache_id
left join public.reel_place_mentions
  on reel_place_mentions.reel_cache_id = saved_reels.reel_cache_id
 and reel_place_mentions.user_id = saved_reels.user_id          -- RETAINED from A3
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
