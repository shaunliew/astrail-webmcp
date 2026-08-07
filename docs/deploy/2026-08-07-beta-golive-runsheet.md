# Beta Backend Go-Live Run-Sheet — Shaun (2026-08-07)

> Everything on the **backend + Supabase + Render** side that must happen before the beta goes
> live, in order, with the verification gate for each step. Covers: the Phase-1 hardening merge,
> the **account-deletion go-live (3-switch order + how the 7-day grace works)**, migrations, env
> vars, and the audit's non-code launch-gate items. **Nothing here is run for you** — the merge,
> `db push`, and flag commits are Shaun's/ZH's own actions; this doc surfaces them.
>
> **Sourcing note:** grounded in the `astrail-release` skill invariants + the committed
> `2026-08-05-account-deletion-backend-handoff.md` + the live code — **not** a live EMDEE read
> this session. Before executing, cross-check the EMDEE **Launch Pre-Checklist** live
> (`mcp__emdee__get_doc`, `full=true`); where it disagrees, EMDEE wins on *what*.

## Ground rules (never violate)

- **Golden order — NEVER reorder:** `DB migrations (Shaun) → Backend/Render (Shaun) → Frontend/Vercel (ZH) → Feature flags`. Schema and code ship decoupled; `assert_schema.py` sees **columns only** (an RPC-body/SQLSTATE change passes it green), so code ahead of its migration fails *silently*.
- **Paired flags need both owners, backend first, verified live before the UI appears.**
- **`numInstances: 1`** on both Render services is load-bearing (>1 double-bills Mapbox + Telegram 409). Do not scale.
- **Blueprint sync re-asserts the literal `render.yaml` env** — a dashboard-only override gets reverted on the next sync. For any flag with a `render.yaml` literal, **change both places**.
- **`NEXT_PUBLIC_*` are build-time** — editing one without a Vercel redeploy is a no-op.
- A **Render single-key env PUT does not reliably redeploy**; a process only picks up new env on restart. Dashboard showing a value ≠ container has it.
- **Never `supabase db push` / `git merge` / `gh pr merge`** — surface the command, let the owner run it.

---

## Step 0 — Pre-flight gate (paste evidence; an unchecked box is a STOP)

```bash
# pending migrations on prod + rollback coverage
supabase migration list --linked          # want: zero REMOTE-ONLY drift; each PENDING has rollback/<v>_down.sql
# CI green on the release branch (both gate Render's rollout)
gh run list --branch dev --limit 5 --json name,conclusion,headSha   # backend-tests AND rls-tests green
# local green
cd backend && uv run pytest -q && uv run pytest evals/ -q            # + anchor 6229.0
cd ../frontend && npm run typecheck && npm test
supabase test db
```
- [ ] Zero remote-only drift; every pending migration has a rollback script
- [ ] `backend-tests` **and** `rls-tests` green on `dev`
- [ ] Local suites green (BE pytest + evals · FE typecheck + test · pgTAP)
- [ ] **Prod DB backup taken** (Supabase dashboard) — the standing debt is real: most applied migrations have **no** `down.sql`, so the backup is the only DB rollback path. Take it even if "no migrations are running today."
- [ ] Render `sync:false` secrets set in the target env; Vercel prod `NEXT_PUBLIC_*` set; preview/prod origins in backend `ALLOWED_ORIGINS`
- [ ] Cross-owner changes have a `docs/deploy/` handoff the other owner has read

---

## Step 1 — Repoint Render `dev → main` (⚑1) — do this FIRST if not already done

Prod is `main` (decided 2026-08-06) but `render.yaml` still pins **`branch: dev`** on both services. This is a **3-step sequence, not an edit** — Render syncs its Blueprint from the branch it currently tracks, and `main` was ~820 commits behind `dev`, so doing it out of order ships the pre-pivot backend to prod.

1. **Promote first** — merge `dev`→`main` with the `render.yaml` change NOT yet made (Render still on `dev`, nothing deploys). Verify `git rev-list --count origin/main..origin/dev` is `0`.
2. **Then repoint** — commit `branch: main` on both services in `render.yaml`, push to `dev`. Render syncs, repoints to `main`; because `main == dev` now, the deploy is the *same code*. Watch `/health`.
3. **Reconcile** — merge that commit `dev`→`main`. From here, `dev`→`main` is the release.

*(If `git rev-list --count origin/main..origin/dev` is already `0` and `render.yaml` says `branch: main`, this is done — skip.)*

---

## Step 2 — Merge Phase-1 hardening

Branch `feat/prelaunch-hardening` (see `2026-08-07-prelaunch-hardening-handoff.md`). Gate is green (per-task SHIP-WITH-NITS + Codex fix-delta SHIP). **No migration, no new env, no flag.** Merging to `dev` auto-deploys the backend.
```bash
git checkout dev && git merge --no-ff feat/prelaunch-hardening && git push origin dev
```
Watch the Render deploy + `/health`, then delete the branch.

---

## Step 3 — Account-deletion go-live (the 3-switch dance + 7-day grace)

The engine is **merged and deployed dark** (PR #61 `d47842a`; migrations `20260805000000` + `20260805010000` applied to prod, zero drift, gate proven shut live). Going live is flipping the switches — in one order.

### How the 7-day grace protects against a butter-finger click
1. User clicks **Delete account** → `POST /account/deletion` → `request_account_deletion` RPC: `account_status` `active → pending_deletion`, `deletion_scheduled_for = now() + interval '7 days'`, an `account_deletion_log` row `outcome='pending'`, and a **"cancel by {date}" email** fires (`send_deletion_scheduled_email`). No data is touched yet.
2. **During the 7 days** — `GET /account/deletion/status` (ungated) returns `pending_deletion` + the scheduled date, so the UI shows a persistent "scheduled for deletion — cancel" banner. The user (or anyone who re-logs in) clicks **Cancel** → `cancel_account_deletion` → `pending_deletion → active`. **Fully reversible.**
3. **After 7 days** — the sweep (`sweep_due_deletions`, run only from `_reap_loop` when `_DELETION_EXECUTION_READY=True`) claims the row (`pending → deleting` via `claim_account_for_deletion`; **a cancel now loses** — this is the point of no return), purges app data (Pass A, verify-before-delete), deletes the `auth.users` row (Pass B), marks `completed`.

The email is *load-bearing* here — it replaces reauthentication in the design, so a stolen session that requests deletion still warns the real owner. That's why RESEND is a hard lock (below).

### PRE-FLIP GATE — verify DONE before Shaun flips (mostly ZH's lane)
Do **not** flip `_DELETION_EXECUTION_READY` until these are confirmed resolved + Shaun re-reviews. The 2026-08-05 handoff parked four engine blockers on ZH's side; the code now carries `test_deletion_engine.py` + the `last_error`/`outcome` machinery, but **confirm sign-off against board card `Both P1: account deletion` and PR #61's review comment** rather than assuming:
- **F1** — stale log-row eats a re-requested grace (needs the `outcome='pending'` guard on the mark path).
- **F2** — dual sweeper double-sends the completion email (CAS-send-once).
- **F3** — durable scheduled-notice email: stamp the log row on send failure + let the sweep retry (a silent Resend 500 = a 7-day countdown nobody sees).
- **2 regression tests** (F1, F2), + recommended `and scheduled_for <= now()` in the claim RPC (clock-skew hardening).
- Frontend **delete card + honest `/privacy` copy** ready behind `NEXT_PUBLIC_DELETION_ENABLED`.

### The 3 switches — one order, none skippable
1. **Shaun — set RESEND in Render:** `RESEND_API_KEY` + `RESEND_FROM_EMAIL = "Astrail <no-reply@send.astrail.xyz>"`. This is a **second fail-closed lock**: `main.py` checks `_DELETION_EXECUTION_READY` (:365) *and* `resend_configured()` (:776) before any DB round-trip — without RESEND the endpoint 503s (refuses to start a grace it can't warn about). **Verify the process actually restarted with the values** (single-key PUT ≠ redeploy).
2. **Shaun — flip `_DELETION_EXECUTION_READY = True`** (`backend/main.py:365`). This is a backend **constant → a code commit + redeploy, NOT a dashboard toggle.** Then **verify live**: with a real user JWT, `GET /account/deletion/status` → **200** (the positive control — proves token/auth/routing), `POST /account/deletion` now **enters the grace** (was 503 `deletion_unavailable`). Provision + delete a throwaway user via `backend/scripts/smoke_http.py::_provision_user`; confirm zero residue.
3. **ONLY THEN — ZH — set `NEXT_PUBLIC_DELETION_ENABLED=true` + redeploy Vercel** (build-time; `SettingsView.tsx:24`). The delete card now renders.

**Leave `_CLEAR_RECONCILIATION_READY = False`** (`main.py:349`) — that's the separate "clear my memory" button, not part of deletion go-live.
**Don't do solo:** flip the gate, set RESEND, or re-run the deletion migrations.

---

## Step 4 — Entitlements (free trial + beta seats) — confirm, already live on `dev`

`ENTITLEMENTS_ENABLED=true`, `TRIAL_LIFETIME_LIMIT=1`, `DAILY_TRIP_QUOTA` (retune `5→10` at this deploy — beta seats ride the daily quota). ⚠ **Rollback is non-atomic**: a Blueprint re-sync re-asserts the literal `render.yaml` value and silently undoes a dashboard-only change — **set both places**. Incident lever: `ENTITLEMENTS_ENABLED=false` + restart → legacy daily-quota path (no lifetime enforcement).

## Step 5 — Beta seats (25 cap) — MANUAL, no code cap

Shaun sets `users.plan` = `'beta'` per grant; `request_seat` only stamps `seat_requested_at`. **A human tracks the running count** — there is no automatic 25-cap. Trial accounts default to 1 lifetime generation.

## Step 6 — Non-code launch-gate items (from the 2026-08-07 security audit) — VERIFY before go-live

These are dashboard/topology facts no code review can see; they were the audit's residual risk:
- [ ] **Provider hard spend caps + alert thresholds** on OpenAI, Apify, Mapbox (billing alerts ≠ caps). Set the alert threshold too — until Sentry is on, these caps are the **only detection** for the refund-cycling spend vector (the Phase-2 code fix for it is post-launch).
- [ ] **`SENTRY_DSN` set in Render + one scrubbed test event arrives.** `backend/observability.py` is live but **dormant** until the DSN is set — the "error monitoring" P1 is otherwise shipped-dark.
- [ ] **`/readiness`** — rate-limit it, or confirm the `*.onrender.com` host sits behind the edge WAF. It's an unauthenticated DB-touching endpoint on a discoverable host; the audit flagged it as the one uncapped anonymous flood vector.
- [ ] **Prod RLS/grants spot-check** — `pg_tables.rowsecurity` + `information_schema.role_table_grants`. Every RLS proof ran on CI-shaped DBs; prod is hand-migrated, so confirm once on prod.

## Step 7 — Smoke (both owners)

`/health` 200 · `backend/scripts/smoke_http.py` + `smoke_generate.py` · **one real end-to-end trip generate** · landing loads · `/sitemap.xml` + `/robots.txt` 200. If account deletion went live: one throwaway request→cancel round-trip, and confirm the grace banner renders.

---

## Rollback

| Tier | Action |
|---|---|
| Frontend | Vercel → previous prod build → **Promote to Production** (instant) |
| Backend | Render → previous deploy → **Rollback**, or `git revert` the merge on `main` |
| Database | **Forward-only** via `rollback/<version>_down.sql`; for a destructive change **restore the pre-release backup** — never improvise a reverse migration |
| Flags | Flip back. `_DELETION_EXECUTION_READY` / `_CLEAR_RECONCILIATION_READY` are code constants (commit+redeploy). Mind the entitlements Blueprint-sync gotcha. |

**Trigger:** `/health` red, trip generate failing, or auth broken → roll FE + BE to the previous prod build. Leave the DB alone unless a migration is the cause, then restore the backup.

## Explicitly NOT going live now (post-launch)

- **Phase-2 hardening** (T1 failure-budget RPC + T2 retry cap) — needs a delta re-review + live E2E gate; provider caps (Step 6) are the interim mitigation.
- **`_CLEAR_RECONCILIATION_READY`** stays `False` (the "clear my memory" button).
