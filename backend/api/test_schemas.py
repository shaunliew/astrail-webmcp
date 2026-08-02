"""Unit tests for the generation API request schema bounds."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.schemas import GenerateTripRequest, TripFeedbackRequest


def _base_kwargs(**overrides) -> dict:
    kwargs = {"reel_urls": ["https://ig/a"], "start_date": "2026-08-01", "end_date": "2026-08-02"}
    kwargs.update(overrides)
    return kwargs


def test_pace_defaults_to_balanced():
    req = GenerateTripRequest(**_base_kwargs())
    assert req.pace == "balanced"


def test_pace_within_max_length_is_accepted():
    req = GenerateTripRequest(**_base_kwargs(pace="relaxed"))
    assert req.pace == "relaxed"


def test_mixed_reel_urls_and_place_ids_is_rejected():
    # ISSUES-B6: run_generation's `if place_ids:` takes the organized-place branch, so a
    # request carrying both silently drops the Reel URLs and still reports success. No
    # approved product contract merges the two sources -- reject at the boundary.
    with pytest.raises(ValidationError):
        GenerateTripRequest(**_base_kwargs(place_ids=["11111111-1111-1111-1111-111111111111"]))


def test_pace_over_max_length_is_rejected():
    # gstack /review cross-model finding (High): `pace` flows unbounded into LLM prompts
    # (preference_block -> restaurant/narrator) -- the same cost/injection surface
    # `preferences` was already capped at 2000 for (A5). Bound
    # with max_length (NOT Literal -- a Literal would 422-reject any pace value outside
    # a fixed set, a breaking change for the frontend).
    with pytest.raises(ValidationError):
        GenerateTripRequest(**_base_kwargs(pace="x" * 33))


def test_settings_preferences_response_shape():
    from api.schemas import MemoryFact, SettingsPreferencesResponse
    r = SettingsPreferencesResponse(
        status="ok",
        facts=[MemoryFact(id="m1", memory="likes ramen", created_at="2026-07-07T03:08:44")])
    assert r.model_dump() == {
        "status": "ok",
        "facts": [{"id": "m1", "memory": "likes ramen",
                   "created_at": "2026-07-07T03:08:44", "source": "mem0"}],
    }


def test_settings_preferences_defaults_to_empty_facts():
    from api.schemas import SettingsPreferencesResponse
    assert SettingsPreferencesResponse(status="disabled").facts == []


def test_settings_preferences_rejects_unknown_status():
    import pydantic
    from api.schemas import SettingsPreferencesResponse
    with pytest.raises(pydantic.ValidationError):
        SettingsPreferencesResponse(status="probably_fine")


def test_rating_feedback_requires_a_rating():
    with pytest.raises(ValidationError, match="rating is required"):
        TripFeedbackRequest(feedback_type="rating")


def test_non_rating_feedback_rejects_a_rating():
    # A thumbs_up carrying rating=5 is ambiguous: the DB would store both and the
    # analytics query cannot tell which the user meant.
    with pytest.raises(ValidationError, match="rating is only valid"):
        TripFeedbackRequest(feedback_type="thumbs_up", rating=5)


@pytest.mark.parametrize("bad", [0, 6, -1])
def test_rating_outside_one_to_five_is_rejected(bad):
    # Mirrors the DB CHECK feedback_rating_range (rating >= 1 and rating <= 5).
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="rating", rating=bad)


@pytest.mark.parametrize("kind", ["free_text", "correction"])
def test_text_only_feedback_requires_a_comment(kind):
    # Without a comment these rows carry no information at all.
    with pytest.raises(ValidationError, match="comment is required"):
        TripFeedbackRequest(feedback_type=kind)


def test_unknown_feedback_type_is_rejected():
    # Mirrors the DB CHECK feedback_feedback_type_check.
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="five_stars")


def test_comment_longer_than_2000_chars_is_rejected():
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="free_text", comment="x" * 2001)


def test_comment_of_exactly_2000_chars_is_accepted():
    # Boundary: max_length is inclusive. Without this, changing le/lt goes unnoticed.
    assert len(TripFeedbackRequest(feedback_type="free_text", comment="x" * 2000).comment) == 2000


@pytest.mark.parametrize("blank", ["", "   ", "\n\t "])
def test_whitespace_only_comment_is_rejected_for_text_feedback(blank):
    # A bare truthiness check would let "   " through and store an empty-signal row.
    with pytest.raises(ValidationError, match="comment is required"):
        TripFeedbackRequest(feedback_type="free_text", comment=blank)


@pytest.mark.parametrize("sneaky", [True, "4", 5.0])
def test_rating_rejects_non_int_types(sneaky):
    # strict=True. Non-strict Pydantic would coerce True->1, "4"->4, 5.0->5 and silently
    # write a rating the user never gave.
    with pytest.raises(ValidationError):
        TripFeedbackRequest(feedback_type="rating", rating=sneaky)


def test_valid_shapes_are_accepted():
    assert TripFeedbackRequest(feedback_type="rating", rating=4).rating == 4
    assert TripFeedbackRequest(feedback_type="thumbs_up").rating is None
    assert TripFeedbackRequest(feedback_type="rating", rating=1, comment="ok").comment == "ok"
    assert TripFeedbackRequest(feedback_type="free_text", comment="too much walking")
