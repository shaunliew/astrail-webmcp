"""Offline reel/place sources — the clean replacement for legacy USE_CACHE.

Legacy `spike_e2e_planner.py` toggled a live scrape vs a committed
`data/places.json` with an env var (`USE_CACHE=true`) and ad-hoc file reads.
This module makes the same idea explicit, typed, and immutable:

  * a Source loads a recorded fixture (offline, deterministic, no network),
  * `resolve()` prefers a primary source (e.g. a future live Apify source,
    Step 5) and falls back to the fixture on absence / empty / error,
  * `record_fixture()` is the write-through capture (clean `_write_cached_places`)
    used only by a one-time live capture — NEVER called on the default offline path.

No live OpenAI / Apify / Mapbox / mem0 / Supabase. Stdlib + typing only.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


class FixtureMissing(FileNotFoundError):
    """Raised when a required offline fixture file is absent."""


class Source(Protocol):
    def load(self) -> list[dict]: ...


def _read_list(path: Path, key: str) -> list[dict]:
    if not path.exists():
        raise FixtureMissing(
            f"offline fixture not found: {path} "
            f"(expected a JSON object with a '{key}' array)"
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get(key)
    if not isinstance(items, list):
        raise ValueError(f"fixture {path} missing '{key}' array")
    return items


@dataclass(frozen=True)
class FixtureReelSource:
    """Loads recorded ReelData (caption + location_name) from a JSON fixture."""

    path: Path

    def load(self) -> list[dict]:
        return _read_list(self.path, "reels")


@dataclass(frozen=True)
class FixturePlaceSource:
    """Loads recorded extracted places from a JSON fixture."""

    path: Path

    def load(self) -> list[dict]:
        return _read_list(self.path, "places")


def resolve(primary: Source | None, fixture: Source) -> list[dict]:
    """Fixture-fallback resolution — the clean USE_CACHE ladder.

    Prefer `primary` (a future live source); fall back to `fixture` when primary
    is absent, returns empty, or raises. Step 2 always passes primary=None
    (offline). Step 5 plugs a live Apify source in as `primary` behind this
    same seam — without changing the harness or the eval.

    NOTE (review finding, Codex P3): Step 5 MUST narrow this bare ``except`` and
    log the fallback reason. Silently swallowing a live-source error here would
    mask schema / auth / parser regressions once a real `primary` exists. The
    broad catch is acceptable ONLY while `primary` is always None (Step 2).
    """
    if primary is None:
        return fixture.load()
    try:
        items = primary.load()
    except Exception:
        return fixture.load()
    return items if items else fixture.load()


def record_fixture(path: Path, key: str, items: list[dict]) -> None:
    """Write-through capture: persist `items` under {key} to a JSON fixture.

    The offline-equivalent of legacy `_write_cached_places`. Used only by a
    one-time live capture step (out of the default offline path) to freeze
    scraped reels / extracted places into a fixture. Creates parent dirs.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({key: items}, indent=2, ensure_ascii=False), encoding="utf-8"
    )
