# Astrail Frontend ↔ Backend Connection Contract

> Backend-owned contract for the production connection. The frontend is currently
> mocked (`frontend/lib/trip/mock-api.ts`); the real client `frontend/lib/trip/api.ts`
> exists but is unused. This documents what the frontend wires against.

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
  - **Burst 429** carries a `Retry-After: 60` header plus `X-RateLimit-*` headers
    (slowapi-injected via `headers_enabled=True`).
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

## Frontend TODOs to go live (Zhi Hao — OUTSIDE the backend workstream; beta blockers)
- [ ] Replace `mock-api` imports with `lib/trip/api.ts`; source the token from `supabase.auth.getSession()`.
- [ ] Add the Render backend origin to `next.config.ts` CSP `connect-src` (else the browser silently blocks the fetch + EventSource).
- [ ] Add a `NEXT_PUBLIC_MOCK_AUTH` production kill-switch (it currently has no build-time guard).
- [ ] Set `NEXT_PUBLIC_BACKEND_URL` to the real Render URL in Vercel prod; confirm `NEXT_PUBLIC_MOCK_AUTH` is unset there.
- [ ] Wire Supabase-direct reads for trip list/detail (`.from('trips')...` under RLS).
