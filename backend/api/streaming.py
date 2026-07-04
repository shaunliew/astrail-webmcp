"""SSE helpers + a generation_events-polling stream generator.

Sources events from the durable generation_events table (progressive
persistence + reconnect-replay). A seen-set of event ids (NOT a created_at
cursor) means two events sharing a timestamp are never skipped. Termination
is the repo's most breaking contract: EVERY terminal path (result OR
timeout) ends with a `result` event then `data: [DONE]\\n\\n` — never a bare
DONE. See CLAUDE.md.
"""
from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

DONE = "data: [DONE]\n\n"


def format_sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


async def stream_trip_events(
    client, trip_id: str, *, poll_s: float = 0.5, max_polls: int = 600
) -> AsyncIterator[str]:
    """Poll generation_events, stream each unseen row as SSE, end on `result`.

    Seen-set (by row id) + order by (created_at, id) means equal-timestamp
    events are never dropped. On timeout, emit a terminal error `result`
    then DONE so a stuck run is never read as an empty success.
    """
    seen: set[str] = set()
    for _ in range(max_polls):
        result = await (
            client.table("generation_events")
            .select("*")
            .eq("trip_id", trip_id)
            .order("created_at")
            .order("id")
            .execute()
        )
        for row in result.data:
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            yield format_sse({
                "type": row["event_type"],
                "stage": row["stage"],
                "msg": row["message"],
                "content": row["payload"],
            })
            if row["event_type"] == "result":
                yield DONE
                return
        if poll_s:
            yield ": heartbeat\n\n"
            await asyncio.sleep(poll_s)
    # Timeout: synthesize a terminal result so the client never sees a bare DONE.
    yield format_sse({
        "type": "result", "stage": "save", "msg": "stream timed out",
        "content": {"error": "generation timed out"},
    })
    yield DONE
