begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000301', 'trip-a@example.com'),
  ('00000000-0000-0000-0000-000000000302', 'trip-b@example.com');

insert into public.trips (id, user_id, status, destination_hint, adult_count, child_count, room_count)
values
  ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'generating', 'Tokyo', 2, 0, 1),
  ('10000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000302', 'complete', 'Osaka', 1, 0, 1);

insert into public.jobs (id, trip_id, user_id, idempotency_key, status, error_message, completed_at, created_at)
values
  ('20000000-0000-0000-0000-000000000301', '10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'trip-a-key', 'pending', null, null, '2026-01-01 00:00:00+00'),
  ('20000000-0000-0000-0000-000000000302', '10000000-0000-0000-0000-000000000302', '00000000-0000-0000-0000-000000000302', 'trip-b-key', 'retryable', 'previous failure', now(), '2026-01-01 00:00:01+00');

insert into public.generation_events (trip_id, event_type, stage, message)
values
  ('10000000-0000-0000-0000-000000000301', 'stage', 'scrape', 'Scraped 1 Reel.'),
  ('10000000-0000-0000-0000-000000000302', 'stage', 'scrape', 'Scraped 2 Reels.');

select has_table('public', 'trips', 'trips table exists');
select has_table('public', 'jobs', 'jobs table exists');
select has_table('public', 'generation_events', 'generation_events table exists');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000301';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000301","role":"authenticated"}';

select results_eq(
  $$select destination_hint from public.trips order by destination_hint$$,
  $$values ('Tokyo'::text)$$,
  'traveler A can only read their own trips'
);

select results_eq(
  $$select idempotency_key from public.jobs order by idempotency_key$$,
  $$values ('trip-a-key'::text)$$,
  'traveler A can only read their own jobs'
);

select results_eq(
  $$select message from public.generation_events order by created_at$$,
  $$values ('Scraped 1 Reel.'::text)$$,
  'traveler A can only read generation events for own trip'
);

select throws_ok(
  $$insert into public.trips (user_id, destination_hint) values ('00000000-0000-0000-0000-000000000301', 'Kyoto')$$,
  '42501',
  'permission denied for table trips',
  'authenticated clients cannot insert trips directly'
);

select throws_ok(
  $$insert into public.jobs (trip_id, user_id, idempotency_key) values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'frontend-job')$$,
  '42501',
  'permission denied for table jobs',
  'authenticated clients cannot insert jobs directly'
);

select throws_ok(
  $$select private.claim_next_generation_job()$$,
  '42501',
  'permission denied for schema private',
  'authenticated clients cannot execute the private job claim helper'
);

reset role;

select throws_ok(
  $$insert into public.jobs (trip_id, user_id, idempotency_key) values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'trip-a-key')$$,
  '23505',
  null,
  'job idempotency key is unique'
);

select throws_ok(
  $$insert into public.jobs (trip_id, user_id, idempotency_key) values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000302', 'cross-owner-job')$$,
  '23503',
  null,
  'job trip and user must belong to the same owner'
);

select throws_ok(
  $$insert into public.memory_events (user_id, trip_id, event_type) values ('00000000-0000-0000-0000-000000000302', '10000000-0000-0000-0000-000000000301', 'learned')$$,
  '23503',
  null,
  'memory event trip and user must belong to the same owner'
);

select throws_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, source_trip_id) values ('00000000-0000-0000-0000-000000000302', 'food', 'source_trip', '{"value":"ramen"}', 'generation', '10000000-0000-0000-0000-000000000301')$$,
  '23503',
  null,
  'preference source trip and user must belong to the same owner'
);

select throws_ok(
  $$insert into public.trips (user_id, status, adult_count, room_count) values ('00000000-0000-0000-0000-000000000301', 'draft', 0, 1)$$,
  '23514',
  null,
  'trip adult count must be positive'
);

select lives_ok(
  $$set local role service_role$$,
  'test can switch to service_role for backend-only job claim'
);

select isnt_empty(
  $$select private.claim_next_generation_job()$$,
  'service-side claim helper can claim one pending job'
);

select results_eq(
  $$select status, attempt_count, error_message, completed_at is null from public.jobs where id = '20000000-0000-0000-0000-000000000301'$$,
  $$values ('running'::text, 1::integer, null::text, true)$$,
  'claim helper marks first pending job running'
);

select isnt_empty(
  $$select private.claim_next_generation_job()$$,
  'service-side claim helper can claim one retryable job'
);

select results_eq(
  $$select status, attempt_count, error_message, completed_at is null from public.jobs where id = '20000000-0000-0000-0000-000000000302'$$,
  $$values ('running'::text, 1::integer, null::text, true)$$,
  'claim helper clears stale retry diagnostics'
);

select results_eq(
  $$select private.claim_next_generation_job() is null$$,
  $$values (true)$$,
  'claim helper returns null when no pending work remains'
);

reset role;

select * from finish();

rollback;
