# Astrail DB Implementation Handoff

> Stop point: 2026-07-01 after M3. Continue tomorrow from Task 7 / M4.

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
- Stop here. Do not start M4 until the next session.

## Commits Created

```text
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
supabase/tests/001_identity_persona_rls.sql
supabase/tests/002_trip_job_rls.sql
```

## Verification Completed

Latest successful checks:

```powershell
supabase db reset
supabase db lint
supabase test db supabase/tests/001_identity_persona_rls.sql
supabase test db supabase/tests/002_trip_job_rls.sql
```

Results:

- `supabase db reset`: applies M1, M2, M3 successfully.
- `supabase db lint`: no schema errors.
- `001_identity_persona_rls.sql`: 24 tests passing.
- `002_trip_job_rls.sql`: 20 tests passing.

Expected harmless reset/test notices:

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
- Job claim helper now clears stale retry diagnostics:
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

## Outstanding Working Tree

At handoff time these were already present and intentionally not touched by the DB task:

```text
 M .env.example
A  docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md
?? .claude/settings.local.json
```

Notes:

- `.env.example` modification is unrelated to this DB implementation session.
- `docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md` was staged before/around this run and left staged.
- `.claude/settings.local.json` is untracked local state.

## Next Session

Start with Task 7: `Migration M4 - Generated Trip Outputs`.

Before coding:

```powershell
git status --short --branch
supabase status
supabase db reset
supabase test db supabase/tests/001_identity_persona_rls.sql
supabase test db supabase/tests/002_trip_job_rls.sql
```

Then continue from:

```text
docs/superpowers/plans/2026-06-30-supabase-db-design-implementation.md
Task 7: Migration M4 - Generated Trip Outputs
```

Important carry-forward items for M4 / Task 8:

- Add output RLS tests that prove authenticated users cannot read `reel_cache` directly.
- Verify `places` only becomes readable through own trip context.
- Keep user/reel-specific evidence in trip-owned tables such as `trip_places.evidence_json`, not `places.source_summary`.
- M4 may update the `places_select_when_used_in_own_trip` policy to include transport, restaurant, and hotel output tables.
- Do not add booking/payment tables or Travala booking/payment fields.

## Commands That Needed Escalation

Supabase and Docker commands needed unsandboxed access because they read/write:

- `C:\Users\desmo\.supabase`
- Docker Desktop / local Postgres containers
- Git metadata for commits

Use escalation again for:

```powershell
supabase db reset
supabase db lint
supabase test db ...
git add ...
git commit ...
```
