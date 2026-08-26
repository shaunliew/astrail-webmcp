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
