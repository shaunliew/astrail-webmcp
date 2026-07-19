# Astrail Saved Reels Handoff

> Current stop point: 2026-07-19. The Saved Reels localhost MVP, global country-verification
> repair, and Section A reliability fix arc are implemented and verified on `zh` through
> `0216a0e`. The seven Section B follow-ups remain open in `ISSUES.md`; no deploy should
> proceed until Render's Mapbox token provenance is confirmed.
>
> The 2026-07-15 beta-wiring handoff is superseded. That auth-to-map wiring work is merged
> and live; this handoff starts from the completed Saved Reels implementation.

## What this session is building

This session built the real Saved Reels path end to end: **inbox -> select up to five Reels
-> Organize as a durable job -> verified country trays with exact research pins -> trip
brief -> place-only trip generation.** Lightweight capture remains extraction-free;
uncached Organize work uses real Apify + OpenAI extraction, while a current-version cache
hit skips both and still reruns the Mapbox country check.

It also repaired the Tokyo-pinned-in-Mexico failure at the authority boundary. Mapbox
Search Box is no longer allowed to choose or overwrite organizer geography. The extractor
proposes sourced coordinates and country, deterministic validation rejects incomplete or
circular evidence, and Mapbox Geocoding v6 independently checks the coordinate's ISO
country. Only mentions stamped `verification_version = 'mapbox-country-v1'` can reach a
Saved Reel card, tray, pin, selected-place authorization, or generated trip. A mismatch or
provider failure fails closed.

Governing documents:

- Design: `docs/superpowers/specs/2026-07-18-saved-reels-trustworthy-location-grounding-design.md`
- Schema plan: `docs/superpowers/plans/2026-07-18-saved-reels-schema-foundation.md`
- Localhost MVP plan: `docs/superpowers/plans/2026-07-18-saved-reels-localhost-mvp.md`
- Global verification plan: `docs/superpowers/plans/2026-07-18-saved-reels-global-location-verification.md`
- Review/fix tracker: `docs/superpowers/reviews/2026-07-18-saved-reels-fix-tracker.md`
- Converged fix plan: `docs/superpowers/reviews/2026-07-19-saved-reels-implementation-plan.md`

## Progress: Saved Reels implementation and Section A fixes done

### Schema foundation

| Commit | What landed |
|---|---|
| `c5018fd` | Added typed Saved Reel capture persistence, canonical URL reuse, and a local-only real RPC integration smoke. |
| `aaca33a` | Exposed authenticated `POST /saved-reels`; ownership comes from the verified JWT and capture stays extraction-free. |
| `1eaefc2` | Added frontend Saved Reel, collection, capture-request, and response contracts with TypeScript parity tests. |
| `cedf1e7` | Recorded the Saved Reels schema-foundation design and implementation receipt. |

### Organize MVP

| Commit | What landed |
|---|---|
| `80848ae` | Added durable organize jobs/items/events, safe Saved Reel projections, country fields, usage accounting, trusted mentions, and pgTAP coverage. |
| `6a83384` | Added the organizer, authenticated status/SSE endpoints, cache and quota handling, reverse-country verification, selected-place authorization, and place-only trip generation. |
| `175095b` | Added the real inbox -> Organize globe -> country trays/map -> brief -> generation frontend flow and tests. |

### Localhost and map fixes

| Commit | What landed |
|---|---|
| `0e821d8` | Anchored trip-map wheel zoom to the map center so the pin no longer appears to follow the cursor. |
| `2fe51dc` | Made localhost Supabase/CSP behavior safe, retained production HSTS, enabled Mapbox's required WebAssembly evaluation, and added a local OTP template. |

### Location-verification design, plans, and developer tooling

| Commit | What landed |
|---|---|
| `2ddf09f` | Recorded the approved global grounding design and the schema, localhost MVP, and verification implementation plans. |
| `3acc977` | Added the local Graphify viewer launcher and ignored Graphify, gstack, Claude-local, and pytest-generated output. |

### P2-1 through P2-7 and P3 reliability arc

| Commit | What landed |
|---|---|
| `9512495` | Revoked authenticated access to the private schema while proving the owner-scoped verified-place RLS path still works. |
| `3ec73e5` | Added outer organizer terminal cleanup so unexpected failures cannot strand a job in `processing`. |
| `c282ca2` | Made analysis reserve/refund state atomic and exactly once, persisted the usage date, and stopped replaying terminal items. |
| `48f8c6a` | Made organize-job creation atomic and rejected a whole overlapping request with HTTP 409 and a specific frontend retry message. |
| `c8e0581` | Rejected coordinate-echo and Google Maps search evidence URLs, required an independent venue page, and bumped the extractor version. |
| `5062be1` | Added `has_current_cache` across SQL/TypeScript/UI and locked its extractor-version and trust-stamp parity with tests. |
| `c6a3c4d` | Added one durable polling fallback after a clean or failed organize stream closes before the job becomes terminal. |
| `75c9b32` | Closed the P3 batch: Mapbox wheel anchoring, image CSP, 408/429 retry handling, UUID validation, dead stream removal, sanitized logs, and the mock-auth regression gate. |
| `e7635c1` | Recorded the converged implementation plan and completion tracker for the review arc. |

### Post-review database repair

| Commit | What landed |
|---|---|
| `0216a0e` | Claude's code review fixed the current-cache view replacement, pgTAP role context, fixture leakage, and assertion count so clean reset/test/lint actually pass. |

`0216a0e` is a Claude code-review correction, not new Codex feature work. It caught a real
bug in the earlier migration: `has_current_cache` had been inserted in the middle of a
`CREATE OR REPLACE VIEW` column list, which Postgres interprets as an illegal rename. It
also repaired tests that ran under the wrong role and P2-6 fixtures that polluted later
row-count assertions. The useful process lesson for Shaun is to treat a clean
`supabase db reset && supabase test db` as a mandatory result, never as an optional or
environment-only gate; the implementation was not complete until that sequence passed.

## Key decisions that must remain locked

The P2-7 evidence contract uses option B. Coordinate-echo URLs and
`google.com/maps/search` URLs are rejected; accepted evidence must be a real independent
venue page such as an official site, Tabelog, TableCheck, or a stable Google Maps `/place/`
URL. This makes evidence non-circular. It does **not** prove that the extracted coordinate
belongs to the named venue. Reverse `types=poi` plus name matching, or a second coordinate
source, remains explicitly deferred and has not started.

The overlap rule is whole-request rejection. If any selected Saved Reel is already in a
different active organize job, the atomic RPC creates nothing partial and the API returns
HTTP 409. The frontend shows the agreed retry message rather than a raw status code.

With `NEXT_PUBLIC_MOCK_AUTH=true`, `/app` deliberately renders the existing offline
`CreateTripFlow`. This arc did not add a mocked Saved Reels inbox.

Mapbox permanent Geocoding v6 entitlement and billing are confirmed on Zhi Hao's account.
Live permanent reverse probes returned JP for Tokyo, CN for Shanghai, and KR for Seoul.
The remaining deployment question is whether Render's `MAPBOX_SECRET_TOKEN` belongs to
that same entitled account.

After `0216a0e`, the full localhost flow was reverified with real OTP sign-in and real
providers: the Reel was saved, Apify scraped it, OpenAI extracted it, Mapbox reverse-country
verification produced a Japan tray and Tokyo pin, the evidence `source_url` was a real
Tabelog listing rather than a coordinate echo, the canonical place reached trip generation,
and a second Organize used the cache without another scrape, without a second quota charge,
while still allowing terminal-job reprocessing.

## Verification state at this handoff

Fresh verification run on 2026-07-19 after `0216a0e`:

| Gate | Result |
|---|---|
| `backend: uv run pytest -q --basetemp=.pytest-tmp` | **585 passed, 7 skipped**, 3 dependency deprecation warnings |
| `backend: uv run pytest evals/ -q --basetemp=.pytest-tmp` | **49 passed** |
| `supabase db reset` | All migrations through `20260719103000` applied successfully |
| `supabase test db` | **7 files, 398/398 tests passed** |
| `supabase db lint --local` | **No schema errors found** |
| `frontend: npm test` | **43 files, 170 tests passed** |
| `frontend: npm run typecheck` | **Passed** |
| `frontend: npm run build` | **Passed**, Next.js production build generated all routes |

## Remaining

- The seven agreed Section B follow-ups are documented in root `ISSUES.md`, ordered B1,
  B4, B6, B2, B3, B5, B7. B1 and B7 require Zhi Hao's product/design decision; B2-B6 are
  implementation calls for Shaun.
- Before any deploy, confirm Render's deployed `MAPBOX_SECRET_TOKEN` was issued by the same
  Mapbox account whose invoice and live probes confirm permanent-geocoding entitlement.
- Coordinate-to-venue identity verification remains an accepted MVP deferral. Country
  containment is verified; the exact dot still trusts the research result.

## Machine/environment quirks (will bite you if forgotten)

- Run backend pytest from `backend/` with `--basetemp=.pytest-tmp`. The normal Windows
  `%TEMP%\pytest-of-*` location has produced permission failures on this machine.
- In a restricted Codex sandbox, `uv` may fail to open
  `%LOCALAPPDATA%\uv\cache\sdists-v9\.git`; rerun the test with permission to use the
  existing uv cache. This is not a product or test failure.
- Supabase verification requires Docker Desktop's Linux engine. Docker Desktop needed one
  reset during the earlier verification session; if reset/test hangs or cannot connect,
  restart the Linux engine and rerun the entire reset -> test -> lint sequence.
- `supabase db reset` erases local auth and acceptance fixtures. A later live acceptance
  run must sign in again and recreate its Saved Reel.
- Frontend npm commands must run from `frontend/`.
- Graphify output is ignored and does not update automatically. Refresh with
  `graphify update backend` and `graphify update frontend` before using its local graph.

## External state already configured (do NOT redo)

- Mapbox permanent Geocoding v6 is enabled and billed on Zhi Hao's account; local JP/CN/KR
  probes passed. Only Render token provenance remains open.
- Local Supabase reset/test/lint is healthy through all Saved Reels migrations.
- Local `backend/.env` and `frontend/.env.local` exist; their secret contents were not copied
  into this handoff.
- Custom email/OTP delivery is already configured; the completed localhost acceptance used
  a real OTP sign-in.

## Manual QA that only a human can do

1. In Render, compare the deployed Mapbox token's account/project with the account carrying
   permanent-geocoding entitlement before deployment.
2. After deploying the migrations and backend/frontend together, repeat one real OTP ->
   Saved Reel -> Organize -> Japan tray/Tokyo pin -> brief -> trip run against production.
3. Confirm deployed access logs do not expose more bearer-token surface than the B1 decision
   explicitly accepts.
4. Decide the B7 CN tray wording in product copy and verify it in the actual UI locale.

## Session log pointers

- Open implementation follow-ups: `ISSUES.md`.
- Review source and account entitlement receipt:
  `docs/superpowers/reviews/2026-07-18-saved-reels-fix-tracker.md`.
- Executed fix sequence and locked decisions D1-D3:
  `docs/superpowers/reviews/2026-07-19-saved-reels-implementation-plan.md`.
- Trust architecture and rollback boundary:
  `docs/superpowers/specs/2026-07-18-saved-reels-trustworthy-location-grounding-design.md`.
- Complete implementation range: `de56ac03868bf5ee6dbbe32fbe40f8f280dbea39..0216a0e`.
- gstack review/QA artifacts remain under `~/.gstack/projects/MalaysiaKaki-astrail/`.
