-- `places.name_local` and the fill-if-null reuse rule (20260720190000), against real Postgres.
--
-- THIS FILE IS THE LOAD-BEARING PROOF, and the Python mirror in `test_saved_reels_organize.py`
-- cannot stand in for it. That mirror is a hand-written transcription of `find_or_create_place`:
-- it implements the coalesce itself, so every Python assertion about the local name would stay
-- green if the real function's INSERT never mentioned the column and its UPDATE never coalesced.
-- The fake is also a dict — it accepts any key, whereas Postgres rejects a column that does not
-- exist. Only a real call can tell the two apart, which is exactly how a payload has previously
-- passed in tests here and 500'd in production.
--
-- The reuse rule under test is `name_local = coalesce(name_local, p_name_local)`: fill a null
-- one, never blank one, never replace one. The asymmetry with the country labels beside it —
-- which ARE overwritten — is deliberate and argued in the migration: this run re-verifies the
-- country against Mapbox and re-verifies nothing about the local name.

begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- The column. Nullable and unbackfilled on purpose: a caption with no local-script name has no
-- local name, and inventing one would be a guardrail #1 violation.
select has_column('public', 'places', 'name_local', 'places has a name_local column');
select col_is_null('public', 'places', 'name_local', 'places.name_local is nullable');

-- THE DROP. Adding a parameter makes a new signature, so `create or replace` alone would have
-- left the 9-argument function behind as an overload — a live, still-granted definition that
-- writes no name_local and wins any 9-argument call. Asserting its ABSENCE is what proves the
-- migration replaced the function rather than shadowing it.
select ok(
  to_regprocedure('public.find_or_create_place(text,text,double precision,double precision,text,text,text,text,double precision)') is null,
  'the superseded 9-argument find_or_create_place is GONE, not left as an overload'
);

-- Shape and privileges on the new signature, mirroring the bar in 012.
select ok(
  to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)') is not null,
  'the 10-argument find_or_create_place exists'
);
select ok(
  coalesce((select prosecdef from pg_proc
             where oid = to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)')),
           false),
  'find_or_create_place is still security definer'
);
select ok(
  coalesce((select 'search_path=""' = any(proconfig) from pg_proc
             where oid = to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)')),
           false),
  'find_or_create_place still has an empty search path'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC still cannot execute find_or_create_place'
);
select ok(
  not coalesce(has_function_privilege('anon',
    to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'anon still cannot execute find_or_create_place'
);
select ok(
  not coalesce(has_function_privilege('authenticated',
    to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'authenticated still cannot execute find_or_create_place'
);
select ok(
  coalesce(has_function_privilege('service_role',
    to_regprocedure('public.find_or_create_place(text,text,text,double precision,double precision,text,text,text,text,double precision)'), 'EXECUTE'), false),
  'service_role can still execute find_or_create_place'
);

-- THE BEHAVIOUR. Every id below comes from a real call, so the insert's column list and the
-- update's coalesce are executed rather than read — plpgsql defers both to runtime, and a
-- function that never writes the column passes `supabase db reset` perfectly happily.
create temporary table local_place (label text primary key, id uuid);

insert into local_place values
  -- A caption that carried a local-script name.
  ('with_local', public.find_or_create_place(
     'Local Cafe', '地元カフェ', 'restaurant', 35.67311, 139.73625, 'Japan', 'JP', 'Japan', 'Tokyo', 500)),
  -- A caption that did not: the common case, and null is the honest answer.
  ('without_local', public.find_or_create_place(
     'Plain Cafe', null, 'restaurant', 35.67311, 139.73625, 'Japan', 'JP', 'Japan', 'Tokyo', 500));

select is(
  (select name_local from public.places where id = (select id from local_place where label = 'with_local')),
  '地元カフェ',
  'a new place STORES the local name (the insert names the column)'
);
select ok(
  (select name_local is null from public.places
    where id = (select id from local_place where label = 'without_local')),
  'a caption with no local-script name leaves name_local NULL, never a guess'
);

-- FILL-IF-NULL. Every row that exists before this migration is null, and reuse is the only
-- route by which the most-referenced places — the ones reused rather than inserted — ever
-- acquire one.
insert into local_place values
  ('fill', public.find_or_create_place(
     'Plain Cafe', 'プレーンカフェ', 'restaurant', 35.67320, 139.73630, 'Japan', 'JP', 'Japan', 'Tokyo', 500));

select is(
  (select id from local_place where label = 'fill'),
  (select id from local_place where label = 'without_local'),
  'the fill call REUSED the row rather than inserting (the gate still decides)'
);
select is(
  (select name_local from public.places where id = (select id from local_place where label = 'fill')),
  'プレーンカフェ',
  'a reuse FILLS a null local name'
);

-- NEVER BLANKED. Copying the country backfill's unconditional write would destroy a good local
-- name on every organize of a reel that captioned the venue in English.
insert into local_place values
  ('blank_attempt', public.find_or_create_place(
     'Local Cafe', null, 'restaurant', 35.67320, 139.73630, 'Japan', 'JP', 'Japan', 'Tokyo', 500));

select is(
  (select id from local_place where label = 'blank_attempt'),
  (select id from local_place where label = 'with_local'),
  'the blanking call reused the row (so the assertion below is about the coalesce, not a miss)'
);
select is(
  (select name_local from public.places where id = (select id from local_place where label = 'with_local')),
  '地元カフェ',
  'a reuse carrying NO local name never blanks the stored one'
);

-- NEVER REPLACED. Both values are verbatim from some caption and neither is more authoritative,
-- so last-writer-wins would let the canonical row's local name flip with reel order — the same
-- nondeterminism `order by (country_code is null), id` exists to eliminate.
insert into local_place values
  ('replace_attempt', public.find_or_create_place(
     'Local Cafe', '地元珈琲店', 'restaurant', 35.67320, 139.73630, 'Japan', 'JP', 'Japan', 'Tokyo', 500));

select is(
  (select id from local_place where label = 'replace_attempt'),
  (select id from local_place where label = 'with_local'),
  'a DIFFERENT local name does not fork a new row — name_local is not in the match predicate'
);
select is(
  (select name_local from public.places where id = (select id from local_place where label = 'with_local')),
  '地元カフェ',
  'a reuse carrying a different local name keeps the one already stored (first non-null is final)'
);

select is(
  (select count(*)::integer from public.places where name in ('Local Cafe', 'Plain Cafe')),
  2,
  'five calls across two venues produced exactly two canonical rows'
);

select * from finish();
rollback;
