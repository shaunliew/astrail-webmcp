"""UserPreferences contract — covers the japan_second_trip user_profile fixture."""
import json
from pathlib import Path

from models.prefs import UserPreferences

CASE = Path(__file__).parents[1] / "evals" / "cases" / "japan_second_trip.json"


def test_validates_second_trip_user_profile():
    profile = json.loads(CASE.read_text(encoding="utf-8"))["user_profile"]
    prefs = UserPreferences.model_validate({"start_date": "2026-06-10",
                                            "end_date": "2026-06-12", **profile})
    assert prefs.budget_style == "mid_range"
    assert prefs.pace == "relaxed"
    assert prefs.food_preference == ["ramen", "cafes"]
    assert prefs.avoid == ["theme_parks"]


def test_defaults():
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-12")
    assert prefs.budget_style == "mid_range"
    assert prefs.pace is None
    assert prefs.food_preference == []
    assert prefs.free_text == ""
