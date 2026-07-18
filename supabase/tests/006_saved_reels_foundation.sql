begin;

create extension if not exists pgtap with schema extensions;

select plan(144);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000601', 'saved-reels-a@example.com'),
  ('00000000-0000-0000-0000-000000000602', 'saved-reels-b@example.com');

insert into public.reel_cache (id, normalized_url, source_platform, caption)
values (
  '60000000-0000-0000-0000-000000000001',
  'https://www.instagram.com/reel/SHARED',
  'instagram',
  'shared public reel'
);

select has_table('public', 'saved_reels', 'saved_reels table exists');
select has_table('public', 'reel_collections', 'reel_collections table exists');
select has_table('public', 'reel_collection_items', 'reel_collection_items table exists');
select ok(to_regprocedure('public.capture_saved_reel(uuid,text,text)') is not null, 'capture_saved_reel function exists');
select ok((select proretset from pg_proc where oid = 'public.capture_saved_reel(uuid,text,text)'::regprocedure), 'capture_saved_reel returns a set');
select is((select pronargdefaults from pg_proc where oid = 'public.capture_saved_reel(uuid,text,text)'::regprocedure), 1::smallint, 'capture_saved_reel has exactly one default argument');

select has_column('public', 'saved_reels', 'id', 'saved_reels.id exists');
select has_column('public', 'saved_reels', 'user_id', 'saved_reels.user_id exists');
select has_column('public', 'saved_reels', 'normalized_url', 'saved_reels.normalized_url exists');
select has_column('public', 'saved_reels', 'source_platform', 'saved_reels.source_platform exists');
select has_column('public', 'saved_reels', 'reel_cache_id', 'saved_reels.reel_cache_id exists');
select has_column('public', 'saved_reels', 'analysis_status', 'saved_reels.analysis_status exists');
select has_column('public', 'saved_reels', 'personal_label', 'saved_reels.personal_label exists');
select has_column('public', 'saved_reels', 'retry_after', 'saved_reels.retry_after exists');
select has_column('public', 'saved_reels', 'analyzed_at', 'saved_reels.analyzed_at exists');
select has_column('public', 'saved_reels', 'created_at', 'saved_reels.created_at exists');
select has_column('public', 'saved_reels', 'updated_at', 'saved_reels.updated_at exists');
select col_type_is('public', 'saved_reels', 'id', 'uuid', 'saved_reels.id is uuid');
select col_type_is('public', 'saved_reels', 'user_id', 'uuid', 'saved_reels.user_id is uuid');
select col_type_is('public', 'saved_reels', 'normalized_url', 'text', 'saved_reels.normalized_url is text');
select col_type_is('public', 'saved_reels', 'source_platform', 'text', 'saved_reels.source_platform is text');
select col_type_is('public', 'saved_reels', 'reel_cache_id', 'uuid', 'saved_reels.reel_cache_id is uuid');
select col_type_is('public', 'saved_reels', 'analysis_status', 'text', 'saved_reels.analysis_status is text');
select col_type_is('public', 'saved_reels', 'personal_label', 'text', 'saved_reels.personal_label is text');
select col_type_is('public', 'saved_reels', 'retry_after', 'timestamp with time zone', 'saved_reels.retry_after is timestamptz');
select col_type_is('public', 'saved_reels', 'analyzed_at', 'timestamp with time zone', 'saved_reels.analyzed_at is timestamptz');
select col_type_is('public', 'saved_reels', 'created_at', 'timestamp with time zone', 'saved_reels.created_at is timestamptz');
select col_type_is('public', 'saved_reels', 'updated_at', 'timestamp with time zone', 'saved_reels.updated_at is timestamptz');
select col_not_null('public', 'saved_reels', 'id', 'saved_reels.id is required');
select col_not_null('public', 'saved_reels', 'user_id', 'saved_reels.user_id is required');
select col_not_null('public', 'saved_reels', 'normalized_url', 'saved_reels.normalized_url is required');
select col_not_null('public', 'saved_reels', 'source_platform', 'saved_reels.source_platform is required');
select col_not_null('public', 'saved_reels', 'analysis_status', 'saved_reels.analysis_status is required');
select col_not_null('public', 'saved_reels', 'created_at', 'saved_reels.created_at is required');
select col_not_null('public', 'saved_reels', 'updated_at', 'saved_reels.updated_at is required');
select has_pk('public', 'saved_reels', 'saved_reels has a primary key');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.saved_reels'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (user_id, normalized_url)'), 'saved_reels is unique per user and normalized URL');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.saved_reels'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)'), 'saved_reels supports same-owner foreign keys');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_normalized_url_nonblank_check' and conrelid = 'public.saved_reels'::regclass and contype = 'c'), 'saved_reels rejects blank normalized URLs');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_source_platform_check' and conrelid = 'public.saved_reels'::regclass and contype = 'c'), 'saved_reels restricts source platforms');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_analysis_status_check' and conrelid = 'public.saved_reels'::regclass and contype = 'c'), 'saved_reels restricts analysis states');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_personal_label_check' and conrelid = 'public.saved_reels'::regclass and contype = 'c'), 'saved_reels validates personal labels');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_analyzed_at_state_check' and conrelid = 'public.saved_reels'::regclass and contype = 'c'), 'saved_reels validates analyzed_at by state');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_user_id_fkey' and conrelid = 'public.saved_reels'::regclass and contype = 'f'), 'saved_reels user foreign key exists');
select ok(exists (select 1 from pg_constraint where conname = 'saved_reels_reel_cache_id_fkey' and conrelid = 'public.saved_reels'::regclass and contype = 'f' and confdeltype = 'n'), 'saved_reels cache foreign key sets null on cache deletion');
select has_index('public', 'saved_reels', 'saved_reels_user_created_id_idx', 'saved_reels newest-first index exists');
select has_index('public', 'saved_reels', 'saved_reels_user_status_created_id_idx', 'saved_reels state index exists');
select has_index('public', 'saved_reels', 'saved_reels_reel_cache_id_idx', 'saved_reels cache index exists');

select has_column('public', 'reel_collections', 'id', 'reel_collections.id exists');
select has_column('public', 'reel_collections', 'user_id', 'reel_collections.user_id exists');
select has_column('public', 'reel_collections', 'name', 'reel_collections.name exists');
select has_column('public', 'reel_collections', 'sort_order', 'reel_collections.sort_order exists');
select has_column('public', 'reel_collections', 'created_at', 'reel_collections.created_at exists');
select has_column('public', 'reel_collections', 'updated_at', 'reel_collections.updated_at exists');
select col_type_is('public', 'reel_collections', 'id', 'uuid', 'reel_collections.id is uuid');
select col_type_is('public', 'reel_collections', 'user_id', 'uuid', 'reel_collections.user_id is uuid');
select col_type_is('public', 'reel_collections', 'name', 'text', 'reel_collections.name is text');
select col_type_is('public', 'reel_collections', 'sort_order', 'integer', 'reel_collections.sort_order is integer');
select col_type_is('public', 'reel_collections', 'created_at', 'timestamp with time zone', 'reel_collections.created_at is timestamptz');
select col_type_is('public', 'reel_collections', 'updated_at', 'timestamp with time zone', 'reel_collections.updated_at is timestamptz');
select col_not_null('public', 'reel_collections', 'id', 'reel_collections.id is required');
select col_not_null('public', 'reel_collections', 'user_id', 'reel_collections.user_id is required');
select col_not_null('public', 'reel_collections', 'name', 'reel_collections.name is required');
select col_not_null('public', 'reel_collections', 'sort_order', 'reel_collections.sort_order is required');
select col_not_null('public', 'reel_collections', 'created_at', 'reel_collections.created_at is required');
select col_not_null('public', 'reel_collections', 'updated_at', 'reel_collections.updated_at is required');
select has_pk('public', 'reel_collections', 'reel_collections has a primary key');
select ok(exists (select 1 from pg_constraint where conrelid = 'public.reel_collections'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)'), 'reel_collections supports same-owner foreign keys');
select ok(exists (select 1 from pg_constraint where conname = 'reel_collections_name_trimmed_length_check' and conrelid = 'public.reel_collections'::regclass and contype = 'c'), 'reel_collections validates names');
select ok(exists (select 1 from pg_constraint where conname = 'reel_collections_sort_order_nonnegative_check' and conrelid = 'public.reel_collections'::regclass and contype = 'c'), 'reel_collections rejects negative sort orders');
select has_index('public', 'reel_collections', 'reel_collections_user_normalized_name_unique_idx', 'reel_collections normalized-name index exists');
select has_index('public', 'reel_collections', 'reel_collections_user_sort_idx', 'reel_collections order index exists');

select has_column('public', 'reel_collection_items', 'user_id', 'reel_collection_items.user_id exists');
select has_column('public', 'reel_collection_items', 'collection_id', 'reel_collection_items.collection_id exists');
select has_column('public', 'reel_collection_items', 'saved_reel_id', 'reel_collection_items.saved_reel_id exists');
select has_column('public', 'reel_collection_items', 'created_at', 'reel_collection_items.created_at exists');
select col_type_is('public', 'reel_collection_items', 'user_id', 'uuid', 'reel_collection_items.user_id is uuid');
select col_type_is('public', 'reel_collection_items', 'collection_id', 'uuid', 'reel_collection_items.collection_id is uuid');
select col_type_is('public', 'reel_collection_items', 'saved_reel_id', 'uuid', 'reel_collection_items.saved_reel_id is uuid');
select col_type_is('public', 'reel_collection_items', 'created_at', 'timestamp with time zone', 'reel_collection_items.created_at is timestamptz');
select col_not_null('public', 'reel_collection_items', 'user_id', 'reel_collection_items.user_id is required');
select col_not_null('public', 'reel_collection_items', 'collection_id', 'reel_collection_items.collection_id is required');
select col_not_null('public', 'reel_collection_items', 'saved_reel_id', 'reel_collection_items.saved_reel_id is required');
select col_not_null('public', 'reel_collection_items', 'created_at', 'reel_collection_items.created_at is required');
select has_pk('public', 'reel_collection_items', 'reel_collection_items has a primary key');
select ok(exists (select 1 from pg_constraint where conname = 'reel_collection_items_user_collection_fkey' and conrelid = 'public.reel_collection_items'::regclass and contype = 'f' and array_length(conkey, 1) = 2 and confdeltype = 'c'), 'reel_collection_items has same-owner collection foreign key');
select ok(exists (select 1 from pg_constraint where conname = 'reel_collection_items_user_saved_reel_fkey' and conrelid = 'public.reel_collection_items'::regclass and contype = 'f' and array_length(conkey, 1) = 2 and confdeltype = 'c'), 'reel_collection_items has same-owner saved reel foreign key');
select has_index('public', 'reel_collection_items', 'reel_collection_items_user_collection_idx', 'reel_collection_items collection index exists');
select has_index('public', 'reel_collection_items', 'reel_collection_items_user_saved_reel_idx', 'reel_collection_items saved reel index exists');

select ok((select relrowsecurity from pg_class where oid = 'public.saved_reels'::regclass), 'saved_reels has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.reel_collections'::regclass), 'reel_collections has RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.reel_collection_items'::regclass), 'reel_collection_items has RLS enabled');
select table_privs_are('public', 'saved_reels', 'authenticated', array['DELETE', 'SELECT'], 'authenticated has only table-level saved_reels read/delete privileges');
select ok(
  (select count(*) = 1 and bool_and(column_name::text = 'personal_label') from information_schema.column_privileges where table_schema = 'public' and table_name = 'saved_reels' and grantee = 'authenticated' and privilege_type = 'UPDATE'),
  'authenticated can update only saved_reels.personal_label'
);
select ok(not has_function_privilege('authenticated', 'public.capture_saved_reel(uuid,text,text)', 'EXECUTE'), 'authenticated cannot execute capture_saved_reel');
select ok(not has_function_privilege('anon', 'public.capture_saved_reel(uuid,text,text)', 'EXECUTE'), 'anon cannot execute capture_saved_reel');
select ok(has_function_privilege('service_role', 'public.capture_saved_reel(uuid,text,text)', 'EXECUTE'), 'service_role can execute capture_saved_reel');

select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url) values ('00000000-0000-0000-0000-000000000601', ' ')$$,
  '23514', null, 'saved_reels rejects blank normalized URLs'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, personal_label) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/blank-label', ' ')$$,
  '23514', null, 'saved_reels rejects blank personal labels'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, personal_label) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/long-label', repeat('x', 121))$$,
  '23514', null, 'saved_reels rejects personal labels longer than 120 characters'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/organized', 'organized')$$,
  '23514', null, 'organized saved reels require analyzed_at'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/location-not-found', 'location_not_found')$$,
  '23514', null, 'location_not_found saved reels require analyzed_at'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status, analyzed_at) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/not-analyzed', 'not_analyzed', now())$$,
  '23514', null, 'not_analyzed saved reels forbid analyzed_at'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status, analyzed_at) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/queued', 'queued', now())$$,
  '23514', null, 'queued saved reels forbid analyzed_at'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status, analyzed_at) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/processing', 'processing', now())$$,
  '23514', null, 'processing saved reels forbid analyzed_at'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, source_platform) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/platform', 'youtube')$$,
  '23514', null, 'saved_reels rejects unsupported source platforms'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url, analysis_status) values ('00000000-0000-0000-0000-000000000601', 'https://example.com/status', 'unknown')$$,
  '23514', null, 'saved_reels rejects unsupported analysis statuses'
);
select throws_ok(
  $$insert into public.reel_collections (user_id, name) values ('00000000-0000-0000-0000-000000000601', ' ')$$,
  '23514', null, 'reel_collections rejects blank names'
);
select throws_ok(
  $$insert into public.reel_collections (user_id, name) values ('00000000-0000-0000-0000-000000000601', ' padded ')$$,
  '23514', null, 'reel_collections rejects padded names'
);
select throws_ok(
  $$insert into public.reel_collections (user_id, name) values ('00000000-0000-0000-0000-000000000601', repeat('x', 81))$$,
  '23514', null, 'reel_collections rejects names longer than 80 characters'
);
select throws_ok(
  $$insert into public.reel_collections (user_id, name, sort_order) values ('00000000-0000-0000-0000-000000000601', 'negative', -1)$$,
  '23514', null, 'reel_collections rejects negative sort orders'
);

set local role service_role;

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/DEFAULT-PLATFORM')$$,
  'service_role can capture with the default instagram platform'
);

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/SHARED', 'instagram')$$,
  'capture_saved_reel creates user A saved reel'
);
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000602', 'https://www.instagram.com/reel/SHARED', 'instagram')$$,
  'capture_saved_reel creates user B saved reel'
);
select isnt(
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'),
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000602' and normalized_url = 'https://www.instagram.com/reel/SHARED'),
  'different users receive different saved reel rows'
);
select is(
  (select reel_cache_id from public.saved_reels where normalized_url = 'https://www.instagram.com/reel/SHARED' and user_id = '00000000-0000-0000-0000-000000000601'),
  '60000000-0000-0000-0000-000000000001'::uuid,
  'user A saved reel links to shared cache'
);
select is(
  (select count(distinct reel_cache_id) from public.saved_reels where normalized_url = 'https://www.instagram.com/reel/SHARED')::integer,
  1,
  'both saved reels share one cache row'
);

update public.saved_reels
set personal_label = 'keep me', analysis_status = 'organized', analyzed_at = now()
where user_id = '00000000-0000-0000-0000-000000000601'
  and normalized_url = 'https://www.instagram.com/reel/SHARED';

select is(
  (select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/SHARED', 'instagram')),
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'),
  'duplicate capture returns the same saved reel'
);
select results_eq(
  $$select personal_label, analysis_status from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'$$,
  $$values ('keep me'::text, 'organized'::text)$$,
  'duplicate capture preserves personal and analysis fields'
);

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/LATE-CACHE', 'instagram')$$,
  'capture creates a saved reel before its cache row exists'
);
update public.saved_reels
set personal_label = 'late label', analysis_status = 'location_not_found', analyzed_at = now()
where user_id = '00000000-0000-0000-0000-000000000601'
  and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE';
insert into public.reel_cache (id, normalized_url, source_platform, caption)
values ('60000000-0000-0000-0000-000000000002', 'https://www.instagram.com/reel/LATE-CACHE', 'instagram', 'late cache');
select is(
  (select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/LATE-CACHE', 'instagram')),
  (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'),
  'late-cache duplicate retains the same saved reel id'
);
select results_eq(
  $$select reel_cache_id, personal_label, analysis_status from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'$$,
  $$values ('60000000-0000-0000-0000-000000000002'::uuid, 'late label'::text, 'location_not_found'::text)$$,
  'late-cache duplicate attaches cache without overwriting user or analysis fields'
);

insert into public.reel_collections (id, user_id, name)
values
  ('61000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000601', 'Food'),
  ('61000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000601', 'Weekend'),
  ('61000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000602', 'Other user');
select throws_ok(
  $$insert into public.reel_collections (user_id, name) values ('00000000-0000-0000-0000-000000000601', 'food')$$,
  '23505', null, 'collection names are case-insensitively unique per user'
);
insert into public.reel_collection_items (user_id, collection_id, saved_reel_id)
values
  ('00000000-0000-0000-0000-000000000601', '61000000-0000-0000-0000-000000000001', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED')),
  ('00000000-0000-0000-0000-000000000601', '61000000-0000-0000-0000-000000000002', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'));
select is(
  (select count(*) from public.reel_collection_items where saved_reel_id = (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'))::integer,
  2,
  'one saved reel can belong to two collections'
);
select throws_ok(
  $$insert into public.reel_collection_items (user_id, collection_id, saved_reel_id) values ('00000000-0000-0000-0000-000000000601', '61000000-0000-0000-0000-000000000001', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'))$$,
  '23505', null, 'duplicate membership is rejected'
);
select throws_ok(
  $$insert into public.reel_collection_items (user_id, collection_id, saved_reel_id) values ('00000000-0000-0000-0000-000000000601', '61000000-0000-0000-0000-000000000001', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000602' and normalized_url = 'https://www.instagram.com/reel/SHARED'))$$,
  '23503', null, 'cross-user membership is rejected'
);
delete from public.reel_collection_items
where collection_id = '61000000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.reel_collection_items where collection_id = '61000000-0000-0000-0000-000000000002')::integer,
  1,
  'deleting one membership preserves the other membership'
);
select isnt_empty(
  $$select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'$$,
  'deleting one membership preserves the saved reel'
);
delete from public.reel_collections where id = '61000000-0000-0000-0000-000000000002';
select isnt_empty(
  $$select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'$$,
  'deleting a collection preserves the saved reel'
);
insert into public.reel_collections (id, user_id, name)
values ('61000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000601', 'Archive');
insert into public.reel_collection_items (user_id, collection_id, saved_reel_id)
values ('00000000-0000-0000-0000-000000000601', '61000000-0000-0000-0000-000000000004', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/SHARED'));
delete from public.saved_reels
where user_id = '00000000-0000-0000-0000-000000000601'
  and normalized_url = 'https://www.instagram.com/reel/SHARED';
select is_empty(
  $$select 1 from public.reel_collection_items where collection_id = '61000000-0000-0000-0000-000000000004'$$,
  'deleting a saved reel removes its memberships'
);
select isnt_empty(
  $$select id from public.reel_cache where id = '60000000-0000-0000-0000-000000000001'$$,
  'deleting a saved reel preserves the shared cache'
);
select isnt_empty(
  $$select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000602' and normalized_url = 'https://www.instagram.com/reel/SHARED'$$,
  'deleting user A saved reel preserves user B saved reel'
);
delete from public.reel_cache where id = '60000000-0000-0000-0000-000000000002';
select is(
  (select reel_cache_id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'),
  null::uuid,
  'deleting a cache row nulls its saved reel reference'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000601', true);
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000601","role":"authenticated"}', true);

select results_eq(
  $$select normalized_url from public.saved_reels order by normalized_url$$,
  $$values ('https://www.instagram.com/reel/DEFAULT-PLATFORM'::text), ('https://www.instagram.com/reel/LATE-CACHE'::text)$$,
  'user A sees only their saved reels'
);
select results_eq(
  $$select name from public.reel_collections order by name$$,
  $$values ('Archive'::text), ('Food'::text)$$,
  'user A sees only their collections'
);
select is(
  (select count(*) from public.reel_collection_items)::integer,
  0,
  'user A sees only their memberships'
);
select lives_ok(
  $$update public.saved_reels set personal_label = 'my late label' where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'$$,
  'user A can update their personal label'
);
select throws_ok(
  $$update public.saved_reels set analysis_status = 'failed' where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'$$,
  '42501', 'permission denied for table saved_reels', 'user A cannot update analysis status'
);
select throws_ok(
  $$update public.saved_reels set reel_cache_id = '60000000-0000-0000-0000-000000000001' where user_id = '00000000-0000-0000-0000-000000000601' and normalized_url = 'https://www.instagram.com/reel/LATE-CACHE'$$,
  '42501', 'permission denied for table saved_reels', 'user A cannot update cache attachment'
);
select results_eq(
  $$with attempted as (update public.reel_collections set name = 'Renamed' where id = '61000000-0000-0000-0000-000000000003' returning id) select count(*)::integer from attempted$$,
  $$values (0::integer)$$,
  'user A cannot rename user B collection'
);
select results_eq(
  $$with attempted as (delete from public.reel_collections where id = '61000000-0000-0000-0000-000000000003' returning id) select count(*)::integer from attempted$$,
  $$values (0::integer)$$,
  'user A cannot delete user B collection'
);
select throws_ok(
  $$insert into public.reel_collection_items (user_id, collection_id, saved_reel_id) values ('00000000-0000-0000-0000-000000000602', '61000000-0000-0000-0000-000000000003', (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000602' and normalized_url = 'https://www.instagram.com/reel/SHARED'))$$,
  '42501', 'new row violates row-level security policy for table "reel_collection_items"',
  'user A cannot organize user B saved reel'
);
select throws_ok(
  $$insert into public.saved_reels (user_id, normalized_url) values ('00000000-0000-0000-0000-000000000601', 'https://www.instagram.com/reel/DIRECT')$$,
  '42501', 'permission denied for table saved_reels', 'authenticated clients cannot insert saved reels directly'
);
select throws_ok(
  $$select id from public.reel_cache$$,
  '42501', 'permission denied for table reel_cache', 'authenticated clients cannot read shared reel_cache'
);

reset role;

select * from finish();

rollback;
