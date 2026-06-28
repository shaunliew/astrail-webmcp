from evals.metrics import (
    dedup_error,
    evidence_coverage,
    hallucination_rate,
    mean_intra_day_travel_m,
    weak_source_url_rate,
)


def _place(name, lat=35.66, lng=139.70, ev=None, url="https://grandhyatt.com/x"):
    return {"name": name, "lat": lat, "lng": lng,
            "evidence_quote": ev if ev is not None else name, "source_url": url}


def test_dedup_error():
    assert dedup_error({"places": [1, 2, 3], "expected_unique": 2}) == 1
    assert dedup_error({"places": [1, 2], "expected_unique": 2}) == 0


def test_mean_intra_day_travel():
    ctx = {
        "places": [_place("A", 0.0, 0.0), _place("B", 0.0, 0.01)],
        "itinerary": {"days": [{"place_names": ["A", "B"]}]},
    }
    assert mean_intra_day_travel_m(ctx) > 1000.0


def test_mean_intra_day_travel_single_place_is_zero():
    ctx = {"places": [_place("A", 0.0, 0.0)],
           "itinerary": {"days": [{"place_names": ["A"]}]}}
    assert mean_intra_day_travel_m(ctx) == 0.0


def test_mean_intra_day_travel_does_not_bridge_over_no_coords_place():
    # A -- B(no coords) -- C must NOT be measured as a single A->C leg (no fake adjacency)
    ctx = {
        "places": [_place("A", 0.0, 0.0),
                   {"name": "B", "lat": None, "lng": None, "evidence_quote": "B", "source_url": "u"},
                   _place("C", 0.0, 1.0)],
        "itinerary": {"days": [{"place_names": ["A", "B", "C"]}]},
    }
    assert mean_intra_day_travel_m(ctx) == 0.0  # both legs broken by missing B, not bridged


def test_hallucination_rate_flags_missing_coords_and_placeholder():
    good = _place("A")
    no_coords = {"name": "B", "lat": None, "lng": None, "evidence_quote": "B", "source_url": "x"}
    placeholder = _place("C", url="https://example.com/x")
    assert hallucination_rate({"places": [good, no_coords, placeholder]}) == round(2 / 3, 3)


def test_evidence_coverage_uses_corpus():
    ctx = {
        "places": [_place("A", ev="Ichiran"), _place("B", ev="Made Up")],
        "reels": [{"caption": "ate at Ichiran", "location_name": None}],
    }
    assert evidence_coverage(ctx) == 0.5


def test_evidence_coverage_falls_back_to_meaningful_when_no_captions():
    # no captions -> fall back to "has a meaningful quote". "xyz" counts; "" and " " do not.
    ctx = {
        "places": [_place("A", ev="xyz"),
                   {"name": "B", "lat": 1, "lng": 1, "evidence_quote": "", "source_url": "u"},
                   {"name": "C", "lat": 1, "lng": 1, "evidence_quote": " ", "source_url": "u"}],
        "reels": [{"caption": None, "location_name": None}],
    }
    assert evidence_coverage(ctx) == round(1 / 3, 3)


def test_weak_source_url_rate():
    ctx = {"places": [
        _place("A", url="https://www.google.com/maps/place/x"),  # weak
        _place("B", url="https://grandhyatt.com/x"),             # ok
    ]}
    assert weak_source_url_rate(ctx) == 0.5
