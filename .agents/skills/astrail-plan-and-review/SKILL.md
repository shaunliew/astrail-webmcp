---
name: astrail-plan-and-review
description: Plan Astrail implementation work, review an implementation plan, or review a branch/diff before execution or merge. Use for Astrail backend feature planning, plan scoring, adversarial plan review, and final diff review; do not use to implement production code unless the user explicitly changes the role.
---

# Astrail Plan and Review

Act as planner and reviewer. Do not implement code by default.

This workflow is the research, plan, and plan-review front of the mandatory Standard Feature Build Loop in `.claude/docs/BUILD-LOOP.md`. Read that file and `.claude/CLAUDE.md` completely before planning any backend feature.

## Engineering rule

Keep every plan and review feasible-first, minimal, and maintainable:

- Ship the smallest working whole before polishing a part.
- Reuse existing seams. Avoid speculative abstractions, extra fields, dependencies, or configuration.
- Put deferrals behind a concrete trigger.
- Prefer small focused files, explicit code, validated boundaries, and tests that pin behavior.
- Treat over-engineering and unnecessary scope as review findings.

## Required context

1. Load GitHub Project #1 through `$astrail-task-tracking` before deciding what work exists or its state.
2. Read `.claude/CLAUDE.md` and the task-relevant portions of `docs/PRD.md`.
3. Read the EMDEE sprint and strategic documents named by `.claude/CLAUDE.md` when the EMDEE connector is available.
4. State any unavailable required source. Never invent the missing contract.

## Planning flow

### 1. Discovery interview

Use `$superpowers:brainstorming` before writing a plan. Surface:

- why the work matters now;
- desired flow or experience;
- explicit in-scope and out-of-scope boundaries;
- unknowns that would materially change the design.

Ask one or two focused questions at a time. Move on only after the user says the interview is complete or explicitly asks for the plan.

### 2. Write the plan

Use `$superpowers:writing-plans`. Save the plan at `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` unless the user specifies another path.

Include agreed assumptions, non-goals, exact files and symbols, task-sized implementation steps, failing-first tests, live/browser QA where applicable, rollback and deployment-order risk, guardrail mappings, and explicit deferrals with triggers.

### 3. Review the plan before code

Run the gstack plan review appropriate to the work:

- `$plan-eng-review` for normal engineering and backend plans;
- `$plan-ceo-review` for scope or product tradeoffs;
- `$plan-design-review` for frontend or visual plans;
- `$autoplan` for a full automatic multi-lens pass.

Then obtain an independent adversarial review. When Codex is the main agent, prefer a fresh `astrail-reviewer` custom subagent and, when cross-vendor review is required by the build loop, use the available Claude review surface. Do not describe two Codex contexts as cross-vendor review.

**Herdr is the default transport for a cross-model pass.** Check `test "${HERDR_ENV:-}" = 1`; when it passes, dispatch to a named pane hosting the other vendor's agent and read the reply back:

```bash
herdr agent list                                    # read pane_id, agent (the vendor), agent_status
herdr agent rename <pane-id> <name>                 # once — a fresh pane has no name to target
herdr agent prompt <name> "Review this implementation plan and score it: <plan path>" --wait --timeout 1800000
herdr agent read <name> --source recent-unwrapped --lines 200
```

Full contract and safety rules: `.claude/docs/HERDR.md`. When the check fails, say so and use the documented fallback in `.claude/docs/BUILD-LOOP.md`. Herdr changes only the transport, never the cross-vendor rule above — two panes running the same vendor are still not a cross-vendor review, and `herdr agent list` reports each pane's `agent` kind so you can check rather than assume. This applies to a **direct** dispatch only. gstack skills that run their own Codex internally — `/review`, `/autoplan`, every `/plan-*-review` — are invoked as-is; read the `CODEX_MODE:` line they print. `ready` means their Codex already **was** the cross-model pass, so a second dispatch just double-spawns. Any other value means they skipped it and you still owe one — and `under_codex` means the main agent is Codex, so that pass needs a **Claude** pane, not another Codex one. With no differing-vendor pane available, report that cross-model coverage is unavailable rather than recording the plan as reviewed.

Fold every blocking finding into the plan and re-run material reviews. A plan passes only at overall score >= 7.0 with no dimension <= 3.

## Final diff review

1. Review the implementation against the approved plan, `.claude/CLAUDE.md`, and deployment reality.
2. Run `$review` for every non-trivial backend diff.
3. Require `$qa` runtime evidence for UI, auth, SSE, Mapbox, endpoint, or full-flow changes.
4. Lead with findings ordered by severity and cite files and lines.
5. Return `PASS` only when no blocking or material findings remain.

## Handoff

After a plan passes, tell the orchestrator to execute it task-by-task through the Standard Feature Build Loop: one `astrail-developer` implementer per task, one `astrail-reviewer` gate after each task, a final whole-branch reviewer, the required gstack cross-check, live verification, and board/doc updates.

## Guardrails

- Do not write production code unless the user explicitly changes the role.
- Do not violate the frozen stack, SSE contract, auth/RLS/owner checks, evidence requirements, or Pydantic/TypeScript/DB schema parity.
- Do not broaden review fixes into rewrites.
- Do not claim a review ran unless its evidence is present.
