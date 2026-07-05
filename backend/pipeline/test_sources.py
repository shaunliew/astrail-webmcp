"""Fixture/cache source tests — the clean replacement for legacy USE_CACHE.

All offline: reads/writes JSON fixtures only, no network, no API key.
"""
import json
from pathlib import Path

import pytest

from pipeline.sources import (
    FixtureMissing,
    FixturePlaceSource,
    FixtureReelSource,
    record_fixture,
    resolve,
)

FIX = Path(__file__).parent / "fixtures"


def test_fixture_reel_source_loads_recorded_reels():
    reels = FixtureReelSource(FIX / "mini_reels.json").load()
    assert [r["short_code"] for r in reels] == ["MINI_AAA", "MINI_BBB"]


def test_fixture_place_source_loads_recorded_places():
    places = FixturePlaceSource(FIX / "mini_places.json").load()
    assert [p["name"] for p in places] == ["Cafe Alpha", "Beta Ramen"]


def test_missing_fixture_raises_clear_error(tmp_path):
    with pytest.raises(FixtureMissing) as exc:
        FixturePlaceSource(tmp_path / "nope.json").load()
    assert "offline fixture not found" in str(exc.value)


def test_bad_shape_fixture_raises_value_error(tmp_path):
    # present but missing its 'places' array — a contract violation, not empty data
    path = tmp_path / "bad.json"
    path.write_text('{"not_places": []}', encoding="utf-8")
    with pytest.raises(ValueError):
        FixturePlaceSource(path).load()


def test_resolve_uses_fixture_when_primary_is_none():
    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(None, fixture) == fixture.load()


def test_resolve_falls_back_when_primary_empty():
    class _Empty:
        def load(self):
            return []

    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(_Empty(), fixture) == fixture.load()


def test_resolve_falls_back_when_primary_raises():
    class _Boom:
        def load(self):
            raise RuntimeError("live source down")

    fixture = FixtureReelSource(FIX / "mini_reels.json")
    assert resolve(_Boom(), fixture) == fixture.load()


def test_resolve_prefers_primary_when_it_returns_data():
    class _Live:
        def load(self):
            return [{"name": "Live Place"}]

    fixture = FixturePlaceSource(FIX / "mini_places.json")
    assert resolve(_Live(), fixture) == [{"name": "Live Place"}]


def test_record_fixture_round_trips(tmp_path):
    path = tmp_path / "sub" / "out.json"
    items = [{"name": "X"}, {"name": "Y"}]
    record_fixture(path, "places", items)
    assert json.loads(path.read_text(encoding="utf-8")) == {"places": items}
    assert FixturePlaceSource(path).load() == items
