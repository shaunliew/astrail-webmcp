-- ISSUES-B5: the event-sequencing invariant, pinned in SQL.
--
-- CHARACTERIZATION, not TDD. Every assertion here passes against the code as shipped by A2;
-- the file exists because none of them were pinned anywhere, and `backend/organizer.py`'s
-- `_record_organize_event` now carries a comment telling future readers that
-- `MAX(sequence) + 1` is collision-free *because of the row lock inside this function*. A
-- claim that load-bearing has to be enforced by a test, not just asserted in prose.
--
-- WHY THIS FILE AND NOT 008. Verified by fault injection before it was written: delete
-- `for update` from `append_organize_event` and the whole suite (9 files / 491 tests,
-- 008_job_leases.sql included) stays GREEN. 008 drives its appends SEQUENTIALLY down one
-- connection, so it pins the allocation RESULT (1, 2, 3, 4, 5, gapless) while the lock that
-- makes that result hold under concurrency goes completely unobserved.
--
-- WHAT A pgTAP FILE CANNOT DO HERE, stated plainly rather than papered over. `supabase test
-- db` runs each file inside ONE transaction on ONE connection, so genuine N-writer
-- contention is out of reach: a second session opened via dblink could not see the fixture
-- rows this uncommitted transaction seeded. So this does not race writers. It asserts the
-- two things that are observable in-transaction and from which a racing writer's safety is
-- *derived*:
--   1. `append_organize_event` really does take a FOR UPDATE row lock on the parent job, and
--   2. `organize_events_job_sequence_unique` really is the backstop if anything ever
--      allocates a sequence outside that lock.
-- Given both, serialization is Postgres's guarantee rather than ours. The Python-side
-- companion (`backend/test_organizer_lease.py`, "--- ISSUES-B5 ---") pins the control flow
-- above this: a worker that lost the claim emits zero events.

begin;

create extension if not exists pgtap with schema extensions;
-- pgrowlocks reports the row-level lock MODE, which is the whole point — see below. Created
-- inside the test transaction, so it rolls back with everything else and no migration or
-- deployed database ever carries it.
create extension if not exists pgrowlocks with schema extensions;

select plan(7);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000901', 'sequencing@example.com');

insert into public.organize_jobs (
  id, user_id, idempotency_key, status, request_json, locked_at, lock_expires_at, lease_token, attempt_count, total_count
)
values (
  '7a000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000901',
  'sequencing-a',
  'processing',
  '{"saved_reel_ids":["seq-a"]}'::jsonb,
  now(),
  now() + interval '5 minutes',
  '7b000000-0000-0000-0000-00000000000a',
  1,
  1
);

-- 1. THE ROW LOCK IS REAL — and asserting that takes more care than it first appears.
--
-- The obvious probe, `pg_locks` for a RowShareLock on organize_jobs, DOES NOT WORK, and
-- failing for a non-obvious reason is exactly why it is written up here. organize_events has
-- a foreign key to organize_jobs (organize_events_user_job_fkey), so the INSERT inside
-- append_organize_event takes its own `FOR KEY SHARE` lock on that same parent row to
-- validate the reference. `FOR KEY SHARE` and `FOR UPDATE` both surface as RowShareLock at
-- the RELATION level, so a pg_locks probe stays green with `for update` deleted — it is
-- watching the foreign key, not the lock under test. That false-green was observed, not
-- theorized.
--
-- The row-level MODE is the only signal that separates the deliberate lock from the
-- incidental one: `{"For Update"}` with the lock present, `{"For Key Share"}` without it.
-- Hence pgrowlocks. The before/after pair rules out a lock left over from the seeding
-- INSERTs, so ordering is load-bearing: nothing may append before assertion 1 runs.
select is(
  (select count(*)::integer from extensions.pgrowlocks('public.organize_jobs')),
  0,
  'no row of organize_jobs is locked before the first append'
);

set local role service_role;
select is(
  public.append_organize_event(
    '7a000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000901',
    '7b000000-0000-0000-0000-00000000000a', 'stage', 'Finding places'
  ),
  1,
  'the append allocates the first sequence'
);
reset role;

select results_eq(
  $$select modes from extensions.pgrowlocks('public.organize_jobs')
     where locked_row = (
       select ctid from public.organize_jobs where id = '7a000000-0000-0000-0000-000000000001'
     )$$,
  $$values (array['For Update']::text[])$$,
  'append_organize_event holds a FOR UPDATE lock on the parent organize job row'
);

-- 2. THE BACKSTOP IS REAL.
--
-- The invariant comment tells a future reader that allocating a sequence anywhere other than
-- inside this RPC "reopens organize_events_job_sequence_unique". That sentence is only a
-- warning if the constraint actually fires, and until now nothing asserted it did: 007 covers
-- organize_events' primary key, foreign key, RLS and replay index, but never this unique
-- constraint. The insert below is deliberately hand-rolled — it is exactly the
-- second-writer-allocating-its-own-sequence shape the comment forbids.
select col_is_unique(
  'public', 'organize_events', array['job_id', 'sequence'],
  'organize events are unique per job and sequence'
);

select throws_ok(
  $$insert into public.organize_events (user_id, job_id, sequence, event_type, message)
    values ('00000000-0000-0000-0000-000000000901', '7a000000-0000-0000-0000-000000000001', 1, 'stage', 'second writer')$$,
  '23505', null,
  'reusing an allocated sequence violates organize_events_job_sequence_unique'
);

-- The rejected duplicate must not have landed, and the legitimate append must still be the
-- only row: a constraint that fired but let the row through would be worse than no constraint.
select is(
  (select count(*)::integer from public.organize_events
    where job_id = '7a000000-0000-0000-0000-000000000001'),
  1,
  'the rejected duplicate wrote no organize event'
);
select results_eq(
  $$select sequence, event_type, message from public.organize_events
     where job_id = '7a000000-0000-0000-0000-000000000001' order by sequence$$,
  $$values (1, 'stage'::text, 'Finding places'::text)$$,
  'the surviving event is the one the fenced RPC allocated'
);

select * from finish();

rollback;
