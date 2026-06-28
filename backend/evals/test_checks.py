from evals.checks import (
    check_coords_present,
    check_day_count,
    check_evidence_verbatim,
    check_japan_bbox,
    check_source_places_parity,
)


def _place(name, lat=35.66, lng=139.70, ev=None):
    return {"name": name, "lat": lat, "lng": lng, "evidence_quote": ev if ev is not None else name}


def test_coords_present_pass_and_fail():
    assert check_coords_present({"places": [_place("A")]}).status == "pass"
    bad = {"places": [{"name": "B", "lat": None, "lng": None}]}
    assert check_coords_present(bad).status == "fail"


def test_japan_bbox():
    assert check_japan_bbox({"places": [_place("A", 35.6, 139.7)]}).status == "pass"
    assert check_japan_bbox({"places": [_place("B", 1.35, 103.8)]}).status == "fail"  # Singapore


def test_day_count():
    ctx = {"start_date": "2026-06-10", "end_date": "2026-06-12",
           "itinerary": {"days": [{}, {}, {}]}}
    assert check_day_count(ctx).status == "pass"
    ctx["itinerary"]["days"] = [{}, {}]
    assert check_day_count(ctx).status == "fail"


def test_source_places_parity():
    ctx = {"places": [_place("A"), _place("B")],
           "itinerary": {"source_places": ["A", "B"]}}
    assert check_source_places_parity(ctx).status == "pass"
    ctx["itinerary"]["source_places"] = ["A"]
    assert check_source_places_parity(ctx).status == "fail"


def test_evidence_verbatim_blocked_without_captions():
    ctx = {"places": [_place("A", ev="A")], "reels": [{"caption": None, "location_name": None}]}
    assert check_evidence_verbatim(ctx).status == "blocked"


def test_evidence_verbatim_pass_and_fail():
    reels = [{"caption": "ate at Ichiran in Shibuya", "location_name": None}]
    assert check_evidence_verbatim(
        {"places": [_place("Ichiran", ev="Ichiran")], "reels": reels}).status == "pass"
    assert check_evidence_verbatim(
        {"places": [_place("X", ev="Not Present")], "reels": reels}).status == "fail"
