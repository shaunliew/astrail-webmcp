-- Read-only repeat-pull report.
-- A repeat generator reaches a second distinct successful trip.
with params as (
  select
    date_trunc('week', now()) as report_start,
    date_trunc('week', now()) + interval '1 week' as report_end
),
ranked_successes as (
  select
    id,
    user_id,
    created_at,
    row_number() over (partition by user_id order by created_at, id) as success_number
  from public.trips
  where status in ('complete', 'saved_with_gaps')
),
per_user as (
  select
    user_id,
    count(*) as successful_trip_count,
    min(created_at) filter (where success_number = 1) as first_success_at,
    min(created_at) filter (where success_number = 2) as second_success_at
  from ranked_successes
  group by user_id
),
summary as (
  select
    count(*) as activated_users,
    count(*) filter (where successful_trip_count >= 2) as repeat_generators,
    count(*) filter (
      where second_success_at >= params.report_start
        and second_success_at < params.report_end
    ) as newly_repeating_users,
    count(*) filter (
      where successful_trip_count >= 2
        and exists (
          select 1
          from ranked_successes weekly
          where weekly.user_id = per_user.user_id
            and weekly.created_at >= params.report_start
            and weekly.created_at < params.report_end
        )
    ) as repeat_generators_active_this_week
  from per_user
  cross join params
)
select
  params.report_start,
  params.report_end,
  summary.activated_users,
  summary.repeat_generators,
  round(100.0 * summary.repeat_generators / nullif(summary.activated_users, 0), 1)
    as repeat_pull_percent,
  summary.newly_repeating_users,
  summary.repeat_generators_active_this_week
from params
cross join summary;
