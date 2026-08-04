"""Unit tests for genagents.hotel_ranking.rank_hotels — pure orchestration with injected
geocode + matrix. No network, no key, deterministic.

The injected `geocode` mirrors geocode.mapbox_forward.forward_geocode with the token pre-bound
(async, returns GeocodeResult | None, may raise on a hard failure). The injected `matrix` mirrors
genagents.matrix.fetch_matrix with the token pre-bound (async, returns Matrix | None).
"""
from __future__ import annotations

import asyncio

import pytest

from genagents.matrix import Matrix
from genagents.hotel_ranking import RankedHotel, rank_hotels
from models.geocode import GeocodeResult

# --- fakes -----------------------------------------------------------------------------------

# Tokyo-ish coordinates; centroid of the dayed places sits well inside Japan.
_TOKYO = (35.68, 139.76)


class FakeGeocode:
    """Injected geocode double. Resolves by the FIRST token of the query (the street address)
    against `hits` → GeocodeResult | None; a query whose address is in `raises` raises RuntimeError
    (mirrors forward_geocode's sanitized non-2xx/network raise)."""

    def __init__(self, hits: dict[str, GeocodeResult | None], raises: set[str] | None = None):
        self.hits = hits
        self.raises = raises or set()
        self.calls: list[dict] = []

    async def __call__(self, query, *, types=None, country=None, proximity_lng_lat=None):
        # address is everything before the first ", " (the "{address}, {city}" join)
        address = query.split(", ")[0]
        self.calls.append({"query": query, "types": types, "country": country,
                            "proximity_lng_lat": proximity_lng_lat})
        if address in self.raises:
            raise RuntimeError("geocode boom (sanitized)")
        return self.hits.get(address)


class FakeMatrix:
    """Injected matrix double. Records each call's sources/destinations (to assert ordering) and
    returns a Matrix whose durations[i][j] = duration_fn(sources[i], destinations[j]) — or a fixed
    `result` (e.g. None to simulate a Mapbox degrade)."""

    def __init__(self, duration_fn=None, result="_derive"):
        self.duration_fn = duration_fn
        self.result = result
        self.calls: list[dict] = []

    async def __call__(self, sources, destinations, *, annotations=None):
        self.calls.append({"sources": list(sources), "destinations": list(destinations),
                           "annotations": annotations})
        if self.result != "_derive":
            return self.result
        durations = [[self.duration_fn(s, d) for d in destinations] for s in sources]
        distances = [[0.0 for _ in destinations] for _ in sources]
        return Matrix(durations=durations, distances=distances)


def _geo(lat, lng, country_code="jp") -> GeocodeResult:
    return GeocodeResult(lat=lat, lng=lng, country_code=country_code)


def _place(place_id, lat, lng, *, place_type="poi", day_number=1) -> dict:
    return {"place_id": place_id, "lat": lat, "lng": lng,
            "place_type": place_type, "day_number": day_number}


def _hotel(hotel_id, *, star=4, price=100, currency="USD", address="1-1 Somewhere",
           name=None) -> dict:
    return {"hotelId": hotel_id, "name": name or f"Hotel {hotel_id}", "star": star,
            "pricePerNight": price, "totalPrice": price * 3, "currency": currency,
            "address": address}


# Two dayed places + one undayed base hotel place (must be excluded from Matrix destinations).
_PLACES = [
    _place("pl_1", 35.69, 139.77),
    _place("pl_2", 35.66, 139.74),
    _place("pl_base", 35.68, 139.70, place_type="hotel", day_number=None),
]


def _run(coro):
    return asyncio.run(coro)


# --- geo gate --------------------------------------------------------------------------------

def test_hit_in_proximity_is_placed():
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert len(out) == 1
    h = out[0]
    assert isinstance(h, RankedHotel)
    assert h.geo_status == "placed"
    assert h.lat == 35.69 and h.lng == 139.75
    assert h.rank == 1 and h.is_recommended is True
    # geocode was asked for a street address, biased to the trip centroid, filtered to JP
    assert geo.calls[0]["types"] == "address"
    assert geo.calls[0]["country"] == "JP"
    prox = geo.calls[0]["proximity_lng_lat"]
    assert prox is not None and 139.5 < prox[0] < 140.0 and 35.5 < prox[1] < 35.8  # (lng, lat)


def test_geocode_miss_is_unresolved():
    hotels = [_hotel("A", address="1-1 Nowhere")]
    geo = FakeGeocode({"1-1 Nowhere": None})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    h = out[0]
    assert h.geo_status == "unresolved"
    assert h.lat is None and h.lng is None
    assert h.rank is None and h.is_recommended is False and h.route_score is None
    assert h.place_durations == {}
    # unresolved hotel is never routed
    assert matrix.calls == []


def test_out_of_60km_is_unresolved():
    # A point ~200km from the Tokyo centroid (well past the 60km gate).
    hotels = [_hotel("A", address="1-1 Faraway")]
    geo = FakeGeocode({"1-1 Faraway": _geo(37.5, 139.75)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert out[0].geo_status == "unresolved"
    assert matrix.calls == []


def test_country_mismatch_is_unresolved():
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75, country_code="us")})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert out[0].geo_status == "unresolved"


def test_missing_address_is_unresolved_without_geocoding():
    hotels = [{"hotelId": "A", "name": "Hotel A", "star": 4, "pricePerNight": 100,
               "currency": "USD"}]  # no address
    geo = FakeGeocode({})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert out[0].geo_status == "unresolved"
    assert geo.calls == []   # never geocoded an address-less hotel


def test_geocode_exception_degrades_to_unresolved():
    hotels = [_hotel("A", address="1-1 Boom"), _hotel("B", address="2-2 Shibuya")]
    geo = FakeGeocode({"2-2 Shibuya": _geo(35.66, 139.74)}, raises={"1-1 Boom"})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    by_id = {r.hotel["hotelId"]: r for r in out}
    assert by_id["A"].geo_status == "unresolved"       # the raising geocode is a miss, not a crash
    assert by_id["B"].geo_status == "placed"


# --- matrix / centrality ---------------------------------------------------------------------

def test_matrix_failure_keeps_placed_but_route_score_none():
    hotels = [_hotel("A", address="1-1 Shinjuku"), _hotel("B", address="2-2 Shibuya")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75),
                       "2-2 Shibuya": _geo(35.66, 139.74)})
    matrix = FakeMatrix(result=None)   # Mapbox degrade
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert all(r.geo_status == "placed" for r in out)
    assert all(r.route_score is None for r in out)
    assert all(r.place_durations == {} for r in out)
    # still ranked (by preference only) — every placed hotel gets a rank
    assert sorted(r.rank for r in out) == [1, 2]
    assert sum(r.is_recommended for r in out) == 1


def test_destinations_exclude_base_and_preserve_order():
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75)})
    # duration = large constant + a per-destination offset so we can read column identity back
    offsets = {(35.69, 139.77): 10.0, (35.66, 139.74): 20.0}
    matrix = FakeMatrix(duration_fn=lambda s, d: 100.0 + offsets[d])
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    call = matrix.calls[0]
    # base (undayed / place_type=hotel) is NOT a destination
    assert call["destinations"] == [(35.69, 139.77), (35.66, 139.74)]
    assert call["annotations"] == "duration,distance"
    h = out[0]
    # place_durations keyed by the real place_id, mapped from the preserved column order
    assert h.place_durations == {"pl_1": 110.0, "pl_2": 120.0}
    assert "pl_base" not in h.place_durations
    assert h.route_score == pytest.approx(115.0)   # min-average duration to the two places


def test_place_durations_omits_unreachable_none_cells():
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75)})

    def dur(s, d):
        return None if d == (35.66, 139.74) else 200.0   # pl_2 unreachable
    matrix = FakeMatrix(duration_fn=dur)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    h = out[0]
    assert h.place_durations == {"pl_1": 200.0}       # None cell dropped
    assert h.route_score == pytest.approx(200.0)      # averaged over reachable only


# --- preference / centrality blend, ranking --------------------------------------------------

def test_central_hotel_is_recommended():
    # Same star/price for both → preference ties → centrality decides. B is closer to both places.
    hotels = [_hotel("A", star=4, price=100, address="1-1 Far"),
              _hotel("B", star=4, price=100, address="2-2 Near")]
    geo = FakeGeocode({"1-1 Far": _geo(35.72, 139.80), "2-2 Near": _geo(35.675, 139.755)})

    def dur(s, d):
        from pipeline.geo import haversine_m
        return haversine_m(s[0], s[1], d[0], d[1])
    matrix = FakeMatrix(duration_fn=dur)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    rec = next(r for r in out if r.is_recommended)
    assert rec.hotel["hotelId"] == "B"
    assert rec.rank == 1


def test_top3_and_single_recommended_across_many_placed():
    hotels = [_hotel(str(i), star=(i % 5) + 1, price=80 + i * 10,
                     address=f"{i}-{i} St") for i in range(5)]
    geo = FakeGeocode({f"{i}-{i} St": _geo(35.68 + i * 0.001, 139.75 + i * 0.001)
                       for i in range(5)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 100.0 + s[0] + d[0])
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    placed = [r for r in out if r.geo_status == "placed"]
    ranks = sorted(r.rank for r in placed)
    assert ranks == [1, 2, 3, 4, 5]                    # contiguous 1..N over placed
    assert sum(r.is_recommended for r in placed) == 1  # exactly one recommended
    assert next(r for r in placed if r.is_recommended).rank == 1
    top3 = sorted(placed, key=lambda r: r.rank)[:3]
    assert [r.rank for r in top3] == [1, 2, 3]


def test_tiebreak_is_deterministic_across_runs():
    # All identical star/price/geo/durations → fully tied blended score. Tie-break = hotelId asc,
    # so the order is reproducible regardless of input order or dict/set iteration.
    hotels = [_hotel("C3", address="a, x"), _hotel("A1", address="b, x"),
              _hotel("B2", address="c, x")]
    geo = FakeGeocode({"a": _geo(35.68, 139.75), "b": _geo(35.68, 139.75),
                       "c": _geo(35.68, 139.75)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)

    def order():
        out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                               geocode=geo, matrix=matrix))
        return [r.hotel["hotelId"] for r in sorted(out, key=lambda r: r.rank)]

    first = order()
    assert first == ["A1", "B2", "C3"]     # hotelId ascending
    for _ in range(3):
        assert order() == first            # stable across repeated runs


def test_string_hotel_id_is_handled():
    # Real Travala hotelId is a string; a purely-numeric-looking id must still sort as a string.
    hotels = [_hotel("100", address="a, x"), _hotel("20", address="b, x")]
    geo = FakeGeocode({"a": _geo(35.68, 139.75), "b": _geo(35.68, 139.75)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    order = [r.hotel["hotelId"] for r in sorted(out, key=lambda r: r.rank)]
    assert order == ["100", "20"]   # string ascending ("100" < "20"), not numeric


def test_cap_trim_keeps_matrix_under_25_dropping_lowest_preference():
    # 20 placeable hotels + 10 dayed destinations = 30 coords > the 25 Matrix cap → sources must be
    # trimmed to <= 15. Lower star = lower preference → the 5 star-1 hotels are dropped from routing
    # first; the 15 star-5 survivors are the ones routed.
    hotels = [_hotel(f"h{i:02d}", star=1 if i < 5 else 5, price=100,
                     address=f"{i}-{i} St") for i in range(20)]
    geo = FakeGeocode({f"{i}-{i} St": _geo(35.68, 139.75) for i in range(20)})
    many_places = [_place(f"pl_{j}", 35.66 + j * 0.003, 139.72 + j * 0.003) for j in range(10)]
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, many_places, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    call = matrix.calls[0]
    assert len(call["sources"]) + len(call["destinations"]) <= 25
    assert len(call["sources"]) == 15                    # trimmed 20 → 15 to fit 15 + 10 = 25
    # all 20 still returned + placed (trim only removes them from the Matrix, not the result)
    assert len(out) == 20
    assert all(r.geo_status == "placed" for r in out)
    # the 5 low-star hotels were dropped from routing → no route_score; survivors are all star 5
    routed = [r for r in out if r.route_score is not None]
    assert len(routed) == 15
    assert all(r.hotel["star"] == 5 for r in routed)


def test_no_centroid_all_unresolved():
    # No place has coordinates → no centroid → the proximity gate can't pass → all unresolved,
    # and nothing is geocoded or routed.
    placeless = [{"place_id": "pl_1", "lat": None, "lng": None,
                  "place_type": "poi", "day_number": 1}]
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, placeless, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert out[0].geo_status == "unresolved"
    assert geo.calls == [] and matrix.calls == []


def test_empty_hotels_returns_empty():
    geo = FakeGeocode({})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels([], _PLACES, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert out == []


def test_geocode_concurrency_uses_gather():
    # Two hotels must be geocoded concurrently (asyncio.gather), not sequentially: the second
    # geocode may start before the first finishes.
    order: list[str] = []

    async def geocode(query, *, types=None, country=None, proximity_lng_lat=None):
        addr = query.split(", ")[0]
        order.append(f"start:{addr}")
        await asyncio.sleep(0)                # yield so a sequential loop would fully finish first
        await asyncio.sleep(0)
        order.append(f"end:{addr}")
        return _geo(35.68, 139.75)

    hotels = [_hotel("A", address="1-1 A"), _hotel("B", address="2-2 B")]
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    _run(rank_hotels(hotels, _PLACES, "Tokyo", "JP", "mid_range",
                     geocode=geocode, matrix=matrix))
    # concurrent: both start before either ends
    assert order[0].startswith("start") and order[1].startswith("start")


# --- honest-failure / robustness: country gate + cap overflow --------------------------------

def test_country_code_none_is_all_unresolved():
    # No trip country → the in-country gate can never pass → every hotel is honestly unresolved
    # (Guardrail #1: no invented pins), and the Matrix is never called (no placed sources).
    hotels = [_hotel("A", address="1-1 Shinjuku"), _hotel("B", address="2-2 Shibuya")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.69, 139.75), "2-2 Shibuya": _geo(35.66, 139.70)})
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, _PLACES, "Tokyo", None, "mid_range",
                           geocode=geo, matrix=matrix))
    assert len(out) == 2
    assert all(h.geo_status == "unresolved" for h in out)
    assert all(h.lat is None and h.lng is None and h.rank is None for h in out)
    assert all(h.is_recommended is False and h.place_durations == {} for h in out)
    assert matrix.calls == []   # nothing placed → no Matrix call


def test_destinations_exceeding_cap_degrade_without_crashing():
    # Regression (T3 review): if dayed places alone exceed the Matrix coord cap, the trim must drop
    # destinations (keeping order), not drain the source list and crash on min([]). Degrades to
    # unlabeled spokes for the dropped places — never a ValueError.
    hotels = [_hotel("A", address="1-1 Shinjuku")]
    geo = FakeGeocode({"1-1 Shinjuku": _geo(35.68, 139.76)})
    # 30 dayed places clustered in Tokyo — more than the 25-coord cap on their own.
    many = [_place(f"pl_{i}", 35.68 + i * 0.001, 139.76 + i * 0.001) for i in range(30)]
    matrix = FakeMatrix(duration_fn=lambda s, d: 300.0)
    out = _run(rank_hotels(hotels, many, "Tokyo", "JP", "mid_range",
                           geocode=geo, matrix=matrix))
    assert len(out) == 1
    assert out[0].geo_status == "placed"          # did not crash; the hotel still ranks
    # destinations trimmed to fit (<= cap-1, leaving room for the 1 hotel source)
    assert len(matrix.calls) == 1
    assert len(matrix.calls[0]["destinations"]) <= 24
    assert len(out[0].place_durations) <= 24
