"""PlaceResult contract — validation + fixture round-trip."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from models.place import CanonicalPlace, ExtractionResult, PlaceResult

EXPECTED = Path(__file__).parents[1] / "evals" / "fixtures" / "expected_places.json"
MINI = Path(__file__).parents[1] / "pipeline" / "fixtures" / "mini_places.json"


def _place(**overrides):
    values = {
        "name": "Harry Potter Cafe",
        "category": "restaurant",
        "lat": 35.67311,
        "lng": 139.73625,
        "confidence": 0.8,
        "evidence_quote": "Harry Potter Cafe",
        "source_url": "https://hpcafe.jp/",
    }
    values.update(overrides)
    return PlaceResult(**values)


def test_place_result_country_pair_defaults_to_none():
    place = _place()
    assert place.country_code is None
    assert place.country_name is None


def test_place_result_accepts_researched_iso_country_pair():
    place = _place(country_code="JP", country_name="Japan")
    assert (place.country_code, place.country_name) == ("JP", "Japan")


@pytest.mark.parametrize("overrides", [
    {"country_code": "JP", "country_name": None},
    {"country_code": None, "country_name": "Japan"},
    {"country_code": "jpn", "country_name": "Japan"},
    {"country_code": "jp", "country_name": "Japan"},
    {"country_code": "JP", "country_name": "   "},
])
def test_place_result_rejects_invalid_country_pair(overrides):
    with pytest.raises(ValidationError):
        _place(**overrides)


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


def test_extraction_result_caps_provider_verification_fanout():
    places = [
        PlaceResult(name=f"Place {i}", category="other", confidence=0.9, evidence_quote=str(i))
        for i in range(11)
    ]
    with pytest.raises(ValidationError):
        ExtractionResult(places=places)


def test_canonical_place_adds_times_referenced():
    cp = CanonicalPlace(name="A", category="other", confidence=0.9, evidence_quote="A")
    assert cp.times_referenced == 1
    assert "times_referenced" in cp.model_dump()


def test_round_trip_preserves_eval_read_values():
    # model_validate + model_dump must preserve every value the eval reads, for EVERY
    # fixture place across BOTH fixtures (review finding, Codex P3) — the parity guarantee.
    for fixture in (EXPECTED, MINI):
        places = json.loads(fixture.read_text(encoding="utf-8"))["places"]
        for original in places:
            dumped = PlaceResult.model_validate(original).model_dump()
            for key in ("name", "lat", "lng", "evidence_quote", "source_url"):
                assert dumped.get(key) == original.get(key), (fixture.name, original["name"], key)
