begin;

create extension if not exists pgtap with schema extensions;

select plan(27);

-- request_/cancel_account_deletion move an account into and out of the 7-day cancellable grace.
-- This proves, single-session and deterministically, that:
--   * request CASes active → pending_deletion, sets scheduled_for = now()+7d, and opens ONE
--     'pending' log row capturing the account email;
--   * a second request while pending returns NULL and writes no extra log row;
--   * cancel CASes pending_deletion → active, CLEARS the timestamps, and marks the log 'cancelled';
--   * after cancel a re-request succeeds again and opens a FRESH 'pending' log row (the new cycle);
--   * request for a nonexistent user returns NULL and writes nothing;
--   * cancel LOSES to 'deleting' (Task 3's point of no return) — returns 'already_deleting',
--     leaves the status untouched;
--   * EXECUTE on BOTH functions is service-role only (public/anon/authenticated revoked) — the
--     load-bearing privilege pin (without it an authenticated user could delete/cancel any uuid).
--
-- now() is frozen at transaction start, and the RPCs call the same now(), so scheduled_for equals
-- the test's `now() + interval '7 days'` exactly (deterministic). The "fresh schedule after cancel"
-- property is proven by the NEW 'pending' log row + the non-null re-request return, not by a clock
-- delta (which frozen-now cannot exercise — same limitation as 018's coalesce note).

-- ── Seed: one active account. Inserting into auth.users fires sync_auth_user_to_public_user,
--    which creates the public.users row (account_status defaults 'active'). ───────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001901', 'del-user@example.com');

-- ── request → enters the 7-day grace ────────────────────────────────────────────────────────
create temporary table req1 as
  select public.request_account_deletion('00000000-0000-0000-0000-000000001901') as scheduled_for;
select ok((select scheduled_for from req1) is not null,
  'request_account_deletion returns a non-null scheduled_for');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000001901'),
  'pending_deletion',
  'request flips account_status active → pending_deletion');
select is(
  (select deletion_scheduled_for from public.users where id = '00000000-0000-0000-0000-000000001901'),
  now() + interval '7 days',
  'request sets deletion_scheduled_for to now() + 7 days');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901' and outcome = 'pending'),
  1, 'request opens exactly one pending log row');
select is(
  (select recipient_email from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901' and outcome = 'pending'),
  'del-user@example.com',
  'the pending log row captures the account email (for the notices)');

-- ── a second request while pending → NULL, no extra log row ──────────────────────────────────
select ok(
  public.request_account_deletion('00000000-0000-0000-0000-000000001901') is null,
  'a second request while pending returns NULL (CAS misses on non-active)');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901'),
  1, 'the second request writes no additional log row');

-- ── cancel → back to active, timestamps cleared, log marked cancelled ─────────────────────────
select is(
  public.cancel_account_deletion('00000000-0000-0000-0000-000000001901'),
  'cancelled', 'cancel_account_deletion returns cancelled');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000001901'),
  'active', 'cancel flips account_status pending_deletion → active');
select ok(
  (select deletion_requested_at is null and deletion_scheduled_for is null
     from public.users where id = '00000000-0000-0000-0000-000000001901'),
  'cancel CLEARS both timestamps (so a re-request gets a brand-new schedule)');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901' and outcome = 'cancelled'),
  1, 'cancel marks the open log row cancelled');

-- ── re-request after cancel → fresh grace + a NEW pending log row ─────────────────────────────
select ok(
  public.request_account_deletion('00000000-0000-0000-0000-000000001901') is not null,
  're-request after cancel succeeds (cleared timestamps let the CAS match again)');
select is(
  (select deletion_scheduled_for from public.users where id = '00000000-0000-0000-0000-000000001901'),
  now() + interval '7 days',
  're-request sets a full 7-day schedule again');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901'),
  2, 're-request opens a NEW log row (1 cancelled + 1 fresh pending)');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-000000001901' and outcome = 'pending'),
  1, 'exactly one pending row after the re-request');

-- ── request for a nonexistent user → NULL, nothing written ────────────────────────────────────
select ok(
  public.request_account_deletion('00000000-0000-0000-0000-0000000019ff') is null,
  'request for a nonexistent user id returns NULL');
select is(
  (select count(*)::int from public.account_deletion_log
     where user_id = '00000000-0000-0000-0000-0000000019ff'),
  0, 'the nonexistent-user request writes no log row');

-- ── cancel LOSES to 'deleting' (Task 3's point of no return) ──────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001902', 'del-deleting@example.com');
update public.users set account_status = 'deleting'
  where id = '00000000-0000-0000-0000-000000001902';
select is(
  public.cancel_account_deletion('00000000-0000-0000-0000-000000001902'),
  'already_deleting', 'cancel on a deleting account returns already_deleting');
select is(
  (select account_status from public.users where id = '00000000-0000-0000-0000-000000001902'),
  'deleting', 'cancel leaves a deleting account untouched (the cancel loses the race)');

-- ── Privilege contract: service-role only, for BOTH functions ─────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.request_account_deletion(uuid)', 'EXECUTE'),
  'authenticated cannot execute request_account_deletion');
select ok(not has_function_privilege('anon', 'public.request_account_deletion(uuid)', 'EXECUTE'),
  'anon cannot execute request_account_deletion');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
     where p.oid = 'public.request_account_deletion(uuid)'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute request_account_deletion');
select ok(has_function_privilege('service_role', 'public.request_account_deletion(uuid)', 'EXECUTE'),
  'service_role can execute request_account_deletion');

select ok(not has_function_privilege('authenticated', 'public.cancel_account_deletion(uuid)', 'EXECUTE'),
  'authenticated cannot execute cancel_account_deletion');
select ok(not has_function_privilege('anon', 'public.cancel_account_deletion(uuid)', 'EXECUTE'),
  'anon cannot execute cancel_account_deletion');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
     where p.oid = 'public.cancel_account_deletion(uuid)'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute cancel_account_deletion');
select ok(has_function_privilege('service_role', 'public.cancel_account_deletion(uuid)', 'EXECUTE'),
  'service_role can execute cancel_account_deletion');

select * from finish();

rollback;
