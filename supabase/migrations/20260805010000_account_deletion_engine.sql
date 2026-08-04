-- Lean self-serve account deletion — the point-of-no-return claim RPC (Task 3).
--
-- SCHEMA-FIRST, GATED OFF. This ships the ONE privilege-pinned RPC the two-pass delete engine
-- needs: claim_account_for_deletion atomically flips a still-pending account into 'deleting'
-- (the irreversible claim — a concurrent cancel loses here). The engine + sweep that call it live
-- in backend/deletion_engine.py and run ONLY when `_DELETION_EXECUTION_READY=True` (main.py),
-- which Task 6 flips. Deploying this migration ahead of that flip is a no-op for the running
-- version — nothing invokes this function until the gate flips.
--
-- account_status lifecycle (Task 2 defined the states): 'active' → 'pending_deletion' (request,
-- reversible for 7 days) → 'deleting' (THIS RPC's atomic claim; a cancel now loses) → row gone
-- (auth.users hard-delete cascades public.users away). Log-row writes (backoff, purged-verified,
-- completed) go through the service-role client DIRECTLY — account_deletion_log is service-role-
-- only, so those need no RPC; only the cross-user users CAS needs the security-definer boundary.
--
-- PRIVILEGE PIN (mirrors Task 2's request_/cancel_account_deletion and reserve_and_enqueue_trip_
-- job). The RPC takes a p_user_id and mutates THAT user's row, so EXECUTE is REVOKED from
-- public/anon/authenticated and granted ONLY to service_role. Without it an authenticated user
-- could POST straight to PostgREST and doom an arbitrary uuid into 'deleting'. The backend calls
-- this with the sweep-selected row's user_id (never a client value); the pin is the boundary.

-- ── claim_account_for_deletion — the atomic point of no return (CAS pending_deletion→deleting) ──
-- Returns true when the CAS matched a still-'pending_deletion' row (this sweeper claimed it),
-- false otherwise. False means the account is no longer heading for deletion the way this claim
-- expects: a concurrent cancel already flipped it back to 'active', the row is absent, or it is
-- already 'deleting'/other. The caller (deletion_engine.erase_user) re-reads account_status on
-- false to tell "a cancel won → never delete" apart from "we already claimed it on a prior tick →
-- keep retrying the purge" — this RPC stays a pure single-statement CAS.
create or replace function public.claim_account_for_deletion(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.users
     set account_status = 'deleting'
   where id = p_user_id and account_status = 'pending_deletion';
  -- FOUND is true only when a still-'pending_deletion' row matched. Returned directly so the
  -- boolean IS "did this call win the claim".
  return found;
end $$;

revoke all on function public.claim_account_for_deletion(uuid) from public, anon, authenticated;
grant execute on function public.claim_account_for_deletion(uuid) to service_role;
