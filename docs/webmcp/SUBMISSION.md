# Astrail WebMCP Challenge submission

Astrail turns Instagram Reel URLs into an evidence-backed travel itinerary on a Mapbox 3D map. The frontend runs on Next.js 15 and React 19, the API runs on FastAPI, and Supabase stores trips, evidence, jobs, and authenticated user data.

## 1. Why is this use case a strong fit for WebMCP?

Travel planning is both conversational and visual. A backend MCP server could return JSON describing a trip, but it would be disconnected from the map the traveler is using. WebMCP tools run inside the active Astrail page. They can use the signed-in session, read the trip already loaded in memory, and call the same state setters that a click uses. That means an agent can inspect the current itinerary and, as the write tools are completed, move a stop, focus a pin, or change the map view in the page the person is watching.

This shared surface matters most on the 3D map. When the agent refers to stop 7, the traveler can see pin 7. When the agent moves that stop to another day, the itinerary and map can redraw together. A remote tool can describe that change. A WebMCP tool can make it visible in the working interface without asking the user to translate a chat response back into a series of clicks.

WebMCP also gives the tools the right context without duplicating it. Astrail already knows which trip is open, which stops are visible, which actions are valid, and whether generation is still running. The browser tool can read that live state instead of rebuilding a second, potentially stale model of the application on a separate server.

## 2. How does it create a better user experience?

The clearest feedback from Astrail users was not about itinerary quality. Users said it was unclear how to navigate the site: where to click, how to choose Reels, and how to start generating a trip. The interface exposed the workflow, but people still had to discover the right controls in the right order.

WebMCP changes the entry point from navigation to intent. A traveler can say, "What can I do here?" or "Plan five days in Tokyo from these Reels." The first tool, `get_app_state`, tells the agent where the user is, what they already have, what is blocked, and which actions are available next. The agent can explain the next step in Astrail's own vocabulary and, as action tools come online, perform it in the page.

The result is less hunting and less context switching. Users no longer need to learn the product's click path before they can express a travel goal. The existing interface remains visible and usable, so the agent guides rather than replaces it.

## 3. What can people and agents do together that was difficult or impossible before?

A traveler can bring scattered Instagram inspiration into one shared workspace. Astrail extracts places from the Reels, deduplicates them, preserves the caption evidence, enriches each place, and builds a routed itinerary. The agent can then discuss that itinerary with the traveler using the same day numbers and map-pin numbers shown on screen.

The collaboration loop is conversational and visible: ask why a place was included, inspect the verbatim source evidence, compare days, move a stop, remove a weak suggestion, and watch the route and 3D map update. The interaction design keeps actions attributed and presents mutations as reversible user-visible changes, so the traveler stays in control instead of approving an opaque batch operation.

Before this work, the main flow was fixed. A user pasted up to five Reel URLs by hand, waited about 90 seconds, and accepted the generated itinerary. The result was not editable at any layer. There was no edit endpoint, no frontend mutation path, and the relevant Supabase access was read-only. Even an agent that understood the request could only describe what the user should change.

The current hackathon build establishes the safe collaboration surface with four read-only tools: `get_app_state`, `list_trips`, `get_itinerary`, and `get_place_evidence`. It also adds guarded PATCH and DELETE endpoints for itinerary stops. The next tool set connects those foundations to saving Reels, starting and monitoring a trip, controlling the map, and moving or removing places.

## 4. How did you implement WebMCP?

The WebMCP layer lives under `frontend/lib/webmcp/`. Tool descriptors are plain TypeScript objects defined by `ToolSpec` in `frontend/lib/webmcp/types.ts`. Pure factories in `frontend/lib/webmcp/tools/app-state.ts` and `frontend/lib/webmcp/tools/trips.ts` create the four tools, while `frontend/lib/webmcp/tools/index.ts` separates always-available tools from tools that only exist while a trip page is open.

`frontend/components/webmcp/RegisterTools.tsx` is the React registration boundary. It gives each descriptor its own component and calls the `useWebMCP` hook from `use-webmcp-tool`. The hook manages registration and unregistration through `document.modelContext.registerTool()`, then normalizes the tool result into the content envelope expected by the browser. `frontend/components/webmcp/GlobalTools.tsx` wires the global tools to real route and trip data and mounts them for the signed-in app shell.

The factories receive reader functions instead of captured values, and the React wiring reads changing values through refs. An execution therefore sees the current route and trip data rather than a snapshot from the first render. Mounting and unmounting also control tool presence, so page-scoped tools disappear when the user leaves the page instead of remaining available with stale context.

Every current tool declares `readOnlyHint: true` and `untrustedContentHint: true`. That second annotation is deliberate: trip titles, place names, evidence quotes, and other strings may originate in an Instagram caption, so the agent must treat them as data rather than instructions.

`frontend/lib/webmcp/format.ts` produces compact agent-readable itinerary text. `frontend/lib/webmcp/fit.ts` measures the serialized tool-result envelope and keeps output within the browser budget without cutting a day in half. `frontend/lib/webmcp/resolve.ts` resolves a place from the same pin number shown on the map, or from an unambiguous name. It returns candidates instead of guessing when a name matches more than one stop.

`frontend/lib/webmcp/__tests__/spec-contract.test.ts` is the registration gate. It checks unique and valid tool names, description and parameter limits, declared required properties, annotations, output size, and non-overlapping global and trip scopes. Together with formatter, resolver, and budget tests, the WebMCP layer added 54 focused frontend tests.

`frontend/components/webmcp/WebMcpRegistry.tsx` tracks what is registered, and `frontend/components/webmcp/WebMcpStatus.tsx` exposes that state in the page. This gives users and judges visible confirmation that WebMCP is available and which tools the current page offers.

The write foundation is in `backend/main.py` and `backend/api/schemas.py`. It adds owner-checked PATCH and DELETE routes for trip places behind the default-off `WEBMCP_EDITS_ENABLED` flag. Each route verifies the authenticated owner, the `(trip_id, trip_place_id)` pair, an editable finished status, and the absence of a running generation job before writing. Successful edits densely resequence each affected day's `sort_order`. `backend/test_webmcp_edits.py` covers those guards and both mutation paths without making network calls.

## How to test

1. Open the ChatGPT desktop app and select GPT-5.6 Sol or GPT-5.6 Terra. GPT-5.6 Luna has WebMCP disabled.
2. Open **Settings > Browser > Permissions** and enable **Site tools**.
3. Open `[LIVE URL]` in ChatGPT's built-in browser. Do not open it in an external browser.
4. Sign in with the demo account below.
5. Look for the **Site tools** arrow in the browser address bar. Open it and confirm the Astrail tools are listed.
6. Start with: "What can I do in Astrail right now?" The agent should call `get_app_state`.
7. Open a completed trip and ask: "Show me the itinerary, then explain why stop 1 is included." The agent should call `get_itinerary` and `get_place_evidence` while the same trip remains visible on the map.

**Demo credentials:** `[EMAIL]` / `[PASSWORD]`
