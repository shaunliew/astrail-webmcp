-- Read-only weekly activation report.
-- Edit report_start/report_end together when backfilling a prior week.
with params as (
  select
    date_trunc('week', now()) as report_start,
    date_trunc('week', now()) + interval '1 week' as report_end
),
successful_trips as (
  select id, user_id, created_at
  from public.trips
  where status in ('complete', 'saved_with_gaps')
),
first_success as (
  select user_id, min(created_at) as first_success_at
  from successful_trips
  group by user_id
),
totals as (
  select
    count(*) as account_count,
    count(*) filter (where plan = 'beta') as granted_beta_seats
  from public.users
),
activation as (
  select
    count(*) as activated_users,
    count(*) filter (
      where first_success_at >= params.report_start
        and first_success_at < params.report_end
    ) as newly_activated_users,
    count(*) filter (where users.plan = 'beta') as activated_beta_seats
  from first_success
  join public.users on users.id = first_success.user_id
  cross join params
),
weekly_generators as (
  select count(distinct successful_trips.user_id) as weekly_successful_generators
  from successful_trips
  cross join params
  where successful_trips.created_at >= params.report_start
    and successful_trips.created_at < params.report_end
)
select
  params.report_start,
  params.report_end,
  totals.account_count,
  activation.activated_users,
  round(100.0 * activation.activated_users / nullif(totals.account_count, 0), 1)
    as account_activation_percent,
  activation.newly_activated_users,
  weekly_generators.weekly_successful_generators,
  totals.granted_beta_seats,
  activation.activated_beta_seats,
  round(100.0 * activation.activated_beta_seats / nullif(totals.granted_beta_seats, 0), 1)
    as beta_seat_activation_percent
from params
cross join totals
cross join activation
cross join weekly_generators;
