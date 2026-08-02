begin;

create extension if not exists pgtap with schema extensions;

select plan(31);

-- `reserve_organize_item_analysis` is on the LIVE organize path every website user runs. This file
-- exists to prove that making its cap per-account changed nothing for them: the default is still
-- 5, the exactly-once short-circuit is untouched, and the privilege contract still holds.

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000001601', 'limit-default@example.com'),
  ('00000000-0000-0000-0000-000000001602', 'limit-raised@example.com'),
  ('00000000-0000-0000-0000-000000001603', 'limit-shortcircuit@example.com');

insert into public.organize_jobs (id, user_id, idempotency_key, status)
values
  ('95000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001601', 'limit-default', 'processing'),
  ('95000000-0000-0000-0000-000000001602', '00000000-0000-0000-0000-000000001602', 'limit-raised', 'processing'),
  ('95000000-0000-0000-0000-000000001603', '00000000-0000-0000-0000-000000001603', 'limit-shortcircuit', 'processing');

-- One Saved Reel (and so one organize item) per reservation: reserving the SAME item twice
-- short-circuits by design, so a boundary test needs distinct items to charge against.
insert into public.saved_reels (id, user_id, normalized_url)
select
  ('96000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-000000001601',
  'https://www.instagram.com/reel/LIMIT-DEFAULT-' || n
from generate_series(1, 6) as n;

insert into public.saved_reels (id, user_id, normalized_url)
select
  ('97000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-000000001602',
  'https://www.instagram.com/reel/LIMIT-RAISED-' || n
from generate_series(1, 3) as n;

insert into public.saved_reels (id, user_id, normalized_url)
values ('98000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001603',
        'https://www.instagram.com/reel/LIMIT-SHORTCIRCUIT');

insert into public.organize_job_items (id, user_id, job_id, saved_reel_id)
select
  ('94000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-000000001601',
  '95000000-0000-0000-0000-000000001601',
  ('96000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid
from generate_series(1, 6) as n;

insert into public.organize_job_items (id, user_id, job_id, saved_reel_id)
select
  ('93000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid,
  '00000000-0000-0000-0000-000000001602',
  '95000000-0000-0000-0000-000000001602',
  ('97000000-0000-0000-0000-0000000016' || lpad(n::text, 2, '0'))::uuid
from generate_series(1, 3) as n;

insert into public.organize_job_items (id, user_id, job_id, saved_reel_id)
values ('92000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001603',
        '95000000-0000-0000-0000-000000001603', '98000000-0000-0000-0000-000000001601');

-- ── the column itself ─────────────────────────────────────────────────────────────────────────
select has_column('public', 'users', 'daily_reel_analysis_limit', 'accounts carry their own daily Reel-analysis limit');
select is(
  (select pg_get_expr(defaults.adbin, defaults.adrelid)
     from pg_attrdef defaults
     join pg_attribute attributes
       on attributes.attrelid = defaults.adrelid and attributes.attnum = defaults.adnum
    where defaults.adrelid = 'public.users'::regclass
      and attributes.attname = 'daily_reel_analysis_limit'),
  '5',
  'the column default is 5 — every account that predates this migration keeps today''s cap'
);

-- ── the default is 5, proven at the boundary ──────────────────────────────────────────────────
--
-- THE byte-for-byte proof that the live web path is unchanged. A brand-new user (no explicit
-- limit, so the column default) gets exactly five reservations and is refused the sixth. RED if
-- the default changes, and RED if the `coalesce` subquery reads something other than this column.
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001601'), current_date, 'default account: 1st reservation is granted');
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001602', '00000000-0000-0000-0000-000000001601'), current_date, 'default account: 2nd reservation is granted');
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001603', '00000000-0000-0000-0000-000000001601'), current_date, 'default account: 3rd reservation is granted');
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001604', '00000000-0000-0000-0000-000000001601'), current_date, 'default account: 4th reservation is granted');
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001605', '00000000-0000-0000-0000-000000001601'), current_date, 'default account: 5th reservation is granted');
select is(public.reserve_organize_item_analysis('94000000-0000-0000-0000-000000001606', '00000000-0000-0000-0000-000000001601'), null, 'default account: the 6th reservation is refused — the cap is still 5');
select is(
  (select reel_analysis_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001601' and usage_date = current_date),
  5,
  'default account: the refused 6th charged nothing'
);

-- ── a raised limit grants N ───────────────────────────────────────────────────────────────────
--
-- The ingest account's whole reason to exist. Seeded at 5 (the old hard cap) so the three calls
-- below are reservations 6, 7 and 8 — the first two only succeed because the account, not the
-- function, now names the limit.
update public.users set daily_reel_analysis_limit = 7 where id = '00000000-0000-0000-0000-000000001602';
insert into public.user_daily_usage (user_id, usage_date, reel_analysis_count)
values ('00000000-0000-0000-0000-000000001602', current_date, 5);

select is(public.reserve_organize_item_analysis('93000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001602'), current_date, 'raised account: the 6th reservation is granted');
select is(public.reserve_organize_item_analysis('93000000-0000-0000-0000-000000001602', '00000000-0000-0000-0000-000000001602'), current_date, 'raised account: the 7th reservation is granted');
select is(public.reserve_organize_item_analysis('93000000-0000-0000-0000-000000001603', '00000000-0000-0000-0000-000000001602'), null, 'raised account: the 8th reservation is refused at its own limit');
select is(
  (select reel_analysis_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001602' and usage_date = current_date),
  7,
  'raised account: the account limit caps the count at 7, not 5 and not 8'
);

-- ── the exactly-once short-circuit still works ────────────────────────────────────────────────
--
-- RED if the `v_state in ('reserved', 'consumed')` early return is disturbed by the rewrite.
select is(public.reserve_organize_item_analysis('92000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001603'), current_date, 'short-circuit: the first reservation is granted');
select is(public.reserve_organize_item_analysis('92000000-0000-0000-0000-000000001601', '00000000-0000-0000-0000-000000001603'), current_date, 'short-circuit: retrying the same item returns the same date');
select is(
  (select reel_analysis_count from public.user_daily_usage
    where user_id = '00000000-0000-0000-0000-000000001603' and usage_date = current_date),
  1,
  'short-circuit: retrying the same item does not double charge'
);

-- ── the coalesce fallback ─────────────────────────────────────────────────────────────────────
--
-- The plan asks for a call whose p_user_id has NO public.users row. That case is FK-unreachable in
-- both directions, asserted below rather than asserted around: organize_job_items.user_id reaches
-- public.users through organize_jobs, and user_daily_usage.user_id references it directly. Nothing
-- is dropped to manufacture the case; it is pinned as unreachable, and the fallback is proven the
-- two ways that remain — the predicate text (RED the moment the coalesce is removed) and the
-- expression's own semantics.
select ok(
  position(
    'coalesce((select u.daily_reel_analysis_limit from public.users u where u.id = p_user_id), 5)'
    in regexp_replace(
         lower(pg_get_functiondef(to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)'))),
         '\s+', ' ', 'g')
  ) > 0,
  'the limit lookup keeps its 5 fallback — an ownerless caller must not be told "quota reached"'
);
select is(
  (select coalesce((select u.daily_reel_analysis_limit from public.users u
                     where u.id = '00000000-0000-0000-0000-0000000016ff'), 5)),
  5,
  'the fallback expression yields the historical 5 for a user id with no public.users row'
);
select throws_ok(
  $$insert into public.organize_jobs (user_id, idempotency_key) values ('00000000-0000-0000-0000-0000000016ff', 'ownerless')$$,
  '23503', null,
  'an organize job cannot exist for a user with no public.users row — the item side is unreachable'
);
select throws_ok(
  $$insert into public.user_daily_usage (user_id, usage_date, reel_analysis_count) values ('00000000-0000-0000-0000-0000000016ff', current_date, 1)$$,
  '23503', null,
  'daily usage cannot exist for a user with no public.users row — the usage side is unreachable too'
);

-- ── the privilege contract ────────────────────────────────────────────────────────────────────
--
-- `create or replace` preserves all four of these, which is exactly why they are asserted: a
-- future edit that drops one would otherwise be silent.
select ok(
  (select prosecdef from pg_proc where oid = to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)')),
  'the reservation RPC is still security definer'
);
select ok(
  (select proconfig from pg_proc where oid = to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)'))
    @> array['search_path=""'],
  'the reservation RPC still pins an empty search_path'
);
select ok(
  not has_function_privilege('authenticated', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'authenticated still cannot reserve an organize item analysis'
);
select ok(
  not has_function_privilege('anon', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'anon still cannot reserve an organize item analysis'
);
select ok(
  has_function_privilege('service_role', 'public.reserve_organize_item_analysis(uuid,uuid)', 'EXECUTE'),
  'service role can still reserve an organize item analysis'
);

-- ── the CHECK constraint bites ────────────────────────────────────────────────────────────────
select throws_ok(
  $$update public.users set daily_reel_analysis_limit = 0 where id = '00000000-0000-0000-0000-000000001603'$$,
  '23514', null,
  'a zero limit is rejected — an account cannot be silently frozen out'
);
select throws_ok(
  $$update public.users set daily_reel_analysis_limit = 10001 where id = '00000000-0000-0000-0000-000000001603'$$,
  '23514', null,
  'a limit above 10000 is rejected'
);
select lives_ok(
  $$update public.users set daily_reel_analysis_limit = 1 where id = '00000000-0000-0000-0000-000000001603'$$,
  '1 is inside the allowed range'
);
select lives_ok(
  $$update public.users set daily_reel_analysis_limit = 10000 where id = '00000000-0000-0000-0000-000000001603'$$,
  '10000 is inside the allowed range'
);

-- ── the signature did not change ──────────────────────────────────────────────────────────────
--
-- The whole reason the limit is a column and not a third parameter. A 3-arg "fix" would be an
-- OVERLOAD, PostgREST would report "function is not unique", and the only way out would be a drop
-- — a PGRST202 window on the live organize path. This pair is what catches that edit.
select ok(
  to_regprocedure('public.reserve_organize_item_analysis(uuid,uuid)') is not null,
  'the 2-arg reservation RPC PostgREST resolves is still there'
);
select is(
  (select count(*)::integer
     from pg_proc
     join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
    where pg_namespace.nspname = 'public'
      and pg_proc.proname = 'reserve_organize_item_analysis'),
  1,
  'exactly one reserve_organize_item_analysis exists — no overload was created'
);

select * from finish();

rollback;
