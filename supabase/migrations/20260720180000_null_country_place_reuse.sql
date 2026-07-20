-- Widen `find_or_create_place`'s reuse predicate to legacy rows that carry no country yet.
--
-- 20260720160000 moved the reuse lookup into this function with the predicate the Python it
-- replaced had at the time: `country_code = p_country_code`. That predicate structurally
-- EXCLUDES every row created before the country migration, because `country_code IS NULL` is
-- never equal to anything. The organizer therefore kept inserting a second canonical row for a
-- venue it demonstrably already had — the exact opposite of what a dedup flywheel is for, and
-- worse than the duplicate 20260720160000 closed, since this one happens on the happy path
-- rather than only under a race (ISSUES-B2).
--
-- So a candidate now qualifies when its country either MATCHES the freshly verified one or is
-- still NULL. What licenses the reuse is still the coordinates: the `p_max_distance_m` gate
-- below is unchanged and is what keeps this from being data corruption — two genuinely
-- different venues that happen to share a name stay two rows, and a far null-country row is
-- never stamped with a country nobody verified it against.
--
-- ORDER BY IS LOAD-BEARING, NOT COSMETIC. Widening the predicate makes it routine for a
-- verified row and a null-country row to BOTH sit inside the gate, and the choice between them
-- must not be whichever the plan happened to emit first. `country_code is null` sorts false
-- before true, so an already-Mapbox-verified row always beats a legacy one — it is strictly
-- more trustworthy, and picking it means the backfill below rewrites labels that were already
-- correct rather than inventing them. `id` then breaks the remaining tie totally, so a
-- re-organize hands `reel_place_mentions` the same canonical id every run instead of flipping
-- after a vacuum or a plan change.
--
-- The advisory lock, its key, the haversine expression, the backfill and the deliberately
-- omitted `embedding` (ISSUES-B3) are all carried over from 20260720160000 UNCHANGED; read
-- that migration for why each is the way it is. `create or replace` keeps the signature, so
-- the existing grants and revokes stand and are re-asserted below only for a fresh database.
--
-- NOT WIDENED: the lock key still hashes `p_country_code`, so two callers with DIFFERENT
-- verified countries do not serialize against each other. They cannot duplicate — an inserted
-- row carries a non-null country, which the other caller's predicate excludes — but they can
-- both reuse and both backfill the SAME null-country legacy row, and the last writer's country
-- wins. That needs two same-named venues within 500 m of one legacy row and on opposite sides
-- of a border; it is a label race on one ambiguous legacy row, not a duplicate, and it was
-- equally present in the Python this replaces. Locking on name alone would close it at the
-- cost of serializing every unrelated same-name call in the world.
create or replace function public.find_or_create_place(
  p_name text,
  p_place_type text,
  p_lat double precision,
  p_lng double precision,
  p_country text,
  p_country_code text,
  p_country_name text,
  p_city text,
  p_max_distance_m double precision
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  -- SERIALIZE FIRST. Held to COMMIT, so the re-check below and the insert cannot interleave
  -- with another worker's identical call. The first argument namespaces the key against every
  -- other advisory-lock user in the database; the second is the reuse lookup's exact-equality
  -- half. `coalesce` because a NULL country_code hashes to NULL, which would take no lock at
  -- all and silently restore the race for exactly the rows least likely to be noticed.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.find_or_create_place'),
    pg_catalog.hashtext(p_name || '|' || coalesce(p_country_code, ''))
  );

  -- The reuse rule: same name, a country that matches the VERIFIED one or is not set yet, and
  -- within p_max_distance_m great-circle metres. `least(1.0, ...)` mirrors the clamp in
  -- `pipeline/geo.haversine_m` that keeps asin() in domain on near-antipodal hallucinated
  -- coordinates, and 6371000 is that function's earth radius — the two must agree or a place
  -- sitting on the gate boundary resolves differently depending on which one ran.
  select id into v_id
    from public.places
   where name = p_name
     and (country_code = p_country_code or country_code is null)
     and 2 * 6371000 * pg_catalog.asin(pg_catalog.sqrt(least(
           1.0,
           pg_catalog.sin(pg_catalog.radians(p_lat - lat) / 2)
             * pg_catalog.sin(pg_catalog.radians(p_lat - lat) / 2)
           + pg_catalog.cos(pg_catalog.radians(lat)) * pg_catalog.cos(pg_catalog.radians(p_lat))
             * pg_catalog.sin(pg_catalog.radians(p_lng - lng) / 2)
             * pg_catalog.sin(pg_catalog.radians(p_lng - lng) / 2)
         ))) < p_max_distance_m
   order by (country_code is null), id
   limit 1;

  if v_id is not null then
    -- Backfill the reused row's country labels. This is now doing two jobs: a legacy row can
    -- carry a poisoned `country`/`country_name` (an LLM guess) alongside a correct code, AND a
    -- pre-migration row can carry no country at all. This run has just verified all three
    -- against Mapbox, so it repairs or fills them. Only the row we CHOSE is written; the
    -- candidates we passed over stay untouched, because we verified this coordinate and not
    -- theirs.
    update public.places
       set country = p_country,
           country_code = p_country_code,
           country_name = p_country_name
     where id = v_id;
    return v_id;
  end if;

  -- `embedding` is DELIBERATELY not written (ISSUES-B3: "document null embeddings as an
  -- accepted MVP state"). The repo has no shared embedding producer, and a NULL column is
  -- honest where a zero vector would pollute every future similarity search. Do not
  -- "complete" this insert with it; the column list is the contract.
  insert into public.places (name, place_type, lat, lng, country, country_code, country_name, city)
  values (p_name, p_place_type, p_lat, p_lng, p_country, p_country_code, p_country_name, p_city)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.find_or_create_place(
  text, text, double precision, double precision, text, text, text, text, double precision)
  from public, anon, authenticated;
grant execute on function public.find_or_create_place(
  text, text, double precision, double precision, text, text, text, text, double precision)
  to service_role;
