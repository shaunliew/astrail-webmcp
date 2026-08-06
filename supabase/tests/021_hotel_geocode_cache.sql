-- hotel_geocode_cache shape + the coord<->status<->country_code invariant (20260805020000).
--
-- Mirrors 009_geocode_country_cache.sql (the cache this table's patterns follow). The load-bearing
-- half is the CHECK: 'found' MUST carry lat/lng/country_code and 'miss' MUST have all three NULL —
-- the honest-failure contract as a hard DB rule (extends 019's coord/status CHECK, adds
-- country_code). A `supabase db reset` alone proves the table is created; only these inserts prove
-- the constraint actually REJECTS a bad row.

begin;

create extension if not exists pgtap with schema extensions;

select plan(31);

-- Shape.
select has_table('public', 'hotel_geocode_cache', 'the hotel forward-geocode cache exists');
select has_column('public', 'hotel_geocode_cache', 'cache_key', 'the cache keys on the stable hotel identity');
select has_column('public', 'hotel_geocode_cache', 'status', 'the cache stores the found/miss geocode fact');
select has_column('public', 'hotel_geocode_cache', 'lat', 'the cache stores the geocoded latitude');
select has_column('public', 'hotel_geocode_cache', 'lng', 'the cache stores the geocoded longitude');
select has_column('public', 'hotel_geocode_cache', 'country_code', 'the cache stores the resolved country code');
select has_column('public', 'hotel_geocode_cache', 'name_fingerprint', 'the cache stores the read-side invalidation fingerprint');
select has_column('public', 'hotel_geocode_cache', 'created_at', 'the cache stamps creation');
select has_column('public', 'hotel_geocode_cache', 'expires_at', 'the cache stamps the bounded TTL expiry');
select col_type_is('public', 'hotel_geocode_cache', 'cache_key', 'text', 'the cache key is text');
select col_type_is('public', 'hotel_geocode_cache', 'expires_at', 'timestamp with time zone', 'expires_at is timestamptz');
select col_not_null('public', 'hotel_geocode_cache', 'expires_at', 'expires_at is NOT NULL — both statuses carry a bounded TTL');

-- The PK is cache_key alone — the stable identity IS the key.
select has_pk('public', 'hotel_geocode_cache', 'the cache has a primary key');
select ok(
  (select conkey from pg_constraint where conrelid = 'public.hotel_geocode_cache'::regclass and contype = 'p')
  = (select array_agg(attnum order by ord) from unnest(array['cache_key']) with ordinality t(col, ord)
      join pg_attribute on attrelid = 'public.hotel_geocode_cache'::regclass and attname = t.col),
  'the cache is keyed on cache_key alone — the stable hotel identity'
);

-- Valid rows: a fully-populated found and an all-NULL miss both satisfy the invariant.
select lives_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, name_fingerprint, expires_at)
    values ('v1:found', 'found', 35.67, 139.72, 'JP', 'fp-a', now() + interval '365 days')$$,
  'a found row with real coords + country is accepted'
);
select lives_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, expires_at)
    values ('v1:miss', 'miss', now() + interval '14 days')$$,
  'a miss row with NULL coords + NULL country is accepted'
);

-- THE INVARIANT. found MUST carry lat, lng AND country_code — a NULL on any is a placed-but-coordless
-- (or countryless) lie the honest-failure contract forbids.
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:found-null-lat', 'found', null, 139.72, 'JP', now())$$,
  '23514', null, 'a found row with NULL lat is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:found-null-lng', 'found', 35.67, null, 'JP', now())$$,
  '23514', null, 'a found row with NULL lng is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:found-null-country', 'found', 35.67, 139.72, null, now())$$,
  '23514', null, 'a found row with NULL country_code is rejected (the country_code half of the invariant)'
);
-- miss MUST have all three NULL — a coordinate on a miss would be handed back as a phantom find.
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:miss-lat', 'miss', 35.67, null, null, now())$$,
  '23514', null, 'a miss row carrying a lat is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:miss-country', 'miss', null, null, 'JP', now())$$,
  '23514', null, 'a miss row carrying a country_code is rejected'
);

-- Column-level guards.
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, expires_at)
    values ('bad:status', 'pending', now())$$,
  '23514', null, 'a status outside {found, miss} is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:lat-range', 'found', 100, 139.72, 'JP', now())$$,
  '23514', null, 'a latitude outside [-90, 90] is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:lng-range', 'found', 35.67, 200, 'JP', now())$$,
  '23514', null, 'a longitude outside [-180, 180] is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, expires_at)
    values ('bad:country-shape', 'found', 35.67, 139.72, 'jp', now())$$,
  '23514', null, 'a non-uppercase-alpha-2 country_code is rejected'
);
select throws_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code)
    values ('bad:no-expiry', 'miss', null, null, null)$$,
  '23502', null, 'a row with no expires_at is rejected (NOT NULL — bounded TTL)'
);

-- The production write is an UPSERT on cache_key. Postgres must INFER that arbiter from the primary
-- key, or the T3 writer fails at runtime against the real database while passing against a fake.
select lives_ok(
  $$insert into public.hotel_geocode_cache (cache_key, status, lat, lng, country_code, name_fingerprint, expires_at)
    values ('v1:found', 'found', 35.68, 139.73, 'JP', 'fp-b', now() + interval '365 days')
    on conflict (cache_key)
    do update set status = excluded.status, lat = excluded.lat, lng = excluded.lng,
                  country_code = excluded.country_code, name_fingerprint = excluded.name_fingerprint,
                  expires_at = excluded.expires_at$$,
  'the upsert arbiter (cache_key) is inferrable from the primary key'
);
select is(
  (select count(*)::integer from public.hotel_geocode_cache where cache_key = 'v1:found'),
  1,
  're-resolving a hotel updates its row instead of duplicating it'
);

-- Access: service-role only. The backend is the sole reader and writer and nothing belongs to a
-- user, so authenticated/anon get nothing at all.
select ok(
  (select relrowsecurity from pg_class where oid = 'public.hotel_geocode_cache'::regclass),
  'the cache has RLS enabled'
);
select table_privs_are(
  'public', 'hotel_geocode_cache', 'authenticated', array[]::text[],
  'authenticated has no privileges on the hotel geocode cache'
);
select table_privs_are(
  'public', 'hotel_geocode_cache', 'anon', array[]::text[],
  'anon has no privileges on the hotel geocode cache'
);

select * from finish();

rollback;
