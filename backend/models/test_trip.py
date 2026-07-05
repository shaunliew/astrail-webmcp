"""ItineraryOutput contract — matches the dict shape the eval consumes."""
from models.trip import ItineraryDay, ItineraryOutput


def _itin() -> ItineraryOutput:
    return ItineraryOutput(
        title="Tokyo",
        source="pipeline",
        source_places=["A", "B"],
        days=[ItineraryDay(day_number=1, date="2026-06-10", place_names=["A"]),
              ItineraryDay(day_number=2, date="2026-06-11", place_names=["B"])],
    )


def test_dumps_to_eval_itinerary_shape():
    d = _itin().model_dump()
    assert d["source"] == "pipeline"
    assert d["source_places"] == ["A", "B"]
    assert d["days"][0] == {"day_number": 1, "date": "2026-06-10", "place_names": ["A"]}


def test_day_requires_its_fields():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        ItineraryDay(date="2026-06-10", place_names=[])  # missing day_number
