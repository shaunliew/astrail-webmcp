"""Contract tests for the organizer per-item helpers extracted from `run_organize_job`.

These pin the helper boundary so the leasing, user-scoping and coordinate-cache work
that follows can target `_ground_and_persist` directly. The fake client and the
`PlaceResult` builder are reused from the existing organizer test module.
"""
from __future__ import annotations

from organizer import _ground_and_persist
from test_saved_reels_organize import _Client, _place


async def test_ground_and_persist_empty_grounded_is_location_not_found():
    client = _Client({})

    async def ground(_place_result):
        return None

    terminal, count = await _ground_and_persist(
        client, {"id": "r1"}, "cache-1", [_place()], ground=ground
    )

    assert (terminal, count) == ("location_not_found", 0)
    assert client.db.get("places", []) == []
    assert client.db.get("reel_place_mentions", []) == []


async def test_ground_and_persist_persists_place_and_mention():
    client = _Client({})
    place = _place()

    async def ground(place_result):
        return {"place": place_result, "country_code": "JP", "country_name": "Japan"}

    terminal, count = await _ground_and_persist(
        client, {"id": "r1"}, "cache-1", [place], ground=ground
    )

    assert (terminal, count) == ("organized", 1)
    assert client.db["places"][-1]["name"] == place.name
    assert client.db["places"][-1]["country_code"] == "JP"
    mention = client.db["reel_place_mentions"][-1]
    assert mention["reel_cache_id"] == "cache-1"
    assert mention["place_id"] == client.db["places"][-1]["id"]
    assert mention["verification_version"] == "mapbox-country-v1"
