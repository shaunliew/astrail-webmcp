# Growth reporting queries

These are operator-run, read-only queries for the live beta growth loop. They do not create views, mutate rows, grant seats, or change schema. Review the `params` CTE before each run, then run the file in a privileged Supabase SQL session.

## Metric definitions

- A successful generated trip is a `public.trips` row whose status is `complete` or `saved_with_gaps`. Draft, generating, places-ready, failed, and refunded attempts do not activate a user.
- Activation is a user's first successful generated trip.
- A repeat generator is an activated user who reaches a second distinct successful trip.
- Feedback reporting keeps thumbs and each rating value separate. It deliberately does not invent a rule such as “4–5 stars are positive”; the founders must define the quality goal first.
- A granted beta seat is `public.users.plan = 'beta'`. `seat_requested_at` is only a request timestamp and is not a grant.

## Files

- `01_activation.sql` — cumulative and current-week activation, including beta-seat activation.
- `02_repeat_generators.sql` — cumulative repeat pull and users reaching their second trip this week.
- `03_trip_feedback.sql` — trip-feedback volume, coverage, thumbs, rating distribution, and comments.
- `04_beta_seat_running_count.sql` — 25-seat guardrail summary, current seat roster, and pending request queue.

## Weekly operating cadence

Run all four every Monday in the same privileged session. Copy only aggregate metrics into the shared growth docs. Do not export user IDs or emails into public or broadly shared documents.

The current schema does not record `seat_granted_at`, grant source, or grant operator. `users.updated_at` is not a valid substitute because unrelated profile/account changes also update it. Until the founders choose a durable seat-list system, the database can prove the current running count and current holders, but not historical grant timing.
