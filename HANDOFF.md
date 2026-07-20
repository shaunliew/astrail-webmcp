# Astrail Saved Reels Handoff

> **Current stop point: 2026-07-20 — the backend is DEPLOYED, MIGRATED and SMOKE-VERIFIED in
> production.** All seven Section B follow-ups are closed, plus six defects a cross-model review
> found that no one had listed. `dev` is at `12b5839`; the live service runs it. The 2026-07-19
> handoff below is superseded from "no deploy should proceed" onward — the deploy happened.
>
> **Zhi Hao: read "Backend release 2026-07-20" next. Three frontend PRs are waiting for you and
> the merge ORDER matters.**

## Backend release 2026-07-20 (Shaun)

### The headline you need

**The organize feature had never once worked in production.** `20260718130000_saved_reels_organize`
was written on 2026-07-18 and never applied, so `organize_jobs`, `organize_job_items`,
`organize_events` and `reel_place_mentions` did not exist on the deployed database. Every organize
attempt failed against missing tables, and `/health` stayed green throughout — it performs no schema
check.

The deployed DB was **seven migrations behind `dev`**, not level with it. Seventeen migrations were
applied in one run; local and remote are now identical at all 27.

Verified live, after the deploy, with a real Instagram Reel:

```
organize job f61709fc  ->  succeeded, 2 places, 0 failed
  'Harry Potter Cafe'  35.6735692, 139.7367042   JP / Japan
  'Akasaka Station'    35.67222,   139.73639     JP / Japan
  reel_place_mentions: user_id populated, verification_version = mapbox-country-v1
```

Also verified: burst limit returns **429** on the 4th request in a minute; a conflicting organize
returns **409**; an unowned Reel id returns **404**. None of these return 500 — that mattered,
because a migration in this batch changed the raised SQLSTATE from `P0001` to `AS4xx`.

### ⚠️ What changed that affects YOUR workflow

**`autoDeploy` is now OFF on the Render service.** Merging to `dev` no longer deploys the backend.
This was not a preference — with it on, merge *was* deploy, which made the standard "apply schema →
verify → merge" protocol impossible to execute, because there was no gap between the last two steps
to verify in. Deploy manually:

```bash
render deploys create srv-d976aess728c738pskk0 --wait --confirm
```

To re-enable it, something must first run migrations before the deploy — Render's
`--pre-deploy-command` running `supabase migration up` is the natural fit. Until that exists,
deploys stay manual. Full sequence: `docs/superpowers/plans/2026-07-20-saved-reels-release-runbook.md`.

**Frontend deploys are unaffected** — Vercel, separate pipeline.

### ⚠️ Merging stacked PRs — this bit us, twice

`gh pr merge 45` reported **✓ Merged** and merged Arc B into the wrong branch. #45's base was still
`feat/saved-reels-arc-a-reliability`, and GitHub had not yet retargeted it to `dev` after #44 merged
seconds earlier. The result was `dev` carrying code that could not speak to its own migrated schema —
caught only by verifying the outcome (`git merge-base --is-ancestor`) rather than trusting the
success message, and fixed by PR #49.

**Your three frontend PRs are stacked the same way.** Merge them in order, and *wait for each
retarget* before the next:

```
#46  Arc C          -> dev          DESIGN.md, CN->China, night->dawn relight
#47  Mascot         -> #46          astronaut + composed 404/error screens
#48  Design pass    -> #47          G2/G3/G4/G7 + the narration nobody could see
```

### What is waiting for you specifically

1. **Live-verify the night→dawn relight.** It has never been *seen* running — there was no Mapbox
   token in the worktree, so it is unit- and source-verified only. Mapbox does animate the preset
   change (~300ms default, `Transitionable` machinery); the specced 2s comes from
   `map.style?.setTransition({duration:2000})`. Watch one real generation complete.
2. **One glance at `/app/trips` in paper scope** after login. The mascot's paper rendering was
   verified against a token harness, not the real authenticated surface.
3. **ISSUES.md B8** — narrowing `saved_reel_cards` visibility is a visible frontend change and was
   deliberately left as your decision, not landed silently in a backend PR.
4. **`CN → China` wording.** `ISSUES.md` said this was yours to choose; the approved plan specified
   "China" so that shipped, structured as one entry in one `Record` so reversing it is a one-line
   change. `frontend/lib/reels/organize.ts`.

### Two findings in #48 that are not design nits

- **`TripDay.title`, `summary` and `weather_summary` — the narrator and weather agents' output —
  shipped in every bundle and rendered nowhere.** The backend paid for narration on every run and
  discarded it. New `DayOverview` renders them.
- **Small text in raw `--brass` sits at roughly 2.2:1 on paper**, because `--brass` does not remap in
  `.paper-scope`. Fixed across 8 files.

### Known, documented, NOT fixed

- **Pre-existing duplicate canonical places** (e.g. `Tokyo Dream Park` ×2) predate the fix that now
  prevents them. An advisory lock serialises `find_or_create_place` going forward; it cannot merge
  rows that already exist.
- **User-isolation smoke check not run** — it needs a second account and I would not use yours.
- The frontend has **no `error.tsx`/`not-found.tsx`** on `dev` yet; #47 adds them. Until it merges,
  production serves stock Next.js error screens.

### Where the reasoning lives

- Release sequence + the ten-migration table: `docs/superpowers/plans/2026-07-20-saved-reels-release-runbook.md`
- What cross-model review caught and why: `.claude/docs/BUILD-LOOP.md` (step 6, and "the six ways a test can't fail")
- Design system, now canonical: `DESIGN.md` at repo root — gstack design skills read it, and its §12 lists every remaining spec/ship gap

---

> Superseded stop point: 2026-07-19. The Saved Reels localhost MVP, global country-verification
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

**Updated 2026-07-20 — the Section B list below is CLOSED.** All seven landed in PRs #44/#45
(merged) and #46–#48 (open, frontend). B7's wording shipped as "China" per the approved plan and
stays a one-line change if Zhi Hao wants otherwise. What is actually left is in
"Backend release 2026-07-20" at the top of this file.

- ~~The seven agreed Section B follow-ups… B1, B4, B6, B2, B3, B5, B7.~~ **Done.**
- ~~Before any deploy, confirm Render's deployed `MAPBOX_SECRET_TOKEN`…~~ The deploy has happened
  and a real Reel geocoded correctly in production (`JP / Japan`, exact Tokyo coordinates), so the
  deployed token demonstrably carries working geocoding. If the *entitlement* question was about
  billing tier rather than function, it is still worth confirming — the smoke run proves it works,
  not that it is on the plan you intend to pay for.
- **Coordinate-to-venue identity verification remains an accepted MVP deferral.** Unchanged and
  still true: country containment is verified, the exact dot still trusts the research result.
- **Duplicate canonical `places` rows created before 2026-07-20 are not merged.** The advisory lock
  in `20260720160000` prevents new ones; existing pairs (e.g. `Tokyo Dream Park` ×2) need a
  deliberate merge pass if they matter.

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

**Updated 2026-07-20.** Items 1 and 2 are largely satisfied by the release smoke run — a real Reel
was captured, organized and geocoded against production, and its places persisted with `user_id`
scoping and `mapbox-country-v1` verification. What genuinely still needs a human:

1. ~~Compare the deployed Mapbox token's account/project…~~ Geocoding demonstrably works in
   production. Re-check only if the concern was billing tier rather than function.
2. **Partially done.** The Saved Reel → Organize → verified Tokyo pin half ran green against
   production. **The brief → trip-generation half did not** — that exercises the *other* durable
   path, the one Arc A's itinerary-fencing RPC and database-clock leases protect. Run one real trip
   generation end to end.
3. **Still open.** Confirm deployed access logs do not expose more bearer-token surface than the B1
   decision accepts. A redaction filter ships (`backend/log_redaction.py`) but has not been checked
   against real Render logs.
4. ~~Decide the B7 CN tray wording…~~ Shipped as "China"; verify it reads correctly in the live UI
   once #46 merges, and change the single `COUNTRY_DISPLAY_OVERRIDES` entry if you disagree.
5. **New — the night→dawn relight has never been seen running.** No Mapbox token was available where
   it was built. Watch one real generation complete after #46 merges.
6. **New — check a warm re-organize skips Apify.** Organize a Reel you have already organized and
   confirm it returns fast. A cache miss on the warm path means every re-organize spends real money,
   and the only symptom is the bill.

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
