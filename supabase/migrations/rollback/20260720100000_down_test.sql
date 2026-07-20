-- Proves `20260720100000_down.sql` does not re-open the cross-user leak A3 closed.
--
-- NOT RUN BY `supabase test db`, and it cannot be. That harness mounts ONLY `supabase/tests`
-- into its pg_prove container, so a test living there resolves `\ir ../migrations/...` to a
-- path that does not exist inside the container (verified: "No such file or directory" for
-- both `../migrations/rollback/*` and `../migrations/*`). Copying the rollback's SQL into a
-- mounted test would test the copy — the exact failure mode where a divergent script ships
-- green. So this runs from the HOST, where both paths are real, against the same local DB:
--
--   supabase db reset && \
--   PGPASSWORD=postgres psql -X -v ON_ERROR_STOP=1 \
--     -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -f supabase/migrations/rollback/20260720100000_down_test.sql
--
-- `finish(true)` raises on any failed assertion, so ON_ERROR_STOP makes the exit code the
-- gate. Everything runs inside one transaction that ROLLS BACK, so it neither leaves the
-- rollback applied nor disturbs the pgTAP suite — it is re-runnable and order-independent.
--
-- Run it as step 0 of the maintenance window, before the forward migration.

begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000a01', 'rollback-organizer@example.com'),
       ('00000000-0000-0000-0000-000000000a02', 'rollback-saver@example.com');

insert into public.reel_cache (id, normalized_url, source_platform, caption, thumbnail_url,
                               transcript, raw_payload)
values ('90000000-0000-0000-0000-000000000001',
        'https://www.instagram.com/reel/ROLLBACK-SHARED', 'instagram',
        'A caption both users saved', 'https://cdn.example/shared.jpg',
        'private transcript', '{"private":"payload"}'::jsonb),
       ('90000000-0000-0000-0000-000000000002',
        'https://www.instagram.com/reel/ROLLBACK-ORPHAN', 'instagram',
        'A caption only the saver has', 'https://cdn.example/orphan.jpg',
        'private transcript', '{"private":"payload"}'::jsonb);

insert into public.places (id, name, place_type, lat, lng, country_code, country_name)
values ('91000000-0000-0000-0000-000000000001', 'Organizer Tower', 'attraction',
        35.6586, 139.7454, 'JP', 'Japan'),
       ('91000000-0000-0000-0000-000000000002', 'Unowned Shrine', 'attraction',
        35.7148, 139.7967, 'JP', 'Japan');

-- THE LEAK'S EXACT SHAPE. User A organized the shared Reel, so the only surviving mention is
-- A's. User B saved the SAME Reel and never organized it, so B owns no mention — B's access,
-- if any, can only come from a join that ignores ownership.
insert into public.saved_reels (id, user_id, normalized_url, reel_cache_id, analysis_status,
                                analyzed_at)
values ('92000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000a01',
        'https://www.instagram.com/reel/ROLLBACK-SHARED',
        '90000000-0000-0000-0000-000000000001', 'organized', now()),
       ('92000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000a02',
        'https://www.instagram.com/reel/ROLLBACK-SHARED',
        '90000000-0000-0000-0000-000000000001', 'not_analyzed', null),
       ('92000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000a02',
        'https://www.instagram.com/reel/ROLLBACK-ORPHAN',
        '90000000-0000-0000-0000-000000000002', 'not_analyzed', null);

insert into public.reel_place_mentions (user_id, reel_cache_id, place_id, evidence_quote,
                                        confidence, verification_version)
values ('00000000-0000-0000-0000-000000000a01', '90000000-0000-0000-0000-000000000001',
        '91000000-0000-0000-0000-000000000001', 'the tower at sunset', 0.9,
        'mapbox-country-v1');

-- --- the fixture is a genuine leak scenario, before the rollback is applied ------------------
--
-- Both halves matter. If B were already denied for some unrelated reason (wrong place id, a
-- missing verification_version, no grant on `places`), every post-rollback assertion below
-- would pass against a rollback that leaks — a fixture whose natural state already satisfies
-- the assertion. A's row is what rules that out: the same seed grants A and denies B, so
-- "0 rows" is ownership doing the work and nothing else.

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
select is(
  (select count(*) from public.places where id = '91000000-0000-0000-0000-000000000001'),
  0::bigint,
  'A3 forward: a user who only SAVED the Reel cannot read the organizer''s verified place'
);

select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
select is(
  (select count(*) from public.places where id = '91000000-0000-0000-0000-000000000001'),
  1::bigint,
  'A3 forward: the user who ORGANIZED the Reel still reads their own verified place'
);
reset role;

-- --- apply the real rollback script, in this transaction -------------------------------------

\ir 20260720100000_down.sql

-- Proof the include actually EXECUTED. Without these, a mistyped path or a silently skipped
-- file would leave the A3 schema in place and every assertion below would be re-testing the
-- forward migration — green, and proving nothing about the rollback at all.
select is(
  (select array_agg(attname::text order by attname)
     from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.reel_place_mentions'::regclass and i.indisprimary),
  array['place_id', 'reel_cache_id'],
  'rollback restored the pre-A3 primary key'
);
select ok(
  not (select attnotnull from pg_attribute
        where attrelid = 'public.reel_place_mentions'::regclass and attname = 'user_id'),
  'rollback made user_id nullable again'
);
select ok(
  to_regprocedure('public.replace_reel_place_mentions(uuid,uuid,text,jsonb)') is null,
  'rollback dropped the A3 set-replacement RPC'
);

-- --- the leak stays closed after the rollback -------------------------------------------------
--
-- THE POINT OF THE FILE. The pre-A3 predicate and view joined mentions to saved Reels on
-- `reel_cache_id` ALONE, so B's saved_reels row reached A's mention and B read A's evidence.
-- Restoring them verbatim would restore that. `user_id` survives the rollback populated (the
-- script leaves it nullable rather than dropping it), so retaining the ownership equality
-- costs nothing and is what makes these two assertions red against a verbatim restore.

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
select is(
  (select count(*) from public.places where id = '91000000-0000-0000-0000-000000000001'),
  0::bigint,
  'after rollback: a user who only SAVED the Reel still cannot read the organizer''s place'
);
select is(
  (select jsonb_array_length(places) from public.saved_reel_cards
    where reel_cache_id = '90000000-0000-0000-0000-000000000001'),
  0,
  'after rollback: the saver''s card carries none of the organizer''s pins'
);

-- ...and not by over-restricting into uselessness. An equality join that matched nothing at
-- all would satisfy the two assertions above while breaking every legitimate reader.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000a01","role":"authenticated"}', true);
select is(
  (select count(*) from public.places where id = '91000000-0000-0000-0000-000000000001'),
  1::bigint,
  'after rollback: the organizer still reads their own verified place'
);
select is(
  (select places->0->>'name' from public.saved_reel_cards
    where id = '92000000-0000-0000-0000-000000000001'),
  'Organizer Tower',
  'after rollback: the organizer''s card still carries their own pin'
);
reset role;

-- --- rows the post-rollback OLD code writes ---------------------------------------------------
--
-- Old `_persist_mention` does not know about `user_id`, so every mention it writes after the
-- rollback has `user_id IS NULL`. An equality join drops NULL automatically, so those rows are
-- HIDDEN rather than shared — the correct failure direction, and recoverable by a forward
-- repair. Asserting it here pins the deliberate consequence so nobody "fixes" it into a
-- `coalesce` or an `is not distinct from` that hands every NULL row to every saver.

insert into public.reel_place_mentions (user_id, reel_cache_id, place_id, evidence_quote,
                                        confidence, verification_version)
values (null, '90000000-0000-0000-0000-000000000002',
        '91000000-0000-0000-0000-000000000002', 'the shrine at dawn', 0.9,
        'mapbox-country-v1');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000a02","role":"authenticated"}', true);
select is(
  (select count(*) from public.places where id = '91000000-0000-0000-0000-000000000002'),
  0::bigint,
  'an unowned mention written by post-rollback old code is hidden, not shared'
);
select is(
  (select jsonb_array_length(places) from public.saved_reel_cards
    where reel_cache_id = '90000000-0000-0000-0000-000000000002'),
  0,
  'an unowned mention does not surface on the saver''s card either'
);
reset role;

select * from finish(true);

rollback;
