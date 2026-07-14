# Astrail Beta Wiring Handoff

> Current stop point: 2026-07-15. Tasks 1-7 of the beta wiring plan have shipped on
> `dev`; automated Task 8 checks passed, but the manual production E2E checklist and
> reviewed `dev` -> `main` promotion remain open.
> Previous handoff (DB implementation, 2026-07-02) is superseded; its schema work is merged and live.

## What this session is building

The beta flow, end-to-end on localhost (deploy-ready): **email sign-up with a 6-digit
OTP code → one-time preference onboarding → paste Reel URLs → real pipeline with live
SSE stage events → itinerary rendered on the Mapbox map, saved + reloadable + listed.**

Governing documents (all committed on `zh`, all reviewed):

- Spec: `docs/superpowers/specs/2026-07-07-beta-auth-to-map-wiring-design.md`
- Plan (8 tasks, execute in order): `docs/superpowers/plans/2026-07-07-beta-auth-to-map-wiring.md`
  — ENG review CLEAR + DESIGN review CLEAR (see its `## GSTACK REVIEW REPORT` final section).
  The plan contains literal code for every step. Follow it verbatim; deviations require a reason.

## Progress: Tasks 1-7 done and committed

| Task | Commit | What landed |
|---|---|---|
| 1. Backend schema parity + preference merge | `5d47b9e` | `GenerateTripRequest` gains requested_places/budget_level/origin_city/preferences; trips insert persists them + merged `preference_summary`/`preference_sources`; new `backend/preferences.py`; 373 backend tests (7 new incl. old-shape regression) |
| 2. Frontend type parity + date-gated Generate | `fb18797` | Dates required end-to-end; `canGenerate(items, brief)`; literal test edits; also repaired pre-existing typecheck break (tokyo-trip fixture missing title/summary); 115 frontend tests |
| 3. Passwordless email OTP auth | `f945cf3` | Sign-in page rewritten (email → 6-digit code, 60s resend cooldown, autofocus/refocus), `SignOutButton`, header links; Google removed (deferred post-beta) |
| 4. Onboarding save + gate | `42d80fa` | New `frontend/lib/trip/supabase-api.ts` (RLS-direct `saveProfile` upsert), wizard swapped off mock-api with error state, middleware gate redirects un-onboarded users to `/app/onboarding` |
| 5. Real create flow + SSE | `ab024b6` | `CreateTripFlow` uses the authenticated backend client and live EventSource stream; warnings and reconnect/failure behavior are covered by tests |
| 6. Real trip reads + list | `f4492e0` | Trip detail and `/app/trips` read Supabase directly under RLS, including generating, failed, empty, and not-found states |
| 7. Deploy readiness | `9542b1f` | Env-driven backend CORS, env documentation, and Supabase OTP setup landed; later Phase-2 PRs #36-#39 hardened and deployed the backend API |

Verification state at this reconciliation: backend `431 passed, 6 skipped`; frontend
`32 files / 123 tests` passed; `npm run typecheck` clean. The Render backend is deployed
and healthy, but production promotion is not complete because `main` and the Vercel
frontend still trail `dev`.

## Remaining: Task 8 + production promotion

- **Task 8 — E2E QA.** Manual + scripted checks. Cold acceptance run uses these two
  reels (chosen by Zhi Hao, must be uncached):
  `https://www.instagram.com/reel/DYbmT-SNzVK/` and `https://www.instagram.com/reel/DYM_I5IvLSv/`.
  Automated checks are recorded in the plan. The remaining production checks are tracked
  by the GitHub Project card `Both: manual production E2E QA checklist — real OTP, cold
  multi-Reel run, second-user RLS, reload/listing, restart recovery`.
- **Production promotion.** Open and review `dev` -> `main`, apply every required
  Supabase migration, repoint Render to `main`, set Vercel `NEXT_PUBLIC_BACKEND_URL`,
  keep `NEXT_PUBLIC_MOCK_AUTH` disabled, and redeploy. Do not merge without the repo's
  review workflow.

## Historical wiring implementation loop

Tasks 1-7 are complete. The command below is retained only as historical context for
the reviewed wiring plan; do not resume at Task 5. New work starts from its GitHub
Project card and the current repository build loop.

Launch template (one task at a time):

```bash
cd C:/Github/astrail && codex exec "Read .claude/CLAUDE.md. You are executing the approved plan at docs/superpowers/plans/2026-07-07-beta-auth-to-map-wiring.md. Tasks 1-N are committed (<hashes>). Execute Task <N+1> ONLY. Follow its steps literally, including the exact code. Your sandbox cannot write to .git, so SKIP the git commit step — the orchestrator commits after verifying. Run the task's test/typecheck commands and make them pass. Report: files changed, results, any deviations and why." \
  -s workspace-write \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'model_reasoning_effort="xhigh"' \
  --enable web_search_cached < /dev/null
```

Standing rules: **always `xhigh` reasoning effort** (Zhi Hao's instruction);
network_access=true (uv/npm need it); verify Codex's report against the actual diff
before committing (`git diff`, rerun suites); commit messages follow the plan's, with
`Co-Authored-By: Codex <noreply@openai.com>`.

## Machine/environment quirks (will bite you if forgotten)

- **Backend pytest MUST run with** `PYTEST_ADDOPTS=--basetemp=.pytest-tmp` from
  `backend/` — the default `%TEMP%\pytest-of-*` dir is permission-locked and causes 5
  phantom PermissionErrors. `backend/pyproject.toml` also has `norecursedirs` guarding
  against sandbox-locked `tmpastrail-*` dirs (one such undeletable dir sits at
  `backend/tmpastrail-pytest-task1/` — ignore it, it's gitignore-invisible and
  pytest-invisible).
- Backend deps: `cd backend && uv sync` already done; venv is live.
- `gh project item-list 1 --owner MalaysiaKaki` fails on this machine ("unknown owner
  type") — needs `gh auth refresh -s project`; skip board loads during plan execution.
- Frontend: run all npm commands from `frontend/`.
- The shared integration baseline is `dev` at `d76cd20`; `main` is intentionally not
  advanced until the production-promotion review and migration checklist clear.

## External state already configured (do NOT redo)

- **Supabase dashboard (done 2026-07-08 by Zhi Hao):** custom SMTP via Resend is
  active; the Magic link/OTP email template now sends `{{ .Token }}` as a 6-digit code
  (saved). Remaining dashboard nits: subject line still says "Your sign-in link"
  (cosmetic), and OTP expiry should be set to 600s (Authentication → Providers →
  Email → Email OTP expiration) if not already.
- **Codex CLI** installed (`codex-cli 0.142.5`) and authenticated.
- Env files exist: `backend/.env`, `frontend/.env.local` (contents not inspected).

## Manual QA that only a human can do (end of Task 8)

1. Real email OTP round-trip (receive the code, wrong-code error, resend cooldown).
2. Onboarding gate: new user forced through wizard; returning user skips.
3. Cold acceptance run with the two reels above → live stages + ⚠ warnings → itinerary
   on the Mapbox map; verify trips row has budget_level/origin_city/preference_summary
   (both profile + per-trip merged) and preference_sources={memory,explicit}.
4. Refresh reload, `/app/trips` listing, second-account RLS invisibility, sign-out,
   401 on tokenless POST, kill-backend-mid-run → no frozen spinner.

## Session log pointers

- Review artifacts: `~/.gstack/projects/MalaysiaKaki-astrail/` (test plan for /qa,
  review logs). TODOS.md at repo root has one deferred item (cookie-cache the
  onboarding gate).
- Docs commits this session: `112637e` (spec), `342998b` (plan), `238d2b0` +
  `0d6fc31` (review folds), `5a2cc7e` (SMTP correction), `947a73e` (gitignore).
