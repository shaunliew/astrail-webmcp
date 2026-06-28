"""Place-extractor tests. Pure helpers + injected-runner logic stay offline (no key,
no live call). The real extraction is one @pytest.mark.live test, skipped by default."""
from types import SimpleNamespace

import pytest

from genagents.place_extractor import (
    build_extractor_input,
    extract_places,
    is_placeholder_url,
    keep_valid_places,
)
from models.place import ExtractionResult, PlaceResult
from models.reel import ReelData


def _reel() -> ReelData:
    return ReelData(reel_url="x", caption="Coffee at 📍Cafe Alpha in Tokyo",
                    location_name="Tokyo, Japan", capture_status="CAPTURED")


def _place(name, ev, lat=35.6, lng=139.7, url=None) -> PlaceResult:
    return PlaceResult(name=name, category="restaurant", confidence=0.9,
                       evidence_quote=ev, lat=lat, lng=lng, source_url=url)


def test_build_input_includes_location_and_caption():
    s = build_extractor_input(_reel())
    assert "Tokyo, Japan" in s and "Cafe Alpha" in s


def test_keep_valid_places_filters():
    kept = keep_valid_places([
        _place("Cafe Alpha", "📍Cafe Alpha"),                         # good → keep
        _place("Ghost Bar", "a place we made up"),                    # evidence not in caption → drop
        _place("No Coords", "Cafe Alpha", lat=None, lng=None),        # null coords → drop
        _place("Fake URL", "Cafe Alpha", url="https://example.com"),  # placeholder url → drop
    ], _reel())
    assert [p.name for p in kept] == ["Cafe Alpha"]


def test_is_placeholder_url():
    assert is_placeholder_url("https://example.com/x") is True
    assert is_placeholder_url("") is True
    assert is_placeholder_url(None) is True
    assert is_placeholder_url("https://tabelog.com/tokyo/123") is False


async def test_extract_places_filters_via_injected_runner():
    async def fake_runner(agent, user_input):
        return SimpleNamespace(final_output=ExtractionResult(places=[
            _place("Cafe Alpha", "📍Cafe Alpha"),
            _place("Ghost Bar", "made up"),
        ]))
    kept = await extract_places(_reel(), runner=fake_runner)
    assert [p.name for p in kept] == ["Cafe Alpha"]


async def test_extract_places_falls_back_on_model_error(monkeypatch):
    import genagents.place_extractor as pe
    monkeypatch.setattr(pe, "_model_errors", lambda: (RuntimeError,))
    calls = {"n": 0}

    async def flaky_runner(agent, user_input):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("primary model down")
        return SimpleNamespace(final_output=ExtractionResult(
            places=[_place("Cafe Alpha", "📍Cafe Alpha")]))

    kept = await extract_places(_reel(), runner=flaky_runner)
    assert calls["n"] == 2  # fell back to gpt-4o
    assert [p.name for p in kept] == ["Cafe Alpha"]


def test_import_needs_no_keys(monkeypatch):
    # importing the module + calling pure helpers requires no key and no live call
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    import importlib

    import genagents.place_extractor as pe
    importlib.reload(pe)
    assert pe.is_placeholder_url("https://example.com") is True


@pytest.mark.live
async def test_live_single_reel_extraction():
    reel = ReelData(reel_url="https://www.instagram.com/reel/DYbmT-SNzVK/",
                    caption="Visited the Doraemon exhibition 📍Tokyo Dream Park",
                    location_name="Tokyo, Japan", capture_status="CAPTURED")
    places = await extract_places(reel)
    assert all(p.lat is not None and p.lng is not None and p.evidence_quote for p in places)
