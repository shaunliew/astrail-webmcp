"""Live smoke for the daily-trip-quota RPC (Phase-2 Task 2) against the LINKED Supabase project.

Proves the backend's own service-role PostgREST `.rpc()` path (the exact call
`check_and_increment_daily_quota`/`refund_daily_quota` make in rate_limit.py) reaches
the newly-applied `increment_daily_trip_usage` / `decrement_daily_trip_usage` functions
on the live DB — i.e. no PGRST202, correct scalar/NULL semantics.

NON-DESTRUCTIVE: one increment then one decrement => net-zero on the given user's TODAY
row, whatever its starting count. Spends ZERO pipeline credits (no Apify/OpenAI, no trip).

Run:
    cd backend && uv run --env-file .env python -m scripts.smoke_quota_rpc <live_user_id>

<live_user_id> must be a UUID that already exists in public.users on the live project
(FK: public.user_daily_usage.user_id -> public.users.id). Grab any real user's UID from
the Supabase dashboard (Authentication -> Users) or use your own account's id.
"""
from __future__ import annotations

import asyncio
import sys

from supabase_client import get_supabase_client


async def _rpc(client, name: str, params: dict):
    return (await client.rpc(name, params).execute()).data


async def main(user_id: str) -> int:
    client = await get_supabase_client()
    HIGH = 10_000  # far above any real daily count -> the first increment always succeeds

    try:
        inc = await _rpc(client, "increment_daily_trip_usage", {"p_user_id": user_id, "p_limit": HIGH})
        print(f"increment(limit={HIGH})  -> {inc!r}   (expect an int >= 1)")

        # Cap path: call again with limit == the current count -> WHERE count < limit is
        # false -> no row returned -> NULL (the "at/over quota" signal the gate relies on).
        cap = await _rpc(client, "increment_daily_trip_usage", {"p_user_id": user_id, "p_limit": inc})
        print(f"increment(limit={inc}) -> {cap!r}   (expect None: at/over cap -> rejected)")

        # Restore: only ONE real increment happened (the cap call did not change the count),
        # so a single decrement returns the row to its starting value. Net-zero.
        dec = await _rpc(client, "decrement_daily_trip_usage", {"p_user_id": user_id})
        print(f"decrement()          -> {dec!r}   (expect {inc - 1 if isinstance(inc, int) else '?'}: restored)")
    except Exception as exc:  # noqa: BLE001 - smoke wants the raw failure surfaced
        print(f"\nRESULT: FAIL ❌  RPC call raised: {type(exc).__name__}: {exc}")
        print("If this is PGRST202 'function not found', the migration is not applied to THIS project.")
        return 1

    ok = isinstance(inc, int) and inc >= 1 and cap is None and dec == inc - 1
    print("\nRESULT:", "PASS ✅  live quota RPC reachable + increment/cap/decrement all correct"
          if ok else "FAIL ❌  unexpected values above")
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: python -m scripts.smoke_quota_rpc <live_user_id>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(asyncio.run(main(sys.argv[1])))
