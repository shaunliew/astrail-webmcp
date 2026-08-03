# Deploy handoff — Free-trial + beta-seat entitlement arc → Shaun

> **From:** ZH session (built + E2E-verified 2026-08-03) · **To:** Shaun (owns Render + prod DB)
> **Status:** merged to `dev` locally, **NOT pushed**. Fully green (backend 1341 pass, frontend 407).
> **This is a DB-first, manual-order deploy.** `dev` is the prod backend branch — pushing it *is* the ship.

---

## TL;DR (what you need to do)

1. **Apply both migrations to the prod DB FIRST**, then run the **probe suite** (§4). Backend-first = a
   503 storm (§5).
2. Only then let the backend roll out (push `dev` / trigger a redeploy). The pre-deploy schema gate
   now guards the entitlement columns, so a rollout against an un-migrated DB **aborts cleanly** (old
   code keeps serving) — a backstop, not a substitute for the probes.
3. Pin env, run the beta-grant SQL, flip the landing CTA — in that order (§3).
4. Rollback if needed is a **flag flip**, no redeploy (§6).

---

## 1. What this ships (context)

Makes the open-beta landing's *"25 seats / 1 free trip"* claim real.

- **Trial** = **1 lifetime generation per account**. A 2nd attempt is pre-empted by a card and the
  backend returns **403 `trial_exhausted`**.
- **Beta** = **25 manually-granted seats**, riding the **daily quota** (retuned `5 → 10`/day). Over the
  cap → **429 `rate_limited`**.
- **Request a seat** → stamps `users.seat_requested_at` (idempotent).

**Core invariant:** *a charge exists iff a durable job records it* — the charge lives ON the `jobs` row
(`charge_kind` / `charge_date` / `charge_refunded_at`). Two atomic RPCs enforce it:
- `reserve_and_enqueue_trip_job(...)` — entitlement reservation **+** trip **+** create_trip event **+**
  job insert in ONE transaction (a charge can never precede a job).
- `complete_trip_run(...)` (extended) — on the **leased failure path** its CAS is the sole terminal
  writer: `jobs.status='failed'` + `trips.status='failed'` + counter **refund** + `charge_refunded_at`
  + terminal `result` event, all fenced on `id + lease_token + status='running'`.

Retry-after-refund works via a **partial unique index**
`jobs_idempotency_key_active_uidx WHERE charge_refunded_at IS NULL` (replaces the old global
`jobs_idempotency_key_unique`) — a refunded key is freed for a fresh attempt.

**Rollback is a flag, not an image swap:** `ENTITLEMENTS_ENABLED=false` routes to a retained legacy
daily-quota path (no lifetime cap). Both paths ship in the one image.

## 2. What's in the merge

- **Migrations** (`supabase/migrations/`): `20260803120000_entitlement_free_trial.sql` (users/jobs
  columns, partial index, `reserve_and_enqueue_trip_job`, extended `complete_trip_run`) then
  `20260803130000_request_seat.sql` (`request_seat`).
- **pgTAP**: `supabase/tests/017_entitlement_rpcs.sql`, `018_request_seat.sql`.
- **Backend**: `rate_limit.py` (wrapper + `ENTITLEMENTS_ENABLED`/`TRIAL_LIFETIME_LIMIT`), `main.py`
  (`generate_trip` on the RPC + retained `_generate_trip_legacy`), `api/errors.py` (structured
  dict-detail), `pipeline/runner.py` (`_fail` fences the leased path), `POST /request-seat`.
- **Frontend**: `useEntitlement` hook + `TrialExhaustedCard`, wired into both generate flows;
  `ApiError` + type mirrors.
- **Deploy gate**: `backend/scripts/assert_schema.py` REQUIRED_SCHEMA extended with the new
  `jobs.charge_*` and `users.{plan,lifetime_trip_count,seat_requested_at}` columns (commit `2c11f3b`) —
  so the pre-deploy probe guards them. Validated: gate tests 25 pass; live probe vs migrated local DB
  OK (164 cols / 20 tables).

Commits: merge `f1d12f3` (16 entitlement commits `7154f00`…`7778791`) + manifest hardening `2c11f3b`.

## 3. Deploy order (DB-first — REQUIRED)

```
1. Apply BOTH migrations to prod DB  ─┐
2. Run the probe suite (§4)           ├─ do these BEFORE any backend rollout
   (columns · index predicate · RPC grants · canary)
3. Let the backend roll out (push dev / redeploy) — gate passes because columns now exist.
   Pin env:  ENTITLEMENTS_ENABLED=true   TRIAL_LIFETIME_LIMIT=1   DAILY_TRIP_QUOTA=10
4. Founders/demo beta grant:  update public.users set plan='beta' where email in (...);
5. Flip the zh landing CTA LAST.
```

**How the code reaches you:** ZH's local `dev` is 18 commits ahead and not pushed. When ZH pushes
`dev`, the gated backend rollout will **abort** (columns absent) and old code keeps serving — safe, no
outage — so you can push first and migrate second if you prefer. The frontend (Vercel) fail-opens if
the columns are absent (shows Generate, no gate) — also safe.

## 4. Probe suite (run against prod DB after migrating, before the backend rollout)

```sql
-- columns + constraints present
select column_name from information_schema.columns
 where table_name='users' and column_name in ('plan','lifetime_trip_count','seat_requested_at');   -- 3 rows
select column_name from information_schema.columns
 where table_name='jobs' and column_name in ('charge_kind','charge_date','charge_refunded_at');     -- 3 rows

-- OLD global unique GONE, partial index present with EXACT predicate
select indexname, pg_get_indexdef(indexrelid) from pg_indexes
  join pg_class c on c.relname=indexname
 where tablename='jobs' and indexname like '%idempotency%';
-- expect: jobs_idempotency_key_active_uidx ... WHERE (charge_refunded_at IS NULL); and NO jobs_idempotency_key_unique

-- all 3 RPCs present, EXECUTE revoked from PUBLIC/anon/authenticated (service_role only)
select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_exec
  from pg_proc p cross join (values ('anon'),('authenticated'),('service_role')) r(rolname)
 where p.proname in ('reserve_and_enqueue_trip_job','complete_trip_run','request_seat');
-- expect can_exec = true ONLY for service_role
```

**Zero-cost transactional canary** (reserve → claim → fail → assert refund, then ROLLBACK — no Apify/
OpenAI spend). Replace `:canary_user` with a **fresh trial user id** (`plan='trial'`,
`lifetime_trip_count=0`, else reserve returns `trial_exhausted`) and `:key` with any unique string:

```sql
do $$
declare v_lease uuid := gen_random_uuid();
        v_trip uuid; v_job uuid; v_before int;
begin
  select generated_trip_count into v_before from public.user_daily_usage
    where user_id = :canary_user and usage_date = current_date;
  select trip_id, job_id into v_trip, v_job
    from public.reserve_and_enqueue_trip_job(:canary_user, :key, null,'2026-08-10','2026-08-13',
         'mid_range','Singapore','pref','{}'::jsonb,'{}'::jsonb, 1, 10);   -- 'created', counter +1
  perform public.claim_trip_job(v_job, v_lease, 300);                       -- pending->running (assert true)
  perform public.complete_trip_run(v_job, v_trip, v_lease,'failed','save','canary','{}'::jsonb); -- refund
  raise exception 'canary rollback';   -- ROLLBACK: no rows persist
end $$;
```
(`claim_trip_job` = `supabase/migrations/20260720170000_db_clock_job_leases.sql`. It's required because
a freshly-reserved job is `pending`/no-lease, so the `complete_trip_run` CAS would no-op without it.)

## 5. Why backend-first is unsafe

With `ENTITLEMENTS_ENABLED=true` (the default) **every** generate path calls
`reserve_and_enqueue_trip_job`. If the RPC isn't in prod yet → PGRST202 → the wrapper **fail-closes**
→ **503 on every generation.** The schema gate (`assert_schema.py`) is the backstop, but it **sees
columns only** — it cannot see RPC signatures or the index swap — so treat it as a safety net, not a
green light. Run the §4 probes.

## 6. Rollback (flag flip, no redeploy)

Ordered, three moves:
1. Flip the zh landing CTA back.
2. Set `DAILY_TRIP_QUOTA=5` **and** `ENTITLEMENTS_ENABLED=false`.
3. Restart (env change only — **no image swap**).

Out of order opens a window where the legacy path (no lifetime cap) runs at a 10/day quota. The
migration stays (additive columns + partial index; no data reversal) — the legacy `generate_trip`
path's idempotency lookups are `.is_(charge_refunded_at,null)`-filtered, so a refunded+active same-key
pair does **not** 500 (we tested this live, §7-C).

## 7. E2E verification already done (your confidence baseline)

Verified 2026-08-03 against real local Postgres + live stack (backend flag-on, `supabase start`, Next,
mock-auth off), one ZH-approved real reel generation:

- **A** — exhausted trial → **403** (no phantom charge); request-seat **idempotent**; beta count=99 →
  **200** `charge_kind=daily` (bypasses lifetime); daily=10 → **429**.
- **A happy path (browser, real reel)** → generate succeeded, **`lifetime_trip_count=1`,
  `charge_kind=lifetime`, `charge_refunded_at` NULL** (charge sticks on success); re-entry → the
  `TrialExhaustedCard` **renders in place of Generate**; Request-a-seat stamped `seat_requested_at`.
- **B** — forced failure → **refund** (count→0, job failed+refunded, trip failed); **same-key retry →
  fresh job** (partial index freed the key). Both trial + daily lanes.
- **C** — `ENTITLEMENTS_ENABLED=false` → exhausted trial **200** (no lifetime cap); **refunded+active
  same-key → clean 200 replay, no 500.**

**Note on entry points:** in prod (mock-auth off) the user-reachable flow is **SavedReelsFlow**;
`CreateTripFlow` is mock-auth-only (dev), so its gate is wired + unit-tested but not the prod path.

## 8. References

- Full plan (design + Codex review log): `docs/superpowers/plans/2026-08-02-free-trial-beta-seats.md`
  (`## Deploy order + rollback`, `## E2E verification`).
- render.yaml deploy-gate rationale: header comment on the `astrail-backend` service.
- Env docs: `.claude/docs/ENV.md`. Architecture: `.claude/docs/ARCHITECTURE.md` (Entitlement ledger).
