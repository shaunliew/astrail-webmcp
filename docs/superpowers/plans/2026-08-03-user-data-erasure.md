# Plan — User data erasure (Clear memory + Delete account)

> Draft 2026-08-03 · **REVISED 2026-08-04 after Codex + fable eng-review** · branch `zh`
> Status: **REVIEWED → REVISE-COMPLETE, ready to implement.** Owner: backend lane.
> Reviews: fable eng-review = REVISE · Codex = BLOCK → both folded in below (§9 review report).
> Closes launch-gate #2 (Clear-memory no-op) + #4 (no deletion path) and makes the published
> `/privacy` promise executable. **Destructive + irreversible — implement task-by-task, stop before
> anything destructive is wired end-to-end for human review. Do NOT merge/PR without ZH review.**

---

## 0. TL;DR for the person cooking tomorrow

Build two operations:
1. **Clear memory** (Settings button, keeps account) — wipe the user's mem0 memory + their *learned*
   preference rows, in one transaction. Powers the currently-fake button.
2. **Delete account** (email-triggered, full wipe) — wipe mem0 **then** delete the `auth.users` row,
   which cascades all 22 user-owned tables. Triggered by a guarded operator script, not a web endpoint.

Both share one mem0 wipe helper behind one safety choke-point. **The whole review boiled down to: the
architecture is correct (cascade verified real by both reviewers), but the mem0 "can't tell empty from
unreachable" bug (§3.1 F1) must be closed or account deletion can orphan a user's memory forever.**

Start with **Task 1** (the choke-point + mem0 helper + fault-injection tests) — safest brick, nothing
destructive wired yet.

---

## 1. Why

Our live `/privacy` page commits, in writing:

> "To delete your account, email us … Deletion removes your account, saved reels, and generated trips,
> and erases your remembered preferences (including your mem0 memory)."

Today no code executes that: `clearMemory()` is a mock no-op (`frontend/lib/trip/mock-api.ts:73`), no
`mem0.delete_all` call exists in the backend, and there is no account-deletion path. We are making a
legal promise (PDPA — Terms are Singapore-governed; GDPR/CCPA honored on request) we cannot keep.

**Approach (locked):** Option 1 — build the erase capability + wire the button; account deletion stays
**email-triggered via a guarded operator script** (no self-serve page, no new admin-auth surface). The
core `erase_user()` is written so a self-serve endpoint or admin dashboard can wrap it later.

---

## 2. Verified facts (recon, re-confirmed by BOTH reviewers)

- **Cascade is REAL.** `public.users.id → auth.users(id) ON DELETE CASCADE`
  (`supabase/migrations/20260701131304_identity_persona_foundation.sql:19`). Every user-owned table
  chains off it with `ON DELETE CASCADE`. Deleting the one `auth.users` row wipes the whole graph. No
  orphans; no global/shared table is caught in the wipe.
- **Table count is 22, not 26** (the earlier draft was wrong). The **22 user-owned tables** (pin this
  list; the Task-6 gate asserts against it, or derive live from `information_schema` FKs):
  `users, traveler_profiles, user_preference_facts, memory_events, user_daily_usage, trips, jobs,
  generation_events, trip_inspiration_items, trip_places, trip_days, transport_legs,
  restaurant_suggestions, hotel_suggestions, feedback, saved_reels, reel_collections,
  reel_collection_items, organize_jobs, organize_job_items, organize_events, reel_place_mentions`.
- **Global / shared — must NOT delete:** `reel_cache`, `places`, `location_graph_nodes/edges`,
  `geocode_country_cache`, and the `reel-covers` Storage bucket (URL-hash keyed, service-role written →
  no FK block on the auth delete). These retain scraped public IG content, **not** private user data.
- **Auth admin delete works.** Service-role client at `backend/supabase_client.py:30` can call
  `client.auth.admin.delete_user(id)` (`supabase_auth/_async/gotrue_admin_api.py:184`).
- **mem0 keying.** `user_id` = Supabase JWT `sub` (`backend/auth.py:120`), used in every mem0
  `search`/`get_all`/`add` (`backend/pipeline/preferences.py:102,148,197`). Exact wipe:
  `await mem0.delete_all(user_id=user_id)`. **mem0 2.0.10 `_prepare_params` silently drops `None`** →
  `delete_all(user_id=None)` becomes an UNFILTERED project-wide wipe. This is why the UUID guard is
  load-bearing, not decorative.
- **Schema base is stale.** `zh` lags `dev` (missing entitlement migrations
  `20260803120000_entitlement_free_trial.sql`, `20260803130000_request_seat.sql` — columns only, no new
  user table, so no new orphan today). **Do the backend work + E2E gate on a dev-rebased base with ALL
  migrations applied.**

---

## 3. Design

The load-bearing invariant everywhere: `user_id` is the authenticated caller's JWT `sub` (clear-memory)
or an operator-supplied UUID validated + resolved to exactly one account (delete-account). **Never**
client-supplied for an endpoint, **never** `"*"`, **never** `reset()`.

### 3.1 Safety invariants (the fixes from review — read first)

- **F1 — mem0 `None` is NOT success (CRITICAL).** `get_mem0_client()` returns `None` both when memory
  is disabled AND when construction failed / key missing (`backend/mem0_client.py:51`). So:
  - **Account-deletion path:** `None` → **ABORT the whole deletion** (do not delete the auth user)
    unless the operator passes an explicit `--skip-mem0` override. A missing key in the script env is a
    *misconfiguration*, not a disabled deployment (prod has mem0 live).
  - **Clear-memory path:** `None` → return a truthful `memory_backend: "unavailable"` (still clear the
    Postgres rows), never report `cleared`.
- **F2 — guard failure ≠ purge failure (invariant).** `_assert_real_uuid` raises a distinct error that
  **propagates (HTTP 500 / script abort)** and is *never* caught as `MemoryPurgeError`. A test must
  prove the endpoint 500s (not 200s) on a bad uuid, and that the Postgres deletes never run with a bad
  id. `_assert_real_uuid` lives OUTSIDE every try/except.
- **F3 — canonicalize the uuid.** `uuid.UUID()` accepts brace/urn/no-dash forms. Require
  `str(uuid.UUID(u)) == u.lower()` (canonical, lowercase) so the Postgres cast and mem0's *string*
  keying refer to the same user. A non-canonical id could wipe Postgres while silently keeping mem0.
- **F4 — no erasure while the user is mid-flight (N1, lightweight).** Before clear/delete, check for an
  active `jobs` / `organize_jobs` row (in-progress). If one exists: clear-memory + account-deletion
  **refuse** with "finish your in-flight trip first" (the pipeline writes mem0 via
  `persist_trip_memory` `preferences.py:175` and would repopulate after the wipe). No write-blocking
  tombstone system for the beta.

### 3.2 Shared helper — `purge_user_memory(user_id, *, require_backend)`  (`backend/erasure.py`, new)

```python
async def purge_user_memory(user_id: str, *, require_backend: bool) -> str:
    _assert_real_uuid(user_id)                 # F2/F3 — raises OUTSIDE any caller try
    mem0 = await get_mem0_client()
    if mem0 is None:
        if require_backend:                    # F1 — account deletion
            raise MemoryBackendUnavailable
        return "unavailable"                   # clear-memory: truthful, not "cleared"
    try:
        await asyncio.wait_for(mem0.delete_all(user_id=user_id), timeout=15)
    except Exception as exc:
        logger.warning("mem0 purge failed (type=%s)", type(exc).__name__)
        raise MemoryPurgeError from exc
    return "cleared"
```

`delete_all` is **queued, not synchronous** (returns `{message, event_id}`). Do NOT verify erasure with
an immediate read on the endpoint path. The **operator script** additionally polls `get_all(user_id)`
until empty (bounded ~30s) and records the `event_id` BEFORE the auth delete — converting "submitted"
into "verified empty" for the one path where the legal promise binds. **Task 1 pins mem0's actual
2.0.10 delete/return contract with a recorded test** (the async-queue vs sync-DELETE detail was
uncertain in review — confirm against the installed SDK, don't guess).

### 3.3 Clear memory (keep account) — `POST /settings/memory/clear`

- Auth `Depends(get_current_user_id_stashed)`, rate-limited, `user_id` from token only.
- **F4** in-flight check first → 409 if a job is active.
- `purge_user_memory(uid, require_backend=False)`.
- **Atomic Postgres clear in ONE owner-scoped SQL RPC / transaction** (not 3 loose PostgREST calls —
  they can partially fail and lie). The RPC deletes/updates, all scoped to the caller:
  - delete `user_preference_facts` where `user_id = uid` **AND `source` is a learned/remembered
    provenance** (NOT `source = 'onboarding'`) — **D1: keep explicit onboarding facts.**
  - delete `memory_events` where `user_id = uid`; insert one `memory_events {event_type:'cleared'}`
    (no preference content) as the durable clear-audit.
  - **Do NOT touch `traveler_profiles`** — every field there (origin, pace, `travel_style_tags`,
    `preference_tags`, `preference_notes`) is explicit onboarding the user typed. (`traveler_profiles`
    is keyed by `id`, not `user_id` — note for whoever writes the RPC.)
- Response: `{ ok, memory_backend: "cleared" | "unavailable", cleared_at }`. Model in
  `backend/api/schemas.py`; TS mirror in `frontend/lib/trip/backend-types.ts` (guardrail #4).
- Idempotent.

### 3.4 Delete account (full wipe) — core service `erase_user(client, user_id)`

1. `_assert_real_uuid` + F4 in-flight check (refuse if active job).
2. `purge_user_memory(uid, require_backend=True)` → **F1 abort if mem0 unavailable.** Then poll
   `get_all(uid)` empty (bounded) + capture `event_id`.
3. `await client.auth.admin.delete_user(uid, should_soft_delete=False)` → cascades the 22 tables.
   Preflight: no Storage objects owned by the user (Supabase blocks auth-delete if so; `reel-covers` is
   service-role owned today, so expected clear — assert it). Note existing JWTs stay valid until expiry
   (local verify doesn't check the user still exists) — acceptable for the operator flow; a self-serve
   version later must invalidate sessions.
4. Write a **durable minimal erasure record** (D3): `{uid, deleted_at, mem0_event_id, verification,
   stage_outcomes}` — **no personal content**, its own retention, pseudonymize/drop the raw uid after
   reconciliation. A tiny `erasure_audit` table or a controlled ops store — NOT app-log-only (Render log
   retention is short, no monitoring).
5. Treat "user already gone / 404" as success **only** when the durable record proves a prior completed
   auth-delete (else a first-run typo looks like success).

### 3.5 Operator trigger — `backend/scripts/erase_user.py` (guarded)

- Input `--email <addr>` → resolve to uid by **exact, lowercased, normalized** match; assert **exactly
  one** account; GoTrue admin has no get-by-email, so list+filter carefully.
- **Print a preview:** matched account's stored email + uid, plus counts (trips, reels, facts, feedback,
  jobs, in-flight jobs, mem0 memory count). Require typed **`--confirm-user-id <resolved-uid>`** to act
  (not a bare `--confirm`). Dry-run without it.
- **Identity verification (F/CCPA):** never delete off a raw inbound "From" email alone. Require a
  confirmation reply from the account's **verified** email (or an authenticated confirmation) before the
  operator runs the script. Document this as the SOP.
- Runs only from a controlled operator env; do not log email addresses or leave them in shell history.
- Track the request against the strictest promised deadline (CCPA 45 days / GDPR ~1 month).

### 3.6 Frontend wiring (clear-memory only)

- `frontend/lib/trip/supabase-api.ts` — real `clearMemory()` → `POST /settings/memory/clear`.
- `frontend/components/settings/SettingsView.tsx` — swap `clearMemory` import from `mock-api` →
  `supabase-api`; **add a confirmation dialog** (irreversible) + scope copy ("this forgets what we
  learned about your taste; your saved origin/pace stay"). **Optimistic UI on 200** (`setCleared(true)`
  — the queued mem0 delete means an immediate re-fetch can still show facts; do NOT assert instant
  emptiness). A network/mem0 failure must NOT set `cleared=true`; show the honest `unavailable` state.
- `frontend/lib/trip/backend-types.ts` — mirror the response type.

### 3.7 Privacy policy honesty (N2 — narrow the wording)

Edit `frontend/app/privacy/page.tsx` "Your rights and choices" / "Data retention": add a one-line
carve-out — deletion removes account + reels + trips + mem0 memory, **but** (a) database backups retain
copies for a short retention window before rolling off, and (b) shared, de-identified public-content
caches (scraped captions/transcripts, reel cover images — not tied to your identity) may persist. This
makes the promise true. Do NOT over-build backup-scrubbing for a 25-seat beta.

---

## 4. Task breakdown (subagent-driven, TDD, per BUILD-LOOP)

Do these in order. Stop after Task 1 for human review before wiring anything destructive.

| # | Task | Files | Reviewer / fault-inject focus |
|---|------|-------|-------------------------------|
| 0 | Rebase `zh` on `dev` (all migrations applied) so backend work + E2E run on the true schema | — | confirm entitlement migrations present |
| 1 | `_assert_real_uuid` (F2/F3) + `purge_user_memory` (F1) + `MemoryBackendUnavailable`/`MemoryPurgeError`; **pin mem0 2.0.10 delete contract with a recorded test** | `backend/erasure.py`, `backend/test_erasure.py` | fault-inject `"*"`,`None`,`""`, brace/urn uuid → raise BEFORE any mem0 call; `None`+require_backend → abort; guard error ≠ purge error |
| 2 | Atomic clear RPC (learned-only, keep onboarding) + `POST /settings/memory/clear` + F4 in-flight 409 | migration (RPC), `backend/main.py`, `backend/api/schemas.py`, `backend/erasure.py`, `backend/test_settings_routes.py` | 401 no token; only caller's rows; onboarding facts SURVIVE; mem0-unavailable → 200 truthful; guard-fail → 500 not 200; idempotent |
| 3 | Frontend clear wiring + confirm dialog + optimistic UI | `supabase-api.ts`, `SettingsView.tsx`, `backend-types.ts`, settings test | button hits real endpoint; confirm dialog; failure never shows "cleared"; no instant-empty assertion |
| 4 | `erase_user` full wipe (mem0 abort-on-unavailable → verify-empty → auth delete) + durable `erasure_audit` | `backend/erasure.py`, migration (audit table), `backend/test_erasure.py` | mem0=None aborts BEFORE auth delete; storage preflight; 404=success only with prior record; globals untouched |
| 5 | `scripts/erase_user.py` guarded CLI (exact email match, typed `--confirm-user-id`, preview, in-flight check) | new script + test | no confirm = dry-run; refuses `"*"`/empty/multi-match; preview shows matched email+uid |
| 6 | Privacy policy carve-out (N2) | `frontend/app/privacy/page.tsx` | wording matches what code actually does |
| 7 | **Live E2E gate** on dev-rebased local Postgres: seed throwaway user + trip/reel/facts → clear-memory (onboarding survives, learned gone) → then account delete → assert all 22 tables empty for that uid, globals intact, mem0 `delete_all` called + verified, audit row written | — | the cascade PROOF; derive the 22-table list from information_schema FKs at gate time |

---

## 5. Test / verification strategy
- Unit (Tasks 1–5); `_assert_real_uuid` gets adversarial tests — a reviewer fault-injects `"*"`/`None`/
  brace-uuid and confirms `delete_all` is never reached and the endpoint errors (not 200).
- **mem0 contract test** (Task 1): pin the installed 2.0.10 `delete_all` call shape + return; a staging
  mem0 canary user to prove real erasure without touching production users.
- **Cascade proof = Task 6** on the rebased schema (not assumed).
- `tsc --noEmit` + `vitest` (frontend) and `pytest` (backend) green before each task's commit.
- Signed-in smoke on the Settings button (open, confirm dialog, clear, honest state on reload).

---

## 6. Risks & mitigations
- **Orphaned memory after account gone (F1)** → account path aborts if mem0 unavailable; verify-empty
  before auth delete. *This is the one that blocked the plan.*
- **Over-delete via `"*"`/`reset()`/None** → single `_assert_real_uuid` choke-point (F2/F3); `reset()`
  never imported; endpoint never takes a client-supplied uid.
- **Memory reappears (live writer)** → F4 in-flight refusal.
- **Partial/lying clear** → one atomic RPC; distinct completed/pending/failed.
- **Wrong account deleted** → exact email match + typed resolved-uid confirm + verified-email challenge.
- **Promise still false** → N2 policy carve-out for backups + shared caches.

---

## 7. Decisions — RESOLVED (confirmed by Codex + fable)
- **D1** — clear only *learned* memory; KEEP explicit onboarding (origin/pace/tags). Implementation fix
  applied: filter by `source`, don't touch `traveler_profiles`. ✅
- **D2** — abort account deletion + retry if mem0 fails. ✅ (implementable once F1 closed.)
- **D3** — durable minimal erasure audit (uid/timestamp/event_id, no content, own retention), not
  app-log-only. ✅
- **D4** — guarded operator script, no web admin surface. ✅
- **N1** — live-writer race: lightweight in-flight refusal (no tombstone system). ✅
- **N2** — `/privacy`: narrow the wording honestly now; build processor/backup scrubbing post-beta. ✅

---

## 8. Ownership / notes
Backend lane (Shaun's domain: auth-admin, mem0, migrations). Drive with subagents. **Do not
merge/PR/deploy without ZH review.** All current `zh` working-tree changes (env-guard, settings-live,
this plan) are uncommitted by design.

---

## 9. GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | fable (astrail-reviewer) | Architecture & tests | 1 | REVISE | 1 critical + 2 blocking + minors; cascade verified real |
| Codex Review | `/codex` cross-model | Independent 2nd opinion | 1 | BLOCK | mem0-None, live-writer race, async-delete, email-verify, promise-scope |

- **CODEX:** blocked on: mem0 `None` false-success, erasure races live writers, async/queued delete
  premise, no email identity verification, `/privacy` broader than the wipe. All folded into §3.1–§3.7.
- **CROSS-MODEL:** both independently verified the cascade is REAL and agreed all four D1–D4
  recommendations. Both flagged the mem0-`None` hole as the top issue and the "26 vs 22 tables" error.
- **VERDICT:** ENG + CODEX reviewed → plan REVISED to address every P1. Architecture sound, no rework.
  Ready to implement starting Task 1 after a `zh`→`dev` rebase (Task 0).

**NO UNRESOLVED DECISIONS**
