"""Live smoke for the daily-trip-quota RPC (Phase-2 Task 2) against the LINKED Supabase project.

Proves the backend's own service-role PostgREST `.rpc()` path (the exact call
`check_and_increment_daily_quota`/`refund_daily_quota` make in rate_limit.py) reaches
the newly-applied `increment_daily_trip_usage` / `decrement_daily_trip_usage` functions
on the live DB — i.e. no PGRST202, correct scalar/NULL semantics.

NON-DESTRUCTIVE: one increment then one decrement => net-zero on the target user's TODAY
row, whatever its starting count. Spends ZERO pipeline credits (no Apify/OpenAI, no trip).

Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from the process env; if absent it loads
backend/.env itself (so it runs as a plain `uv run python -m scripts.smoke_quota_rpc`,
not `--env-file`). If no user id is given it auto-picks one from live public.users.

Run:
    cd backend && uv run python -m scripts.smoke_quota_rpc [live_user_id]
"""
from __future__ import annotations

import asyncio
import os
import sys


def _ensure_env() -> None:
    if not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        from dotenv import find_dotenv, load_dotenv

        load_dotenv(find_dotenv(usecwd=True))


async def _rpc(client, name: str, params: dict):
    return (await client.rpc(name, params).execute()).data


async def main(user_id: str | None) -> int:
    _ensure_env()
    from supabase_client import get_supabase_client

    client = await get_supabase_client()

    if user_id is None:
        rows = (await client.table("users").select("id").limit(1).execute()).data
        if not rows:
            print("RESULT: FAIL ❌  no rows in public.users to smoke against; pass a user id explicitly.")
            return 1
        user_id = rows[0]["id"]
        print(f"(auto-picked live user {user_id})")

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
        exp = inc - 1 if isinstance(inc, int) else "?"
        print(f"decrement()          -> {dec!r}   (expect {exp}: restored)")
    except Exception as exc:  # noqa: BLE001 - smoke wants the raw failure surfaced
        print(f"\nRESULT: FAIL ❌  RPC call raised: {type(exc).__name__}: {exc}")
        print("If this is PGRST202 'function not found', the migration is not applied to THIS project.")
        return 1

    ok = isinstance(inc, int) and inc >= 1 and cap is None and dec == inc - 1
    print("\nRESULT:", "PASS ✅  live quota RPC reachable + increment/cap/decrement all correct"
          if ok else "FAIL ❌  unexpected values above")
    return 0 if ok else 1


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    raise SystemExit(asyncio.run(main(arg)))
