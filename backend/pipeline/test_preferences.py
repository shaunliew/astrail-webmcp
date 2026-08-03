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


# --- multi-table Supabase fake (C9) -----------------------------------------------
# Rebuilt from the old insert-only `memory_events` fake: persist_trip_memory's write-back
# guard also reads `trips`, and a single-table fake would make the guard blow up inside its
# own fail-safe — the write-back would look guarded while nothing was proven.
#
# Instants are Postgres-sourced and written as LITERALS rather than derived from one
# another: a derived offset follows the comparison anywhere, so a guard keyed on the wrong
# reference would keep every test green. No wall clock is read (determinism).
_TRIP_START = "2026-08-03T12:00:00+00:00"     # trips.created_at — this generation's start
_BEFORE_START = "2026-08-03T11:59:00+00:00"   # a clear from an EARLIER session
_AFTER_START = "2026-08-03T12:01:00+00:00"    # a clear DURING this generation
_LATER = "2026-08-03T12:05:00+00:00"          # later still (recovery re-run fixture)

_DEFAULT_TRIP = {"id": "t1", "user_id": "u1", "created_at": _TRIP_START}


class _Result:
    def __init__(self, data): self.data = data


class _FakeTable:
    """PostgREST-shaped builder over one table of a shared in-memory db.

    Filters GENUINELY (BUILD-LOOP trap #4: a `return self` builder makes every window and
    ownership case vacuous), and unsupported shapes raise rather than filtering on nothing
    — the rule test_memory_clear.py and test_saved_reels_organize.py already follow.
    """

    def __init__(self, client, name: str) -> None:
        self._client, self._name = client, name
        self._op = None
        self._payload = None
        self._eq: dict = {}
        self._gt: dict = {}
        self._single = False

    def insert(self, row): self._op, self._payload = "insert", dict(row); return self

    def select(self, *_cols): self._op = "select"; return self

    def eq(self, column, value):
        if value is None:
            raise ValueError(".eq(col, None) is never valid against postgrest; use .is_(col, 'null')")
        self._eq[column] = value
        return self

    def gt(self, column, value):
        if value is None:
            raise ValueError(".gt(col, None) is never valid against postgrest; use .is_(col, 'null')")
        self._gt[column] = value
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row) -> bool:
        if any(row.get(col) != value for col, value in self._eq.items()):
            return False
        for col, value in self._gt.items():
            current = row.get(col)
            # Postgres: `NULL > x` is NULL, so a row missing the column does NOT match.
            if current is None or not current > value:
                return False
        return True

    async def execute(self):
        client = self._client
        client.ops.append(f"{self._op}:{self._name}")
        rows = client.db[self._name]
        if self._op == "insert":
            row = dict(self._payload)
            client.seq += 1
            # The DB supplies both as defaults and the guard reads created_at.
            row.setdefault("id", f"{self._name}-{client.seq}")
            row.setdefault("created_at", _LATER)   # audit rows land after the trip started
            rows.append(row)
            return _Result([dict(row)])
        if self._op == "select":
            if self._name in client.select_raises:
                raise RuntimeError(f"select on {self._name} failed")
            matched = [dict(r) for r in rows if self._matches(r)]
            if self._single:
                if len(matched) > 1:
                    raise ValueError("maybe_single() matched multiple rows")
                # Faithful to postgrest 2.31.0: a bare None on zero rows, NOT a result whose
                # .data is None (test_main.py's fake carries the same note — a forgiving fake
                # there hid a real 500 in the stream owner check).
                return _Result(matched[0]) if matched else None
            return _Result(matched)
        raise ValueError(f"fake table used with no supported operation: {self._op!r}")


class _FakeClient:
    def __init__(self, *, trips=None, memory_events=None, select_raises=()) -> None:
        seeded_trips = [_DEFAULT_TRIP] if trips is None else trips
        self.db = {
            "trips": [dict(r) for r in seeded_trips],
            "memory_events": [dict(r) for r in (memory_events or [])],
        }
        self.select_raises = frozenset(select_raises)
        self.seq = 0
        self.ops: list[str] = []   # so ORDER and short-circuiting are assertable

    def table(self, name):
        if name not in self.db:
            raise ValueError(f"fake serves only {sorted(self.db)}, got {name!r}")
        return _FakeTable(self, name)

    @property
    def events(self):
        return self.db["memory_events"]


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


# ---------------------------------------------------------------------------------
# Write-back concurrency guard (C8): a clear that lands DURING a 60-180s generation must
# not be undone by the post-`result` write-back. The UI would say cleared while the memory
# quietly came back.
# ---------------------------------------------------------------------------------

def _explicit_ctx():
    from pipeline.preferences import merge_preferences
    return merge_preferences(explicit_text="loves ramen", pace="relaxed", memory_facts=[])


def _cleared_row(**overrides):
    row = {"id": "evt-clear", "user_id": "u1", "trip_id": None,
           "event_type": "cleared", "created_at": _AFTER_START}
    row.update(overrides)
    return row


def _run_write_back(client, mem):
    from pipeline.preferences import persist_trip_memory
    return asyncio.run(persist_trip_memory(client, mem, user_id="u1", trip_id="t1",
                                           ctx=_explicit_ctx()))


def test_write_back_proceeds_when_memory_was_never_cleared():
    # Positive control for the guard: it must not suppress the ordinary path. Reddens if
    # the guard is hard-wired to True (over-suppression is a real failure mode — every
    # fail-safe branch returns True).
    client, mem = _FakeClient(), _FakeMem0Add()
    learned = _run_write_back(client, mem)
    assert learned == ["loves ramen"]
    assert mem.added and mem.added[0][1] == "u1"
    assert [r["event_type"] for r in client.events] == ["learned"]


def test_write_back_skipped_when_cleared_during_this_generation():
    # THE case this guard exists for. The clear landed after trips.created_at, so re-adding
    # would silently un-clear memory the endpoint already reported as cleared.
    client = _FakeClient(memory_events=[_cleared_row()])
    mem = _FakeMem0Add()
    learned = _run_write_back(client, mem)
    assert learned == ["loves ramen"]     # the caller's contract is unchanged
    assert mem.added == []                # nothing re-added to mem0
    # No audit row either: nothing was learned and nothing failed, so only the seeded
    # marker remains.
    assert [r["event_type"] for r in client.events] == ["cleared"]


def test_write_back_proceeds_when_the_clear_predates_this_generation():
    # Makes `.gt(created_at, started_at)` load-bearing: an OLD clear is already reflected in
    # mem0, so suppressing here would lose every later preference the user states.
    client = _FakeClient(memory_events=[_cleared_row(created_at=_BEFORE_START)])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added and mem.added[0][1] == "u1"
    assert [r["event_type"] for r in client.events] == ["cleared", "learned"]


def test_write_back_ignores_another_users_clear():
    # Makes the memory_events `.eq("user_id", …)` filter load-bearing: without it one user
    # clearing memory would stop every OTHER user's generation from learning.
    client = _FakeClient(memory_events=[_cleared_row(user_id="u2")])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added and mem.added[0][1] == "u1"
    assert [r["event_type"] for r in client.events] == ["cleared", "learned"]


def test_write_back_ignores_a_non_clear_event_newer_than_the_trip():
    # Makes `.eq("event_type", "cleared")` load-bearing: memory_events also carries this
    # user's 'learned'/'failed' rows, and a filter-less lookup would read any of them as a
    # clear and suppress learning forever.
    client = _FakeClient(memory_events=[
        {"id": "evt-learn", "user_id": "u1", "trip_id": "t0", "event_type": "learned",
         "created_at": _AFTER_START}])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added and mem.added[0][1] == "u1"
    assert [r["event_type"] for r in client.events] == ["learned", "learned"]


def test_write_back_skipped_when_the_trip_lookup_fails():
    # Fail-safe direction (D7): with no reference we cannot tell a clear from no clear.
    # Losing one learned memory is benign; resurrecting cleared data is the bug.
    client = _FakeClient(memory_events=[_cleared_row()], select_raises={"trips"})
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert [r["event_type"] for r in client.events] == ["cleared"]


def test_write_back_skipped_when_the_trip_row_is_absent():
    # maybe_single() returns a BARE None on zero rows (postgrest 2.31.0), not a result whose
    # .data is None. `client.ops` proves the SHORT-CIRCUIT.
    #
    # PROVE THIS BRANCH BY INVERTING IT (`return True` -> `return False`), NOT BY DELETING IT.
    # Deleting the branch leaves this test GREEN, which reads like "dead code" and is a trap:
    # `_FakeTable.gt()` raises ValueError during query CONSTRUCTION, before `.execute()`, so
    # `ops.append()` never fires and `ops` still reads ["select:trips"]; the ValueError is then
    # swallowed by the cleared-lookup `except`, which returns True — the right answer for the
    # wrong reason. Inversion reddens this test and the owner-check test above; deletion reddens
    # neither. (Measured 2026-08-03 during the Task-3 review.)
    client = _FakeClient(trips=[], memory_events=[_cleared_row()])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert client.ops == ["select:trips"]
    assert [r["event_type"] for r in client.events] == ["cleared"]


def test_write_back_skipped_when_the_cleared_lookup_fails():
    # Same fail-safe as the trip lookup, different query. Its own `except` — proving one
    # says nothing about the other.
    client = _FakeClient(select_raises={"memory_events"})
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert client.ops == ["select:trips", "select:memory_events"]
    assert client.events == []


def test_write_back_ignores_a_trip_owned_by_another_user():
    # Guardrail #6 on the reference read itself: the trips row must match BOTH id and
    # user_id. Without the user_id filter this reads a stranger's trip start and compares
    # this user's clears against it.
    client = _FakeClient(trips=[{"id": "t1", "user_id": "u2", "created_at": _TRIP_START}])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert client.ops == ["select:trips"]


def test_write_back_recovery_rerun_compares_against_the_original_trip_start():
    # Guardrail #12: a crashed generation re-executes from Phase 1, but the trips row is
    # INSERTed once in POST /generate-trip and only ever `.update()`d, so created_at still
    # marks the ORIGINAL start. Here the clear is OLDER than the crashed attempt's own audit
    # row: a guard keyed on "this attempt started now" — or on the newest memory_events row —
    # would find no clear "since" and resurrect the memory.
    client = _FakeClient(memory_events=[
        _cleared_row(created_at=_AFTER_START),
        {"id": "evt-crash", "user_id": "u1", "trip_id": "t1", "event_type": "failed",
         "created_at": _LATER},
    ])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert [r["event_type"] for r in client.events] == ["cleared", "failed"]


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
