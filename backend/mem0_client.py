"""Hosted mem0 (Platform) singleton — cross-trip preference memory recall/store.

Mirrors supabase_client.get_supabase_client(): a lazy, double-checked-lock
singleton. Returns None when MEM0_API_KEY is unset OR construction fails, so
memory cleanly NO-OPS (guardrail #3: a trip never depends on mem0).

The mem0 client constructor makes a BLOCKING network ping to validate the key
(even AsyncMemoryClient.__init__ uses the blocking `requests` lib), so:
  * NEVER construct at module import — the offline #16 eval imports must stay
    credential-free and network-free;
  * construct in a dedicated single-worker executor (never the event loop, and
    never the shared asyncio.to_thread pool — see _CONSTRUCT_EXECUTOR below);
  * warm it once at app startup (main.lifespan) so the first trip doesn't pay it.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import os
import sys

_client = None          # AsyncMemoryClient | None
_initialized = False
_init_failed = False    # True once a construction attempt has failed (see mem0_status)
_lock = asyncio.Lock()

# mem0's AsyncMemoryClient.__init__ validates the key via a SYNC `requests.get`
# ping with NO `timeout=` kwarg, and `socket.setdefaulttimeout` is rejected here
# because it's process-global (would silently reach into unrelated code, e.g.
# Apify's own HTTP calls). `asyncio.wait_for` only bounds the asyncio-side wait
# — it cannot kill the underlying thread, so a hung ping otherwise leaks one
# zombie thread per retry (guardrail A6: retry-on-every-call) into the shared
# default `asyncio.to_thread` pool during a sustained mem0 outage. A dedicated
# single-worker executor caps that leak at exactly ONE stuck thread — later
# attempts queue behind it and their own `wait_for` still times out cleanly.
_CONSTRUCT_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=1, thread_name_prefix="mem0-construct"
)


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
    global _client, _initialized, _init_failed
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
            _client = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(_CONSTRUCT_EXECUTOR, _construct),
                timeout=8,
            )
            _init_failed = False
            _initialized = True
        except Exception as e:  # noqa: BLE001 — timeout / API error → disabled THIS attempt only
            print(f"[mem0] client unavailable this attempt, memory disabled: {type(e).__name__}",
                  file=sys.stderr)
            _client = None            # leave _initialized False → a later call RETRIES (Codex C7:
                                      # a transient boot blip must not disable memory process-wide)
            _init_failed = True       # observable by mem0_status() without re-triggering construction
    return _client


def mem0_status() -> str:
    """Non-networking view of the memory singleton, for /readiness.

    OBSERVES state; never constructs. get_mem0_client() intentionally retries after a
    failure (it leaves _initialized False so a transient boot blip does not disable memory
    process-wide), which means calling it from a polled health probe would re-run an
    8-second blocking constructor on every poll during a mem0 outage.

    'configured' means a key is set and a client object exists — NOT that mem0 is
    reachable right now. Construction is memoized and does no network I/O on later calls,
    so any stronger word would assert something never tested.
    """
    # Bare truthiness DELIBERATELY, matching get_mem0_client's own check (line 62) rather
    # than being stricter. A whitespace-only key is truthy, so the getter WILL attempt
    # construction and fail — this must report `init_failed`, not `disabled`. A status
    # that contradicts what the getter actually does is worse than no status.
    if not os.environ.get("MEM0_API_KEY"):
        return "disabled"
    if _client is not None:
        return "configured"
    return "init_failed" if _init_failed else "not_initialized"
