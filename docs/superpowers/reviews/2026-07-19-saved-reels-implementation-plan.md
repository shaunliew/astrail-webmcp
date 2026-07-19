# Saved Reels fix arc — converged implementation plan (2026-07-19)

> Source: Claude's 2026-07-18 final review (`2026-07-18-saved-reels-fix-tracker.md`) +
> Codex planning critique (gpt-5.6-sol, high). Converged and approved by Zhi Hao.
> Implementer: Codex CLI `gpt-5.6-luna`, `model_reasoning_effort="xhigh"`.
> One commit per numbered step. NO push, NO PR.

## Decisions locked by Zhi Hao (do not revisit)

- **D1 — Overlap rule (P2-6):** a request containing a Reel already in an active organize
  job is rejected WHOLE with HTTP **409**, creating nothing partial. The frontend must map
  that 409 to a friendly inbox message: "One of those Reels is already being organized.
  Wait for it to finish, or deselect it and organize the others." (Never show a raw
  "request failed: 409".)
- **D2 — Mock-auth /app (P3):** when `NEXT_PUBLIC_MOCK_AUTH=true`, `/app` renders the
  existing offline `CreateTripFlow`; otherwise `SavedReelsFlow`. No mocked Saved Reels
  inbox in this arc (revisit only during the visual-polish pass).
- **D3 — P2-7 scope bound:** evidence must be REAL/non-circular (reject coordinate-echo and
  `google.com/maps/search` URLs; accept official/Tabelog/TableCheck/real `/place/` URLs with
  a stable place id). Do NOT add coordinate-identity verification (types=poi/name-match) —
  deferred.

## Commit plan (implement in this order)

1. **P2-1 private-schema lockdown** — new migration
   `supabase/migrations/20260719100000_saved_reels_private_schema_lockdown.sql`:
   `revoke usage on schema private from authenticated;` keep service_role usage and keep
   authenticated EXECUTE on `private.can_select_verified_saved_reel_place(uuid)` (the stored
   RLS policy resolves the function by OID, so schema USAGE is not needed at runtime — the
   pgTAP tests below must PROVE this, red-first). Keep `002_trip_job_rls.sql` test 9
   unchanged. Extend `007_saved_reels_organize.sql`: authenticated lacks schema usage;
   direct qualified call denied; the `places` RLS policy still returns only the verified
   owner place; service_role unaffected. Gate: `supabase db reset && supabase test db`
   fully green.

2. **P2-2 organizer terminal cleanup** — `backend/organizer.py` +
   `backend/test_saved_reels_organize.py`. Wrap everything after the successful CAS claim in
   an outer `try/except Exception` (do NOT catch `asyncio.CancelledError` — shutdown must
   stay requeue-able). Terminal-failure helper: job `failed`, fixed safe message,
   `completed_at`, clear `locked_at`/`lock_expires_at`, one durable `result` event
   `{"status":"failed"}`; each cleanup write best-effort. Stop writing the decorative
   15-min `lock_expires_at` at claim (recovery still clears the legacy column). Red-first
   fault injections: initial event write fails; item load fails; `_update_job_counts`
   fails; finalization fails — each ends `failed` + result event; stream still ends
   `result` → `[DONE]`.

3. **P2-4 exactly-once quota + terminal-item recovery filter** — new migration
   `20260719101000_saved_reels_exactly_once_quota.sql` + `backend/usage.py` +
   `backend/organizer.py` + tests (py + `007`). Add
   `organize_job_items.analysis_usage_date date`; backfill non-`not_charged` rows from
   `analysis_reserved_at`; update the charge-state CHECK to require a usage date on
   reserved/refunded/consumed. Service-role-only RPCs
   `reserve_organize_item_analysis(p_item_id,p_user_id) returns date` (row-lock item;
   idempotent when already reserved/consumed; `refunded` ⇒ fresh reservation; Postgres
   `current_date`; increments under cap + stamps `reserved` in ONE transaction; NULL at
   quota without changing the item) and
   `refund_organize_item_analysis(p_item_id,p_user_id) returns boolean` (row-lock;
   decrement the PERSISTED `analysis_usage_date`; `reserved → refunded` same transaction;
   idempotent). Python helpers take `item_id`; no Python-side dates. `reserved → consumed`
   transitions conditionally after the cache write; a retry that finds the cache while
   `reserved` consumes the existing reservation. **Recovery filter:** the item loop
   processes only `queued`/`processing` items — terminal items are never replayed. Keep the
   old RPCs in the DB for deploy compatibility; app code stops calling them. Red-first tests
   per crash window: (a) reserve+stamp atomic / no double increment on retry, (b) refunded
   retry gets a fresh reservation before Apify, (c) refund targets the persisted date,
   refund idempotent, (d) quota rejection leaves item unchanged, (e) cache-write-crash retry
   consumes the original reservation, (f) terminal items skipped on requeue, (g) RPC
   privileges service-role-only.

4. **P2-6 atomic creation + active-item guard** — new migration
   `20260719102000_saved_reels_active_item_guard.sql` + `backend/organizer.py` +
   `backend/main.py` + tests (py + `007`) + frontend 409 message (D1):
   service-role-only RPC
   `create_saved_reels_organize_job(p_user_id, p_saved_reel_ids uuid[], p_idempotency_key)
   returns uuid` — validates 1-5 unique ids; locks the owner's `saved_reels` rows in sorted
   UUID order (deadlock avoidance); rejects missing/cross-owner (→ existing 404 semantics);
   returns the existing active job for the exact idempotency key; rejects any other active
   job sharing a selected reel (→ stable 409); inserts pending job + all items + sequence-1
   queued event atomically (this also removes the partial-initialization window). Replace
   the Python `initializing → items → event → pending` path; keep legacy initializing
   recovery for rows from older code. Frontend: map the organize 409 in
   `frontend/lib/reels/api.ts` / `SavedReelsInbox` to the D1 message (test it). Red-first:
   `[A]` then `[A]` same job id; `[A]` active then `[A,B]` → 409, no partial rows;
   `[A]` terminal then `[A,B]` succeeds; disjoint sets run concurrently; cross-owner 404;
   RPC service-role-only.

5. **P2-7 independent evidence** — `backend/genagents/place_extractor.py` + its tests. Pure
   predicate `is_independent_source_url(url, lat, lng) -> bool`; reject placeholders/
   non-HTTP (existing), `google.* /maps/search` URLs, URLs whose query merely echoes the
   place's own lat/lng, and Google `/place/` URLs WITHOUT a stable embedded place id;
   accept official venue pages, Tabelog/TableCheck, and `/place/` URLs WITH a stable id.
   Wire into `keep_valid_places`. Update `PLACE_EXTRACTOR_INSTRUCTIONS` to require a real
   independent venue page and prohibit coordinate/search echo. Bump `EXTRACTOR_VERSION`
   to `2026-07-19.1`. Red-first URL matrix. Scope bound D3 applies.

6. **P2-5 current-cache signal** — new migration
   `20260719103000_saved_reels_current_cache_signal.sql` (AFTER P2-7 so the SQL embeds the
   final version once) + `frontend/lib/reels/backend-types.ts` + `frontend/lib/reels/api.ts`
   + `SavedReelsInbox.tsx` + frontend tests + `007` + a backend source-parity test.
   Replace `saved_reel_cards` forward-only preserving the byte-identical
   `mapbox-country-v1` join; add
   `coalesce(reel_cache.extractor_version = '2026-07-19.1', false) as has_current_cache`.
   Badge keys on it. **Load-bearing parity tests:** (i) the migration's version literal ==
   Python `EXTRACTOR_VERSION`; (ii) the replacement view retains `mapbox-country-v1`
   byte-identical. These make every future extractor bump fail red until a companion
   migration ships — intentional.

7. **P2-3 durable poll fallback** — `SavedReelsFlow.tsx` + its tests. Idempotent
   `startPolling()`; `refresh()` reports terminal-vs-not; on EVERY stream `result`:
   refresh, and if status is still `initializing|pending|processing`, start the 1s poll;
   reuse the same starter from `onFail`; never multiple intervals; clear polling before
   terminal `finish()`; guard concurrent finishes. Red-first fake-timer tests: timeout
   result + processing → polling; later succeeded → trays + poll cleared; later failed →
   inbox + poll cleared; repeated callbacks → one interval; unmount cancels stream + poll.

8. **P3 batch** — map/CSP/retry/validation/dead-code/logging/mock-auth:
   `VerifiedPlacesMap.tsx` `scrollZoom:{around:'center'}` + test ·
   `next.config.ts` `img-src` add `https://*.cdninstagram.com https://*.fbcdn.net` + test ·
   `mapbox_reverse.py` retry 408/429 once, parse `Retry-After`, fallback `retry_delay_s`,
   cap at a named 2.0s, sanitized status-only errors + tests ·
   `schemas.py`: `list[UUID]` for `saved_reel_ids` and `place_ids`, stringify in `main.py`
   before DB/idempotency/payload, 422-not-500 tests proving no DB/background work on
   malformed input · delete dead `stream_organize_status` + its tests (keep/extend
   `stream_organize_events` tests) · organizer per-item except: fixed phase category
   (`quota|apify|extractor|mapbox|database`) logged with job/item UUID ONLY — caplog test
   injects an exception containing a fake token + URL and proves neither appears ·
   `/app/page.tsx` mock-auth gate per D2 + a page test proving mock mode renders with no
   Supabase/fetch/EventSource/backend calls.

9. **docs** — update `docs/superpowers/reviews/2026-07-18-saved-reels-fix-tracker.md`
   checkboxes for what landed; commit this plan file too.

## Standing constraints (from .claude/CLAUDE.md + review)

- Forward-only migrations; NEVER edit an applied migration.
- Never weaken or delete existing test assertions to get green.
- `mapbox-country-v1` literal byte-identical Python↔SQL everywhere it appears.
- Do NOT touch `backend/geocode/mapbox_forward.py` `country="jp"` (capture-CLI-only,
  intentional). No Google Maps/Places API integration.
- Token safety: no secrets, tokenized URLs, captions, or payloads in logs/exceptions.
- SSE contract: every path ends `result` → `data: [DONE]`; stage events additive only.
- The frozen offline eval anchor `mean_intra_day_travel_m = 6229.0` must not move.
- TDD: write the failing test first and watch it fail for the right reason.
- Stage only files you changed; never `git add -A`.

## Final gates (run all; report pass/fail per command; if your sandbox cannot run one,
say so explicitly — never fake a result)

- `cd backend && uv run pytest -q --basetemp=.pytest-tmp`
- `cd backend && uv run pytest evals/ -q --basetemp=.pytest-tmp`
- `supabase db reset && supabase test db && supabase db lint --local`
- `cd frontend && npm test && npm run typecheck && npm run build`

When done, print `git log --oneline origin/zh..HEAD` and the per-gate results.
