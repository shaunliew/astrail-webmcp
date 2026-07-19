begin;

create extension if not exists pgtap with schema extensions;

select plan(201);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000701', 'organize-a@example.com'),
  ('00000000-0000-0000-0000-000000000702', 'organize-b@example.com');

insert into public.reel_cache (
  id,
  normalized_url,
  source_platform,
  caption,
  thumbnail_url,
  transcript,
  raw_payload
)
values
  (
    '70000000-0000-0000-0000-000000000001',
    'https://www.instagram.com/reel/ORGANIZE-A',
    'instagram',
    'A safe caption',
    'https://cdn.example/a.jpg',
    'private transcript A',
    '{"private":"payload A"}'::jsonb
  ),
  (
    '70000000-0000-0000-0000-000000000002',
    'https://www.instagram.com/reel/ORGANIZE-B',
    'instagram',
    'B safe caption',
    'https://cdn.example/b.jpg',
    'private transcript B',
    '{"private":"payload B"}'::jsonb
  );

insert into public.places (
  id,
  name,
  place_type,
  lat,
  lng,
  country,
  city,
  country_code,
  country_name
)
values
  (
    '71000000-0000-0000-0000-000000000001',
    'Canonical A',
    'attraction',
    35.6812,
    139.7671,
    'Japan',
    'Tokyo',
    'JP',
    'Japan'
  ),
  (
    '71000000-0000-0000-0000-000000000002',
    'Canonical B',
    'restaurant',
    1.3521,
    103.8198,
    'Singapore',
    'Singapore',
    'SG',
    'Singapore'
  );

select has_table('public', 'reel_place_mentions', 'reel_place_mentions exists');
select has_table('public', 'organize_jobs', 'organize_jobs exists');
select has_table('public', 'organize_job_items', 'organize_job_items exists');
select has_table('public', 'organize_events', 'organize_events exists');
select has_view('public', 'saved_reel_cards', 'saved_reel_cards exists');
select has_column('public', 'saved_reel_cards', 'places', 'saved_reel_cards exposes aggregated safe places');
select has_column('public', 'saved_reel_cards', 'has_current_cache', 'saved_reel_cards exposes current cache state');
select has_column('public', 'places', 'country_code', 'places.country_code exists');
select has_column('public', 'places', 'country_name', 'places.country_name exists');
select has_column('public', 'user_daily_usage', 'reel_analysis_count', 'reel_analysis_count exists');
select has_column('public', 'reel_place_mentions', 'verification_version', 'mentions carry a verification version');
select has_column('public', 'organize_job_items', 'analysis_usage_date', 'organize item usage date exists');

select col_type_is('public', 'reel_place_mentions', 'reel_cache_id', 'uuid', 'mention cache id is uuid');
select col_type_is('public', 'reel_place_mentions', 'place_id', 'uuid', 'mention place id is uuid');
select col_type_is('public', 'reel_place_mentions', 'evidence_quote', 'text', 'mention evidence is text');
select col_type_is('public', 'reel_place_mentions', 'source_url', 'text', 'mention source url is text');
select col_type_is('public', 'reel_place_mentions', 'confidence', 'numeric', 'mention confidence is numeric');
select col_type_is('public', 'organize_jobs', 'status', 'text', 'organize job status is text');
select col_type_is('public', 'organize_jobs', 'idempotency_key', 'text', 'organize job idempotency key is text');
select col_type_is('public', 'organize_jobs', 'request_json', 'jsonb', 'organize job request is jsonb');
select col_type_is('public', 'organize_jobs', 'lock_expires_at', 'timestamp with time zone', 'organize job lock expiry is timestamptz');
select col_type_is('public', 'organize_job_items', 'status', 'text', 'organize item status is text');
select col_type_is('public', 'organize_job_items', 'analysis_charge_state', 'text', 'organize item charge state is text');
select col_type_is('public', 'organize_events', 'sequence', 'integer', 'organize event sequence is integer');
select col_type_is('public', 'user_daily_usage', 'reel_analysis_count', 'integer', 'reel analysis count is integer');
select col_type_is('public', 'reel_place_mentions', 'verification_version', 'text', 'mention verification version is text');
select col_type_is('public', 'organize_job_items', 'analysis_usage_date', 'date', 'organize item usage date is date');
select col_not_null('public', 'reel_place_mentions', 'verification_version', 'mention verification version is required after cleanup');

select col_not_null('public', 'reel_place_mentions', 'reel_cache_id', 'mention cache id is required');
select col_not_null('public', 'reel_place_mentions', 'place_id', 'mention place id is required');
select col_not_null('public', 'reel_place_mentions', 'evidence_quote', 'mention evidence is required');
select col_not_null('public', 'organize_jobs', 'user_id', 'organize job owner is required');
select col_not_null('public', 'organize_jobs', 'status', 'organize job status is required');
select col_not_null('public', 'organize_jobs', 'idempotency_key', 'organize job idempotency key is required');
select col_not_null('public', 'organize_job_items', 'user_id', 'organize item owner is required');
select col_not_null('public', 'organize_job_items', 'saved_reel_id', 'organize item reel is required');
select col_not_null('public', 'organize_job_items', 'analysis_charge_state', 'organize item charge state is required');
select col_not_null('public', 'organize_events', 'user_id', 'organize event owner is required');
select col_not_null('public', 'organize_events', 'job_id', 'organize event job is required');
select col_not_null('public', 'user_daily_usage', 'reel_analysis_count', 'reel analysis count is required');
-- user_id is supplied so the ONLY null left is verification_version; without it this would
-- still raise 23502 and would silently stop pinning the stamp it exists to pin.
select throws_ok(
  $$insert into public.reel_place_mentions (user_id, reel_cache_id, place_id, evidence_quote, source_url) values ('00000000-0000-0000-0000-000000000701', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'unstamped', 'https://www.instagram.com/reel/ORGANIZE-A')$$,
  '23502', null,
  'unstamped mentions are rejected after successful cleanup'
);
select throws_ok(
  $$insert into public.reel_place_mentions (reel_cache_id, place_id, evidence_quote, verification_version) values ('70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'ownerless', 'mapbox-country-v1')$$,
  '23502', null,
  'ownerless mentions are rejected — every mention has a user'
);

select has_pk('public', 'reel_place_mentions', 'mentions have a composite primary key');
select col_not_null('public', 'reel_place_mentions', 'user_id', 'mention owner is required');
select col_type_is('public', 'reel_place_mentions', 'user_id', 'uuid', 'mention owner is uuid');
select ok(
  (select conkey from pg_constraint where conrelid = 'public.reel_place_mentions'::regclass and contype = 'p')
  = (select array_agg(attnum order by ord) from unnest(array['user_id','reel_cache_id','place_id']) with ordinality t(col, ord)
      join pg_attribute on attrelid = 'public.reel_place_mentions'::regclass and attname = t.col),
  'mentions are keyed (user_id, reel_cache_id, place_id) — the owner is IN the key'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.reel_place_mentions'::regclass
      and conname = 'reel_place_mentions_user_fkey'
      and contype = 'f'
      and confrelid = 'public.users'::regclass
      and confdeltype = 'c'
  ),
  'mention owner cascades from public.users'
);
select has_index('public', 'reel_place_mentions', 'reel_place_mentions_cache_place_idx', 'mentions keep a cache/place index for the card join');
select has_pk('public', 'organize_jobs', 'organize jobs have a primary key');
select has_pk('public', 'organize_job_items', 'organize items have a primary key');
select has_pk('public', 'organize_events', 'organize events have a primary key');
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.organize_jobs'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)'
  ),
  'organize jobs support same-owner composite foreign keys'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.organize_job_items'::regclass
      and conname = 'organize_job_items_user_job_fkey'
      and contype = 'f'
  ),
  'organize items have a same-owner job foreign key'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.organize_job_items'::regclass
      and conname = 'organize_job_items_user_saved_reel_fkey'
      and contype = 'f'
  ),
  'organize items have a same-owner saved reel foreign key'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.organize_events'::regclass
      and conname = 'organize_events_user_job_fkey'
      and contype = 'f'
  ),
  'organize events have a same-owner job foreign key'
);
select has_index('public', 'reel_place_mentions', 'reel_place_mentions_place_id_idx', 'mentions place index exists');
select has_index('public', 'organize_jobs', 'organize_jobs_user_created_at_idx', 'organize jobs owner index exists');
select has_index('public', 'organize_job_items', 'organize_job_items_job_id_idx', 'organize items job index exists');
select has_index('public', 'organize_events', 'organize_events_job_sequence_idx', 'organize events replay index exists');
select has_index('public', 'places', 'places_country_code_name_idx', 'places country index exists');
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.reel_place_mentions'::regclass
      and conname = 'reel_place_mentions_verification_version_nonblank_check'
      and contype = 'c'
  ),
  'mention verification version rejects blank values'
);
select ok(
  exists (
    select 1
    from pg_index
    where indexrelid = to_regclass('public.organize_jobs_active_idempotency_key_unique')
      and indisunique
      and pg_get_expr(indpred, indrelid) like '%initializing%'
      and pg_get_expr(indpred, indrelid) like '%pending%'
      and pg_get_expr(indpred, indrelid) like '%processing%'
  ),
  'organize jobs enforce idempotency only while active'
);
select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.organize_jobs'::regclass
      and conname = 'organize_jobs_status_check'
      and pg_get_constraintdef(oid) like '%initializing%'
  ),
  'organize jobs support a non-claimable initializing state'
);
select ok(
  to_regprocedure('private.cleanup_unverified_saved_reel_locations()') is not null,
  'private legacy location cleanup function exists'
);
select ok(
  to_regprocedure('private.can_select_verified_saved_reel_place(uuid)') is not null,
  'private verified Saved Reel place predicate exists'
);
select is(
  (
    select prorettype::regtype::text
    from pg_proc
    where oid = to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')
  ),
  'boolean',
  'verified Saved Reel place predicate returns boolean'
);
select ok(
  coalesce(
    (
      select prosecdef
      from pg_proc
      where oid = to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')
    ),
    false
  ),
  'verified Saved Reel place predicate is security definer'
);
select ok(
  coalesce(
    (
      select 'search_path=""' = any(proconfig)
      from pg_proc
      where oid = to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')
    ),
    false
  ),
  'verified Saved Reel place predicate has an empty search path'
);
select ok(
  coalesce(
    (
      select prosecdef
      from pg_proc
      where oid = to_regprocedure('private.cleanup_unverified_saved_reel_locations()')
    ),
    false
  ),
  'legacy location cleanup is security definer'
);
select ok(
  coalesce(
    (
      select 'search_path=""' = any(proconfig)
      from pg_proc
      where oid = to_regprocedure('private.cleanup_unverified_saved_reel_locations()')
    ),
    false
  ),
  'legacy location cleanup has an empty search path'
);
select ok(
  position(
    'lock table public.reel_cache in share row exclusive mode'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) > 0
  and position(
    'lock table public.reel_cache in share row exclusive mode'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) < position(
    'update public.reel_cache'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ),
  'legacy location cleanup locks reel cache before invalidation'
);
select ok(
  position(
    'lock table public.reel_place_mentions in share row exclusive mode'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) > 0
  and position(
    'lock table public.reel_place_mentions in share row exclusive mode'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) < position(
    'update public.reel_cache'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ),
  'legacy location cleanup locks reel mentions before invalidation'
);
select ok(
  position(
    'update public.reel_cache'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) > 0
  and position(
    'delete from public.reel_place_mentions'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) > 0
  and position(
    'public.places'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) = 0
  and position(
    'public.location_graph'
    in lower(pg_get_functiondef(to_regprocedure('private.cleanup_unverified_saved_reel_locations()')))
  ) = 0,
  'legacy location cleanup touches only cache payloads and unverified mentions'
);

select ok((select relrowsecurity from pg_class where oid = 'public.reel_place_mentions'::regclass), 'mentions have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organize_jobs'::regclass), 'organize jobs have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organize_job_items'::regclass), 'organize items have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.organize_events'::regclass), 'organize events have RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.reel_cache'::regclass), 'reel cache retains RLS');
select ok(
  not coalesce((select reloptions @> array['security_invoker=true'] from pg_class where oid = 'public.saved_reel_cards'::regclass), false),
  'saved_reel_cards does not invoke service-role-only base tables as the browser'
);
select ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'saved_reel_cards'
      and column_name in ('raw_payload', 'transcript')
  ),
  'saved_reel_cards has no raw payload or transcript columns'
);
select ok(
  position('raw_payload' in lower(pg_get_viewdef('public.saved_reel_cards'::regclass, true))) = 0
  and position('transcript' in lower(pg_get_viewdef('public.saved_reel_cards'::regclass, true))) = 0
  and position('has_current_cache' in lower(pg_get_viewdef('public.saved_reel_cards'::regclass, true))) > 0
  and position('auth.uid()' in lower(pg_get_viewdef('public.saved_reel_cards'::regclass, true))) > 0,
  'saved_reel_cards explicitly filters by auth.uid without unsafe cache fields'
);
select table_privs_are('public', 'organize_jobs', 'authenticated', array['SELECT'], 'authenticated can read organize jobs only');
select table_privs_are('public', 'organize_job_items', 'authenticated', array['SELECT'], 'authenticated can read organize items only');
select table_privs_are('public', 'organize_events', 'authenticated', array['SELECT'], 'authenticated can replay organize events only');
select ok(not has_function_privilege('authenticated', 'public.reserve_daily_reel_analysis(uuid,date)', 'EXECUTE'), 'authenticated cannot reserve analysis');
select ok(not has_function_privilege('anon', 'public.reserve_daily_reel_analysis(uuid,date)', 'EXECUTE'), 'anon cannot reserve analysis');
select ok(has_function_privilege('service_role', 'public.reserve_daily_reel_analysis(uuid,date)', 'EXECUTE'), 'service role can reserve analysis');
select ok(not has_function_privilege('authenticated', 'public.refund_daily_reel_analysis(uuid,date)', 'EXECUTE'), 'authenticated cannot refund analysis');
select ok(has_function_privilege('service_role', 'public.refund_daily_reel_analysis(uuid,date)', 'EXECUTE'), 'service role can refund analysis');
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute the verified Saved Reel place predicate'
);
select ok(
  not coalesce(
    has_function_privilege(
      'anon',
      to_regprocedure('private.can_select_verified_saved_reel_place(uuid)'),
      'EXECUTE'
    ),
    false
  ),
  'anon cannot execute the verified Saved Reel place predicate'
);
select ok(
  coalesce(
    has_function_privilege(
      'authenticated',
      to_regprocedure('private.can_select_verified_saved_reel_place(uuid)'),
      'EXECUTE'
    ),
    false
  ),
  'authenticated can execute the verified Saved Reel place predicate'
);
select ok(
  not has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated cannot use the private schema directly'
);
-- The prior assertions only check metadata (has_schema_privilege/has_function_privilege),
-- which run fine as the superuser connection. Actually calling the qualified name must
-- run AS authenticated, or the superuser bypasses the revoke and no error is raised.
set local role authenticated;
select throws_ok(
  $$select private.can_select_verified_saved_reel_place('71000000-0000-0000-0000-000000000001'::uuid)$$,
  '42501',
  'permission denied for schema private',
  'authenticated cannot directly qualify the verified Saved Reel place predicate'
);
reset role;
select ok(
  coalesce(
    has_function_privilege(
      'service_role',
      to_regprocedure('private.can_select_verified_saved_reel_place(uuid)'),
      'EXECUTE'
    ),
    false
  ),
  'service role can execute the verified Saved Reel place predicate'
);
select ok(
  not exists (
    select 1
    from pg_proc
    cross join lateral aclexplode(coalesce(proacl, acldefault('f', proowner))) as privilege
    where oid = to_regprocedure('private.cleanup_unverified_saved_reel_locations()')
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute the legacy location cleanup'
);
select ok(
  not coalesce(
    has_function_privilege(
      'anon',
      to_regprocedure('private.cleanup_unverified_saved_reel_locations()'),
      'EXECUTE'
    ),
    false
  ),
  'anon cannot execute the legacy location cleanup'
);
select ok(
  not coalesce(
    has_function_privilege(
      'authenticated',
      to_regprocedure('private.cleanup_unverified_saved_reel_locations()'),
      'EXECUTE'
    ),
    false
  ),
  'authenticated cannot run the legacy location cleanup'
);
select ok(
  coalesce(
    has_function_privilege(
      'service_role',
      to_regprocedure('private.cleanup_unverified_saved_reel_locations()'),
      'EXECUTE'
    ),
    false
  ),
  'service role can rerun the legacy location cleanup'
);

set local role service_role;

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000701', 'https://www.instagram.com/reel/ORGANIZE-A')$$,
  'service role captures user A saved reel'
);
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000702', 'https://www.instagram.com/reel/ORGANIZE-B')$$,
  'service role captures user B saved reel'
);

insert into public.reel_place_mentions (
  user_id,
  reel_cache_id,
  place_id,
  evidence_quote,
  source_url,
  confidence,
  verification_version
)
values (
  '00000000-0000-0000-0000-000000000701',
  '70000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000001',
  'A proof quote',
  'https://www.instagram.com/reel/ORGANIZE-A',
  0.95,
  'mapbox-country-v1'
);
reset role;
alter table public.reel_place_mentions
  alter column verification_version drop not null;
set local role service_role;
insert into public.reel_place_mentions (
  user_id,
  reel_cache_id,
  place_id,
  evidence_quote,
  source_url,
  confidence
)
values (
  '00000000-0000-0000-0000-000000000701',
  '70000000-0000-0000-0000-000000000001',
  '71000000-0000-0000-0000-000000000002',
  'Legacy Search Box proof',
  'https://www.instagram.com/reel/ORGANIZE-A',
  0.5
);
update public.reel_cache
set extracted_places = '[{"name":"Legacy Search Box result"}]'::jsonb,
    extractor_version = 'searchbox-v0'
where id = '70000000-0000-0000-0000-000000000001';
insert into public.location_graph_nodes (id, node_type, ref_table, ref_id)
values
  ('74000000-0000-0000-0000-000000000001', 'reel', 'reel_cache', '70000000-0000-0000-0000-000000000001'),
  ('74000000-0000-0000-0000-000000000002', 'place', 'places', '71000000-0000-0000-0000-000000000002');
insert into public.location_graph_edges (id, from_node_id, to_node_id, edge_type)
values (
  '74100000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000001',
  '74000000-0000-0000-0000-000000000002',
  'mentions_place'
);
select throws_ok(
  $$insert into public.reel_place_mentions (user_id, reel_cache_id, place_id, evidence_quote, source_url) values ('00000000-0000-0000-0000-000000000701', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'duplicate', 'https://www.instagram.com/reel/ORGANIZE-A')$$,
  '23505', null,
  'duplicate owner/cache/place mention is rejected'
);
-- ...but the SAME cache/place for a DIFFERENT owner is not a duplicate. This is the whole
-- point of the re-key: two users who saved the same Reel each hold their own evidence row.
select lives_ok(
  $$insert into public.reel_place_mentions (user_id, reel_cache_id, place_id, evidence_quote, source_url, verification_version) values ('00000000-0000-0000-0000-000000000702', '70000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000001', 'B proof quote', 'https://www.instagram.com/reel/ORGANIZE-A', 'mapbox-country-v1')$$,
  'a second owner may hold their own mention for the same cache and place'
);
delete from public.reel_place_mentions
where user_id = '00000000-0000-0000-0000-000000000702';

insert into public.organize_jobs (
  id,
  user_id,
  idempotency_key,
  status,
  status_message,
  request_json,
  locked_at,
  lock_expires_at,
  attempt_count,
  total_count
)
values
  (
    '72000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000701',
    'organize-a-1',
    'processing',
    'Finding places',
    '{"saved_reel_ids":["saved-a"]}'::jsonb,
    now(),
    now() + interval '5 minutes',
    1,
    1
  ),
  (
    '72000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702',
    'organize-b-1',
    'pending',
    'Queued',
    '{"saved_reel_ids":["saved-b"]}'::jsonb,
    null,
    null,
    0,
    1
  );
select lives_ok(
  $$insert into public.organize_jobs (user_id, idempotency_key, status) values
      ('00000000-0000-0000-0000-000000000701', 'terminal-retry', 'succeeded'),
      ('00000000-0000-0000-0000-000000000701', 'terminal-retry', 'failed')$$,
  'terminal organize jobs may reuse an idempotency key'
);
insert into public.organize_jobs (user_id, idempotency_key, status)
values ('00000000-0000-0000-0000-000000000701', 'active-once', 'pending');
select throws_ok(
  $$insert into public.organize_jobs (user_id, idempotency_key, status) values ('00000000-0000-0000-0000-000000000701', 'active-once', 'processing')$$,
  '23505', null,
  'active organize jobs cannot reuse an idempotency key'
);
insert into public.organize_jobs (user_id, idempotency_key, status)
values ('00000000-0000-0000-0000-000000000701', 'initializing-once', 'initializing');
select throws_ok(
  $$insert into public.organize_jobs (user_id, idempotency_key, status) values ('00000000-0000-0000-0000-000000000701', 'initializing-once', 'pending')$$,
  '23505', null,
  'initializing organize jobs reserve the active idempotency key'
);
delete from public.organize_jobs
where user_id = '00000000-0000-0000-0000-000000000701'
  and idempotency_key in ('terminal-retry', 'active-once', 'initializing-once');

insert into public.organize_job_items (
  id,
  user_id,
  job_id,
  saved_reel_id,
  status,
  place_count
)
values (
  '73000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000701',
  '72000000-0000-0000-0000-000000000001',
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701'),
  'organized',
  1
);

insert into public.organize_events (
  user_id,
  job_id,
  sequence,
  event_type,
  message,
  payload
)
values (
  '00000000-0000-0000-0000-000000000701',
  '72000000-0000-0000-0000-000000000001',
  1,
  'stage',
  'Finding places',
  '{"processed_count":0}'::jsonb
);
select throws_ok(
  $$insert into public.organize_events (user_id, job_id, sequence, event_type, message) values ('00000000-0000-0000-0000-000000000702', '72000000-0000-0000-0000-000000000001', 2, 'stage', 'cross owner')$$,
  '23503', null,
  'organize events reject cross-owner job links'
);

update public.organize_job_items
set analysis_charge_state = 'reserved',
    analysis_usage_date = current_date,
    analysis_reserved_at = now(),
    analysis_refunded_at = null,
    analysis_consumed_at = null
where id = '73000000-0000-0000-0000-000000000001';
select is(
  (select analysis_charge_state from public.organize_job_items where id = '73000000-0000-0000-0000-000000000001'),
  'reserved',
  'organize item records one reserved analysis charge'
);
update public.organize_job_items
set analysis_charge_state = 'refunded', analysis_refunded_at = now()
where id = '73000000-0000-0000-0000-000000000001';
select is(
  (select analysis_charge_state from public.organize_job_items where id = '73000000-0000-0000-0000-000000000001'),
  'refunded',
  'organize item records one refunded analysis charge'
);
select throws_ok(
  $$update public.organize_job_items set analysis_charge_state = 'refunded', analysis_reserved_at = null, analysis_refunded_at = null where id = '73000000-0000-0000-0000-000000000001'$$,
  '23514', null,
  'organize item charge state cannot lose its reservation/refund timestamps'
);
select throws_ok(
  $$insert into public.organize_job_items (user_id, job_id, saved_reel_id) values ('00000000-0000-0000-0000-000000000702', '72000000-0000-0000-0000-000000000002', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701'))$$,
  '23503', null,
  'organize items reject cross-owner job/reel links'
);

select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 1, 'analysis reservation one');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 2, 'analysis reservation two');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 3, 'analysis reservation three');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 4, 'analysis reservation four');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 5, 'analysis reservation five');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), null, 'sixth analysis reservation is capped');
select is(public.refund_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 4, 'analysis refund returns four');
select is(public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date), 5, 'refunded analysis can be reserved again');

select throws_ok(
  $$insert into public.user_daily_usage (user_id, usage_date, reel_analysis_count) values ('00000000-0000-0000-0000-000000000701', current_date - 1, -1)$$,
  '23514', null,
  'negative reel analysis usage is rejected'
);

select ok(
  not has_function_privilege('authenticated', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'authenticated cannot reserve an organize item analysis'
);
select ok(
  not has_function_privilege('authenticated', 'public.refund_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'authenticated cannot refund an organize item analysis'
);
select ok(
  has_function_privilege('service_role', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'service role can reserve an organize item analysis'
);
select ok(
  has_function_privilege('service_role', 'public.refund_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'service role can refund an organize item analysis'
);

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000702', 'https://www.instagram.com/reel/ORGANIZE-B-2')$$,
  'service role captures a second user B saved reel for quota tests'
);
insert into public.organize_job_items (
  id, user_id, job_id, saved_reel_id, status, analysis_charge_state
)
values
(
  '73000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000702',
  '72000000-0000-0000-0000-000000000002',
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000702' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-B'),
  'queued',
  'not_charged'
),
(
  '73000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000702',
  '72000000-0000-0000-0000-000000000002',
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000702' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-B-2'),
  'queued',
  'not_charged'
);

select is(
  public.reserve_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  current_date,
  'organize item reservation stamps the database current date'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date),
  1,
  'organize item reservation increments quota once'
);
select results_eq(
  $$select analysis_charge_state, analysis_usage_date from public.organize_job_items where id = '73000000-0000-0000-0000-000000000002'$$,
  $$values ('reserved'::text, current_date)$$,
  'organize item reservation stamps state and usage date atomically'
);
select is(
  public.reserve_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  current_date,
  'retrying a reserved organize item returns the existing reservation'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date),
  1,
  'retrying a reserved organize item does not double charge'
);
select ok(
  public.refund_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  'reserved organize item refunds successfully'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date),
  0,
  'organize item refund decrements the current reservation'
);
select results_eq(
  $$select analysis_charge_state, analysis_usage_date from public.organize_job_items where id = '73000000-0000-0000-0000-000000000002'$$,
  $$values ('refunded'::text, current_date)$$,
  'refund preserves the reservation usage date'
);
select ok(
  public.refund_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  'retrying a refunded organize item is idempotent'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date),
  0,
  'retrying a refund does not decrement quota twice'
);
insert into public.user_daily_usage (user_id, usage_date, reel_analysis_count)
values ('00000000-0000-0000-0000-000000000702', current_date - 1, 1);
update public.organize_job_items
set analysis_charge_state = 'reserved',
    analysis_usage_date = current_date - 1,
    analysis_reserved_at = now() - interval '1 day',
    analysis_refunded_at = null,
    analysis_consumed_at = null
where id = '73000000-0000-0000-0000-000000000002';
select ok(
  public.refund_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  'refund succeeds for an older persisted usage date'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date - 1),
  0,
  'refund decrements the persisted reservation date'
);
select is(
  coalesce((select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date), 0),
  0,
  'older-date refund leaves current-date quota unchanged'
);
select results_eq(
  $$select analysis_charge_state, analysis_usage_date, analysis_refunded_at is null from public.organize_job_items where id = '73000000-0000-0000-0000-000000000002'$$,
  $$values ('refunded'::text, (current_date - 1), false)$$,
  'older-date refund keeps the item terminal refund state'
);
select is(
  public.reserve_organize_item_analysis(
    '73000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000702'
  ),
  current_date,
  'a refunded item gets a fresh current-date reservation'
);
select is(
  (select reel_analysis_count from public.user_daily_usage
   where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date),
  1,
  'fresh reservation increments only the new usage date'
);
select results_eq(
  $$select analysis_charge_state, analysis_usage_date, analysis_refunded_at is null from public.organize_job_items where id = '73000000-0000-0000-0000-000000000002'$$,
  $$values ('reserved'::text, current_date, true)$$,
  'fresh reservation clears the prior refund marker'
);
update public.user_daily_usage
set reel_analysis_count = 5
where user_id = '00000000-0000-0000-0000-000000000702' and usage_date = current_date;
select is(
  public.reserve_organize_item_analysis(
    '73000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000702'
  ),
  null,
  'quota rejection returns null'
);
select results_eq(
  $$select analysis_charge_state, analysis_usage_date, analysis_reserved_at, analysis_refunded_at, analysis_consumed_at from public.organize_job_items where id = '73000000-0000-0000-0000-000000000003'$$,
  $$values ('not_charged'::text, null::date, null::timestamptz, null::timestamptz, null::timestamptz)$$,
  'quota rejection leaves the item unchanged'
);

-- The P2-2/P2-4 fixture job above left ORGANIZE-A inside an active ('processing')
-- job. Retire it before the P2-6 active-item-guard tests reuse that same reel,
-- or the atomic RPC correctly (and here, unintentionally) rejects the overlap.
update public.organize_jobs
set status = 'succeeded'
where id = '72000000-0000-0000-0000-000000000001';

select ok(
  not has_function_privilege('authenticated', 'public.create_saved_reels_organize_job(uuid,uuid[],text)', 'EXECUTE'),
  'authenticated cannot create Saved Reel organize jobs through the RPC'
);
select ok(
  has_function_privilege('service_role', 'public.create_saved_reels_organize_job(uuid,uuid[],text)', 'EXECUTE'),
  'service role can create Saved Reel organize jobs through the RPC'
);
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000701', 'https://www.instagram.com/reel/ORGANIZE-A-2')$$,
  'service role captures a second user A saved reel for overlap tests'
);
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000701', 'https://www.instagram.com/reel/ORGANIZE-A-3')$$,
  'service role captures a third user A saved reel for disjoint tests'
);
select ok(
  public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000701',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A')]::uuid[],
    'p2-6-atomic'
  ) is not null,
  'atomic RPC creates a pending organize job'
);
select is(
  (select count(*)::integer from public.organize_job_items items
   join public.organize_jobs jobs on jobs.id = items.job_id
   where jobs.user_id = '00000000-0000-0000-0000-000000000701' and jobs.idempotency_key = 'p2-6-atomic'),
  1,
  'atomic RPC inserts all selected items with the job'
);
select results_eq(
  $$select event_type, sequence from public.organize_events events join public.organize_jobs jobs on jobs.id = events.job_id where jobs.idempotency_key = 'p2-6-atomic'$$,
  $$values ('stage'::text, 1)$$,
  'atomic RPC inserts the sequence-one queued event'
);
select is(
  public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000701',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A')]::uuid[],
    'p2-6-atomic'
  ),
  (select id from public.organize_jobs where user_id = '00000000-0000-0000-0000-000000000701' and idempotency_key = 'p2-6-atomic'),
  'identical active idempotency replay returns the same job'
);
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000701',
    array[
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A'),
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A-2')
    ]::uuid[],
    'p2-6-overlap'
  )$$,
  'P0001',
  'Saved Reel is already being organized',
  'overlapping active organize items are rejected as one request'
);
select is(
  (select count(*)::integer from public.organize_jobs where user_id = '00000000-0000-0000-0000-000000000701' and idempotency_key = 'p2-6-overlap'),
  0,
  'active overlap rejection creates no partial job'
);
update public.organize_jobs
set status = 'succeeded'
where user_id = '00000000-0000-0000-0000-000000000701' and idempotency_key = 'p2-6-atomic';
select ok(
  public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000701',
    array[
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A'),
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A-2')
    ]::uuid[],
    'p2-6-terminal'
  ) is not null,
  'terminal Saved Reel items can be selected in a new active job'
);
select ok(
  public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000701',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A-3')]::uuid[],
    'p2-6-disjoint'
  ) is not null,
  'disjoint Saved Reel sets can run concurrently'
);
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000702',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701' and normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A')]::uuid[],
    'p2-6-cross-owner'
  )$$,
  'P0001',
  'Saved Reel not found',
  'cross-owner Saved Reel selection preserves not-found semantics'
);

-- Retire every P2-6-only fixture artifact (no later assertion references them —
-- verified above). The RLS/safe-projection tests below were written against the
-- single pre-existing job/item/event/saved-reel fixture and still expect exactly
-- that shape.
delete from public.organize_jobs
where user_id = '00000000-0000-0000-0000-000000000701'
  and idempotency_key in ('p2-6-atomic', 'p2-6-terminal', 'p2-6-disjoint');
delete from public.saved_reels
where user_id = '00000000-0000-0000-0000-000000000701'
  and normalized_url in (
    'https://www.instagram.com/reel/ORGANIZE-A-2',
    'https://www.instagram.com/reel/ORGANIZE-A-3'
  );

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000701","role":"authenticated"}', true);

select is(
  (select count(*)::integer from public.saved_reel_cards),
  1,
  'user A sees only their saved reel card'
);
select results_eq(
  $$select id, caption, thumbnail_url, places from public.saved_reel_cards$$,
  $$select (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000701'), 'A safe caption'::text, 'https://cdn.example/a.jpg'::text, '[{"country_code":"JP","country_name":"Japan","confidence":0.95,"evidence_quote":"A proof quote","lat":35.6812,"lng":139.7671,"name":"Canonical A","place_id":"71000000-0000-0000-0000-000000000001","source_reel_url":"https://www.instagram.com/reel/ORGANIZE-A","source_url":"https://www.instagram.com/reel/ORGANIZE-A"}]'::jsonb$$,
  'saved_reel_cards exposes safe cache metadata and place proof'
);
select is(
  (select count(*)::integer from public.saved_reel_cards, jsonb_array_elements(places) as place where place->>'name' = 'Canonical B'),
  0,
  'saved_reel_cards hides unstamped legacy mentions'
);
select results_eq(
  $$select place->>'country_code', place->>'country_name', (place->>'lat')::double precision, (place->>'lng')::double precision from public.saved_reel_cards, jsonb_array_elements(places) as place$$,
  $$values ('JP'::text, 'Japan'::text, 35.6812::double precision, 139.7671::double precision)$$,
  'saved_reel_cards exposes verified country and coordinates'
);
select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and tablename = 'places'
      and policyname = 'places_select_when_used_in_own_saved_reel'
      and qual like '%can_select_verified_saved_reel_place%'
      and qual not like '%reel_place_mentions%'
  ),
  1,
  'authenticated places policy delegates service-only reads to the private predicate'
);
-- Introspecting a private-schema function's source also requires schema USAGE,
-- which authenticated correctly no longer has after the P2-1 lockdown. This
-- assertion checks the predicate's source text, not an authenticated-caller
-- permission boundary (already covered above), so it runs with schema visibility
-- and then restores the authenticated session for the RLS tests that follow.
reset role;
select ok(
  position(
    'verification_version = ''mapbox-country-v1'''
    in lower(pg_get_functiondef(to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')))
  ) > 0
  and position(
    'sr.user_id = (select auth.uid())'
    in lower(pg_get_functiondef(to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')))
  ) > 0
  -- A3: the mention must belong to the requesting user, not merely to a Reel they saved.
  and position(
    'sr.user_id = m.user_id'
    in lower(pg_get_functiondef(to_regprocedure('private.can_select_verified_saved_reel_place(uuid)')))
  ) > 0,
  'verified Saved Reel place predicate remains trust-gated and owner-scoped'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000701', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000701","role":"authenticated"}', true);
select lives_ok(
  $$select count(*) from public.places where id in ('71000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002')$$,
  'authenticated place selection evaluates without direct mention-table privilege'
);
select results_eq(
  $$select id from public.places where id in ('71000000-0000-0000-0000-000000000001', '71000000-0000-0000-0000-000000000002') order by id$$,
  $$values ('71000000-0000-0000-0000-000000000001'::uuid)$$,
  'authenticated place selection exposes only the owner verified Saved Reel place'
);
select is((select count(*)::integer from public.organize_jobs), 1, 'user A sees only own organize jobs');
select is((select count(*)::integer from public.organize_job_items), 1, 'user A sees only own organize items');
select is((select count(*)::integer from public.organize_events), 1, 'user A can replay only own organize events');
select throws_ok(
  $$select count(*) from public.reel_place_mentions$$,
  '42501', null,
  'user A cannot read the service-role-only mention table'
);
select throws_ok(
  $$select count(*) from public.reel_cache$$,
  '42501', null,
  'user A cannot read the service-role-only cache table'
);
select throws_ok(
  $$select raw_payload from public.reel_cache$$,
  '42501', null,
  'user A cannot read raw cache payload'
);
select throws_ok(
  $$insert into public.organize_jobs (user_id) values ('00000000-0000-0000-0000-000000000701')$$,
  '42501', null,
  'authenticated clients cannot create organize jobs'
);
select throws_ok(
  $$update public.organize_job_items set status = 'failed' where user_id = '00000000-0000-0000-0000-000000000701'$$,
  '42501', null,
  'authenticated clients cannot mutate organize items'
);
select throws_ok(
  $$select public.reserve_daily_reel_analysis('00000000-0000-0000-0000-000000000701', current_date)$$,
  '42501', null,
  'authenticated clients cannot reserve analysis quota'
);

reset role;
set local role service_role;

select lives_ok(
  $$select private.cleanup_unverified_saved_reel_locations()$$,
  'legacy Saved Reels locations clean up safely'
);
reset role;
alter table public.reel_place_mentions
  alter column verification_version set not null;
set local role service_role;
select results_eq(
  $$select extracted_places, extractor_version from public.reel_cache where id = '70000000-0000-0000-0000-000000000001'$$,
  $$values ('[]'::jsonb, 'invalidated-searchbox-2026-07-18'::text)$$,
  'cleanup invalidates the linked legacy cache payload'
);
select is(
  (select count(*)::integer from public.reel_place_mentions where verification_version is null),
  0,
  'cleanup removes unstamped mentions'
);
select is(
  (
    select count(*)::integer
    from public.reel_place_mentions
    where reel_cache_id = '70000000-0000-0000-0000-000000000001'
      and verification_version = 'mapbox-country-v1'
  ),
  1,
  'cleanup preserves verified mentions'
);
select is(
  (select count(*)::integer from public.places where id = '71000000-0000-0000-0000-000000000002'),
  1,
  'cleanup preserves the pre-existing shared canonical place'
);
select is(
  (select count(*)::integer from public.location_graph_nodes where id = '74000000-0000-0000-0000-000000000002'),
  1,
  'cleanup preserves the canonical place graph node'
);
select is(
  (select count(*)::integer from public.location_graph_edges where id = '74100000-0000-0000-0000-000000000001'),
  1,
  'cleanup preserves graph edges attached to the canonical place'
);
select is(
  (select count(*)::integer from public.places where id = '71000000-0000-0000-0000-000000000001'),
  1,
  'cleanup preserves verified canonical places'
);
select lives_ok(
  $$select private.cleanup_unverified_saved_reel_locations()$$,
  'legacy location cleanup is idempotent'
);
select results_eq(
  $$select extracted_places, extractor_version from public.reel_cache where id = '70000000-0000-0000-0000-000000000001'$$,
  $$values ('[]'::jsonb, 'invalidated-searchbox-2026-07-18'::text)$$,
  'idempotent cleanup leaves the invalidated cache stable'
);

-- ── saved_reel_cards is owner-scoped too ──────────────────────────────────────────────────
-- User B saves the very Reel user A organized. Pre-A3 the card joined mentions on
-- reel_cache_id alone, so B SAW A's pins — pins authorize_place_ids then rejected, failing
-- generation terminally. B must now see an empty place list until they organize it.
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000702', 'https://www.instagram.com/reel/ORGANIZE-A')$$,
  'service role captures user B saving the Reel user A organized'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000702', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000702","role":"authenticated"}', true);
select results_eq(
  $$select places from public.saved_reel_cards where normalized_url = 'https://www.instagram.com/reel/ORGANIZE-A'$$,
  $$values ('[]'::jsonb)$$,
  'saved_reel_cards hides another owner''s mentions for a Reel this user merely saved'
);
reset role;
set local role service_role;

-- ── replace_reel_place_mentions: the owner-scoped, transactional set replacement ──────────
select has_function('public', 'replace_reel_place_mentions', array['uuid','uuid','text','jsonb'], 'the mention rewrite RPC exists');
select ok(
  (select prosecdef from pg_proc where oid = 'public.replace_reel_place_mentions(uuid,uuid,text,jsonb)'::regprocedure),
  'the mention rewrite RPC is security definer'
);
select ok(
  (select proconfig from pg_proc where oid = 'public.replace_reel_place_mentions(uuid,uuid,text,jsonb)'::regprocedure)
    @> array['search_path=""'],
  'the mention rewrite RPC pins an empty search_path'
);
select ok(
  has_function_privilege('service_role', 'public.replace_reel_place_mentions(uuid,uuid,text,jsonb)', 'execute'),
  'service_role may execute the mention rewrite RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.replace_reel_place_mentions(uuid,uuid,text,jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.replace_reel_place_mentions(uuid,uuid,text,jsonb)', 'execute'),
  'browser roles may not execute the mention rewrite RPC'
);

-- THE Major, against a real database: a rewrite for user B must not touch user A's set.
-- User A currently holds exactly one verified mention for cache-A.
select is(
  (select count(*)::integer from public.reel_place_mentions where user_id = '00000000-0000-0000-0000-000000000701'),
  1,
  'user A holds one verified mention before the cross-user rewrite'
);
select is(
  public.replace_reel_place_mentions(
    '00000000-0000-0000-0000-000000000702',
    '70000000-0000-0000-0000-000000000001',
    'mapbox-country-v1',
    '[{"place_id":"71000000-0000-0000-0000-000000000002","evidence_quote":"B proof","confidence":0.8}]'::jsonb
  ),
  1,
  'a rewrite for user B reports its own single mention'
);
select is(
  (select count(*)::integer from public.reel_place_mentions where user_id = '00000000-0000-0000-0000-000000000701'),
  1,
  'user B rewriting the same Reel leaves user A''s mentions untouched'
);
select results_eq(
  $$select place_id from public.reel_place_mentions where user_id = '00000000-0000-0000-0000-000000000701'$$,
  $$values ('71000000-0000-0000-0000-000000000001'::uuid)$$,
  'user A''s surviving mention is byte-identical, not merely equal in count'
);

-- A payload naming the same place twice must SUCCEED and write exactly one row. Without the
-- RPC's `distinct on (place_id)` Postgres rejects the whole statement with 25P02/21000
-- ("ON CONFLICT DO UPDATE command cannot affect row a second time") and every organize of a
-- Reel that names one venue twice breaks. The Python fake cannot reproduce this; only here.
select is(
  public.replace_reel_place_mentions(
    '00000000-0000-0000-0000-000000000702',
    '70000000-0000-0000-0000-000000000001',
    'mapbox-country-v1',
    '[{"place_id":"71000000-0000-0000-0000-000000000001","evidence_quote":"first","confidence":0.9},
      {"place_id":"71000000-0000-0000-0000-000000000001","evidence_quote":"second","confidence":0.1}]'::jsonb
  ),
  1,
  'a payload naming one place twice collapses to a single mention instead of erroring'
);
select results_eq(
  $$select place_id, evidence_quote from public.reel_place_mentions where user_id = '00000000-0000-0000-0000-000000000702'$$,
  $$values ('71000000-0000-0000-0000-000000000001'::uuid, 'first'::text)$$,
  'the first occurrence wins deterministically and B''s superseded place is pruned'
);
select throws_ok(
  $$select public.replace_reel_place_mentions('00000000-0000-0000-0000-000000000702', '70000000-0000-0000-0000-000000000001', 'mapbox-country-v1', '{"place_id":"x"}'::jsonb)$$,
  'AS422', null,
  'a non-array mentions payload is rejected at the boundary'
);
delete from public.reel_place_mentions
where user_id = '00000000-0000-0000-0000-000000000702';

delete from public.saved_reels
where user_id = '00000000-0000-0000-0000-000000000701';
select is(
  (select count(*)::integer from public.organize_job_items where id = '73000000-0000-0000-0000-000000000001'),
  0,
  'deleting a saved reel removes its organize item'
);
select is(
  (select count(*)::integer from public.reel_place_mentions where reel_cache_id = '70000000-0000-0000-0000-000000000001'),
  1,
  'deleting a saved reel preserves shared mention data'
);
delete from public.reel_cache where id = '70000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::integer from public.reel_place_mentions where reel_cache_id = '70000000-0000-0000-0000-000000000001'),
  0,
  'deleting its cache removes the shared mention'
);

reset role;
select * from finish();

rollback;
