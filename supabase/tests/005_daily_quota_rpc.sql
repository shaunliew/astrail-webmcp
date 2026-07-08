begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000401', 'quota-user@example.com');

select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 1, 'first increment -> 1');
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 2, 'second increment -> 2');
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 3, 'third increment -> 3');
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), null, 'at cap -> NULL (rejected)');

select * from finish();

rollback;
