# Plan — Self-serve account deletion (full-rigor) + mem0 write-barrier + hardened `/admin`

> Draft 2026-08-04 · **Rev 3 (full-rigor / Direction A).** Folds BOTH Rev-2 reviews
> (fable REVISE 8/10 · Codex `gpt-5.6-sol` BLOCK 4/10) in full, and pulls A's in-scope pieces
> — `barrier_blocked` operator-escalation state, per-processor deletion inventory, webhook
> delivery-confirmation — out of "deferred" and into numbered tasks.
> branch `zh` · Owner: backend lane (drive with subagents). Citations re-grounded 2026-08-04.
> Supersedes the *trigger* of `2026-08-03-user-data-erasure.md` (reuses its `erase_user` core idea);
> corrects its stale premise (clear-memory already exists on `zh`, gated).
> **Destructive + irreversible + legally-binding. Implement task-by-task; STOP after Task 1 for
> human review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**

---

## 0. TL;DR + shape

A signed-in user deletes their own account **gracefully and provably**: reauth (OTP, `amr`-checked)
→ 7-day cancellable grace → a **durable, leased, staged background job** that (1) drains every
outstanding mem0 add to a terminal provider state — or escalates to a human when mem0's API cannot
prove it (`barrier_blocked`), (2) `delete_all` + verifies empty (loop-until-stable), (3) hard-deletes
`auth.users` (cascade 22 tables), (4) **instructs every downstream processor** (PostHog / Resend /
Render logs / Apify / OpenAI) to delete or documents the disclosed retention exception, (5) records a
durable no-FK, HMAC'd audit, (6) **delivers** (webhook-confirmed) a completion notice. Plus a hardened
`/admin` (founder allowlist + passphrase step-up minting a short-lived signed capability).

**Full-rigor honest cost: ~13 tasks, multi-week.** The mem0 ceiling is real and disclosed: a lost `add`
HTTP response leaves no `event_id`, and mem0 has no idempotency-key / delete-fence to recover it, so a
rare add is **unprovably-erasable** → the job holds in a non-terminal `barrier_blocked` state and
escalates to a human rather than lying "done." That is a mem0 limitation, not a plan defect (Codex R2).

Natural phases: **Foundation** (T1–T3) → **Engine** (T4) → **Self-serve + guards + RLS freeze**
(T5–T6) → **Sweep + durable notify** (T7–T8) → **Processor inventory** (T9) → **Admin + FE** (T10–T11)
→ **Privacy/audit-retention + E2E** (T12–T13). Build in order; **STOP after Task 1** (non-destructive).

The mem0 event-id barrier (T2) is the linchpin **and** un-gates the clear-memory button and rewires its
still-lying UI (fable HIGH-1) — one machine, both launch-gates (#2 + #4) closed.

---

## 1. Why + the decision

`/privacy` promises deletion + mem0 erasure; **no code executes it** (no `backend/erasure.py`). We are
making a PDPA/GDPR/CCPA promise we cannot keep. Clear-memory (`#2`) already exists but is **gated off**
(`_CLEAR_RECONCILIATION_READY=False`, `main.py:310`; route `main.py:318`, gate-return `main.py:330`)
awaiting the exact mem0 reconciliation this plan builds — **and its Settings button still calls the
MOCK** (`SettingsView.tsx:8` imports `clearMemory` from `mock-api`), so the UI lies about success today.
Account deletion (`#4`) is 100% missing.

**Decision (ZH, 2026-08-04): FULL RIGOR (Direction A).** Fold everything from both R2 reviews; add the
`barrier_blocked` escalation and the per-processor deletion inventory and webhook-confirmed completion.
Enterprise-grade, multi-week; still cannot promise 100% hands-off erasure (the mem0 ceiling is disclosed,
not hidden). Task 1 is a non-destructive stop-point cleared by both reviewers.

---

## 2. Verified facts (re-grounded 2026-08-04 — `file:line` corrected vs Rev 2)

**Cascade / schema**
- `public.users.id → auth.users(id) ON DELETE CASCADE` (`20260701131304_identity_persona_foundation.sql:19`);
  22 user-owned tables cascade; 5 globals + `reel-covers` bucket must survive. `users` has NO client
  UPDATE policy — its ONLY policy is `users_select_own` (`…:182`) — so new status columns are
  service-role-write-only *by construction* (still add pgTAP regression, §3.11 / T12).

**mem0 barrier (BUILDABLE via event-id reconciliation — but two contract items MUST be verified first)**
- `add()` → `POST /v3/memories/add/` returns `{status, event_id, results}`. Terminal-poll endpoint
  proposed **`GET /v1/event/{event_id}/`** → `PENDING|RUNNING|SUCCEEDED|FAILED`.
- **⚠ VERIFY-BEFORE-BUILD (Codex R2, T2 research gate):** mem0's official delete docs show `delete_all()`
  returning **`204` with NO `event_id`**, which conflicts with the live-probe assumption that `delete_all`
  yields a pollable `event_id`. If true, the delete leg's provability rests on **verify-empty +
  re-enumerate-until-stable**, not an event poll. Confirm the real `add`/`delete_all`/`event` contract
  (astrail-researcher, mem0 docs MCP) before T2 code; the design already fails safe to `barrier_blocked`
  if the contract differs.
- The installed SDK (`AsyncMemoryClient`) exposes **no** event method → a small raw-`httpx` adapter is
  required (matches `main.py:303-309`). **No documented delete-fencing guarantee exists** → verify-empty
  alone is insufficient; the reconciler is mandatory.
- **The add `event_id` is not merely discarded — it is unrecoverable on the timeout path.**
  `persist_trip_memory` (`preferences.py:306`) wraps the add in
  `asyncio.wait_for(mem0.add(...), timeout=5)` at `preferences.py:348-351`; the whole response is
  discarded, and on timeout `asyncio.wait_for` **cancels the coroutine**, so the `event_id` never
  materializes (`except` at `:352-353` marks the intent "may-have-landed"). Rev 2's "capture event_id on
  timeout" is therefore **unimplementable as written** (fable MED-3) — see §3.2 for the `create_task`
  fix.

**Reauth (`amr` is the only unambiguous freshness signal; `iat` is NOT)**
- Re-running `signInWithOtp`→`verifyOtp` mints a **new session** (new `session_id`, fresh `amr[]` entry,
  fires `SIGNED_IN`) while already signed in. Reuse `sign-in/page.tsx:101-136` as a modal.
- JWT carries `iat`, `session_id`, `aal`, **`amr[].{method,timestamp}`**. A silent refresh **re-stamps
  `iat` but does NOT append an `amr` entry** → **drop the `iat` fallback entirely** (fable HIGH-2); a
  refresh would otherwise bypass reauth. Fail closed on missing/stale `amr`.
- **Cost is NOT zero (Rev 2 was wrong):** `_decode` (`auth.py:93`; `jwt.decode` at `:112`) returns
  **only `sub`** (`:124`) and `get_current_user_id_stashed` (`rate_limit.py:60`) stashes only the derived
  user_id — **both discard the claims/JWT**. A claims-returning refactor is required to read `amr`.
- **CCPA §7061 caveat:** the reauth **window (propose 300s) is a product choice, not a statutory number**
  — confirm the primary reg before treating any number as compliance-locked (§10 open item / legal).

**Durable job + RPC idiom (corrected names)**
- mem0's ONLY production writer is `persist_trip_memory` (`preferences.py:306`), reachable ONLY after a
  `jobs` row (`runner.py:561`). Job-creating paths to guard: `reserve_and_enqueue_trip_job`
  (`20260804000000_reserve_replay_on_exhausted.sql:15`; reserves at `:56-61` and `:83-86`), the legacy
  **direct PostgREST insert `enqueue_job` (`jobs.py:73`, inserts at `:80` — NOT an RPC)** reached when
  `ENTITLEMENTS_ENABLED=false` via `_generate_trip_legacy` (`main.py:461`→`:510`), `create_organize_job`
  (`organizer.py:79`, RPC `create_saved_reels_organize_job:85`); judgment call now RESOLVED to guard:
  `capture_saved_reel` (`saved_reels.py:7`). **Block job creation ⇒ no new mem0 adds, for free.**
- Lease primitives to mirror (`jobs.py`, corrected): `mark_job_running` (`:96`, RPC `claim_trip_job`),
  `_renew_job_lease` (`:143`, RPC `renew_trip_job_lease`), `mark_job_done` fenced CAS on `lease_token`
  (`:117`, update at `:138-139`), reaper `reclaim_expired_jobs` (`:212`, RPC `reclaim_expired_trip_jobs`).
  **DB-clock (`clock_timestamp()`) decides expiry** (`20260720170000_db_clock_job_leases.sql:68`,`:85`) —
  mirror exactly. CAS = single `UPDATE … WHERE <predicate> RETURNING` (no `FOR UPDATE`).
- RPC idiom (`request_seat.sql`): `security definer`, `search_path=''`, revoke public/anon/authenticated
  + grant service_role; `coalesce(col, now()+interval)` = do-not-reset-clock. Richer CAS shape:
  `reserve_and_enqueue_trip_job` (`UPDATE…WHERE…RETURNING INTO; IF NOT FOUND THEN reject`).
- No-FK durability pattern: mirror **`geocode_country_cache`** (`20260720110000_geocode_country_cache.sql`
  — FK-free table `:22-35`, RLS + revoke + grant service_role `:39-41`). **Do NOT mirror
  `reel_place_mentions`** (cascade FK). Store the deleted uid as a **plain uuid, no FK, HMAC'd** (§3.10).
- Schema gate: `scripts/assert_schema.py` `REQUIRED_SCHEMA` (`:63`) **probes columns only — it CANNOT see
  RPC signatures** (the file says so: a column probe "cannot see `reserve_and_enqueue_trip_job`"). So a
  migration that only ships RPC bodies is invisible to it → we add a **schema-capability/version
  sentinel** (§3.4 / T3). `memory_events` is already in the manifest → T2 extends its tuple with
  `event_id`.
- Rollback convention: `supabase/migrations/rollback/` **exists** (e.g. `20260720100000_down.sql`) but
  covers only 2/35 migrations — real, not universal. Ship `_down.sql` twins for the new migrations.

**Client-side write paths that `pending_deletion` must freeze (Codex HIGH: pending ≠ deactivated)**
- `sign_out` cannot revoke an already-issued access JWT, and the repo permits **direct RLS client writes**:
  `traveler_profiles` upsert (`lib/trip/supabase-api.ts:27-28`), `reel_collections` insert/update/delete
  (`lib/reels/collections.ts:40/51/61`) + `reel_collection_items` upsert/delete (`:80/:88`). A stolen or
  still-valid token can write these AFTER a deletion request unless RLS itself checks the owner's status
  (§3.6 / T6).

---

## 3. Design

Invariant: the acted-on `user_id` is the authenticated caller's JWT `sub` (self-serve) or a founder-
supplied UUID resolved to exactly one account (`/admin`). **Never** client-supplied to the delete engine,
**never** `"*"`/`None`, **never** `reset()`.

### 3.1 Safety invariants
- **F1 — mem0 abort + provable barrier.** Purge is a strict wrapper over `clear_memory` translating its
  return: `"cleared"` → ok; `"unavailable"`→`MemoryBackendUnavailable`, `"unknown"`→`MemoryPurgeError`.
  Inherits all four `clear_memory` guards (`memory_clear.py:153`; marker + `_add_possibly_in_flight:123`;
  returns exactly `{cleared,unavailable,unknown}`). On the account path the durable barrier (§3.3) makes
  erasure **provable-for-known** and **explicitly-blocked-when-unprovable**, never probabilistic.
- **F2 — guard ≠ purge error.** `_assert_real_uuid` raises `InvalidUserId` (distinct), OUTSIDE every
  try/except, on every path. Catch **both `ValueError` and `TypeError`** (`uuid.UUID(None)` → TypeError).
- **F3 — canonical uuid.** `str(uuid.UUID(u)) == u` strict-equality (NOT `_parse_uuid`'s brace-accepting
  canonicalization). F3 equality is the binding spec.
- **F4 — no erasure mid-flight, enforced ATOMICALLY at the DB, defence-in-depth.** (a) The
  request-deletion RPC takes `SELECT … FROM users WHERE id=p_user_id FOR UPDATE`, checks/flips
  `account_status` **UPDATE-users-first**, and rejects if any non-terminal `jobs`/`organize_jobs` exists —
  all in ONE transaction. (b) Every job-creating RPC takes the same `FOR UPDATE` lock and rejects
  `account_status<>'active'` in its own txn (Codex F4). (c) Because the legacy `enqueue_job` (`jobs.py:73`)
  is a **direct PostgREST insert** that bypasses all RPCs, a **`BEFORE INSERT` trigger on `jobs` (and
  `organize_jobs`) with `FOR SHARE` on the owner row** rejects any insert for a non-active user — so no
  present-or-future insert path can slip through (fable MED-2). Frontend middleware is UX only.
- **F5 — point of no return (fable HIGH-3 + MED-1, Codex cancellation).** The engine crosses ONE durable,
  fenced transition from the cancellable drain phase into the destructive phase; past it, cancel returns
  `409 deletion_already_started`. This same CAS makes crash-recovery's "404 = success" a *correct*
  classification instead of a crash-window misread (§3.3).

### 3.2 mem0 event-id write barrier (T2 — linchpin; un-gates + un-lies #2)
- **Persist event ids, intent-first, via a tracked task (fable MED-3 fix).** Add `memory_events.event_id
  text` (nullable) + a cutover marker. Refactor `persist_trip_memory` so the add is `asyncio.create_task`
  (not a `wait_for` that cancels it): write the intent row first, let the request path move on, and a
  background completion callback records the late `event_id` (or a terminal failure) onto that row. This
  is the only way a request-path timeout can still yield an `event_id`.
- **Poll adapter — hardened (Codex MED).** New `backend/mem0_events.py`: raw `httpx` to a **fixed origin
  with redirects disabled**, `Authorization: Token <MEM0_API_KEY>`, 4 states
  (`PENDING/RUNNING/FAILED/SUCCEEDED`), **exponential backoff + jitter (NOT a fixed 500ms poll — a 17-min
  backlog would be thousands of calls)**, honor `Retry-After`, bounded concurrency, per-status handling
  (404/401/403/429/5xx), **UUID-validate every id**, timeout-bounded, keeps the deletion lease alive and
  **re-checks cancellation while draining**. Isolated + monkeypatchable (never import the real SDK/network
  in tests).
- **`barrier_blocked` — the disclosed ceiling (Codex R2 mem0 blocker).** Two unprovable cases → the job
  does **NOT** auto-complete; it enters the non-terminal `barrier_blocked` status, holds at the
  `memory_hold` stage, and escalates to a human (operator alert + admin overdue view): (i) an add whose
  HTTP response was lost so no `event_id` exists; (ii) an id stuck non-terminal past the drain bound.
- **Cutover / backfill.** Pre-migration `memory_events` rows have NULL `event_id` forever. Scope
  "outstanding" to rows after the cutover marker; a NULL-`event_id` **young** row inside the in-flight
  window still forces `unknown`/hold (fable MED-4: the event-state check is a fallback lattice on TOP of
  `_add_possibly_in_flight`'s time window — it does NOT wholesale-replace it).
- **Clear-memory (sync, variant a1):** layer the real event-state check onto (not instead of) the elapsed
  window; on tail-timeout still return `"unknown"` (now grounded in an actual `PENDING`). Flip
  `_CLEAR_RECONCILIATION_READY=True` (`main.py:310`) **in the same PR** + re-run `smoke_memory_clear.py`
  (taught to reconcile). **Rewire the UI (fable HIGH-1):** `SettingsView.tsx:8` stops importing
  `clearMemory` from `mock-api`; the button calls the real `POST /settings/memory/clear` and surfaces
  `memory_unavailable` / `memory_clear_unknown` honestly. Closes launch-gate #2 *and* its lying UI.
- **Account-delete (async, variant a2 — provable):** the deletion job (§3.3) drains **all** outstanding
  event_ids for the user to terminal (no HTTP-timeout bound), then `delete_all` (+ poll its event_id
  terminal *if* the contract exposes one — see §2 ⚠), then **verify-empty + re-enumerate until the drain
  set is stable** (fable MED-5). Load-bearing test: an old add materializes after the first empty read →
  deletion MUST stay pending / re-drain, never complete.

### 3.3 Durable staged deletion job (`deletion_jobs` — T3 schema, T4 engine)
Mirror `jobs.py` leasing. **`status` and `stage` are DISTINCT (Codex HIGH):**
- **`status`** (lifecycle): `scheduled | running | retryable | barrier_blocked | cancelled | overdue |
  completed | failed`. Non-terminal = `{scheduled, running, retryable, barrier_blocked, overdue}`.
- **`stage`** (monotonic progress): `claimed → memory_hold → [FENCE] → memory_purged → auth_delete_started
  → auth_deleted → processors_notified → completed`.
- **Partial unique index = one active deletion per user** (mirror the entitlement arc's pattern):
  `UNIQUE (user_id) WHERE status IN (non-terminal)`. Requesting deletion atomically cancels any prior
  active job with the status flip.
- Columns: `id`, `user_id` (plain uuid, **no FK**, HMAC'd in audit), `status`, `stage`, `lease_token`,
  `lock_expires_at` (DB-clock), `attempts`, `last_error`, `next_attempt_at` (backoff), `statutory_deadline`,
  `scheduled_for`, `barrier_blocked_reason`, timestamps.

`erase_user(client, mem0, deletion_job)` stages:
1. `_assert_real_uuid` + re-check lease token + `account_status='pending_deletion'` **before EACH
   irreversible step** (a cancel between ticks must abort).
2. **`memory_hold`** — barrier drain (§3.2 a2), cancellable. Unprovable → `barrier_blocked` (no
   auto-complete).
3. **FENCE (F5):** fenced CAS `UPDATE deletion_jobs SET status='running', stage='memory_purged'
   WHERE id=$1 AND lease_token=$2 AND stage='memory_hold' AND status='running' RETURNING`. 0 rows ⇒ a
   cancel won the race ⇒ abort cleanly. This is the point of no return; cancel past here = `409`.
4. `purge_account_memory` (F1 abort) → verify-empty → **re-enumerate + loop until stable** (fable MED-5)
   → stage `memory_purged`.
5. Storage preflight (`reel-covers` service-role-owned → expected clear; assert).
6. **Persist `auth_delete_started` BEFORE the call (Codex HIGH crash recovery)**, then
   `auth.admin.delete_user(uid, should_soft_delete=False)` → cascade → stage `auth_deleted`. On recovery
   from `auth_delete_started`, **absence of the auth user = idempotent success** (the 404 is correct, not
   a crash-window misread — enabled by F5 + the persisted fence).
7. Processor-deletion instructions (§3.9 / T9) → stage `processors_notified`.
8. Flip audit `completed` + enqueue completion email (§3.7) → stage `completed`.

- **Intent-first, no-FK audit:** an `erasure_audit`/`deletion_jobs` row exists BEFORE any destructive op
  and does not cascade — stage transitions are the recovery ground-truth.
- **Expedite = set `scheduled_for=now()` (with a floor > the mem0 write-back bound so a just-issued add
  can still be observed — fable MED-5), never an independent erasure.**

### 3.4 Deployment gate — one transactional migration + capability sentinel (T3; Codex HIGH deploy gate)
- Ship **ONE transactional migration**: `users` columns + `deletion_jobs` + `erasure_audit` +
  notification outbox (§3.7) + the `BEFORE INSERT` triggers (§3.1c) + all RPC bodies + grants + a
  **schema-capability/version sentinel** (a probeable row/function proving the RPC-bearing migration
  landed, since `assert_schema` sees columns only). Precedent: the entitlement arc used `jobs.charge_kind`
  as the observable proxy for its RPC migration.
- Extend `assert_schema.py` `REQUIRED_SCHEMA` (**same PR**): `memory_events += event_id` (T2), `users`
  status columns, `deletion_jobs`, `erasure_audit`, `notification_outbox` (T3).
- **`_DELETION_EXECUTION_READY` (fail-closed) gates request-acceptance AND admin-expedite AND the worker —
  not just execution** (accepting requests while execution is off starts legal clocks with no engine to
  honor them). Schema-first rollout → probe live contracts → then flip the flag (its task home is T13).
- `_down.sql` rollback twins for every new migration (`supabase/migrations/rollback/`).

### 3.5 Soft-delete state + reauth (T5)
- Migration: `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion')`,
  `deletion_requested_at timestamptz`, `deletion_scheduled_for timestamptz`. Service-role-write-only.
- **`require_fresh_reauth(max_age_s=300)`** dependency (`auth.py`): a **claims-returning `_decode`
  refactor** (today it returns only `sub`) surfaces `amr`; require an `amr[].timestamp` with an allowed
  method within `0 ≤ now-amr.ts ≤ 300` (+ skew), fresh-token-subject == the account, **no `iat`
  fallback** (fable HIGH-2). Apply ONLY to the two deletion endpoints. **Assert `amr` presence against a
  REAL Astrail Supabase token in T5/T11** (unverified in-repo — the claim shape must be confirmed live).
- Add an authoritative **account-status/existence** check to deletion/cancel/admin + the memory/work
  endpoints (a lightweight `users` read on these few routes only; not global — Codex #5 scoped).
- `request_account_deletion(p_user_id)` RPC — `FOR UPDATE` + UPDATE-users-first CAS `active→pending_
  deletion`, reject non-terminal jobs, `deletion_scheduled_for = coalesce(…, now()+INTERVAL '7 days')`
  (don't reset clock), DB-clock, create the `deletion_jobs` row (partial-unique enforced).
- `cancel_account_deletion(p_user_id)` RPC — CAS `pending_deletion→active` **only while stage is still
  pre-FENCE**; past the fence the worker owns it and cancel returns `409 deletion_already_started`.
  Endpoint additionally requires fresh reauth timestamp **> `deletion_requested_at`**.
- Endpoints `POST /account/deletion` + `/cancel`: `require_fresh_reauth`; `sign_out(jwt, scope="global")`
  using the **raw Authorization header** (re-read it — the stashed helper discards the jwt);
  **treat sign_out failure as recorded/retried, not success**; instruct FE to clear the local session
  after 200. (Note F6: sign_out alone does not stop a live token — see §3.6.)

### 3.6 RLS freeze — pending ≠ deactivated (T6; Codex HIGH)
Because `sign_out` cannot revoke an issued JWT and the repo allows direct client RLS writes
(`supabase-api.ts:27-28`, `collections.ts:40/51/61/80/88`), make `pending_deletion` **load-bearing in the
RLS write path itself**:
- A `security definer` helper `public.account_is_active(uid uuid) returns boolean` (`search_path=''`).
- Add `AND public.account_is_active(auth.uid())` to the `WITH CHECK` of every user-owned-table
  INSERT/UPDATE/UPSERT policy; leave SELECT/read, reauth, cancel and privacy ops permitted. Service-role
  mutations that create user content honor the same status.
- Optionally validate `session_id` still exists after `sign_out` on the few destructive/write routes.
- pgTAP proves: a `pending_deletion` user cannot insert/update any user-owned row (T12).

### 3.7 Durable completion notifications + delivery confirmation (T8 — legally required; Codex HIGH outbox)
`backend/notifications.py` + a **durable outbox table**: one row per notification with `lease`,
`attempts`, `next_attempt_at`, a **stable idempotency key**, and a **terminal delivery state**. Email +
message intents are **captured BEFORE auth deletion** (auth delete removes the address from `auth.users`);
retain the minimum PII until the terminal state, then drop it.
- Resend direct HTTP with **`Idempotency-Key`** (24h). Emails: scheduled (date + cancel link), cancelled,
  **completed** (GDPR Art.12 / CCPA response), failure/operator alert.
- **Completion condition = delivered (full rigor A):** consume **signed Resend delivery webhooks**; a
  permanent bounce routes to an operator manual-response path (a compliant response must reach the user
  via a durable channel — overdue escalation ALONE is not compliant, Codex Legal). Define when local +
  Resend PII is removed. Best-effort send never blocks a state transition; the outbox guarantees eventual
  delivery + retry.

### 3.8 Background sweep (T7)
- **Separate bounded deletion semaphore** (1 worker fine for beta) — do NOT share `_RECOVERY_SEM` (Codex
  #8, fable F-2). `claim_deletion_job`/`renew_deletion_job_lease`/`reclaim_expired_deletion_jobs` RPCs
  mirror `jobs.py`. Extend `_reap_loop` with a **third branch in its OWN try** (a deletion error must not
  skip trip/organize recovery — fable F-8) + boot re-sweep. The claim is the dedup — no re-dispatch of a
  claimed uid.
- **Overdue/failure workflow (Codex #11):** `status` drives it — `retryable` w/ backoff via
  `next_attempt_at`; `overdue` when `statutory_deadline` passes; `barrier_blocked` surfaces to the admin
  overdue view + an operator alert. Gated by `_DELETION_EXECUTION_READY`.

### 3.9 Processor-deletion inventory (T9 — full-rigor A; Codex R2 "erasure inventory too early" blocker)
Complete erasure ≠ the 22 DB tables. CCPA §7022 / GDPR 17+19 require **instructing processors** to delete.
Build a per-processor data-flow inventory — for EACH: correlation key · delete API (or manual runbook) ·
retention exception (what legally survives + why) · retry proof · completion criterion:
- **PostHog** (analytics) — distinct_id keyed; GDPR delete/anonymize API.
- **Resend** (email) — address keyed; contact deletion + the outbox's own PII drop.
- **Render logs** — no per-user delete API → **disclosed retention-window expiry** is the exception.
- **Apify** — run/dataset artifacts; delete or document retention.
- **OpenAI / Agents SDK** — confirm whether any user-keyed store exists (default: no retention) →
  document.
The **completion email states what was erased and what remains under a disclosed exception** (with the
window). Automated where an API exists; runbook + audit where not.

### 3.10 Hardened `/admin` (T10; Codex HIGH admin capability spec + #9/#13, fable LOW overdue view)
`require_admin`: (1) valid JWT; (2) **founder allowlist** `ADMIN_USER_IDS` — parse **fail-closed at
REQUEST time** (403 if unset/malformed + loud boot log), NOT boot-fatal (don't crash-loop the shared web
process); (3) **founder still exists + active**; (4) **step-up on EVERY `/admin` route incl. GET** (the
user list is personal data) — passphrase (`X-Admin-Passphrase`) `hmac.compare_digest` vs
`ADMIN_ACTION_SECRET`, which **mints a short-lived signed admin capability token** rather than forwarding
the long-term secret each request. **Capability token spec:** `iss`, `aud=astrail-admin`, founder `sub`,
original `session_id`, `iat/nbf/exp/jti`, **≤5-min**, memory-only in the browser, **reject future
timestamps + alg-confusion** (pin alg, forbid `none`), verify allowlist + active account on every use.
Lockout keyed **primarily on founder UUID** (+ secondary trusted-proxy bucket; never raw forwarded IP),
TTL + exponential backoff; high-entropy `ADMIN_ACTION_SECRET` validated at startup. Endpoints:
`GET /admin/accounts` (status list), cancel, **expedite** (schedule-set), and an **overdue view**
(fable LOW). All audited.

### 3.11 Frontend (T11)
Delete card (destructive styling, mirror `SettingsView.tsx:126/130`) → **OTP re-challenge modal** (reuse
`sign-in/page.tsx`) → confirm → `POST /account/deletion` with the fresh token; clear local session on 200.
Pending banner ("deletes on {date} — Cancel", cancel re-challenges). `middleware.ts` third check
(`pending_deletion`) as UX gating only (backend is the real guard). Minimal founder-gated admin page
(passphrase prompt → capability). **The rewired real clear-memory button lands here too** (from T2).
`backend-types.ts` mirrors all new shapes (guardrail #4).

### 3.12 Privacy honesty + audit retention (T12; Codex #10, MED audit-retention, Legal)
Replace "email us" with the self-serve flow + 7-day grace. Precise carve-out: shared entries are
**public-source cache data no longer linked to an Astrail account** (NOT "de-identified"); state the
**actual backup retention window + restore-and-reapply-erasure procedure**. **HMAC the audit uuid** (treat
as personal data), with a stated purpose + retention: CCPA §7101 wants request/response records **≥24
months**; define the **HMAC-key lifecycle** and the **purge of raw uid/email** (HMAC is still linkable
while key + source persist). RLS regression (pgTAP) proves no client write path to any deletion-state
column and the §3.6 freeze; ship Pydantic + TS + SQL + `assert_schema.py` together.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Fault-inject / gate focus |
|---|------|---------------------------|
| 1 | **Core choke-point** — `_assert_real_uuid` (F2/F3, catch ValueError+TypeError, strict equality, OUTSIDE try) + `purge_account_memory` (strings→exceptions wrapper over `clear_memory`) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` (`backend/erasure.py`,`test_erasure.py`) | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; `≠"cleared"` ⇒ raise (BEHAVIORAL, not vacuous mock-called); guard≠purge error. **Non-destructive stop-point. Gates stay False; nothing imports it.** |
| 2 | **mem0 event barrier** (research gate first: verify `add`/`delete_all`/`event` contract per §2 ⚠) — `memory_events.event_id` + intent-first `create_task` capture (fable MED-3) + hardened `mem0_events.py` (backoff/jitter/Retry-After/per-status/UUID-validate/fixed-origin) + reconciler w/ `barrier_blocked` + clear-memory event-state layered on the time window (fable MED-4) + flip `_CLEAR_RECONCILIATION_READY` + rewire `SettingsView` button → real POST (fable HIGH-1) + re-run smoke | old add materializes after first empty read → stays `unknown`/pending; timeout no longer loses `event_id`; unprovable → `barrier_blocked` (no auto-complete); NULL-`event_id` young row forces `unknown`; #2 un-gate + un-lie verified |
| 3 | **Schema + deploy gate** — ONE txn migration: `account_status`/timestamps + `deletion_jobs` (status⊥stage + partial-unique) + `erasure_audit` (no-FK, HMAC) + `notification_outbox` + `BEFORE INSERT` triggers (fable MED-2) + RPC bodies + **capability sentinel** + `assert_schema` manifest + `_DELETION_EXECUTION_READY` (gates request+expedite+worker) + `_down.sql` twins | both deploy orders; schema-drift gate fails code-first; sentinel proves RPC migration landed; audit has no cascade FK; trigger blocks direct `enqueue_job` insert |
| 4 | **`erase_user` engine** (staged, leased, idempotent; F5 fenced point-of-no-return; `auth_delete_started` persisted before delete; drain loop-until-stable) | mem0 unavailable aborts BEFORE delete; re-check claim+status before each step; cancel pre-fence aborts, post-fence 409; crash-resume from stage; 404=success ONLY with `auth_delete_started` recorded; globals untouched |
| 5 | **Soft-delete + reauth + atomic guards** — request/cancel RPCs (`FOR UPDATE`, UPDATE-users-first) + convert/guard legacy `enqueue_job` + `require_fresh_reauth` (claims-returning `_decode`, `amr`-only, NO iat fallback) + status guard in every creator RPC incl. `capture_saved_reel` + `sign_out`(raw jwt) | reauth required (stale/refresh token 401); cancel needs freshness>requested_at; job-create blocked when pending (atomic, both commit orders); re-request doesn't reset clock; guard-fail 500 not 200; `amr` asserted vs a REAL token |
| 6 | **RLS freeze (pending ≠ deactivated)** — `account_is_active()` helper + `WITH CHECK` on every user-owned write policy + service-role parity + optional session-existence check | a `pending_deletion` token cannot insert/update profiles/collections/items; reads + cancel + privacy still allowed |
| 7 | **Deletion sweep** — separate semaphore + `claim/renew/reclaim_deletion_job` + `_reap_loop` third branch (own try) + boot re-sweep + overdue/retryable/`barrier_blocked` escalation | cancelled-pre-fence aborts; no double-dispatch; deletion error doesn't skip trip recovery; overdue + barrier_blocked escalate |
| 8 | **Durable notifications + delivery** — Resend HTTP + outbox (lease/attempts/idempotency-key/terminal) + intent-captured-before-auth-delete + signed delivery webhooks (completion=delivered) + permanent-bounce operator path | send failure retried, never blocks state; completion not "done" until delivered; bounce → operator; PII dropped after terminal |
| 9 | **Processor-deletion inventory** — PostHog/Resend/Render-logs/Apify/OpenAI: correlation key · delete API/runbook · retention exception · retry proof · completion criterion; completion email states erased + residual | each processor has a delete-or-documented-exception path; email wording matches the inventory; no silent "fully erased" claim |
| 10 | **Hardened `/admin`** — allowlist(request-time fail-closed)+founder-active+passphrase step-up→**signed capability token (full spec)**+uuid-keyed lockout+GET/cancel/expedite/**overdue view** | non-founder 403; bad passphrase lockout+backoff; `compare_digest` (fault-inject `==`); GET needs step-up; alg-confusion/future-ts/expired capability rejected; expedite sets schedule |
| 11 | **Frontend** — delete card + OTP modal + pending banner + cancel + middleware + admin page + rewired clear-memory + `backend-types` | fresh token sent; failure never shows deleted; pending gates generation (backend is real guard) |
| 12 | **Privacy carve-out + audit retention + RLS pgTAP** — HMAC audit + actual backup window + restore-and-reapply + ≥24mo retention + HMAC-key lifecycle + raw-PII purge + pgTAP | wording matches code; pgTAP proves no client write path + §3.6 freeze; audit retention/purge honored |
| 13 | **Live E2E gate** — seed user+trip/reel+mem0 → reauth+request (status flip, gen blocked) → force grace lapse → sweep drains event_ids→delete_all+verify(loop)→auth-delete → assert 22 tables empty, globals intact, mem0 reconciled+empty, audit stages, completion email **delivered**, processors instructed; flip `_DELETION_EXECUTION_READY`; + #2 un-gate check | the cascade+barrier+processor PROOF on rebased local schema; also the barrier_blocked path (inject an unprovable add) |

Deferrals: §8 — smaller now (A pulls processors/webhooks/barrier_blocked in-scope).

## 5. Test / verification
- Unit T1–T12; `_assert_real_uuid`/`purge_account_memory` adversarial (each guard reddens ALONE — avoid the
  BUILD-LOOP "tests that cannot fail" traps; the reuse test must be behavioral, not mock-called-vacuous).
- mem0 barrier: the "late-materializing add" and the "unprovable → barrier_blocked" tests are load-bearing.
- Two-session concurrency tests for F4 (both commit orders) and the F5 cancel-vs-fence race.
- Cascade+barrier+processor proof = T13 (rebased local Postgres; derive the 22-table list from
  `information_schema`).
- `uv run pytest evals/ -q` green after every backend change (anchor `6229.0` immovable); `tsc`+`vitest`+
  `pytest` green per task. `/qa` on the delete/cancel/reauth flow (UI+auth → required).

## 6. Risks & mitigations
- Orphaned/unprovable memory (F1) → provable-for-known barrier + `barrier_blocked` escalation + abort-on-
  unavailable + verify-empty-until-stable.
- Over-delete (`"*"`/`None`) → single `_assert_real_uuid` choke; engine never takes client uid.
- Delete/purge a cancelled account → re-check status before each step + F5 fenced point-of-no-return
  (cancel post-fence = 409); expedite=schedule-only.
- New memory after request → atomic `FOR UPDATE` status guard in every creator RPC + `BEFORE INSERT`
  trigger (covers the direct `enqueue_job` insert).
- Writes by a still-valid token after request → §3.6 RLS freeze (status load-bearing in WITH CHECK).
- Lost deletion record → intent-first no-FK staged audit; crash-resume from `auth_delete_started`.
- Stolen/refreshed token deletes → `amr`-only reauth (no iat), freshness>requested_at, status/existence,
  session clear.
- No compliant response → durable outbox + webhook-confirmed delivery + operator bounce path.
- Deploy skew → one txn migration + capability sentinel + `_DELETION_EXECUTION_READY` (gates request too)
  + both-order tests.
- Recovery starvation → separate deletion semaphore + per-branch try.
- Incomplete erasure vs processors → §3.9 inventory + disclosed-exception completion email.
- `/admin` compromise → step-up-on-all + founder-active + signed capability (alg/ts-hardened) + uuid-keyed
  lockout.
- Promise false → precise policy + HMAC audit + named backup window + ≥24mo audit retention.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Full rigor / Direction A ✅ · self-serve graceful ✅ · 7-day grace ✅ · `/admin` login+passphrase step-up
(not bare PIN) ✅ · reuse `clear_memory`/`jobs.py`/`request_seat`/`geocode_country_cache` patterns ✅ ·
un-gate + un-lie clear-memory as part of T2 ✅ · `capture_saved_reel` IS gated on status (open item #3
resolved) ✅ · completion = webhook-confirmed delivery ✅ · processor inventory in-scope (not deferred) ✅.

## 8. Deferrals (with triggers) — smaller under A
- Dedicated external deletion worker → once durable claims + separate semaphore exist and load demands it.
- KV-backed admin lockout → past one Render instance.
- Rich admin dashboard → post-beta (overdue view + cancel/expedite ship now).
- MFA/AAL step-up → when an MFA feature exists (OTP reauth suffices now).
- Per-request DB existence check on ALL routes → only destructive/admin/memory routes now (Codex #5).

## 9. Review folds (Rev 2 → Rev 3) — BOTH R2 reviews, in full
**fable R2 (REVISE 8/10):** HIGH-1→§3.2/T2+T11 (rewire lying button) · HIGH-2→§2/§3.5 (drop iat, amr-only,
claims-returning `_decode`) · HIGH-3+MED-1→§3.1 F5/§3.3 (fenced point-of-no-return, fixes 404-crash-window)
· MED-2→§3.1c/T3 (`BEFORE INSERT` trigger for the direct `enqueue_job` insert; UPDATE-users-first) ·
MED-3→§3.2 (`create_task` background capture — `wait_for` cancels) · MED-4→§3.2 (event-state layered on,
not replacing, the time window) · MED-5→§3.3 (loop-until-stable drain; expedite floor; `memory_hold`
before purge) · LOW→§2 (citation drift corrected), §3.4 (`_DELETION_EXECUTION_READY` home=T13, `_down.sql`
twins), §3.10 (capability mechanics + overdue view).
**Codex R2 (BLOCK 4/10):** mem0-not-provable→§3.2 (`barrier_blocked` non-terminal + verify the 204/no-
event_id contract) · cancellation-racy→§3.1 F5/§3.3 (one fenced durable transition) · F4-serialization→
§3.1 F4 (`FOR UPDATE` every creator + trigger) · erasure-inventory→§3.9/T9 (processors) · job-schema→§3.3
(status⊥stage + partial-unique) · crash-recovery→§3.3 (`auth_delete_started` fenced-before) · outbox→
§3.7/T8 (durable + webhook delivery) · pending≠deactivated→§3.6/T6 (RLS freeze) · deploy-gate→§3.4/T3
(one txn + sentinel + gate-request-too) · admin-capability→§3.10 · raw-mem0-adapter→§3.2 (hardened) ·
audit-retention→§3.12 · Legal→§3.5 (300s=product choice, amr rules), §3.7 (durable-channel response),
§3.12 (backup window).

## 10. Open items for the re-review
- **mem0 `delete_all` / `event` contract (§2 ⚠)** — verify the 204/no-event_id case BEFORE T2; the design
  fails safe to `barrier_blocked`, but the provability wording depends on the real contract.
- **CCPA §7061 reauth window** — 300s is a product choice; confirm the primary reg before locking a number.
- **`amr[].timestamp` live shape** — confirm a real Astrail Supabase token carries it (T5/T11) before
  relying on it as the sole freshness signal.
- **Backup retention window** — fill the ACTUAL number from the Supabase/infra config for §3.12.

_Re-review status: Rev 3 pending fable eng-review + Codex `gpt-5.6-sol` (§ BUILD-LOOP step 3, third round)._
