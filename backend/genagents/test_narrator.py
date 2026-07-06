"""Narrator tests. Pure helpers + injected-runner logic stay offline (no key, no live call).
The real run is one @pytest.mark.live test, skipped by default."""
from types import SimpleNamespace

import pytest

from genagents.narrator import build_narrator_input, keep_valid_narration, narrate_trip
from models.enrichment import DayNarration, NarrationResult


def _days():
    return [{"day_number": 1, "day_date": "2026-08-01", "weather_summary": "Partly cloudy, 24-31C",
             "places": [{"name": "Tokyo Tower", "place_type": "attraction"}]},
            {"day_number": 2, "day_date": "2026-08-02", "weather_summary": None, "places": []}]


def test_build_input_is_structured_only():
    s = build_narrator_input(_days(), city="Tokyo")
    assert "Tokyo Tower" in s and "Day 1" in s and "Day 2" in s and "Tokyo" in s
    assert "no stops planned" in s  # day 2 empty


def test_keep_valid_narration_drops_unknown_day_and_blanks():
    r = NarrationResult(days=[
        DayNarration(day_number=1, title="Day 1", summary="Good."),
        DayNarration(day_number=9, title="Ghost", summary="not a real day"),
        DayNarration(day_number=2, title="", summary="blank title"),
    ], trip_title="  Tokyo  ", trip_summary="  A short run.  ")
    kept = keep_valid_narration(r, valid_day_numbers={1, 2})
    assert [d.day_number for d in kept.days] == [1]
    assert kept.trip_title == "Tokyo" and kept.trip_summary == "A short run."


def test_keep_valid_narration_dedups_day_numbers():
    r = NarrationResult(days=[DayNarration(day_number=1, title="a", summary="a"),
                              DayNarration(day_number=1, title="b", summary="b")])
    kept = keep_valid_narration(r, valid_day_numbers={1})
    assert len(kept.days) == 1


async def test_narrate_trip_filters_via_injected_runner(monkeypatch):
    import genagents.narrator as n
    monkeypatch.setattr(n, "build_narrator_agent", lambda model: object())

    async def fake_runner(agent, user_input):
        return SimpleNamespace(final_output=NarrationResult(
            days=[DayNarration(day_number=1, title="Day 1: Icons", summary="Tokyo Tower first."),
                  DayNarration(day_number=7, title="Ghost", summary="invented day")],
            trip_title="Tokyo in 2 Days", trip_summary="A compact highlights run."))

    out = await narrate_trip(_days(), city="Tokyo", runner=fake_runner)
    assert [d.day_number for d in out.days] == [1]
    assert out.trip_title == "Tokyo in 2 Days" and out.trip_summary


async def test_narrate_trip_empty_days_short_circuits():
    async def boom(agent, user_input):
        raise AssertionError("runner must not run for an empty trip")
    out = await narrate_trip([], runner=boom)
    assert out.days == [] and out.trip_summary == ""


async def test_narrate_trip_falls_back_on_model_error(monkeypatch):
    import genagents.narrator as n
    monkeypatch.setattr(n, "_model_errors", lambda: (RuntimeError,))
    monkeypatch.setattr(n, "build_narrator_agent", lambda model: object())
    calls = {"n": 0}

    async def flaky(agent, user_input):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("primary down")
        return SimpleNamespace(final_output=NarrationResult(
            days=[DayNarration(day_number=1, title="t", summary="s")], trip_summary="ok"))

    out = await narrate_trip(_days(), runner=flaky)
    assert calls["n"] == 2 and [d.day_number for d in out.days] == [1]


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    import genagents.narrator as n
    importlib.reload(n)
    assert n.keep_valid_narration(NarrationResult(), set()).days == []


@pytest.mark.live
async def test_live_narrates_trip():
    out = await narrate_trip(_days(), city="Tokyo")
    assert out.trip_summary and all(d.title and d.summary for d in out.days)
