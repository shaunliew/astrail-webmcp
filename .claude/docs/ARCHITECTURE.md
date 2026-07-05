# Astrail Architecture

> Extracted verbatim from `.claude/CLAUDE.md` on 2026-07-03 (backup:
> `.claude/backups/CLAUDE.md.2026-07-03.bak`). Read this BEFORE touching the backend
> pipeline, SSE streaming, API endpoints, or creating new files (the tree below says
> where things go).

## Project Structure

> This is the TARGET-STATE tree — use it to decide where NEW files go, not as an inventory
> of disk. Known differences today: `docs/PRD.md` (not root `PRD.md`), the DESIGN spec
> lives only in EMDEE `astrail/DESIGN.md`, and `HANDOFF.md`, `docker-compose.yml`,
> `frontend/middleware.ts`, and `frontend/components/landing/` exist but are not shown.

```
astrail/
├── CLAUDE.md                       # gstack enforcement (root)
├── AGENTS.md                       # thin pointer to CLAUDE.md
├── docs/PRD.md                     # product requirements (beta v1); UX/UI spec is EMDEE astrail/DESIGN.md
├── README.md
├── .env.example
├── Dockerfile                      # Render deploy target — multi-stage, non-root, $PORT bind, SIGTERM graceful shutdown
├── render.yaml                     # Render service config (replaces fly.toml)
│
├── backend/
│   ├── pyproject.toml              # backend Python deps (uv project — NOT repo root)
│   ├── main.py                     # FastAPI app, routes, CORS
│   ├── auth.py                     # Supabase JWT validation
│   ├── supabase_client.py          # Supabase Python client wrapper (DB / storage / RLS)
│   ├── jobs.py                     # durable jobs table: enqueue, idempotency keys, startup recovery sweep
│   ├── api/
│   │   ├── schemas.py              # request/response models
│   │   └── streaming.py            # SSE helpers, stage event emitters
│   ├── scrape/
│   │   ├── apify_direct.py         # Direct HTTP Apify (no LLM); opt-in transcript fallback
│   │   └── reel_url.py             # URL normalization + validation
│   ├── genagents/                  # LLM pipeline agents — renamed from `agents/`: the OpenAI Agents SDK shadows the top-level `agents` package
│   │   ├── place_extractor.py      # per-reel extraction (LLM)
│   │   ├── place_enricher.py       # research + summary + evidence
│   │   ├── weather.py              # Open-Meteo agent
│   │   ├── restaurant.py           # NEW — restaurant suggestions
│   │   ├── hotel.py                # NEW — Travala Travel MCP hotel/base suggestions (search only)
│   │   ├── transport.py            # NEW — Mapbox Directions legs
│   │   ├── narrator.py             # day-by-day itinerary assembly
│   │   └── orchestrator.py         # NEW — read-only summary agent
│   ├── pipeline/
│   │   ├── runner.py               # 4-phase parallel orchestration
│   │   ├── cache.py                # Reel + place cache (via Supabase Postgres)
│   │   └── dedup.py                # semantic place dedup (Supabase pgvector)
│   ├── models/
│   │   ├── trip.py                 # ItineraryOutput, ItineraryDay, DayStop
│   │   ├── place.py                # PlaceResult, EnrichedPlace, CanonicalPlace
│   │   ├── reel.py                 # ReelData
│   │   ├── enrichment.py           # WeatherReport, RestaurantSuggestion, TransportLeg
│   │   ├── summary.py              # OrchestratorSummary
│   │   └── prefs.py                # UserPreferences
│   └── tests/
│
├── supabase/
│   ├── config.toml                 # local dev + project config
│   └── migrations/                 # forward-only additive SQL (schema + RLS); see PRD §5.1
│                                   # tables: users, trips, reel_cache,
│                                   # places (pgvector), generation_events, jobs (durable)
│
├── frontend/
│   ├── app/
│   │   ├── layout.tsx              # Supabase provider (auth + realtime client)
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
│   │       ├── HotelSuggestionStrip.tsx # NEW (see build step 18)
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

## API Endpoints

Public:
- `GET /health`

Authenticated (Supabase JWT required):
- `POST /generate-trip` — accepts preferences + reelUrls, creates a Supabase trip row + enqueues a durable job, returns `{trip_id}` (snake_case, per the shipped `GenerateTripResponse`)
- `GET /generate-trip/stream/:tripId` — SSE stream
- `GET /trips/:tripId`
- `DELETE /trips/:tripId`

Most read operations go directly to Supabase from the frontend (Supabase JS client — RLS-protected queries + Realtime subscriptions). FastAPI exists for the agent pipeline (long-running SSE) and external API calls requiring the Python SDK.

## The 4-Phase Pipeline

Runs inside a **durable job**: write a `jobs` row before any work, key it with an idempotency key, stream progress over SSE, and re-sweep in-flight jobs on process startup (Render restarts must not orphan a run). Untrusted Reel content passes through Agents SDK input guardrails before extraction.

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

When caption + `locationName` from a reel yield too few places, the scraper re-runs that reel with `includeTranscript` and the extractor uses the Apify `transcript` field as an extra signal — opt-in, never always-on (protects perceived latency + Apify transcription cost).

## Place Cache Semantic Dedup (the data flywheel)

Two-gate matching per new place:
1. **Semantic gate**: Supabase pgvector search, similarity ≥ 0.85
2. **Geographic gate**: haversine distance <500m

Both gates must pass to merge into an existing canonical record. Semantic-only would merge "Ichiran Shibuya" with "Ichiran Shinjuku." Lat/lng-only would miss "Senso-ji Temple" vs "浅草寺."

On match: append new evidence quote, increment `timesReferenced`. On miss: create new canonical record with embedding.

## Build Order (productionising from hackathon)

1. Repo scaffold: Next.js, FastAPI, Supabase project, Dockerfile + render.yaml
2. Copy hackathon repo into `legacy/tripcanvas-hackathon/` — read-only reference
3. Supabase schema + RLS from PRD §5.1 (incl. durable `jobs` table + pgvector on `places`)
4. Supabase Auth + Google OAuth — RLS-backed user identity
5. Port TripMap from legacy, strip demo hacks
6. Port place extractor agent from `legacy/backend/spike_e2e.py`
7. Replace MCP scrape with direct Apify HTTP in `backend/scrape/apify_direct.py` (opt-in transcript fallback)
8. Port enricher, weather, narrator from legacy — strip flight/payment references
9. Build restaurant agent
10. Build hotel search agent via Travala Travel MCP (`travala_search_hotel`; optional `travala_search_package`; no booking/payment)
11. Build transport agent (Mapbox Directions API)
12. Build orchestrator summary agent
13. Build Reel cache (Supabase)
14. Build semantic dedup (Supabase pgvector)
15. Wire 4-phase pipeline with asyncio.gather, wrapped in the durable jobs layer
16. SSE streaming endpoint with stage events
17. Frontend: port ReelInputPanel, GenerationTimeline, AgentDecisionRail
18. Frontend: new RestaurantStrip, TransportStrip, HotelSuggestionStrip, OrchestratorSummary
19. Trip persistence + trip list
20. Landing page, settings
21. Wire memory (mem0), guardrails, rate limiting (slowapi + per-user quota), and result caching
22. Observability: Langfuse + Sentry + UptimeRobot; product analytics: PostHog
23. CI/CD: GitHub Actions → Vercel + Render; Supabase migrations applied on merge to `main`
24. Deploy: Vercel + Render + Supabase
25. Open beta
