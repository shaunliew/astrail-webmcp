"""Service-role-only Saved Reel analysis quota helpers."""
from __future__ import annotations


async def reserve_organize_item_analysis(
    client, item_id: str, user_id: str
) -> str | None:
    result = await client.rpc(
        "reserve_organize_item_analysis",
        {"p_item_id": item_id, "p_user_id": user_id},
    ).execute()
    return result.data


async def refund_organize_item_analysis(client, item_id: str, user_id: str) -> bool:
    result = await client.rpc(
        "refund_organize_item_analysis",
        {"p_item_id": item_id, "p_user_id": user_id},
    ).execute()
    return bool(result.data)
