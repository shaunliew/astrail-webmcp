# TODOS

Deferred work with enough context to pick up cold. Spec-level deferrals (Realtime,
preference→agent feed, requested_places resolution, Google OAuth, custom SMTP) live in
`docs/superpowers/specs/2026-07-07-beta-auth-to-map-wiring-design.md` § Non-goals.

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
