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
