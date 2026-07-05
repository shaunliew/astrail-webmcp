import pytest

from evals.baseline import (
    build_baseline_itinerary,
    date_range,
    name_only_dedup,
    naive_day_plan,
)


def _p(name, lat=35.66, lng=139.70, conf=0.9):
    return {"name": name, "lat": lat, "lng": lng, "confidence": conf}


def test_date_range_inclusive():
    assert date_range("2026-06-10", "2026-06-12") == ["2026-06-10", "2026-06-11", "2026-06-12"]


def test_date_range_rejects_reversed():
    with pytest.raises(ValueError):
        date_range("2026-06-12", "2026-06-10")


def test_name_only_dedup_keeps_highest_confidence():
    out = name_only_dedup([_p("Ichiran", conf=0.7), _p("ichiran ", conf=0.95)])
    assert len(out) == 1
    assert out[0]["confidence"] == 0.95


def test_name_only_dedup_drops_no_coords():
    out = name_only_dedup([{"name": "X", "lat": None, "lng": None, "confidence": 0.9}])
    assert out == []


def test_name_only_dedup_keeps_distinct_names():
    out = name_only_dedup([_p("A"), _p("B")])
    assert {p["name"] for p in out} == {"A", "B"}


def test_naive_day_plan_even_split():
    days = naive_day_plan([_p(str(i)) for i in range(5)], ["d1", "d2"])
    assert [len(d["place_names"]) for d in days] == [3, 2]
    assert [d["day_number"] for d in days] == [1, 2]


def test_build_baseline_itinerary_shape():
    itin = build_baseline_itinerary([_p("A"), _p("B"), _p("C")], "2026-06-10", "2026-06-11")
    assert len(itin["days"]) == 2
    assert set(itin["source_places"]) == {"A", "B", "C"}
    assert itin["source"] == "baseline"
