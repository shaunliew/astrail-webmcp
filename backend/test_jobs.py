import pytest
import jobs


def test_idempotency_key_is_request_derived_and_stable():
    a = jobs.compute_idempotency_key("u1", ["https://ig/b", "https://ig/a"], "2026-08-01", "2026-08-02")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    c = jobs.compute_idempotency_key("u2", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    assert a == b        # order-independent, same request → same key
    assert a != c        # different user → different key
    assert "trip" not in a  # never derived from a trip id


class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, store): self.store = store; self._pending = None; self._filter = {}
    def insert(self, row): self._pending = ("insert", row); return self
    def update(self, row): self._pending = ("update", row); return self
    def select(self, cols): self._pending = ("select", cols); return self
    def eq(self, col, val): self._filter[col] = val; return self
    def execute(self):
        op, arg = self._pending
        if op == "insert":
            key = arg["idempotency_key"]
            if key in self.store:
                raise Exception("duplicate key value violates unique constraint")
            self.store[key] = {"id": f"job-{len(self.store)+1}", **arg}
            return _Result([self.store[key]])
        if op == "update":
            for r in self.store.values():
                if all(r.get(k) == v for k, v in self._filter.items()):
                    r.update(arg)
            return _Result([])
        match = [r for r in self.store.values()
                 if all(r.get(k) == v for k, v in self._filter.items())]
        return _Result(match)


class _Client:
    def __init__(self): self.store = {}
    def table(self, name): return _Table(self.store)


@pytest.mark.asyncio
async def test_enqueue_returns_job_id_and_is_idempotent():
    c = _Client()
    first = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    second = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    assert first == second == "job-1"


@pytest.mark.asyncio
async def test_mark_running_then_done():
    c = _Client()
    await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    await jobs.mark_job_running(c, "job-1")
    assert c.store["idem-1"]["status"] == "running"
    assert c.store["idem-1"]["locked_at"] is not None
    await jobs.mark_job_done(c, "job-1", status="succeeded")
    assert c.store["idem-1"]["status"] == "succeeded"
    assert c.store["idem-1"]["completed_at"] is not None
