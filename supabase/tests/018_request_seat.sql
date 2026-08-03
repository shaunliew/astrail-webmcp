begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

-- request_seat stamps public.users.seat_requested_at exactly once. This proves, single-session
-- and deterministically, that:
--   * the first call returns a non-null timestamp AND writes it to the row;
--   * a repeat call returns the ORIGINAL stamp and does NOT overwrite it (coalesce, idempotent);
--   * coalesce genuinely PRESERVES a pre-existing (non-now()) stamp — the LOAD-BEARING coalesce
--     proof (a same-transaction repeat call is satisfied by frozen-now() alone, see below);
--   * a call for a nonexistent user id returns NULL and writes nothing;
--   * EXECUTE is service-role only (public/anon/authenticated are all revoked).

-- ── Seed: one account ───────────────────────────────────────────────────────────────────────
-- Inserting into auth.users fires sync_auth_user_to_public_user, which creates the public.users
-- row (seat_requested_at defaults NULL).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001801', 'seat-user@example.com');

-- ── First call → non-null timestamp, and the row is stamped to that same value ──────────────
create temporary table seat1 as
  select public.request_seat('00000000-0000-0000-0000-000000001801') as stamp;
select ok((select stamp from seat1) is not null,
  'the first request_seat call returns a non-null timestamp');
select is(
  (select seat_requested_at from public.users where id = '00000000-0000-0000-0000-000000001801'),
  (select stamp from seat1),
  'the first call stamps users.seat_requested_at to the returned value');

-- ── Repeat call → the SAME timestamp; coalesce keeps the original, never overwrites ─────────
create temporary table seat2 as
  select public.request_seat('00000000-0000-0000-0000-000000001801') as stamp;
select is((select stamp from seat2), (select stamp from seat1),
  'a repeat call returns the ORIGINAL stamp (idempotent — coalesce, not overwritten)');
select is(
  (select seat_requested_at from public.users where id = '00000000-0000-0000-0000-000000001801'),
  (select stamp from seat1),
  'the repeat call leaves users.seat_requested_at unchanged');

-- ── Coalesce PRESERVES a pre-existing stamp (the load-bearing idempotency proof) ─────────────
-- The repeat-call check above is satisfied by transaction semantics ALONE: pgTAP runs the whole
-- file in ONE transaction and Postgres freezes now() at transaction start, so two request_seat
-- calls return the same value even with bare now() (no coalesce). To actually pin coalesce, seed a
-- SECOND account whose seat_requested_at is already a fixed PAST literal (set directly, bypassing
-- the RPC), then assert request_seat returns THAT literal — bare now() would return the current
-- transaction timestamp instead. This assertion reds if coalesce is ever dropped.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000001802', 'seat-preset@example.com');
update public.users set seat_requested_at = timestamptz '2020-01-01 00:00:00+00'
  where id = '00000000-0000-0000-0000-000000001802';
select is(
  public.request_seat('00000000-0000-0000-0000-000000001802'),
  timestamptz '2020-01-01 00:00:00+00',
  'request_seat PRESERVES a pre-existing stamp (coalesce, not now()) — reds if coalesce is dropped');

-- ── No public.users row → UPDATE matches nothing → NULL, and nothing is written ─────────────
select ok(
  public.request_seat('00000000-0000-0000-0000-0000000018ff') is null,
  'a call for a nonexistent user id returns NULL');
select is(
  (select count(*)::int from public.users where id = '00000000-0000-0000-0000-0000000018ff'),
  0, 'the nonexistent-user call writes no row');

-- ── Privilege contract: service-role only ───────────────────────────────────────────────────
select ok(not has_function_privilege('authenticated', 'public.request_seat(uuid)', 'EXECUTE'),
  'authenticated cannot execute request_seat');
select ok(not has_function_privilege('anon', 'public.request_seat(uuid)', 'EXECUTE'),
  'anon cannot execute request_seat');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
     where p.oid = 'public.request_seat(uuid)'::regprocedure
       and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'),
  'PUBLIC cannot execute request_seat');
select ok(has_function_privilege('service_role', 'public.request_seat(uuid)', 'EXECUTE'),
  'service_role can execute request_seat');

select * from finish();

rollback;
