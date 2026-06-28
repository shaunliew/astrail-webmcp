---
name: astrail-task-tracking
description: Use whenever tracking, checking, prioritizing, or updating Astrail tasks — "what should I work on next", sprint/board status, planning a step, creating or activating tickets, or reporting progress. Establishes GitHub Project #1 as the single source of truth (NOT repo issue lists, NOT the CLAUDE.md owners line, NOT memory).
user-invocable: true
allowed-tools:
  - Bash
  - Read
---

# Astrail Task Tracking — GitHub Project is the Source of Truth

## Core Rule

**GitHub Project #1 (owner `MalaysiaKaki`, id `PVT_kwDOEXlARc4BanGs`) is the SINGLE source of truth** for what work exists, who owns it, its status, and its ordering. Always re-read the board **live** before planning, picking the next task, or reporting status.

Do NOT treat any of these as the task list:
- `gh issue list` on `astrail` or `TripCanvas` — repo issues are a subset; most tasks live as **draft cards** with no issue number.
- The `.claude/CLAUDE.md` "Owners" line (`Shaun owns #4,#5,…`) — it uses stale TripCanvas numbering and is not authoritative.
- Issue numbers remembered from an earlier session — they go stale.

## Sources — what the board governs vs what the docs govern

The **board governs task state**; the **docs govern task content**. Use them together — the board tells you *which* task and *where it stands*; the docs tell you *what it means, how to build it, and why*.

| Source | Use it for | Authority |
|---|---|---|
| **GitHub Project #1 board** | what tasks exist, status, owner, phase/ordering, what's active now | **Source of truth for task tracking** |
| **`docs/PRD.md`** | WHAT to build per task — scope, requirements, acceptance criteria, v1 beta boundaries | source of truth for product scope |
| **`.claude/CLAUDE.md`** | HOW to build — stack freeze, the 12 guardrails, build order, SSE/schema contracts, conventions | source of truth for engineering rules |
| **`AGENTS.md`** | entry pointer → CLAUDE.md (Codex reads it first) | pointer only |
| **EMDEE** (`astrail/CONTEXT.md`, `CONSTRAINTS.md`, `DECISIONS LOG.md`, `SPRINTS.md`, per-person sprint logs — via the EMDEE MCP **if configured**) | WHY — strategic context, constraints, decisions, sprint intent | source of truth for strategic intent; **may be unavailable** (no MCP) → fall back to PRD + board |

When the board and a doc disagree on **task status/ordering**, the board wins. When you need to know **what a task means / how to do it / why it matters**, read PRD.md (what) + CLAUDE.md (how) + EMDEE (why).

## Step 1 — Load the board (do this first, every time)

Requires the `project` gh scope. If `gh project` errors with a scope message, run once:
`gh auth refresh -s project` (interactive — the human runs it).

```bash
gh project item-list 1 --owner MalaysiaKaki --format json --limit 60
```

Each item carries: `content.title`, `content.number` (absent for drafts), `content.type` (`Issue` | `DraftIssue`), `repository`, `status` (`Todo` | `In progress` | `Done`), `owner` (`Shaun` | `Zhi Hao` | `Both`), `phase`, `size`, `sprint`.

Field definitions / option ids (needed to update a field):
```bash
gh project field-list 1 --owner MalaysiaKaki --format json
```

Readable snapshot:
```bash
gh project item-list 1 --owner MalaysiaKaki --format json --limit 60 | python3 -c "
import json,sys
for it in json.load(sys.stdin)['items']:
    c=it.get('content',{}); num=c.get('number','—')
    repo=(c.get('repository') or '').split('/')[-1] or 'draft'
    print(f\"{it.get('status','—'):<12} {repo:<11} #{num!s:<4} {it.get('owner','—'):<8} {it.get('phase','—'):<8} {c.get('title') or it.get('title','')}\")"
```

## Step 2 — How to read it

- **Status** = where it is: `Todo → In progress → Done`. The **In progress** item(s) are what's active right now — that's the answer to "what am I working on."
- **Phase** drives ordering. Lower phase first. Backend order: `1.1` (core agent-quality loop: eval, harness, specialist split, latency, Apify extraction, dedupe, feasibility) → `1.2` (hotel) → `1.3` (mem0 memory) → `Phase 2` (beta readiness).
- **Owner**: `Shaun` = backend (FastAPI / Supabase / agents). `Zhi Hao` = frontend (Next.js / Vercel / Mapbox). `Both` = shared contract.
- **Draft cards** (no issue number) = planned work not yet started. **Activate one at a time** into a real GitHub issue when its step begins, and set the card `In progress`.
- The board intentionally tracks items across **both repos** (`astrail` for new code, `TripCanvas` for legacy/frontend). That is expected, not a bug.

## Step 3 — Rules

1. Before answering "what should I do next?", "what's the status?", or producing a plan, **load the board** (Step 1). Never answer from memory or a repo issue list.
2. The board's **Status + Phase are authoritative for task STATE** (what's active, in what order). For task **CONTENT** — what to build, how, and why — read `docs/PRD.md` (what) + `.claude/CLAUDE.md` (how) + EMDEE (why), per the Sources table above.
3. **Keep the board current.** When work starts or finishes, the matching card's Status must change. If another agent owns board mutations in the current workstream (e.g. Codex), propose the change and let them apply it instead of double-writing.
4. **Don't invent issue numbers.** When a task has no issue number, reference it by **title + phase**.
5. When picking the next task: lowest open Phase, your owner lane, `Todo` status, respecting any `In progress` item already claimed.

## Reference

- Live board state + structure is captured in the planner's memory note `astrail-task-tracking`.
- Backend revamp roadmap (board-aligned): `docs/superpowers/plans/2026-06-28-backend-revamp-roadmap.md`.
