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
have the signed-in session, the `TripBundle` in memory, which day is selected and whether a
generation is still running. A remote server would have to maintain a second, staler copy of all of
that.

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

**Being honest about how far that has got.** Tool registration, the address-bar list and the read
tools are verified on the judged surface, in ChatGPT desktop's built-in browser. A full generation
has *not* been run there — it is implemented, unit-tested and exercised against the real backend,
and that is the honest state. The screen has caught up since: an empty `/app` now leads with the
agent and a one-click starter prompt rather than a paste-a-URL form.
What genuinely works today is everything downstream of a trip existing.

## 3. What can people and agents do together that was difficult or impossible before?

**Restructure an itinerary conversationally, and watch the map redraw.**

Before this work the generated trip was frozen. Not "hard to edit" — there was no edit path at any
layer: no endpoint, no frontend mutation, and Supabase RLS was `SELECT`-only. An agent that
understood "day 2 is too packed" could only describe what the user should do.

Now: `move_place`, `remove_place`, `add_place`, `set_trip_dates` and `replan_trip` change the real
itinerary through owner-checked FastAPI endpoints, routes recompute, and the map redraws. Each
mutation resolves only once the UI reflects it — when the agent says "done, it's on day 3", the map
has already flown there.

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

**Spending and irreversible actions get an in-page approval card.** `plan_trip_from_reels`,
`add_place`, `remove_place` and `replan_trip` render a card and await a click before anything is
spent or destroyed. The summary — including any free-text preferences — is rendered as **plain text,
never innerHTML**, so a prompt-injected caption cannot dress itself up as interface chrome.

Two honest limits on that sentence. `save_reels` can start a paid extraction **without** a card — it
is bounded instead by URL validation, a per-account daily limit, and a cache that never re-analyses a
reel. And the `{signal}` passed at registration governs the tool's registration lifetime, not the
pending card: an agent abort does not currently dismiss an open approval.

**Output is budgeted against what actually ships.** `fit.ts` measures
`JSON.stringify(envelope).length`, not `text.length`, because the MCP content envelope costs ~40
characters and every newline becomes two escaped ones. It degrades at whole-day boundaries rather
than truncating mid-day. `resolve.ts` maps a pin number to a stop and returns candidates instead of
guessing when a name is ambiguous.

**The registration gate is a test.** `spec-contract.test.ts` enforces unique snake_case names,
description and parameter limits, structural schema validity, required annotations, non-overlapping
scopes, and the serialized envelope budget against a real fixture — because a silently rejected
registration is an *absent tool*, and a judge would find it before we did. The synthetic 40-stop
budget cases live beside it in `fit.test.ts` and `format.test.ts` rather than inside the gate. The
suite is **1181 tests**.

## What a judge can do, and what state each path is in

**The journey, in order.** Open the live URL in ChatGPT desktop's built-in browser on GPT-5.6 Sol or
Terra, signed in with the supplied credentials. Click the **Site tools** arrow in the address bar and
open **Available site tools** — 13 are listed on the app, 16 once a trip is open. Then, in chat:

1. *"What can I do here?"* — `get_app_state` reports where you are and what is available next.
2. *"Plan me 3 days in Osaka, 14-16 March, from these reels: …"* — paste any 1-5 public Instagram
   Reel links. They do **not** need to be saved first. An approval card appears on the page; nothing
   is spent until you accept it. The wait screen then takes over the browser and the map fills in as
   places are verified.
3. *"Why is stop 4 on this trip?"* — `get_place_evidence` returns the verbatim caption quote and the
   Reel it came from.
4. *"Show me day 2 in 3D"*, *"move stop 7 to day 3"*, *"add Osaka Castle to day 1"* — the map and the
   itinerary change in front of you, and the reply names `replan_trip` when the day summaries have
   fallen behind the stops.

**State of each path.** Stated plainly, because a claim a judge can disprove costs more than a
limitation we name.

| | Path | State |
|---|---|---|
| ✅ | Tool registration, the address-bar list, annotations | **Live-verified** in ChatGPT's built-in browser |
| ✅ | `get_app_state`, `list_saved_reels` | **Live-verified** — executed and returned |
| ⚙ | `plan_trip_from_reels` end to end, and the page takeover it drives | **Implemented and unit-tested; one live run outstanding** |
| ⚙ | `replan_trip`, `set_trip_dates` | Implemented and unit-tested; not live-run |
| ⚠ | The five edit tools | Require `WEBMCP_EDITS_ENABLED=true` on the deployment |
| ✅ | The signed-in landing screen | An empty account now leads with the agent and a starter prompt; the paste box is the fallback, not the front door |
| ✅ | `/app/trip/demo` | A fixture-backed sample trail, reachable with **no account** — five tools answer there, and the edit tools deliberately cannot see it |

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
