# CLAUDE.md

> Engineering handoff doc for the Astrail repo. Single canonical reference for Claude Code and Codex sessions. Read this before touching any code. Companion to PRD.md (what to build) and DESIGN.md (how it looks).

## What Astrail is

AI-native travel planner. User pastes 1-5 Instagram Reel URLs + dates + budget + origin + free-text preferences. A parallel agent pipeline extracts places, enriches them with research, fetches weather, suggests restaurants, computes transport between places, narrates a day-by-day itinerary, and produces an orchestrator summary. Every recommendation surfaces evidence (source Reel, caption quote, research URL). Rendered as a Mapbox 3D map with agent reasoning panels.

**Pitch:** "Astrail turns scattered travel inspiration into the route you actually take."

**What changed from TripCanvas hackathon:**
- No hotels in v1 — all hotel logic removed. Returns in Phase 1.4 with Travala MCP.
- No payments in v1 — all AP2/x402 code removed. Payment seam in `legacy/` for future revival.
- Auth + persistence added — Clerk for Google OAuth, Convex for DB and realtime.
- Reel scraping is direct HTTP — no Agents SDK, no MCP in the scrape loop.
- New agents — Restaurant, Transport, Orchestrator summary.
- Two cache layers — Reel-level cache + place-level semantic dedup (the data flywheel).

## Stack (locked — do not substitute)

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + Tailwind v4 |
| Map | Mapbox GL JS 3.24.0 — 3D tilted globe → city map |
| Frontend hosting | Vercel |
| Auth | Clerk (Google OAuth only in v1) |
| DB + realtime + vector search | Convex |
| Backend | FastAPI (Python ≥3.14) + Server-Sent Events |
| Backend hosting | Fly.io (always-on, no cold sleep) |
| LLM SDK | OpenAI Agents SDK |
| Primary LLM | `gpt-5.5-2026-04-23` |
| Fallback LLM | `gpt-4o` (typed `_MODEL_ERRORS` fallback) |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims) |
| Reel scraping | Apify HTTP API — **direct HTTP, no MCP, no Agents SDK** |
| Weather | Open-Meteo HTTP (free, no auth) |
| Transport routing | Mapbox Directions API |
| Python package manager | `uv` (pyproject.toml at repo root, not `backend/`) |

**Banned / never reintroduce:**
- react-pageflip, flipbook, pop-up book UI
- Google Maps, MapLibre, Three.js (Mapbox 3D only)
- Duffel (deprecated, fully removed)
- yt-dlp, ffmpeg, audio transcription
- Google Places API
- `requirements.txt` (use pyproject.toml + uv)
- Any hotel-related code (Phase 1.4 territory)
- Any payment-related code (Phase 1.4 territory)
- MCP + Agents SDK for the Apify scrape loop (costs 10-15s/reel for no functional gain)

## Project Structure

```
astrail/
├── pyproject.toml                  # PROJECT ROOT (not backend/)
├── CLAUDE.md                       # THIS FILE — read first
├── AGENTS.md                       # thin pointer to CLAUDE.md
├── PRD.md                          # product requirements (beta v1)
├── DESIGN.md                       # UX/UI spec (separate workstream)
├── README.md
├── .env.example
├── Dockerfile                      # Fly.io deploy target
├── fly.toml
│
├── backend/
│   ├── main.py                     # FastAPI app, routes, CORS
│   ├── auth.py                     # Clerk JWT validation
│   ├── convex_client.py            # HTTP actions wrapper
│   ├── api/
│   │   ├── schemas.py              # request/response models
│   │   └── streaming.py            # SSE helpers, stage event emitters
│   ├── scrape/
│   │   ├── apify_direct.py         # Direct HTTP Apify (no LLM)
│   │   └── reel_url.py             # URL normalization + validation
│   ├── agents/
│   │   ├── place_extractor.py      # per-reel extraction (LLM)
│   │   ├── place_enricher.py       # research + summary + evidence
│   │   ├── weather.py              # Open-Meteo agent
│   │   ├── restaurant.py           # NEW — restaurant suggestions
│   │   ├── transport.py            # NEW — Mapbox Directions legs
│   │   ├── narrator.py             # day-by-day itinerary assembly
│   │   └── orchestrator.py         # NEW — read-only summary agent
│   ├── pipeline/
│   │   ├── runner.py               # 4-phase parallel orchestration
│   │   ├── cache.py                # Reel + place cache (via Convex)
│   │   └── dedup.py                # semantic place dedup
│   ├── models/
│   │   ├── trip.py                 # ItineraryOutput, ItineraryDay, DayStop
│   │   ├── place.py                # PlaceResult, EnrichedPlace, CanonicalPlace
│   │   ├── reel.py                 # ReelData
│   │   ├── enrichment.py           # WeatherReport, RestaurantSuggestion, TransportLeg
│   │   ├── summary.py              # OrchestratorSummary
│   │   └── prefs.py                # UserPreferences
│   └── tests/
│
├── convex/
│   ├── schema.ts                   # see PRD §5.1
│   ├── users.ts
│   ├── trips.ts
│   ├── reelCache.ts
│   ├── places.ts                   # vector search lives here
│   ├── generationEvents.ts
│   └── http.ts                     # HTTP actions called by FastAPI
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx              # ClerkProvider + ConvexProvider
│   │   ├── page.tsx                # / landing
│   │   ├── sign-in/page.tsx
│   │   └── app/
│   │       ├── page.tsx            # /app — new trip
│   │       ├── trip/[tripId]/page.tsx
│   │       ├── trips/page.tsx
│   │       └── settings/page.tsx
│   ├── components/
│   │   ├── map/TripMap.tsx
│   │   └── trip/
│   │       ├── ReelInputPanel.tsx
│   │       ├── GenerationTimeline.tsx
│   │       ├── AgentDecisionRail.tsx
│   │       ├── ItineraryCards.tsx
│   │       ├── DaySelector.tsx
│   │       ├── PlaceIntelPanel.tsx
│   │       ├── RestaurantStrip.tsx     # NEW
│   │       ├── TransportStrip.tsx      # NEW
│   │       └── OrchestratorSummary.tsx # NEW
│   └── lib/trip/
│       ├── api.ts
│       ├── sse.ts                  # SSE parser (port from hackathon)
│       ├── backend-types.ts        # TypeScript mirror of Pydantic models
│       ├── types.ts
│       └── normalize-trip.ts
│
└── legacy/                         # READ-ONLY reference
    └── tripcanvas-hackathon/       # full hackathon codebase
                                    # never import in production code
```

## SSE Stream Contract

Termination is non-negotiable:
```
data: {"type": "result", "content": "<final JSON string>"}\n\n
data: [DONE]\n\n
```

Frontend breaks on `data: [DONE]`. Error paths also terminate with `[DONE]`.

Stage events (additive — frontend tolerates unknown types):
```
{"type": "stage", "stage": "scrape"|"cache_hit"|"extract"|"enrich"|"weather"|"restaurants"|"transport"|"narrate"|"summarize", "msg": "..."}
{"type": "heartbeat", "elapsed_s": 23.4}
```

**Adding new stage events is non-breaking. Renaming existing ones is breaking — coordinate with frontend.**

## Environment Variables

Backend (required):
```
OPENAI_API_KEY
APIFY_TOKEN
CLERK_SECRET_KEY
CONVEX_DEPLOYMENT_URL
CONVEX_DEPLOY_KEY
MAPBOX_ACCESS_TOKEN
```

Backend (optional, with defaults):
```
EXTRACTION_TIMEOUT=80
PIPELINE_TIMEOUT=180
HEARTBEAT_INTERVAL=5
SEMANTIC_DEDUP_THRESHOLD=0.85
PLACE_LATLNG_DISTANCE_M=500
MAX_PLACES_PER_TRIP=8
MAX_REELS_PER_REQUEST=5
REEL_CACHE_TTL_DAYS=30
```

Frontend:
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_CONVEX_URL
NEXT_PUBLIC_MAPBOX_TOKEN
NEXT_PUBLIC_BACKEND_URL    # defaults to http://localhost:8000
```

**Removed from hackathon (do not reintroduce):** `USE_CACHE`, `DEMO_REEL_URLS`, `DEMO_REEL_URL`, all `AP2_*`/`X402_*` vars, `DUFFEL_TEST_TOKEN`, `BOOKING_AID`, `USE_MOCK_PAYMENT`.

## API Endpoints

Public:
- `GET /health`

Authenticated (Clerk JWT required):
- `POST /generate-trip` — accepts preferences + reelUrls, creates Convex trip, returns `{tripId}`
- `GET /generate-trip/stream/:tripId` — SSE stream
- `GET /trips/:tripId`
- `DELETE /trips/:tripId`

Most read operations go directly to Convex from the frontend via reactive queries. FastAPI exists for the agent pipeline (long-running SSE) and external API calls requiring the Python SDK.

## The 4-Phase Pipeline

```python
async def run_generation_pipeline(trip_id, reel_urls, preferences, event_emitter):

    # PHASE 1: SCRAPE — parallel per reel, direct HTTP
    cache_results = await check_reel_cache(reel_urls)
    uncached_scraped = await asyncio.gather(
        *[scrape_reel_direct(url) for url in uncached_urls]
    )

    # PHASE 2: EXTRACT + DEDUP
    extracted_per_reel = await asyncio.gather(
        *[extract_places_agent(rd) for rd in all_reel_data]
    )
    canonical_places = await semantic_dedup_against_cache(flatten(extracted_per_reel))

    # PHASE 3: ENRICH — 4 parallel agents
    enriched, weather, restaurants, transport = await asyncio.gather(
        enrich_places_agent(canonical_places),
        weather_agent(canonical_places, preferences),
        restaurant_agent(canonical_places, preferences),
        transport_agent(canonical_places),
    )

    # PHASE 4: NARRATE → SUMMARIZE (sequential, summarizer is read-only)
    itinerary = await narrator_agent(EnrichedContext(...))
    summary = await orchestrator_summary_agent(itinerary, enriched_context)
    return itinerary
```

**Key invariants:** phases are sequential; within each phase, operations run in parallel. The orchestrator is strictly read-only — it summarizes, never overrides.

## Place Cache Semantic Dedup (the data flywheel)

Two-gate matching per new place:
1. **Semantic gate**: Convex vector search, similarity ≥ 0.85
2. **Geographic gate**: haversine distance <500m

Both gates must pass to merge into an existing canonical record. Semantic-only would merge "Ichiran Shibuya" with "Ichiran Shinjuku." Lat/lng-only would miss "Senso-ji Temple" vs "浅草寺."

On match: append new evidence quote, increment `timesReferenced`. On miss: create new canonical record with embedding.

## Non-Negotiable Engineering Guardrails

1. **No hallucinated places.** Every PlaceResult must have lat, lng, and a verbatim evidence_caption_quote. Drop places that fail.
2. **No hidden chain-of-thought.** UI shows structured reasoning — never raw LLM thinking traces.
3. **Partial pipeline failure is acceptable.** Weather/restaurant/transport can fail; itinerary still renders.
4. **Schema parity.** Every Pydantic field has a TypeScript mirror in `backend-types.ts`. Ship both sides in the same PR.
5. **Auth on every endpoint.** No anonymous trip creation.
6. **Owner check.** Every trip read/write verifies `trip.userId === current_user.id`.
7. **Caches are write-through.** Persist before returning.
8. **No `requirements.txt`.** pyproject.toml + uv only.
9. **No `legacy/` imports.** Production code never imports from the hackathon folder.
10. **Direct HTTP for Apify.** Never reintroduce MCP + Agents SDK for scraping.

## Hard-Won Lessons from Hackathon (do not regress)

- `ModelSettings(tool_choice="required", parallel_tool_calls=True)` on the extractor — without `required`, model skips WebSearchTool and hallucinates coords.
- `_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)` — typed fallback to `gpt-4o`. Apply to every agent.
- `output_type` must be a Pydantic model, not a bare list.
- Pydantic lat/lng bounds: `ge=-90, le=90` and `ge=-180, le=180` — catches hallucinated coords.
- `evidence_caption_quote` must be verbatim substring of `caption + locationName`. Drop if not.
- `WebSearchTool` calls appear as `ToolSearchCallItem`, not `ToolCallItem`. Match both class-name patterns.
- Apify MCP `client_session_timeout_seconds` default is 5s — always too short. Irrelevant now (using direct HTTP), but note if SDK ever returns.

## Build Order (productionising from hackathon)

1. Repo scaffold: Next.js, FastAPI, Convex project, Dockerfile + fly.toml
2. Copy hackathon repo into `legacy/tripcanvas-hackathon/` — read-only reference
3. Convex schema from PRD §5.1
4. Clerk + Google OAuth + user sync webhook
5. Port TripMap from legacy, strip demo hacks
6. Port place extractor agent from `legacy/backend/spike_e2e.py`
7. Replace MCP scrape with direct Apify HTTP in `backend/scrape/apify_direct.py`
8. Port enricher, weather, narrator from legacy — strip hotel/flight references
9. Build restaurant agent
10. Build transport agent (Mapbox Directions API)
11. Build orchestrator summary agent
12. Build Reel cache (Convex)
13. Build semantic dedup (Convex vector search)
14. Wire 4-phase pipeline with asyncio.gather
15. SSE streaming endpoint with stage events
16. Frontend: port ReelInputPanel, GenerationTimeline, AgentDecisionRail
17. Frontend: new RestaurantStrip, TransportStrip, OrchestratorSummary
18. Trip persistence + trip list
19. Landing page, settings
20. Deploy: Vercel + Fly.io + Convex
21. Open beta

## Where the Strategic Context Lives

- `PRD.md` — beta v1 product requirements (this repo)
- `DESIGN.md` — UX/UI spec (this repo, separate workstream)
- EMDEE_DOCS `astrail/CONTEXT.md` — strategic source of truth
- EMDEE_DOCS `astrail/CONSTRAINTS.md` — bandwidth, budget, deadlines
- EMDEE_DOCS `astrail/DECISION GATE.md` — 2026-10-31 forcing function
- EMDEE_DOCS `astrail/DECISIONS LOG.md` — append-only decisions log

When in doubt about **what** to build: PRD.md. About **why**: CONTEXT.md. About **how**: you're here.
