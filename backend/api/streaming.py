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


def format_sse(payload: dict, *, event_id: int | str | None = None) -> str:
    prefix = f"id: {event_id}\n" if event_id is not None else ""
    return f"{prefix}data: {json.dumps(payload)}\n\n"


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
        try:
            result = await (
                client.table("generation_events")
                .select("*")
                .eq("trip_id", trip_id)
                .order("created_at")
                .order("id")
                .execute()
            )
        except Exception:
            # Transient Supabase blip: events are durable, so the next poll
            # catches up. Skip this iteration rather than ending the stream.
            result = None
        if result is not None:
            for row in result.data:
                if row["id"] in seen:
                    continue
                seen.add(row["id"])
                is_result = row["event_type"] == "result"
                yield format_sse({
                    "type": row["event_type"],
                    "stage": row["stage"],
                    "msg": row["message"],
                    # result.content MUST be a JSON string (repo's most breaking
                    # SSE contract) — other event types stay as-is (additive).
                    "content": json.dumps(row["payload"]) if is_result else row["payload"],
                })
                if is_result:
                    yield DONE
                    return
        if poll_s:
            yield ": heartbeat\n\n"
            await asyncio.sleep(poll_s)
    # Timeout: synthesize a terminal result so the client never sees a bare DONE.
    yield format_sse({
        "type": "result", "stage": "save", "msg": "stream timed out",
        "content": json.dumps({"error": "generation timed out"}),
    })
    yield DONE


async def stream_organize_events(
    client, job_id: str, user_id: str, *, cursor: str | None = None,
    poll_s: float = 0.5, max_polls: int = 600,
) -> AsyncIterator[str]:
    """Replay durable organize_events after cursor and terminate on its result event."""
    try:
        cursor_sequence = int(cursor) if cursor else 0
    except ValueError:
        cursor_sequence = 0
    for _ in range(max_polls):
        try:
            query = client.table("organize_events").select("*").eq("job_id", job_id).eq("user_id", user_id)
            if cursor_sequence:
                query = query.gt("sequence", cursor_sequence)
            result = await query.order("sequence").execute()
        except Exception:
            result = None
        if result is not None:
            for row in result.data or []:
                sequence = int(row.get("sequence", 0))
                if sequence <= cursor_sequence:
                    continue
                cursor_sequence = sequence
                event_type = row.get("event_type", "stage")
                payload = row.get("payload") or {}
                if event_type == "result":
                    yield format_sse({
                        "type": "result", "stage": "organize", "msg": row.get("message", ""),
                        "content": json.dumps(payload),
                    }, event_id=sequence)
                    yield DONE
                    return
                yield format_sse({
                    "type": event_type, "stage": "organize", "msg": row.get("message", ""),
                    "content": payload,
                }, event_id=sequence)
        if poll_s:
            yield ": heartbeat\n\n"
            await asyncio.sleep(poll_s)
    yield format_sse({
        "type": "result", "stage": "organize", "msg": "stream timed out",
        "content": json.dumps({"error": "organize stream timed out"}),
    })
    yield DONE
