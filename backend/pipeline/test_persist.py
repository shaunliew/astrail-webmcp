import pytest

from models.enrichment import WeatherReport
from models.place import CanonicalPlace
from pipeline import persist
from pipeline.feasibility import group_places_by_day


def _cp(name, lat, lng, *, category="attraction", source_type="reel_extracted",
        aliases=None, name_local=None):
    return CanonicalPlace(
        name=name, name_local=name_local, category=category, source_type=source_type,
        lat=lat, lng=lng, confidence=0.9, evidence_quote=f"📍{name}",
        source_url="https://example.org/a", formatted_address=None,
        city_or_region_guess="Tokyo", aliases=aliases or [name],
        evidence_quotes=[f"📍{name}"], times_referenced=1,
    )


# --- pure mappers -----------------------------------------------------------
def test_place_type_maps_transport_to_station_and_unknown_to_other():
    assert persist._place_type("transport") == "station"
    assert persist._place_type("restaurant") == "restaurant"
    assert persist._place_type("Attraction") == "attraction"   # case-insensitive
    assert persist._place_type("station") == "station"          # already valid passes through
    assert persist._place_type("nonsense") == "other"


def test_source_summary_never_contains_blocked_keys():
    p = _cp("X", 1.0, 2.0)
    ss = persist._source_summary(p)
    assert isinstance(ss, dict)
    for blocked in ("caption", "transcript", "trip_id", "user_id", "raw_payload"):
        assert blocked not in ss


def test_group_places_by_day_is_identity_based_not_name_based():
    # Two DISTINCT places sharing the literal name "7-Eleven" but far apart still land in
    # groups keyed by object identity, not merged/confused by name.
    a = _cp("7-Eleven", 35.0, 139.0)
    b = _cp("7-Eleven", 35.06, 139.06)   # ~7.5km away
    groups = group_places_by_day([a, b], ["2026-08-01", "2026-08-02"])
    all_places = [p for _, group in groups for p in group]
    assert all_places.count(a) == 1 and all_places.count(b) == 1
    assert a is not b


# --- async fake client ------------------------------------------------------
class _Result:
    def __init__(self, data): self.data = data


class _Table:
    def __init__(self, name, db):
        self.name, self.db = name, db
        self._op = None; self._f = {}; self._range = {}; self._in = {}

    def insert(self, row): self._op = ("insert", row); return self
    def update(self, row): self._op = ("update", row); return self
    def delete(self): self._op = ("delete", None); return self
    def select(self, *_): self._op = ("select", None); return self
    def eq(self, c, v): self._f[c] = v; return self
    def gte(self, c, v): self._range[(c, "gte")] = v; return self
    def lte(self, c, v): self._range[(c, "lte")] = v; return self
    def in_(self, c, values): self._in[c] = list(values); return self

    def _match(self, r):
        if not all(r.get(k) == v for k, v in self._f.items()):
            return False
        if not all(r.get(k) in vs for k, vs in self._in.items()):
            return False
        for (c, op), v in self._range.items():
            if op == "gte" and not r.get(c, 0) >= v: return False
            if op == "lte" and not r.get(c, 0) <= v: return False
        return True

    async def execute(self):
        op, arg = self._op
        rows = self.db.setdefault(self.name, [])
        if op == "insert":
            row = {"id": f"{self.name}-{len(rows) + 1}", **arg}
            rows.append(row); return _Result([row])
        if op == "update":
            matched = [r for r in rows if self._match(r)]
            for r in matched:
                r.update(arg)
            return _Result(matched)
        if op == "delete":
            keep = [r for r in rows if not self._match(r)]
            self.db[self.name] = keep; return _Result([])
        return _Result([r for r in rows if self._match(r)])


class _Client:
    def __init__(self, db=None): self.db = db if db is not None else {}
    def table(self, name): return _Table(name, self.db)


@pytest.mark.asyncio
async def test_persist_writes_places_trip_places_and_days():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454),
                 _cp("Senso-ji", 35.7148, 139.7967)]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])

    assert dropped == 0
    assert len(c.db["places"]) == 2
    tps = c.db["trip_places"]
    assert len(tps) == 2
    assert {tp["source_type"] for tp in tps} == {"reel_extracted"}
    assert all(tp["trip_id"] == "trip-1" and tp["place_id"] for tp in tps)
    assert {tp["day_number"] for tp in tps} == {1}
    assert {tp["sort_order"] for tp in tps} == {0, 1}
    assert len(c.db["trip_days"]) == 1 and c.db["trip_days"][0]["day_number"] == 1


@pytest.mark.asyncio
async def test_persist_drops_no_coord_places():
    c = _Client()
    canonical = [_cp("Has Coords", 35.0, 139.0), _cp("No Coords", None, None)]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
    assert dropped == 1
    assert len(c.db["places"]) == 1 and c.db["places"][0]["name"] == "Has Coords"
    assert len(c.db["trip_places"]) == 1


@pytest.mark.asyncio
async def test_dedup_on_write_reuses_existing_nearby_place():
    # A pre-existing global place ~10m away with the same name → reused, not re-inserted.
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower"], "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541)]  # ~1m away
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
    assert len(c.db["places"]) == 1  # NOT a new row — flywheel reuse
    assert c.db["trip_places"][0]["place_id"] == "existing-1"


@pytest.mark.asyncio
async def test_two_canonical_resolving_to_same_place_link_once():
    # Both canonical places match the SAME existing global place (name/alias overlap + <500m) →
    # exactly ONE trip_places row (guards trip_places UNIQUE(trip_id, place_id)).
    c = _Client({"places": [{"id": "existing-1", "name": "Tokyo Tower",
                             "aliases": ["Tokyo Tower", "東京タワー"],
                             "lat": 35.6586, "lng": 139.7454}]})
    canonical = [_cp("Tokyo Tower", 35.65861, 139.74541),
                 _cp("東京タワー", 35.65859, 139.74539, name_local="東京タワー",
                     aliases=["東京タワー"])]
    dropped = await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
    assert dropped == 1  # the second canonical place resolved to the SAME place_id, skipped
    assert len(c.db.get("places", [])) == 1
    assert len(c.db["trip_places"]) == 1  # both resolved to existing-1 → linked once, no UNIQUE crash


@pytest.mark.asyncio
async def test_persist_is_retry_safe_deletes_prior_rows():
    c = _Client()
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454)]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])  # retry
    assert len(c.db["trip_places"]) == 1   # not doubled
    assert len(c.db["trip_days"]) == 1
    assert len(c.db["places"]) == 1        # dedup reused the place from attempt 1


@pytest.mark.asyncio
async def test_persist_assigns_distinct_days_by_identity_not_name():
    # Two DISTINCT canonical places sharing the literal name "7-Eleven", ~6km apart, over a
    # 2-day span. Name-based day assignment (the old `_day_lookup`) would collapse both onto
    # whichever day the FIRST "7-Eleven" occupied in the itinerary's place_names list — a
    # silently-wrong result. Identity-based assignment (`group_places_by_day`) must place them
    # on their own geo-chain days.
    c = _Client()
    near = _cp("7-Eleven", 35.6586, 139.7454)
    far = _cp("7-Eleven", 35.70, 139.80)   # ~6km away
    canonical = [near, far]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01", "2026-08-02"])

    tps = c.db["trip_places"]
    assert len(tps) == 2
    assert len({tp["day_number"] for tp in tps}) == 2   # DIFFERENT days, not both on day 1


@pytest.mark.asyncio
async def test_persist_weather_updates_trip_days_by_date():
    c = _Client({"trip_days": [
        {"id": "d1", "trip_id": "trip-1", "day_number": 1, "day_date": "2026-08-01"},
        {"id": "d2", "trip_id": "trip-1", "day_number": 2, "day_date": "2026-08-02"},
    ]})
    reports = [WeatherReport(date="2026-08-01", temp_min_c=24.0, temp_max_c=31.0,
                             precipitation_mm=0.0, weather_code=2, summary="Partly cloudy, 24-31°C")]
    await persist.persist_weather(c, "trip-1", reports)
    d1 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-01"][0]
    assert d1["weather_source"] == "open_meteo"
    assert d1["weather_summary"].startswith("Partly cloudy")
    assert d1["weather_payload"]["weather_code"] == 2
    d2 = [d for d in c.db["trip_days"] if d["day_date"] == "2026-08-02"][0]
    assert "weather_source" not in d2  # untouched day (no report)


@pytest.mark.asyncio
async def test_persist_transport_inserts_legs_per_consecutive_pair():
    # 3 stops on day 1 → 2 legs; day 2 has 1 stop → 0 legs.
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 1, "sort_order": 2},
            {"trip_id": "trip-1", "place_id": "pd", "day_number": 2, "sort_order": 0},
        ],
        "trip_days": [
            {"id": "d1", "trip_id": "trip-1", "day_number": 1},
            {"id": "d2", "trip_id": "trip-1", "day_number": 2},
        ],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.62, "lng": 139.72}, {"id": "pd", "lat": 35.70, "lng": 139.80},
        ],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 600, "distance_m": 800, "code": "Ok"} for _ in range(len(coords) - 1)]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 2
    legs = c.db["transport_legs"]
    assert len(legs) == 2
    assert {l["leg_order"] for l in legs} == {0, 1}
    assert all(l["trip_id"] == "trip-1" and l["trip_day_id"] == "d1" for l in legs)
    assert all(l["transport_mode"] == "walk" and l["routing_profile"] == "walking" for l in legs)
    assert all(l["status"] == "ok" and l["duration_seconds"] == 600 for l in legs)
    frm_to = {(l["from_place_id"], l["to_place_id"]) for l in legs}
    assert frm_to == {("pa", "pb"), ("pb", "pc")}


@pytest.mark.asyncio
async def test_persist_transport_marks_no_route():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 40.0, "lng": 145.0}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": None, "distance_m": None, "code": "NoRoute"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and c.db["transport_legs"][0]["status"] == "no_route"


@pytest.mark.asyncio
async def test_persist_transport_retry_safe_deletes_first():
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 35.61, "lng": 139.71}],
        "transport_legs": [{"trip_id": "trip-1", "leg_order": 0, "from_place_id": "x", "to_place_id": "y"}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 1, "distance_m": 1, "code": "Ok"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 1 and len(c.db["transport_legs"]) == 1   # stale leg deleted, not appended


@pytest.mark.asyncio
async def test_persist_transport_deletes_stale_legs_when_trip_places_empty():
    # A pre-existing stale transport_legs row from an earlier run, but THIS run's trip_places
    # now resolves to zero rows (e.g. every place got dropped on a re-run) — the early return
    # on empty tps must still hit the delete-first path, not leave the stale legs behind.
    c = _Client({
        "transport_legs": [{"trip_id": "trip-1", "leg_order": 0, "from_place_id": "x", "to_place_id": "y"}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 1, "distance_m": 1, "code": "Ok"}]
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 0
    assert c.db["transport_legs"] == []


@pytest.mark.asyncio
async def test_persist_transport_isolates_per_day_failure():
    # Day 1's fetch succeeds; day 2's fetch raises. Day 1's real legs, day 2's `failed` rows,
    # and (implicitly) any later day's real legs must ALL persist — no silent partial drop.
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 2, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pd", "day_number": 2, "sort_order": 1},
        ],
        "trip_days": [
            {"id": "d1", "trip_id": "trip-1", "day_number": 1},
            {"id": "d2", "trip_id": "trip-1", "day_number": 2},
        ],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.62, "lng": 139.72}, {"id": "pd", "lat": 35.63, "lng": 139.73},
        ],
    })

    async def fake_legs(coords, *, profile="walking"):
        if coords[0] == (35.62, 139.72):   # day 2's first coord — simulate a Mapbox blip
            raise RuntimeError("Mapbox Directions request failed: ConnectError")
        return [{"duration_s": 600, "distance_m": 800, "code": "Ok"} for _ in range(len(coords) - 1)]

    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    legs = c.db["transport_legs"]
    day1_legs = [leg for leg in legs if leg["trip_day_id"] == "d1"]
    day2_legs = [leg for leg in legs if leg["trip_day_id"] == "d2"]
    assert day1_legs and all(leg["status"] == "ok" for leg in day1_legs)
    assert day2_legs and all(leg["status"] == "failed" for leg in day2_legs)
    assert all(leg["duration_seconds"] is None and leg["distance_meters"] is None for leg in day2_legs)
    assert written == len(day1_legs) + len(day2_legs)


@pytest.mark.asyncio
async def test_persist_transport_long_walk_becomes_transit_hint():
    # day 1: leg0 short (walk), leg1 >2km (transit_hint with a warning; walking numbers retained).
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
            {"trip_id": "trip-1", "place_id": "pc", "day_number": 1, "sort_order": 2},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [
            {"id": "pa", "lat": 35.60, "lng": 139.70}, {"id": "pb", "lat": 35.61, "lng": 139.71},
            {"id": "pc", "lat": 35.70, "lng": 139.80},
        ],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 300, "distance_m": 500, "code": "Ok"},        # short -> walk
                {"duration_s": 5640, "distance_m": 10054, "code": "Ok"}]     # 10km -> transit_hint
    written = await persist.persist_transport(c, "trip-1", fetch_legs=fake_legs)
    assert written == 2
    legs = {leg["leg_order"]: leg for leg in c.db["transport_legs"]}
    assert legs[0]["transport_mode"] == "walk" and legs[0]["warning"] is None
    assert legs[1]["transport_mode"] == "transit_hint"
    assert legs[1]["warning"] and "transit" in legs[1]["warning"]
    assert legs[1]["routing_profile"] == "walking"       # numbers are still the real walking route
    assert legs[1]["distance_meters"] == 10054


@pytest.mark.asyncio
async def test_persist_transport_driving_profile_never_transit_hints():
    # a long leg on a non-walking profile is NOT a transit hint (driving a long leg is normal).
    c = _Client({
        "trip_places": [
            {"trip_id": "trip-1", "place_id": "pa", "day_number": 1, "sort_order": 0},
            {"trip_id": "trip-1", "place_id": "pb", "day_number": 1, "sort_order": 1},
        ],
        "trip_days": [{"id": "d1", "trip_id": "trip-1", "day_number": 1}],
        "places": [{"id": "pa", "lat": 35.6, "lng": 139.7}, {"id": "pb", "lat": 35.7, "lng": 139.8}],
    })
    async def fake_legs(coords, *, profile="walking"):
        return [{"duration_s": 900, "distance_m": 10054, "code": "Ok"}]
    await persist.persist_transport(c, "trip-1", profile="driving", fetch_legs=fake_legs)
    leg = c.db["transport_legs"][0]
    assert leg["transport_mode"] == "drive" and leg["warning"] is None


# --- persist_restaurants ----------------------------------------------------
from models.enrichment import RestaurantCandidate


def _rcand(name, lat, lng, *, name_local="ラーメン", summary="tasty"):
    return RestaurantCandidate(name=name, name_local=name_local, cuisine="ramen", summary=summary,
                               lat=lat, lng=lng, address="Tokyo", mapbox_id="poi.1",
                               categories=["レストラン"], distance_m=25)


async def _seed_two_places_one_day(c):
    canonical = [_cp("Tokyo Tower", 35.6586, 139.7454), _cp("Senso-ji", 35.7148, 139.7967)]
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])


@pytest.mark.asyncio
async def test_persist_restaurants_writes_row_place_and_near_id():
    c = _Client()
    await _seed_two_places_one_day(c)
    tower_id = next(p["id"] for p in c.db["places"] if p["name"] == "Tokyo Tower")

    async def suggest(places, *, city=None):
        return [_rcand("Ramen Near Tower", 35.6587, 139.7455)]   # right next to Tokyo Tower

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 1
    rs = c.db["restaurant_suggestions"][0]
    assert rs["summary"] == "tasty" and rs["cuisine"] == "ramen"
    assert rs["near_place_id"] == tower_id                        # nearest day place
    assert rs["restaurant_place_id"]                              # a places row was created/reused
    assert rs["preference_match_json"] == {}
    assert rs["evidence_json"]["mapbox_id"] == "poi.1"
    rest_place = next(p for p in c.db["places"] if p["id"] == rs["restaurant_place_id"])
    assert rest_place["name"] == "Ramen Near Tower" and rest_place["place_type"] == "restaurant"


@pytest.mark.asyncio
async def test_persist_restaurants_passes_city_from_places():
    c = _Client()
    await _seed_two_places_one_day(c)                             # _cp sets city_or_region_guess="Tokyo"
    seen = {}

    async def suggest(places, *, city=None):
        seen["city"] = city
        return []

    await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert seen["city"] == "Tokyo"


@pytest.mark.asyncio
async def test_persist_restaurants_retry_safe_deletes_first():
    c = _Client({"restaurant_suggestions": [{"id": "stale", "trip_id": "trip-1", "summary": "old"}]})
    await _seed_two_places_one_day(c)

    async def suggest(places, *, city=None):
        return []                                                # a re-run that now yields nothing

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 0 and c.db["restaurant_suggestions"] == []  # stale row cleared


@pytest.mark.asyncio
async def test_persist_restaurants_no_trip_places_returns_zero():
    c = _Client()

    async def suggest(places, *, city=None):
        raise AssertionError("suggest must not be called with no trip_places")

    assert await persist.persist_restaurants(c, "trip-1", suggest=suggest) == 0


@pytest.mark.asyncio
async def test_persist_restaurants_distinct_mapbox_ids_not_merged():
    # Two chain branches within 500m whose LLM name_en collapses to the SAME "Gusto" but with
    # DIFFERENT mapbox_ids must get SEPARATE places rows. The itinerary flywheel's name+geo dedup
    # would mis-merge them (same "gusto" key + <500m); restaurant dedup is by mapbox_id.
    c = _Client()
    await _seed_two_places_one_day(c)
    b1 = RestaurantCandidate(name="Gusto", name_local="ガスト 渋谷店", cuisine="family",
                             summary="branch one", lat=35.6586, lng=139.7454, address="A",
                             mapbox_id="poi.a", categories=["レストラン"], distance_m=10)
    b2 = RestaurantCandidate(name="Gusto", name_local="ガスト 道玄坂店", cuisine="family",
                             summary="branch two", lat=35.6588, lng=139.7456, address="B",
                             mapbox_id="poi.b", categories=["レストラン"], distance_m=30)

    async def suggest(places, *, city=None):
        return [b1, b2]

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 2
    rest_ids = {r["restaurant_place_id"] for r in c.db["restaurant_suggestions"]}
    assert len(rest_ids) == 2, "distinct-mapbox_id branches must not merge into one places row"
    by_pid = {p["id"]: p for p in c.db["places"]}
    assert {by_pid[pid]["source_summary"].get("mapbox_id") for pid in rest_ids} == {"poi.a", "poi.b"}


@pytest.mark.asyncio
async def test_persist_restaurants_same_mapbox_id_reuses_place():
    # The same POI suggested twice (near two stops, or on a retry) dedups to ONE places row.
    c = _Client()
    await _seed_two_places_one_day(c)
    places_before = len(c.db["places"])
    cand = _rcand("Ramen X", 35.70, 139.75)          # mapbox_id="poi.1" (default)

    async def suggest(places, *, city=None):
        return [cand, cand]

    written = await persist.persist_restaurants(c, "trip-1", suggest=suggest)
    assert written == 2                                # two suggestion rows...
    rest_ids = {r["restaurant_place_id"] for r in c.db["restaurant_suggestions"]}
    assert len(rest_ids) == 1                          # ...sharing ONE places row (deduped by mapbox_id)
    assert len(c.db["places"]) == places_before + 1
