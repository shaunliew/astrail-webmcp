-- Rollback for 20260805010000_account_deletion_engine.sql.
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up
-- (it globs timestamped files at the top level of supabase/migrations only) — it is the escape
-- hatch, applied BY HAND with psql, and it exists before the deploy rather than being written
-- under pressure.
--
-- SAFE TO ROLL BACK ANY TIME BEFORE THE FEATURE GOES LIVE. Task 3 ships gated OFF
-- (`_DELETION_EXECUTION_READY=False`) and nothing calls this RPC until Task 6 flips the gate, so
-- before that flip this is a database-only step: no code revert, no redeploy, no ordering against
-- a release. (After go-live, rolling back would strip the claim a two-pass deletion depends on —
-- do not run it then without draining in-flight deletions first.)
--
-- ONE object to drop. `if exists` so a partial/repeated rollback is re-runnable.
--
-- RUN IT WITH `psql -1`: Postgres DDL is transactional, so one transaction makes a failure
-- all-or-nothing. With lock_timeout set, a rollback that cannot get its lock aborts cleanly and is
-- simply retried.

set lock_timeout = '3s';
set statement_timeout = '30s';

drop function if exists public.claim_account_for_deletion(uuid);

-- Session-level, and this file is applied by hand into an operator's psql session that keeps going
-- afterwards. Hand it back as we found it.
reset lock_timeout;
reset statement_timeout;
