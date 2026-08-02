"""Unit tests for the generation API request schema bounds."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.schemas import GenerateTripRequest


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
    # (preference_block -> restaurant/narrator) and the mem0 synopsis -- the same
    # cost/injection surface `preferences` was already capped at 2000 for (A5). Bound
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
