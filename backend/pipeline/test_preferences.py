"""Pure, offline tests for preference merge/render/distill (no mem0, no network)."""
import asyncio
import uuid

import pytest

from pipeline.preferences import (distill_memory_text, merge_preferences,
                                  preference_block)


def test_explicit_input_wins():
    ctx = merge_preferences(explicit_text="ramen, walkable days", pace="relaxed",
                            memory_facts=["prefers luxury"])
    assert ctx.source == "explicit"
    # explicit wins wholesale: memory is NOT injected when the user stated preferences
    block = preference_block(ctx)
    assert "ramen, walkable days" in block
    assert "luxury" not in block
    assert "your preferences" in ctx.summary.lower()


def test_blank_input_uses_memory():
    ctx = merge_preferences(explicit_text="", pace="balanced",
                            memory_facts=["likes ramen", "avoids theme parks"])
    assert ctx.source == "memory"
    block = preference_block(ctx)
    assert "likes ramen" in block and "avoids theme parks" in block
    assert "saved travel preferences" in ctx.summary.lower()


def test_blank_input_no_memory_infers_default():
    ctx = merge_preferences(explicit_text="  ", pace="balanced", memory_facts=[])
    assert ctx.source == "inferred_default"
    assert preference_block(ctx) is None   # nothing to inject
    assert "infer" in ctx.summary.lower()


def test_distill_only_writes_on_explicit():
    explicit = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    assert distill_memory_text(explicit, synopsis="Planned a 3-day Tokyo trip.") \
        == "Travel preferences: loves ramen. Planned a 3-day Tokyo trip."
    mem = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    assert distill_memory_text(mem, synopsis="x") is None   # nothing NEW to learn
    default = merge_preferences(explicit_text="", pace="balanced", memory_facts=[])
    assert distill_memory_text(default, synopsis="x") is None


def test_distill_never_leaks_synopsis_secrets():
    # synopsis is a templated string built by the caller; distill only concatenates —
    # this pins that raw reel text is never introduced here.
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    out = distill_memory_text(ctx, synopsis="Planned a 2-day Kyoto trip (relaxed pace).")
    assert "reel" not in out.lower() and "caption" not in out.lower()


class _FakeMem0:
    def __init__(self, results=None, raises=False):
        self._results = results or []
        self._raises = raises
        self.searched = []

    async def search(self, query, *, filters=None, top_k=10):
        self.searched.append((query, filters, top_k))
        if self._raises:
            raise RuntimeError("mem0 down")
        return {"results": self._results}


def test_build_context_reads_memory_when_blank():
    from pipeline.preferences import build_preference_context
    mem = _FakeMem0(results=[{"memory": "likes ramen"}, {"memory": "avoids theme parks"}])
    ctx = asyncio.run(build_preference_context(mem, "user-1", explicit_text="",
                                               pace="balanced", destination_hint="Tokyo"))
    assert ctx.source == "memory"
    assert ctx.memory_facts == ["likes ramen", "avoids theme parks"]
    assert mem.searched and mem.searched[0][1] == {"user_id": "user-1"}
    # Query stays GENERIC regardless of destination_hint (Non-goals "Destination-scoped
    # recall") — mem0 memories are global taste, not per-destination.
    assert mem.searched[0][0] == "travel preferences for a trip"


def test_build_context_skips_search_when_explicit():
    from pipeline.preferences import build_preference_context
    mem = _FakeMem0(results=[{"memory": "should not be read"}])
    ctx = asyncio.run(build_preference_context(mem, "user-1", explicit_text="ramen",
                                               pace="relaxed", destination_hint="Tokyo"))
    assert ctx.source == "explicit"
    assert mem.searched == []   # explicit wins → no wasted search / quota


def test_build_context_mem0_none_or_error_infers_default():
    from pipeline.preferences import build_preference_context
    a = asyncio.run(build_preference_context(None, "user-1", explicit_text="",
                                             pace="balanced", destination_hint=None))
    assert a.source == "inferred_default"
    b = asyncio.run(build_preference_context(_FakeMem0(raises=True), "user-1",
                                             explicit_text="", pace="balanced",
                                             destination_hint="Tokyo"))
    assert b.source == "inferred_default"   # a mem0 blip degrades, never raises


def test_build_context_drops_non_string_memory_values():
    # M1 (guardrail #3): a shape-drifted mem0 result (memory as a dict instead of a
    # string) must NOT propagate an AttributeError out of build_preference_context —
    # the bad entry is dropped, valid string entries are kept.
    from pipeline.preferences import build_preference_context
    mem = _FakeMem0(results=[{"memory": {"nested": "x"}}, {"memory": "likes ramen"}])
    ctx = asyncio.run(build_preference_context(mem, "user-1", explicit_text="",
                                               pace="balanced", destination_hint="Tokyo"))
    assert ctx.source == "memory"
    assert ctx.memory_facts == ["likes ramen"]


def test_build_context_timeout_degrades_to_default(monkeypatch):
    # A2: the search MUST be wrapped in asyncio.wait_for(..., timeout=4) — the read runs
    # BEFORE scrape, so an unbounded hang would stall EVERY generation. Pin the exact
    # timeout value without a real 4s sleep by faking asyncio.wait_for itself.
    from pipeline import preferences as prefs_mod

    async def _timing_out_wait_for(coro, timeout):
        coro.close()  # avoid "coroutine was never awaited"
        assert timeout == 4
        raise TimeoutError

    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _timing_out_wait_for)
    mem = _FakeMem0(results=[{"memory": "should not be used"}])
    ctx = asyncio.run(prefs_mod.build_preference_context(
        mem, "user-1", explicit_text="", pace="balanced", destination_hint="Tokyo"))
    assert ctx.source == "inferred_default"


class _FakeMem0Add(_FakeMem0):
    def __init__(self, add_raises=False):
        super().__init__()
        self.added = []
        self._add_raises = add_raises

    async def add(self, messages, *, user_id=None, metadata=None):
        if self._add_raises:
            raise RuntimeError("mem0 add failed")
        self.added.append((messages, user_id, metadata))
        return {"status": "PENDING", "event_id": "evt-1"}


class _FakeTable:
    def __init__(self, sink): self.sink = sink; self._row = None
    def insert(self, row): self._row = row; return self
    async def execute(self):
        self.sink.append(self._row); return type("R", (), {"data": [self._row]})()


class _FakeClient:
    def __init__(self): self.events = []
    def table(self, name):
        assert name == "memory_events"
        return _FakeTable(self.events)


def test_write_back_writes_event_and_adds_on_explicit():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    mem, client = _FakeMem0Add(), _FakeClient()
    learned = asyncio.run(persist_trip_memory(
        client, mem, user_id="u1", trip_id="t1", ctx=ctx,
        synopsis="Planned a 3-day Tokyo trip (relaxed pace)."))
    assert learned == ["loves ramen"]
    assert client.events and client.events[0]["event_type"] == "learned"
    assert client.events[0]["trip_id"] == "t1"
    assert mem.added and mem.added[0][1] == "u1"


def test_write_back_swallows_add_error():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    mem, client = _FakeMem0Add(add_raises=True), _FakeClient()
    # must NOT raise — write-back is best-effort
    asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                    ctx=ctx, synopsis="x"))
    assert client.events and client.events[-1]["event_type"] == "failed"


def test_write_back_noop_when_nothing_learned():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    mem, client = _FakeMem0Add(), _FakeClient()
    learned = asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                              ctx=ctx, synopsis="x"))
    assert learned == [] and mem.added == []   # memory-only trip: nothing new to store


def test_write_back_disabled_memory_writes_no_event():
    # Finding 3: mem0=None (MEM0_API_KEY unset in prod) must NOT write a memory_events
    # row claiming a fact was "learned" — nothing was ever sent to mem0. The
    # preferences are already recorded in trips.preference_summary (Task 3).
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    client = _FakeClient()
    learned = asyncio.run(persist_trip_memory(client, None, user_id="u1", trip_id="t1",
                                              ctx=ctx, synopsis="x"))
    assert learned == ["loves ramen"]
    assert client.events == []   # no audit row when memory is disabled


def test_trip_synopsis_uses_real_itinerary_shape_and_destination():
    # Finding 2: ItineraryDay has no `.places`/`.city` — trip_synopsis must derive the
    # day count from the real ItineraryOutput shape and take destination from the caller.
    from models.trip import ItineraryDay, ItineraryOutput
    from pipeline.preferences import trip_synopsis
    itinerary = ItineraryOutput(
        title="Tokyo trip", source="reels", source_places=["Tokyo Tower"],
        days=[
            ItineraryDay(day_number=1, date="2026-08-01", place_names=["Tokyo Tower"]),
            ItineraryDay(day_number=2, date="2026-08-02", place_names=["Senso-ji"]),
        ])
    result = trip_synopsis(itinerary, "relaxed", "Tokyo")
    assert result == "Planned a 2-day Tokyo trip (relaxed pace)."
    assert "the destination" not in result


@pytest.mark.live
async def test_live_mem0_v3_contract_add_then_search():
    """A7 (Codex C8): every other test here fakes mem0's response as {"results": [...]}.
    This is the ONE real round-trip against the hosted mem0 Platform API, so a v3 response
    shape drift is caught here instead of silently degrading recall to `inferred_default`
    in production (build_preference_context swallows ANY shape mismatch as a best-effort
    miss — guardrail #3 — so a break here would otherwise be invisible).

    Skipped by default (needs --run-live + a real MEM0_API_KEY); never runs in the
    keyless offline suite.
    """
    from mem0 import AsyncMemoryClient

    user_id = f"astrail-contract-test-{uuid.uuid4()}"
    mem0 = AsyncMemoryClient()
    try:
        await mem0.add(
            [{"role": "user", "content": "Travel preferences: loves ramen and quiet, walkable days."}],
            user_id=user_id, metadata={"source": "contract_test"},
        )
        res = await mem0.search("travel preferences for a trip", filters={"user_id": user_id}, top_k=10)
        assert isinstance(res, dict)
        results = res.get("results")
        assert isinstance(results, list)
        assert results, "expected the just-added fact to come back on search"
        assert all(isinstance(m, dict) and isinstance(m.get("memory"), str) for m in results)
    finally:
        try:
            await mem0.delete_all(user_id=user_id)   # best-effort cleanup of the throwaway user
        except Exception:
            pass
