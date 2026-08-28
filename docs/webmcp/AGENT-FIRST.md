# Agent-first: the four days before submission

> **Working doc — update the status boxes as things land.** Written 2026-08-28 ~23:30 GMT+8 from
> two independent reviews that converged: a Codex product critique dispatched through a Herdr pane,
> and an external-research pass on OpenAI's own WebMCP showcase apps. Every code claim below was
> re-verified against the repo before it was written down.

**Deadline: Wed 3 Sept 2026, 1:00 pm PT = Thu 4 Sept, 04:00 GMT+8.** Verified against the
[Devpost rules](https://webmcp.devpost.com/rules) and [OpenAI's page](https://openai.com/webmcp-challenge/) —
the submission window is 25 Aug 11:00 PT → 3 Sept 13:00 PT, winners on or around 23 Sept. Two other
times circulate in secondary sources (5pm PT, and 4 Sept); **both are wrong**. After the deadline,
touch nothing — not the entry, not the repo, not the live site — until winners are announced.

**Judged on:** WebMCP Leverage · Execution · Potential Impact · Creativity & Ambition.

## The one-line diagnosis

The trip page is genuinely agent-first. `/app` is not. A judge lands on a paste box, and the
agent-aware chrome is a dismissible corner dock while a manual library owns the screen. Worse, the
single sentence the whole submission rests on — *the agent moves the map the human is looking at* —
**cannot currently be demonstrated on the main path.**

## Status

| # | Item | Impact | Cost | Status |
|---|---|---|---|---|
| 1 | Connect agent generation to the page | Very high — Leverage, Execution, Creativity | 1–2 d | ☐ not started |
| 2 | Invited empty state + one-click seeded demo trip | High — Execution, Impact | ~1 d | ☐ not started — **confirmed live, see below** |
| 3 | Persistent receipts + undo (replace the 8s fade) | High — Execution | ~1 d | ☐ not started |
| 4 | Tool-contract gaps + truthful SUBMISSION.md | Med-high Leverage, protects every score | <1 d | ☐ not started |
| 5 | `get_trip_notes` / `resolve_trip_note` (JSONB) | Highest Leverage + Creativity | ~1 d | ☐ stretch — only if the days hold |

---

## 1. Connect agent-started generation to the page

**The defect, verified.** `GenerationScene` is rendered from exactly one place for real auth —
`SavedReelsFlow.tsx:412`, gated on a `phase` set at `:340` by the manual button. The entire WebMCP
layer contains **zero** `router.push` / `useRouter`. So a trip started by the agent never puts the
page into `generating`, never feeds `GenerationScene`, never moves the map, and never opens the
finished trip.

`SavedReelsFlow.handleGenerate()` does four things the agent path does none of:

```
① setPhase('generating')        :340   → renders <GenerationScene>
② setEvents([...])              :341,:354 → the array that FEEDS it, per stage event
③ setTripId(response.trip_id)   :347
④ router.push('/app/trip/{id}') :365   → on `result`; :369 on failure
```

`GlobalTools`'s `openStream` does one: `storeRef.current.start(tripId, …)`, into the WebMCP store
(`lib/webmcp/generation.ts`) that exists to answer `get_trip_progress`. **Nothing renders from it.**
Two consumers of one SSE stream; only one is attached to the screen.

**What a judge sees today:** approval card appears (that part *is* wired), they approve — and the
page stays on the reels library for the whole 60–180s while the agent narrates into chat. On
completion, nothing opens. Meanwhile the manual button gives a night globe, stage lines, pins
landing on the map one at a time, and an auto-navigate to the finished 3D trip.

**The design question to settle before building:** `phase` is local `useState` inside
`SavedReelsFlow`; `GlobalTools` sits outside it and cannot call `setPhase`. Lift the state to a
provider, or use a ref-handoff like the `refreshOpenTrip` / `adoptOrganizeJob` pattern already in
that file? Decide with a plan review, not mid-implementation.

**Done when:** a trip started by `plan_trip_from_reels` takes over the screen with the same
`GenerationScene` the button produces, lands pins progressively, and navigates to the trip on
completion — verified live in ChatGPT's browser, not just in tests.

## 2. Invited empty state + a one-click seeded demo trip

**The defect.** With an empty library a judge sees a URL paste box. `ExamplePrompts` is keyed by
pathname only (`ExamplePrompts.tsx:15`), not library state, so it offers *"Plan me 4 days in Kyoto"*
— which **cannot run**: `plan_trip_from_reels` requires 1–5 reel URLs (`tools/generation.ts:88`).
The component's own comment claims the prompts are context-aware and never wrong. They are wrong in
exactly this state. A judge without Instagram links to hand can also burn the free lifetime
generation just to see anything at all.

**The template, from OpenAI's own apps.** [WanderNote](https://developers.openai.com/showcase/wandernote)
and the rest of the [showcase](https://developers.openai.com/showcase/) share one structure: an
artifact the human sees, that the agent mutates in place. Its literal on-screen copy —
*"Your agent is invited"*, *"It can suggest plans, read your notes, and make thoughtful changes"*,
*"Your edits are protected. Your agent can't overwrite them."* — plus a **pre-seeded, partially
planned demo trip** so a first-time visitor has something to collaborate on.

**Confirmed on the judged surface, 2026-08-29 ~00:00 GMT+8.** Shaun ran it in ChatGPT desktop's
built-in browser against an empty library. Asked *"What can I do here?"*, the agent called
`get_app_state` and replied:

> "Right now you have no saved Reels or trips, so **start by pasting up to five Instagram
> Reel/post links**. […] You can also use Trails to revisit trips, New trail to start over, and
> Settings for your account."

**The agent sent the user to the form.** Then `list_saved_reels` answered *"No saved reels yet. Use
save_reels with Instagram Reel links to add some."* — an instruction the user cannot follow without
leaving to find Instagram URLs, which the agent cannot do for them.

That is item 2 stated by the product itself, in the agent's own words, on the surface judges use.
The empty state has **no path forward that does not route through the manual UI**, and
`get_app_state` currently narrates the app's navigation chrome (Trails, New trail, Settings) rather
than what the pair can do together.

**Done when:** an empty `/app` leads with the invitation and a runnable prompt, one click opens a
seeded trip with real evidence quotes and pins — no Instagram URL required, no generation spent —
and `get_app_state` offers a next action the agent can *take*, not a button to go press.

## 3. Persistent receipts + undo

`AgentActivityRail` drops entries after `FADE_AFTER_MS = 8_000` and keeps five. It is described as
an audit log; it is a toast. Convert to a per-trip "what changed" panel: what changed, when, by whom
(you / Astrail), with **Undo** on reversible operations — `tools/edit.ts:14` already documents
`move_place` as trivially undoable, so the inverse op is nearly free.

This is the most-cited pattern in the practitioner literature under three names: Action Audit & Undo
([Smashing](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)),
Action Receipts ([Hatchworks](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/)), Footprints
([Shape of AI](https://www.shapeof.ai/)).

Also incomplete: `add_place`, `set_trip_dates` and `replan_trip` are missing from `LABELS`
(`WebMcpRegistry.tsx:10`) and fall back to a generic "WORKING".

## 4. Tool-contract gaps + a truthful SUBMISSION.md

**Judges open the tool list before they touch the page.** ChatGPT renders an address-bar arrow —
gray when tools are available, blue while in use — opening to "Available site tools" with each
tool's name and whether it reads or changes things. **Tool names and descriptions are judged copy.**

Fix, in this order:

- `docs/webmcp/SUBMISSION.md:29` still says only four read-only tools exist and the rest is future
  work; `:39` says every tool is read-only; `:35` describes a registration hook the README says was
  removed. Judges may score from this document without opening the app. It currently **underclaims
  the work while contradicting the repo.** Rewrite it.
- `add_place` reads `args.trip_id`, but `trip_id` is not in its schema and `additionalProperties` is
  `false` (`tools/edit.ts:136,:149`) — registered globally, it cannot reliably target a closed trip.
- `get_map_view` claims to report the selected day and stop; it returns camera coordinates and trip
  size only (`tools/map.ts:116`).
- `get_app_state` knows the route and aggregate counts, not the `/app` workflow state — entering
  URLs, organizing, choosing places, waiting. All of those live privately in `SavedReelsFlow.tsx:24`
  and all report as "Saved Reels — where trips start" (`GlobalTools.tsx:25`).
- `README.md:90` still has demo-credential placeholders.

**Already correct, and worth saying out loud in the video:** the [current W3C draft](https://webmachinelearning.github.io/webmcp/)
keeps only `readOnlyHint` and `untrustedContentHint` — `destructiveHint`, `idempotentHint` and
`openWorldHint` were removed. Astrail uses exactly those two, and `map.ts:40` already documents why
`set_map_view` is deliberately **not** read-only. Chrome's
[best practices](https://developer.chrome.com/docs/ai/webmcp/best-practices) warn that the real risk
is tool *overlap*, not tool count — 16 well-separated tools is defensible.

## 5. Stretch — the note thread

`get_trip_notes` / `resolve_trip_note`. The human pins a note to a day or a stop ("day 2 is too much
walking", "one more coffee place"); the agent reads it, acts, and writes its reply back into the
thread **attributed to Astrail, never impersonating the user** (Margin Editor's rule). Renders as a
comment thread on each day card.

This is the single mechanic that converts "an agent operates my form" into "we are co-authoring one
document", and it is the most collaborative pattern published in this field.
**Store it in the existing trip JSONB, not a new table** — a table means migration + rollback script
+ load-bearing deploy order; JSONB means none of those.

---

## Stop claiming these until they are true

- *"We removed the need to find the button."* The primary screen is a URL form followed by several
  picker forms.
- *"The same generation state drives chat and page."* `lib/webmcp/generation.ts:10` says so in a
  comment; item 1 above is the proof that it does not.
- *"The agent understands where the user is."* `get_app_state` understands the route.
- *"The user watches the map while the agent builds the trip."* Agent-started generation never
  reaches `GenerationScene`.
- *"The activity rail is an audit log."* It is a fading tail of five.
- Reversibility. `remove_place` cannot be undone; `move_place` returns instructions for moving it
  back, not an undo control.

## Lead with these — they are genuinely strong

1. **The live-map tools.** `show_on_map` / `set_map_mode` operate the same in-page map state the
   human sees (`tools/map.ts:25`). A backend MCP server returning JSON provably cannot do this. It
   is the clearest WebMCP argument in the entry.
2. **Evidence.** The popup renders the verbatim caption quote as text, links the source Reel, and
   ties it to the visible stop (`TripMap.tsx:480`). Far more credible than "AI trip planning".
   `ItineraryCards.tsx:7-11` already renders `From reel` / `You asked` / `Astrail pick`.
3. **Editing a generated itinerary** — move, add, remove, re-route, re-narrate — is real
   collaboration, not summarization.
4. **The in-page approval gate** (`AgentConfirm.tsx:18`): visible, blocks costly execution, renders
   untrusted caption text as text.

## Do not build

- An in-page chat panel. The agent lives in ChatGPT's browser; a second chat competes with the
  judge's actual surface and reads as not trusting WebMCP. **Every OpenAI reference app avoids it.**
- An autonomy dial or graduated permissions — one confirm gate on the one costly action covers it.
- Multi-agent role cards, budget meters, CRDT multiplayer. Out of scale for ≤5 reels and ≤8 places.

## The tool surface — VERIFIED on the judged surface (2026-08-29)

The longest-open 🔴 is closed. In ChatGPT desktop's built-in browser, signed in, on `/app`:

- the **address-bar arrow appears**
- **"Available site tools" lists every tool** with its full description and `readOnlyHint` /
  `untrustedContentHint` annotations
- the on-page **WebMCP chip renders**
- read-only tools **execute and return** — `get_app_state` and `list_saved_reels` both answered

The descriptions read as prose written for a person, not as developer identifiers — which matters,
because a judge opens that list before touching the page.

**Correction: the count is 13 on `/app` and 16 on a trip page**, not the 10/13 recorded in
`T4-QUEUE.md:66`. The five edit tools were moved to global registration, so `globalTools` returns
13 and `tripTools` adds 3. Fix the doc before quoting a number at a judge.

## Also open, from earlier

- **`plan_trip_from_reels` has never been run through WebMCP.** Item 1 is what makes it worth
  running; it is also the demo video's spine.
- The generation progress bar pins at 93% for the whole wait — documented in
  `GenerationScene.tsx`, not fixed. It is the furthest stage *started*, never percent-complete.
- `WEBMCP_EDITS_ENABLED` defaults **off** in production. It gates five edit tools and spans both
  owner surfaces: backend goes first and is verified live before the UI is exposed.
- The weather warning says *"No forecast available this far ahead"* when the log shows an
  `HTTPStatusError`. The copy invents a specific, wrong reason.
