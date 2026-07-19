# Saved Reels Follow-up Issues

Priority order: **B1, B4, B6, B2, B3, B5, B7**. B1 is live security-adjacent log
exposure; B4 is restart burst-cost and provider-rate-limit risk; B6 is a cheap correctness
guard for a currently unreachable UI path; B2/B3 are canonical-data hygiene; B5 is
currently protected by a single-writer invariant; B7 is cosmetic product wording.

## B1 — Stop bearer tokens from leaking into stream access logs

**Suggested severity:** P2. This is an observed credential-exposure surface in normal live
operation, even though ownership is still checked correctly.

**Owner/decision:** Zhi Hao must choose the stream-auth design; Shaun implements the chosen
backend path. Do not resolve this without the product/security decision.

**Files and symbols:**

- `frontend/lib/reels/api.ts::streamOrganize`
- `frontend/lib/trip/api.ts::streamGeneration`
- `backend/auth.py::get_user_id_from_query_or_header`
- `backend/main.py::organize_stream`
- `backend/main.py::stream` (the trip stream route)

**Problem:** Browser `EventSource` cannot set an `Authorization` header, so both frontend
streams append the full Supabase JWT as `?token=<JWT>`. FastAPI authenticates it correctly,
but Uvicorn/Render access logs record the request URL. Anyone with log access may therefore
receive a live bearer credential. Query parameters can also pass through intermediary
request telemetry.

**Scoped options:**

1. Issue a short-lived, one-time stream token over an authenticated POST, then let
   EventSource exchange that limited credential on the GET stream. This removes the
   long-lived Supabase JWT from stream URLs but adds token issuance, expiry, consumption,
   replay prevention, and reconnect semantics.
2. Redact query strings from Uvicorn/Render access logging. This is much smaller and covers
   the observed log leak, but the Supabase JWT still exists in the browser URL and may be
   visible to infrastructure outside the application logger.

**Recommendation/open question:** Zhi Hao must decide whether the release requirement is
to eliminate the Supabase JWT from URLs entirely (option 1) or to accept URL transport while
guaranteeing access-log redaction (option 2). At minimum, do not deploy with the current
unredacted Render access logs.

**Regression test:** Start each stream with a sentinel JWT, capture application and access
logs, and assert the sentinel and `token=` never appear. For one-time tokens, additionally
prove expiry, single use, ownership binding, reconnect behavior, and rejection after
consumption.

## B4 — Bound organize-job recovery concurrency at startup

**Suggested severity:** P2. A restart with a backlog can create an immediate Apify/OpenAI/
Mapbox/database burst, increasing cost and rate-limit risk in production.

**Files and symbols:**

- `backend/main.py::lifespan`
- `backend/main.py::_RECOVERY_SEM`
- `backend/main.py::_redispatch`
- `backend/organizer.py::recover_organize_jobs`
- `backend/organizer.py::run_organize_job`

**Problem:** Trip recovery creates one task per recovered trip, but `_redispatch` acquires
`_RECOVERY_SEM` before provider work. Organize recovery also creates one task per pending
job, but calls `run_organize_job` directly with no semaphore. A large pending backlog can
therefore start every organizer at once after a process restart.

**Options:** Reuse `_RECOVERY_SEM` through a small `_redispatch_organize` wrapper; add a
separate organizer semaphore if trip and organizer budgets must be isolated; or replace
per-job tasks with a fixed-size recovery worker queue.

**Recommendation:** Reuse the existing recovery bound first through an organizer wrapper.
It is the smallest change and caps aggregate boot-time provider work at the already accepted
limit of three. Split the semaphore only after measured workloads show starvation.

**Regression test:** Recover more than three organize jobs with an instrumented fake runner,
block each invocation on an event, and assert maximum simultaneous executions never exceeds
three. Then release them and prove every pending job eventually runs exactly once.

## B6 — Reject mixed Reel URLs and canonical place IDs

**Suggested severity:** P3. The current Saved Reels UI sends only `place_ids`, so the path is
not reachable from that screen, but an API client can silently lose requested input.

**Files and symbols:**

- `backend/api/schemas.py::GenerateTripRequest.require_reel_or_place`
- `backend/main.py::generate_trip`
- `backend/pipeline/runner.py::run_generation`

**Problem:** `GenerateTripRequest` accepts a request containing both `reel_urls` and
`place_ids`. In `run_generation`, any non-empty `place_ids` takes the organized-place branch,
so the Reel URLs are silently ignored. The API reports success without processing all of
the caller's submitted inspiration.

**Options:** Reject mixed input as mutually exclusive, or define and implement a merge
contract that scrapes Reels and combines them with authorized canonical places.

**Recommendation:** Reject the combination in the Pydantic model with HTTP 422. No approved
product contract requires merged sources, and rejection prevents silent data loss without
expanding the pipeline.

**Regression test:** Submit both fields to `POST /generate-trip`; assert 422 and prove no
trip row, job, quota increment, background task, Apify call, or place authorization occurs.
Keep separate regressions showing Reel-only and place-only requests still pass.

## B2 — Reuse verified legacy places whose country code is null

**Suggested severity:** P3. This creates duplicate canonical rows and weakens data hygiene,
but it does not expose an unverified place or break the current trip flow.

**Files and symbols:**

- `backend/organizer.py::_persist_place`
- `public.places.country_code` and `public.places.country_name`

**Problem:** `_persist_place` queries exact `name` plus the newly verified `country_code`.
Rows created before the country migration have null country fields, so they are never
considered even when their coordinates are within the existing 500-metre reuse gate. The
organizer inserts another canonical row for the same venue.

**Options:** Backfill legacy rows after reverse-country verification; or make
`_persist_place` consider same-name rows with either the matching code or null, then reuse
and fill a null-country row only when its coordinates pass the 500-metre gate.

**Recommendation:** Add null-aware reuse at the write boundary and populate the verified
country fields on a geo-matching legacy row. Use a separate audited backfill only if the
existing null-country population is large enough to justify batch processing. Never infer
country from the place name alone.

**Regression test:** Seed a same-name legacy row with null country fields inside 500 metres,
persist a Mapbox-verified candidate, and assert the existing ID is reused and receives the
verified country. Also prove a far null-country row is not reused.

## B3 — Define how organizer places enter the pgvector flywheel

**Suggested severity:** P3. The rows remain usable by exact-name and geographic matching;
the gap affects future semantic reuse rather than current correctness.

**Files and symbols:**

- `backend/organizer.py::_persist_place`
- `backend/pipeline/persist.py::_find_or_create_place`
- `public.places.embedding` and `places_embedding_hnsw_idx`
- `.claude/docs/ARCHITECTURE.md` canonical-place flywheel contract

**Problem:** Newly inserted organizer places omit the nullable `embedding` column. They can
be used by ID and exact-name/geo matching, but cannot participate in pgvector semantic
matching or a future embedding-backed canonical-place flywheel. The repository currently
has no shared production embedding writer, so this is broader than adding one field to the
insert.

**Options:** Generate `text-embedding-3-small` on insert and persist it; enqueue an
asynchronous/backfill embedding job; or explicitly accept null embeddings for the MVP until
the shared embedding pipeline is implemented.

**Recommendation:** Document null embeddings as an accepted MVP state and create a bounded
backfill/producer task with the future shared embedding pipeline. Do not add a new blocking
OpenAI call to the organizer critical path just for this issue.

**Regression test:** When an embedding producer exists, insert an organizer place, run the
producer, and assert a 1536-dimensional vector is stored and discoverable through the
intended similarity query. Until then, add a contract test/documentation assertion that
null is deliberate rather than accidental.

## B5 — Make organize-event sequencing explicitly single-writer or atomic

**Suggested severity:** P3. The current CAS job claim gives one organizer writer per job,
and `(job_id, sequence)` is unique, so normal operation is safe; the implementation is
fragile if another writer is introduced.

**Files and symbols:**

- `backend/organizer.py::_record_organize_event`
- `backend/organizer.py::run_organize_job`
- `supabase/migrations/20260718130000_saved_reels_organize.sql`
  (`organize_events_job_sequence_unique`)

**Problem:** `_record_organize_event` reads all existing sequences, computes
`MAX(sequence) + 1` in Python, and performs a separate insert. Two writers for the same job
can choose the same sequence; one then fails the unique constraint and may turn otherwise
valid work into a terminal failure. Safety currently depends on the load-bearing CAS
single-writer invariant elsewhere in `run_organize_job`.

**Options:** Allocate and insert the next sequence atomically in a database function under a
job/advisory lock; maintain a per-job database counter; or retain the current implementation
with an explicit load-bearing invariant comment and a test proving a second worker cannot
write after losing the claim.

**Recommendation:** For the MVP, document and test the CAS single-writer dependency beside
`_record_organize_event`. Move allocation into one database operation before adding any
second event producer or concurrent writer for a job.

**Regression test:** Race two job claims and prove only the winner can emit events and that
sequences remain unique and ordered. If atomic allocation is implemented, concurrently
insert many events and assert no unique violations, gaps caused by retries, or lost events.

## B7 — Decide the user-facing name for country code CN

**Suggested severity:** Cosmetic. Coordinates and country code remain correct; only tray
wording differs from current fixtures and expected product language.

**Owner/decision:** Zhi Hao must choose the display wording. Do not silently normalize it in
backend code before that decision.

**Files and symbols:**

- `backend/geocode/mapbox_reverse.py::parse_reverse_country_response`
- `backend/organizer.py::_ground_place` and `_persist_place`
- `frontend/lib/reels/organize.ts::groupPlacesByCountry`
- `frontend/components/reels/CountryTrays.tsx::CountryTrays`
- `frontend/lib/reels/__tests__/organize.test.ts`
- `frontend/components/reels/__tests__/VerifiedPlacesMap.test.tsx`

**Problem:** Live Mapbox permanent reverse geocoding returns country code `CN` with the
canonical name `People's Republic of China`. The backend deliberately persists Mapbox's
verified canonical name, and the frontend displays it unchanged. Current fixtures expect
the shorter label `China`, so production wording differs from the test vocabulary.

**Scoped options:** Display Mapbox's canonical `People's Republic of China` everywhere; or
retain the canonical stored value and apply a product-owned display-name mapping such as
`CN -> China` in the presentation layer. A broader locale-aware country-name formatter can
replace that map later if multilingual presentation is required.

**Recommendation/open question:** Zhi Hao should choose whether canonical provider wording
or concise product wording is the source of truth for display. Whichever wording is chosen,
keep `CN` as the grouping/identity key and avoid mutating verified coordinates or country
codes. If concise wording wins, prefer presentation mapping over rewriting stored provider
evidence.

**Regression test:** Feed the exact live pair `CN` / `People's Republic of China` through
the backend card shape and frontend grouping. Assert one CN tray and the chosen visible
label, while confirming the stored canonical provider name remains available if the
presentation layer maps it.
