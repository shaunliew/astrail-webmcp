# Plan — Lean self-serve account deletion + 7-day grace

> Draft 2026-08-04 · **Lean Rev 2** (Direction B) · **folds the Codex `gpt-5.6-sol` lean review (BLOCK
> 4/10 → 5 lean-level correctness/security bugs in Rev 1, none needing the fortress).** branch `zh` ·
> backend lane. Citations grounded this session (verified exact by the review).
> **This is the ACTIVE build plan.** The full-rigor version (`2026-08-04-self-serve-account-deletion.md`,
> Rev 4, 13 tasks) is **SHELVED as the scale-up blueprint** — adopt its pieces per §8 triggers.
> **Destructive + legally-binding. Implement task-by-task; STOP after Task 1 (non-destructive) for human
> review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**
> **ONE small sub-decision for ZH (§7): reauth strength — "recent-OTP window" (lean default) vs a one-use
> reauth intent.**

---

## 0. TL;DR + shape

A signed-in user deletes their own account from **Settings**: destructive confirm → **fresh OTP
re-challenge** → the account enters a **7-day cancellable grace** (pending banner + Cancel). New mem0
writes are **frozen** for the account the moment it's pending. After 7 days a lightweight sweep runs a
**two-pass** delete: (pass 1) atomically claim `pending_deletion → deleting` (point of no return), purge
mem0 + verify empty; (pass 2, a later tick) re-verify still-empty, capture the email, **then** hard-delete
`auth.users` (cascade wipes the user tables), send a best-effort completion email, and mark the log. If
mem0 can't be confirmed empty, it **retries with backoff and flags for a human — never marks "deleted."**
Same machine un-lies the "Clear memory" button (launch-gate #2).

**Honest cost: ~6 small tasks, days.** It is a real, honest deletion. It skips the enterprise machinery
(event-id barrier, leased/fenced jobs, webhook proof, hardened `/admin`, HMAC audit) — but NOT reauth,
actually-deleting, verifying, or telling the truth. The Rev-1 review found 5 lean-level bugs; Rev 2 fixes
all of them cheaply (§9).

---

## 1. Lean vs full-rigor — keep / drop

**KEEP:** Settings button → **fresh reauth** → real delete + **verify (two-pass, freeze-new-writes)** →
**7-day grace + Cancel** (with an atomic point-of-no-return) → best-effort completion email → honest
`/privacy` → un-lie the "Clear memory" button (#2).
**DROP (→ Rev-4 blueprint, §8 triggers):** provable event-id barrier / `barrier_blocked` · leased/fenced
staged jobs + per-stage CAS · separate semaphore · webhook delivery-confirmation · hardened `/admin` ·
HMAC + §7101 audit schema · full RLS/service-role freeze across all tables. §6 records what we consciously
accept.

---

## 2. Grounded facts (verified 2026-08-04)

- **Cascade:** `public.users.id → auth.users(id) ON DELETE CASCADE`
  (`20260701131304_identity_persona_foundation.sql:18-19`) → `auth.admin.delete_user(uid,
  should_soft_delete=False)` wipes the user-scoped tables (**~24 of 27 public tables; 3 are globals** —
  derive the exact list from `information_schema` in T6). `users` has no client UPDATE policy (only
  `users_select_own:182`) → status columns are service-role-write-only by construction. Globals +
  `reel-covers` bucket survive.
- **mem0 purge exists but its `"cleared"` is NOT terminal-proof.** `clear_memory`
  (`pipeline/memory_clear.py:153`, returns `{cleared,unavailable,unknown}`, needs the Supabase `client` to
  arm its marker `:172`) only checks in-flight adds **younger than 30s** (`:135`); mem0 has shown a
  **17-min pending queue** (`:28`); the route gate `_CLEAR_RECONCILIATION_READY=False` (`main.py:310`;
  live-repro rationale `main.py:285`) exists precisely because `"cleared"` can be a false positive while a
  queued add later appears. **⇒ the account path must NOT treat one `"cleared"` as proof (§3.4/T3).**
- **Reauth:** `signInWithOtp`→`verifyOtp` mints a fresh session with a new `amr[].timestamp` (a silent
  refresh re-stamps `iat` but not `amr`). `_decode` (`auth.py:93`) returns only `sub` and has callers at
  `auth.py:127/134` → add a NEW `_decode_claims` (don't mutate `_decode`) to read `amr`. `sign_out` needs
  the raw Authorization header (`rate_limit.py:60` discards the jwt). Reuse the OTP modal
  `sign-in/page.tsx:101-136`.
- **New mem0 writes come only from `persist_trip_memory`** (`pipeline/preferences.py:306`, `mem0.add`
  `:346`), reachable only after a `jobs` row. Generation entrypoints: `reserve_and_enqueue_trip_job`
  (`20260804000000_reserve_replay_on_exhausted.sql:15`), `_generate_trip_legacy` (`main.py:461`→`:510`),
  `create_organize_job` (`organizer.py:79`). **Freeze = fail-closed `persist_trip_memory` for pending/
  deleting accounts + block new gen.**
- **Sweep host:** the periodic reaper `_reap_loop` runs **every 120s** (`main.py:78/113`; reaper
  `reclaim_expired_jobs` `jobs.py:212`) — NOT daily. Add a deletion branch **in its own try**; use
  `next_attempt_at` on the log for backoff so a failing purge doesn't burn attempts in minutes.
- **Sensitive RPC idiom:** `security definer` + `search_path=''` + **`revoke … from public, anon,
  authenticated; grant execute to service_role`** (`20260804000000:163`). The new RPCs take `p_user_id` →
  they MUST pin privileges this way, else an authenticated user could delete/cancel another uuid via
  PostgREST.
- **Log table:** FK-free, RLS service-role-only (mirror `geocode_country_cache`
  `20260720110000:39-41`) — must survive the cascade.
- **Schema gate:** `scripts/assert_schema.py` `REQUIRED_SCHEMA` (`:63`, columns-only) — extend same PR.
- **Privacy page** promises deletion + mem0 erasure today (`frontend/app/privacy/page.tsx:131`); the
  Settings button still imports the MOCK `clearMemory` (`SettingsView.tsx:8`).

---

## 3. Design

Invariant: the deleted `user_id` is the authenticated caller's JWT `sub` (self-serve only) — the RPCs pin
privileges to service_role so a client can't pass someone else's `p_user_id` (§2). The T1 choke-point
(`_assert_real_uuid`) guards the value; never `"*"`/`None`/`reset()`.

### 3.1 State (T2)
- `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion','deleting')`
  (`deleting` = the atomic point of no return), `deletion_requested_at`, `deletion_scheduled_for`
  (service-role-write-only).
- `account_deletion_log` (no FK, RLS service-role-only, **stated retention period** — don't keep the uuid
  forever): `id`, `user_id` (plain uuid), `recipient_email` (captured pre-delete, cleared after send),
  `requested_at`, `scheduled_for`, `attempts`, `next_attempt_at`, `last_error`, `purged_verified_at`,
  `completed_at`, `outcome text CHECK IN ('pending','deleting','completed','failed','cancelled')`.

### 3.2 Request / cancel (T2) — privilege-pinned, race-safe
- `request_account_deletion(p_user_id)` — `revoke/grant service_role`; CAS `active→pending_deletion`,
  `deletion_scheduled_for = now()+INTERVAL '7 days'`, insert a fresh log row (`pending`). Reject if already
  pending/deleting.
- `cancel_account_deletion(p_user_id)` — CAS **`pending_deletion→active` ONLY** (fails if already
  `deleting` → endpoint returns `409 deletion_already_started`); atomically mark the pending log
  `cancelled` **and CLEAR `deletion_requested_at`/`deletion_scheduled_for`** so a later re-request gets a
  brand-new 7-day schedule + new log (fixes the stale-deadline delete).
- Endpoints `POST /account/deletion` + `/account/deletion/cancel`: `require_fresh_reauth` (§3.3);
  `sign_out(jwt, scope="global")` with the raw Authorization header; FE clears local session on 200.

### 3.3 Reauth (T2) — honest by construction
`require_fresh_reauth` uses a new `_decode_claims` to read `amr`: require `amr[].method` includes `otp`
and `amr[].timestamp` within a **tight window (≈120s)** — **no `iat` fallback**. Applied only to the two
deletion endpoints; the FE forces a real OTP re-challenge in the modal so the token is seconds old.
**Honest label (lean default):** this proves "OTP-authenticated within ~2 min," NOT "OTP initiated
specifically for this action" — documented as such (§7 sub-decision; upgrade = a one-use server reauth
intent the `amr` must postdate, §8).

### 3.4 Delete engine + sweep (T3) — two-pass, honest-or-flag
Freeze first: **`persist_trip_memory` fails closed for `pending_deletion`/`deleting` accounts** (no new
adds once deletion is requested) + block new generation (§3.6). `erase_user(client, mem0, log_row)`:
- **Pass A** (row is `pending`, `scheduled_for<=now`): atomically CAS `account_status pending_deletion →
  deleting` (point of no return — a concurrent cancel now loses; also dedups sweepers). Assert **no
  non-terminal trip/organize jobs** for the user (quiescence — near-certain after 7 days). `purge_account_
  memory` (T1 wrapper). If it does NOT confirm cleared → `last_error`+`attempts`+`next_attempt_at` backoff,
  **stay, retry; after N flag a loud error. NEVER hard-delete on an unconfirmed purge.** On confirmed
  clear → set `purged_verified_at`, log `deleting`.
- **Pass B** (row `deleting`, `purged_verified_at` set, ≥1 sweep tick later = a settle gap): **re-verify
  mem0 still empty** (catches a late-materializing queued add). Then hard-delete `auth.users(uid,
  should_soft_delete=False)` → cascade. Send best-effort completion email to the stored `recipient_email`,
  clear it, mark log `completed`.
- **Crash recovery:** the status re-read must handle **`public.users` MISSING** (auth-delete cascaded it):
  if the log is `deleting` and the auth user is absent → treat as done, finish the email + `completed`
  (fixes the "stuck pending forever" hole). A 404 from `delete_user` on re-run = already gone = success.
Idempotent throughout; `_reap_loop` deletion branch (own try) selects `outcome IN ('pending','deleting')
AND next_attempt_at<=now`.

### 3.5 Notifications + clear-memory un-lie (T4)
- Best-effort completion email (Resend direct HTTP) to the pre-captured `recipient_email`; a send failure
  retries via `next_attempt_at` (using the stored address), cleared after terminal. No webhook proof (§8).
- **#2:** rewire `SettingsView.tsx:8` off the mock to the real `POST /settings/memory/clear`, surfacing
  `unavailable`/`unknown` honestly (kills the fake-success lie regardless of the gate). **Flipping
  `_CLEAR_RECONCILIATION_READY`** is a smaller call — the sync button's false-`"cleared"` risk only arises
  during a concurrent in-flight add, which the manual-Settings context makes rare; ship the button showing
  a truthful "clearing…/cleared as far as we can confirm" state rather than an absolute "cleared ✅".

### 3.6 Generation freeze (T3)
App-level `account_status='active'` check at the 3 generation entrypoints (a `pending_deletion`/`deleting`
account gets a clean "scheduled for deletion" response) **plus the `persist_trip_memory` fail-closed**
(§3.4) — the latter is the load-bearing half (it stops new mem0 data; relational data is handled by the
cascade regardless). No DB-level fortress.

### 3.7 Frontend (T5)
Delete card (destructive styling, `SettingsView.tsx:126/130`) → OTP re-challenge modal
(`sign-in/page.tsx:101-136`) → confirm → `POST /account/deletion` with the fresh token; clear session on
200. Pending banner ("deletes on {date} — Cancel"; cancel re-challenges; if `deleting`, show "deletion in
progress — can't cancel"). Rewired clear-memory button. `backend-types.ts` mirrors new shapes. Self-serve
control **hidden behind the readiness flag** until the backend is live (no 503 button; keep "email us"
copy until flip).

### 3.8 Deploy gate + privacy (T6)
Fail-closed `_DELETION_EXECUTION_READY` (default False) gates the request endpoint + the sweep; ship
schema-first, flip last. Extend `assert_schema` `REQUIRED_SCHEMA` same PR. Make `/privacy` (`page.tsx:131`)
honest: self-serve flow + 7-day grace + name the short residual windows (Render logs, Resend send-log
~30d) now that OpenAI tracing is off (`52f2cce`). Couple the copy to the flag flip.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Focus / fault-inject |
|---|------|----------------------|
| 1 | **Core choke-point** (`backend/erasure.py`,`test_erasure.py`) — `_assert_real_uuid` (strict `str(uuid.UUID(u))==u`; catch ValueError+TypeError; OUTSIDE try) + `purge_account_memory(client, mem0, user_id)` (`≠"cleared"` ⇒ raise) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; behavioral fault tests; guard≠purge. **Non-destructive stop-point; nothing imports it; gates False. T3 must NOT treat wrapper-success as terminal proof (see §3.4 two-pass).** |
| 2 | **Schema + request/cancel + reauth** — `account_status`(+`deleting`)/timestamps + `account_deletion_log`(no-FK, RLS, retention) + `request_/cancel_account_deletion` RPCs (**revoke/grant service_role**; cancel clears timestamps) + `require_fresh_reauth`(`_decode_claims`, `amr`+otp, no iat) + endpoints + `sign_out`(raw jwt) + `assert_schema` + readiness flag + `_down` twin | direct anon/authenticated RPC call REJECTED (privilege pin); reauth req'd (stale/refresh 401); cancel→active only pre-`deleting`; re-request gets fresh 7-day; `cancelled` storable |
| 3 | **Delete engine + sweep + freeze** — two-pass `erase_user` (CAS→`deleting`, quiesce, purge+verify, **settle-tick re-verify**, capture email, auth-delete) + crash-recovery(missing public.users) + `_reap_loop` branch(own try, `next_attempt_at`) + `persist_trip_memory` fail-closed + gen entrypoint checks | unconfirmed mem0 → retry+flag, NEVER hard-delete; cancel-mid-purge loses to `deleting` CAS; late-add caught by pass B; crash post-auth-delete completes not wedges; no new adds while pending |
| 4 | **Completion email + clear-memory un-lie (#2)** — Resend best-effort (pre-captured address) + rewire `SettingsView` off mock → real POST + honest states | email failure retried via `next_attempt_at`, never blocks delete; button no longer fakes success; honest clear states |
| 5 | **Frontend** — delete card + OTP modal + pending banner(+`deleting` no-cancel) + cancel + rewired clear-memory + `backend-types` + readiness-gated | fresh token sent; failure never shows "deleted"; self-serve hidden pre-flip; `deleting` can't be cancelled in UI |
| 6 | **Privacy + live smoke + flip flag** — honest `/privacy` + live E2E (seed user+trip+mem0 → reauth+request → freeze proven (new add rejected) → force grace lapse → two-pass sweep purges+re-verifies+auth-deletes → assert user rows gone, globals intact, mem0 empty, log `completed`, email sent; + cancel-race + crash-recovery cases) + flip `_DELETION_EXECUTION_READY` | real cascade+purge proof on local Postgres; #2 un-gate check; privacy copy matches behavior |

## 5. Test / verification
- T1 adversarial (each guard reddens alone; reuse test behavioral).
- **The load-bearing lean tests:** unconfirmed-purge never hard-deletes; a mem0 add issued pre-request but
  materializing at purge time is caught by pass B (or blocked by the freeze); cancel landing mid-Pass-A
  loses to the `deleting` CAS; crash after auth-delete completes the log; direct anon/authenticated RPC
  call is rejected.
- `uv run pytest evals/ -q` green (anchor `6229.0`); `tsc`+`vitest`+`pytest` green per task; `/qa` on
  delete/cancel/reauth. Live proof = T6.

## 6. What we consciously ACCEPT going lean (on the record)
- **mem0:** two-pass verify + freeze-new-writes + retry/flag, not a per-add event-id proof. Residual is
  bounded and **flagged for a human — never a false "deleted"** (the Rev-1 false-success path is fixed).
- **Crash-proofing:** simple-idempotent sweep + one `deleting` CAS, not leased/fenced per-stage.
- **Delivery:** best-effort email, not webhook-confirmed.
- **No `/admin`:** a stuck (flagged) deletion → founder fixes via SQL/script.
- **Freeze scope:** new mem0 writes + new generation blocked; other edits allowed in grace (all deleted at
  grace-end).
- **Audit:** a plain service-only `account_deletion_log` (with a stated retention period), not HMAC/§7101.
  CCPA §7101 applies only if actually in-scope (a 25-seat co is usually below thresholds); GDPR Art.17
  needs erasure-without-undue-delay, not HMAC records. Confirm applicability before launch (cheap: a
  lawyer eyeball of the `/privacy` wording).
Each has a Rev-4 upgrade in §8.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Lean self-serve (B) ✅ · 7-day grace + cancel ✅ · reuse `clear_memory`/`_reap_loop`/`geocode_country_cache`
patterns ✅ · un-lie clear-memory in T4 ✅ · no `/admin` for beta ✅ · OpenAI tracing OFF (done `52f2cce`) ✅
· Rev 4 shelved ✅.
**Sub-decision (ZH, small): reauth strength** — (a) LEAN DEFAULT: OTP-method + `amr` within ~120s,
labelled honestly as "recent OTP" (cheapest honest); (b) one-use server reauth intent the `amr` must
postdate (true per-action binding, a bit more work). Default (a); confirm at T2.
**Build-time minor:** sweep host = `_reap_loop` branch (default, zero infra) vs Render cron.

## 8. Upgrade triggers — pull a Rev-4 piece off the shelf when…
provable mem0 barrier + `barrier_blocked` → the "flag for manual" fires often or a DPA demands provable
erasure · leased/fenced job + semaphore → past one worker's load / a real crash incident · one-use reauth
intent → if "recent-OTP" is judged too weak · webhook delivery-confirmation → a "did they get it"
compliance ask · hardened `/admin` → non-founders action deletions · HMAC + §7101 schema → a regulator
requires the format · full RLS/service-role freeze → editing-during-grace causes a real problem.

## 9. Review folds (Lean Rev 1 → Rev 2) — Codex lean review
#1 false-`"cleared"`→§2/§3.4 (freeze new writes + quiesce + two-pass re-verify; never hard-delete
unconfirmed) · #2 cancel-race→§3.1/§3.2/§3.4 (`deleting` CAS point-of-no-return) · #3 CHECK+cancel-
schema→§3.1/§3.2 (`cancelled`/`deleting` states; cancel clears timestamps; fresh re-request schedule) ·
#4 crash-post-auth-delete→§3.4 (recovery handles missing `public.users`; capture `recipient_email`
pre-delete) · #5 RPC privilege→§2/§3.2/T2 (revoke/grant service_role + anon/authenticated test) · reauth-
honesty→§3.3/§7 (`_decode_claims`, otp+tight-window, honest label / one-use-intent option) · 120s
cadence→§2/§3.4 (`next_attempt_at` backoff) · dedup→the CAS · table-count→§2 (~24/27) · log-retention→§3.1.

_Next: on ZH's go — build Task 1 and STOP for review. (The Rev-1 review is folded; a re-review of Rev 2 is
optional — the fixes are mechanical/lean, not new design.)_
