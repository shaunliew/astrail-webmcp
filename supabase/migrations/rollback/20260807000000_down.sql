-- Rollback for 20260807000000_account_deletion_notice_durability.sql (C2).
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up
-- (it globs timestamped files at the top level of supabase/migrations only) — it is the escape
-- hatch, applied BY HAND, and it exists before the deploy rather than being written under pressure.
--
-- SAFE TO ROLL BACK ONLY BEFORE THIS BRANCH'S CODE IS DEPLOYED — or in lockstep with reverting/
-- redeploying that code. This is NOT a database-only step, even though the deletion FEATURE ships
-- gated OFF (`_DELETION_EXECUTION_READY=False`):
--   1. `scripts/assert_schema.py`'s preDeploy gate now PINS `account_deletion_log.notified_at`
--      (REQUIRED_SCHEMA), so dropping the column BRICKS every subsequent deploy of BOTH services
--      until the migration is re-applied or the pin reverted in the same window.
--   2. Once `_DELETION_EXECUTION_READY` is live, the request endpoint and the sweep's notice-retry
--      READ and WRITE this column; dropping it under a live engine breaks the scheduled-notice path.
-- Roll back only with the branch code reverted/redeployed in the SAME window.
--
-- ONE object to drop. `if exists` so a partial/repeated rollback is re-runnable. Non-destructive of
-- any OTHER state — the column is nullable and additive.
--
-- APPLY IT WITH `supabase db query --linked -f supabase/migrations/rollback/20260807000000_down.sql`
-- (this team has no psql / no local DB password — the PR #61 S3 correction). Postgres DDL is
-- transactional; with lock_timeout set a rollback that cannot get its lock aborts cleanly and is
-- simply retried.

set lock_timeout = '3s';
set statement_timeout = '30s';

alter table public.account_deletion_log drop column if exists notified_at;

-- Session-level; hand the session back as we found it.
reset lock_timeout;
reset statement_timeout;
