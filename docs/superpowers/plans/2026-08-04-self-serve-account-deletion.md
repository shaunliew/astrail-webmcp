# Plan — Self-serve account deletion (full-rigor) + mem0 write-barrier + hardened `/admin`

> Draft 2026-08-04 · **Rev 2 (full-rigor) after fable REVISE 7/10 + Codex `gpt-5.6-sol` BLOCK 3/10.**
> branch `zh` · Owner: backend lane (drive with subagents).
> Supersedes the *trigger* of `2026-08-03-user-data-erasure.md` (reuses its `erase_user` core idea);
> corrects its stale premise (clear-memory already exists on `zh`, gated).
> **ZH chose "full rigor" — build the provable mem0 barrier + durable staged deletion job; resolves
> launch-gate #2 (clear-memory) AND #4 (account deletion) for good.**
> **Destructive + irreversible + legally-binding. Implement task-by-task; STOP after Task 1 for human
> review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**

---

## 0. TL;DR + shape

A signed-in user deletes their own account **gracefully and provably**: reauth (OTP) → 7-day
cancellable grace → a **durable, leased, staged background job** that (1) drains every outstanding
mem0 add to a terminal provider state, (2) `delete_all` + verifies empty, (3) hard-deletes
`auth.users` (cascade 22 tables), (4) records a durable no-FK audit, (5) emails a completion notice.
Plus a hardened `/admin` (founder allowlist + passphrase step-up minting a short-lived capability).

**This is a big arc (~11 tasks) — that's the honest cost of a legally-binding destructive feature.**
Natural phases: **Foundation** (T1–T3: choke-point, mem0 barrier, schema+gate) → **Engine** (T4) →
**Self-serve + reauth + atomic guards** (T5) → **Sweep + notifications** (T6–T7) → **Admin + FE**
(T8–T9) → **Privacy + E2E** (T10–T11). Build in order; **STOP after Task 1** (non-destructive) for review.

The mem0 event-id barrier (T2) is the linchpin **and** un-gates the clear-memory button — one machine,
both gates closed.

---

## 1. Why + the decision

`/privacy` promises deletion + mem0 erasure; **no code executes it** (no `backend/erasure.py`). We are
making a PDPA/GDPR/CCPA promise we cannot keep. Clear-memory (`#2`) already exists but is **gated off**
(`_CLEAR_RECONCILIATION_READY=False`, `main.py:310`) awaiting the exact mem0 reconciliation this plan
builds. Account deletion (`#4`) is 100% missing.

**Decision (ZH, 2026-08-04): FULL RIGOR.** Self-serve, Google-style graceful deletion, with a *provable*
mem0 barrier (not the 7-day-grace probabilistic mitigation), a durable staged deletion job, legally-
required reauthentication and completion notice. Reviewed at REVISE(fable)/BLOCK(codex) as a lighter
design; this Rev 2 folds every finding (§9).

---

## 2. Verified facts (grounded 2026-08-04 — three research scouts, `file:line`)

**Cascade / schema**
- `public.users.id → auth.users(id) ON DELETE CASCADE` (`20260701131304:19`); 22 user-owned tables
  cascade; 5 globals + `reel-covers` bucket must survive. `users` has NO client UPDATE policy — only
  `users_select_own` (`20260701131304:180`) — so new status columns are service-role-write-only by
  construction (still add pgTAP regression, §3.10 / Codex #12).

**mem0 barrier (scout 1 — BUILDABLE via event-id reconciliation)**
- `add()` → `POST /v3/memories/add/` returns `{status: PENDING|SUCCEEDED|FAILED, event_id, results}`;
  `delete_all()` → `DELETE /v1/memories/` returns `{message, event_id}` (~830ms terminal). Both carry a
  **pollable `event_id`**. Terminal-poll endpoint **`GET /v1/event/{event_id}/`** → `SUCCEEDED|FAILED`.
- The installed SDK (`AsyncMemoryClient`) exposes **no** event method → a small raw-`httpx` adapter is
  required (matches `main.py:303-309`). **No documented delete-fencing guarantee exists** → verify-empty
  alone is insufficient; the reconciler is mandatory. `persist_trip_memory` currently **discards** the
  add `event_id` (`preferences.py:306`) → must persist it.

**Reauth (scout 2 — reuse OTP, check `amr`)**
- `reauthenticate()` (password-only) and AAL/MFA step-up (needs MFA enrollment UI) are **inapplicable**.
  Re-running `signInWithOtp`→`verifyOtp` mints a **new session** (new `session_id`, fresh `iat`, fires
  `SIGNED_IN`) — works while already signed in. Reuse `sign-in/page.tsx:101-136` as a modal.
- JWT carries `iat`, `session_id`, `aal`, **`amr[].{method,timestamp}`**. Use `amr[].timestamp` (a silent
  refresh does NOT append an `amr` entry, so it's unambiguous; `iat` may be re-stamped on refresh → weak).
  Backend already decodes claims (`auth.py:112`) → zero extra cost, no DB round-trip.
- **CCPA §7061 caveat:** primary reg text not fetched; the reauth **window (propose 300s) is a product
  choice, not a fixed legal number** — confirm the actual reg before locking it (§10 open item).

**Durable job + RPC idiom (scout 3)**
- mem0's ONLY production writer is `persist_trip_memory` (`preferences.py:306`), reachable ONLY after a
  `jobs` row (`runner.py:560`). Job-creating paths to guard: `reserve_and_enqueue_trip_job`
  (`20260804000000:34`), the `_generate_trip_legacy` insert path (`main.py:510`, only if
  `ENTITLEMENTS_ENABLED=false`), `create_saved_reels_organize_job` (`organizer.py:80`); judgment call:
  `capture_saved_reel` (`saved_reels.py:7`). **Block job creation ⇒ no new mem0 adds, for free.**
- Lease primitives to mirror (`jobs.py`): `claim_trip_job`/`mark_job_running` (`:96`), `renew_trip_job_lease`
  (`:143`), `mark_job_done` CAS (`:117`), reaper `reclaim_expired_trip_jobs` (`:212`), **DB-clock
  (`clock_timestamp()`) decides expiry** (`20260720170000:1-38`) — mirror exactly. CAS = single
  `UPDATE ... WHERE <predicate> RETURNING` (no `FOR UPDATE`).
- RPC idiom (`request_seat.sql:1-21`): `security definer`, `search_path=''`, revoke public/anon/
  authenticated + grant service_role; **`coalesce(col, now()+interval)` = do-not-reset-clock**. Richer CAS
  shape: `reserve_and_enqueue_trip_job` (`UPDATE...WHERE...RETURNING INTO; IF NOT FOUND THEN reject`).
- `erasure_audit`/`deletion_jobs` durability: mirror **`geocode_country_cache`** (zero FK to users, RLS
  service-role-only, `20260720110000:30-33`). **Do NOT mirror `reel_place_mentions`** (it carries a cascade
  FK). Store the deleted uid as a **plain uuid, no FK** (HMAC it, §3.9/Codex #10).
- Schema gate: `assert_schema.py` `REQUIRED_SCHEMA` (`:63`) — extend `users` + add `deletion_jobs`/
  `erasure_audit`, **same PR** as migration (column-probe only, can't see RPCs). Fail-closed readiness gate
  precedent: `_CLEAR_RECONCILIATION_READY` (`main.py:310`).

---

## 3. Design

Invariant: the acted-on `user_id` is the authenticated caller's JWT `sub` (self-serve) or a founder-
supplied UUID resolved to exactly one account (`/admin`). **Never** client-supplied to the delete engine,
**never** `"*"`/`None`, **never** `reset()`.

### 3.1 Safety invariants
- **F1 — mem0 abort + provable barrier.** Purge is a strict wrapper over `clear_memory` translating its
  return: `"cleared"` → ok; anything else **raises** (`"unavailable"`→`MemoryBackendUnavailable`,
  `"unknown"`→`MemoryPurgeError`). This inherits all four `clear_memory` guards (marker + `_add_possibly_
  in_flight`) instead of the 2 the last draft reused (fable F-1). On the account path, the durable barrier
  (§3.3) makes it **provable**, not probabilistic (Codex #1).
- **F2 — guard ≠ purge error.** `_assert_real_uuid` raises `InvalidUserId` (distinct), OUTSIDE every
  try/except, on every path. Catch **both `ValueError` and `TypeError`** (`uuid.UUID(None)` raises
  TypeError — fable F-9).
- **F3 — canonical uuid.** `str(uuid.UUID(u)) == u` strict-equality (NOT `_parse_uuid`'s brace-accepting
  canonicalization — F3 equality is the binding spec; fable F-9).
- **F4 — no erasure mid-flight, enforced ATOMICALLY at the DB.** The request-deletion RPC rejects if any
  non-terminal `jobs`/`organize_jobs` exists AND flips `account_status` in ONE transaction; every job-
  creating RPC rejects `account_status<>'active'` in the same txn (Codex #3). Frontend middleware is a UX
  convenience, NOT the guard — a live token bypasses it.

### 3.2 mem0 event-id write barrier (T2 — linchpin; un-gates #2)
- **Persist event ids.** Add `memory_events.event_id text` (nullable). `persist_trip_memory` records the
  add's `event_id` on every attempt (including timeouts where the response is available). A timed-out add
  with **no** event_id is a "barrier-unprovable" marker (see §10 edge).
- **Poll adapter.** New `backend/mem0_events.py`: `httpx GET https://api.mem0.ai/v1/event/{id}/`,
  `Authorization: Token <MEM0_API_KEY>`, poll ~500ms to `SUCCEEDED|FAILED`. Isolated + monkeypatchable
  (never import real SDK/network in tests), timeout-bounded.
- **Clear-memory (sync, variant a1):** replace `_add_possibly_in_flight`'s elapsed-time heuristic with a
  real event-state check (poll outstanding ids ~20–30s; on tail-timeout still return `"unknown"`, now
  grounded in an actual `PENDING` state). Flip `_CLEAR_RECONCILIATION_READY=True` **in the same PR** that
  lands this + re-run `smoke_memory_clear.py` (taught to reconcile). Closes launch-gate #2.
- **Account-delete (async, variant a2 — provable):** the deletion job (§3.3) drains **all** outstanding
  event_ids for the user to terminal (no HTTP-timeout bound — it's a background job), THEN `delete_all` +
  poll its event_id terminal, THEN verify-empty. Because generation is atomically blocked at request
  (F4), the outstanding set is closed. Add a test: an old add materializes after the first empty read →
  deletion MUST stay pending (Codex #1).

### 3.3 Durable staged deletion job (`deletion_jobs` — T3 schema, T4 engine)
Mirror `jobs.py` leasing. States: `claimed → memory_reconciled → memory_verified → auth_deleted →
completed` (+ `failed`/`overdue`). Columns: `id`, `user_id` (plain uuid, **no FK**), `stage`, `lease_token`,
`lock_expires_at` (DB-clock), `attempts`, `last_error`, `next_attempt_at`, `statutory_deadline`,
`scheduled_for`, timestamps. `erase_user(client, mem0, deletion_job)`:
1. `_assert_real_uuid` + re-check the claim token + `account_status='pending_deletion'` before EACH
   irreversible step (Codex #2: a cancel between ticks must abort the run).
2. Reconcile barrier (§3.2 a2) → stage `memory_reconciled`.
3. `purge_account_memory` (F1 abort) → verify-empty → stage `memory_verified`.
4. Storage preflight (`reel-covers` service-role-owned → expected clear; assert).
5. `auth.admin.delete_user(uid, should_soft_delete=False)` → cascade → stage `auth_deleted`.
6. Flip audit to `completed` + enqueue completion email (§3.6).
- **Intent-first, no-FK audit (Codex #4, fable F-5):** an `erasure_audit`/`deletion_jobs` row exists
  BEFORE any destructive op and does not cascade — a crash after `delete_user` resumes from it (idempotent:
  a 404 from a re-run with `auth_deleted` already recorded = success). Stage transitions are the recovery
  ground-truth.
- **Expedite = set `scheduled_for=now()`, never an independent erasure** (Codex #2).

### 3.4 Soft-delete state + reauth (T5)
- Migration: `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion')`,
  `deletion_requested_at timestamptz`, `deletion_scheduled_for timestamptz`. Service-role-write-only.
- **`require_fresh_reauth(max_age_s=300)`** dependency (`auth.py`, layered on `_decode`): require an
  `amr[].timestamp` within window (fallback `iat`). Apply ONLY to the two deletion endpoints — never
  global (no per-request cost elsewhere). Also add an authoritative **account-status/existence** check to
  deletion/cancel/admin + the memory/work endpoints (Codex #5) — a lightweight `users` existence+status
  read on these few routes only.
- `request_account_deletion(p_user_id)` RPC — CAS `active→pending_deletion`, reject non-terminal jobs,
  `deletion_scheduled_for = coalesce(…, now()+INTERVAL '7 days')` (don't reset clock), DB-clock.
- `cancel_account_deletion(p_user_id)` RPC — CAS `pending_deletion→active`; endpoint additionally requires
  fresh reauth timestamp **> `deletion_requested_at`** (Codex #5, scout 2).
- Endpoints `POST /account/deletion` + `/cancel`: `require_fresh_reauth`; `sign_out(jwt, scope="global")`
  using the **raw Authorization header** (re-read it — `get_current_user_id_stashed` discards the jwt;
  fable F-10); **treat sign_out failure as recorded/retried, not success** (Codex #5); instruct FE to clear
  the local session after 200.

### 3.5 Background sweep (T6)
- **Separate bounded deletion semaphore** (1 worker adequate for beta) — do NOT share `_RECOVERY_SEM`
  (Codex #8, fable F-2: mem0 polling could starve trip/organize recovery). `claim_deletion_job`/
  `renew_deletion_job_lease`/`reclaim_expired_deletion_jobs` RPCs mirror `jobs.py`. Extend `_reap_loop`
  with a **third branch in its OWN try** (fable F-8: a deletion error must not skip job recovery) + boot
  re-sweep. Cap claims/tick; the claim is the dedup (Codex #2/#8) — no re-`_spawn` of an already-claimed
  uid.
- **Overdue/failure workflow (Codex #11):** track `attempts`, `last_error`, `next_attempt_at` (backoff),
  `statutory_deadline`; an admin "overdue" view + an operator alert as the deadline approaches.
- Gated by **`_DELETION_EXECUTION_READY`** (fail-closed) until schema+barrier verified (Codex #7).

### 3.6 Completion notification (T7 — legally required, NOT deferred; Codex #6)
`backend/notifications.py` — Resend direct HTTP + a **durable outbox** row (retain the minimum email
address until scheduled/cancelled/**completed/failed** is delivered, then drop). Emails: scheduled
(date + cancel link), cancelled, **completed** (GDPR Art.12 / CCPA response), failure/operator alert.
Best-effort send must not block a state transition, but the outbox guarantees eventual delivery + retry.

### 3.7 Hardened `/admin` (T8; Codex #9/#13)
`require_admin`: (1) valid JWT; (2) **founder allowlist** `ADMIN_USER_IDS` — parse **fail-closed at
REQUEST time** (403 if unset/malformed + loud boot log), NOT boot-fatal (fable F-6: don't crash-loop the
shared web process); (3) **founder still exists + active** (Codex #9); (4) **step-up on EVERY `/admin`
route incl. GET** (the user list is personal data) — passphrase (`X-Admin-Passphrase`) `hmac.compare_digest`
vs `ADMIN_ACTION_SECRET`, which **mints a short-lived admin capability token** rather than forwarding the
long-term secret on each request (Codex #9). Lockout keyed **primarily on founder UUID** (+ secondary
trusted-proxy bucket; never raw forwarded IP), TTL + exponential backoff, high-entropy secret validated at
startup (Codex #13). Endpoints: `GET /admin/accounts` (status list), cancel/**expedite** (schedule-set).
All audited. Minimal page; full dashboard deferred.

### 3.8 Frontend (T9)
Delete card (destructive styling, mirror `SettingsView.tsx:126`) → **OTP re-challenge modal** (reuse
`sign-in/page.tsx`) → confirm → `POST /account/deletion` with the fresh token; clear local session on 200.
Pending banner ("deletes on {date} — Cancel", cancel re-challenges). `middleware.ts` third check
(`pending_deletion`) as UX gating only. Minimal founder-gated admin page (passphrase prompt → capability).
`backend-types.ts` mirrors all new shapes (guardrail #4).

### 3.9 Privacy honesty (T10; Codex #10)
Replace "email us" with the self-serve flow + 7-day grace. Precise carve-out: shared entries are
**public-source cache data no longer linked to an Astrail account** (NOT "de-identified"); define the
actual **backup retention window** + restore-and-reapply-erasure posture; **HMAC the audit uuid** (treat
as personal data) + give the audit a stated purpose/retention.

### 3.10 RLS regression (T10; Codex #12)
pgTAP: anon/authenticated cannot write any deletion-state column; a user reads only their own status;
`deletion_jobs`/`erasure_audit` are service-role-only. Ship Pydantic + TS + SQL + `assert_schema.py` together.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Fault-inject / gate focus |
|---|------|---------------------------|
| 1 | **Core choke-point** — `_assert_real_uuid` (F2/F3, catch ValueError+TypeError, strict equality) + `purge_account_memory` (strings→exceptions wrapper over `clear_memory`) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` (`backend/erasure.py`,`test_erasure.py`) | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; `≠"cleared"` ⇒ raise (behavioral, not vacuous mock-called); guard≠purge error. **Non-destructive stop-point.** |
| 2 | **mem0 event barrier** — `memory_events.event_id` col + persist in `persist_trip_memory` + `mem0_events.py` poll adapter + reconciler; swap clear-memory heuristic → event-state; flip `_CLEAR_RECONCILIATION_READY` + re-run smoke | old add materializes after first empty read → stays `unknown`/pending; adapter timeout bounded; #2 un-gate verified |
| 3 | **Schema + gate** — `account_status`/timestamps + `deletion_jobs` + `erasure_audit` migrations (no-FK, RLS service-role) + `assert_schema` manifest + `_DELETION_EXECUTION_READY` | both deploy orders; schema-drift gate fails code-first; audit has no cascade FK |
| 4 | **`erase_user` engine** (staged, leased, idempotent, barrier→purge→verify→auth-delete→audit) | mem0 unavailable aborts BEFORE delete; re-check claim+status before each irreversible step; crash-resume from stage; 404=success only with `auth_deleted` recorded; globals untouched |
| 5 | **Soft-delete + reauth + atomic guards** — RPCs (`request_/cancel_account_deletion`) + `require_fresh_reauth` + `account_status` guard in the 3 job-creating RPCs + `sign_out`(raw jwt) + endpoints | reauth required (stale token 401); cancel needs freshness>requested_at; job-create blocked when pending (atomic); re-request doesn't reset clock; guard-fail 500 not 200 |
| 6 | **Deletion sweep** — separate semaphore + `claim/renew/reclaim_deletion_job` + `_reap_loop` third branch (own try) + boot re-sweep + overdue tracking | cancelled-after-claim aborts; no double-dispatch; deletion error doesn't skip trip recovery; overdue escalates |
| 7 | **Completion notifications** — Resend HTTP + durable outbox (scheduled/cancelled/completed/failed + operator deadline alert) | send failure retried, never blocks state; outbox drops PII after delivery |
| 8 | **Hardened `/admin`** — allowlist(request-time fail-closed)+founder-active+passphrase step-up→capability+lockout(uuid-keyed)+GET/cancel/expedite | non-founder 403; bad passphrase lockout+backoff; `compare_digest` (fault-inject `==`); GET needs step-up; expedite sets schedule |
| 9 | **Frontend** — delete card + OTP modal + pending banner + cancel + middleware + admin page + `backend-types` | fresh token sent; failure never shows deleted; pending gates generation (backend is real guard) |
| 10 | **Privacy carve-out (HMAC audit, backup window) + RLS pgTAP** | wording matches code; pgTAP proves no client write path |
| 11 | **Live E2E gate** — seed user+trip/reel+mem0 → reauth+request (status flip, gen blocked) → force grace lapse → sweep drains event_ids→delete_all+verify→auth-delete → assert 22 tables empty, globals intact, mem0 reconciled+empty, audit stages, completion email; + #2 un-gate check | the cascade+barrier PROOF on rebased local schema |

Deferrals: §8, each with a trigger.

## 5. Test / verification
- Unit T1–T10; `_assert_real_uuid`/`purge_account_memory` adversarial (each guard reddens ALONE — avoid the
  BUILD-LOOP "tests that cannot fail" traps; the reuse test must be behavioral, not mock-called-vacuous).
- mem0 barrier: the "late-materializing add" test is the load-bearing one.
- Cascade+barrier proof = T11 (rebased local Postgres, derive the 22-table list from `information_schema`).
- `uv run pytest evals/ -q` green after every backend change (anchor `6229.0` immovable); `tsc`+`vitest`+
  `pytest` green per task. `/qa` on the delete/cancel/reauth flow (UI+auth → required).

## 6. Risks & mitigations
- Orphaned memory (F1) → provable event-id barrier + abort-on-unavailable + verify-empty.
- Over-delete (`"*"`/`None`) → single `_assert_real_uuid` choke; engine never takes client uid.
- Delete a cancelled account (Codex #2) → re-check claim+status before each irreversible step; expedite=schedule.
- New memory after request (Codex #3) → atomic `account_status` guard in every job-creating RPC.
- Lost deletion record (Codex #4) → intent-first no-FK staged audit.
- Stolen token deletes (Codex #5) → reauth + freshness>requested_at + status/existence checks + session clear.
- No compliant response (Codex #6) → durable completion outbox.
- Deploy skew (Codex #7) → schema manifest + `_DELETION_EXECUTION_READY` + both-order tests.
- Recovery starvation (Codex #8) → separate deletion semaphore + per-branch try.
- `/admin` (Codex #9/#13) → step-up-on-all + founder-active + capability token + uuid-keyed lockout.
- Promise false (Codex #10) → precise policy + HMAC audit + backup window.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Full rigor (provable barrier, not the grace-period mitigation) ✅ · self-serve graceful ✅ · 7-day grace ✅ ·
`/admin` login+passphrase step-up (not bare PIN) ✅ · reuse `clear_memory`/`jobs.py`/`request_seat`/
`geocode_country_cache` patterns ✅ · un-gate clear-memory as part of T2 ✅.

## 8. Deferrals (with triggers)
- Dedicated external deletion worker → once durable claims + separate semaphore exist and load demands it.
- KV-backed admin lockout → past one Render instance.
- Rich admin dashboard → post-beta.
- MFA/AAL step-up → when an MFA feature exists (OTP reauth suffices now).
- Per-request DB existence check on ALL routes → only the few destructive/admin/memory routes get it now
  (Codex #5 scoped); global check deferred unless abuse appears.

## 9. Review folds (Rev 1 → Rev 2)
- **fable:** F-1→§3.1/T1 (wrapper) · F-2→§3.5 (claim dedup) · F-3→§2/T3 (manifest) · F-4→§3.4 (RPCs) ·
  F-5→§3.3 (intent-first) · F-6→§3.7 (request-time fail-closed) · F-7→T2 (#2 un-gate replaces the "lying
  button" — now genuinely fixed, not a homeless deferral) · F-8→§3.5 (own try) · F-9→F2/F3 (TypeError,
  strict eq) · F-10→§3.4 (raw jwt) · F-11→§8/§7 (re-signup fresh trial: documented, beta-acceptable).
- **Codex:** #1→§3.2 (provable barrier) · #2→§3.3 (claim/CAS/expedite) · #3→§3.1 F4/§3.4 (atomic guards) ·
  #4→§3.3 (no-FK intent-first) · #5→§3.4 (reauth+status checks) · #6→§3.6 (outbox) · #7→§3.5/T3 (gate) ·
  #8→§3.5 (separate semaphore) · #9→§3.7 · #10→§3.9 · #11→§3.5 (overdue) · #12→§3.10 (pgTAP) · #13→§3.7
  (lockout) · #14→T2 (button honesty).

## 10. Open items for the re-review
- **Timed-out add with no captured event_id** (barrier edge): proposed — treat as "barrier-unprovable" →
  the job holds in `memory_reconciled` with a bounded extended verify + overdue escalation rather than
  proceeding. Re-review to confirm this closes the residual or demands a stricter rule.
- **CCPA §7061 reauth window** — 300s is a product choice; confirm against the primary reg text before
  treating any number as compliance-locked.
- **`capture_saved_reel` guard** — gate saved-reel capture on `account_status` too, or only job creation?
  (Not a mem0 writer; a UX/consistency call.)

_Re-review status: pending fable eng-review + Codex `gpt-5.6-sol` (§ BUILD-LOOP step 3, second round)._
