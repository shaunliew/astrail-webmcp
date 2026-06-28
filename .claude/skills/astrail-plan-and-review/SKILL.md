---
name: astrail-plan-and-review
description: Use when planning Astrail implementation work, reviewing an implementation plan, or reviewing a branch/diff before Codex execution or merge.
---

# Astrail Plan And Review

## Core Rule

Act as planner and reviewer. Do not implement code by default.

Use this skill to turn an Astrail issue or request into an executable markdown plan, critique plans before implementation, and review final diffs after Codex has executed the plan.

## Required Context

1. Read `.claude/CLAUDE.md` first and follow its session-start instructions.
2. Read the task-relevant parts of `PRD.md`, `DESIGN.md`, and EMDEE sprint docs named by `.claude/CLAUDE.md`.
3. If a required document or EMDEE source is unavailable, state the missing source in the plan or review. Do not invent the missing contract.

## Planning Flow

### Step 1 — Discovery interview (REQUIRED, do this before anything else)

**REQUIRED SUB-SKILL:** Use `superpowers:brainstorming` to run an interview with the user before writing any plan.

Do not assume you understand what they want. Even if the request seems clear, hidden intentions, preferences, and constraints almost always come out in the interview that would change the plan. Skipping this step produces plans full of assumptions the user never agreed to.

The interview must surface:
- **The "why"** — what problem does this solve for the user right now?
- **The look and feel** — any references, vibes, flows they have in mind?
- **Scope boundaries** — what is explicitly in and explicitly out?
- **Unknowns** — what do you not know that would change the design?

Ask focused questions one or two at a time. Do not dump a list of 10 questions. Listen to the answer before asking the next one. Keep going until you could write the plan without guessing anything material.

Only move to Step 2 when the user says they are done or explicitly asks you to write the plan.

### Step 2 — Write the plan

**REQUIRED SUB-SKILL:** Use `superpowers:writing-plans`.

Write the plan based on what the user said in the interview — not on what you assumed before it. Decisions made during the interview override your prior reading of PRD/DESIGN/EMDEE.

Save the plan to `docs/superpowers/plans/YYYY-MM-DD-<issue-or-feature>.md` unless the user gives a different path.

Include exact assumptions (reference the interview), non-goals, files likely touched, tests, browser QA, and rollback risk. Map every task to Astrail contracts from `.claude/CLAUDE.md`, `PRD.md`, `DESIGN.md`, or EMDEE. Keep tasks small enough for Codex to execute task-by-task.

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
