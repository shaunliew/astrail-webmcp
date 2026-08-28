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
UUID crosses the boundary in either direction.

## 2. How does it create a better user experience?

The clearest feedback Astrail ever got was not about itinerary quality:

> "It's unclear how to navigate the website — where to click, how to choose the reels, how to start
> generating a trip."

The usual fix is better affordances. WebMCP allows a different one: stop making the user find the
button. `get_app_state` reports where they are, what they have, and what is available next, so an
agent can answer "what can I do here?" and then do it.

**Being honest about how far that has got.** The tools work — verified on the judged surface, in
ChatGPT desktop's built-in browser. The *screen* has not caught up: `/app` still leads with a
paste-a-URL form, so when asked "what can I do here?" the agent currently answers "start by pasting
Instagram links." That is tracked as open work in `docs/webmcp/AGENT-FIRST.md`, not claimed as done.
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
*verbatim* caption quote from the Instagram Reel the place came from, the source Reel URL, and a
confidence. Every stop carries provenance the traveller can check: `From reel` / `You asked` /
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
exactly those two. `set_map_view` is deliberately **not** read-only — `readOnlyHint` should mean
"safe to call speculatively without the user noticing", and a camera flying across the globe is
extremely noticeable.

**`untrustedContentHint` is literally true here.** Reel captions are attacker-controlled third-party
text, and every tool whose output can carry a caption-derived string is annotated. `save_reels` runs
`normalizeReelUrl()` *before* any request — a tool that fetched a URL lifted from a caption would be
an SSRF primitive by construction. No tool takes or returns an access token, and there is no
arbitrary-fetch, navigate, or raw-SQL tool at any price.

**Costly and irreversible actions get an in-page approval card.** `plan_trip_from_reels` spends the
user's trip allowance plus real Apify and OpenAI credit, so `execute()` renders a card and awaits a
click, wired to `{signal}` so an agent abort dismisses it. The summary — including any free-text
preferences — is rendered as **plain text, never innerHTML**, so a prompt-injected caption cannot
dress itself up as interface chrome.

**Output is budgeted against what actually ships.** `fit.ts` measures
`JSON.stringify(envelope).length`, not `text.length`, because the MCP content envelope costs ~40
characters and every newline becomes two escaped ones. It degrades at whole-day boundaries rather
than truncating mid-day. `resolve.ts` maps a pin number to a stop and returns candidates instead of
guessing when a name is ambiguous.

**The registration gate is a test.** `spec-contract.test.ts` enforces unique snake_case names,
description and parameter limits, valid schemas, required annotations, non-overlapping scopes, and
the serialized envelope budget against both a real fixture and a synthetic 40-stop trip — because a
silently rejected registration is an *absent tool*, and a judge would find it before we did. The
WebMCP and generation layers carry **283 tests**.

## Verified, and not

**Verified in ChatGPT desktop's built-in browser:** the address-bar tools arrow appears, "Available
site tools" lists every tool with its annotations, the on-page WebMCP chip renders, and read tools
execute and return.

**Not yet verified end to end on that surface:** `plan_trip_from_reels`, which spends real credit.
Open work is tracked in `docs/webmcp/AGENT-FIRST.md` and every run is logged in
`docs/webmcp/RUNLOG.md`. What is new for this challenge versus pre-existing is documented in
`docs/webmcp/WHATS-NEW.md`.
