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

### Step 3 — Review the plan with gstack (REQUIRED, before any implementation)

**REQUIRED SUB-SKILL:** A plan is NOT "ready" until it has passed a gstack review. Run the gstack review skill that matches the plan's nature — this is mandatory, not optional:

- Normal engineering / backend plans → gstack `/plan-eng-review`.
- Scope / product tradeoffs → gstack `/plan-ceo-review`.
- Frontend or visual work → gstack `/plan-design-review`.
- Full automatic multi-lens review → gstack `/autoplan`.

Then run the Codex peer review as the second, adversarial pass — the standard backend loop is **gstack `/plan-eng-review` + Codex** (`/codex:rescue Review this implementation plan and score it: <plan path>`). Pass criteria: overall >= 7.0 and no dimension <= 3.

Fix every blocking finding in the plan file before handoff, and re-run the gstack review after any material change. Do not hand a plan to an implementer (Codex or the `astrail-developer` subagent) that has not passed gstack review.

## Final Diff Review Flow

When an implementation branch returns (from Codex or the `astrail-developer` subagent):

1. Review the branch against the approved plan and `.claude/CLAUDE.md`.
2. **REQUIRED:** Run gstack `/review` on the diff — every backend diff gets a gstack review before approval.
3. For UI, auth, SSE, Mapbox, or full-flow changes, **REQUIRED:** gstack `/qa` evidence — run it yourself or require it from the implementer before approval.
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
