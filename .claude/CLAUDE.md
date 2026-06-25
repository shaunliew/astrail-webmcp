# CLAUDE.md

> Engineering handoff doc for the Astrail repo. Single canonical reference for Claude Code and Codex sessions. Read this before touching any code. Companion to PRD.md (what to build) and DESIGN.md (how it looks).

After reading this file, confirm with: "Ready. Sprint [N], working on [your issues], EMDEE loaded."

## What Astrail is

AI-native travel planner. User pastes 1-5 Instagram Reel URLs + dates + budget + origin + free-text preferences. A parallel agent pipeline extracts places, enriches them with research, fetches weather, suggests restaurants, searches hotel/base candidates via Travala Travel MCP, computes transport between places, narrates a day-by-day itinerary, and produces an orchestrator summary. Every recommendation surfaces evidence (source Reel, caption quote, research URL, Travala hotel search result where applicable). Rendered as a Mapbox 3D map with agent reasoning panels.

**Pitch:** "Astrail turns scattered travel inspiration into the route you actually take."

**What changed from TripCanvas hackathon:**
- Hotel search is in v1 via Travala Travel MCP — **search/suggestions only**, no booking or payment.
- No payments in v1 — all AP2/x402 code removed. Payment seam in `legacy/` for future revival. Do not call Travala booking/payment tools in production v1.
- Auth + persistence added — **Supabase Auth (Google OAuth) + Supabase Postgres** for DB, RLS, realtime, and storage. **Clerk and Convex both dropped** in the 2026-06-20 stack freeze.
- Backend hosts on **Render (Singapore)**, not Fly.io — container-first so a Fly.io/Cloud Run move stays trivial later.
- Reel scraping is direct HTTP — no Agents SDK, no MCP in the scrape loop.
- New agents — Restaurant, Transport, Orchestrator summary.
- Two cache layers — Reel-level cache + place-level semantic dedup (the data flywheel).

## Stack (locked — do not substitute)

> **Frozen 2026-06-20** (Shaun + Zhi Hao V1 stack pass). Guiding principle: **"easier and lesser is better"** — defer every tool until a specific real problem forces it. Authoritative source: EMDEE `astrail/DECISIONS LOG` → entry `2026-06-20 — V1 production tech stack frozen`. At v1, cost is effectively free except Render $7/mo + OpenAI usage (hackathon credits).

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + Tailwind v4 |
| Map (frontend) | Mapbox GL JS 3.24.0 — 3D tilted globe → city map (public `pk`, URL-restricted) |
| Places / geocoding | Mapbox Search Box API — backend resolution (secret `sk`, server-side). **Replaces Google Places.** Live business metadata comes from the research agent |
| Frontend hosting | Vercel (free tier) |
| Auth | Supabase Auth (Google OAuth in v1) — RLS enforced on every table. *(Clerk evaluated and rejected: ~10x cost at scale + JWT/RLS glue + a user-sync webhook, for orgs/UX features v1 doesn't use.)* |
| DB + realtime + vector + storage | Supabase — Postgres + pgvector + Realtime + Storage (free tier, RLS on every table) |
| Backend | FastAPI (Python ≥3.14) + Server-Sent Events |
| Backend hosting | Render (Singapore region) — paid $7/mo Starter from launch (no free-tier spin-down that would kill in-flight agent runs). *(Fly.io evaluated: better for edge/multi-region, but more ops surface than a single-region weekend-team v1 needs.)* |
| Job execution | FastAPI BackgroundTasks backed by a durable `jobs` table in Supabase + startup recovery sweep + idempotency keys |
| LLM SDK | OpenAI Agents SDK |
| Primary LLM | `gpt-5.5-2026-04-23` |
| Fallback LLM | `gpt-4o` (typed `_MODEL_ERRORS` fallback) |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dims → pgvector column) |
| Web search | OpenAI `WebSearchTool` (default). **Exa rejected** — semantic engine, weak on recency |
| Agent memory | mem0 (hosted) + Agents SDK Sessions + Supabase columns for structured prefs |
| Guardrails | Agents SDK-native input/tool guardrails — the prompt-injection defense for untrusted Reel content |
| Reel scraping | Apify `instagram-reel-scraper` — **direct HTTP, no MCP, no Agents SDK**; kept logged-out (legal posture). Transcript via opt-in `includeTranscript` as a fallback when caption + `locationName` are thin |
| Weather | Open-Meteo HTTP (free, no auth) — forecast ≤16 days; climate/historical normals for trips further out. Free tier is non-commercial → paid/self-host is a v2 trigger at monetization. No web search for weather (must stay structured) |
| Transport routing | Mapbox Directions API |
| Hotel search | Travala Travel MCP (`travala/travel-mcp`) for `travala_search_hotel` and optional `travala_search_package` only — **no booking/payment tools in v1** |
| Images | Supabase Storage (S3-compatible) — only the URL string lives in Postgres |
| Rate limiting / abuse | Per-user daily trip quota in Postgres (the hard cap) + slowapi (in-memory request limiting) + result cache keyed by reel+prefs hash + OpenAI budget alerts (auto-recharge **off**) |
| Observability | Langfuse Cloud Hobby (traces + golden eval dataset + LLM-as-judge) + Sentry (errors) + UptimeRobot (`/health`) |
| Product analytics | PostHog (free tier) — activation, D1/D7/D30 retention, reel→itinerary funnel, cost-per-trip (feeds the Decision Gate) |
| CI/CD | GitHub Actions → Vercel + Render; Supabase migrations in Git applied on merge to `main`; separate dev/prod Supabase projects; forward-only additive migrations |
| Python package manager | `uv` (pyproject.toml at repo root, not `backend/`) |

**Banned / never reintroduce:**
- react-pageflip, flipbook, pop-up book UI
- Google Maps, MapLibre, Three.js (Mapbox 3D only)
- Duffel (deprecated, fully removed)
- Google Places API (no-store/no-train ToS + "no non-Google map" rule collide with our Mapbox UI + persistent trips + data flywheel)
- Convex (Python client is read-only → would force a second backend language in TypeScript)
- Clerk (replaced by Supabase Auth)
- Exa web search (weak on recency — wrong tool for live "is it open" metadata)
- Separate AWS S3 (Supabase Storage is already S3-compatible)
- A pivot to GCP / Cloud Run "for consolidation" (vendor-consolidation fallacy; no scaling need at v1)
- yt-dlp, ffmpeg, self-hosted Whisper / audio transcription **in our codebase** — the reel transcript comes from Apify's `transcript` field instead (see Reel scraping). No home-grown audio pipeline
- `requirements.txt` (use pyproject.toml + uv)
- Hotel booking/payment code. Hotel **search/suggestions** via Travala Travel MCP is allowed in v1.
- Any payment-related code or x402 execution in the production v1 flow
- MCP + Agents SDK for the Apify scrape loop (costs 10-15s/reel for no functional gain)

**Deferred to v2 (gated by a concrete trigger, not banned):**
- ARQ + Redis — when BackgroundTasks stops surviving restarts at concurrency, or we need retries/scheduling/separate workers/>1 instance
- ClickHouse (direct) — when Langfuse's 30-day retention or fixed schema can't express the training dataset
- ClickStack — preferred over Grafana once multi-service infra observability outgrows per-platform dashboards
- Cloudflare Turnstile — at public launch / observed abuse / spend spike
- Temporal — when durable agent execution outgrows the `jobs` table
- Portkey-style gateway — when per-feature cost/routing control can't live in app code
- Cloud Run / Fly.io migration — when Render's single-region model is outgrown
- Open-Meteo paid tier or self-host — at commercialization, or when >10k calls/day
- Fine-tuning — when prompts are stable and enough labeled eval data exists

**Open validations (before PRD freeze):**
1. Run the real Japan-demo Reel places through Mapbox Search Box to confirm resolution / coordinate quality.
2. Confirm place cards don't need live ratings/reviews that only Google had — if the research agent covers current hours / "is it open," the Google drop is clean.
3. Validate Travala Travel MCP latency/result quality on the Japan demo set; if dates/occupancy are missing, skip hotel search rather than blocking trip generation.

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
├── Dockerfile                      # Render deploy target — multi-stage, non-root, $PORT bind, SIGTERM graceful shutdown
├── render.yaml                     # Render service config (replaces fly.toml)
│
├── backend/
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
│   ├── agents/
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
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY        # server-side, full access (never exposed to client)
SUPABASE_JWT_SECRET              # verify Supabase-issued JWTs on every request
MAPBOX_SECRET_TOKEN              # sk — Search Box API resolution, server-side only
MEM0_API_KEY
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
SENTRY_DSN
```

Backend (optional, with defaults):
```
LANGFUSE_HOST=https://cloud.langfuse.com
EXTRACTION_TIMEOUT=80
PIPELINE_TIMEOUT=180
HEARTBEAT_INTERVAL=5
SEMANTIC_DEDUP_THRESHOLD=0.85
PLACE_LATLNG_DISTANCE_M=500
MAX_PLACES_PER_TRIP=8
MAX_REELS_PER_REQUEST=5
REEL_CACHE_TTL_DAYS=30
MAX_TRIPS_PER_USER_PER_DAY=5     # hard per-user quota (the real abuse cap)
```

Frontend:
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY    # RLS-protected, safe to ship to client
NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN  # pk — URL-restricted
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
NEXT_PUBLIC_BACKEND_URL          # defaults to http://localhost:8000
```

**Removed in the 2026-06-20 stack freeze (do not reintroduce):** all `CLERK_*` (`CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), all `CONVEX_*` (`CONVEX_DEPLOYMENT_URL`, `CONVEX_DEPLOY_KEY`, `NEXT_PUBLIC_CONVEX_URL`), and the single combined `MAPBOX_ACCESS_TOKEN` (now split into secret `sk` / public `pk`).

**Removed from hackathon (do not reintroduce):** `USE_CACHE`, `DEMO_REEL_URLS`, `DEMO_REEL_URL`, all `AP2_*`/`X402_*` vars, `DUFFEL_TEST_TOKEN`, `BOOKING_AID`, `USE_MOCK_PAYMENT`.

## API Endpoints

Public:
- `GET /health`

Authenticated (Supabase JWT required):
- `POST /generate-trip` — accepts preferences + reelUrls, creates a Supabase trip row + enqueues a durable job, returns `{tripId}`
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

## Non-Negotiable Engineering Guardrails

1. **No hallucinated places.** Every PlaceResult must have lat, lng, and a verbatim evidence_caption_quote. Drop places that fail.
2. **No hidden chain-of-thought.** UI shows structured reasoning — never raw LLM thinking traces.
3. **Partial pipeline failure is acceptable.** Weather/restaurant/transport can fail; itinerary still renders.
4. **Schema parity.** Every Pydantic field has a TypeScript mirror in `backend-types.ts`; the DB schema lives in `supabase/migrations/*.sql`. Ship all sides in the same PR.
5. **Auth on every endpoint.** No anonymous trip creation.
6. **Owner check.** Every trip read/write verifies `trip.userId === current_user.id` — enforced by Supabase RLS, not just app code.
7. **Caches are write-through.** Persist before returning.
8. **No `requirements.txt`.** pyproject.toml + uv only.
9. **No `legacy/` imports.** Production code never imports from the hackathon folder.
10. **Direct HTTP for Apify.** Never reintroduce MCP + Agents SDK for scraping; never build a home-grown Whisper/ffmpeg pipeline — transcripts come from Apify's `transcript` field.
11. **Treat Reel content as untrusted.** Agents SDK input/tool guardrails are the prompt-injection defense — never feed raw caption/transcript text into a tool-call without them.
12. **Trip generation is a durable job.** Persist a `jobs` row before work, use idempotency keys, recover in-flight jobs on startup. A Render restart must never silently drop a run.

## Hard-Won Lessons from Hackathon (do not regress)

- `ModelSettings(tool_choice="required", parallel_tool_calls=True)` on the extractor — without `required`, model skips WebSearchTool and hallucinates coords.
- `_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)` — typed fallback to `gpt-4o`. Apply to every agent.
- `output_type` must be a Pydantic model, not a bare list.
- Pydantic lat/lng bounds: `ge=-90, le=90` and `ge=-180, le=180` — catches hallucinated coords.
- `evidence_caption_quote` must be verbatim substring of `caption + locationName`. Drop if not.
- `WebSearchTool` calls appear as `ToolSearchCallItem`, not `ToolCallItem`. Match both class-name patterns.
- Apify MCP `client_session_timeout_seconds` default is 5s — always too short. Irrelevant now (using direct HTTP), but note if SDK ever returns.

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

## Where the Strategic Context Lives

- `PRD.md` — beta v1 product requirements (this repo)
- `DESIGN.md` — UX/UI spec (this repo, separate workstream)
- EMDEE_DOCS `astrail/CONTEXT.md` — strategic source of truth
- EMDEE_DOCS `astrail/CONSTRAINTS.md` — bandwidth, budget, deadlines
- EMDEE_DOCS `astrail/DECISION GATE.md` — 2026-10-31 forcing function
- EMDEE_DOCS `astrail/DECISIONS LOG.md` — append-only decisions log; **the 2026-06-20 entry is the authoritative source for this stack**

When in doubt about **what** to build: PRD.md. About **why**: CONTEXT.md. About **how**: you're here.

## Session start (read this first)

Read EMDEE in this order before touching any code:

1. `astrail/SPRINTS.md` — current sprint goal, your issues, what's active this week
2. `astrail/team/zhihao/SPRINT-1.md` or `astrail/team/shaun/SPRINT-1.md` — your personal log
3. `astrail/CONSTRAINTS.md` — bandwidth and the **19 July Claude Code credit cliff**

Then come back here for engineering detail.

### Skills (in `.claude/skills/`)

- `shiplog` — after every meaningful commit, run this to log to EMDEE and draft content
- `haotobuild` — writes X posts and Reel scripts for @haotobuildzip (Zhi Hao's channel)

After every meaningful commit:
```
shiplog "what you did" --type ship|fix|learn|struggle --sprint 1 --author zhihao|shaun
```

### Owners

- **Zhi Hao** — frontend (Next.js, Vercel, Mapbox) → issues #6, #12
- **Shaun** — backend (FastAPI, Supabase, agents) → issues #4, #5, #7, #8, #9, #10, #11

### Git hook

The `.githooks/post-commit` hook fires after every commit and prompts you to log it.
Run once to activate:
```bash
git config core.hooksPath .githooks
```

---