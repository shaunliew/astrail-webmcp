import pytest

import jobs


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder, scoped to `jobs`."""

    def __init__(self, store):
        self.store = store
        self._op = None
        self._eq_filters: dict = {}
        self._in_filters: dict = {}
        self._lt_filters: dict = {}

    def select(self, cols):
        self._op = ("select", cols)
        return self

    def update(self, row):
        self._op = ("update", row)
        return self

    def eq(self, col, val):
        self._eq_filters[col] = val
        return self

    def in_(self, col, values):
        self._in_filters[col] = values
        return self

    def lt(self, col, val):
        self._lt_filters[col] = val
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._eq_filters.items()):
            return False
        if not all(row.get(k) in v for k, v in self._in_filters.items()):
            return False
        for col, cutoff in self._lt_filters.items():
            rv = row.get(col)
            if rv is None or not rv < cutoff:
                return False
        return True

    async def execute(self):
        op, arg = self._op
        matched = [r for r in self.store if self._matches(r)]
        if op == "update":
            for r in matched:
                r.update(arg)
        return _Result(matched)


class _Client:
    def __init__(self, store):
        self.store = store

    def table(self, _name):
        return _Table(self.store)


@pytest.mark.asyncio
async def test_recovers_pending_and_stale_running_but_not_fresh_running_or_succeeded():
    store = [
        {"id": "j1", "status": "pending", "trip_id": "t1", "user_id": "u", "locked_at": None},
        {
            "id": "j2", "status": "running", "trip_id": "t2", "user_id": "u",
            "locked_at": "2000-01-01T00:00:00+00:00",  # stale
        },
        {
            "id": "j3", "status": "running", "trip_id": "t3", "user_id": "u",
            "locked_at": "2999-01-01T00:00:00+00:00",  # fresh
        },
        {"id": "j4", "status": "succeeded", "trip_id": "t4", "user_id": "u", "locked_at": None},
    ]
    reclaimable = await jobs.recover_inflight_jobs(client=_Client(store), stale_after_s=900)

    ids = {r["id"] for r in reclaimable}
    assert ids == {"j1", "j2"}  # pending + stale-running; NOT fresh-running, NOT succeeded
    assert store[1]["status"] == "retryable"  # stale running flipped
    assert store[2]["status"] == "running"  # fresh running untouched (no double-run)
