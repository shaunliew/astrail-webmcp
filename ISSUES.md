# Saved Reels Follow-up Issues

Priority order: **B1, B4, B6, B2, B3, B5, B7**. B1 is **RESOLVED** (live security-adjacent
log exposure, closed by access-log redaction — see below);
B4 is restart burst-cost and provider-rate-limit risk; B6 is **RESOLVED** (the cheap
correctness guard for a currently unreachable UI path — mixed input is now a 422);
B2/B3 are canonical-data hygiene, and both are **RESOLVED** — B2 in code (null-country legacy
rows are now reused and backfilled at the write boundary, still behind the 500-metre gate), B3
by decision (null embeddings accepted as a documented, tested MVP state, with a trigger); B5 is
**RESOLVED** (it was never protected by the single-writer invariant claimed below — Arc A's
lease work replaced that premise with a database row lock); B7 is cosmetic product wording.

---

## STATUS UPDATE — 2026-07-19 (Shaun). Read this before picking anything up.

All of B1–B7 are now planned in **`docs/superpowers/plans/2026-07-19-saved-reels-followups.md`**
(3 arcs; Arc A ships as a 5-PR stack). Implementation started on branch
`feat/saved-reels-arc-a-reliability`. What changed since this file was written:

- **Two P1 defects were found that are NOT in this list**, both in `organizer.py`, both now Arc A
  tasks. (1) `recover_organize_jobs` accepts `stale_after_s` and never uses it, so every
  zero-downtime Render deploy requeues in-flight jobs and **double-executes** them — and the trip
  side has its own variant that resurrects `succeeded` as `retryable`. (2) The mention rewrite at
  `organizer.py:377` deletes by `reel_cache_id` with no user scope, so one user's failed
  re-grounding **destroys another user's verified places**. Full evidence:
  `docs/superpowers/reviews/2026-07-19-saved-reels-merged-diff-review.md`.
- **B1 is RESOLVED in favour of log redaction.** The sentinel probe was run against the live
  service (`srv-d976aess728c738pskk0`): the token appears in `type=app` (uvicorn access) logs, and
  **no `type=request` platform logs exist at all** on the starter plan. One-time stream tokens stay
  deferred, with "before public beta" as a mandatory gate.
- **B7 decided:** presentation-layer map `CN → China`; the stored canonical Mapbox name is left
  untouched and `CN` stays the grouping key.
- **B5's premise here is wrong — and B5 is now RESOLVED.** "Currently protected by a single-writer
  invariant" never held: recovery erased the very claim the CAS depended on, so two writers were
  reachable. Arc A did not settle for documenting that weaker truth — it removed the dependency on
  single-writer execution altogether (see the corrected B5 section below).
- **B4 is materially larger than described** — it merges with the double-execution defect above.

**→ NEW: B8 below needs your decision, Zhi Hao.** It is the only item blocking on you.

## B1 — Stop bearer tokens from leaking into stream access logs — **RESOLVED (Branch A)**

**Suggested severity:** P2. This was an observed credential-exposure surface in normal live
operation, even though ownership was still checked correctly.

**RESOLUTION (2026-07-19, Arc A / task A5).** Option 2 — access-log redaction — shipped:
`backend/log_redaction.py` installs a filter on the `uvicorn.access` logger from
`backend/main.py` at import, rewriting `token=<JWT>` to `token=REDACTED` while leaving the
rest of the access line (method, path, protocol, status) intact. `Dockerfile:25` runs uvicorn
with default access logging, so that filter is the entire mechanism. The dead
`sentry-sdk[fastapi]` dependency and its `SENTRY_DSN` config were removed in the same change:
`sentry_sdk.init` was called nowhere, and its FastAPI integration captures full request URLs,
so wiring it later would have reopened this leak by another route.

**⚠ NOT YET CONFIRMED IN THE DEPLOYED CONTAINER.** Redaction is proven in-process (unit tests
plus a reproduction of uvicorn's real startup and access-log call shape), but the running
service has not been re-probed. **Arc A closeout step 4** owns this: after the branch deploys,
re-run `curl ".../saved-reels/organize/<uuid>/stream?token=SENTINEL-B1-PROBE"` then
`render logs -r srv-d976aess728c738pskk0 --type app` and confirm the line reads
`token=REDACTED`. Until that runs, treat B1 as resolved-in-code, not resolved-in-production.

**Why the decision was safe to make without a further product call.** A sentinel probe against
the live service (`srv-d976aess728c738pskk0`, starter plan) on 2026-07-19T09:34:17Z classified
every sink:

| Sink | Sentinel | Verdict |
|---|---|---|
| `--type app` (uvicorn access log, in-container) | **PRESENT** — `"GET /saved-reels/organize/…/stream?token=… HTTP/1.1" 401` | the leak Branch A closes |
| `--type request` (Render platform/edge) | **ABSENT — no request-type logs exist at all** | nothing outside app control to redact |

Absence of evidence was ruled out: a `--type request` query with no text filter returned
empty, and sampling 200 recent entries with no type filter returned `type=app` × 200. Reproduce
with `render logs -r srv-d976aess728c738pskk0 --type request --limit 3 -o json --confirm`.
Branch A therefore closes every sink observable on this service.

**What Branch A does NOT fix, and when Branch B (one-time stream tokens) becomes mandatory.**
Redaction removes the credential from the logs; the Supabase JWT still travels in the URL and
so still lands in browser history, and absence from the Render CLI proves Render does not
*expose* request logs to us, not that nothing records them. Branch B (short-lived, single-use,
ownership-bound stream tokens — fully specified in
`docs/superpowers/plans/2026-07-19-saved-reels-followups.md` § Task A5) stays deferred behind
an explicit trigger: **whichever comes first of (a) public beta, (b) any external party gaining
log access, (c) a Render plan/tier change that surfaces platform request logs — re-run the
sentinel probe after any such change.**

**Files and symbols:**

- `backend/log_redaction.py` (the fix) · `backend/main.py::_install_log_redaction` (the wiring)
- `backend/test_log_redaction.py` (regression)
- `frontend/lib/reels/api.ts::streamOrganize`
- `frontend/lib/trip/api.ts::streamGeneration`
- `backend/auth.py::get_user_id_from_query_or_header`
- `backend/main.py::organize_stream`
- `backend/main.py::stream` (the trip stream route)

**Problem (as originally reported):** Browser `EventSource` cannot set an `Authorization`
header, so both frontend streams append the full Supabase JWT as `?token=<JWT>`. FastAPI
authenticates it correctly, but Uvicorn/Render access logs record the request URL. Anyone with
log access may therefore receive a live bearer credential. Query parameters can also pass
through intermediary request telemetry.

**Scoped options:**

1. Issue a short-lived, one-time stream token over an authenticated POST, then let
   EventSource exchange that limited credential on the GET stream. This removes the
   long-lived Supabase JWT from stream URLs but adds token issuance, expiry, consumption,
   replay prevention, and reconnect semantics.
2. Redact query strings from Uvicorn/Render access logging. This is much smaller and covers
   the observed log leak, but the Supabase JWT still exists in the browser URL and may be
   visible to infrastructure outside the application logger.

**Decision (settled — no longer open):** option 2 now, option 1 behind the trigger above. The
probe made this a measurement rather than a judgement call: option 1's extra surface (issuance,
expiry, consumption, replay prevention, reconnect semantics) buys nothing against any sink that
is observable today, and option 2 removes the credential from the one sink that *is*.

**Regression test (shipped):** `backend/test_log_redaction.py` emits a JWT-shaped sentinel
through the real `uvicorn.access` logger after importing `main`, and asserts neither the
sentinel nor a bare `token=` survives while the access-line shape does. It is deliberately two
layers — the direct-filter tests stay green if the wiring is deleted, so a separate `caplog`
test covers the install, and that asymmetry was verified by fault injection. It also pins
`api/errors.py` logging `request.url.path` (no query string). If Branch B is ever built, add:
expiry, single use, ownership binding, reconnect behaviour, and rejection after consumption.

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

## B6 — Reject mixed Reel URLs and canonical place IDs — **RESOLVED (Arc B)**

**Suggested severity:** P3. The current Saved Reels UI sends only `place_ids`, so the path is
not reachable from that screen, but an API client can silently lose requested input.

**RESOLUTION (2026-07-20, Arc B / task B1).** The recommendation shipped as written:
`GenerateTripRequest.require_reel_or_place` (`backend/api/schemas.py`) now also rejects the
combination, so a request carrying both fields is a 422 from Pydantic — before the handler
body runs. `backend/pipeline/runner.py::run_generation` is unchanged; no merge contract was
defined, and none is planned until an approved product requirement for merged sources exists.
The regression is `test_main.py::test_generate_trip_rejects_mixed_reel_urls_and_place_ids`,
which asserts the 422 plus zero side effects (no trip row, no job, no quota RPC, no background
dispatch — the last being the only path to an Apify call or to `authorize_place_ids`), with
`api/test_schemas.py::test_mixed_reel_urls_and_place_ids_is_rejected` covering the model
directly. The Reel-only and place-only happy paths keep their own regressions.

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

## B2 — Reuse verified legacy places whose country code is null — **RESOLVED (Arc B)**

**Suggested severity:** P3. This creates duplicate canonical rows and weakens data hygiene,
but it does not expose an unverified place or break the current trip flow.

**RESOLUTION (2026-07-20, Arc B / task B2).** The recommendation shipped as written:
null-aware reuse at the write boundary, no batch backfill. The reuse predicate lives in
`public.find_or_create_place` (Arc A moved it there in 20260720160000 to serialize the
find-or-create behind an advisory lock), and 20260720180000 widens it from
`country_code = p_country_code` to `country_code = p_country_code or country_code is null`.
`order by (country_code is null), id` then makes the choice deterministic when both shapes sit
inside the gate: an already-Mapbox-verified row beats a legacy one, and the lowest id breaks
the remaining tie, so a re-organize resolves to the same canonical place every run. Reuse is
still licensed by coordinates alone — the unchanged 500-metre haversine gate decides — and the
function's existing update on the chosen row is what backfills the verified
`country/country_code/country_name`. Country is never inferred from the name, and only the
chosen row is written. Regressions in `backend/test_saved_reels_organize.py`:
`..._reuses_and_backfills_a_near_null_country_legacy_row`,
`..._does_not_reuse_a_far_null_country_row` (the anti-corruption case — same name, different
venue, stays two rows and is not stamped with an unverified country),
`..._prefers_the_country_code_match_over_a_null_country_row` and
`..._breaks_a_same_country_tie_by_lowest_id`; at the SQL level in
`supabase/tests/012_serialized_place_find_or_create.sql`.

**Still deferred, with triggers.** A separate audited batch backfill of legacy null-country
rows: when a production count shows `places.country_code IS NULL` rows above roughly 200. The
select-then-insert TOCTOU is closed for THIS caller by the advisory lock, but the lock is a
convention rather than a constraint: `pipeline/persist.py::_find_or_create_place` still reaches
`places` directly and keeps its own deferral, since its match rule is by name/alias rather than
name/country. Trigger for porting it: observed duplicate canonical rows in production.

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

## B3 — Define how organizer places enter the pgvector flywheel — **RESOLVED as ACCEPTED (Arc B)**

**Status:** closed by decision, not by code. Null embeddings are now a *documented, tested*
MVP state rather than an undocumented gap. Nothing about the insert changed — what changed is
that the omission is asserted, so a future edit has to argue with it instead of drifting past it.

**Why accept rather than fix.** The recommendation below was already "do not add a blocking
OpenAI call to the organizer critical path for this", and verification during Arc B widened it:
there is **no production embedding writer anywhere in the repo**. `pipeline/persist.py::
_find_or_create_place` omits `embedding` exactly as the organizer does, and `pipeline/dedup.py`
states outright that its matching is "Pure + offline — no embeddings, no Supabase". So null is
the consistent state of the entire system, not an organizer oversight — which also means the fix
is a shared producer, never a one-line addition to one insert. `places_embedding_hnsw_idx` is
partial (`where embedding is not null`), so the null rows cost the index nothing meanwhile.

**What landed:** a documentation block at the insert site (`organizer.py::_persist_place`), a
corrected flywheel section in `.claude/docs/ARCHITECTURE.md` (it previously claimed inserts
create the record "with embedding" — untrue), and a characterization test,
`test_persist_place_omits_embedding_deliberately`. That test pins an absence, so it had no red
phase; its fault-injection is inverted — adding `"embedding": [0.0]` to the insert payload
reddens it, confirmed.

**TRIGGER to build the producer + bounded backfill:** when **semantic place matching is
scheduled on the board** — i.e. the first feature that actually queries
`places_embedding_hnsw_idx`. Build it as a shared producer used by **both**
`organizer._persist_place` and `persist._find_or_create_place`, never inline in the organize
loop. Not before that trigger: an embedding written today serves no query.

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

## B5 — Make organize-event sequencing explicitly single-writer or atomic — **RESOLVED (Arc A)**

**Status:** closed by Arc A. The mechanism this issue described no longer exists, and the
safety property it *asserted* has been replaced with a stronger one that is actually true.

**CORRECTION — the original severity note was wrong.** It read: "The current CAS job claim
gives one organizer writer per job … so normal operation is safe; the implementation is
fragile if another writer is introduced." That understated the problem in the one way that
matters. A second writer did not have to be *introduced* — one was already reachable.
`recover_organize_jobs` could requeue a job whose original worker was still alive, and
nothing stopped that superseded worker from continuing to write. So "safe under normal
operation, fragile later" was really "already unsafe, and invisible". Anyone reading the old
text would have inherited a false premise about why the code was correct.

**What the problem was.** `_record_organize_event` read the existing sequences, computed
`MAX(sequence) + 1` in Python, and issued a separate insert. Two writers could compute the
same sequence; the loser then violated `organize_events_job_sequence_unique`, turning
otherwise valid work into a terminal failure.

**How it was fixed.** Arc A did not document the single-writer dependency — it removed it.
Allocation moved into `public.append_organize_event`
(`supabase/migrations/20260720090000_job_leases.sql`), which takes `select … for update` on
the parent `organize_jobs` row and then allocates inside that lock. Two consequences:

1. `MAX(sequence) + 1` is collision-free because the **database serializes allocation**, not
   because exactly one writer exists. Correctness no longer rests on distributed
   exactly-once execution.
2. A `p_lease_token` fence rejects a superseded worker outright (`AS409`), so it cannot write
   at all. There is no unfenced form — a null token raises `AS400` by design.

**Therefore a second event producer is now safe to add**, provided it goes through this RPC
with a valid lease. That is the opposite of the original recommendation, and it is the reason
this issue is closed rather than deferred.

**Files and symbols:**

- `backend/organizer.py::_record_organize_event` (carries the load-bearing invariant comment)
- `supabase/migrations/20260720090000_job_leases.sql` (`append_organize_event` — the row lock)
- `supabase/migrations/20260718130000_saved_reels_organize.sql`
  (`organize_events_job_sequence_unique` — the backstop)

**Regression tests (shipped):**

- `supabase/tests/010_organize_event_sequencing.sql` — proves against real Postgres that the
  `for update` row lock is genuinely taken (via the row-level lock *mode*: `For Update`, not
  the foreign key's incidental `For Key Share`) and that the unique constraint fires on a
  hand-rolled duplicate sequence. Fault-injected both ways.
- `backend/test_organizer_lease.py` (`--- ISSUES-B5 ---`) — races two claims and proves the
  loser emits **zero** events while the winner's sequences stay unique, gapless and ordered.

**Known limit, recorded deliberately:** no test races N *real* concurrent writers.
`supabase test db` runs each file in one transaction on one connection, so genuine contention
is unreachable there. The tests pin the lock's presence and the constraint's behaviour, and
serialization follows from Postgres given both. Stated in full at the top of test file 010.

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

## B8 — Saved Reel cards will stop showing pins the viewer cannot actually use

**Suggested severity:** P3 product-behavior change. Not a bug and not a security issue — a
visible change to your surface that should not land silently inside a backend PR.

**Owner/decision:** **Zhi Hao.** This is the only item in this file blocking on you. Arc A task
A3 implements whichever way you call it; the backend work does not otherwise depend on the answer.

**Files and symbols:**

- `supabase/migrations/20260718190000_saved_reels_location_verification.sql` (the
  `saved_reel_cards` view) and `20260719103000_saved_reels_current_cache_signal.sql:36`
- `backend/organizer.py::authorize_place_ids` (`organizer.py:96-120`)
- `frontend/components/reels/CountryTrays.tsx`, `frontend/components/reels/VerifiedPlacesMap.tsx`

**Problem — the two surfaces disagree today.** `reel_place_mentions` is keyed on
`reel_cache_id` and shared by every user who saved the same Reel. The `saved_reel_cards` view
joins it filtering only on `verification_version`, **not** on the viewer's own
`analysis_status`. But `authorize_place_ids` additionally requires *this* user's saved Reel to be
`organized` before a place may enter a trip.

Net effect right now: if you save a Reel that **someone else** already organized, you SEE their
verified pins on your card — and selecting them fails trip generation with a terminal
`PermissionError`. Pins you can look at but cannot use.

Arc A's A3 migration adds a `user_id` dimension to the mentions table and scopes the view to the
viewer, which removes that mismatch. The consequence: **users who saved a Reel but have not
successfully organized it themselves will see no pins until they run their own Organize.**

**Scoped options:**

1. **Accept the narrowing (what the plan currently does).** The card shows only what the viewer
   can actually use. Honest, and it makes the read surface and the authorization surface agree.
   Cost: an emptier-looking card for a user who saved but has not organized — needs UI copy telling
   them to hit Organize, otherwise it reads as breakage.
2. **Keep the wider view and fix the mismatch at the other end** — let cards keep showing verified
   pins from any owner, and make `authorize_place_ids` accept them. This is a real product/security
   decision, not a display tweak: it would let any user pull another user's organized places into
   their own trip. Not recommended without a deliberate sharing model.
3. **Keep the wider view but mark unusable pins in the UI** (greyed, "Organize to use these").
   Preserves discovery while making the limit legible. Most frontend work of the three.

**Recommendation/open question:** option 1, plus a line of empty-state copy. It is the smallest
change, it is what the plan already implements, and it removes a state where the UI promises
something the backend refuses. If you want option 3, say so before Arc A's A3 lands — after that,
widening the view again means another migration.

**Regression test:** Seed two users sharing one `reel_cache_id`, only one of them `organized`.
Assert the non-organizing user's card shows the chosen state (no pins for option 1), and that
`authorize_place_ids` still rejects their attempt to select those places into a trip.

**Update 2026-07-20 (Arc B, task B3) — STILL YOUR CALL, but the narrowing is now wider.**
A3 closed the cross-user half of this (a user who merely saved someone else's organized Reel
owns no mention rows). B3 closed the remaining same-user half: the card view and
`private.can_select_verified_saved_reel_place` now BOTH require
`saved_reels.analysis_status = 'organized'`, matching `authorize_place_ids`.

The newly visible consequence, beyond what this item described: a user who organized a Reel
**successfully once**, then re-organized it into `failed` / `location_not_found`, keeps their
verified mention rows but their pins **disappear from the card** until the next successful
organize. That next organize is a cache hit (Mapbox-cached, quota-free), so it is cheap — but
it is a state where pins vanish from a Reel the user previously saw working, and it needs the
same empty-state copy option 1 already needs. Still option 1; still yours to confirm or
override. Overriding after this means another view migration
(`20260720120000_saved_reels_cache_signal_v2.sql`).
