# Plan — Free trial + beta seats (entitlement arc)

**Date:** 2026-08-02 · **Rev 6, 2026-08-03** (closes the 4-item punch-list from Codex r5 — climb
r1 4/10 → r2 5/10 → r3 6/10 → r4 7/10 → r5 7/10 "Safety 4→6, architectural core reconfirmed a 4th
time, zero regressions"; Codex forecast these 4 → ≥8/10; reports `scratchpad/codex-r*-review.out`;
full history in `## Codex review log`) · **Branch:** `entitlements` off `dev`
· **Owner / implementer:** Zhi Hao, full-stack, in a **fresh implementation session** (NOT Shaun —
this is now Zhi Hao's build). The plan is written to be self-contained for that session: read it top
to bottom, then implement task-by-task. **This design has passed 4 consecutive Codex architectural
validations — the review loop is CLOSED; Rev 6 is the build spec.**
**Type:** Full-stack — one migration + backend enforcement + frontend UX. **No SSE contract
change** (rejection is an HTTP error before the stream). Landing CTA flip is a follow-up on `zh`,
flag-gated until this arc is deployed. **Verification bar: a real end-to-end test** (see `## E2E
verification`) drives the full trial→exhausted→seat→beta flow against a live stack — not just unit/pgTAP.

## What changed in Rev 6 (final precision pass; build-ready)

Codex r5 reconfirmed the core a 4th time and blocked only on 4 mechanical items (its own forecast:
these reach ≥8/10). All folded in:

1. **[HIGH] `_generate_trip_legacy` is now fully specified** (§Backend) — real body, `background:
   BackgroundTasks` param, and the `.is_("charge_refunded_at","null")` filter on its **direct replay
   lookup** (the 3rd idempotency lookup, `main.py:373`, previously the only unfiltered one). No more
   hand-wave; the rollback path is a concrete, partial-index-safe function.
2. **[HIGH] The two-session race test barrier is now deterministic** (§tests) — a **third autocommit
   observer connection** (Postgres caches the stat snapshot inside a txn), `pg_blocking_pids()`
   verification that session-1 is the specific blocker, and all fixture seeds committed BEFORE the
   winner-insert txn.
3. **[MED] The adversarial-timestamp case is folded into that two-session test** (it can't run
   single-session — an active row short-circuits to `replay`, only-refunded rows return `created`).
4. **[MED] The canary's lease SQL is corrected** — one declared `v_lease uuid`, reused positionally
   in both RPC calls, with the counter snapshotted in-txn for a deterministic 0→1→0.

(LOW, non-blocking per Codex: a mismatched `p_trip_id` returns `false` = looks like supersession;
keep the `won=false` log.)

## What changed in Rev 5 (precision fixes; the design is settled)

Codex r4 reconfirmed the architectural core and blocked only on implementation precision — two of
which were Rev 4's own mistakes. The seven changes, keyed to r4's findings:

1. **[HIGH] Fix 1 was backwards → reverted.** The collision re-read is **filtered active-only again**
   (`and charge_refunded_at is null`) so it returns the ACTIVE winner, never a refunded/failed trip
   (which the workspace can't resume — it only shows "Generation failed / Plan a new trip"). If no
   active row remains → `conflict_retry` (409). A test seeds a refunded row with a LATER `created_at`
   than the active winner to prove ordering can't pick the wrong trip.
2. **[HIGH] `.is_()` not `.eq(None)`.** `.eq("charge_refunded_at", None)` builds `eq.None`, not
   `IS NULL`, in the installed PostgREST client — the active-only filters use
   `.is_("charge_refunded_at", "null")` (the form the repo already uses in `backfill_reel_covers.py:77`).
3. **[HIGH] Real, coherent rollback: an `ENTITLEMENTS_ENABLED` flag, no image swap.** The arc ships
   **both** paths — the new RPC path and the retained legacy daily-quota path — gated by
   `ENTITLEMENTS_ENABLED` (default `true`). Rollback = set `ENTITLEMENTS_ENABLED=false` (routes to the
   legacy path, whose idempotency lookups are partial-index-safe via #2) + `DAILY_TRIP_QUOTA=5` +
   landing flag off. No redeploy, and it's a tested branch — the "pinned build" hand-wave is gone.
4. **[HIGH] Deterministic two-session test.** Adds a `pg_stat_activity` **barrier** (poll until
   session-2 is blocked on the lock before committing session-1), bounded `statement_timeout` +
   orchestration timeout, a **declared DB driver** (`psycopg[binary]` added to `backend/pyproject.toml`
   dev deps), a direct non-pooled connection, and an explicit winner seed (charge metadata AND counter
   both = 1).
5. **[MED] Canary claims a lease first.** A freshly reserved job is `pending`/no-lease, so the r4
   canary's `complete_trip_run` CAS would no-op; Rev 5 inserts `claim_trip_job(v_job_id, v_lease, 300)`
   before the fail step so the refund actually exercises (counter 0→1→0).
6. **[MED] `complete_trip_run` rejects a mismatched `p_trip_id`.** `and trip_id = p_trip_id` is added
   to the CAS predicate — a caller passing the wrong trip gets a clean `false` (no silent write to the
   other trip), and the RETURNING'd `v_trip_id` (now provably == `p_trip_id`) still drives the writes.
7. **[LOW] `conflict_retry` gets explicit tests** — a backend endpoint (RPC → 409) + a shared FE
   classifier/API test (both flows display the structured retry message).

## What changed in Rev 4 (targeted fixes on a validated design)

Codex r3 confirmed the atomic-ledger core (no double-charge, no double-refund, no CAS-loser writes)
and blocked only on a tight cluster around the same-key race, its tests, and rollback compat. Rev 4
is fixes, not a redesign. The nine changes, keyed to r3's findings:

1. **[HIGH] No more `replay`-with-NULL.** The `unique_violation` branch re-reads the conflicting
   trip **unfiltered by refund state** (a post-collision row with that key always exists), so it can
   never return `('replay', NULL, …)`. A pathological empty re-read returns a distinct
   `conflict_retry` outcome (→ 409), never NULL.
2. **[HIGH] Narrowed exception.** The handler catches **only** `jobs_idempotency_key_active_uidx`
   (via `GET STACKED DIAGNOSTICS … CONSTRAINT_NAME`) and re-raises every other
   `unique_violation` — no more swallowing an unrelated constraint error.
3. **[HIGH] Real concurrency tests.** The load-bearing undo branch gets **deterministic two-session
   DB tests** (uncommitted-insert → commit → forced collision), not the Rev 3 pgTAP that returned
   `replay` at step 1 and never reached the branch. Plus fault tests (uncaught reserve error rolls
   back the reservation; result-event failure rolls back the whole terminal CAS+refund).
4. **[HIGH] Rollback compat, honestly.** The partial index breaks **any** unfiltered idempotency
   lookup (forward too, not just on rollback): this PR adds `charge_refunded_at is null` filters to
   `enqueue_job`'s 23505 re-read and `live_run.py`'s replay, and the rollback target is a **pinned
   build carrying those same filters**, not the literal pre-arc image. Rev 3's "one-request 500"
   claim was wrong — it was a persistent per-key outage; corrected in Deploy.
5. **[MED] Fenced path writes nothing unfenced.** `_fail` no longer writes the pre-CAS `error`
   event on the leased path — so "a superseded worker writes nothing" is now literally true. The
   error detail still rides the fenced terminal `result` event's payload.
6. **[MED] `complete_trip_run` trusts the fenced row.** Terminal trip+event writes use the
   `trip_id` **returned by the CAS**, not the caller's `p_trip_id`.
7. **[MED] Real schema parity.** A backend `RequestSeatResponse` Pydantic + endpoint `response_model`
   (not just the TS type); jobs charge columns are declared **backend-only** (no row mirror).
8. **[MED] Stronger probes.** Assert the OLD global unique is **gone**, the new index predicate is
   exactly `charge_refunded_at IS NULL`, `PUBLIC` also lacks EXECUTE, and add a zero-cost
   transactional canary (reserve → replay → fail-refund, then ROLLBACK).
9. **[MED, pre-existing] `enqueue_job` is not dead** (live_run uses it — filtered in #4), and
   `compute_idempotency_key` now folds in `budget_level`, request `origin_city`, and
   `requested_places` so distinct requests stop colliding/replaying each other.

## What changed in Rev 3 (the atomic-ledger pivot)

Codex r2 kept two dimensions at 🚩 (Correctness 3/10, Safety 3/10) because Rev 2 orchestrated
`charge → trip → event → enqueue` as **separate steps in Python** with a bolt-on "pre-dispatch
refund reconciliation" — leaving a crash window (charge with no durable job), a cross-statement
midnight drift, an unfenced terminal failure, and a retry-after-refund that the global unique
key rejected. Rev 3 folds findings 1–4 into **one idea**: *the jobs row IS the charge ledger,
and every charge/refund happens in the SAME transaction as the job's create/terminate.*

- **Reserve = enqueue.** A single RPC `reserve_and_enqueue_trip_job` does entitlement reservation
  **+** trip insert **+** `create_trip` event **+** job insert in one transaction. RPC commits ⇒
  charge and durable job both exist; RPC aborts ⇒ neither. The whole "pre-dispatch reconciliation"
  from Rev 2 is **deleted** — there is no charge-then-enqueue window left to reconcile.
- **Fail = refund.** We extend the **already-existing** `complete_trip_run` RPC (not the mythical
  new one Rev 2 described) so its failure branch owns *every* terminal effect — the lease CAS,
  `trips.status='failed'`, the counter refund keyed by the job's stored charge metadata,
  `charge_refunded_at`, and the terminal result event — in one transaction. A superseded worker's
  CAS loses and writes nothing.
- **Charge date is recorded in the reservation transaction**, so it is provably the same date the
  counter was incremented (kills the midnight drift — no second `current_date` read later).
- **Retryable-after-refund** via a partial unique index `where charge_refunded_at is null`, so a
  refunded failure frees its idempotency key for a fresh attempt.

Net: 3 standalone RPCs (Rev 2) → **2 atomic RPCs** (one new, one extended); the Python handler
shrinks to "call RPC, map outcome"; recovery (unchanged) is the only crash safety-net needed and
it already works because the `create_trip` event is written inside the reservation transaction.

## Why

GTM pivot (ZH, 2026-08-02): the waitlist gates the proof our product-first landing exists to give.
Replace it with an open free trial — anyone can sign up and generate **one** real trip — while the
25 self-funded **beta seats** become the scarce thing: continued (daily-capped) generation. Wallet
exposure stays bounded: `signups × 1 generation` (~$0.15–0.35 worst case each), and the upsell
moment fires in-app at peak intent. Seat selection shifts from cold waitlist names to observed
activation.

## Decisions from the interview (2026-08-02, ZH) — unchanged

- **Trial = exactly 1 lifetime generation per account.** Viewing/editing the trip stays free
  forever. Failed runs refund the trial (exactly once — enforced by the lease CAS, see Design).
- **No new save caps.** Reel saves keep the existing burst limit. Defer a lifetime save cap
  (trigger: Apify cost visibly climbing).
- **25 seats, free, granted manually by ZH** (service-role SQL). "Unlimited" rides the existing
  daily quota (retune env `DAILY_TRIP_QUOTA=5 → 10` at deploy — atomic + enforced,
  `backend/rate_limit.py:32`).
- **Request-a-seat = one-click in-app** via backend endpoint (users table keeps NO client UPDATE
  policy; entitlement fields are service-role-write-only).
- **Waitlist fully replaced**, flag-gated on `zh` until this arc is live.

## Decisions carried / added (resolving Codex findings)

- **Uniqueness model (r2-F2):** keep the deterministic request-hash idempotency key; replace the
  **global** unique constraint with a **partial** unique index excluding refunded attempts. A
  `failed`⇒`refunded` job is invisible to both the index and the replay lookup, so the same input
  can be retried. Considered and rejected: an idempotency-key "tombstone rekey" (cleaner rollback
  but mutates a hash column and reads as a smell) and base-key+attempt-number (more schema). The
  partial index is the standard soft-delete-unique pattern; its one rollback caveat is documented
  in Deploy.
- **Grandfathering (r1-F4):** pre-launch, `public.users` holds only team/test accounts (founders +
  `aster@astrail.app`), all set `plan='beta'` in post-deploy grant SQL. **No backfill** — stated
  policy. Pre-arc `jobs` rows have `charge_kind IS NULL`; a terminal failure on such a row sets
  `charge_refunded_at` (freeing its key) but decrements no counter — there was no arc charge to
  refund. Harmless and tested.
- **Concurrent first-requests (r2, accepted):** two racing **same-key** first-POSTs → the RPC's
  savepoint + unique-violation branch means exactly one charges and creates the job; the loser
  undoes its reservation inside the RPC and returns `replay` (beta) or, for a trial user at limit
  1, the loser is rejected at reservation and gets `trial_exhausted` (rare, self-heals — accepted
  by ZH & Codex). Test pins: never more than ONE net charge.
- **Missing `users` row (r1-F5):** an authed request whose `public.users` row is absent (the auth
  trigger normally creates it) → the RPC returns `identity_unavailable` → 503. Never
  `trial_exhausted`, never a silent default.
- **Deploy order (r1-F2):** DB-first REQUIRED. Rollback is **ordered** (r2-F6): landing flag off →
  restore `DAILY_TRIP_QUOTA=5` → redeploy old backend. See Deploy.

## Facts from the verified seam scout (Rev 3 — corrects Rev 2's line numbers)

Rev 2 cited several wrong seams; these are re-verified verbatim against the current tree:

- **`generate_trip` is `backend/main.py:358-479`** (Rev 2 said 236-357 — that's inside
  `/readiness`). Order: compute key `:369-371` → replay lookup by `idempotency_key` only,
  `.maybe_single()`, **before** quota `:373-379` → `check_and_increment_daily_quota` `:381-384`
  (429) → `try:` profile → `trips` insert (status `generating`) `:391-407` → `record_event`
  `create_trip` `:408-428` → `enqueue_job` `:429` → `except:` mark trip failed + best-effort
  `refund_daily_quota` + 500 `:430-457` → lost-idempotency-race branch (refund + delete orphan +
  redirect) `:459-467` → `background.add_task(run_generation, …)` `:469-478`.
- **Recovery re-dispatch is `_redispatch` at `backend/main.py:557-577`** (Rev 2 said 431 — a
  comment). It reconstructs run inputs from the persisted `create_trip` generation-event payload
  (queried by `trip_id` + `stage='create_trip'`), fed by `reclaim_expired_jobs` (pending+retryable)
  at boot `:127-130` and a periodic sweep `:155-158`. Inputs replayed: `reel_urls`, dates, `pace`,
  `preferences`, `destination_hint`, `place_ids`. **This is why the `create_trip` event MUST be
  written in the reservation transaction** — recovery has no other input source.
- **`complete_trip_run` ALREADY EXISTS** (`supabase/migrations/20260720090000_job_leases.sql:99-126`),
  `security definer set search_path=''`, and its CAS is **exactly** `where id = p_job_id and
  lease_token = p_lease_token and status = 'running'` (`:111`) → `if not found then return false`.
  It performs two terminal effects today: `update jobs set status, completed_at` + `insert
  generation_events (event_type='result', …)`. It does **not** touch `trips.status`. Signature:
  `(p_job_id uuid, p_trip_id uuid, p_lease_token uuid, p_status text, p_stage text, p_message text,
  p_payload jsonb) returns boolean`. **This is the CAS Codex wanted** — Rev 2's "copy
  `mark_job_done`'s predicate" was the bug, because Python `mark_job_done` (`backend/jobs.py:106-121`)
  deliberately has **no** `status='running'` guard. Rev 3 extends `complete_trip_run`, not
  `mark_job_done`. The runner's terminal path already calls it via `_complete_trip_run`
  (`backend/pipeline/runner.py:49-67`); success at `:526`, failure inside `_fail` at `:167`.
- **`_fail()` is `backend/pipeline/runner.py:125-173`.** `superseded = lease_lost is not None and
  lease_lost.is_set()` (`:146`) → skips the unfenced `error` event + `_set_status(failed)`. For
  `job_id` + `lease_token` present it calls `_complete_trip_run(status="failed", …)` (`:167-172`).
  **Confirmed: NO refund call site anywhere in the pipeline** — refunds today live only in
  `generate_trip`. This is the bug this arc fixes.
- **Daily quota RPCs** (`supabase/migrations/20260707120000_daily_trip_quota_rpc.sql`):
  `increment_daily_trip_usage(p_user_id uuid, p_limit int) returns int` — WHERE-gated
  `on conflict … do update … where u.generated_trip_count < p_limit`, **returns the count, NOT the
  usage_date** (this is why Rev 2's "return usage_date" was a change, not a fact — Rev 3 avoids the
  need by recording `charge_date` in the reservation txn). Twin
  `decrement_daily_trip_usage(p_user_id uuid, p_usage_date date default current_date) returns int`.
  Both `security definer set search_path=''`, revoked from public/anon/authenticated, granted to
  `service_role`.
- **`user_daily_usage`** is defined in `20260701131304_identity_persona_foundation.sql:130-149`
  (NOT the quota-RPC migration): synthetic `id` PK + `constraint user_daily_usage_user_date_unique
  unique (user_id, usage_date)`, `generated_trip_count integer not null default 0`, `updated_at`
  trigger. RLS SELECT-own only.
- **`jobs`** (`20260701151718_trip_job_backbone.sql:32-49`): columns incl. `idempotency_key text
  not null`, `status text` CHECK `in ('pending','running','succeeded','failed','retryable','cancelled')`,
  `attempt_count`, `locked_at/started_at/completed_at`, `error_message`; FK `(trip_id,user_id) →
  trips(id,user_id)`. **`constraint jobs_idempotency_key_unique unique (idempotency_key)` at `:46`
  is a GLOBAL unconditional unique** (not partial). Lease columns `lease_token uuid`,
  `lock_expires_at timestamptz` added by `20260720090000:4-6` (NB: `lock_expires_at`, not
  `lease_expires_at`).
- **`trips`** (`20260701151718:1-26`): the `generate_trip` insert sets exactly 9 columns —
  `user_id, status, destination_hint, start_date, end_date, budget_level, origin_city,
  preference_summary, preference_sources`; everything else uses table defaults. `trips_status_check`
  allows `draft/generating/places_ready/complete/saved_with_gaps/failed`.
- **`compute_idempotency_key`** (`backend/jobs.py:45-63`): SHA-256 of
  `[user_id, sorted(reel_urls), sorted(place_ids), start_date, end_date, preferences.strip(), pace,
  destination_hint]` — a hash of the request, already includes `user_id`; **no attempt discriminator**.
- **`enqueue_job`** (`backend/jobs.py:66-82`): plain insert, catches `23505`, re-reads existing by
  `idempotency_key` via `.maybe_single()`. After Rev 3 the `created` path no longer calls it (the
  RPC inserts the job) — `enqueue_job` and `check_and_increment_daily_quota`/`refund_daily_quota`
  become dead for trip generation; leave in place (harmless, still unit-tested), deprecate later.
- **`public.users`** (`20260701131304:18-29`): has `email text` (nullable) and already
  `beta_status text not null default 'active'` CHECK `in ('active','waitlisted','disabled')` — a
  **different axis** (account standing) than entitlement tier, wired to nothing; Rev 3 leaves it
  untouched and adds `plan`. RLS: **only `users_select_own` (SELECT); no authenticated UPDATE**
  (`:180-184`). Auth trigger populates rows and does **not** set `beta_status`.
- **Error envelope** `build_error_response(status, message, code=None) → {"error":{"code","message"}}`
  (`backend/api/errors.py:40-44`); the HTTPException handler does `str(exc.detail)` **unconditionally**
  (`:48`) — a dict detail is stringified today, so Rev 3 must add a dict branch.
- **Frontend**: `frontend/lib/trip/api.ts:24-25` throws a plain `Error("generate-trip failed: <status>
  <raw text>")` — does NOT parse the envelope. `listTrips()` (`frontend/lib/trip/supabase-api.ts:97-104`)
  reads own trips via RLS, ordered `created_at desc`, returns `Trip[]`. Generate call sites:
  `CreateTripFlow.tsx:66`, `SavedReelsFlow.tsx:217`; `PlanSheet.tsx` is presentational (`onGenerate`
  prop, button `:218`) — it does NOT POST.

## Non-goals (defer, with triggers) — unchanged

- **Landing CTA flip** (`zh`): trigger = this arc deployed + migration applied. Rollback also
  reverts this flag.
- **Live seat counter**: trigger = first seats granted. · **Lifetime save cap**: trigger = Apify
  cost signal. · **Admin UI**: manual SQL until >~10 requests/week.
- **`beta_status` cleanup / success-path `trips.status` fencing**: pre-existing; a superseded
  *success* worker's unfenced `_set_status('complete')` could still clobber — out of scope; fold
  into `complete_trip_run` via a `p_trip_status` param in a later hardening pass. · **Payments**: banned.

## Guardrail check

- **#4 Schema parity:** migration + `backend/api/schemas.py` (if any request/response shape shifts)
  + `frontend/lib/trip/backend-types.ts` in this PR.
- **#5 Auth / #6 Owner:** both endpoints keep `get_current_user_id_stashed`; entitlement reads ride
  `users_select_own`; all writes are service-role keyed by **token-derived** `user_id` inside the RPCs.
- **#12 Durable jobs:** the `create_trip` event + job row are written **inside** the reservation
  transaction, so recovery's input source exists the instant a charge exists; replay-before-charge
  preserved (now inside the RPC); refund fenced by the same CAS that owns the terminal transition;
  idempotency preserved (partial unique). **A crash after the RPC commit but before `add_task`
  leaves a `pending` charged job with its `create_trip` event → recovery re-dispatches it.**
  Invariant, stated narrowly (per Codex r3): *every entitlement debit created by the new
  `/generate-trip` path has a charged job row that can refund it* — deliberately NOT claimed for
  pre-arc jobs (NULL charge), the retained `live_run` script, or jobs an old backend makes post-rollback.
- **SSE contract:** untouched (the terminal `result` event still terminates the stream, now written
  by the RPC on the failure path too). · **Eval-safety:** no pipeline/eval import changes;
  `uv run pytest evals/ -q` every task.
- **Feasible-first:** reuses the proven daily-usage table + the existing `complete_trip_run` CAS;
  no new tables; charge state = 3 columns on existing `jobs` + 3 on `users`; no BaseSettings refactor.

## Design

### DB — migration `supabase/migrations/<ts>_entitlement_free_trial.sql`

```sql
-- 1. Entitlement columns on users (leave beta_status untouched — different axis).
alter table public.users
  add column plan text not null default 'trial'
    constraint users_plan_check check (plan in ('trial', 'beta')),
  add column lifetime_trip_count integer not null default 0
    constraint users_lifetime_trip_count_nonnegative check (lifetime_trip_count >= 0),
  add column seat_requested_at timestamptz;

-- 2. Charge ledger ON the jobs row (charge exists iff a job row records it).
alter table public.jobs
  add column charge_kind text
    constraint jobs_charge_kind_check check (charge_kind in ('lifetime', 'daily')),
  add column charge_date date,
  add column charge_refunded_at timestamptz;

-- 3. Retryable-after-refund: a refunded (reversed) attempt frees its idempotency key.
--    Existing rows all have charge_refunded_at NULL and (under the old global unique) distinct
--    keys, so the partial index builds cleanly.
alter table public.jobs drop constraint jobs_idempotency_key_unique;
create unique index jobs_idempotency_key_active_uidx
  on public.jobs (idempotency_key) where charge_refunded_at is null;
```

**No seed rows in the migration.** Post-deploy manual SQL (run once by ZH):
`update public.users set plan='beta' where email in ('<zh>','<shaun>','aster@astrail.app');`

#### RPC A (new) — `reserve_and_enqueue_trip_job` — the atomic reserve = enqueue

`security definer set search_path = ''`, EXECUTE revoked from `public, anon, authenticated`,
granted to `service_role` (exact posture of `increment_daily_trip_usage`). Returns one row.

```sql
create or replace function public.reserve_and_enqueue_trip_job(
  p_user_id uuid, p_idempotency_key text,
  p_destination_hint text, p_start_date date, p_end_date date,
  p_budget_level text, p_origin_city text,
  p_preference_summary text, p_preference_sources jsonb,
  p_event_payload jsonb,
  p_trial_limit integer, p_daily_limit integer
)
returns table (outcome text, trip_id uuid, job_id uuid)
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan text;
  v_charge_kind text;
  v_charge_date date := current_date;   -- recorded ONCE, in this txn (kills midnight drift)
  v_reserved integer;
  v_trip_id uuid;
  v_job_id uuid;
  v_constraint text;
begin
  -- 0. Identity. A missing row is an anomaly (the auth trigger normally creates it).
  select u.plan into v_plan from public.users u where u.id = p_user_id;
  if not found then
    return query select 'identity_unavailable'::text, null::uuid, null::uuid;
    return;
  end if;

  -- 1. Idempotent replay: an ACTIVE (non-refunded) job with this key already exists → return its
  --    trip, charge nothing. Refunded attempts are invisible here (partial-index semantics).
  select j.trip_id into v_trip_id
    from public.jobs j
   where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
   limit 1;
  if found then
    return query select 'replay'::text, v_trip_id, null::uuid;
    return;
  end if;

  -- 2. Reserve the entitlement atomically (row-locked; concurrent first-requests serialize here).
  if v_plan = 'beta' then
    v_charge_kind := 'daily';
    insert into public.user_daily_usage as d (user_id, usage_date, generated_trip_count)
      values (p_user_id, v_charge_date, 1)
      on conflict (user_id, usage_date)
      do update set generated_trip_count = d.generated_trip_count + 1, updated_at = now()
      where d.generated_trip_count < p_daily_limit
      returning d.generated_trip_count into v_reserved;
    if v_reserved is null then
      return query select 'daily_exhausted'::text, null::uuid, null::uuid;
      return;
    end if;
  else
    v_charge_kind := 'lifetime';
    update public.users
       set lifetime_trip_count = lifetime_trip_count + 1
     where id = p_user_id and lifetime_trip_count < p_trial_limit
     returning lifetime_trip_count into v_reserved;
    if v_reserved is null then
      return query select 'trial_exhausted'::text, null::uuid, null::uuid;
      return;
    end if;
  end if;

  -- 3. Create trip + create_trip event + charged job, all in this txn. A same-key race that lost
  --    the partial-unique index raises unique_violation on the job insert; the block's savepoint
  --    rolls back trip+event+job, we undo the reservation (step 2 is OUTSIDE the block), and replay.
  begin
    insert into public.trips (user_id, status, destination_hint, start_date, end_date,
                              budget_level, origin_city, preference_summary, preference_sources)
      values (p_user_id, 'generating', p_destination_hint, p_start_date, p_end_date,
              p_budget_level, p_origin_city, p_preference_summary, coalesce(p_preference_sources, '[]'::jsonb))
      returning id into v_trip_id;

    insert into public.generation_events (trip_id, event_type, stage, message, payload)
      values (v_trip_id, 'stage', 'create_trip', 'Starting your trip',
              coalesce(p_event_payload, '{}'::jsonb));

    insert into public.jobs (trip_id, user_id, idempotency_key, status, charge_kind, charge_date)
      values (v_trip_id, p_user_id, p_idempotency_key, 'pending', v_charge_kind, v_charge_date)
      returning id into v_job_id;
  exception when unique_violation then
    -- Fix 2: only OUR active-key insert may collide here. Any other unique violation (a real bug,
    -- a future constraint) must NOT be swallowed as a replay — re-raise it. `is distinct from`
    -- re-raises on a NULL constraint name too (fail loud on uncertainty).
    get stacked diagnostics v_constraint = constraint_name;   -- pg keyword is CONSTRAINT_NAME, not pg_exception_*
    if v_constraint is distinct from 'jobs_idempotency_key_active_uidx' then
      raise;
    end if;
    -- Undo the reservation we made OUTSIDE this block (the savepoint already rolled back
    -- trip+event+job). Beta decrements the locked date row; trial decrements lifetime.
    if v_charge_kind = 'daily' then
      update public.user_daily_usage
         set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
       where user_id = p_user_id and usage_date = v_charge_date;
    else
      update public.users set lifetime_trip_count = greatest(lifetime_trip_count - 1, 0)
       where id = p_user_id;
    end if;
    -- Fix 1 (Rev 5, reverted from Rev 4): return the ACTIVE conflicting winner only. The partial
    -- index guarantees at most ONE row with this key has charge_refunded_at IS NULL, so this is
    -- unambiguous (no ordering / tie-breaker needed). Returning a refunded/failed trip would be
    -- wrong — the workspace can't resume it. If the winner has ALREADY refunded (no active row
    -- left), return a distinct non-charging `conflict_retry` (409), NEVER replay-with-NULL and
    -- NEVER a dead refunded trip.
    select j.trip_id into v_trip_id from public.jobs j
      where j.idempotency_key = p_idempotency_key and j.charge_refunded_at is null
      limit 1;
    if v_trip_id is null then
      return query select 'conflict_retry'::text, null::uuid, null::uuid;
      return;
    end if;
    return query select 'replay'::text, v_trip_id, null::uuid;
    return;
  end;

  return query select 'created'::text, v_trip_id, v_job_id;
end $$;

revoke all on function public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_and_enqueue_trip_job(uuid, text, text, date, date, text, text, text, jsonb, jsonb, integer, integer)
  to service_role;
```

> **Implementer note (create_trip event parity — RESOLVED by Codex r3):** `record_event` inserts
> exactly `trip_id, event_type, stage, message, payload` (`backend/pipeline/runner.py:112`) and
> `generation_events` has **no `sequence` column** (`20260701151718:55`); the event insert above is
> a faithful mirror. SSE orders by `created_at, id` (`backend/api/streaming.py:29`), so equal
> timestamps are handled. A test still asserts `_redispatch` finds and replays the event.

#### RPC B (extended) — `complete_trip_run` — fail = refund, exactly once, fully fenced

Same signature and grants as today (so `_complete_trip_run` and both call sites are unchanged).
Only the body grows: the CAS now `RETURNING`s the charge ledger **and the fenced `trip_id`**, and a
**failure-only** branch owns `trips.status='failed'` + the counter refund + `charge_refunded_at`, all
in the one transaction the CAS already fences. **Fix 6 (Rev 5):** `trip_id = p_trip_id` is now part
of the CAS predicate, so a caller passing the wrong trip gets a clean `false` (the mismatch is
surfaced as won=false, not silently swallowed) instead of a misdirected write; the RETURNING'd
`v_trip_id` (provably == `p_trip_id`) still drives the terminal writes. The success path
(`p_status='succeeded'`) is semantically identical to today (the only diffs are the added predicate
conjunct — which always holds for legitimate callers — and the `RETURNING`).

```sql
create or replace function public.complete_trip_run(
  p_job_id uuid, p_trip_id uuid, p_lease_token uuid,
  p_status text, p_stage text, p_message text, p_payload jsonb
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_trip_id uuid;      -- authoritative: read from the fenced job row, NOT p_trip_id (Fix 6)
  v_charge_kind text;
  v_charge_date date;
  v_user_id uuid;
begin
  -- Fence FIRST. CAS: id + lease + status='running' + trip_id=p_trip_id (Fix 6 — a caller passing
  -- the wrong trip matches zero rows → clean `false`, never a silent write to another trip; it is
  -- NOT silently ignored). A superseded worker also matches zero rows and writes NOTHING. RETURNING
  -- hands us the fenced trip_id + ledger so every terminal effect below is in THIS transaction and
  -- bound to the job we actually own (v_trip_id is now provably == p_trip_id).
  update public.jobs
     set status = p_status, completed_at = now()
   where id = p_job_id and lease_token = p_lease_token and status = 'running'
     and trip_id = p_trip_id
   returning trip_id, charge_kind, charge_date, user_id
        into v_trip_id, v_charge_kind, v_charge_date, v_user_id;
  if not found then
    return false;
  end if;

  -- Failure-only terminal effects. Exactly-once by construction: a 'running' job always has
  -- charge_refunded_at IS NULL (set only here), and only the CAS winner reaches this branch.
  if p_status = 'failed' then
    update public.trips set status = 'failed' where id = v_trip_id;
    update public.jobs set charge_refunded_at = now() where id = p_job_id;
    if v_charge_kind = 'lifetime' then
      update public.users
         set lifetime_trip_count = greatest(lifetime_trip_count - 1, 0)
       where id = v_user_id;
    elsif v_charge_kind = 'daily' then
      update public.user_daily_usage
         set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
       where user_id = v_user_id and usage_date = v_charge_date;   -- STORED date (kills midnight drift)
    end if;
    -- v_charge_kind NULL (pre-arc job): no counter to refund; charge_refunded_at is still set so
    -- the key frees for retry. Harmless.
  end if;

  -- Terminal result event (unchanged shape; terminates the SSE stream). Bound to v_trip_id.
  insert into public.generation_events (trip_id, event_type, stage, message, payload)
  values (v_trip_id, 'result', p_stage, p_message, coalesce(p_payload, '{}'::jsonb));
  return true;
end $$;

revoke all on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.complete_trip_run(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;
```

- No client UPDATE policy on `users` (deliberate). Reads covered by `users_select_own`.
- **pgTAP** `supabase/tests/entitlement_rpcs_test.sql` (single-session, deterministic):
  - `reserve_and_enqueue_trip_job`: trial user → `created`, `lifetime_trip_count=1`, a `pending`
    job with `charge_kind='lifetime'`, `charge_date=current_date`, a trip (`generating`) and a
    `create_trip` event exist; **second** call same key → `replay`, no new charge/job; second call
    **different** key at limit 1 → `trial_exhausted`, no trip/job; beta user increments daily and
    stops at `p_daily_limit`; missing user row → `identity_unavailable`; `PUBLIC`, `anon`, and
    `authenticated` **cannot** EXECUTE.
  - **Fault/rollback (single-session, Fix 3):** force a NON-`unique_violation` error inside the
    savepoint block (e.g. seed `p_budget_level='bogus'` to trip `trips_budget_level_check`) → the
    whole call aborts, `raise` is NOT swallowed, and **the reservation is rolled back** (no
    `lifetime_trip_count`/`user_daily_usage` change, no trip/job) — proves non-unique errors are
    not misread as replay and the outer txn abort unwinds the reservation.
  - **(Rev 6 Fix 3: the adversarial-timestamp case moved to the two-session test below — it cannot
    run single-session: a visible active row short-circuits to `replay`, and only-refunded rows let
    the insert succeed → `created`; neither reaches the post-`23505` re-read.)**
  - `complete_trip_run` failure: right lease + `status='running'` → `(true)`, `status='failed'`,
    `trips='failed'`, `charge_refunded_at` set, counter decremented **once**; **second** call →
    CAS finds no `running` row → `false`, counter untouched (exactly-once); **wrong lease** →
    `false`, nothing written (no refund, no trips clobber); a **wrong `p_trip_id`** (≠ the job's
    trip) → CAS predicate `trip_id=p_trip_id` fails → `false`, and the OTHER trip is untouched
    (Fix 6 — mismatch surfaced, not silently ignored);
    **result-event-failure rollback** — force the terminal `generation_events` insert to fail (e.g.
    a bad `p_stage`/`p_payload` that violates a constraint) → the whole txn aborts, so the job stays
    `running`, the counter is NOT decremented, and `charge_refunded_at` stays NULL (all-or-nothing);
    **daily** refund targets the **stored** `charge_date` (seed a yesterday-dated charge, fail today
    → yesterday's row decremented, not today's); **success** path (`succeeded`) leaves
    `charge_refunded_at` NULL and counter intact and does **not** touch `trips.status`; **pre-arc**
    row (`charge_kind` NULL) → `charge_refunded_at` set, no counter change, no error.
- **Two-session concurrency (Rev 6 Fix 2+3 — now genuinely deterministic)** —
  `backend/tests/test_reserve_enqueue_race.py`. Driver: **add `psycopg[binary]` to
  `backend/pyproject.toml` dev deps** (Codex confirmed neither `asyncpg` nor `psycopg` is there).
  Uses **THREE direct, non-pooled** connections: `winner` + `loser` (the racers) and an **autocommit
  `observer`** (Rev 6 Fix 2 — `pg_stat_activity` snapshots are cached inside a txn, so an observer
  polling from within `winner`'s open txn can see stale state forever; the observer must be its own
  autocommit connection). Each racer sets a bounded `SET statement_timeout='10s'`; the orchestration
  has its own wall-clock timeout.
  - **Seed EVERYTHING first, committed, BEFORE any racer txn opens** (Rev 6 Fix 2): the user row; the
    winner's counter = 1 (trial: `lifetime_trip_count=1`; beta: `user_daily_usage` today = 1); AND
    (Rev 6 Fix 3, folded-in adversarial row) a **refunded** historical job for key K whose
    `created_at` is LATER than the active winner will be. Committing seeds first guarantees the only
    lock `loser` can wait on is the partial-index insert, not a fixture-row lock.
  - **Choreography:** (1) `winner` `BEGIN` + insert the **active** job for key K carrying
    `charge_kind`/`charge_date` (do NOT commit); (2) launch `loser`'s `reserve_and_enqueue_trip_job(K)`
    as a concurrent task; (3) **barrier** — record both backend PIDs; from the `observer`, poll until
    **`winner_pid = ANY(pg_blocking_pids(loser_pid))`** (Rev 6 Fix 2 — proves `loser` is blocked
    *specifically by `winner`* on the index insert, i.e. it already passed its active-only replay
    SELECT); (4) `winner` `COMMIT`; (5) `await` `loser` → it unblocks, hits `23505`, runs the undo
    branch, and its **exception-path re-read returns the ACTIVE winner's trip, NOT the later-`created_at`
    refunded row** (Fix 3 assertion — the `charge_refunded_at is null` filter makes this unambiguous).
  - **Assert:** exactly one net charge (counter back to 1, `loser`'s reservation undone); `loser`
    returned `replay` with the **active winner's** `trip_id` (non-NULL, not the refunded one); no
    orphan trip/event from `loser` (savepoint rolled back). Run BOTH lanes — beta (daily undo) and
    **trial with `trial_limit=2`** (so the loser reserves before colliding; at limit 1 it is rejected
    at reservation and never reaches the branch).

### Backend

**`backend/rate_limit.py`** — beside `DAILY_TRIP_QUOTA`:
- `TRIAL_LIFETIME_LIMIT = int(os.environ.get("TRIAL_LIFETIME_LIMIT", "1"))`.
- `ENTITLEMENTS_ENABLED = os.environ.get("ENTITLEMENTS_ENABLED", "true").lower() == "true"` (Fix 3)
  — the rollback switch. `true` = new RPC path; `false` = legacy daily-quota path (`generate_trip`
  above). Default on.
- `async def reserve_and_enqueue_trip_job(client, *, user_id, idempotency_key, destination_hint,
  start_date, end_date, budget_level, origin_city, preference_summary, preference_sources,
  event_payload, trial_limit, daily_limit) -> ReserveResult` — calls
  `client.rpc("reserve_and_enqueue_trip_job", {...})`, returns `ReserveResult(outcome, trip_id,
  job_id)` from `resp.data[0]` (outcomes incl. `conflict_retry`). **PGRST202** → a distinct 503
  `{"code":"generation_unavailable","message":"Trip generation temporarily unavailable"}` (RPC missing
  = deploy lag, fail CLOSED — mirrors `check_and_increment_daily_quota`); any other `APIError`
  propagates (→500).
- The standalone `check_and_increment_daily_quota` / `refund_daily_quota` helpers **stay and are
  live** — they back the `ENTITLEMENTS_ENABLED=false` legacy path (Fix 3) and `live_run`, so they are
  NOT dead; do not delete.

**`backend/api/errors.py`** — additive dict branch in `http_exception_handler`:
```python
detail = exc.detail
if isinstance(detail, dict) and "message" in detail:
    return build_error_response(exc.status_code, detail["message"], code=detail.get("code"))
return build_error_response(exc.status_code, str(detail))   # string path unchanged
```

**`backend/main.py` `generate_trip`** — the handler keeps BOTH paths, gated by `ENTITLEMENTS_ENABLED`
(default `true`). Flag off → the **retained legacy path** (`_generate_trip_legacy`, fully specified
below — Rev 6 Fix 1); flag on → the new RPC path. `generate_trip` already receives `background:
BackgroundTasks` (verified `main.py:361`); it threads it into whichever path runs:
```python
client = await get_supabase_client()
place_ids = [str(p) for p in req.place_ids]
idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date,
                               preferences=req.preferences, pace=req.pace,
                               destination_hint=req.destination_hint, place_ids=place_ids,
                               budget_level=req.budget_level, origin_city=req.origin_city,   # Fix 9
                               requested_places=req.requested_places)

if not ENTITLEMENTS_ENABLED:                        # ROLLBACK PATH (Fix 3): legacy daily-quota only
    return await _generate_trip_legacy(client, req, user_id, idem, place_ids, background)

profile = await fetch_traveler_profile(client, user_id)                       # DB read — stays in Python
preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
origin_city = req.origin_city or (profile.get("origin_city") if profile else None)
event_payload = {"reel_urls": req.reel_urls, "start_date": req.start_date, "end_date": req.end_date,
                 "pace": req.pace, "preferences": req.preferences,
                 "destination_hint": req.destination_hint,
                 "requested_places": req.requested_places, "place_ids": place_ids}

res = await reserve_and_enqueue_trip_job(client, user_id=user_id, idempotency_key=idem,
        destination_hint=req.destination_hint, start_date=req.start_date, end_date=req.end_date,
        budget_level=req.budget_level, origin_city=origin_city,
        preference_summary=preference_summary, preference_sources=preference_sources,
        event_payload=event_payload, trial_limit=TRIAL_LIFETIME_LIMIT, daily_limit=DAILY_TRIP_QUOTA)

if res.outcome == "identity_unavailable":
    raise HTTPException(503, {"code": "identity_unavailable",
        "message": "We couldn't verify your account. Please sign in again."})
if res.outcome in ("replay",):
    return GenerateTripResponse(trip_id=res.trip_id)
if res.outcome == "trial_exhausted":
    raise HTTPException(403, {"code": "trial_exhausted",
        "message": "Your free trip is planned. Beta seats unlock unlimited planning — only 25 exist."})
if res.outcome == "daily_exhausted":
    raise HTTPException(429, {"code": "rate_limited",
        "message": "Daily trip limit reached. Try again tomorrow."})
if res.outcome == "conflict_retry":                                           # Fix 1 — never NULL
    raise HTTPException(409, {"code": "conflict_retry",
        "message": "That request is already being processed — please retry."})
# created:
background.add_task(run_generation, res.trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
                    job_id=res.job_id, pace=req.pace, preferences=req.preferences,
                    destination_hint=req.destination_hint, place_ids=place_ids)
return GenerateTripResponse(trip_id=res.trip_id)
```
`fetch_traveler_profile`/`compose_preference_summary` failing raises **before** any charge (better
than today). Nothing between the RPC commit and `add_task` can strand a charge — recovery owns that.
(Codex r3 corrected two Rev-3 asides: `fetch_traveler_profile` is a `traveler_profiles` **DB read**,
not mem0, and it **swallows** read failures — so a "fail-before-charge" here is a benign empty
profile, not a raised 500; the charge still can't precede a durable job either way.)

**`_generate_trip_legacy` (Fix 1 — the rollback path, fully specified).** This is the CURRENT pre-arc
`generate_trip` body (`main.py:373-479`) extracted verbatim into a helper, with exactly ONE change:
its direct replay lookup gains `.is_("charge_refunded_at", "null")` so it is partial-index-safe (the
3rd and previously only-unfiltered idempotency lookup Codex r5 flagged). It does NOT touch the new
charge columns — legacy jobs carry `charge_kind = NULL` (harmless; see rollback note). It takes
`background` so it can dispatch:
```python
async def _generate_trip_legacy(client, req, user_id: str, idem: str,
                                place_ids: list[str], background: BackgroundTasks) -> GenerateTripResponse:
    # 1. Idempotent replay — ACTIVE row only (Fix 1: .is_(), not the pre-arc unfiltered .eq/.maybe_single).
    existing = await (client.table("jobs").select("trip_id")
                      .eq("idempotency_key", idem).is_("charge_refunded_at", "null")
                      .maybe_single().execute())
    if existing is not None and existing.data is not None:
        return GenerateTripResponse(trip_id=existing.data["trip_id"])

    # 2. Legacy daily quota (no lifetime enforcement — this is the rollback behavior).
    if not await check_and_increment_daily_quota(client, user_id, DAILY_TRIP_QUOTA):
        raise HTTPException(429, "Daily trip limit reached. Try again tomorrow.")

    trip_id: str | None = None
    try:
        profile = await fetch_traveler_profile(client, user_id)
        preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
        origin_city = req.origin_city or (profile.get("origin_city") if profile else None)
        trip = (await client.table("trips").insert({
            "user_id": user_id, "status": "generating", "destination_hint": req.destination_hint,
            "start_date": req.start_date, "end_date": req.end_date, "budget_level": req.budget_level,
            "origin_city": origin_city, "preference_summary": preference_summary,
            "preference_sources": preference_sources,
        }).execute()).data[0]
        trip_id = trip["id"]
        await record_event(client, trip_id, event_type="stage", stage="create_trip",
                           message="Starting your trip",
                           payload={"reel_urls": req.reel_urls, "start_date": req.start_date,
                                    "end_date": req.end_date, "pace": req.pace,
                                    "preferences": req.preferences, "destination_hint": req.destination_hint,
                                    "requested_places": req.requested_places, "place_ids": place_ids})
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)   # its 23505 re-read is .is_()-filtered (#4)
    except Exception:
        logger.exception("generate_trip_legacy_enqueue_failed trip_id=%s", trip_id)
        if trip_id is not None:
            try: await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq("user_id", user_id).execute()
            except Exception as exc: logger.warning("legacy_fail_mark trip_id=%s error=%s", trip_id, type(exc).__name__)
        try: await refund_daily_quota(client, user_id)
        except Exception as exc: logger.warning("legacy_quota_refund_failed error=%s", type(exc).__name__)
        raise HTTPException(500, "Could not enqueue generation job")

    if winning_trip_id != trip_id:                 # lost same-key race → refund, drop orphan, redirect
        try: await refund_daily_quota(client, user_id)
        except Exception as exc: logger.warning("legacy_quota_refund_failed error=%s", type(exc).__name__)
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)

    background.add_task(run_generation, trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
                        job_id=job_id, pace=req.pace, preferences=req.preferences,
                        destination_hint=req.destination_hint, place_ids=place_ids)
    return GenerateTripResponse(trip_id=trip_id)
```
This is behavior-identical to today's `generate_trip` except the one `.is_()` filter, so the rollback
path is a proven flow, not new logic. It reuses `check_and_increment_daily_quota` / `refund_daily_quota`
(the "still live" helpers) and the `.is_()`-filtered `enqueue_job`.

**Shared idempotency-lookup hardening (Fix 4 + Fix 9) — REQUIRED, forward AND rollback.** The partial
index means a key can have one active row + N refunded rows, so **every** lookup that reads a job by
`idempotency_key` must filter `charge_refunded_at is null` or it can match >1 row and 500 (this is a
*forward* bug, not only a rollback one):
- **`compute_idempotency_key`** (`backend/jobs.py:45`): add `budget_level`, request `origin_city`
  (the raw `req.origin_city`, not the profile-resolved value — keep the key deterministic from the
  request), and `requested_places` to the hashed material, so two genuinely different requests stop
  colliding into one another's replay. Note: this changes every key vs today; safe pre-launch (only
  test accounts exist). It lands **in the backend rollout that switches to the RPC** — DB-first
  necessarily leaves a safe migration→backend gap (Codex r4).
- **`enqueue_job`** (`backend/jobs.py:78`) — the 23505 re-read gains **`.is_("charge_refunded_at",
  "null")`** so it returns the single active row. **Fix 2 (Rev 5): use `.is_()`, NOT `.eq(…, None)`**
  — in the installed PostgREST client `.eq` builds `eq.None` (wrong); `.is_(col, "null")` is the
  `IS NULL` form (the repo already uses it, `backend/scripts/backfill_reel_covers.py:77`).
  `enqueue_job` is **NOT dead** — `backend/scripts/live_run.py:150` still calls it (Codex r3); its
  replay lookup (`live_run.py:169`) gets the same `.is_()` filter, or migrate the script to the RPC.
- **Rollback (corrects Rev 3/4):** handled by the `ENTITLEMENTS_ENABLED` flag, not a pinned image —
  see `generate_trip` below and Deploy.

**`RequestSeatResponse` (Fix 7 — real schema parity):** add a Pydantic model in
`backend/api/schemas.py` (`class RequestSeatResponse(BaseModel): requested_at: datetime`) and set
`@app.post("/request-seat", response_model=RequestSeatResponse)`; mirror it in
`frontend/lib/trip/backend-types.ts`. The `jobs` charge columns (`charge_kind/charge_date/
charge_refunded_at`) are **backend-only** — the frontend never reads a raw jobs row (it sees trips +
SSE), so they get a schema comment, not a TS row mirror.

**`backend/pipeline/runner.py` `_fail()`** — restructure so the fenced path lets the RPC own **all**
terminal writes. **Fix 5:** the pre-CAS unfenced `error` event is moved OFF the leased path — on a
leased failure the RPC's CAS is the sole writer, so "a superseded worker writes nothing" is now
literally true (the error detail still rides the fenced terminal `result` event's payload). The two
unfenced fallbacks (no durable job; job-without-lease) keep today's behavior, error event included.

> **APPROACH-O CORRECTION (2026-08-03, at implementation — the delivered `_fail`).** The earlier
> snippet opened with `superseded = lease_lost…; if superseded: return`. That short-circuit is a
> **bug** and was dropped: `_heartbeat` sets `lease_lost` BOTH when a replacement claimed the job AND
> when the worker hit past-TTL unreachability but STILL owns the row (`jobs.py` `trip_lease_unrenewable_past_ttl`).
> `_fail` can't tell them apart, so returning early drops the terminal SSE result in the still-owning
> case → the launch-audit "silent spinner" P1. Instead the leased path ALWAYS calls the CAS and lets
> it arbitrate: a replacement-superseded worker loses the CAS and writes nothing (no unfenced event
> exists to leak — Fix 5 still holds); a still-owning worker wins and delivers the terminal result +
> refund promptly. This matches this section's own Fix-5 test ("superseded **CAS-false** … no error
> event" — the CAS is *called* and loses, not skipped). `lease_lost` is retained in the signature for
> caller compat but no longer gates any write. Committed `8f28813`.

```python
# Leased path: the RPC's CAS is the SOLE terminal writer (Fix 5) — called regardless of lease_lost,
# the CAS arbitrates (superseded→loses→writes nothing; still-owning→wins→delivers result + refund).
if job_id is not None and lease_token is not None:
    try:
        ok = await _complete_trip_run(client, job_id, trip_id, lease_token, status="failed",
                                      stage=stage, message="Astrail couldn't finish this trip",
                                      payload={"error": message})
        logger.info("trip_fail_fenced job_id=%s won=%s", job_id, ok)
    except Exception:
        logger.warning("trip_fail_fenced_error job_id=%s", job_id, exc_info=True)  # sole writer+refund: leave a trace
    return {"error": message}

# Unfenced fallbacks — no lease to fence with (a no-lease worker is never superseded).
try: await record_event(client, trip_id, event_type="error", stage=stage, message=message)
except Exception: pass
try: await _set_status(client, trip_id, user_id, "failed")
except Exception: pass
if job_id is None:                                               # no durable job → emit SSE terminator
    try: await record_event(client, trip_id, event_type="result", stage=stage,
                            message="Astrail couldn't finish this trip", payload={"error": message})
    except Exception: pass
# else job present but never leased → reaper owns the terminal result (no result event today) — unchanged
return {"error": message}
```
The success path (`_complete_trip_run(status="succeeded")` at `:526`) is untouched. **Test (Fix 5):**
a leased worker whose CAS loses (lease_lost NOT set, `_complete_trip_run`→False) writes NO `error`
event either — assert zero rows written.

**`POST /request-seat`** — auth + burst limit; service-role
`update public.users set seat_requested_at = coalesce(seat_requested_at, now()) where id = :uid
returning seat_requested_at`; 0 rows → 503 `identity_unavailable`; response `{"requested_at": iso}`
(idempotent — repeat clicks return the original stamp).

### Frontend

**`frontend/lib/trip/api.ts`** — `class ApiError extends Error { status: number; code: string }`; on
`!res.ok` parse the `{"error":{"code","message"}}` envelope, fallback
`new ApiError(res.status, "unknown", res.statusText)`. Replaces the raw-text throw at `:24-25`.

**`frontend/lib/trip/backend-types.ts`** — `UserPlan = 'trial' | 'beta'`, `ERROR_CODE_TRIAL_EXHAUSTED`,
`ERROR_CODE_IDENTITY_UNAVAILABLE`, `ERROR_CODE_RATE_LIMITED`, `ERROR_CODE_CONFLICT_RETRY`,
`RequestSeatResponse` (mirrors the new backend Pydantic model) — same PR (#4 parity). Jobs charge
columns are backend-only (comment, no row mirror).

**`frontend/lib/entitlement.ts` + `useEntitlement()` hook (single source)** — owns:
- the own-row read (`plan, lifetime_trip_count, seat_requested_at`) via Supabase `users_select_own`;
- **the canonical trip for the "Open your trip" link (r2-F5): call the existing `listTrips()` and
  take `trips[0]`** (ordered `created_at desc`; a trial-exhausted user has exactly one trip → it is
  unambiguous). Expose `{ canonicalTripId, canonicalTripLoading }`; a still-`generating` trip links
  fine (the workspace renders its live state).
- `requestSeat()` and `classifyGenerateError(err)` (`err instanceof ApiError && err.code ===
  ERROR_CODE_TRIAL_EXHAUSTED`).
- **Advisory fetch failure → fail-open**: show Generate; the backend RPC is the enforcer.

**`components/entitlement/TrialExhaustedCard.tsx`** — three states (exhausted / request-sent /
already-requested) **plus an "Open your trip" link to `canonicalTripId`** (lost-response recovery).
Copy: "Your free trip is planned." · "Beta seats unlock unlimited planning — we're self-funded, so
only 25 exist." · button "Request a seat" → received state. No invented numbers; the link is hidden
while `canonicalTripLoading` or if no trip resolves.

**Wiring** — `CreateTripFlow.tsx:66`: pre-emptive gate via the hook (render the card instead of
Generate when `plan==='trial' && lifetime_trip_count>=1`) + `ApiError` catch → card on
`trial_exhausted`, message alert otherwise. `SavedReelsFlow.tsx:217` (Generate lives here, not in
the presentational `PlanSheet`): same via the same hook.

## Tasks (each = one focused implementation step; TDD; commit per task)

> **Implementer: a fresh Zhi Hao-driven session** (not Shaun). Read this plan top-to-bottom first;
> the design is Codex-validated (4×) and frozen — build it, don't re-derive it. Use the Standard
> Feature Build Loop (`.claude/docs/BUILD-LOOP.md`): per-task `astrail-developer` + `astrail-reviewer`,
> then the whole-branch reviews, then the **E2E gate below** before PR/merge.

1. **Migration + pgTAP** — users cols, jobs charge cols, partial unique index (drop the global
   `jobs_idempotency_key_unique`, create the partial `jobs_idempotency_key_active_uidx`),
   `reserve_and_enqueue_trip_job` (narrowed `GET STACKED DIAGNOSTICS` branch + **active-only re-read**
   + `conflict_retry`), extended `complete_trip_run` (fenced `trip_id` in the CAS predicate); full
   single-session pgTAP list above incl. the **fault/rollback** cases (non-unique error rolls back the
   reservation; result-event-failure rolls back the terminal CAS+refund; wrong `p_trip_id` → CAS
   false, other trip untouched). NB: the adversarial-timestamp case is NOT here — it moved to 1a
   (unreachable single-session).
1a. **Two-session concurrency test** (`backend/tests/test_reserve_enqueue_race.py`, Rev 6 Fix 2+3) —
   **add `psycopg[binary]` to `backend/pyproject.toml` dev deps**; the **THREE-connection**
   (`winner`/`loser` + autocommit `observer`) `pg_blocking_pids()`-barriered, bounded-timeout choreography
   with all seeds committed first (user, winner counter=1, AND the later-`created_at` refunded row for
   the adversarial assertion); assert the loser replays the **active** winner (not the refunded row).
   Both beta and trial-limit-2 lanes. Load-bearing — the branch Rev 3's pgTAP missed and Rev 4's test
   didn't synchronize.
2. **rate_limit helper** — `TRIAL_LIFETIME_LIMIT`, `ENTITLEMENTS_ENABLED` (Fix 3),
   `reserve_and_enqueue_trip_job` wrapper + `ReserveResult` (incl. `conflict_retry`) + PGRST202→503
   fail-closed; unit tests (outcome passthrough incl. conflict_retry, PGRST202 path, non-202 APIError
   propagates).
3. **errors.py dict-detail branch** + tests (dict → structured `{code,message}`; string path pinned
   unchanged; existing 429 string still slugs `rate_limited`).
4. **generate_trip rewrite + `_generate_trip_legacy` + idempotency-lookup hardening** — the new RPC
   path + outcome mapping (incl. `conflict_retry`→409); extract **`_generate_trip_legacy`** exactly as
   spelled out above (Rev 6 Fix 1 — `background` param + `.is_()`-filtered direct replay lookup) and
   gate it on `ENTITLEMENTS_ENABLED`; extend `compute_idempotency_key` (budget_level, request
   origin_city, requested_places — Fix 9); add `.is_("charge_refunded_at","null")` to `enqueue_job`'s
   23505 re-read + `live_run.py` (Fix 2). Endpoint tests: trial 2nd POST → 403; beta cap → 429;
   replay charges nothing; missing user → 503; **conflict_retry → 409** (mock the RPC outcome);
   **refunded failure → same-input POST runs again** (`created`, not `replay`); a hash-input change
   (different budget_level) is NOT a replay; `enqueue_job` re-read returns the single active row when a
   refunded row shares the key (`.is_()` proven, not `.eq(None)`); **`ENTITLEMENTS_ENABLED=false` →
   `_generate_trip_legacy` runs** (daily-quota only, no lifetime enforcement, its direct replay lookup
   `.is_()`-filtered); a **migrated-DB rollback test** — with `ENTITLEMENTS_ENABLED=false` against the
   migrated schema seeded with BOTH a refunded and an active row for one key, hit the real route and
   assert it returns the active trip (no >1-row 500) before any quota increment / trip insert.
5. **`_fail()` restructure → fenced `complete_trip_run(failed)`** — tests: failed run refunds once
   (trial + beta); **superseded (CAS-false while `lease_lost` false) → NO refund, NO `trips` clobber,
   AND no `error` event** (Fix 5; fault-inject the fence → the double-write test reds without the CAS);
   recovery-redispatched job refunds from row metadata; yesterday-dated daily charge refunds
   yesterday's row; success path leaves charge intact.
6. **`POST /request-seat` + `RequestSeatResponse`** (Fix 7) — Pydantic model + `response_model`;
   tests (auth, idempotent stamp via `coalesce`, 503 on missing row, envelope + response shape).
7. **FE `ApiError` + type mirrors** + tests (envelope parse, non-JSON fallback, existing callers get
   clean messages).
8. **FE `useEntitlement` hook + `TrialExhaustedCard`** + tests (three states; canonical-trip link via
   `listTrips()[0]`, hidden while loading / when none; fail-open on fetch error).
9. **Both flow wirings via the hook** + tests (pre-emptive gate, 403 catch, no logic duplication —
   the hook is the single source; `PlanSheet` stays presentational; **both flows display the
   structured `conflict_retry`/409 message** through the shared `ApiError` path — Fix 7/LOW).
10. **Docs** — `ENV.md` (`TRIAL_LIFETIME_LIMIT`, **`ENTITLEMENTS_ENABLED`** + the rollback recipe;
    deploy note `DAILY_TRIP_QUOTA=10`), `ARCHITECTURE.md` (endpoints + the two-RPC entitlement-ledger
    section + charge/refund invariants + the `ENTITLEMENTS_ENABLED` legacy/rollback branch), this
    plan's deploy checklist.
11. **E2E test** (see `## E2E verification`) — the LAST gate before PR/merge; the whole flow driven
    against a live stack, not mocks.

**Per-task gates:** `uv run pytest -q` · `uv run pytest evals/ -q` · `npm test` · `npx tsc --noEmit`
(FE tasks) · DB tasks also: `supabase db reset` + `supabase test db` + `supabase db lint --local`.

## E2E verification (REQUIRED gate — Zhi Hao's explicit bar for this arc)

Unit + pgTAP + the two-session race test prove the pieces; **this proves the whole flow works for a
real user**. Run against a **live local stack** (backend on Render-parity env + `supabase start` + the
Next.js app), driven through the browser via gstack `/qa` (or a Playwright spec if we want it in CI).
Credit-spend (real Apify/OpenAI) needs ZH's go — otherwise point the pipeline at cache-warm inputs.

**Scenario A — trial → exhausted → seat → beta (happy path):**
1. Fresh trial account (`plan='trial'`, `lifetime_trip_count=0`). Sign in.
2. Generate a trip → succeeds; assert `lifetime_trip_count=1`, a `succeeded` job with
   `charge_kind='lifetime'`, `charge_refunded_at` NULL.
3. Start a second generation → the `TrialExhaustedCard` **pre-empts** it (no POST); "Open your trip"
   opens the trip from step 2.
4. Force the POST anyway (bypass the gate) → **403 `trial_exhausted`**, structured message shown.
5. Click "Request a seat" → `seat_requested_at` set in DB; button → received state; repeat click
   returns the same stamp.
6. Grant the seat (`update users set plan='beta'`) → reload → generate again succeeds; repeat until
   the daily cap → **429 `rate_limited`**.

**Scenario B — refund on failure (the load-bearing invariant):** on a scratch trial account, force a
mid-pipeline failure (kill the run / inject a stage error) → assert `lifetime_trip_count` back to 0,
the failed job's `charge_refunded_at` set, `trips.status='failed'`, and a **same-input retry runs
again** (`created`, a fresh job — the key was freed).

**Scenario C — rollback drill (the safety net):** flip `ENTITLEMENTS_ENABLED=false` on the running
backend, restart → generate works via the legacy daily-quota path with NO lifetime limit; confirm no
500s even with a refunded+active row sharing a key (seed that state first); flip back → new path
resumes. This is the drill we'd actually run in an incident, so rehearse it once.

`/qa` over BOTH generate entry points (`CreateTripFlow` and `SavedReelsFlow`/`PlanSheet`).

## Deploy order + rollback

**DB-first is REQUIRED.** Sequence:
1. Apply migration; then **probe via service role** (before deploying code — Fix 8):
   - `users.plan`, `users.lifetime_trip_count`, `users.seat_requested_at` selectable, with the
     expected defaults + check constraints (`plan default 'trial' in ('trial','beta')`,
     `lifetime_trip_count >= 0`);
   - `jobs.charge_kind/charge_date/charge_refunded_at` present with `charge_kind` check;
   - the OLD global `jobs_idempotency_key_unique` is **GONE**, and `jobs_idempotency_key_active_uidx`
     exists, **is unique**, and its predicate is **exactly `charge_refunded_at IS NULL`** (read
     `pg_index.indpred` / `pg_get_indexdef`) — merely finding the index name does not prove the
     unconditional uniqueness was removed;
   - both RPCs present with the expected signatures, **EXECUTE granted to `service_role` and revoked
     from `PUBLIC`, `anon`, AND `authenticated`** (check all three, not just the two roles);
   - a **zero-provider-cost transactional canary** (Rev 6 Fix 4 — valid SQL): in one
     `BEGIN … ROLLBACK`, declare one lease UUID and reuse it positionally (the r5 call mixed a named
     arg before a positional one and named a non-parameter — invalid):
     ```sql
     do $$
     declare v_lease uuid := gen_random_uuid();
             v_trip uuid; v_job uuid; v_before int; v_claimed bool; v_done bool;
     begin
       select generated_trip_count into v_before from public.user_daily_usage
         where user_id = :canary_user and usage_date = current_date;      -- snapshot in-txn
       select trip_id, job_id into v_trip, v_job
         from public.reserve_and_enqueue_trip_job(:canary_user, :key, …, 1, 10);   -- created, counter +1
       -- (assert a 2nd call with :key returns 'replay' and does not increment again)
       select public.claim_trip_job(v_job, v_lease, 300) into v_claimed;   -- pending→running, assert true
       select public.complete_trip_run(v_job, v_trip, v_lease,
                'failed', 'save', 'canary failure', '{}'::jsonb) into v_done;  -- assert true, counter −1
       -- assert the counter net-returned to coalesce(v_before,0); then:
       raise exception 'canary rollback';   -- force ROLLBACK: no real rows, NO Apify/OpenAI spend
     end $$;
     ```
     `claim_trip_job` is at `supabase/migrations/20260720170000_db_clock_job_leases.sql:48`. **Fix 5
     (Rev 5) reason it's needed:** a freshly reserved job is `pending`/no-lease, so without the claim
     the `complete_trip_run` CAS (`status='running'`) no-ops and the counter never refunds.
2. Deploy backend.
3. Run the founders/demo beta-grant SQL.
4. Set `DAILY_TRIP_QUOTA=10`.
5. Only then flip the `zh` landing CTA.

Backend-first is NOT safe — with `ENTITLEMENTS_ENABLED=true` (default) every generation path calls
`reserve_and_enqueue_trip_job`; if the RPC is absent, PGRST202 fails every request closed.

**Rollback is ORDERED — three moves, no redeploy (Fix 3, corrects Rev 3/4):** (1) flip the `zh`
landing CTA back → (2) `DAILY_TRIP_QUOTA=5` **and** `ENTITLEMENTS_ENABLED=false` → (3) restart (env
change only; **no image swap**). Out-of-order opens a window where the legacy path (no lifetime
enforcement) runs at a 10/day cap. **Why a flag, not a pinned image:** the migration drops the global
unique for a partial index — a *behavioral* compat change, not purely additive. Any code path whose
idempotency lookups are unfiltered can match >1 row once a refunded + a later attempt share a key and
**500s every subsequent POST with that key** (a persistent per-key outage; Rev 3's "one request" was
wrong; no corruption / no overcharge, it 500s before quota). So the arc ships **both** paths in one
image: `ENTITLEMENTS_ENABLED=false` routes to the retained legacy daily-quota `generate_trip`, whose
`enqueue_job` re-read is `.is_()`-filtered (§Shared idempotency-lookup hardening) → partial-index-safe.
The migration stays (additive columns + partial index; no data reversal). A **migrated-DB rollback
test** exercises the `false` path against a schema seeded with both refunded and active rows for one
key, proving no >1-row 500. (The considered alternative — tombstone-rekeying refunded jobs so the
literal pre-arc image is a safe rollback — was rejected: the flag keeps the validated forward path
untouched and needs no separate build artifact.)

## Codex review log

- **Rev 1** → 4/10 (8 findings). **Rev 2** → 5/10, BLOCKED (Correctness 3/10 🚩, Safety 3/10 🚩).
- **Rev 3** → **6/10, BLOCKED but no CRITICAL findings, no dimension ≤3** (`gpt-5.6-sol`, high;
  report `scratchpad/codex-r3-review.out`). Correctness 7 · Completeness 6 · Safety 5 · Testability 4
  · Maintainability 6. F1–F4 architectural core confirmed FIXED (no path double-charges, double-refunds,
  or lets a CAS-losing worker write trip-failure/refund/`charge_refunded_at`/result); F3, F4, F5 fixed.

- **Rev 4** → **all 9 punch-list items folded in** (see `## What changed in Rev 4`); NOT yet
  re-reviewed by Codex. Summary of resolutions: (1) unfiltered re-read + `conflict_retry`, never
  NULL; (2) `GET STACKED DIAGNOSTICS` narrows the catch; (3) deterministic two-session race test +
  single-session fault/rollback tests; (4) active-only filters on all idempotency lookups + pinned
  rollback build; (5) leased path writes nothing unfenced; (6) terminal writes bound to the fenced
  `trip_id`; (7) real `RequestSeatResponse` Pydantic + `response_model`; (8) probes assert
  old-unique-gone + exact index predicate + PUBLIC revoked + txn canary; (9) `enqueue_job` filtered
  (not dead) + `compute_idempotency_key` folds in budget/origin/requested_places.

  **Rev 3 punch-list (each now addressed in Rev 4 above):**
  1. **[HIGH] Replay-race → NULL trip_id.** In the `unique_violation` branch, if the conflicting
     job got refunded between B's replay-check and B's undo, the re-read finds no active row → returns
     `('replay', NULL, NULL)` → `GenerateTripResponse(trip_id=None)` → 500. Fix: return the conflicting
     trip regardless of refunded state, or a distinct bounded-retry outcome — never replay-with-NULL.
  2. **[HIGH] Narrow the exception.** Catch only `jobs_idempotency_key_active_uidx` via
     `GET STACKED DIAGNOSTICS ... CONSTRAINT_NAME`; rethrow every other `unique_violation`.
  3. **[HIGH] Concurrency tests are load-bearing but absent.** The proposed pgTAP "race" test returns
     `replay` at step 1 and never reaches the undo branch. Need deterministic two-session tests for
     beta undo, lifetime undo, savepoint rollback, and the NULL-replay race; plus fault tests
     (uncaught reserve error rolls back reservation; result-event failure rolls back the terminal
     CAS/refund; wrong lease writes no result).
  4. **[HIGH] Rollback compat** (see corrected caveat above): migration-compatible rollback build with
     active-only idempotency lookups everywhere (incl. `enqueue_job` + `live_run`), or tombstone-rekey.
  5. **[MED] Unfenced `error` event.** `_fail` writes the non-terminal `error` event before the CAS, so
     "CAS loser writes nothing" is literally false — a superseded leased worker can flash a spurious
     error. Omit the unfenced error event for leased failures (or make it CAS-owned).
  6. **[MED] `complete_trip_run` trusts caller `p_trip_id`.** Bind terminal trip effects to the
     `trip_id` returned by the fenced job-row CAS instead.
  7. **[MED] Schema parity.** Add a real backend `RequestSeatResponse` Pydantic + endpoint
     `response_model` (not just the frontend type); decide jobs charge-cols backend-only vs typed.
  8. **[MED] Probes.** Assert the OLD global uniqueness is *gone*, the new index predicate is exactly
     `charge_refunded_at IS NULL`, `PUBLIC` (not just anon/authenticated) lacks EXECUTE, and add a
     zero-cost transactional canary for reserve/replay/refund/CAS.
  9. **[MED, pre-existing] `enqueue_job` is NOT dead** — still used by `backend/scripts/live_run.py:150`;
     and `compute_idempotency_key` omits `budget_level`/`origin_city`/`requested_places` despite the
     arc leaning on the key's exactness.

  **Codex corrections to Rev 3's own facts:** profile fetch is a `traveler_profiles` DB read (not mem0)
  and swallows read failures; `generation_events` has no `sequence` column and SSE orders by
  `created_at,id`, so the flagged event-parity risk is a non-issue; success-path is semantically (not
  byte-) identical because the CAS gains a `RETURNING`.

- **Rev 5** → **all 7 r4 items folded in** (see `## What changed in Rev 5`); NOT yet re-reviewed.
  Resolutions: (1) re-read reverted to active-only filter + `conflict_retry` (never a dead refunded
  trip); (2) `.is_(col,"null")` not `.eq(col,None)`; (3) real `ENTITLEMENTS_ENABLED` flag with a
  retained legacy path — rollback = env flip, no image swap, + a migrated-DB rollback test; (4)
  two-session test with `pg_stat_activity` barrier + `psycopg[binary]` dep + winner seed; (5) canary
  claims a lease before failing; (6) `trip_id=p_trip_id` added to the CAS predicate (mismatch → clean
  false); (7) explicit conflict_retry endpoint + FE tests.

- **Rev 4** → **7/10, BLOCKED** (`gpt-5.6-sol`, high; report `scratchpad/codex-r4-review.out`).
  Correctness 6 · Completeness 6 · Safety 4 · Testability 5 · Maintainability 6. No CRITICAL, no
  dim ≤3. **Architectural core RECONFIRMED valid.** Fixes **2, 5, 7, 9 confirmed FIXED**; the rest
  partial. Two of Rev 4's own fixes were WRONG and are corrected in the Rev 5 changes above.

  **Rev 5 punch-list (Codex: these reach ~8/10, implementation-ready):**
  1. **[HIGH] Fix 1 was backwards.** The unfiltered re-read can now return a *refunded/failed* trip
     as `replay` — and the workspace only shows "Generation failed / Plan a new trip"
     (`TripWorkspace.tsx:116`), it does not resume. Correct fix = the OPPOSITE: KEEP
     `and j.charge_refunded_at is null` on the re-read AND return `conflict_retry` when no active row
     remains. Add a test where a refunded row has a LATER `created_at` than the active winner (no
     causal tie-breaker exists). (Codex note: the committed-refund interleaving is rarer than Rev 4
     implied — B holds the entitlement-row lock until commit — so filtered+conflict_retry is both
     correct and low-cost.)
  2. **[HIGH] `.eq("charge_refunded_at", None)` is NOT `IS NULL`** in the installed PostgREST client
     (`.eq` builds `eq.<value>`; only `.is_` maps None→`is.null`). Use `.is_("charge_refunded_at",
     "null")` (repo already does this in `backfill_reel_covers.py:77`) at `jobs.py:78` + `live_run.py:169`.
  3. **[HIGH] The pinned rollback build is not a coherent artifact.** `TRIAL_LIFETIME_LIMIT` unset
     defaults to `"1"` (still enforces), and `generate_trip` calls the new RPC unconditionally — so
     the described rollback build still enforces the new model. Rev 5 needs a real
     `ENTITLEMENTS_ENABLED=false` legacy daily-quota branch (or an explicit compatibility commit) +
     a migrated-DB rollback test with both refunded and active rows for one key.
  4. **[HIGH] Two-session test not yet deterministic.** "Start session 2, then commit session 1" is
     timing-dependent. Needs: session-2 as a concurrent task + a **barrier polling `pg_stat_activity`**
     until session-2 is blocked on the lock, bounded `statement_timeout` + orchestration timeout, a
     **declared DB driver** (neither `asyncpg` nor `psycopg` is in `backend/pyproject.toml`), a direct
     (non-pooled) connection, and an explicit winner seed (charge metadata AND counter both = 1). The
     single-session fault tests are VALID.
  5. **[MED] The canary can't refund as written.** A freshly reserved job is `pending`/no-lease, so
     `complete_trip_run`'s CAS (`status='running'` + lease) returns false → counter stuck at 1. Insert
     `select public.claim_trip_job(v_job_id, v_lease_token, 300);` (RPC at
     `20260720170000_db_clock_job_leases.sql:48`) before the failure step; assert both return true.
  6. **[MED] Fix 6 should REJECT a mismatched `p_trip_id`, not silently ignore it** (hides caller
     bugs where earlier pipeline writes targeted trip X but completion succeeds for trip Y). Either
     add `and trip_id = p_trip_id` to the CAS predicate, or compare `v_trip_id`↔`p_trip_id` and raise.
  7. **[LOW] Add explicit `conflict_retry` tests** — one backend endpoint (RPC → 409) + one shared
     FE classifier/API test (both flows display the structured retry message).

  Codex fact: the constraint-name diagnostic DOES populate with the standalone unique-INDEX name for
  this violation (Fix 2 correct) — BUT the plpgsql item keyword is `CONSTRAINT_NAME`, not
  `pg_exception_constraint_name` (that spelling is a syntax error, SQLSTATE 42601; caught at Task-1
  verification 2026-08-03 and corrected in both the migration and the code block above);
  the SHA-256 hash change (Fix 9) is safe (old requests get new keys,
  no harmful replay). "Lands with the migration" (Fix 9) should read "lands in the backend rollout
  that switches to the RPC" — DB-first inherently leaves a safe migration→backend gap.

- **Rev 6** → **all 4 r5 items folded in; review loop CLOSED, build-ready** (Codex's own forecast:
  these 4 → ≥8/10). NOT re-reviewed by Codex — by decision, we stop the paper loop here (design
  validated 4× consecutively) and verify the rest with a real **E2E test** during implementation.
  Resolutions: (1) `_generate_trip_legacy` fully spelled out (body + `background` param + `.is_()` on
  its direct replay lookup); (2) two-session test → 3-connection autocommit-observer +
  `pg_blocking_pids()` barrier + seeds-committed-first; (3) adversarial-timestamp row folded into that
  two-session test; (4) canary SQL fixed (one declared `v_lease`, positional reuse). Owner re-pointed:
  **fresh Zhi Hao session implements** (not Shaun). LOW `p_trip_id`-observability left as-is.

- **Rev 5** → **7/10, BLOCKED** (`gpt-5.6-sol`, high; report `scratchpad/codex-r5-review.out`).
  Correctness 7 · Completeness 6 · **Safety 6** (↑ from 4 — the `ENTITLEMENTS_ENABLED` flag landed) ·
  Testability 4 · Maintainability 6. No CRITICAL, no dim ≤3. **Architectural core reconfirmed a 4th
  time, zero regressions.** Fixes **2 & 6 confirmed FIXED**; 1/3/4/5/7 partial (precision, not design).
  Codex forecast: **the 4 items below reach ≥8/10, implementation-ready.**

  **Rev 6 punch-list (4 mechanical items — Codex says these clear it):**
  1. **[HIGH] `_generate_trip_legacy` is still hand-waved.** Rev 5 references it but doesn't spell out
     the body, doesn't pass it `background: BackgroundTasks`, and — the real hazard — doesn't show the
     `.is_("charge_refunded_at","null")` filter on the legacy path's FIRST/direct replay lookup
     (`main.py:373`, the unfiltered `.eq("idempotency_key",idem).maybe_single()`). An implementer
     following only the shown code would retain the >1-row outage. Fully specify the helper: signature
     with `background`, filtered direct replay → daily quota → profile/trip/event → `enqueue_job` →
     failure+lost-race cleanup/refund → `background.add_task`. (Note in rollback docs: legacy jobs have
     `charge_kind=NULL` → a rollback-era failure doesn't refund its daily debit — matches existing
     legacy behavior, not a blocker, but state it.)
  2. **[HIGH] The `pg_stat_activity` barrier can still be flaky.** Within session-1's open txn the stat
     snapshot is cached, so re-polls can see stale state. Use a **third autocommit observer connection**
     (or `pg_stat_clear_snapshot()` before every poll), record both PIDs, match session-2 specifically,
     require `session1_pid = ANY(pg_blocking_pids(session2_pid))`, and commit ALL fixture seeds (trip,
     counter=1, refunded historical row) BEFORE session-1's winner-insert txn (else `transactionid`
     could be the counter-row wait, not the index wait).
  3. **[MED] The adversarial-timestamp test can't run single-session** (an active row → step-1 replay;
     only-refunded rows → `created`, never reaching the re-read). Fold it INTO the two-session collision
     test: commit a later-`created_at` refunded row for K, then run the choreography, assert session-2's
     exception-path re-read returns the ACTIVE winner (not the later refunded row).
  4. **[MED] The canary's exact lease SQL is invalid.** `claim_trip_job(v_job_id, v_lease := gen_random_uuid(), 300)`
     mixes a named arg before a positional one and `v_lease` isn't a param name. Declare a local
     `v_lease uuid := gen_random_uuid();` and reuse it: `select public.claim_trip_job(v_job_id, v_lease, 300)`
     then `select public.complete_trip_run(v_job_id, v_trip_id, v_lease, 'failed', 'save', '…', '{}'::jsonb)`;
     snapshot the counter inside the txn so 0→1→0 is deterministic.

  **[LOW, non-blocking]** a mismatched `p_trip_id` returns `false` (safe) but the runner can't
  distinguish it from benign supersession — keep the `won=false` log; ideally the RPC would signal a
  mismatch for alerting. Codex: does NOT block implementation.

  **Confirmed FIXED / validated this round:** `.is_()` (PostgREST 2.31.0 in `uv.lock`), the grep found
  exactly 3 idempotency lookups (main.py:373 / jobs.py:78 / live_run.py:169 — latter two filtered, the
  first is the HIGH-1 gap), CAS `trip_id` guard, conflict_retry wiring, and the full architectural core.
