# Herdr — the default delegation surface

> **Read before dispatching a cross-model review or any long-running delegated task.** Herdr is a
> terminal multiplexer that hosts real CLI agents (codex, claude, gemini, …) in named, persistent,
> user-visible panes. Where it is available it replaces the fragile `codex exec` invocation
> documented in `BUILD-LOOP.md` and removes two whole classes of failure that cost real time.
> Adopted 2026-08-26.

## The conditional — check it first, every time

Herdr is the **default where it is available**, not a hard requirement. This repo is also worked
from sessions that have no Herdr (the other owner's machine, CI, a plain terminal), so every
instruction below is gated:

```bash
test "${HERDR_ENV:-}" = 1
```

- **Passes** → use the Herdr path. The `herdr` binary in `PATH` talks to the current session.
- **Fails** → say so plainly, then fall back to the documented non-Herdr path
  (`BUILD-LOOP.md` §"Calling Codex without hanging" for Codex; the Task tool for subagents).
  **Never** inspect or control a Herdr session from outside Herdr.

Caller context is injected into every managed pane — prefer it over guessing IDs:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

## What belongs on which surface

Herdr did **not** replace subagents wholesale, and the split is deliberate.

**Read the rows in order — the first match wins.** A long research task matches both "long work"
and "research"; research is the more specific row, so it stays a Task subagent.

| Work | Surface | Why |
|---|---|---|
| A gstack skill that runs Codex itself — `/review`, `/autoplan`, **and every `/plan-*-review`** | **Run the skill as-is, then read its `CODEX_MODE:` line** | Each spawns and manages its own `codex` process behind an `under_codex` guard. Herdr cannot transport it, and dispatching your own pass alongside a `CODEX_MODE: ready` run double-spawns for one opinion |
| Per-task review gates (BUILD-LOOP step 4), research (step 1) | **Task subagent** — *regardless of how long they run or how watchable they'd be* | 7+ passes per arc, so panes would sprawl; and the fable/opus/sonnet tiering in BUILD-LOOP's model table is expressed per-dispatch, which the Task tool supports and a pane does not |
| **Direct differing-vendor dispatch** you send yourself — only when the gstack skill's `CODEX_MODE:` says it skipped its own pass | **Herdr pane** | Kills the `codex exec` stdin hang and the zombie-process trap outright; the user can watch the review happen. "Differing-vendor", not "Codex": under `under_codex` the asker *is* Codex, so this pass must target a **Claude** pane |
| Other long or parallel work the user should see | **Herdr pane** | Persistent, interruptible, survives the turn; you read it back instead of hoping a report arrives |
| Ordinary shell commands | **Bash tool** | A pane is for something that needs watching, not for `pytest` |

**Herdr changes the transport, never the review rule.** A cross-model pass must cross *vendors*: two
panes running the same vendor as the orchestrator are not a cross-model review. If the main agent is
Claude, target a Codex/Gemini pane; if the main agent is Codex, target a Claude pane. Check what the
pane actually runs (`herdr agent list` reports its `agent` kind) before calling it cross-model.

**The `CODEX_MODE` rule — when you owe a pass and when you don't.** gstack's review skills print
`CODEX_MODE:` after probing:

- `ready` → that skill's own Codex **is** the cross-model pass. Dispatching your own on top is a
  double spawn. Don't.
- `under_codex` / `not_installed` / `not_authed` / `model_unusable` / `disabled` → the skill
  **skipped** its cross-model pass. You owe one. `under_codex` specifically means the main agent is
  Codex, so the pass you supply needs a **Claude** pane.
- Nothing of a differing vendor available → **report that cross-model coverage is unavailable.**
  Never record the step as done on same-vendor review; a gap you have named is recoverable, one you
  have papered over is not.

Do not create a workspace, tab, worktree, or different cwd unless the user asks for that topology.
Default to a sibling pane in the current tab, in the current working directory.

## Talking to an agent already in a pane

This is the common case — the user opened a split and started an agent in it.

```bash
herdr agent list                       # read pane_id, agent (the VENDOR), agent_status from the JSON
herdr agent rename <pane-id> <name>    # stable name, once; must match [a-z][a-z0-9_-]{0,31}
herdr agent prompt <name> "<prompt>" --wait --timeout 180000
herdr agent read <name> --source recent-unwrapped --lines 120
```

Pick `<name>` for the **role** (`reviewer`, `planner`), not the vendor, and choose the pane by the
`agent` field in `agent list`. Hardcoding `codex` reads fine from a Claude session and silently
produces a same-vendor "cross-model" review from a Codex one.

- Targets accept a **unique live agent name** or the **pane ID** hosting it — never a terminal ID
  or a bare kind label.
- `--wait` waits for the first settled `idle`, `done`, or `blocked`. That is enough for normal work;
  do not also pass `--until` with those same states.
- `agent prompt` **refuses** an agent sitting at an approval dialog, returning `agent_blocked`
  before sending anything. Inspect with `agent get` / `agent read` and **ask the user** before
  answering an approval UI on their behalf.
- `unknown` status does not mean finished. `idle` means ready for input; `done` is the same state
  after unseen background work completed.

**Verify the channel before you trust it.** Ask for something you already know the answer to —
a constant, a file:line — and check the reply against it. A pane that echoes your prompt back, or
an agent that answers from memory instead of reading the repo, is not a working channel.

## Starting a new agent

`agent start` needs an **existing, available shell pane** — at an interactive prompt, no foreground
command. It never creates or moves layout, so split first:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"                              # wide → split right; tall → split down
herdr pane split --current --direction right --cwd "$PWD" --no-focus   # read .result.pane.pane_id
herdr agent start reviewer --kind codex --pane <returned-pane-id>
```

Pass native agent flags only after `--`. Keep `--no-focus` for background work: the user's focus
stays in their pane unless they asked to switch. Startup defaults to a 30s timeout; a blocked
startup returns `agent_not_ready` but the name stays usable for `read` and `send-keys`.

## Running a command where the user can watch it

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr pane run <pane-id> "uv run pytest -q"
herdr pane wait-output <pane-id> --match "passed" --timeout 300000
herdr pane read <pane-id> --source recent-unwrapped --lines 120
```

`pane wait-output` searches the current snapshot immediately, so text already on screen matches.

> **`pane run` vs `send-text`.** `pane run <pane_id> <command>` sends the command text and Enter
> **atomically**; `send-text` sends text without the Enter. Prefer `pane run` for commands. (Both
> are in `herdr pane`'s help — read the whole listing, it is longer than one screen.)

## Reading output — and the one case where `--lines` cannot help

Use `recent-unwrapped` for logs and transcripts (soft wraps joined). Use `--format ansi` only when
colour is the evidence.

If raising `--lines` stops revealing more of a **completed** response, the agent is rendering on the
terminal's alternate screen; those rows never enter Herdr's scrollback and no line count recovers
them. Only then, ask the agent to write its full response as Markdown to a temp path and reply with
the path alone, and read the file. This is a fallback — do not ask for file output up front.

## What this replaces, and why it is worth the change

Both of these are real incidents recorded in `BUILD-LOOP.md`, and both are Herdr-proof:

1. **`codex exec` hangs on a non-TTY stdin** — prints `Reading additional input from stdin...` and
   waits forever; cost ~20 min twice. The fix was `< /dev/null` plus file redirection plus
   remembering that exit code 0 does not mean it ran. `herdr agent prompt --wait` has no stdin, no
   redirect, and a real lifecycle state to wait on.
2. **Zombie-checking with `ps aux | grep -i codex`** counts the user's ChatGPT.app helpers and the
   VS Code extension — it once reported "20 codex processes" against zero leftovers, and acting on
   it would have killed the user's editor. `herdr agent list` reports only Herdr-managed agents.

A third, softer win: BUILD-LOOP §"Subagent result delivery" exists because a background Task
subagent's plain output is not delivered to the orchestrator. A Herdr agent has no such handoff —
you read the pane.

## Safety rules

- `--no-focus` for background work; never steal the user's focus uninvited.
- Target `--current`, an explicit pane ID, or a unique name. Never rely on another client's focused
  pane.
- Parse IDs out of the JSON responses. Do not infer them from sidebar order or from examples here.
- **Do not close workspaces, tabs, panes, or sessions you did not create** unless asked.
- Never run `herdr server stop` from an active session, and never kill the main Herdr process.
- A pane ID changes after `pane move` — continue with `.result.move_result.pane.pane_id` or the
  agent's name, not the old ID.
- The usual repo rules still bind an agent in a pane: no `git merge` / `gh pr merge` /
  `supabase db push` on the user's behalf, and commit/push/PR only when asked.
