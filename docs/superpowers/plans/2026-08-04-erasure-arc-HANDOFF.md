# HANDOFF — User-data-erasure arc (self-serve account deletion + mem0 barrier + /admin)

> Written 2026-08-04, end of session (session expiring; author had a meeting). Branch `zh`,
> worktree `/Users/desmondchyezhihao/Github/astrail-zh` (NOT the main checkout on `dev`).
> This captures state that otherwise lives only in the expiring session (the fable review came via
> SendMessage; the Codex reviews are in session-only scratchpad). **Everything below is the durable record.**

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
- `purge_account_memory(mem0, user_id)` — a strict wrapper over `pipeline/memory_clear.py::clear_memory`
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
