# Plan — Lean self-serve account deletion + 7-day grace

> Draft 2026-08-04 · **Direction B (lean self-serve), 7-day grace.** branch `zh` · backend lane
> (drive with subagents). Citations grounded this session (all verified exact in the Rev-4 R3 review).
> **This is now the ACTIVE build plan.** The full-rigor version
> (`2026-08-04-self-serve-account-deletion.md`, Rev 4, 13 tasks, dual-reviewed) is **SHELVED as the
> scale-up blueprint** — not deleted; adopt its pieces when the §8 triggers fire.
> **Destructive + legally-binding. Implement task-by-task; STOP after Task 1 (non-destructive) for human
> review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**

---

## 0. TL;DR + shape

A signed-in user deletes their own account from **Settings**: destructive confirm → **OTP re-challenge**
→ the account enters a **7-day cancellable grace**; a pending banner offers Cancel. After 7 days a
**lightweight sweep** runs the delete: purge mem0 memories **and verify empty** (reusing the existing
`clear_memory` guards; if it can't confirm, it **flags for a human — never lies**), then hard-deletes
`auth.users` (cascade wipes the 22 user tables), then sends a best-effort completion email, and logs the
outcome. Same machine un-gates + un-lies the existing "Clear memory" button (launch-gate #2).

**Honest cost: ~6 small tasks, days.** It is a real, honest deletion — it just skips the enterprise
machinery (provable event-id barrier, leased/fenced staged jobs, crash-recovery, webhook-delivery proof,
hardened `/admin`, HMAC audit) that only pays off at scale. What it does NOT skip: reauth, actually
deleting, verifying, and telling the truth.

---

## 1. Lean vs full-rigor — what we keep and drop

**KEEP (load-bearing at any scale):**
- **Settings delete button** → confirm → **fresh reauth (OTP re-challenge)** so a stolen/borrowed session
  can't delete the account.
- **Actually deletes + verifies:** mem0 `delete_all` + verify-empty (via the existing `clear_memory`
  contract); hard-delete `auth.users` (cascade). If mem0 can't be confirmed clear, **do NOT proceed to a
  "deleted" state** — retry next sweep, and after N attempts flag for manual attention.
- **7-day grace + Cancel.**
- **Best-effort completion email** + an honest `/privacy` page.
- **Un-lie the "Clear memory" button** (currently calls the mock — `SettingsView.tsx:8`) — launch-gate #2.
- **Block new trip generation while `pending_deletion`** (app-level status check — a clean UX signal +
  avoids burning the free-trial charge on a doomed account).

**DROP (deferred to the Rev-4 blueprint, §8 triggers):** provable event-id barrier + `barrier_blocked`
state machine · leased/fenced staged deletion job + per-stage CAS + crash-recovery · separate semaphore ·
webhook delivery-confirmation / `awaiting_delivery` lifecycle · hardened `/admin` capability system ·
HMAC audit + CCPA §7101 24-month field schema · full RLS/service-role freeze across all tables. **§6
records exactly what we consciously accept by dropping these — so we're not pretending.**

---

## 2. Grounded facts (verified 2026-08-04 · only what lean needs)

- **Cascade:** `public.users.id → auth.users(id) ON DELETE CASCADE`
  (`20260701131304_identity_persona_foundation.sql:19`) → `auth.admin.delete_user(uid,
  should_soft_delete=False)` wipes the 22 user tables. `users` has NO client UPDATE policy (only
  `users_select_own:182`) → new status columns are service-role-write-only by construction. Globals +
  `reel-covers` bucket survive (they carry no per-user identity).
- **mem0 purge already exists, gated:** `clear_memory` (`pipeline/memory_clear.py:153`) returns exactly
  `{cleared, unavailable, unknown}`, **needs the Supabase `client` to arm its marker** (`:172`), and
  already verifies-empty + in-flight-guards. The route is gated off `_CLEAR_RECONCILIATION_READY=False`
  (`main.py:310`; route `:318`, gate-return `:330`) and the Settings button still imports the MOCK
  (`SettingsView.tsx:8`). Lean bar ("best-effort + honest states") is exactly what `clear_memory` already
  provides → un-gate + rewire.
- **Reauth:** re-running `signInWithOtp`→`verifyOtp` mints a fresh session with a new `amr[].timestamp`
  (a silent refresh re-stamps `iat` but does NOT append `amr`) → the real freshness signal is `amr`, not
  `iat`. `_decode` (`auth.py:93`) returns only `sub` → a small **claims-returning** read is needed to see
  `amr`. Reuse the OTP flow `sign-in/page.tsx:101-136` as a modal. `sign_out` needs the raw Authorization
  header (the stashed helper `rate_limit.py:60` discards the jwt).
- **Generation entrypoints to freeze** (app-level status check): `reserve_and_enqueue_trip_job`
  (`20260804000000_reserve_replay_on_exhausted.sql:15`), `_generate_trip_legacy` (`main.py:461`→`:510`),
  `create_organize_job` (`organizer.py:79`).
- **Sweep host:** the existing periodic reaper `_reap_loop` (reclaims expired job leases via
  `reclaim_expired_jobs` `jobs.py:212`) — add a deletion branch **in its own try** (a deletion error must
  not skip job recovery). Grace is 7 days, so a ~daily cadence is ample. (Alt: a Render cron — §7.)
- **Log table pattern:** mirror `geocode_country_cache` — FK-free, RLS service-role-only
  (`20260720110000_geocode_country_cache.sql:39-41`). **No FK to `users`** (must survive the cascade).
- **Schema gate:** extend `scripts/assert_schema.py` `REQUIRED_SCHEMA` (`:63`, columns-only) in the same
  PR as the migration.
- **Email:** Resend direct HTTP (send subdomain per infra). **Privacy page** promises deletion today
  (`frontend/app/privacy/page.tsx:131`) — make it honest.

---

## 3. Design

Invariant: the deleted `user_id` is the authenticated caller's JWT `sub` (self-serve only). Never client-
supplied, never `"*"`/`None`, never `reset()`. The single choke-point (`_assert_real_uuid`, T1) guards it.

### 3.1 Soft-delete state (T2)
Migration: `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion')`,
`deletion_requested_at timestamptz`, `deletion_scheduled_for timestamptz` (service-role-write-only).
Plus a simple **`account_deletion_log`** table (no FK, RLS service-role-only): `id`, `user_id` (plain
uuid), `requested_at`, `scheduled_for`, `attempts`, `last_error`, `completed_at`, `outcome`
(`pending | completed | failed`). This is the durable record and the sweep's work-list.

### 3.2 Request / cancel (T2)
- RPC `request_account_deletion(p_user_id)` — CAS `active→pending_deletion`,
  `deletion_scheduled_for = coalesce(deletion_scheduled_for, now()+INTERVAL '7 days')` (**don't reset the
  clock on a re-request**), insert the `account_deletion_log` row. Reject if already pending.
- RPC `cancel_account_deletion(p_user_id)` — CAS `pending_deletion→active`, mark the log row cancelled.
- Endpoints `POST /account/deletion` + `/account/deletion/cancel`: require **fresh reauth** (§3.3);
  `sign_out(jwt, scope="global")` with the raw Authorization header; FE clears the local session on 200.

### 3.3 Reauth — the one security piece we keep honest (T2)
`require_fresh_reauth(max_age_s≈600)` dependency: a **claims-returning `_decode`** surfaces `amr`; require
an `amr[].timestamp` within the window (**no `iat` fallback** — a refresh would bypass it). Apply ONLY to
the two deletion endpoints. The FE forces a real OTP re-challenge (email code) — that challenge is the
actual protection; the backend `amr` check is the enforcement. (This is the ONE bit of "rigor" that is
load-bearing for *security*, not just scale — so it stays.)

### 3.4 Delete engine + sweep (T3)
`erase_user(client, mem0, user_id)` — idempotent, best-effort-honest:
1. `_assert_real_uuid` + re-read `account_status='pending_deletion'` (a cancel must abort).
2. `purge_account_memory` (T1 wrapper over `clear_memory`). **If it raises** (`unavailable`/`unknown`):
   record `last_error`, bump `attempts`, **leave the account pending, retry next sweep**; after N attempts
   (e.g. 5) log a loud error for manual attention. **Do NOT hard-delete on an unconfirmed purge.**
3. On confirmed purge: `auth.admin.delete_user(uid, should_soft_delete=False)` → cascade. (Idempotent: a
   404 on a re-run = already gone = success.)
4. Best-effort completion email (§3.5). Mark the log row `completed`.
Sweep: extend `_reap_loop` with a branch (own try) that selects log rows where `outcome='pending' AND
scheduled_for <= now()` and runs `erase_user`. The selection + attempts counter is the dedup. Idempotent
throughout — a crash mid-run just re-runs next tick.

### 3.5 Notifications (T4) + clear-memory un-lie (T4)
- **Completion email** (Resend direct HTTP, best-effort): "your account and data have been deleted."
  Best-effort — a send failure is retried on the next sweep but never blocks the delete. (No webhook
  delivery-proof — that's a §8 upgrade.)
- **Un-gate + un-lie clear-memory (#2):** flip `_CLEAR_RECONCILIATION_READY=True` (`main.py:310`) — the
  existing `clear_memory` already meets the lean bar — and rewire `SettingsView.tsx:8` to call the real
  `POST /settings/memory/clear`, surfacing `unavailable`/`unknown` honestly. Re-run `smoke_memory_clear.py`.

### 3.6 Generation freeze (T3)
An app-level `account_status='active'` check at the generation entrypoints (`request_account_enqueue`
path + `_generate_trip_legacy` + `create_organize_job`): a `pending_deletion` account gets a clean "your
account is scheduled for deletion" response. Lightweight (no triggers/atomic-fortress) — the final
`delete_all` wipes everything regardless, so this is UX + entitlement hygiene, not a correctness barrier.

### 3.7 Frontend (T5)
Delete card in Settings (destructive styling, mirror `SettingsView.tsx:126/130`) → OTP re-challenge modal
(reuse `sign-in/page.tsx:101-136`) → confirm → `POST /account/deletion` with the fresh token; clear local
session on 200. Pending banner ("deletes on {date} — Cancel"; cancel re-challenges). The rewired real
clear-memory button lands here too. `backend-types.ts` mirrors the new shapes (guardrail #4). **The
self-serve control is hidden behind the readiness flag** (§3.8) until the backend is live — no visible
button that 503s; keep the current "email us" copy until then.

### 3.8 Deploy gate + privacy (T6)
- A fail-closed readiness flag (`_DELETION_EXECUTION_READY`, default False) gates the request endpoint +
  the sweep, so we ship schema-first and flip last. Extend `assert_schema` `REQUIRED_SCHEMA` with the new
  columns/tables (same PR as the migration).
- Make `/privacy` (`page.tsx:131`) honest: describe the self-serve flow + 7-day grace, name the short
  retention windows that remain (Render logs, Resend send-log ~30d) now that OpenAI tracing is off
  (committed `52f2cce`). Couple the copy change to the flag flip.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Focus / fault-inject |
|---|------|----------------------|
| 1 | **Core choke-point** (`backend/erasure.py`,`test_erasure.py`) — `_assert_real_uuid` (strict `str(uuid.UUID(u))==u`; catch ValueError+TypeError; OUTSIDE try) + `purge_account_memory(client, mem0, user_id)` (wrapper over `clear_memory`: `≠"cleared"` ⇒ raise) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; behavioral fault tests (not mock-called); guard≠purge error. **Non-destructive stop-point. Nothing imports it; gates stay False.** |
| 2 | **Schema + request/cancel + reauth** — `account_status`/timestamps + `account_deletion_log` (no-FK, RLS service-role) migration + `request_/cancel_account_deletion` RPCs + `require_fresh_reauth` (claims-returning `_decode`, `amr`-only) + endpoints + `sign_out`(raw jwt) + `assert_schema` manifest + readiness flag | reauth required (stale/refresh 401); re-request doesn't reset the 7-day clock; cancel flips back to active; status cols not client-writable |
| 3 | **Delete engine + sweep + generation freeze** — `erase_user` (purge→verify→auth-delete, idempotent, unconfirmed-purge does NOT hard-delete) + `_reap_loop` deletion branch (own try) + `account_status` check at the 3 generation entrypoints | mem0 unavailable → retry, never hard-delete; cancel-before-run aborts; 404 auth-delete = success; deletion error doesn't skip job recovery; pending account can't generate |
| 4 | **Completion email + clear-memory un-lie (#2)** — Resend best-effort email + flip `_CLEAR_RECONCILIATION_READY` + rewire `SettingsView` button → real POST + honest states + re-run smoke | email failure retried, never blocks delete; clear-memory shows real `unavailable`/`unknown`; button no longer fakes success |
| 5 | **Frontend** — delete card + OTP modal + pending banner + cancel + rewired clear-memory + `backend-types` + readiness-gated (hidden until flag) | fresh token sent; failure never shows "deleted"; self-serve hidden pre-flip; pending banner shows the date |
| 6 | **Privacy + live smoke + flip flag** — honest `/privacy` copy + a live E2E smoke (seed user+trip+mem0 → reauth+request → force grace lapse → sweep purges+verifies+auth-deletes → assert user rows gone, globals intact, mem0 empty, log `completed`, email sent) + flip `_DELETION_EXECUTION_READY` | the real cascade+purge proof on local Postgres; #2 un-gate check; privacy copy matches behavior |

## 5. Test / verification
- T1 adversarial (each guard reddens alone — no "tests that cannot fail"; reuse test behavioral).
- Idempotency: crash-mid-sweep re-runs cleanly; unconfirmed mem0 purge → pending+retry, never a false
  "completed"; cancel-before-sweep aborts.
- `uv run pytest evals/ -q` green after backend changes (anchor `6229.0` immovable); `tsc`+`vitest`+
  `pytest` green per task. `/qa` on the delete/cancel/reauth flow. Live cascade+purge proof = T6.

## 6. What we consciously ACCEPT by going lean (on the record — not hidden)
- **mem0 provability:** we rely on `delete_all`+verify-empty+retry, not a per-add event-id proof. A lost
  mem0 add response in the rare race is not mathematically provable-erased; the retry + honest "flag for
  manual attention" (never a false "deleted") is our answer. Upgrade = Rev-4 barrier.
- **Crash-proofing:** the sweep is simple-idempotent, not leased/fenced. A pathological crash pattern
  could re-attempt a delete; deletes are idempotent so this is safe, just not "provably exactly-once."
- **Delivery:** completion email is best-effort, not webhook-confirmed.
- **No `/admin`:** a stuck deletion is resolved by the founder via direct SQL/script, not a hardened UI.
- **Freeze scope:** only new *generation* is blocked during grace; a user could still edit their own
  collections in the 7 days — harmless, it's all deleted at grace-end.
- **Audit:** a plain `account_deletion_log` row, not an HMAC'd ≥24-month CCPA §7101 field schema.
These are right-sized for a 25-seat beta; each has a Rev-4 upgrade in §8.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Lean self-serve (Direction B) ✅ · 7-day grace + cancel ✅ · reauth kept (OTP + `amr`, no iat) ✅ · reuse
`clear_memory`/`_reap_loop`/`geocode_country_cache` patterns ✅ · un-lie clear-memory in T4 ✅ · no `/admin`
for beta ✅ · OpenAI tracing OFF (done, `52f2cce`) ✅ · Rev 4 shelved as the scale-up blueprint ✅.
**Open (build-time, minor):** sweep host — `_reap_loop` branch (default, zero new infra) vs a Render cron
(cleaner isolation); confirm at T3.

## 8. Upgrade triggers — when to pull a Rev-4 piece off the shelf
- Provable mem0 barrier + `barrier_blocked` → if "flag for manual attention" fires often, or an enterprise/
  DPA customer demands provable erasure.
- Leased/fenced staged job + separate semaphore → past ~1 deletion worker's load, or if crash-safety
  becomes a real incident.
- Webhook delivery-confirmation → if "did the user actually get the email" becomes a compliance ask.
- Hardened `/admin` → when non-founders need to action deletions.
- HMAC audit + §7101 field schema → when a regulator/DPA actually requires the record format.
- Full RLS/service-role freeze → if editing-during-grace ever causes a real problem.

_Next: on ZH's go — recommend a single lean plan-review (the destructive T2/T3 warrant one pass), then
build Task 1 and STOP for review._
