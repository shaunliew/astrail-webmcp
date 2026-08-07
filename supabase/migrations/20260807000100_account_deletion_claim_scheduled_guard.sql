-- Point of no return decided by Postgres time, not a stale sweep row (C5 — PR #61 recommended).
--
-- CREATE OR REPLACE of claim_account_for_deletion (originally 20260805010000) adding
-- `and deletion_scheduled_for <= now()` to the CAS. This closes the F1 race at its ROOT: F1's
-- log-write guard protects the LOG row, but the destructive users CAS is keyed on user_id and, before
-- this, would still WIN on a freshly re-requested account — a stale sweep row holding an expired
-- schedule could claim an account whose live 7-day grace had just restarted, deleting it early. With
-- Postgres time gating the claim, a re-requested account (deletion_scheduled_for in the future)
-- CANNOT be claimed until its OWN grace actually lapses, so the fresh grace is honoured. It also
-- hardens the process-clock grace-expiry concern (Codex #5): Postgres now() decides the irreversible
-- step, not the reaper host's clock.
--
-- NULL-safe: whenever account_status='pending_deletion' the request RPC has also set
-- deletion_scheduled_for (cancel clears both together), so the column is non-null here; and even a
-- stray NULL yields `NULL <= now()` = NULL = no match = no claim (fail-safe, never a wrong delete).
--
-- CREATE OR REPLACE preserves the signature, so the existing revoke/grant carry over; they are
-- re-issued here so this file is a self-contained, idempotent statement of the RPC's posture (and the
-- assert_schema deploy gate keeps proving the service_role grant). GATED OFF: nothing calls this
-- until _DELETION_EXECUTION_READY flips (main.py) — applying it ahead of the code is a no-op.

create or replace function public.claim_account_for_deletion(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.users
     set account_status = 'deleting'
   where id = p_user_id
     and account_status = 'pending_deletion'
     and deletion_scheduled_for <= now();   -- C5: the grace must have ACTUALLY lapsed (Postgres time)
  -- FOUND is true only when a still-'pending_deletion', now-DUE row matched. A future-scheduled
  -- (freshly re-requested) account returns false and is left untouched in its fresh grace.
  return found;
end $$;

revoke all on function public.claim_account_for_deletion(uuid) from public, anon, authenticated;
grant execute on function public.claim_account_for_deletion(uuid) to service_role;
