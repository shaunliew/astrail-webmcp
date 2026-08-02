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
{"type": "stage", "stage": "create_trip"|"scrape"|"cache_hit"|"extract"|"preferences"|"dedup"|"enrich"|"weather"|"save"|"restaurants"|"hotels"|"transport"|"narrate"|"summarize", "msg": "..."}
{"type": "heartbeat", "elapsed_s": 23.4}
```

**Adding new stage events is non-breaking. Renaming existing ones is breaking — coordinate with frontend.**

## API Endpoints

Infra (unauthenticated by design):
- `GET /health` — dumb liveness; the Render `healthCheckPath` deploy gate (never touches the DB, so a DB blip can't fail a deploy).
- `GET /readiness` — deep probe (confirms Supabase reachable) + mem0's configuration state; monitoring only, NOT the deploy gate. `200 {"ready":true,"mem0":"configured|disabled|init_failed|not_initialized"}` / `503 {"ready":false,"mem0":…}` (mem0 is reported on the failure path too). `mem0` is **observed, not probed** — `mem0_status()` reads the singleton without constructing it, because `get_mem0_client()` retries an 8s blocking constructor after a failure and a polled probe must not amplify a mem0 outage. `configured` is a **configuration** claim (key set + client built), never a connectivity claim; mem0 is reported, never required (guardrail #3 — `MEM0_API_KEY` stays out of `REQUIRED_SECRETS`).

Authenticated (Supabase JWT, ES256/JWKS):
- `POST /generate-trip` — accepts `reel_urls` (1–5) + `start_date`/`end_date` + optional `destination_hint`/`pace`/`preferences`; creates a Supabase trip row + enqueues a durable job; returns `{trip_id}` (snake_case, per the shipped `GenerateTripResponse`). **Two-layer per-user rate limit:** slowapi in-memory burst (`3/minute`, keyed on `request.state.user_id`) + a durable daily quota (`5/day` via an atomic `security definer` RPC on `user_daily_usage`) → `429` on either (burst 429 carries `Retry-After`; daily-cap 429 does not).
- `GET /generate-trip/stream/:tripId` — SSE stream (query-param `?token=` auth for EventSource, header fallback; owner-checked).
- `GET /settings/preferences` — the caller's STORED mem0 memories, read live (PRD §18). `200 {"status":"ok|disabled|unavailable","facts":[{id,memory,created_at,source:"mem0"}]}`; always 200, `status` carries the bad news (guardrail #3). `ok` + `facts: []` is a legitimately empty memory, NOT an error. `user_id` is token-derived, so a cross-user read is structurally impossible. Facts are mem0's own prose — deliberately NOT the structured `UserPreferenceFact` shape, since synthesising `fact_key`/`confidence` would fabricate data (guardrail #1). `POST /settings/memory/clear` (PRD §18) is **not implemented yet**.
- `POST /trips/:tripId/feedback` — trip-level feedback only (`artifact_type='trip'`, `artifact_id` NULL); append-only (a resubmission inserts another row, no unique constraint); owner-checked in app code because service_role bypasses RLS. Body `{feedback_type: "rating"|"thumbs_up"|"thumbs_down"|"correction"|"free_text", rating?: 1–5, comment?: ≤2000}` with `extra="forbid"` (a client-supplied `user_id`/`artifact_type` is a `422`); `201 {"feedback":{id,trip_id,artifact_type,feedback_type,rating,comment}}`, `404` for a trip that is missing **or** not yours (never 403 — do not confirm existence). Same slowapi burst limit as `/generate-trip` (`3/minute`, keyed on `request.state.user_id`).

**No backend trip-read endpoints.** Finished-trip reads (list + detail) go **Supabase-direct under RLS** from the frontend (Supabase JS client — RLS is the sole read-authz control, gated in CI by `.github/workflows/rls-tests.yml`). FastAPI owns **writes / orchestration / streaming** only, plus external API calls requiring the Python SDK.

**Error envelope:** every non-2xx response is one JSON shape `{"error":{"code","message"}}` — registered on the Starlette base `HTTPException`, so framework 404/405 and pre-stream auth failures are enveloped too. TS mirror: `frontend/lib/trip/backend-types.ts` → `ErrorResponse`.

**Deployment:** live on Render as `astrail-backend` (Docker, Starter, `region: singapore`, Blueprint-managed via `render.yaml`). Launches `cd backend && uvicorn main:app` (bare imports need `backend/` as cwd). Env keys in `render.yaml` / `.claude/docs/ENV.md`.

**`autoDeploy: false` — deploys are MANUAL, and merging is NOT deploying** (`render.yaml:32`). There is no pre-deploy migration hook anywhere, so schema is applied **by hand** and code ships only when someone triggers a Render deploy. For a migration-bearing branch the order is: apply the migration → confirm the *currently deployed* code still works against the new schema → merge → trigger the deploy. `/health` performs **no schema check**, so a code-first deploy against an old schema stays GREEN while jobs silently fail. Do not re-enable `autoDeploy` without landing a real pre-deploy migration gate — `render.yaml:12-30` records the incident that disabled it.

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

**Preference memory (mem0, LIVE — Phase 1.3, merged to `dev` PR #31):** a returning user's remembered travel taste is read once at generation start (`mem0.search` → a typed `PreferenceContext`; explicit current input wins), emitted as a `preferences` SSE stage event, and injected as a soft-guidance block into the **restaurant + narrator** prompts (never per-agent memory tools). After a successful trip, an **awaited** best-effort write-back (`mem0.add` + a `memory_events` audit row) runs *after* the terminal `result` event. Every mem0 call (search/add/construct) is `try/except` + `asyncio.wait_for` bounded — memory never fails or stalls a trip, and the whole feature no-ops when `MEM0_API_KEY` is unset. Personalization reaches the trip **only through the LLM prompts**, so the deterministic dedup/assembly (the frozen `mean_intra_day_travel_m = 6229.0` eval anchor) is untouched. Read/inject/write-back detail: `docs/superpowers/plans/2026-07-06-mem0-preference-memory.md`.

When caption + `locationName` from a reel yield too few places, the scraper re-runs that reel with `includeTranscript` and the extractor uses the Apify `transcript` field as an extra signal — opt-in, never always-on (protects perceived latency + Apify transcription cost).

## Place Cache Semantic Dedup (the data flywheel)

Two-gate matching per new place:
1. **Semantic gate**: Supabase pgvector search, similarity ≥ 0.85
2. **Geographic gate**: haversine distance <500m

Both gates must pass to merge into an existing canonical record. Semantic-only would merge "Ichiran Shibuya" with "Ichiran Shinjuku." Lat/lng-only would miss "Senso-ji Temple" vs "浅草寺."

On match: append new evidence quote, increment `timesReferenced`. On miss: create new canonical record.

**Status — the semantic gate is NOT built (ISSUES-B3, accepted MVP state).** The two gates above describe the target design; today only the geographic gate plus exact-name matching is live. Both writers — `organizer._persist_place` and `pipeline.persist._find_or_create_place` — insert `places` rows with `embedding = NULL`, and `pipeline/dedup.py` matches by name/alias overlap + haversine with no embeddings at all. There is **no production embedding writer anywhere in the repo**. This is deliberate: filling `embedding` at insert time means a blocking OpenAI call per place on a user-facing critical path, to serve a similarity query no feature issues yet. `places_embedding_hnsw_idx` is partial (`where embedding is not null`), so null rows cost it nothing. **Trigger to build it:** when semantic place matching is scheduled on the board — the first feature that actually queries `places_embedding_hnsw_idx` — built as a shared producer used by BOTH writers, plus a bounded backfill for existing rows. Never inline in the organize loop.

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
22. Observability: Langfuse + UptimeRobot; product analytics: PostHog. (Sentry removed 2026-07-19 — never wired, and its default request-URL capture would re-open ISSUES-B1. Re-add only with a `before_send` URL scrubber; see STACK.md.)
23. CI/CD: GitHub Actions → Vercel + Render. **Supabase migrations are applied BY HAND, not on merge** — `render.yaml` sets `autoDeploy: false` and there is no pre-deploy migration hook (see the Deployment note above).
24. Deploy: Vercel + Render + Supabase
25. Open beta
