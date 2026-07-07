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
