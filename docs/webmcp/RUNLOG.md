# WebMCP build — run log

Append-only. One entry per task: what ran, the gate, the exit code, the evidence.
A task with no recorded gate did not pass. On any gate failure the run STOPS.

**Never unattended:** `git push` · `git merge` · `gh pr merge` · `supabase db push` ·
any Render/Vercel deploy · any production config change · any real generation run
(Apify + OpenAI cost money) · answering an agent approval dialog.

---

## Batch 1 — Day 1 foundations (started 2026-08-27 00:51)

| # | Task | Gate | Result |
|---|---|---|---|
| 1.1 | Branch `feat/webmcp` off `dev` | `git branch --show-current` | ✅ `feat/webmcp` |
| 1.2 | MIT `LICENSE` (unmodified, for GitHub detection) | 21 lines, standard MIT text | ✅ — **T4: confirm the About badge renders once the repo is public** |
| 1.3 | `npm i use-webmcp-tool@0.2.0` | present in package.json | ✅ `^0.2.0`, zero runtime deps |
| 1.4 | `lib/webmcp/fit.ts` — envelope budget + block-boundary degradation | `tsc --noEmit` | ✅ typechecks |
| 1.5 | `fit.ts` tests — envelope budget, block-boundary degradation | `npx vitest run lib/webmcp/__tests__/fit.test.ts` | ✅ **10/10**. One assertion of mine was wrong (a newline costs 2 escaped chars, not 1) — implementation was right, test corrected |
| 1.6 | `resolve.ts` — pin-number / name → TripPlace, candidates on ambiguity | typecheck | ✅ clean |
| 1.7 | `resolve.ts` tests against the real `TOKYO_TRIP` fixture | `npx vitest run lib/webmcp/__tests__/` | ✅ **21/21** (10 fit + 11 resolve). Covers the dangerous case: "Shibuya" matches 2 stops → returns candidates, never guesses |
| 1.8 | `format.ts` — compact trip/itinerary/list renderings, legend kept in tool descriptions | typecheck | ✅ clean |
| 1.9 | `format.ts` tests incl. the real budget gate | `npx vitest run lib/webmcp/__tests__/` | ✅ **33/33**. 10d/40-stop fits ≤1400; 20d/200-stop stays ≤1500 by dropping whole days with a recovery hint; verified no partial day is ever emitted |
| 1.10 | `types.ts` + `tools/{app-state,trips,index}.ts` — 4 specs as pure factories (readers are functions, so no spec ever closes over a stale snapshot) | typecheck | ✅ clean |
| 1.11 | **`spec-contract.test.ts`** — the unattended gate | `npx vitest run lib/webmcp/__tests__/` | ✅ **54/54**. Enforces: unique names · ≤30 char snake_case · description ≤500 · param desc ≤150 · `required` keys actually declared · `readOnlyHint` present · `untrustedContentHint` on all 4 caption-derived tools · every output ≤1500 serialized · global/trip scopes do not overlap |
| 1.12 | **No-regression gate** | `npx vitest run` + `npm run typecheck` | ✅ **629 tests / 84 files pass**, tsc clean |

**Batch 1 verdict: PASS.** 4 tools, 54 new tests, zero regressions, all committed locally (not pushed).

### ⚠️ Incident — two agents, one git index

**What happened.** Claude (frontend) and Codex (backend) ran concurrently on disjoint *files*,
which the plan required — but they shared one **git index**, which the plan did not consider.
Codex ran `git add` on its backend files; my `git commit` then ran and swept them in, because
**`git commit` commits the whole index, not just the paths passed to `git add`**. Codex's own
commit then found nothing staged and failed. Commit `2122c85` ended up containing both agents'
work under a frontend-only message.

**Impact:** none to the code — nothing was lost, and nothing was pushed. History was misleading.

**Verified before repairing anything** (correctness first, tidiness second):

```
cd backend && uv run pytest test_webmcp_edits.py -q   ->   11 passed
cd backend && uv run pytest -q                        -> 1897 passed, 13 skipped
```

**Fix for the rest of the sprint — file disjointness is not enough, the index must be serialized:**

- Only ONE agent commits. Implementer agents write files and run tests; the orchestrator stages
  and commits. This is now the rule.
- Never `git add` and `git commit` from two panes in the same worktree.
- If parallel commits are genuinely needed, give the second agent its own **git worktree**
  (`herdr` supports `worktree`), which is a separate index — not just separate paths.
- Prefer `git commit -o <paths>` (commit *only* these paths) over bare `git commit` whenever any
  other agent might be live.

## Batch 2 — React registration layer + submission docs

| # | Task | Gate | Result |
|---|---|---|---|
| 2.1 | Backend endpoints (Codex, gpt-5.6-sol, Herdr pane) | `uv run pytest test_webmcp_edits.py -q` | ✅ **11 passed** |
| 2.2 | Backend no-regression | `uv run pytest -q` | ✅ **1897 passed, 13 skipped** |
| 2.3 | Guard spot-check **against the code, not Codex's report** | grep `backend/main.py` | ✅ flag default-off (95) · flag check (538) · `_require_trip_owner` (542, reused 570/671) · triple guard (551) · 409 `trip_not_editable` (555) · status guard (593) · running-job 409 (599–604) |
| 2.4 | History repair — split the mixed commit, drop Codex's empty marker commit | `git log`, then re-run both suites | ✅ 629 frontend / 1897 backend still green **after** the surgery |
| 2.5 | `WebMcpRegistry` + `RegisterTools` + `GlobalTools`, wired into `app/app/layout.tsx` | `tsc --noEmit` | ✅ clean |
| 2.6 | `WebMcpStatus` — availability chip + tool inspector | `npx vitest run components/webmcp` | ✅ **4/4** incl. the no-provider case and the "how to enable" fallback |
| 2.7 | Frontend no-regression | `npx vitest run` | ✅ **633 tests / 85 files** |
| 2.8 | **Production build** — the gate unit tests cannot give you | `npm run build` | ✅ all routes build, middleware 153 kB |
| 2.9 | `SUBMISSION.md` + `WHATS-NEW.md` (Codex, docs-only, no git) | read-through | ✅ answers all four Devpost questions; separates built from planned rather than overclaiming |

**Batch 2 verdict: PASS.** React-layer diff was 389 lines — under the 400 gate.

### State at hand-off

- Branch `feat/webmcp`, **8 commits, nothing pushed** (correct — pushing is not an unattended action).
- 4 WebMCP tools registering in the `/app` shell; 2 backend endpoints, flag-gated **off**.
- Frontend **633 tests / 85 files** · backend **1897 passed, 13 skipped** · `tsc` clean · production build green.
- Working tree clean apart from pre-existing untracked skill files that predate this branch.

## Batch 3 — reel ingestion

| # | Task | Gate | Result |
|---|---|---|---|
| 3.1 | `save_reels` tool — validates via the existing `normalizeReelUrl` before any request | `npx vitest run lib/webmcp/__tests__/reels.test.ts` | ✅ **9/9**, incl. rejecting `instagram.com.evil.example` and non-Instagram hosts *before* `save` is reached |
| 3.2 | Registered in the tool index; `GlobalTools` wired to `captureSavedReel` | `tsc --noEmit` | ✅ clean — typecheck caught the missing dep before tests did |
| 3.3 | Full frontend suite | `npx vitest run` | ✅ **646 tests / 86 files** |
| 3.4 | Production build | `npm run build` | ✅ green |

**Batch 3 verdict: PASS.** 5 tools now registering (`get_app_state`, `list_trips`, `save_reels`
globally; `get_itinerary`, `get_place_evidence` on a trip page).

## 🟢 T4 GATE PASSED — first real verification in ChatGPT desktop (27 Aug, 09:28)

**The critical unknown is resolved.** Tools register, ChatGPT discovers them, and it called
`get_app_state` unprompted when asked "what can I do here?". The Site tools arrow appeared and
the in-page chip read **"WebMCP active · 3 tools"** with correct reads/changes badges.

Everything built overnight rested on this working. It does.

### But the test immediately caught a real bug — which is what the gate is for

The agent told a user with a full library: *"there are no saved reels or verified places"* and
advised them to *"start by pasting a Reel link"* — while simultaneously mentioning their
**"Tokyo Winter 2026" tray**, which it had read off the page. The tool was contradicting the screen.

Cause: `get_app_state` reported a hardcoded `savedReels: 0`.

**The real lesson is not the missing wiring.** It is that an unloaded value rendered as a
confident `0`. To an agent, "0" and "I could not check" are entirely different facts, and it
reasons — and advises — off either with equal confidence.

| # | Fix | Gate | Result |
|---|---|---|---|
| 4.1 | Counts are `number \| null`; `null` renders as "an unknown number of", plus an explicit line telling the agent **not** to claim the user has none | `npx vitest run lib/webmcp` | ✅ **77/77** |
| 4.2 | A *loaded* zero still renders as `0` — "unknown" must not swallow a real zero either | covered by test | ✅ |
| 4.3 | `savedReels` / `verifiedPlaces` wired to `listSavedReelCards()`, distinct places de-duplicated, refreshed after a save | typecheck | ✅ |
| 4.4 | `blocked` only fires when the counts are actually **known** — an unknown blocks nothing | covered by test | ✅ |
| 4.5 | Full suite + production build | `npx vitest run`, `npm run build` | ✅ **656 tests / 87 files**, build green |

**Standing rule for every tool from here:** never report a count you failed to load as zero.

### ⚠️ Incident — `next build` clobbered the running dev server

**What happened.** I ran `npm run build` as a verification gate while `next dev` was live in the
`astraildev` tmux session. Both write to the same `.next/` directory, and the production build
replaced the chunks the dev server had open. The browser then threw:

```
Runtime TypeError: Cannot read properties of undefined (reading 'call')
  Object.__webpack_require__  .next/server/webpack-runtime.js (25:43)
```

**Impact:** none to the code — tests and the build both passed. Purely a corrupted dev cache,
but it looked like an application crash to the person testing, which cost trust and time.

**Fix:** stop the dev server → `rm -rf .next` → restart → warm `/`, `/app`, `/sign-in` with curl
so a compile error surfaces in the log rather than in someone's browser.

**Rule for the rest of the sprint:** `next build` and `next dev` are NOT safely concurrent.
The build gate must run either **before** the dev server starts or **after** it is stopped.
Overnight batches run a build gate, so any dev server left up during the day is collateral —
stop it before dispatching a batch, or scope the build to a separate output directory.

## Batch 3–5 — generation, editing, map tools (morning, 27 Aug)

| # | Task | Gate | Result |
|---|---|---|---|
| 3.1 | Data tools moved from page-scoped to **global** | vitest | ✅ Scoping them to the trip page failed the actual flow: in a chat-first product the user asks "what's on day 2 of my Kyoto trip?" without navigating, and a tool on an unopened page is invisible exactly when wanted. Now takes an optional `trip_id`, accepting the 8-char prefix `list_trips` prints |
| 3.2 | `plan_trip_from_reels` + `get_trip_progress` + generation store | `vitest lib/webmcp` | ✅ 24 tests. Self-throttling poll, STAGE_LABEL narration, dead stream → `unknown` not eternal "generating" |
| 3.3 | `AgentConfirm` approval card | vitest | ✅ 7 tests incl. XSS: caption text renders as text, never markup |
| 4.1 | `move_place` / `remove_place` + frontend fetchers | vitest | ✅ 10 tests. 1-based tool position → 0-based column pinned by test |
| 5.1 | `show_on_map`, `set_map_mode`, `get_map_view` (page-scoped) | vitest | ✅ 12 tests |
| 5.2 | Mapbox visuals — popups, chips, day colours, 3D (Codex) | `vitest components/map` | ✅ 42/42; claims verified against the code: no `innerHTML`, http/https allowlist, marker contract 8/8 |
| 5.3 | **Full suite + production build** | `npx vitest run`, `npm run build` | ✅ **761 tests / 93 files**, build green |

**12 tools. 20 commits. Nothing pushed.**

### 🔴 Two bugs the unit tests could not catch

**1. Infinite render loop on every trip page** — "Maximum update depth exceeded", thousands of
times. Introduced when I made the registry optional: I swapped stable callback deps for the whole
context value, which is memoized on `tools`. `report()` → new tools → new context → effect →
`report()` → forever.

> **All 758 tests passed while the page was unusable.** Every test seeded the registry directly;
> none rendered `RegisterTools` inside the real provider. The regression test now does, and also
> covers a specs array whose identity changes each render — which is what `GlobalTools` does.

**2. `RegisterTools` hard-required the provider**, so `TripWorkspace` — a core product component —
threw wherever the agent layer was absent. 13 existing tests caught this one. The dependency was
backwards: registration targets `document.modelContext`; the registry only feeds the status chip.

Both are the argument for the T2/T3 browser gate. Neither was visible from vitest.

### Screenshots — `docs/webmcp/evidence/`

Captured via gstack `/browse` against a temporary mock-auth server on 3001 (your `.env.local` was
never touched; the real-auth server is back up).

⚠️ The compiled `browse` binary at `~/.claude/skills/gstack/browse/dist/browse` is broken —
"Script not found". Workaround: `cd ~/.claude/skills/gstack/browse && bun run src/cli.ts <cmd>`.

## Batch 6 — completion pass (late morning, 27 Aug)

| # | Task | Gate | Result |
|---|---|---|---|
| 6.1 | `list_saved_reels` | vitest | ✅ 16 tests. **Unblocked the main flow** — without it `plan_trip_from_reels` needs URLs the agent has no way to obtain, so it would ask the user to paste links they had already saved |
| 6.2 | `ExamplePrompts` — context-aware first-run panel | vitest | ✅ 5 tests. Hidden where WebMCP is unsupported; survives a throwing localStorage |
| 6.3 | **`AgentActivityRail`** — the last never-cut item from the plan | vitest | ✅ 9 tests. Wrapped in `RegisterTools`, so no call can be silent — reads included |
| 6.4 | Landing framing + judge README (Codex) | vitest | ✅ 7 tests; verified: robots noindex real, tool names read from source, and it explicitly does NOT overclaim on editing |
| 6.5 | **Real-browser end-to-end** | gstack `/browse` + a `document.modelContext` shim | ✅ **13 tools register · `get_itinerary` returns the real itinerary · 0 console errors · 0 render loops** |
| 6.6 | Full suite | `npx vitest run`, `tsc` | ✅ **793 tests / 97 files** |

**13 tools. 26 commits. Nothing pushed.**

### 🔴 Bug 3 — found only by executing a tool in a browser

Sitting **on a trip page**, `get_itinerary` answered *"Which trip? Call list_trips and pass its
trip_id."* Technically correct, obviously wrong. Making the data tools global had quietly lost the
one thing page-scoping gave for free: knowing which trip is on screen.

`TripWorkspace` now publishes its bundle to a **ref** on the registry that the global tools read.
A ref rather than state, deliberately — state would re-create the context value on every trip load
and re-trigger this morning's render loop.

> Three bugs so far, and **not one was visible from vitest**: the render loop, the hard provider
> dependency, and this. Unit tests verified the pieces; only the browser verified the composition.

### How to drive WebMCP in a headless browser (reusable)

The hook polls for a late-injected `document.modelContext` for **10 seconds after mount**, then
gives up. So the shim must land inside that window:

```bash
cd ~/.claude/skills/gstack/browse            # the compiled dist/browse binary is broken
bun run src/cli.ts goto http://localhost:3001/app/trip/trip_tokyo_demo
sleep 2                                       # must be well under 10s
bun run src/cli.ts eval /private/tmp/inject-webmcp.js
bun run src/cli.ts js "document.modelContext.executeTool('get_itinerary', {}).then(r => r.content[0].text)"
```

That 10-second window is also a **real risk on the judged surface**: if ChatGPT's browser injects
its WebMCP API later than 10s after mount, no tools register at all. Worth watching for.
