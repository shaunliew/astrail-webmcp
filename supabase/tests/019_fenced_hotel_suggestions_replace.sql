-- `replace_hotel_suggestions` against real Postgres (20260804120000).
--
-- Same reasoning as 011_fenced_trip_itinerary_replace.sql: the fence is the point, and it has
-- to be EXECUTED to be proven. plpgsql defers "operator does not exist: uuid = text" and every
-- jsonb cast (double precision / numeric / smallint / boolean / jsonb) to RUNTIME, so
-- `supabase db reset` alone reports a perfectly healthy function that raises on its first real
-- call. The shape checks below mirror 011; the behavioural half — a valid lease writing, the
-- seven geo columns surviving their casts, the NOT-NULL coalesce defaults, a stale/cross-trip
-- lease refused with no clobber — is what this file adds and the only thing that persists into
-- CI as a regression guard.

begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000902', 'hotel-fence@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values ('95000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000902', 'generating', 'Tokyo');

insert into public.jobs (id, trip_id, user_id, idempotency_key, status, lease_token, lock_expires_at)
values ('96000000-0000-0000-0000-000000000001',
        '95000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000902',
        'fenced-hotel-a', 'running',
        '97000000-0000-0000-0000-00000000000a',
        now() + interval '5 minutes');

-- Shape, mirroring the two RPCs 008/011 already pin.
select ok(
  to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)') is not null,
  'replace_hotel_suggestions exists'
);
select ok(
  coalesce((select prosecdef from pg_proc
             where oid = to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)')),
           false),
  'replace_hotel_suggestions is security definer'
);
select ok(
  coalesce((select 'search_path=""' = any(proconfig) from pg_proc
             where oid = to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)')),
           false),
  'replace_hotel_suggestions has an empty search path'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute replace_hotel_suggestions'
);
select ok(
  not coalesce(has_function_privilege('anon',
    to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)'), 'EXECUTE'), false),
  'anon cannot execute replace_hotel_suggestions'
);
select ok(
  not coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)'), 'EXECUTE'), false),
  'authenticated cannot execute replace_hotel_suggestions'
);
select ok(
  coalesce(has_function_privilege('service_role',
    to_regprocedure('public.replace_hotel_suggestions(uuid,uuid,uuid,jsonb)'), 'EXECUTE'), false),
  'service_role can execute replace_hotel_suggestions'
);

-- The lease holder writes. Also the only execution proof that every jsonb cast in the function
-- body is right (lat/lng -> double precision, route_score -> numeric, rank -> smallint,
-- is_recommended -> boolean, place_durations -> jsonb).
select is(
  public.replace_hotel_suggestions(
    '96000000-0000-0000-0000-000000000001',
    '95000000-0000-0000-0000-000000000001',
    '97000000-0000-0000-0000-00000000000a',
    '[{"name":"Central Hotel","area":"Chiyoda","star_rating":4,
       "price_snapshot":{"pricePerNight":200,"currency":"USD"},
       "travala_hotel_id":"100","travala_session_id":"sess-1","travala_package_id":"pkg-1",
       "travala_result_json":{"name":"Central Hotel"},"source":"travala","status":"suggested",
       "lat":35.67,"lng":139.72,"geo_status":"placed","route_score":450,"rank":1,
       "is_recommended":true,"place_durations":{"pa":300,"pb":600}}]'::jsonb
  ),
  true,
  'the lease holder writes the hotel suggestions'
);
select is(
  (select count(*)::integer from public.hotel_suggestions
    where trip_id = '95000000-0000-0000-0000-000000000001'),
  1,
  'the leased write inserted exactly one hotel row'
);
select is(
  (select lat from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  35.67::double precision,
  'lat survives the jsonb -> double precision cast'
);
select is(
  (select lng from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  139.72::double precision,
  'lng survives the jsonb -> double precision cast'
);
select is(
  (select geo_status from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  'placed',
  'geo_status is written as provided'
);
select is(
  (select route_score from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  450::numeric,
  'route_score survives the jsonb -> numeric cast'
);
select is(
  (select rank from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  1::smallint,
  'rank survives the jsonb -> smallint cast'
);
select is(
  (select is_recommended from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  true,
  'is_recommended survives the jsonb -> boolean cast'
);
select is(
  (select place_durations->>'pa' from public.hotel_suggestions
    where trip_id = '95000000-0000-0000-0000-000000000001'),
  '300',
  'place_durations survives the jsonb cast, keyed by place_id'
);

-- NOT-NULL coalesce: a minimal row (only a name) must backfill the defaulted columns rather than
-- violate their NOT NULL constraints — the guarantee the coalesce()s in the insert encode.
select is(
  public.replace_hotel_suggestions(
    '96000000-0000-0000-0000-000000000001',
    '95000000-0000-0000-0000-000000000001',
    '97000000-0000-0000-0000-00000000000a',
    '[{"name":"Minimal Inn"}]'::jsonb
  ),
  true,
  'a minimal row (name only) writes without a NOT NULL violation'
);
select is(
  (select geo_status from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  'unresolved',
  'geo_status coalesces to its unresolved default when absent'
);
select is(
  (select is_recommended from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  false,
  'is_recommended coalesces to false when absent'
);
select is(
  (select place_durations from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  '{}'::jsonb,
  'place_durations coalesces to {} when absent'
);

-- THE FENCE. A superseded worker's rewrite must write NOTHING — not the insert, and above all
-- not the DELETE. Asserted while the row is still `running` and carrying the replacement's token,
-- so it is the TOKEN doing the work.
select is(
  public.replace_hotel_suggestions(
    '96000000-0000-0000-0000-000000000001',
    '95000000-0000-0000-0000-000000000001',
    '97000000-0000-0000-0000-00000000000b',            -- a superseded worker's stale token
    '[{"name":"Zombie Hotel"}]'::jsonb
  ),
  false,
  'a stale lease token is refused'
);
select is(
  (select count(*)::integer from public.hotel_suggestions
    where trip_id = '95000000-0000-0000-0000-000000000001'),
  1,
  'the refused rewrite neither deleted nor inserted'
);
select is(
  (select name from public.hotel_suggestions where trip_id = '95000000-0000-0000-0000-000000000001'),
  'Minimal Inn',
  'the refused rewrite left the live hotel row untouched'
);

-- A lease on job X may not rewrite some OTHER trip: the fence carries the owner check
-- (guardrail #6) through the job row rather than trusting a caller-supplied user_id.
select is(
  public.replace_hotel_suggestions(
    '96000000-0000-0000-0000-000000000001',
    '95000000-0000-0000-0000-000000000002',            -- not this job's trip
    '97000000-0000-0000-0000-00000000000a',
    '[]'::jsonb
  ),
  false,
  'a valid lease cannot rewrite a trip the job does not own'
);

-- The geo_status<->coords invariant (hotel_suggestions_geo_coords_consistent): a `placed` row with
-- NULL coords is a lie the honest-failure contract forbids. The CHECK must reject it — the insert
-- raises check_violation (SQLSTATE 23514) inside the fenced RPC (valid lease, so the fence passes
-- and it is the CHECK, not the fence, doing the refusing). throws_ok rolls the failed call back, so
-- the live 'Minimal Inn' row is untouched.
select throws_ok(
  $$ select public.replace_hotel_suggestions(
       '96000000-0000-0000-0000-000000000001',
       '95000000-0000-0000-0000-000000000001',
       '97000000-0000-0000-0000-00000000000a',
       '[{"name":"Coordless Placed","geo_status":"placed"}]'::jsonb) $$,
  '23514',
  NULL,
  'a placed row with null coords is rejected by the geo/coords CHECK'
);

select * from finish();
rollback;
