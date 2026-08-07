-- Durable + visible scheduled-deletion notice (C2 — PR #61 go-live blocker).
--
-- Adds the ONE column the "scheduled — cancel by {date}" email needs to stop being fire-and-forget.
-- That email is the safety net that REPLACED reauthentication for the stolen-session threat model
-- (plan §3.5); before this, a swallowed send — a 403 unverified-domain (Shaun hit exactly this on
-- 2026-08-07), a Resend 500, a timeout — left NOTHING on the row, so a user in a 7-day countdown got
-- no cancel-by notice and no trace anyone could reconcile.
--
-- `notified_at` is the send-CONFIRMED stamp: the request endpoint sets it on a 2xx send; the sweep
-- re-sends any still-'pending', still-cancellable (scheduled_for > now), still-unnotified row until
-- the notice genuinely lands. Distinct from `completed_at` (the account-DELETED notice).
--
-- GATED OFF like the rest of the feature: nothing reads or writes this column until
-- `_DELETION_EXECUTION_READY` flips (main.py). Applying it ahead of the code is a no-op for the
-- running version. account_deletion_log is already service-role-only (20260805000000) — no new grants.

set lock_timeout = '3s';   -- account_deletion_log is tiny + new, and a nullable no-default add is a
                           -- fast metadata-only change (no rewrite) — but bound the lock anyway
                           -- (the opus should-fix from PR #61: never queue an unbounded lock).

alter table public.account_deletion_log
  add column if not exists notified_at timestamptz;

comment on column public.account_deletion_log.notified_at is
  'When the "scheduled — cancel by {date}" grace email was CONFIRMED sent (a Resend 2xx). NULL = not '
  'yet sent; the sweep retries the notice for pending, still-cancellable (scheduled_for > now) rows '
  'while this is NULL. Distinct from completed_at (the account-deleted notice). C2 / PR #61.';
