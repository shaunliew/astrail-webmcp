# Saved Reels to Trip localhost MVP

> Date: 2026-07-18
> Status: execution plan locked from the user-approved localhost MVP handoff
> Scope: smallest real Saved Reels -> Organize -> globe -> country tray -> brief -> trip flow

## Discovery and approval record

The source handoff records the approved product decisions for this slice: browser-first
localhost, lightweight capture before analysis, real Apify extraction for uncached Reels,
exact cache reuse at zero extraction cost, canonical country grounding before a country is
shown, a replacing globe status bar, country trays before the trip brief, one focused brief
question at a time, and trip generation from selected canonical place IDs without a second
Apify call. Visual polish, collections management, hotels, manual correction, and landing
page work are explicitly deferred.

The handoff is the discovery interview record for this continuation. No new visual or
product decision is assumed. The live Project #1 activation gate remains pending because
the local `gh` credential is invalid; implementation may proceed locally, but no board card
or stale issue is guessed or mutated until authentication is restored.

## Locked vertical contract

### Database

Add forward-only migration objects:

- `reel_place_mentions`: global, service-role-written mentions keyed by `reel_cache_id`
  and canonical `place_id`, carrying only safe evidence (`evidence_quote`, `source_url`,
  `confidence`).
- `organize_jobs`: user-owned durable jobs with `pending|processing|succeeded|failed`,
  a unique request-derived idempotency key, replayable request JSON, current
  human-readable status, counts, timestamps, and stale-lock recovery fields.
- `organize_job_items`: owner-linked selected Saved Reels with per-item
  `queued|processing|organized|location_not_found|failed` status, counts/errors, and
  exactly-once analysis charge/refund state.
- `organize_events`: owner-filtered durable human-readable progress events for SSE
  replay/reconnect; the current job snapshot remains sufficient for polling.
- `saved_reel_cards` safe projection: explicit `(select auth.uid())` filtering by the
  Saved Reel owner, joined to only safe cache columns (`caption`, `thumbnail_url`) and
  safe place proof. Do not use `security_invoker` against the service-role-only
  `reel_cache`; do not grant authenticated access to `raw_payload` or `transcript`.
- `places.country_code` and `places.country_name` for grounded tray grouping.
- `reel_analysis_count` on `user_daily_usage` plus a service-role-only atomic daily
  reservation/refund RPC pair, capped at five. Cache hits never reserve usage.

All user-owned job tables use RLS and owner-enforced composite foreign keys. Global
mentions remain service-role-only; the explicit-auth-filter safe projection is the browser
read seam. pgTAP proves second-user isolation, safe projection, duplicate/cache behavior,
quota cap/refund, and deletion semantics.

### Backend

- `POST /saved-reels/organize` accepts `{saved_reel_ids: string[]}` (1-5), authenticates,
  verifies ownership, creates an idempotent durable organize job, and returns `{job_id}`.
- `GET /saved-reels/organize/{job_id}` authenticates and owner-checks, returning the
  current job plus item progress, countries found, and safe place counts.
- `GET /saved-reels/organize/{job_id}/stream` authenticates and owner-checks, replays
  `organize_events` from an optional cursor, and uses the existing SSE framing: each
  status event is structured JSON, the terminal `result` carries a JSON string in
  `content`, and every success/error/timeout path ends with `[DONE]`.
- The organizer reuses `pipeline.cache` at the current extractor version. On a miss it
  calls the existing direct Apify scraper once, then the existing typed extractor once,
  requires Mapbox-derived canonical country code/name for every place shown in a tray,
  persists the shared cache before returning, persists canonical places and safe mentions,
  and updates each Saved Reel terminal state. A Reel with no grounded places becomes
  `location_not_found` and remains charged once Apify successfully read it.
- Cached Reels skip Apify, extraction, and analysis usage. An uncached attempt reserves one
  analysis immediately before paid processing; item-level charge state plus the atomic
  daily RPC makes reserve/charge/refund exactly once. Source/private/block/infrastructure
  failures refund once; a successful read/extraction, including `location_not_found`,
  remains charged. No raw payload or transcript reaches browser responses.
- Extend `POST /generate-trip` with optional `place_ids`; `reel_urls` becomes optional
  only when `place_ids` is nonempty. The backend verifies every selected ID is reachable
  through the authenticated user's organized Saved Reels before creating the trip. The
  runner loads the selected place and mention evidence, skips scrape/extract entirely,
  and persists the existing trip shape. Existing Reel-based generation remains backward
  compatible. Idempotency and recovery include `place_ids`.

### Frontend

- `/app` becomes the Saved Reels inbox for real auth, with lightweight capture, safe cards,
  temporary selection mode, and `Organize selected`.
- Organize transitions to a globe-processing screen with one replacing status bar. Polling
  the durable status endpoint is allowed as the reconnect fallback; no raw logs are shown.
- Completion groups safe grounded places by country into trays. A tray shows real pins and
  source-Reel proof. `Plan this trip` passes selected canonical `place_ids` into the
  existing one-question-at-a-time brief and then the existing generation stream.
- Keep current auth, Supabase browser client, existing trip SSE termination, and existing
  responsive shell. No persistent checkboxes outside selection mode and no visual-system
  rewrite.

## Parallel write scopes

After this contract is locked, workers may write only:

1. Database worker: `supabase/migrations/*` and `supabase/tests/*` for the new objects.
2. Backend worker: `backend/*` organizer, grounding, trip bridge, routes, and tests.
3. Frontend worker: `frontend/*` inbox, globe, tray, brief bridge, types, and tests.

The main agent owns this plan, existing shared contract review, integration seams, final
review, and real localhost acceptance. Workers must not edit docs, generated/shared files
outside their scope, or each other's files.

## Execution order and verification

1. Lock this contract and obtain the live Project #1 card/owner/status when `gh` auth is
   available. Verify branch/status and preserve the four known unrelated paths.
2. Run focused red tests for database, backend, and frontend slices, then implement the
   three disjoint workstreams in parallel.
3. Review every returned patch for RLS, cache write-through, auth/owner checks, no raw
   payload leakage, async unmount/reconnect guards, and exact trip/SSE parity. Run focused
   suites after each integration step.
4. Run full database tests/lint, backend tests plus the frozen `backend/evals/` anchor,
   frontend tests/typecheck/build, and a read-only whole-scope review.
5. Start local Supabase, backend, and frontend; use real Supabase Auth credentials and
   a real Reel to prove uncached extraction, second-run cache hit, second-user isolation,
   globe -> tray -> brief -> generated trip, refresh/reconnect, and failure recovery.

## Non-goals and deferrals

No nested collections UI, manual place correction, profile quota panel, top-three hotels,
trip editing, landing-page work, final globe styling, Instagram sync, raw Apify inspection,
or remote migration/deployment belongs in this slice. The trigger to revisit polish is a
passing real localhost happy path and the second-user/cache acceptance evidence.

## Plan review receipt

| Review | Status | Outcome |
|---|---|---|
| Fresh-eyes architecture review | Resolved | Added idempotent/CAS/replayable organize jobs, safe cache projection, selected-place authorization, Mapbox-only country grounding, mandatory cache write-through, exactly-once quota state, and exact SSE termination requirements. |

No unresolved contract decision remains for this localhost slice.

## Execution receipt

- Database reset, `supabase test db supabase/tests/007_saved_reels_organize.sql`, and
  `supabase db lint --local` passed: 94 pgTAP assertions and no schema errors.
- Backend passed 482 tests with 7 skips; frontend passed 152 tests across 40 files,
  typecheck, and production build.
- Real local acceptance used an isolated Supabase Auth user and cache-hit Reel: capture
  succeeded, organize completed with 1 organized / 0 failed, safe projection returned one
  country-grounded place plus source-Reel proof without raw fields, organize SSE replayed
  sequence IDs and ended with `[DONE]`, and place-only generation persisted the canonical
  place with a succeeded durable job. Optional enrichment degraded the trip display to
  `saved_with_gaps` while the itinerary and trip place persisted.
- Browser UI acceptance reached the real sign-in screen and delivered the normal local
  email link to Mailpit. The Mailpit redirect is configured to `127.0.0.1:3000`, which an
  external browser container cannot reach; component coverage for inbox -> globe -> trays
  -> brief -> selected `place_ids` generation remains green. Development transport headers
  and local Supabase CSP are now conditional/local-safe; production HSTS and CSP upgrade
  behavior remain enabled.
- The live Project #1 board remains unverified because the local `gh` credential is invalid;
  no guessed card or remote board mutation was made.
