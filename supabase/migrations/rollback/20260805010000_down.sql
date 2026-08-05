-- Rollback for 20260805010000_account_deletion_engine.sql.
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up
-- (it globs timestamped files at the top level of supabase/migrations only) — it is the escape
-- hatch, applied BY HAND with psql, and it exists before the deploy rather than being written
-- under pressure.
--
-- SAFE TO ROLL BACK ONLY BEFORE THIS BRANCH'S CODE IS DEPLOYED — or in lockstep with reverting/
-- redeploying that code. This is NOT a database-only step, even though the deletion FEATURE ships
-- gated OFF (`_DELETION_EXECUTION_READY=False`): `scripts/assert_schema.py`'s preDeploy gate now
-- probes `claim_account_for_deletion` for LIVENESS, so dropping this RPC BRICKS every subsequent
-- deploy until the migration is re-applied or the code reverted. Roll back only with the branch
-- code reverted/redeployed in the SAME window. After go-live it also strips the claim a two-pass
-- deletion depends on — drain in-flight deletions first.
--
-- TWO objects to drop (the claim RPC + the sweep index). `if exists` so a partial/repeated
-- rollback is re-runnable.
--
-- RUN IT WITH `psql -1`: Postgres DDL is transactional, so one transaction makes a failure
-- all-or-nothing. With lock_timeout set, a rollback that cannot get its lock aborts cleanly and is
-- simply retried.

set lock_timeout = '3s';
set statement_timeout = '30s';

drop index if exists public.account_deletion_log_sweep_idx;
drop function if exists public.claim_account_for_deletion(uuid);

-- Session-level, and this file is applied by hand into an operator's psql session that keeps going
-- afterwards. Hand it back as we found it.
reset lock_timeout;
reset statement_timeout;
