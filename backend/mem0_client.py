"""Hosted mem0 (Platform) singleton — cross-trip preference memory recall/store.

Mirrors supabase_client.get_supabase_client(): a lazy, double-checked-lock
singleton. Returns None when MEM0_API_KEY is unset OR construction fails, so
memory cleanly NO-OPS (guardrail #3: a trip never depends on mem0).

The mem0 client constructor makes a BLOCKING network ping to validate the key
(even AsyncMemoryClient.__init__ uses the blocking `requests` lib), so:
  * NEVER construct at module import — the offline #16 eval imports must stay
    credential-free and network-free;
  * construct inside asyncio.to_thread so the one-time ping never blocks the
    event loop;
  * warm it once at app startup (main.lifespan) so the first trip doesn't pay it.
"""
from __future__ import annotations

import asyncio
import os
import sys

_client = None          # AsyncMemoryClient | None
_initialized = False
_lock = asyncio.Lock()


def _construct():
    """Blocking: build the hosted client (validates the key via a sync ping).

    Isolated + monkeypatchable so tests never import the real SDK or hit network.
    """
    from mem0 import AsyncMemoryClient

    return AsyncMemoryClient()   # reads MEM0_API_KEY from env


async def get_mem0_client():
    """Lazily build + memoize the hosted mem0 client, or None if unavailable.

    None means memory is DISABLED (no key, or mem0 unreachable at construction) —
    callers MUST treat None as 'no memory', never as an error.
    """
    global _client, _initialized
    if _initialized:
        return _client
    async with _lock:
        if _initialized:
            return _client
        if not os.environ.get("MEM0_API_KEY"):
            _client, _initialized = None, True     # no key: settled — memory disabled
            return _client
        try:
            # Timeout-bounded (Codex C6): a slow/hung hosted ping must not wedge boot or
            # the first trip. Memoize ONLY on success.
            _client = await asyncio.wait_for(asyncio.to_thread(_construct), timeout=8)
            _initialized = True
        except Exception as e:  # noqa: BLE001 — timeout / API error → disabled THIS attempt only
            print(f"[mem0] client unavailable this attempt, memory disabled: {type(e).__name__}",
                  file=sys.stderr)
            _client = None            # leave _initialized False → a later call RETRIES (Codex C7:
                                      # a transient boot blip must not disable memory process-wide)
    return _client
