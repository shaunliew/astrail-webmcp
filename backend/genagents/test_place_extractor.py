"""Place-extractor tests. Pure helpers + injected-runner logic stay offline (no key,
no live call). The real extraction is one @pytest.mark.live test, skipped by default."""
from types import SimpleNamespace

import pytest

from genagents.place_extractor import (
    build_extractor_input,
    extract_places,
    is_placeholder_url,
    keep_valid_places,
    _count_web_searches,
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


class _Raw:
    def __init__(self, type_):
        self.type = type_


class _Item:
    def __init__(self, raw):
        self.raw_item = raw


class _Result:
    def __init__(self, items):
        self.new_items = items


def test_count_web_searches_counts_web_search_call_raw_items():
    # Hosted WebSearchTool calls are ToolCallItems whose raw_item.type is "web_search_call".
    result = _Result([
        _Item(_Raw("web_search_call")),
        _Item(_Raw("function_call")),
        _Item(_Raw("web_search_call")),
        _Item({"type": "web_search_call"}),
        _Item(_Raw("reasoning")),
        _Item(None),
    ])
    assert _count_web_searches(result) == 3


def test_count_web_searches_ignores_unrelated_tool_search_items():
    result = _Result([_Item(_Raw("tool_search_call")), _Item(_Raw("file_search_call"))])
    assert _count_web_searches(result) == 0


def test_count_web_searches_no_new_items_returns_zero():
    class _Bare:
        pass

    assert _count_web_searches(_Bare()) == 0
    assert _count_web_searches(_Result([])) == 0


async def test_extract_places_filters_via_injected_runner(monkeypatch):
    import genagents.place_extractor as pe
    monkeypatch.setattr(pe, "build_extractor", lambda model: object())  # keep the test SDK-free

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
    monkeypatch.setattr(pe, "build_extractor", lambda model: object())  # keep the test SDK-free
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


def _reel_with(caption: str) -> ReelData:
    return ReelData(reel_url="manual:x", caption=caption, capture_status="MANUAL")


def test_place_result_name_local_defaults_none():
    p = PlaceResult(name="X", category="other", confidence=0.5, evidence_quote="X")
    assert p.name_local is None


def test_keep_valid_places_keeps_verbatim_name_local():
    # famous venue canonicalized to English `name`, Japanese form present in the caption
    reel = _reel_with("最高の夜景 📍東京タワー at night")
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.95,
                    evidence_quote="📍東京タワー", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1 and kept[0].name_local == "東京タワー"


def test_keep_valid_places_nulls_non_verbatim_name_local_but_keeps_place():
    reel = _reel_with("amazing tower 📍Tokyo Tower")          # no Japanese in caption
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.9,
                    evidence_quote="📍Tokyo Tower", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")                    # not in the caption
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1 and kept[0].name_local is None       # place kept, bad local name dropped


@pytest.mark.live
async def test_live_single_reel_extraction():
    reel = ReelData(reel_url="https://www.instagram.com/reel/DYbmT-SNzVK/",
                    caption="Visited the Doraemon exhibition 📍Tokyo Dream Park",
                    location_name="Tokyo, Japan", capture_status="CAPTURED")
    places = await extract_places(reel)
    assert all(p.lat is not None and p.lng is not None and p.evidence_quote for p in places)
