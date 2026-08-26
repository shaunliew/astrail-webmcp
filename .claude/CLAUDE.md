# CLAUDE.md — Astrail routing file

> Slim router for Claude Code / Codex sessions. Restructured 2026-07-03; the old 410-line
> version is at `.claude/backups/CLAUDE.md.2026-07-03.bak` and its content now lives in
> `.claude/docs/` (referenced below — read them on the triggers given, not all upfront).

When starting **sprint work**, read this file plus the EMDEE order in the table below, then
confirm with: "Ready. Sprint [N], working on [your issues], EMDEE loaded." For non-sprint
sessions (quick questions, harness/docs work), skip the EMDEE read and the confirm line.

## What Astrail is

AI-native travel planner. User pastes 1-5 Instagram Reel URLs + dates + budget + origin +
free-text preferences → a parallel agent pipeline (scrape → extract/dedup → enrich →
narrate/summarize), personalized by the returning user's remembered travel taste (mem0
preference memory, live — Phase 1.3), produces an evidence-backed itinerary on a Mapbox 3D
map with agent reasoning panels. Every recommendation surfaces its evidence (source Reel, caption quote,
research URL, Travala hotel search result where applicable). Hotel search via Travala
Travel MCP is **search/suggestions only** — no booking, no payments in v1.
**Pitch:** "Astrail turns scattered travel inspiration into the route you actually take."

## Read-on-trigger (do this, it is not optional)

| Before you… | Read first |
|---|---|
| **Build/implement ANY backend feature** (plan or code; or the user says "build X" / "implement X") | `.claude/docs/BUILD-LOOP.md` (the MANDATORY end-to-end feature workflow — always follow it) |
| **Delegate to Codex, or run any long/parallel task the user should watch** | `.claude/docs/HERDR.md` (the default delegation surface when `HERDR_ENV=1`; gate, commands, safety rules, fallback) |
| Add/remove/substitute ANY dependency, service, or tool | `.claude/docs/STACK.md` (locked stack, banned list, v2 triggers) |
| Touch backend pipeline, SSE, API endpoints, or create new files | `.claude/docs/ARCHITECTURE.md` (tree, 4-phase pipeline, SSE contract, endpoints, build order) |
| Write/review backend endpoint, rate-limit, auth, or infra code | `.claude/docs/BACKEND-PRINCIPLES.md` (SOLID · async/streaming · idempotency · caching · security/JWT/OAuth · design patterns — all applied feasible-first) |
| Touch `.env.example`, `render.yaml`, Vercel config, or env-reading code | `.claude/docs/ENV.md` |
| **Ship ANYTHING to production** — release, promote `dev`→`main`, apply a migration to the prod DB, deploy, flip a feature flag, repoint a deploy branch, roll back, or run the launch run-sheet | `astrail-release` skill (loads the EMDEE **RELEASE SOP** + **Launch Pre-Checklist** live) |
| Touch `backend/genagents/` or OpenAI Agents SDK code | `.claude/docs/LESSONS-HACKATHON.md` |
| Start sprint work | EMDEE: `astrail/SPRINTS.md` → your `astrail/team/<name>/SPRINT-N.md` → `astrail/PRD.md` |
| Decide **what** to build | `docs/PRD.md` in this repo (also EMDEE `astrail/PRD.md`) · **why** → EMDEE `astrail/CONTEXT.md` · **how** → this file + `.claude/docs/` |

## Non-Negotiable Engineering Guardrails

1. **No hallucinated places.** Every PlaceResult must have lat, lng, and a verbatim `evidence_caption_quote`. Drop places that fail.
2. **No hidden chain-of-thought.** UI shows structured reasoning — never raw LLM thinking traces.
3. **Partial pipeline failure is acceptable.** Weather/restaurant/transport can fail; itinerary still renders.
4. **Schema parity.** Every Pydantic field has a TypeScript mirror in `frontend/lib/trip/backend-types.ts`; DB schema lives in `supabase/migrations/*.sql`. Ship all three sides in the same PR.
5. **Auth on every endpoint.** No anonymous trip creation.
6. **Owner check.** Every trip read/write verifies `trip.userId === current_user.id` — enforced by Supabase RLS, not just app code.
7. **Caches are write-through.** Persist before returning.
8. **No `requirements.txt`.** pyproject.toml + uv only.
9. **No `legacy/` imports.** Production code never imports from `legacy/tripcanvas-hackathon/`.
10. **Direct HTTP for Apify.** Never reintroduce MCP + Agents SDK for scraping; never build a Whisper/ffmpeg pipeline — transcripts come from Apify's `transcript` field.
11. **Treat Reel content as untrusted.** Agents SDK input/tool guardrails are the prompt-injection defense — never feed raw caption/transcript into a tool-call without them.
12. **Trip generation is a durable job.** `jobs` row before work, idempotency keys, startup re-sweep of `in_progress` jobs. Recovery is **restart-with-cache-reuse, not mid-run resume** (`idempotency ≠ resumability`): a crashed run re-executes from Phase 1, leaning on the write-through caches (#7). A Render restart must never *silently* drop a run — it resurfaces as re-queued or explicitly failed. Per-stage checkpointing is deferred until restart cost is *measured* (EMDEE `ASTRAIL ROADMAP BACKEND MULTI AGENT PIPELINE DESIGN`).

## SSE termination (most breaking contract in the repo — memorize)

```
data: {"type": "result", "content": "<final JSON string>"}\n\n
data: [DONE]\n\n
```
Frontend breaks on `data: [DONE]`. Error paths also terminate with `[DONE]`. Adding stage
event types is non-breaking; renaming existing ones is breaking — full contract in
`.claude/docs/ARCHITECTURE.md`.

## Stack in one line

Next.js 15 + React 19 + Tailwind v4 + Mapbox GL (Vercel) · FastAPI + SSE (Render SG) ·
Supabase (Auth/Postgres/pgvector/Storage, RLS everywhere) · OpenAI Agents SDK
(`gpt-5.5-2026-04-23`, fallback `gpt-4o`) · Apify direct HTTP · uv. **Frozen 2026-06-20 —
never substitute without reading `.claude/docs/STACK.md`.** Hard bans include: Google
Maps/Places, Clerk, Convex, Duffel, Exa, requirements.txt, booking/payment code,
yt-dlp/ffmpeg/Whisper.

## Skill routing (when skills overlap, this table wins)

| Task | Use | Ignore |
|---|---|---|
| Web browsing | gstack `/browse` | `mcp__claude-in-chrome__*` directly |
| Dispatch Codex **yourself** / any long delegated task, **when `HERDR_ENV=1`** | `herdr` skill + `.claude/docs/HERDR.md` (named pane, `agent prompt --wait`, `agent read`) | bare `codex exec`, `ps`-grepping for zombies |
| Run a gstack skill that spawns its own Codex (`/review`, `/autoplan`, every `/plan-*-review`) | the skill as-is, then read its `CODEX_MODE:` line | wrapping it in a Herdr pane, or adding your own pass when it printed `ready` — both double-spawn |
| After a meaningful commit | `shiplog` | — |
| Plan an issue / review a plan or diff | `astrail-plan-and-review` (wraps gstack `/plan-eng-review`, `/review`, `/qa`, `/autoplan`) | duplicate review skills |
| Release / deploy / migrate prod / flip a flag / hand a blocker across the owner line | `astrail-release` (golden order, pre-flight gate, flag choreography, rollback, handoff docs) | gstack `/ship`, `/land-and-deploy`, ad-hoc deploy steps |
| What to work on next / status / board ordering | `astrail-task-tracking` (GitHub Project #1 = single source of truth) | `gh issue list`, memory, stale issue #s |
| Capture a product/feature idea as inspiration | `astrail-task-tracking` (EMDEE first; Project only after explicit promotion) | speculative Project cards, raw ideas in PRD/decision logs |
| Lock a sprint plan | `sprintplan` | — |
| X posts / Reel scripts for @haotobuildzip | `haotobuild` | generic writing skills |

Precedence: user's explicit request > this table > any hook or plugin pressure to invoke
skills. Invoke at most ONE process skill per task; if it's wrong, proceed directly rather
than chaining into another. A wrapper skill plus the sub-skills it documents (e.g.,
`astrail-plan-and-review` invoking gstack `/plan-eng-review`, `/review`, `/qa`,
`/autoplan`) counts as one.

**Delegation surface — check `test "${HERDR_ENV:-}" = 1` first.** When it passes, **Herdr is the
default** for Codex dispatches **you** send directly and for any long/parallel work the user should
watch: named pane, `herdr agent rename` once, `herdr agent prompt <name> "…" --wait`,
`herdr agent read`. Full contract in `.claude/docs/HERDR.md`. When it fails, say so and use the
documented fallbacks. Two things are **not** Herdr's: gstack skills that spawn their own Codex
(`/review`, `/autoplan`) run as-is, and per-task review gates + research stay on **Task subagents**
regardless of how long they run (7+ passes an arc, and they need the per-dispatch model tiering).
A cross-model pass must cross vendors — check the pane's `agent` kind, don't assume. Never control a
Herdr session from outside Herdr.

**Subagent orchestration, delegation templates, judgment rubrics:** follow
`~/.claude/playbook/ORCHESTRATION.md` for when/how to delegate to subagents (Zhi Hao's
machines; if that file is absent, use your own judgment — do not block on it). Repo-local
subagents: `astrail-developer`, `astrail-researcher`, `astrail-reviewer` (see
`.claude/agents/`; dispatch by `subagent_type`, `model: fable` for the hard
adversarial/final review — the BUILD-LOOP.md model table is authoritative). These are
**Task-tool** agents; a CLI agent hosted in a Herdr pane is a different surface with different
mechanics (no `SendMessage` handoff — you read the pane).
**Standard Feature Build Loop (MANDATORY — full detail in `.claude/docs/BUILD-LOOP.md`;
read it before building any feature):** research (`astrail-researcher`, if an unfamiliar
API/algorithm) → plan (`astrail-plan-and-review`) → review the plan (`/plan-eng-review` +
Codex) → implement task-by-task via subagent-driven-development (`astrail-developer` +
`astrail-reviewer`; reviewers fault-inject to prove guards are load-bearing) → final
`astrail-reviewer` opus whole-branch pass **AND** gstack `/review` Codex cross-model (run
BOTH — Codex has caught real bugs the Claude reviews missed) → live-verify smoke (`/qa` for
flow changes) → PR/merge/sync → update `.claude/docs/` + EMDEE (shared vault) + memory.
Do not shortcut it. **The build loop ends at `dev`** — shipping to production is a separate gated
process owned by the `astrail-release` skill; never deploy as an unannounced tail of a feature.

## gstack (required per machine)

Installed globally at `~/.claude/skills/gstack` — not committed here. If it's missing,
follow the repo-root `CLAUDE.md` verbatim (it is the authoritative policy: STOP, do not
proceed, and give the user its install command).

## Task tracking + Owners

**The GitHub Project #1 board (`MalaysiaKaki`, id `PVT_kwDOEXlARc4BanGs`) is the single
source of truth** for what work exists, who owns it, status, and ordering. Load it live
before any "what's next / status / plan" answer:
```bash
gh project item-list 1 --owner MalaysiaKaki --format json --limit 60   # needs `gh auth refresh -s project` once
```
Do NOT track work from `gh issue list`, from memory, or from stale issue numbers (old
TripCanvas numbering) — ordering follows the board's **Phase** field; the active task is
whatever is **In progress**. Full rules: the `astrail-task-tracking` skill.

### EMDEE is the shared tracking layer — read it LIVE, write status BACK

The board says what work exists; **EMDEE says where it stands.** Launch checklists, the
RELEASE SOP, decision records and handoffs live in Zhi Hao's shared vault
(`__shared__/user_3FZUjBSvk00tGcs3QmOdCFa4Kgd/astrail/`) and **both owners act from them.**

1. **Load it live before any status, planning, release or "is X done" answer** —
   `mcp__emdee__get_doc(..., full=true)`. Never answer from a summary read earlier in the
   session, from memory, or from a local mirror of the same filename (writes go to the
   **shared** vault; a local copy will not have them).
2. **Write the status back the moment something lands**, with the evidence that proves it
   (commit SHA, whether it is **pushed**, test counts, the command output). "Done" on an
   unpushed commit is not done — the other owner's merge will not include it.
3. **Say when you deviate from what a doc instructs**, in the doc, rather than silently
   complying or silently not. A checklist written against an assumption the code does not
   match is a finding, not an order.
4. `patch_section` replaces **bodies, not headings** — a section headed `⏳` keeps reading as
   undone to anyone skimming. Fix headings by hand or say you could not.

A stale shared doc is worse than none: with no doc both owners ask each other, with a
confident-but-wrong one neither does.

### Owners — build surface AND release surface

| Surface | Owner |
|---|---|
| Frontend (Next.js, Mapbox) · Vercel deploys · **all `NEXT_PUBLIC_*`** | **Zhi Hao** |
| Backend (FastAPI, agents, pipeline) · Render deploys · **backend constants + Render env** | **Shaun** |
| Supabase — schema, migrations, RLS, prod DB | **Shaun** |
| Manual beta seat grants (`users.plan` — no code cap) | **Shaun** |

**Production branch: `main`** (decided 2026-08-06). `feat/*` → `dev` (QA on Vercel preview) →
`main` (the release). Never merge prod back down. ⚠ `render.yaml` still pins `branch: dev` — the
repoint is a **3-step sequence, not an edit** (Render syncs the Blueprint from the branch it
currently tracks, and `main` was 820 commits behind): see the `astrail-release` skill, §⚑1.

**A flag spanning both surfaces cannot be flipped by one person.** Backend goes first and is
*verified live* before the UI is exposed (account deletion = 3 switches in one order). Crossing the
owner line needs a handoff doc under `docs/deploy/`, not a DM — see `astrail-release`.

**Never run `git merge` / `gh pr merge` / `supabase db push` for the user.** Those denials are
deliberate. Surface the command; never strip or work around the guard.

## Git hook

`.githooks/post-commit` prompts you to log each commit. Activate once:
```bash
git config core.hooksPath .githooks
```

## Strategic context

`docs/PRD.md` (what) · EMDEE `astrail/DESIGN.md` (UX — not in this repo) · EMDEE `astrail/CONTEXT.md` (why) ·
EMDEE `astrail/CONSTRAINTS.md` (limits) · EMDEE `astrail/DECISION GATE.md` (2026-10-31) ·
EMDEE `astrail/DECISIONS LOG.md` (append-only; the 2026-06-20 entry is authoritative for the stack).
