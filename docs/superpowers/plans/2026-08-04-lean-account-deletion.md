# Plan — Lean self-serve account deletion + 7-day grace

> Draft 2026-08-04 · **Lean Rev 3** (Direction B) · Rev 2 folded the Codex lean review (5 bugs); **Rev 3
> drops reauth** (ZH — Astrail is passwordless, so an emailed-code reauth adds ~nothing; the confirm +
> 7-day grace + notification email is the real protection). branch `zh` · backend lane. Citations grounded
> this session.
> **This is the ACTIVE build plan.** The full-rigor version (`2026-08-04-self-serve-account-deletion.md`,
> Rev 4, 13 tasks) is **SHELVED as the scale-up blueprint** — adopt its pieces per §8 triggers.
> **Destructive + legally-binding. Implement task-by-task; STOP after Task 1 (non-destructive) for human
> review before anything destructive is wired. Do NOT merge/PR/deploy without ZH review.**

---

## 0. TL;DR + shape

Astrail is **passwordless** (Google OAuth + emailed OTP code; `privacy/page.tsx:48` "we never store a
password"). A signed-in user deletes their own account from **Settings**: **type-to-confirm** ("this is
permanent") → the account enters a **7-day cancellable grace**, and we **immediately email a "deletion
scheduled — cancel by {date}" notice** (the safety net) + show a pending banner with Cancel. New mem0
writes are **frozen** for the account the moment it's pending. After 7 days a lightweight sweep runs a
**two-pass** delete: (pass 1) atomically claim `pending_deletion → deleting` (point of no return), purge
mem0 + verify empty; (pass 2, a later tick) re-verify still-empty, then hard-delete `auth.users` (cascade
wipes the user tables), send a best-effort completion email, and mark the log. If mem0 can't be confirmed
empty, it **retries with backoff and flags for a human — never marks "deleted."** Same machine un-lies the
"Clear memory" button (launch-gate #2).

**Honest cost: ~6 small tasks, days.** A real, honest deletion. It skips the enterprise machinery
(event-id barrier, leased/fenced jobs, webhook proof, hardened `/admin`, HMAC audit) — but NOT
actually-deleting, verifying, or telling the truth.

---

## 1. Lean vs full-rigor — keep / drop

**KEEP:** Settings button → **type-to-confirm** → real delete + **verify (two-pass, freeze-new-writes)** →
**7-day grace + Cancel** (with an atomic point-of-no-return) → **notification emails (scheduled = the
safety net; completed)** → honest `/privacy` → un-lie the "Clear memory" button (#2).
**DROP:** **reauth** (§3.3 — a passwordless app can't "re-enter a password"; email-code reauth adds ~
nothing since email access already = full account access; replaced by confirm + grace + notification) ·
provable event-id barrier · leased/fenced jobs + per-stage CAS · separate semaphore · webhook
delivery-confirmation · hardened `/admin` · HMAC/§7101 audit · full RLS/service-role freeze. §6 records
what we consciously accept; §8 the upgrade triggers.

---

## 2. Grounded facts (verified 2026-08-04)

- **Passwordless auth:** sign-in is Google OAuth + email OTP (`sign-in/page.tsx:90` OAuth, `:107`
  `signInWithOtp`, `:127` `verifyOtp`); no password (`privacy/page.tsx:48`). ⇒ "reauth" would mean
  re-emailing a code, which a session-only attacker's victim can already defeat via the grace email, and
  which an email-holding attacker can trivially pass — so it's dropped (§3.3).
- **Cascade:** `public.users.id → auth.users(id) ON DELETE CASCADE`
  (`20260701131304_identity_persona_foundation.sql:18-19`) → `auth.admin.delete_user(uid,
  should_soft_delete=False)` wipes the user-scoped tables (**~24 of 27 public tables; 3 globals** — derive
  the exact list from `information_schema` in T6). `users` has no client UPDATE policy (only
  `users_select_own:182`) → status columns are service-role-write-only. Globals + `reel-covers` survive.
- **mem0 `"cleared"` is NOT terminal-proof.** `clear_memory` (`pipeline/memory_clear.py:153`, returns
  `{cleared,unavailable,unknown}`, needs the Supabase `client` to arm its marker `:172`) only checks
  in-flight adds **younger than 30s** (`:135`); mem0 has shown a **17-min queue** (`:28`); the gate
  `_CLEAR_RECONCILIATION_READY=False` (`main.py:310`; live-repro rationale `main.py:285`) exists because
  `"cleared"` can be a false positive. **⇒ the account path must NOT treat one `"cleared"` as proof
  (§3.4).**
- **New mem0 writes come only from `persist_trip_memory`** (`pipeline/preferences.py:306`, `mem0.add`
  `:346`), reachable only after a `jobs` row. Generation entrypoints: `reserve_and_enqueue_trip_job`
  (`20260804000000_reserve_replay_on_exhausted.sql:15`), `_generate_trip_legacy` (`main.py:461`→`:510`),
  `create_organize_job` (`organizer.py:79`). **Freeze = fail-closed `persist_trip_memory` for pending/
  deleting + block new gen.**
- **Sweep host:** the reaper `_reap_loop` runs **every 120s** (`main.py:78/113`; `reclaim_expired_jobs`
  `jobs.py:212`) — add a deletion branch **in its own try**; use `next_attempt_at` for backoff.
- **Sensitive RPC idiom:** `security definer` + `search_path=''` + **`revoke … from public, anon,
  authenticated; grant execute to service_role`** (`20260804000000:163`). The new RPCs take `p_user_id` →
  MUST pin privileges this way, else an authenticated user could delete/cancel another uuid via PostgREST.
- **Log table:** FK-free, RLS service-role-only (mirror `geocode_country_cache` `20260720110000:39-41`) —
  survives the cascade. **Schema gate:** `assert_schema.py` `REQUIRED_SCHEMA` (`:63`, columns-only) —
  extend same PR.
- **Email:** Resend direct HTTP. **Privacy page** promises deletion + mem0 erasure today
  (`privacy/page.tsx:131`); the Settings button still imports the MOCK `clearMemory` (`SettingsView.tsx:8`).

---

## 3. Design

Invariant: the deleted `user_id` is the authenticated caller's JWT `sub` (self-serve only) — the RPCs pin
privileges to service_role so a client can't pass someone else's `p_user_id` (§2). The T1 choke-point
(`_assert_real_uuid`) guards the value; never `"*"`/`None`/`reset()`.

### 3.1 State (T2)
- `users.account_status text NOT NULL DEFAULT 'active' CHECK IN ('active','pending_deletion','deleting')`
  (`deleting` = the atomic point of no return), `deletion_requested_at`, `deletion_scheduled_for`
  (service-role-write-only).
- `account_deletion_log` (no FK, RLS service-role-only, **stated retention period**): `id`, `user_id`
  (plain uuid), `recipient_email` (captured at request, cleared after the completion send), `requested_at`,
  `scheduled_for`, `attempts`, `next_attempt_at`, `last_error`, `purged_verified_at`, `completed_at`,
  `outcome text CHECK IN ('pending','deleting','completed','failed','cancelled')`.

### 3.2 Request / cancel (T2) — privilege-pinned, race-safe, no reauth
- `request_account_deletion(p_user_id)` — `revoke/grant service_role`; CAS `active→pending_deletion`,
  `deletion_scheduled_for = now()+INTERVAL '7 days'`, insert a fresh log row (`pending`) **capturing the
  user's email** (for the notices). Reject if already pending/deleting. The endpoint then fires the
  **immediate "scheduled" email** (§3.5).
- `cancel_account_deletion(p_user_id)` — CAS **`pending_deletion→active` ONLY** (fails if already
  `deleting` → endpoint returns `409 deletion_already_started`); atomically mark the log `cancelled` **and
  CLEAR the timestamps** so a later re-request gets a brand-new 7-day schedule + new log.
- Endpoints `POST /account/deletion` + `/account/deletion/cancel`: normal auth (a valid logged-in
  session) — **no reauth step, no forced sign-out** (the account still exists during grace; the user stays
  logged in to see the banner + Cancel; sessions become invalid naturally when the auth user is deleted at
  grace-end). Requests use the Bearer token (not cookies), so there's no CSRF vector.

### 3.3 Safety model (T-frontend + T-notify) — replaces reauth
Three cheap layers instead of reauth:
1. **Type-to-confirm** in the delete dialog (type your account email, or the word `DELETE`) — kills the
   fat-finger / "someone idly clicked it" case.
2. **7-day grace + in-app Cancel** — a wrong or malicious request is fully reversible for a week.
3. **Immediate "deletion scheduled — cancel by {date}" email** (§3.5) — the load-bearing net: even someone
   at your unlocked laptop can't quietly delete you, because you get the email and cancel. (And a
   passwordless account is already only as safe as its email inbox — an email-holding attacker could log in
   fully regardless, so email-code reauth would add nothing.)
Upgrade to a real reauth / one-use intent only if abuse appears (§8).

### 3.4 Delete engine + sweep (T3) — two-pass, honest-or-flag
Freeze first: **`persist_trip_memory` fails closed for `pending_deletion`/`deleting` accounts** + block new
generation (§3.6). `erase_user(client, mem0, log_row)`:
- **Pass A** (`pending`, `scheduled_for<=now`): atomically CAS `account_status pending_deletion → deleting`
  (point of no return — a concurrent cancel now loses; also dedups sweepers). Assert **no non-terminal
  trip/organize jobs** for the user (quiescence — near-certain after 7 days). `purge_account_memory` (T1
  wrapper). If NOT confirmed cleared → `last_error`+`attempts`+`next_attempt_at` backoff, **stay, retry;
  after N flag a loud error. NEVER hard-delete on an unconfirmed purge.** On confirmed clear → set
  `purged_verified_at`, log `deleting`. **Exception discipline (T1-review note): the backoff path catches
  ONLY `(MemoryBackendUnavailable, MemoryPurgeError)` — NOT the shared `ErasureError` base — so a corrupted
  `user_id` (`InvalidUserId`) propagates as a hard, non-retryable failure instead of looping forever; also
  ensure `log_row.user_id` is a `str` before the call (a native `uuid.UUID` fails closed correctly, but
  pass a str).**
- **Pass B** (`deleting`, `purged_verified_at` set, ≥1 sweep tick later = settle gap): **re-verify mem0
  still empty** (catches a late queued add). Then hard-delete `auth.users(uid, should_soft_delete=False)`
  → cascade. Best-effort completion email to the stored `recipient_email`, clear it, mark log `completed`.
- **Crash recovery:** the status re-read must handle **`public.users` MISSING** (auth-delete cascaded it):
  log `deleting` + auth user absent → treat as done, finish email + `completed`. A 404 from `delete_user`
  on re-run = already gone = success.
Idempotent; `_reap_loop` deletion branch (own try) selects `outcome IN ('pending','deleting') AND
next_attempt_at<=now`.

### 3.5 Notifications + clear-memory un-lie (T4)
- **"Scheduled" email (load-bearing safety net):** fired immediately on request — "your account will be
  deleted on {date}; cancel any time before then: {how}". Best-effort but prominent.
- **"Completed" email:** on final deletion. (Optional "cancelled" confirmation.) Best-effort; a failure
  retries via `next_attempt_at`. No webhook proof (§8).
- **#2:** rewire `SettingsView.tsx:8` off the mock to the real `POST /settings/memory/clear`, surfacing
  `unavailable`/`unknown` honestly (kills the fake-success lie). The sync button shows a truthful
  "clearing…/cleared as far as we can confirm" state, not an absolute "cleared ✅"; the false-`"cleared"`
  risk only arises during a concurrent in-flight add (rare from the manual Settings context).

### 3.6 Generation freeze (T3)
App-level `account_status='active'` check at the 3 generation entrypoints (a pending/deleting account gets
a clean "scheduled for deletion" response) **plus the `persist_trip_memory` fail-closed** (§3.4) — the
latter is the load-bearing half (stops new mem0 data; relational data is handled by the cascade). No
DB-level fortress.

### 3.7 Frontend (T5)
Delete card (destructive styling, `SettingsView.tsx:126/130`) → **type-to-confirm dialog** (enter account
email or `DELETE`) → `POST /account/deletion`. Pending banner ("deletes on {date} — Cancel"; if the row is
already `deleting`, show "deletion in progress — can't cancel"). Rewired clear-memory button.
`backend-types.ts` mirrors new shapes. Self-serve control **hidden behind the readiness flag** until the
backend is live (no 503 button; keep "email us" copy until flip).

### 3.8 Deploy gate + privacy (T6)
Fail-closed `_DELETION_EXECUTION_READY` (default False) gates the request endpoint + the sweep; ship
schema-first, flip last. Extend `assert_schema` `REQUIRED_SCHEMA` same PR. Make `/privacy`
(`page.tsx:131`) honest: self-serve flow + 7-day grace + name the short residual windows (Render logs,
Resend send-log ~30d) now that OpenAI tracing is off (`52f2cce`). Couple the copy to the flag flip.

---

## 4. Task breakdown (subagent-driven, TDD) — do in order; **STOP after Task 1**

| # | Task | Focus / fault-inject |
|---|------|----------------------|
| 1 | **Core choke-point** (`backend/erasure.py`,`test_erasure.py`) — `_assert_real_uuid` (strict `str(uuid.UUID(u))==u`; catch ValueError+TypeError; OUTSIDE try) + `purge_account_memory(client, mem0, user_id)` (`≠"cleared"` ⇒ raise) + `InvalidUserId`/`MemoryBackendUnavailable`/`MemoryPurgeError` | `"*"`/`None`/`""`/brace-uuid → raise before any mem0 call; behavioral fault tests; guard≠purge. **Non-destructive stop-point; nothing imports it; gates False. T3 must NOT treat wrapper-success as terminal (§3.4 two-pass).** |
| 2 | **Schema + request/cancel** — `account_status`(+`deleting`)/timestamps + `account_deletion_log`(no-FK, RLS, retention) + `request_/cancel_account_deletion` RPCs (**revoke/grant service_role**; capture email; cancel clears timestamps) + endpoints (normal auth, no reauth/sign-out) + `assert_schema` + readiness flag + `_down` twin | direct anon/authenticated RPC call REJECTED (privilege pin); cancel→active only pre-`deleting`; re-request fresh 7-day; `cancelled` storable; no reauth dependency |
| 3 | **Delete engine + sweep + freeze** — two-pass `erase_user` (CAS→`deleting`, quiesce, purge+verify, **settle-tick re-verify**, auth-delete) + crash-recovery(missing public.users) + `_reap_loop` branch(own try, `next_attempt_at`) + `persist_trip_memory` fail-closed + gen entrypoint checks | unconfirmed mem0 → retry+flag, NEVER hard-delete; cancel-mid-purge loses to `deleting` CAS; late-add caught by pass B; crash post-auth-delete completes not wedges; no new adds while pending |
| 4 | **Notifications + clear-memory un-lie (#2)** — Resend best-effort **scheduled** email (on request, the safety net) + **completed** email (pre-captured address) + rewire `SettingsView` off mock → real POST + honest states | scheduled email fires on request; email failure retried via `next_attempt_at`, never blocks delete; button no longer fakes success |
| 5 | **Frontend** — delete card + **type-to-confirm** dialog + pending banner(+`deleting` no-cancel) + cancel + `backend-types` + readiness-gated. (clear-memory rewire is **Task 4** per §3.5 — NOT here.) | confirm requires typing email/DELETE; failure never shows "deleted"; self-serve hidden pre-flip; `deleting` can't be cancelled in UI |
| 6 | **Privacy + live smoke + flip flag** — honest `/privacy` + live E2E (seed user+trip+mem0 → request → scheduled-email + freeze proven (new add rejected) → force grace lapse → two-pass sweep purges+re-verifies+auth-deletes → assert user rows gone, globals intact, mem0 empty, log `completed`; + cancel-race + crash-recovery cases) + flip `_DELETION_EXECUTION_READY` | real cascade+purge proof on local Postgres; #2 un-gate check; privacy copy matches behavior |

## 5. Test / verification
- T1 adversarial (each guard reddens alone; reuse test behavioral).
- **Load-bearing lean tests:** unconfirmed-purge never hard-deletes; a mem0 add materializing at purge
  time is caught by pass B (or blocked by the freeze); cancel landing mid-Pass-A loses to the `deleting`
  CAS; crash after auth-delete completes the log; direct anon/authenticated RPC call is rejected; the
  scheduled email fires on request.
- `uv run pytest evals/ -q` green (anchor `6229.0`); `tsc`+`vitest`+`pytest` green per task; `/qa` on the
  delete/cancel flow. Live proof = T6.

## 6. What we consciously ACCEPT going lean (on the record)
- **No reauth:** confirm + 7-day grace + immediate notification email is the protection. Sound for a
  **passwordless** app — an attacker with your email can already log in fully, and a session-only attacker
  is caught by the grace email. Upgrade = reauth / one-use intent (§8).
- **mem0:** two-pass verify + freeze-new-writes + retry/flag, not a per-add event-id proof. Residual is
  bounded and **flagged for a human — never a false "deleted."**
- **Crash-proofing:** simple-idempotent sweep + one `deleting` CAS, not leased/fenced per-stage.
- **Delivery:** best-effort emails, not webhook-confirmed.
- **No `/admin`:** a stuck (flagged) deletion → founder fixes via SQL/script.
- **Freeze scope:** new mem0 writes + new generation blocked; other edits allowed in grace (all deleted at
  grace-end).
- **Audit:** a plain service-only `account_deletion_log` (stated retention), not HMAC/§7101. §7101 applies
  only if actually in-scope (a 25-seat co is usually below thresholds); GDPR Art.17 needs erasure-without-
  undue-delay, not HMAC. Confirm applicability before launch (cheap: a lawyer eyeball of `/privacy`).
Each has a Rev-4 upgrade in §8.

## 7. Decisions — RESOLVED (ZH, 2026-08-04)
Lean self-serve (B) ✅ · 7-day grace + cancel ✅ · **reauth DROPPED — confirm + grace + notification email
is the safety net (passwordless)** ✅ · type-to-confirm as the accidental-delete guard ✅ · reuse
`clear_memory`/`_reap_loop`/`geocode_country_cache` patterns ✅ · un-lie clear-memory in T4 ✅ · no `/admin`
for beta ✅ · OpenAI tracing OFF (done `52f2cce`) ✅ · Rev 4 shelved ✅.
**Build-time minor:** sweep host = `_reap_loop` branch (default, zero infra) vs Render cron.

## 8. Upgrade triggers — pull a Rev-4 piece off the shelf when…
reauth / one-use intent → malicious or disputed deletions appear · provable mem0 barrier +
`barrier_blocked` → the "flag for manual" fires often or a DPA demands provable erasure · leased/fenced job
+ semaphore → past one worker's load / a real crash incident · webhook delivery-confirmation → a "did they
get it" compliance ask · hardened `/admin` → non-founders action deletions · HMAC + §7101 schema → a
regulator requires the format · full RLS/service-role freeze → editing-during-grace causes a real problem.

## 9. Review folds
**Rev 1 → Rev 2 (Codex lean review):** false-`"cleared"`→§2/§3.4 (freeze + quiesce + two-pass) ·
cancel-race→`deleting` CAS · CHECK/cancel-schema→states + clear-timestamps + fresh re-request ·
crash-post-auth-delete→recovery for missing `public.users` + pre-captured email · RPC-privilege→
revoke/grant service_role · 120s-cadence→`next_attempt_at` · table-count→~24/27 · log-retention.
**Rev 2 → Rev 3 (ZH):** **dropped reauth** (passwordless) — removed `_decode_claims`/`amr`/tight-window +
forced sign-out; the immediate **scheduled notification email** becomes load-bearing (§3.3/§3.5) and
**type-to-confirm** becomes the accidental-delete guard (§3.7).

_Next: on ZH's go — build Task 1 and STOP for review. (Rev 3 is a simplification of the reviewed Rev 2; a
re-review is optional — dropping a step + adding an email is lower-risk than the Rev-2 fixes.)_
