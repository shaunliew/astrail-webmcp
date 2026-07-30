# Astrail Stack (locked — do not substitute)

> Extracted verbatim from `.claude/CLAUDE.md` on 2026-07-03 (backup:
> `.claude/backups/CLAUDE.md.2026-07-03.bak`). Read this BEFORE adding, removing, or
> substituting any dependency, service, or tool.

**Frozen 2026-06-20** (Shaun + Zhi Hao V1 stack pass). Guiding principle: **"easier and lesser is better"** — defer every tool until a specific real problem forces it. Authoritative source: EMDEE `astrail/DECISIONS LOG` → entry `2026-06-20 — V1 production tech stack frozen`. At v1, cost is effectively free except Render $7/mo + OpenAI usage (hackathon credits).

## What changed from the TripCanvas hackathon

- Hotel search is in v1 via Travala Travel MCP — **search/suggestions only**, no booking or payment.
- No payments in v1 — all AP2/x402 code removed. Payment seam in `legacy/` for future revival. Do not call Travala booking/payment tools in production v1.
- Auth + persistence added — **Supabase Auth (Google OAuth) + Supabase Postgres** for DB, RLS, realtime, and storage. **Clerk and Convex both dropped** in the 2026-06-20 stack freeze.
- Backend hosts on **Render (Singapore)**, not Fly.io — container-first so a Fly.io/Cloud Run move stays trivial later.
- Reel scraping is direct HTTP — no Agents SDK, no MCP in the scrape loop.
- New agents — Restaurant, Transport, Orchestrator summary.
- Two cache layers — Reel-level cache + place-level semantic dedup (the data flywheel).

## The stack table

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + Tailwind v4 |
| Frontend animation | `motion` (framer-motion 12) — drag gestures + spring physics. **Added 2026-07-30 (Zhi Hao)** for the reel-folder interaction (`components/ui/folder-gallery.tsx`): drag-a-photo-down-to-close needs real pointer-drag + spring, which CSS transitions can't express. First animation lib in the stack; reach for CSS/Tailwind transitions first, `motion` only where a gesture/physics genuinely needs it |
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
| Observability | Langfuse Cloud Hobby (traces + golden eval dataset + LLM-as-judge) + UptimeRobot (`/health`). **Sentry REMOVED 2026-07-19** — it was declared but never wired (`sentry_sdk` was never imported in any backend file, in the whole of git history), and an unwired error tracker whose default behaviour captures request URLs is a standing re-open of ISSUES-B1, which put the Supabase JWT in `?token=`. **Re-add only with a `before_send` URL scrubber** — Sentry ships URLs to its own backend over HTTPS, entirely outside Python's `logging`, so `backend/log_redaction.py` structurally cannot cover it. |
| Product analytics | PostHog (free tier) — activation, D1/D7/D30 retention, reel→itinerary funnel, cost-per-trip (feeds the Decision Gate) |
| CI/CD | GitHub Actions → Vercel + Render; Supabase migrations in Git applied on merge to `main`; separate dev/prod Supabase projects; forward-only additive migrations |
| Python package manager | `uv` (`backend/pyproject.toml` — backend deps, NOT repo root) |

## Banned / never reintroduce

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
- `requirements.txt` (use `backend/pyproject.toml` + uv)
- Hotel booking/payment code. Hotel **search/suggestions** via Travala Travel MCP is allowed in v1.
- Any payment-related code or x402 execution in the production v1 flow
- MCP + Agents SDK for the Apify scrape loop (costs 10-15s/reel for no functional gain)

## Deferred to v2 (gated by a concrete trigger, not banned)

- ARQ + Redis — when BackgroundTasks stops surviving restarts at concurrency, or we need retries/scheduling/separate workers/>1 instance
- ClickHouse (direct) — when Langfuse's 30-day retention or fixed schema can't express the training dataset
- ClickStack — preferred over Grafana once multi-service infra observability outgrows per-platform dashboards
- Cloudflare Turnstile — at public launch / observed abuse / spend spike
- Temporal — when durable agent execution outgrows the `jobs` table
- Portkey-style gateway — when per-feature cost/routing control can't live in app code
- Cloud Run / Fly.io migration — when Render's single-region model is outgrown
- Open-Meteo paid tier or self-host — at commercialization, or when >10k calls/day
- Fine-tuning — when prompts are stable and enough labeled eval data exists

## Open validations (before PRD freeze)

1. Run the real Japan-demo Reel places through Mapbox Search Box to confirm resolution / coordinate quality.
2. Confirm place cards don't need live ratings/reviews that only Google had — if the research agent covers current hours / "is it open," the Google drop is clean.
3. Validate Travala Travel MCP latency/result quality on the Japan demo set; if dates/occupancy are missing, skip hotel search rather than blocking trip generation.
