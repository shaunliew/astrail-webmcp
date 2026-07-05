"""Async service-role Supabase client (server-side only; never exposed to the frontend).

Thin accessor around the async client used by the agent pipeline for
write-through caches, trip persistence, the durable jobs table, and Storage.
The service-role key bypasses RLS, so it must never reach the frontend.

Uses a lazy async singleton (NOT `functools.lru_cache`, which cannot memoize
an async factory) with a double-checked `asyncio.Lock` so concurrent callers
never race-create two clients.
"""
from __future__ import annotations

import asyncio
import os

import httpx
from supabase import AsyncClient, acreate_client
from supabase.lib.client_options import AsyncClientOptions

_client: AsyncClient | None = None
_lock = asyncio.Lock()

# REST timeout configured on the shared httpx client — NOT the deprecated
# AsyncPostgrestClient(timeout=/verify=) params. Handing supabase-py a
# pre-configured httpx client makes it take its non-deprecated postgrest
# constructor branch (supabase/_async/client.py: `if http_client is not None`).
_HTTP_TIMEOUT = httpx.Timeout(30.0)


async def get_supabase_client() -> AsyncClient:
    """Lazily create + memoize one service-role AsyncClient (double-checked lock)."""
    global _client
    if _client is None:
        async with _lock:
            if _client is None:
                options = AsyncClientOptions(httpx_client=httpx.AsyncClient(timeout=_HTTP_TIMEOUT))
                _client = await acreate_client(
                    os.environ["SUPABASE_URL"],
                    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
                    options=options,
                )
    return _client
