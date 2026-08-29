# Merging `wt/receipts` and `wt/layout` — verified, not predicted

Both branches are finished and waiting. `git merge` is deliberately the repo owner's command, so
this documents the exact result rather than performing it. Everything below was checked with
`git merge-tree` (a read-only 3-way simulation) plus a full build of the resolved result in a
throwaway directory. No merge was run.

## Result, up front

**The two branches do not overlap. Order does not matter textually.**

```
files changed by wt/receipts          files changed by wt/layout
  components/webmcp/AgentActivityRail.tsx   components/reels/TraysScreen.tsx
  components/webmcp/AgentActivityRail.test  components/reels/AgentBand.tsx
  components/webmcp/WebMcpRegistry.tsx      components/reels/TraysScreen.test.tsx
                                            components/reels/AgentBand.test.tsx
```
`comm -12` on those two lists is empty.

| Merge | Conflicts |
|---|---|
| `wt/receipts` → `feat/webmcp` | **None.** `merge-tree` exits 0 with a clean tree |
| `wt/layout` → `feat/webmcp` | **Four hunks, in two files** |

## The four conflicts, and the one-line rule that resolves all of them

**Take `wt/layout`'s side in all four.** Not a judgement call — in two of them `feat/webmcp`'s
side is *literally empty*, and in the other two layout's text contains main's and adds to it.

`frontend/components/reels/TraysScreen.tsx`
1. **main's side empty.** Layout adds `buildAgentBandPrompt(start, end)`, which main has no
   equivalent of because main has no band.
2. **layout's side is a superset.** Main has a `useMemo` producing `starterPrompt`; layout has the
   same comment plus the band gating and a combined `useMemo` producing *both* prompts from one
   `new Date()`. Taking main's side here would drop the band and leave `agentBandPrompt` undefined.

`frontend/components/reels/__tests__/TraysScreen.test.tsx`
3. A one-word comment difference — "the prompt" vs "a prompt". Layout's is the accurate one now
   that the screen builds two.
4. **main's side empty.** Layout adds the `AGENT_BAND_PROMPT` fixture.

The starter-date region does **not** conflict at all. `wt/layout` commit `d9df9d9` ported main's
derivation byte-for-byte, so git's 3-way sees the same change on both sides and auto-resolves it.
Before that commit this merge produced a *TypeScript failure* rather than a conflict marker —
layout still referenced `STARTER_START_DATE`, `STARTER_END_DATE` and `STARTER_PROMPT`, which
`d2f638c` had deleted.

## Verified, not assumed

The resolved result was reconstructed from the merge tree, the four hunks resolved toward layout,
and then built:

```
feat/webmcp + wt/layout                      →  tsc clean · 112 files · 1209 tests passed
feat/webmcp + wt/layout + wt/receipts        →  tsc clean · 112 files · 1215 tests passed
```

## The thing tests cannot catch

A cross-model review put it this way: *"The dangerous outcome is not a Git conflict. It is a clean
merge that leaves the receipts dock obscuring the redesigned `/app` page."* Both branches add fixed
overlay UI and neither knows about the other, so they can collide at runtime while every test
passes — the suites above prove nothing about this.

`docs/webmcp/SHOWCASE-PATTERNS.md` measured what OpenAI's own showcase apps do here, and it is
consistent: agent chrome is peripheral, small, and never over the content column. Codex Modeling
Studio's footer pill is ~480px and explicitly non-blocking. **A fixed receipts dock sitting over
the agent-first `/app` screen is the one thing none of the six do.**

So after merging, look at `/app` at desktop and mobile widths with the rail expanded, a status card
up, a confirmation overlay open, and reel details open. Then decide one of: reserve space for the
dock, hide it on the agent-first screen, or give it a route-aware variant.

## Commands

```bash
git merge wt/receipts     # clean, no conflicts
git merge wt/layout       # 4 hunks, all resolved by taking wt/layout's side
cd frontend && npx tsc --noEmit && npx vitest run   # expect 112 files / 1215 tests
```
