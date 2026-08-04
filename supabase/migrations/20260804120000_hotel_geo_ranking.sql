-- Hotel-hub map: geocode + route-rank columns on hotel_suggestions, plus a lease-fenced replace RPC.
--
-- The hotel stage now geocodes each Travala hotel (Mapbox Search Box, types=address) and blends a
-- preference proxy with route-centrality (Mapbox Matrix) to shortlist the top 3 as central "hub"
-- candidates. Honest-failure is Guardrail #1: a hotel that fails to geocode / falls out of proximity
-- / has no matrix row is written with geo_status='unresolved' and NULL coords — never an invented
-- coordinate. The seven new columns carry that result to the frontend (read client-side via
-- getTrip's select('*')).
--
-- 1. New columns (all nullable EXCEPT the three defaulted ones, so existing rows backfill cleanly):
--      lat/lng            double precision, bounds-checked (null-tolerant, like star_rating).
--      geo_status         NOT NULL DEFAULT 'unresolved' — the honest-failure discriminant.
--      route_score        numeric, NULL when Matrix degraded but the hotel is still placed.
--      rank               smallint, 1..N shortlist position.
--      is_recommended     NOT NULL DEFAULT false — rank 1 (the default-selected hub).
--      place_durations    NOT NULL DEFAULT '{}' — {place_id: duration_s}, spoke labels.
--    `alter table … add column` with CONSTANT defaults performs no table rewrite. RLS already
--    governs this table (20260702012806); no policy change.

alter table public.hotel_suggestions
  add column lat double precision
    constraint hotel_suggestions_lat_range
      check (lat is null or (lat >= -90 and lat <= 90)),
  add column lng double precision
    constraint hotel_suggestions_lng_range
      check (lng is null or (lng >= -180 and lng <= 180)),
  add column geo_status text not null default 'unresolved'
    constraint hotel_suggestions_geo_status_check
      check (geo_status in ('placed', 'unresolved')),
  add column route_score numeric,
  add column rank smallint,
  add column is_recommended boolean not null default false,
  add column place_durations jsonb not null default '{}'::jsonb;

-- geo_status <-> coords invariant (Codex P2): a `placed` row MUST carry real coords and an
-- `unresolved` row MUST have NULL coords. This is the honest-failure contract as a hard DB rule —
-- neither the RPC's coalesced inserts nor _build_hotel_rows can ever write a placed-but-coordless
-- (or unresolved-but-coordbearing) row. Existing rows backfill `unresolved` + NULL coords, which
-- satisfies the second branch, so the ALTER validates cleanly against current data.
alter table public.hotel_suggestions
  add constraint hotel_suggestions_geo_coords_consistent
    check (
      (geo_status = 'placed' and lat is not null and lng is not null)
      or (geo_status = 'unresolved' and lat is null and lng is null)
    );

comment on column public.hotel_suggestions.lat is
  'Geocoded latitude (Mapbox). NULL when geo_status=unresolved — never an invented coordinate.';
comment on column public.hotel_suggestions.lng is
  'Geocoded longitude (Mapbox). NULL when geo_status=unresolved — never an invented coordinate.';
comment on column public.hotel_suggestions.geo_status is
  'Honest-failure discriminant: placed (has coords, mappable) vs unresolved (list-only).';
comment on column public.hotel_suggestions.route_score is
  'Mean route duration to the trip''s places, in seconds (lower = more central). NULL when the hotel is not a top-3 hub candidate, did not reach every place, or the Matrix degraded (still placed, ranked on preference only).';
comment on column public.hotel_suggestions.rank is
  'Shortlist position 1..N among placed hotels; the top 3 are the hub candidates.';
comment on column public.hotel_suggestions.is_recommended is
  'True on rank 1 — the default-selected central hub. Orthogonal to the price/rating tradeoff panel.';
comment on column public.hotel_suggestions.place_durations is
  '{place_id: duration_seconds} from the hotel to each trip place; drives spoke labels.';

-- 2. Fence the hotel stage's one DESTRUCTIVE write.
--
-- persist_hotels clears this trip's hotel_suggestions and rebuilds them. With geocode + Matrix
-- latency now added inside that window, an unfenced delete-first (behind an in-process lease check)
-- is a TOCTOU: a worker superseded mid-stage could delete the replacement's rows and reinsert its
-- own. So this gets the EXACT contract of replace_trip_itinerary (20260720150000): the lease check
-- and the rewrite are ONE transaction.
--
-- Three constraints this signature encodes; do not "simplify" them back:
--   1. `p_lease_token uuid`, NOT text — jobs.lease_token is uuid and plpgsql defers
--      "operator does not exist: uuid = text" to RUNTIME, so `supabase db reset` alone does NOT
--      catch a text parameter. Only an execution test does.
--   2. The fence matches on `trip_id = p_trip_id` as well as the token, so a lease on job X can
--      only ever rewrite job X's OWN trip (guardrail #6, enforced through the job row rather than by
--      trusting a caller-supplied user_id).
--   3. `set search_path = ''` plus the revoke/grant block, matching replace_trip_itinerary.
create or replace function public.replace_hotel_suggestions(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_rows jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  -- FENCE FIRST, and take the row lock: `for update` is what makes this safe against a concurrent
  -- reclaim rather than merely narrow. Under READ COMMITTED the predicate is re-evaluated after the
  -- lock is granted, so a reclaim that commits while we wait (it NULLs lease_token) leaves us
  -- matching zero rows — we abort instead of deleting the rows the replacement is about to write.
  -- The lock is held to COMMIT, so the delete-reinsert below cannot interleave with another
  -- worker's claim of the same job.
  perform 1 from public.jobs
   where id = p_job_id
     and trip_id = p_trip_id
     and lease_token = p_lease_token
     and status = 'running'
     for update;
  if not found then
    return false;
  end if;

  -- Retry-safety: clear THIS trip's hotel rows (per-trip search, delete-first — the same
  -- idempotency persist_hotels already relied on, now inside the fence).
  delete from public.hotel_suggestions where trip_id = p_trip_id;

  insert into public.hotel_suggestions
    (trip_id, base_place_id, name, area, star_rating, price_snapshot,
     travala_hotel_id, travala_session_id, travala_package_id, travala_result_json,
     source, status,
     lat, lng, geo_status, route_score, rank, is_recommended, place_durations)
  select p_trip_id,
         (row_value->>'base_place_id')::uuid,
         row_value->>'name',
         row_value->>'area',
         (row_value->>'star_rating')::numeric,
         coalesce(row_value->'price_snapshot', '{}'::jsonb),
         row_value->>'travala_hotel_id',
         row_value->>'travala_session_id',
         row_value->>'travala_package_id',
         coalesce(row_value->'travala_result_json', '{}'::jsonb),
         coalesce(row_value->>'source', 'travala'),
         coalesce(row_value->>'status', 'suggested'),
         (row_value->>'lat')::double precision,
         (row_value->>'lng')::double precision,
         coalesce(row_value->>'geo_status', 'unresolved'),
         (row_value->>'route_score')::numeric,
         (row_value->>'rank')::smallint,
         coalesce((row_value->>'is_recommended')::boolean, false),
         coalesce(row_value->'place_durations', '{}'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as row_value;

  return true;
end $$;

revoke all on function public.replace_hotel_suggestions(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_hotel_suggestions(uuid, uuid, uuid, jsonb)
  to service_role;
