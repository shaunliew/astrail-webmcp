begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000801', 'lease-a@example.com'),
  ('00000000-0000-0000-0000-000000000802', 'lease-b@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values
  ('75000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801', 'generating', 'Tokyo'),
  -- second running trip, reserved for the null-payload coalesce assertion (the ...0001 job is
  -- already terminal by the time that runs, so it cannot be reused)
  ('75000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000801', 'generating', 'Osaka');

insert into public.jobs (id, trip_id, user_id, idempotency_key, status, lease_token, lock_expires_at)
values (
  '76000000-0000-0000-0000-000000000001',
  '75000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000801',
  'lease-trip-a',
  'running',
  '77000000-0000-0000-0000-00000000000a',
  now() + interval '5 minutes'
);

insert into public.jobs (id, trip_id, user_id, idempotency_key, status, lease_token, lock_expires_at)
values (
  '76000000-0000-0000-0000-000000000002',
  '75000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000801',
  'lease-trip-b',
  'running',
  '77000000-0000-0000-0000-000000000002',
  now() + interval '5 minutes'
);

insert into public.organize_jobs (
  id, user_id, idempotency_key, status, request_json, locked_at, lock_expires_at, lease_token, attempt_count, total_count
)
values (
  '78000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000801',
  'lease-organize-a',
  'processing',
  '{"saved_reel_ids":["lease-a"]}'::jsonb,
  now(),
  now() + interval '5 minutes',
  '79000000-0000-0000-0000-00000000000a',
  1,
  1
);

-- Columns and reap indexes.
select has_column('public', 'organize_jobs', 'lease_token', 'organize jobs carry a lease token');
select col_type_is('public', 'organize_jobs', 'lease_token', 'uuid', 'organize job lease token is uuid');
select has_column('public', 'jobs', 'lease_token', 'trip jobs carry a lease token');
select col_type_is('public', 'jobs', 'lease_token', 'uuid', 'trip job lease token is uuid');
select has_column('public', 'jobs', 'lock_expires_at', 'trip jobs carry a lease expiry');
select col_type_is('public', 'jobs', 'lock_expires_at', 'timestamp with time zone', 'trip job lease expiry is timestamptz');
select has_index('public', 'organize_jobs', 'organize_jobs_lease_reap_idx', 'organize jobs have a lease reap index');
select has_index('public', 'jobs', 'jobs_lease_reap_idx', 'trip jobs have a lease reap index');
select ok(
  (
    select pg_get_expr(indpred, indrelid) like '%processing%'
    from pg_index
    where indexrelid = to_regclass('public.organize_jobs_lease_reap_idx')
  ),
  'organize job reap index only covers processing rows'
);
select ok(
  (
    select pg_get_expr(indpred, indrelid) like '%running%'
    from pg_index
    where indexrelid = to_regclass('public.jobs_lease_reap_idx')
  ),
  'trip job reap index only covers running rows'
);

-- Both functions exist, are security definer, and pin an empty search path.
select ok(
  to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)') is not null,
  'append_organize_event exists'
);
select ok(
  to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)') is not null,
  'complete_trip_run exists'
);
select ok(
  coalesce(
    (
      select prosecdef
      from pg_proc
      where oid = to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)')
    ),
    false
  ),
  'append_organize_event is security definer'
);
select ok(
  coalesce(
    (
      select prosecdef
      from pg_proc
      where oid = to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)')
    ),
    false
  ),
  'complete_trip_run is security definer'
);
select ok(
  coalesce(
    (
      select 'search_path=""' = any(proconfig)
      from pg_proc
      where oid = to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)')
    ),
    false
  ),
  'append_organize_event has an empty search path'
);
select ok(
  coalesce(
    (
      select 'search_path=""' = any(proconfig)
      from pg_proc
      where oid = to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)')
    ),
    false
  ),
  'complete_trip_run has an empty search path'
);

-- Execute privileges: service role only.
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute append_organize_event'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute complete_trip_run'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)'), 'EXECUTE'), false),
  'anon cannot execute append_organize_event'
);
select ok(
  not coalesce(has_function_privilege('anon', to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)'), 'EXECUTE'), false),
  'anon cannot execute complete_trip_run'
);
select ok(
  not coalesce(has_function_privilege('authenticated', to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)'), 'EXECUTE'), false),
  'authenticated cannot execute append_organize_event'
);
select ok(
  not coalesce(has_function_privilege('authenticated', to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)'), 'EXECUTE'), false),
  'authenticated cannot execute complete_trip_run'
);
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('public.append_organize_event(uuid,uuid,uuid,text,text,jsonb)'), 'EXECUTE'), false),
  'service role can execute append_organize_event'
);
select ok(
  coalesce(has_function_privilege('service_role', to_regprocedure('public.complete_trip_run(uuid,uuid,uuid,text,text,text,jsonb)'), 'EXECUTE'), false),
  'service role can execute complete_trip_run'
);

-- The privilege assertions above are metadata only, and metadata runs fine on the superuser
-- connection. Actually invoking the functions must run AS authenticated, or the superuser
-- sails past the revoke and no error is ever raised.
set local role authenticated;
select throws_ok(
  $$select public.append_organize_event('78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801', '79000000-0000-0000-0000-00000000000a', 'stage', 'forbidden')$$,
  '42501', null,
  'authenticated clients cannot invoke append_organize_event'
);
select throws_ok(
  $$select public.complete_trip_run('76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001', '77000000-0000-0000-0000-00000000000a', 'succeeded', 'save', 'forbidden', '{}'::jsonb)$$,
  '42501', null,
  'authenticated clients cannot invoke complete_trip_run'
);
reset role;

set local role service_role;

-- append_organize_event allocates a gapless sequence under its own row lock.
select is(
  public.append_organize_event(
    '78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801',
    '79000000-0000-0000-0000-00000000000a', 'stage', 'Finding places', '{"processed_count":0}'::jsonb
  ),
  1,
  'first organize event append allocates sequence one'
);
select is(
  public.append_organize_event(
    '78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801',
    '79000000-0000-0000-0000-00000000000a', 'stage', 'Organizing reel one', '{"processed_count":1}'::jsonb
  ),
  2,
  'second organize event append allocates sequence two'
);
select is(
  public.append_organize_event(
    '78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801',
    '79000000-0000-0000-0000-00000000000a', 'stage', 'Organizing reel two', '{"processed_count":2}'::jsonb
  ),
  3,
  'third organize event append allocates sequence three'
);
select is(
  public.append_organize_event(
    '78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801',
    '79000000-0000-0000-0000-00000000000a', 'stage', 'Organizing reel three', '{"processed_count":3}'::jsonb
  ),
  4,
  'fourth organize event append allocates sequence four'
);
select is(
  public.append_organize_event(
    '78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801',
    '79000000-0000-0000-0000-00000000000a', 'complete', 'Organized 3 reels'
  ),
  5,
  'omitting the payload still allocates the next sequence'
);
select results_eq(
  $$select sequence, event_type, message, payload from public.organize_events
     where job_id = '78000000-0000-0000-0000-000000000001' order by sequence$$,
  $$values
      (1, 'stage'::text, 'Finding places'::text, '{"processed_count":0}'::jsonb),
      (2, 'stage'::text, 'Organizing reel one'::text, '{"processed_count":1}'::jsonb),
      (3, 'stage'::text, 'Organizing reel two'::text, '{"processed_count":2}'::jsonb),
      (4, 'stage'::text, 'Organizing reel three'::text, '{"processed_count":3}'::jsonb),
      (5, 'complete'::text, 'Organized 3 reels'::text, '{}'::jsonb)$$,
  'organize event sequences are gapless and carry their payloads'
);
select is(
  (select count(*)::integer from public.organize_events where job_id = '78000000-0000-0000-0000-000000000001'),
  5,
  'five appends wrote exactly five organize events'
);

select throws_ok(
  $$select public.append_organize_event('78000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-000000000801', '79000000-0000-0000-0000-00000000000a', 'stage', 'unknown job')$$,
  'AS404', null,
  'appending to an unknown organize job raises AS404'
);
select throws_ok(
  $$select public.append_organize_event('78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000802', '79000000-0000-0000-0000-00000000000a', 'stage', 'cross owner')$$,
  'AS404', null,
  'appending to another owner organize job raises AS404'
);
select throws_ok(
  $$select public.append_organize_event('78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801', '79000000-0000-0000-0000-0000000000ff', 'stage', 'superseded')$$,
  'AS409', null,
  'appending with a superseded lease token raises AS409'
);
select throws_ok(
  $$select public.append_organize_event('78000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000801', null, 'stage', 'unfenced')$$,
  'AS400', null,
  'appending with no lease token raises AS400'
);
select is(
  (select count(*)::integer from public.organize_events where job_id = '78000000-0000-0000-0000-000000000001'),
  5,
  'rejected appends wrote no organize events'
);

-- complete_trip_run: a superseded worker must write NOTHING, in either table.
select is(
  public.complete_trip_run(
    '76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001',
    '77000000-0000-0000-0000-0000000000ff', 'failed', 'save', 'stale worker result', '{"error":"stale"}'::jsonb
  ),
  false,
  'a superseded trip lease cannot complete the run'
);
select is(
  (select count(*)::integer from public.generation_events where trip_id = '75000000-0000-0000-0000-000000000001'),
  0,
  'a superseded trip lease writes no result event'
);
select results_eq(
  $$select status, completed_at is null from public.jobs where id = '76000000-0000-0000-0000-000000000001'$$,
  $$values ('running'::text, true)$$,
  'a superseded trip lease leaves the job untouched'
);

-- The owning worker completes the job and its result event in one transaction.
select is(
  public.complete_trip_run(
    '76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001',
    '77000000-0000-0000-0000-00000000000a', 'succeeded', 'save', 'generation complete', '{"trip_id":"75000000-0000-0000-0000-000000000001"}'::jsonb
  ),
  true,
  'the lease holder completes the trip run'
);
select is(
  (select count(*)::integer from public.generation_events where trip_id = '75000000-0000-0000-0000-000000000001'),
  1,
  'the lease holder writes exactly one result event'
);
select results_eq(
  $$select event_type, stage, message, payload from public.generation_events where trip_id = '75000000-0000-0000-0000-000000000001'$$,
  $$values ('result'::text, 'save'::text, 'generation complete'::text, '{"trip_id":"75000000-0000-0000-0000-000000000001"}'::jsonb)$$,
  'the result event carries the terminal stage, message and payload'
);
select results_eq(
  $$select status, completed_at is not null from public.jobs where id = '76000000-0000-0000-0000-000000000001'$$,
  $$values ('succeeded'::text, true)$$,
  'completing the trip run stamps the terminal job status'
);

-- Replay: the status guard makes completion single-shot even for the real lease holder.
select is(
  public.complete_trip_run(
    '76000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001',
    '77000000-0000-0000-0000-00000000000a', 'failed', 'save', 'duplicate result', '{}'::jsonb
  ),
  false,
  'completing an already terminal trip run is refused'
);
select is(
  (select count(*)::integer from public.generation_events where trip_id = '75000000-0000-0000-0000-000000000001'),
  1,
  'a refused replay writes no second result event'
);
select results_eq(
  $$select status from public.jobs where id = '76000000-0000-0000-0000-000000000001'$$,
  $$values ('succeeded'::text)$$,
  'a refused replay leaves the terminal job status intact'
);

-- A null payload must be coalesced, not rejected. generation_events.payload is NOT NULL and
-- the INSERT names the column, so the DEFAULT never applies — without coalesce this raises
-- 23502. append_organize_event coalesces; this asserts complete_trip_run matches it.
select lives_ok(
  $$select public.complete_trip_run(
      '76000000-0000-0000-0000-000000000002'::uuid,
      '75000000-0000-0000-0000-000000000002'::uuid,
      '77000000-0000-0000-0000-000000000002'::uuid,
      'succeeded', 'save', 'generation complete', null)$$,
  'a null payload is coalesced, not a not-null violation'
);
select results_eq(
  $$select payload from public.generation_events
     where trip_id = '75000000-0000-0000-0000-000000000002'$$,
  $$values ('{}'::jsonb)$$,
  'a coalesced null payload is stored as an empty object'
);

reset role;
select * from finish();

rollback;
