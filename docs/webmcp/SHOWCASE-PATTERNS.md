# How OpenAI's own showcase apps present the agent

Measured from the six live showcase apps — raw HTML plus their real CSS and JS bundles, not from
screenshots or write-ups. Recorded because it bears directly on two branches waiting to merge.

## The finding

**Agent chrome is small, peripheral, and honest about being disconnected. Nobody spends display
type on the agent.**

| App | Tools | On-page agent chrome |
|---|---|---|
| Verdant Market | 9 | **None.** The string "agent" appears nowhere in rendered output |
| Crossword Desk | 5 | **None.** Registers silently |
| Webroom | **28** | One topbar status pill, defaulting to "WebMCP unavailable", plus one italic line |
| Margin Editor | — | One small rail-footer button: a dot and the word "WebMCP" |
| Codex Modeling Studio | — | A topbar status dot and a ~480px non-blocking footer pill over the canvas |
| WanderNote | 11 | 39px h1 for the trip; **11px bold / 10px body** for "Your agent is invited." |

Three patterns hold across all six:

1. **No in-page chat panel anywhere.** Confirmed negative — grepped rendered text and both JS
   bundles for chat-prefixed class names. Zero hits. The agent lives in ChatGPT; the page is the
   artifact.
2. **The tool list is never on the page.** Always behind a modal on a small button.
3. **The strongest "an agent can act here" signal is not chrome at all — it is visible holes in
   the artifact.** WanderNote repeats an empty-slot button 17 times down the page.

Codex Modeling Studio is the most agent-forward of the set and still artifact-first: the 3D canvas
is 100vw × 100vh and everything floats over it. Its copy repeatedly says **verified** — "The latest
verified agent action will appear here", "No verified edits yet" — framing agent actions as things
the page confirms rather than narrates.

## What it changes for Astrail

**It corroborates the collision warning on the two pending merges.** A cross-model review already
flagged that the dangerous outcome of merging `wt/receipts` and `wt/layout` "is not a Git conflict
— it is a clean merge that leaves the receipts dock obscuring the redesigned `/app` page." Every
showcase app that has agent chrome keeps it non-blocking and out of the content column. A fixed
receipts dock sitting over the agent-first `/app` screen is the one thing none of them do.

So the merge needs an explicit layout decision, not just a conflict resolution: reserve space for
the dock, hide it on the agent-first screen, or give it a route-aware variant.

**Where we deliberately differ, and why it is defensible.** Our empty `/app` leads with the agent,
which inverts the artifact-first rule. Crossword Desk is the fair comparison — genuinely empty, and
it still leads with the artifact (a blank 10×10 grid) plus one button. The difference is that a
blank grid *is* a usable artifact and an empty reel library is not: there is nothing to render and
nothing to click. Leading with the agent there answers the measured complaint that started this
work — "it's unclear where to click, how to choose the reels, how to start generating." Once an
account has reels, the library is the artifact and should lead.

**Two things worth copying outright.** The word *verified* over the word *did* — we already resolve
mutation tools only after the UI reflects them, so the stronger word is earned. And the honest
disconnected state: Webroom ships "WebMCP unavailable" as its default topbar text rather than
hiding the indicator, which is exactly what our own chip does.

## Caveats, stated

- Margin Editor is a JS-only shell; its copy and layout are source-accurate from the bundle but the
  page was never seen painted.
- **No app was observed with WebMCP actually connected.** Every status indicator captured is in its
  disconnected or checking state, so the "active" presentation of any of these is unverified.
- The live-URL pattern is not reliably `<slug>.openai.chatgpt.site` — three guesses 404'd.
