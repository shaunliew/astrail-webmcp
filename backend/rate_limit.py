"""Rate-limit config, the slowapi Limiter singleton, the per-user key function,
and the durable daily-quota helpers.

Two layers gate POST /generate-trip:
  - Layer 1 (durable): a per-user daily trip quota in public.user_daily_usage,
    enforced via an atomic Postgres RPC (survives restarts; the real free-tier cap).
  - Layer 2 (burst): slowapi in-memory, keyed on the authenticated user id
    (request.state.user_id, stashed by get_current_user_id_stashed). It targets
    AUTHENTICATED per-user abuse. FastAPI resolves the auth dependency BEFORE the
    slowapi-wrapped route body runs, so an unauthenticated POST is rejected 401 before
    the limiter executes — the IP fallback in rate_limit_key is therefore unreachable
    on /generate-trip and exists only as defensive behavior for any future route that
    runs the limiter pre-auth. Anonymous / volumetric flood protection is delegated to
    the edge (Cloudflare in front of Render) per the locked Phase-2 decision, NOT to
    this in-process limiter (which, behind the proxy, would see Render's IP anyway).

Pure HTTP-entry gate — never touches the runner, dedupe, or the #16 eval anchor.
In-memory storage is correct for a single Render instance; switch storage_uri to
Render Key Value only when scaling past one instance.
"""
from __future__ import annotations

import os
from typing import NamedTuple

from fastapi import Header, Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from auth import get_current_user_id

BURST_LIMIT: str = os.environ.get("BURST_LIMIT", "3/minute")
# Saving a Reel is a pure DB insert (normalize URL + one atomic RPC) — no Apify, no
# scraping, no OpenAI. The tight BURST_LIMIT (tuned for the Apify/OpenAI-spending routes)
# false-positives the core "paste 1-5 Reels" flow, so the save route gets its own generous
# ceiling. The Apify cost lives at /saved-reels/organize, which keeps BURST_LIMIT.
SAVE_LIMIT: str = os.environ.get("SAVE_LIMIT", "30/minute")
DAILY_TRIP_QUOTA: int = int(os.environ.get("DAILY_TRIP_QUOTA", "5"))
TRIAL_LIFETIME_LIMIT: int = int(os.environ.get("TRIAL_LIFETIME_LIMIT", "1"))
# Rollback switch (default on): enabled = new atomic-RPC path (reserve_and_enqueue_trip_job);
# disabled = legacy daily-quota path (check_and_increment_daily_quota / refund_daily_quota).
# Fail-SAFE parse: ENABLED unless the value is an explicit recognized falsy token, so a bare
# "1"/"yes"/"on" (or a typo) keeps lifetime enforcement ON rather than silently dropping to the
# legacy path (the old `== "true"` check routed `=1` to legacy). Only false/0/no/off flip it off.
ENTITLEMENTS_ENABLED: bool = (
    os.environ.get("ENTITLEMENTS_ENABLED", "true").strip().lower() not in ("false", "0", "no", "off")
)


def rate_limit_key(request: Request) -> str:
    """slowapi key: the authenticated user id if an auth dependency stashed it,
    else the client IP. Sync (slowapi requires a sync key_func).

    On /generate-trip the stashed user_id is always set (auth resolves before the
    limiter runs), so the IP-fallback branch is only reachable on a route that runs
    the limiter WITHOUT prior auth — none today. See the module docstring: anonymous
    floods are the edge's job, not this limiter's."""
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


async def check_and_increment_daily_quota(client, user_id: str, limit: int) -> bool:
    """Atomically increment today's trip count for user_id if below `limit`.
    Returns True if allowed (and incremented), False if already at/over quota.

    Deploy-order safety net (Codex HIGH #4): if the RPC is missing from the live DB
    (a migration that lagged a code deploy — deploys are manual, render.yaml autoDeploy:false),
    PostgREST returns PGRST202. Fail CLOSED with a clean 503 (protects Apify/OpenAI spend — deliberately
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


class ReserveResult(NamedTuple):
    """One row from the reserve_and_enqueue_trip_job RPC, passed through verbatim.

    outcome is one of: 'created', 'replay', 'trial_exhausted', 'daily_exhausted',
    'identity_unavailable', 'conflict_retry'. The wrapper does NOT branch on it —
    mapping each outcome to an HTTP response is the caller's job (main.py, Task 4).
    trip_id/job_id carry whatever nulls the RPC returned for that outcome.
    """

    outcome: str
    trip_id: str | None
    job_id: str | None


async def reserve_and_enqueue_trip_job(
    client,
    *,
    user_id: str,
    idempotency_key: str,
    destination_hint: str | None,
    start_date: str,
    end_date: str,
    budget_level: str | None,
    origin_city: str | None,
    preference_summary: str,
    preference_sources: list,
    event_payload: dict,
    trial_limit: int,
    daily_limit: int,
) -> ReserveResult:
    """Atomic reserve = enqueue via the reserve_and_enqueue_trip_job Postgres RPC.

    Returns EVERY outcome verbatim as a ReserveResult (created / replay /
    trial_exhausted / daily_exhausted / identity_unavailable / conflict_retry) —
    it deliberately does NOT branch on outcome; that mapping is the caller's job
    (main.py, Task 4). Dates ride as-is (ISO strings); preference_sources/event_payload
    ride as the list/dict they are (the client serializes to jsonb).

    Deploy-order safety net (mirrors check_and_increment_daily_quota): if the RPC is
    missing from the live DB (a migration that lagged a code deploy — deploys are manual,
    render.yaml autoDeploy:false), PostgREST returns PGRST202. Fail CLOSED with a distinct 503 (protects Apify/OpenAI
    spend — deliberately NOT fail-open). Any other APIError propagates (-> 500).
    """
    from fastapi import HTTPException
    from postgrest.exceptions import APIError

    try:
        resp = await client.rpc(
            "reserve_and_enqueue_trip_job",
            {
                "p_user_id": user_id,
                "p_idempotency_key": idempotency_key,
                "p_destination_hint": destination_hint,
                "p_start_date": start_date,
                "p_end_date": end_date,
                "p_budget_level": budget_level,
                "p_origin_city": origin_city,
                "p_preference_summary": preference_summary,
                "p_preference_sources": preference_sources,
                "p_event_payload": event_payload,
                "p_trial_limit": trial_limit,
                "p_daily_limit": daily_limit,
            },
        ).execute()
    except APIError as exc:
        if getattr(exc, "code", None) == "PGRST202":
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "generation_unavailable",
                    "message": "Trip generation temporarily unavailable",
                },
            ) from None
        raise
    row = resp.data[0]
    return ReserveResult(
        outcome=row["outcome"], trip_id=row["trip_id"], job_id=row["job_id"]
    )
