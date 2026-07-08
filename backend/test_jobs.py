import pytest
from postgrest.exceptions import APIError

import jobs


def test_idempotency_key_is_request_derived_and_stable():
    a = jobs.compute_idempotency_key("u1", ["https://ig/b", "https://ig/a"], "2026-08-01", "2026-08-02")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    c = jobs.compute_idempotency_key("u2", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    assert a == b        # order-independent, same request → same key
    assert a != c        # different user → different key
    assert "trip" not in a  # never derived from a trip id


def test_idempotency_key_changes_with_preferences_pace_or_destination_hint():
    # A4: same reels+dates but CHANGED preferences/pace/destination_hint must NOT replay
    # the old trip — otherwise "explicit input wins" silently fails on a re-submit.
    base = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02")
    same = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                        preferences=None, pace="balanced", destination_hint=None)
    diff_prefs = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                              preferences="ramen")
    diff_pace = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                             pace="relaxed")
    diff_dest = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                             destination_hint="Tokyo")
    assert base == same          # explicit defaults are stable/backward-compatible
    assert base != diff_prefs
    assert base != diff_pace
    assert base != diff_dest


def test_idempotency_key_no_collision_across_field_boundary():
    # gstack /review cross-model finding (Medium): the old encoding joined fields with a
    # raw "|" (reels with ","). Free-text `preferences`/`destination_hint` can contain
    # "|", so two DIFFERENT requests could produce the SAME join material -- e.g. shifting
    # a "|" across the end_date/preferences boundary. On the old `|`-join code these two
    # keys were EQUAL (a real collision -- an idempotent replay would return the WRONG
    # trip); this assertion would fail to distinguish them there. The JSON-encoded
    # material quotes/escapes each field, so the boundary is unambiguous and the keys
    # differ.
    a = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "e|p", preferences="q")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "e", preferences="p|q")
    assert a != b


def test_idempotency_key_strips_whitespace_only_preferences_difference():
    # merge_preferences (runtime) strips `preferences`, so a whitespace-only difference
    # must not spawn a duplicate trip on replay.
    a = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                     preferences="ramen")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                     preferences="  ramen  ")
    assert a == b


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder, scoped to `jobs`."""

    def __init__(self, store):
        self.store = store
        self._op = None
        self._filters: dict = {}
        self._in_filters: dict = {}
        self._single = False

    def insert(self, row):
        self._op = ("insert", row)
        return self

    def update(self, row):
        self._op = ("update", row)
        return self

    def select(self, cols):
        self._op = ("select", cols)
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def in_(self, col, values):
        self._in_filters[col] = values
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        return all(row.get(k) in v for k, v in self._in_filters.items())

    async def execute(self):
        op, arg = self._op
        if op == "insert":
            key = arg["idempotency_key"]
            if key in self.store:
                raise APIError({
                    "code": "23505",
                    "message": (
                        'duplicate key value violates unique constraint '
                        '"jobs_idempotency_key_unique"'
                    ),
                })
            row = {"id": f"job-{len(self.store) + 1}", **arg}
            self.store[key] = row
            return _Result([row])
        if op == "update":
            matched = [r for r in self.store.values() if self._matches(r)]
            for r in matched:
                r.update(arg)
            return _Result(matched)
        matched = [r for r in self.store.values() if self._matches(r)]
        if self._single:
            return _Result(matched[0] if matched else None)
        return _Result(matched)


class _Client:
    def __init__(self):
        self.store: dict = {}

    def table(self, name):
        return _Table(self.store)


@pytest.mark.asyncio
async def test_enqueue_returns_job_id_and_trip_id_tuple():
    c = _Client()
    job_id, trip_id = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    assert job_id == "job-1"
    assert trip_id == "trip-1"


@pytest.mark.asyncio
async def test_enqueue_duplicate_key_returns_existing_job_and_trip():
    c = _Client()
    first = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    second = await jobs.enqueue_job("trip-2", "user-1", "idem-1", client=c)  # racing dup POST
    assert first == second == ("job-1", "trip-1")


@pytest.mark.asyncio
async def test_enqueue_non_duplicate_api_error_reraises():
    class _BoomTable(_Table):
        async def execute(self):
            if self._op[0] == "insert":
                raise APIError({"code": "23503", "message": "foreign key violation"})
            return await super().execute()

    class _BoomClient(_Client):
        def table(self, name):
            return _BoomTable(self.store)

    c = _BoomClient()
    with pytest.raises(APIError) as ei:
        await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    assert ei.value.code == "23503"


@pytest.mark.asyncio
async def test_mark_running_then_done():
    c = _Client()
    job_id, _ = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    won = await jobs.mark_job_running(c, job_id)
    assert won is True
    assert c.store["idem-1"]["status"] == "running"
    assert c.store["idem-1"]["locked_at"] is not None
    await jobs.mark_job_done(c, job_id, status="succeeded")
    assert c.store["idem-1"]["status"] == "succeeded"
    assert c.store["idem-1"]["completed_at"] is not None


@pytest.mark.asyncio
async def test_mark_running_loses_cas_when_already_running():
    c = _Client()
    job_id, _ = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    first = await jobs.mark_job_running(c, job_id)
    second = await jobs.mark_job_running(c, job_id)  # already running -> CAS must lose
    assert first is True
    assert second is False
