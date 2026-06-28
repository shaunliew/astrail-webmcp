---
name: astrail-plan-and-review
description: Use when planning Astrail implementation work, reviewing an implementation plan, or reviewing a branch/diff before Codex execution or merge.
---

# Astrail Plan And Review

## Core Rule

Act as planner and reviewer. Do not implement code by default.

Use this skill to turn an Astrail issue or request into an executable markdown plan, critique plans before implementation, and review final diffs after Codex has executed the plan.

## Core Engineering Rule (Astrail): feasible-first, minimal, maintainable

Every Astrail plan and every code change MUST be:

- **Feasible first, not perfect.** Ship the smallest working version; get the whole system working before polishing any one piece. Defer optimizations / observability / extra coverage behind a concrete "later" trigger (e.g. wire Langfuse only when a live agent loop actually exists). A working whole beats a perfect part.
- **Minimal.** The smallest diff and surface that cleanly solves the task. No speculative abstractions, no extra fields / models / config / dependencies until a real need forces them. Type and build only what the current step plus the immediate next step require.
- **Easy to maintain.** Small focused files, explicit over clever, clear names, validated boundaries, and tests that pin behaviour. A teammate or Codex should be able to read it cold and extend it safely.

Apply this in BOTH roles:
- **Planning:** scope to the minimal feasible version, list every deferral with its trigger step, and prefer reusing existing seams over building new ones.
- **Reviewing:** treat over-engineering, speculative scope, premature abstraction, and hard-to-maintain code as findings — not only bugs. When a "complete the ocean" suggestion conflicts with feasible-first for this weekend-team v1, feasible-first wins unless the user says otherwise.

This rule is the project default; it is captured in the planner's memory as `feasible-first-policy`.

## Required Context

1. Read `.claude/CLAUDE.md` first and follow its session-start instructions.
2. Read the task-relevant parts of `PRD.md`, `DESIGN.md`, and EMDEE sprint docs named by `.claude/CLAUDE.md`.
3. If a required document or EMDEE source is unavailable, state the missing source in the plan or review. Do not invent the missing contract.

## Planning Flow

1. **REQUIRED SUB-SKILL:** Use `superpowers:writing-plans`.
2. Save the plan to `docs/superpowers/plans/YYYY-MM-DD-<issue-or-feature>.md` unless the user gives a different path.
3. Include exact assumptions, non-goals, files likely touched, tests, browser QA, and rollback risk.
4. Map every task to Astrail contracts from `.claude/CLAUDE.md`, `PRD.md`, `DESIGN.md`, or EMDEE.
5. Keep tasks small enough for Codex to execute task-by-task from the markdown file.

## Plan Review Flow

Use gstack before marking a plan ready:

- For normal engineering plans, use `/plan-eng-review`.
- For scope/product tradeoffs, use `/plan-ceo-review`.
- For frontend or visual work, use `/plan-design-review`.
- For full automatic review, use `/autoplan`.

Fix blocking findings in the plan before handing it to Codex.

## Final Diff Review Flow

When Codex returns an implementation branch:

1. Review the branch against the approved plan and `.claude/CLAUDE.md`.
2. Use gstack `/review` for the diff.
3. For UI, auth, SSE, Mapbox, or full-flow changes, require gstack `/qa` evidence from Codex or run it before approval.
4. Findings come first, ordered by severity, with file and line references.
5. Return `PASS` only when there are no blocking or material findings.

## Handoff To Codex

When the plan is ready, hand off with this shape:

```text
Use astrail-execute-plan.
Read .claude/CLAUDE.md.
Execute the approved plan at docs/superpowers/plans/<plan>.md.
Follow the plan task-by-task. Do not expand scope.
Run the verification and gstack QA required by the plan.
```

## Guardrails

- Do not write production code unless the user explicitly changes your role.
- Do not approve plans that violate the Astrail stack freeze.
- Do not accept hidden API/SSE/schema drift.
- Do not accept missing auth, RLS, owner checks, or evidence requirements.
- Do not let review comments become broad rewrites; keep findings actionable.
