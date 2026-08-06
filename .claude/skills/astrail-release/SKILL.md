---
name: astrail-release
description: Use when shipping Astrail to production — releasing, promoting dev→main, applying migrations to the prod DB, deploying backend or frontend, flipping a feature flag, repointing a deploy branch, running the launch run-sheet, rolling back, or handing a blocker across the Shaun/Zhi Hao owner line. Enforces the RELEASE SOP golden order, pre-flight gate, flag choreography, and rollback. Not for feature work — that is the Standard Feature Build Loop.
---

# Astrail Release

The operational front of the **RELEASE SOP**. The build loop ends at `dev`; this skill owns
everything from `dev` to production. Feasible-first governs *scope*; this governs *process* — and
unlike scope, none of it is negotiable, because every step here is hard to reverse and visible to
real users.

## Source of truth — load it live, do not recite it from here

The SOP itself lives in EMDEE (Zhi Hao's shared vault) and both owners edit it:

| Doc | Path |
|---|---|
| RELEASE SOP | `__shared__/user_3FZUjBSvk00tGcs3QmOdCFa4Kgd/astrail/RELEASE-SOP.md` |
| Launch Pre-Checklist | `__shared__/user_3FZUjBSvk00tGcs3QmOdCFa4Kgd/astrail/LAUNCH-PRE-CHECKLIST.md` |

**Read both before any release action** (`mcp__emdee__get_doc`, `full=true`). This file carries only
the invariants that must survive without a network round-trip, plus the gate mechanics. Where the two
disagree, EMDEE wins on *what* and this file wins on *how to run the check* — and say which you used.
If the EMDEE connector is unavailable, say so and proceed on the invariants below; never invent a step.

## The two things you must never get wrong

**1. The golden order — NEVER reorder.**

```
DB migrations (Shaun)  →  Backend/Render (Shaun)  →  Frontend/Vercel (ZH)  →  Feature flags
```

Schema and code ship **decoupled**. `/health` does not check schema, and Render's `assert_schema.py`
pre-deploy gate sees **columns only** — a changed RPC signature or SQLSTATE passes it green. So code
that reaches prod ahead of its migration fails *silently*, which is worse than failing loudly.

**2. The owner split — and what neither owner may do alone.**

| Surface | Owner |
|---|---|
| Prod DB / migrations / Supabase | **Shaun** |
| Backend, Render, backend constants + Render env | **Shaun** |
| Manual beta seat grants (`users.plan`) | **Shaun** |
| Frontend, Vercel, all `NEXT_PUBLIC_*` | **Zhi Hao** |

A flag that spans both surfaces **cannot be flipped by one person.** Backend goes first and is
*verified live* before the UI is exposed — see Flag choreography. Neither owner edits the other's
surface silently; the mechanism for crossing the line is a handoff doc (below), not a DM.

## Pre-flight gate — run this, don't assert it

Every box must be green *with evidence pasted*, before any prod action. An unchecked box is a stop.

```bash
# 1. What is actually pending on prod, and does each pending one have a rollback?
#    Scope matters: a repo-wide rollback loop reports ~33 long-applied migrations and gets muted.
#    Only migrations with no `remote` are this release's DB step.
supabase migration list --linked 2>/dev/null | grep -o '{"migrations".*' | python3 -c '
import json,sys,pathlib
m=json.load(sys.stdin)["migrations"]
pending=[x["local"] for x in m if x.get("local") and not x.get("remote")]
orphan=[x["remote"] for x in m if x.get("remote") and not x.get("local")]
print("PENDING (apply on release):", pending or "none — zero drift")
print("REMOTE-ONLY (drift!):     ", orphan or "none")
for v in pending:
    if not pathlib.Path(f"supabase/migrations/rollback/{v}_down.sql").exists():
        print("BLOCKER — no rollback script:", v)
'

# 2. CI green on the release branch — BOTH gate Render's rollout
gh run list --branch dev --limit 5 --json name,conclusion,headSha

# 3. Local green
cd backend && uv run pytest -q && uv run pytest evals/ -q
cd frontend && npm run typecheck && npm test
supabase test db
```

- [ ] Check 1 clean: zero `REMOTE-ONLY` drift, and every `PENDING` migration has a rollback script
- [ ] `backend-tests` **and** `rls-tests` green on the release branch (check 2)
- [ ] Local suites green: BE pytest + evals · FE typecheck + test · `supabase test db` (check 3)
- [ ] **Prod DB backup taken** (Supabase dashboard) — before *any* migration
- [ ] Render `sync:false` secrets all set in the target env; Vercel Production `NEXT_PUBLIC_*` set;
      preview/prod origins present in backend `ALLOWED_ORIGINS`
- [ ] Feature QA'd on the `dev` Vercel preview
- [ ] Any **cross-owner** change has a handoff doc under `docs/deploy/` and the other owner has read it

The eval anchor is `uv run pytest evals/ -q`, **not** the `run_eval` CLI headline number — they are
different subjects (`.claude/docs/BUILD-LOOP.md`).

## Release steps

1. **Integrate** *(either owner)* — feature → `dev` via PR, CI green. QA on the `dev` Vercel preview.
2. **Migrations to prod** *(Shaun)* — backup first, then each new file **in order**:
   `supabase db query --linked -f <file>` → `supabase migration repair --status applied <version>` →
   `supabase migration list --linked` to confirm zero drift. Never `db push`. Never hand-split a
   multi-statement file that lacks `IF NOT EXISTS`.
3. **Promote** *(either owner)* — PR `dev`→`main`, reviewed, merged. **Merging is the user's action,
   not yours** — surface the command, never run it.
4. **Backend** *(Shaun)* — the merge fires `checksPass` → rollout → `assert_schema.py` → watch
   `/health`. **If the change alters an RPC signature or a raised SQLSTATE, set
   `autoDeployTrigger: off` and hand-deploy AFTER the migration** — that exact case would have 500'd
   prod through *both* merge orderings, and three reviewers missed it.
5. **Frontend** *(Zhi Hao)* — `main` build → astrail.xyz. `NEXT_PUBLIC_*` are **build-time**: an env
   edit without a redeploy changes nothing.
6. **Smoke** *(both)* — `/health` 200 · `backend/scripts/smoke_http.py` + `smoke_generate.py` · one
   real end-to-end trip generate · landing loads · `/sitemap.xml` + `/robots.txt` 200.

## Flag choreography

Split by surface; **paired flags need both owners, backend first, verified before the UI appears.**

- **Account deletion — 3 switches, one order.** (1) Shaun sets `RESEND_API_KEY` +
  `RESEND_FROM_EMAIL` in Render (endpoints fail closed to 503 without it) → (2) Shaun flips
  `_DELETION_EXECUTION_READY=True` — a backend **constant**, so a code commit + redeploy, not a
  dashboard toggle → **verify the deletion status endpoint live** → (3) *only then* ZH sets
  `NEXT_PUBLIC_DELETION_ENABLED=true` and **redeploys** Vercel.
  Leave `_CLEAR_RECONCILIATION_READY=False` — that is the separate "clear my memory" button.
- **Entitlements.** `ENTITLEMENTS_ENABLED`, `TRIAL_LIFETIME_LIMIT`, `DAILY_TRIP_QUOTA`. ⚠ Rollback is
  **non-atomic**: a Blueprint re-sync re-asserts the literal `render.yaml` value and silently undoes a
  dashboard-only change. **Change both places.**
- **Beta seats (25 cap).** MANUAL — Shaun sets `users.plan`; `request_seat` only stamps
  `seat_requested_at`. There is **no code cap**; a human tracks the running count.
- A Render env-var PUT does **not** redeploy. Verify the process actually restarted with the value.

## Rollback

| Tier | Action |
|---|---|
| Frontend | Vercel → Deployments → previous prod build → **Promote to Production** (instant) |
| Backend | Render → previous deploy → **Rollback**, or `git revert` the merge commit on `main` |
| Database | **Forward-only.** Use `supabase/migrations/rollback/<version>_down.sql`. For a destructive change, **restore the pre-release backup** — never improvise a reverse migration |
| Flags | Flip back, minding the entitlements Blueprint-sync gotcha above |

**Trigger:** `/health` red, trip generate failing, or auth broken → roll FE + BE back to the previous
prod build. Leave the DB alone unless a migration is the cause, then restore the backup.

⚠ **Standing debt — DB rollback coverage is thin.** As of 2026-08-06 only 4 of 37 applied migrations
have a `rollback/<version>_down.sql`; the entitlement, hotel-geo-ranking, and hotel-geocode-cache
migrations have none. This does not block a release whose pre-flight shows zero pending migrations —
but it does mean **the pre-release backup is the only DB rollback path** for anything already applied.
Take the backup. Do not skip it on the reasoning that "no migrations are running today."

## Cross-owner handoff protocol

The two-person failure mode is not bad code — it is *work parked on the wrong side of the owner line
with no artifact*. When a change needs the other owner (a flag they own, a deploy on their surface, a
blocker you cannot clear), write a handoff doc; do not rely on chat.

Path: `docs/deploy/YYYY-MM-DD-<topic>-handoff.md`. Use `handoff-template.md` in this skill directory.
Then: commit it, and hand **Codex** the board-card update (Codex owns GitHub Project #1 mutations).

A handoff doc is required — not optional — when the change (a) needs a flag the other owner controls,
(b) alters a shared contract (`backend-types.ts` parity, SSE frames, error envelope, rate-limit
headers), or (c) is deployed **dark** and someone must later flip it on. Dark deploys rot: the
account-deletion engine has been live-but-gated since 2026-08-05 with four open blockers, and the only
reason that is recoverable is that its handoff doc exists.

## Guardrails — do NOT touch casually

- **`numInstances: 1`** on both Render services is load-bearing: >1 **double-bills Mapbox** and causes
  a **Telegram 409** (duplicate `getUpdates` consumer). Never scale naively.
- **Blueprint sync re-asserts literal env from `render.yaml`** — dashboard-only overrides get reverted.
- **`NEXT_PUBLIC_*` are build-time.** Editing one without a Vercel redeploy is a no-op.
- **Never run `git merge` / `gh pr merge` / `supabase db push` for the user.** Shaun's settings deny
  them deliberately. Surface the command and let the user run it; never work around the denial.
- Stage **explicit paths**. Never `git add -A` while a subagent is live.

## ⚑1 — the `dev`→`main` repoint (decided 2026-08-06: `main` is production)

`render.yaml` currently pins **`branch: dev`** on both services while Vercel prod is `main`. The
target is `main` for both. **This is a sequence, not an edit** — Render syncs its Blueprint from the
branch it *currently tracks*, so committing `branch: main` onto `dev` makes Render read it, repoint
itself to `main`, and deploy whatever `main` holds. `main` was 820 commits behind `dev` on 2026-08-06;
doing this out of order ships the pre-pivot backend to production.

Each step below is safe **on its own**; run them in order and verify between.

1. **Promote first.** Merge `dev`→`main` with the render.yaml change **not yet made**. Render is still
   on `dev` and sees no Blueprint change, so nothing deploys. Verify `git rev-list --count
   origin/main..origin/dev` is `0`.
2. **Then repoint.** Commit `branch: main` on both services in `render.yaml`, push to `dev`. Render
   syncs, repoints to `main` — and because `main` now equals `dev`, the resulting deploy is the *same
   code*. Watch `/health` through it.
3. **Reconcile.** Merge that commit `dev`→`main` so both branches agree. From here on, `dev`→`main` is
   the release.

Until step 3 completes, `docs/CONNECTION-CONTRACT.md`'s open items and the SOP run-sheet describe the
*target*, not the live wiring. Say so rather than reading them as current.

## Verdict discipline

Report what was actually done, with evidence — a deploy is the one place where an optimistic summary
becomes a production incident. "Migrations applied" means `migration list --linked` showed zero drift
and you pasted it. "Flag flipped" means you hit the endpoint afterwards. If a step was skipped, say
which and why. Never claim a release is complete on a green CI badge alone.
