"""Live runner tests: fully offline, async fake Supabase client (execute() is
awaitable). Covers happy path, partial failure (degraded), critical failure (no
places/reels survive), an unexpected exception outside the per-reel isolation,
a blank-day feasibility flag downgrading status even with no scrape/extract
failures, and the atomic CAS claim guard that aborts a double-dispatched run."""
import pytest

from models.enrichment import WeatherReport
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
        self._range: dict = {}

    def insert(self, row):
        self._op = ("insert", row)
        return self

    def update(self, row):
        self._op = ("update", row)
        return self

    def delete(self):
        self._op = ("delete", None)
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

    def gte(self, col, val):
        self._range[(col, "gte")] = val
        return self

    def lte(self, col, val):
        self._range[(col, "lte")] = val
        return self

    def _matches(self, row):
        if not all(row.get(k) == v for k, v in self._filters.items()):
            return False
        if not all(row.get(k) in v for k, v in self._in_filters.items()):
            return False
        for (col, op), val in self._range.items():
            if op == "gte" and not row.get(col, 0) >= val:
                return False
            if op == "lte" and not row.get(col, 0) <= val:
                return False
        return True

    async def execute(self):
        op, arg = self._op
        rows = self.db.setdefault(self.name, [])
        if op == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row)
            return _Result([row])
        if op == "update":
            matched = [r for r in rows if self._matches(r)]
            for r in matched:
                r.update(arg)
            self.db.setdefault(self.name + "_updates", []).append(arg)
            return _Result(matched)
        if op == "delete":
            keep = [r for r in rows if not self._matches(r)]
            self.db[self.name] = keep
            return _Result([])
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


def _place(name, lat=35.6586, lng=139.7454):
    return PlaceResult(name=name, name_local=None, category="attraction",
                        source_type="reel_extracted", lat=lat, lng=lng,
                        confidence=0.9, evidence_quote="📍Tokyo Tower",
                        source_url="https://example.org/a", formatted_address=None)


async def _no_weather(*_a, **_k):
    return []


async def _no_transport(*_a, **_k):
    return []


async def _no_restaurant(*_a, **_k):
    return []


async def _no_narrator(*_a, **_k):
    from models.enrichment import NarrationResult
    return NarrationResult(days=[], trip_title=None, trip_summary="")


@pytest.mark.asyncio
async def test_happy_path_completes_marks_job_and_emits_result():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
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
                                       scrape=scrape, extract=extract, weather=_no_weather,
                                       transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
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
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
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
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=boom,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert "error" in out
    assert [e for e in c.events if e["event_type"] == "result"]  # never a hanging stream
    assert c.db["jobs"][0]["status"] == "failed"


@pytest.mark.asyncio
async def test_blank_day_reports_saved_with_gaps():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-03", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert len(out["itinerary"]["days"]) == 3
    assert out["itinerary"]["days"][1]["place_names"] == []
    assert out["itinerary"]["days"][2]["place_names"] == []
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_normalized_rows_on_success():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                 "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                 weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert c.db.get("places") and c.db["places"][0]["name"] == "Tokyo Tower"
    trip_places = c.db.get("trip_places")
    assert trip_places and all(tp["trip_id"] == "trip-1" for tp in trip_places)
    assert c.db.get("trip_days")
    assert c.trip_updates[-1]["status"] == "complete"


@pytest.mark.asyncio
async def test_runner_degrades_to_saved_with_gaps_when_persist_fails(monkeypatch):
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def _boom(*args, **kwargs):
        raise RuntimeError("persist db error")

    monkeypatch.setattr(runner, "persist_itinerary", _boom)
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]                       # itinerary still produced + returned
    assert any(e["event_type"] == "warning" for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"       # NOT failed — persist is non-critical


@pytest.mark.asyncio
async def test_runner_degrades_when_persist_drops_a_place():
    c = _Client(jobs=[{"id": "job-1", "status": "pending"}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower"),
                PlaceResult(name="No Coords Spot", name_local=None, category="attraction",
                            source_type="reel_extracted", lat=None, lng=None,
                            confidence=0.9, evidence_quote="📍No Coords Spot",
                            source_url="https://example.org/a", formatted_address=None)]

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]                       # itinerary still shows both places
    assert any(e["event_type"] == "warning" and "not saved" in e["message"] for e in c.events)
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"
    assert c.db["jobs"][0]["status"] == "succeeded"        # a dropped place is non-critical


@pytest.mark.asyncio
async def test_cas_abort_skips_when_job_already_claimed():
    c = _Client(jobs=[{"id": "job-1", "status": "running"}])  # already claimed by another run

    async def scrape(url):
        raise AssertionError("scrape must not run when the CAS claim is lost")

    async def extract(reel):
        raise AssertionError("extract must not run when the CAS claim is lost")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01",
                                       "2026-08-01", job_id="job-1", client=c, scrape=scrape, extract=extract,
                                       weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out == {"skipped": "job already claimed by another run"}
    assert c.events == []
    assert c.trip_updates == []
    assert c.db["jobs"][0]["status"] == "running"  # untouched — not re-claimed


@pytest.mark.asyncio
async def test_runner_persists_weather_on_trip_days():
    c = _Client(jobs=[{"id": "job-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def weather(lat, lng, dates):
        return [WeatherReport(date=d, temp_min_c=24.0, temp_max_c=31.0, precipitation_mm=0.0,
                              weather_code=2, summary="Partly cloudy, 24-31°C") for d in dates]

    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract, weather=weather,
                                transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    td = c.db["trip_days"]
    assert td and td[0].get("weather_source") == "open_meteo"
    assert td[0].get("weather_summary")
    assert any(e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # weather success does not degrade


@pytest.mark.asyncio
async def test_runner_skips_weather_when_all_places_lack_coords():
    c = _Client(jobs=[{"id": "job-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [PlaceResult(name="No Coords Spot", name_local=None, category="attraction",
                             source_type="reel_extracted", lat=None, lng=None,
                             confidence=0.9, evidence_quote="📍No Coords Spot",
                             source_url="https://example.org/a", formatted_address=None)]

    async def weather(lat, lng, dates):
        raise AssertionError("weather must not be called when centroid is None")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract, weather=weather,
                                      transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]                            # itinerary still produced
    assert not any(e["stage"] == "weather" for e in c.events)  # centroid is None → weather skipped entirely
    assert c.trip_updates[-1]["status"] == "saved_with_gaps"   # the no-coord place is dropped by persist
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_weather_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "status": "pending", "attempt_count": 0, "started_at": None}])

    async def scrape(url):
        return _reel(url)

    async def extract(reel):
        return [_place("Tokyo Tower")]

    async def weather(lat, lng, dates):
        raise RuntimeError("open-meteo down")

    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract, weather=weather,
                                      transport=_no_transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]                        # trip still produced
    assert any(e["event_type"] == "warning" and e["stage"] == "weather" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # weather failure does NOT degrade or fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_transport_legs():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 400, "code": "Ok"} for _ in range(len(coords) - 1)]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert c.db["transport_legs"], "expected transport_legs written"
    assert any(e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # transport success does not degrade


@pytest.mark.asyncio
async def test_runner_transport_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def transport(coords, *, profile="walking"): raise RuntimeError("mapbox down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather, transport=transport, restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"       # transport failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_transport_missing_token_is_non_critical(monkeypatch):
    # transport NOT injected -> the REAL fetch_directions_legs runs and reads
    # os.environ["MAPBOX_SECRET_TOKEN"] -> KeyError (before any network) -> absorbed -> warning + complete.
    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather,   # transport intentionally NOT injected
                                      restaurant=_no_restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "transport" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_restaurant_suggestions():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def restaurant(places, *, city=None):
        from models.enrichment import RestaurantCandidate
        return [RestaurantCandidate(name="Ramen X", name_local="ラーメンX", cuisine="ramen",
                                    summary="Great tonkotsu near A", lat=35.601, lng=139.701,
                                    address="Tokyo", mapbox_id="poi.1", categories=["レストラン"], distance_m=20)]
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=_no_transport, restaurant=restaurant, narrator=_no_narrator)
    rs = c.db.get("restaurant_suggestions")
    assert rs and rs[0]["summary"] == "Great tonkotsu near A"
    assert rs[0]["restaurant_place_id"] and rs[0]["near_place_id"]
    assert any(p["name"] == "Ramen X" and p["place_type"] == "restaurant" for p in c.db["places"])
    assert any(e["stage"] == "restaurants" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # restaurant success does not degrade


@pytest.mark.asyncio
async def test_runner_restaurant_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("A", lat=35.60, lng=139.70), _place("B", lat=35.62, lng=139.72)]
    async def restaurant(places, *, city=None): raise RuntimeError("mapbox/openai down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather, transport=_no_transport, restaurant=restaurant, narrator=_no_narrator)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "restaurants" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"      # restaurant failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"


@pytest.mark.asyncio
async def test_runner_persists_narration():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def narrator(days, *, city=None):
        from models.enrichment import NarrationResult, DayNarration
        return NarrationResult(days=[DayNarration(day_number=1, title="Day 1: Icons",
                                                  summary="Tokyo Tower first.")],
                               trip_title="Tokyo in a Day", trip_summary="A compact highlights run.")
    await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                job_id="job-1", client=c, scrape=scrape, extract=extract,
                                weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                narrator=narrator)
    td = c.db["trip_days"]
    assert td and td[0].get("title") == "Day 1: Icons" and td[0].get("summary")
    assert any("summary" in u and u.get("summary") == "A compact highlights run." for u in c.trip_updates)
    assert any(e["stage"] == "summarize" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # narration success does not degrade


@pytest.mark.asyncio
async def test_runner_narration_failure_is_non_critical():
    c = _Client(jobs=[{"id": "job-1", "attempt_count": 0, "started_at": None, "status": "pending"}])
    async def scrape(url): return _reel(url)
    async def extract(reel): return [_place("Tokyo Tower")]
    async def narrator(days, *, city=None): raise RuntimeError("openai down")
    out = await runner.run_generation("trip-1", "user-1", ["https://ig/r1"], "2026-08-01", "2026-08-01",
                                      job_id="job-1", client=c, scrape=scrape, extract=extract,
                                      weather=_no_weather, transport=_no_transport, restaurant=_no_restaurant,
                                      narrator=narrator)
    assert out["itinerary"]["days"]
    assert any(e["event_type"] == "warning" and e["stage"] == "summarize" for e in c.events)
    assert c.trip_updates[-1]["status"] == "complete"   # narration failure does NOT degrade/fail
    assert c.db["jobs"][0]["status"] == "succeeded"
