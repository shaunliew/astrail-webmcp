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

## The product, stated properly (Shaun, 2026-08-29)

Everything below serves one shape, and the plan was under-encoding it:

> **The agent is the primary user of Astrail. The human inspects and steers.**

Concretely — the human talks to their agent, the agent operates Astrail. The human watches the trip
and the map appear, and adjusts it by *saying so*, not by clicking. Success is a session where the
user never types a Reel URL into Astrail at all.

That reframes two things:

- **The pain point is the copy-paste.** Astrail's whole premise is turning scattered Reels into a
  route you actually take, and the pasting was always the tax on that. The agent removes it — that
  is the WebMCP argument, not "we added tools".
- **The manual UI becomes an inspection surface**, not the primary path. It is not being demoted for
  neatness; it is being demoted because a human clicking through pickers is the workflow this
  product exists to end. It stays reachable because a judge may want it and because an agent cannot
  always help.

The test of every item below: **does it reduce what the human has to do by hand, or does it only
make the manual path prettier?**

## The one-line diagnosis

The trip page is genuinely agent-first. `/app` is not. A judge lands on a paste box, and the
agent-aware chrome is a dismissible corner dock while a manual library owns the screen. Worse, the
single sentence the whole submission rests on — *the agent moves the map the human is looking at* —
**cannot currently be demonstrated on the main path.**

## Status

| # | Item | Impact | Cost | Status |
|---|---|---|---|---|
| 1 | Connect agent generation to the page | Very high — Leverage, Execution, Creativity | 1–2 d | ✅ **done** — `78dee85`, 4 Codex rounds |
| 2 | Invited empty state + one-click seeded demo trip | High — Execution, Impact | ~1 d | ✅ **done** — empty state `f9882da`, sample trail `656fc7b`, reachable signed-out `d7b3514`, fixture re-sourced to real Reels `ec06e6c` |
| 3 | Persistent receipts + undo (replace the 8s fade) | High — Execution | ~1 d | ✅ **built on `wt/receipts`** (`1eb444e`) — **awaiting the owner's merge**, verified conflict-free |
| 4 | Tool-contract gaps + truthful SUBMISSION.md | Med-high Leverage, protects every score | <1 d | ✅ **done** — `get_map_view` overclaim `27dc7b2`, `get_app_state` rebuilt `2ff76d6`, the evidence-field bug `ec06e6c`, doc claims `4ab1722` + `1388445` |
| 2b | **Agent-first layout for `/app`** — the visual redesign | High — Execution, Creativity | ~1 d | ✅ **built on `wt/layout`** (`083eaeb`, dates `d9df9d9`) — **awaiting the owner's merge**, 4 hunks, all resolving toward layout |
| 2c | **Edits leave the trip's prose stale** — the agent is never told to replan | High — Execution, and it is a live bug | ~2 h | ✅ **done** — `78dee85` |
| 2d | **Pre-gate the agent path** — an exhausted account approves, then gets a silent 403 | High — a judge-facing failure | ~1 h | ✅ **done** — `78dee85` |
| 5 | `get_trip_notes` / `resolve_trip_note` (JSONB) | Highest Leverage + Creativity | ~1 d | ☐ **not started** — stretch, and now correctly out of scope |

**Every item except the stretch is built.** Two of them live on branches the owner has to merge;
`docs/webmcp/MERGE-PLAN.md` records the simulated result and the resolved build (112 files / 1242
tests, tsc clean, production build clean).

**This table was wrong for a day.** It listed 2, 2b, 3 and 4 as unbuilt long after they shipped,
which is worse than having no table: anyone reading it would have rebuilt finished work. Fixed
2026-08-30.

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

## 2b. Agent-first layout for `/app`

**Added 2026-08-29 on Shaun's call, and he is right that the plan was missing it.** Items 2 and 3
change *behaviour and copy*; neither restructures the screen. The information architecture still
puts the manual path first — a paste box and a library own the viewport while every agent-aware
component (`WebMcpStatus`, `WebMcpDock`, `ExamplePrompts`, `AgentActivityRail`) is a dismissible
corner dock.

That hierarchy is why the live test failed the way it did. With all 13 tools registered and
executing correctly, `get_app_state` still answered *"start by pasting up to five Instagram
Reel/post links"* and then listed Trails, New trail and Settings. **The agent described the screen
it was given.** No amount of tool work fixes that; the screen has to change.

Constraints, so this does not become a restyle:

- **Stay inside Night & Daybreak.** Brass accents, constellation pins, the existing tokens. This is
  a hierarchy change, not a new visual language.
- **Do not delete the manual path.** Demote it. A judge who wants to paste a URL must still be able
  to, and every existing test that drives the form must still pass.
- **No in-page chat panel.** The agent lives in ChatGPT's browser; a second chat competes with the
  judge's real surface, and every OpenAI reference app avoids one.
- **A static screenshot has to read as collaborative.** A judge may only ever see one, plus a
  3-minute video.

**Done when:** the primary position on an empty `/app` belongs to the invitation and something the
agent can act on; the paste box is reachable but secondary; and `get_app_state` describes what the
pair can do next rather than which buttons exist.

Research in flight — the layout, the demotion mechanics and the actual empty-state copy land here
when it returns.

## 2c. An edited trip still describes the old itinerary

**Reported from real use, 2026-08-29.** Shaun asked the agent to add Osaka Castle to a generated
trip. It was added — and the trip description and day plan still described the itinerary without it.
The stops changed; the prose did not.

`replan_trip` already does exactly this job. The defect is that **nothing tells the agent to call it
at the moment it matters.** Verified across all four mutation tools in `lib/webmcp/tools/edit.ts`:

- `move_place`, `remove_place`, `add_place`, `set_trip_dates` — **not one** mentions replanning, in
  its description or in its return value.
- `add_place` returns *"Pin numbers have shifted — call get_itinerary before using them again"*. It
  names one follow-up tool and stays silent about the stale prose.
- `replan_trip`'s own description says *"use this after adding, moving or removing stops"* — but an
  agent only reads that if it is already considering the tool. Right guidance, wrong place.

The fix is the pattern this codebase already established for the same problem: `plan_trip_from_reels`
returns `next_tool` as a **structured field**, with a comment recording that agents follow a
structured field far more reliably than the same instruction in prose. Do that, do not auto-replan —
`replan_trip` costs credit and owns its own approval card, so the agent must be told, not overruled.

Why this matters more than its size: in the product shape above, an edit *is* the human's whole
interaction. If the trip silently disagrees with itself afterwards, the collaboration is not
trustworthy, and a judge trying "add Osaka Castle" will see it immediately.

## 2d. The agent path is not entitlement-gated

`GlobalTools` registers `plan_trip_from_reels` unconditionally — it has no entitlement dependency,
unlike the manual flow which pre-renders `TrialExhaustedCard`. So on an exhausted account the judge
sees the approval card, **approves the spend**, and only then does the backend 403. The trial card
never renders; the tool returns `isError` and the activity rail marks it failed.

Approve-then-rejected is the worst failure available to us, because the user consented first and got
nothing back that explains why. Gate it before the approval card, and say which limit was hit.

## Judge access — decided 2026-08-29

- **Credentials, not Google OAuth.** Google returns `403 disallowed_useragent` for anything it
  classifies as an embedded user-agent, and nobody has documented how it classifies ChatGPT's
  built-in browser. Devpost has a dedicated credentials field; password sign-in already ships.
- **Several accounts, one per judge.** Quota is per account and the active-run lock is per browser
  session, so separate judges never contend for either.
- **Every account must be `plan='beta'`.** `TRIAL_LIFETIME_LIMIT = 1` means a `trial` account gets
  **one generation ever**, not one per day. This is the setting that silently kills a judge.
- **`DAILY_TRIP_QUOTA` is an env var, not per-user** (`backend/rate_limit.py:38`), read at call time
  and passed to the entitlement RPC. Raising it is a change to the hackathon Render service's env —
  which is exactly why the hackathon runs its own service: production keeps its own value.
- OpenAI credit is not a constraint (Shaun has plenty). Apify still is, but the 37 cached reels
  sidestep it — a generation from an already-read reel costs no Apify call and no analysis quota.

## `/qa` is waived for this sprint — deliberately, and here is the cost

Shaun's call, 2026-08-29. Recording what it buys and what it risks rather than just dropping it.

vitest runs on **jsdom, which has no layout engine** — no z-index, no stacking contexts, no paint.
So a test can prove an element is in the DOM and cannot prove a human can see it. That is not
hypothetical here: the implementer's first failure notice was a normal-flow `<p>` rendered before
`CountryTrays`, which is `fixed inset-0 z-50`. The test found it; a real user would have seen the
overlay. It is now a `z-[60]` toast, **and no automated check in this repo can confirm that.**

Waiving `/qa` means shipping visual-layer changes on inspection alone. Acceptable for a 4-day
hackathon where the judged surface is the tool list and the map — but any finding of the form "the
test says it renders" now carries an asterisk, and should be written as such rather than as proof.

## 3. Persistent receipts + undo

`AgentActivityRail` drops entries after `FADE_AFTER_MS = 8_000` and keeps five. It is described as
an audit log; it is a toast. Convert to a per-trip "what changed" panel: what changed, when, by whom
(you / Astrail), with **Undo** on reversible operations — `tools/edit.ts:14` already documents
`move_place` as trivially undoable, so the inverse op is nearly free.

This is the most-cited pattern in the practitioner literature under three names: Action Audit & Undo
([Smashing](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/)),
Action Receipts ([Hatchworks](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/)), Footprints
([Shape of AI](https://www.shapeof.ai/)).

~~Also incomplete: `add_place`, `set_trip_dates` and `replan_trip` are missing from `LABELS`
(`WebMcpRegistry.tsx:10`) and fall back to a generic "WORKING".~~ ✅ **Fixed on `wt/receipts`** —
its table covers all 16 tools where `main` has 5. Verified 2026-08-30 by diffing the two versions.
It lands with that merge; nothing to do on `feat/webmcp`.

## 4. Tool-contract gaps + a truthful SUBMISSION.md

**Judges open the tool list before they touch the page.** ChatGPT renders an address-bar arrow —
gray when tools are available, blue while in use — opening to "Available site tools" with each
tool's name and whether it reads or changes things. **Tool names and descriptions are judged copy.**

Fix, in this order:

- ~~`docs/webmcp/SUBMISSION.md:29` still says only four read-only tools exist...~~ ✅ **Done** —
  SUBMISSION was rewritten in `6354a60` and has since been audited against the code twice more
  (`4ab1722`, `d04cf25`). The line references in this bullet are pre-rewrite and no longer resolve.
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
- The weather warning says *"No forecast available this far ahead"* for **any** exception, not
  just the horizon one — `runner.py:357` catches bare `Exception` and emits that one message, so a
  timeout, a provider 500 or a DNS failure all get a confidently wrong reason. Verified 2026-08-30
  and deliberately NOT fixed before submission: the starter prompt is now 10 days out, inside
  Open-Meteo's ~16-day horizon, so a judge will not see it, and churning the generation runner the
  night before a deadline costs more than it buys. Fix it after.
