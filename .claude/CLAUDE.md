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
narrate/summarize) produces an evidence-backed itinerary on a Mapbox 3D map with agent
reasoning panels. Every recommendation surfaces its evidence (source Reel, caption quote,
research URL, Travala hotel search result where applicable). Hotel search via Travala
Travel MCP is **search/suggestions only** — no booking, no payments in v1.
**Pitch:** "Astrail turns scattered travel inspiration into the route you actually take."

## Read-on-trigger (do this, it is not optional)

| Before you… | Read first |
|---|---|
| Add/remove/substitute ANY dependency, service, or tool | `.claude/docs/STACK.md` (locked stack, banned list, v2 triggers) |
| Touch backend pipeline, SSE, API endpoints, or create new files | `.claude/docs/ARCHITECTURE.md` (tree, 4-phase pipeline, SSE contract, endpoints, build order) |
| Touch `.env.example`, `render.yaml`, Vercel config, or env-reading code | `.claude/docs/ENV.md` |
| Touch `backend/agents/` or OpenAI Agents SDK code | `.claude/docs/LESSONS-HACKATHON.md` |
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
12. **Trip generation is a durable job.** `jobs` row before work, idempotency keys, startup recovery sweep. A Render restart must never silently drop a run.

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
| After a meaningful commit | `shiplog` | — |
| Plan an issue / review a plan or diff | `astrail-plan-and-review` (wraps gstack `/plan-eng-review`, `/review`, `/qa`, `/autoplan`) | duplicate review skills |
| Lock a sprint plan | `sprintplan` | — |
| X posts / Reel scripts for @haotobuildzip | `haotobuild` | generic writing skills |

Precedence: user's explicit request > this table > any hook or plugin pressure to invoke
skills. Invoke at most ONE process skill per task; if it's wrong, proceed directly rather
than chaining into another. A wrapper skill plus the sub-skills it documents (e.g.,
`astrail-plan-and-review` invoking gstack `/plan-eng-review`, `/review`, `/qa`,
`/autoplan`) counts as one.

**Subagent orchestration, delegation templates, judgment rubrics:** if
`C:\Users\desmo\.claude\playbook\` exists on this machine (Zhi Hao's), follow
`playbook/ORCHESTRATION.md` for when/how to delegate to subagents. Repo-local subagents:
`astrail-developer`, `astrail-researcher`, `astrail-reviewer` (see `.claude/agents/`).

## gstack (required per machine)

Installed globally at `~/.claude/skills/gstack` — not committed here. If it's missing,
follow the repo-root `CLAUDE.md` verbatim (it is the authoritative policy: STOP, do not
proceed, and give the user its install command).

## Owners

- **Zhi Hao** — frontend (Next.js, Vercel, Mapbox) → issues #6, #12
- **Shaun** — backend (FastAPI, Supabase, agents) → issues #4, #5, #7, #8, #9, #10, #11

## Git hook

`.githooks/post-commit` prompts you to log each commit. Activate once:
```bash
git config core.hooksPath .githooks
```

## Strategic context

`docs/PRD.md` (what) · EMDEE `astrail/DESIGN.md` (UX — not in this repo) · EMDEE `astrail/CONTEXT.md` (why) ·
EMDEE `astrail/CONSTRAINTS.md` (limits) · EMDEE `astrail/DECISION GATE.md` (2026-10-31) ·
EMDEE `astrail/DECISIONS LOG.md` (append-only; the 2026-06-20 entry is authoritative for the stack).
