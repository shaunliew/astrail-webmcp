"""SSE streaming tests.

Covers the format/DONE shape, the seen-set stream emitting new events then
DONE on a `result` row (equal-`created_at` rows must never be skipped — a
`created_at` cursor would drop them), and the timeout path always emitting a
terminal error `result` before DONE (never a bare DONE — CLAUDE.md's most
breaking contract). The fake Supabase client's `execute()` is awaitable,
matching the real async supabase-py client.
"""
import pytest

from api import streaming


def test_format_sse_and_done():
    assert streaming.format_sse({"type": "stage"}) == 'data: {"type": "stage"}\n\n'
    assert streaming.DONE == "data: [DONE]\n\n"


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    """Async fake of a supabase-py postgrest filter/order builder over a fixed row list."""

    def __init__(self, rows):
        self.rows = rows

    def select(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    async def execute(self):
        return _Result(list(self.rows))


class _Client:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return _Query(self.rows)


@pytest.mark.asyncio
async def test_stream_emits_new_events_then_done_on_result():
    rows = [
        {"id": "e1", "created_at": "t", "event_type": "stage", "stage": "scrape",
         "message": "s", "payload": {}},
        {"id": "e2", "created_at": "t", "event_type": "result", "stage": "save",
         "message": "done", "payload": {"itinerary": {"days": []}}},  # same created_at as e1
    ]
    out = [c async for c in streaming.stream_trip_events(_Client(rows), "trip-1", poll_s=0, max_polls=3)]
    assert streaming.DONE == out[-1]
    assert '"type": "result"' in out[-2] and '"itinerary"' in out[-2]
    # both rows were emitted despite the shared created_at (seen-set, not a cursor)
    assert sum('"stage": "scrape"' in c for c in out) == 1


@pytest.mark.asyncio
async def test_stream_timeout_emits_error_result_before_done():
    # No result row ever arrives -> timeout path must still send a result, then DONE.
    rows = [{"id": "e1", "created_at": "t", "event_type": "stage", "stage": "scrape",
             "message": "s", "payload": {}}]
    out = [c async for c in streaming.stream_trip_events(_Client(rows), "trip-1", poll_s=0, max_polls=1)]
    assert streaming.DONE == out[-1]
    assert '"type": "result"' in out[-2] and '"error"' in out[-2]  # never a bare DONE
