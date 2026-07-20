begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

-- Shape.
select has_table('public', 'geocode_country_cache', 'the coordinate→country cache exists');
select has_column('public', 'geocode_country_cache', 'coord_key', 'the cache keys on a coordinate');
select has_column('public', 'geocode_country_cache', 'verification_version', 'the cache keys on the verification contract');
select has_column('public', 'geocode_country_cache', 'country_code', 'the cache stores the verified country code');
select has_column('public', 'geocode_country_cache', 'country_name', 'the cache stores the verified country name');
select has_column('public', 'geocode_country_cache', 'created_at', 'the cache stamps creation for the TTL-deferral audit query');
select col_type_is('public', 'geocode_country_cache', 'coord_key', 'text', 'the coordinate key is text');
select col_type_is('public', 'geocode_country_cache', 'verification_version', 'text', 'the verification version is text');

-- The PK is (coord_key, verification_version) — BOTH columns. Dropping verification_version
-- from it would make bump-to-invalidate a no-op and serve answers written under a superseded
-- verification contract.
select has_pk('public', 'geocode_country_cache', 'the cache has a composite primary key');
select ok(
  (select conkey from pg_constraint where conrelid = 'public.geocode_country_cache'::regclass and contype = 'p')
  = (select array_agg(attnum order by ord) from unnest(array['coord_key','verification_version']) with ordinality t(col, ord)
      join pg_attribute on attrelid = 'public.geocode_country_cache'::regclass and attname = t.col),
  'the cache is keyed (coord_key, verification_version) — the verification contract is IN the key'
);

-- Value guards. These are the same checks `_ground_place` relies on being true of a cached
-- row: a blank or malformed country would be handed straight back as a verified answer.
select throws_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('35.6586,139.7454', 'mapbox-country-v1', 'jp', 'Japan')$$,
  '23514',
  null,
  'a non-ISO country code is rejected'
);
select throws_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('35.6586,139.7454', 'mapbox-country-v1', 'JP', '   ')$$,
  '23514',
  null,
  'a blank country name is rejected'
);

-- Shape guard on the key: it catches a malformed/empty key, not a wrong coordinate.
select throws_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('garbage', 'mapbox-country-v1', 'JP', 'Japan')$$,
  '23514',
  null,
  'a non-coordinate cache key is rejected'
);
select throws_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('', 'mapbox-country-v1', 'JP', 'Japan')$$,
  '23514',
  null,
  'an empty cache key is rejected'
);
select lives_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('-33.8688,151.2093', 'mapbox-country-v1', 'AU', 'Australia')$$,
  'a lossless signed repr() coordinate key is accepted'
);
select lives_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('1.401e-45,-1.7976931348623157e+308', 'mapbox-country-v1', 'JP', 'Japan')$$,
  'an exponent-form repr() coordinate key is accepted'
);

-- Same coordinate under a NEW verification version is a separate row, never a conflict —
-- this is what makes a version bump invalidate rather than overwrite.
select lives_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('-33.8688,151.2093', 'mapbox-country-v2', 'AU', 'Australia')$$,
  'the same coordinate under a bumped verification version is a distinct row'
);

-- The production write is an UPSERT on (coord_key, verification_version). Postgres must be
-- able to INFER that arbiter from the primary key, or `_store_cached_country` fails at
-- runtime against the real database while passing against an in-memory fake.
select lives_ok(
  $$insert into public.geocode_country_cache (coord_key, verification_version, country_code, country_name)
    values ('-33.8688,151.2093', 'mapbox-country-v1', 'AU', 'Australia')
    on conflict (coord_key, verification_version)
    do update set country_code = excluded.country_code, country_name = excluded.country_name$$,
  'the upsert arbiter (coord_key, verification_version) is inferrable from the primary key'
);
select is(
  (select count(*)::integer from public.geocode_country_cache
    where coord_key = '-33.8688,151.2093' and verification_version = 'mapbox-country-v1'),
  1,
  're-verifying a coordinate updates its row instead of duplicating it'
);

-- Access: service-role only. The backend is the sole reader and writer and nothing here
-- belongs to a user, so `authenticated` gets nothing at all.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.geocode_country_cache'::regclass),
  'the cache has RLS enabled'
);
select table_privs_are(
  'public', 'geocode_country_cache', 'authenticated', array[]::text[],
  'authenticated has no privileges on the geocode cache'
);
select table_privs_are(
  'public', 'geocode_country_cache', 'anon', array[]::text[],
  'anon has no privileges on the geocode cache'
);

select * from finish();

rollback;
