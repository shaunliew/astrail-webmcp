-- `find_or_create_place` against real Postgres (20260720160000).
--
-- The serialization is the point, and a lock cannot be proven by a single session: a test that
-- only calls the function twice in a row passes identically whether or not the advisory lock
-- exists. So the middle of this file opens REAL concurrent backends through dblink and watches
-- one of them block on another.
--
-- ORDERING IS LOAD-BEARING: the race runs BEFORE any call from this session. A call from here
-- takes the same transaction-level advisory lock and holds it until the closing rollback, so
-- the race's own "holder" backend would block on US and `dblink()` would wait forever — a hung
-- pg_prove instead of a failing one. The DO block asserts that precondition rather than
-- trusting this comment.
--
-- The behavioural half at the end is not decoration either. plpgsql defers every operator and
-- cast error to RUNTIME, so `supabase db reset` reports a perfectly healthy function whose
-- haversine expression raises — or worse, silently never matches — on its first real call.

begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select plan(20);

-- Shape and privileges, mirroring 008_job_leases.sql and 011_fenced_trip_itinerary_replace.sql.
select ok(
  to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)') is not null,
  'find_or_create_place exists'
);
select ok(
  coalesce((select prosecdef from pg_proc
             where oid = to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)')),
           false),
  'find_or_create_place is security definer'
);
select ok(
  coalesce((select 'search_path=""' = any(proconfig) from pg_proc
             where oid = to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)')),
           false),
  'find_or_create_place has an empty search path'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute find_or_create_place'
);
select ok(
  not coalesce(has_function_privilege('anon',
    to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'anon cannot execute find_or_create_place'
);
select ok(
  not coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'authenticated cannot execute find_or_create_place'
);
select ok(
  coalesce(has_function_privilege('service_role',
    to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'service_role can execute find_or_create_place'
);

-- THE SERIALIZATION. Two real backends, because a lock is invisible from one.
--
-- The fix also depends on READ COMMITTED: `pg_advisory_xact_lock` and the reuse SELECT are
-- separate statements, so the SELECT takes its snapshot AFTER the lock is granted and
-- therefore sees the row the other worker just committed. Under REPEATABLE READ the snapshot
-- predates the lock, the waiter would still see nothing, and it would insert the duplicate
-- anyway — the lock would be doing visible work and no good at all. Pin the assumption.
select is(
  current_setting('default_transaction_isolation'),
  'read committed',
  'the re-check-under-lock depends on READ COMMITTED snapshots'
);

create temporary table race_observed (
  same_key_busy integer,      -- 1 = the contending backend was still waiting
  other_key_busy integer,     -- 0 = a different lock key was never made to wait
  waiter_id uuid,             -- what the waiter got once the holder committed
  holder_id uuid,
  rows_for_name integer,
  rows_after_cleanup integer
);

do $race$
declare
  -- The stock local-Supabase credentials (`supabase status` prints this exact URL). dblink
  -- refuses a connection whose password went unused, so this must NOT go to 127.0.0.1: local
  -- pg_hba trusts loopback and scram-authenticates the server's own address, which is what
  -- `inet_server_addr()` resolves to from both the pg_prove container and a host psql.
  v_conn text := format('dbname=%s user=postgres password=postgres host=%s port=%s',
                        current_database(), host(inet_server_addr()), inet_server_port());
  v_holder uuid;
  v_waiter uuid;
  v_same_busy integer;
  v_other_busy integer;
  v_rows integer;
  v_left integer;
begin
  if inet_server_addr() is null then
    raise exception 'no server address: this test needs a TCP connection, not a unix socket';
  end if;
  -- The ordering precondition, checked rather than assumed. Diagnosed the hard way: with the
  -- behavioural half above this block, THIS session holds the lock the holder wants, the
  -- holder's synchronous `dblink()` never returns, and pg_prove hangs with no output at all.
  if exists (
    select 1 from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid()
       and classid = pg_catalog.hashtext('public.find_or_create_place')::oid
  ) then
    raise exception 'this session already holds a find_or_create_place advisory lock — the '
                    'race must run before any in-session call, or the holder deadlocks on us';
  end if;

  perform extensions.dblink_connect('holder', v_conn);
  perform extensions.dblink_connect('waiter', v_conn);
  perform extensions.dblink_connect('bystander', v_conn);

  -- The holder opens a transaction and creates the place, so it keeps the advisory lock.
  perform extensions.dblink_exec('holder', 'begin');
  select id into v_holder from extensions.dblink('holder',
    $q$select public.find_or_create_place('Race Cafe','attraction',35.0,139.0,
        'Japan','JP','Japan','Tokyo',500)::text$q$) as t(id uuid);

  -- The replacement worker: same name, same country, ~1.4 m away — the duplicate this whole
  -- migration exists to prevent. Asynchronous, so we can observe it mid-wait.
  perform extensions.dblink_send_query('waiter',
    $q$select public.find_or_create_place('Race Cafe','attraction',35.00001,139.00001,
        'Japan','JP','Japan','Tokyo',500)::text$q$);
  -- A different name: a lock keyed on the identity must let this straight through. A blanket
  -- mutex would satisfy the wait assertion below and fail here.
  perform extensions.dblink_send_query('bystander',
    $q$select public.find_or_create_place('Bystander Cafe','attraction',35.0,139.0,
        'Japan','JP','Japan','Tokyo',500)::text$q$);
  perform pg_sleep(0.5);        -- ~500x an uncontended call; only a real wait survives it
  v_same_busy := extensions.dblink_is_busy('waiter');
  v_other_busy := extensions.dblink_is_busy('bystander');

  -- Release the lock BEFORE draining either backend, so both always come back and the verdict
  -- rests on the samples taken above, while the lock was still held.
  perform extensions.dblink_exec('holder', 'commit');
  perform * from extensions.dblink_get_result('bystander') as t(id uuid);
  select id into v_waiter from extensions.dblink_get_result('waiter') as t(id uuid);
  select count(*)::integer into v_rows from public.places where name = 'Race Cafe';

  -- Clean up BEFORE asserting: these backends committed for real, outside this transaction's
  -- rollback, so nothing between that commit and here may be allowed to fail.
  perform extensions.dblink_exec('holder',
    $q$delete from public.places where name in ('Race Cafe','Bystander Cafe')$q$);
  select count(*)::integer into v_left from public.places
   where name in ('Race Cafe', 'Bystander Cafe');
  perform extensions.dblink_disconnect('holder');
  perform extensions.dblink_disconnect('waiter');
  perform extensions.dblink_disconnect('bystander');

  insert into race_observed
  values (v_same_busy, v_other_busy, v_waiter, v_holder, v_rows, v_left);
exception when others then
  -- Best-effort teardown so a failure strands neither committed rows nor open backends.
  begin
    perform extensions.dblink_exec('holder', 'rollback');
    perform extensions.dblink_exec('holder',
      $q$delete from public.places where name in ('Race Cafe','Bystander Cafe')$q$);
  exception when others then null;
  end;
  perform extensions.dblink_disconnect(open_name)
     from unnest(extensions.dblink_get_connections()) as open_name;
  raise;
end $race$;

select is(
  (select same_key_busy from race_observed), 1,
  'a second backend requesting the same place BLOCKS while the first holds the lock'
);
select is(
  (select other_key_busy from race_observed), 0,
  'a different place is not blocked — the lock is keyed on identity, not global'
);
select is(
  (select waiter_id from race_observed),
  (select holder_id from race_observed),
  'once the holder commits, the waiter reuses its row instead of inserting'
);
select is(
  (select rows_for_name from race_observed), 1,
  'the race produced ONE canonical row, which is the whole point'
);
select is(
  (select rows_after_cleanup from race_observed), 0,
  'the committed race rows were cleaned up (they outlive this transaction)'
);

-- The reuse rule, executed. Every id below comes from a real call, so the haversine
-- expression, the 500 m gate and the country predicate are exercised rather than read.
create temporary table found_place (label text primary key, id uuid);

insert into found_place values
  ('tokyo', public.find_or_create_place(
     'Harry Potter Cafe', 'restaurant', 35.67311, 139.73625, 'Japan', 'JP', 'Japan', 'Tokyo', 500)),
  -- ~11 m away: inside the gate.
  ('tokyo_nearby', public.find_or_create_place(
     'Harry Potter Cafe', 'restaurant', 35.67320, 139.73630, 'Japan', 'JP', 'Japan', 'Tokyo', 500)),
  -- Osaka, ~400 km away: outside it.
  ('osaka', public.find_or_create_place(
     'Harry Potter Cafe', 'restaurant', 34.69370, 135.50230, 'Japan', 'JP', 'Japan', 'Osaka', 500)),
  -- Same name, same coordinates as 'tokyo', different verified country.
  ('mexico', public.find_or_create_place(
     'Harry Potter Cafe', 'restaurant', 35.67311, 139.73625, 'Mexico', 'MX', 'Mexico', 'CDMX', 500));

select is(
  (select id from found_place where label = 'tokyo_nearby'),
  (select id from found_place where label = 'tokyo'),
  'a place inside the 500 m gate reuses the canonical row'
);
select isnt(
  (select id from found_place where label = 'osaka'),
  (select id from found_place where label = 'tokyo'),
  'the same name outside the gate gets its own row'
);
select isnt(
  (select id from found_place where label = 'mexico'),
  (select id from found_place where label = 'tokyo'),
  'the same name in another verified country is never reused'
);
select is(
  (select count(*)::integer from public.places where name = 'Harry Potter Cafe'),
  3,
  'four calls produced exactly three canonical rows'
);
select ok(
  (select embedding is null from public.places
    where id = (select id from found_place where label = 'tokyo')),
  'a newly created place leaves embedding NULL (ISSUES-B3, deliberate)'
);

-- Country backfill: a legacy row can carry an LLM-guessed label beside a correct code, and a
-- reuse repairs all three from the freshly Mapbox-verified values.
update public.places
   set country = 'United States', country_name = 'United States'
 where id = (select id from found_place where label = 'tokyo');

select is(
  public.find_or_create_place(
    'Harry Potter Cafe', 'restaurant', 35.67320, 139.73630, 'Japan', 'JP', 'Japan', 'Tokyo', 500),
  (select id from found_place where label = 'tokyo'),
  'the poisoned row is still the reuse target'
);
select is(
  (select country || '/' || country_name from public.places
    where id = (select id from found_place where label = 'tokyo')),
  'Japan/Japan',
  'reuse repairs the poisoned country labels'
);

select * from finish();
rollback;
