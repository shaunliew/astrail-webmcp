-- B5(d): `create_saved_reels_organize_job` signals its three rejections by SQLSTATE.
--
-- Every assertion here passes `null` as throws_ok's expected message ON PURPOSE. The message
-- is presentation and must stay free to be reworded; the CODE is the contract Python matches
-- on (`organizer._ORGANIZE_JOB_ERRORS`). Asserting the prose here would rebuild, in SQL, the
-- exact coupling 20260720130000 exists to remove.
--
-- Companion coverage: `backend/test_saved_reels_organize.py` drives each code through a
-- deliberately REWORDED message and asserts the Python outcome is unchanged. This file pins
-- the other half — that real Postgres actually raises these codes for these inputs.
--
-- 007 keeps the behavioral assertions (which requests are rejected, and that a rejection
-- creates no partial job); this file is only about the codes.

begin;

create extension if not exists pgtap with schema extensions;

select plan(7);

insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000a01', 'errcodes-a@example.com'),
  ('00000000-0000-0000-0000-000000000a02', 'errcodes-b@example.com');

select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000a01', 'https://www.instagram.com/reel/ERRCODE-A')$$,
  'fixture: user A saved a reel'
);
select isnt_empty(
  $$select id from public.capture_saved_reel('00000000-0000-0000-0000-000000000a01', 'https://www.instagram.com/reel/ERRCODE-A-2')$$,
  'fixture: user A saved a second reel'
);

-- AS422 — the request itself is malformed. Two distinct branches of the function reach it.
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000a01', '{}'::uuid[], 'errcode-empty'
  )$$,
  'AS422', null,
  'an empty Saved Reel selection raises AS422'
);
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000a01',
    array[
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A'),
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A')
    ]::uuid[],
    'errcode-duplicate'
  )$$,
  'AS422', null,
  'a duplicated Saved Reel id raises AS422'
);

-- AS404 — the caller does not own (or there is no) such Saved Reel.
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000a02',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A')]::uuid[],
    'errcode-cross-owner'
  )$$,
  'AS404', null,
  'a cross-owner Saved Reel selection raises AS404'
);

-- AS409 — a selected Reel is already inside another ACTIVE job.
select ok(
  public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000a01',
    array[(select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A')]::uuid[],
    'errcode-active'
  ) is not null,
  'fixture: an active job now holds the first reel'
);
select throws_ok(
  $$select public.create_saved_reels_organize_job(
    '00000000-0000-0000-0000-000000000a01',
    array[
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A'),
      (select id from public.saved_reels where user_id = '00000000-0000-0000-0000-000000000a01' and normalized_url = 'https://www.instagram.com/reel/ERRCODE-A-2')
    ]::uuid[],
    'errcode-overlap'
  )$$,
  'AS409', null,
  'overlapping an active job raises AS409'
);

select * from finish();

rollback;
