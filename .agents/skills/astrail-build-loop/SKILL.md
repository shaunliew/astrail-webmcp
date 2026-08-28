---
name: astrail-build-loop
description: The mandatory loop for building anything in Astrail — plan with a subagent, review the plan with Codex through Herdr, implement with the astrail-developer subagent, review with astrail-reviewer AND Codex, verify. Use for every feature, fix, and refactor. Claude does not implement directly; if you are about to write production code yourself, you have already left the loop.
---

# The build loop — every stage has an owner, and it is not you

> **Why this exists.** On 2026-08-28 the loop was documented in `.claude/docs/BUILD-LOOP.md`, in
> `astrail-plan-and-review`, and in the CLAUDE.md routing table — and the orchestrator still
> planned, implemented and reviewed a whole feature itself. Three separate documents did not stop
> it, because each stage individually felt faster to just do. This skill exists to remove the
> per-stage judgement call. **If you are typing production code into an Edit or a heredoc, stop.**

## The five stages and their owners

| Stage | Owner | Never |
|---|---|---|
| 1 · Research an unfamiliar API, algorithm or seam | `astrail-researcher` subagent, **then Codex `checker` verifies its repo claims** | guessing from memory; building on unverified file:line claims |
| 2 · Write the plan | `astrail-plan-and-review` skill, or a Plan subagent | planning inline while editing |
| 3 · **Review the plan** | **Codex via `astrail-codex`** (Herdr pane) | building on an unreviewed plan |
| 4 · **Implement, task by task** | **`astrail-developer` subagent** | **Claude writing the code** |
| 5 · Review the diff | `astrail-reviewer` subagent **AND** Codex via `astrail-codex` | one of the two |

Stages 3 and 5 both go through Herdr. Stage 4 is the one that keeps getting skipped.

## Stage 4 — dispatching the implementer

One task per dispatch. The task must be small enough to state its acceptance in a sentence.

```
Agent(subagent_type: "astrail-developer", prompt: …)
```

The prompt carries, every time:

- **The plan file path** and which numbered task this is.
- **The exact files** it may touch. Anything outside is a stop, not a judgement call.
- **The acceptance test** — the command, and what its output must say.
- **The invariant it must not break**, named. Not "be careful".
- **TDD**: the failing test first, then the code. A test written after the code that passes on the
  first run has proved nothing.

Then verify its work yourself before dispatching the next task: run the suite, read the diff. A
subagent reporting success is a claim, not evidence.

## What Claude does in this loop

Orchestrate, verify, and decide. Concretely: write the plan file, dispatch, read the diffs, run the
suites, hold the RUNLOG, judge the findings, and decide what to cut. Also the small things a
dispatch would cost more than it saves — a one-line copy fix, a comment, a doc.

The line: **if it needs a test, it needs the implementer.**

## Fact-check against the source, not against memory

Two live doc channels. Use them before asserting anything about either platform — both have moved
under us already this sprint.

**WebMCP / ChatGPT site tools** — `mcp__openaiDeveloperDocs__*`. Prefer `fetch_openai_doc` on
`https://learn.chatgpt.com/docs/webmcp` over `search_openai_docs`, which returns tens of KB of
unrelated changelog. That page is the authority on what the built-in browser actually supports, and
it has already corrected us: tools in iframes are **not** discovered, the declarative HTML-attribute
API is **not** supported, only GPT-5.6 Sol/Terra (Luna has WebMCP disabled), nothing in Enterprise
or Edu workspaces, and OpenAI treats a site's own tool definitions and results as **untrusted
content** with a safety review before every invocation.

It also names our use case as the canonical example: *"A travel planner that lets the agent compare
options and update an itinerary while you inspect the map."*

**Mapbox** — no MCP server is mounted in this session. The `mapbox-*` entries are **skills**, not
servers, so a claim about Mapbox behaviour must come from a skill, the repo, or a live probe. Do not
invent an MCP call that does not exist.

**The W3C spec** (`https://webmachinelearning.github.io/webmcp/`) is the authority on annotations —
the ChatGPT page shows `readOnlyHint` in an example but does not enumerate the set. Attribute the
claim to whichever source you actually read.

## `/qa` is waived for the WebMCP sprint (until 2026-09-03)

Live browser verification is off for this sprint by the owner's decision. Two consequences to hold
in mind rather than forget:

- **jsdom has no layout engine.** No z-index, no stacking contexts, no paint. A passing test proves
  an element is in the DOM, never that a human can see it. When a change is visual — a toast, an
  overlay, a z-index, anything that could be covered — say "the test asserts it renders" and not
  "verified", because the second is not true.
- A subagent that flags "this needs a human eye" is **right**, and the flag belongs in the RUNLOG
  even though nobody will act on it this sprint. It is the list of what was never actually seen.

After the deadline, restore it: `/qa` for flow changes is part of the standard loop.

## Recovering when something fails

The overnight rule is **stop on a gate failure**, and that stands: a failing gate means an assumption
was wrong, and fixing forward on a wrong assumption compounds it. But distinguish the two cases,
because treating everything as fatal wastes a night as surely as ignoring it.

**Recoverable — fix and continue, no human needed:**
- a test the implementer wrote is wrong (its harness, not the behaviour) — verify against the code,
  correct the test, say so in the RUNLOG
- a shell or tooling slip: a bad heredoc, a stale path, a wrong flag
- a review finding — that is the loop working; dispatch it back to the implementer
- a task touching a file another task owns — re-scope the allowlist and re-dispatch

**Stop and write it down — a human decides:**
- a gate that fails for a reason the plan did not anticipate
- two reviews disagreeing on whether something is a defect
- anything needing a push, a deploy, a migration, real credit, or an approval dialog
- a fix that would make an existing test fail, where you cannot prove the test was wrong

**Always leave the tree clean or stashed.** A morning that starts with a half-edited file is worse
than one that starts with an honest "stopped here, and why".

## Running items in parallel

Two implementers at once is worth real wall-clock, and the gate is **file overlap, not tooling**.
Check it before you plan the parallelism, not after a merge conflict.

```bash
# Do the two tasks touch the same files? If yes, they are sequential. No exceptions.
git diff --name-only <base>...HEAD          # what is already in flight
```

**Same tree** when the tasks are file-disjoint and short — two `astrail-developer` dispatches with
non-overlapping allowlists, which is what the allowlist is for. Verify disjointness yourself; do
not take the plan's word for it.

**A worktree** when a task is long, touches many files, or you want to keep `main`-tree tests green
while it runs:

```bash
git worktree add ../astrail-<item> feat/webmcp   # or dispatch with isolation: "worktree"
```

`.claude/settings.local.json` symlinks `frontend/node_modules` and `backend/.venv` into new trees —
without that a worktree of this repo needs a 685 MB install before it can run a single test. Check
that setting still exists before promising a parallel run.

**What never parallelizes here:** anything touching `SavedReelsFlow.tsx` or the `webmcp/` layer.
Nearly every item in `docs/webmcp/AGENT-FIRST.md` lands there, so in practice the headline items are
sequential and the parallel budget goes to the disjoint edges — a new route, a tool contract, a doc.

**A shared tree makes every test count a lie.** Two implementers in one tree means the suite total
includes both their work, so neither can measure its own. This happened twice in one night — briefs
said 997 and 1047, the real baselines were 999 and 1062, and each implementer caught it and told me.
Consequences to hold:

- **Never quote a whole-tree number as one task's result.** Ask for the focused suites the task
  actually touched, and treat the total as a smoke test.
- **Give the baseline as "whatever the tree reports when you start"**, not a number from your own
  earlier run — yours is already stale.
- An implementer that corrects your baseline is doing its job. Take the correction.
- **This is the real argument for a worktree**, more than merge conflicts: an isolated tree is the
  only place a task can measure itself honestly.

**Merging back:** rebase the worktree branch on `feat/webmcp` and run the FULL suite in the main
tree before removing it. A worktree that passed in isolation has proved nothing about the merge.
`git worktree remove` when done — a stale worktree holding a branch reference is a confusing thing
to find in the morning.

## The findings loop

A review returns findings. Do NOT fix them yourself for the same reason you did not write the code.
Group them into tasks and dispatch each to `astrail-developer` with the finding quoted verbatim,
including the reviewer's file:line and its failure scenario. Then re-review.

Two rounds minimum on anything non-trivial. This branch has a documented history of a fix being
worse than the finding it closed — round 2 exists to catch that, and it has, repeatedly.

## The one question that keeps exposing hollow work

Ask it of every review, every time:

> **Are the new tests load-bearing, or would they pass against the old code?**

It has caught: tests asserting a DB shape that does not exist; green tests written by the same
author in the same hour that constrained nothing; a fault-injection test whose injected fault never
reached the handler it claimed to exercise.

## Overnight rules

`implement → verify → append to docs/webmcp/RUNLOG.md → commit locally → next task`.

**On any gate failure: STOP.** Write the failure and its output to the RUNLOG, leave the tree clean,
and do not attempt the next task. Never fix forward unattended — a failing gate means an assumption
was wrong, and that needs a human.

Never unattended, no exceptions: `git push` to a shared branch · `git merge` · `gh pr merge` ·
`supabase db push` · any deploy or production config change · any real generation run (it spends
Apify and OpenAI credit) · answering an agent's approval dialog.

Also: stop the local backend before leaving it overnight. `_reap_loop` runs every 120s against the
shared Supabase and is not flag-gated, so an idle local backend can adopt and re-execute someone
else's stuck job and spend real credit while nobody is watching.

## Red flags — you have left the loop

| Thought | Reality |
|---|---|
| "This is a two-line change, I'll just do it" | Two lines that need a test need the implementer |
| "Dispatching costs more than doing it" | That is the exact reasoning that skipped the loop three times |
| "I already know what the plan is" | Then writing it down costs nothing and Codex can attack it |
| "The tests pass, it's fine" | Tests you wrote after the code prove the code does what you wrote |
| "I'll review it myself, I wrote it" | You reviewed it while writing it. That is not a review |
| "Codex already reviewed the plan" | The plan is not the diff. Stage 5 is separate |
