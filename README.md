# Astrail · WebMCP Challenge build

> This repository is the WebMCP Challenge build of Astrail — an experiment in planning trips with an agent, not a product you can sign up for.

Astrail turns Instagram Reel URLs into an evidence-backed travel itinerary on a Mapbox 3D map. Its existing pipeline extracts and verifies real places, deduplicates them, enriches the route, and attaches the source evidence to every stop. WebMCP changes the interface: an agent in ChatGPT's built-in browser can now inspect the signed-in page, start and follow a trip, retrieve its evidence, and operate the same live map and itinerary state the person is watching.

## Why this exists

The motivating feedback was direct: users said it is **“unclear how to navigate the website — where to click, how to choose the reels, how to start generating a trip.”** The challenge pivot is to stop making users find the button and let them say what they want. `get_app_state` is the first tool the agent can call. It reports the current route, what the user already has, what actions are available next, and known blockers without turning failed reads into misleading zero counts.

A backend MCP server could return JSON about a trip. WebMCP can also move the 3D map the person is actually looking at because its tools execute inside the page, inherit the browser session and loaded trip, and call the same React state setters as a click.

## WebMCP tools

The current code registers **16 tools**: 13 throughout the signed-in `/app` shell and 3 only while a trip map is mounted. The table is generated from the source — `grep -rn "name: '" frontend/lib/webmcp/tools/` returns exactly these.

| Tool | Scope | Reads / changes | Purpose |
|---|---|---|---|
| `get_app_state` | Global app | Reads page and session state | Explains where the user is, what they have, what is possible next, and what is blocked. |
| `list_trips` | Global app | Reads trips | Lists the user's trips with destination, dates, status, and a short trip ID. |
| `save_reels` | Global app | Changes Reel library | Validates and saves up to five Instagram Reel or post URLs, reporting each result. |
| `list_saved_reels` | Global app | Reads Reel library | Groups saved Reels by verified country and exposes the places needed to plan without re-pasting links. |
| `get_itinerary` | Global app | Reads a trip | Returns a compact day-by-day route with the same pin numbers the user sees on the map. |
| `get_place_evidence` | Global app | Reads evidence | Returns the verbatim Reel-caption quote, source URL, and confidence for one stop. |
| `plan_trip_from_reels` | Global app | Creates a trip | Shows an in-page approval card, starts the pipeline, and returns a trip ID without pretending generation is finished. |
| `get_trip_progress` | Global app | Reads generation state | Reports the live pipeline stage and elapsed time until the agent can fetch the itinerary. |
| `move_place` | Global app | Changes itinerary | Moves a stop to another day or position, refreshes the trip, and reports how to reverse the move. |
| `remove_place` | Global app | Changes itinerary | Requests explicit in-page approval, removes a stop, then warns that the remaining pins were renumbered. |
| `add_place` | Global app | Changes itinerary | Adds a stop the user asked for, recorded as `requested_by_you` with no invented evidence behind it. |
| `set_trip_dates` | Global app | Changes a trip | Moves the trip's dates, keeping day numbering and the itinerary intact. |
| `replan_trip` | Global app | Changes a trip | Re-routes the legs and re-narrates the days, so the prose matches the stops after edits. |
| `show_on_map` | Trip page | Changes visible map state | Flies the live camera to a trip, day, stop, or hotel-hub view and opens the matching panel. |
| `set_map_mode` | Trip page | Changes visible map state | Switches the live map between day-by-day route and hotel-hub views. |
| `get_map_view` | Trip page | Reads visible map state | Reports the current camera and trip size so the agent can ground words such as “here” or “up north.” |

**What has actually been run, and what has not.** `save_reels` and the extraction it starts are verified end to end against the live backend, including the per-reel progress the page shows while it runs. The edit tools (`move_place`, `remove_place`, `add_place`) have been exercised live through an agent against a real trip. `plan_trip_from_reels` is implemented, unit-tested and **not yet run end to end** — it spends real Apify and OpenAI credit, so it is the one path still marked unproven. `replan_trip` is in the same state.

The FastAPI endpoints behind the edit tools are protected by owner, pair, trip-status, running-job and dense-ordering guards, and `WEBMCP_EDITS_ENABLED` is **off by default** — the write surface 404s entirely unless a deployment opts in.

## How WebMCP is implemented

The browser primitive at the center of the integration is deliberately visible in this repository:

```ts
document.modelContext.registerTool({ name, description, inputSchema, execute })
```

The React implementation uses our own `useRegisterTool` hook ([`frontend/lib/webmcp/use-register-tool.ts`](frontend/lib/webmcp/use-register-tool.ts)) to make that native registration follow component lifecycle. We began on Chrome's [`use-webmcp-tool`](https://www.npmjs.com/package/use-webmcp-tool) and moved off it: that hook never catches the promise `registerTool` returns, and because aborting the signal is *how* a tool unregisters, every page navigation raised an unhandled `AbortError`. It cannot be fixed from the outside — `registerTool` is a non-writable property of a native interface, and an `unhandledrejection` listener loses to handlers registered earlier during bootstrap. Owning ~130 lines of registration was the smaller cost, and it keeps zero runtime dependencies. [`frontend/lib/webmcp/`](frontend/lib/webmcp/) contains the schemas, tool factories, resolution and formatting logic. [`frontend/components/webmcp/`](frontend/components/webmcp/) wires those factories to authenticated Supabase and backend clients, registers global tools in the app shell, mounts map tools only when a real trip map exists, and shows registration status in the WebMCP chip. Tool callbacks read through refs so a long-lived registration sees the current route, trip, and map rather than first-render state.

Every string derived from an Instagram caption is treated as untrusted content. Read tools declare `untrustedContentHint`, URL-writing tools validate Instagram origins before making a request, and destructive removal requires a visible user approval card.

## Run locally

Prerequisites: Node.js with npm, Python 3.11+, [`uv`](https://docs.astral.sh/uv/), a Supabase project, and a public Mapbox token.

Create `frontend/.env.local` with these browser-safe values:

```dotenv
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN=pk.your-public-token
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Then start the two services in separate terminals:

```bash
# Terminal 1: API
cd backend
uv sync
uv run uvicorn main:app --reload

# Terminal 2: web app
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A real generation needs valid backend credentials for Supabase, Apify, and OpenAI; unit tests do not make those network calls.

## Test in ChatGPT

> **Filled in at submission:** the live URL and the judge account below are placeholders until the
> challenge deployment exists. They are the two things this section cannot be followed without.

- **Live URL:** `<filled at submission>`
- **Judge account:** `<filled at submission>` — email and password. There is no OAuth in the judged
  path: Google refuses OAuth inside embedded browsers, so Astrail ships a plain password sign-in
  for this.

Then:

1. Open the URL in the **ChatGPT desktop app's built-in browser** — not Safari, not Chrome. Site
   tools do not exist anywhere else.
2. Select **GPT-5.6 Sol or Terra**. Luna has WebMCP disabled, and site tools are unavailable in
   Enterprise or Edu workspaces.
3. Turn on **Settings › Browser › Permissions › Enable site tools**.
4. Sign in with the judge account. Two redirects to expect, both normal:
   `/app` sends you to `/sign-in` while signed out (`frontend/middleware.ts:36`), and a brand-new
   account is sent once through `/app/onboarding` before `/app` opens (`:42`). The judge account is
   pre-onboarded, so you should land on `/app` directly.
5. Click the **Site tools** arrow in the address bar → **Available site tools**. You should see
   **13** tools, and **16** once a trip is open. The on-page **WebMCP chip** shows the same count.
6. Then, in chat:
   - *"What can I do here?"* → `get_app_state`
   - *"Plan me 3 days in Osaka, 14-16 March, from these reels: …"* with any 1-5 public Instagram
     Reel links. They do **not** need to be saved first. Approve the card that appears on the page.
   - *"Why is stop 1 on this trip?"* → the verbatim caption quote and the Reel it came from.
     Ask about any pin you can see; pin numbers are whatever the trip produced. A stop Astrail
     suggested rather than took from a Reel answers with its reasoning and a research link
     instead, and says so — that is the tool being honest, not failing.
   - *"Show me day 2 in 3D"* and *"move stop 7 to day 3"* → the map changes in front of you

The five edit tools require `WEBMCP_EDITS_ENABLED=true` on the deployment; they return 404 when it
is unset.

### Nothing to sign in to, nothing spent: `/app/trip/demo`

`/app/trip/demo` is a finished Tokyo trail rendered from a fixture. It is the one route that opens
with **no account** — allowlisted by exact match in `frontend/middleware.ts:39`, verified against a
production build with zero cookies — so a judge can see the map, the pins and the evidence without a
credential, and without spending a generation.

Six tools are offered there, and all six answer: `get_app_state`, `get_itinerary`,
`get_place_evidence`, `show_on_map`, `set_map_mode` and `get_map_view`. Ask *"what can I do here?"*
first — signed out, `get_app_state` says you are on the public sample trail, lists exactly those
six, and states that saving Reels, planning and editing need an account rather than letting the
agent discover that by failing. The edit tools deliberately **cannot** see this trip — it has no database row, and a
reader that could return it to a write tool would be a way to pretend an edit had happened. Ask
*"why is stop 1 here?"* and you get a verbatim caption quote and a real Instagram Reel, both checked
against the captured scrape in `backend/evals/fixtures/japan_demo_reels.json` by a test.

## Submission documentation

- [Devpost submission answers](docs/webmcp/SUBMISSION.md)
- [What is new vs pre-existing](docs/webmcp/WHATS-NEW.md)

## Name

**Astrail = Astra + Trail**

Meaning: **star path, guided route**.

The name reflects the product direction: helping travelers move from scattered inspiration to a guided path they can actually follow.

## Product Direction

Astrail is not just a chatbot beside a map. The agent is the operating layer that helps transform intent into an explainable, mapped travel plan.

Core product ideas:

- collect scattered travel inspiration from social links and saved places
- extract real destinations, activities, constraints, and preferences
- build a route that is spatially and temporally realistic
- explain why each stop belongs in the trip
- support human-approved booking and payment flows later

## Reference Implementation

The earlier TripCanvas project is used as a reference implementation only. Astrail is the new canonical product identity and repository.

## Status

The core product predates the challenge. The browser-side WebMCP layer, its tool and contract tests, and the guarded itinerary edit endpoints were added during the challenge period. See the [dated eligibility record](docs/webmcp/WHATS-NEW.md) for the exact split.

---

## Backend API Reference (for the frontend)

Base URL: the Render backend service (set as `NEXT_PUBLIC_BACKEND_URL`; `http://localhost:8000` in local dev).

**Split of responsibilities:**
- **Writes / orchestration / streaming → this backend** (`POST /generate-trip`, `GET /generate-trip/stream/...`).
- **Finished-trip reads (list + itinerary detail) → Supabase-direct under RLS.** There are **no backend `GET /trips` endpoints** — the frontend reads trips straight from Supabase with the user's session (RLS enforces ownership). Use the anon key only; the `service_role` key must never reach the browser.

### Auth
Every non-infra endpoint requires the Supabase session **`access_token`** (a JWKS-verified JWT from `supabase.auth.getSession()`).
- `POST /generate-trip` → header `Authorization: Bearer <access_token>`.
- SSE stream → query param `?token=<access_token>` (EventSource can't set headers; a header is also accepted as fallback).

### Error envelope
**Every** error response (401/404/422/429/500, and framework 404/405) has this exact shape — read `error.message`, not `detail`:
```json
{ "error": { "code": "rate_limited", "message": "..." } }
```
Common `code` values: `unauthorized` (401), `not_found` (404), `validation_error` (422), `rate_limited` (429), `internal_error` (500).

### Rate limits (on `POST /generate-trip`)
- **Burst:** 3 requests/minute per user.
- **Daily:** 5 trips/user/day (durable).
- Both return **429** with `code: "rate_limited"`. Distinguish them by the `Retry-After` header:
  - **Burst** 429 carries `Retry-After: <n>` (seconds until the 1-min window resets; 1–60, not a fixed 60) + `X-RateLimit-*`.
  - **Daily-cap** 429 has **no** `Retry-After`; message is `"Daily trip limit reached. Try again tomorrow."`

---

### `POST /generate-trip` — start trip generation
Auth: **required** (Bearer). Idempotent: the same request replays the same `trip_id` instead of creating a duplicate.

**Request body** (`application/json`):

| Field | Type | Required | Notes |
|---|---|---|---|
| `reel_urls` | `string[]` | ✅ | 1–5 Instagram Reel URLs |
| `start_date` | `string` | ✅ | ISO date, e.g. `"2026-08-01"` |
| `end_date` | `string` | ✅ | ISO date, e.g. `"2026-08-05"` |
| `destination_hint` | `string \| null` | — | optional free-text hint (e.g. `"Tokyo"`) |
| `pace` | `string` | — | default `"balanced"`; max 32 chars (unknown values accepted, not 422'd) |
| `preferences` | `string \| null` | — | free-text taste; max 2000 chars |

```json
{
  "reel_urls": ["https://instagram.com/reel/abc", "https://instagram.com/reel/def"],
  "start_date": "2026-08-01",
  "end_date": "2026-08-05",
  "destination_hint": "Tokyo",
  "pace": "relaxed",
  "preferences": "loves ramen, quiet neighborhoods, avoid theme parks"
}
```

**Response** `200` — returns the trip id to stream:
```json
{ "trip_id": "9c1e…" }
```
Then open the SSE stream below with that `trip_id`.

**Multiple reels:** pass 1–5 URLs in `reel_urls`; each is scraped + extracted independently, then places are **deduped and combined into one multi-day itinerary** (day assignment is geo-based). *Verified live: `[DWtlEw5D9zs, demo]` → "Come On" (Itabashi) + "Tokyo Dream Park" (Ariake) on separate days, each with real coords + evidence.* A reel that yields no verifiable place is skipped; if **no** reel yields one, the run ends with an error result (no hallucinated stops — guardrail #1).

**Errors:** `401` (missing/invalid token), `422` (bad body), `429` (burst or daily cap — see above), `500` (`{"error":{"code":"internal_error", ...}}`; quota is auto-refunded on failure).

---

### `GET /generate-trip/stream/{trip_id}` — progress + final itinerary (SSE)
Auth: **required** via `?token=<access_token>`. Owner-checked (`404` if the trip isn't yours).
`Content-Type: text/event-stream`.

Each event is a `data:` line whose JSON has `{ type, stage, msg, content }`:
```
data: {"type":"stage","stage":"scrape","msg":"scraping reels","content":{...}}

: heartbeat

data: {"type":"result","stage":"save","msg":"done","content":"<final itinerary as a JSON STRING>"}

data: [DONE]
```

**Contract (important):**
- Progress events have `type` = a stage name (`scrape`, `extract`, `enrich`, `narrate`, …); their `content` is a JSON object.
- The **terminal** event has `type: "result"` and its **`content` is a JSON string** (parse it again) holding the final itinerary. On timeout the backend still emits a terminal `result` with `content` = `{"error":"generation timed out"}` (as a string).
- The stream **always** ends with a `result` event followed by `data: [DONE]`. Treat `data: [DONE]` as the close signal. Lines starting with `:` are heartbeat comments — ignore them.
- A pre-open failure (bad/missing token, not owner) returns the **error envelope** (JSON), not an SSE stream.

---

### `GET /health` — liveness (no auth)
Render's deploy gate. Always cheap, never touches the DB.
```json
{ "status": "ok" }
```

### `GET /readiness` — deep readiness (no auth)
Confirms Supabase is reachable and reports mem0's **configuration** state (monitoring only — **not** the deploy gate).
- `200` → `{ "ready": true, "mem0": "configured" | "disabled" | "init_failed" | "not_initialized" }`
- `503` → `{ "ready": false, "mem0": … }` (DB unreachable — `mem0` is still reported)

`mem0` is observed, never probed: `configured` means a key is set and the client was built, **not** that mem0 is reachable right now. `disabled` = no key · `init_failed` = key set but construction failed · `not_initialized` = key set, not yet constructed. A mem0 outage never fails readiness (guardrail #3).

### `GET /settings/preferences` — the user's saved mem0 memories (auth)
Read **live** from mem0 for the caller's own user (id comes from the token — you cannot read another user's memory). Rate-limited per user like the other authed routes.
```json
{ "status": "ok",
  "facts": [ { "id": "…", "memory": "User prefers ramen and quiet, walkable days",
               "created_at": "2026-07-07T03:08:44", "source": "mem0" } ] }
```
- `status: "ok"` → mem0 answered. **`facts: []` with `ok` is a legitimate empty memory, not an error** — render "nothing saved yet", not a failure.
- `status: "disabled"` → no `MEM0_API_KEY`; memory is off by configuration.
- `status: "unavailable"` → mem0 errored, timed out, or the client failed to construct. Render "memory unavailable", not "you have no preferences".

Always `200` — a memory outage must not break the settings screen (guardrail #3). Mirrors `SettingsPreferencesResponse` in `frontend/lib/trip/backend-types.ts`.

**These are STORED memories, not a preview of recall.** Generation recalls via a semantic `search(top_k=10)` and only when the user leaves preferences blank, so this list is a superset, differently ordered. Facts are mem0's own prose — deliberately **not** the structured `UserPreferenceFact` shape, because mem0 returns sentences and synthesising `fact_key`/`confidence` would be inventing data.

> `POST /settings/memory/clear` (PRD §18) is **not implemented yet**. Until it ships, a "Clear memory" control has no backend — do not wire one to a mock that reports success.

---

> Full FE↔backend production contract (incl. the go-live checklist for wiring the real client) lives in [`docs/CONNECTION-CONTRACT.md`](docs/CONNECTION-CONTRACT.md). Backend response shapes mirror `frontend/lib/trip/backend-types.ts`.

---

## How generation works (the deployed flow)

`POST /generate-trip` returns a `trip_id` immediately and runs the pipeline as a durable background job; the client watches progress over the SSE stream. Each stage is an SSE `stage` event:

1. **create_trip** — persist the trip + run inputs (recovery replays from here).
2. **scrape** — fetch each Reel's caption + transcript via Apify. Write-through cached in `reel_cache`; a re-run of the same Reel emits `cache_hit` and skips scrape+extract.
3. **extract** — pull candidate places from the caption/transcript (OpenAI). Every place must verify (real `lat`/`lng` + evidence) or it is **dropped — no hallucinated places** (guardrail #1). If nothing verifies, the run ends with an error `result` (`"no verified places after extraction"`) rather than inventing stops.
4. **dedup → narrate (assemble)** — the deterministic spine geo-orders places into day groups + feasibility warnings (e.g. `empty_day` when a day has no stops).
5. **enrich** (best-effort, parallel) — weather, transport, restaurants, hotels, LLM narration; any one may fail without failing the trip (guardrail #3).
6. **save** — terminal `result` event, then `data: [DONE]`.

**SSE `result` vs the DB — important for the frontend:**
- The `result` event's `content` is the **deterministic skeleton**: `days` (with `place_names`), `feasibility_warnings`, and a **fixed placeholder `title` = `"Tokyo (offline pipeline skeleton)"`** (the eval-anchored spine). **Do not render `result.itinerary.title` to users.**
- The **real** narrated `title`/`summary` and the **evidence-backed places** (name, `lat`/`lng`, `evidence_json` with the caption quote + research source) persist to Supabase (`trips`, `places`, `trip_places`); the frontend reads them **Supabase-direct under RLS**.

**Reel content requirement:** extraction reads the Reel's **caption + Apify transcript**. Reels that **name places in the caption** (or carry a 📍 location tag / a transcript) extract cleanly; a generic teaser with no named place and no transcript correctly yields zero places → an error result. *(Verified live: a reel captioned `📍 … Come On, Itabashi, Tokyo` extracted the place with matching coords; a generic "best Tokyo restaurants" teaser with an empty transcript produced none.)*

## Backend smoke tests (`backend/scripts/`)

Each self-loads `backend/.env`. Set `SMOKE_BASE_URL` to target a deployed service; omit it to drive the app in-process.

| Script | Proves | Credit |
|---|---|---|
| `smoke_http.py` | health · readiness · CORS · 401 · burst-429 vs quota-429 (self-provisions a throwaway JWKS user with `SMOKE_PROVISION=1`, then deletes it) | none |
| `smoke_quota_rpc.py` | the daily-quota RPC via the real PostgREST `.rpc()` path (non-destructive, net-zero) | none |
| `smoke_generate.py` | one-shot **real** generation end-to-end (POST → SSE → itinerary + evidence-backed places) | **spends Apify + OpenAI** |

```bash
# HTTP surface against the deployed service (zero-credit):
cd backend && SMOKE_BASE_URL=https://astrail-backend.onrender.com SMOKE_PROVISION=1 \
  uv run python -m scripts.smoke_http

# One real generation against the deployed service (spends credits):
cd backend && SMOKE_BASE_URL=https://astrail-backend.onrender.com \
  REELS=https://www.instagram.com/reels/<id>/ uv run python -m scripts.smoke_generate
```
