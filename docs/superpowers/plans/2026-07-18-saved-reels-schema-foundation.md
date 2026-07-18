# Saved Reels Schema Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `astrail-execute-plan` to implement this plan task-by-task. Keep commits scoped to the files named by each task.

**Goal:** Add a permanent, owner-isolated Saved Reels library that can capture an Instagram Reel without extraction, place the same Saved Reel in several flat collections, reuse a shared cache row when available, and delete user organization without damaging global cache data.

**Architecture:** Add three user-owned Postgres tables plus a service-role-only `capture_saved_reel` RPC. The authenticated FastAPI route accepts only a Reel URL, derives `user_id` from the verified JWT, reuses the existing URL normalizer, and calls the RPC. The RPC performs cache attachment and `INSERT ... ON CONFLICT` atomically, preserving existing personal labels and analysis state. Browser clients use RLS for library reads, label edits, collection CRUD, and membership changes; they never receive direct access to `reel_cache` or backend-owned analysis fields.

```text
Browser
  │ POST /saved-reels { url } + Supabase JWT
  ▼
FastAPI auth ── invalid JWT/URL ──> existing 401/422 error envelope
  │ JWT-derived user_id + canonical URL
  ▼
capture_saved_reel RPC (service role only)
  ├── match public.reel_cache.normalized_url (optional, shared)
  └── INSERT public.saved_reels
        ON CONFLICT (user_id, normalized_url)
        DO UPDATE reel_cache_id only
  │
  ▼
Typed SavedReel response

users 1 ── * saved_reels * ── * reel_collections
                    via reel_collection_items
```

**Tech Stack:** Supabase Postgres 15, SQL/PLpgSQL, pgTAP, FastAPI, Pydantic v2, async `supabase-py`, pytest, TypeScript 5, Vitest type assertions.

**Design source:** `docs/superpowers/specs/2026-07-18-saved-reels-schema-foundation-design.md`

## Execution gate

The live GitHub Project #1 board was checked on 2026-07-18. It contains the completed legacy item `Sprint 1: define MVP persistence schema in Supabase` (TripCanvas issue #4), but no active item for this library-first Saved Reels slice. Before Task 1 starts:

- create or attach one Project #1 card named for this exact slice;
- put the card in the correct active status/phase and assign an owner;
- record its URL or project-item ID in the execution log;
- do not reopen or repurpose the completed trip-first schema item.

Planning may finish without mutating GitHub. Implementation may not begin until this gate is satisfied.

## Locked constraints

- This is schema Slice 1 only. Do not add Reel-to-place mentions, countries, cities, trays, category taxonomy, trip bridges, hotel changes, extraction jobs, or UI screens.
- Saving is lightweight capture. It does not call Apify, OpenAI, research agents, generation jobs, or any quota-increment RPC.
- `public.reel_cache` remains shared and service-role-only. No new authenticated grant or policy is added to it.
- The API request contains only `url`. `user_id`, `reel_cache_id`, `analysis_status`, and timestamps are never accepted from the client.
- Reuse `backend/scrape/reel_url.py:normalize_reel_url`; do not create a second normalizer.
- Backend service-role writes always use the JWT-derived `user_id`.
- One user can save one normalized URL once. Different users can save the same normalized URL.
- A Saved Reel can belong to zero, one, or many collections.
- Deleting a folder deletes memberships only. Deleting a Saved Reel deletes that user's memberships only. Neither operation deletes `reel_cache`.
- All migrations are forward-only. Do not edit an applied migration.
- Do not push migrations to remote Supabase in this plan. Local reset, pgTAP, and lint must pass first.

## Public contracts

### HTTP capture

```http
POST /saved-reels
Authorization: Bearer <supabase access token>
Content-Type: application/json

{"url":"https://www.instagram.com/reel/ABC123/?igsh=..."}
```

Success is idempotent and returns HTTP 200:

```json
{
  "saved_reel": {
    "id": "uuid",
    "user_id": "uuid",
    "normalized_url": "https://www.instagram.com/reel/ABC123",
    "source_platform": "instagram",
    "reel_cache_id": null,
    "analysis_status": "not_analyzed",
    "personal_label": null,
    "retry_after": null,
    "analyzed_at": null,
    "created_at": "2026-07-18T00:00:00Z",
    "updated_at": "2026-07-18T00:00:00Z"
  }
}
```

A repeated request returns the same row. It must not reset `personal_label`, `analysis_status`, `retry_after`, `analyzed_at`, or `created_at`. If a matching shared cache row appeared since the first save, the repeat may fill a previously null `reel_cache_id`.

Invalid or non-Instagram-Reel URLs return the existing 422 error envelope. Missing or invalid authentication returns the existing 401 envelope.

### Database capture RPC

```sql
public.capture_saved_reel(
  p_user_id uuid,
  p_normalized_url text,
  p_source_platform text default 'instagram'
) returns setof public.saved_reels
```

Only `service_role` may execute it. It must return exactly one row and use one `INSERT ... ON CONFLICT (user_id, normalized_url) DO UPDATE` statement. The conflict branch may fill `reel_cache_id` with `coalesce(saved_reels.reel_cache_id, excluded.reel_cache_id)` and must leave every other user- or analysis-owned field unchanged.

---

### Task 1: Add the failing pgTAP contract

**Files:**
- Create: `supabase/tests/006_saved_reels_foundation.sql`

- [ ] **Step 1: Seed two authenticated users and one shared cache row**

Begin a transaction, install pgTAP in `extensions`, declare the exact plan count, and seed:

```sql
insert into auth.users (id, email)
values
  ('00000000-0000-0000-0000-000000000601', 'saved-reels-a@example.com'),
  ('00000000-0000-0000-0000-000000000602', 'saved-reels-b@example.com');

insert into public.reel_cache (id, normalized_url, source_platform, caption)
values (
  '60000000-0000-0000-0000-000000000001',
  'https://www.instagram.com/reel/SHARED',
  'instagram',
  'shared public reel'
);
```

- [ ] **Step 2: Assert schema shape, constraints, indexes, grants, and RPC privileges**

Use pgTAP helpers such as `has_table`, `has_column`, `col_type_is`, `col_not_null`, `has_pk`, `has_fk`, `has_unique`, `has_check`, `has_index`, `table_privs_are`, and `function_privs_are` where supported by the installed pgTAP version. Cover all three tables, all named indexes, RLS-enabled tables, and the service-role-only RPC.

Do not assert only table existence. The test must prove:

- exact columns and key data types from the design;
- `(user_id, normalized_url)` uniqueness;
- `(user_id, id)` uniqueness on both parent tables;
- both same-owner composite foreign keys;
- collection membership primary key `(collection_id, saved_reel_id)`;
- authenticated column privileges permit only `saved_reels.personal_label` updates;
- authenticated has no direct `saved_reels` insert privilege;
- authenticated and anon cannot execute `capture_saved_reel`;
- service role can execute the RPC.

Then test the behavior of checks with `throws_ok`; constraint existence alone is not
enough. Reject:

- blank `normalized_url`;
- blank or more-than-120-character `personal_label`;
- `organized`/`location_not_found` without `analyzed_at`;
- `not_analyzed`/`queued`/`processing` with `analyzed_at`;
- blank, padded, or more-than-80-character collection names;
- negative `sort_order`;
- unsupported source-platform and analysis-status values.

- [ ] **Step 3: Assert duplicate, many-to-many, ownership, and delete behavior**

As `service_role`, call the RPC for both users with the same normalized URL, then create collections and memberships. Prove:

- both users receive separate `saved_reels.id` values linked to the same `reel_cache_id`;
- a duplicate capture for user A returns the same Saved Reel row;
- the duplicate does not overwrite a seeded `personal_label` or terminal analysis state;
- a Reel saved before its cache row exists gains `reel_cache_id` on a later duplicate capture: capture an unseeded URL, save its returned ID and set a label/status, insert the matching cache row, recapture, then assert the same Saved Reel ID, the new cache ID, and preserved label/status;
- one Reel can appear in two collections;
- duplicate membership raises `23505`;
- cross-user membership raises `23503`;
- deleting one membership preserves the Reel and its other membership;
- deleting a collection preserves the Reel;
- deleting user A's Saved Reel removes its memberships but preserves the cache and user B's Saved Reel.
- deleting a referenced cache row sets `saved_reels.reel_cache_id` to null and preserves the Saved Reel.

- [ ] **Step 4: Assert RLS and column ownership using authenticated JWT claims**

Follow the existing tests' pattern:

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000601', true);
```

Prove user A:

- sees only their Saved Reels, collections, and memberships;
- can update their own `personal_label`;
- cannot update backend-owned fields such as `analysis_status` or `reel_cache_id`;
- cannot read, rename, delete, or organize user B's rows;
- cannot insert directly into `saved_reels`;
- cannot read `reel_cache`.

Reset the role, call `finish()`, and roll back.

- [ ] **Step 5: Run the test before the migration and confirm red**

Run from the repository root:

```powershell
supabase test db supabase/tests/006_saved_reels_foundation.sql
```

Expected: FAIL because `public.saved_reels`, `public.reel_collections`, `public.reel_collection_items`, and `public.capture_saved_reel` do not exist.

If the Codex sandbox blocks Supabase CLI telemetry under `%USERPROFILE%\.supabase`, run the command in the user's normal terminal. Do not change the product migration to work around a local permissions issue.

---

### Task 2: Implement the forward-only schema and atomic capture RPC

**Files:**
- Create: `supabase/migrations/20260718120000_saved_reels_foundation.sql`
- Verify: `supabase/tests/006_saved_reels_foundation.sql`

- [ ] **Step 1: Create `public.saved_reels`**

Implement the approved columns and named constraints. Use `gen_random_uuid()`, `timestamptz`, explicit non-blank checks with `btrim`, and the existing `private.set_updated_at()` trigger.

The timestamp check must require a timestamp for analyzed terminal states, forbid it for
in-progress states, and permit either null or non-null for `failed`:

```sql
constraint saved_reels_analyzed_at_state_check check (
  (analysis_status in ('organized', 'location_not_found') and analyzed_at is not null)
  or (analysis_status in ('not_analyzed', 'queued', 'processing') and analyzed_at is null)
  or analysis_status = 'failed'
)
```

This preserves the approved meaning: `failed` may happen before analysis starts or after
work has begun. Do not permit stale `analyzed_at` values in `not_analyzed`, `queued`, or
`processing` rows.

- [ ] **Step 2: Create `public.reel_collections` and `public.reel_collection_items`**

Implement flat collections only. Enforce the normalized folder-name unique index:

```sql
create unique index reel_collections_user_normalized_name_unique_idx
  on public.reel_collections (user_id, lower(btrim(name)));
```

The table check must also require `name = btrim(name)` and `char_length(name) between 1
and 80`. The expression index prevents case/whitespace-equivalent duplicates; the table
check prevents padded display values from being stored.

For each composite foreign key, reference `(user_id, id)` and use `ON DELETE CASCADE`. Add no parent collection column and no surrogate membership ID.

- [ ] **Step 3: Add only the approved access-path indexes**

Create the six non-unique indexes from design section 5, plus the normalized collection-name unique index. Do not duplicate indexes already supplied by primary-key or unique constraints.

- [ ] **Step 4: Enable RLS and apply table/column grants**

Use separate policies per operation and wrap `auth.uid()` as `(select auth.uid())`.

Key privilege shape:

```sql
grant select, delete on public.saved_reels to authenticated;
grant update (personal_label) on public.saved_reels to authenticated;
grant all on public.saved_reels to service_role;
```

Authenticated users get own-row CRUD for collections and own-row select/insert/delete for memberships. They do not get membership update. Service role gets full access to all three tables.

RLS does row ownership; column-level grants prevent analysis-field updates. Do not attempt to solve column authorization with RLS alone.

- [ ] **Step 5: Create the service-role-only `capture_saved_reel` RPC**

Create `public.capture_saved_reel(uuid, text, text)` with an empty `search_path`, fully qualified names, and no `SECURITY DEFINER`. The service role already bypasses RLS; invoker security avoids creating an unnecessary privilege-escalation surface.

The function body should have this shape:

```sql
insert into public.saved_reels (
  user_id,
  normalized_url,
  source_platform,
  reel_cache_id
)
select
  p_user_id,
  p_normalized_url,
  p_source_platform,
  cache.id
from (values (1)) as singleton(n)
left join public.reel_cache as cache
  on cache.normalized_url = p_normalized_url
on conflict (user_id, normalized_url) do update
set reel_cache_id = coalesce(
  public.saved_reels.reel_cache_id,
  excluded.reel_cache_id
)
returning public.saved_reels.*;
```

The table checks remain defense in depth for source platform and non-blank URLs. The backend is responsible for canonical URL validation before this RPC.

Revoke function execution from `public`, `anon`, and `authenticated`; grant it only to `service_role`.

- [ ] **Step 6: Reset locally and make the pgTAP contract green**

Run:

```powershell
supabase db reset
supabase test db supabase/tests/006_saved_reels_foundation.sql
supabase test db
supabase db lint
```

Expected: the focused test passes, then all database tests pass, then lint reports no schema errors. If pgTAP helper availability differs, rewrite only the assertion mechanism, not the required behavior.

- [ ] **Step 7: Inspect the generated schema diff**

Run:

```powershell
supabase db diff --local
```

Expected: no untracked schema changes beyond the new migration after reset. Do not apply the migration remotely.

- [ ] **Step 8: Commit the database unit**

```powershell
git add supabase/migrations/20260718120000_saved_reels_foundation.sql supabase/tests/006_saved_reels_foundation.sql
git commit -m "feat(db): add saved reels library foundation"
```

Stage only these two files. Preserve unrelated `.claude`, `.gitignore`, and documentation changes.

---

### Task 3: Add backend capture models and persistence helper with TDD

**Files:**
- Modify: `backend/api/schemas.py`
- Create: `backend/saved_reels.py`
- Create: `backend/test_saved_reels.py`
- Create: `backend/test_saved_reels_integration.py`

**Interfaces:**

```python
class CaptureSavedReelRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)

class SavedReel(BaseModel):
    id: str
    user_id: str
    normalized_url: str
    source_platform: Literal["instagram", "tiktok", "manual"]
    reel_cache_id: str | None
    analysis_status: Literal[
        "not_analyzed", "queued", "processing", "organized",
        "location_not_found", "failed",
    ]
    personal_label: str | None
    retry_after: datetime | None
    analyzed_at: datetime | None
    created_at: datetime
    updated_at: datetime

class CaptureSavedReelResponse(BaseModel):
    saved_reel: SavedReel
```

```python
async def capture_saved_reel(client, user_id: str, raw_url: str) -> dict:
    """Normalize one Reel URL and atomically persist the user's Saved Reel."""
```

- [ ] **Step 1: Write failing helper tests**

In `backend/test_saved_reels.py`, use a tiny async RPC fake that records function name and parameters. Add tests proving:

- query strings and trailing slashes normalize through the existing normalizer;
- the helper calls only `capture_saved_reel` with JWT-derived user ID, canonical URL, and `instagram`;
- the helper does not call any table upsert directly;
- invalid Instagram posts, TikTok URLs, and arbitrary text raise `ValueError` before any database call;
- one returned RPC row is passed through;
- zero or several returned rows raise a server-side invariant error rather than silently choosing one.

Run:

```powershell
Set-Location backend
uv run pytest test_saved_reels.py -v
```

Expected: FAIL because `saved_reels.py` and the new models do not exist.

- [ ] **Step 2: Add minimal Pydantic models and helper**

Add the models to `backend/api/schemas.py` and implement the helper in `backend/saved_reels.py`. The helper imports `normalize_reel_url` from `scrape.reel_url`, then makes exactly one RPC call:

```python
result = await client.rpc(
    "capture_saved_reel",
    {
        "p_user_id": user_id,
        "p_normalized_url": normalized_url,
        "p_source_platform": "instagram",
    },
).execute()
```

Do not import Apify, the generation runner, extraction cache helpers, or quota helpers.

- [ ] **Step 3: Run focused tests green**

```powershell
Set-Location backend
uv run pytest test_saved_reels.py scrape/test_reel_url.py -v
```

Expected: all focused tests pass.

- [ ] **Step 4: Commit the helper unit**

Before committing, add `backend/test_saved_reels_integration.py` using the existing
`@pytest.mark.integration` plus `RUN_DB_INTEGRATION=1` pattern. Against a locally reset
Supabase instance, construct a dedicated async client from
`ASTRAIL_LOCAL_SUPABASE_URL` and `ASTRAIL_LOCAL_SUPABASE_SERVICE_ROLE_KEY`. Fail closed
unless the URL host is `localhost` or `127.0.0.1`, so this test cannot mutate the remote
project accidentally. Use the local service client's Auth admin API to create a unique
temporary user, call the real helper with a unique Reel shortcode, and assert PostgREST
accepts the named RPC parameters and decodes exactly one Saved Reel row. Recapture and
assert the same ID. Delete the temporary auth user in `finally`; the user cascade cleans
up the Saved Reel. This smoke must not call the HTTP route, Apify, extraction, or agents.

The default keyless suite skips this test. It becomes required in Task 6 after local
Supabase reset.

Then commit:

```powershell
git add backend/api/schemas.py backend/saved_reels.py backend/test_saved_reels.py backend/test_saved_reels_integration.py
git commit -m "feat(api): add saved reel capture persistence"
```

---

### Task 4: Expose authenticated `POST /saved-reels`

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/test_saved_reels.py`

- [ ] **Step 1: Add failing route tests**

Drive `main.app` through `httpx.ASGITransport`, following `backend/test_main.py`. Override `auth.get_current_user_id` at the FastAPI dependency seam and mock `main.get_supabase_client` plus the persistence helper.

Cover:

- 200 response mirrors the exact `CaptureSavedReelResponse` shape;
- the authenticated user's ID, not request JSON, reaches the helper;
- invalid Reel URL returns the existing 422 envelope;
- missing authentication returns the existing 401 envelope;
- repeated requests return the same row without background tasks;
- RPC/database failure and a zero-row or multi-row invariant failure return the existing generic 500 envelope without leaking internals;
- no trip quota function, generation task, Apify capture, or extraction helper is invoked.

The request JSON must reject extra ownership/backend fields if supplied. Set the request model to `ConfigDict(extra="forbid")` so attempts to send `user_id`, `analysis_status`, or `reel_cache_id` return 422.

- [ ] **Step 2: Run route tests and confirm red**

```powershell
Set-Location backend
uv run pytest test_saved_reels.py -v
```

Expected: route tests FAIL with 404 before the endpoint exists.

- [ ] **Step 3: Implement the route minimally**

In `backend/main.py`:

- import `CaptureSavedReelRequest`, `CaptureSavedReelResponse`;
- import `get_current_user_id` from `auth`;
- import the persistence helper with a non-colliding name;
- add `@app.post("/saved-reels", response_model=CaptureSavedReelResponse)`;
- resolve the user through `Depends(get_current_user_id)`;
- obtain the service-role client server-side;
- translate `ValueError` from URL validation into `HTTPException(422, "A valid Instagram Reel URL is required")`;
- return the typed response.

Do not attach the generation burst limiter to this route. General infrastructure-level abuse protection can be designed separately; this slice must not consume the five-analysis or three-trip product allowances.

- [ ] **Step 4: Run backend tests**

```powershell
Set-Location backend
uv run pytest test_saved_reels.py -v
uv run pytest -v
```

Expected: focused and full offline backend suites pass. Live tests remain skipped unless explicitly enabled.

- [ ] **Step 5: Commit the route unit**

```powershell
git add backend/main.py backend/test_saved_reels.py
git commit -m "feat(api): expose authenticated saved reel capture"
```

---

### Task 5: Add TypeScript schema and HTTP parity

**Files:**
- Create: `frontend/lib/reels/backend-types.ts`
- Create: `frontend/lib/reels/__tests__/backend-types.test.ts`

- [ ] **Step 1: Write compile-time contract assertions**

Create the type file initially with an intentionally incomplete placeholder, then add
`satisfies` fixtures and `// @ts-expect-error` cases in the test file to freeze snake_case
row shapes, the response wrapper, and rejection of backend-owned request fields. These
are TypeScript compiler assertions; Vitest's esbuild transform alone does not validate
them.

The module must export:

```ts
export type ReelSourcePlatform = 'instagram' | 'tiktok' | 'manual'
export type SavedReelAnalysisStatus =
  | 'not_analyzed' | 'queued' | 'processing'
  | 'organized' | 'location_not_found' | 'failed'

export type SavedReel = { /* exact DB/API row */ }
export type ReelCollection = { /* exact DB row */ }
export type ReelCollectionItem = { /* exact DB row */ }
export type CaptureSavedReelRequest = { url: string }
export type CaptureSavedReelResponse = { saved_reel: SavedReel }
```

Do not add these types to `frontend/lib/trip/backend-types.ts`; Saved Reels are independent of trips.

- [ ] **Step 2: Run typecheck red, then add minimal types**

```powershell
Set-Location frontend
npm run typecheck
```

Expected before implementation: FAIL on the intentionally incomplete type exports or
contract assertions. Do not use Vitest alone as the red proof; type-only imports and
`satisfies` can be erased before runtime.

Create the type module with exact field parity. Use ISO timestamp strings and nullable fields matching Pydantic/Postgres.

- [ ] **Step 3: Verify frontend contracts**

```powershell
Set-Location frontend
npm test -- lib/reels/__tests__/backend-types.test.ts
npm run typecheck
npm test
```

Expected: focused test, typecheck, and full frontend suite pass.

- [ ] **Step 4: Commit the parity unit**

```powershell
git add frontend/lib/reels/backend-types.ts frontend/lib/reels/__tests__/backend-types.test.ts
git commit -m "feat(frontend): add saved reels data contracts"
```

---

### Task 6: Final cross-layer verification and documentation handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-saved-reels-schema-foundation-design.md`
- Modify: `docs/UPDATE.md`
- Verify only: all implementation files from Tasks 1-5

- [ ] **Step 1: Run every required local check from clean process state**

```powershell
supabase db reset
supabase test db
supabase db lint
$localStatus = supabase status -o env
$env:ASTRAIL_LOCAL_SUPABASE_URL = ((($localStatus | Select-String '^API_URL=').Line -split '=', 2)[1]).Trim('"')
$env:ASTRAIL_LOCAL_SUPABASE_SERVICE_ROLE_KEY = ((($localStatus | Select-String '^SERVICE_ROLE_KEY=').Line -split '=', 2)[1]).Trim('"')

Set-Location backend
uv run pytest -v
$env:RUN_DB_INTEGRATION = "1"
uv run pytest test_saved_reels_integration.py -v
Remove-Item Env:RUN_DB_INTEGRATION
Remove-Item Env:ASTRAIL_LOCAL_SUPABASE_URL
Remove-Item Env:ASTRAIL_LOCAL_SUPABASE_SERVICE_ROLE_KEY

Set-Location ..\frontend
npm run typecheck
npm test
npm run build
```

Expected: all checks pass. The integration smoke uses the locally reset Supabase project,
crosses the real PostgREST RPC seam, and cleans up its own Saved Reel. `npm run build`
must not require a live backend or expose the service-role key.

- [ ] **Step 2: Review security and cost invariants manually**

Confirm in the diff:

- the API body cannot set ownership or backend state;
- the route authenticates before touching Supabase;
- no service-role key or `reel_cache` raw content enters frontend code;
- authenticated users cannot insert Saved Reels directly;
- the RPC execute grant is service-role-only;
- the RPC conflict branch preserves personal and analysis fields;
- cross-owner memberships are blocked by the database, not just UI logic;
- no Apify, agent, extraction, trip-generation, or usage-counter call exists in the capture path;
- no existing migration was edited;
- unrelated dirty files were not staged.

- [ ] **Step 3: Update durable project documentation**

Change the design status to implemented only after all checks pass. Append an implementation receipt to `docs/UPDATE.md` with:

- migration filename;
- endpoint and request/response contract;
- deletion semantics;
- exact verification commands and results;
- explicit statement that remote migration and UI remain deferred;
- Project #1 card reference.

- [ ] **Step 4: Commit documentation only**

```powershell
git add docs/superpowers/specs/2026-07-18-saved-reels-schema-foundation-design.md docs/UPDATE.md
git commit -m "docs: record saved reels schema foundation"
```

## Completion criteria

This plan is complete only when:

1. a Project #1 card exists for this exact slice;
2. local migration reset, pgTAP, and database lint pass;
3. backend focused and full offline tests pass;
4. frontend focused tests, full tests, typecheck, and build pass;
5. the local real-client PostgREST RPC integration smoke passes;
6. `POST /saved-reels` is authenticated, URL-normalizing, idempotent, and extraction-free;
7. RLS plus column grants isolate owners and protect backend analysis state;
8. deletion tests prove global cache and other users' rows survive;
9. schema, Pydantic, and TypeScript contracts match exactly;
10. no remote migration, UI, country/city, trip, or hotel work has slipped into the slice;
11. documentation records what actually passed, not what was merely intended.

## Engineering review notes

### What already exists and is reused

- `backend/scrape/reel_url.py` already validates and canonicalizes Instagram Reel URLs.
- `backend/supabase_client.py` already owns the server-only async service-role client.
- `backend/auth.py:get_current_user_id` already verifies Supabase JWTs for POST routes.
- `backend/api/errors.py` already guarantees non-leaking 401/422/500 envelopes.
- `private.set_updated_at()` and the repository's RLS/pgTAP patterns already exist.
- `public.reel_cache(normalized_url)` already supplies the shared cache identity.

No parallel URL parser, auth layer, cache table, error format, or database client is introduced.

### Code-path coverage target

```text
POST /saved-reels
  ├── missing/invalid JWT ─────────────── 401 test
  ├── forbidden extra request fields ─── 422 test
  ├── invalid/non-Reel URL ────────────── 422 + no-DB-call tests
  └── valid Reel
       ├── RPC failure/invariant break ── generic 500 tests
       └── RPC success
            ├── cache miss ────────────── null cache ID test
            ├── cache hit ─────────────── shared cache test
            ├── duplicate ─────────────── same ID + fields preserved test
            └── cache appears later ───── cache ID filled test

Authenticated direct data access
  ├── own reads/label edit ────────────── pgTAP
  ├── cross-owner access ──────────────── pgTAP
  ├── backend-field mutation ──────────── pgTAP
  ├── many-to-many membership ─────────── pgTAP
  └── delete/cascade/set-null paths ───── pgTAP
```

### Production failure modes

| Failure | Protection | Test | User result |
|---|---|---|---|
| Forged owner/backend fields | JWT-derived owner, `extra="forbid"` | Route tests | 422 |
| Invalid Instagram URL | Existing canonical normalizer | Helper + route tests | Clear 422 |
| Two duplicate saves race | Database unique key plus `ON CONFLICT` | SQL structure + duplicate pgTAP | One Saved Reel |
| Shared cache is absent | Nullable FK | pgTAP + helper response | Reel remains unanalysed |
| Shared cache arrives later | Conflict branch fills null cache ID | pgTAP | Same Reel becomes cache-linked |
| Cross-user folder membership | Same-owner composite FKs | pgTAP | Write rejected |
| Browser edits analysis state | Column-level grant denial | pgTAP | Write rejected |
| Supabase/RPC outage | Existing generic exception handler | Route test | Non-leaking 500 |
| Cache row is removed | `ON DELETE SET NULL` | pgTAP | Saved Reel survives |

### Implementation sequencing

Sequential implementation is preferred. Tasks 1-2 establish the database contract that
Tasks 3-4 consume. Task 5 is technically parallel after the design is frozen, but its
small size does not justify a second worktree and merge overhead. Task 6 is the integration
gate after all preceding tasks.

## Deferred follow-ups

- Safe display-source contract for captions, covers, and original Reel links.
- Reel-to-place mention model and one-Reel-to-many-place extraction.
- Analysis quota reservation/refund and batch job model.
- Canonical country/city grounding and user trays.
- Linking selected Saved Reels/places into trips.
- Hotel recommendation persistence and route-aware ranking.
- Frontend Saved Reels screens, collections interactions, and extraction globe.

## Review status

| Review | Runs | Status | Findings |
|---|---:|---|---|
| Engineering plan review | 1 | Clear | 1 timestamp-contract mismatch found and resolved; coverage/failure diagram added |
| Independent outside voice | 1 | Clear | 5 test/constraint gaps found and resolved; no high-severity findings |
| Design review | 0 | Not required | No UI is implemented in this schema/backend slice |

The review added behavioral constraint tests, explicit late-cache and cache-deletion
coverage, trimmed-name enforcement, a real TypeScript red step, and a local-only real
PostgREST RPC smoke. No unresolved engineering decision remains in the plan. No new
`TODOS.md` item is needed because product follow-ups are already captured above and in
the approved design slices.
