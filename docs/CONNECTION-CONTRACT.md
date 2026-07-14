# Astrail Frontend ↔ Backend Connection Contract

> Backend-owned contract for the production connection. On `dev`, trip generation uses
> the authenticated backend client + live SSE, and trip detail/list reads use Supabase
> directly under RLS. `mock-api.ts` remains only for offline fixtures/tests and the
> still-unmigrated Settings view. Production remains gated on reviewed `dev` -> `main`
> promotion and Vercel environment/redeploy verification.

## Split
- **Writes / orchestration / streaming → backend** (`POST /generate-trip`, `GET /generate-trip/stream/{trip_id}`).
- **Finished-trip reads (list + itinerary) → Supabase-direct under RLS.** No backend read endpoints. RLS is the sole read-authz control and is gated in CI (`.github/workflows/rls-tests.yml`).

## Auth
- Frontend sends the Supabase session **`access_token`** (from `supabase.auth.getSession()`), a JWKS-verified JWT.
- `POST /generate-trip`: `Authorization: Bearer <access_token>`.
- SSE stream: `?token=<access_token>` (EventSource can't set headers), header fallback.
- Frontend Supabase client uses the **anon** key only. The `service_role` key must never reach the browser.

## CORS
- Backend allows origins from `ALLOWED_ORIGINS` (default `https://astrail.xyz,https://www.astrail.xyz`). Add Vercel preview origins there at deploy time.

## Rate limits (429 → `ErrorResponse` envelope)
- Burst: 3/min per user on `POST /generate-trip`.
- Daily: 5 trips/user/day (durable). Both return `{"error": {"code": "rate_limited", "message": "..."}}`.
- Both 429s share the same `code: "rate_limited"` — the frontend must distinguish them by
  **headers/message, not code**:
  - **Burst 429** carries a `Retry-After: <n>` header plus `X-RateLimit-*` headers
    (slowapi-injected via `headers_enabled=True`). `<n>` is the seconds remaining until the
    1-minute burst window resets — a countdown in the range `1..60`, **not** a fixed `60`.
    Drive any retry/backoff timer off this value, don't hardcode 60.
  - **Daily-cap 429** carries no `Retry-After` header; its message is exactly
    `"Daily trip limit reached. Try again tomorrow."`.
  - FE UX: check for the `Retry-After` header first — present means "slow down" (burst),
    absent means "daily cap reached."

## Error shape
- All errors: `{"error": {"code": string, "message": string}}` (mirror: `frontend/lib/trip/backend-types.ts` → `ErrorResponse`).
- This includes framework 404/405 and pre-stream 401/404 on the SSE endpoint (the error
  handler is registered on Starlette's base `HTTPException`, not just FastAPI's, so
  unmatched routes and wrong methods are enveloped too).
- The frontend must read `error.message`, **not** `detail` — `detail` is not present in
  any response shape.

## Health
- `/health` = liveness (Render deploy gate). `/readiness` = deep DB probe (monitoring only).

## Frontend production status
- [x] Generation uses `lib/trip/api.ts` with a token from `supabase.auth.getSession()`.
- [x] Trip detail and list use Supabase-direct reads under RLS.
- [x] `next.config.ts` builds CSP `connect-src` from `NEXT_PUBLIC_BACKEND_URL`.
- [ ] Replace the remaining Settings view `mock-api` reads/actions with real data paths.
- [ ] Add a production build/deploy guard that rejects `NEXT_PUBLIC_MOCK_AUTH=true`.
- [ ] Promote the reviewed `dev` branch to `main` and repoint Render to `main`.
- [ ] Set Vercel production `NEXT_PUBLIC_BACKEND_URL` to
  `https://astrail-backend.onrender.com`, confirm `NEXT_PUBLIC_MOCK_AUTH` is unset, and redeploy.
- [ ] Run and record the manual production E2E checklist before closing beta readiness.
