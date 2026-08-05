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
# 20s before _LATER, and that offset is the entire point (C12): it sits OUTSIDE the 15s
# window `_add_possibly_in_flight` used to look back over and INSIDE the 30s one it looks
# back over now. An intent stamped here is exactly the row Codex watched age out of a
# concurrent clear's view while the add it announced was still pending.
_AGED_INTENT = "2026-08-03T12:04:40+00:00"

_DEFAULT_TRIP = {"id": "t1", "user_id": "u1", "created_at": _TRIP_START}


class _Result:
    def __init__(self, data): self.data = data


class _FakeTable:
    """PostgREST-shaped builder over one table of a shared in-memory db.

    Filters GENUINELY (BUILD-LOOP trap #4: a `return self` builder makes every window and
    ownership case vacuous), and unsupported shapes raise rather than filtering on nothing
    — the rule test_memory_clear.py and test_saved_reels_organize.py already follow.

    `not_`/`is_`/`in_` are modelled exactly (C11 test 8 runs the REAL clear_memory against
    this same fake, and its in-flight lookup is
    `.in_("event_type", …).not_.is_("trip_id", "null")`): a `not_` that returned self while
    `is_` ignored the flag would silently INVERT that query — it would then match only the
    clear's own markers and never a generation's, while every test still passed.
    """

    def __init__(self, client, name: str) -> None:
        self._client, self._name = client, name
        self._op = None
        self._payload = None
        self._eq: dict = {}
        self._in: dict = {}
        self._gt: dict = {}
        self._is_null: set = set()
        self._not_is_null: set = set()
        self._negate_next = False
        self._single = False

    def insert(self, row): self._op, self._payload = "insert", dict(row); return self

    def update(self, patch): self._op, self._payload = "update", dict(patch); return self

    def delete(self): self._op = "delete"; return self

    def select(self, *_cols): self._op = "select"; return self

    @property
    def not_(self):
        # postgrest's `not_` is a PROPERTY that sets negate_next and returns self; the very
        # next filter() consumes and resets it (base_request_builder.py). Modelled exactly.
        self._negate_next = True
        return self

    def _take_negation(self) -> bool:
        negated, self._negate_next = self._negate_next, False
        return negated

    def eq(self, column, value):
        if self._take_negation():
            raise ValueError("fake does not implement `not_.eq`")
        if value is None:
            raise ValueError(".eq(col, None) is never valid against postgrest; use .is_(col, 'null')")
        self._eq[column] = value
        return self

    def gt(self, column, value):
        if self._take_negation():
            raise ValueError("fake does not implement `not_.gt`")
        if value is None:
            raise ValueError(".gt(col, None) is never valid against postgrest; use .is_(col, 'null')")
        self._gt[column] = value
        return self

    def in_(self, column, values):
        if self._take_negation():
            raise ValueError("fake does not implement `not_.in_`")
        self._in[column] = tuple(values)
        return self

    def is_(self, column, value):
        negated = self._take_negation()
        if value not in (None, "null"):
            raise ValueError(f"fake implements only `is.null`, got .is_({column!r}, {value!r})")
        (self._not_is_null if negated else self._is_null).add(column)
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row) -> bool:
        if self._negate_next:
            raise ValueError("`not_` was armed but no filter consumed it")
        if any(row.get(col) != value for col, value in self._eq.items()):
            return False
        if any(row.get(col) not in values for col, values in self._in.items()):
            return False
        for col, value in self._gt.items():
            current = row.get(col)
            # Postgres: `NULL > x` is NULL, so a row missing the column does NOT match.
            if current is None or not current > value:
                return False
        if any(row.get(col) is not None for col in self._is_null):
            return False
        if any(row.get(col) is None for col in self._not_is_null):
            return False
        return True

    def _is_the_guards_cleared_lookup(self) -> bool:
        """The write-back guard's second read — the query C11's race is against."""
        return self._name == "memory_events" and self._eq.get("event_type") == "cleared"

    async def execute(self):
        client = self._client
        client.ops.append(f"{self._op}:{self._name}")
        rows = client.db[self._name]
        if self._op == "insert":
            if self._name in client.insert_raises:
                raise RuntimeError(f"insert into {self._name} failed")
            if self._name in client.insert_returns_no_row:
                return _Result([])          # postgrest can answer with data == []
            row = dict(self._payload)
            client.seq += 1
            # The DB supplies both as defaults and the guard reads created_at.
            row.setdefault("id", f"{self._name}-{client.seq}")
            if "created_at" not in row:
                row["created_at"] = client.next_created_at()
            rows.append(row)
            return _Result([dict(row)])
        if self._op == "update":
            if self._name in client.update_raises:
                raise RuntimeError(f"update on {self._name} failed")
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(self._payload)
            return _Result([dict(r) for r in matched])
        if self._op == "delete":
            if self._name in client.delete_raises:
                raise RuntimeError(f"delete on {self._name} failed")
            # Deliberately NOT refusing an unfiltered delete: dropping `.eq("id", …)` must
            # REDIRECT (wipe the table) so the id-scoping test reddens, not crash — a crash
            # is not the absence of the filter.
            removed = [dict(r) for r in rows if self._matches(r)]
            client.db[self._name] = [r for r in rows if not self._matches(r)]
            return _Result(removed)
        if self._op == "select":
            if self._name in client.select_raises:
                raise RuntimeError(f"select on {self._name} failed")
            matched = [dict(r) for r in rows if self._matches(r)]
            # C11 test 8's interleaving point, and the ONE that matters: the guard's
            # snapshot is taken but persist_trip_memory has not resumed, so anything landing
            # here is invisible to it. One-shot — the clear's OWN memory_events reads must
            # not re-enter the hook (that would deadlock).
            if self._is_the_guards_cleared_lookup() and client.after_guard_read is not None:
                hook, client.after_guard_read = client.after_guard_read, None
                await hook()
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
    def __init__(self, *, trips=None, memory_events=None, users=None, select_raises=(),
                 insert_raises=(), insert_returns_no_row=(), update_raises=(),
                 delete_raises=(), insert_created_at=()) -> None:
        seeded_trips = [_DEFAULT_TRIP] if trips is None else trips
        # persist_trip_memory now reads users.account_status (the §3.6 generation freeze) BEFORE
        # the intent write. Default the acting user to 'active' so the freeze is inert and every
        # pre-existing write-back assertion still exercises the real add path; the freeze tests
        # pass a pending/deleting row (or omit the row) explicitly.
        seeded_users = [{"id": "u1", "account_status": "active"}] if users is None else users
        self.db = {
            "trips": [dict(r) for r in seeded_trips],
            "memory_events": [dict(r) for r in (memory_events or [])],
            "users": [dict(r) for r in seeded_users],
        }
        self.select_raises = frozenset(select_raises)
        self.insert_raises = frozenset(insert_raises)
        self.insert_returns_no_row = frozenset(insert_returns_no_row)
        self.update_raises = frozenset(update_raises)
        self.delete_raises = frozenset(delete_raises)
        self.seq = 0
        self.ops: list[str] = []   # so ORDER and short-circuiting are assertable
        self.after_guard_read = None   # one-shot async hook; see _FakeTable.execute
        # Postgres stamps created_at on insert. A test needing two inserts at DIFFERENT
        # instants — the aged-intent case, where the write-back's intent row predates the
        # clear's marker — scripts them here, oldest first. Unscripted inserts fall back to
        # _LATER, which is what every pre-C12 test assumed.
        self._created_at_script = list(insert_created_at)

    def next_created_at(self) -> str:
        return self._created_at_script.pop(0) if self._created_at_script else _LATER

    def table(self, name):
        if name not in self.db:
            raise ValueError(f"fake serves only {sorted(self.db)}, got {name!r}")
        return _FakeTable(self, name)

    @property
    def events(self):
        return self.db["memory_events"]


def _wait_for_recorder(seen: list, *, expire_call: int | None = None):
    """Fake `asyncio.wait_for` recording every bound IN CALL ORDER, optionally expiring the
    Nth one. Every call the write-back makes is bounded (C12), so a fake that expired them
    ALL could only ever prove the first one.

    Assert on `seen` OUTSIDE the fake, never in here: persist_trip_memory and all three of
    its helpers wrap their bounded call in a blanket `except`, so an AssertionError raised
    inside this fake is swallowed and the pin could never fail. That is the trap
    test_build_context_timeout_degrades_to_default already documents — Codex reproduced it
    there with `timeout == 999` still passing.
    """
    async def _fake(awaitable, timeout):
        seen.append(timeout)
        if len(seen) == expire_call:
            awaitable.close()          # avoid "coroutine was never awaited"
            raise TimeoutError
        return await awaitable
    return _fake


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


# ---------------------------------------------------------------------------------
# GENERATION FREEZE (plan §3.6, account-deletion Task 3). persist_trip_memory must take on NO
# new mem0 data once the account is leaving the platform — the LOAD-BEARING half of the freeze.
# The reads above (the active positive control test_write_back_proceeds_...) redden if the freeze
# is hard-wired to True; these redden if it is removed / hard-wired to False. Fail CLOSED: a
# non-active status OR an unreadable one skips the add. Checked BEFORE the intent row, so a frozen
# account writes NOTHING (ops == ["select:users"] alone, no intent, no add).
# ---------------------------------------------------------------------------------


def test_write_back_skipped_when_account_pending_deletion():
    client = _FakeClient(users=[{"id": "u1", "account_status": "pending_deletion"}])
    mem = _FakeMem0Add()
    assert _run_write_back(client, mem) == ["loves ramen"]   # caller contract unchanged
    assert mem.added == []                                    # nothing sent to mem0
    assert client.events == []                                # no intent row either
    assert client.ops == ["select:users"]                    # short-circuit at the freeze read


def test_write_back_skipped_when_account_deleting():
    # 'deleting' is the irreversible claim; a new add here would race the two-pass purge.
    client = _FakeClient(users=[{"id": "u1", "account_status": "deleting"}])
    mem = _FakeMem0Add()
    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert client.ops == ["select:users"]


def test_write_back_fails_closed_when_account_status_unreadable():
    # No users row -> maybe_single() yields a bare None -> status unreadable. Fail CLOSED (skip):
    # losing one learned memory is benign (D7); adding to a possibly-deleting account is the bug.
    client = _FakeClient(users=[])
    mem = _FakeMem0Add()
    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert client.ops == ["select:users"]


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
    # The §3.6 freeze read (users.account_status) is the pre-window first op; the intent row
    # (C11) then precedes the guard and is retracted when it fires, so the guard's short-circuit
    # is the ABSENT `select:memory_events`, not a two-op log.
    assert client.ops == ["select:users", "insert:memory_events", "select:trips", "delete:memory_events"]
    assert [r["event_type"] for r in client.events] == ["cleared"]


def test_write_back_skipped_when_the_cleared_lookup_fails():
    # Same fail-safe as the trip lookup, different query. Its own `except` — proving one
    # says nothing about the other.
    client = _FakeClient(select_raises={"memory_events"})
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert client.ops == ["select:users", "insert:memory_events", "select:trips",
                          "select:memory_events", "delete:memory_events"]
    assert client.events == []   # the intent row is retracted, not left behind


def test_write_back_ignores_a_trip_owned_by_another_user():
    # Guardrail #6 on the reference read itself: the trips row must match BOTH id and
    # user_id. Without the user_id filter this reads a stranger's trip start and compares
    # this user's clears against it.
    client = _FakeClient(trips=[{"id": "t1", "user_id": "u2", "created_at": _TRIP_START}])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert client.ops == ["select:users", "insert:memory_events", "select:trips", "delete:memory_events"]


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


# ---------------------------------------------------------------------------------
# INTENT-FIRST write-back (C11). The guard above closes the window between a clear and the
# NEXT generation; it does NOT close the window between its own read and the mem0.add that
# follows it. A clear landing there is invisible to the guard AND unblocked by it, so the
# endpoint answers `cleared` while the add lands afterwards. The fix is ordering: the intent
# row is written BEFORE the guard's snapshot, so a concurrent clear can see it.
# ---------------------------------------------------------------------------------


class _FakeMem0ClearAndAdd(_FakeMem0Add):
    """The write-back's `add` AND the clear endpoint's `delete_all`/`get_all` on one object,
    so the race test can run the real `clear_memory` against the real `persist_trip_memory`
    over one shared Supabase fake."""

    def __init__(self):
        super().__init__()
        self.deleted: list = []

    async def delete_all(self, *, user_id=None):
        self.deleted.append(user_id)
        return {"message": "Delete in progress. This may take some time."}

    async def get_all(self, **_kwargs):
        # A well-formed EMPTY envelope on purpose: the delete really did empty mem0, so the
        # ONLY thing that can stop this clear from claiming success is the intent row.
        return {"results": [], "count": 0}


def test_the_intent_row_is_written_before_the_guard_reads():
    # C11 test 1. ORDERING IS THE ENTIRE FIX — presence proves nothing. An intent written
    # just before mem0.add() would also be "present", and Codex was explicit that it would
    # still leave the race: the clear races the guard's SNAPSHOT, so the row must exist
    # before that snapshot is taken.
    client, mem = _FakeClient(), _FakeMem0Add()
    _run_write_back(client, mem)
    assert client.ops == ["select:users", "insert:memory_events", "select:trips", "select:memory_events"]


def test_intent_insert_failure_aborts_the_add():
    # C11 test 2, and the one behaviour CHANGE here (C4-bis). Previously a successful add
    # whose audit insert failed was permanently invisible to every later clear, so the
    # endpoint could report `cleared` while that memory was live. No intent -> no add.
    # Losing one learned memory on a DB blip is the fail-safe direction (D7).
    client = _FakeClient(insert_raises={"memory_events"})
    mem = _FakeMem0Add()
    learned = _run_write_back(client, mem)
    assert learned == ["loves ramen"]   # caller contract unchanged; best-effort, never raises
    assert mem.added == []              # NOTHING was sent to mem0
    assert client.events == []
    # freeze read (active) then the intent insert fails — short-circuit: the guard never ran.
    assert client.ops == ["select:users", "insert:memory_events"]


def test_intent_insert_returning_no_row_aborts_the_add():
    # A distinct shape from a raising insert: postgrest can answer `data == []`, and the
    # `or [{}]` fallback must yield "no intent" rather than an IndexError.
    client = _FakeClient(insert_returns_no_row={"memory_events"})
    mem = _FakeMem0Add()
    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert client.ops == ["select:users", "insert:memory_events"]


def test_guard_firing_retracts_the_intent_row_and_skips_the_add():
    # C11 test 3. ABSENCE, not present-and-ignored: nothing was sent, so there is no audit
    # event to keep, and a lingering 'learned' row would match the clear's in-flight check
    # and make the NEXT clear answer `unknown` for a whole _ADD_VISIBILITY_WINDOW_S.
    client = _FakeClient(memory_events=[_cleared_row()])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert [r["event_type"] for r in client.events] == ["cleared"]
    assert client.ops == ["select:users", "insert:memory_events", "select:trips",
                          "select:memory_events", "delete:memory_events"]


def test_a_successful_add_leaves_exactly_one_learned_row_carrying_the_trip_id():
    # C11 test 4. EXACTLY one: a second audit insert after the add would double-count, and
    # trip_id must be set or `_add_possibly_in_flight`'s `trip_id IS NOT NULL` filter would
    # never see this row.
    client, mem = _FakeClient(), _FakeMem0Add()
    _run_write_back(client, mem)
    assert [(r["event_type"], r["trip_id"]) for r in client.events] == [("learned", "t1")]
    assert len(mem.added) == 1
    assert "delete:memory_events" not in client.ops
    assert "update:memory_events" not in client.ops


def test_a_failed_add_flips_the_intent_to_failed_and_never_deletes_it():
    # C11 test 5. 'failed' means "issued, outcome unconfirmed" — precisely what the clear's
    # in-flight check must treat as may-still-land, so this row must survive.
    client, mem = _FakeClient(), _FakeMem0Add(add_raises=True)
    _run_write_back(client, mem)
    assert [r["event_type"] for r in client.events] == ["failed"]
    assert "delete:memory_events" not in client.ops


def test_a_timed_out_add_flips_the_intent_to_failed(monkeypatch):
    # The other half of C11 test 5, and the case MOST likely to still land server-side.
    # Expires the FOURTH bounded call specifically — the three before it are the write-back's
    # own Supabase calls, which C12 bounded too, and expiring those instead aborts the run
    # long before the add.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=4))
    client, mem = _FakeClient(), _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    assert [r["event_type"] for r in client.events] == ["failed"]
    # Asserted OUT here: persist_trip_memory's blanket `except` would swallow an
    # AssertionError raised inside the fake and the pin could never fail.
    assert seen[3] == 5


def test_a_failing_retraction_is_swallowed_and_never_escapes():
    # C11 test 6 (guardrail #3): the write-back is past the point of no return — the trip is
    # already saved and the terminal `result` already streamed — so nothing here may raise.
    client = _FakeClient(memory_events=[_cleared_row()], delete_raises={"memory_events"})
    mem = _FakeMem0Add()
    learned = _run_write_back(client, mem)
    assert learned == ["loves ramen"]
    assert mem.added == []
    # State assertion, NOT a guard proof: the stale intent lingers, which over-suppresses the
    # next clear (`unknown` for one _ADD_VISIBILITY_WINDOW_S) rather than resurrecting cleared data.
    assert [r["event_type"] for r in client.events] == ["cleared", "learned"]


def test_a_failing_mark_failed_is_swallowed_and_never_escapes():
    # The third helper's own try/except — proving one says nothing about the others.
    client = _FakeClient(update_raises={"memory_events"})
    mem = _FakeMem0Add(add_raises=True)
    assert _run_write_back(client, mem) == ["loves ramen"]
    # Still 'learned', so still matched by the clear's in-flight check: the conservative
    # direction holds even when the flip fails.
    assert [r["event_type"] for r in client.events] == ["learned"]


def _other_trips_audit_row():
    return {"id": "evt-other-trip", "user_id": "u1", "trip_id": "t0",
            "event_type": "learned", "created_at": _BEFORE_START}


def test_marking_the_intent_failed_touches_only_its_own_row():
    # C11 test 7. TWO rows on purpose: with one, dropping `.eq("id", intent_id)` would flip
    # EVERY audit row this user has and the test would still pass.
    client = _FakeClient(memory_events=[_other_trips_audit_row()])
    mem = _FakeMem0Add(add_raises=True)
    _run_write_back(client, mem)
    by_id = {r["id"]: r["event_type"] for r in client.events}
    assert by_id["evt-other-trip"] == "learned"      # a previous trip's receipt, untouched
    assert [t for i, t in by_id.items() if i != "evt-other-trip"] == ["failed"]


def test_retracting_the_intent_deletes_only_its_own_row():
    # The mirror for the DELETE. Unscoped, it would empty memory_events — including the
    # 'cleared' marker that keeps the guard armed for the rest of this generation.
    client = _FakeClient(memory_events=[_other_trips_audit_row(), _cleared_row()])
    mem = _FakeMem0Add()
    _run_write_back(client, mem)
    assert mem.added == []
    # The delete must actually have RUN — the surviving-rows assertion alone is satisfied by
    # a write-back that never wrote an intent at all (trap #2, the fixture's natural state).
    assert "delete:memory_events" in client.ops
    assert {r["id"] for r in client.events} == {"evt-other-trip", "evt-clear"}


async def test_a_clear_between_the_guard_read_and_the_add_reports_unknown():
    """C11 test 8 — THE RACE ITSELF, which no other test in this repo can reproduce.

    Two concurrent coroutines over ONE Supabase fake: the write-back suspends at the exact
    instant its guard's snapshot has been taken but before `mem0.add`, a clear runs to
    completion inside that window, then the write-back resumes and its add lands. The clear
    must NOT claim `cleared` — the intent row written before the guard read is what it sees.

    This reddens for the patch Codex called insufficient (an intent written immediately
    before `mem0.add`): at the hook point no row would exist yet, so the clear would answer
    `cleared` while an add was already committed behind it.
    """
    from pipeline.memory_clear import clear_memory
    from pipeline.preferences import persist_trip_memory

    client, mem = _FakeClient(), _FakeMem0ClearAndAdd()
    guard_read = asyncio.Event()
    clear_finished = asyncio.Event()

    async def _suspend_until_the_clear_has_run():
        guard_read.set()
        await clear_finished.wait()

    client.after_guard_read = _suspend_until_the_clear_has_run

    async def _clear_landing_mid_generation():
        await guard_read.wait()
        try:
            return await clear_memory(client, mem, user_id="u1")
        finally:
            clear_finished.set()   # never strand the write-back, even on a failure

    # Watchdog, not a timing dependency: the normal path never waits on the clock. It only
    # converts "the hook was never reached" (a faulted guard) into a red test instead of a
    # hung suite.
    _, verdict = await asyncio.wait_for(asyncio.gather(
        persist_trip_memory(client, mem, user_id="u1", trip_id="t1", ctx=_explicit_ctx()),
        _clear_landing_mid_generation(),
    ), timeout=5)

    assert verdict == "unknown"        # exact — 'unavailable' comes from a different guard
    assert mem.deleted == ["u1"]       # the clear really did run its delete
    # ...and the add really did land after the clear returned, which is WHY `unknown` is the
    # only honest answer: `cleared` would have been a lie by the time the user read it.
    assert mem.added and mem.added[0][1] == "u1"


# ---------------------------------------------------------------------------------
# BOUNDED write-back (C12). C11 put the intent row before the guard's snapshot, but the
# write-back's own Supabase calls were unbounded — they inherit the shared 30s HTTP timeout.
# A slow guard read therefore lets the intent age out of the clear's visibility window while
# the add it announces is still pending, which is the state Codex reproduced against the real
# functions: `expired_intent_verdict='cleared'` with `add_landed=True`. Two independent
# bounds close it: every call here is capped, and the window is widened to cover the capped
# worst case.
# ---------------------------------------------------------------------------------


def test_every_write_back_call_is_bounded_and_the_budget_fits_the_visibility_window(monkeypatch):
    # THE PIN for all four bounds, by exact value and in call order. Literals, not the
    # module constants: `assert seen == [_ADD_INTENT_TIMEOUT_S, ...]` would follow the
    # constants anywhere and a bound inflated to 300 would keep this green.
    from pipeline import preferences as prefs_mod
    from pipeline.memory_clear import (_ADD_VISIBILITY_WINDOW_S,
                                       _MEM0_MATERIALIZATION_ALLOWANCE_S)

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _wait_for_recorder(seen))
    client, mem = _FakeClient(), _FakeMem0Add()
    _run_write_back(client, mem)

    assert mem.added                    # the happy path really ran end to end
    # intent insert, the guard's trips read, the guard's cleared read, mem0.add
    assert seen == [4, 4, 4, 5]
    # ...and the arithmetic C12 turns on. Everything between committing the intent row and
    # the memory becoming READABLE must fit inside the window the clear looks back over, or
    # an intent can age out of view while its own add is still pending — Codex's `cleared` +
    # `add_landed`. 4+4+4+5 = 17s of local bounds, PLUS mem0's materialization.
    #
    # The allowance is part of the ASSERTION, not just the comment: pinning only
    # `sum(seen) < window` caught a window narrowed to <=17s but stayed GREEN at 21s, where
    # the documented 17+8=25s budget no longer fits (Codex R3 injected exactly that).
    # Derived from the RECORDED bounds, so a widened timeout cannot slip past it either.
    assert sum(seen) + _MEM0_MATERIALIZATION_ALLOWANCE_S <= _ADD_VISIBILITY_WINDOW_S


def test_an_intent_insert_that_overruns_its_bound_skips_the_add(monkeypatch):
    # Same fail-safe as an insert that raises (D7), reached down a different path: with no
    # intent on record an add would be invisible to every later clear, so it must not happen.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=1))
    client, mem = _FakeClient(), _FakeMem0Add()

    assert _run_write_back(client, mem) == ["loves ramen"]   # nothing raises (guardrail #3)
    assert mem.added == []
    assert client.events == []
    # the freeze read runs (unbounded, pre-window); the intent insert then never reaches the fake.
    assert client.ops == ["select:users"]
    assert seen == [4]


def test_a_trip_lookup_that_overruns_its_bound_retracts_the_intent_and_skips_the_add(monkeypatch):
    # The guard's first read. An unbounded one is half of the C12 defect: it can outlast the
    # window while holding a pre-clear snapshot. Bounded, it takes the same fail-safe path as
    # a raising lookup — assume a clear happened, retract, add nothing.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=2))
    client, mem = _FakeClient(), _FakeMem0Add()

    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert client.events == []          # the intent was retracted, not left to linger
    assert client.ops == ["select:users", "insert:memory_events", "delete:memory_events"]
    assert seen == [4, 4, 4]            # intent, the expired trips read, the retraction


def test_a_cleared_lookup_that_overruns_its_bound_retracts_the_intent_and_skips_the_add(monkeypatch):
    # The guard's SECOND read has its own bound and its own `except`; proving one says
    # nothing about the other. This is the read C12's race is against.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=3))
    client, mem = _FakeClient(), _FakeMem0Add()

    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert client.events == []
    assert client.ops == ["select:users", "insert:memory_events", "select:trips", "delete:memory_events"]
    assert seen == [4, 4, 4, 4]         # intent, trips, the expired cleared read, retraction


def test_a_retraction_that_overruns_its_bound_is_swallowed_and_never_escapes(monkeypatch):
    # A hung DELETE must not wedge the write-back task either — the trip is already saved and
    # streamed. The stale intent lingering over-suppresses the next clear (`unknown`), which
    # is the safe direction.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=4))
    client = _FakeClient(memory_events=[_cleared_row()])
    mem = _FakeMem0Add()

    assert _run_write_back(client, mem) == ["loves ramen"]
    assert mem.added == []
    assert [r["event_type"] for r in client.events] == ["cleared", "learned"]
    assert seen == [4, 4, 4, 4]         # intent, trips, cleared, the expired retraction


def test_a_mark_failed_that_overruns_its_bound_is_swallowed_and_never_escapes(monkeypatch):
    # The third write's own bound. The row stays 'learned', which the clear's in-flight check
    # still matches — the conservative direction holds even when the flip cannot be recorded.
    from pipeline import preferences as prefs_mod

    seen: list = []
    monkeypatch.setattr(prefs_mod.asyncio, "wait_for",
                        _wait_for_recorder(seen, expire_call=5))
    client, mem = _FakeClient(), _FakeMem0Add(add_raises=True)

    assert _run_write_back(client, mem) == ["loves ramen"]
    assert [r["event_type"] for r in client.events] == ["learned"]
    assert seen == [4, 4, 4, 5, 4]      # intent, trips, cleared, add, the expired flip


async def test_an_aged_intent_blocks_the_clear_and_an_overrunning_guard_read_never_adds(monkeypatch):
    """C12's regression test — the state Codex REPRODUCED, in one fixture.

    An intent committed 20s before the clear (outside the old 15s window, inside the new
    30s one) while the guard holding the pre-clear snapshot overruns its bound. Codex saw
    `expired_intent_verdict='cleared'` with `add_landed=True`; the two assertions below own
    one half each:

      * `verdict == "unknown"` fails if `_ADD_VISIBILITY_WINDOW_S` goes back to 15 — the
        clear stops seeing the aged intent and claims a success it cannot support.
      * `mem.added == []` fails if the bound around the guard's read is removed — the read
        resumes on its stale snapshot and issues the add the clear just told the user was
        gone.

    Remove BOTH and the fixture reproduces Codex's pair exactly.
    """
    from pipeline import preferences as prefs_mod
    from pipeline.memory_clear import clear_memory
    from pipeline.preferences import persist_trip_memory

    real_wait_for = asyncio.wait_for      # bound BEFORE the patch: the watchdog below must
                                          # not run through the fake
    client = _FakeClient(insert_created_at=[_AGED_INTENT])   # the clear's marker gets _LATER
    mem = _FakeMem0ClearAndAdd()
    guard_read = asyncio.Event()
    clear_finished = asyncio.Event()
    bounded = {"depth": 0}               # >0 while a wait_for is awaiting, so the hook can
    overran = {"guard_read": False}      # tell a BOUNDED slow read from an unbounded one

    async def _suspend_until_the_clear_has_run():
        guard_read.set()
        await clear_finished.wait()
        # Attributed to THIS call, never latched globally: a flag that outlived the read
        # would be consumed by the next bounded call instead (mem0.add), and removing the
        # guard's bound would still look like "no add landed" — a false-green injection.
        if bounded["depth"]:
            overran["guard_read"] = True

    client.after_guard_read = _suspend_until_the_clear_has_run

    async def _expiring_wait_for(awaitable, timeout):
        # A deterministic stand-in for the real bound: the op the hook marked as slow is let
        # through to its interleaving point and THEN expired, exactly as asyncio.wait_for
        # would have expired it mid-flight. Every other bounded call passes through, so the
        # clear's own timeouts behave normally.
        bounded["depth"] += 1
        try:
            result = await awaitable
        finally:
            bounded["depth"] -= 1
        if overran["guard_read"]:
            overran["guard_read"] = False
            raise TimeoutError
        return result

    monkeypatch.setattr(prefs_mod.asyncio, "wait_for", _expiring_wait_for)

    async def _clear_landing_mid_generation():
        await guard_read.wait()
        try:
            return await clear_memory(client, mem, user_id="u1")
        finally:
            clear_finished.set()          # never strand the write-back, even on a failure

    # Watchdog, not a timing dependency: it turns "the hook was never reached" into a red
    # test instead of a hung suite.
    _, verdict = await real_wait_for(asyncio.gather(
        persist_trip_memory(client, mem, user_id="u1", trip_id="t1", ctx=_explicit_ctx()),
        _clear_landing_mid_generation(),
    ), timeout=5)

    assert verdict == "unknown"           # exact — 'unavailable' comes from a different guard
    assert mem.deleted == ["u1"]          # the clear really did run its delete
    assert mem.added == []                # the overrunning read failed safe instead of adding
    # ...and the intent it wrote was retracted, so the next clear is not suppressed by it.
    assert [r["event_type"] for r in client.events] == ["cleared"]


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
