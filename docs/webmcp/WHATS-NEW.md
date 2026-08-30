# What is new for the WebMCP Challenge

Astrail existed before the WebMCP Challenge submission period. This document separates the established product from work built for the challenge, so judges can evaluate the WebMCP extension on its own.

**Everything in the "Built for the challenge" section below was written on or after 26 Aug 2026, on the `feat/webmcp` branch.** The branch history is the evidence: `git log --since="2026-08-26"` on this branch is the challenge work, end to end.

## Pre-existing (before 25 Aug 2026)

Before the challenge, Astrail was already a working travel-planning application. The following are **not** claimed as hackathon work:

- Instagram Reel ingestion and scraping (Apify, direct HTTP), caption and transcript collection.
- Place extraction from Reel content, canonical place matching, deduplication, and confidence-backed evidence records.
- Place enrichment — geocoding through Mapbox Search Box, weather, transport routing, restaurant
  grounding, and hotel search via Travala. **Hotel search stopped working during the challenge
  window** — see "Honest limits" below.
- Itinerary generation, day grouping, routing, trade-off handling, and generated trip narration.
- The Next.js 15 / React 19 application: saved-Reels flow, trip creation, trip pages, and the surrounding UI.
- The Mapbox GL 3D map, trip pins, routes and day views.
- The FastAPI generation backend, its durable job pipeline, recovery sweep, SSE streaming and persistence layer.
- The Supabase schema, authentication, cookie sessions, ownership rules and row-level security.

These are the foundation the challenge work exposes as a shared human-agent workspace. **The challenge did not build Astrail's scraper, planner, map, database or auth.**

## Built for the WebMCP Challenge (from 26 Aug 2026)

### The tool layer — 16 tools in two scopes

All of `frontend/lib/webmcp/` is new. Tools are registered through `document.modelContext.registerTool()`; 13 are available anywhere in the app, and 3 more appear only where a live map exists to drive.

| Tool | Scope | What it does |
|---|---|---|
| `get_app_state` | Global | Where the user is, what they have, and what can happen next. Built for the one thing testers kept reporting — that they could not tell where to click. |
| `list_trips` | Global | The user's trips, newest first. |
| `list_saved_reels` | Global | The saved-Reel library, so a trip can be planned without re-pasting links. |
| `save_reels` | Global | Saves up to 5 Instagram URLs **and starts extracting their places**, exactly as the app's own save button does. |
| `get_itinerary` | Global | A day-by-day itinerary keyed by the map's own pin numbers. |
| `get_place_evidence` | Global | Why a stop is there: the verbatim caption and its source Reel when it came from one, otherwise Astrail's reasoning or the traveller's own request. Links are labelled and optional. |
| `plan_trip_from_reels` | Global | Starts a real 60–180s generation, behind an on-page approval gate. |
| `get_trip_progress` | Global | Polls a running generation and narrates each stage. |
| `move_place` | Global | Moves a stop to another day or position. |
| `remove_place` | Global | Removes a stop, behind a confirmation. |
| `add_place` | Global | Adds a stop the user asks for. |
| `set_trip_dates` | Global | Changes the trip's dates. |
| `replan_trip` | Global | Re-routes and re-narrates so the prose matches the stops after edits. |
| `show_on_map` | Trip page | Flies the live map to a trip, day, stop or hotel hub. |
| `set_map_mode` | Trip page | Switches between the route view and the hotel hub view. |
| `get_map_view` | Trip page | Reads the current camera plus the trip's day and stop totals. It states plainly that it cannot see which day or stop is selected — the page does not expose it — rather than guessing at "this one". |

Supporting modules, all new:

- `types.ts` — the local descriptor, JSON Schema, annotation and size-limit contracts.
- `fit.ts` — budgets the **serialized envelope**, not the raw string, and drops only whole blocks.
- `resolve.ts` — maps a visible pin number or unambiguous name to a trip place, refusing ambiguous matches.
- `format.ts` — compact itinerary output carrying pin numbers and provenance.
- `tools/index.ts` — assembles the two scopes from live readers, so no tool can act on stale state.
- `__tests__/spec-contract.test.ts` — makes the registration rules executable: unique names, schema validity, descriptor limits, annotations, output budget, scope separation.

### Registration and visibility

`components/webmcp/` is new: `WebMcpRegistry` (what is registered, and the page hooks tools call to make the UI catch up), `GlobalTools`, `TripTools`, `AgentConfirm` (the approval gate), the activity rail that shows **every** agent action including reads, and the availability chip.

`lib/webmcp/use-register-tool.ts` is a hand-written replacement for Chrome's `use-webmcp-tool`. That hook never caught `registerTool`'s promise, and since aborting the signal is how a tool *unregisters*, every navigation threw an unhandled `AbortError` over the app. It could not be fixed from outside — `registerTool` is non-writable, and a listener loses to Next's own handler — so registration is owned here.

### Backend

- Owner-checked, flag-gated edit endpoints: `POST /trips/{id}/places`, `PATCH`/`DELETE /trips/{id}/places/{tp_id}`, `PATCH /trips/{id}`, `POST /trips/{id}/replan`. All gated by `WEBMCP_EDITS_ENABLED` — note the flag makes the **endpoints** 404, it does not hide the tools, which stay registered either way — all 404-not-403 on a foreign trip, all refusing an unfinished trip or one with a running job, all resequencing days so pin numbers stay hole-free.
- `evidence_json.source_reel_url` — the field that records **which Reel** a stop came from. `source_url` is the research page by construction, so before this the Reel had nowhere to live.
- `genagents/restaurant_details.py` — opening hours and official websites for restaurant suggestions, via a separate web-search agent whose input is exclusively Mapbox-sourced, keeping the labeller's no-tool property intact.
- Email/password sign-in and env-driven demo credentials, so judges never meet an OAuth redirect.
- `backend/test_webmcp_edits.py` — network-free guard and mutation coverage for the whole edit surface.

### The map, rebuilt so it is worth driving

An agent moving a map the user is watching is the point of the entry, so the map had to be worth watching:

- Teardrop pins carrying **the source Reel's own cover frame** as evidence, with a numbered badge and a label chip. Stops with no Reel behind them get one universal placeholder — never a borrowed photograph.
- Evidence popups that answer "why is this on **my** trip", not "what is this place": position in the day, how you arrive, what to eat nearby, the verbatim caption, and a link to **the Reel** rather than a scraped directory page.
- "Where to eat" as findable pins with their own cards — cuisine, address, why it was picked. ("Where to stay" was built the same way and still renders for trips generated while Travala worked, but no new trip has hotels — see "Honest limits".)
- Day-coloured routes, 3D buildings, and a selected-place camera that leaves room for the card.

### Safety posture

- Every caption-derived output carries `untrustedContentHint`; Reel captions are attacker-controlled third-party text.
- No tool accepts or returns an access token; no arbitrary-URL fetch; no account-lifecycle tools; no raw SQL surface.
- `save_reels` validates against an Instagram allowlist **before** any request — a tool that fetches a URL lifted from a caption is an SSRF primitive by construction.
- Planning a trip, and anything that cannot be undone, stops for on-page approval with the request rendered verbatim first. `save_reels` is the one paid action that does not ask: it is bounded by a daily limit and never re-analyses a Reel already in the library.
- Where a fact does not exist, nothing is shown in its place: no invented opening hours, no borrowed photographs, no Reel cited for a stop that did not come from one.

## Challenge commit record

The complete record is the branch. `docs/webmcp/RUNLOG.md` is the append-only narrative, including the incidents.

```
git log --oneline --since="2026-08-26" feat/webmcp
```

Representative deliveries, in order:

| Commit | Delivery |
|---|---|
| `5c79928` | Branch foundations — LICENSE, run log, output-budget helper |
| `3aa738b` | Output budget + pin-number resolver |
| `4e8e325` | Tool registry and the spec contract test |
| `775563b` | Owner-checked trip-place edit endpoints behind the flag |
| `a3bc559` | Global tool registration in the app shell + availability chip |
| `e2c3cf8` | `save_reels` |
| `8476cdb` | Data tools registered globally, not scoped to the trip page |
| `e953802` | Async generation — start, poll, approval gate |
| `1beb1a8` | `move_place` and `remove_place` |
| `12c53ea` | `show_on_map`, `set_map_mode`, `get_map_view` |
| `e59760c` | `add_place` and `set_trip_dates` |
| `e6d4e18` | `replan_trip` |
| `7390947` | Own the registration — the `AbortError` that could not be fixed from outside |
| `cac5617` | Password sign-in and demo credentials for judges |
| `95d8f50` | Record which Reel a place came from |
| `8ebf5d2` | Teardrop pins carrying the Reel cover as evidence |
| `e8e852c` | Per-place Reel attribution, found by querying live rows |
| `6d2f305` | "Where to eat" / "Where to stay" suggestion cards |
| `830941b` | Web-searched opening hours, evidence-gated |
| `e8849ef` | Agent-started extraction shown live, derived not persisted |
| `d14552d` | Six defects a cross-model review found in that same batch |
| `aaaea61` | The wait screen went quiet for 140 of its 147 seconds |
| `a1036fc` | Say what a plan will cost before the user approves it |
| `060d17d` | Pins had never landed during a generation — dedup fires 59 lines before persistence |
| `290c265` | The agent's trip takes over the screen |
| `78dee85` | The pre-POST race closed after four cross-model rounds |
| `7a4202b` | A successful route could still report failure |
| `f9882da` | An empty account leads with the agent, not a paste box |
| `d2f638c` | Starter-prompt dates come from the clock, in UTC — they were 77 days out and forecast-less |
| `27dc7b2` | The map tools promised four things the map never does |
| `656fc7b` | A sample trail a judge can open with no account and nothing spent |
| `d7b3514` | That sample trail actually reachable signed-out, exact-match only |
| `ec06e6c` | The evidence tool cited the research page, not the Reel — and the fixture cited three Reels that do not exist |
| `213d4e9` | `get_trip_progress` answered about whichever run the browser held, whatever trip you asked about |
| `0ab99d7` | The signed-out sample trail advertised 16 tools; 11 of them could not work |
| `2ff76d6` | The orientation tool restored to the free path, with an answer true for someone with no account |
| `38d31bd` | Stop telling a signed-in judge they planned a trip nobody planned |
| `b8f8183` | Trip labels made status-aware, so the agent stops offering edits the backend will refuse |
| `22339cc` | A disabled edit surface no longer reads as a missing trip |

## Honest limits

Stated here rather than left for a judge to find:

- **Cross-tab Reel reading, if demonstrated, is ChatGPT's browser orchestration — not a WebMCP capability.** A site's tools belong to the page that registered them and do not follow the agent to another tab. `save_reels` receives an array either way.
- **Opening hours are unavailable for most Japanese venues.** Measured, not assumed: Mapbox returns empty POI metadata for 20 of 20 restaurants near the Osaka trip we measured against. The enrichment returns nothing rather than inventing something.
- **Hotel search is currently unavailable, and trips return no places to stay.** Travala's Travel
  MCP was a keyless public endpoint when this was built. It now requires OAuth — it has renamed
  itself "Travala **Wallet** MCP" and every call returns `401 invalid_token`, including `initialize`
  and `tools/list`. Verified against the live endpoint on 2026-08-30.

  We chose not to wire it. Its dynamic registration refuses `client_credentials` outright
  (*"grant_types may contain only authorization_code and refresh_token"*), so the only path is a
  human browser login storing a personal refresh token — on a wallet product whose scopes include
  `mcp:book` and `mcp:pay`. Binding a demo to one person's payment-capable credential, days before
  judging, to fill one panel, is a trade we declined.

  Nothing pretends otherwise: the hub toggle disables itself when no hotel has coordinates, and both
  map tools say so in as many words rather than flying the camera to nothing — *"no hotel on this
  trip has a location yet, so the map has nothing to draw."*
- **Hotel results were always search only.** No booking, no payments, and the card said so.
- **`replan_trip` has not been run against a live trip.** It is implemented and unit-tested; that is the honest state.
