# backend/pipeline/test_tradeoffs.py
from models.trip import FeasibilityWarning
from pipeline.tradeoffs import build_hotel_comparisons, warnings_to_notes


def _w(kind, day, detail, sev, leg_m=None):
    return FeasibilityWarning(kind=kind, day_number=day, detail=detail, severity=sev, leg_m=leg_m)


def test_warnings_to_notes_maps_fields_and_severity_none_to_info():
    ws = [_w("long_leg", 2, "4200 m A -> B (flag)", "flag", leg_m=4200.0),
          _w("empty_day", 3, "day has no stops", None)]
    notes = warnings_to_notes(ws)
    assert [n.kind for n in notes] == ["long_leg", "empty_day"]
    assert notes[0].scope == "day" and notes[0].leg_m == 4200.0 and notes[0].severity == "flag"
    assert notes[1].severity == "info"          # None -> info
    assert all(n.refs == [] for n in notes)     # no groups passed


def test_warnings_to_notes_fills_refs_from_groups():
    class P:
        def __init__(self, name): self.name = name
    groups = [(2, [P("Senso-ji"), P("Tokyo Tower")])]
    notes = warnings_to_notes([_w("overpacked_day", 2, "…", "warn")], groups=groups)
    assert notes[0].refs == ["Senso-ji", "Tokyo Tower"]


def _hotel(id_, name, price, star, *, key="pricePerNight"):
    return {"id": id_, "name": name, "star_rating": star,
            "price_snapshot": {key: price, "currency": "JPY"}}


def test_build_hotel_comparisons_price_vs_rating():
    rows = [_hotel("a", "Cheap Inn", 8000, 3), _hotel("b", "Grand", 12000, 5)]
    comps = build_hotel_comparisons(rows)
    assert len(comps) == 1
    c = comps[0]
    assert c.axis == "price_vs_rating" and c.scope == "hotel"
    assert set(c.refs) == {"a", "b"}
    assert c.option_a.label == "Cheap Inn" and "8000" in c.option_a.value
    assert "/night" in c.option_a.value          # pricePerNight labeled per-night
    assert c.recommendation is None              # 2-star gap (>1) -> no clear winner


def test_build_hotel_comparisons_recommends_cheaper_on_small_rating_gap():
    rows = [_hotel("a", "Cheap", 8000, 4), _hotel("b", "Grand", 12000, 5)]
    comps = build_hotel_comparisons(rows)
    assert comps[0].recommendation == "Cheap"    # gap == 1 -> recommend cheaper


def test_build_hotel_comparisons_total_price_labeled_total():
    rows = [_hotel("a", "A", 40000, 3, key="totalPrice"),
            _hotel("b", "B", 60000, 4, key="totalPrice")]
    comps = build_hotel_comparisons(rows)
    assert "total" in comps[0].option_a.value    # totalPrice NOT mislabeled as /night


def test_build_hotel_comparisons_edge_cases():
    assert build_hotel_comparisons([]) == []
    assert build_hotel_comparisons([_hotel("a", "Solo", 8000, 3)]) == []
    # both unpriced -> no comparison
    assert build_hotel_comparisons(
        [{"id": "a", "name": "X", "star_rating": 3, "price_snapshot": {}},
         {"id": "b", "name": "Y", "star_rating": 4, "price_snapshot": {}}]) == []
