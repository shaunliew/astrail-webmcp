---
name: shiplog
description: "Astrail build-in-public logger. Invoke after shipping a feature, fixing a bug, or hitting a hard problem. Reads EMDEE_DOCS for current context, asks structured questions, then outputs: (1) an EMDEE sprint log entry, (2) an X post draft, (3) an optional Reel script. Works for both Zhi Hao (frontend) and Shaun (backend). Run this whenever Claude Code or Codex detects a meaningful commit."
user-invocable: true
argument-hint: '"one sentence about what just happened" [--type ship|fix|learn|struggle] [--author zhihao|shaun] [--content x|reels|both|none] [--sprint N]'
allowed-tools:
  - Read
  - Write
  - Bash
  - mcp__emdee__get_doc
  - mcp__emdee__append_doc
  - mcp__emdee__append_section
---

# shiplog: Astrail Build Logger + Content Generator

Captures what just happened in the build, logs it to EMDEE, and optionally generates content for @haotobuildzip. Designed to run right after a meaningful commit — takes under 3 minutes end-to-end.

Arguments received: $ARGUMENTS

---

## WHO USES THIS

**Zhi Hao** — frontend, Next.js, marketing, landing page, Reels content, @haotobuildzip
**Shaun** — backend, FastAPI, Supabase, agent pipeline

Both share the same EMDEE vault. Both can invoke this skill. Content generation (`--content`) defaults to on for Zhi Hao, off for Shaun (Shaun's logs feed Zhi Hao's content but Shaun isn't posting).

---

## Step 1: Parse Arguments

Extract:
- **Event**: The one-sentence description. Everything not a flag.
- **--type**: `ship` | `fix` | `learn` | `struggle`
- **--author**: `zhihao` or `shaun`. Defaults to `zhihao`.
- **--content**: `x` | `reels` | `both` | `none`. Defaults to `both` for zhihao, `none` for shaun.
- **--sprint**: Sprint number (e.g. `1`). Defaults to `1`.

If event is missing, ask: *"One sentence — what just happened? Ship, fix, learn, or struggle?"*
If --type is missing, infer from the event description.

---

## Step 2: Load EMDEE Context

Read these docs before generating anything (skip silently if unavailable):

1. `astrail/SPRINTS.md` — current sprint goal, active issues
2. `astrail/CONSTRAINTS.md` — deadlines (19 July cliff is real)
3. `astrail/MARKETING.md` — what claims are honest for the current phase

Extract and hold:
- **Current phase** (1.1 / 1.2 / 1.3 / 1.4)
- **Sprint number** — which sprint log to append to
- **Content rules for current phase** — what can and can't be claimed
- **Credibility anchors** — 2nd place SEA × OpenAI Codex Hackathon, 1,000+ applicants

If EMDEE is unreachable: proceed without it, note it in output.

---

## Step 3: Ask Clarifying Questions (max 3, in one message)

**For `ship`:**
1. What can someone do now that they couldn't before?
2. How long did it take?
3. Anything that almost didn't work?

**For `fix`:**
1. What was broken specifically?
2. What was the root cause?
3. How long before you found it?

**For `learn`:**
1. What assumption turned out to be wrong?
2. What changed as a result?

**For `struggle`:**
1. What exactly is broken? (error, behaviour, component)
2. What have you tried?
3. Blocked or working around it?

Skip questions if the one-liner already answers them.

---

## Step 4: Generate Outputs

### OUTPUT A — EMDEE Sprint Log Entry

Append to `astrail/team/[author]/SPRINT-[N].md` under the `## Log` section.

Format:
```
**[YYYY-MM-DD HH:MM] — [EMOJI] [Short title]**
What: [1-2 sentences. Specific.]
Root cause / reason: [Why. Technical for fix/struggle. Product reasoning for ship.]
Time: [Honest number]
Impact: [What this unblocks]
```

EMOJI: 🚢 ship | 🐛 fix | 💡 learn | 🧱 struggle

After generating, confirm: *"Append this to your Sprint [N] log? (yes/no)"*
If yes: use `mcp__emdee__append_section` to write to the `## Log` section of `astrail/team/[author]/SPRINT-[N].md`.

---

### OUTPUT B — X Post Draft

Only if `--content` includes `x` or `both`.

Voice rules:
- Open with a number, confession, result, or tension — never "Excited to share"
- No hype words: excited, thrilled, blessed, game-changing, revolutionary, transformative
- One idea. Blunt.
- Phase-gate: no user claims, partnership mentions, or revenue in Phase 1.1/1.2
- Max 280 chars for single tweet. Label thread tweets as "1/N", "2/N" etc.

---

### OUTPUT C — Reel Script

Only if `--content` includes `reels` or `both`.

Format:
```
[HOOK — 0-2s]
Spoken: "..."
On screen: [what's visible]
Text overlay: [3-5 words]

[BODY — 2-25s]
Spoken: "..."
B-roll: [achievable suggestions: screen recording, terminal, hands typing]

[CTA — last 3s]
"..."

Caption: [2-3 sentences, keyword-rich, 3-5 hashtags]
```

Target length: 25-35 seconds spoken. Hook must work with zero prior context.

---

## Step 5: Phase Gate Check

Silently check before outputting B and C:

**Phase 1.1/1.2 — remove:**
- "users are loving it" / "our users" / "customers say"
- Travala, insurance partnership mentions (not signed)
- Revenue numbers

If a claim violates phase rules: rewrite and note `[⚠️ Removed: X — not honest for Phase Y yet]`

---

## Step 6: Shaun → Zhi Hao pipeline

If `--author shaun`:
- Generate OUTPUT A only
- End with: *"Zhi Hao — Shaun just logged this. Want me to generate content from it? (yes/no)"*

---

## Quick invoke examples

```
shiplog "wired Vercel frontend to Supabase auth" --type ship --sprint 1
shiplog "fixed SSE stream dropping on mobile" --type fix --author shaun --sprint 1
shiplog "Mapbox route rendering breaks on Safari, 4hrs in" --type struggle
shiplog "shipped landing page" --type ship --content reels
```
