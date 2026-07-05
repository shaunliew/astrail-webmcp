# Runtime Spine (Durable Pipeline + SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the offline-proven agent pipeline into a live, authenticated, durably-jobbed, SSE-streamed runtime — shipping the deterministic spine (scrape → extract → dedup → route-assembly) end-to-end first.

**Architecture:** A `POST /generate-trip` route (Supabase-JWT-guarded) computes a **request-derived idempotency key**, replays the existing trip on a retry, else creates a `trips` row + a `create_trip` `generation_events` row whose `payload` carries the run inputs (so recovery can re-run), enqueues a durable `jobs` row, and schedules an async `run_generation` via FastAPI `BackgroundTasks`. The runner **owns the job lifecycle** (`pending → running → succeeded/failed`), reuses the pure offline helpers (`dedupe_places`, `assemble_itinerary`) while calling the *live* per-reel `scrape_reel` + `extract_places` under `asyncio.gather(..., return_exceptions=True)`, and writes each stage as a `generation_events` row (progressive persistence). `GET /generate-trip/stream/:tripId` authenticates via a `?token=` query param (browser `EventSource` can't set headers), polls `generation_events`, and re-streams them as SSE, terminating on a `result` event + `[DONE]`. A startup recovery sweep re-queues pending/retryable/**stale**-running jobs and re-dispatches them (restart-with-cache-reuse, **not** mid-run resume).

**Tech Stack:** FastAPI (SSE via `StreamingResponse`), `python-jose[cryptography]` (HS256 JWT), `supabase-py` (service-role client), OpenAI Agents SDK (extractor — already built), Apify direct HTTP (scraper — already built), pytest + mocked clients.

## Global Constraints

- **No `requirements.txt`.** `backend/pyproject.toml` + `uv` only (guardrail #8). `python-jose[cryptography]>=3.3.0` and `supabase>=2.0.0` are already pinned — add no new deps without reading `.claude/docs/STACK.md`.
- **Auth on every endpoint except `/health`** (guardrail #5). The POST route authenticates from the `Authorization` header; the SSE stream route authenticates from a `?token=` query param (with header fallback) because browser `EventSource` cannot send headers. Both validate the same Supabase JWT via **JWKS** — the live project uses **ES256 / ECC P-256** asymmetric signing keys, so `auth.py` was migrated from HS256 shared-secret to JWKS verification against `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` (algorithms pinned to `ES256`/`RS256` to block algorithm-confusion; keys cached with debounce+TTL). No `SUPABASE_JWT_SECRET`.
- **Owner check** (guardrail #6): every trip write filters on BOTH `id` AND `user_id` (`.eq("id", trip_id).eq("user_id", user_id)`) even under the service-role client (which bypasses RLS), so a bad `trip_id` can never write into another user's trip. The stream route verifies `trip.user_id == current_user_id` before streaming.
- **Idempotency key is request-derived** (never from the freshly-generated `trip_id`): `sha256(user_id | sorted(reel_urls) | start_date | end_date)`. A retried POST maps to the same key → replays the same trip, never duplicates.
- **Durable job = restart-with-cache-reuse, NOT resume** (guardrail #12): the runner marks the job `running` (with `locked_at`) and `succeeded`/`failed`; a crash re-executes from Phase 1. Startup recovery re-queues `pending`, `retryable`, and **stale** `running` jobs (`locked_at` older than the stale window) and re-dispatches them. It never silently drops a run, and never re-queues a *fresh* `running` job (that would double-run on a rolling deploy).
- **Partial pipeline failure is acceptable** (guardrail #3, PRD §17): non-critical per-reel failures degrade (status `saved_with_gaps`), never abort. Critical failures (no user, invalid request, no scraped reels, no verified places, owner mismatch) fail the run (status `failed`). ANY unexpected exception inside the runner is caught and turned into a terminal `error` `result` event + `failed` status (never a hanging stream).
- **SSE termination is the most breaking contract in the repo.** Every terminal path — success, critical failure, AND stream timeout — ends with a `result` event then `data: [DONE]\n\n`. A bare `[DONE]` with no preceding `result` is forbidden (the client would read a dropped run as empty success). Renaming existing stage/event types is breaking; adding is not.
- **Service-role key is server-side only** — never returned in a response or logged. Never place `APIFY_TOKEN` / `OPENAI_API_KEY` / JWT secret in raised error text or event payloads. (The `create_trip` payload carries `reel_urls` + dates only, no secrets.)
- **Do NOT touch the #16 eval anchor.** `evals/baseline.py`, `evals/cases/*.json`, `evals/fixtures/*.json`, and `pipeline/offline_harness.py::run_offline_pipeline` (signature + side-effect-free import) must stay unchanged. The live runner is a *separate* module that reuses the pure helpers — it never imports credential-eager code at module scope, and `offline_harness.py` never gains a module-level import of `supabase_client`/`jobs`/live agents.
- **Env vars** (per `.claude/docs/ENV.md`): `SUPABASE_URL` (also the JWKS source for auth), `SUPABASE_SERVICE_ROLE_KEY`, `APIFY_TOKEN`, `OPENAI_API_KEY`. Read via `os.environ[...]` (fail fast if absent); never hardcode. (No `SUPABASE_JWT_SECRET` — auth verifies asymmetric ES256 tokens via JWKS.)
- **Canonical stage names** = the DB `generation_events_stage_check` superset: `create_trip, scrape, cache_hit, extract, resolve, preferences, dedup, enrich, weather, restaurants, hotels, transport, narrate, summarize, save`. `event_type` ∈ `stage, decision, warning, error, heartbeat, result`.

---

## Supabase Alignment Amendment (BINDS Tasks 2–5 — supersedes any sync code shown below)

A Supabase-doc-alignment review (against installed `supabase==2.31.0`/`postgrest`) found the original sync code blocks are non-idiomatic and carry two concurrency defects. **This amendment is authoritative — where a task's code block below shows the sync/older form, use the async/atomic form here instead.** Implementers: load the `supabase:supabase` + `supabase:supabase-postgres-best-practices` skills first.

**A. Async client, awaited everywhere (§5 — blocking-loop fix).** `supabase-py`'s sync client blocks FastAPI's event loop. Use the async client + a lazy async singleton (NOT `lru_cache`, which can't memoize an async factory), and `await` every `.execute()` at every call site (jobs, runner, streaming poll loop, main, recovery):

```python
# backend/supabase_client.py
"""Async service-role Supabase client (server-side only; never exposed to the frontend)."""
from __future__ import annotations

import asyncio
import os

from supabase import AsyncClient, acreate_client

_client: AsyncClient | None = None
_lock = asyncio.Lock()


async def get_supabase_client() -> AsyncClient:
    """Lazily create + memoize one service-role AsyncClient (double-checked lock)."""
    global _client
    if _client is None:
        async with _lock:
            if _client is None:
                _client = await acreate_client(
                    os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    return _client
```

Every consumer becomes `client = await get_supabase_client()` and `await client.table(...)...execute()`. `record_event` / `_set_status` / `mark_job_*` / `enqueue_job` / `recover_inflight_jobs` / `stream_trip_events`'s poll are all `async` and `await` their queries.

**B. `jobs.py` — idiomatic + atomic (§1, §1b, T2 idiom fixes):**

```python
# backend/jobs.py
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

from postgrest.exceptions import APIError

from supabase_client import get_supabase_client

_UNIQUE_VIOLATION = "23505"   # Postgres unique_violation (stable; use exc.code, NOT str(exc))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str) -> str:
    material = "|".join([user_id, ",".join(sorted(reel_urls)), start_date, end_date])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def enqueue_job(trip_id: str, user_id: str, idempotency_key: str, *, client=None) -> tuple[str, str]:
    """Insert a pending job; return (job_id, trip_id). On a duplicate key, return the
    EXISTING job's (id, trip_id) — which may be a DIFFERENT trip when two same-key POSTs
    race, so the caller MUST redirect to the returned trip_id (see main.py)."""
    client = client or await get_supabase_client()
    row = {"trip_id": trip_id, "user_id": user_id, "idempotency_key": idempotency_key, "status": "pending"}
    try:
        created = (await client.table("jobs").insert(row).execute()).data[0]
        return created["id"], created["trip_id"]
    except APIError as exc:
        if exc.code != _UNIQUE_VIOLATION:
            raise
        existing = await (client.table("jobs").select("id,trip_id")
                          .eq("idempotency_key", idempotency_key).maybe_single().execute())
        if existing is None or existing.data is None:
            raise                       # unique violation but no matching row → surface, don't mask
        return existing.data["id"], existing.data["trip_id"]


async def mark_job_running(client, job_id: str) -> bool:
    """Atomic CAS claim: pending/retryable -> running in ONE statement. Returns True iff
    THIS caller won (empty result = already claimed/running/done → caller must abort).
    (attempt_count increment is deferred — postgrest can't do `col = col + 1`; not load-bearing.)"""
    result = await (client.table("jobs").update(
        {"status": "running", "locked_at": _now(), "started_at": _now(),
         "completed_at": None, "error_message": None})
        .eq("id", job_id).in_("status", ["pending", "retryable"]).execute())
    return bool(result.data)


async def mark_job_done(client, job_id: str, *, status: str) -> None:
    await client.table("jobs").update({"status": status, "completed_at": _now()}).eq("id", job_id).execute()


async def recover_inflight_jobs(*, client=None, stale_after_s: int = 900) -> list[dict]:
    """Flip STALE running (locked_at older than stale_after_s) -> retryable, then return
    reclaimable jobs. The atomic CAS in mark_job_running (on redispatch) is what prevents a
    double-run when two instances recover the same job — so this select-then-flip is safe
    (flipping to retryable twice is idempotent). Restart-with-cache-reuse, NOT resume (#12)."""
    client = client or await get_supabase_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_s)).isoformat()
    stale = (await client.table("jobs").select("id").eq("status", "running").lt("locked_at", cutoff).execute()).data
    for r in stale:
        await client.table("jobs").update({"status": "retryable"}).eq("id", r["id"]).execute()
    reclaimable = (await client.table("jobs").select("id,trip_id,user_id")
                   .in_("status", ["pending", "retryable"]).execute()).data
    return reclaimable
```

**C. `run_generation` claim guard (Task 3).** At the top, atomically claim before any work; abort if another instance already owns it:

```python
    client = client or await get_supabase_client()
    if job_id and not await mark_job_running(client, job_id):
        return {"skipped": "job already claimed by another run"}   # atomic double-run guard
```

All `record_event` / `_set_status` calls become `await` (both are `async`; `_set_status` keeps the `.eq("id", trip_id).eq("user_id", user_id)` owner filter). `_fail` calls `await mark_job_done(client, job_id, status="failed")` when `job_id`. On success, `await mark_job_done(client, job_id, status="succeeded")`.

**D. `POST /generate-trip` idempotency race (Task 4, §1).** Pre-check with `maybe_single`; on a lost race, delete the orphan trip and redirect to the winner — never double-dispatch:

```python
    client = await get_supabase_client()
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date)
    existing = await (client.table("jobs").select("trip_id").eq("idempotency_key", idem)
                      .maybe_single().execute())
    if existing is not None and existing.data is not None:
        return GenerateTripResponse(trip_id=existing.data["trip_id"])         # idempotent replay
    trip = (await client.table("trips").insert({...}).execute()).data[0]
    trip_id = trip["id"]
    await record_event(client, trip_id, event_type="stage", stage="create_trip",
                       message="trip created",
                       payload={"reel_urls": req.reel_urls, "start_date": req.start_date,
                                "end_date": req.end_date, "pace": req.pace})
    try:
        job_id, winning_trip_id = await enqueue_job(trip_id, user_id, idem)
    except APIError:
        await client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq("user_id", user_id).execute()
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")
    if winning_trip_id != trip_id:                    # lost the race → another POST is canonical
        await client.table("trips").delete().eq("id", trip_id).eq("user_id", user_id).execute()
        return GenerateTripResponse(trip_id=winning_trip_id)                  # do NOT dispatch
    background.add_task(run_generation, trip_id, user_id, req.reel_urls,
                        req.start_date, req.end_date, job_id=job_id, pace=req.pace)
    return GenerateTripResponse(trip_id=trip_id)
```

**E. Single-row reads** use `.maybe_single()` (returns `None` on 0 rows, `APIError` on >1) instead of `.execute().data[0]` wherever a lookup can legitimately miss (existing-job pre-check, `enqueue_job` fallback). Guarded `.data[0]` after a just-inserted row (trip insert) is fine.

**F. Tests** for the async client use an async fake whose `execute()` is `async` (awaitable) and model `postgrest.exceptions.APIError(code="23505")` for the duplicate path (not a plain `Exception` string), plus a test for the re-raise branch (a non-23505 `APIError` propagates) and the `mark_job_running` CAS returning `False` when status is already `running`.

**Polling vs Realtime (§4) and RLS/owner-check (§6): reviewed, NO change** — table-polling is a deliberate, defensible choice (reconnect-replay, one persistence path, backend-owned `[DONE]` contract; `generation_events` is intentionally not in the Realtime publication), and the RLS + app-level owner filters already match current service-role guidance.

---

## Database Connectivity & Integration Testing

The Astrail **online Supabase (dev) project is already connected** — the migrations in `supabase/migrations/` (`trips`, `jobs`, `generation_events`, and `private.claim_next_generation_job()`) are live. So slices A/B/D can be validated against the **real database**, not only mocked clients.

**Env loading (implementer):** the backend reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` from the environment (per `.claude/docs/ENV.md`). Load them from the backend env file before any integration step:

```bash
cd backend && uv run --env-file ../.env pytest ...   # or: set -a && source ../.env && set +a
```

**Preflight (run once before Task 2 integration) — read-only, no writes:**

```bash
cd backend && uv run --env-file ../.env python -c "
from supabase_client import get_supabase_client
c = get_supabase_client()
for t in ('trips', 'jobs', 'generation_events'):
    c.table(t).select('id').limit(1).execute(); print(f'{t}: OK')
"
```

Expected: `trips: OK` / `jobs: OK` / `generation_events: OK`. If any table errors, STOP — the migrations are not applied on the connected project; do not proceed with integration tests.

**Integration-test policy:**
- **Unit tests (mocked clients) are the PRIMARY gate** — they run with NO credentials and are what stays green in CI. Every Task ships its unit tests first; integration is additive.
- Integration tests hit the **real dev DB**, are marked `@pytest.mark.integration`, and are **skipped unless `RUN_DB_INTEGRATION=1`** — a keyless/CI run must stay green. Register the marker in `backend/pyproject.toml` under `[tool.pytest.ini_options]`: `markers = ["integration: hits the live dev Supabase DB"]`.
- Every integration test MUST clean up rows it creates (delete by id in a `finally`). The `jobs`/`trips` composite FK needs a real `users` row, so integration tests reference an existing seeded dev user via `ASTRAIL_TEST_USER_ID`. `trips` delete cascades to `jobs` + `generation_events`.
- Never run integration tests against a production project. Never let live Apify/OpenAI calls into an integration test — inject fake `scrape`/`extract` so the DB is the only live dependency.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `backend/auth.py` | Supabase JWT (HS256) decode; header dependency + query-param/header dependency | 1 |
| `backend/supabase_client.py` | Memoized service-role `supabase-py` client | 2 |
| `backend/jobs.py` | `compute_idempotency_key`, `enqueue_job`, `mark_job_running`, `mark_job_done` (T2); `recover_inflight_jobs` (T5) | 2, 5 |
| `backend/pipeline/runner.py` | Live async deterministic spine + job lifecycle + reel-level partial failure + outer error wrapper + `generation_events` writes | 3 |
| `backend/api/schemas.py` | `GenerateTripRequest` / `GenerateTripResponse` Pydantic models | 4 |
| `backend/api/streaming.py` | SSE formatter + `generation_events` seen-set stream generator + timeout terminal result | 4 |
| `backend/main.py` | `POST /generate-trip` (idempotent replay), `GET /generate-trip/stream/:tripId` (query-param auth), startup recovery re-dispatch | 4, 5 |

**Deferred to their own cards (explicit, with triggers):**
- Phase-3/4 enrich agents (`weather`, `restaurant`, `transport`, LLM `narrator`, `orchestrator`) — trigger: this spine streams a real trip end-to-end. Their `asyncio.gather` fan-out slots into `run_generation`'s enrich phase when they exist.
- `pipeline/cache.py` write-through Reel/place cache — trigger: measured restart cost or a repeated live reel. Recovery is *correct* without it (re-runs from Phase 1, re-paying cost); the cache only makes re-runs cheap.
- Normalized persistence to `generated_trip_outputs` + `GET /trips/:tripId` — trigger: the trip-detail read path. This card persists the itinerary durably as the terminal `result` `generation_events` row (also the SSE final payload); the normalized read-model write is a thin follow-up.
- `generation_events` `user_id` composite FK (defense-in-depth for service-role writes) — a migration in Zhi Hao's lane; app-code owner-check (guardrail #6) covers it meanwhile.
- Short-lived single-use stream token (instead of the JWT in `?token=`) — trigger: security hardening pass. v1 accepts the JWT in the query param over TLS with a short token TTL; document the log-hygiene tradeoff.

---

### Task 1: Supabase JWT auth (header + query-param dependencies)

**Files:**
- Modify: `backend/auth.py:10-12`
- Test: `backend/test_auth.py` (create)

**Interfaces:**
- Produces: `_decode(token: str) -> str` — decodes the Supabase HS256 token with `SUPABASE_JWT_SECRET` (audience `authenticated`), returns `sub`; raises `HTTPException(401)` on any failure.
- Produces: `async def get_current_user_id(authorization: str | None = Header(None)) -> str` — header dependency for `POST` routes.
- Produces: `async def get_user_id_from_query_or_header(token: str | None = Query(None), authorization: str | None = Header(None)) -> str` — stream dependency: prefers `?token=`, falls back to the header (browser `EventSource` cannot set headers).

- [ ] **Step 1: Write the failing tests**

```python
# backend/test_auth.py
import os
import pytest
from jose import jwt
from fastapi import HTTPException

os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret-please-change")
from auth import get_current_user_id, get_user_id_from_query_or_header  # noqa: E402

SECRET = os.environ["SUPABASE_JWT_SECRET"]


def _token(claims: dict, secret: str = SECRET) -> str:
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.mark.asyncio
async def test_header_valid_token_returns_sub():
    tok = _token({"sub": "user-123", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-123"


@pytest.mark.asyncio
async def test_header_missing_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(None)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_header_wrong_secret_raises_401():
    tok = _token({"sub": "u", "aud": "authenticated"}, secret="other")
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_query_token_wins():
    tok = _token({"sub": "user-q", "aud": "authenticated"})
    assert await get_user_id_from_query_or_header(token=tok, authorization=None) == "user-q"


@pytest.mark.asyncio
async def test_query_falls_back_to_header():
    tok = _token({"sub": "user-h", "aud": "authenticated"})
    assert await get_user_id_from_query_or_header(token=None, authorization=f"Bearer {tok}") == "user-h"


@pytest.mark.asyncio
async def test_query_missing_both_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_user_id_from_query_or_header(token=None, authorization=None)
    assert ei.value.status_code == 401
```

Review also added 3 more 401-path tests to `backend/test_auth.py` (the plan's original set omitted them): `test_header_expired_token_raises_401` (past `exp` → 401), `test_header_missing_subject_raises_401` (no `sub` → 401), and `test_token_missing_aud_raises_401` (correct secret, no `aud` → 401 — locks `require_aud`). See the shipped test file for the code.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest test_auth.py -v`
Expected: FAIL — functions raise `NotImplementedError` / are undefined.

- [ ] **Step 3: Implement the JWT dependencies**

```python
# backend/auth.py
"""Supabase JWT validation for authenticated FastAPI endpoints.

Verifies the Supabase-issued access token (HS256, signed with SUPABASE_JWT_SECRET)
and returns the authenticated user id. The POST route reads the Authorization
header; the SSE stream route reads a ?token= query param (browser EventSource
cannot set headers), with a header fallback. See guardrails #5 (auth) and #6 (owner).
"""
from __future__ import annotations

import os

from fastapi import Header, HTTPException, Query
from jose import JWTError, jwt


def _decode(token: str) -> str:
    """Validate a Supabase HS256 token and return its subject; raise 401 on failure."""
    secret = os.environ["SUPABASE_JWT_SECRET"]
    try:
        # require_aud: python-jose only validates `aud` when the claim is present;
        # requiring it rejects a correctly-signed token that omits aud=authenticated.
        claims = jwt.decode(token, secret, algorithms=["HS256"], audience="authenticated",
                            options={"require_aud": True})
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from None
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")
    return user_id


async def get_current_user_id(authorization: str | None = Header(None)) -> str:
    """Header-based auth dependency for POST routes."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    return _decode(authorization.removeprefix("Bearer ").strip())


async def get_user_id_from_query_or_header(
    token: str | None = Query(None), authorization: str | None = Header(None)
) -> str:
    """Stream auth: prefer ?token= (EventSource can't set headers), fall back to header."""
    if token:
        return _decode(token)
    if authorization and authorization.startswith("Bearer "):
        return _decode(authorization.removeprefix("Bearer ").strip())
    raise HTTPException(status_code=401, detail="Missing token")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest test_auth.py -v`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/auth.py backend/test_auth.py
git commit -m "feat(auth): Supabase JWT header + query-param dependencies for authed routes"
```

---

### Task 2: Service-role client + job enqueue/mark helpers

**Files:**
- Modify: `backend/supabase_client.py:10-12`
- Modify: `backend/jobs.py` (implement everything except `recover_inflight_jobs`)
- Test: `backend/test_supabase_client.py` (create), `backend/test_jobs.py` (create)

**Interfaces:**
- Produces: `get_supabase_client() -> Client` — memoized service-role client.
- Produces: `compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str) -> str` — deterministic `sha256` over the request (NOT the trip id), so retries dedupe.
- Produces: `async def enqueue_job(trip_id, user_id, idempotency_key, *, client=None) -> str` — inserts a `pending` job; a duplicate key returns the existing job id (idempotent backstop).
- Produces: `async def mark_job_running(client, job_id) -> None` — `pending/retryable → running`, sets `locked_at`, `started_at`, bumps `attempt_count`.
- Produces: `async def mark_job_done(client, job_id, *, status) -> None` — `running → succeeded|failed`, sets `completed_at`.

- [ ] **Step 1: Write the failing test for the client**

```python
# backend/test_supabase_client.py
import importlib

def test_client_is_memoized(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    import supabase_client
    importlib.reload(supabase_client)
    calls = []
    monkeypatch.setattr(supabase_client, "create_client",
                        lambda url, key: calls.append((url, key)) or object())
    a = supabase_client.get_supabase_client()
    b = supabase_client.get_supabase_client()
    assert a is b and len(calls) == 1
    assert calls[0] == ("https://example.supabase.co", "service-role-key")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && uv run pytest test_supabase_client.py -v`
Expected: FAIL — `NotImplementedError`.

- [ ] **Step 3: Implement the memoized client**

```python
# backend/supabase_client.py
"""Supabase Python client wrapper (DB / storage / RLS).

Thin accessor around the service-role client used by the agent pipeline for
write-through caches, trip persistence, the durable jobs table, and Storage.
The service-role key bypasses RLS, so it must never reach the frontend.
"""
from __future__ import annotations

import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    """Return a memoized service-role Supabase client (server-side only)."""
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && uv run pytest test_supabase_client.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for jobs**

```python
# backend/test_jobs.py
import pytest
import jobs


def test_idempotency_key_is_request_derived_and_stable():
    a = jobs.compute_idempotency_key("u1", ["https://ig/b", "https://ig/a"], "2026-08-01", "2026-08-02")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    c = jobs.compute_idempotency_key("u2", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    assert a == b        # order-independent, same request → same key
    assert a != c        # different user → different key
    assert "trip" not in a  # never derived from a trip id


class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, store): self.store = store; self._pending = None; self._filter = {}
    def insert(self, row): self._pending = ("insert", row); return self
    def update(self, row): self._pending = ("update", row); return self
    def select(self, cols): self._pending = ("select", cols); return self
    def eq(self, col, val): self._filter[col] = val; return self
    def execute(self):
        op, arg = self._pending
        if op == "insert":
            key = arg["idempotency_key"]
            if key in self.store:
                raise Exception("duplicate key value violates unique constraint")
            self.store[key] = {"id": f"job-{len(self.store)+1}", **arg}
            return _Result([self.store[key]])
        if op == "update":
            for r in self.store.values():
                if all(r.get(k) == v for k, v in self._filter.items()):
                    r.update(arg)
            return _Result([])
        match = [r for r in self.store.values()
                 if all(r.get(k) == v for k, v in self._filter.items())]
        return _Result(match)


class _Client:
    def __init__(self): self.store = {}
    def table(self, name): return _Table(self.store)


@pytest.mark.asyncio
async def test_enqueue_returns_job_id_and_is_idempotent():
    c = _Client()
    first = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    second = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    assert first == second == "job-1"


@pytest.mark.asyncio
async def test_mark_running_then_done():
    c = _Client()
    await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    await jobs.mark_job_running(c, "job-1")
    assert c.store["idem-1"]["status"] == "running"
    assert c.store["idem-1"]["locked_at"] is not None
    await jobs.mark_job_done(c, "job-1", status="succeeded")
    assert c.store["idem-1"]["status"] == "succeeded"
    assert c.store["idem-1"]["completed_at"] is not None
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && uv run pytest test_jobs.py -v`
Expected: FAIL — functions undefined / `NotImplementedError`.

- [ ] **Step 7: Implement jobs (leave `recover_inflight_jobs` for Task 5)**

```python
# backend/jobs.py
"""Durable generation jobs backed by a Supabase `jobs` table.

Enqueue a pending job before any work; the runner owns the lifecycle
(pending -> running -> succeeded/failed); a startup recovery sweep re-queues
runs a crash left mid-flight. Idempotency keys are request-derived so a retried
POST never double-runs. See CLAUDE.md guardrail #12.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from supabase_client import get_supabase_client


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_idempotency_key(user_id: str, reel_urls: list[str], start_date: str, end_date: str) -> str:
    """Deterministic key from the REQUEST (not the trip id) so retries dedupe."""
    material = "|".join([user_id, ",".join(sorted(reel_urls)), start_date, end_date])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


async def enqueue_job(trip_id: str, user_id: str, idempotency_key: str, *, client=None) -> str:
    """Persist a pending job and return its id (idempotent on the key)."""
    client = client or get_supabase_client()
    row = {"trip_id": trip_id, "user_id": user_id,
           "idempotency_key": idempotency_key, "status": "pending"}
    try:
        return client.table("jobs").insert(row).execute().data[0]["id"]
    except Exception as exc:
        if "idempotency_key" not in str(exc) and "duplicate key" not in str(exc):
            raise
        existing = (client.table("jobs").select("id")
                    .eq("idempotency_key", idempotency_key).execute())
        return existing.data[0]["id"]


async def mark_job_running(client, job_id: str) -> None:
    """pending/retryable -> running; stamp locked_at + started_at, bump attempt_count."""
    current = client.table("jobs").select("attempt_count,started_at").eq("id", job_id).execute().data
    attempt = (current[0]["attempt_count"] if current else 0) + 1
    started = (current[0].get("started_at") if current else None) or _now()
    client.table("jobs").update({
        "status": "running", "locked_at": _now(), "started_at": started,
        "attempt_count": attempt, "completed_at": None, "error_message": None,
    }).eq("id", job_id).execute()


async def mark_job_done(client, job_id: str, *, status: str) -> None:
    """running -> succeeded|failed; stamp completed_at."""
    client.table("jobs").update({"status": status, "completed_at": _now()}).eq("id", job_id).execute()


async def recover_inflight_jobs(*, client=None, stale_after_s: int = 900) -> list[dict]:
    """Re-queue runs a crash left mid-flight (implemented in Task 5)."""
    raise NotImplementedError  # Task 5
```

- [ ] **Step 8: Run all Task-2 tests to verify they pass**

Run: `cd backend && uv run pytest test_supabase_client.py test_jobs.py -v`
Expected: PASS (4 passed).

- [ ] **Step 9: Commit**

```bash
git add backend/supabase_client.py backend/jobs.py backend/test_supabase_client.py backend/test_jobs.py
git commit -m "feat(jobs): service-role client + request-derived idempotency + job lifecycle helpers"
```

---

### Task 3: Live deterministic runner + job lifecycle + partial failure

**Files:**
- Create: `backend/pipeline/runner.py` (currently a 1-line comment stub)
- Test: `backend/pipeline/test_runner.py` (create)

**Interfaces:**
- Consumes: `scrape_reel` (`scrape/apify_direct.py:34`), `extract_places` (`genagents/place_extractor.py:172`), `dedupe_places` (`pipeline/dedup.py:75` → `.places`), `assemble_itinerary` + `_date_range` (`pipeline/offline_harness.py:47,37`), `mark_job_running`/`mark_job_done` (Task 2), `get_supabase_client`.
- Produces:
  - `async def record_event(client, trip_id, *, event_type, stage, message, payload=None) -> None` — inserts one `generation_events` row.
  - `async def run_generation(trip_id, user_id, reel_urls, start_date, end_date, *, job_id=None, pace="balanced", client=None, scrape=None, extract=None) -> dict` — runs the deterministic spine, owns the job lifecycle, writes stage/warning/result events + trip status, returns `{"itinerary": ...}` or `{"error": ...}`. `job_id` optional so the pure pipeline is testable without a job; `scrape`/`extract` injectable for tests.

Design notes for the implementer:
- **Never mutate/import `run_offline_pipeline`** — only the pure helpers `assemble_itinerary` + `_date_range`. Do not route through `pipeline/sources.py::resolve` (fixture seam only).
- **Job lifecycle:** if `job_id`, call `mark_job_running` at start and `mark_job_done(status=...)` at the end of every path (success, critical failure, unexpected exception).
- **Owner check (guardrail #6):** EVERY `trips` update filters `.eq("id", trip_id).eq("user_id", user_id)`.
- **Outer wrapper (guardrail #3 / SSE):** wrap the whole body in `try/except Exception`. Any unexpected error → terminal `error` `result` event + trip `failed` + job `failed`, never a hanging stream, never a secret in the message.
- **Partial failure:** scrape + extract fan out with `asyncio.gather(..., return_exceptions=True)`; a per-reel exception → `warning` event + drop. Zero scraped reels or zero places → critical failure (`failed`). Any drop → final status `saved_with_gaps`, else `complete`.
- Read `APIFY_TOKEN` via `os.environ`; never in an event payload/message.

- [ ] **Step 1: Write the failing tests (fake client with trips/jobs/events; fully offline)**

```python
# backend/pipeline/test_runner.py
import pytest

from models.reel import ReelData
from models.place import PlaceResult
from pipeline import runner


class _Table:
    def __init__(self, name, db): self.name, self.db = name, db; self._op = None; self._f = {}
    def insert(self, row): self._op = ("insert", row); return self
    def update(self, row): self._op = ("update", row); return self
    def select(self, cols): self._op = ("select", cols); return self
    def eq(self, c, v): self._f[c] = v; return self
    def execute(self):
        op, arg = self._op
        if op == "insert":
            self.db.setdefault(self.name, []).append(arg); return type("R", (), {"data": [arg]})()
        if op == "update":
            for r in self.db.get(self.name, []):
                if all(r.get(k) == v for k, v in self._f.items()): r.update(arg)
            self.db.setdefault(self.name + "_updates", []).append(arg)
            return type("R", (), {"data": []})()
        rows = [r for r in self.db.get(self.name, []) if all(r.get(k) == v for k, v in self._f.items())]
        return type("R", (), {"data": rows})()


class _Client:
    def __init__(self, jobs=None): self.db = {"jobs": jobs or []}
    def table(self, name): return _Table(name, self.db)
    @property
    def events(self): return self.db.get("generation_events", [])
    @property
    def trip_updates(self): return self.db.get("trips_updates", [])


def _reel(url): return ReelData(reel_url=url, caption="📍Tokyo Tower", location_name="Tokyo",
                                short_code="x", capture_status="CAPTURED", transcript=None)

def _place(name):
    return PlaceResult(name=name, name_local=None, category="attraction",
                       source_type="reel_extracted", lat=35.6586, lng=139.7454,
                       confidence=0.9, evidence_quote="📍Tokyo Tower",
                       source_url="https://example.org/a", formatted_address=None)


@pytest.mark.asyncio
async def test_happy_path_completes_marks_job_and_emits_result():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                      "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert out["itinerary"]["days"][0]["place_names"] == ["Tokyo Tower"]
    stages = [e["stage"] for e in c.events]
    assert stages[:4] == ["scrape", "extract", "dedup", "narrate"]
    assert [e for e in c.events if e["event_type"] == "result"]
    assert c.db["jobs"][0]["status"] == "succeeded"
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_one_reel_fails_saves_with_gaps():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url):
        if url.endswith("bad"): raise RuntimeError("Apify scrape failed (HTTP 500)")
        return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/ok", "https://ig/bad"],
                                      "2026-08-01", "2026-08-01", job_id="job-1", client=c,
                                      scrape=scrape, extract=extract)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"


@pytest.mark.asyncio
async def test_all_reels_fail_is_critical_failure():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): raise RuntimeError("Apify scrape failed (HTTP 500)")
    async def extract(reel): return []
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/bad"], "2026-08-01",
                                      "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"][0]["payload"]["error"]
    assert c.db["jobs"][0]["status"] == "failed"
    assert c.trip_updates[-1]["status"] == "failed"


@pytest.mark.asyncio
async def test_unexpected_exception_still_writes_terminal_result():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None}])
    async def scrape(url): return _reel(url)
    def boom(reel): raise ValueError("unexpected non-async boom")  # wrong shape → TypeError on await
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                      "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=boom)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"]     # never a hanging stream
    assert c.db["jobs"][0]["status"] == "failed"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && uv run pytest pipeline/test_runner.py -v`
Expected: FAIL — `run_generation`/`record_event` not defined.

- [ ] **Step 3: Implement the runner**

```python
# backend/pipeline/runner.py
"""Live deterministic generation runner (scrape → extract → dedup → route-assembly),
streamed as generation_events and persisted progressively. Owns the durable job
lifecycle. Reuses the pure offline helpers; NEVER imports or mutates
offline_harness.run_offline_pipeline (the frozen #16 eval anchor). Phase-3/4 enrich
agents are deferred — their asyncio.gather fan-out slots into the enrich phase later.
"""
from __future__ import annotations

import asyncio
import os

from models.place import PlaceResult
from pipeline.dedup import dedupe_places
from pipeline.offline_harness import _date_range, assemble_itinerary
from jobs import mark_job_done, mark_job_running
from supabase_client import get_supabase_client


async def record_event(client, trip_id, *, event_type, stage, message, payload=None):
    """Insert one generation_events row (progressive persistence + SSE source)."""
    client.table("generation_events").insert({
        "trip_id": trip_id, "event_type": event_type, "stage": stage,
        "message": message, "payload": payload or {},
    }).execute()


def _set_status(client, trip_id, user_id, status):
    # Owner check (guardrail #6): filter on id AND user_id even under service-role.
    client.table("trips").update({"status": status}).eq("id", trip_id).eq("user_id", user_id).execute()


async def run_generation(trip_id, user_id, reel_urls, start_date, end_date,
                         *, job_id=None, pace="balanced", client=None, scrape=None, extract=None):
    """Run the deterministic spine; own the job lifecycle; always write a terminal result."""
    client = client or get_supabase_client()
    if scrape is None:
        from scrape.apify_direct import scrape_reel
        token = os.environ["APIFY_TOKEN"]
        async def scrape(url): return await scrape_reel(url, token=token)
    if extract is None:
        from genagents.place_extractor import extract_places
        extract = extract_places

    if job_id:
        await mark_job_running(client, job_id)
    try:
        _set_status(client, trip_id, user_id, "generating")
        degraded = False

        # PHASE 1: SCRAPE (parallel, partial-failure isolated)
        await record_event(client, trip_id, event_type="stage", stage="scrape",
                           message=f"scraping {len(reel_urls)} reel(s)")
        scraped = await asyncio.gather(*[scrape(u) for u in reel_urls], return_exceptions=True)
        reels = []
        for url, res in zip(reel_urls, scraped):
            if isinstance(res, Exception):
                degraded = True
                await record_event(client, trip_id, event_type="warning", stage="scrape",
                                   message=f"reel skipped: {url}")
            else:
                reels.append(res)
        if not reels:
            return await _fail(client, trip_id, user_id, job_id, "scrape", "no reels could be scraped")

        # PHASE 2: EXTRACT (parallel, partial-failure isolated) + DEDUP
        await record_event(client, trip_id, event_type="stage", stage="extract",
                           message=f"extracting places from {len(reels)} reel(s)")
        per_reel = await asyncio.gather(*[extract(r) for r in reels], return_exceptions=True)
        places: list[PlaceResult] = []
        for res in per_reel:
            if isinstance(res, Exception):
                degraded = True
                await record_event(client, trip_id, event_type="warning", stage="extract",
                                   message="extraction failed for one reel")
            else:
                places.extend(res)
        if not places:
            return await _fail(client, trip_id, user_id, job_id, "extract",
                               "no verified places after extraction")

        await record_event(client, trip_id, event_type="stage", stage="dedup",
                           message=f"deduping {len(places)} place(s)")
        canonical = dedupe_places(places).places

        # PHASE 4: NARRATE (deterministic route assembly)
        await record_event(client, trip_id, event_type="stage", stage="narrate",
                           message="assembling itinerary")
        itinerary = assemble_itinerary(canonical, _date_range(start_date, end_date), pace=pace)

        status = "saved_with_gaps" if degraded else "complete"
        await record_event(client, trip_id, event_type="stage", stage="save", message="saving trip")
        _set_status(client, trip_id, user_id, status)
        payload = {"itinerary": itinerary.model_dump()}
        await record_event(client, trip_id, event_type="result", stage="save",
                           message="generation complete", payload=payload)
        if job_id:
            await mark_job_done(client, job_id, status="succeeded")
        return payload
    except Exception:
        # Any unexpected error → terminal result, failed status, failed job (never hang the stream).
        return await _fail(client, trip_id, user_id, job_id, "save", "unexpected generation error")


async def _fail(client, trip_id, user_id, job_id, stage, message):
    await record_event(client, trip_id, event_type="error", stage=stage, message=message)
    _set_status(client, trip_id, user_id, "failed")
    await record_event(client, trip_id, event_type="result", stage=stage,
                       message="generation failed", payload={"error": message})
    if job_id:
        await mark_job_done(client, job_id, status="failed")
    return {"error": message}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && uv run pytest pipeline/test_runner.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Verify the #16 eval is still green (parity anchor untouched)**

Run: `cd backend && uv run pytest pipeline/ evals/ -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all pipeline/eval tests PASS; eval exits 0 with unchanged baseline numbers.

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/runner.py backend/pipeline/test_runner.py
git commit -m "feat(pipeline): live runner owns job lifecycle + partial-failure + terminal-result wrapper"
```

---

### Task 4: SSE endpoint + schemas + idempotent routes

**Files:**
- Modify: `backend/api/schemas.py`, `backend/api/streaming.py`, `backend/main.py`
- Test: `backend/api/test_streaming.py`, `backend/test_main.py` (create)

**Interfaces:**
- Consumes: `get_current_user_id` + `get_user_id_from_query_or_header` (T1), `get_supabase_client`, `compute_idempotency_key` + `enqueue_job` (T2), `run_generation` + `record_event` (T3).
- Produces (`schemas.py`): `GenerateTripRequest(reel_urls: list[str] Field(min_length=1,max_length=5), start_date, end_date, destination_hint=None, pace="balanced")`; `GenerateTripResponse(trip_id: str)`.
- Produces (`streaming.py`): `format_sse(payload) -> str`; `DONE`; `async def stream_trip_events(client, trip_id, *, poll_s=0.5, max_polls=600) -> AsyncIterator[str]` — a **seen-set** stream: each poll fetches all events for `trip_id` ordered by `(created_at, id)`, emits rows whose `id` is unseen, and on the `result` event yields `DONE`. On timeout it yields a terminal `error` `result` **then** `DONE` (never a bare `DONE`).
- Produces (`main.py`): idempotent `POST /generate-trip` + query-param-authed `GET /generate-trip/stream/{trip_id}`.

- [ ] **Step 1: Write the failing test for the SSE generator (seen-set + timeout terminal result)**

```python
# backend/api/test_streaming.py
import pytest
from api import streaming


def test_format_sse_and_done():
    assert streaming.format_sse({"type": "stage"}) == 'data: {"type": "stage"}\n\n'
    assert streaming.DONE == "data: [DONE]\n\n"


class _Query:
    def __init__(self, rows): self.rows = rows
    def select(self, *_): return self
    def eq(self, *_): return self
    def order(self, *_, **__): return self
    def execute(self): return type("R", (), {"data": list(self.rows)})()


class _Client:
    def __init__(self, rows): self.rows = rows
    def table(self, _): return _Query(self.rows)


@pytest.mark.asyncio
async def test_stream_emits_new_events_then_done_on_result():
    rows = [
        {"id": "e1", "created_at": "t", "event_type": "stage", "stage": "scrape", "message": "s", "payload": {}},
        {"id": "e2", "created_at": "t", "event_type": "result", "stage": "save", "message": "done",
         "payload": {"itinerary": {"days": []}}},   # same created_at as e1 — must NOT be skipped
    ]
    out = [c async for c in streaming.stream_trip_events(_Client(rows), "trip-1", poll_s=0, max_polls=3)]
    assert streaming.DONE == out[-1]
    assert '"type": "result"' in out[-2] and '"itinerary"' in out[-2]


@pytest.mark.asyncio
async def test_stream_timeout_emits_error_result_before_done():
    # No result row ever arrives → timeout path must still send a result, then DONE.
    rows = [{"id": "e1", "created_at": "t", "event_type": "stage", "stage": "scrape",
             "message": "s", "payload": {}}]
    out = [c async for c in streaming.stream_trip_events(_Client(rows), "trip-1", poll_s=0, max_polls=1)]
    assert streaming.DONE == out[-1]
    assert '"type": "result"' in out[-2] and '"error"' in out[-2]   # never a bare DONE
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest api/test_streaming.py -v`
Expected: FAIL — module attributes undefined.

- [ ] **Step 3: Implement schemas + streaming**

```python
# backend/api/schemas.py
"""Request/response models for the generation API."""
from __future__ import annotations

from pydantic import BaseModel, Field


class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    pace: str = "balanced"


class GenerateTripResponse(BaseModel):
    trip_id: str
```

```python
# backend/api/streaming.py
"""SSE helpers + a generation_events-polling stream generator.

Sources events from the durable generation_events table (progressive persistence +
reconnect-replay). A seen-set of event ids (not a created_at cursor) means two
events sharing a timestamp are never skipped. Termination is the repo's most
breaking contract: EVERY terminal path (result OR timeout) ends with a `result`
event then `data: [DONE]\\n\\n` — never a bare DONE. See CLAUDE.md.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

DONE = "data: [DONE]\n\n"


def format_sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def stream_trip_events(client, trip_id, *, poll_s: float = 0.5,
                             max_polls: int = 600) -> AsyncIterator[str]:
    """Poll generation_events, stream each unseen row as SSE, end on `result`.

    Seen-set (by row id) + order by (created_at, id) → equal-timestamp events are
    never dropped. On timeout, emit a terminal error `result` then DONE so a stuck
    run is never read as an empty success.
    """
    seen: set[str] = set()
    for _ in range(max_polls):
        rows = (client.table("generation_events").select("*").eq("trip_id", trip_id)
                .order("created_at").order("id").execute()).data
        for row in rows:
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            yield format_sse({"type": row["event_type"], "stage": row["stage"],
                              "msg": row["message"], "content": row["payload"]})
            if row["event_type"] == "result":
                yield DONE
                return
        if poll_s:
            yield ": heartbeat\n\n"
            await asyncio.sleep(poll_s)
    # Timeout: synthesize a terminal result so the client never sees a bare DONE.
    yield format_sse({"type": "result", "stage": "save", "msg": "stream timed out",
                      "content": {"error": "generation timed out"}})
    yield DONE
```

- [ ] **Step 4: Run to verify streaming tests pass**

Run: `cd backend && uv run pytest api/test_streaming.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the routes (idempotent replay + auth)**

```python
# backend/test_main.py
import os
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
import main
from auth import get_current_user_id


class _T:
    def __init__(self, name, db): self.name, self.db = name, db; self._op = None; self._f = {}
    def insert(self, row): self._op = ("insert", row); return self
    def select(self, *_): self._op = ("select", None); return self
    def eq(self, c, v): self._f[c] = v; return self
    def execute(self):
        op, row = self._op
        if op == "insert":
            row = {"id": f"{self.name}-1", **row}; self.db.setdefault(self.name, []).append(row)
            return type("R", (), {"data": [row]})()
        rows = [r for r in self.db.get(self.name, []) if all(r.get(k) == v for k, v in self._f.items())]
        return type("R", (), {"data": rows})()


@pytest.fixture
def ctx(monkeypatch):
    db = {}
    monkeypatch.setattr(main, "get_supabase_client", lambda: type("C", (), {"table": lambda self, n: _T(n, db)})())
    async def _enq(trip_id, user_id, key, **kw): return "job-1"
    monkeypatch.setattr(main, "enqueue_job", _enq)
    async def _run(*a, **k): return {"itinerary": {"days": []}}
    monkeypatch.setattr(main, "run_generation", _run)
    main.app.dependency_overrides[get_current_user_id] = lambda: "user-1"
    yield TestClient(main.app), db
    main.app.dependency_overrides.clear()


def test_generate_trip_creates_trip_and_returns_id(ctx):
    tc, db = ctx
    r = tc.post("/generate-trip", json={"reel_urls": ["https://ig/r1"],
                                        "start_date": "2026-08-01", "end_date": "2026-08-02"})
    assert r.status_code == 200 and r.json()["trip_id"] == "trips-1"
    assert "trips" in db
    # create_trip event persists the run inputs for recovery
    ct = [e for e in db["generation_events"] if e["stage"] == "create_trip"][0]
    assert ct["payload"]["reel_urls"] == ["https://ig/r1"]


def test_generate_trip_requires_auth():
    main.app.dependency_overrides.clear()
    tc = TestClient(main.app)
    r = tc.post("/generate-trip", json={"reel_urls": ["https://ig/r1"],
                                        "start_date": "2026-08-01", "end_date": "2026-08-02"})
    assert r.status_code == 401
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd backend && uv run pytest test_main.py -v`
Expected: FAIL — routes not defined.

- [ ] **Step 7: Implement the routes**

```python
# backend/main.py
"""Astrail FastAPI app — health, trip generation, and SSE streaming."""
from __future__ import annotations

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from api.schemas import GenerateTripRequest, GenerateTripResponse
from api.streaming import stream_trip_events
from auth import get_current_user_id, get_user_id_from_query_or_header
from jobs import compute_idempotency_key, enqueue_job
from pipeline.runner import record_event, run_generation
from supabase_client import get_supabase_client

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/generate-trip", response_model=GenerateTripResponse)
async def generate_trip(req: GenerateTripRequest, background: BackgroundTasks,
                        user_id: str = Depends(get_current_user_id)) -> GenerateTripResponse:
    client = get_supabase_client()
    idem = compute_idempotency_key(user_id, req.reel_urls, req.start_date, req.end_date)

    # Idempotent replay: a retried POST returns the SAME trip (never a duplicate).
    existing = (client.table("jobs").select("trip_id").eq("idempotency_key", idem).execute()).data
    if existing:
        return GenerateTripResponse(trip_id=existing[0]["trip_id"])

    # Create trip FIRST (jobs composite FK needs it), then persist run inputs, then enqueue.
    trip = (client.table("trips").insert({
        "user_id": user_id, "status": "generating",
        "destination_hint": req.destination_hint,
        "start_date": req.start_date, "end_date": req.end_date,
    }).execute()).data[0]
    trip_id = trip["id"]
    # create_trip event payload carries the run inputs so recovery can re-run from Phase 1.
    await record_event(client, trip_id, event_type="stage", stage="create_trip",
                       message="trip created",
                       payload={"reel_urls": req.reel_urls, "start_date": req.start_date,
                                "end_date": req.end_date, "pace": req.pace})
    try:
        job_id = await enqueue_job(trip_id, user_id, idem)
    except Exception:
        # Never leave an orphan trip with no durable job.
        await record_event(client, trip_id, event_type="error", stage="create_trip",
                           message="could not enqueue job")
        client.table("trips").update({"status": "failed"}).eq("id", trip_id).eq("user_id", user_id).execute()
        raise HTTPException(status_code=500, detail="Could not enqueue generation job")

    background.add_task(run_generation, trip_id, user_id, req.reel_urls,
                        req.start_date, req.end_date, job_id=job_id, pace=req.pace)
    return GenerateTripResponse(trip_id=trip_id)


@app.get("/generate-trip/stream/{trip_id}")
async def stream(trip_id: str,
                 user_id: str = Depends(get_user_id_from_query_or_header)) -> StreamingResponse:
    client = get_supabase_client()
    owner = (client.table("trips").select("user_id").eq("id", trip_id).execute()).data
    if not owner or owner[0]["user_id"] != user_id:      # guardrail #6 owner check
        raise HTTPException(status_code=404, detail="Trip not found")
    return StreamingResponse(stream_trip_events(client, trip_id), media_type="text/event-stream")
```

- [ ] **Step 8: Run the route + streaming tests to verify they pass**

Run: `cd backend && uv run pytest test_main.py api/test_streaming.py -v`
Expected: PASS.

- [ ] **Step 9 (optional integration — live DB): end-to-end spine against the connected Supabase**

Requires `RUN_DB_INTEGRATION=1`, a seeded `ASTRAIL_TEST_USER_ID`, and `SUPABASE_JWT_SECRET`. Injects fake `scrape`/`extract` (no Apify/OpenAI cost). FastAPI's `TestClient` runs `BackgroundTasks` before returning, so the run has completed by the time the response lands.

```python
# backend/test_main_integration.py
import os
import pytest
from jose import jwt
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration
RUN = os.environ.get("RUN_DB_INTEGRATION") == "1"


@pytest.mark.skipif(not RUN, reason="set RUN_DB_INTEGRATION=1 to run against the dev DB")
def test_generate_trip_end_to_end(monkeypatch):
    import main
    from pipeline import runner
    from models.reel import ReelData
    from models.place import PlaceResult

    user_id = os.environ["ASTRAIL_TEST_USER_ID"]

    async def scrape(url):
        return ReelData(reel_url=url, caption="📍Tokyo Tower", location_name="Tokyo",
                        short_code="x", capture_status="CAPTURED", transcript=None)

    async def extract(reel):
        return [PlaceResult(name="Tokyo Tower", name_local=None, category="attraction",
                            source_type="reel_extracted", lat=35.6586, lng=139.7454,
                            confidence=0.9, evidence_quote="📍Tokyo Tower",
                            source_url="https://example.org/a", formatted_address=None)]

    async def run(trip_id, uid, urls, sd, ed, **kw):
        return await runner.run_generation(trip_id, uid, urls, sd, ed, job_id=kw.get("job_id"),
                                           scrape=scrape, extract=extract)

    monkeypatch.setattr(main, "run_generation", run)
    token = jwt.encode({"sub": user_id, "aud": "authenticated"},
                       os.environ["SUPABASE_JWT_SECRET"], algorithm="HS256")
    tc = TestClient(main.app)
    resp = tc.post("/generate-trip",
                   headers={"Authorization": f"Bearer {token}"},
                   json={"reel_urls": ["https://ig/r1"],
                         "start_date": "2026-08-01", "end_date": "2026-08-01"})
    assert resp.status_code == 200
    trip_id = resp.json()["trip_id"]
    client = main.get_supabase_client()
    try:
        events = (client.table("generation_events").select("event_type")
                  .eq("trip_id", trip_id).execute()).data
        assert any(e["event_type"] == "result" for e in events)   # spine ran to completion
        job = (client.table("jobs").select("status").eq("trip_id", trip_id).execute()).data
        assert job and job[0]["status"] in ("succeeded", "saved_with_gaps", "complete")
    finally:
        client.table("trips").delete().eq("id", trip_id).execute()  # cascade cleans jobs+events
```

Run: `cd backend && RUN_DB_INTEGRATION=1 uv run --env-file ../.env pytest test_main_integration.py -v -m integration`
Expected: PASS — a real trip is created, generation runs, a `result` event lands, the job is terminal, and the trip (plus cascade-deleted jobs/events) is cleaned up.

- [ ] **Step 10: Commit**

```bash
git add backend/api/schemas.py backend/api/streaming.py backend/main.py \
        backend/api/test_streaming.py backend/test_main.py backend/test_main_integration.py
git commit -m "feat(api): idempotent POST /generate-trip + query-param-authed seen-set SSE stream"
```

---

### Task 5: Durable startup recovery sweep + re-dispatch

**Files:**
- Modify: `backend/jobs.py` (implement `recover_inflight_jobs`)
- Modify: `backend/main.py` (startup hook re-dispatches from the `create_trip` payload)
- Test: `backend/test_jobs_recovery.py` (create)

**Interfaces:**
- Produces: `async def recover_inflight_jobs(*, client=None, stale_after_s=900) -> list[dict]` — flips **stale** `running` jobs (`locked_at` older than `stale_after_s`) to `retryable`, then returns all reclaimable jobs (`status IN (pending, retryable)`) as `[{id, trip_id, user_id}]`. Fresh `running` jobs are left alone (no rolling-deploy double-run). Restart-with-cache-reuse, not resume (guardrail #12).
- Modifies `main.py`: a startup handler calls `recover_inflight_jobs`, reads each job's `create_trip` event `payload` to reconstruct the run inputs, and re-dispatches `run_generation` via `asyncio.create_task`.

- [ ] **Step 1: Write the failing test**

```python
# backend/test_jobs_recovery.py
import pytest
import jobs


class _T:
    def __init__(self, store): self.store = store; self._op = None; self._f = {}; self._lt = None
    def update(self, row): self._op = ("update", row); return self
    def select(self, *_): self._op = ("select", None); return self
    def eq(self, c, v): self._f[c] = ("eq", v); return self
    def in_(self, c, vals): self._f[c] = ("in", vals); return self
    def lt(self, c, v): self._f[c] = ("lt", v); return self
    def _match(self, r):
        for c, (op, v) in self._f.items():
            rv = r.get(c)
            if op == "eq" and rv != v: return False
            if op == "in" and rv not in v: return False
            if op == "lt" and not (rv is not None and rv < v): return False
        return True
    def execute(self):
        op, row = self._op
        hit = [r for r in self.store if self._match(r)]
        if op == "update":
            for r in hit: r.update(row)
        return type("R", (), {"data": hit})()


class _Client:
    def __init__(self, store): self.store = store
    def table(self, _): return _T(self.store)


@pytest.mark.asyncio
async def test_recovers_pending_retryable_and_stale_running_only():
    store = [
        {"id": "j1", "status": "pending",   "trip_id": "t1", "user_id": "u", "locked_at": None},
        {"id": "j2", "status": "running",   "trip_id": "t2", "user_id": "u", "locked_at": "2000-01-01T00:00:00+00:00"},  # stale
        {"id": "j3", "status": "running",   "trip_id": "t3", "user_id": "u", "locked_at": "2999-01-01T00:00:00+00:00"},  # fresh
        {"id": "j4", "status": "succeeded", "trip_id": "t4", "user_id": "u", "locked_at": None},
    ]
    reclaimable = await jobs.recover_inflight_jobs(client=_Client(store), stale_after_s=900)
    ids = {r["id"] for r in reclaimable}
    assert ids == {"j1", "j2"}            # pending + stale-running; NOT fresh-running, NOT succeeded
    assert store[1]["status"] == "retryable"   # stale running flipped
    assert store[2]["status"] == "running"     # fresh running untouched (no double-run)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && uv run pytest test_jobs_recovery.py -v`
Expected: FAIL — `recover_inflight_jobs` raises `NotImplementedError`.

- [ ] **Step 3: Implement recover_inflight_jobs**

```python
# backend/jobs.py  (replace the recover_inflight_jobs stub)
from datetime import timedelta   # add to the existing datetime import line


async def recover_inflight_jobs(*, client=None, stale_after_s: int = 900) -> list[dict]:
    """Flip STALE running jobs to retryable, then return all reclaimable jobs.

    Restart-with-cache-reuse, NOT resume (guardrail #12): a reclaimed job re-runs
    from Phase 1. Only STALE running jobs (locked_at older than stale_after_s) are
    re-queued — a fresh running job on another live instance is left alone so a
    rolling deploy never double-runs. Never silently drops a run.
    """
    client = client or get_supabase_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=stale_after_s)).isoformat()
    stale = (client.table("jobs").select("id").eq("status", "running").lt("locked_at", cutoff).execute()).data
    for r in stale:
        client.table("jobs").update({"status": "retryable"}).eq("id", r["id"]).execute()
    reclaimable = (client.table("jobs").select("id,trip_id,user_id")
                   .in_("status", ["pending", "retryable"]).execute()).data
    return reclaimable
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && uv run pytest test_jobs_recovery.py -v`
Expected: PASS.

- [ ] **Step 5: Wire the startup re-dispatch in main.py**

```python
# backend/main.py  (add after the app/middleware definition)
import asyncio
from jobs import recover_inflight_jobs


async def _redispatch(client, job) -> None:
    """Reconstruct a reclaimable job's run inputs from its create_trip event and re-run it."""
    ev = (client.table("generation_events").select("payload")
          .eq("trip_id", job["trip_id"]).eq("stage", "create_trip").execute()).data
    if not ev:
        return                                  # no inputs to replay; leave it for a human/next sweep
    p = ev[0]["payload"]
    await run_generation(job["trip_id"], job["user_id"], p["reel_urls"],
                         p["start_date"], p["end_date"], job_id=job["id"], pace=p.get("pace", "balanced"))


@app.on_event("startup")
async def _recover_jobs_on_startup() -> None:
    """Guardrail #12: on boot, re-queue and re-run anything a crash left mid-flight."""
    client = get_supabase_client()
    for job in await recover_inflight_jobs(client=client):
        asyncio.create_task(_redispatch(client, job))
```

Note: `@app.on_event("startup")` is deprecated in newer FastAPI in favor of a `lifespan=` handler; functionally equivalent for v1. If the implementer prefers, wrap the same body in an `asynccontextmanager` passed as `FastAPI(lifespan=...)`.

- [ ] **Step 6: Run the full backend suite (nothing regressed; eval still green)**

Run: `cd backend && uv run pytest -q && uv run python -m evals.run_eval --subject pipeline`
Expected: all tests PASS; eval exits 0 with unchanged baseline numbers.

- [ ] **Step 7: Commit**

```bash
git add backend/jobs.py backend/main.py backend/test_jobs_recovery.py
git commit -m "feat(jobs): startup recovery re-queues + re-dispatches stale/pending runs (restart-not-resume)"
```

---

## Self-Review

**Spec coverage (PRD "Weeks 5-6: Durable Pipeline" + §16/§17/§18/§19/§20):**
- Durable jobs (full lifecycle) → Tasks 2 (enqueue + mark) + 3 (runner owns it) + 5 (recovery). ✅
- SSE streaming (`[DONE]` termination, no bare DONE) → Task 4. ✅
- Progressive persistence → Task 3 (each stage → a `generation_events` row; terminal `result` carries the itinerary). ✅
- Partial-trip save (§17) → Task 3 (`saved_with_gaps` vs `complete` vs `failed`; critical vs non-critical; outer wrapper). ✅
- Auth on every endpoint (§18, #5) → Task 1 (header + query-param) on both routes. Owner check (#6) → Tasks 3 (trip updates) + 4 (stream route). ✅
- Idempotency → Task 2 (`compute_idempotency_key`) + Task 4 (replay). ✅
- Reel/place cache, pgvector+geo dedup (§19) → already shipped (Phase 1.1); dedup reused in Task 3. ✅
- Preference-context persistence (§19 Phase 3) → **deferred** (needs mem0 / the Phase-3 agent); `pace` threaded now. ⚠️ intentional
- Enrich agents / narrator / orchestrator (§19 Phase 4/5) → **deferred to their own cards** (stubs today). ⚠️ intentional

**Placeholder scan:** every code step is complete/runnable; every command has an expected result. No "TBD"/"add error handling"/"similar to Task N". ✅

**Type consistency:** `run_generation(trip_id, user_id, reel_urls, start_date, end_date, *, job_id, pace, client, scrape, extract)` identical in Tasks 3/4/5. `enqueue_job(trip_id, user_id, idempotency_key, *, client)`, `mark_job_running(client, job_id)`, `mark_job_done(client, job_id, *, status)`, `recover_inflight_jobs(*, client, stale_after_s)` consistent across Tasks 2/3/5. `record_event(client, trip_id, *, event_type, stage, message, payload)` consistent Tasks 3/4/5. Stage/event_type strings all drawn from the DB check constraints. ✅

**Failure modes covered (from the eng-review):** job never transitions (F1 → Task 2/3 lifecycle + Task 5 recovery); non-idempotent retry (F2 → request key + replay); browser SSE 401 (F3 → query-param auth); cursor error on first poll + equal-timestamp skip (F4/F6 → seen-set); unexpected runner crash hangs stream (F5 → outer wrapper + terminal result); rolling-deploy double-run (F7 → stale-only recovery); bare DONE read as success (F8 → timeout terminal result); cross-user write (F9 → owner-filtered updates); orphan trip on enqueue failure (F10 → mark failed + 500).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (backend infra, no product-scope change) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_found → folded | 4 P1 + 6 P2 found; all folded into the plan |
| Outside Voice | `codex exec` | Independent 2nd opinion | 1 | issues_found → folded | Codex (high effort) independently confirmed F1 (job lifecycle) + surfaced F2/F3/F4 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run (backend-only; frontend is Zhi Hao's lane) |

- **CODEX:** confirmed the durable-job lifecycle is dead as originally designed (job never `running`, `claim_next_generation_job` uncalled, recovery watches an unset status), and caught three the first pass missed: non-idempotent retry key, browser `EventSource` 401 (can't send headers), and the empty-string SSE cursor. All verified against real code.
- **CROSS-MODEL:** strong agreement on F1 (both reviewers, independently). No cross-model tension — no point where the reviewers disagreed on a fix.
- **VERDICT:** ENG CLEARED (all 10 findings folded; deterministic-spine scope + `?token=` stream auth + runner-owned lifecycle confirmed by the user). Ready to implement via subagent-driven-development (`astrail-developer` per task → `astrail-reviewer` between tasks → final adversarial pass).

NO UNRESOLVED DECISIONS
