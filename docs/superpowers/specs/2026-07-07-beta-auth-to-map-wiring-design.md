# Beta wiring: email OTP sign-in → onboarding → reels → itinerary on Mapbox

> Design spec agreed with Zhi Hao on 2026-07-07 (interview via astrail-plan-and-review /
> brainstorming). Codex implements via the plan derived from this spec.
> Missing source: EMDEE sprint docs were unavailable this session (MCP unauthenticated);
> this spec is grounded in the repo docs + two codebase exploration reports instead.

## Goal

A brand-new beta user can, end-to-end on localhost (deploy-ready config included):

1. Sign up / sign in with **email only** — receive a **6-digit code** by email, enter it, no password.
2. Complete the **preference onboarding wizard** once; returning users skip it.
3. Paste 1–5 Instagram Reel URLs + dates/budget/origin/notes and start a **real** generation.
4. Watch **live SSE stage events** while the pipeline runs.
5. See the finished, evidence-backed itinerary **on the Mapbox map** (pins, day grouping, route lines), saved and reloadable, listed on a trips page.

## Decisions (from the interview)

| Decision | Choice |
|---|---|
| Done bar | Localhost end-to-end, **deploy-ready** (env vars + CORS config landed, prod flip later) |
| Pipeline | **Real pipeline.** Acceptance run uses **fresh (uncached) reel URLs** → full Apify scrape + extraction. Dev iteration reuses cached reels for speed/cost. |
| Auth | **Passwordless email OTP only** (signup and sign-in are the same flow). Google OAuth hidden/deferred post-beta. No passwords anywhere. |
| Preferences | **Both layers**: one-time onboarding (stored on `traveler_profiles`) + per-trip free-text; backend merges both into the pipeline input. |
| Persistence | Trip saved + reloadable by URL + **trips list page**. |
| Generating UX | **Live stage events** rendered from SSE in the existing generating UI. |
| Failure UX | Total pipeline failure → explicit failed state (never a hang). Partial enrichment failure still renders (guardrail #3). |

## Current state (verified by exploration, 2026-07-07)

- Auth: Google OAuth only (`frontend/app/sign-in/page.tsx`); middleware guards `/app/*`; backend JWT/JWKS validation works (`backend/auth.py`). No email/OTP code exists.
- Onboarding wizard **fully built** (`frontend/components/onboarding/OnboardingWizard.tsx`, `frontend/lib/onboarding/onboarding.ts`) but saves via `mock-api.saveProfile` and **nothing gates users into it**. `traveler_profiles` + `user_preference_facts` tables exist with RLS (`supabase/migrations/20260701131304_identity_persona_foundation.sql`).
- Trip creation form built; `frontend/lib/trip/api.ts` (real client: POST + SSE with token) exists but **is never imported** — `CreateTripFlow.tsx` and `TripWorkspace.tsx` use `mock-api` and the Tokyo fixture.
- Backend: `POST /generate-trip` + `GET /generate-trip/stream/{trip_id}` exist with auth, durable jobs, owner checks, and correct `result` + `[DONE]` SSE termination.
- **Schema mismatch (guardrail #4 violation):** backend `GenerateTripRequest` lacks `requested_places`, `budget_level`, `origin_city`, `preferences`; dates are non-nullable; the trip insert drops those fields. DB columns already exist.
- Backend pipeline **ignores per-user preferences entirely** (only trip free-text reaches it — and today not even that).
- Mapbox map (`frontend/components/map/TripMap.tsx`) is complete and the pipeline already persists every field it consumes (lat/lng, `day_number`, `route_geometry`, leg `status`). No map changes needed.

## Design

### 1. Auth — passwordless email OTP
- Sign-in page: email input → `supabase.auth.signInWithOtp({ email })` → 6-digit code entry screen → `supabase.auth.verifyOtp({ email, token, type: 'email' })` → session. Same flow for new and returning users. Resend-code affordance; clear error on wrong/expired code.
- Remove/hide the Google button. Add sign-out (clears session → `/sign-in`).
- Existing middleware guard and backend JWT validation are unchanged.
- **Manual Supabase dashboard steps (documented in the plan, not code):** enable email OTP sign-in; edit the Magic Link / OTP email template to send `{{ .Token }}` (the 6-digit code) instead of a link; set OTP expiry ≈ 10 min.
- **Security posture:** no password store; Supabase rate-limits sends and verify attempts; account security = inbox security (equivalent to password-reset trust). **Before external beta users:** switch Supabase to custom SMTP (e.g., Resend) — built-in email service is rate-limited to a few emails/hour (dev-only).

### 2. Onboarding — wire and gate
- Wire wizard save directly to Supabase (architecture: reads/writes RLS-direct, no new backend endpoint): upsert own `traveler_profiles` row (origin_city, travel_style_tags, preference_tags, preference_notes), set `onboarding_completed = true`. Verify/add an RLS policy allowing users to update their own profile row.
- Gate: authenticated user with `onboarding_completed = false` is redirected to `/app/onboarding` (middleware or app-layout check — plan picks one and states why); completed users go straight to trip creation. Post-verify redirect respects the gate.
- Onboarding writes only the profile row for now. `user_preference_facts` write-path is deferred (trigger: memory feature goes active).

### 3. Backend — schema parity + preference merge
- `GenerateTripRequest` (backend/api/schemas.py) gains `requested_places: list[str] = []`, `budget_level: str | None`, `origin_city: str | None`, `preferences: str | None`; `start_date`/`end_date` become nullable. TS mirror already has these — all sides ship in the same PR (guardrail #4).
- `POST /generate-trip` persists budget_level, origin_city, preference_summary to the trips row.
- At generation time the backend fetches the user's `traveler_profiles` row and composes profile prefs + per-trip notes into the preference text the agents already consume. Plain string composition — no new agent, no new tables.
- Idempotency key: confirm whether preference changes should produce a new key; default is keep the current key (reels + dates) and document it.

### 4. Create flow — real API
- `CreateTripFlow.tsx` swaps `mock-api` → `lib/trip/api.ts`; obtains the Supabase session access token; `POST /generate-trip` → navigate to `/app/trip/[tripId]` → consume SSE, render stage events live in the existing generating UI; on `result`, render the itinerary. `mock-api` files stay in the repo but nothing imports them.

### 5. Trip page + trips list — real data
- `TripWorkspace.tsx` fetches the real trip bundle from Supabase RLS-direct (trips + trip_places/places + trip_days + transport_legs + restaurant/hotel suggestions), replacing the Tokyo fixture. The existing map/timeline components consume it unchanged.
- New minimal trips-list page: the user's trips (title, status, dates), linking to `/app/trip/[id]`.

### 6. Hardening + deploy-readiness
- Failed job → trip page shows explicit failed state from the error stage event.
- CORS `allow_origins` moves from `"*"` to an env-configured list.
- `.env.example` updated both sides; Supabase dashboard steps + SMTP note documented.

## Success criteria (acceptance bar for Codex)

1. Brand-new email → receives 6-digit code → enters it → signed in and routed to onboarding. Wrong/expired code shows a clear error; resend works.
2. Completing the wizard persists to `traveler_profiles` and routes to trip creation; on next sign-in, onboarding is skipped.
3. **Cold acceptance run:** paste fresh (uncached) reel URLs + brief → real `POST /generate-trip` → full Apify scrape + extraction runs → live stage events render → finished itinerary renders on the Mapbox map (evidence-backed pins, day grouping, route lines). Cached-reel runs are for dev iteration only.
4. The trips row contains budget_level, origin_city, and a preference summary reflecting **both** onboarding answers and per-trip notes.
5. Refreshing `/app/trip/[id]` reloads the trip; the trips list shows it; another user's trip id shows nothing (RLS); sign-out works; backend returns 401 without a valid JWT.
6. Pipeline failure → explicit failed state; SSE always terminates with `[DONE]` (success and error paths).
7. Deploy-ready: all required env vars in `.env.example` (both sides), CORS origin env-configurable, manual Supabase steps documented.

## Non-goals (deferred, with triggers)

- Google OAuth (post-beta), password auth (never for beta), password reset (n/a).
- Supabase Realtime subscriptions (trigger: live post-generation editing exists).
- `user_preference_facts` writes from onboarding/generation/feedback (trigger: memory feature active).
- Preference editing in Settings; trip deletion; `GET /trips*` backend endpoints (frontend reads RLS-direct by design).
- Custom SMTP setup itself (documented, executed before inviting external users).
- Per-stage pipeline checkpointing (per guardrail #12, restart-with-cache-reuse stands).

## Risks

- **Supabase built-in email rate limit** (~few/hour) can stall OTP testing — mitigate by testing with 1–2 addresses, move to custom SMTP when inviting users.
- **OTP template change** is a manual dashboard step; if missed, users get a link instead of a code — plan includes a verification step.
- **Cold Apify runs** cost real money and minutes — acceptance run is scripted once, not per-iteration.
- **Preference merge** touches pipeline input text — must not violate guardrail #11 (profile text is user-authored, but still goes through the same guardrailed input path as captions).
