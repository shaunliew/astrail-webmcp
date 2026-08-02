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
    assert distill_memory_text(explicit) == "Travel preferences: loves ramen"
    mem = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    assert distill_memory_text(mem) is None   # nothing NEW to learn
    default = merge_preferences(explicit_text="", pace="balanced", memory_facts=[])
    assert distill_memory_text(default) is None


def test_distill_emits_only_the_users_own_words():
    # Was test_distill_never_leaks_synopsis_secrets. The synopsis it guarded is gone
    # (PRD §357), but the guarantee it protected still matters: the mem0 payload carries
    # the user's stated preference and NOTHING else a caller could smuggle in.
    from pipeline.preferences import distill_memory_text, merge_preferences
    ctx = merge_preferences(explicit_text="ramen, quiet days", pace="relaxed", memory_facts=[])
    assert distill_memory_text(ctx) == "Travel preferences: ramen, quiet days"


def test_distill_memory_text_excludes_trip_history():
    # PRD §357: distilled preference facts only — never trip history.
    from pipeline.preferences import distill_memory_text, merge_preferences
    ctx = merge_preferences(explicit_text="nice food", pace="balanced", memory_facts=[])
    assert distill_memory_text(ctx) == "Travel preferences: nice food"


def test_trip_synopsis_is_gone():
    # Deleted, not merely bypassed — an accepted-but-ignored parameter is a trap.
    import pipeline.preferences as p
    assert not hasattr(p, "trip_synopsis")


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

    seen = {}

    async def _timing_out_wait_for(coro, timeout):
        coro.close()  # avoid "coroutine was never awaited"
        seen["timeout"] = timeout   # RECORD here, assert OUTSIDE (see below)
        raise TimeoutError

    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _timing_out_wait_for)
    mem = _FakeMem0(results=[{"memory": "should not be used"}])
    ctx = asyncio.run(prefs_mod.build_preference_context(
        mem, "user-1", explicit_text="", pace="balanced", destination_hint="Tokyo"))
    assert ctx.source == "inferred_default"
    # Asserted OUT here, not inside the fake: build_preference_context wraps the search in
    # a blanket `except`, so an AssertionError raised inside the fake is SWALLOWED and the
    # function still returns inferred_default — the pin could never fail. Verified by
    # Codex, which reproduced it with timeout == 999 still passing.
    assert seen["timeout"] == 4


_MEM0_PAGE = 1               # keep in sync with preferences._MEM0_PAGE
_MEM0_PAGE_SIZE = 100        # keep in sync with preferences._MEM0_PAGE_SIZE


class _FakeMem0GetAll:
    def __init__(self, rows=None, raises=False):
        self.rows, self.raises, self.calls = rows, raises, []

    async def get_all(self, **kwargs):
        self.calls.append(kwargs)          # recorded so tests can assert the real contract
        if self.raises:
            raise RuntimeError("mem0 down")
        return {"results": self.rows}


def test_list_memory_facts_returns_ok_and_maps_rows():
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=[
        {"id": "m1", "memory": "User prefers ramen", "created_at": "2026-07-07T03:08:44"},
        {"id": "m2", "memory": "  ", "created_at": "x"},        # blank -> dropped
        {"id": "m3", "memory": None, "created_at": "y"},        # non-str -> dropped
    ])
    status, facts = asyncio.run(list_memory_facts(mem, "u1"))
    assert status == "ok"
    assert facts == [{"id": "m1", "memory": "User prefers ramen",
                      "created_at": "2026-07-07T03:08:44"}]


def test_list_memory_facts_sends_v2_filter_and_both_pagination_keys():
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=[])
    asyncio.run(list_memory_facts(mem, "u1"))
    assert mem.calls[0]["version"] == "v2"
    assert mem.calls[0]["filters"] == {"AND": [{"user_id": "u1"}]}
    # BOTH keys required: mem0ai 2.0.10 client/main.py get_all only emits pagination query
    # params under `if "page" in params and "page_size" in params`. page_size alone is
    # SILENTLY IGNORED and the read comes back unbounded — and this fake would accept it,
    # so only asserting BOTH keys catches the real SDK's rule.
    assert mem.calls[0]["page"] == _MEM0_PAGE
    assert mem.calls[0]["page_size"] == _MEM0_PAGE_SIZE


def test_list_memory_facts_disabled_when_client_is_none():
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(None, "u1")) == ("disabled", [])


def test_list_memory_facts_unavailable_on_error():
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(_FakeMem0GetAll(raises=True), "u1")) == ("unavailable", [])


def test_list_memory_facts_unavailable_on_timeout(monkeypatch):
    from pipeline import preferences as prefs_mod
    seen = {}

    async def _timing_out_wait_for(coro, timeout):
        coro.close()
        seen["timeout"] = timeout      # RECORD, do not assert in here
        raise TimeoutError

    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _timing_out_wait_for)
    assert asyncio.run(prefs_mod.list_memory_facts(_FakeMem0GetAll(rows=[]), "u1")) \
        == ("unavailable", [])
    # Asserted OUT here, not inside the fake: an AssertionError raised inside the fake
    # lands in list_memory_facts's blanket `except Exception` and is swallowed, so the
    # function returns ("unavailable", []) anyway and the timeout pin can never fail.
    # (The same latent flaw exists at test_preferences.py:120-123 — do not copy it.)
    assert seen["timeout"] == 4


def test_list_memory_facts_empty_is_ok_not_an_error():
    # A legitimately empty memory is NOT a failure — the UI must distinguish "you have no
    # saved preferences" from "memory is broken".
    from pipeline.preferences import list_memory_facts
    assert asyncio.run(list_memory_facts(_FakeMem0GetAll(rows=[]), "u1")) == ("ok", [])


@pytest.mark.parametrize("payload", [None, {"results": None}, {"results": "nope"},
                                     {}, "not a dict", 42])
def test_list_memory_facts_unrecognised_envelope_is_unavailable_not_ok(payload):
    # An unreadable ENVELOPE means "memory is broken", NOT "you have no saved
    # preferences". The earlier version of this test asserted `status in ("ok",
    # "unavailable")` and so could not tell those apart — it passed while every malformed
    # fixture wrongly returned ("ok", []). Assert the EXACT status (BUILD-LOOP case 7).
    from pipeline.preferences import list_memory_facts

    class _Odd:
        async def get_all(self, **kw): return payload

    assert asyncio.run(list_memory_facts(_Odd(), "u1")) == ("unavailable", [])


@pytest.mark.parametrize("payload", [{"results": []}, {"results": ["a string", None, 42]}])
def test_list_memory_facts_valid_envelope_with_bad_rows_is_ok(payload):
    # The other side of the fork: the envelope WAS readable, so junk rows are dropped and
    # the status stays `ok`. A row-level problem is not a memory outage.
    from pipeline.preferences import list_memory_facts

    class _Odd:
        async def get_all(self, **kw): return payload

    assert asyncio.run(list_memory_facts(_Odd(), "u1")) == ("ok", [])


def test_list_memory_facts_accepts_a_bare_list_envelope():
    # Defensive: some mem0 versions return a bare list rather than {"results": [...]}.
    # Tightening the envelope check must not break that shape.
    from pipeline.preferences import list_memory_facts
    rows = [{"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07"}]

    class _Bare:
        async def get_all(self, **kw): return rows

    status, facts = asyncio.run(list_memory_facts(_Bare(), "u1"))
    assert status == "ok"
    assert facts == [{"id": "m1", "memory": "likes ramen", "created_at": "2026-07-07"}]


def test_list_memory_facts_keeps_valid_rows_beside_garbage_entries():
    # The `isinstance(m, dict)` row guard must be LOAD-BEARING, and the test above cannot
    # prove that: it accepts ("ok", []) OR ("unavailable", []), and the blanket `except`
    # produces the latter on its own — so deleting the row guard leaves it green.
    # Surviving a good row beside a bad one is an outcome the `except` path CANNOT fake,
    # because it returns []. Drop the junk, keep the real memory.
    from pipeline.preferences import list_memory_facts
    mem = _FakeMem0GetAll(rows=["a string", None, 42,
                                {"id": "m1", "memory": "User prefers ramen",
                                 "created_at": "2026-07-07T03:08:44"}])
    status, facts = asyncio.run(list_memory_facts(mem, "u1"))
    assert status == "ok"
    assert facts == [{"id": "m1", "memory": "User prefers ramen",
                      "created_at": "2026-07-07T03:08:44"}]


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
        client, mem, user_id="u1", trip_id="t1", ctx=ctx))
    assert learned == ["loves ramen"]
    assert client.events and client.events[0]["event_type"] == "learned"
    assert client.events[0]["trip_id"] == "t1"
    assert mem.added and mem.added[0][1] == "u1"


def test_write_back_swallows_add_error():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="quiet trip", pace="relaxed", memory_facts=[])
    mem, client = _FakeMem0Add(add_raises=True), _FakeClient()
    # must NOT raise — write-back is best-effort
    asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1", ctx=ctx))
    assert client.events and client.events[-1]["event_type"] == "failed"


def test_write_back_noop_when_nothing_learned():
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="", pace="balanced", memory_facts=["likes ramen"])
    mem, client = _FakeMem0Add(), _FakeClient()
    learned = asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                              ctx=ctx))
    assert learned == [] and mem.added == []   # memory-only trip: nothing new to store


def test_write_back_disabled_memory_writes_no_event():
    # Finding 3: mem0=None (MEM0_API_KEY unset in prod) must NOT write a memory_events
    # row claiming a fact was "learned" — nothing was ever sent to mem0. The
    # preferences are already recorded in trips.preference_summary (Task 3).
    from pipeline.preferences import merge_preferences, persist_trip_memory
    ctx = merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])
    client = _FakeClient()
    learned = asyncio.run(persist_trip_memory(client, None, user_id="u1", trip_id="t1",
                                              ctx=ctx))
    assert learned == ["loves ramen"]
    assert client.events == []   # no audit row when memory is disabled


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
        # v3 add() is asynchronous (returns PENDING, processes in the background — mem0's
        # own docs say to wait 2-3s before searching), so poll instead of asserting on the
        # first search: every poll checks SHAPE immediately (catches real v3 drift
        # regardless of timing), then only after the loop do we require non-empty results
        # (now that propagation has had time), keeping "shape drift" separate from "lag".
        results = []
        for _ in range(8):
            res = await mem0.search("travel preferences for a trip",
                                    filters={"user_id": user_id}, top_k=10)
            assert isinstance(res, dict), \
                f"mem0 v3 shape drift: search returned {type(res).__name__}, not dict"
            results = res.get("results")
            assert isinstance(results, list), "mem0 v3 shape drift: 'results' is not a list"
            if results:
                break
            await asyncio.sleep(1)  # v3 add() is async (PENDING) — allow background processing
        assert results, "expected the just-added fact to come back within ~8s (v3 async propagation)"
        for m in results:
            assert isinstance(m, dict) and isinstance(m.get("memory"), str), \
                "mem0 v3 shape drift: result entry missing a string 'memory'"
    finally:
        try:
            await mem0.delete_all(user_id=user_id)   # best-effort cleanup of the throwaway user
        except Exception:
            pass
