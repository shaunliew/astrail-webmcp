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
