# Astrail Environment Variables

> Extracted verbatim from `.claude/CLAUDE.md` on 2026-07-03 (backup:
> `.claude/backups/CLAUDE.md.2026-07-03.bak`). Read this BEFORE touching `.env.example`,
> deploy config (`render.yaml`, Vercel), or any code that reads `os.environ` /
> `process.env`.

## Backend (required)

```
OPENAI_API_KEY
APIFY_TOKEN
SUPABASE_URL                     # project URL + JWKS source: auth verifies ES256 tokens via {URL}/auth/v1/.well-known/jwks.json
SUPABASE_SERVICE_ROLE_KEY        # server-side secret key (sb_secret_… or legacy service_role); bypasses RLS, never exposed to client
# SUPABASE_JWT_SECRET removed — project uses asymmetric ES256 signing keys (JWKS), not a shared HS256 secret
MAPBOX_SECRET_TOKEN              # sk — Search Box API resolution, server-side only
MEM0_API_KEY
LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY
SENTRY_DSN
```

## Backend (optional, with defaults)

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
DAILY_TRIP_QUOTA=5               # live per-user daily trip cap (rate_limit.py) — the durable free-tier hard cap
BURST_LIMIT=3/minute             # per-user burst throttle on POST /generate-trip (slowapi, in-memory)
ALLOWED_ORIGINS=https://astrail.xyz,https://www.astrail.xyz   # CORS allowlist (comma-separated); add Vercel preview origins at deploy
# MAX_TRIPS_PER_USER_PER_DAY — SUPERSEDED / never wired; the live cap is DAILY_TRIP_QUOTA above
```

## Frontend

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY    # RLS-protected, safe to ship to client
NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN  # pk — URL-restricted
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
NEXT_PUBLIC_BACKEND_URL          # defaults to http://localhost:8000
```

## Removed — do not reintroduce

**Removed in the 2026-06-20 stack freeze:** all `CLERK_*` (`CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), all `CONVEX_*` (`CONVEX_DEPLOYMENT_URL`, `CONVEX_DEPLOY_KEY`, `NEXT_PUBLIC_CONVEX_URL`), and the single combined `MAPBOX_ACCESS_TOKEN` (now split into secret `sk` / public `pk`).

**Removed from hackathon:** `USE_CACHE`, `DEMO_REEL_URLS`, `DEMO_REEL_URL`, all `AP2_*`/`X402_*` vars, `DUFFEL_TEST_TOKEN`, `BOOKING_AID`, `USE_MOCK_PAYMENT`.
