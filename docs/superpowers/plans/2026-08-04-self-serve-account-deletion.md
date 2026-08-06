# Plan — Self-serve account deletion (full-rigor) + mem0 write-barrier + hardened `/admin`

> Draft 2026-08-04 · **Rev 4 (full-rigor / Direction A).** Folds the THIRD-round reviews of Rev 3
> — fable REVISE 8/10 + Codex `gpt-5.6-sol` BLOCK 5/10 — which AGREE on substance. Rev 4 fixes the
> destructive-boundary correctness gaps they found: fence-stage truthfulness, non-durable event-id
> capture, `barrier_blocked` with no exit, completion-sequencing contradiction, RLS service-role/DELETE/
> oracle gaps, and legally-material processor-premise errors (OpenAI tracing is ON by default).
> branch `zh` · Owner: backend lane (drive with subagents). Citations grounded 2026-08-04.
> Supersedes the *trigger* of `2026-08-03-user-data-erasure.md`; corrects its stale premise (clear-memory
> already exists on `zh`, gated).
> **Destructive + irreversible + legally-binding. Implement task-by-task; STOP after Task 1 for human
> review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**
> **ONE OPEN DECISION for ZH (§10-D1): mem0-add durability — light (registry+drain) vs heavy (durable
> leased add work-item). Rev 4 defaults to LIGHT; confirm before building T2.**

---

## 0. TL;DR + shape

A signed-in user deletes their own account **gracefully and provably**: reauth (OTP, `amr`-checked)
→ 7-day cancellable grace → a **durable, leased, staged background job** that (1) drains every
outstanding mem0 add to a terminal provider state — or escalates to a human when mem0's API cannot
prove it (`barrier_blocked`, with a defined operator-exit), (2) `delete_all` + verifies empty
(loop-until-stable), (3) hard-deletes `auth.users` (cascade 22 tables), (4) **instructs every downstream
processor** (OpenAI-trace / Resend / Render logs / Apify / PostHog? / mem0 / Supabase-backups) to delete
or documents the disclosed retention exception, (5) records a durable no-FK, HMAC'd audit with the CCPA
§7101 fields, (6) reaches `erasure_completed`, then **delivers** (webhook-confirmed) a completion notice
before the request reaches `response_delivered`. Plus a hardened `/admin` (founder allowlist + passphrase
step-up + fresh reauth, minting a short-lived signed capability).

**Full-rigor honest cost: ~13 tasks, multi-week.** Two ceilings are real and DISCLOSED, not hidden:
- **mem0:** a lost `add` HTTP response leaves no `event_id`, unrecoverable (no idempotency key / delete-
  fence) → the job holds in the non-terminal `barrier_blocked` state and escalates to a human rather than
  lying "done." An operator-exit resolves it (verified-manual-purge → resume, or complete-with-disclosed-
  exception).
- **processors:** some third parties (Render logs, Resend send-logs, Supabase backups, any pre-cutover
  OpenAI trace) retain data on a fixed window we cannot force to zero → the completion email states what
  was erased AND what remains under a disclosed, time-bounded exception.

Phases: **Foundation** (T1–T3) → **Engine** (T4) → **Self-serve + guards + RLS freeze** (T5–T6) →
**Sweep + durable notify** (T7–T8) → **Processor inventory** (T9) → **Admin + FE** (T10–T11) →
**Privacy/audit-retention + E2E** (T12–T13). Build in order; **STOP after Task 1** (non-destructive).

The mem0 event-id barrier (T2) is the linchpin **and** un-gates + un-lies the clear-memory button
(`SettingsView.tsx:8` still imports the mock) — one machine, both launch-gates (#2 + #4) closed.

---

## 1. Why + the decision

`/privacy` promises deletion + mem0 erasure (`frontend/app/privacy/page.tsx:131`); **no code executes it**
(no `backend/erasure.py`). We are making a PDPA/GDPR/CCPA promise we cannot keep. Clear-memory (`#2`)
exists but is **gated off** (`_CLEAR_RECONCILIATION_READY=False`, `main.py:310`; route `main.py:318`,
gate-return `main.py:330`) **and its Settings button still calls the MOCK** (`SettingsView.tsx:8`), so the
UI lies about success today. Account deletion (`#4`) is 100% missing.

**Decision (ZH, 2026-08-04): FULL RIGOR (Direction A).** Fold everything from all three review rounds; add
`barrier_blocked` escalation + exit, the per-processor deletion inventory, and webhook-confirmed
completion. Enterprise-grade, multi-week; still cannot promise 100% hands-off erasure (the two ceilings
are disclosed). Task 1 is a non-destructive stop-point cleared by all reviewers.

---

## 2. Verified facts (grounded 2026-08-04 · `file:line` re-checked, all exact in R3)

**Cascade / schema**
- `public.users.id → auth.users(id) ON DELETE CASCADE` (`20260701131304_identity_persona_foundation.sql:19`);
  22 user-owned tables cascade; 5 globals + `reel-covers` bucket survive. `users` has NO client UPDATE
  policy — its ONLY policy is `users_select_own` (`…:182`) — so status columns are service-role-write-only
  by construction (still pgTAP-regress, §3.11 / T12).

**mem0 barrier (BUILDABLE via event-id reconciliation — two contract items MUST be verified first)**
- `add()` → `POST /v3/memories/add/` returns `{status, event_id, results}`. Proposed terminal-poll
  `GET /v1/event/{event_id}/` → `PENDING|RUNNING|SUCCEEDED|FAILED`.
- **⚠ VERIFY-BEFORE-BUILD (T2 research gate):** mem0's official delete docs show `delete_all()` returning
  **`204` with NO `event_id`**; the installed SDK `delete_all` "blindly parses JSON"
  (`backend/.venv/.../mem0/client/main.py:1324`) and exposes **no event method** (`:1140`). If a 204/empty
  body is real, the delete leg's provability rests on **verify-empty + re-enumerate-until-stable**, not an
  event poll. Confirm the real `add`/`delete_all`/`event` contract (astrail-researcher, mem0 docs MCP)
  BEFORE T2 code; the design fails safe to `barrier_blocked` if the contract differs.
- The installed `AsyncMemoryClient` has no event method → a small raw-`httpx` adapter is required. No
  documented delete-fencing guarantee → verify-empty alone is insufficient; the reconciler is mandatory.
- **The add `event_id` is unrecoverable on the timeout path today.** `persist_trip_memory`
  (`preferences.py:306`) wraps the add in `asyncio.wait_for(mem0.add(...), timeout=5)` at `:348-351`; the
  whole response is discarded, and on timeout `asyncio.wait_for` **cancels the coroutine**, so the
  `event_id` never materializes (`except` at `:352-353`). See §3.2 for the durability-hardened fix and the
  §10-D1 decision — a **bare** `create_task` is NOT safe (`runner.py:553-554` documents "AWAITED — not
  create_task → no GC risk"; the loop keeps only weak task refs; `main.py:88 _spawn` is the existing
  strong-ref pattern; shutdown drains only the reaper `main.py:177`; the CLI cancels children under
  `asyncio.run` `scripts/live_run.py:310/:369`).

**Reauth (`amr` is the only unambiguous freshness signal; `iat` is NOT)**
- Re-running `signInWithOtp`→`verifyOtp` mints a new session (new `session_id`, fresh `amr[]`, fires
  `SIGNED_IN`) while signed in. Reuse `sign-in/page.tsx:101-136` as a modal.
- A silent refresh **re-stamps `iat` but does NOT append an `amr` entry** → **drop the `iat` fallback**;
  fail closed on missing/stale `amr`. **Not zero-cost:** `_decode` (`auth.py:93`; `jwt.decode` `:112`)
  returns **only `sub`** (`:124`) and `get_current_user_id_stashed` (`rate_limit.py:60`) stashes only the
  derived user_id — a **claims-returning refactor** is required to read `amr`.
- **CCPA §7061:** the reauth window (propose 300s) is a **product choice, not statutory** — confirm the
  primary reg before locking a number (§10 / legal).

**Durable job + RPC idiom (corrected names)**
- mem0's ONLY production writer is `persist_trip_memory` (`preferences.py:306`), reachable ONLY after a
  `jobs` row (`runner.py:561`). Job-creating paths to guard: `reserve_and_enqueue_trip_job`
  (`20260804000000_reserve_replay_on_exhausted.sql:15`; reserves `:56-61`,`:83-86`), the legacy **direct
  PostgREST insert `enqueue_job` (`jobs.py:73`, insert `:80` — NOT an RPC)** reached when
  `ENTITLEMENTS_ENABLED=false` via `_generate_trip_legacy` (`main.py:461`→`:510`), `create_organize_job`
  (`organizer.py:79`, RPC `create_saved_reels_organize_job:85`); RESOLVED to guard too:
  `capture_saved_reel` (`saved_reels.py:7`).
- Lease primitives (`jobs.py`): `mark_job_running` (`:96`, RPC `claim_trip_job`), `_renew_job_lease`
  (`:143`, RPC `renew_trip_job_lease`), `mark_job_done` fenced CAS on `lease_token` (`:117`, update
  `:138-139`), reaper `reclaim_expired_jobs` (`:212`, RPC `reclaim_expired_trip_jobs`). DB-clock
  (`clock_timestamp()`) decides expiry (`20260720170000_db_clock_job_leases.sql:68`,`:85`). CAS = single
  `UPDATE … WHERE <predicate> RETURNING`.
- No-FK durability pattern: mirror `geocode_country_cache` (`20260720110000_geocode_country_cache.sql`,
  FK-free `:22-35`, RLS+revoke+grant service_role `:39-41`). Deleted uid stored plain, no FK, HMAC'd.
- Schema gate: `scripts/assert_schema.py` `REQUIRED_SCHEMA` (`:63`) probes **columns only — can only run
  `table.select(cols).limit(0)` (`:9`,`:232`) and explicitly CANNOT inspect functions/RPC signatures
  (`:14`)** → the capability sentinel must be a **table+column** entry, not a "row/function" (§3.4).
  `memory_events` is already in the manifest → T2 extends its tuple with `event_id`.
- Rollback: `supabase/migrations/rollback/` exists but covers only 2/35 — real, not universal. Ship
  `_down.sql` twins for the new migrations.

**Client + service-role write paths that `pending_deletion` must freeze (Codex HIGH; sharper in R3)**
- `sign_out` cannot revoke an issued JWT. Direct client RLS writes: `traveler_profiles` upsert
  (`lib/trip/supabase-api.ts:27-28`), `reel_collections` insert/update/**delete** (`lib/reels/
  collections.ts:40/51/61`) + `reel_collection_items` upsert/**delete** (`:80/:88`). **DELETE policies are
  live** (`20260701131304:205/:242`, `20260718120000_saved_reels_foundation.sql:109`) and a `WITH CHECK`
  freeze does NOT cover DELETE.
- **Service-role bypasses ALL RLS** (documented `main.py:387`): a pending user can still write via
  service-role routes — e.g. **feedback** (`main.py:372`) — unless the route/RPC checks status. RLS alone
  is insufficient (§3.6).

**Processor reality (Codex R3 — corrects Rev 3's premises; legally material)**
- **OpenAI:** `Runner.run` is called WITHOUT disabling tracing (`genagents/place_extractor.py:279`,
  `narrator.py:106`, `restaurant.py:184`); Agents SDK tracing is **ON by default** and includes sensitive
  gen/tool data → a real trace store + Responses API default retention. "No retention" was FALSE.
- **Resend:** 30-day email-data retention; contact deletion ≠ send-log deletion.
- **Apify:** the sync call (`scrape/apify_direct.py:48`) sends the Reel URL, returns dataset items, and
  **never persists a run/dataset ID** → deletion needs an id we don't keep.
- **Render logs:** window is 7/14/30 (confirm the plan).
- **PostHog:** `posthog>=3.0.0` in `pyproject.toml:23` but **zero in-repo calls**; only a CSP entry
  (`next.config.ts:26`) → prove any flow or remove the dep.

---

## 3. Design

Invariant: the acted-on `user_id` is the authenticated caller's JWT `sub` (self-serve) or a founder-
supplied UUID resolved to exactly one account (`/admin`). **Never** client-supplied to the delete engine,
**never** `"*"`/`None`, **never** `reset()`.

### 3.1 Safety invariants
- **F1 — mem0 abort + provable barrier.** Purge is a strict wrapper over `clear_memory` translating its
  return: `"cleared"`→ok; `"unavailable"`→`MemoryBackendUnavailable`; `"unknown"`→`MemoryPurgeError`.
  Inherits all four `clear_memory` guards (`memory_clear.py:153`; marker + `_add_possibly_in_flight:123`;
  returns exactly `{cleared,unavailable,unknown}`). On the account path, erasure is **provable-for-known**
  and **explicitly-blocked-when-unprovable** (`barrier_blocked`), never probabilistic.
- **F2 — guard ≠ purge error.** `_assert_real_uuid` raises `InvalidUserId` (distinct), OUTSIDE every
  try/except, on every path. Catch **both `ValueError` and `TypeError`** (`uuid.UUID(None)` → TypeError).
- **F3 — canonical uuid.** `str(uuid.UUID(u)) == u` strict-equality (binding spec).
- **F4 — no erasure mid-flight, enforced ATOMICALLY at the DB, defence-in-depth.** (a) request-deletion
  RPC: `SELECT … FROM users WHERE id=p_user_id FOR UPDATE`, check/flip `account_status` UPDATE-users-first,
  reject if any non-terminal `jobs`/`organize_jobs` exists — ONE txn. (b) every job-creating RPC takes the
  same `FOR UPDATE` lock and rejects `account_status<>'active'`. (c) because legacy `enqueue_job`
  (`jobs.py:73`) is a **direct PostgREST insert**, a **`BEFORE INSERT` trigger on `jobs`/`organize_jobs`
  with `FOR SHARE` on the owner row** rejects inserts for non-active users — no present/future insert path
  slips through.
- **F5 — point of no return (fence).** The engine crosses ONE durable, fenced CAS from the cancellable
  drain phase into the destructive phase. **The fence stage is `purge_started` (a *started* marker), NOT
  `memory_purged` (a *completed* fact)** — see §3.3. Past the fence, cancel returns
  `409 deletion_already_started`. Codex R3 confirmed the cancel-vs-fence race is closed in BOTH commit
  orders; the only Rev-3 defect was the false completed-stage name, fixed here.

### 3.2 mem0 event-id write barrier (T2 — linchpin; un-gates + un-lies #2)
- **Persist event ids, intent-first, durably (§10-D1 decision).** Add `memory_events.event_id text`
  (nullable) + a cutover marker. Write the intent row first; run the add so a request-path timeout still
  yields an `event_id`. Rev 4 **default = LIGHT**: the add runs as an `asyncio.create_task` that is
  (1) held in a **module-level strong-ref registry** (add on create, discard in the done-callback —
  mirror `main.py:88 _spawn`, do NOT rely on the loop's weak refs); (2) **drained bounded on FastAPI
  lifespan shutdown** (extend the shutdown that today only awaits the reaper, `main.py:177`); (3) its
  done-callback **consumes the task exception** (else "Task exception was never retrieved") AND handles its
  own `memory_events` write-failure; (4) uses the module-singleton Supabase client that outlives the
  request. **Disclosed residual (LIGHT):** a process loss AFTER the add is issued but BEFORE the callback
  writes → a NULL-`event_id` row → that user's future deletion goes `barrier_blocked` (resolvable via the
  §3.3 operator-exit). Render restarts on every deploy, so this is **deploy-correlated**, not purely
  "rare" — acceptable for beta ONLY with the operator-exit in place. **HEAVY alternative (§10-D1):** make
  each mem0 add its own durable leased work-item (its own `jobs`-style row) so the `event_id` is captured
  under a lease with retry — no process-loss hole, at the cost of a new subsystem on the trip hot path.
  **Fix the stale comment:** update `runner.py:553-554` ("not create_task → no GC risk") in T2.
- **Poll adapter — hardened.** `backend/mem0_events.py`: raw `httpx` to a **fixed origin with redirects
  disabled**, `Authorization: Token <MEM0_API_KEY>`, 4 states, **exponential backoff + jitter (not fixed
  500ms — a 17-min backlog = thousands of calls)**, honor `Retry-After`, bounded concurrency, per-status
  handling (404/401/403/429/5xx), UUID-validate every id, timeout-bounded, keeps the deletion lease alive
  and re-checks cancellation while draining. Isolated + monkeypatchable.
- **`barrier_blocked` — disclosed ceiling WITH an exit (§3.3).** Two unprovable cases → the job does NOT
  auto-complete; it enters `barrier_blocked` (non-terminal), **releases its lease**, and escalates: (i) an
  add whose HTTP response was lost (no `event_id`) — can NEVER self-resolve; (ii) an id stuck non-terminal
  past the drain bound — CAN later go terminal. §3.3 defines re-drain vs operator-exit per case.
- **Cutover / backfill.** Pre-migration rows have NULL `event_id` forever. Scope "outstanding" to rows
  after the cutover marker; a NULL-`event_id` **young** row inside the in-flight window still forces
  `unknown`/hold — the event-state check is a fallback lattice ON TOP of `_add_possibly_in_flight`'s time
  window, it does NOT replace it.
- **Clear-memory (sync, a1):** layer the real event-state check onto the elapsed window; tail-timeout still
  returns `"unknown"`. Flip `_CLEAR_RECONCILIATION_READY=True` (`main.py:310`) in the same PR + re-run
  `smoke_memory_clear.py`. **Rewire the UI:** `SettingsView.tsx:8` stops importing `clearMemory` from
  `mock-api`; the button calls the real `POST /settings/memory/clear`, surfacing `memory_unavailable` /
  `memory_clear_unknown` honestly. Closes #2 and its lying UI.
- **Account-delete (async, a2 — provable):** the deletion job drains all outstanding event_ids to terminal
  (no HTTP-timeout bound), then `delete_all` (+ poll its event_id IF the contract exposes one — §2 ⚠),
  then **verify-empty + re-enumerate until the drain set is stable**. Load-bearing test: an old add
  materializes after the first empty read → deletion re-drains, never completes early.

### 3.3 Durable staged deletion job (`deletion_jobs` — T3 schema, T4 engine)
Mirror `jobs.py` leasing. **`status` and `stage` are DISTINCT**, and every stage write is a fenced CAS on
`(id, lease_token, expected_stage)` (make this explicit in T4 — not merely "mirror jobs.py"):
- **`status`** (lifecycle): `scheduled | running | retryable | barrier_blocked | awaiting_delivery |
  cancelled | overdue | completed | failed`. Non-terminal = `{scheduled, running, retryable,
  barrier_blocked, awaiting_delivery, overdue}`.
- **`stage`** (monotonic progress): `claimed → memory_hold → [FENCE] purge_started → memory_purged →
  auth_delete_started → auth_deleted → processors_notified → erasure_completed`.
- **Partial unique index = one active deletion per user** (mirror the entitlement arc):
  `UNIQUE (user_id) WHERE status IN (non-terminal)`. Requesting deletion atomically cancels any prior
  active job with the status flip.
- Columns: `id`, `user_id` (plain uuid, no FK, HMAC'd in audit), `status`, `stage`, `lease_token`,
  `lock_expires_at` (DB-clock), `attempts`, `last_error`, `next_attempt_at`, `statutory_deadline`,
  `scheduled_for`, `barrier_blocked_reason`, `recipient_email` (captured pre-delete), timestamps.

`erase_user(client, mem0, deletion_job)` stages:
1. `_assert_real_uuid` + re-check lease token + `account_status='pending_deletion'` **before EACH
   irreversible step**.
2. **`memory_hold`** — barrier drain (§3.2 a2), cancellable. Unprovable → `barrier_blocked` (§3.3-BB).
3. **FENCE (F5):** fenced CAS `UPDATE deletion_jobs SET status='running', stage='purge_started'
   WHERE id=$1 AND lease_token=$2 AND stage='memory_hold' AND status='running' RETURNING`. 0 rows ⇒ cancel
   won ⇒ abort. Point of no return; cancel past here = 409. **`purge_started` is a *started* marker.**
4. `purge_account_memory` (F1 abort) → verify-empty → **re-enumerate + loop until stable** → THEN write
   stage `memory_purged`. **Recovery from `purge_started` RE-RUNS the purge** (delete_all+verify is
   idempotent) — closes the Rev-3 crash-window where a false `memory_purged` let recovery skip the purge
   and hard-delete with mem0 intact.
5. Storage preflight (`reel-covers` service-role-owned → expected clear; assert).
6. **Capture `recipient_email` + enqueue the completion-notification intent NOW (before auth delete)** —
   auth delete removes the address from `auth.users` (§3.7). Then persist `auth_delete_started` BEFORE the
   call, then `auth.admin.delete_user(uid, should_soft_delete=False)` → cascade → stage `auth_deleted`. On
   recovery from `auth_delete_started`, **absence of the auth user = idempotent success** (the 404 is
   correct, enabled by the persisted started-marker).
7. Processor-deletion instructions (§3.9 / T9) → stage `processors_notified`.
8. Write audit + stage **`erasure_completed`** and set status **`awaiting_delivery`** — **do NOT mark the
   request `completed` here** (Codex B5). The completion notice must be DELIVERED first.
9. On a signed Resend **delivered** webhook (or an audited manual-response proof), transition status
   `awaiting_delivery → completed` (`response_delivered`). A permanent bounce → operator manual-response
   path (§3.7); the user must still receive the outcome via a durable channel.

**`barrier_blocked` protocol (§3.3-BB — new, Codex B3/fable I1):**
- On entry: set `status='barrier_blocked'`, write `barrier_blocked_reason`, **release the lease**
  (`lease_token=NULL`, `lock_expires_at=NULL`). The partial-unique index still holds the slot (still
  non-terminal — correct: the deletion is unfinished).
- **Case (ii) stuck-PENDING:** the sweep re-claims with `next_attempt_at` backoff and re-drains; on
  terminal it proceeds past the fence.
- **Case (i) lost-response:** NO auto-retry (nothing to poll). Waits for an operator action.
- **Admin actions (capability-gated, audited — §3.10):** `resume` (operator recorded a verified manual
  mem0 check → re-enter `memory_hold`); `complete_with_exception` (record the disclosed residual in
  `barrier_blocked_reason`, proceed past the fence, completion email names the residual); `deny_with_reason`
  (rare; durable notice to the user). Each is a CAS on `(id, status='barrier_blocked')`.
- **Statutory clock keeps running while blocked** → a **user-facing DELAY notice email** fires when the
  hold crosses `statutory_deadline` (§3.7) — operator escalation ALONE is not a compliant response.
- **Expedite = set `scheduled_for=now()` with a floor > the mem0 write-back bound** (so a just-issued add
  is still observable), never an independent erasure.

### 3.4 Deployment gate — one transactional migration + capability sentinel (T3)
- ONE **transactional** migration: `users` columns + `deletion_jobs` + `erasure_audit` +
  `notification_outbox` + the `BEFORE INSERT` triggers + all RPC bodies + grants + a **capability
  sentinel that is a real table+column in `REQUIRED_SCHEMA`** (all-or-nothing txn ⇒ any one column of the
  migration proves it landed — the columns-only gate CAN see this; a "row/function" cannot). Precedent:
  the entitlement arc used `jobs.charge_kind` as the observable proxy.
- Extend `assert_schema.py` `REQUIRED_SCHEMA` (same PR): `memory_events += event_id` (T2), `users` status
  columns, `deletion_jobs`, `erasure_audit`, `notification_outbox`.
- **A separate live RPC semantic smoke** (call each new RPC with a benign/rollback probe) runs BEFORE the
  flag flip, since `assert_schema` cannot see RPC signatures.
- **`_DELETION_EXECUTION_READY` (fail-closed) gates request-acceptance AND admin-expedite AND the worker.**
  Its flip is T13.
- **FE/privacy rollout:** `privacy/page.tsx:131` already promises deletion. Until the flag flips, **keep
  the "email us" mail intake and HIDE the self-serve control** (a FE readiness gate) — never ship a
  visible deletion button that deterministically 503s. T11 respects this.
- `_down.sql` twins for every new migration.

### 3.5 Soft-delete state + reauth (T5)
- Migration: `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion')`,
  `deletion_requested_at timestamptz`, `deletion_scheduled_for timestamptz`. Service-role-write-only.
- **`require_fresh_reauth(max_age_s=300)`** (`auth.py`): a **claims-returning `_decode` refactor** surfaces
  `amr`; require an `amr[].timestamp` with an allowed method within `0 ≤ now-amr.ts ≤ 300` (+ skew),
  fresh-token-subject == the account, **no `iat` fallback**. Apply to the two deletion endpoints **AND the
  admin capability-mint route** (§3.10). **Assert `amr` presence against a REAL Astrail Supabase token in
  T5/T11.**
- Authoritative account-status/existence check on deletion/cancel/admin + memory/work endpoints (a light
  `users` read on these few routes; not global).
- `request_account_deletion(p_user_id)` RPC — `FOR UPDATE` + UPDATE-users-first CAS `active→pending_
  deletion`, reject non-terminal jobs, `deletion_scheduled_for = coalesce(…, now()+INTERVAL '7 days')`,
  DB-clock, create the `deletion_jobs` row (partial-unique).
- `cancel_account_deletion(p_user_id)` RPC — CAS `pending_deletion→active` **only while stage is
  pre-FENCE**; past the fence → `409`. Endpoint additionally requires fresh reauth `> deletion_requested_at`.
- Endpoints `POST /account/deletion` + `/cancel`: `require_fresh_reauth`; `sign_out(jwt, scope="global")`
  using the **raw Authorization header**; treat sign_out failure as recorded/retried, not success; FE
  clears local session after 200. (`sign_out` alone doesn't stop a live token — §3.6.)

### 3.6 Freeze — pending ≠ deactivated (T6; Codex HIGH, sharpened)
`pending_deletion` must be load-bearing across BOTH RLS and service-role write paths:
- **RLS, oracle-safe:** a `security definer` helper **bound to `auth.uid()` with NO argument**
  (`public.caller_account_active() returns boolean`, `search_path=''`) — avoids the account-status oracle
  a `(uid)` arg would create via PostGREST. Add `AND public.caller_account_active()` to the `WITH CHECK`
  of every user-owned-table INSERT/UPDATE/UPSERT policy.
- **DELETE is a mutation → freeze it too:** add a `USING public.caller_account_active()` guard to the live
  authenticated DELETE policies (`20260701131304:205/:242`, `20260718120000:109`, collections/items). (Or,
  if ZH prefers, document deletes as a deliberate erasure-aligned carve-out — Rev 4 recommends FREEZE for
  "no mutation" clarity; §10-D2.)
- **Service-role writes bypass RLS** (`main.py:387`) → add an explicit `account_status='active'` check in
  the concrete service-role write routes/RPCs. **Enumerate them in T6** (known: feedback `main.py:372`);
  the pipeline's own writes are upstream-blocked by F4 (request RPC rejects while non-terminal jobs exist);
  **global write-through caches stay writable** (they carry no per-user PII gate).
- pgTAP (T12) proves a `pending_deletion` user cannot insert/update/delete any user-owned row; the loop is
  **generated from `information_schema`** so later tables inherit the check.

### 3.7 Durable completion notifications + delivery confirmation (T8; Codex HIGH + B5)
`backend/notifications.py` + a **durable `notification_outbox`**: one row per notification with `lease`,
`attempts`, `next_attempt_at`, a **stable idempotency key**, and a **terminal delivery state**. Email +
message intents are **captured BEFORE auth deletion** (§3.3 step 6). Resend direct HTTP with
**`Idempotency-Key`** (24h). Notices: scheduled (date + cancel link), cancelled, **DELAY** (hold crossed
`statutory_deadline`), **completed** (GDPR Art.12 / CCPA response), failure/operator alert.
- **Completion = delivered:** the request reaches `completed`/`response_delivered` ONLY on a signed Resend
  **delivered** webhook or an audited manual-response proof (§3.3 steps 8–9). A permanent bounce → operator
  manual-response path. Define when local + Resend PII is dropped (after terminal). **Resend itself retains
  send-data 30 days → the completion email is a disclosed exception** named in §3.9. Best-effort send never
  blocks a state transition; the outbox guarantees eventual delivery + retry.

### 3.8 Background sweep (T7)
- **Separate bounded deletion semaphore** (1 worker fine for beta) — do NOT share `_RECOVERY_SEM`.
  `claim/renew/reclaim_deletion_job` RPCs mirror `jobs.py`. Extend `_reap_loop` with a **third branch in
  its OWN try** (a deletion error must not skip trip/organize recovery) + boot re-sweep. The claim is the
  dedup. **Re-claims `barrier_blocked` case-(ii) rows** on `next_attempt_at` backoff; leaves case-(i) for
  the operator (§3.3-BB).
- **Overdue/failure:** `status` drives it — `retryable` w/ backoff; `overdue` when `statutory_deadline`
  passes (fires the DELAY email); `barrier_blocked` → admin overdue view + operator alert. Gated by
  `_DELETION_EXECUTION_READY`.

### 3.9 Processor-deletion inventory (T9 — full-rigor A; Codex B4, premises corrected)
Complete erasure ≠ the 22 DB tables (CCPA §7022 / GDPR 17+19 require instructing processors). **T9 OPENS
with "does any data flow at all, per processor?"** — verify-first, because the completion email is the
legally-binding artifact. For EACH: correlation key · delete API or runbook · retention exception (window)
· retry proof · completion criterion.
- **OpenAI trace store** — tracing is ON by default at `genagents/place_extractor.py:279`,
  `narrator.py:106`, `restaurant.py:184`. **Primary mitigation: DISABLE tracing going forward**
  (`set_tracing_disabled(True)` / `RunConfig(tracing_disabled=True)`), shrinking future retention to ~0;
  for pre-cutover traces + Responses API data, document the provider retention window as a disclosed
  exception (confirm whether ZDR/no-retention is available).
- **Resend** — address keyed; send-log 30-day retention is the disclosed exception; contact deletion if
  Audiences are ever used.
- **Apify** — TODAY no run/dataset id is persisted (`scrape/apify_direct.py:48`) → either start persisting
  the run id to enable dataset deletion, or document that no per-user artifact is retained beyond the sync
  response (verify which is true).
- **Render logs** — no per-user delete API → disclosed retention-window expiry (confirm 7/14/30).
- **PostHog** — prove a stable Astrail-UUID `distinct_id` is actually emitted + all projects/regions;
  if unused (current in-repo evidence), **remove the dep + CSP entry** → 4 processors.
- **mem0 itself** — the barrier + `delete_all` + verify-empty is its erasure; name it in the inventory.
- **Supabase backups** — named backup window + restore-and-reapply-erasure posture (§3.12).
The **completion email states what was erased AND what remains under a disclosed, time-bounded exception**.

### 3.10 Hardened `/admin` (T10; Codex HIGH admin capability + #9/#13, fable overdue view)
`require_admin`: (1) valid JWT; (2) **founder allowlist** `ADMIN_USER_IDS` — **fail-closed at REQUEST
time** (403 if unset/malformed + loud boot log), NOT boot-fatal; (3) **founder still exists + active**;
(4) **step-up on EVERY `/admin` route incl. GET** — passphrase (`X-Admin-Passphrase`)
`hmac.compare_digest` vs `ADMIN_ACTION_SECRET`. The **capability-mint route ALSO requires fresh `amr`
reauth** (restored — Codex R3: Rev 3 had dropped it) and mints a short-lived **signed capability token**:
`iss`, `aud=astrail-admin`, founder `sub`, original `session_id`, `iat/nbf/exp/jti`, **≤5-min**,
memory-only in the browser, **alg-pinned + `none` forbidden + future-ts rejected**, verify allowlist +
active on every use. **Define the capability signing-key + rotation contract** (separate from
`ADMIN_ACTION_SECRET`; startup-validated high entropy). Lockout keyed **primarily on founder UUID**
(+ secondary trusted-proxy bucket; never raw forwarded IP), TTL + exponential backoff. Endpoints:
`GET /admin/accounts` (status list), cancel, **expedite**, **overdue view**, and the **`barrier_blocked`
resolution actions** (`resume`/`complete_with_exception`/`deny_with_reason` — §3.3-BB). All audited.

### 3.11 Frontend (T11)
Delete card (destructive styling, mirror `SettingsView.tsx:126/130`) → OTP re-challenge modal (reuse
`sign-in/page.tsx`) → confirm → `POST /account/deletion` with the fresh token; clear local session on 200.
Pending banner ("deletes on {date} — Cancel", cancel re-challenges). `middleware.ts` third check
(`pending_deletion`) is UX gating only. **The self-serve control is HIDDEN behind the readiness gate until
`_DELETION_EXECUTION_READY`** (§3.4) — no visible 503 button; "email us" stays until flip. The rewired real
clear-memory button lands here too (from T2). `backend-types.ts` mirrors all new shapes (guardrail #4).

### 3.12 Privacy honesty + audit retention (T12; Codex #10 + audit-retention + Legal)
Replace "email us" with the self-serve flow + 7-day grace (coupled to the flag flip, §3.4). Precise
carve-out: shared entries are **public-source cache data no longer linked to an Astrail account** (NOT
"de-identified"); state the **actual Supabase backup retention window + restore-and-reapply-erasure
procedure**; disclose the processor exceptions (§3.9). **HMAC the audit uuid**; the audit schema
**enumerates the CCPA §7101 request/response fields + the denial basis**, retained **≥24 months**, with a
defined **HMAC-key lifecycle** and **purge of raw uid/email** (HMAC stays linkable while key+source
persist). RLS regression (pgTAP, `information_schema`-generated) proves no client write/delete path to any
deletion-state column and the §3.6 freeze; ship Pydantic + TS + SQL + `assert_schema.py` together.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Fault-inject / gate focus |
|---|------|---------------------------|
| 1 | **Core choke-point** — `_assert_real_uuid` (F2/F3; catch ValueError+TypeError; strict equality; OUTSIDE try) + `purge_account_memory(client, mem0, user_id)` (strings→exceptions wrapper over `clear_memory`; **note the `client` arg — needed to arm the marker `memory_clear.py:172`**) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` (`backend/erasure.py`,`test_erasure.py`) | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; `≠"cleared"` ⇒ raise (BEHAVIORAL); guard≠purge error. **Non-destructive stop-point. Gates stay False; nothing imports it.** |
| 2 | **mem0 event barrier** (research gate first: verify `add`/`delete_all`/`event` contract, §2 ⚠) — `memory_events.event_id` + **durable intent-first capture (registry+lifespan-drain — §10-D1)** + hardened `mem0_events.py` + reconciler w/ `barrier_blocked` + clear-memory event-state layered on the window + flip `_CLEAR_RECONCILIATION_READY` + rewire `SettingsView` button → real POST + fix `runner.py:554` comment + re-run smoke | old add materializes after first empty read → re-drain; timeout no longer loses `event_id`; process-loss residual is registry-drained or → `barrier_blocked` (not silent); NULL-`event_id` young row forces `unknown`; #2 un-gate + un-lie verified |
| 3 | **Schema + deploy gate** — ONE txn migration (status columns + `deletion_jobs` status⊥stage + partial-unique + `erasure_audit` no-FK/HMAC/§7101-fields + `notification_outbox` + `BEFORE INSERT` triggers + RPC bodies + **table+column sentinel**) + `assert_schema` manifest + **RPC semantic smoke** + `_DELETION_EXECUTION_READY` (gates request+expedite+worker) + `_down` twins | both deploy orders; drift gate fails code-first; sentinel is a real column; RPC smoke catches signature drift; trigger blocks the direct `enqueue_job` insert; audit has no cascade FK |
| 4 | **`erase_user` engine** (staged, leased, idempotent; per-stage CAS on id+lease+expected-stage; **fence writes `purge_started`; `memory_purged` only after verify-stable; recovery from `purge_started` RE-PURGES**; `auth_delete_started` before delete; recipient captured pre-delete; ends at `erasure_completed`+`awaiting_delivery`, NOT `completed`) | mem0 unavailable aborts BEFORE delete; cancel pre-fence aborts / post-fence 409; **crash between fence and delete_all → recovery re-purges before auth delete**; 404=success only with `auth_delete_started`; globals untouched; audit not "completed" on enqueue |
| 5 | **Soft-delete + reauth + atomic guards** — request/cancel RPCs (`FOR UPDATE`, UPDATE-users-first) + convert/guard legacy `enqueue_job` + `require_fresh_reauth` (claims-returning `_decode`, `amr`-only, NO iat) on deletion endpoints **+ admin-mint route** + status guard in every creator RPC incl. `capture_saved_reel` + `sign_out`(raw jwt) | reauth required (stale/refresh 401); cancel needs freshness>requested_at; job-create blocked when pending (atomic, both commit orders); re-request doesn't reset clock; guard-fail 500 not 200; `amr` asserted vs a REAL token |
| 6 | **Freeze (pending ≠ deactivated)** — no-arg `caller_account_active()` (oracle-safe) in `WITH CHECK` on every user-owned INSERT/UPDATE/UPSERT policy **+ `USING` on DELETE policies** + **explicit service-role write-route guards (enumerate: feedback `main.py:372`, …)** + keep caches writable | a `pending_deletion` token cannot insert/update/**delete** profiles/collections/items; service-role feedback rejected; caches still write; reads+cancel+privacy allowed; no status oracle |
| 7 | **Deletion sweep** — separate semaphore + `claim/renew/reclaim_deletion_job` + `_reap_loop` third branch (own try) + boot re-sweep + overdue/retryable + **`barrier_blocked` re-claim (case ii) / leave (case i)** + DELAY-email trigger | cancelled-pre-fence aborts; no double-dispatch; deletion error doesn't skip trip recovery; case-ii re-drains w/ backoff, case-i doesn't busy-loop; deadline → DELAY email |
| 8 | **Durable notifications + delivery** — Resend HTTP + `notification_outbox` (lease/attempts/idempotency-key/terminal) + intent-captured-pre-auth-delete + **signed delivery webhook → `response_delivered`** + DELAY + permanent-bounce operator path + PII drop after terminal | send failure retried, never blocks state; request NOT `completed` until delivered; bounce → operator; hold past deadline → user DELAY notice; PII dropped after terminal |
| 9 | **Processor inventory** — verify-first per processor; **disable OpenAI tracing** + document trace/Responses retention; Resend 30-day send-log exception; Apify (persist run-id or document none); Render window; PostHog (prove-or-remove); mem0 + Supabase-backups rows; completion email states erased + residual-with-window | each processor: delete-path OR documented time-bounded exception; email wording matches the inventory; NO unqualified "fully erased" claim; no assumed API |
| 10 | **Hardened `/admin`** — allowlist(request-time fail-closed)+founder-active+passphrase step-up **+ fresh-`amr` reauth on mint** → **signed capability token (full spec + key-rotation contract)** + uuid-keyed lockout + GET/cancel/expedite/overdue + **`barrier_blocked` resolution actions** | non-founder 403; bad passphrase lockout+backoff; `compare_digest` (fault-inject `==`); GET needs step-up; alg-confusion/future-ts/expired/`none` rejected; mint needs fresh amr; expedite sets schedule; resume/complete_with_exception CAS-guarded |
| 11 | **Frontend** — delete card + OTP modal + pending banner + cancel + middleware + admin page + rewired clear-memory + `backend-types` + **readiness-gated self-serve (hidden until flag; "email us" until then; no visible 503)** | fresh token sent; failure never shows deleted; pending gates generation (backend is real guard); self-serve hidden pre-flip |
| 12 | **Privacy carve-out + audit retention + RLS pgTAP** — HMAC audit + §7101 fields + ≥24mo + HMAC-key lifecycle + raw-PII purge + actual backup window + restore-and-reapply + processor-exception disclosure + `information_schema`-generated pgTAP | wording matches code + inventory; pgTAP proves no client write/**delete** path + §3.6 freeze incl. service-role; audit retention/purge honored |
| 13 | **Live E2E gate** — seed user+trip/reel+mem0 → reauth+request (status flip, gen blocked) → force grace lapse → sweep drains→delete_all+verify(loop)→auth-delete → assert 22 tables empty, globals intact, mem0 reconciled+empty, audit stages + §7101 fields, completion email **delivered** (webhook), processors instructed; **inject an unprovable add → `barrier_blocked` → operator `complete_with_exception` path**; flip `_DELETION_EXECUTION_READY`; + #2 un-gate check | the cascade+barrier+processor+delivery PROOF on rebased local schema; barrier_blocked exit proven; crash-between-fence-and-delete recovery re-purges |

Deferrals: §8.

## 5. Test / verification
- Unit T1–T12; `_assert_real_uuid`/`purge_account_memory` adversarial (each guard reddens ALONE — no
  "tests that cannot fail"; the reuse test is behavioral, not mock-called-vacuous).
- mem0 barrier: "late-materializing add", "unprovable → barrier_blocked", and "process-loss → registry
  drain vs barrier_blocked" are load-bearing.
- Two-session concurrency: F4 (both commit orders) + the F5 cancel-vs-fence race + the
  crash-between-fence-and-delete_all recovery-re-purge.
- Completion: assert the request is NOT `completed` until a delivered webhook; bounce → operator path.
- Cascade+barrier+processor+delivery proof = T13 (rebased local Postgres; 22-table list from
  `information_schema`).
- `uv run pytest evals/ -q` green after every backend change (anchor `6229.0` immovable); `tsc`+`vitest`+
  `pytest` green per task. `/qa` on the delete/cancel/reauth flow (required).

## 6. Risks & mitigations
- Orphaned/unprovable memory → provable-for-known barrier + `barrier_blocked` (with operator-exit) +
  abort-on-unavailable + verify-empty-until-stable.
- Over-delete (`"*"`/`None`) → single `_assert_real_uuid` choke; engine never takes client uid.
- Purge/delete a cancelled account → status re-check each step + F5 fenced `purge_started`
  (cancel post-fence = 409); expedite=schedule-only.
- **Crash mid-purge → skipped purge (Rev-3 bug)** → fence writes `purge_started`, not `memory_purged`;
  recovery re-purges before auth delete.
- **Lost late event_id (create_task GC/restart)** → registry + lifespan drain; disclosed residual →
  `barrier_blocked` (never silent). Heavy option (§10-D1) removes the residual.
- New writes after request → atomic `FOR UPDATE` status guard in every creator RPC + `BEFORE INSERT`
  trigger + §3.6 RLS/service-role/DELETE freeze (oracle-safe helper).
- Lost deletion record → intent-first no-FK staged audit; crash-resume from `auth_delete_started`.
- Stolen/refreshed token → `amr`-only reauth (no iat), freshness>requested_at, status/existence, session
  clear.
- **"Completed" while undelivered (Rev-3 bug)** → `erasure_completed` ≠ `response_delivered`;
  `awaiting_delivery` until a webhook/manual proof; DELAY email on deadline.
- Incomplete/oversold erasure vs processors → §3.9 verify-first inventory + disable OpenAI tracing +
  disclosed-exception completion email.
- Deploy skew → one txn migration + column sentinel + RPC smoke + `_DELETION_EXECUTION_READY` (gates
  request too) + hidden self-serve pre-flip.
- Recovery starvation → separate deletion semaphore + per-branch try.
- `/admin` compromise → step-up-on-all + founder-active + fresh-amr mint + signed capability (alg/ts-
  hardened + key rotation) + uuid-keyed lockout.
- Promise false → precise policy + HMAC audit + §7101 fields + named backup window + ≥24mo retention.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Full rigor / Direction A ✅ · self-serve graceful ✅ · 7-day grace ✅ · `/admin` login+passphrase step-up
+ fresh-amr mint (not bare PIN) ✅ · reuse `clear_memory`/`jobs.py`/`request_seat`/`geocode_country_cache`
patterns ✅ · un-gate + un-lie clear-memory in T2 ✅ · `capture_saved_reel` gated on status ✅ · completion
= webhook-confirmed delivery (`erasure_completed` ≠ `response_delivered`) ✅ · processor inventory in-scope
+ disable OpenAI tracing ✅ · fence stage = `purge_started` (recovery re-purges) ✅ · DELETE frozen (§10-D2
recommended) · capability sentinel = table+column + RPC smoke ✅.

## 8. Deferrals (with triggers)
- **HEAVY mem0-add durability** (each add its own durable leased work-item) → adopt when deploy-correlated
  `barrier_blocked` volume exceeds operator capacity, or post-beta (§10-D1). LIGHT ships now.
- Dedicated external deletion worker → once durable claims + separate semaphore exist and load demands it.
- KV-backed admin lockout → past one Render instance.
- Rich admin dashboard → post-beta (overdue view + cancel/expedite + barrier resolution ship now).
- MFA/AAL step-up → when an MFA feature exists (OTP reauth suffices now).
- Per-request DB existence check on ALL routes → only destructive/admin/memory routes now.

## 9. Review folds
**Rev 1 → Rev 2:** (see git history / prior rev) — fable F-1…F-11 + Codex #1…#14 folded.
**Rev 2 → Rev 3:** folded both R2 lists in full (see handoff §5).
**Rev 3 → Rev 4 (this rev):** — fable R3: C1→§3.1 F5/§3.3 (fence `purge_started`, recovery re-purges) ·
I1→§3.3-BB (barrier_blocked exit) + §3.7 (DELAY email) · I2→§3.2/§10-D1 (registry+drain, comment fix) ·
M1→§2/§3.9 (processor premises) · M2→§3.6 (DELETE frozen) · M3→§3.6 (service-role enum) · M4→§3.4 (column
sentinel) · M5→§3.10 (mint reauth) · M6→§3.4/§3.11 (readiness-gated FE) · Task-1 sig→T1/§6. — Codex R3:
#1 create_task-durability→§3.2/§10-D1 · #2 fence-stage→§3.1/§3.3 · #3 barrier-exit→§3.3-BB · #4 completion-
sequencing→§3.3 steps 8-9/§3.7 · #5 RLS service-role+DELETE+oracle→§3.6 · #6 processor-premises→§2/§3.9 ·
#7 sentinel+FE-503→§3.4/§3.11 · admin-mint-reauth+key-rotation→§3.10 · §7101 audit fields→§3.12 · mem0-SDK
204/no-event→§2 ⚠/T2 research gate.

## 10. Open items / decisions for the re-review
- **D1 (DECISION — ZH): mem0-add durability.** LIGHT (registry + lifespan drain; disclosed deploy-
  correlated `barrier_blocked` residual) vs HEAVY (each add a durable leased work-item; no residual, new
  hot-path subsystem). **Rev 4 defaults LIGHT + operator-exit.** Confirm before building T2.
- **D2 (DECISION — ZH): DELETE freeze** — freeze client deletes during `pending_deletion` (Rev 4
  recommends) vs document them as a deliberate erasure-aligned carve-out.
- **mem0 `delete_all`/`event` contract (§2 ⚠)** — verify the 204/no-event_id case BEFORE T2.
- **CCPA §7061 reauth window** — 300s is a product choice; confirm the primary reg.
- **`amr[].timestamp` live shape** — confirm a real Astrail Supabase token carries it (T5/T11).
- **Processor confirmations (T9 verify-first):** OpenAI ZDR/no-retention availability; Apify id-persist vs
  none; Render window (7/14/30); PostHog used-or-remove; the actual Supabase backup window (§3.12).

_Re-review status: Rev 4 pending — recommend a FOURTH round (fable + Codex) after ZH resolves D1/D2, since
Rev 4 folds correctness fixes at the destructive boundary that warrant re-confirmation._
