begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000301', 'anon-denial-owner@example.com');

insert into public.trips (id, user_id, status)
values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'draft');

set local role anon;

select throws_ok(
  $$select id from public.trips$$,
  '42501',
  'permission denied for table trips',
  'anon role cannot select from public.trips (no GRANT, no RLS policy targets anon)'
);

reset role;

select is(
  (select count(*) from public.trips)::integer,
  1,
  'sanity: the seeded trip still exists and is readable by a privileged role'
);

select * from finish();

rollback;
