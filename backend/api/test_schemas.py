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


def test_pace_over_max_length_is_rejected():
    # gstack /review cross-model finding (High): `pace` flows unbounded into LLM prompts
    # (preference_block -> restaurant/narrator) and the mem0 synopsis -- the same
    # cost/injection surface `preferences` was already capped at 2000 for (A5). Bound
    # with max_length (NOT Literal -- a Literal would 422-reject any pace value outside
    # a fixed set, a breaking change for the frontend).
    with pytest.raises(ValidationError):
        GenerateTripRequest(**_base_kwargs(pace="x" * 33))
