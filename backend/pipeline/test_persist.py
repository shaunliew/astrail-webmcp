import pytest

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
        self._op = None; self._f = {}; self._range = {}

    def insert(self, row): self._op = ("insert", row); return self
    def delete(self): self._op = ("delete", None); return self
    def select(self, *_): self._op = ("select", None); return self
    def eq(self, c, v): self._f[c] = v; return self
    def gte(self, c, v): self._range[(c, "gte")] = v; return self
    def lte(self, c, v): self._range[(c, "lte")] = v; return self

    def _match(self, r):
        if not all(r.get(k) == v for k, v in self._f.items()):
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
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])

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
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
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
    await persist.persist_itinerary(c, "trip-1", canonical, ["2026-08-01"])
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
