begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

-- claim_account_for_deletion is Task 3's atomic point of no return: the CAS that flips a
-- still-'pending_deletion' account into 'deleting' so a two-pass sweep can act on it while a
-- concurrent cancel loses the race. This proves, single-session and deterministically, that:
--   * the claim CASes pending_deletion → deleting and returns true;
--   * a second claim on the now-'deleting' row returns false and leaves the status untouched
--     (idempotent-at-the-status-level: the engine treats false-with-status-'deleting' as "ours,
--     keep retrying the purge", NOT as a cancel);
--   * a claim on an 'active' row returns false and never flips it (a cancel already won);
--   * a claim on a nonexistent user returns false and writes nothing;
--   * EXECUTE is service-role only (public/anon/authenticated revoked) — the load-bearing
--     privilege pin, without which an authenticated user could doom any uuid into 'deleting'.
--
-- Runs at the Task 6 live pgTAP gate against real Postgres (no local DB is reachable from the
-- keyless suite). Paired with backend/test_deletion_engine.py, which proves the ENGINE's handling
-- of each claim outcome with fakes.

-- ── Seed: one pending account. Inserting into auth.users fires sync_auth_user_to_public_user,
--    which creates the public.users row; then request_account_deletion enters the grace. ────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002001', 'claim-user@example.com');
select public.request_account_deletion('00000000-0000-0000-0000-000000002001');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000002001'),
  'pending_deletion', 'precondition: the account is pending_deletion before the claim');

-- ── first claim → wins, flips pending_deletion → deleting ─────────────────────────────────────
select is(
  public.claim_account_for_deletion('00000000-0000-0000-0000-000000002001'),
  true, 'claim_account_for_deletion returns true on the first (winning) claim');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000002001'),
  'deleting', 'the winning claim flips account_status pending_deletion → deleting');

-- ── second claim on the now-'deleting' row → false, status untouched ──────────────────────────
select is(
  public.claim_account_for_deletion('00000000-0000-0000-0000-000000002001'),
  false, 'a second claim on an already-deleting row returns false (the CAS matches nothing)');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000002001'),
  'deleting', 'the losing second claim leaves the deleting status untouched');

-- ── claim on an 'active' account (a cancel already won) → false, never flips ──────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000002002', 'claim-active@example.com');
select is(
  public.claim_account_for_deletion('00000000-0000-0000-0000-000000002002'),
  false, 'a claim on an active account returns false (a cancel won / never pending)');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000002002'),
  'active', 'the claim never flips an active account into deleting');

-- ── claim on a nonexistent user → false ───────────────────────────────────────────────────────
select is(
  public.claim_account_for_deletion('00000000-0000-0000-0000-0000000020ff'),
  false, 'a claim on a nonexistent user id returns false');

-- ── Privilege contract: service-role only ─────────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.claim_account_for_deletion(uuid)', 'EXECUTE'),
  'authenticated cannot execute claim_account_for_deletion');
select ok(has_function_privilege('service_role', 'public.claim_account_for_deletion(uuid)', 'EXECUTE'),
  'service_role can execute claim_account_for_deletion');

select * from finish();

rollback;
