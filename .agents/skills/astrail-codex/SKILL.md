---
name: astrail-codex
description: Send any Codex work — code review, plan review, product critique, a second opinion, an investigation — through a Herdr pane and read the answer back. Use whenever the user says "ask Codex", "get Codex to review", "cross-check with Codex", or a workflow calls for a cross-vendor pass. Replaces bare `codex exec` and replaces gstack /review for this repo.
---

# Codex, through Herdr — always

Every Codex dispatch in this repo goes to a **named Herdr pane**. Not `codex exec`. Not gstack
`/review`. The pane is the contract: the user can watch the review happen, the process survives the
turn, and there is no stdin hang and no zombie to hunt.

> **Why this skill exists.** On 2026-08-28 a Codex review was dispatched with `codex exec` and then
> with gstack `/review`, both of which spawn Codex outside Herdr where the user cannot see it. The
> guidance existed in `.claude/docs/HERDR.md` and in `astrail-plan-and-review`; it was still walked
> past, because reaching for `/review` felt like the review-shaped thing to do. So: one skill, one
> answer, no judgement call at the moment of dispatch.

## The gate — check it, every time

```bash
test "${HERDR_ENV:-}" = 1
```

**Fails** → say so plainly in your reply, then fall back to `.claude/docs/BUILD-LOOP.md`
§"Calling Codex without hanging". Never control a Herdr session from outside Herdr.

## The sequence

```bash
herdr agent list          # read pane_id, name, and `agent` (the VENDOR), agent_status
```

Reuse a live pane whose `agent` is `codex` before creating anything. Only if none exists:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"                              # wide → right, tall → down
herdr pane split --current --direction right --cwd "$PWD" --no-focus   # take .result.pane.pane_id
herdr agent start reviewer --kind codex --pane <that-pane-id>
```

Then dispatch. Long prompts go through a quoted heredoc into a shell variable — never inline, or the
shell eats the backticks and quotes:

```bash
read -r -d '' P <<'EOF' || true
<the prompt>
EOF
herdr agent prompt reviewer "$P" --wait --timeout 900000
```

## Reading the answer back — the part that bites

Four things learned the hard way; none of them are obvious from the CLI help.

1. **`--wait` can return instantly with `idle`.** It waits for the first *settled* state, and a pane
   that was already idle satisfies that immediately. Returning does not mean the work is done.
   Follow with `herdr agent wait <name> --timeout <ms>`, then confirm with `herdr agent get <name>`.

2. **Read in slices — the reply is longer than one screen.**
   ```bash
   herdr agent read reviewer --source recent-unwrapped --lines 400 | tail -190   # the findings
   herdr agent read reviewer --source recent-unwrapped --lines 400 | sed -n '160,215p'  # the top
   ```
   `recent-unwrapped` joins soft wraps; `visible` truncates to the viewport and will silently cost
   you the highest-severity findings, which print first.

3. **If a bigger `--lines` reveals nothing more**, the agent is on the terminal's alternate screen
   and those rows never entered scrollback. Ask it to write the full reply as Markdown to a temp
   path and reply with only that path, then read the file. Fallback only — not the first ask.

4. **Verify the channel before trusting the answer.** Put a checkable fact in the prompt: *"quote
   `backend/pipeline/runner.py` line 528 verbatim so I know you read the repo."* An agent answering
   from your prompt instead of the code produces confident, groundless findings.

## Cross-vendor means cross-VENDOR

A cross-model pass must cross vendors. This session's main agent is Claude, so the pane must be
Codex — check the `agent` field in `agent list` rather than trusting the pane's name. If the main
agent is ever Codex, the pass needs a **Claude** pane. With no differing-vendor pane available,
**report that cross-model coverage is unavailable**. Never record the step as done on a same-vendor
review: a gap you have named is recoverable, one you have papered over is not.

## Writing the prompt

Codex earns its keep when the prompt is adversarial and specific. A vague "review this" returns
vague praise. The two-round pattern that has actually found bugs in this repo:

- **Round 1** — state what changed, state the invariant you *claim* holds, and name 3-5 specific
  attacks. Include the measured evidence that motivated the change. Ask it to say plainly when a
  category is clean, so silence is not mistaken for approval.
- **Round 2** — after fixing, dispatch again: "I applied your findings, here is what I changed,
  verify the fixes and tell me if any fix is worse than the bug." This branch has a documented
  history of fixes introducing worse defects than the finding; round 2 is not optional ceremony.

Always ask: *"are the new tests load-bearing, or would they pass against the old code?"* That single
question has repeatedly exposed tests that constrained nothing.

## Blocked panes

`agent prompt` refuses an agent sitting at an approval dialog and returns `agent_blocked` before
sending anything. Inspect with `agent get` / `agent read` and **ask the user**. Never answer an
approval UI on their behalf.

## What does NOT belong here

| Work | Surface |
|---|---|
| Per-task review gates, research | **Task subagents** (`astrail-researcher`, `astrail-reviewer`) — they need per-dispatch model tiering a pane cannot express |
| Ordinary shell commands | **Bash tool** — a pane is for something that needs watching, not for `pytest` |
| gstack skills that run their own Codex | Not used in this repo for Codex work. Use this skill instead |

Full CLI contract and safety rules: `.claude/docs/HERDR.md`.
