-- Read-only beta-seat guardrail and manual tracking report.
-- Operational cap 25 comes from RELEASE SOP. This query does not grant seats.

-- Result set 1: running-count guardrail. Check this before and after every grant.
with params as (
  select 25::integer as seat_cap
),
counts as (
  select
    count(*) filter (where plan = 'beta') as granted_seats,
    count(*) filter (where plan = 'trial' and seat_requested_at is not null) as pending_requests
  from public.users
)
select
  params.seat_cap,
  counts.granted_seats,
  greatest(params.seat_cap - counts.granted_seats, 0) as seats_remaining,
  counts.pending_requests,
  counts.granted_seats > params.seat_cap as over_cap,
  counts.granted_seats = params.seat_cap as at_cap
from params
cross join counts;

-- Result set 2: current seat holders. `updated_at` is intentionally omitted;
-- it is not a grant timestamp. Keep IDs/emails in the privileged operator session.
select
  id as user_id,
  email,
  seat_requested_at,
  created_at as account_created_at
from public.users
where plan = 'beta'
order by email nulls last, id;

-- Result set 3: requested but not granted, oldest request first.
select
  id as user_id,
  email,
  seat_requested_at,
  created_at as account_created_at
from public.users
where plan = 'trial'
  and seat_requested_at is not null
order by seat_requested_at, id;
