"""Live runner tests: fully offline, async fake Supabase client (execute() is
awaitable). Covers happy path, partial failure (degraded), critical failure (no
places/reels survive), an unexpected exception outside the per-reel isolation,
and the atomic CAS claim guard that aborts a double-dispatched run."""
import pytest

from models.place import PlaceResult
from models.reel import ReelData
from pipeline import runner


class _Result:
    def __init__(self, data):
        self.data = data


class _Table:
    """Async fake of a supabase-py postgrest filter builder over a shared in-memory db."""

    def __init__(self, name, db):
        self.name = name
        self.db = db
        self._op = None
        self._filters: dict = {}
        self._in_filters: dict = {}

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

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        return all(row.get(k) in v for k, v in self._in_filters.items())

    async def execute(self):
        op, arg = self._op
        if op == "insert":
            self.db.setdefault(self.name, []).append(arg)
            return _Result([arg])
        if op == "update":
            rows = self.db.get(self.name, [])
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(arg)
            self.db.setdefault(self.name + "_updates", []).append(arg)
            return _Result(matched)
        rows = self.db.get(self.name, [])
        matched = [r for r in rows if self._matches(r)]
        return _Result(matched)


class _Client:
    def __init__(self, jobs=None):
        self.db: dict = {"jobs": jobs or []}

    def table(self, name):
        return _Table(name, self.db)

    @property
    def events(self):
        return self.db.get("generation_events", [])

    @property
    def trip_updates(self):
        return self.db.get("trips_updates", [])


def _reel(url):
    return ReelData(reel_url=url, caption="📍Tokyo Tower", location_name="Tokyo",
                     short_code="x", capture_status="CAPTURED", transcript=None)


def _place(name):
    return PlaceResult(name=name, name_local=None, category="attraction",
                        source_type="reel_extracted", lat=35.6586, lng=139.7454,
                        confidence=0.9, evidence_quote="📍Tokyo Tower",
                        source_url="https://example.org/a", formatted_address=None)


@pytest.mark.asyncio
async def test_happy_path_completes_marks_job_and_emits_result():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert out["itinerary"]["days"][0]["place_names"] == ["Tokyo Tower"]
    stages = [e["stage"] for e in c.events]
    assert stages[:4] == ["scrape", "extract", "dedup", "narrate"]
    assert [e for e in c.events if e["event_type"] == "result"]
    assert c.db["jobs"][0]["status"] == "succeeded"
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_one_reel_fails_saves_with_gaps():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        if url.endswith("bad"):
            raise RuntimeError("Apify scrape failed (HTTP 500)")
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/ok", "https://ig/bad"],
                                       "2026-08-01", "2026-08-01", job_id="job-1", client=c,
                                       scrape=scrape, extract=extract)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_all_reels_fail_is_critical_failure():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        raise RuntimeError("Apify scrape failed (HTTP 500)")

    async def extract(reel):
        return []

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/bad"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"][0]["payload"]["error"]
    assert c.db["jobs"][0]["status"] == "failed"
    assert c.trip_updates[-1]["status"] == "failed"


@pytest.mark.asyncio
async def test_unexpected_exception_still_writes_terminal_result():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    def boom(reel):
        raise ValueError("unexpected non-async boom")  # wrong shape → raises before gather()

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=boom)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"]  # never a hanging stream
    assert c.db["jobs"][0]["status"] == "failed"


@pytest.mark.asyncio
async def test_cas_abort_skips_when_job_already_claimed():
    c = _Client(jobs=[{"id": "job-1", "status": "running"}])  # already claimed by another run

    async def scrape(url):
        raise AssertionError("scrape must not run when the CAS claim is lost")

    async def extract(reel):
        raise AssertionError("extract must not run when the CAS claim is lost")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract)
    assert out == {"skipped": "job already claimed by another run"}
    assert c.events == []
    assert c.trip_updates == []
    assert c.db["jobs"][0]["status"] == "running"  # untouched — not re-claimed
