"""PlaceResult contract — validation + fixture round-trip."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.place import CanonicalPlace, ExtractionResult, PlaceResult

EXPECTED = Path(__file__).parents[1] / "evals" / "fixtures" / "expected_places.json"
MINI = Path(__file__).parents[1] / "pipeline" / "fixtures" / "mini_places.json"


def test_validates_expected_places_fixture():
    places = json.loads(EXPECTED.read_text(encoding="utf-8"))["places"]
    models = [PlaceResult.model_validate(p) for p in places]
    assert len(models) == 8
    assert models[0].name == "Tokyo Dream Park"
    assert models[0].source_type == "reel_extracted"
    # model_dump preserves the keys the eval reads
    d = models[0].model_dump()
    assert {"name", "lat", "lng", "evidence_quote", "source_url"} <= set(d)


def test_validates_minimal_place_fixture():
    # mini_places.json omits city/formatted/source_type — optional fields + default fill in
    places = json.loads(MINI.read_text(encoding="utf-8"))["places"]
    models = [PlaceResult.model_validate(p) for p in places]
    assert [m.name for m in models] == ["Cafe Alpha", "Beta Ramen"]
    assert models[0].source_type == "reel_extracted"  # default
    assert models[0].city_or_region_guess is None


def test_lat_lng_bounds_reject_hallucinated_coords():
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x", lat=200.0)
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x", lng=-999.0)


def test_confidence_bounds_and_source_type_enum():
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=1.5, evidence_quote="x")
    with pytest.raises(ValidationError):
        PlaceResult(name="x", category="other", confidence=0.5, evidence_quote="x",
                    source_type="from_thin_air")


def test_required_fields():
    with pytest.raises(ValidationError):
        PlaceResult(category="other", confidence=0.5, evidence_quote="x")  # missing name


def test_extraction_result_wraps_places():
    er = ExtractionResult(places=[PlaceResult(name="A", category="other",
                                              confidence=0.9, evidence_quote="A")])
    assert er.places[0].name == "A"


def test_canonical_place_adds_times_referenced():
    cp = CanonicalPlace(name="A", category="other", confidence=0.9, evidence_quote="A")
    assert cp.times_referenced == 1
    assert "times_referenced" in cp.model_dump()


def test_round_trip_preserves_eval_read_values():
    # model_validate + model_dump must preserve every value the eval reads, for EVERY
    # fixture place (review finding, Codex P3) — this is the parity-anchor guarantee.
    places = json.loads(EXPECTED.read_text(encoding="utf-8"))["places"]
    for original in places:
        dumped = PlaceResult.model_validate(original).model_dump()
        for key in ("name", "lat", "lng", "evidence_quote", "source_url"):
            assert dumped.get(key) == original.get(key), (original["name"], key)
