# Phase-2 Backend API-Surface Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Astrail backend API surface production-ready for public beta — per-user rate limiting, hardened CORS, a consistent error envelope, a readiness probe, a CI gate that proves RLS still protects the frontend's direct-read path, and a finalized deploy Blueprint.

**Architecture:** Additive hardening only — no change to the pipeline, the durable-jobs spine, or the frozen SSE contract. Two-layer rate limiting on `POST /generate-trip` (slowapi in-memory burst keyed per authenticated user + a durable daily quota in the existing `user_daily_usage` table via an atomic Postgres RPC). CORS moves from wildcard to an env-driven allowlist. Errors are normalized to one JSON envelope with a TypeScript mirror. Finished-trip reads stay on the frontend↔Supabase-direct path under RLS (already built + tested); this plan adds a GitHub Actions gate so RLS regressions block merges.

**Tech Stack:** FastAPI (async), `slowapi==0.1.10`, `supabase==2.31.0` (async, service-role key), Supabase Postgres + pgTAP, Supabase CLI in GitHub Actions, Python 3.14, uv.

## Global Constraints

- **Feasible-first.** Smallest working hardening; every deferral below has a concrete trigger. Over-engineering is a review finding.
- **Frozen SSE contract (guardrail #4 / repo's most breaking contract).** Do NOT touch `backend/api/streaming.py`, the raw `data:` frames, or the `data: [DONE]` sentinel. This plan does not migrate anything to `EventSourceResponse`.
- **Eval-safety.** Everything here is a pure HTTP-entry gate or CI/deploy config. It must never touch the runner, `dedupe`, `assemble_itinerary`, or the frozen `#16` anchor `mean_intra_day_travel_m = 6229.0`. Run `uv run pytest evals/ -q` after any backend change to confirm the anchor is unmoved. Nothing here may construct a live client at import time.
- **Auth is DONE — reuse, don't rebuild.** `Depends(get_current_user_id)` (header) and `get_user_id_from_query_or_header` (stream) already verify Supabase JWTs via JWKS. Do not change their signatures — `test_auth.py` calls them directly ~15×.
- **Guardrails:** #4 schema parity (every new response shape gets a TS mirror in `frontend/lib/trip/backend-types.ts`), #5 auth on every endpoint (rate-limited endpoint stays authed; `/health` + `/readiness` are unauthenticated infra probes by design), #6 owner checks / RLS unchanged.
- **Versions (verified from the installed trees):** `slowapi==0.1.10`, `supabase==2.31.0`, Python 3.14. `slowapi` default `storage_uri` is `memory://` (correct for single Render instance).
- **Package manager:** uv only. No `requirements.txt`.
- **CORS prod origin:** `https://astrail.xyz` (domain purchased). Env-driven allowlist so Vercel preview origins can be added at deploy time without a code change.
- **Rate limits (locked in interview):** daily quota = **5 trips/user/day**; burst = **3/minute** on `POST /generate-trip`.

---

## Interview decisions this plan encodes (do not re-litigate)

- Finished-trip **reads = Supabase-direct under RLS** (already built + tested — `supabase/tests/001,002,003`). **No backend `GET /trips` endpoints** in scope.
- **Preferences/settings endpoint = OUT** (mem0 personalizes implicitly; deferred until a real FE settings screen exists).
- **Writes/orchestration/streaming = backend** (unchanged): `POST /generate-trip` + SSE.
- **RLS verification = FULL** — stand up the CI gate now.
- **Quota storage** = the existing `public.user_daily_usage` table (`generated_trip_count`, `unique(user_id, usage_date)`); no new table.

## Deferrals (each with a trigger)

- **`auth.py` defense-in-depth (`iss` verification + clock `leeway`)** → defer. JWKS already fails-closed for other projects' keys, so `iss` is marginal and carries breakage risk (exact Supabase `iss` format unconfirmed). Trigger: a confirmed `iss` string from a live token, or a clock-skew 401 actually observed.
- **Redis/Key-Value slowapi `storage_uri`** → defer. Trigger: Render scales past 1 instance (in-memory burst counts would then diverge per instance).
- **DB-level `CHECK`/trigger hard cap on daily quota** → defer. The atomic RPC already makes the increment race-safe; trigger: a need to enforce the cap for writers other than this endpoint.
- **preferences/settings endpoint + `GET /trips` endpoints** → defer (see interview decisions). Trigger: FE moves off Supabase-direct reads / ships a settings screen.
- **Docker-layer caching for the RLS CI job** → defer. Trigger: CI wall-clock becomes a measured bottleneck (>~2 min).

## Non-goals (belong to the broader "Both P2" card / Zhi Hao / other work)

- Any frontend implementation. The FE↔backend wiring is currently **mocked** (`frontend/lib/trip/mock-api.ts`); the real client `frontend/lib/trip/api.ts` is built but unused. Task 9 produces the **contract doc** the frontend wires against, but the wiring itself (replace mock-api, add the Render origin to `next.config.ts` CSP `connect-src`, add a `NEXT_PUBLIC_MOCK_AUTH` prod kill-switch, set `NEXT_PUBLIC_BACKEND_URL`) is Zhi Hao's. **Public beta cannot work end-to-end until those land — flag, don't implement.**
- README/license/architecture-diagram/observability/feedback-capture (the rest of the "Both" release card).
- Any booking/payment surface.

---

## File Structure

- **`backend/rate_limit.py`** (new) — rate-limit config (env), the `Limiter` singleton, the per-user `key_func`, the `get_current_user_id_stashed` wrapper dependency, and the daily-quota helper functions. One responsibility: everything the rate-limit feature needs, importable by `main.py`.
- **`backend/api/errors.py`** (new) — the `ErrorResponse` model + exception handlers. One responsibility: normalize error output.
- **`supabase/migrations/20260707120000_daily_trip_quota_rpc.sql`** (new) — atomic increment/decrement RPC functions on `public.user_daily_usage`.
- **`supabase/tests/004_anon_denial.sql`** (new) — pgTAP: unauthenticated `anon` cannot read `public.trips`.
- **`supabase/tests/005_daily_quota_rpc.sql`** (new) — pgTAP: the quota RPC caps at the limit and floors at 0.
- **`.github/workflows/rls-tests.yml`** (new) — CI gate: `supabase db start` → `supabase test db`.
- **`backend/main.py`** (modify) — register limiter + error handlers + CORS allowlist; wire the two-layer limit + refund into `POST /generate-trip`; add `GET /readiness`.
- **`frontend/lib/trip/backend-types.ts`** (modify) — add the `ErrorResponse` TS mirror (guardrail #4).
- **`render.yaml`** (modify) — add `ALLOWED_ORIGINS` + `DAILY_TRIP_QUOTA` + `BURST_LIMIT` env keys.
- **`docs/CONNECTION-CONTRACT.md`** (new) — FE↔backend production connection contract (handoff to Zhi Hao).
- Tests: **`backend/test_rate_limit.py`** (new), additions to **`backend/test_main.py`** / **`backend/test_main_integration.py`**.

Task order respects dependencies: 1 (rate-limit foundation) → 2 (quota RPC + helper) → 3 (error envelope) → 4 (wire the limit into the route, depends on 1+2+3) → 5 (CORS) → 6 (readiness) → 7 (RLS CI gate) → 8 (render.yaml) → 9 (contract doc).

---

### Task 1: Rate-limit foundation (`backend/rate_limit.py`)

**Files:**
- Create: `backend/rate_limit.py`
- Test: `backend/test_rate_limit.py`

**Interfaces:**
- Produces:
  - `limiter: Limiter` — module singleton (`key_func=rate_limit_key`, `headers_enabled=True`, default `memory://`).
  - `rate_limit_key(request: Request) -> str` — returns `request.state.user_id` if set, else `get_remote_address(request)`.
  - `BURST_LIMIT: str` — from env `BURST_LIMIT`, default `"3/minute"`.
  - `DAILY_TRIP_QUOTA: int` — from env `DAILY_TRIP_QUOTA`, default `5`.
  - `async def get_current_user_id_stashed(request: Request, authorization: str | None = Header(None)) -> str` — calls the existing `get_current_user_id`, stashes `request.state.user_id`, returns it.

- [ ] **Step 1: Write the failing test**

```python
# backend/test_rate_limit.py
from types import SimpleNamespace

import pytest
from starlette.requests import Request

import rate_limit


def _fake_request(user_id=None, client_host="1.2.3.4") -> Request:
    scope = {
        "type": "http",
        "headers": [],
        "client": (client_host, 12345),
        "state": {},
    }
    req = Request(scope)
    if user_id is not None:
        req.state.user_id = user_id
    return req


def test_key_func_uses_user_id_when_present():
    req = _fake_request(user_id="user-abc")
    assert rate_limit.rate_limit_key(req) == "user-abc"


def test_key_func_falls_back_to_ip_when_no_user():
    req = _fake_request(user_id=None, client_host="9.9.9.9")
    assert rate_limit.rate_limit_key(req) == "9.9.9.9"


def test_defaults():
    assert rate_limit.DAILY_TRIP_QUOTA == 5
    assert rate_limit.BURST_LIMIT == "3/minute"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest test_rate_limit.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'rate_limit'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/rate_limit.py
"""Rate-limit config, the slowapi Limiter singleton, the per-user key function,
and the durable daily-quota helpers.

Two layers gate POST /generate-trip:
  - Layer 1 (durable): a per-user daily trip quota in public.user_daily_usage,
    enforced via an atomic Postgres RPC (survives restarts; the real free-tier cap).
  - Layer 2 (burst): slowapi in-memory, keyed on the authenticated user id
    (request.state.user_id, stashed by get_current_user_id_stashed) with an IP
    fallback for unauthenticated callers.

Pure HTTP-entry gate — never touches the runner, dedupe, or the #16 eval anchor.
In-memory storage is correct for a single Render instance; switch storage_uri to
Render Key Value only when scaling past one instance.
"""
from __future__ import annotations

import os

from fastapi import Header, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from auth import get_current_user_id

BURST_LIMIT: str = os.environ.get("BURST_LIMIT", "3/minute")
DAILY_TRIP_QUOTA: int = int(os.environ.get("DAILY_TRIP_QUOTA", "5"))


def rate_limit_key(request: Request) -> str:
    """slowapi key: the authenticated user id if an auth dependency stashed it,
    else the client IP. Sync (slowapi requires a sync key_func)."""
    user_id = getattr(request.state, "user_id", None)
    return user_id if user_id else get_remote_address(request)


limiter = Limiter(key_func=rate_limit_key, headers_enabled=True)


async def get_current_user_id_stashed(
    request: Request,
    authorization: str | None = Header(None),
) -> str:
    """Auth dependency that also stashes the user id on request.state so the
    slowapi key_func (which only receives the Request) can key on it.

    Wraps — does NOT replace — get_current_user_id, so test_auth.py's direct
    calls to get_current_user_id stay valid.
    """
    user_id = await get_current_user_id(authorization)
    request.state.user_id = user_id
    return user_id
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest test_rate_limit.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/rate_limit.py backend/test_rate_limit.py
git commit -m "feat(backend): rate-limit foundation (limiter, per-user key, stashed-auth dep)"
```

---

### Task 2: Daily quota RPC + Python helper

**Files:**
- Create: `supabase/migrations/20260707120000_daily_trip_quota_rpc.sql`
- Modify: `backend/rate_limit.py`
- Test: `backend/test_rate_limit.py` (add), `supabase/tests/005_daily_quota_rpc.sql` (created in Task 7's suite but the RPC is defined here)

**Interfaces:**
- Produces:
  - Postgres `public.increment_daily_trip_usage(p_user_id uuid, p_limit int) returns int` — returns the new count, or `NULL` when already at/over the limit. Race-safe.
  - Postgres `public.decrement_daily_trip_usage(p_user_id uuid, p_usage_date date default current_date) returns int`.
  - `async def check_and_increment_daily_quota(client, user_id: str, limit: int) -> bool` — `True` if allowed (and incremented), `False` if over quota.
  - `async def refund_daily_quota(client, user_id: str) -> None` — decrements today's count (used on the enqueue-failure / lost-race paths).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260707120000_daily_trip_quota_rpc.sql
-- Atomic per-user daily trip quota on the existing public.user_daily_usage table
-- (unique(user_id, usage_date), generated_trip_count). Lives in `public` (NOT
-- `private`) so the service-role client can reach it via PostgREST .rpc(); EXECUTE
-- is revoked from anon/authenticated so only the backend service role can call it.

create or replace function public.increment_daily_trip_usage(p_user_id uuid, p_limit int)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count int;
begin
  insert into public.user_daily_usage as u (user_id, usage_date, generated_trip_count)
  values (p_user_id, current_date, 1)
  on conflict (user_id, usage_date)
  do update set generated_trip_count = u.generated_trip_count + 1,
                updated_at = now()
  where u.generated_trip_count < p_limit
  returning u.generated_trip_count into v_new_count;

  return v_new_count;  -- NULL => already at/over p_limit (ON CONFLICT WHERE was false)
end;
$$;

revoke all on function public.increment_daily_trip_usage(uuid, int) from public, anon, authenticated;
grant execute on function public.increment_daily_trip_usage(uuid, int) to service_role;

create or replace function public.decrement_daily_trip_usage(p_user_id uuid, p_usage_date date default current_date)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_count int;
begin
  update public.user_daily_usage
  set generated_trip_count = greatest(generated_trip_count - 1, 0), updated_at = now()
  where user_id = p_user_id and usage_date = p_usage_date
  returning generated_trip_count into v_new_count;
  return v_new_count;
end;
$$;

revoke all on function public.decrement_daily_trip_usage(uuid, date) from public, anon, authenticated;
grant execute on function public.decrement_daily_trip_usage(uuid, date) to service_role;
```

> **Race-safety note (PostgreSQL `INSERT ... ON CONFLICT DO UPDATE`):** a row locked but not updated because the `WHERE u.generated_trip_count < p_limit` condition was false is not returned by `RETURNING` — so a `NULL` return unambiguously means "at/over limit," and concurrent callers are serialized by Postgres's own conflict-resolution locking. No explicit `SELECT ... FOR UPDATE` needed.

> **DEPLOY-ORDERING GATE (F2, review fold) — MUST hold or `POST /generate-trip` 500s.**
> This migration must be applied to the **live Supabase project** BEFORE the backend
> code that calls `increment_daily_trip_usage` deploys to Render. If the code ships
> first, every non-replay POST hits a missing function (`PGRST202`/`42883`) → 500.
> Sequence: (1) push this migration to the live project (`supabase db push` against the
> linked project, or the team's migration path — confirm it lands) → (2) verify with a
> `.rpc()` smoke against the live DB → (3) THEN deploy the backend. See the deploy-order
> gate in Task 8. Research flagged migrations-applied-to-live as UNVERIFIED from the
> repo — do not assume the live project is in sync.

- [ ] **Step 2: Write the failing helper test**

```python
# backend/test_rate_limit.py  (append)
import pytest
import rate_limit


class _FakeRPC:
    def __init__(self, data):
        self._data = data
    def execute(self):
        async def _run():
            return type("Resp", (), {"data": self._data})()
        return _run()


class _FakeClient:
    def __init__(self, data):
        self._data = data
        self.calls = []
    def rpc(self, name, params):
        self.calls.append((name, params))
        return _FakeRPC(self._data)


@pytest.mark.asyncio
async def test_quota_allows_when_rpc_returns_count():
    client = _FakeClient(data=3)
    allowed = await rate_limit.check_and_increment_daily_quota(client, "user-1", 5)
    assert allowed is True
    assert client.calls[0][0] == "increment_daily_trip_usage"
    assert client.calls[0][1] == {"p_user_id": "user-1", "p_limit": 5}


@pytest.mark.asyncio
async def test_quota_rejects_when_rpc_returns_none():
    client = _FakeClient(data=None)
    allowed = await rate_limit.check_and_increment_daily_quota(client, "user-1", 5)
    assert allowed is False


@pytest.mark.asyncio
async def test_refund_calls_decrement():
    client = _FakeClient(data=2)
    await rate_limit.refund_daily_quota(client, "user-1")
    assert client.calls[0][0] == "decrement_daily_trip_usage"
    assert client.calls[0][1] == {"p_user_id": "user-1"}


@pytest.mark.asyncio
async def test_quota_missing_rpc_fails_closed_503():
    # Codex HIGH #4: RPC absent from the live DB (migration lagged deploy) -> PGRST202
    # -> fail CLOSED with 503, not an opaque 500 and not fail-open.
    from fastapi import HTTPException
    from postgrest.exceptions import APIError

    class _RaisingRPC:
        def execute(self):
            async def _run():
                raise APIError({"code": "PGRST202", "message": "function not found"})
            return _run()

    class _RaisingClient:
        def rpc(self, name, params):
            return _RaisingRPC()

    with pytest.raises(HTTPException) as ei:
        await rate_limit.check_and_increment_daily_quota(_RaisingClient(), "user-1", 5)
    assert ei.value.status_code == 503
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && uv run pytest test_rate_limit.py -k quota -v`
Expected: FAIL with `AttributeError: module 'rate_limit' has no attribute 'check_and_increment_daily_quota'`.

- [ ] **Step 4: Add the helpers to `backend/rate_limit.py`**

```python
# backend/rate_limit.py  (append)

async def check_and_increment_daily_quota(client, user_id: str, limit: int) -> bool:
    """Atomically increment today's trip count for user_id if below `limit`.
    Returns True if allowed (and incremented), False if already at/over quota.

    Deploy-order safety net (Codex HIGH #4): if the RPC is missing from the live DB
    (a migration that lagged the code deploy — autoDeploy:true), PostgREST returns
    PGRST202. Fail CLOSED with a clean 503 (protects Apify/OpenAI spend — deliberately
    NOT fail-open) instead of an opaque 500. Any other APIError propagates (-> 500),
    matching jobs.py's RPC/DB error posture.
    """
    from fastapi import HTTPException
    from postgrest.exceptions import APIError

    try:
        resp = await client.rpc(
            "increment_daily_trip_usage", {"p_user_id": user_id, "p_limit": limit}
        ).execute()
    except APIError as exc:
        # Implementer: confirm the missing-function code is "PGRST202" against the
        # installed postgrest (it is the documented "function not found in schema
        # cache" code); the fail-injection test below asserts the 503 path.
        if getattr(exc, "code", None) == "PGRST202":
            raise HTTPException(
                status_code=503, detail="Trip generation temporarily unavailable"
            ) from None
        raise
    return resp.data is not None


async def refund_daily_quota(client, user_id: str) -> None:
    """Decrement today's count (floored at 0). Used when a counted request did not
    result in a new generation (enqueue failure, or lost idempotency-key race)."""
    await client.rpc("decrement_daily_trip_usage", {"p_user_id": user_id}).execute()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && uv run pytest test_rate_limit.py -k quota -v` then `cd backend && uv run pytest test_rate_limit.py -v`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260707120000_daily_trip_quota_rpc.sql backend/rate_limit.py backend/test_rate_limit.py
git commit -m "feat(backend): atomic daily-trip-quota RPC + helper"
```

---

### Task 3: Error envelope (`backend/api/errors.py` + TS mirror)

**Files:**
- Create: `backend/api/errors.py`
- Modify: `frontend/lib/trip/backend-types.ts`
- Test: `backend/test_main.py` (add), `backend/api/test_errors.py` (new)

**Interfaces:**
- Produces:
  - `ErrorResponse` pydantic model: `{ "error": { "code": str, "message": str } }`.
  - `async def http_exception_handler(request, exc: HTTPException) -> JSONResponse`
  - `async def validation_exception_handler(request, exc: RequestValidationError) -> JSONResponse`
  - `async def unhandled_exception_handler(request, exc: Exception) -> JSONResponse`
  - `def register_error_handlers(app) -> None` — wires all three onto the app.

- [ ] **Step 1: Write the failing test**

```python
# backend/api/test_errors.py
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.errors import register_error_handlers


def _app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom-http")
    async def boom_http():
        raise HTTPException(status_code=404, detail="Trip not found")

    @app.get("/boom-500")
    async def boom_500():
        raise RuntimeError("secret db dsn leaked here")

    return app


def test_http_exception_is_enveloped():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-http")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Trip not found"}}


def test_unhandled_exception_does_not_leak():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-500")
    assert r.status_code == 500
    body = r.json()
    assert body["error"]["code"] == "internal_error"
    assert "secret db dsn" not in body["error"]["message"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest api/test_errors.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'api.errors'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/api/errors.py
"""Consistent JSON error envelope for the API: {"error": {"code", "message"}}.

Errors-only normalization (success responses keep their existing shapes). Every
shape here has a TypeScript mirror in frontend/lib/trip/backend-types.ts
(guardrail #4). The unhandled-exception handler must never leak internals.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("astrail.errors")

_STATUS_CODE_SLUG = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
}


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


def build_error_response(status_code: int, message: str, code: str | None = None) -> JSONResponse:
    """Shared error-envelope builder. Public so the rate-limit 429 handler in
    main.py reuses it instead of hand-rolling the shape (DRY — F3)."""
    slug = code or _STATUS_CODE_SLUG.get(status_code, "error")
    return JSONResponse(status_code=status_code, content={"error": {"code": slug, "message": message}})


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return build_error_response(exc.status_code, str(exc.detail))


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return build_error_response(422, "Request validation failed", code="validation_error")


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Log the real error server-side; return a generic message so nothing leaks.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return build_error_response(500, "Internal server error", code="internal_error")


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
```

> **Known limitation (F1, review fold) — CORS headers on 500.** Starlette's
> `ServerErrorMiddleware` (which dispatches the bare-`Exception` handler) sits
> OUTSIDE `CORSMiddleware`, so an UNHANDLED 500 response won't carry CORS headers
> and a browser will surface an opaque CORS error instead of the enveloped body.
> `HTTPException`/`RequestValidationError`/`RateLimitExceeded` are handled *inside*
> the stack and DO get CORS headers — only genuinely-unexpected 500s are affected,
> and only in how the browser labels them (the server still logs the real error).
> Feasible-first: accept for beta (the frontend treats any non-2xx as failure).
> Trigger to revisit: a real debugging session is blocked by the opaque-500 label
> → then wrap the app in a CORS-aware 500 shim. Do NOT add that complexity now.

> **Error-shape change scope (F5/Codex LOW).** Enveloping `HTTPException` changes the
> body of ALL non-2xx endpoint errors from FastAPI's default `{"detail": ...}` to
> `{"error": {"code", "message"}}` — including the **pre-connection** 401/404 on
> `GET /generate-trip/stream/{trip_id}` (missing token / owner-check fail). The FROZEN
> SSE contract is NOT touched: the `data:` frames and `data: [DONE]` sentinel of an
> ESTABLISHED stream are unchanged (those are emitted by `streaming.py`, not by an
> exception handler). Only the shape of an error returned *before* the stream opens
> changes. The `ErrorResponse` TS mirror (Step 5) covers it; call it out to Zhi Hao in
> the connection-contract doc so the FE reads `error.message`, not `detail`, on stream-open failures.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest api/test_errors.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the TypeScript mirror (guardrail #4)**

Append to `frontend/lib/trip/backend-types.ts`:

```typescript
/** Mirror of backend api/errors.py ErrorResponse. Every API error returns this shape. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}
```

- [ ] **Step 6: Commit**

```bash
git add backend/api/errors.py backend/api/test_errors.py frontend/lib/trip/backend-types.ts
git commit -m "feat(backend): consistent JSON error envelope + TS mirror"
```

---

### Task 4: Wire two-layer rate limiting into `POST /generate-trip`

**Files:**
- Modify: `backend/main.py`
- Test: `backend/test_main.py` (add) or `backend/test_main_integration.py`

**Interfaces:**
- Consumes: `rate_limit.limiter`, `rate_limit.BURST_LIMIT`, `rate_limit.DAILY_TRIP_QUOTA`, `rate_limit.get_current_user_id_stashed`, `rate_limit.check_and_increment_daily_quota`, `rate_limit.refund_daily_quota`, `api.errors.register_error_handlers`.
- Produces: `POST /generate-trip` now returns `429` (enveloped) on burst OR daily-quota exceed.

**Placement rules (exact):**
1. Burst limit = the `@limiter.limit(BURST_LIMIT)` decorator (fires after `Depends` resolves — `request.state.user_id` is set by then).
2. Daily-quota gate = **after** the idempotency-replay short-circuit (a retried POST must not consume quota) and **before** the trip insert.
3. Refund the quota on both non-generation exits: the `enqueue_job` failure `except` block, and the lost-idempotency-race branch (`winning_trip_id != trip_id`).

- [ ] **Step 1: Write the failing test**

```python
# backend/test_main.py  (add; follow the file's existing app/client + auth-override fixtures)
# Assumes the suite already overrides auth to a fixed user and injects a fake supabase
# client (see existing test_main_integration.py patterns). Reuse those helpers.

def test_burst_limit_returns_enveloped_429(client, auth_as_user_a, valid_trip_body):
    # 3/minute -> the 4th call in the window is rejected with the error envelope.
    for _ in range(3):
        r = client.post("/generate-trip", json=valid_trip_body)
        assert r.status_code in (200, 429)
    r = client.post("/generate-trip", json=valid_trip_body)
    assert r.status_code == 429
    assert r.json()["error"]["code"] == "rate_limited"


def test_daily_quota_exceeded_returns_429(client, auth_as_user_a, valid_trip_body, fake_client_quota_full):
    # increment_daily_trip_usage RPC returns None -> gate rejects before trip insert.
    r = client.post("/generate-trip", json=valid_trip_body)
    assert r.status_code == 429
    assert r.json()["error"]["code"] in ("rate_limited", "quota_exceeded")


def test_idempotent_replay_does_not_consume_quota(client, auth_as_user_a, valid_trip_body, fake_client_with_existing_job):
    # Existing job for this idempotency key -> replay path returns the trip WITHOUT
    # calling increment_daily_trip_usage.
    r = client.post("/generate-trip", json=valid_trip_body)
    assert r.status_code == 200
    assert "increment_daily_trip_usage" not in [c[0] for c in fake_client_with_existing_job.rpc_calls]


def test_burst_limit_is_per_user_not_shared(client, auth_as_user_a, auth_as_user_b, valid_trip_body):
    # F4 (review fold): the whole point of keying on request.state.user_id is that
    # user A exhausting the 3/min burst must NOT rate-limit user B. Drive A to 429,
    # then confirm B still gets through on a fresh bucket.
    with auth_as_user_a:
        for _ in range(3):
            client.post("/generate-trip", json=valid_trip_body)
        assert client.post("/generate-trip", json=valid_trip_body).status_code == 429
    with auth_as_user_b:
        assert client.post("/generate-trip", json=valid_trip_body).status_code != 429


def test_insert_failure_refunds_quota_without_stranding(client, auth_as_user_a, valid_trip_body, fake_client_insert_fails):
    # Codex HIGH #2 fold: trips.insert raises AFTER the quota increment. Expect a
    # 500 envelope, a best-effort refund (decrement called), and NO orphan trip left
    # 'generating' (none was created, so the fail-mark is correctly skipped).
    r = client.post("/generate-trip", json=valid_trip_body)
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    assert "decrement_daily_trip_usage" in [c[0] for c in fake_client_insert_fails.rpc_calls]


def test_refund_exception_after_creation_still_marks_trip_failed(
    client, auth_as_user_a, valid_trip_body, fake_client_enqueue_and_refund_both_fail
):
    # Codex HIGH #3 PROOF (the load-bearing part the earlier test missed): trip IS
    # created, then enqueue_job raises AND refund_daily_quota then raises. The fail-mark
    # runs BEFORE the swallowed refund, so the trip must STILL end 'failed' — a refund
    # error must never strand a trip in 'generating'.
    # Fixture: trips.insert succeeds; enqueue_job raises; refund RPC raises; records
    # whether trips.update(status='failed') was issued (trip_marked_failed).
    r = client.post("/generate-trip", json=valid_trip_body)
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    assert fake_client_enqueue_and_refund_both_fail.trip_marked_failed is True
```

> Implementer note: the exact fixtures (`client`, `auth_as_user_a`, `valid_trip_body`, `fake_client_quota_full`, `fake_client_with_existing_job`) follow the existing `test_main_integration.py` injection style (dependency_overrides for auth + a fake supabase client returning canned `.table()`/`.rpc()` results). Add an `autouse` limiter-reset fixture so burst counts don't leak across tests:
> ```python
> @pytest.fixture(autouse=True)
> def _reset_limiter():
>     from main import app
>     app.state.limiter.reset()
>     yield
> ```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest test_main.py -k "burst or quota or replay" -v`
Expected: FAIL (429 not returned / RPC still called on replay).

- [ ] **Step 3: Modify `backend/main.py` — imports + app wiring**

Add to the imports:

```python
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response
from slowapi.errors import RateLimitExceeded

from api.errors import build_error_response, register_error_handlers
from rate_limit import (
    BURST_LIMIT,
    DAILY_TRIP_QUOTA,
    check_and_increment_daily_quota,
    get_current_user_id_stashed,
    limiter,
    refund_daily_quota,
)
```

After `app = FastAPI(...)` and BEFORE the CORS middleware block, register the limiter, its 429 handler, and the error envelope:

```python
app.state.limiter = limiter


async def _rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    # Reuse the shared envelope builder (DRY — F3), then inject Retry-After /
    # X-RateLimit-* (Limiter was created with headers_enabled=True).
    response = build_error_response(429, f"Too many requests: {exc.detail}", code="rate_limited")
    return request.app.state.limiter._inject_headers(response, request.state.view_rate_limit)


app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
register_error_handlers(app)
```

> `register_error_handlers` adds the generic `Exception` + `HTTPException` + validation handlers; the explicit `RateLimitExceeded` registration above takes precedence for that specific type. Import `JSONResponse` at the top if not already imported (`from fastapi.responses import JSONResponse` — it currently imports `StreamingResponse` from there; add `JSONResponse`).

- [ ] **Step 4: Modify `POST /generate-trip` — decorator, params, quota gate, refunds**

```python
@app.post("/generate-trip", response_model=GenerateTripResponse)
@limiter.limit(BURST_LIMIT)
async def generate_trip(
    request: Request,                       # required by slowapi; must be named `request`
    response: Response,                     # REQUIRED with headers_enabled=True (Codex BLOCKER fix):
    req: GenerateTripRequest,               #   slowapi injects X-RateLimit-*/Retry-After into it on the
    background: BackgroundTasks,            #   SUCCESS path; without a `response` kwarg its
    user_id: str = Depends(get_current_user_id_stashed),   # _inject_headers(None,...) breaks EVERY call.
) -> GenerateTripResponse:                  # (stashes request.state.user_id for the key_func)
    client = await get_supabase_client()
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date,
                                   preferences=req.preferences, pace=req.pace,
                                   destination_hint=req.destination_hint)

    # Idempotent replay: unchanged — returns the existing trip WITHOUT consuming quota.
    existing = await (
        client.table("jobs").select("trip_id").eq("idempotency_key", idem).maybe_single().execute()
    )
    if existing is not None and existing.data is not None:
        return GenerateTripResponse(trip_id=existing.data["trip_id"])

    # Layer 1 — durable daily quota. AFTER the replay short-circuit, BEFORE trip insert.
    if not await check_and_increment_daily_quota(client, user_id, DAILY_TRIP_QUOTA):
        raise HTTPException(status_code=429, detail="Daily trip limit reached. Try again tomorrow.")

    # Quota is now consumed. ANY failure before a durable job exists must (a) preserve
    # the existing invariant — never leave an orphan trip stuck 'generating' with no job
    # (mark it failed FIRST) — and (b) best-effort refund the quota. trips.insert is INSIDE
    # this try so its own failure refunds too (Codex HIGH #2). Refund runs AFTER the
    # fail-mark and is swallowed, so a refund error can't strand the trip (Codex HIGH #3).
    trip_id: str | None = None
    try:
        trip = (
            await client.table("trips")
            .insert({
                "user_id": user_id,
                "status": "generating",
                "destination_hint": req.destination_hint,
                "start_date": req.start_date,
                "end_date": req.end_date,
            })
            .execute()
        ).data[0]
        trip_id = trip["id"]
        await record_event(
            client, trip_id, event_type="stage", stage="create_trip", message="trip created",
            payload={
                "reel_urls": req.reel_urls,
                "start_date": req.start_date,
                "end_date": req.end_date,
                "pace": req.pace,
                "preferences": req.preferences,
                "destination_hint": req.destination_hint,
            },
        )
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except Exception:
        # Invariant FIRST (load-bearing): a created-but-jobless trip must be marked failed.
        if trip_id is not None:
            await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq(
                "user_id", user_id
            ).execute()
        try:
            await refund_daily_quota(client, user_id)   # best-effort; never masks the 500 / fail-mark
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")

    if winning_trip_id != trip_id:
        # Lost the idempotency-key race — the winner is canonical. Best-effort refund
        # our quota (the winner counted its own), then delete our orphan trip.
        try:
            await refund_daily_quota(client, user_id)
        except Exception:
            pass
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)

    background.add_task(
        run_generation, trip_id, user_id, req.reel_urls, req.start_date, req.end_date,
        job_id=job_id, pace=req.pace, preferences=req.preferences,
        destination_hint=req.destination_hint,
    )
    return GenerateTripResponse(trip_id=trip_id)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && uv run pytest test_main.py test_main_integration.py -v`
Expected: PASS, including the new burst/quota/replay tests. Then `cd backend && uv run pytest evals/ -q` — eval anchor unmoved.

- [ ] **Step 6: Commit**

```bash
git add backend/main.py backend/test_main.py
git commit -m "feat(backend): two-layer rate limit on POST /generate-trip (burst + daily quota + refunds)"
```

---

### Task 5: CORS env allowlist

**Files:**
- Modify: `backend/main.py`
- Test: `backend/test_main.py` (add)

- [ ] **Step 1: Write the failing test**

```python
# backend/test_main.py  (add)
def test_cors_allows_astrail_origin(client):
    r = client.options(
        "/generate-trip",
        headers={
            "Origin": "https://astrail.xyz",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert r.headers.get("access-control-allow-origin") == "https://astrail.xyz"


def test_cors_rejects_unknown_origin(client):
    r = client.options(
        "/generate-trip",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
        },
    )
    # Starlette does not echo a disallowed origin.
    assert r.headers.get("access-control-allow-origin") != "https://evil.example.com"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest test_main.py -k cors -v`
Expected: FAIL — current `allow_origins=["*"]` echoes any origin.

- [ ] **Step 3: Replace the CORS block in `backend/main.py`**

```python
import os

_allowed_origins = [
    o.strip()
    for o in os.environ.get("ALLOWED_ORIGINS", "https://astrail.xyz,https://www.astrail.xyz").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

> Removing the `"*"` + `allow_credentials=True` combination fixes the credentialed-wildcard footgun. Preview origins (e.g. `https://<branch>.vercel.app`) are added at deploy time via the `ALLOWED_ORIGINS` env var — no code change.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest test_main.py -k cors -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/test_main.py
git commit -m "feat(backend): env-driven CORS allowlist (drop wildcard+credentials footgun)"
```

---

### Task 6: `/readiness` endpoint

**Files:**
- Modify: `backend/main.py`
- Test: `backend/test_main.py` (add)

**Design:** `/health` stays the dumb liveness probe (the Render `healthCheckPath`, so a DB blip never fails a deploy — matches the lifespan's graceful-degrade). `/readiness` does a cheap Supabase probe for monitoring; it is NOT the deploy gate.

- [ ] **Step 1: Write the failing test**

```python
# backend/test_main.py  (add)
def test_readiness_ok_when_db_reachable(client, fake_client_healthy):
    r = client.get("/readiness")
    assert r.status_code == 200
    assert r.json() == {"ready": True}


def test_readiness_503_when_db_unreachable(client, fake_client_db_down):
    r = client.get("/readiness")
    assert r.status_code == 503
    assert r.json()["ready"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && uv run pytest test_main.py -k readiness -v`
Expected: FAIL — no `/readiness` route (404).

- [ ] **Step 3: Add the route to `backend/main.py`**

```python
@app.get("/readiness")
async def readiness():
    """Deep readiness probe: confirms Supabase is reachable. NOT the deploy gate
    (that is /health) — a DB blip should not fail a rolling deploy."""
    try:
        client = await get_supabase_client()
        await client.table("users").select("id").limit(1).execute()
        return {"ready": True}
    except Exception:
        return JSONResponse(status_code=503, content={"ready": False})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && uv run pytest test_main.py -k readiness -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py backend/test_main.py
git commit -m "feat(backend): /readiness deep probe (separate from /health liveness)"
```

---

### Task 7: RLS CI gate + anon-denial + quota-RPC pgTAP tests

**Files:**
- Create: `.github/workflows/rls-tests.yml`
- Create: `supabase/tests/004_anon_denial.sql`
- Create: `supabase/tests/005_daily_quota_rpc.sql`

**Interfaces:** none (CI + SQL tests). The workflow runs `supabase db start` (applies `supabase/migrations/` on the fresh CI volume, incl. Task 2's RPC migration) then `supabase test db` (runs all `supabase/tests/*.sql` via `pg_prove`; fails the job on any failing assertion).

- [ ] **Step 1: Write the anon-denial pgTAP test**

```sql
-- supabase/tests/004_anon_denial.sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000301', 'anon-denial-owner@example.com');

insert into public.trips (id, user_id, status)
values ('10000000-0000-0000-0000-000000000301', '00000000-0000-0000-0000-000000000301', 'draft');

set local role anon;

select throws_ok(
  $$select id from public.trips$$,
  '42501',
  null,
  'anon role cannot select from public.trips (no GRANT, no RLS policy targets anon)'
);

reset role;

select is(
  (select count(*) from public.trips)::integer,
  1,
  'sanity: the seeded trip still exists and is readable by a privileged role'
);

select * from finish();

rollback;
```

- [ ] **Step 2: Write the quota-RPC pgTAP test**

```sql
-- supabase/tests/005_daily_quota_rpc.sql
begin;

create extension if not exists pgtap with schema extensions;

select plan(4);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-000000000401', 'quota-user@example.com');

-- Below the cap: first three increments return 1,2,3.
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 1, 'first increment -> 1');
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 2, 'second increment -> 2');
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), 3, 'third increment -> 3');

-- At the cap: the fourth increment is refused (NULL).
select is(public.increment_daily_trip_usage('00000000-0000-0000-0000-000000000401', 3), null, 'at cap -> NULL (rejected)');

select * from finish();

rollback;
```

- [ ] **Step 3: Verify both tests pass locally**

Run (Docker must be running):
```bash
supabase db start
supabase test db
```
Expected: all files pass, including `004_anon_denial.sql` and `005_daily_quota_rpc.sql`. If `supabase db start` reports migrations, confirm `20260707120000_daily_trip_quota_rpc.sql` applied.

- [ ] **Step 4: Write the GitHub Actions workflow**

```yaml
# .github/workflows/rls-tests.yml
name: RLS pgTAP Tests

on:
  pull_request:
  push:
    branches: [main, dev]

jobs:
  rls-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Supabase CLI
        uses: supabase/setup-cli@v1
        with:
          version: latest

      # DB-only start: Postgres + auto-applied migrations from supabase/migrations/.
      # Faster than full `supabase start` — GoTrue/Studio/etc. aren't needed for
      # pgTAP tests that set request.jwt.claims via GUC directly.
      - name: Start local Supabase database
        run: supabase db start

      - name: Run pgTAP RLS + quota tests
        run: supabase test db
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rls-tests.yml supabase/tests/004_anon_denial.sql supabase/tests/005_daily_quota_rpc.sql
git commit -m "ci: gate merges on RLS + quota pgTAP tests (anon-denial + daily-quota RPC)"
```

> Verification of the gate itself happens when the branch is pushed / the PR opens (the workflow runs). If it fails in CI for an environment reason (Docker/CLI), fix the workflow — do not weaken the tests.

---

### Task 8: Finalize `render.yaml`

**Files:**
- Modify: `render.yaml`

**Design:** the Blueprint already has `type: web`, `runtime: docker`, `region: singapore`, `healthCheckPath: /health`, `autoDeploy: true`, and 10 secret env keys. Add the three config keys this workstream introduces. `ALLOWED_ORIGINS`, `DAILY_TRIP_QUOTA`, and `BURST_LIMIT` are non-secret → set literal `value:` (not `sync: false`).

> **DEPLOY-ORDER GATE (F2, review fold).** `autoDeploy: true` means Render deploys
> the backend the moment this branch lands. So the Task 2 migration MUST be applied to
> the live Supabase project **before** this branch merges — otherwise the newly-deployed
> code calls a function that doesn't exist yet and every non-replay `POST /generate-trip`
> 500s. Land order: apply migration to live → smoke the `.rpc()` → then merge the code.
> Also set the three new env keys in the Render dashboard/Blueprint before the deploy so
> CORS/quota read real values, not just the defaults baked into the code.

- [ ] **Step 1: Add the env keys**

Append under `envVars:` in `render.yaml`:

```yaml
      - key: ALLOWED_ORIGINS
        value: https://astrail.xyz,https://www.astrail.xyz
      - key: DAILY_TRIP_QUOTA
        value: "5"
      - key: BURST_LIMIT
        value: 3/minute
```

- [ ] **Step 2: Validate the Blueprint**

Run: `render blueprints validate` (Render CLI) if available, or confirm YAML parses:
`python3 -c "import yaml,sys; yaml.safe_load(open('render.yaml')); print('render.yaml OK')"`
Expected: `render.yaml OK`.

- [ ] **Step 3: Commit**

```bash
git add render.yaml
git commit -m "chore(deploy): finalize render.yaml env (ALLOWED_ORIGINS, DAILY_TRIP_QUOTA, BURST_LIMIT)"
```

---

### Task 9: FE↔backend connection contract doc

**Files:**
- Create: `docs/CONNECTION-CONTRACT.md`

**Why:** the FE↔backend wiring is currently mocked. This doc is the backend-owned contract Zhi Hao wires the real client against. No code; no test.

- [ ] **Step 1: Write the doc**

```markdown
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

## Error shape
- All errors: `{"error": {"code": string, "message": string}}` (mirror: `frontend/lib/trip/backend-types.ts` → `ErrorResponse`).

## Health
- `/health` = liveness (Render deploy gate). `/readiness` = deep DB probe (monitoring only).

## Frontend TODOs to go live (Zhi Hao — OUTSIDE the backend workstream; beta blockers)
- [ ] Replace `mock-api` imports with `lib/trip/api.ts`; source the token from `supabase.auth.getSession()`.
- [ ] Add the Render backend origin to `next.config.ts` CSP `connect-src` (else the browser silently blocks the fetch + EventSource).
- [ ] Add a `NEXT_PUBLIC_MOCK_AUTH` production kill-switch (it currently has no build-time guard).
- [ ] Set `NEXT_PUBLIC_BACKEND_URL` to the real Render URL in Vercel prod; confirm `NEXT_PUBLIC_MOCK_AUTH` is unset there.
- [ ] Wire Supabase-direct reads for trip list/detail (`.from('trips')...` under RLS).
```

- [ ] **Step 2: Commit**

```bash
git add docs/CONNECTION-CONTRACT.md
git commit -m "docs: FE<->backend production connection contract (handoff)"
```

---

## Self-Review

**Spec coverage:** rate-limit (Tasks 1,2,4) · CORS (5) · error envelope + TS mirror (3) · health/readiness (6) · RLS full CI gate (7) · render.yaml (8) · connection contract (9). Preferences/settings + trip-read endpoints intentionally absent (interview: out). `auth.py` iss/leeway intentionally deferred (feasible-first, breakage risk).

**Placeholder scan:** every code/SQL/YAML/test step contains complete content; no TBD/TODO in implementation steps (the only checkboxes labelled TODO are the frontend beta-blockers inside the contract doc, which are deliberately Zhi Hao's out-of-scope items).

**Type consistency:** `rate_limit_key`, `get_current_user_id_stashed`, `check_and_increment_daily_quota(client, user_id, limit) -> bool`, `refund_daily_quota(client, user_id)`, `ErrorResponse {error:{code,message}}`, and the RPC names `increment_daily_trip_usage(uuid,int)` / `decrement_daily_trip_usage(uuid,date)` are used identically across Tasks 1→2→4→7 and the TS mirror.

**Eval-safety:** every task is HTTP-entry / CI / deploy config; none imports the runner or constructs a live client at import time; `uv run pytest evals/ -q` is run after Task 4 (the only pipeline-adjacent change).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-phase2-backend-api-surface-hardening.md`.

### ✅ RESUME HERE TOMORROW (plan is review-passed, awaiting user go)

**Status:** Both required review gates PASSED (gstack eng-review 8.4/10; Codex round-2 7.2/10 after 2 fix rounds — see GSTACK REVIEW REPORT below). No code written yet. **The plan is ready to implement pending the user's final go.**

**To take this from plan → implementation tomorrow:**

1. **Confirm the go.** The user reviewed nothing yet at implementation depth — a quick "yes, build it" is the gate. Do NOT start coding without it.
2. **Read first (Build Loop context):** this plan file top-to-bottom, `.claude/docs/BUILD-LOOP.md`, and recall memory `phase2-backend-decisions` + `phase2-backend-api-surface-plan`.
3. **Execute via `superpowers:subagent-driven-development`** (the Build Loop's implement step): one `astrail-developer` subagent per Task (1→9, respecting the dependency order in the File Structure section), each followed by an `astrail-reviewer` per-task gate that fault-injects to prove guards are load-bearing. Transcribe each task's code faithfully — the blocks already encode the Codex fix folds.
4. **Branch:** cut a feature branch off `dev` (e.g. `feat/phase2-api-hardening`) — do NOT commit to `shaun`/`dev` directly.
5. **Two caveats the implementer MUST resolve (both flagged by Codex, left as verify-at-implementation):**
   - **PGRST202** — confirm the exact PostgREST "function not found" error code against the installed `postgrest` before relying on the 503 fail-closed branch (Task 2 helper). The installed source has no named constant; verify empirically.
   - **Deploy-order is procedural** — `render.yaml` `autoDeploy:true` does NOT enforce migration-before-code. The Task 2 migration must be pushed to the LIVE Supabase project and `.rpc()`-smoked BEFORE the code branch merges (Task 2 + Task 8 gates). This is a human step; there is no automated gate.
6. **After implementation:** final `astrail-reviewer` opus whole-branch pass **AND** gstack `/review` Codex cross-model pass (run BOTH), then `uv run pytest evals/ -q` (eval anchor `6229.0` unmoved), live-verify smoke, PR to `dev`, then update docs + EMDEE + memory + hand Codex the board-card update.

**Board:** this is the backend slice of GitHub Project #1 card "Both P2: public beta readiness checklist" (Phase 2). Leave it in Todo/In-progress per the task-tracking skill.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (8.4/10) | 4 issues, 0 critical gaps — all folded |
| Codex Review | `/codex:rescue` | Independent 2nd opinion | 2 | PASS (7.2/10) | 5 findings round 1 (incl. 1 blocker) → all folded → round 2 re-verified |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not required (backend infra) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not required (backend-only) |

**Scope:** one cohesive plan (user-confirmed), 9 tasks. Complexity smell (13 files) reviewed → breadth not gold-plating, accepted as-is.

**Eng-review findings folded (F1–F4):** F1 CORS-headers-absent-on-500 (documented limitation + trigger, Task 3); F2 migration deploy-order (gates in Task 2 + 8); F3 DRY 429 envelope (reuses `build_error_response`); F4 per-user burst-independence test.

**Codex findings folded (round 1 → round 2 verified):**
- **BLOCKER** — missing `response: Response` param (slowapi `headers_enabled=True` → `_inject_headers(None,…)` breaks EVERY call). Fixed: param added → Codex round 2 **FIXED**.
- **HIGH #2** — `trips.insert` outside refund `try` → unrefunded quota. Fixed: insert inside try → **FIXED**.
- **HIGH #3** — refund-before-fail-mark could strand a trip `generating`. Fixed: fail-mark first, refund best-effort/swallowed + a proof test → **FIXED**.
- **HIGH #4** — migration vs `autoDeploy`. Fixed: fail-CLOSED 503 on `PGRST202` + deploy-order gates → **PARTIALLY** (fail-closed logic verified; deploy-order remains procedural — no automated gate; PGRST202 code to confirm at implementation).
- **LOW #5** — HTTPException envelope changes pre-stream 401/404 shape. Fixed: documented; frozen SSE frames confirmed intact → **FIXED**.

**CODEX:** 2 rounds (4.5 → 7.2). Residual (non-blocking, carried into the plan as implementation-time verifies): confirm `PGRST202` empirically; `autoDeploy:true` deploy-order is a human step, not enforced.

**CROSS-MODEL:** Codex caught the `response: Response` blocker the Claude eng-review missed — the cross-model gate earned its keep. No cross-model tension on any fold (both agree).

**Eval-safety:** every task is an HTTP-entry gate, CI, or deploy config — none touches the runner/dedupe/`6229.0`. Non-negotiable: `uv run pytest evals/ -q` after Task 4.

**Parallelization:** Lane A = Tasks 1→2→3→4→5→6 (backend, shared `main.py`/`rate_limit.py`, sequential); Lane B = Task 7 (RLS CI, independent); Lane C = Task 9 (contract doc, independent). Merge A+B+C, then Task 8 (render.yaml).

**VERDICT:** ENG + CODEX CLEARED (8.4 / 7.2, both ≥ 7, no dimension ≤ 3) — plan is implementation-ready pending the user's final go. See "RESUME HERE TOMORROW" above for the plan→implementation handoff.

NO UNRESOLVED DECISIONS
