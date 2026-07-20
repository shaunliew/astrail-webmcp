-- Serialize the canonical-place find-or-create so two workers cannot both insert.
--
-- `_persist_place` did SELECT-then-INSERT into `places`, and 20260701162954 gives that table
-- no unique key at all. An expired worker A and its replacement B processing the same place
-- both SELECT before either INSERTs, both see no candidate, and both insert. Fencing the
-- mention row only decides which of the two duplicates gets REFERENCED; the orphan stays.
--
-- That is what separates this from the select-then-insert TOCTOU this branch knowingly
-- deferred in `pipeline/persist.py`. There the consequence is one trip pointing at one of two
-- rows. Here `places` is the CROSS-TRIP dedup flywheel: the duplicate is global and permanent,
-- every later organize resolves the same real-world venue to an arbitrary one of the two ids,
-- and the reuse that makes the flywheel worth having stops happening.
--
-- WHY AN ADVISORY LOCK AND NOT A UNIQUE INDEX + ON CONFLICT
--
-- The reuse rule is `name = ? AND country_code = ? AND haversine < p_max_distance_m`, and no
-- unique constraint can express a distance predicate. The closest key available is
-- (name, country_code, lat, lng), which would let two rows 3 m apart — the exact case the
-- 500 m gate exists to merge — both insert. It would read like the fix while closing only the
-- byte-identical-coordinate slice of it. A unique index is also unbuildable here without a
-- data decision: `places` may ALREADY carry duplicates from the unfenced past, and
-- `create unique index` fails outright on them.
--
-- A transaction-level advisory lock has neither problem. Two callers can only ever collide
-- when their name AND country_code are equal — an unequal pair cannot read each other's row
-- under the predicate above — so locking on exactly that pair serializes exactly the callers
-- that could duplicate, and the 500 m gate is then re-evaluated INSIDE the lock. Distinct
-- pairs that happen to collide in `hashtext` serialize needlessly; that costs a little
-- concurrency and cannot cost correctness.
--
-- What it does NOT protect: a caller that reaches `places` by any other route. The lock is a
-- convention, not a constraint, so it binds only writers that go through this function.
-- `pipeline/persist.py` (`_find_or_create_place`, `_find_or_create_restaurant_place`) still
-- inserts directly and still carries its own documented TOCTOU. Closing that one means
-- porting those callers onto this RPC — their match rule is by name/ALIAS rather than
-- name/country, so it is a different key and a separate change.
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

  -- The reuse rule, unchanged from the Python it replaces: same name, same VERIFIED country,
  -- within p_max_distance_m great-circle metres. `least(1.0, ...)` mirrors the clamp in
  -- `pipeline/geo.haversine_m` that keeps asin() in domain on near-antipodal hallucinated
  -- coordinates, and 6371000 is that function's earth radius — the two must agree or a place
  -- sitting on the gate boundary resolves differently depending on which one ran.
  --
  -- `order by id` makes the winner total rather than incidental: without it `limit 1` returns
  -- whichever of several eligible rows the plan happened to emit first, so a re-organize could
  -- hand `reel_place_mentions` a different canonical id for the same venue after a vacuum.
  select id into v_id
    from public.places
   where name = p_name
     and country_code = p_country_code
     and 2 * 6371000 * pg_catalog.asin(pg_catalog.sqrt(least(
           1.0,
           pg_catalog.sin(pg_catalog.radians(p_lat - lat) / 2)
             * pg_catalog.sin(pg_catalog.radians(p_lat - lat) / 2)
           + pg_catalog.cos(pg_catalog.radians(lat)) * pg_catalog.cos(pg_catalog.radians(p_lat))
             * pg_catalog.sin(pg_catalog.radians(p_lng - lng) / 2)
             * pg_catalog.sin(pg_catalog.radians(p_lng - lng) / 2)
         ))) < p_max_distance_m
   order by id
   limit 1;

  if v_id is not null then
    -- Backfill the reused row's country labels. A legacy row can carry a poisoned
    -- `country`/`country_name` (an LLM guess) alongside a correct code; this run has just
    -- verified all three against Mapbox, so it repairs them.
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
