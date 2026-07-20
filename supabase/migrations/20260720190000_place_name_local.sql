-- Persist `name_local` — the venue's name in its local language/script — on `places`.
--
-- The field has existed on `PlaceResult` since the extractor gained it, the prompt asks for it
-- under a verbatim-substring guardrail, `geocode/policy.py::geocode_query()` keys its whole
-- script-detection branch off it (a Japanese query with `language=ja` is what makes Mapbox find
-- Japanese POIs AT ALL), and `pipeline/dedup.py` + `pipeline/persist.py::_place_matches` read it
-- back for alias matching. Nothing stored it. So it lived exactly as long as the run that
-- extracted it: a place REUSED from the canonical table came back without it, and re-grounding
-- that place fell back to its English name — the precise failure the field exists to prevent.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. A row whose caption carried no local-script name
-- has no local name, and that is a fact about the caption, not a gap to be filled. Deriving one
-- from a model or a geocoder would be unsourced data and a guardrail #1 violation
-- ("no hallucinated places" — every field traces to verbatim evidence). Every row that exists
-- today is therefore NULL, and the reuse path below is the only route by which one is ever
-- filled in.
alter table public.places add column name_local text;

comment on column public.places.name_local is
  'Venue name in the local language/script (e.g. 東京タワー), always from a SOURCE: verbatim from '
  'a reel caption for extracted places, or from the Mapbox POI for restaurant suggestions. NULL '
  'when no source supplied one — never inferred, translated or transliterated (guardrail #1). '
  'find_or_create_place fills it on insert and thereafter only if null; see 20260720190000.';

-- DROP AND RECREATE, NOT `create or replace`. Adding a parameter makes a DIFFERENT signature,
-- so `create or replace` would leave the 9-argument function in place as an OVERLOAD rather
-- than replacing it: a stale definition that still writes no `name_local`, still carries its
-- `service_role` grant, and resolves ahead of the new one for any 9-argument call. Dropping it
-- explicitly makes a missed call site a hard "function does not exist" instead of a silent
-- write of the wrong shape.
drop function public.find_or_create_place(
  text, text, double precision, double precision, text, text, text, text, double precision);

-- `p_name_local` sits beside `p_name` because they are the same fact in two scripts. Everything
-- else here is carried over from 20260720160000 and 20260720180000 UNCHANGED — the advisory
-- lock and its key, the 500 m haversine gate, the null-country-tolerant predicate, the
-- `order by (country_code is null), id`, the country backfill, and the deliberately omitted
-- `embedding` (ISSUES-B3). Read those two migrations for why each is the way it is; this one
-- only adds a column to the insert and one coalesce to the update.
create or replace function public.find_or_create_place(
  p_name text,
  p_name_local text,
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
  --
  -- `p_name_local` is NOT part of the key, and must not be: two callers that disagree about a
  -- venue's local name are exactly the pair that has to serialize, and keying on it would let
  -- them both insert.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.find_or_create_place'),
    pg_catalog.hashtext(p_name || '|' || coalesce(p_country_code, ''))
  );

  -- The reuse rule: same name, a country that matches the VERIFIED one or is not set yet, and
  -- within p_max_distance_m great-circle metres. `least(1.0, ...)` mirrors the clamp in
  -- `pipeline/geo.haversine_m` that keeps asin() in domain on near-antipodal hallucinated
  -- coordinates, and 6371000 is that function's earth radius — the two must agree or a place
  -- sitting on the gate boundary resolves differently depending on which one ran.
  --
  -- `name_local` is NOT in this predicate either. It is a second label for a venue already
  -- identified by name + country + coordinates, so matching on it would only ever REJECT a row
  -- the gate already accepted — reintroducing the duplicate 20260720180000 closed, for reels
  -- that captioned the same place in different scripts.
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
    -- Backfill the reused row's country labels. A legacy row can carry a poisoned
    -- `country`/`country_name` (an LLM guess) alongside a correct code, AND a pre-migration row
    -- can carry no country at all. This run has just verified all three against Mapbox, so it
    -- repairs or fills them. Only the row we CHOSE is written; the candidates we passed over
    -- stay untouched, because we verified this coordinate and not theirs.
    --
    -- `name_local` is FILL-IF-NULL, and the asymmetry with the country labels above is the
    -- whole decision. Those are overwritten because this run RE-VERIFIED them against Mapbox,
    -- so the fresh value is strictly better than the stored one. Nothing verifies `name_local`
    -- — it is whatever this reel's caption happened to contain — so that licence does not
    -- extend to it:
    --   * `coalesce(name_local, p_name_local)` and not `p_name_local`, or every organize of a
    --     reel that captioned this venue in English would DESTROY a good local name.
    --   * `coalesce(name_local, ...)` and not `coalesce(p_name_local, ...)`, because when both
    --     are set neither is more authoritative — two reels routinely render the same venue
    --     differently ('一蘭 渋谷店' vs '一蘭') — and organize order across reels is not fixed,
    --     so last-writer-wins would let a canonical row's local name FLIP between runs. That is
    --     the nondeterminism the `order by` above was added to eliminate. Fill-if-null reaches
    --     a fixed point; last-writer-wins never does.
    update public.places
       set country = p_country,
           country_code = p_country_code,
           country_name = p_country_name,
           name_local = coalesce(name_local, p_name_local)
     where id = v_id;
    return v_id;
  end if;

  -- `embedding` is DELIBERATELY not written (ISSUES-B3: "document null embeddings as an
  -- accepted MVP state"). The repo has no shared embedding producer, and a NULL column is
  -- honest where a zero vector would pollute every future similarity search. Do not
  -- "complete" this insert with it; the column list is the contract.
  insert into public.places (name, name_local, place_type, lat, lng, country, country_code, country_name, city)
  values (p_name, p_name_local, p_place_type, p_lat, p_lng, p_country, p_country_code, p_country_name, p_city)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.find_or_create_place(
  text, text, text, double precision, double precision, text, text, text, text, double precision)
  from public, anon, authenticated;
grant execute on function public.find_or_create_place(
  text, text, text, double precision, double precision, text, text, text, text, double precision)
  to service_role;
