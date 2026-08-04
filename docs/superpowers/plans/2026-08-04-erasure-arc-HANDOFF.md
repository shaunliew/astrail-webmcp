# HANDOFF — User-data-erasure arc (self-serve account deletion + mem0 barrier + /admin)

> Written 2026-08-04, end of session (session expiring; author had a meeting). Branch `zh`,
> worktree `/Users/desmondchyezhihao/Github/astrail-zh` (NOT the main checkout on `dev`).
> This captures state that otherwise lives only in the expiring session (the fable review came via
> SendMessage; the Codex reviews are in session-only scratchpad). **Everything below is the durable record.**

---

## ⏩ PICKUP — SESSION-3 CLOSE (2026-08-04) — READ THIS FIRST (supersedes everything below)

**STATE: the LEAN self-serve account-deletion feature (Direction B · 7-day grace · passwordless, NO reauth)
is CODE-COMPLETE and ALL GATED OFF.** Local commits on branch `zh` (worktree
`/Users/desmondchyezhihao/Github/astrail-zh`, NOT the main `dev` checkout); **NOTHING pushed / PR'd /
merged.** Active plan: `docs/superpowers/plans/2026-08-04-lean-account-deletion.md` (Lean Rev 3). The
full-rigor Rev 4 (`2026-08-04-self-serve-account-deletion.md`, 13 tasks) is SHELVED as the scale-up
blueprint — adopt its pieces per its §8 triggers.

**COMMIT MAP (this arc, all on `zh`, local):**
- Standalone honesty fix — OpenAI Agents tracing OFF: `52f2cce` (cherry-pickable to `dev` on its own).
- Plan: `664b392` (lean) → `cbb764b` (Rev 2, folds Codex lean review) → `5760610` (Rev 3, drops reauth).
- **T1** choke-point `89b7a42` (review APPROVED) · **T2** schema + request/cancel RPCs `98cc1bd` (SHIP,
  privilege-pinned) · **T3** two-pass delete engine + sweep + freeze `5cc6fda` + folds `76b7ecb` (opus
  SHIP) · **T5** frontend delete card `9fb1a59` (Approved) · **T4** Resend emails + clear-memory un-lie #2
  `9d3d81f` + folds `303b56b` (SHIP).
- **T6 CODE PARTS** (ZH-approved "code parts, stop before flipping flags"): `5fa0b33` (GET
  `/account/deletion/status` + email-latency bound) · `edc4393` (FE status wiring + 3 T5 folds) · `710adc7`
  (bare-`None` test) — combined review **SHIP**.

**GATES — ALL OFF (verify before any go-live):** `_DELETION_EXECUTION_READY=False` (`main.py:352`) ·
`_CLEAR_RECONCILIATION_READY=False` (`main.py:336`) · `NEXT_PUBLIC_DELETION_ENABLED` unset (delete UI
hidden) · no `RESEND_API_KEY` (emails no-op). Backend suite green (~1548 pass / 12 skipped), frontend green
(tsc clean; the only 2 full-suite fails are PRE-EXISTING in `SavedReelsFlow.test.tsx`), eval anchor 6229.0
holds. Every task per-task-reviewed (SHIP/APPROVED); every finding folded or explicitly deferred.

**REMAINING = T6 GO-LIVE SWITCHES ONLY — HELD for ZH (full detail in § T6 GO-LIVE CHECKLIST below):**
live pgTAP `019`/`020` on a rebased local Postgres → honest `/privacy` copy → set `RESEND_API_KEY` +
`RESEND_FROM_EMAIL` in `render.yaml` + decide `_CLEAR_RECONCILIATION_READY` → **flip
`_DELETION_EXECUTION_READY` + `NEXT_PUBLIC_DELETION_ENABLED`** (schema-first: migrations + config land
BEFORE the flag flip) → live `/qa` E2E → **FINAL whole-branch review — run BOTH `astrail-reviewer`
(fable/opus) AND gstack `/review` Codex cross-model** → PR/merge to `dev`, sync.

**DEFERRED (non-blocking):** T2 cancel cosmetic wrong-409-*message* race (never wrong state); a rate-limiter
on GET `/account/deletion/status` (matches the repo's unrated GET-status convention).

**GUARDRAILS:** destructive + legally-binding; everything gated off; do NOT flip flags, set secrets, merge,
PR, or push without ZH's explicit go; STOP before any flag flip.

### PICKUP PROMPT (paste to resume)
> Resume the Astrail LEAN account-deletion arc. Branch `zh`, worktree
> `/Users/desmondchyezhihao/Github/astrail-zh` (NOT the main `dev` checkout).
> READ FIRST: `docs/superpowers/plans/2026-08-04-erasure-arc-HANDOFF.md` (the ⏩ PICKUP block at the top,
> then § T6 GO-LIVE CHECKLIST) + `docs/superpowers/plans/2026-08-04-lean-account-deletion.md` (active Lean
> Rev 3) + memory `launch-gate-erasure-arc.md`.
> STATE: the lean self-serve account-deletion feature (Direction B, 7-day grace, passwordless — no reauth)
> is CODE-COMPLETE and ALL GATED OFF, as local commits on `zh` (nothing pushed/PR'd/merged). Tasks T1–T5 +
> T4 + the T6 code parts (status-read endpoint + FE wiring + all deferred folds) are built and each
> per-task-reviewed (SHIP/APPROVED); every finding folded or deferred. Backend + frontend suites green,
> eval anchor 6229.0 holds. OpenAI Agents tracing was disabled (`52f2cce`, standalone, cherry-pickable to
> dev). Full-rigor Rev 4 is SHELVED as the scale-up blueprint.
> WHAT REMAINS = T6 GO-LIVE SWITCHES ONLY — do NOT do without my explicit go, and STOP before flipping any
> flag: live pgTAP `019`/`020` on a rebased local Postgres; honest `/privacy` copy; set `RESEND_API_KEY` +
> `RESEND_FROM_EMAIL` in `render.yaml` + decide `_CLEAR_RECONCILIATION_READY`; flip
> `_DELETION_EXECUTION_READY` (`main.py:352`) + `NEXT_PUBLIC_DELETION_ENABLED` (schema-first); live `/qa`
> E2E; then the FINAL whole-branch review — run BOTH `astrail-reviewer`(fable/opus) AND gstack `/review`
> Codex — before any PR/merge to `dev`.
> GUARDRAILS: destructive + legally-binding; all gated off; don't flip flags / set secrets / merge / PR /
> push without my explicit go. Deferred non-blocking: T2 cancel cosmetic-message race; a rate-limiter on
> GET `/account/deletion/status`.
> FIRST: confirm you've read the handoff + plan, tell me the current gate state, and ask which T6 step I
> want to start with (or whether to run the final whole-branch review first as a pre-flight).

---

## ★★★ SESSION-2 PIVOT (2026-08-04) — history; superseded by the ⏩ PICKUP above

**ZH re-scoped after seeing full-rigor's cost: → LEAN self-serve (Direction B) + 7-day grace.** The
13-task full-rigor Rev 4 was correct-but-overkill for a 25-seat beta; the law needs an honest, real
deletion, not provable-exactly-once machinery.
- **ACTIVE PLAN NOW: `docs/superpowers/plans/2026-08-04-lean-account-deletion.md`** (~6 tasks, days). Keeps
  the button + reauth(OTP+`amr`) + real delete + verify + 7-day grace + honest email + un-lie clear-memory
  (#2). Drops the barrier/leased-jobs/webhook/`admin`/HMAC-audit machinery (see its §6 "what we accept" +
  §8 upgrade triggers). Task 1 is UNCHANGED (same non-destructive choke-point, both reviewers cleared it).
- **Rev 4 (`2026-08-04-self-serve-account-deletion.md`) is SHELVED** as the scale-up blueprint — not
  deleted; adopt its pieces when a §8 trigger fires.
- **DONE this session: OpenAI Agents SDK tracing DISABLED** (`52f2cce`) — it was ON by default, exporting
  gen/tool data to OpenAI's trace store, contradicting `/privacy`. `set_tracing_disabled(True)` at all 3
  `Runner.run` sites; verified `NoOpTrace`; genagents 109 pass. Standalone honesty fix, cherry-pickable to
  dev. Lesson recorded in `LESSONS-HACKATHON.md`.
- **Next:** on ZH's go — one lean plan-review of the destructive T2/T3, then build Task 1 and STOP. No
  build/wire yet this session.

**★ TASK 1 BUILT + REVIEWED (2026-08-04): `89b7a42` on zh (local).** `backend/erasure.py` +
`backend/test_erasure.py` — `_assert_real_uuid` (strict `str(uuid.UUID(u))==u`, catches
ValueError/TypeError/**AttributeError** — int→AttributeError on Py3.14, not TypeError as the plan guessed)
+ `purge_account_memory(client, mem0, user_id)` (guard-first, reuses `clear_memory`, tri-state→exceptions)
+ 3 distinct exceptions under an `ErasureError` base. Built by astrail-developer (opus, TDD, 20 behavioral
tests) → **astrail-reviewer (sonnet): APPROVED, no findings** (independent fault-injection in a scratch
copy, each guard reddens alone, unwired, gate untouched, keyless import; 20 pass + full offline suite 1487
pass). **STOPPED for ZH review** — nothing wired, no gate flipped, no push/PR/merge. **T3 note (folded into
plan §3.4):** the retry loop must catch ONLY `(MemoryBackendUnavailable, MemoryPurgeError)`, NOT the
`ErasureError` base, so `InvalidUserId` fails hard instead of looping.

**★ TASK 2 BUILT (2026-08-04): `98cc1bd` on zh (local).** Migration `20260805000000_account_deletion_lean.sql`
(+ rollback twin): `users.account_status IN (active/pending_deletion/deleting)` + timestamps; FK-free
service-role-only `account_deletion_log`; **privilege-pinned** `request_/cancel_account_deletion` RPCs
(revoke public/anon/authenticated + grant service_role — the Codex must-fix, present on both) with correct
CAS (request only from active; cancel only from pending_deletion, clears timestamps, loses to `deleting`).
`backend/deletion.py` service wrappers (PGRST202→503 fail-closed). `POST /account/deletion` + `/cancel`
endpoints in `main.py`, **503 when `_DELETION_EXECUTION_READY=False`** (before any DB call), JWT-sub only.
`assert_schema` extended; 14 endpoint/static tests + a 27-assert pgTAP (`supabase/tests/019_*`) staged for
the T6 live gate; 1501 pass. Orchestrator self-verified the migration + wrappers.

**★ PARALLEL WAVE (2026-08-04):** after T2's contract landed, launched 3 concurrent agents (disjoint
files): astrail-reviewer on T2 · T3 developer (engine/sweep/freeze) · T5 developer (frontend, flag-gated).
T4 (notifications) held for the next wave (also edits main.py). All gated OFF.
- **T2 REVIEW DONE: SHIP — no Critical/Important.** Privilege pin + gating + CAS + timestamp-clear all
  verified by independent fault-injection (4 mutations each reddened exactly one test). 4 Minors, all
  ACCEPTED/deferred: cancel post-CAS-miss `select` reads a raced value → **cosmetic wrong-409-message only,
  never wrong state** (`…lean.sql:123-129`); endpoints' `-> …Response` annotation vs raw JSONResponse on
  gated branches (harmless, no mypy gate; `clear_settings_memory` omits the annotation); no test for a
  non-PGRST202 APIError (inherited from request_seat); **[→T3] no index on `account_deletion_log(outcome,
  next_attempt_at)`** for the sweep query.
- **T3 REVIEW MUST CHECK (reviewer forward-notes):** (1) add the `(outcome, next_attempt_at)` index; (2)
  the `pending_deletion→deleting` claim CAS **and** the log `outcome='deleting'` write must be ATOMIC (one
  RPC/txn) — else a window where `users.account_status='deleting'` but the log still reads `'pending'`.
- **T5 BUILT: `9fb1a59`** (frontend, 7 files) — `backend-types` mirror + `api.ts` client + `DeleteAccountCard`
  (type-to-confirm email/`DELETE` → request → pending banner + Cancel; `deletion_already_started` locks
  Cancel) + `SettingsView` gated by `NEXT_PUBLIC_DELETION_ENABLED` (default OFF). tsc clean, 20 tests pass
  (2 full-suite fails are PRE-EXISTING in `SavedReelsFlow.test.tsx`, proven by stash). Committed only its
  7 frontend files (T3's concurrent WIP correctly excluded — disjoint file sets, shared worktree held).
  **T5 review IN FLIGHT.**
  - **[→T6 GAP] no cross-session `account_status` read:** the pending banner only shows after an in-session
    request (seeded via `DeleteAccountCard` `initialStatus` props = the T6 seam). T6 must wire a real status
    read (add `account_status`/`deletion_scheduled_for` to an existing settings/profile GET, or a new
    `GET /account/deletion/status`) so a returning user sees the banner + can Cancel.
  - **T5 REVIEW DONE: Approved — no Critical/Important.** All 8 checks passed (exact-match confirm,
    no-false-success, mount-gated flag, no-body authed client, banner+cancel, backend-types line-matched to
    `98cc1bd`, tsc clean, 15/15 tests; the 2 SavedReelsFlow fails confirmed pre-existing since `7778791`).
    3 Minors → **deferred to T6 polish:** (1) no unmount guard in `DeleteAccountCard` async handlers (vs
    `SettingsView`'s `activeRef`); (2) the 2 new API fns skip the `MOCK_AUTH_ENABLED` short-circuit (dormant
    while gated, but would fire a real call w/ a fake token under mock-auth demo); (3) silent revert on
    `no_pending_deletion` (only reachable once cross-session reads exist). Plan §4-row-5 vs §3.5 ownership
    of the clear-memory rewire → FIXED (it's Task 4; removed from the T5 row).
- **T3 BUILT: `5cc6fda`** (the destructive core) — `deletion_engine.py` (two-pass `erase_user`: Pass A
  claim→quiesce→purge+verify, never hard-delete on unconfirmed purge, catch ONLY Memory*, `InvalidUserId`
  propagates→sweep `_mark_failed`; Pass B settle-gap→re-verify→`auth.admin.delete_user(should_soft_delete=
  False)`, 404/missing-users-row=completed crash-recovery) + `claim_account_for_deletion` CAS RPC
  (`20260805010000`, service_role-pinned) + `_reap_loop` 3rd branch (own try, no-op when gated) + freeze
  (`persist_trip_memory` fail-closed for pending/deleting + `generate_trip` 403). 37 engine tests + full
  suite 1527 pass, eval anchor 6229.0 intact. Orchestrator self-read the engine+RPC: high quality; the
  `deleting`+log-`pending` window is handled by design (claim-false re-reads status: `deleting`→retry).
  **T3 review IN FLIGHT (opus, destructive-core).**
  - **[→FOLD after T3 review] sweep index still missing** (T2 note #1): the T3 migration adds only the
    claim RPC. Add a partial index for the sweep WHERE — `on account_deletion_log(scheduled_for) where
    outcome in ('pending','deleting')` (note: `scheduled_for` is the SQL filter; `next_attempt_at` is
    filtered in Python). Cheap; beta-scale it's a seq-scan today.
  - Atomicity note (T2 #2): SATISFIED-BY-DESIGN (not forced atomic) — no observer is harmed by the window;
    T3 review to confirm.
- **T3 REVIEW DONE: SHIP (Approved), no Critical/Important** — destructive invariants fault-injection-
  verified (unconfirmed-purge→no-delete, no-delete-after-cancel, freeze closes Pass-B TOCTOU, 404 fails
  safe vs real `supabase_auth 2.31.0 .status`). 4 Minors → **ALL FOLDED `76b7ecb`** (orchestrator applied,
  transcript of the T3 dev had expired): (1) `initializing` added to organize quiescence set; (2) sweep
  partial index `account_deletion_log(scheduled_for) where outcome in (pending,deleting)`; (3) Pass B backs
  off on a non-`deleting` account_status (self-guard); (4) skip `_get_mem0()` on a quiet tick. +2 tests;
  full suite 1529 pass.

**WAVE DONE + REVIEWED + FOLDED. Remaining:**
- **T4 BUILT: `9d3d81f`** — `notifications.py` (first Resend integration; 2 best-effort senders, catch-all,
  secret-safe TYPE-only logs, **no-op+log when `RESEND_API_KEY` unset**, lazy httpx + call-time env) + wired
  the scheduled email into `POST /account/deletion` (email via `admin.get_user_by_id`, wrapped so it can't
  block/fail the 200) + filled `_mark_completed`'s completion-email TODO (send then clear `recipient_email`)
  + **#2 un-lie**: `SettingsView` off the mock → real `POST /settings/memory/clear` via `api.ts clearMemory`,
  honest states, never fake success (button honestly shows unavailable while gated). `.env.example` +=
  `RESEND_API_KEY`/`RESEND_FROM_EMAIL` (NOT render.yaml — T6). Backend 1539 pass, eval anchor holds; frontend
  tsc + 18 tests. Gates NOT flipped; engine two-pass LOGIC + T3 folds intact; keyless import OK. **T4 review
  IN FLIGHT (sonnet).** Flagged deviation (for the review): completion email is best-effort-no-retry (row
  goes `completed` → sweep stops selecting; `recipient_email` cleared same write) — acceptable per §6 (the
  scheduled email is the load-bearing one), review to confirm.

- **T4 REVIEW DONE: SHIP, no Critical/Important** — verified live (best-effort/never-raises, no-op-without-
  key, secret-safe logging proven by embedding the key in a raised error + asserting absence, gates off,
  engine logic + T3 folds byte-identical). 4 Minors → **3 FOLDED `303b56b`:** (1) `_mark_completed`
  write-then-send (was send-then-write) → idempotent terminal path, no double-send on crash-recovery re-run;
  (2) scheduled email renders a human date not raw ISO; (3) drop the unused `ERROR_CODE_MEMORY_UNAVAILABLE`.
  Backend 1539 pass, tsc clean, settings 18 pass. **4th Minor → T6 DECISION:** the scheduled email is
  `await`ed in the request path (worst case ~40s if GoTrue+Resend degraded; inert while gated) → at go-live
  choose fire-and-forget (`create_task`) vs tighter timeouts.

**★★★★ ALL BUILD TASKS (T1–T5) BUILT + REVIEWED + FOLDED. Everything GATED OFF, local on `zh`, NOT pushed.**
Commits: `89b7a42`(T1) `98cc1bd`(T2) `5cc6fda`+`76b7ecb`(T3) `9fb1a59`(T5) `9d3d81f`+`303b56b`(T4) +
`52f2cce`(tracing-off, standalone). Backend 1539 pass, frontend green, eval 6229.0 holds.

## T6 — GO-LIVE CHECKLIST (do NOT start without ZH's explicit go)
**★ T6 CODE PARTS DONE (2026-08-04, ZH-approved "code parts, stop before flipping flags"):** items 2 + 3
below are BUILT (gated OFF) — backend `5fa0b33` (`GET /account/deletion/status`: ungated, sub-only,
fail-safe→active/null; + T4 latency fold `asyncio.wait_for(6s)` on the scheduled email) + frontend `edc4393`
(status fetch on mount seeds the pending/deleting banner cross-session; T5 folds: unmount `activeRef` guard,
`MOCK_AUTH_ENABLED` short-circuit on all 3 deletion api fns, `no_pending_deletion` neutral note). Backend
1547 pass, frontend tsc clean + 23 tests, gates NOT flipped, `NEXT_PUBLIC_DELETION_ENABLED` still off.
**Combined review DONE: SHIP, no Critical/Important** — verified by RUNNING: contract parity exact (incl.
datetime `Z`-suffix ↔ FE `string`), fail-safe (even Pydantic-validation errors → safe default), structurally
sub-only, email bound load-bearing (test: <2s w/ a 5s send; `CancelledError` still propagates), hidden card
structurally can't fetch, all 3 folds correct, gates untouched. 2 Minors: #1 test-coverage of `maybe_single`
bare-`None` → **FOLDED `710adc7`** (26 pass); #2 no rate-limiter on the GET status → **DEFERRED** (matches
the repo's unrated GET-status convention — saved-reels status/stream; FE fetches once on mount; revisit if
abuse appears). **T5's 3 minors + T4's #4 latency: all now FOLDED.** Remaining below = pure go-live switches,
HELD for ZH.
1. **Live DB gate:** apply the 3 migrations to a rebased local Postgres; run pgTAP `019_account_deletion.sql`
   + `020_claim_account_for_deletion.sql` (privilege-pin + CAS runtime proof, deferred here — no local PG).
2. **Wire the cross-session `account_status` read** (T5 gap): add `account_status`+`deletion_scheduled_for`
   to an existing settings/profile GET (or a new `GET /account/deletion/status`) so a returning user sees
   the pending banner + can Cancel; feed it into `DeleteAccountCard`'s `initialStatus`/`initialScheduledFor`.
3. **Fold deferred minors:** T5's 3 (unmount guard, `MOCK_AUTH_ENABLED` short-circuit in the 2 new api fns,
   silent-revert on `no_pending_deletion`); T4's #4 (sync scheduled-email latency — fire-and-forget vs
   timeouts); T2's cancel cosmetic-message race (optional).
4. **`/privacy` honest copy** (`page.tsx:131`): self-serve flow + 7-day grace + name the residual windows
   (Render logs, Resend send-log ~30d); OpenAI tracing already off.
5. **Config:** set `RESEND_API_KEY` (+ `RESEND_FROM_EMAIL`) in `render.yaml`/Render env (`.env.example`
   already has them). Decide `_CLEAR_RECONCILIATION_READY` (clear-memory live-enable) — separate from the
   delete flags.
6. **FLIP THE FLAGS (the actual go-live):** `_DELETION_EXECUTION_READY=True` (`main.py:351`) +
   `NEXT_PUBLIC_DELETION_ENABLED=true`. Schema-first: migrations + config land BEFORE the flag flip.
7. **Live E2E** (`/qa`): request→scheduled email arrives w/ friendly date+cancel copy→banner shows→cancel;
   then a full grace-lapsed deletion→two-pass sweep→auth-delete→22 tables gone→completion email→log
   `completed`+`recipient_email` cleared; clear-memory button honest states.
8. **FINAL whole-branch review — fable/opus + gstack `/review` Codex cross-model (run BOTH)** before any
   PR/merge/deploy. THEN PR to `dev`, merge, sync.
- **T6 (HOLD for ZH go-live)** — live pgTAP 019/020 + wire the cross-session `account_status` read (T5 gap)
  + the T2/T5 minors + flip `_DELETION_EXECUTION_READY` + `NEXT_PUBLIC_DELETION_ENABLED` (+ decide
  `_CLEAR_RECONCILIATION_READY`) + `/privacy` honest copy. FINAL whole-branch pass (fable/opus +
  Codex cross-model) before any merge/PR/deploy.

**LEAN Rev 3 IS THE CURRENT PLAN (`cbb764b`=Rev2, then Rev3):** Rev 2 folded the Codex lean review; **Rev 3
DROPPED REAUTH** (ZH — Astrail is passwordless per `privacy/page.tsx:48`, so emailed-code reauth adds ~
nothing; replaced by **type-to-confirm + 7-day grace + an immediate "scheduled — cancel by {date}"
notification email** as the safety net; removed `_decode_claims`/`amr`/forced-sign-out). Also DONE this
session: **OpenAI Agents tracing disabled** (`52f2cce`).

**Codex lean review (on lean terms): BLOCK 4/10 — shape right, 5 lean-level bugs in Rev-1 (none need the
fortress), all folded into Rev 2. Task 1 re-confirmed safe.** The 5 must-fixes:
1. **False "cleared" is reproducible** — the plan trusted `clear_memory=="cleared"` as terminal proof, but
   that function's in-flight check only looks back 30s (`memory_clear.py:135`), mem0 has shown a 17-min
   queue (`:28`), and `_CLEAR_RECONCILIATION_READY` exists BECAUSE of a live repro where it said cleared
   while queued adds later appeared (`main.py:285`). An add queued >30s → delete_all at grace-end →
   get_all empty → "cleared" → hard-delete+"completed" → the add materializes under a deleted uuid =
   orphaned mem0 + a false "done." **Fix (lean):** fail-closed new mem0 writes for pending/deleting
   accounts + engine waits for job quiescence + a two-pass verify (purge on one sweep, re-verify empty on
   a later sweep) before auth-delete. NOT the event-id barrier.
2. **Cancel-vs-sweep race** — engine reads `pending_deletion` once, then does slow mem0 ops, then deletes;
   a cancel that lands mid-op still gets deleted (user got "cancelled ✅", loses account). **Fix:** one
   atomic CAS `pending_deletion → deleting` (point of no return) before external erasure; cancel then wins
   or gets "already started." Also dedups two sweepers.
3. **CHECK can't store `cancelled`** — log `outcome` CHECK is `pending|completed|failed` but cancel marks
   `cancelled`. **Fix:** add `cancelled`+`deleting`; cancel must atomically mark log + **clear the
   timestamps** so a re-request gets a fresh 7-day schedule (else the coalesce'd old deadline deletes
   immediately).
4. **Crash idempotency breaks post-auth-delete** — step-1 re-reads `public.users`, but auth-delete
   cascades that row away; crash after auth-delete → next sweep finds no user row → never hits "404=
   success" → log stuck pending forever + no email address to retry. **Fix:** recovery handles "public
   user missing" → verify auth absent → complete log; **capture `recipient_email` BEFORE auth-delete**
   (store short-lived, clear after send).
5. **RPC privilege pin** — Task-2 RPCs take `p_user_id`; if `SECURITY DEFINER` with default EXECUTE grant,
   an authenticated user can call via PostgREST to schedule/cancel ANOTHER uuid. **Fix:** explicit
   `revoke from public/anon/authenticated; grant service_role` (mirror `20260804000000:163`) + test direct
   anon/authenticated invocation.
Plus: **reauth** as specified is "recent auth," not a per-action challenge — a session from a normal OTP
login 1 min ago passes; either document honestly as "OTP within a tight window" (lean default) or add a
one-use reauth intent that the amr must postdate; use a NEW `_decode_claims` (don't touch `_decode` —
callers at `auth.py:127/134`). Nice-to-haves: `_reap_loop` is **120s not daily** (`main.py:78/113`) → add
`next_attempt_at` spacing; `attempts` isn't dedup (the CAS is); "22 tables" is stale (~24 of 27 public);
define a **retention period** for the FK-free log. §6 tradeoffs judged legit for beta EXCEPT the mem0 one
(unsafe as paired with "never false deleted" — fixed by #1); CCPA §7101 only if actually in-scope (25-seat
co usually below thresholds); GDPR needs no HMAC. **Full output:** `<scratchpad>/codex-lean-out.txt`.

Everything below (SESSION-2 UPDATE, the A/B/C decision, the Rev-3/Rev-4 review captures) is HISTORY of the
full-rigor track — still accurate, but the active direction is LEAN above.

---

## ★ SESSION-2 UPDATE (2026-08-04, cont.) — supersedes §0/§4/§8 below

**ZH DECIDED: Direction A (full rigor)** + **HOLD Task 1** (planning only this session — do NOT build the
`backend/erasure.py` core yet).

**Rev 3 (full-rigor / Direction A) is WRITTEN + COMMITTED** — `631af6c` on `zh`
(`docs/superpowers/plans/2026-08-04-self-serve-account-deletion.md`). It folds ALL of §5 (both R2 reviews)
in full and pulls A's in-scope pieces out of deferral: `barrier_blocked` operator-escalation state (mem0
ceiling), per-processor deletion inventory (T9: PostHog/Resend/Render-logs/Apify/OpenAI), webhook-confirmed
completion (T8). Citations were **re-grounded** (Rev 2 had drift — corrected: `_renew_job_lease:143`,
`reclaim_expired_jobs:212`, `enqueue_job:73` direct insert, `runner.py:561`, `_decode:auth.py:93` returns
only sub, `get_current_user_id_stashed:rate_limit.py:60`, `create_organize_job:79`, reserve RPC
`20260804000000:15`, geocode RLS `:39-41`, rollback dir exists but sparse). Task count grew to **13**
(added T6 RLS-freeze, T9 processor-inventory; T8 now webhook delivery).

**THIRD-ROUND RE-REVIEW IN FLIGHT (BUILD-LOOP step 3):** fable eng-review (astrail-reviewer, model fable)
+ Codex `gpt-5.6-sol` (`codex exec -m gpt-5.6-sol -s read-only`, output →
`<scratchpad>/codex-r3-out.txt`). Both launched against Rev 3; verdicts pending. **Next session, if this
one dies mid-review:** re-run both on `631af6c`, fold criticals into Rev 3.1, present to ZH. Then (only on
ZH go) build Task 1 per §6 and STOP.

**Still holds:** don't wire anything destructive before ZH review; don't merge/PR/deploy. Task 1 spec (§6)
is unchanged and still the correct first build when ZH gives the go.

---

## ★★ SESSION-2 RE-REVIEW RESULTS — Rev 3 (durable capture; → Rev 4 fold list)

**fable R3 (astrail-reviewer, model fable): REVISE 8/10.** No structural blocker; architecture sound; both
R2 lists substantially folded (16 FOLDED / 4 PARTIAL / 0 MISSING). Every plan citation it relied on
re-verified EXACT. **Task 1 CONFIRMED** build-ready (one signature nit). Fold before building T2–T4:

- **[CRITICAL] C1 — fence stage name `memory_purged` is written BEFORE the purge runs** (§3.3 steps 3–4).
  Crash between the fence CAS and `delete_all` → recovery reads `stage='memory_purged'`, a faithful
  completed-fact resume proceeds to `auth.admin.delete_user` with **mem0 never purged**: auth user gone,
  cascade destroys `memory_events` bookkeeping, mem0 permanently retains the user's memories, audit reads
  `completed`, email says erased — silent, permanent, legally-false. It's the unapplied half of Codex R2's
  "started/confirmed on every side effect" + a recurrence of the MED-5 assert-success-naming defect one
  stage later. **Fix:** fence sets `stage='purge_started'` (or `fenced`); write `memory_purged` only AFTER
  verify-empty+stable; recovery from `purge_started` **re-runs the purge** (delete_all+verify is idempotent).
  Add a T4 gate line: "crash between fence and delete_all → recovery re-purges before auth delete."
- **[IMPORTANT] I1 — `barrier_blocked` has no operator EXIT.** No resolve/ack/force-re-drain/complete-with-
  exception action exists (§3.10 admin list = accounts/cancel/expedite/overdue-view only); case (i)
  (lost-add, no event_id — can NEVER self-resolve) **wedges the deletion permanently**: user stuck
  `pending_deletion`, RLS-frozen, statutory clock running, human has no lever. Unspecified: does the sweep
  re-claim `barrier_blocked` (case ii stuck-PENDING CAN later go terminal → periodic re-drain w/
  `next_attempt_at`; case i must NOT busy-loop); is the lease released on the flip. **Fix:** audited,
  capability-gated admin action — "operator verified mem0 manually → resume" OR "complete with disclosed
  exception in `barrier_blocked_reason` + completion email"; + sweep re-drain per case. **(b)** add a
  user-facing **DELAY notice email** to §3.7 when a hold crosses the deadline (Codex R2: operator alert
  alone is NOT a compliant response).
- **[IMPORTANT] I2 — `create_task` reverses a documented in-repo GC-risk decision** (`runner.py:553-554`
  says "AWAITED (not create_task → no GC risk)"). A bare `create_task` with no strong ref can be
  GC'd mid-flight → silently loses the `event_id` (the exact loss the barrier exists to kill). **Fix,
  spec in T2:** (1) module-level strong-ref registry (add on create, discard in done-callback); (2)
  FastAPI lifespan shutdown **drains pending add-tasks bounded** — Render restarts on every deploy, so
  without a drain every deploy during an add window creates a post-cutover NULL-event_id row = a future
  `barrier_blocked`, making the "rare" case **deploy-correlated**; (3) completion callback consumes task
  exceptions + its own DB-write failure path; (4) confirm the Supabase client singleton outlives the
  callback. Update the `runner.py:554` comment in T2.
- **[IMPORTANT] M1 — processor inventory assumes integrations that may not exist.** `posthog>=3.0.0` is in
  `pyproject.toml:23` but **never imported** (zero hits); only a CSP `connect-src` entry
  (`next.config.ts:26`). §3.9 asserts a PostHog data-flow that in-repo sends nothing → T9 must OPEN with
  "establish whether any data flows at all, per processor"; if unused, the entry becomes "remove dep + CSP"
  → shrinks to 4 processors. Resend "contact deletion" presumes Audiences/Contacts; transactional sends
  create no contacts — the real PII is the sent-email LOG (retention/support path). Verify BOTH before the
  (legally-binding) completion-email wording is drafted.
- **[MINORS]** (M2) DELETE not frozen — §3.6 freezes INSERT/UPDATE/UPSERT `WITH CHECK`, but DELETE policies
  have only `USING`; client deletes (`collections.ts:61/:88`) stay permitted — state as a deliberate
  erasure-aligned carve-out or add `USING` status guards. (M3) service-role write enumeration — list the
  concrete guarded routes (feedback path `assert_schema.py:97-98`) + generate pgTAP from `information_schema`
  so later tables inherit the freeze. (M4) sentinel as "probeable row/function" contradicts columns-only
  `assert_schema` — define it as a column/table probe (transactional ⇒ any column suffices). (M5) admin
  mint drops Codex's fresh-reauth (valid JWT + passphrase only) — restore amr-fresh reauth on the mint
  route or record the substitution in §7. (M6) T11/T12/T13 sequencing — `/privacy` self-serve copy + FE
  delete card land before `_DELETION_EXECUTION_READY` flips (T13) → mid-arc deploy makes `/privacy`
  advertise a 503 flow; couple privacy-copy to the flag-flip deploy + spec the delete card's honest 503.
- **Task-1 nit:** handoff §6 signature `purge_account_memory(mem0, user_id)` is wrong — `clear_memory`
  needs the Supabase client to arm the marker (`memory_clear.py:172`); use
  **`purge_account_memory(client, mem0, user_id)`**, consistent with §3.3's `erase_user(client, mem0, …)`.

**Codex R3 (`gpt-5.6-sol`): BLOCK 5/10 — does NOT move off its Rev-2 BLOCK.** Agrees with fable on
substance (differ on bar, as in R2). Confirms Rev 3 is "materially stronger." **Task 1 CONFIRMED safe.**
7 findings — 4 overlap fable (C1=Codex#2 fence-stage; I2=Codex#1 create_task; I1=Codex#3 barrier_blocked;
M1=Codex#6 processors), plus three fable missed:
- **[BLOCKER B5] completion-sequencing contradicts "completion = delivered".** Engine marks audit
  `completed` + enqueues email (§3.3 step 8 / `plan:223`), but §3.7 says completion = webhook-confirmed
  delivery (`plan:282`). Auth+data deleted, email enqueued, audit `completed`, THEN Resend permanently
  bounces → durable truth says "completed" while the declared completion condition failed. **Fix:**
  separate `erasure_completed` from `response_delivered`; keep the request lifecycle `awaiting_delivery`
  until a delivered webhook or audited manual-response; capture recipient+outbox intent BEFORE auth delete
  (the engine currently only enqueues AFTER).
- **[HIGH H1, sharper] RLS freeze doesn't govern service-role writes + oracle + DELETE.** Service-role
  bypasses ALL RLS (`main.py:387`); a pending user can still submit feedback via `main.py:372` unless the
  route/RPC checks status. `account_is_active(uid)` becomes a status **oracle** through PostgREST → use a
  **no-arg helper bound to `auth.uid()`**. Existing authenticated **DELETE** policies stay live
  (`20260701131304:205/:242`, `20260718120000_saved_reels_foundation.sql:109`) — WITH CHECK doesn't cover
  DELETE. Keep global caches writable; T6 needs an explicit service-role write-path inventory.
- **[BLOCKER B4, corrected premises — legally material] processor inventory wrong/unverified.**
  **OpenAI:** "default: no retention" is FALSE — `Runner.run` runs with **tracing ON by default**
  (`genagents/place_extractor.py:279`, `narrator.py:106`, `restaurant.py:184`); sensitive gen/tool data
  goes to the trace store + Responses API default retention → **disable tracing** as the primary
  mitigation. **Resend:** 30-day email-data retention; contact deletion ≠ send-log deletion; the
  completion email itself is a NEW disclosed exception. **Apify:** the sync call
  (`scrape/apify_direct.py:48`) sends the Reel URL, returns dataset items, and **never persists a run/
  dataset ID** → deletion is impossible without first persisting the id. **Render:** window is 7/14/30
  (confirm). **PostHog:** zero in-repo calls → prove any flow or remove. The inventory must ALSO cover
  **mem0 itself + Supabase backups + the OpenAI trace store** — not just 5 bullets. T9 opens with "does
  any data flow at all, per processor?".

Codex also flags (agreeing w/ fable minors): admin-mint dropped fresh-reauth + no signing-key rotation
contract; capability sentinel not probeable by columns-only `assert_schema` (`scripts/assert_schema.py:9/
:14/:232`) → define as a **table+column in REQUIRED_SCHEMA + a separate live RPC semantic smoke**;
FE/privacy rollout (`privacy/page.tsx:131` already promises deletion) must hide the self-serve control +
keep mail intake until the flag flips (no visible 503 button); audit schema must enumerate CCPA §7101
request/response fields + denial basis; the installed mem0 SDK `delete_all` "blindly parses JSON"
(`mem0/client/main.py:1324`) with no event method (`:1140`) — reinforces the §2 ⚠ 204/no-event_id verify.

**Full Codex output:** `<scratchpad>/codex-r3-out.txt` (SESSION-ONLY — this capture is the durable copy).

**→ WRITING Rev 4** folding all consensus must-fixes (fence-stage, create_task-durability, barrier_blocked-
exit, completion-sequencing, RLS-service-role+DELETE+oracle, processor-premises, sentinel, mint-reauth,
audit-fields). One genuine DECISION for ZH surfaced: **B2 create_task durability** — light (strong-ref
registry + lifespan drain, accept process-loss→barrier_blocked residual) vs heavy (make each mem0 add its
own durable leased work-item). Rev 4 defaults to LIGHT + flags heavy as a triggered upgrade.

---

## 0. One-line status
Plan is at **Rev 2 (full-rigor), reviewed twice**: **fable REVISE 8/10 (buildable-with-revisions)** vs
**Codex `gpt-5.6-sol` BLOCK 4/10 (still blocked)**. **A user decision is pending (direction A/B/C below)
before writing Rev 3 / building anything past Task 1.** Task 1 (non-destructive core) is cleared by BOTH
reviewers to build now.

## 1. What's DONE (committed on `zh`, local only — NOT pushed)
- `a7821ed` — #3 localhost env-guard (`resolveBackendUrl`, prod-throw). 374/374 FE tests green.
- `ee7a39b` — #1 Settings reads live profile + mem0 memories (honest empty/unavailable states). NOTE:
  the Settings **"Clear memory" button still calls the MOCK** and fakes success — that's launch-gate #2,
  fixed later in this arc (fable HIGH-1 below).
- `826537d` — the OLD operator-script erasure plan (`2026-08-03-user-data-erasure.md`).
- **Task 0 (dev sync) already satisfied** — `zh` contains all of `dev` incl. entitlement migrations
  (`20260803120000_entitlement_free_trial.sql`, `20260803130000_request_seat.sql`,
  `20260804000000_reserve_replay_on_exhausted.sql`). No merge needed.

## 2. What's UNCOMMITTED on `zh` (persists on disk, but commit before relying on it)
- **`docs/superpowers/plans/2026-08-04-self-serve-account-deletion.md`** — the Rev 2 full-rigor plan.
- **this handoff.**
- `zh` backend venv is provisioned (`cd backend && uv sync` was run).

## 3. How we got here (arc history — don't re-derive)
1. Discovered the clear-memory backend ALREADY EXISTS on `zh` (`pipeline/memory_clear.py` + gated route
   `main.py:318`, gated off `_CLEAR_RECONCILIATION_READY=False`). The old erasure plan was written
   unaware of it. Account deletion (#4) is 100% missing.
2. ZH chose **self-serve, Google-style graceful deletion** + an `/admin` (PIN → hardened to
   login+passphrase). Then chose **"full rigor"** (provable mem0 barrier + durable staged job).
3. Wrote Rev 2 folding 3 research scouts (mem0 barrier / Supabase reauth / staged-job+RPC map) + the
   Rev-1 review. Re-reviewed → the split verdict above.

## 4. THE PENDING DECISION (what ZH must pick next session)
Codex proved two things that reshape the target:
- **(a) Fully-provable erasure is capped by mem0's API.** A lost `add` HTTP response = no `event_id`,
  and mem0 has **no idempotency key / delete-fence / event-lookup-by-client-id**, so that add is
  unprovably-erasable. Best achievable = provable-for-all-known-adds + a rare **`barrier_blocked`
  non-terminal state that escalates to a human** (cannot auto-complete). This is a mem0 limitation, not
  a plan defect.
- **(b) Complete erasure ≠ 22 DB tables.** CCPA §7022 / GDPR 17/19 require instructing PROCESSORS to
  delete too: **PostHog, Resend, Render logs, Apify, OpenAI**. Needs a per-processor data-flow inventory.

**Direction options presented (ZH rejected the multiple-choice to clarify first — re-ask or let ZH steer):**
- **B — Beta-pragmatic (fable's bar, my lean):** fold all correctness+legal must-fixes; DEFER the
  enterprise pieces (webhook delivery-confirmation, automated processor deletion) with triggers; accept
  the documented mem0 residual. Legally-defensible, strong, self-serve, right-sized for 25 seats.
- **A — Full rigor, accept the mem0 ceiling:** fold ALL of Codex+fable, add `barrier_blocked` escalation
  + full processor inventory. Enterprise-grade, multi-week; still can't promise 100% hands-off.
- **C — Operator-script for the beta:** guarded manual delete now (human handles reauth/serialization/
  completion → dodges most Codex blockers), self-serve later. Fastest+safest to "not lying." Same T1 core.

Also pending: **start Task 1 now in parallel?** (both reviewers say yes — see §6.)

## 5. Rev 3 FOLD LIST (the durable capture of BOTH R2 reviews — do NOT lose this)
### fable R2 (REVISE 8/10 — closed 10/11 Rev-1 items + all 6 Codex blockers "at the design level")
- **HIGH-1:** §9 claims the lying clear-memory button is fixed but NO task rewires it. `SettingsView.tsx:8`
  still imports `clearMemory` from `mock-api`. Add a named task: wire button → real `POST
  /settings/memory/clear`, surface `memory_unavailable`/`memory_clear_unknown` honestly (part of T2 un-gate).
- **HIGH-2:** drop the reauth `iat` fallback (a silent refresh re-stamps `iat`, no new `amr` → bypass);
  fail closed on missing/stale `amr`. `_decode` returns only `sub` today → needs a claims-returning
  refactor (not "zero cost"). Assert `amr` presence against a REAL Astrail token in T5/T11 (unverified in-repo).
- **HIGH-3 + MED-1 (one fix):** cancel-vs-engine TOCTOU is a read, not atomic vs external `delete_user`.
  Add a **pre-delete stage CAS point-of-no-return** + cancel "409 too late past the fence." Same CAS fixes
  the "404=success" crash-window misclassification.
- **MED-2:** the account_status guard must be a **DB `BEFORE INSERT` trigger (`FOR SHARE`/`FOR UPDATE`)** —
  the legacy path `enqueue_job` (`jobs.py:73`) is a direct PostgREST insert, so "3 RPCs" misses it. Order
  UPDATE-users-first in the request RPC.
- **MED-3:** "capture event_id on timeout" is unimplementable — `asyncio.wait_for` CANCELS the coroutine
  (`preferences.py:346-350`). Use `create_task` + background capture of the late `event_id`. Scope
  "outstanding" to a window (pre-migration rows have NULL `event_id` forever).
- **MED-4:** in the clear path, event-state polling must NOT wholesale-replace `_add_possibly_in_flight`'s
  time window — a NULL-`event_id` young row still forces `unknown` (keep the window as fallback lattice).
- **MED-5:** re-enumerate the drain set AFTER `delete_all`+verify (loop until stable); give expedite a
  floor > the write-back bound; the "hold" stage must be BEFORE `memory_reconciled` (that name asserts success).
- **LOW:** `_DELETION_EXECUTION_READY` flip needs a task home (T11); §2 citation drift (real names:
  `mark_job_running:96`, `_renew_job_lease:143`, `reclaim_expired_jobs:212`; reserve RPC at
  `20260804000000:15`; persist call `runner.py:561`); capability-token mechanics; add `_down.sql` rollback
  twins (repo convention: `supabase/migrations/rollback/`); admin "overdue view" missing from T8 endpoints.

### Codex R2 (BLOCK 4/10) — blocker status: #4 CLOSED; #5,#6 PARTIALLY; #1,#2,#3 OPEN
- **BLOCKER mem0 not provable:** the response-loss/no-event_id case (see §4a). Make **`barrier_blocked` a
  distinct non-terminal state** (don't auto-complete). ALSO: official mem0 delete docs show a **204 with NO
  event_id** — conflicts with our live-probe assumption that `delete_all` returns a pollable `event_id`;
  **verify this**. Pre-`event_id` `memory_events` rows need a cutover/backfill procedure.
- **BLOCKER cancellation racy:** one durable transition — cancel `scheduled|reconciling → cancelled`;
  worker `reconciling → erasing` (only winner proceeds); cancel-after-`erasing` = `409
  deletion_already_started`. Fence every stage write on job id + lease token + expected stage.
- **BLOCKER F4 shared serialization:** every creator RPC must `SELECT ... FROM users WHERE id=p_user_id
  FOR UPDATE` then check `account_status` under that lock. Convert/remove the legacy Python enqueue.
  Apply to `capture_saved_reel` (`saved_reels.py:7`). Add two-session concurrency tests (both commit orders).
- **BLOCKER erasure inventory too early (NEW):** per-processor data-flow inventory (PostHog/Resend/Render
  logs/Apify/OpenAI) — correlation key, delete API, retention exception, retry proof, completion criterion.
  Completion email must state what was erased + what remains under a disclosed exception.
- **HIGH job schema:** add `status` (`scheduled|running|retryable|cancelled|completed|failed|overdue`)
  DISTINCT from monotonic `stage`; **partial unique index = one active deletion per user** (mirror the
  entitlement arc's partial-unique-index pattern); atomically cancel the active job with the status flip.
- **HIGH crash recovery:** persist a fenced `auth_delete_started` stage BEFORE the `delete_user` call; on
  recovery from that stage, verify the auth user is absent → treat absence as idempotent success. Apply
  "started/confirmed" to every non-transactional side effect.
- **HIGH outbox durable delivery:** capture email + enqueue message intents BEFORE auth deletion; one row
  per notification w/ lease, attempts, next_attempt, stable idempotency key, terminal delivery state.
  Resend has an `Idempotency-Key` (24h retention). If "delivered" is the completion condition, consume
  signed delivery webhooks. Define the permanent-bounce/manual-response path + when local+Resend PII is removed.
- **HIGH pending ≠ deactivated:** `sign_out` can't revoke an issued access JWT; the repo permits direct
  RLS writes (profiles, trays, collections — `supabase-api.ts:21`, `collections.ts:35`). Make
  `pending_deletion` load-bearing in ALL RLS write policies + service-role mutations (allow only
  status/read, reauth, cancel, privacy ops). Optionally validate `session_id` still exists after sign_out.
- **HIGH deployment gate:** update the schema manifest in T2 (with `event_id`), not T3. Ship ONE
  transactional migration with columns+tables+RPC bodies+grants+a **schema-capability/version sentinel**
  (`assert_schema` sees columns only, not RPC signatures). Gate **request-acceptance + admin-expedite +
  worker** (not just execution — accepting requests while execution is off starts legal clocks).
  Schema-first rollout; probe live contracts; then flip the flag.
- **HIGH admin capability spec:** signed token (`iss`, `aud=astrail-admin`, founder `sub`, original
  `session_id`, `iat/nbf/exp/jti`), 5-min max, memory-only in browser, reject future timestamps/alg-
  confusion; verify allowlist + active account on every use; mint route needs fresh reauth + passphrase
  lockout + audit.
- **MED raw mem0 adapter:** 4 states (`PENDING/RUNNING/FAILED/SUCCEEDED`); fixed 500ms poll = thousands of
  calls in a 17-min backlog → exponential backoff+jitter, `Retry-After`, bounded concurrency, per-status
  (404/401/403/429/5xx) handling, UUID-validate ids, fixed-origin URL + redirects disabled; keep the lease
  alive + recheck cancellation while draining.
- **MED audit retention:** CCPA §7101 wants request/response records ≥24 months with specific fields;
  HMAC is still linkable while key+source exist — define retention, HMAC-key lifecycle, purge of raw uid/email.
- **Legal:** 300s is a defensible product choice, NOT a statutory number; require no-iat-fallback + only
  allowed AMR methods + `0 ≤ now-amr.ts ≤ 300` w/ skew + fresh-token-subject = the account. Overdue
  escalation ALONE isn't a compliant response — the user must get a delay/denial/failure via a durable
  channel. Backup carve-out must name the ACTUAL retention window + restore-and-reapply procedure.

## 6. TASK 1 — ready to build (both reviewers cleared it; common to A/B/C)
`backend/erasure.py` + `backend/test_erasure.py`, NOTHING else:
- `_assert_real_uuid(u)` — F2/F3: `str(uuid.UUID(u)) == u` strict equality (NOT `_parse_uuid`'s brace-
  accepting canonicalization); **catch BOTH `ValueError` and `TypeError`** (`uuid.UUID(None)` → TypeError);
  lives OUTSIDE every try/except; raises `InvalidUserId`.
- `purge_account_memory(client, mem0, user_id)` — a strict wrapper over `pipeline/memory_clear.py::clear_memory`
  (**signature corrected R3: takes `client`** — `clear_memory` needs the Supabase client to arm its
  clear-marker at `memory_clear.py:172`; without it every call degenerates to `MemoryBackendUnavailable`.
  Consistent with §3.3's `erase_user(client, mem0, deletion_job)`.)
  translating its return: `"cleared"` → ok; `"unavailable"` → raise `MemoryBackendUnavailable`; `"unknown"`
  → raise `MemoryPurgeError`. (Inherits clear_memory's 4 guards; do NOT reimplement a naive delete.)
- Exceptions: `InvalidUserId`, `MemoryBackendUnavailable`, `MemoryPurgeError`.
- Fault-injection tests must be BEHAVIORAL (`≠"cleared"` ⇒ raises), not vacuous "mock-was-called"
  (BUILD-LOOP "tests that cannot fail" trap #7). Fault-inject `"*"`/`None`/`""`/brace-uuid → raise BEFORE
  any mem0 call; guard error ≠ purge error.
- **Codex's stop-point conditions:** nothing imports/invokes the wrapper from a route/sweep/task;
  `_CLEAR_RECONCILIATION_READY` and `_DELETION_EXECUTION_READY` stay False; tests use fake clients only.
- Build via `astrail-developer` (opus, TDD) → `astrail-reviewer` (sonnet) per BUILD-LOOP. **STOP after
  Task 1 for ZH review** before wiring anything destructive.

## 7. Environment / where things are
- Backend `:8000` was running from the MAIN checkout (`/Users/.../astrail/backend`, on `dev`, code ≡ zh's
  backend) — may or may not survive. Frontend `:3000` was started from the zh worktree (`npm run dev`).
- Reviews' raw text: fable via conversation SendMessage (session-only); Codex at
  `<scratchpad>/codex-plan-review-out.txt` (R1) + `codex-plan-review-r2-out.txt` (R2) — **SESSION-ONLY,
  will be gone.** §5 above is the durable copy.
- Guardrails: `.claude/docs/BUILD-LOOP.md` (mandatory loop); destructive/irreversible → task-by-task,
  don't wire destructive code before ZH review, don't merge/PR/deploy.

## 8. Immediate next steps for the picking-up session
1. Get ZH's direction (A/B/C) + whether to start Task 1 now.
2. If B/A: write Rev 3 folding §5; re-review (fable + Codex) per BUILD-LOOP step 3. If C: re-scope to the
   operator-script plan (much smaller; reuses the T1 core).
3. Build Task 1 (§6) when cleared; STOP after it for ZH review.
