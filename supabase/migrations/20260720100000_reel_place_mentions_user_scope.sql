-- reel_place_mentions is the Saved Reels trust boundary (authorize_place_ids reads it, and
-- the backend is service_role so RLS cannot scope it). Give it an owner.
--
-- Applied inside a MAINTENANCE WINDOW, not an ordinary merge. An expand/contract split is
-- impossible: the fan-out below needs N rows sharing today's (reel_cache_id, place_id) key,
-- so the PK must drop first — and dropping it immediately breaks the currently-deployed
-- `_persist_mention`, which upserts on_conflict="reel_cache_id,place_id" and requires a
-- matching unique index. Old and new code cannot coexist against either schema.

alter table public.reel_place_mentions add column user_id uuid;
alter table public.reel_place_mentions drop constraint reel_place_mentions_pkey;

-- Backfill: fan out to every user who ORGANIZED this Reel — exactly the set for whom
-- authorize_place_ids already succeeds, so the authorization surface is preserved.
insert into public.reel_place_mentions
  (user_id, reel_cache_id, place_id, evidence_quote, source_url, confidence,
   verification_version, created_at, updated_at)
select distinct sr.user_id, m.reel_cache_id, m.place_id, m.evidence_quote, m.source_url,
       m.confidence, m.verification_version, m.created_at, m.updated_at
  from public.reel_place_mentions m
  join public.saved_reels sr
    on sr.reel_cache_id = m.reel_cache_id
   and sr.analysis_status = 'organized'
 where m.user_id is null;

-- Unowned leftovers are unreachable (authorize_place_ids requires 'organized') and fully
-- regenerable from the frozen extraction cache. See the plan's Step 0 audit.
delete from public.reel_place_mentions where user_id is null;

alter table public.reel_place_mentions alter column user_id set not null;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_user_fkey
  foreign key (user_id) references public.users(id) on delete cascade;
alter table public.reel_place_mentions
  add constraint reel_place_mentions_pkey
  primary key (user_id, reel_cache_id, place_id);
create index reel_place_mentions_cache_place_idx
  on public.reel_place_mentions (reel_cache_id, place_id);

-- Atomic owner-scoped set replacement — ONE transaction, so there is no window in which a
-- concurrent authorize_place_ids sees a half-written set, and no ordering in which a failed
-- grounding can destroy a previously verified one.
create or replace function public.replace_reel_place_mentions(
  p_user_id uuid, p_reel_cache_id uuid, p_verification_version text, p_mentions jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_place_ids uuid[];
begin
  if p_mentions is null or jsonb_typeof(p_mentions) <> 'array' then
    raise exception 'mentions payload must be a JSON array' using errcode = 'AS422';
  end if;

  -- DEDUPE BY place_id — load-bearing, not defensive tidiness. Two extracted entries can
  -- resolve through _persist_place to the SAME canonical place_id (the extractor does not
  -- dedupe: genagents/place_extractor.py, and today's sequential upserts tolerate it).
  -- A single INSERT ... ON CONFLICT DO UPDATE that touched that row twice fails outright with
  -- "ON CONFLICT DO UPDATE command cannot affect row a second time", so a Reel naming one
  -- venue twice would break every organize of it. `with ordinality` makes first-occurrence-wins
  -- deterministic rather than dependent on jsonb ordering.
  -- ONE statement: dedupe, upsert, and collect the surviving ids. A data-modifying CTE keeps
  -- this to a single pass (a two-statement form would not compile — CTEs do not outlive their
  -- statement).
  with input as (
    select (elem->>'place_id')::uuid as place_id, elem, ord
      from jsonb_array_elements(p_mentions) with ordinality t(elem, ord)
  ), deduped as (
    select distinct on (place_id) place_id, elem from input order by place_id, ord
  ), upserted as (
    insert into public.reel_place_mentions
      (user_id, reel_cache_id, place_id, evidence_quote, source_url, confidence, verification_version)
    select p_user_id, p_reel_cache_id, d.place_id, d.elem->>'evidence_quote',
           d.elem->>'source_url', coalesce((d.elem->>'confidence')::numeric, 0), p_verification_version
      from deduped d
    on conflict (user_id, reel_cache_id, place_id) do update
      set evidence_quote = excluded.evidence_quote,
          source_url = excluded.source_url,
          confidence = excluded.confidence,
          verification_version = excluded.verification_version,
          updated_at = now()
    returning place_id
  )
  select coalesce(array_agg(place_id), '{}'::uuid[]) into v_place_ids from upserted;

  -- Prune ONLY this owner's superseded rows. Other users' sets are untouched by construction.
  delete from public.reel_place_mentions
   where user_id = p_user_id
     and reel_cache_id = p_reel_cache_id
     and place_id <> all(v_place_ids);

  return cardinality(v_place_ids);
end;
$$;

revoke all on function public.replace_reel_place_mentions(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_reel_place_mentions(uuid, uuid, text, jsonb)
  to service_role;

-- The mention must belong to the requesting user, not merely to a Reel they saved.
create or replace function private.can_select_verified_saved_reel_place(p_place_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.reel_place_mentions m
      join public.saved_reels sr
        on sr.reel_cache_id = m.reel_cache_id
       and sr.user_id = m.user_id                      -- NEW: owner-scoped
     where m.place_id = p_place_id
       and m.verification_version = 'mapbox-country-v1'
       and sr.user_id = (select auth.uid())
  );
$$;

-- Never CREATE OR REPLACE: this adds a join predicate, and any column-list drift makes the
-- replace an illegal rename (the bug 0216a0e had to fix). Drop and recreate.
--
-- VISIBILITY NARROWS, deliberately. The mention join was on reel_cache_id alone with no
-- analysis_status filter, so a user who saved a Reel SOMEONE ELSE organized saw those pins —
-- pins authorize_place_ids then rejected, failing generation terminally. They now see none
-- until they organize it themselves. Reversible via a view-only migration if the borrowed
-- pins are wanted back as read-only.
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
 and reel_place_mentions.verification_version = 'mapbox-country-v1'
 and reel_place_mentions.user_id = saved_reels.user_id
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
