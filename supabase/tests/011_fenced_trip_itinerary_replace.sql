-- `replace_trip_itinerary` against real Postgres (20260720150000).
--
-- The fence is the point, and it has to be EXECUTED to be proven. plpgsql defers
-- "operator does not exist: uuid = text" and every jsonb cast error to RUNTIME, so
-- `supabase db reset` alone reports a perfectly healthy function that raises on its first
-- real call. The shape checks below (security definer, empty search_path, service-role-only
-- execute) mirror 008_job_leases.sql; the behavioural half is what this file adds.

begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000901', 'itinerary-fence@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values ('85000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000901', 'generating', 'Tokyo');

insert into public.jobs (id, trip_id, user_id, idempotency_key, status, lease_token, lock_expires_at)
values ('86000000-0000-0000-0000-000000000001',
        '85000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000901',
        'fenced-itinerary-a', 'running',
        '87000000-0000-0000-0000-00000000000a',
        now() + interval '5 minutes');

insert into public.places (id, name, place_type, lat, lng)
values ('88000000-0000-0000-0000-000000000001', 'Tokyo Tower', 'attraction', 35.6586, 139.7454),
       ('88000000-0000-0000-0000-000000000002', 'Senso-ji', 'attraction', 35.7148, 139.7967);

-- Shape, mirroring the two RPCs 008 already pins.
select ok(
  to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)') is not null,
  'replace_trip_itinerary exists'
);
select ok(
  coalesce((select prosecdef from pg_proc
             where oid = to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)')),
           false),
  'replace_trip_itinerary is security definer'
);
select ok(
  coalesce((select 'search_path=""' = any(proconfig) from pg_proc
             where oid = to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)')),
           false),
  'replace_trip_itinerary has an empty search path'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute replace_trip_itinerary'
);
select ok(
  not coalesce(has_function_privilege('anon',
    to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)'), 'EXECUTE'), false),
  'anon cannot execute replace_trip_itinerary'
);
select ok(
  not coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)'), 'EXECUTE'), false),
  'authenticated cannot execute replace_trip_itinerary'
);
select ok(
  coalesce(has_function_privilege('service_role',
    to_regprocedure('public.replace_trip_itinerary(uuid,uuid,uuid,jsonb,jsonb)'), 'EXECUTE'), false),
  'service_role can execute replace_trip_itinerary'
);

-- The lease holder writes. Also the only execution proof that every jsonb cast in the
-- function body is right.
select is(
  public.replace_trip_itinerary(
    '86000000-0000-0000-0000-000000000001',
    '85000000-0000-0000-0000-000000000001',
    '87000000-0000-0000-0000-00000000000a',
    '[{"place_id":"88000000-0000-0000-0000-000000000002","source_type":"reel_extracted",
       "evidence_json":{"quote":"📍Senso-ji"},"day_number":1,"sort_order":0}]'::jsonb,
    '[{"day_number":1,"day_date":"2026-08-01"}]'::jsonb
  ),
  true,
  'the lease holder rewrites the itinerary'
);
select is(
  (select count(*)::integer from public.trip_places
    where trip_id = '85000000-0000-0000-0000-000000000001'),
  1,
  'the leased rewrite inserted the place link'
);
select is(
  (select day_date from public.trip_days
    where trip_id = '85000000-0000-0000-0000-000000000001'),
  '2026-08-01'::date,
  'day_date survives the jsonb -> date cast'
);

-- THE FENCE. A superseded worker's rewrite must write NOTHING — not the insert, and above
-- all not the DELETE. Asserted while the row is still `running` and carrying the replacement's
-- token, so it is the TOKEN doing the work: were the row already terminal, `status =
-- 'running'` would reject the stale call on its own and the token predicate could be deleted
-- outright with this test still green.
select is(
  public.replace_trip_itinerary(
    '86000000-0000-0000-0000-000000000001',
    '85000000-0000-0000-0000-000000000001',
    '87000000-0000-0000-0000-00000000000b',            -- a superseded worker's stale token
    '[{"place_id":"88000000-0000-0000-0000-000000000001","source_type":"reel_extracted",
       "evidence_json":{},"day_number":1,"sort_order":0}]'::jsonb,
    '[{"day_number":1,"day_date":"2026-08-02"}]'::jsonb
  ),
  false,
  'a stale lease token is refused'
);
select is(
  (select place_id from public.trip_places
    where trip_id = '85000000-0000-0000-0000-000000000001'),
  '88000000-0000-0000-0000-000000000002'::uuid,
  'the refused rewrite neither deleted nor replaced the live itinerary'
);
select is(
  (select day_date from public.trip_days
    where trip_id = '85000000-0000-0000-0000-000000000001'),
  '2026-08-01'::date,
  'the refused rewrite left trip_days untouched'
);

-- A lease on job X may not rewrite some OTHER trip: the fence carries the owner check
-- (guardrail #6) through the job row rather than trusting a caller-supplied user_id.
select is(
  public.replace_trip_itinerary(
    '86000000-0000-0000-0000-000000000001',
    '85000000-0000-0000-0000-000000000002',            -- not this job's trip
    '87000000-0000-0000-0000-00000000000a',
    '[]'::jsonb, '[]'::jsonb
  ),
  false,
  'a valid lease cannot rewrite a trip the job does not own'
);

select * from finish();
rollback;
