from models.tradeoff import (
    TripTradeoffNote, TradeoffOption, TripTradeoffComparison, TripTradeoffs,
)


def test_note_defaults_and_fields():
    n = TripTradeoffNote(kind="long_leg", scope="day", severity="flag",
                         detail="4200 m A -> B", day_number=2, leg_m=4200.0)
    assert n.refs == [] and n.day_number == 2 and n.severity == "flag"


def test_comparison_roundtrips_options():
    a = TradeoffOption(label="Hotel A", value="¥8000/night", pro="cheaper", con="3-star")
    b = TradeoffOption(label="Hotel B", value="¥12000/night", pro="4-star", con="pricier")
    c = TripTradeoffComparison(axis="price_vs_rating", option_a=a, option_b=b,
                               recommendation="Hotel A", refs=["id-a", "id-b"])
    assert c.scope == "hotel" and c.option_a.label == "Hotel A"


def test_tradeoffs_container_defaults_empty():
    t = TripTradeoffs()
    assert t.notes == [] and t.comparisons == []
