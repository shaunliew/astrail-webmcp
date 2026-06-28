"""Opt-in LIVE probe: is the Apify Instagram actor currently unblocked?

When Instagram throttles the logged-out actor, EVERY reel fails the same way
(see ApifyScrapeError). Before burning a real capture run, probe a stable,
maximally-public account (natgeo) and get a clear verdict:

    python -m scrape.probe_apify          # exit 0 = unblocked, 1 = still blocked, 2 = no token

The classifier is injected so this is offline-testable. Importing this module
pulls in no SDK and needs no key — the same import-time invariant as capture.py.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Awaitable, Callable

import httpx

from scrape.apify_direct import ACTOR

# A maximally-public, reel-heavy account. If the actor cannot scrape THIS
# logged-out, it cannot scrape anything logged-out — i.e. the block is global.
PROBE_TARGET = "natgeo"
_ENDPOINT = f"https://api.apify.com/v2/acts/{ACTOR}/run-sync-get-dataset-items"

# fetch(body, token=...) -> list[dict] (the actor's dataset items).
Fetch = Callable[..., Awaitable[list]]


async def probe_actor(*, token: str, fetch: Fetch, target: str = PROBE_TARGET) -> tuple[bool, str]:
    """Probe the actor against `target`. Returns (unblocked, human_detail).

    A token-safe verdict — the detail never echoes the token. `fetch` is injected
    so the network call can be faked in tests.
    """
    items = await fetch({"username": [target], "resultsLimit": 1}, token=token)
    if not items:
        return False, "actor returned 0 items"
    item = items[0]
    if item.get("error"):
        return False, f"{item.get('error')} ({item.get('errorDescription') or 'no detail'})"
    return True, f"scraped @{target} OK"


async def _live_fetch(body: dict, *, token: str, timeout_s: int = 120) -> list:
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=timeout_s + 10) as http:
        resp = await http.post(_ENDPOINT, json=body, headers=headers, params={"timeout": timeout_s})
    if resp.status_code // 100 != 2:
        raise RuntimeError(f"Apify probe failed (HTTP {resp.status_code})")
    return resp.json()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe whether the Apify IG actor is unblocked")
    parser.add_argument("--target", default=PROBE_TARGET, help="public IG username to probe")
    args = parser.parse_args(argv)

    from dotenv import find_dotenv, load_dotenv  # lazy: keeps `import` keyless
    load_dotenv(find_dotenv())

    token = os.environ.get("APIFY_TOKEN")
    if not token:
        print("probe needs APIFY_TOKEN in the environment.", file=sys.stderr)
        return 2

    unblocked, detail = asyncio.run(probe_actor(token=token, fetch=_live_fetch, target=args.target))
    if unblocked:
        print(f"UNBLOCKED — {detail}. Safe to re-run capture.")
        return 0
    print(f"STILL BLOCKED — {detail}. Wait and retry later.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
