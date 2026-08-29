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
feat/webmcp + wt/layout + wt/receipts   →  tsc clean · 114 files · 1263 tests passed
                                        →  `next build` clean, production
```

## The overlay collision was real, and is fixed

Confirmed in a real browser on the merged tree, at both widths, and photographed — 15 screenshots
in `docs/webmcp/evidence/merge-dock-*.png`.

At **390px, in the default state with no user interaction at all**, the example-prompts panel
covered the "Plan a trip from your 9 saved reels" CTA. At **1280px** an `elementFromPoint` probe on
the capture form's Save button returned the panel, not the button: Save was unclickable. Scrolled
to the trays, clicks were being stolen from a tray card.

**Neither branch could have caught it alone, which is why both passed their own tests.**
`wt/layout`'s AgentBand adds ~156px at the top, pushing the form down into the dock's zone;
`wt/receipts` made the rail persistent and expandable to 45dvh, pushing the dock's top edge up.
Without the band, Save sits ~30px higher and merely clips.

Fixed on `wt/receipts` (`99c1384`) with the route-aware variant — the third shape the review named.
On the full-bleed map routes (`/app/trip/*`, `/app/trips`) nothing changes: that is the floating
non-blocking pill over a canvas, which is exactly the Codex Modeling Studio shape
`SHOWCASE-PATTERNS.md` measured. On document routes the prompts panel is dropped and the rail's cap
drops to 9rem, leaving the slim `READING · Astrail` pill. Dropped rather than shrunk because
layout's AgentBand now does that job **in-content**, laid out with the page — two prompt blocks
with different text is worse than one.

**Residual, stated rather than hidden.** On a phone with the read-back *expanded*, the panel still
covers the CTA — but that is a state the user opened and can close from a visible control, unlike
the default state it replaces. At 1280 the collapsed rail clips ~12px of the third tray card's top
edge while scrolled to the very top; every card is fully clickable once scrolled. Closing both
needs reserved space in the shell (`app/app/(shell)/layout.tsx`, a bottom pad conditional on
`supported`), which belongs to neither branch and is deliberately left for after the merge.

## ⚠ Reconstructing the merge needs `--binary`

This affects **only the reconstruction recipe below**, not your `git merge` — that handles binary
files correctly.

`99c1384` adds PNGs. A plain `git diff <base> wt/receipts` omits their content (31KB vs 3.9MB with
`--binary`), and because `git apply` is atomic it then fails **every** hunk with *"cannot apply
binary patch without full index line"*, leaving the tree silently unpatched. Reproduced. Use:

```bash
git diff --binary "$BASE" wt/receipts > receipts.patch
```

## ⚠ The take-layout's-side rule is POSITION-sensitive

"Take layout's side in all four" describes the four hunks as they stand, **not a property of the
branch.** An implementer working on `wt/layout` hit this: it added a test in the middle of the
`agent-first empty state` describe — the same block `feat/webmcp` inserts its own new test into —
and git aligned the two `it(` blocks into an **add/add conflict**, taking the count to six hunks.
Applying the blanket rule there would have silently **deleted** main's clock test
(`prints dates read off the clock, not a pair frozen into the source`).

It was fixed by moving the new test to the end of that describe, and both tests are confirmed
present in the merged tree. But if either branch gains another test in that block, re-check the
hunk count before applying the rule. Six hunks means the rule no longer applies as written.

Re-verified at `b8f8183`, after a further seven commits landed on `feat/webmcp`. The conflict
shape did not move: `wt/receipts` still merges clean, `wt/layout` still produces the same four
hunks in the same two files, and all four still resolve toward layout.

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
