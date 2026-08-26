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
