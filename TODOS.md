# TODOS

Deferred work with enough context to pick up cold. Spec-level deferrals (Realtime,
preference→agent feed, requested_places resolution, Google OAuth, custom SMTP) live in
`docs/superpowers/specs/2026-07-07-beta-auth-to-map-wiring-design.md` § Non-goals.

## Extract an `authedPost()` helper in `frontend/lib/trip/api.ts`

- **What:** Collapse the five near-identical authed-POST helpers (`requestSeat`,
  `requestAccountDeletion`, `cancelAccountDeletion`, `clearMemory`, `submitTripFeedback`) onto one
  `authedPost(path, accessToken, body?)` that owns the fetch/headers/`apiErrorFrom` boilerplate.
- **Why:** Each new endpoint currently copies ~15 lines of identical fetch plumbing; a sixth copy
  landed with the trip-feedback arc (2026-08-05 eng review flagged it, DRY preference).
- **Pros:** One place for headers/error-envelope handling; new endpoints become 3-liners.
- **Cons:** Touches four already-reviewed, shipped helpers for zero behavior change — churn on
  code with per-fn mock-auth short-circuits that don't fold into the shared shape trivially.
- **Context:** Deliberately NOT done inside the trip-feedback arc (minimal-diff rule; the arc
  copies the house pattern instead). The mock-auth short-circuits stay per-endpoint — only the
  network half extracts cleanly. See `frontend/lib/trip/api.ts`.
- **Depends on / blocked by:** Nothing; best bundled into the next arc that touches ≥2 of these
  helpers anyway.

## Cookie-cache the onboarding gate query

- **What:** Skip the middleware's per-request `traveler_profiles.onboarding_completed`
  SELECT by caching completion in a cookie or session claim, invalidated on onboarding save.
- **Why:** Removes one DB round-trip (~10ms) from every `/app/*` navigation once traffic grows.
- **Pros:** Cheap perf win; design + staleness edge case already thought through.
- **Cons:** Adds invalidation complexity; a stale "onboarded" claim could skip the gate on
  multi-device sign-ins. Worthless at beta scale.
- **Context:** Decided 2026-07-07 during `/plan-eng-review` of the beta wiring plan
  (issue 1, option 1A): keep the explicit per-request query for beta because it can never
  be stale. This TODO is the revisit path. Gate code: `frontend/middleware.ts` (onboarding
  gate block added by plan Task 4).
- **Depends on / blocked by:** Beta wiring shipped; middleware latency measurably matters.

## Repair a NULL `places.country` when the reused row's coordinate DIFFERS (R3)

- **What:** On a `_find_or_create_place` dedup hit onto a row whose `country_code` is NULL and
  whose stored coordinate is NOT the one we just verified, reverse-geocode **that row's own**
  coordinate, compare against the incoming place's claim, and fill via a CAS.
- **Why:** Option F (shipped 2026-08-03) only repairs when the row's coordinate is the *same*
  binary64 coordinate already grounded. That covered the measured case 4/4, but a genuinely
  different coordinate within the 500 m dedup radius still goes unrepaired forever — dedup reuse
  never repairs, so those rows render without a country indefinitely.
- **Pros:** Closes the remaining half of the NULL-absorption channel; recovers the Mapbox call
  already paid for on those places.
- **Cons:** Costs one extra reverse call per repair, and carries three unsolved problems (below)
  that F does not. Scored **6.2/10** at plan review — it is NOT ready as drafted.
- **Context:** Full spec + the three problems in
  `docs/superpowers/plans/2026-08-03-places-country-fill-on-dedup-hit.md` §6, which is the file
  to read before touching this. The problems, briefly:
  1. **Must fail closed** — if the row-coordinate grounding returns `None`, the candidate must be
     REJECTED too, or a Malaysian input still reuses a Singapore-coordinate NULL row.
  2. **Not true two-source venue agreement** — Mapbox verifies the row's coordinate; the incoming
     claim is only a compatibility gate, because name+500 m can merge different chain branches
     (`persist.py`'s own restaurant-dedup comment says so). Do not describe it as two-source.
  3. **The CAS closes pipeline-vs-pipeline only** — `find_or_create_place` can select a NULL row
     using any coordinate within 500 m and then overwrite unconditionally
     (`20260720180000:93`). No Python-only change closes that; it needs an RPC conditional
     update, i.e. a migration.
- **Depends on / blocked by:** beta (2026-08-08) shipped. **Re-gate before implementing** — the
  6.2 score stands. Note that converging on the RPC instead is NOT the cheaper path: the RPC
  matches `where name = p_name` (exact, case-sensitive) with no `aliases` parameter, so it would
  lose the pipeline's normalized name/alias matching and drop aliases on every row it creates.

## Stop the third `places` writer minting country-less rows

- **What:** `_find_or_create_restaurant_place` (`backend/pipeline/persist.py`) inserts a
  `places` row for every Mapbox restaurant POI with **no country at all**, by design. It is the
  only remaining writer that always produces NULL.
- **Why:** It is the ongoing *source* of the NULL rows that Option F and R3 exist to repair.
  Fixing the source shrinks the problem instead of chasing it. The live smoke showed several
  `POST /places 201` from this writer on a single run.
- **Pros:** Stops corpus growth of un-repairable rows; makes any future backfill finite.
- **Cons:** A Mapbox Search Box POI carries **no independent country claim** to compare against,
  so grounding it would write a bare reverse-geocode result — a *second, weaker* meaning of
  non-NULL `country` alongside the verified one, with no way to tell them apart. That is the
  exact failure mode `2026-08-02-places-country-two-writers.md` §2 rejects for option 1.
- **Context:** Needs a decision on what `country` means for provider-sourced rows BEFORE any
  code — either a separate provenance column, or an explicit redefinition applied to both
  writers. `RestaurantCandidate` (`backend/models/enrichment.py`) has Mapbox coordinates and a
  `mapbox_id` but no country claim.
- **Depends on / blocked by:** beta shipped; the `country`-semantics decision above.

## Landing mobile hero: scroll hint overlaps Aster's legs (QA ISSUE-002, cosmetic)

- **What:** At 375x812 the "SCROLL TO BEGIN" hint (`.story-scroll-hint`, bottom 26px) renders
  over the mobile Aster cutout's lower legs (`.story-hero-aster-mobile`, bottom 2.5%).
- **Severity/category:** Low / visual. Found by /qa on 2026-08-06 (report
  `.gstack/qa-reports/qa-report-astrail-zh-2026-08-06.md`, screenshot `mobile-hero.png`).
- **Repro:** viewport 375x812 → open `/` → hero: hint text sits on the figure's feet.
- **Fix sketch:** either lift the hint (`bottom: 8px` + smaller gap) or reserve a lane by
  capping `.story-hero-aster-mobile` height a touch lower on short-width phones. ZH has
  hand-tuned this hero's mobile clamps twice (story.css history) — change with his eye on it.
- **Depends on / blocked by:** Nothing.

## story-config.ts stale pre-launch config + orphaned beat clips

- **What:** `frontend/components/story/story-config.ts` still opens with the pre-launch seat
  truth ("ZERO claimed, boarding soon, waitlist as primary CTA") while the live page is open
  beta; `SEATS_CLAIMED`/`BOARDING_OPEN` feed only unmounted beat components; six `CLIPS`
  entries point into gitignored, locally-absent `/landing/clips/*` (referenced only by
  orphaned beat layers StoryStage never mounts — no live 404 today, but re-mounting any beat
  would 404 in prod).
- **Severity/category:** Low / hygiene. Found by the 2026-08-06 final-gate fable review.
- **Fix sketch:** one cleanup commit — rewrite the header comment to the open-beta truth and
  delete (or clearly quarantine) the orphaned beat layers with their CLIPS/SEATS constants.
- **Depends on / blocked by:** Nothing.
