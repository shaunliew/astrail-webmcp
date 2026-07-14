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


def test_build_hotel_comparisons_cheapest_also_highest_rated_is_honest():
    # regression (Codex #5): when the CHEAPEST hotel is also the higher-rated one, option_b
    # must NOT be labeled "higher rated", and the cheaper hotel is recommended (it dominates).
    rows = [_hotel("a", "Cheap5", 8000, 5), _hotel("b", "Pricey3", 12000, 3)]
    c = build_hotel_comparisons(rows)[0]
    assert c.option_a.label == "Cheap5"
    assert "higher rated" not in c.option_b.pro
    assert "not higher rated" in c.option_b.con
    assert c.recommendation == "Cheap5"


def test_build_hotel_comparisons_rejects_mixed_currency():
    # regression (Codex #4): comparing prices in different currencies is not fair -> no comparison.
    rows = [{"id": "a", "name": "Yen", "star_rating": 3,
             "price_snapshot": {"pricePerNight": 8000, "currency": "JPY"}},
            {"id": "b", "name": "Dollar", "star_rating": 4,
             "price_snapshot": {"pricePerNight": 100, "currency": "USD"}}]
    assert build_hotel_comparisons(rows) == []


def test_build_hotel_comparisons_never_mixes_price_units():
    # regression (Codex #4): one hotel priced per-night, the other only total -> neither unit has
    # >=2 comparable rows, so no (unit-mismatched) comparison is emitted.
    rows = [_hotel("a", "PerNight", 8000, 3, key="pricePerNight"),
            _hotel("b", "TotalOnly", 40000, 4, key="totalPrice")]
    assert build_hotel_comparisons(rows) == []


def test_build_hotel_comparisons_tiebreak_is_input_order_independent():
    # regression (Codex #3): tied prices must resolve by stable name, not random row id/order.
    h_alpha = _hotel("id-random-1", "Alpha", 8000, 3)
    h_zeta = _hotel("id-random-2", "Zeta", 8000, 5)
    a = build_hotel_comparisons([h_alpha, h_zeta])[0]
    b = build_hotel_comparisons([h_zeta, h_alpha])[0]   # reversed input
    assert a.option_a.label == b.option_a.label == "Alpha"   # name-sorted, order-independent
