# Astrail DB Implementation Handoff

> Current stop point: 2026-07-02 after M4, output RLS tests, and full local DB verification.

## Current State

- Branch: `zh`
- Local Supabase stack: started and usable.
- Completed through:
  - Task 1: Supabase CLI preflight and local stack startup.
  - Task 2: M1 identity/persona migration.
  - Task 3: M1 RLS/persona tests.
  - Task 4: M2 trip/job/generation-event migration.
  - Task 5: M2 RLS/job tests.
  - Task 6: M3 global knowledge migration.
  - Task 7: M4 generated trip output migration.
  - Task 8: M3/M4 output RLS tests.
  - Task 9: full DB verification.
  - Task 10: backend integration checkpoint recorded here.

## Commits Created

Latest continuation commits:

```text
e21bcba test(database): cover trip output rls
a604f79 feat(database): add generated trip output schema
```

Previous DB implementation commits:

```text
4242a64 docs(database): add db implementation handoff
768cd55 fix(database): harden global knowledge schema
0462d12 feat(database): add global knowledge schema
d9c0339 test(database): make job claim order deterministic
6c9acb0 test(database): cover trip job rls
2886153 fix(database): tighten trip job backbone
721c09b feat(database): add trip job backbone
c0ec694 test(database): tighten persona preference rls coverage
a5dcec7 test(database): cover identity persona rls
e5ff947 fix(database): tighten persona preference writes
70a6775 feat(database): add identity persona foundation
```

## Files Added

```text
supabase/migrations/20260701131304_identity_persona_foundation.sql
supabase/migrations/20260701151718_trip_job_backbone.sql
supabase/migrations/20260701162954_global_knowledge_foundation.sql
supabase/migrations/20260702012806_generated_trip_outputs.sql
supabase/tests/001_identity_persona_rls.sql
supabase/tests/002_trip_job_rls.sql
supabase/tests/003_trip_outputs_rls.sql
```

## Verification Completed

Latest successful checks:

```powershell
supabase db reset
supabase test db
supabase db reset
supabase db lint
supabase db query "<foreign-key index inspection query>"
```

Results:

- `supabase db reset`: applies M1, M2, M3, and M4 successfully.
- `supabase test db`: 3 files, 63 tests passing.
  - `001_identity_persona_rls.sql`: 24 tests.
  - `002_trip_job_rls.sql`: 20 tests.
  - `003_trip_outputs_rls.sql`: 19 tests.
- `supabase db lint`: no schema errors on a fresh reset.
- Missing FK index inspection: zero rows.
- `supabase migration list`: not available until this repo is linked to a remote Supabase project; local migration files are present in timestamp order.

Expected harmless notices:

- `extension "pgcrypto" already exists, skipping`
- auth trigger drop notices on fresh reset
- `WARN: no files matched pattern: supabase/seed.sql`
- `extension "pgtap" already exists, skipping`

## Review Decisions Folded In

M1:

- Authenticated users can only write client-originated preference facts:
  - `source in ('onboarding', 'explicit_input')`
  - `status = 'active'`
  - `source_trip_id is null`
  - `mem0_memory_id is null`
- Backend provenance remains service-role-only.

M2:

- Added same-owner composite FK protection:
  - `jobs(trip_id, user_id)` -> `trips(id, user_id)`
  - `memory_events(trip_id, user_id)` -> `trips(id, user_id)`
  - `user_preference_facts(source_trip_id, user_id)` -> `trips(id, user_id)`
- Added `grant usage on schema private to service_role`.
- Job claim helper clears stale retry diagnostics:
  - `completed_at = null`
  - `error_message = null`
- Removed redundant `jobs_trip_id_idx`.

M3:

- `places.source_summary` is explicitly public-only:
  - added comment
  - added shape guard against obvious private/evidence keys.
- Added per-trip Reel dedupe:
  - unique partial index on `(trip_id, normalized_reel_url)` for Reel items.
- Hardened graph references:
  - constrained `location_graph_nodes.ref_table`
  - enforced ref table/id pair shape
  - added unique partial graph ref index.
- Removed redundant indexes:
  - `reel_cache_normalized_url_idx`
  - `trip_places_trip_id_idx`

M4:

- Added generated trip output tables:
  - `trip_days`
  - `transport_legs`
  - `restaurant_suggestions`
  - `hotel_suggestions`
  - `feedback`
- Extended `places_select_when_used_in_own_trip` so authenticated users can read places only when linked to their own trip through:
  - `trip_places`
  - `trip_inspiration_items`
  - `transport_legs`
  - `restaurant_suggestions`
  - `hotel_suggestions`
- Added same-trip integrity for optional day links:
  - `trip_days` has `unique (id, trip_id)`.
  - output tables use composite `(trip_day_id, trip_id)` FKs to `trip_days(id, trip_id)`.
- Direct authenticated `feedback` inserts are beta-limited to trip-level feedback:
  - `artifact_type = 'trip'`
  - `artifact_id is null`
  - richer artifact feedback should go through a service-side validator later.

Task 8 tests:

- Prove authenticated users cannot read `reel_cache` directly.
- Prove `places` only becomes readable through own trip-linked output context.
- Prove generated output reads are owner-scoped with wrong-owner fixtures.
- Prove cross-trip `trip_day_id` references are rejected for transport, restaurant, and hotel outputs.
- Prove direct artifact feedback insert is rejected even for the user's own artifact.

## Database Contracts Now Available

- `public.users`: app-owned Supabase Auth mirror.
- `public.traveler_profiles`: lightweight onboarding profile.
- `public.user_preference_facts`: structured preference source of truth.
- `public.trips`: saved trip artifact and preference snapshots.
- `public.jobs`: durable pipeline work ticket with idempotency key.
- `private.claim_next_generation_job()`: service-role job claim helper using `for update skip locked`.
- `public.generation_events`: user-visible decision timeline.
- `public.reel_cache`: service-role Reel scrape cache by normalized URL.
- `public.places`: canonical place cache with pgvector embedding.
- `public.trip_inspiration_items`: submitted Reels and requested places per trip.
- `public.trip_places`: final verified places per trip.
- `public.trip_days`: date-backed itinerary days.
- `public.transport_legs`: Mapbox route legs per trip/day.
- `public.restaurant_suggestions`: route-aware food suggestions.
- `public.hotel_suggestions`: Travala search snapshots and normalized cards.
- `public.feedback`: beta trip/artifact feedback.
- `public.user_daily_usage`: quota counters.
- `public.location_graph_nodes` and `public.location_graph_edges`: global reusable knowledge graph.

## Backend Integration Checkpoint

Read on 2026-07-02:

```text
backend/supabase_client.py
backend/auth.py
backend/jobs.py
backend/pipeline/cache.py
backend/pipeline/dedup.py
backend/api/schemas.py
frontend/lib/trip/backend-types.ts
```

Observed state:

- Backend files are still placeholders/TODO stubs.
- The next implementation plan can wire backend reads/writes against concrete table names instead of the Mermaid draft.
- Generated Supabase TypeScript DB types are deferred for now.
- Frontend still consumes `frontend/lib/trip/backend-types.ts` until direct Supabase table reads are wired.

Deferred command:

```powershell
supabase gen types typescript --local > frontend/lib/supabase/database.types.ts
```

Only run and commit that file when frontend integration will consume it in the same sprint.

## Outstanding Working Tree

These were already present and intentionally not touched by this DB task:

```text
 M .env.example
A  docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md
?? .claude/settings.local.json
```

Notes:

- `.env.example` modification is unrelated to this DB implementation session.
- `docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md` was staged before/around this run and left staged.
- `.claude/settings.local.json` is untracked local state.

## Suggested Next Session

Start backend integration against the completed schema:

1. Implement `backend/supabase_client.py` service-role client from `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
2. Implement `backend/auth.py` Supabase JWT validation from `SUPABASE_JWT_SECRET`.
3. Implement `backend/jobs.py` enqueue/claim/complete/recover flows against `public.jobs` and `private.claim_next_generation_job()`.
4. Wire write-through cache code for `reel_cache`, `places`, `trip_inspiration_items`, and `trip_places`.
5. Only generate TypeScript DB types when the frontend starts direct Supabase table reads.
