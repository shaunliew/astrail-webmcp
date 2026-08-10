-- Read-only trip-feedback report.
-- Deliberately reports rating values separately: the founders have not defined
-- which ratings, if any, combine with thumbs_up as a "positive" signal.
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
trip_feedback as (
  select feedback.*
  from public.feedback
  where artifact_type = 'trip'
),
all_time as (
  select
    count(*) as feedback_rows,
    count(distinct trip_id) as trips_with_feedback,
    count(distinct user_id) as users_who_left_feedback,
    count(*) filter (where feedback_type = 'thumbs_up') as thumbs_up_count,
    count(*) filter (where feedback_type = 'thumbs_down') as thumbs_down_count,
    count(*) filter (where feedback_type = 'rating' and rating = 1) as rating_1_count,
    count(*) filter (where feedback_type = 'rating' and rating = 2) as rating_2_count,
    count(*) filter (where feedback_type = 'rating' and rating = 3) as rating_3_count,
    count(*) filter (where feedback_type = 'rating' and rating = 4) as rating_4_count,
    count(*) filter (where feedback_type = 'rating' and rating = 5) as rating_5_count,
    round(avg(rating) filter (where feedback_type = 'rating'), 2) as average_rating,
    count(*) filter (where nullif(btrim(comment), '') is not null) as rows_with_comment
  from trip_feedback
),
weekly as (
  select
    count(*) as weekly_feedback_rows,
    count(distinct trip_id) as weekly_trips_with_feedback,
    count(distinct user_id) as weekly_users_who_left_feedback,
    count(*) filter (where feedback_type = 'thumbs_up') as weekly_thumbs_up_count,
    count(*) filter (where feedback_type = 'thumbs_down') as weekly_thumbs_down_count,
    count(*) filter (where feedback_type = 'rating') as weekly_rating_count,
    count(*) filter (where nullif(btrim(comment), '') is not null) as weekly_rows_with_comment
  from trip_feedback
  cross join params
  where trip_feedback.created_at >= params.report_start
    and trip_feedback.created_at < params.report_end
),
successful_summary as (
  select
    count(*) as successful_trips,
    count(distinct user_id) as activated_users
  from successful_trips
)
select
  params.report_start,
  params.report_end,
  successful_summary.successful_trips,
  successful_summary.activated_users,
  all_time.feedback_rows,
  all_time.trips_with_feedback,
  round(100.0 * all_time.trips_with_feedback / nullif(successful_summary.successful_trips, 0), 1)
    as successful_trip_feedback_coverage_percent,
  all_time.users_who_left_feedback,
  round(100.0 * all_time.users_who_left_feedback / nullif(successful_summary.activated_users, 0), 1)
    as activated_user_feedback_coverage_percent,
  all_time.thumbs_up_count,
  all_time.thumbs_down_count,
  all_time.rating_1_count,
  all_time.rating_2_count,
  all_time.rating_3_count,
  all_time.rating_4_count,
  all_time.rating_5_count,
  all_time.average_rating,
  all_time.rows_with_comment,
  weekly.weekly_feedback_rows,
  weekly.weekly_trips_with_feedback,
  weekly.weekly_users_who_left_feedback,
  weekly.weekly_thumbs_up_count,
  weekly.weekly_thumbs_down_count,
  weekly.weekly_rating_count,
  weekly.weekly_rows_with_comment
from params
cross join successful_summary
cross join all_time
cross join weekly;
