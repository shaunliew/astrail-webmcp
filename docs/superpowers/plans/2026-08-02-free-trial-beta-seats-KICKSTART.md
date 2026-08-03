# Kickstart — implement the Free-trial + beta-seats entitlement arc

> Paste the block below as the first message in a fresh Claude Code session (repo:
> `~/Github/astrail`). It is self-contained: it points at the frozen plan and tells the session to
> build, not re-plan.

---

You are implementing the **Free trial + beta seats entitlement arc** for Astrail. The plan is
**frozen and build-ready** — do NOT redesign it or re-open the review loop.

**Read these FIRST, in order, before touching code:**
1. `docs/superpowers/plans/2026-08-02-free-trial-beta-seats.md` — the plan (Rev 6). Read it top to
   bottom, including the `## Codex review log` at the end (it explains *why* the non-obvious choices
   are there — the design passed 4 consecutive Codex architectural validations; the `unique_violation`
   handling, the two-RPC atomic ledger, the partial index, and `ENTITLEMENTS_ENABLED` rollback flag
   are all deliberate, don't "simplify" them).
2. Your memory note `entitlement-free-trial-plan.md` (loaded via MEMORY.md) — the review history + the
   judgment calls behind the design.
3. `.claude/docs/BUILD-LOOP.md` (mandatory workflow), plus `.claude/docs/ARCHITECTURE.md`,
   `.claude/docs/BACKEND-PRINCIPLES.md`, and `.claude/docs/ENV.md` on the triggers in `.claude/CLAUDE.md`.

**What this is (one line):** trial accounts get exactly **1 lifetime generation**; **25 beta seats**
(manually granted) ride the daily quota. The mechanism is two atomic Postgres RPCs
(`reserve_and_enqueue_trip_job` + an extended `complete_trip_run`) where **the jobs row IS the charge
ledger** — a charge exists iff a durable job records it, and failures refund exactly once behind the
lease CAS.

**Ground rules:**
- **Branch:** work on `entitlements` off `dev` (not `zh`, not `main`).
- **This is normally Shaun's backend lane — Zhi Hao is building it.** Give Shaun visibility and update
  the GitHub Project board (`astrail-task-tracking` skill) as you go.
- **Follow BUILD-LOOP.md:** implement the plan's **11 tasks in order** (DB-first — Task 1 migration +
  pgTAP first), each as an `astrail-developer` dispatch (TDD, transcribe the plan's code faithfully)
  reviewed by `astrail-reviewer` (fault-inject to prove the guards are load-bearing). Then the
  whole-branch `astrail-reviewer` (opus) pass **AND** gstack `/review` (Codex cross-model) — run BOTH.
- **Verify seams before editing.** The plan cites exact `file:line`s (e.g. `main.py:373`,
  `jobs.py:78`), but the tree may have drifted — re-grep/confirm each seam before you change it; don't
  trust a line number blindly.
- **Respect the guardrails** (`.claude/CLAUDE.md` §Non-Negotiable): schema parity ships all three
  sides in one PR (migration + `backend/api/schemas.py` + `frontend/lib/trip/backend-types.ts`); auth
  + owner-check on every endpoint; durable-jobs contract; **the SSE termination contract is
  untouched**. Per-task gates: `uv run pytest -q` · `uv run pytest evals/ -q` · `npm test` ·
  `npx tsc --noEmit` · DB tasks also `supabase db reset` + `supabase test db` + `supabase db lint --local`.

**The last gate is a real E2E test** (`## E2E verification` in the plan) — required before PR/merge,
Zhi Hao's explicit bar. Drive the whole flow against a live local stack (`supabase start` + backend +
Next.js), via gstack `/qa` (or a Playwright spec). Three scenarios:
- **A:** fresh trial → generate (count→1) → 2nd attempt pre-empted by `TrialExhaustedCard` → forced
  POST → 403 `trial_exhausted` → request seat (`seat_requested_at` set) → grant `plan='beta'` →
  generate until daily cap → 429.
- **B (load-bearing):** force a mid-pipeline failure → `lifetime_trip_count` back to 0, failed job's
  `charge_refunded_at` set, `trips.status='failed'`, and a same-input retry **runs again** (`created`).
- **C (rollback drill):** flip `ENTITLEMENTS_ENABLED=false`, restart → legacy daily-quota path works,
  no 500s even with a refunded+active row sharing a key (seed that) → flip back.

**Deploy order (for the docs/checklist task, not to run now):** DB-first is REQUIRED; rollback is the
`ENTITLEMENTS_ENABLED=false` flag flip (+ `DAILY_TRIP_QUOTA=5` + landing flag), no image swap.

**Do NOT:** re-run the Codex plan-review loop (it's closed — Rev 6 is final), redesign the ledger,
skip the E2E gate, or touch `zh`/`main`. If you find a genuine design flaw the 6 reviews missed, STOP
and flag it to me rather than silently changing the approach.

**Confirm before you start:** reply with (1) the task you're starting with, (2) confirmation you've
read the plan + the `## Codex review log`, and (3) any seam from the plan that no longer matches the
current tree. Then begin Task 1.
