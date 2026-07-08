"""compose_preference_summary is a pure function — pin its contract."""
from preferences import compose_preference_summary


def test_profile_and_trip_notes_merge_with_sources():
    profile = {
        "origin_city": "Kuala Lumpur",
        "travel_style_tags": ["food-led", "walkable"],
        "preference_tags": ["ramen", "markets"],
        "preference_notes": "no early mornings",
    }
    summary, sources = compose_preference_summary(profile, "vegetarian this trip")
    assert "Travel style: food-led, walkable." in summary
    assert "Interests: ramen, markets." in summary
    assert "Notes: no early mornings" in summary
    assert "This trip: vegetarian this trip" in summary
    assert sources == ["memory", "explicit"]


def test_no_profile_only_trip_notes():
    summary, sources = compose_preference_summary(None, "halal food only")
    assert summary == "This trip: halal food only"
    assert sources == ["explicit"]


def test_empty_profile_and_no_notes_returns_none():
    summary, sources = compose_preference_summary(
        {"travel_style_tags": [], "preference_tags": [], "preference_notes": None}, None
    )
    assert summary is None
    assert sources == []


def test_profile_only():
    profile = {"travel_style_tags": ["relaxed"], "preference_tags": [], "preference_notes": None}
    summary, sources = compose_preference_summary(profile, None)
    assert summary == "Travel style: relaxed."
    assert sources == ["memory"]
