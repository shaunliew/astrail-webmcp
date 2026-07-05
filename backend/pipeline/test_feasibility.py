"""Itinerary feasibility — pure, offline, deterministic."""
from models.place import CanonicalPlace
from pipeline.feasibility import (
    LONG_LEG_FLAG_M, DEFAULT_PACE, assess_feasibility, geo_order, optimal_day_order,
)


def _p(name, lat, lng):
    return CanonicalPlace(name=name, category="attraction", confidence=0.9,
                          evidence_quote=name, lat=lat, lng=lng)


def _total(order):
    from pipeline.geo import haversine_m
    return sum(haversine_m(order[i].lat, order[i].lng, order[i + 1].lat, order[i + 1].lng)
               for i in range(len(order) - 1))


def test_geo_order_is_deterministic():
    pts = [_p("A", 35.0, 139.0), _p("B", 35.9, 139.9), _p("C", 35.1, 139.1)]
    assert [p.name for p in geo_order(pts)] == [p.name for p in geo_order(list(reversed(pts)))]


def test_geo_order_beats_input_order_total_distance():
    # input order zig-zags; geo_order should chain neighbors → shorter total
    pts = [_p("A", 35.0, 139.0), _p("Z", 35.9, 139.9), _p("B", 35.05, 139.05), _p("Y", 35.85, 139.85)]
    assert _total(geo_order(pts)) <= _total(pts)


def test_geo_order_appends_no_coord_places_last():
    a = _p("A", 35.0, 139.0)
    nc = CanonicalPlace(name="NoCoord", category="other", confidence=0.5,
                        evidence_quote="NoCoord", lat=None, lng=None)
    out = geo_order([nc, a])
    assert out[-1].name == "NoCoord"  # coord-bearing first, no-coord appended last


def test_optimal_day_order_minimizes_intra_day_travel():
    # a deliberately bad order; brute-force should find a shorter one
    bad = [_p("A", 35.0, 139.0), _p("Far", 35.5, 139.5), _p("B", 35.01, 139.01)]
    out = optimal_day_order(bad)
    assert _total(out) <= _total(bad)
    assert {p.name for p in out} == {"A", "Far", "B"}  # same set, reordered


def test_assess_feasibility_flags_long_leg():
    days = [(1, [_p("A", 35.0, 139.0), _p("B", 35.9, 139.9)])]  # ~120 km apart
    w = assess_feasibility(days, pace="balanced")
    assert any(x.kind == "long_leg" and x.leg_m and x.leg_m >= LONG_LEG_FLAG_M for x in w)


def test_assess_feasibility_flags_overpacked_day():
    day = (1, [_p(f"P{i}", 35.0 + i * 0.001, 139.0) for i in range(5)])  # 5 stops
    w = assess_feasibility([day], pace="balanced")  # cap 4
    assert any(x.kind == "overpacked_day" and x.day_number == 1 for x in w)


def test_assess_feasibility_clean_day_no_warnings():
    day = (1, [_p("A", 35.000, 139.0), _p("B", 35.005, 139.0)])  # ~550 m, 2 stops
    assert assess_feasibility([day], pace="balanced") == []


def test_no_coords_place_never_crashes_ordering_or_legs():
    a = _p("A", 35.0, 139.0)
    nc = CanonicalPlace(name="NC", category="other", confidence=0.5, evidence_quote="NC",
                        lat=None, lng=None)
    assert len(geo_order([a, nc])) == 2
    assert assess_feasibility([(1, [a, nc])], pace="balanced") == []  # leg skipped, no crash


def test_assess_feasibility_flags_empty_day():
    """A day with 0 stops gets an empty_day warning with severity flag."""
    days = [(1, [_p("A", 35.0, 139.0)]), (2, [])]
    w = assess_feasibility(days, pace="balanced")
    empty = [x for x in w if x.kind == "empty_day"]
    assert len(empty) == 1
    assert empty[0].day_number == 2
    assert empty[0].severity == "flag"


def test_assess_feasibility_long_leg_flag_severity():
    """A leg >= LONG_LEG_FLAG_M (4 km) has severity == 'flag'."""
    # ~120 km apart — well above the flag threshold
    days = [(1, [_p("A", 35.0, 139.0), _p("B", 35.9, 139.9)])]
    w = assess_feasibility(days, pace="balanced")
    long_leg_warnings = [x for x in w if x.kind == "long_leg"]
    assert long_leg_warnings, "expected at least one long_leg warning"
    assert long_leg_warnings[0].severity == "flag"
    assert long_leg_warnings[0].leg_m >= LONG_LEG_FLAG_M


def test_assess_feasibility_one_stop_day_no_warnings():
    """A single-stop day produces no warnings (no legs, not overpacked)."""
    day = (1, [_p("A", 35.0, 139.0)])
    assert assess_feasibility([day], pace="balanced") == []


def test_assess_feasibility_pace_none_uses_default_cap():
    """pace=None falls back to the balanced default (no crash, balanced cap applies)."""
    # 3 stops <= balanced cap 4 → no overpacked warning; pace=None uses default
    day = (1, [_p(f"P{i}", 35.0 + i * 0.001, 139.0) for i in range(3)])
    w = assess_feasibility([day], pace=None)
    assert all(x.kind != "overpacked_day" for x in w)


def test_optimal_day_order_no_coord_place_last_on_small_path():
    """No-coord place is LAST on the ≤2-coord early-return path."""
    a = _p("A", 35.0, 139.0)
    nc = CanonicalPlace(name="NC", category="other", confidence=0.5, evidence_quote="NC",
                        lat=None, lng=None)
    b = _p("B", 35.9, 139.9)
    # 2 coord places → early return; NC must end up last, not middle
    out = optimal_day_order([a, nc, b])
    assert out[-1].name == "NC"


def test_optimal_day_order_large_path_preserves_all_names():
    """8-coord stops (> _BRUTE_FORCE_MAX 7) takes early-return; all names preserved."""
    places = [_p(f"P{i}", 35.0 + i * 0.01, 139.0) for i in range(8)]
    out = optimal_day_order(places)
    assert {p.name for p in out} == {p.name for p in places}


def test_route_aware_ordering_strictly_reduces_zig_zag():
    """A deliberately zig-zagging input is strictly improved by geo_order + optimal_day_order.

    Replaces the fixture-dependent test_pipeline_strictly_improves_route_on_japan_first_trip
    which could spuriously pass/fail if the demo fixture happened to already be geo-optimal.
    """
    # Input deliberately zig-zags: near, far, near, far
    places = [
        _p("A_near", 35.0, 139.0),
        _p("Far1", 35.5, 139.5),
        _p("B_near", 35.01, 139.01),
        _p("Far2", 35.51, 139.51),
    ]
    naive_total = _total(places)
    optimized = optimal_day_order(geo_order(places))
    optimized_total = _total(optimized)
    assert optimized_total < naive_total, (
        f"expected optimized route ({optimized_total:.0f} m) < naive ({naive_total:.0f} m)"
    )
