-- Rollback for 20260805000000_account_deletion_lean.sql.
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up
-- (it globs timestamped files at the top level of supabase/migrations only) — it is the escape
-- hatch, applied BY HAND with psql, and it exists before the deploy rather than being written
-- under pressure.
--
-- SAFE TO ROLL BACK ONLY BEFORE THIS BRANCH'S CODE IS DEPLOYED — or in lockstep with reverting/
-- redeploying that code. This is NOT a database-only step, even though the deletion FEATURE ships
-- gated OFF (`_DELETION_EXECUTION_READY=False`): two live code paths already read these objects the
-- instant the branch deploys, gate or no gate.
--   1. `pipeline/preferences.py::_account_deletion_frozen` reads `users.account_status` on EVERY
--      generation write-back and FAILS CLOSED on a missing column — so dropping `account_status`
--      SILENTLY disables ALL mem0 write-back platform-wide (guardrail #3 makes the failure silent).
--   2. `scripts/assert_schema.py`'s preDeploy gate now REQUIRES these columns, so dropping them
--      BRICKS every subsequent deploy until the migration is re-applied or the code reverted.
-- Roll back only with the branch code reverted/redeployed in the SAME window. After go-live it also
-- strips the state a pending deletion depends on — drain in-flight deletions first.
--
-- ORDER IS LOAD-BEARING: drop the two RPCs FIRST (they name the columns), then the log table, then
-- the columns. `if exists` on every statement so a partial rollback is re-runnable.
--
-- RUN IT WITH `psql -1`: Postgres DDL is transactional, so one transaction makes the intermediate
-- state invisible to every concurrent session and makes a failure all-or-nothing. With
-- lock_timeout set, a rollback that cannot get its lock aborts cleanly and is simply retried. The
-- statement ORDER is kept anyway as the backstop for whoever runs this without `-1` at 3am.

set lock_timeout = '3s';
set statement_timeout = '30s';

drop function if exists public.request_account_deletion(uuid);
drop function if exists public.cancel_account_deletion(uuid);

drop table if exists public.account_deletion_log;

alter table public.users drop column if exists deletion_scheduled_for;
alter table public.users drop column if exists deletion_requested_at;
alter table public.users drop column if exists account_status;

-- Session-level, and this file is applied by hand into an operator's psql session that keeps going
-- afterwards. Hand it back as we found it.
reset lock_timeout;
reset statement_timeout;
