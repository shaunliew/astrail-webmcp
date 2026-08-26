"""Keyless route tests for owner-checked WebMCP itinerary edits.

The fake models PostgREST's chained filters and mutates an in-memory database. No test
constructs a live Supabase client or makes a network request.
"""
from __future__ import annotations

import os

import httpx
import pytest
from fastapi import Request

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

import main  # noqa: E402
from rate_limit import get_current_user_id_stashed, limiter  # noqa: E402


_TRIP_ID = "11111111-1111-1111-1111-111111111111"
_OTHER_TRIP_ID = "22222222-2222-2222-2222-222222222222"
_TARGET_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"


class _Result:
    def __init__(self, data):
        self.data = data


_DEFAULT_OWNER_RESULT = object()


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

    def select(self, columns="*"):
        self._op = "select"
        self._select = columns
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = dict(payload)
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, column, value):
        self._filters[column] = value
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
        return all(row.get(key) == value for key, value in self._filters.items())

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

    def table(self, name):
        return _Table(self, name)


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


def _seed_owned_trip(db, *, status="complete", user_id="user-1"):
    db.setdefault("trips", []).append({
        "id": _TRIP_ID,
        "user_id": user_id,
        "status": status,
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
def _reset_app():
    limiter.reset()
    yield
    main.app.dependency_overrides.clear()
    limiter.reset()


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
    assert response.json() == {"removed_id": _TARGET_ID, "days_touched": [1]}
    assert [(row["id"], row["sort_order"]) for row in db["trip_places"] if row["day_number"] == 1] == [
        ("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", 0),
        ("cccccccc-cccc-cccc-cccc-cccccccccccc", 1),
    ]
    # Untouched days are not normalized as a side effect.
    assert next(row for row in db["trip_places"] if row["day_number"] == 2)["sort_order"] == 4
