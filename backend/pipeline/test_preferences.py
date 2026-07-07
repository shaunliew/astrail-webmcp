"""Pure, offline tests for preference merge/render/distill (no mem0, no network)."""
import asyncio

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
