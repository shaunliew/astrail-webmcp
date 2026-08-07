-- Rollback for 20260807000100_account_deletion_claim_scheduled_guard.sql (C5).
--
-- NOT a migration. It lives in this subdirectory precisely so the Supabase CLI never picks it up.
-- It is the escape hatch, applied BY HAND, and it exists before the deploy rather than being written
-- under pressure.
--
-- ⚠ THIS IS NOT `drop function`. C5 is a CREATE OR REPLACE of an RPC that already existed
-- (20260805010000). Dropping `claim_account_for_deletion` would (a) BRICK the deploy — the
-- assert_schema preDeploy gate probes this RPC for LIVENESS — and (b) strip the claim the two-pass
-- deletion depends on. Rolling C5 back therefore means RE-APPLYING THE ORIGINAL 20260805010000 BODY
-- (the CAS WITHOUT the `deletion_scheduled_for <= now()` conjunct), not removing the function.
--
-- SAFE TO ROLL BACK ONLY BEFORE THIS BRANCH'S CODE IS DEPLOYED — or in lockstep with reverting the
-- code. The engine tolerates either CAS shape (the C5 predicate only makes the claim STRICTER), so a
-- revert is behavior-safe; it just re-opens the F1 re-request race C5 closed. Re-issues the
-- revoke/grant so the privilege pin is restored verbatim.
--
-- APPLY IT WITH `supabase db query --linked -f supabase/migrations/rollback/20260807000100_down.sql`
-- (no psql / no local DB password — the PR #61 S3 correction). Idempotent (`create or replace`).

set lock_timeout = '3s';
set statement_timeout = '30s';

-- Restore the pre-C5 claim body (20260805010000): CAS pending_deletion -> deleting, no due-time gate.
create or replace function public.claim_account_for_deletion(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.users
     set account_status = 'deleting'
   where id = p_user_id and account_status = 'pending_deletion';
  return found;
end $$;

revoke all on function public.claim_account_for_deletion(uuid) from public, anon, authenticated;
grant execute on function public.claim_account_for_deletion(uuid) to service_role;

reset lock_timeout;
reset statement_timeout;
