begin;

create extension if not exists pgtap with schema extensions;

select plan(24);

select has_table('public', 'users', 'users table exists');
select has_table('public', 'traveler_profiles', 'traveler_profiles table exists');
select has_table('public', 'user_preference_facts', 'user_preference_facts table exists');
select has_table('public', 'memory_events', 'memory_events table exists');
select has_table('public', 'user_daily_usage', 'user_daily_usage table exists');

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000101', 'traveler-a@example.com'),
  ('00000000-0000-0000-0000-000000000202', 'traveler-b@example.com');

select is(
  (select count(*) from public.users),
  2::bigint,
  'auth trigger mirrors users into public.users'
);

insert into public.traveler_profiles (id, origin_city, travel_style_tags, onboarding_completed)
values
  ('00000000-0000-0000-0000-000000000101', 'Kuala Lumpur', array['balanced', 'food-led'], true),
  ('00000000-0000-0000-0000-000000000202', 'Singapore', array['packed'], true);

insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence)
values
  ('00000000-0000-0000-0000-000000000101', 'food', 'likes', '{"value":"ramen"}', 'onboarding', 0.9),
  ('00000000-0000-0000-0000-000000000202', 'pace', 'prefers', '{"value":"packed"}', 'onboarding', 0.8);

insert into public.memory_events (user_id, event_type, learned_facts_json)
values
  ('00000000-0000-0000-0000-000000000101', 'learned', '[{"fact":"likes ramen"}]'),
  ('00000000-0000-0000-0000-000000000202', 'learned', '[{"fact":"packed pace"}]');

insert into public.user_daily_usage (user_id, usage_date, generated_trip_count)
values
  ('00000000-0000-0000-0000-000000000101', current_date, 1),
  ('00000000-0000-0000-0000-000000000202', current_date, 2);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000101';
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000101","role":"authenticated"}';

select results_eq(
  $$select email from public.users order by email$$,
  $$values ('traveler-a@example.com'::text)$$,
  'traveler A can only read their own public user row'
);

select results_eq(
  $$select origin_city from public.traveler_profiles$$,
  $$values ('Kuala Lumpur'::text)$$,
  'traveler A can only read their own traveler profile'
);

select lives_ok(
  $$insert into public.traveler_profiles (id, origin_city) values ('00000000-0000-0000-0000-000000000101', 'Tokyo') on conflict (id) do update set origin_city = excluded.origin_city$$,
  'traveler A can upsert their own traveler profile'
);

select throws_ok(
  $$insert into public.traveler_profiles (id, origin_city) values ('00000000-0000-0000-0000-000000000202', 'Osaka') on conflict (id) do update set origin_city = excluded.origin_city$$,
  '42501',
  'new row violates row-level security policy for table "traveler_profiles"',
  'traveler A cannot upsert traveler B profile'
);

select results_eq(
  $$select fact_value ->> 'value' from public.user_preference_facts order by fact_key$$,
  $$values ('ramen'::text)$$,
  'traveler A can only read their own preference facts'
);

select lives_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence) values ('00000000-0000-0000-0000-000000000101', 'food', 'dislikes', '{"value":"queues"}', 'explicit_input', 0.7)$$,
  'traveler A can insert their own explicit preference fact'
);

select throws_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence) values ('00000000-0000-0000-0000-000000000202', 'food', 'cross_user', '{"value":"udon"}', 'explicit_input', 0.7)$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot insert preference facts for traveler B'
);

select throws_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence) values ('00000000-0000-0000-0000-000000000101', 'food', 'generated', '{"value":"sushi"}', 'generation', 0.7)$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot insert backend generation preference provenance'
);

select throws_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence, mem0_memory_id) values ('00000000-0000-0000-0000-000000000101', 'food', 'mem0_link', '{"value":"ramen"}', 'explicit_input', 0.7, 'mem_123')$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot insert mem0-linked preference provenance'
);

select throws_ok(
  $$insert into public.user_preference_facts (user_id, category, fact_key, fact_value, source, confidence, source_trip_id) values ('00000000-0000-0000-0000-000000000101', 'food', 'trip_link', '{"value":"ramen"}', 'explicit_input', 0.7, '10000000-0000-0000-0000-000000000101')$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot insert trip-linked preference provenance'
);

select throws_ok(
  $$update public.user_preference_facts set source = 'mem0' where user_id = '00000000-0000-0000-0000-000000000101' and fact_key = 'likes'$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot update preference fact into backend provenance'
);

select throws_ok(
  $$update public.user_preference_facts set mem0_memory_id = 'mem_123' where user_id = '00000000-0000-0000-0000-000000000101' and fact_key = 'likes'$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot add mem0 provenance to a preference fact'
);

select throws_ok(
  $$update public.user_preference_facts set source_trip_id = '10000000-0000-0000-0000-000000000101' where user_id = '00000000-0000-0000-0000-000000000101' and fact_key = 'likes'$$,
  '42501',
  'new row violates row-level security policy for table "user_preference_facts"',
  'traveler A cannot add trip provenance to a preference fact'
);

select results_eq(
  $$with attempted as (
      update public.user_preference_facts
      set fact_value = '{"value":"changed"}'
      where user_id = '00000000-0000-0000-0000-000000000202'
        and fact_key = 'prefers'
      returning id
    )
    select count(*)::integer from attempted$$,
  $$values (0::integer)$$,
  'traveler A cannot update traveler B preference facts'
);

select results_eq(
  $$with attempted as (
      delete from public.user_preference_facts
      where user_id = '00000000-0000-0000-0000-000000000202'
      returning id
    )
    select count(*)::integer from attempted$$,
  $$values (0::integer)$$,
  'traveler A cannot delete traveler B preference facts'
);

select results_eq(
  $$select generated_trip_count from public.user_daily_usage$$,
  $$values (1::integer)$$,
  'traveler A can only read their own quota row'
);

select results_eq(
  $$select learned_facts_json -> 0 ->> 'fact' from public.memory_events$$,
  $$values ('likes ramen'::text)$$,
  'traveler A can only read their own memory event'
);

reset role;

select throws_ok(
  $$insert into public.user_daily_usage (user_id, usage_date) values ('00000000-0000-0000-0000-000000000101', current_date)$$,
  '23505',
  null,
  'one usage row per user per day is enforced'
);

select * from finish();

rollback;
