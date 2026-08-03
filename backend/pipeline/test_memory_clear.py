"""Offline tests for the POST /settings/memory/clear engine (pipeline.memory_clear).

Injected fakes only — no network, no DB, no credentials, no wall clock. The fakes
GENUINELY filter (BUILD-LOOP trap #4: a `return self` builder makes every window and
event-type case vacuous) and model postgrest 2.31.0's real `not_` semantics, because a
`not_` that returned self while `is_` ignored the flag would SILENTLY INVERT the in-flight
query — the check would then match only the clear's own markers and never a generation's,
while every test still passed.

Assertions are exact outcomes, never `in ("unknown", "unavailable")` (trap #7): those two
come from different guards, and a disjunction makes neither attributable.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

import pytest

from pipeline.memory_clear import clear_memory

# The Postgres clock the fake stamps on insert. Everything else is derived from it, so the
# suite never reads a wall clock (determinism).
_NOW = "2026-08-03T12:00:00+00:00"


def _shift(ts: str, seconds: int) -> str:
    return (datetime.fromisoformat(ts) + timedelta(seconds=seconds)).isoformat()


# -5s is INSIDE and -40s is OUTSIDE the module's 30s _ADD_VISIBILITY_WINDOW_S. Written as
# literals rather than derived from the constant on purpose: derived offsets would follow
# the window anywhere, so a window inflated to an hour would keep every test green.
#
# -20s is the band C12 widened the window to cover: outside the old 15s, inside today's 30s.
# The write-back's bounded budget (4+4+4 to issue the add, 5 for the add, then mem0's 4-8s
# PENDING->readable) means an intent that old can still be materializing.
_RECENT = _shift(_NOW, -5)
_AGING = _shift(_NOW, -20)
_STALE = _shift(_NOW, -40)


def _stale_add(**overrides) -> dict:
    """A 'learned' row OLDER than the visibility window.

    Every test that expects `"cleared"` seeds this explicitly (A16): an empty table would
    satisfy the no-in-flight precondition by its natural state, which is trap #2.
    """
    row = {"id": "evt-stale", "user_id": "u1", "trip_id": "t1",
           "event_type": "learned", "created_at": _STALE}
    row.update(overrides)
    return row


def _recent_add(**overrides) -> dict:
    row = {"id": "evt-recent", "user_id": "u1", "trip_id": "t1",
           "event_type": "learned", "created_at": _RECENT}
    row.update(overrides)
    return row


class _Mem0Error(Exception):
    """Duck-typed mem0 SDK error — the production code classifies on `.error_code` and
    never imports mem0 (the offline #16 eval must stay credential-free)."""

    def __init__(self, error_code: str) -> None:
        super().__init__(error_code)
        self.error_code = error_code


class _Result:
    def __init__(self, data): self.data = data


class _FakeTable:
    """PostgREST-shaped builder over an in-memory row list.

    Unsupported shapes raise loudly rather than filtering on nothing
    (test_saved_reels_organize.py's `_eval_filter_term` follows the same rule): an operator
    that quietly evaluated True is how a later increment gets a green test proving nothing.
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

    # --- builders ---------------------------------------------------------------
    def select(self, *_cols): self._op = "select"; return self

    def insert(self, row): self._op, self._payload = "insert", dict(row); return self

    def update(self, patch): self._op, self._payload = "update", dict(patch); return self

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

    # --- evaluation -------------------------------------------------------------
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

    async def execute(self):
        client = self._client
        client.ops.append(f"{self._op}:{self._name}")
        if self._op == "insert":
            if client.insert_raises:
                raise RuntimeError("insert failed")
            if client.insert_returns_no_row:
                return _Result([])
            row = dict(self._payload)
            client.seq += 1
            row.setdefault("id", f"row-{client.seq}")
            if client.created_at is not None:
                row.setdefault("created_at", client.created_at)
            client.rows.append(row)
            return _Result([dict(row)])
        if self._op == "update":
            if client.update_raises:
                raise RuntimeError("update failed")
            matched = [r for r in client.rows if self._matches(r)]
            for r in matched:
                r.update(self._payload)
            return _Result([dict(r) for r in matched])
        if self._op == "select":
            if client.select_raises:
                raise RuntimeError("select failed")
            return _Result([dict(r) for r in client.rows if self._matches(r)])
        raise ValueError(f"fake table used with no supported operation: {self._op!r}")


class _FakeSupabase:
    def __init__(self, *, rows=None, insert_raises=False, insert_returns_no_row=False,
                 update_raises=False, select_raises=False, created_at=_NOW) -> None:
        self.rows = [dict(r) for r in (rows or [])]
        self.insert_raises = insert_raises
        self.insert_returns_no_row = insert_returns_no_row
        self.update_raises = update_raises
        self.select_raises = select_raises
        self.created_at = created_at   # None -> the insert response carries no created_at
        self.seq = 0
        self.ops: list[str] = []       # shared with _FakeMem0 so ORDER is assertable

    def table(self, name: str):
        if name != "memory_events":
            raise ValueError(f"fake only serves memory_events, got {name!r}")
        return _FakeTable(self, name)

    def row(self, row_id: str) -> dict:
        return next(r for r in self.rows if r["id"] == row_id)


_EMPTY = {"results": [], "count": 0}


class _FakeMem0:
    def __init__(self, *, ops=None, delete_exc=None, envelope=_EMPTY, get_all_exc=None) -> None:
        self.ops = ops if ops is not None else []
        self.delete_exc, self.get_all_exc = delete_exc, get_all_exc
        self.envelope = envelope
        self.delete_calls: list = []
        self.get_all_calls: list[dict] = []

    async def delete_all(self, *, user_id=None):
        self.ops.append("delete_all")
        self.delete_calls.append(user_id)
        if self.delete_exc is not None:
            raise self.delete_exc
        return {"message": "Delete in progress. This may take some time."}

    async def get_all(self, **kwargs):
        self.ops.append("get_all")
        self.get_all_calls.append(kwargs)
        if self.get_all_exc is not None:
            raise self.get_all_exc
        return self.envelope


def _wire(**client_kwargs):
    """A client + a mem0 sharing one op log."""
    client = _FakeSupabase(**client_kwargs)
    return client, _FakeMem0(ops=client.ops)


# ---------------------------------------------------------------------------------
# Pre-delete guards
# ---------------------------------------------------------------------------------

async def test_disabled_memory_is_unavailable_and_writes_no_marker():
    # mem0=None means nothing was ever sent, so nothing was deleted — and no audit row
    # should claim a clear that never happened.
    client = _FakeSupabase(rows=[_stale_add()])
    assert await clear_memory(client, None, user_id="u1") == "unavailable"
    assert client.ops == []


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
async def test_blank_user_id_never_calls_delete_all(blank):
    # delete_all() with no user filter deletes EVERY memory in the mem0 account. The fake
    # ACCEPTS the marker insert on purpose (C10): a UUID-rejecting fake would block the
    # delete by itself and this test would pass with the guard deleted.
    client, mem = _wire(rows=[_stale_add()])
    assert await clear_memory(client, mem, user_id=blank) == "unavailable"
    assert mem.delete_calls == []


async def test_marker_insert_failure_never_calls_delete_all():
    # The guard persist_trip_memory reads must be ARMED before anything can be deleted
    # (D4). No marker -> no delete, ever.
    client, mem = _wire(insert_raises=True)
    assert await clear_memory(client, mem, user_id="u1") == "unavailable"
    assert mem.delete_calls == []


async def test_marker_insert_returning_no_row_never_calls_delete_all():
    # A distinct shape from a raising insert: postgrest can return `data == []`. The
    # `or [{}]` fallback must yield "no marker" rather than an IndexError.
    client, mem = _wire(insert_returns_no_row=True)
    assert await clear_memory(client, mem, user_id="u1") == "unavailable"
    assert mem.delete_calls == []


async def test_marker_is_written_before_the_delete_and_verification_always_follows():
    client, mem = _wire(rows=[_stale_add()])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"
    assert client.ops == ["insert:memory_events", "delete_all", "get_all",
                          "select:memory_events"]


async def test_marker_row_is_a_null_trip_cleared_event():
    client, mem = _wire(rows=[_stale_add()])
    await clear_memory(client, mem, user_id="u1")
    marker = client.row("row-1")
    assert marker["user_id"] == "u1"
    assert marker["event_type"] == "cleared"
    assert marker["trip_id"] is None


# ---------------------------------------------------------------------------------
# Delete-error classification (C2)
# ---------------------------------------------------------------------------------

async def test_net_connect_is_unavailable_and_flips_the_marker():
    # The ONLY provably-nothing-happened bucket: the request never reached mem0.
    client, mem = _wire(rows=[_stale_add()])
    mem.delete_exc = _Mem0Error("NET_CONNECT")
    assert await clear_memory(client, mem, user_id="u1") == "unavailable"
    assert client.row("row-1")["event_type"] == "failed"
    assert mem.get_all_calls == []   # nothing to verify: nothing was sent


@pytest.mark.parametrize("error_code", ["HTTP_409", "HTTP_429", "HTTP_500", "HTTP_504", "408"])
async def test_http_errors_verify_instead_of_claiming_nothing_was_deleted(error_code):
    # C2 regression. A status proves which exception class the SDK raised, NOT that the
    # server had no side effects — a 409 can mean "a deletion is already in progress",
    # possibly our OWN retried request. Asserting an exact outcome, not merely "it
    # verified": a spy that only observes is satisfied by code that discards the result.
    client, mem = _wire(rows=[_stale_add()])
    mem.delete_exc = _Mem0Error(error_code)
    assert await clear_memory(client, mem, user_id="u1") == "cleared"
    assert len(mem.get_all_calls) == 1
    assert client.row("row-1")["event_type"] == "cleared"   # never retracted


@pytest.mark.parametrize("error_code", ["HTTP_409", "HTTP_429", "HTTP_500", "HTTP_504", "408"])
async def test_http_errors_report_unknown_when_memory_is_still_populated(error_code):
    # The other half of the same fork: verification, not the status code, decides.
    client, mem = _wire(rows=[_stale_add()])
    mem.delete_exc = _Mem0Error(error_code)
    mem.envelope = {"results": [{"id": "m1", "memory": "likes ramen"}], "count": 1}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_delete_timeout_still_verifies_and_can_report_cleared():
    # A timed-out delete may still commit server-side, so it verifies rather than failing.
    client, mem = _wire(rows=[_stale_add()])
    mem.delete_exc = asyncio.TimeoutError()
    assert await clear_memory(client, mem, user_id="u1") == "cleared"
    assert len(mem.get_all_calls) == 1


async def test_delete_and_verify_are_both_timeout_bounded(monkeypatch):
    from pipeline import memory_clear as mc

    real_wait_for = asyncio.wait_for
    seen: list = []

    async def _recording_wait_for(awaitable, timeout):
        seen.append(timeout)
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(mc.asyncio, "wait_for", _recording_wait_for)
    client, mem = _wire(rows=[_stale_add()])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"
    # RECORDED inside the fake, ASSERTED out here: _memory_is_empty wraps its call in a
    # blanket `except`, so an AssertionError raised inside would be swallowed and the pin
    # could never fail (the same trap test_preferences.py:145 documents).
    assert seen == [5, 4]


# ---------------------------------------------------------------------------------
# Verification strictness (_memory_is_empty)
# ---------------------------------------------------------------------------------

async def test_verify_reads_only_this_users_memories_with_v2_pagination():
    client, mem = _wire(rows=[_stale_add()])
    await clear_memory(client, mem, user_id="u1")
    call = mem.get_all_calls[0]
    assert call["version"] == "v2"
    assert call["filters"] == {"AND": [{"user_id": "u1"}]}
    assert call["page"] == 1 and call["page_size"] == 1


async def test_clean_delete_with_a_surviving_memory_is_unknown():
    # E1 regression, the reason this endpoint verifies at all: delete_all returns in
    # ~374ms while the server-side DELETE_ALL takes ~830-880ms. A clean return is NOT
    # evidence, so a still-populated read must never report success.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": [{"id": "m1", "memory": "likes ramen"}], "count": 1}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_rows_present_with_a_zero_count_is_unknown():
    # Envelope drift where `count` lies. The ONLY fixture that makes `not rows`
    # attributable on its own — with a truthful count the `count == 0` clause catches it.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": [{"id": "m1"}], "count": 0}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_empty_rows_with_a_non_zero_count_is_unknown():
    # The mirror: makes `count == 0` attributable on its own.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": [], "count": 3}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_boolean_count_is_unknown():
    # `bool` subclasses `int` and `False == 0`, so a plain `count == 0` would read a
    # drifted payload as empty. This is what makes `type(count) is int` load-bearing.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": [], "count": False}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_missing_count_is_unknown():
    # Defense in depth, stated as such: `type(None) is int` and `None == 0` are BOTH
    # false, so neither clause is individually attributable here — the two tests above own
    # that job. This one pins the composed behaviour.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": []}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


@pytest.mark.parametrize("envelope", [None, [], [{"id": "m1"}], "nope", 42])
async def test_verify_non_dict_envelope_is_unknown(envelope):
    # A bare-list envelope is NOT established for this SDK call, and for a DESTRUCTIVE
    # verifier an unrecognised shape must never read as empty.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = envelope
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


@pytest.mark.parametrize("results", [{}, "nope", 42])
async def test_verify_results_that_are_not_a_list_is_unknown(results):
    # `{}` is the attributable case: it is falsy, so with `isinstance(rows, list)` removed
    # the payload would pass `not rows` and report cleared. The truthy fixtures cannot
    # prove that clause on their own.
    client, mem = _wire(rows=[_stale_add()])
    mem.envelope = {"results": results, "count": 0}
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_raising_is_unknown():
    client, mem = _wire(rows=[_stale_add()])
    mem.get_all_exc = RuntimeError("mem0 down")
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_verify_timeout_is_unknown(monkeypatch):
    from pipeline import memory_clear as mc

    real_wait_for = asyncio.wait_for

    async def _fail_second_wait(awaitable, timeout):
        if timeout == mc._VERIFY_TIMEOUT_S:
            awaitable.close()          # avoid "coroutine was never awaited"
            raise TimeoutError
        return await real_wait_for(awaitable, timeout)

    monkeypatch.setattr(mc.asyncio, "wait_for", _fail_second_wait)
    client, mem = _wire(rows=[_stale_add()])
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


# ---------------------------------------------------------------------------------
# In-flight add detection (_add_possibly_in_flight)
# ---------------------------------------------------------------------------------

async def test_recent_learned_add_makes_the_result_unknown():
    # add() returns PENDING in ~570ms and the memory becomes readable 4-8s later, so an
    # empty read taken inside that window is not trustworthy.
    client, mem = _wire(rows=[_recent_add()])
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_recent_failed_add_makes_the_result_unknown():
    # A14: persist_trip_memory records 'failed' on any add error OR TIMEOUT, and a
    # timed-out add is exactly the case most likely to still land.
    client, mem = _wire(rows=[_recent_add(event_type="failed")])
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_add_older_than_the_visibility_window_still_reports_cleared():
    # Makes `.gt("created_at", cutoff)` load-bearing: without it this row would match and
    # every clear would report unknown forever.
    client, mem = _wire(rows=[_stale_add()])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"


async def test_an_add_20s_old_is_still_treated_as_possibly_in_flight():
    # THE PIN for C12's widened window, and it reddens the moment 30 goes back to 15.
    # 15s covered only mem0's measured 4-8s materialization; it did not cover the write-back's
    # own pre-add budget, so an intent could age out of view while its add was still pending —
    # the clear then reported `cleared` and the add landed behind it (Codex reproduced it).
    client, mem = _wire(rows=[_recent_add(id="evt-aging", created_at=_AGING)])
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_a_flipped_clear_marker_does_not_count_as_an_in_flight_add():
    # C10: the ONLY fixture that makes `not_.is_("trip_id", "null")` load-bearing. A
    # normal 'cleared' marker is already excluded by the event_type filter, so it would
    # prove nothing; a clear marker that _mark_marker_failed flipped to 'failed' with a
    # NULL trip_id is excluded by the trip_id filter alone. Without it, one previously
    # failed clear would make every later clear report unknown forever.
    client, mem = _wire(rows=[_stale_add(),
                              _recent_add(id="evt-flipped", event_type="failed",
                                          trip_id=None)])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"


async def test_a_non_add_event_type_does_not_count_as_an_in_flight_add():
    # Makes `.in_("event_type", ["learned", "failed"])` attributable. The clear's own
    # markers are already excluded by the trip_id filter, so the only fixture the
    # event_type whitelist excludes ON ITS OWN is a non-add event carrying a trip_id.
    # 'updated' is schema-legal (memory_events_event_type_check allows learned/updated/
    # cleared/reconciled/failed) and is written by nothing today — only 'learned' and
    # 'failed' mean an add was attempted, and only those may gate a clear.
    client, mem = _wire(rows=[_stale_add(),
                              _recent_add(id="evt-updated", event_type="updated")])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"


async def test_another_users_recent_add_does_not_block():
    client, mem = _wire(rows=[_stale_add(),
                              _recent_add(id="evt-other", user_id="u2")])
    assert await clear_memory(client, mem, user_id="u1") == "cleared"


async def test_missing_time_reference_is_unknown():
    # No Postgres clock to compare against -> an in-flight add cannot be ruled out, and
    # claiming a confirmed clear anyway is the exact overclaim this endpoint prevents.
    client, mem = _wire(rows=[_stale_add()], created_at=None)
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_unparseable_time_reference_is_unknown():
    # Distinct from missing: the column is present but `datetime.fromisoformat` rejects it.
    client, mem = _wire(rows=[_stale_add()], created_at="not-a-timestamp")
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


async def test_in_flight_lookup_failure_is_unknown():
    client, mem = _wire(rows=[_stale_add()], select_raises=True)
    assert await clear_memory(client, mem, user_id="u1") == "unknown"


# ---------------------------------------------------------------------------------
# Marker retraction (_mark_marker_failed)
# ---------------------------------------------------------------------------------

async def test_marker_retraction_touches_only_its_own_row():
    # TWO markers on purpose (C10): with a single row, deleting `.eq("id", marker_id)`
    # would update every audit row and the test would still pass.
    other = {"id": "evt-other-clear", "user_id": "u1", "trip_id": None,
             "event_type": "cleared", "created_at": _STALE}
    client, mem = _wire(rows=[_stale_add(), other])
    mem.delete_exc = _Mem0Error("NET_CONNECT")
    assert await clear_memory(client, mem, user_id="u1") == "unavailable"
    assert client.row("row-1")["event_type"] == "failed"
    assert client.row("evt-other-clear")["event_type"] == "cleared"


async def test_marker_retraction_failure_is_swallowed_and_suppression_stays_armed():
    # A state assertion, NOT a guard proof (C10): the marker stays 'cleared' whether or
    # not _mark_marker_failed exists. What IS asserted is that a failing retraction never
    # escapes — the endpoint still returns its documented outcome.
    client, mem = _wire(rows=[_stale_add()], update_raises=True)
    mem.delete_exc = _Mem0Error("NET_CONNECT")
    assert await clear_memory(client, mem, user_id="u1") == "unavailable"
    assert client.row("row-1")["event_type"] == "cleared"   # over-suppresses, never resurrects


# ---------------------------------------------------------------------------------
# Secret hygiene
# ---------------------------------------------------------------------------------

async def test_failure_logs_carry_only_the_exception_type(capsys):
    # Token safety: a mem0 SDK error can carry the API key in its message/URL, so only the
    # TYPE is ever printed.
    client, mem = _wire(rows=[_stale_add()])
    mem.delete_exc = _Mem0Error("HTTP_401 org_id=secret-token-abc123")
    mem.get_all_exc = _Mem0Error("HTTP_401 org_id=secret-token-abc123")
    assert await clear_memory(client, mem, user_id="u1") == "unknown"
    err = capsys.readouterr().err
    assert "secret-token-abc123" not in err
    assert "_Mem0Error" in err
