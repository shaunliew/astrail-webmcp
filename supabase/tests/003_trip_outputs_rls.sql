begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000401', 'output-a@example.com'),
  ('00000000-0000-0000-0000-000000000402', 'output-b@example.com');

insert into public.trips (id, user_id, status, destination_hint)
values
  ('10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000401', 'complete', 'Tokyo'),
  ('10000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000402', 'complete', 'Kyoto');

insert into public.reel_cache (id, normalized_url, caption)
values
  ('30000000-0000-0000-0000-000000000401', 'https://www.instagram.com/reel/a/', 'Tokyo reel'),
  ('30000000-0000-0000-0000-000000000402', 'https://www.instagram.com/reel/b/', 'Kyoto reel');

insert into public.places (id, name, place_type, lat, lng, country, city)
values
  ('40000000-0000-0000-0000-000000000401', 'Tokyo Tower', 'attraction', 35.6586, 139.7454, 'Japan', 'Tokyo'),
  ('40000000-0000-0000-0000-000000000402', 'Kyoto Tower', 'attraction', 34.9875, 135.7593, 'Japan', 'Kyoto'),
  ('40000000-0000-0000-0000-000000000403', 'Ramen Near Tokyo Tower', 'restaurant', 35.6590, 139.7460, 'Japan', 'Tokyo'),
  ('40000000-0000-0000-0000-000000000404', 'Tokyo Station Base', 'hotel', 35.6812, 139.7671, 'Japan', 'Tokyo');

insert into public.trip_inspiration_items (trip_id, item_type, source, normalized_reel_url, reel_cache_id, status)
values
  ('10000000-0000-0000-0000-000000000401', 'reel_url', 'manual_paste', 'https://www.instagram.com/reel/a/', '30000000-0000-0000-0000-000000000401', 'places_found'),
  ('10000000-0000-0000-0000-000000000402', 'reel_url', 'manual_paste', 'https://www.instagram.com/reel/b/', '30000000-0000-0000-0000-000000000402', 'places_found');

insert into public.trip_places (trip_id, place_id, source_type, day_number, sort_order)
values
  ('10000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000401', 'reel_extracted', 1, 1),
  ('10000000-0000-0000-0000-000000000402', '40000000-0000-0000-0000-000000000402', 'reel_extracted', 1, 1);

insert into public.trip_days (id, trip_id, day_number, day_date, title)
values
  ('50000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000401', 1, '2026-12-01', 'Tokyo arrival'),
  ('50000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000402', 1, '2026-12-02', 'Kyoto arrival');

insert into public.transport_legs (id, trip_id, trip_day_id, from_place_id, to_place_id, leg_order, transport_mode, routing_provider, routing_profile, status, duration_seconds, distance_meters)
values
  ('60000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000404', 1, 'walk', 'mapbox', 'walking', 'ok', 900, 1200),
  ('60000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000402', '50000000-0000-0000-0000-000000000402', '40000000-0000-0000-0000-000000000402', null, 1, 'walk', 'mapbox', 'walking', 'ok', 300, 450);

insert into public.restaurant_suggestions (id, trip_id, trip_day_id, restaurant_place_id, near_place_id, cuisine, summary)
values
  ('70000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000403', '40000000-0000-0000-0000-000000000401', 'ramen', 'Good ramen near Tokyo Tower.'),
  ('70000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000402', '50000000-0000-0000-0000-000000000402', null, '40000000-0000-0000-0000-000000000402', 'soba', 'Good soba near Kyoto Tower.');

insert into public.hotel_suggestions (id, trip_id, trip_day_id, base_place_id, name, area, source, status)
values
  ('80000000-0000-0000-0000-000000000401', '10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000401', '40000000-0000-0000-0000-000000000404', 'Tokyo Station Base', 'Tokyo Station', 'travala', 'suggested'),
  ('80000000-0000-0000-0000-000000000402', '10000000-0000-0000-0000-000000000402', '50000000-0000-0000-0000-000000000402', '40000000-0000-0000-0000-000000000402', 'Kyoto Tower Base', 'Kyoto Station', 'travala', 'suggested');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000401';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000401","role":"authenticated"}';

select results_eq(
  $$select normalized_reel_url from public.trip_inspiration_items$$,
  $$values ('https://www.instagram.com/reel/a/'::text)$$,
  'traveler A can read only own inspiration items'
);

select results_eq(
  $$select name from public.places order by name$$,
  $$values ('Ramen Near Tokyo Tower'::text), ('Tokyo Station Base'::text), ('Tokyo Tower'::text)$$,
  'traveler A can read places connected to own trip outputs'
);

select results_eq(
  $$select place_id::text from public.trip_places$$,
  $$values ('40000000-0000-0000-0000-000000000401'::text)$$,
  'traveler A can read own trip places'
);

select results_eq(
  $$select title from public.trip_days$$,
  $$values ('Tokyo arrival'::text)$$,
  'traveler A can read own trip days'
);

select results_eq(
  $$select duration_seconds from public.transport_legs$$,
  $$values (900::integer)$$,
  'traveler A can read own transport legs'
);

select results_eq(
  $$select cuisine from public.restaurant_suggestions$$,
  $$values ('ramen'::text)$$,
  'traveler A can read own restaurant suggestions'
);

select results_eq(
  $$select name from public.hotel_suggestions$$,
  $$values ('Tokyo Station Base'::text)$$,
  'traveler A can read own hotel suggestions'
);

select lives_ok(
  $$insert into public.feedback (trip_id, user_id, artifact_type, feedback_type, rating, preference_source) values ('10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000401', 'trip', 'rating', 5, 'explicit')$$,
  'traveler A can insert feedback on own trip'
);

select throws_ok(
  $$insert into public.feedback (trip_id, user_id, artifact_type, artifact_id, feedback_type, rating, preference_source) values ('10000000-0000-0000-0000-000000000401', '00000000-0000-0000-0000-000000000401', 'hotel_suggestion', '80000000-0000-0000-0000-000000000401', 'rating', 1, 'explicit')$$,
  '42501',
  'new row violates row-level security policy for table "feedback"',
  'traveler A cannot insert artifact feedback directly'
);

select throws_ok(
  $$insert into public.feedback (trip_id, user_id, artifact_type, feedback_type, rating, preference_source) values ('10000000-0000-0000-0000-000000000402', '00000000-0000-0000-0000-000000000401', 'trip', 'rating', 1, 'explicit')$$,
  '42501',
  'new row violates row-level security policy for table "feedback"',
  'traveler A cannot insert feedback on traveler B trip'
);

select throws_ok(
  $$select count(*) from public.reel_cache$$,
  '42501',
  'permission denied for table reel_cache',
  'authenticated clients cannot read global reel cache directly'
);

reset role;

select throws_ok(
  $$insert into public.places (name, place_type, lat, lng) values ('Bad lat', 'attraction', 120, 139)$$,
  '23514',
  null,
  'place latitude bounds are enforced'
);

select throws_ok(
  $$insert into public.transport_legs (trip_id, leg_order, transport_mode, routing_provider, status, duration_seconds) values ('10000000-0000-0000-0000-000000000401', 1, 'walk', 'mapbox', 'ok', -1)$$,
  '23514',
  null,
  'transport duration cannot be negative'
);

select throws_ok(
  $$insert into public.transport_legs (trip_id, trip_day_id, leg_order, transport_mode, routing_provider, status) values ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000402', 2, 'walk', 'mapbox', 'ok')$$,
  '23503',
  null,
  'transport leg day must belong to the same trip'
);

select throws_ok(
  $$insert into public.restaurant_suggestions (trip_id, trip_day_id, summary) values ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000402', 'Bad cross-trip restaurant.')$$,
  '23503',
  null,
  'restaurant suggestion day must belong to the same trip'
);

select throws_ok(
  $$insert into public.hotel_suggestions (trip_id, trip_day_id, name) values ('10000000-0000-0000-0000-000000000401', '50000000-0000-0000-0000-000000000402', 'Bad cross-trip hotel')$$,
  '23503',
  null,
  'hotel suggestion day must belong to the same trip'
);

select has_index('public', 'places', 'places_lat_lng_idx', 'places lat/lng index exists');
select has_index('public', 'transport_legs', 'transport_legs_trip_day_order_idx', 'transport leg ordering index exists');
select has_index('public', 'feedback', 'feedback_user_id_created_at_idx', 'feedback owner index exists');

select * from finish();

rollback;
