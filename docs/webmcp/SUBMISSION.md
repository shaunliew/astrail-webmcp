# Astrail WebMCP Challenge submission

Astrail turns Instagram Reel URLs into an evidence-backed travel itinerary on a Mapbox 3D map.
Next.js 15 + React 19 on the front, FastAPI behind it, Supabase for trips, evidence, durable jobs
and authenticated user data.

**16 WebMCP tools** — 13 available anywhere in the signed-in app, 3 more that exist only where a
live map does. 7 read, 9 write.

## 1. Why is this use case a strong fit for WebMCP?

A backend MCP server can return JSON describing a trip. It cannot move the map the traveller is
looking at.

That is the whole argument, and Astrail is built so it is literally true. `show_on_map` and
`set_map_mode` call the same state setters a click calls, on the same Mapbox instance already
rendered on screen (`frontend/lib/webmcp/tools/map.ts`). The agent does not describe a change and
ask the person to reproduce it — the camera flies, the pin grows, the day chip turns brass.

The tools also inherit context instead of rebuilding it. They run inside the page, so they already
have the signed-in session, the `TripBundle` in memory, the camera the traveller is actually looking
at, and whether a generation is still running. A remote server would have to maintain a second,
staler copy of all of that.

Where that inheritance stops is stated in the tool rather than papered over. The page does not hand
the tools which day or stop is *selected* — `MapDeps` carries the setters and the camera, not the
selection (`frontend/lib/webmcp/tools/map.ts:17`) — so `get_map_view` says so in its own description
and tells the agent to ask which stop "this one" means instead of guessing at it.

And the agent's vocabulary is the user's vocabulary. Tools address stops by **map-pin number** —
the numbers the traveller can see. "Move stop 7 to day 3" means the same thing to both parties. No
trip-place UUID enters the agent's vocabulary at all; a trip id remains the trip-level handle, and
`list_trips` returns it shortened.

## 2. How does it create a better user experience?

The clearest feedback Astrail ever got was not about itinerary quality:

> "It's unclear how to navigate the website — where to click, how to choose the reels, how to start
> generating a trip."

The usual fix is better affordances. WebMCP allows a different one: stop making the user find the
button. `get_app_state` reports where they are, what they have, and what is available next, so an
agent can answer "what can I do here?" and then do it.

**Being honest about how far that has got.** Two different claims get called "verified", so this
document separates them and keeps the same words for them everywhere below.

- **In the judged browser** — driven by an agent in ChatGPT desktop's built-in browser, against a
  backend running on `localhost`. This is where all of the work below has been exercised.
- **On a judged URL** — the same thing against the deployment a judge would open. **Nothing has
  been run on a judged URL, because that deployment does not exist yet.** Every claim on this page
  is the first kind.

In the judged browser, the arc runs end to end. **Upstream:** `save_reels` through the agent — the
reel is saved, extraction starts, the card moves Queued → Analyzing while you watch, and verified
places land with no manual refresh anywhere. **The middle:** a full generation, approval card before
anything is spent, real stage narration, the map on completion; measured at 123.5 seconds, of which
restaurant enrichment is roughly 94%. **Downstream:** reading the trip, its evidence, the map, and
the edits — including `replan_trip` rewriting the trip title, the day titles and both day summaries,
checked in the database rather than taken from the reply.

Two tools are still unproven and marked as such in the table below: `move_place` and
`set_trip_dates` are unit-tested only. The screen caught up alongside: an empty `/app` now leads
with the agent and a one-click starter prompt rather than a paste-a-URL form.

## 3. What can people and agents do together that was difficult or impossible before?

**Restructure an itinerary conversationally, and watch the map redraw.**

Before this work the generated trip was frozen. Not "hard to edit" — there was no edit path at any
layer: no endpoint, no frontend mutation, and Supabase RLS was `SELECT`-only. An agent that
understood "day 2 is too packed" could only describe what the user should do.

Now: `move_place`, `remove_place`, `add_place`, `set_trip_dates` and `replan_trip` change the real
itinerary through owner-checked FastAPI endpoints, routes recompute, and the map redraws. Each
mutation resolves only once the write has landed AND the page has been refreshed — and when that
refresh itself fails, the tool says the page may still be showing the old order rather than claiming
otherwise. When the agent says "done, it's on day 3", the
route has already been redrawn on screen. (The edit tools redraw; they do not move the camera. Only
`show_on_map` flies it, and that is a separate tool on purpose.)

**Ask why a place is on your trip, and get the receipt.** `get_place_evidence` returns the
*verbatim* caption quote from the Instagram Reel the place came from, that Reel's URL on its own
labelled line, and a confidence. Where Astrail suggested a stop rather than lifting it from a Reel,
it says so and returns its reasoning plus a research link — it does not dress a suggestion up as
evidence. Every stop carries provenance the traveller can check: `From reel` / `You asked` /
`Astrail pick`. This is what separates it from generic "AI trip planning" — nothing on the map is
there because a model felt like it.

## 4. How did you implement WebMCP?

**We register directly against the platform API.** `frontend/lib/webmcp/use-register-tool.ts` calls
`document.modelContext.registerTool(tool, { signal })` itself. We started on Chrome's
`use-webmcp-tool` hook and removed it: it could not fix an `AbortError` on unregistration from
outside, and patching the platform object broke `/app` entirely. Owning the ~140 lines was the
smaller risk.

**Two scopes, by lifetime.** `globalTools()` registers 13 in the app shell, which survives
client-side navigation. `tripTools()` registers 3 map tools inside the trip page, so they unregister
via `AbortController` when the user leaves — the agent is never offered a map tool where no map
exists. Opening a trip takes the count from 13 to 16 live.

**Annotations are current with the spec.** The W3C draft now keeps only `readOnlyHint` and
`untrustedContentHint`; `destructiveHint`, `idempotentHint` and `openWorldHint` were removed. We use
exactly those two. `show_on_map` and `set_map_mode` are deliberately **not** read-only —
`readOnlyHint` should mean "safe to call speculatively without the user noticing", and a camera
flying across the globe is extremely noticeable.

**`untrustedContentHint` is literally true here.** Reel captions are attacker-controlled third-party
text, and every tool whose output can carry a caption-derived string is annotated. `save_reels` runs
`normalizeReelUrl()` *before* any request — a tool that fetched a URL lifted from a caption would be
an SSRF primitive by construction. No tool takes or returns an access token, and there is no
arbitrary-fetch, navigate, or raw-SQL tool at any price.

**Spending and irreversible actions get an in-page approval card.** Every tool that changes a trip,
plus the one that creates one — `plan_trip_from_reels`, `move_place`, `add_place`, `remove_place`,
`set_trip_dates` and `replan_trip` — renders a card and awaits a click before anything is spent or
destroyed. `move_place`
was the last to get one, and not because moving a stop became irreversible: every edit now starts a
summary rewrite, so a cardless move spent an LLM call with nothing on screen having asked. Its card
says so, because a consent card that does not name what it is consenting to is decoration. The
summary — including any free-text preferences — is rendered as **plain text, never innerHTML**, so a
prompt-injected caption cannot dress itself up as interface chrome.

Three honest limits on that sentence.

- `replan_trip` skips the card on one branch, deliberately: when it is *joining* a rewrite an edit
  has already started. That work is running and cannot be called back, so a card there would offer
  a choice that does not exist, and answering "no" would be followed by the summaries changing
  anyway. It starts nothing and spends nothing extra, and the reply names which branch it took.
- `save_reels` can start a paid extraction **without** a card — bounded instead by URL validation, a
  per-account daily limit, and a skip for reels already done. The skip keys on the reel being fully
  organized, so a reel saved earlier that never made it through extraction **is** queued again.
- The `{signal}` passed at registration governs the tool's registration lifetime, not the pending
  card: an agent abort does not currently dismiss an open approval. And there is no undo control
  anywhere in the surface — `move_place` reports where a stop came from so the move can be reversed
  by asking, but a stop can have had no recorded position at all, and the reply says that rather
  than promising an exact restoration.

**Output is budgeted against what actually ships.** `fit.ts` measures
`JSON.stringify(envelope).length`, not `text.length`, because the MCP content envelope costs ~40
characters and every newline becomes two escaped ones. It degrades at whole-day boundaries rather
than truncating mid-day. `resolve.ts` maps a pin number to a stop and returns candidates instead of
guessing when a name is ambiguous.

**The registration gate is a test.** `spec-contract.test.ts` enforces unique snake_case names,
description and parameter limits, structural schema validity, required annotations, non-overlapping
scopes, and the serialized envelope budget against a real fixture — because a silently rejected
registration is an *absent tool*, and a judge would find it before we did. The synthetic 40-stop
budget cases live beside it in `fit.test.ts` and `format.test.ts` rather than inside the gate.

The suite is deliberately not quoted here as a number — a count in a document is a claim nobody can
check, and it was wrong within a day of being written. Run it instead; both halves are network-free
and need no API key:

```bash
cd frontend && npx vitest run     # tool, contract, formatting and component tests
cd backend  && uv run pytest -q   # pipeline, endpoints and the edit surface
```

## What a judge can do, and what state each path is in

**If you only have two minutes, start signed out.** `/app/trip/demo` is a finished Tokyo trail
rendered from a fixture and it opens with **no account and nothing spent** — allowlisted by exact
match in `frontend/middleware.ts:40`, verified against a production build with zero cookies. Ask
*"why is stop 1 here?"* and you get a verbatim Instagram caption quote and the Reel it came from,
both checked against our captured scrape by a test. The map tools drive the map while you watch.
The edit tools deliberately cannot see this trip: it has no database row, and a reader that could
hand it to a write tool would let the agent pretend an edit had happened.

**The journey, in order.** Open the live URL in ChatGPT desktop's built-in browser on GPT-5.6 Sol or
Terra, signed in with the supplied credentials. Click the **Site tools** arrow in the address bar and
open **Available site tools** — 13 are listed on the app, 16 once a trip is open. Then, in chat:

1. *"What can I do here?"* — `get_app_state` reports where you are and what is available next.
2. *"Plan me 3 days in Osaka, 14-16 March, from these reels: …"* — paste any 1-5 public Instagram
   Reel links. They do **not** need to be saved first. An approval card appears on the page; nothing
   is spent until you accept it. The wait screen then takes over the browser and the map fills in as
   places are verified.
3. *"Why is stop 1 on this trip?"* — `get_place_evidence` returns the verbatim caption quote and the
   Reel it came from. Ask about any pin you can actually see: pin numbers are whatever the trip
   produced, and a stop Astrail suggested answers with its reasoning instead of a Reel.
4. *"Show me day 2 on the map"*, *"move stop 2 to day 1"*, *"add Osaka Castle to day 1"* — the map and the
   itinerary change in front of you. Do **not** then ask for a replan: every edit now starts the
   summary rewrite itself, the reply carries `summaries_rewriting: true` and tells the agent not to
   call `replan_trip`, and the activity rail shows the rewrite land ~30s later. `replan_trip`
   remains for the one case the agent must still act on — prose stale with no rewrite running.

**State of each path.** Stated plainly, because a claim a judge can disprove costs more than a
limitation we name. Every "live-run" below means *in the judged browser, against a local backend*,
in the sense defined in §2 — no row here is a claim about a deployed URL.

| | Path | State |
|---|---|---|
| ✅ | Tool registration, the address-bar list, annotations | **Live-verified** in ChatGPT's built-in browser |
| ◐ | `get_app_state`, `list_saved_reels` | Executed and returned in ChatGPT's built-in browser on 29 Aug — but `get_app_state` was **rewritten after** that run (signed-out variant, trip-status labels), so what was verified is not quite what ships. `list_saved_reels` is unchanged since |
| ✅ | `plan_trip_from_reels` end to end, and the page takeover it drives | **Live-run 2026-08-30** — approval card before spend, real stage narration, map on completion |
| ✅ | `replan_trip` | **Live-run 2026-08-30** — after an add and after a remove; rewrote the trip title, day titles and day summaries, checked in the database |
| ✅ | `add_place`, `remove_place` | **Live-run 2026-08-30** through the agent, each with its on-page approval |
| ⚙ | `move_place`, `set_trip_dates` | Implemented and unit-tested; not live-run |
| ⚠ | The five edit tools | Require `WEBMCP_EDITS_ENABLED=true` on the deployment |
| ✅ | The signed-in landing screen | An empty account now leads with the agent and a starter prompt; the paste box is the fallback, not the front door |
| ✅ | `/app/trip/demo` | A fixture-backed sample trail, reachable with **no account** — six tools are offered and all six answer, and the edit tools deliberately cannot see it |

## Where this sits against WebMCP's own example

OpenAI's site-tools documentation gives as its canonical illustration *"a travel planner that lets
the agent compare options and update an itinerary while you inspect the map."* Astrail implements
that interaction — and then extends it with the parts the example does not reach: untrusted
social-video input, per-stop evidence lineage back to a caption, a 60-180 second generation pipeline
behind a tool call that returns in one second, and owner-checked conversational restructuring of a
trip that was, until this work, frozen at every layer.

The alignment is evidence of fit. The Reel-to-evidence pipeline and the shared visible map are the
part nobody else is doing.

Open work is tracked in `docs/webmcp/AGENT-FIRST.md`; every run is logged in `docs/webmcp/RUNLOG.md`;
what is new for this challenge versus pre-existing is documented in `docs/webmcp/WHATS-NEW.md`.
