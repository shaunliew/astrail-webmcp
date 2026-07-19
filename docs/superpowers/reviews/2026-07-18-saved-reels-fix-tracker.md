# Saved Reels `zh` — Fix Tracker (from 2026-07-18 final review)

Verdict at review: **REQUEST CHANGES**. Core trust contract proven live (Japan tray, Tokyo
pin, cache-hit retry, no re-scrape, quota reserve/consume happy path). No P0/P1. Everything
below is P2/P3/hygiene. Line numbers drift — find code by symbol.

**Status 2026-07-19: Section A fully landed and verified.** Codex implemented all 9 commits
(`9512495`..`e7635c1`). Claude's commit-by-commit review found the `supabase db reset &&
supabase test db` gate still red after Codex's own run reported it "unavailable" — three
real bugs, not environment noise: (1) the P2-5 view migration inserted a column mid-list in
`CREATE OR REPLACE VIEW`, which Postgres treats as an illegal rename; (2) the P2-1 lockdown
test and one metadata-introspection assertion ran under the wrong role, so they either
silently passed as superuser or broke after the lockdown correctly took effect; (3) the
P2-6 pgTAP fixtures leaked extra Saved Reels/jobs into three downstream row-count
assertions written against the original single-fixture shape. All three fixed in `0216a0e`.
**Full gate now green: backend 585/7 skip, evals 49, pgTAP 398/398, `db lint` clean,
frontend 170 tests + typecheck + build.** Final verdict: **PASS** — ready for Zhi Hao's
Section B pass and live localhost re-verification before merge.

Execution model: Claude drives Codex CLI — planning critique on `gpt-5.6-sol`
(`model_reasoning_effort="high"`), implementation/coding on `gpt-5.6-luna`
(`model_reasoning_effort="xhigh"`) — one commit per task, no push, then Claude reviews
commit-by-commit. Product/design calls escalate to Zhi Hao.

## What already works (do not re-litigate)

- Reel → Organize → verified Japan tray → Tokyo pin at research coords → brief → place-only
  trip generation, end to end, real auth + real providers.
- Cross-country mispin (Tokyo→Mexico) is structurally dead: Search Box is out of the
  organizer authority path; only `mapbox-country-v1`-stamped mentions reach cards/pins/trips.
- Trust gate enforced three ways (view, `places` RLS policy, `authorize_place_ids`); cleanup
  fails closed then sets NOT NULL. RLS + composite owner FKs + service-role-only mentions hold.
- Secret Mapbox token never leaks to logs/exceptions/client (verified live).
- Live Mapbox permanent Geocoding v6: Tokyo→JP, Shanghai→CN, Seoul→KR (local token).

---

## A. Delegated to Codex (Claude reviews its commits, doesn't redo)

- [x] **P2-1** `supabase test db` red on clean reset — `grant usage on schema private to
  authenticated` (migration 20260718190000) broke `002_trip_job_rls.sql` test 9, and weakened
  the schema-usage defense layer. Fix via new forward-only migration. *Gate: `supabase db reset
  && supabase test db` fully green.*
- [x] **P2-2** Organize job hangs in `processing` — only the item loop is exception-guarded;
  `run_organize_job` needs terminal cleanup (failed status + `result` event) on any escape.
  `lock_expires_at` is written but never read at runtime.
- [x] **P2-3** SSE 5-min synthetic timeout / finish-error leaves frontend with no poll
  fallback (`SavedReelsFlow.tsx` — poll only arms via `onFail` after 5 EventSource errors;
  a clean `[DONE]` close after a non-terminal status arms nothing).
- [x] **P2-4** Quota not exactly-once — 3 crash windows: (a) reserve RPC / item `reserved`
  stamp split → double charge on requeue; (b) requeued `refunded`-state item skips reservation
  then the `consumed` update violates the `analysis_charge_state` CHECK after paying Apify;
  (c) `date.today()` at reserve AND refund → midnight leak + server-TZ vs Postgres
  `current_date` skew. Make reserve+stamp atomic; `refunded` ⇒ needs new reservation; persist
  and reuse the reservation usage_date.
- [x] **P2-5** "Cache ready/free" badge keys on `reel_cache_id`, wrong for
  invalidated/old-`EXTRACTOR_VERSION` rows — expose current-version signal via the
  `saved_reel_cards` view + TS type (same commit, schema parity guardrail #4).
- [x] **P2-6** Same Reel runs in overlapping active jobs (idempotency key = sorted reel-id
  set, so `[A]` and `[A,B]` are both active and both process A) — add an active-item guard;
  preserve identical-request idempotency.
- [x] **P2-7** Evidence contract — **DECISION: option B.** Reject coordinate-echo /
  `google.com/maps/search` URLs as `source_url`; force a real independent venue page
  (TableCheck/Tabelog/official site/real Google Maps `/place/` URL with an embedded
  place id). Update the extractor prompt accordingly. Bump `EXTRACTOR_VERSION`.
  *Scope bound: makes evidence non-circular only; does NOT prove coords match the venue —
  the identity check (types=poi + name-match) stays deferred (C3).*
- [x] **P3 batch**: VerifiedPlacesMap `scrollZoom:{around:'center'}` + test ·
  `img-src` add `https://*.cdninstagram.com https://*.fbcdn.net` · `mapbox_reverse.py` retry
  429/408 once (honor `Retry-After`, cap seconds) · UUID-validate `saved_reel_ids`/`place_ids`
  (422 not 500) · delete dead `stream_organize_status` · sanitized server log line in the
  organizer item `except` (distinguish quota/Apify/Mapbox; no tokens/URLs/payloads) ·
  `/app` mock-auth regression gate (`NEXT_PUBLIC_MOCK_AUTH=true` must still render a
  zero-backend dev flow).

Implementation note (2026-07-19): all delegated A-section changes landed on `zh` in
the approved one-commit-per-step order. The local Supabase database gate still requires
the Docker Desktop Linux engine; no unavailable DB result is treated as passing.

---

## B. Claude + Zhi Hao together (Codex may see for context; design calls go to Zhi Hao)

- [ ] **B1 — JWT in stream logs.** EventSource `?token=<JWT>` on the organize stream (and the
  pre-existing trip stream) puts full bearer tokens in uvicorn/Render access logs (observed
  live). Options: short-lived one-time stream tokens, or redact query strings from access
  logging. Design call.
- [ ] **B2 — Legacy null-country `places` never reused.** `_persist_place` matches on
  `(name, country_code)`; pre-migration rows have null `country_code` → duplicate canonical
  rows. Fix: null-country match handling or backfill.
- [ ] **B3 — Organizer `places` rows get no embedding.** They bypass the pgvector dedup
  flywheel. Fix: embed on insert, or document as accepted for MVP.
- [ ] **B4 — Startup organize recovery is unbounded.** Lifespan spawns one task per pending
  organize job, no semaphore. Reuse the trip-recovery bound.
- [ ] **B5 — `_record_organize_event` `MAX(sequence)+1` non-atomic.** Safe only under the
  CAS-claim single-writer invariant. DB sequence, or a load-bearing comment if accepted.
- [ ] **B6 — Mixed `reel_urls` + `place_ids` silently drops the reels.** Runner takes the
  `place_ids` branch. Fix: reject the combination in `GenerateTripRequest`.
- [ ] **B7 — CN tray label.** Live Mapbox canonical `country_name` is
  `People's Republic of China`; fixtures say "China". Product-wording decision.

---

## C. Ops & product decisions

- [x] **C1 — Mapbox permanent-geocoding entitlement: CONFIRMED at account level.**
  2026-07 Mapbox invoice bills "Permanent Geocoding API: 19 requests" ($5) on Zhi Hao's
  account — permanent mode is enabled and billing. Live probes returned JP/CN/KR. Remaining
  sliver before deploy: confirm the Render env `MAPBOX_SECRET_TOKEN` is a token from THIS
  account. Note: permanent geocoding is paid per request — batching/caching country checks is
  a future cost lever (each organize place = 1 billed request).
- [x] **C2 — P2-7 direction: option B chosen** (real, non-circular evidence).
- [ ] **C3 — Deferred (accepted for MVP):** full coordinate-identity verification
  (reverse `types=poi` + name-match, or a second coordinate source). Country is verified; the
  exact dot is trusted to research. Revisit only if a measured mispin rate justifies the cost.

---

## D. Hardcoded-value register (decide keep vs. surface, per item)

- [ ] Quota cap `5` — SQL literal in `reserve_daily_reel_analysis`; duplicated in inbox copy
  and `MAX_SELECTED=5`. Changing it = migration + 3 hand-synced spots.
- [ ] `max_polls=600`/`poll_s=0.5` (streaming) — the 5-min ceiling behind P2-3; name/config it
  once P2-3 lands.
- [ ] 15-min `lock_expires_at` — written, never read at runtime; `INITIALIZING_STALE_AFTER_S=120`
  is the enforced one.
- [ ] `date.today()` in `usage.py` — folded into P2-4.
- [ ] Place-type whitelist + `transport→station` in `_persist_place` — unknown categories
  silently become `other`.
- [ ] `country="jp"` + `TOKYO` in `mapbox_forward.py` — capture-CLI-only, intentional,
  unreachable from the organizer. **Leave it**; a one-line "capture-only" comment prevents scares.
- [ ] `"mapbox-country-v1"` — trust stamp, hand-synced Python↔SQL; a typo silently hides all
  places. Suggest a pgTAP parity assertion.
- [ ] `'invalidated-searchbox-2026-07-18'` — cleanup sentinel; safe while no real
  `EXTRACTOR_VERSION` equals it.
- [ ] "Return at most 10 places" — fan-out cap lives in prompt prose; no test guards it.

---

## Review protocol for Codex's work (Section A)

Per commit: read the actual diff (not the message), fault-inject each new guard (revert it,
watch the new test go red, restore), then rerun the affected gate — `uv run pytest`,
`supabase db reset && supabase test db`, `npm test`/`typecheck`/`build`. PASS only when all
six P2s land clean and the DB suite is green. The frozen offline eval anchor
`mean_intra_day_travel_m = 6229.0` must not move.
