# Astrail Environment Variables

> Extracted verbatim from `.claude/CLAUDE.md` on 2026-07-03 (backup:
> `.claude/backups/CLAUDE.md.2026-07-03.bak`). Read this BEFORE touching `.env.example`,
> deploy config (`render.yaml`, Vercel), or any code that reads `os.environ` /
> `process.env`.

> **Deploy note (2026-08-03):** `render.yaml` now sets `autoDeployTrigger: checksPass` (the
> current spelling — `autoDeploy` is deprecated) plus a `preDeployCommand` running
> `backend/scripts/assert_schema.py`. **Merging to `dev` deploys the backend**, gated by CI and
> a schema-drift probe. That probe reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` — the same
> two secrets the service already has, so **no new env key was introduced**. It needs no
> postgres DSN, which is why `supabase migration up` was not an option: `preDeployCommand` runs
> inside the service image, which has no Supabase CLI and no psql. If you add a column the code
> requires, add it to `REQUIRED_SCHEMA` in the same PR or the gate aborts the deploy.

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
# SENTRY_DSN removed 2026-07-19 (ISSUES-B1) — sentry-sdk was staged but never initialised, and
# its FastAPI integration captures full request URLs, reintroducing the ?token=<JWT> leak that
# backend/log_redaction.py closes. Re-add only together with a `before_send` URL scrubber.
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
DAILY_TRIP_QUOTA=5               # live per-user daily trip cap (rate_limit.py) — the durable free-tier hard cap. RETUNE 5→10 at the entitlement-arc deploy: beta seats ride the daily quota (see "Entitlement arc" below)
TRIAL_LIFETIME_LIMIT=1           # free-trial LIFETIME generation cap (rate_limit.py) — 1 real trip per trial account; enforced by the reserve_and_enqueue_trip_job RPC, NOT this constant alone
ENTITLEMENTS_ENABLED=true        # rollback switch (rate_limit.py): ENABLED unless set to an explicit falsy token (false/0/no/off) → legacy daily-quota path (_generate_trip_legacy, no lifetime enforcement). A bare "1"/"yes"/typo stays ENABLED (fail-safe: never silently drops enforcement)
BURST_LIMIT=3/minute             # per-user burst throttle on the Apify/OpenAI-spending routes — POST /generate-trip + /saved-reels/organize (slowapi, in-memory)
SAVE_LIMIT=30/minute             # per-user burst on POST /saved-reels only — a pure DB insert, no Apify (rate_limit.py)
ALLOWED_ORIGINS=https://astrail.xyz,https://www.astrail.xyz   # CORS allowlist (comma-separated); add Vercel preview origins at deploy
# MAX_TRIPS_PER_USER_PER_DAY — SUPERSEDED / never wired; the live cap is DAILY_TRIP_QUOTA above
```

### Entitlement arc (free trial + beta seats)

`TRIAL_LIFETIME_LIMIT` and `ENTITLEMENTS_ENABLED` were added for the free-trial + beta-seat arc
(`rate_limit.py:34,37`). Both have safe defaults, so a deploy that sets neither runs the new
entitlement path with a 1-trip lifetime trial. See `.claude/docs/ARCHITECTURE.md` → **Entitlement
ledger** for the two-RPC design, and the arc plan's `## Deploy order + rollback` for the full ordered
sequence.

**Rollback recipe (no image swap, no DB reversal).** `ENTITLEMENTS_ENABLED` is the incident lever:
set `ENTITLEMENTS_ENABLED=false` on the running backend and **restart** → generation works via the
retained legacy daily-quota path (`_generate_trip_legacy`) with **no lifetime enforcement**; flip
back to `true` + restart to resume the entitlement path. The migration is additive (columns + a
partial unique index) and **stays applied** — nothing to revert on the DB side. (The fuller ordered
rollback also flips the `zh` landing CTA back and restores `DAILY_TRIP_QUOTA=5`; that ordering lives
in the plan's deploy section.)

**FE sync caveat (Task-8 review).** The frontend hardcodes its own `TRIAL_LIFETIME_LIMIT = 1` in
`frontend/lib/entitlement.ts:16` as an **advisory pre-emptive gate** (it renders the trial-exhausted
card before POSTing). The backend RPC is the real enforcer. If `TRIAL_LIFETIME_LIMIT` is ever changed
via env, that FE constant must be **manually synced**. It does **not** affect correctness (the
backend still enforces the true limit), but the failure mode is worse than "mistimed card": if
`TRIAL_LIFETIME_LIMIT` is **raised** (e.g. to 2) without syncing the FE, `CreateTripFlow` still
REPLACES its whole compose UI with the exhausted card at 1 trip — the user cannot POST at all (an
**availability block**), not merely a card shown early. Sync `frontend/lib/entitlement.ts:16`
whenever the env value changes.

## Worker-only (`astrail-telegram-ingest`)

The Telegram reel-ingestion worker is a second Render service (`type: worker`, same image,
`render.yaml`). It has **no inbound HTTP**. These three are read by that worker only — the web
service never reads them, and they are not in its `envVars`.

```
TELEGRAM_BOT_TOKEN               # from @BotFather (/newbot, or /token for an existing bot). Blank counts as missing
TELEGRAM_ALLOWED_CHAT_IDS        # comma-separated Telegram chat ids the bot will ingest from, e.g. -1001234567890
ASTRAIL_INGEST_USER_ID           # UUID of the row in public.users that owns every ingested reel (Supabase dashboard → Auth → Users)
```

Getting a chat id: add the bot to the group, send a message, then read `message.chat.id` from
`https://api.telegram.org/bot<TOKEN>/getUpdates`. Supergroup ids are negative and start `-100`.
The bot must also be a group **administrator** — Telegram's privacy mode hides plain-URL
messages from a non-admin bot, so the chat delivers nothing and raises no error. The worker
logs `telegram_bot_not_admin` at boot when it sees this.

**Is it alive?** `telegram_poller_alive offset=<n>` in the Render logs is the ONLY liveness
signal this service has — a `type: worker` has no inbound HTTP, so it has no
`healthCheckPath` and UptimeRobot cannot see it. It is emitted on an idle loop too, because
"alive and idle" and "dead" are otherwise the same silence, and it carries the offset so a
frozen offset across beats reads as *polling fine, ingesting nothing*.

**The first beat is immediate; after that it fires roughly every 100 seconds, not every 60.**
The interval constant is 60 s but the check runs once per loop iteration, and one iteration is
one full 50 s long poll, so each beat lands on the first poll boundary at or after 60 s. The
first is deliberately exempted — `last_beat` starts one interval in the past — so a freshly
started worker announces itself at once instead of going quiet for a minute and a half in the
window you are most likely to be watching it. While the transport is failing the gap between
beats is wider than 100 s. Do not set an alert threshold under ~3 minutes; a tighter one fires
against a perfectly healthy worker. (Both properties pinned in
`backend/telegram_ingest/test_poller.py` — `test_the_first_beat_fires_at_loop_entry_before_the_first_poll`
and `test_the_real_idle_cadence_is_the_interval_rounded_up_to_a_poll`.)

**How to stop it — the entire Phase 1 rollback lever.** Suspend the service in the Render
dashboard (Settings → Suspend), or scale `numInstances` to 0. Nothing else is needed and
nothing has to be reverted: the worker owns no schema and the web service never reads its
variables, so a suspended worker simply stops creating `organize_jobs` rows. Jobs already
created still run — the existing web reaper picks up anything `pending`. The separate,
independent lever for the per-account limit column is
`supabase/migrations/rollback/20260802120000_down.sql`, which needs no code coordination.

**`TELEGRAM_ALLOWED_CHAT_IDS` fails CLOSED — this is the bot's entire authorization surface.**
Unset, blank, whitespace-only, or `","` is a **boot failure**, never "allow every chat"; there
is no allow-all value, and the only way to accept a chat is to name it. Entries must match
`-?[0-9]+` exactly (no `+42`, no unicode digits, no `4_2`), `0` is rejected, and one bad entry
fails the whole boot rather than silently shrinking the list. The failure names the variable,
never its value.

Shared with the web service (the worker reads these from the same secrets, set separately on
the worker in the Render dashboard): `OPENAI_API_KEY`, `APIFY_TOKEN`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, `MAPBOX_SECRET_TOKEN` — the five in
`backend/config_validation.py`. **Eight declared variables on the worker, and no ninth** —
`backend/telegram_ingest/config.py` states the count as an invariant. (`ASTRAIL_EXTRACT_MODEL`
is the only other var anything in the worker's import graph reads, and it has a default.)

Deliberately **absent** from the worker (verified by grep — do not "complete" the list):

```
MEM0_API_KEY          the organize path never reaches mem0 — mem0_client is imported only by
                      main.py and pipeline/runner.py, both web-only
LANGFUSE_PUBLIC_KEY   pipeline/tracing.py's default tracer is a no-op; nothing imports langfuse
LANGFUSE_SECRET_KEY   (same)
SUPABASE_JWT_SECRET   already removed project-wide — ES256 via JWKS, no shared HS256 secret
ALLOWED_ORIGINS       CORS, and a worker serves no requests
DAILY_TRIP_QUOTA      trip-generation quota; the worker runs organize jobs, not /generate-trip
BURST_LIMIT           slowapi throttles an HTTP endpoint the worker does not have
SAVE_LIMIT            same — the worker serves no HTTP routes
PORT                  nothing binds a port
```

## Frontend

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY    # RLS-protected, safe to ship to client
NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN  # pk — URL-restricted
NEXT_PUBLIC_POSTHOG_KEY
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
NEXT_PUBLIC_BACKEND_URL          # REQUIRED in prod (NODE_ENV=production) — resolveBackendUrl() throws at module load if unset/empty; defaults to http://localhost:8000 in local dev only
NEXT_PUBLIC_SENTRY_DSN           # optional browser-visible Sentry DSN; blank/unset keeps frontend error reporting dormant
```

Frontend Sentry also reads four **private Vercel build/server variables**: `SENTRY_DSN`
(server/edge event DSN), `SENTRY_ORG`, `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` (source-map
upload only). Never prefix the auth token with `NEXT_PUBLIC_`. All frontend runtimes set
`sendDefaultPii=false`, disable tracing, and pass events/breadcrumbs through the recursive
credential scrubber in `frontend/sentry.shared.ts` before sending.

## Removed — do not reintroduce

**Removed in the 2026-06-20 stack freeze:** all `CLERK_*` (`CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`), all `CONVEX_*` (`CONVEX_DEPLOYMENT_URL`, `CONVEX_DEPLOY_KEY`, `NEXT_PUBLIC_CONVEX_URL`), and the single combined `MAPBOX_ACCESS_TOKEN` (now split into secret `sk` / public `pk`).

**Removed from hackathon:** `USE_CACHE`, `DEMO_REEL_URLS`, `DEMO_REEL_URL`, all `AP2_*`/`X402_*` vars, `DUFFEL_TEST_TOKEN`, `BOOKING_AID`, `USE_MOCK_PAYMENT`.
