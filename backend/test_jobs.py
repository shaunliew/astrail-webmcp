from datetime import datetime, timedelta, timezone

import pytest
from postgrest.exceptions import APIError

import jobs
from test_saved_reels_organize import _LEASE_RPCS


def test_idempotency_key_is_request_derived_and_stable():
    a = jobs.compute_idempotency_key("u1", ["https://ig/b", "https://ig/a"], "2026-08-01", "2026-08-02")
    b = jobs.compute_idempotency_key("u1", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    c = jobs.compute_idempotency_key("u2", ["https://ig/a", "https://ig/b"], "2026-08-01", "2026-08-02")
    assert a == b        # order-independent, same request → same key
    assert a != c        # different user → different key
    assert "trip" not in a  # never derived from a trip id


def test_idempotency_key_changes_with_output_affecting_fields():
    # A4 + Fix 9: same reels+dates but a CHANGED output-affecting field must NOT replay the old
    # trip — otherwise "explicit input wins" silently fails on a re-submit. Covers preferences/
    # pace/destination_hint (A4) AND budget_level/origin_city/requested_places (Fix 9): two
    # genuinely different requests must not collide into one another's idempotent replay.
    base = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02")
    same = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                        preferences=None, pace="balanced", destination_hint=None,
                                        budget_level=None, origin_city=None, requested_places=None)
    diff_prefs = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                              preferences="ramen")
    diff_pace = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                             pace="relaxed")
    diff_dest = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                             destination_hint="Tokyo")
    diff_budget = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                               budget_level="luxury")           # Fix 9
    diff_origin = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                               origin_city="SFO")               # Fix 9
    diff_places = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                               requested_places=["Tokyo Tower"])  # Fix 9
    assert base == same          # explicit defaults are stable/backward-compatible
    assert base != diff_prefs
    assert base != diff_pace
    assert base != diff_dest
    assert base != diff_budget   # Fix 9 — a different budget must not replay the old trip
    assert base != diff_origin   # Fix 9 — a different origin must not replay
    assert base != diff_places   # Fix 9 — a different requested place must not replay
    # requested_places is order-independent (sorted into the material), like reel_urls.
    ab = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                      requested_places=["Tokyo Tower", "Shibuya"])
    ba = jobs.compute_idempotency_key("u1", ["https://ig/a"], "2026-08-01", "2026-08-02",
                                      requested_places=["Shibuya", "Tokyo Tower"])
    assert ab == ba


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
        self._is_filters: dict = {}
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

    def is_(self, col, val):
        # IS NULL filter (charge_refunded_at IS NULL): `.is_(col, "null")` matches rows
        # where row.get(col) is None. Only "null" is modeled; anything else fails loudly.
        if val != "null":
            raise ValueError(f"fake .is_() models only the IS NULL form, got .is_({col!r}, {val!r})")
        self._is_filters[col] = val
        return self

    def maybe_single(self):
        self._single = True
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        if not all(row.get(k) in v for k, v in self._in_filters.items()):
            return False
        return all(row.get(col) is None for col in self._is_filters)

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
        self.clock_skew = timedelta(0)

    def db_now(self) -> datetime:
        """The DATABASE's clock. Every lease instant is `clock_timestamp()` inside Postgres,
        so the mirrors must read this rather than this process's wall clock."""
        return datetime.now(timezone.utc) + self.clock_skew

    def table(self, name):
        return _Table(self.store)

    def rpc(self, name, params):
        # The SHARED mirrors, over this fake's differently-shaped store. Copying the claim
        # predicate into a second local mirror is how two fakes drift apart and one of them
        # starts proving nothing; the mirrors take their rows as an argument for exactly this.
        if name in _LEASE_RPCS:
            mirror, _table = _LEASE_RPCS[name]
            return mirror(self, params, list(self.store.values()))
        raise AssertionError(f"fake does not implement rpc {name!r}")


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
async def test_enqueue_dup_reread_returns_active_row_not_refunded():
    """Fix 2/Fix 4: the partial unique index lets a key have one ACTIVE row + N refunded
    rows. On 23505 the re-read is `.is_("charge_refunded_at","null")`-filtered so it returns
    the SINGLE ACTIVE row's (id, trip_id) — an unfiltered maybe_single would match >1 and
    500. Two rows share one key here; the insert collides, and only the active row comes back."""
    rows = [
        {"id": "job-refunded", "trip_id": "trip-refunded", "idempotency_key": "idem-1",
         "status": "failed", "charge_refunded_at": "2026-08-01T00:00:00+00:00"},
        {"id": "job-active", "trip_id": "trip-active", "idempotency_key": "idem-1",
         "status": "pending", "charge_refunded_at": None},
    ]

    class _DupTable(_Table):
        """store is a LIST (two rows share the key); every insert collides -> 23505."""

        def __init__(self, seeded):
            super().__init__(store=None)
            self._rows = seeded

        async def execute(self):
            if self._op[0] == "insert":
                raise APIError({"code": "23505", "message": "duplicate key value violates unique constraint"})
            matched = [r for r in self._rows if self._matches(r)]
            if self._single:
                return _Result(matched[0] if matched else None)
            return _Result(matched)

    class _DupClient:
        def __init__(self, seeded):
            self._rows = seeded

        def table(self, name):
            return _DupTable(self._rows)

    c = _DupClient(rows)
    job_id, trip_id = await jobs.enqueue_job("trip-new", "user-1", "idem-1", client=c)
    assert (job_id, trip_id) == ("job-active", "trip-active")


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
    token = await jobs.mark_job_running(c, job_id)
    assert token is not None
    assert c.store["idem-1"]["status"] == "running"
    assert c.store["idem-1"]["locked_at"] is not None
    assert await jobs.mark_job_done(c, job_id, status="succeeded", lease_token=token) is True
    assert c.store["idem-1"]["status"] == "succeeded"
    assert c.store["idem-1"]["completed_at"] is not None


@pytest.mark.asyncio
async def test_mark_running_loses_cas_when_already_running():
    c = _Client()
    job_id, _ = await jobs.enqueue_job("trip-1", "user-1", "idem-1", client=c)
    first = await jobs.mark_job_running(c, job_id)
    second = await jobs.mark_job_running(c, job_id)  # already running -> CAS must lose
    assert first is not None
    assert second is None                            # no second token: no second owner
