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

## Batch 7 — reported bugs (lunchtime, 27 Aug)

**Both red T4 checks passed on the real surface**, which validates two design calls made blind:
- From `/app` with no trip open: *"What's on day 2 of one of my latest generated Osaka trips?"* →
  `list_trips` → `get_itinerary`, correct answer. This is the flow the **global tools** refactor
  existed for; under the original page-scoped design the tool would not have been visible at all.
- On the trip page: *"What's on day 2 of my Osaka trip?"* → used the open trip without asking
  which. That is the **openTrip ref** fix, confirmed.

"10 tools on `/app`" is correct, not a bug: 10 global + 3 map tools that only exist where a map does.

| # | Task | Gate | Result |
|---|---|---|---|
| 7.1 | Tool panel could not be closed | vitest + browser | ✅ Panel rendered **below** the chip in a bottom-anchored box, so opening it pushed the chip upward and the click target moved out from under the cursor. Panel now renders **before** the chip; chip never moves; explicit close button added |
| 7.2 | Three panels fighting for one corner | browser at 375 / 768 / 1440 | ✅ Chip, prompts and rail were each `fixed` at a hardcoded offset (4/16/28) — fine only while all three stay short. Replaced with **one dock**: each panel sizes itself and the others move, no offsets to keep in sync |
| 7.3 | 13 tools taller than a phone | browser | ✅ `max-h-[60dvh]` + scroll. Measured fully on screen at 375×812 |
| 7.4 | Prompts + tool list filled a phone viewport | browser | ✅ Now mutually exclusive — together they buried the map the agent is meant to be driving |
| 7.5 | Regression + full suite | `npx vitest run` | ✅ **796 tests / 97 files**, 0 render loops in-browser |

**Lesson, third time today:** all three of these were invisible to vitest. jsdom has no layout, so a
panel positioned off the bottom of the viewport looks identical to one positioned correctly. The
new tests pin what jsdom *can* see — DOM order, the close control, the height cap — and the
geometry was verified by measuring `getBoundingClientRect` in a real browser at three widths.

## Batch 8 — teardrop pins + the two-dev-server incident (evening, 27 Aug)

Shaun's call, verbatim: *"we just focus on those locations that are from reels, so that we just use
the thumbnail from the reel will do. For those added from agent or from the web search we can just
one placeholder that is universal."* That is the whole design: **the pin's photo is evidence, and a
place with no Reel behind it gets a deliberate blank rather than a borrowed picture.**

| # | Task | Gate | Result |
|---|---|---|---|
| 8.1 | Teardrop pins replace the dots; Reel cover in the head | `npx vitest run components/map` + browser measure | ✅ Pin measured **40×52** (was 30×30), selected **50×65**, receding **26×34**. 2 of 6 fixture pins carry covers, 4 the placeholder |
| 8.2 | Three dot-era CSS rules removed | marker-css-contract drift guard | ✅ They styled `border` against `border: 0` (a no-op) and drew an `outline` on the marker root — a **rectangle** around a teardrop, because an outline follows the bounding box, not the shape. Source kind now draws on the SVG path |
| 8.3 | Popup clipped on a 720px laptop | browser measure at 1280×720 | ✅ Overflowed by 53px; both CTAs off-screen. Fixed at the **camera** — `framePadding({popupRoom:true})` lands the pin in the upper third. Now 91px of headroom. Fault-injected |
| 8.4 | Hostile Reel thumbnail | vitest, fault-injected | ✅ **Real finding, found before Codex's pass.** `safeWebUrl` gated the popup's copy of `thumbnail_url` but not the pin's `<image href>` — the same attacker-controlled value from Apify's scrape (guardrail #11). Now gated at the call site, so the number badge agrees with it |
| 8.5 | Pin tap did nothing visible on mobile | browser at 390×844 | ✅ The popup opens inside `.shared-map`, which is `position: fixed; z-index: 0` — **its own stacking context** — so it can never paint above the `z-10` sheet covering ~65% of a phone. No z-index fixes that. The selected place's card now scrolls into view instead, which also fixes the agent's `show_on_map` direction |
| 8.6 | Full suite | `npx vitest run` + `tsc --noEmit` | ✅ **863 tests / 100 files**, typecheck clean |

### Incident: two dev servers, one `.next/`

`:3001` and `:3002` were both running Next dev from `frontend/`, so they shared `.next/` and
overwrote each other's chunks. The symptom is a **500 with `Cannot read properties of undefined
(reading 'call')` from `__webpack_require__`** — which reads as an application bug and sends you
looking in the wrong place. Same error Shaun hit earlier in the sprint, and the same root cause as
the "never run `next build` while the dev server is running" note: **anything that writes `.next/`
concurrently corrupts it.**

Fixed structurally rather than by remembering: `distDir: process.env.NEXT_DIST_DIR || ".next"` in
`next.config.ts`, plus `.next-*/` in `.gitignore`. The fixture harness now runs as

```bash
tmux new-session -d -s harness \
  "cd frontend && NEXT_DIST_DIR=.next-harness NEXT_PUBLIC_MOCK_AUTH=true npx next dev -p 3002"
```

Two caveats recorded so the next session does not rediscover them:
- Next **rewrites `tsconfig.json`** to add `<distDir>/types` (and reformats the file). Run
  `git checkout frontend/tsconfig.json` after a harness session.
- A repo hook requires dev servers to run in tmux, but its regex matches the string `npm run dev`
  **anywhere in a command** — including inside the tmux invocation it recommends, and including
  prose that merely mentions it. `npx next dev` inside tmux satisfies the actual requirement.

**Lesson:** two of the three real defects this batch (8.3, 8.5) were geometry that vitest
structurally cannot see, and the third (8.4) was a consistency gap between two call sites of one
value. None would have been caught by more unit tests — 860 were already passing. Measuring
`getBoundingClientRect` in a real browser at three viewports is what found them.

### Codex cross-model review of batch 8 — 5 findings, 1 false positive

Dispatched to the Herdr `reviewer` pane (Codex, gpt-5.6-sol). Its first pass was lost to a context
compaction mid-run; **re-dispatched asking for the report as a FILE**, which is the documented
Herdr fallback and should have been the first move for a long review.

Verdict: CHANGES REQUESTED. Findings, each verified against the code before acting:

| # | Finding | Verdict | Action |
|---|---|---|---|
| 1 | **`thumbnail_url` is never supplied on the live path**, so every pin renders a placeholder in production | ✅ **Real, and the most valuable finding of the sprint.** `trip_inspiration_items` has no such column — it carries `reel_cache_id`; the cover lives on `reel_cache`. `select('*')` cannot return it. The fixture hand-injects it, so 863 green tests said nothing | Resolved through **`saved_reel_cards`**, the user-scoped view that already joins `reel_cache` server-side. **A client-side embed would have been *denied*, not empty** — migration 20260718130000 runs `revoke all on public.reel_cache from public, anon, authenticated`. **No migration needed**, which matters: prod DB changes are gated by `astrail-release` |
| 2 | A non-Reel place can be given a Reel cover and link | ✅ Real. `reelUrlFor` gated only the *legacy* fallback on provenance; the `source_reel_url` and `source_url` paths did not. An agent pick's research URL, or a dedup-rewritten row, could take the brass "from Reel" frame — a false provenance claim (guardrail #1) | Provenance is now the **outer** gate on every path, requiring `source_type === 'reel_extracted'` **and** `evidence_kind === 'reel_quote'`. The backend writes both from one total mapping, so demanding both is free on rows it wrote and is the protection for rows it did not |
| 3a | Cross-day pin selection is a silent no-op | ✅ Real. The map shows every day's pins; the card list shows only the active day. `onSelectPlace` never set the day | Fixed at the parent, where day state lives. The agent's `show_on_map` already did this itself (`map.ts:79`), so only the pin path was affected |
| 3b | `CSS.escape` absent in this jsdom, so the new tests must throw | ❌ **False positive.** Probed directly: `CSS=object, escape=function`, and the tests pass. Codex's probe ran a bare Node/jsdom rather than the project's configured vitest environment | None |
| 4 | Pin image bypasses `safeWebUrl` | ✅ Real — **already fixed in `329ba91`** before this review landed. Codex read a stale tree and correctly reported implementation and test contradicting each other, which was true at the commit it saw | None |
| 5 | Zero-sized canvas bypasses the padding cap | ✅ Real, narrow. `canvas?.clientHeight || window.innerHeight` treats a true `0` as "unmeasured" and substitutes the much larger window — recreating the exact mismatch the 70% cap exists to prevent | `??` instead of `||`. A zero canvas now yields zero padding |
| 6 | `NEXT_DIST_DIR` reachable from a production build | ✅ Fair. The comment "unset everywhere else" was an assumption, not enforcement | Gated on `!isProduction`, so a stray Vercel env var cannot repoint a production build's output |

Codex also confirmed two things were fine, with reasoning I checked: the `pinClipSeq` counter cannot
collide or leak (markers are `remove()`d and the counter holds only a number), and the popup-room
algebra is correct (`0.6H = top + H − bottom → bottom = top + 0.4H`).

**All six fixes are fault-injection tested** — each fails with its guard removed. 873 tests / 101 files.

**The lesson worth keeping:** finding 1 is a class of bug no amount of unit testing would have caught,
because *the fixture and the schema disagreed* and every test trusted the fixture. The check that
found it was reading the migration. Fixtures assert what we believe the shape is; only the schema
says what it is.

### Codex adversarial review of the backfill migration — verdict: DO NOT RUN

Dispatched to the Herdr `reviewer` pane before Shaun applied anything by hand. **It found that
both the migration AND the frontend fix from `532a635` were inert in production**, for the same
reason, and the finding is worth recording in full because it is the third instance of one pattern.

**BLOCKER 1 — `trip_inspiration_items` has no producer.** Nothing in the backend or the frontend
writes it. The repo already knew: `components/trip/OrchestratorSummary.tsx` dropped its SOURCES
stat over exactly this ("grep for a producer — there is none"). So the migration's inner join
eliminated every candidate row, and the frontend cover/attribution fix — which derives the trip's
Reel list from `bundle.inspiration` — resolved nothing. **Both passed all their tests**, because
the Tokyo fixture hand-writes inspiration rows the live table never receives.

**BLOCKER 2 — set membership is not lineage.** "Exactly one currently-organized Reel mentions this
place" does not prove that Reel supplied *this stop's* verbatim quote. If Reel A produced the stop
but is no longer `organized`, and Reel B also mentions the place, the filters hide A *before* the
distinct count runs and the migration writes B **under A's quote** — a false citation directly
beneath verbatim evidence, which is precisely what guardrail #1 forbids. The safe policy is false
negatives: require the stop's quote to equal the mention's `evidence_quote`, else leave it absent.

Also found, and all correct on inspection:

| Sev | Finding |
|---|---|
| HIGH | The blank-key predicate lived only in the source CTE. Under Read Committed the final `UPDATE` re-evaluates its own `WHERE` against the newer row version — but that check was not there, so a concurrent legitimate write could be overwritten |
| HIGH | `on conflict do nothing` silently keeps a stale ledger row while the update writes a new value, so the reversal ledger stops being an exact inverse |
| MED | The rollback treated value equality as proof of ownership. Equality is not provenance: a pipeline-written row carrying the same URL would be stripped |
| MED | No date cutoff, no terminal-status guard, no `lock_timeout`/`statement_timeout` on an `UPDATE` against a shared production table |
| LOW | Two of my own comments were wrong: I described a `having` clause that isn't there, and claimed `on conflict` protects a run "killed mid-statement without `-1`" — a single statement is atomic, so it cannot |

**Outcome.** Migration withdrawn, not fixed — with the source table empty there is nothing for it
to join against, so the correct move was to solve the real problem instead. The durable record of
a trip's Reels is its `create_trip` generation event (`backend/main.py` builds that payload from
`req.reel_urls`), which `getTrip` already loads. The loader now recovers the Reel list from there
when the table is empty, normalising the pasted URLs so they match `saved_reels.normalized_url`.

**The pattern, three times in one evening:** `thumbnail_url` (column does not exist),
`trip_inspiration_items` (table never written), and a migration joining through it. Every one
passed a full green suite. **The fixture is a statement of what we believe the shape is; only the
schema and the producers say what it is.** The check that caught all three was reading the
migrations and grepping for a writer — never the tests.

**Deferred, with a trigger:** writing `trip_inspiration_items` during generation is the real fix —
it would restore the SOURCES stat and the "not planned yet" list as well. Deferred past the
hackathon deadline because it is a new pipeline write path needing its own RLS and idempotency
review, and the event-recovery path above already yields the same answer for old and new trips.

## Batch 9 — overnight, 27→28 Aug (Shaun asleep, four items he picked)

Ingest was proven live before he went to bed: save → extract → live status → places, through the
agent, on the real backend. `plan_trip_from_reels` remains the one unrun path.

| # | Item | Gate | Result |
|---|---|---|---|
| 9.1 | Real status during the 60–180s wait | vitest + fault-inject | ✅ The longest-standing red T4 item, on the screen a judge sits through. `OrganizeGlobe` cycled decorative words — explicitly "never a progress claim" — while the REAL status rode an `sr-only` region. So a screen-reader user was told what was happening and a sighted user was not. Now one element, seen and heard, plus elapsed seconds (measured, so it cannot be wrong) |
| 9.2 | Hotels warn when the search finds nothing | vitest + fault-inject | ✅ Only the exception path spoke; a successful empty search recorded nothing, so "found none" and "failed silently" were indistinguishable. Worded WITHOUT claiming a search ran — zero rows also means "no city and no destination hint, so nothing was called" |
| 9.3 | Three T4 items | vitest + fault-inject | ✅ The organize dead end now offers "Find places in N reels" instead of naming a blocker and leaving the user to find the fix on another screen; "No trails yet" over "Your trays" became one noun, defined where it is first used; "Your grounded places" became "Places we found" |
| 9.4 | Re-pasted link reported as a new save | vitest + fault-inject | ✅ `capture_saved_reel` upserts, so a duplicate looked identical to a new save. `updated_at != created_at` is exact and compares no clocks across machines: the table's trigger is BEFORE UPDATE, so the conflict branch bumps it while a fresh insert leaves both set by one `now()` |
| 9.5 | Cross-model review of 9.1–9.4 | Codex, Herdr pane | ⚠ **Three HIGH, three MEDIUM — all real, all in code written hours earlier.** Fixed in `d14552d` |
| 9.6 | WHATS-NEW.md + README | manual + a script diffing the table against the registry | ✅ |

### What the Codex pass caught, and why it mattered

The most valuable finding was one I had asserted in a comment: **the backend does NOT enforce one
active organize job per user.** The active unique index is on `(user_id, idempotency_key)`, and
creation rejects only a batch that OVERLAPS an active job's reels — two disjoint batches run side
by side. A judge calling `save_reels` twice with different URLs would have silently orphaned the
first run, because the page held a single job slot.

Two more of the same family: at job-terminal the code cleared its state and THEN awaited the card
reload, so one transient read failure stopped the poll for good — reinstating the exact stale card
the mechanism exists to prevent; and item ids were marked settled *before* their refetch
succeeded, retiring a reel forever on a single blip. Both are now ordered so nothing is retired
until the read that justifies it has landed.

The fourth: the live overlay yielded to the row whenever the row was non-default — but a reel
being RE-analysed still carries its previous `failed` / `organized` outcome, so the row looked
caught up while the new run was only starting.

**Lesson, and it is the same one as batch 8:** every one of these passed a green suite written by
the same author in the same hour. Fault-injection proves a guard is load-bearing; it does not
prove the guard is the right one. A second reader is what found the wrong invariant.

### Docs

`WHATS-NEW.md` was an eligibility requirement and was **badly stale** — it claimed four tools when
sixteen exist and listed the shipped ones as "planned, not yet claimed as complete", understating
the work to a judge. Rewritten against the branch, with all 21 cited SHAs verified to exist. The
README's tool table is now checked against the registry by a script rather than by eye, and its
status section says plainly what has been run live and what has not.

---

## Batch 10 — the verification pass, and closing what it found

`83d4395` · `58151a6` · 2026-08-28, unattended

Codex re-reviewed batch 9's own fixes rather than the original code. That is the pass worth
running: a fix written under time pressure at 3am is the least-reviewed code in the branch.

**Verdict: five of six findings genuinely closed, one partially, and one NEW HIGH introduced by
the fix itself.** The new HIGH is the instructive one. Batch 9 replaced a single job slot with a
set of adopted jobs — correct — and polled them with `Promise.all`. One rejected status read
therefore rejected the whole batch, so a single unreadable job id stalled *every* adopted job for
the rest of the page mount. That is strictly worse than the single slot it replaced: the fix for
"a second job abandons the first" made "a bad job abandons all of them" possible.

`Promise.allSettled` now, with a test that adopts a bad id alongside a good one and asserts the
good one still reports its finished item. Restoring `Promise.all` fails it.

The partially-closed finding: the overlay correctly marked a re-analysing card `processing`, and
`statusLabel` then ignored it, because places were checked first. A reel being re-analysed kept
reading "Places found · 3" from the *previous* run. An active run now outranks the place count.

Two more from the same pass, both mine: `settledRef` was keyed by reel id while its comment
claimed per-job, so a reel re-analysed by a later job would have been suppressed by an earlier
job having settled it; and the README contract test had gone stale in exactly the way it existed
to prevent — it hardcoded 13 tool names against a registry of 16 and kept passing. It now derives
the names from `lib/webmcp/tools/`, with a guard-the-guard assertion so a broken parse fails
loudly rather than vacuously.

`58151a6` closed the remaining three, all bounds rather than defects: the adopted-job set had no
eviction (a job that never reaches a terminal status is never retired, so the set grew on every
`save_reels` call and polled a dead id for the life of the page — capped at 8, oldest out); the
3s poll had no in-flight guard, so a slow round overlapped the next tick and doubled every request
at exactly the wrong moment; and I had documented `updated_at !== created_at` as "exact" when it
is transport-dependent — `now()` is transaction-stable, so two captures in one transaction would
share a timestamp. Reliable, not exact, and the comment now says which.

### The lesson, stated for the third time in this branch

Batch 8: the fixture asserted a shape the database does not have. Batch 9: green tests written by
the author in the same hour proved nothing about the invariant. Batch 10: the *fix* for batch 9's
finding introduced a worse failure of the same kind, and its own tests passed.

Fault injection proves a guard is load-bearing. It does not prove the guard is correct, and it
never proves the guard is the *right* guard. Only a second reader with a different prior has
caught any of these — and it caught them in the code most recently declared done.

## Overnight, 28→29 Aug — agent-first item 1

Working from `docs/webmcp/plans/01-agent-generation-drives-the-page.md`, whose ownership model was
rewritten after Codex rejected the first one. Backend stopped for the night first: `_reap_loop`
runs every 120s against the shared Supabase and is not flag-gated, so an idle local backend can
adopt and re-execute a stuck job and spend real credit while nobody is watching.

### Task 1 — pins have never landed progressively

Pulled out of the plan and done first: small, independently verifiable, and it improves the manual
path today regardless of what happens to the rest.

`GenerationScene` fetched places on the first places-bearing stage and set `fetchedRef.current =
true` **before** the fetch resolved. `dedup` is emitted at `runner.py:332` and `persist_itinerary`
does not run until `:391` — even `stage:save` (`:386`) precedes it — so that first read found zero
rows and the latch suppressed every retry for the rest of the run. The comment above
`PLACES_READY_STAGES` claimed those stages "only run after places are persisted". None of them does.

Two halves:

- **Backend** — `runner.py` emits `decision` / `save` / `"Saved N stops to your map"` immediately
  after `persist_itinerary` returns, counting `len(canonical) - dropped`. The first event that
  actually means the rows are readable, and another beat in the long silent stretch.
- **Frontend** — `placesReady` (a boolean that flips once, so the effect never ran again) became
  `placesSignals`, a count including that decision. The latch now moves to *after* pins land, with
  an in-flight guard so overlapping signals cannot race.

Both new frontend tests fail against the old component: it latches on the empty read, and it
ignores a `decision` entirely.

```
frontend  npx tsc --noEmit          exit 0
frontend  npx vitest run            985 passed
backend   uv run pytest -q          1965 passed, 13 skipped
```

### Tasks 2-5 — the generation controller

`GenerationProvider` now lives in `app/app/layout.tsx`, inside `MapProvider` and above
`GlobalTools`, and owns the parts of a generation that must outlive a page: the single
EventSource, the full `StreamEvent[]` history the wait screen renders from, the active-run lock,
the dawn relight and the terminal navigation. It deliberately does **not** own the reels workflow
— phase, trays, selection and inbox stay in `SavedReelsFlow`, which subscribes.

Codex rejected the first design (a fourth ref slot, page owns the stream) and the rewrite follows
its model. What that bought, concretely:

- `plan_trip_from_reels` now renders `GenerationScene`, lands pins, relights at dawn and opens the
  finished trip — the thing the whole submission claims and could not previously demonstrate.
- One shared lock across both entry points. A manual click and an agent approval could each create
  a real backend run; neither stopped the other, and `get_trip_progress` cannot recover an
  abandoned one. `canStart()` is checked synchronously **before** the backend call.
- A terminal result carrying `{error: …}` is now a failure. `runner.py:154` → `streaming.py:53`
  can emit one with no preceding `error` event, and every result was being read as success.
- Reconnect drops the history, because the backend replays every event on `onopen`.
- A token failure ends the run as `unknown` instead of leaving it "generating" for ever.
- Run-ID guards: a stale run cannot cancel a newer stream or navigate to a finished trip.

`SavedReelsFlow` lost its own `streamGeneration` call, its `events`/`tripId` state and its
unmount cancel. Its two generation tests now render the real composition — `MapProvider` >
`GenerationProvider` > `SavedReelsFlow` — with **every assertion kept**, so the dawn relight and
the entitlement refetch are still proven, through the new owner.

```
frontend  npx tsc --noEmit          exit 0
frontend  npx vitest run            997 passed (105 files)
```

**Still unverified, and it is the point of all this:** `plan_trip_from_reels` has never been run
through WebMCP in ChatGPT's browser. Tests are not evidence the handoff works on the judged surface.
