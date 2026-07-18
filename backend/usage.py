"""Service-role-only Saved Reel analysis quota helpers."""
from __future__ import annotations

from datetime import date


async def reserve_daily_reel_analysis(client, user_id: str) -> bool:
    result = await client.rpc(
        "reserve_daily_reel_analysis",
        {"p_user_id": user_id, "p_usage_date": date.today().isoformat()},
    ).execute()
    return result.data is not None


async def refund_daily_reel_analysis(client, user_id: str) -> None:
    await client.rpc(
        "refund_daily_reel_analysis",
        {"p_user_id": user_id, "p_usage_date": date.today().isoformat()},
    ).execute()
