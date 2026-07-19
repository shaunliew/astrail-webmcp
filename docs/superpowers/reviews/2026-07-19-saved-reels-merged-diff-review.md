# Saved Reels — third-pass adversarial review of the merged diff

> **Status:** plan input, not a merge gate. The diff is already merged (`42c525f..b58099a`, now on `dev`
> and `shaun`). Reviewer: Claude (fable), read-only, 2026-07-19. This is a *third* pass — the code already
> went through Codex's authoring+review arc and Claude's `0216a0e` correction.
>
> **Verdict:** Needs-fixes. The trust boundary HOLDS — no path reaches a card, tray, pin, or generated trip
> without the `mapbox-country-v1` stamp — and the exactly-once quota RPCs are sound. But two Majors are NOT
> in `ISSUES.md` B1–B7, and the Mapbox cost problem is worse than redundancy: warm organizes are an
> **unmetered billable path outside the daily quota**.

Findings verified against the code at `b58099a`. Independently re-verified by the orchestrator where marked ✅.

## 1. Missed defects (not in B1–B7)

### MAJOR — organize recovery has no staleness guard → double execution on every deploy ✅

`backend/organizer.py:263-281`. `recover_organize_jobs(client, stale_after_s: int = 900)` accepts the
parameter and **never uses it**. Lines 273-279 select *every* `status='processing'` job with no `locked_at`
filter and flip all of them to `pending`.

Contrast the trip side, `backend/jobs.py:81-94`, which filters `.lt("locked_at", cutoff)` and whose docstring
states plainly that the CAS in `mark_job_running` is what prevents a double-run.

Render deploys are zero-downtime — the old instance keeps serving until the new one passes `/health`, and
organize jobs run for minutes. So: old instance mid-job → new instance boots → requeues the job → claims it
(the `pending` CAS at `organizer.py:293-297` succeeds *because recovery just erased the old claim*) →
**two live writers on one job**.

Consequences:
- Double Apify/OpenAI/Mapbox spend on every cache-miss item.
- Racing `_record_organize_event` MAX+1 inserts collide on `organize_events_job_sequence_unique`; the losing
  writer's exception lands inside the per-item `try`, marking a **successfully organized** item `failed`.
- The claim never sets `lock_expires_at`, and overwrites `started_at` on every attempt.

The unused parameter is the tell that the staleness check was intended and dropped.

**Fix:** set `lock_expires_at` at claim; requeue only `locked_at < now - stale_after_s` (mirror `jobs.py`).
Merge into the B4 task — same function, same test.

### MAJOR — destructive cross-user mention rewrite ✅

`backend/organizer.py:377-380`. The only query in the file not scoped to `user_id`:

```python
await (client.table("reel_place_mentions").delete()
       .eq("reel_cache_id", cache_id).execute())
```

`reel_place_mentions` has **no `user_id` column** — PK is `(reel_cache_id, place_id)`
(`20260718130000_saved_reels_organize.sql:25-33`), and `reel_cache_id` is keyed on normalized URL, so all
users who saved the same Reel share one row. RLS cannot help: lines 171-172 grant the table to `service_role`
only, which is what the backend runs as.

The delete runs **before** checking whether `grounded` is empty. If Mapbox returns a valid-but-empty
FeatureCollection (`mapbox_reverse.py:34-36` returns `None` rather than raising — plausible in a brownout),
every place fails verification → `grounded=[]` → mentions already gone → item marked `location_not_found`.

- **Cross-user, not self-healing:** User A organizes Reel X → 5 verified places, builds a trip. User B
  organizes the same Reel; a flaky Mapbox run grounds 2. A's other 3 mentions are deleted → A's next
  place-only generation fails at `authorize_place_ids` (`organizer.py:111-112`, PermissionError) on places A
  legitimately owned. A never ran anything.
- **Crash window, single-user:** delete at 377 → `_persist_place` throws at 383 → the handler at 394 marks
  the item failed and **never restores** the mentions.
- Even on success, the non-atomic delete→insert window makes concurrent `authorize_place_ids` transiently fail.

**Fix:** delete only stale mentions, and only when `grounded` is non-empty (the existing upsert `on_conflict`
already handles overwrite); make an empty-features response **raise** (transient anomaly → failed/retryable)
instead of returning `None`.

### MINOR — warm organizes are billable but quota-exempt

`organizer.py:372`. The daily quota charges only on cache **miss**; a cache-hit organize still runs the full
grounding loop, bounded only by `BURST_LIMIT` (3/min). A user looping warm re-organizes of 5 cached reels
drives ~150 permanent-geocode calls/min indefinitely. The §2 cache fix closes this; if deferred, warm
organizes need their own quota.

### MINOR — coordinate-echo rejection defeated by rounding

`backend/genagents/place_extractor.py:132-138`. Compares URL numbers to lat/lng at `abs(...) <= 1e-6`. A
fabricated URL carrying coordinates rounded to 4–5 decimals (~10 m — exactly what LLMs emit) passes as
"independent". It also scans only `parsed.query`, so coordinates in the path (`/@35.65,139.74`) are invisible
on non-Google hosts. This defeats the check's own non-circularity purpose (the P2-7 evidence contract).

**Fix:** tolerance ~1e-3; scan path + query.

### MINOR — read surface and trip-authorization disagree on `analysis_status`

Migration `20260718190000` (the `saved_reel_cards` view + `can_select_verified_saved_reel_place`) vs
`organizer.py:106-107`. The view and `places` RLS expose stamped places to a user who merely *saved* a reel
another user organized (the mention join filters `verification_version` but not the owner's
`analysis_status`), while `authorize_place_ids` additionally requires *this* user's reel be `organized`. A
card can show verified pins its owner cannot select into a trip — generation fails terminal. Not a trust leak
(places are stamped); an inconsistent contract the frontend will trip over. Pick one.

### MINOR — no rate limit on `POST /saved-reels`

`backend/main.py::create_saved_reel`. Every other new mutating endpoint carries `BURST_LIMIT`; capture has
none → unbounded authenticated row creation. One decorator.

### MINOR — lost refund leaks a quota unit permanently (FYI)

`organizer.py:363-365`. If `refund_organize_item_analysis` itself fails, the item goes terminal `failed` with
`charge_state='reserved'`; nothing reconciles dangling reservations, and the next organize charges fresh.
Needs two provider faults. Fix would be a recovery-time sweep refunding `reserved` charges on terminal items.

### MINOR — a job with failed items reads "Organized" (FYI)

`organizer.py:408-414`. `final_status` is `succeeded` whenever ≥1 item is organized **or**
`location_not_found` — so 4 failed + 1 `location_not_found` ⇒ "Organized" with zero places. Line 411 also
re-hardcodes `"Organization failed"` instead of `ORGANIZE_FAILURE_MESSAGE`.

### FYI bundle

- `organizer.py:78-80` matches a Postgres error by **exact message string** — a wording tweak turns 409 into
  500. Match a custom SQLSTATE instead.
- The prompt-injection regex (`place_extractor.py:90-101`) is English-keyword-only and trivially bypassed
  (other languages, zero-width chars). Acceptable **only** because the real guardrail-#11 boundary is the
  ensemble: verbatim-evidence substring + independent-URL + country verification + structured output. The
  plan must not describe the regex as "the" defense.
- `organizer.py:329` calls `get_cached_places` without the runner's blip-tolerant `try/except` — an organizer
  cache-read blip fails the item where the trip runner treats it as a MISS.
- The direct `reel_urls` trip path never gets Mapbox country verification; extractor-claimed country is
  trusted there. Consistent with Saved-Reels scope, but state it explicitly.
- `sentry-sdk[fastapi]` is in `backend/pyproject.toml:17` with `SENTRY_DSN` in `render.yaml`, but
  `sentry_sdk.init` is called nowhere — dead dependency today, future B1 leak path if wired.
- **Dead code:** nothing ever writes `status='initializing'` (the RPC inserts `pending` directly), so
  `_initializing_job_is_stale` (`organizer.py:43-52`, zero production callers) and the initializing-delete
  sweep (`organizer.py:265-272`) are dead — as are the superseded `reserve/refund_daily_reel_analysis` SQL
  functions from `20260718130000`.

## 2. Mapbox geocoding cost

Verified against `organizer.py:356-361, 372` and `mapbox_reverse.py:59-106`. `reverse_country` has exactly
**one** call site (`organizer.py:157-159` inside `_ground_place`) and **no cache at any layer**; every call
sets `permanent: "true"` — Mapbox's expensive storable-results tier.

**Call math.** One billable call per *complete* extracted place (has lat/lng + country pair + non-placeholder
independent URL; incomplete places return at `organizer.py:148-155` without billing).

| Scenario | Billable permanent-geocode calls |
|---|---|
| Full 5-reel organize, 10-place extractor cap | worst case **50** |
| Typical (2–5 places/reel × 5 reels) | **10–25** |
| Each call, on 408/429/5xx | retries once → **×2** worst case |
| **Warm (cache hit)** | **Identical to cold** — the cache-hit branch at `:372` re-grounds every cached place |
| Re-organizing an already-organized reel | full price again, *plus* it deletes the mentions (`:377`) |
| Trip generation from `place_ids` | **zero** — the runner's place branch does no grounding |

Nothing reusable is consulted: the verified result **is** persisted (`places.country_code/country_name`,
`mentions.verification_version`) but the warm path never reads either before calling. Calls are sequential
with a fresh `httpx.AsyncClient` each.

**Smallest safe fix.** A write-through coordinate→country cache keyed `(round(lat,4), round(lng,4))` →
`{country_code, country_name, verification_version}`, checked in `_ground_place` before the HTTP call, written
only on provider success (never cache failures).

Why this does not weaken fail-closed: the only thing skipped is *re-asking Mapbox the same deterministic
question*. `reverse(lat,lng) → country` is a pure function of frozen inputs (coordinates come from the
extraction cache, frozen per `EXTRACTOR_VERSION`), and national borders do not move at 10 m resolution on
product timescales. The load-bearing comparison — `country.country_code != place.country_code → reject` —
still runs on **every** organize. A cache miss falls through to the live call. A `verification_version` column
gives the same bump-to-invalidate lever `mentions` already uses. Guardrail #7 satisfied (persist before
return). Eliminates ~100% of warm-path and re-organize spend and closes the quota-exempt billable loop.

**Do NOT** instead use "existing mentions" as the skip condition: `reel_cache` is URL-keyed with a *mutable*
`extractor_version`, so mentions can predate the current cached place set — mention-reuse needs
version-coupling reasoning the coordinate cache avoids.

Secondary (latency only, not cost): share one `AsyncClient` and `gather` the per-place calls.

## 3. Refactor / maintainability

- **Sequence FIRST — extract the per-item body of `run_organize_job`.** `organizer.py:314-406` is ~90 lines
  inside a ~138-line function at 6 nesting levels (violates the <50-line / ≤4-nesting rules). Split into
  `_process_item` + `_ground_and_persist`. Both Majors, B2, B5, and the coordinate cache **all edit this exact
  block** — landing them into the current nesting is where a quota-state or mention-rewrite regression slips
  in. The 421-line file itself is within budget; a package split is **not** warranted (feasible-first).
- **Remove production branching on test-double capabilities.** `_maybe_await` (`organizer.py:39-40`),
  `hasattr(table, "upsert")` (`:217-220`), `hasattr(query, "gt")` (`api/streaming.py`). Production behavior
  forking on whether a fake implements a method hides real `supabase-py` API drift — make the fakes implement
  the interface. Delete the dead code above in the same pass.
- *FYI:* the version-parity tripwire (`backend/test_saved_reels_cache_signal.py`) pins migration file
  `20260719103000` **by name** — the next `EXTRACTOR_VERSION` bump needs a new view migration *plus* an edit to
  that test's `MIGRATION_PATH`. Works as a tripwire; document the three-step bump procedure.
- *FYI:* the analysis-quota limit `5` is hardcoded in two SQL functions (vs `DAILY_TRIP_QUOTA` being env).
  Fold into any quota task, not standalone.

## 4. Corrections to ISSUES.md B1–B7

- **B1 — CORRECTION. Log redaction alone is NOT verifiably sufficient.** In-app: `Dockerfile:25` runs uvicorn
  with no `--no-access-log` and no `--log-config`, so the full `?token=<JWT>` request line goes to stdout →
  Render's log stream ✅. A filter on the `uvicorn.access` logger does fix *that* sink, and `api/errors.py:62`
  logs only `request.url.path` — no second in-app leak. **But two paths app code cannot redact:**
  (1) Render's **platform-level** HTTP request logs are generated at Render's edge, *outside* the container —
  if they record the query string, option 2 is dead on arrival and the one-time token stops being deferrable.
  The B1 task must **START with a sentinel probe** (`curl ".../stream?token=SENTINEL"` → inspect the full
  Render log stream, not just app stdout). (2) `sentry-sdk[fastapi]` + `SENTRY_DSN` are staged but
  uninitialized — whoever wires Sentry later inherits request-URL capture. Write B1's "sentinel never appears
  in any sink" regression now so it catches that.
- **B4 — MATERIALLY LARGER than described.** The unbounded-recovery claim is correct (`main.py:73` routes via
  `_redispatch` which holds `_RECOVERY_SEM` at `:342`; `main.py:77` calls `run_organize_job` directly) ✅ — but
  the same function carries the missing-staleness Major above. Make B4 **one** task: staleness filter on
  `locked_at`/`lock_expires_at` + set `lock_expires_at` at claim + the semaphore wrapper. ISSUES.md's
  regression test only proves the concurrency bound — add one proving a *recently-locked* processing job is
  NOT requeued.
- **B2 — accurate** ✅ (`organizer.py:177-178`). Note the same select-then-insert is also non-atomic
  (concurrent-dup risk), matching the known-deferred `persist.py` caveat — keep deferred.
- **B3 — accurate** ✅. The insert at `organizer.py:194-203` has no `embedding`; zero production embedding
  writers exist repo-wide.
- **B5 — accurate** ✅, and blast radius confirmed: a sequence collision at `organizer.py:393` lands inside the
  per-item `try`, marking a **successfully organized** item `failed`. Note the B4-merged double-execution fix
  is what actually makes B5's single-writer invariant true — sequence them accordingly.
- **B6 — accurate** ✅ (`schemas.py::require_reel_or_place` accepts both; `runner.py`'s `if place_ids:`
  silently ignores `reel_urls`). The 422 rejection is one validator line.
- **B7 — accurate** ✅ (`mapbox_reverse.py:49-54` returns Mapbox's canonical name; `_ground_place` /
  `_persist_place` persist it verbatim). Presentation-layer mapping is the right shape.

## Recommended sequencing

Open with the `run_organize_job` extraction refactor, then land **(B4 + staleness/double-execution)** and the
**mention-rewrite fix** before anything else. The deploy-overlap double execution converts every routine Render
deploy with in-flight organizes into failed jobs and double provider spend, and every other organize-path task
edits the code it destabilizes.

## Scope of this review

Read-only. No test suites run (HANDOFF's fresh verification covers them). No fresh gstack `/review` pass — the
diff already went through the Codex authoring+review arc and Claude's `0216a0e`; this was commissioned as a
third-pass adversarial read for plan input, not a merge gate.
