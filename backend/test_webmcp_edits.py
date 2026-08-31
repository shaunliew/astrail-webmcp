"""Keyless route tests for owner-checked WebMCP itinerary edits.

The fake models PostgREST's chained filters and mutates an in-memory database. No test
constructs a live Supabase client or makes a network request.
"""
from __future__ import annotations

import asyncio
import os
from datetime import date
from fnmatch import fnmatchcase

import httpx
import pytest
from fastapi import Request

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

import main  # noqa: E402
from models.geocode import GeocodeResult  # noqa: E402
from rate_limit import get_current_user_id_stashed, limiter  # noqa: E402


_TRIP_ID = "11111111-1111-1111-1111-111111111111"
_OTHER_TRIP_ID = "22222222-2222-2222-2222-222222222222"
_TARGET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
_NEW_PLACE_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff"


class _Result:
    def __init__(self, data):
        self.data = data


_DEFAULT_OWNER_RESULT = object()

# The column list `_find_requested_place_coordinates` selects — the fingerprint of the FREE
# exact-name lookup, distinct from the geographic-context read that shares most of its columns.
_NAME_LOOKUP_SELECT = "id,name,aliases,lat,lng,city,country,country_code"


def _like_to_fnmatch(pattern: str) -> str:
    """Translate a Postgres LIKE pattern to an fnmatch one, honouring backslash escapes.

    The fake used to do a blind `%`->`*` / `_`->`?` swap, which cannot tell a wildcard from an
    escaped literal — so it would have passed a name-lookup test whether or not the caller escaped
    the name at all. `\%` and `\_` are literals here, and `*`/`?`/`[` coming from a place name are
    wrapped in a character class so fnmatch does not re-read them as wildcards of its own.
    """
    out: list[str] = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if char == "\\" and index + 1 < len(pattern):
            nxt = pattern[index + 1]
            out.append(f"[{nxt}]" if nxt in "*?[" else nxt)
            index += 2
            continue
        if char == "%":
            out.append("*")
        elif char == "_":
            out.append("?")
        elif char in "*?[":
            out.append(f"[{char}]")
        else:
            out.append(char)
        index += 1
    return "".join(out).casefold()


class _Table:
    """Small stateful subset of the async Supabase/PostgREST builder."""

    def __init__(self, client, name):
        self.client = client
        self.name = name
        self._op = "select"
        self._payload = None
        self._select = "*"
        self._filters: dict[str, object] = {}
        self._orders: list[tuple[str, bool]] = []
        self._single = False
        self._limit: int | None = None
        self._ranges: list[tuple[str, str, object]] = []
        self._in_filters: dict[str, set[object]] = {}
        self._ilike_filters: dict[str, str] = {}

    def select(self, columns="*"):
        self._op = "select"
        self._select = columns
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = dict(payload)
        return self

    def insert(self, payload):
        self._op = "insert"
        self._payload = dict(payload)
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, column, value):
        self._filters[column] = value
        return self

    def in_(self, column, values):
        self._in_filters[column] = set(values)
        return self

    def ilike(self, column, pattern):
        self._ilike_filters[column] = pattern
        return self

    def gte(self, column, value):
        self._ranges.append((column, "gte", value))
        return self

    def lte(self, column, value):
        self._ranges.append((column, "lte", value))
        return self

    def order(self, column, *, desc=False):
        self._orders.append((column, desc))
        return self

    def maybe_single(self):
        self._single = True
        return self

    def limit(self, count):
        self._limit = count
        return self

    def _matches(self, row):
        if not all(row.get(key) == value for key, value in self._filters.items()):
            return False
        if not all(row.get(key) in values for key, values in self._in_filters.items()):
            return False
        for column, pattern in self._ilike_filters.items():
            if not fnmatchcase(str(row.get(column, "")).casefold(), _like_to_fnmatch(pattern)):
                return False
        for column, op, value in self._ranges:
            candidate = row.get(column)
            if candidate is None:
                return False
            if op == "gte" and candidate < value:
                return False
            if op == "lte" and candidate > value:
                return False
        return True

    def _ordered(self, rows):
        ordered = list(rows)
        for column, desc in reversed(self._orders):
            ordered.sort(
                key=lambda row: (row.get(column) is None, row.get(column)),
                reverse=desc,
            )
        return ordered

    async def execute(self):
        self.client.calls.append({
            "table": self.name,
            "op": self._op,
            "select": self._select,
            "filters": dict(self._filters),
            "payload": self._payload,
            "orders": list(self._orders),
        })

        if (
            self.name == "trips"
            and self._op == "select"
            and self._select == "user_id"
            and self.client.owner_result is not _DEFAULT_OWNER_RESULT
        ):
            return self.client.owner_result

        rows = self.client.db.setdefault(self.name, [])
        matched = self._ordered(row for row in rows if self._matches(row))
        if self._limit is not None:
            matched = matched[: self._limit]

        if self._op == "insert":
            row = dict(self._payload)
            if "id" not in row:
                row["id"] = self.client.next_id(self.name)
            if self.name == "trip_places":
                row.setdefault("created_at", "2026-08-27T00:00:00+00:00")
            rows.append(row)
            return _Result([row])
        if self._op == "update":
            for row in matched:
                row.update(self._payload)
            return _Result(matched)
        if self._op == "delete":
            self.client.db[self.name] = [row for row in rows if row not in matched]
            return _Result(matched)
        if self._single:
            # postgrest 2.31.0 returns a bare None when maybe_single finds zero rows.
            return _Result(matched[0]) if matched else None
        return _Result(matched)


class _Client:
    def __init__(self, db, *, owner_result=_DEFAULT_OWNER_RESULT):
        self.db = db
        self.owner_result = owner_result
        self.calls: list[dict] = []
        self._ids = {"places": 0, "trip_places": 0}

    def table(self, name):
        return _Table(self, name)

    def next_id(self, table):
        self._ids[table] = self._ids.get(table, 0) + 1
        if table == "places":
            return _NEW_PLACE_ID
        return f"99999999-9999-9999-9999-{self._ids[table]:012d}"


def _trip_place(row_id, trip_id, day_number, sort_order, *, place_suffix="1"):
    return {
        "id": row_id,
        "trip_id": trip_id,
        "place_id": f"00000000-0000-0000-0000-00000000000{place_suffix}",
        "source_type": "reel_extracted",
        "evidence_json": {"quote": "source"},
        "day_number": day_number,
        "sort_order": sort_order,
        "created_at": "2026-08-27T00:00:00+00:00",
    }


def _seed_owned_trip(
    db,
    *,
    status="complete",
    user_id="user-1",
    start_date="2026-08-27",
    end_date="2026-08-29",
):
    db.setdefault("trips", []).append({
        "id": _TRIP_ID,
        "user_id": user_id,
        "status": status,
        "destination_hint": "Osaka",
        "inferred_destination": "Osaka, Japan",
        "start_date": start_date,
        "end_date": end_date,
        "origin_city": None,
        "budget_level": None,
        "adult_count": 1,
        "child_count": 0,
        "room_count": 1,
        "occupancy_json": {},
        "hotel_preference_json": {},
        "persona_snapshot_json": {},
        "preference_sources": [],
        "preference_summary": None,
        "title": "Three days in Osaka",
        "summary": None,
        "tradeoffs": {"notes": [], "comparisons": []},
        "created_at": "2026-08-27T00:00:00+00:00",
        "updated_at": "2026-08-27T00:00:00+00:00",
    })


def _client(monkeypatch, db, *, user_id="user-1", owner_result=_DEFAULT_OWNER_RESULT):
    fake = _Client(db, owner_result=owner_result)
    monkeypatch.setattr(main, "WEBMCP_EDITS_ENABLED", True)

    async def _get_client():
        return fake

    async def _auth(request: Request):
        request.state.user_id = user_id
        return user_id

    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    main.app.dependency_overrides[get_current_user_id_stashed] = _auth
    client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    )
    client.fake_supabase = fake  # type: ignore[attr-defined]
    return client


@pytest.fixture(autouse=True)
def _reset_app(monkeypatch):
    async def _transport_stub(client, trip_id):
        return 0

    async def _narration_must_be_explicit(client, trip_id, user_id):
        raise AssertionError("persist_narration was called outside an explicit replan test")

    # Every route test stays keyless even after structural edits start refreshing routes.
    monkeypatch.setattr(main, "persist_transport", _transport_stub, raising=False)
    monkeypatch.setattr(main, "persist_narration", _narration_must_be_explicit, raising=False)
    # add_place now geocodes an unknown name. Drop the token unconditionally so a developer's
    # exported MAPBOX_SECRET_TOKEN can never turn an offline route test into a paid live call;
    # the tests that exercise the lookup put a fake one back via `_stub_geocoder`.
    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    limiter.reset()
    yield
    main.app.dependency_overrides.clear()
    limiter.reset()


class _GeocodeSpy:
    """Stands in for `geocode.mapbox_forward.strict_forward_geocode` — the ONLY paid call on the
    add path. Records every invocation so a test can assert one happened with the trip's bias, or
    that none happened at all (the local-reuse path must never cost money).

    It RECORDS rather than raises on an unwanted call, deliberately. An `AssertionError` raised in
    here is swallowed by `geocode_requested_place`'s catch-all (which exists so a provider blip
    cannot fail the add), so a spy that policed itself by raising would report a clean pass while
    the route spent money. The assertion has to live in the test body, against `spy.calls`.
    """

    def __init__(self, *, result=None, raises=None, sleep=None):
        self.result = result
        self.raises = raises
        self.sleep = sleep
        self.calls: list[dict] = []

    async def __call__(self, query, **kwargs):
        self.calls.append({"query": query, **kwargs})
        if self.sleep is not None:
            await asyncio.sleep(self.sleep)
        if self.raises is not None:
            raise self.raises
        return self.result


def _stub_geocoder(monkeypatch, **kwargs) -> _GeocodeSpy:
    """Install the spy AND a fake token, so a test that asserts "no paid call" is asserting the
    route's own gating rather than a missing credential."""
    import geocode.mapbox_forward as mapbox_forward

    spy = _GeocodeSpy(**kwargs)
    monkeypatch.setattr(mapbox_forward, "strict_forward_geocode", spy)
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "sk.fake-test-token")
    return spy


def _geo(lat, lng, *, country_code="JP", country_name="Japan") -> GeocodeResult:
    return GeocodeResult(lat=lat, lng=lng, country_code=country_code, country_name=country_name)


def _seed_context_place(db, *, name, lat, lng, city, country, country_code) -> str:
    """One stop already on the trip — the geographic context every geocode is biased by."""
    place_id = "00000000-0000-0000-0000-000000000001"
    db["places"] = [{
        "id": place_id,
        "name": name,
        "aliases": [],
        "lat": lat,
        "lng": lng,
        "city": city,
        "country": country,
        "country_code": country_code,
    }]
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]
    db["trip_places"][0]["place_id"] = place_id
    return place_id


def _seed_osaka_places(db) -> str:
    return _seed_context_place(
        db, name="Osaka Castle", lat=34.6873, lng=135.5262,
        city="Osaka", country="Japan", country_code="JP",
    )


@pytest.mark.parametrize("method", ["patch", "delete"])
async def test_edit_routes_are_404_when_feature_flag_is_off(monkeypatch, method):
    monkeypatch.setattr(main, "WEBMCP_EDITS_ENABLED", False, raising=False)

    async def _must_not_touch_db():
        raise AssertionError("feature-off route touched Supabase")

    monkeypatch.setattr(main, "get_supabase_client", _must_not_touch_db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await getattr(client, method)(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}",
            **({"json": {"sort_order": 0}} if method == "patch" else {}),
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "Not found"


async def test_non_owner_is_404_not_403(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, user_id="user-2")
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}", json={"sort_order": 1}
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "Trip not found"
    assert db["trip_places"][0]["sort_order"] == 0


@pytest.mark.parametrize("owner_result", [None, _Result(None)])
async def test_owner_none_and_owner_data_none_are_both_404(monkeypatch, owner_result):
    db = {"trips": [], "trip_places": [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]}

    async with _client(monkeypatch, db, owner_result=owner_result) as client:
        response = await client.delete(f"/trips/{_TRIP_ID}/places/{_TARGET_ID}")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert len(db["trip_places"]) == 1


async def test_mismatched_trip_and_trip_place_pair_is_404(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_places"] = [_trip_place(_TARGET_ID, _OTHER_TRIP_ID, 1, 0)]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}", json={"sort_order": 1}
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert db["trip_places"][0]["trip_id"] == _OTHER_TRIP_ID


async def test_generating_trip_is_409_trip_not_editable(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, status="generating")
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}", json={"sort_order": 1}
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"
    assert db["trip_places"][0]["sort_order"] == 0


async def test_running_job_is_409_trip_not_editable(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]
    db["jobs"] = [{"id": "job-1", "trip_id": _TRIP_ID, "status": "running"}]

    async with _client(monkeypatch, db) as client:
        response = await client.delete(f"/trips/{_TRIP_ID}/places/{_TARGET_ID}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"
    assert len(db["trip_places"]) == 1


async def test_patch_rejects_an_empty_body(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}", json={}
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_patch_move_resequences_both_days_densely(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, status="saved_with_gaps")
    db["trip_places"] = [
        _trip_place("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", _TRIP_ID, 1, 0, place_suffix="2"),
        _trip_place(_TARGET_ID, _TRIP_ID, 1, 1),
        _trip_place("cccccccc-cccc-cccc-cccc-cccccccccccc", _TRIP_ID, 1, 4, place_suffix="3"),
        _trip_place("dddddddd-dddd-dddd-dddd-dddddddddddd", _TRIP_ID, 2, 0, place_suffix="4"),
        _trip_place("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", _TRIP_ID, 2, 5, place_suffix="5"),
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}",
            json={"day_number": 2, "sort_order": 1},
        )

    assert response.status_code == 200
    assert response.json()["days_touched"] == [1, 2]
    assert response.json()["trip_place"]["id"] == _TARGET_ID
    assert response.json()["trip_place"]["day_number"] == 2
    assert response.json()["trip_place"]["sort_order"] == 1

    by_day = {
        day: [(row["id"], row["sort_order"]) for row in db["trip_places"] if row["day_number"] == day]
        for day in (1, 2)
    }
    assert sorted(by_day[1], key=lambda item: item[1]) == [
        ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0),
        ("cccccccc-cccc-cccc-cccc-cccccccccccc", 1),
    ]
    assert sorted(by_day[2], key=lambda item: item[1]) == [
        ("dddddddd-dddd-dddd-dddd-dddddddddddd", 0),
        (_TARGET_ID, 1),
        ("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", 2),
    ]


async def test_delete_resequences_the_touched_day_densely(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_places"] = [
        _trip_place("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", _TRIP_ID, 1, 0, place_suffix="2"),
        _trip_place(_TARGET_ID, _TRIP_ID, 1, 2),
        _trip_place("cccccccc-cccc-cccc-cccc-cccccccccccc", _TRIP_ID, 1, 6, place_suffix="3"),
        _trip_place("dddddddd-dddd-dddd-dddd-dddddddddddd", _TRIP_ID, 2, 4, place_suffix="4"),
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.delete(f"/trips/{_TRIP_ID}/places/{_TARGET_ID}")

    assert response.status_code == 200
    assert response.json() == {
        "removed_id": _TARGET_ID,
        "days_touched": [1],
        "routes_refreshed": True,
    }
    assert [(row["id"], row["sort_order"]) for row in db["trip_places"] if row["day_number"] == 1] == [
        ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0),
        ("cccccccc-cccc-cccc-cccc-cccccccccccc", 1),
    ]
    # Untouched days are not normalized as a side effect.
    assert next(row for row in db["trip_places"] if row["day_number"] == 2)["sort_order"] == 4


async def test_add_place_is_404_when_feature_flag_is_off(monkeypatch):
    monkeypatch.setattr(main, "WEBMCP_EDITS_ENABLED", False, raising=False)

    async def _must_not_touch_db():
        raise AssertionError("feature-off route touched Supabase")

    monkeypatch.setattr(main, "get_supabase_client", _must_not_touch_db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1, "lat": 34.6654, "lng": 135.4323},
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_add_place_non_owner_is_404_not_403(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, user_id="user-2")

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1, "lat": 34.6654, "lng": 135.4323},
        )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert db.get("trip_places", []) == []


async def test_add_place_rejects_generating_trip(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, status="generating")

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1, "lat": 34.6654, "lng": 135.4323},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"
    assert db.get("trip_places", []) == []


async def test_add_place_rejects_running_job(monkeypatch):
    db: dict = {"jobs": [{"id": "job-1", "trip_id": _TRIP_ID, "status": "running"}]}
    _seed_owned_trip(db)

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1, "lat": 34.6654, "lng": 135.4323},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"
    assert db.get("trip_places", []) == []


async def test_add_place_requires_resolvable_coordinates(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["places"] = [{
        "id": "00000000-0000-0000-0000-000000000001",
        "name": "Osaka Castle",
        "aliases": [],
        "lat": 34.6873,
        "lng": 135.5262,
        "city": "Osaka",
        "country": "Japan",
        "country_code": "JP",
    }]
    db["trip_places"] = [_trip_place(_TARGET_ID, _TRIP_ID, 1, 0)]

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "supply both lat and lng" in response.json()["error"]["message"].lower()
    assert len(db["trip_places"]) == 1


async def test_add_place_reuses_trip_location_and_resequences_dense(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, status="saved_with_gaps")
    castle_place_id = "00000000-0000-0000-0000-000000000001"
    usj_place_id = "00000000-0000-0000-0000-000000000002"
    db["places"] = [
        {
            "id": castle_place_id,
            "name": "Osaka Castle",
            "aliases": [],
            "lat": 34.6873,
            "lng": 135.5262,
            "city": "Osaka",
            "country": "Japan",
            "country_code": "JP",
        },
        {
            "id": usj_place_id,
            "name": "Universal Studios Japan",
            "aliases": ["USJ"],
            "lat": 34.6654,
            "lng": 135.4323,
            "city": "Osaka",
            "country": "Japan",
            "country_code": "JP",
        },
    ]
    db["trip_places"] = [
        _trip_place(_TARGET_ID, _TRIP_ID, 1, 2),
        _trip_place("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", _TRIP_ID, 1, 7, place_suffix="3"),
    ]
    db["trip_places"][0]["place_id"] = castle_place_id

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "universal studios japan", "day_number": 1, "position": 1},
        )

    assert response.status_code == 201
    body = response.json()
    assert body["days_touched"] == [1]
    assert body["trip_place"]["place_id"] == usj_place_id
    assert body["trip_place"]["source_type"] == "user_requested"
    assert body["trip_place"]["evidence_json"] == {
        "confidence": 1.0,
        "source_url": None,
        "source_reel_url": None,
        "quote": "universal studios japan",
        "quotes": [],
        "rationale": None,
        "evidence_kind": "requested_by_you",
    }
    assert [row["sort_order"] for row in sorted(db["trip_places"], key=lambda row: row["sort_order"])] == [0, 1, 2]
    assert next(row for row in db["trip_places"] if row["place_id"] == usj_place_id)["sort_order"] == 0



async def test_add_place_geocodes_a_name_the_trip_does_not_yet_know(monkeypatch):
    """The Tokyo Tower case: Astrail resolves the name itself instead of asking the agent."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(34.6687, 135.5013))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Dotonbori", "day_number": 1},
        )

    assert response.status_code == 201
    assert len(spy.calls) == 1
    added = next(row for row in db["places"] if row["name"] == "Dotonbori")
    assert (added["lat"], added["lng"]) == (34.6687, 135.5013)
    # The provider's country is persisted, which is what lets the NEXT add of this name reuse
    # the row for free instead of paying Mapbox again.
    assert added["country_code"] == "JP"
    assert added["country"] == "Japan"
    assert added["country_name"] == "Japan"
    assert db["trip_places"][-1]["place_id"] == added["id"]


async def test_add_place_biases_the_geocode_with_the_trip_context(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(34.6687, 135.5013))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Chinatown", "day_number": 1},
        )

    assert response.status_code == 201
    call = spy.calls[0]
    assert call["query"] == "Chinatown"
    assert call["token"] == "sk.fake-test-token"
    assert call["country"] == "jp"                        # the trip's only country
    assert call["proximity_lng_lat"] == (135.5262, 34.6873)   # (lng, lat) — Osaka Castle
    assert call["language"] == "en"


async def test_add_place_local_match_never_makes_a_paid_geocode(monkeypatch):
    """The money regression: a name the trip already knows must cost nothing."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    usj_place_id = "00000000-0000-0000-0000-000000000002"
    db["places"].append({
        "id": usj_place_id,
        "name": "Universal Studios Japan",
        "aliases": ["USJ"],
        "lat": 34.6654,
        "lng": 135.4323,
        "city": "Osaka",
        "country": "Japan",
        "country_code": "JP",
    })
    spy = _stub_geocoder(monkeypatch, result=_geo(0.0, 0.0))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "universal studios japan", "day_number": 1},
        )

    assert response.status_code == 201
    assert response.json()["trip_place"]["place_id"] == usj_place_id
    assert spy.calls == []          # $0.005 that must never be spent on a name we already have


async def test_add_place_explicit_coordinates_never_make_a_paid_geocode(monkeypatch):
    """The escape hatch stays open, and stays free."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(0.0, 0.0))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "A place Mapbox has never heard of", "day_number": 1,
                  "lat": 34.6654, "lng": 135.4323},
        )

    assert response.status_code == 201
    added = next(row for row in db["places"] if row["name"] == "A place Mapbox has never heard of")
    assert (added["lat"], added["lng"]) == (34.6654, 135.4323)
    assert spy.calls == []
    # The free name lookup is skipped too — only the geographic context is read, and only so the
    # agent's own pair can be checked against the trip.
    assert not any(call["select"] == _NAME_LOOKUP_SELECT for call in client.fake_supabase.calls)


async def test_add_place_refuses_agent_coordinates_nowhere_near_the_trip(monkeypatch):
    """The escape hatch is checked, not trusted.

    A model reciting the wrong landmark's coordinates used to be stored verbatim, and the approval
    card never showed the numbers, so nobody could have caught it. This is the Eiffel Tower on an
    Osaka trip.
    """
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(0.0, 0.0))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Osaka Castle Annex", "day_number": 1, "lat": 48.8584, "lng": 2.2945},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "not near this trip" in response.json()["error"]["message"]
    assert [row["name"] for row in db["places"]] == ["Osaka Castle"]
    assert len(db["trip_places"]) == 1
    assert spy.calls == []          # refusing is free; it never falls through to a paid lookup


async def test_add_place_accepts_agent_coordinates_on_an_empty_trip(monkeypatch):
    """A trip with nothing placed has nothing to check against, and the escape hatch is the only
    way to place its first stop — so the gate must stay open there."""
    db: dict = {}
    _seed_owned_trip(db)
    db["places"] = []
    db["trip_places"] = []
    _stub_geocoder(monkeypatch, result=_geo(0.0, 0.0))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Somewhere Far", "day_number": 1, "lat": 48.8584, "lng": 2.2945},
        )

    assert response.status_code == 201


async def test_add_place_reuses_a_name_containing_a_like_wildcard_for_free(monkeypatch):
    """`%` and `_` are LIKE wildcards. Unescaped, they widen the candidate window past its
    unordered 25-row cap and the exact row can fall outside it — a free answer missed and a paid
    geocode bought for nothing."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    wildcard_place_id = "00000000-0000-0000-0000-000000000002"
    # Decoys FIRST. Each one matches the UNESCAPED pattern (`%` = anything, `_` = any character)
    # but not the escaped one, and there are more of them than the query's 25-row cap — so with the
    # escaping removed the exact row below is cut from the window and never compared. Ordering is
    # the whole point of the fixture: seeded after the decoys, it is row 31 of the loose match.
    db["places"].extend({
        "id": f"00000000-0000-0000-0000-0000000001{index:02d}",
        "name": f"Cafe 100 filler {index} Chocolate-Bar",
        "aliases": [],
        "lat": 34.60 + index / 1000,
        "lng": 135.50,
        "city": "Osaka",
        "country": "Japan",
        "country_code": "JP",
    } for index in range(30))
    db["places"].append({
        "id": wildcard_place_id,
        "name": "Cafe 100% Chocolate_Bar",
        "aliases": [],
        "lat": 34.6700,
        "lng": 135.5000,
        "city": "Osaka",
        "country": "Japan",
        "country_code": "JP",
    })
    spy = _stub_geocoder(monkeypatch, result=_geo(0.0, 0.0))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Cafe 100% Chocolate_Bar", "day_number": 1},
        )

    assert response.status_code == 201
    assert response.json()["trip_place"]["place_id"] == wildcard_place_id
    assert spy.calls == []


async def test_add_place_still_asks_when_the_geocoder_misses(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=None)

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Zzzzz Unfindable", "day_number": 1},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "supply both lat and lng" in response.json()["error"]["message"].lower()
    assert len(spy.calls) == 1
    assert len(db["trip_places"]) == 1


@pytest.mark.parametrize(
    ("case", "result"),
    [
        # Right name, wrong country: Universal Studios Singapore on an Osaka trip.
        ("another_country", _geo(1.2540, 103.8238, country_code="SG", country_name="Singapore")),
        # Right country, ~1,000 km from every stop the trip has.
        ("far_from_the_trip", _geo(43.0621, 141.3544)),
    ],
)
async def test_add_place_refuses_to_pin_a_low_confidence_geocode(monkeypatch, case, result):
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    _stub_geocoder(monkeypatch, result=result)

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios", "day_number": 1},
        )

    assert response.status_code == 422, case
    assert response.json()["error"]["code"] == "validation_error"
    assert [row["name"] for row in db["places"]] == ["Osaka Castle"]
    assert len(db["trip_places"]) == 1


async def test_add_place_refuses_a_cross_border_geocode_the_distance_gate_would_allow(monkeypatch):
    """Proves the country gate carries its own weight at the route level.

    Singapore trip, a Johor Bahru hit ~25 km away: comfortably inside the distance bound, so the
    only thing that can stop it being pinned in the wrong country is the country check.
    """
    db: dict = {}
    _seed_owned_trip(db)
    _seed_context_place(
        db, name="Gardens by the Bay", lat=1.2897, lng=103.8501,
        city="Singapore", country="Singapore", country_code="SG",
    )
    _stub_geocoder(
        monkeypatch,
        result=_geo(1.4927, 103.7414, country_code="MY", country_name="Malaysia"),
    )

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "City Square Mall", "day_number": 1},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert [row["name"] for row in db["places"]] == ["Gardens by the Bay"]
    assert len(db["trip_places"]) == 1


async def test_add_place_falls_back_to_asking_when_the_geocoder_hangs(monkeypatch):
    import geocode.requested_place as requested_place

    monkeypatch.setattr(requested_place, "GEOCODE_TIMEOUT_S", 0.02)
    monkeypatch.setattr(requested_place, "GEOCODE_DEADLINE_SLACK_S", 0.03)
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    _stub_geocoder(monkeypatch, result=_geo(34.6687, 135.5013), sleep=30)

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Dotonbori", "day_number": 1},
        )

    assert response.status_code == 422
    assert "supply both lat and lng" in response.json()["error"]["message"].lower()
    assert len(db["trip_places"]) == 1


async def test_change_dates_is_404_when_feature_flag_is_off(monkeypatch):
    monkeypatch.setattr(main, "WEBMCP_EDITS_ENABLED", False, raising=False)

    async def _must_not_touch_db():
        raise AssertionError("feature-off route touched Supabase")

    monkeypatch.setattr(main, "get_supabase_client", _must_not_touch_db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.patch(f"/trips/{_TRIP_ID}", json={"start_date": "2026-08-28"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_change_dates_rejects_reversed_range(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            json={"start_date": "2026-08-30", "end_date": "2026-08-28"},
        )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_change_dates_rejects_empty_body(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)

    async with _client(monkeypatch, db) as client:
        response = await client.patch(f"/trips/{_TRIP_ID}", json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


async def test_change_dates_rejects_range_shorter_than_existing_days(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {"id": f"day-{number}", "trip_id": _TRIP_ID, "day_number": number, "day_date": f"2026-08-{26 + number:02d}"}
        for number in (1, 2, 3)
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            json={"start_date": "2026-08-28", "end_date": "2026-08-29"},
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_range_too_short"
    assert "3 existing days" in response.json()["error"]["message"]
    assert "remove stops first" in response.json()["error"]["message"].lower()
    assert db["trips"][0]["start_date"] == "2026-08-27"
    assert [row["day_date"] for row in db["trip_days"]] == ["2026-08-27", "2026-08-28", "2026-08-29"]


async def test_change_dates_redates_every_day_without_changing_day_number(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {"id": f"day-{number}", "trip_id": _TRIP_ID, "day_number": number, "day_date": f"2026-08-{26 + number:02d}"}
        for number in (1, 2, 3)
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            json={"start_date": "2026-08-28", "end_date": "2026-08-30"},
        )

    assert response.status_code == 200
    assert response.json()["days_touched"] == [1, 2, 3]
    assert response.json()["trip"]["start_date"] == "2026-08-28"
    assert response.json()["trip"]["end_date"] == "2026-08-30"
    assert [(row["day_number"], row["day_date"]) for row in db["trip_days"]] == [
        (1, date(2026, 8, 28).isoformat()),
        (2, date(2026, 8, 29).isoformat()),
        (3, date(2026, 8, 30).isoformat()),
    ]


async def test_change_dates_clears_the_forecast_on_days_that_moved(monkeypatch):
    """A forecast for the old dates is a claim about weather on a day the trip no longer has.

    Nothing else clears it: this endpoint used to write only day_date, and /replan runs
    _refresh_trip_routes + persist_narration. Reported live — a Tokyo trip moved from September to
    October kept September's forecast on rows now labelled October.
    """
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {
            "id": f"day-{number}",
            "trip_id": _TRIP_ID,
            "day_number": number,
            "day_date": f"2026-08-{26 + number:02d}",
            "weather_summary": "Sunny, 24°C",
            "weather_source": "open_meteo",
            "weather_payload": {"high_c": 24},
        }
        for number in (1, 2, 3)
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            json={"start_date": "2026-10-09", "end_date": "2026-10-11"},
        )

    assert response.status_code == 200
    # All three columns together — a summary cleared while the payload survives is the same bug
    # one layer down, and the payload is NOT NULL with an "is an object" check, so it resets to {}.
    for row in db["trip_days"]:
        assert row["weather_summary"] is None
        assert row["weather_source"] is None
        assert row["weather_payload"] == {}


async def test_change_dates_keeps_the_forecast_on_days_that_did_not_move(monkeypatch):
    """The case a whole-trip wipe passes a one-day test and fails.

    Extending the END of a range leaves every existing day on the date it already had, so their
    forecasts still describe the right dates and destroying them would be a second bug traded for
    the first.
    """
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {
            "id": f"day-{number}",
            "trip_id": _TRIP_ID,
            "day_number": number,
            "day_date": f"2026-08-{26 + number:02d}",
            "weather_summary": f"Sunny, day {number}",
            "weather_source": "open_meteo",
            "weather_payload": {"day": number},
        }
        for number in (1, 2, 3)
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            # Same start, later end: days 1-3 keep 08-27, 08-28, 08-29.
            json={"start_date": "2026-08-27", "end_date": "2026-09-02"},
        )

    assert response.status_code == 200
    for row in db["trip_days"]:
        assert row["weather_summary"] == f"Sunny, day {row['day_number']}"
        assert row["weather_source"] == "open_meteo"
        assert row["weather_payload"] == {"day": row["day_number"]}


async def test_change_dates_clears_only_the_days_that_actually_moved(monkeypatch):
    """The mixed case, which is the one that separates a real fix from a blanket wipe.

    Shifting the start by one day moves every day BUT the one that lands where another used to be
    is still a move — so this pins the rule per row rather than per trip: day 1 moves off 08-27,
    and a day left on its own date keeps what it had.
    """
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {"id": "day-1", "trip_id": _TRIP_ID, "day_number": 1, "day_date": "2026-08-27",
         "weather_summary": "Day 1 forecast", "weather_source": "open_meteo", "weather_payload": {"d": 1}},
        # Already sitting where the new range will put it, so it must be left alone.
        {"id": "day-2", "trip_id": _TRIP_ID, "day_number": 2, "day_date": "2026-08-29",
         "weather_summary": "Day 2 forecast", "weather_source": "open_meteo", "weather_payload": {"d": 2}},
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            # Day 1 -> 08-28 (moved), day 2 -> 08-29 (unchanged).
            json={"start_date": "2026-08-28", "end_date": "2026-08-29"},
        )

    assert response.status_code == 200
    by_number = {row["day_number"]: row for row in db["trip_days"]}
    assert by_number[1]["weather_summary"] is None
    assert by_number[1]["weather_payload"] == {}
    assert by_number[2]["weather_summary"] == "Day 2 forecast"
    assert by_number[2]["weather_payload"] == {"d": 2}


async def test_change_dates_leaves_a_no_op_edit_alone(monkeypatch):
    """Re-sending the range the trip already has must not cost it its forecast."""
    db: dict = {}
    _seed_owned_trip(db)
    db["trip_days"] = [
        {"id": "day-1", "trip_id": _TRIP_ID, "day_number": 1, "day_date": "2026-08-27",
         "weather_summary": "Unchanged", "weather_source": "open_meteo", "weather_payload": {"d": 1}},
    ]

    async with _client(monkeypatch, db) as client:
        response = await client.patch(
            f"/trips/{_TRIP_ID}",
            json={"start_date": "2026-08-27", "end_date": "2026-08-27"},
        )

    assert response.status_code == 200
    assert db["trip_days"][0]["weather_summary"] == "Unchanged"
    assert db["trip_days"][0]["weather_payload"] == {"d": 1}


def _seed_structural_edit_trip(db):
    _seed_owned_trip(db)
    castle_id = "00000000-0000-0000-0000-000000000001"
    usj_id = "00000000-0000-0000-0000-000000000002"
    sky_id = "00000000-0000-0000-0000-000000000003"
    db["places"] = [
        {
            "id": castle_id,
            "name": "Osaka Castle",
            "aliases": [],
            "lat": 34.6873,
            "lng": 135.5262,
            "city": "Osaka",
            "country": "Japan",
            "country_code": "JP",
        },
        {
            "id": usj_id,
            "name": "Universal Studios Japan",
            "aliases": ["USJ"],
            "lat": 34.6654,
            "lng": 135.4323,
            "city": "Osaka",
            "country": "Japan",
            "country_code": "JP",
        },
        {
            "id": sky_id,
            "name": "Umeda Sky Building",
            "aliases": [],
            "lat": 34.7053,
            "lng": 135.4905,
            "city": "Osaka",
            "country": "Japan",
            "country_code": "JP",
        },
    ]
    db["trip_places"] = [
        _trip_place(_TARGET_ID, _TRIP_ID, 1, 0),
        _trip_place("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", _TRIP_ID, 1, 1, place_suffix="3"),
    ]
    db["trip_places"][0]["place_id"] = castle_id
    db["trip_places"][1]["place_id"] = sky_id


async def _perform_edit(client, operation):
    if operation == "add":
        return await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Universal Studios Japan", "day_number": 1, "position": 2},
        )
    if operation == "move":
        return await client.patch(
            f"/trips/{_TRIP_ID}/places/{_TARGET_ID}",
            json={"sort_order": 1},
        )
    if operation == "delete":
        return await client.delete(f"/trips/{_TRIP_ID}/places/{_TARGET_ID}")
    if operation == "dates":
        return await client.patch(f"/trips/{_TRIP_ID}", json={"start_date": "2026-08-28"})
    raise AssertionError(f"unknown operation {operation}")


@pytest.mark.parametrize("operation,expected_status", [("add", 201), ("move", 200), ("delete", 200)])
async def test_structural_edits_refresh_routes(monkeypatch, operation, expected_status):
    db: dict = {}
    _seed_structural_edit_trip(db)
    calls = []

    async def _transport(client, trip_id):
        calls.append((client, trip_id))
        return 2

    monkeypatch.setattr(main, "persist_transport", _transport)
    async with _client(monkeypatch, db) as client:
        response = await _perform_edit(client, operation)

    assert response.status_code == expected_status
    assert response.json()["routes_refreshed"] is True
    assert calls == [(client.fake_supabase, _TRIP_ID)]  # type: ignore[attr-defined]


async def test_transport_failure_does_not_fail_structural_edit(monkeypatch):
    db: dict = {}
    _seed_structural_edit_trip(db)

    async def _transport_failure(client, trip_id):
        raise RuntimeError("Mapbox unavailable")

    monkeypatch.setattr(main, "persist_transport", _transport_failure)
    async with _client(monkeypatch, db) as client:
        response = await _perform_edit(client, "move")

    assert response.status_code == 200
    assert response.json()["trip_place"]["sort_order"] == 1
    assert response.json()["routes_refreshed"] is False


async def test_replan_is_404_when_feature_flag_is_off(monkeypatch):
    monkeypatch.setattr(main, "WEBMCP_EDITS_ENABLED", False, raising=False)

    async def _must_not_touch_db():
        raise AssertionError("feature-off route touched Supabase")

    monkeypatch.setattr(main, "get_supabase_client", _must_not_touch_db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    ) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "Not found"


async def test_replan_non_owner_is_404_not_403(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, user_id="user-2")

    async with _client(monkeypatch, db) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"
    assert response.json()["error"]["message"] == "Trip not found"


async def test_replan_rejects_generating_trip(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db, status="generating")

    async with _client(monkeypatch, db) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"


async def test_replan_rejects_running_job(monkeypatch):
    db: dict = {"jobs": [{"id": "job-1", "trip_id": _TRIP_ID, "status": "running"}]}
    _seed_owned_trip(db)

    async with _client(monkeypatch, db) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "trip_not_editable"


async def test_replan_refreshes_routes_then_narrates(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)
    calls = []

    async def _transport(client, trip_id):
        calls.append(("transport", client, trip_id))
        return 3

    async def _narration(client, trip_id, user_id):
        calls.append(("narration", client, trip_id, user_id))
        return 2

    monkeypatch.setattr(main, "persist_transport", _transport)
    monkeypatch.setattr(main, "persist_narration", _narration)
    async with _client(monkeypatch, db) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 200
    assert response.json() == {"days_narrated": 2, "routes_refreshed": True}
    assert calls == [
        ("transport", client.fake_supabase, _TRIP_ID),  # type: ignore[attr-defined]
        ("narration", client.fake_supabase, _TRIP_ID, "user-1"),  # type: ignore[attr-defined]
    ]


async def test_replan_narration_failure_is_502_and_reports_route_result(monkeypatch):
    db: dict = {}
    _seed_owned_trip(db)

    async def _transport(client, trip_id):
        return 2

    async def _narration_failure(client, trip_id, user_id):
        raise RuntimeError("LLM unavailable")

    monkeypatch.setattr(main, "persist_transport", _transport)
    monkeypatch.setattr(main, "persist_narration", _narration_failure)
    async with _client(monkeypatch, db) as client:
        response = await client.post(f"/trips/{_TRIP_ID}/replan")

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "replan_failed"
    assert "narration" in response.json()["error"]["message"].lower()
    assert response.json()["routes_refreshed"] is True
    assert "days_narrated" not in response.json()


@pytest.mark.parametrize("operation", ["add", "move", "delete", "dates"])
async def test_cheap_edit_routes_never_call_persist_narration(monkeypatch, operation):
    db: dict = {}
    _seed_structural_edit_trip(db)
    narration_calls = []

    async def _narration(client, trip_id, user_id):
        narration_calls.append((client, trip_id, user_id))
        return 1

    monkeypatch.setattr(main, "persist_narration", _narration)
    async with _client(monkeypatch, db) as client:
        response = await _perform_edit(client, operation)

    assert response.status_code in {200, 201}
    assert narration_calls == []


async def test_add_place_geocodes_the_local_script_name_the_agent_supplied(monkeypatch):
    """The Japan bug end to end. Mapbox's Japan POI dataset has no English names — verified
    against the live API, `q="Tokyo Disneyland"` returns zero features under every language — so
    an add that only ever sent the English name could not resolve a single Tokyo landmark."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(35.6327, 139.8806))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={
                "name": "Tokyo Disneyland",
                "name_local": "東京ディズニーランド",
                "day_number": 1,
            },
        )

    assert response.status_code == 201
    assert len(spy.calls) == 1                                  # the hit costs one paid call
    assert spy.calls[0]["query"] == "東京ディズニーランド"
    assert spy.calls[0]["language"] == "ja"
    # The stop is still filed under the name the USER used: the local name is a lookup key, not
    # a rename, and the itinerary must read back in the language they typed.
    added = next(row for row in db["places"] if row["name"] == "Tokyo Disneyland")
    assert (added["lat"], added["lng"]) == (35.6327, 139.8806)


async def test_add_place_ignores_a_blank_local_name(monkeypatch):
    """A blank is an absent local name, not a blank query — and must not cost a second call."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    spy = _stub_geocoder(monkeypatch, result=_geo(34.6687, 135.5013))

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Dotonbori", "name_local": "   ", "day_number": 1},
        )

    assert response.status_code == 201
    assert len(spy.calls) == 1
    assert spy.calls[0]["query"] == "Dotonbori"


async def test_add_place_asks_for_the_local_name_before_it_asks_for_coordinates(monkeypatch):
    """What the 422 tells the agent to do next decides the provenance of the pin it comes back
    with. A name is looked up and gated by Mapbox; a lat/lng is model-asserted all the way to the
    map (guardrail #1). So the cheaper, checkable retry has to be named FIRST."""
    db: dict = {}
    _seed_owned_trip(db)
    _seed_osaka_places(db)
    _stub_geocoder(monkeypatch, result=None)

    async with _client(monkeypatch, db) as client:
        response = await client.post(
            f"/trips/{_TRIP_ID}/places",
            json={"name": "Tokyo Disneyland", "day_number": 1},
        )

    assert response.status_code == 422
    message = response.json()["error"]["message"]
    assert "name_local" in message
    assert message.index("name_local") < message.index("lat and lng")
