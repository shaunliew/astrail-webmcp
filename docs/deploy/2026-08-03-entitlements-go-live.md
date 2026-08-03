# Deploy log — free-trial + beta-seat entitlement arc → production

> **Executed:** 2026-08-03 by Shaun (backend/DB lane) · **Code by:** ZH (built + E2E-verified)
> **Result:** DB migrated, verified, backend live on `dd7b0f3`, env pinned, 4 beta seats granted.
> **Still open:** the landing CTA flip — Zhi Hao's lane, deliberately NOT done here.
> Companion to `docs/deploy/2026-08-03-entitlements-deploy-handoff.md` (the plan); this is what
> actually happened, including where it deviated.

---

## 1. What was applied

Two migrations, to Supabase project `ngfssihvukhxxqhcudix` (**PostgreSQL 17.6.1.127**, ap-southeast-1):

| Order | File | Contents |
|---|---|---|
| 1 | `20260803120000_entitlement_free_trial.sql` | `users.{plan,lifetime_trip_count,seat_requested_at}` · `jobs.{charge_kind,charge_date,charge_refunded_at}` · swap global unique → partial unique index · `reserve_and_enqueue_trip_job` (new) · `complete_trip_run` (extended) |
| 2 | `20260803130000_request_seat.sql` | `request_seat` RPC |

Then `supabase migration repair --status applied 20260803120000 20260803130000`, and
`supabase migration list --linked` confirmed **32 local = 32 remote, zero drift**.

### DEVIATION 1 — apply mechanism (`db query -f`, not `db push`)

The handoff implied `supabase db push`. **That was wrong for this repo**, and the attempt was
correctly refused. `.claude/docs/STACK.md`'s "Schema deployment" row mandates hand-applied,
one-file-at-a-time migrations via `psql -X -1 -v ON_ERROR_STOP=1 -f <file>`, where `-1` makes a
failed migration all-or-nothing. `db push` would have swept every pending file in one batch.

`psql` was not usable: `backend/.env` carries only `SUPABASE_URL` + service-role key (PostgREST,
no DSN), and `supabase/.temp/pooler-url` has **no password** (`postgresql://postgres.<ref>@host`).

Resolution: `supabase db query --linked -f <one file>`. Its single-transaction behaviour was
**proven, not assumed** — two statements in one invocation both reported `txid_current() = 4967`,
`same_transaction = true`. That is the `-1` guarantee, applied to exactly the file named.

Atomicity was load-bearing here: file 1 drops the unique constraint *before* creating the partial
index, so a half-applied file leaves `jobs` with **no uniqueness at all**.

### Pre-flight facts established before writing (all read-only, against prod)

- `complete_trip_run` had exactly **one** `pg_proc` row, signature identical to the new one →
  `create or replace` replaces rather than creating an overload (the highest-risk item).
- `jobs_idempotency_key_unique` was a real UNIQUE **constraint** → droppable.
- 35 jobs / 35 non-null keys / **35 distinct** → the partial unique index could not fail to build.
- Added-column defaults are constants (`'trial'`, `0`) → non-volatile → metadata-only on PG17.
- `user_daily_usage_user_date_unique (user_id, usage_date)` exists → the RPC's `ON CONFLICT` resolves.
- Lock window clear: **0** long transactions, **0** idle-in-transaction, **0** running/pending jobs.

### DEVIATION 2 — the "third pending migration" that wasn't

A review pass claimed `20260802120000_per_account_reel_analysis_limit` was also pending, citing a
comment in `backend/scripts/assert_schema.py` about a live probe finding its column absent.
**Disproven:** `users.daily_reel_analysis_limit` exists on prod (integer, default 5), and the
14:35 gate log named *only* the six entitlement columns. That comment is stale text.
Exactly two migrations were pending. (The claim came from inference, because that reviewer's own
`migration list --linked` had failed — a good reminder to verify a report against the artifact.)

---

## 2. Probe evidence

Raw output: probe suite P1–P10 (scripts + captured output kept with the session; key results below).

| Probe | Result |
|---|---|
| P1 columns | 6/6, correct types/nullability; `plan` default `'trial'::text`, `lifetime_trip_count` default `0`, both NOT NULL |
| P2 CHECKs | `users_plan_check`, `users_lifetime_trip_count_nonnegative`, `jobs_charge_kind_check` — all `convalidated: true` (not NOT VALID) |
| P3 index listing | All 7 indexes on `jobs` enumerated; only `jobs_pkey(id)` and the new partial uidx are unique |
| P4 old uniqueness | `old_constraint_rows=0`, `old_index_rows=0`, `any_unconditional_unique_on_key=0`, `exact_partial_index_rows=1` |
| Predicate | `pg_get_expr(indpred)` → `(charge_refunded_at IS NULL)` — exact, single term, read from the catalog not the name |
| P5 RPCs | All 3 present, **`overload_count=1` each**, `security definer`, `search_path=""`; `anon=false`, `authenticated=false`, `service_role=true` |
| P6 raw ACL | `{postgres=X/postgres,service_role=X/postgres}` — non-null, **no `=X/` PUBLIC entry**, no anon/authenticated row |

### Canaries (all zero-cost: one `DO` block each, closing `raise` rolls the whole thing back)

- **P7 failure path** — `outcome=created charge_kind=lifetime charge_date=2026-08-03 | lifetime 0→1→0 | claimed=t completed=t | job_status=failed refunded_at_set=t | trip_status=failed events=2 || PASS`
- **P9 success path** — `lifetime 0→1→1 (charge STICKS) | job_status=succeeded refunded_at_set=f | trip_status=generating result_events=1 || PASS`
  `trip_status=generating` is **correct**: `complete_trip_run` writes `trips.status` only in the
  failure branch; the runner sets success status separately (`runner.py:529`, before the `:538` call).
- **P10 denial + key reuse** (added after review; **not in the handoff's suite**) —
  `R1=created(c=1) | R2=trial_exhausted trip=NULL job=NULL (c=1) | refund c=0 | R3=created newtrip=t (c=1) | R4=replay same_as_R3=t job=NULL || PASS`
- **Residue after all three:** `canary_jobs=0`, `canary_trips=0`, `jobs=35`, `trips=35`,
  `lifetime_sum=0`, `charged=0`. Nothing persisted.

### COVERAGE BOUNDARY — stated verbatim as the adversarial reviewer required

Do **not** call these verified:

1. ~~`trial_exhausted`~~ and ~~retry-after-refund~~ — **these two were closed by P10** after the
   review flagged them. Everything below remains genuinely uncovered.
2. The beta/`daily` branch (daily reserve, daily refund, `daily_exhausted`, `user_daily_usage`
   upsert) — cold code. All 6 prod users were `trial` at probe time; the beta grant in §4 is the
   first thing that makes this path reachable.
3. `conflict_retry`, the `unique_violation` race handler, and `identity_unavailable` — never executed.
4. **PostgREST integration.** The canaries called the RPCs as SQL under `postgres`. Production calls
   arrive as named-param REST calls under `service_role` via `supabase-py`. `overload_count=1`
   mitigates ambiguity, but no call has traversed that layer. **DB-verified ≠ integration-verified.**
5. Anything cross-transaction. A rolled-back canary is faithful for one sequential caller only.
6. The canaries picked a user with `lifetime_trip_count=0`, which guarantees the reserve succeeds —
   so P7/P9 alone structurally could not detect a broken limit guard. P10 is what covers that.

Two probe defects found by review, neither material: P8's `canary_trips`/`canary_events`
predicates match P7's literals only (P9/P10 residue is caught instead by `canary_jobs LIKE
'canary-%'`, `charged_jobs=0` and `lifetime_sum=0`); and `charge_date = current_date` is
unfalsifiable inside one transaction, so it cannot detect the midnight-drift class it nominally guards.

---

## 3. Rollout

- ZH's push of `dev` had already fired a gated deploy at 14:35 that **aborted at the schema gate**
  (`dep-d9oae7c9v7es73cvtfo0`, `pre_deploy_failed`), naming all six missing columns.
  `/health` returned 200 continuously throughout. **The gate worked exactly as designed — no outage.**
- After migrating: `dep-d9ob3abm8hqs73fuagu0`, commit `dd7b0f3`, **live** in 55s.
  Gate log: `schema gate OK — verified 164 columns across 20 tables` → `Pre-deploy complete!` →
  `Application startup complete.` → `/health` `{"status":"ok"}` HTTP 200.

### The DB-first window (not mentioned in the handoff)

The handoff documents why backend-first is unsafe (503 storm). **DB-first has its own, smaller
window**, which was open between the migration and this deploy: the old container also calls
`complete_trip_run` — that function pre-dates this arc — and the *new* version stamps
`charge_refunded_at` on any failure. The old `enqueue_job` re-read lacks the
`charge_refunded_at is null` filter, so an old-code failure followed by a same-key retry would 500.
It requires a failed generation **plus** a same-key retry; prod had 0 running jobs and 6 team
accounts, and the window was closed by deploying promptly. **Future schema+code arcs should
minimise this gap deliberately, not incidentally.**

---

## 4. Env + beta grant

Pinned on `astrail-backend` (`srv-d976aess728c738pskk0`) via the single-key API endpoint —
never the bulk replace, which would have dropped the six dashboard-only secrets. 9 → 11 vars,
all secrets intact:

`ENTITLEMENTS_ENABLED=true` · `TRIAL_LIFETIME_LIMIT=1` · `DAILY_TRIP_QUOTA=10`

**Order was deliberate:** code first, quota second. Raising the quota *before* `dd7b0f3` was live
would have put pre-entitlement code at 10/day with no lifetime cap — the exact unsafe state the
rollback procedure warns about.

**GOTCHA:** a single-key env-var PUT did **not** trigger a redeploy. Env is read at import in
`backend/rate_limit.py`, so the running process kept `DAILY_TRIP_QUOTA=5` until a restart. Harmless
(more restrictive) but it means **env changes here are not self-applying — always restart and verify.**

Beta grant — 4 accounts, verified 4 matched before and 4 updated after:
`shaunliew20@gmail.com`, `desmondchye321@gmail.com`, `aster@astrail.app`, `telegram-ingest@astrail.xyz`.
Final distribution: **4 beta, 2 trial** (the two `gen-smoke-*` throwaways stay trial).
`telegram-ingest@astrail.xyz` is a service account included as a zero-cost hedge — it runs
organize jobs only and has no trip-generation path today (`backend/telegram_ingest/` has no
`reserve_and_enqueue_trip_job` call site).

---

## 5. `render.yaml` — the Blueprint drift fix (§3A)

`DAILY_TRIP_QUOTA` was declared `"5"` as a literal Blueprint value. A Blueprint **configuration
sync** re-applies literal values and is **not** governed by `autoDeployTrigger`, so a dashboard-only
change to 10 could be reverted to 5 — halving beta capacity with nothing naming the quota as the
cause. Not hypothetical: the 2026-08-02 worker breakage recorded in render.yaml's own `PYTHONPATH`
note is this exact failure mode.

**Resolved by changing the Blueprint to `"10"`**, so Blueprint and dashboard agree.

`ENTITLEMENTS_ENABLED` and `TRIAL_LIFETIME_LIMIT` are deliberately **left undeclared**: Render
*preserves* dashboard env vars a Blueprint omits, so an undeclared key survives a sync — which is
what makes `ENTITLEMENTS_ENABLED` a real rollback lever. A `value: "true"` there would be
re-asserted mid-incident and could undo an in-progress rollback. Their code defaults (`true` / `1`)
independently equal the intended production values.

Cross-model review (Codex `gpt-5.6-sol`, high reasoning): **APPROVE-WITH-CHANGES**. It corrected
three factual errors in the first draft of that comment, all fixed before commit:
a sync does **not** drop omitted vars (Render preserves them); a Blueprint sync **does** redeploy
affected services; and sync triggers on **modifying the Blueprint file**, not on any push to `dev`.

---

## 6. Deferred findings — recorded, deliberately NOT fixed in this deploy

| # | Finding | Why deferred |
|---|---|---|
| D1 | **Rollback is not atomic.** It spans the dashboard flag *and* the Blueprint quota. A sync while overrides are active would re-assert quota 10 while `ENTITLEMENTS_ENABLED=false` routes to the legacy no-lifetime-cap path. Structural fix: have `ENTITLEMENTS_ENABLED=false` force the legacy quota in code, making rollback one flag. | A `rate_limit.py` behaviour change would invalidate the 1341-test verification mid-deploy. Mitigation: do not modify `render.yaml` or manually sync while overrides are active. |
| D2 | **Double-submit returns the wrong outcome.** A trial user double-clicking gets `403 trial_exhausted` while their first trip is still generating — the step-1 replay check is not re-run after the reservation fails. *Accounting stays correct; wrong outcome, not a leak.* Fires at `trial_limit=1` on any genuine double-click. | ~6 lines in both exhaustion branches. Backend change, not a migration. Should be the next task on this arc. |
| D3 | **No `rollback/*_down.sql` for either migration**, and the naive down-path (re-adding the global unique constraint) stops working at the first refund. | Forward-only additive design; rollback is a flag flip, not a schema reversal. But the gap should be written down rather than discovered later. |
| D4 | `assert_schema.py`'s comment about `daily_reel_analysis_limit` being absent from prod is **stale** — the column exists. | Doc touch-up; it misled one review pass in this very deploy. |
| D5 | Tightened CAS in `complete_trip_run` adds a failure mode: a caller passing a mismatched `trip_id` matches zero rows, returns false, and the runner emits nothing → SSE never terminates. Not reachable today (both call sites pass the dispatched `trip_id`). | Latent, unreachable. Worth an assertion if the call sites ever change. |

---

## 7. Rollback (unchanged, memorise the order)

1. Flip the landing CTA back.
2. Set `DAILY_TRIP_QUOTA=5` **and** `ENTITLEMENTS_ENABLED=false`.
3. Restart (env only — **no image swap**; and per §4, a restart is REQUIRED for env to take effect).

Out of order opens a window where the legacy no-lifetime-cap path runs at a 10/day quota.
Do **not** modify `render.yaml` or sync the Blueprint while a rollback is active (D1).

---

## 8. Not done here

**The landing CTA flip remains open. It is Zhi Hao's lane and was deliberately not touched.**
Until it flips, the entitlement arc is live and enforcing on the backend, but the public entry
point still advertises the pre-beta state.

Recommended first live check once the CTA is on: a real trial account generating once, then
attempting a second generation, to prove `trial_exhausted` end-to-end **through PostgREST** —
that is the one layer the canaries could not reach (§2, boundary item 4).
