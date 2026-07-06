"""Restaurant-enricher tests. Mapbox grounding is exercised with httpx.MockTransport and the
LLM labeling with an injected fake runner — both fully offline (no key, no live call). The real
run is one @pytest.mark.live test, skipped by default."""
from types import SimpleNamespace

import httpx
import pytest

from genagents.restaurant import (
    build_label_input,
    fetch_restaurant_pois,
    keep_grounded_restaurants,
    suggest_restaurants,
)
from models.enrichment import RestaurantLabel, RestaurantResult


@pytest.fixture(autouse=True)
def _dummy_mapbox_token(monkeypatch):
    # fetch reads MAPBOX_SECRET_TOKEN before the (mocked) call; MockTransport never sends it.
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "sk.dummy")


_FEATURES = {"features": [
    {"geometry": {"coordinates": [139.7004, 35.6593]},
     "properties": {"name": "ガスト 渋谷駅前店", "full_address": "東京都渋谷区道玄坂2-3-1",
                    "poi_category": ["レストラン>その他", "レストラン"], "mapbox_id": "poi.1", "distance": 25}},
    {"geometry": {"coordinates": [139.7005, 35.6594]},
     "properties": {"name": "サイゴン 渋谷", "full_address": "東京都渋谷区渋谷2-24-1",
                    "poi_category": ["レストラン>ベトナム料理", "レストラン"], "mapbox_id": "poi.2", "distance": 30}},
]}


def _mock_client(payload, status=200):
    def handler(request):
        return httpx.Response(status, json=payload)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_fetch_pois_parses_features():
    pois = await fetch_restaurant_pois(35.6593, 139.7003, client=_mock_client(_FEATURES))
    assert [p["name"] for p in pois] == ["ガスト 渋谷駅前店", "サイゴン 渋谷"]
    assert pois[0]["lat"] == 35.6593 and pois[0]["lng"] == 139.7004
    assert pois[0]["mapbox_id"] == "poi.1" and pois[0]["categories"][0].startswith("レストラン")


async def test_fetch_pois_non_200_is_sanitized():
    with pytest.raises(RuntimeError) as exc:
        await fetch_restaurant_pois(35.6, 139.7, client=_mock_client({}, status=422))
    msg = str(exc.value)
    assert "sk.dummy" not in msg and "access_token" not in msg and "422" in msg


async def test_fetch_pois_request_error_is_sanitized():
    def boom(request):
        raise httpx.ConnectError("boom")
    client = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    with pytest.raises(RuntimeError) as exc:
        await fetch_restaurant_pois(35.6, 139.7, client=client)
    assert "sk.dummy" not in str(exc.value) and "ConnectError" in str(exc.value)


def test_build_label_input_indexes_pois_and_names_stops_no_reel_text():
    pois = [{"name": "ガスト", "categories": ["レストラン"], "address": "東京都渋谷区道玄坂"}]
    s = build_label_input(pois, ["Shibuya Crossing"], city="Tokyo")
    assert "[0]" in s and "ガスト" in s and "Shibuya Crossing" in s and "Tokyo" in s


def test_keep_grounded_uses_real_poi_coords_and_drops_bad_index():
    pois = [{"name": "ガスト", "lat": 35.6593, "lng": 139.7004, "address": "A",
             "mapbox_id": "poi.1", "categories": ["レストラン"], "distance_m": 25}]
    labels = [
        RestaurantLabel(poi_index=0, name_en="Gusto Shibuya", cuisine="family restaurant",
                        summary="Casual all-rounder by the station"),
        RestaurantLabel(poi_index=9, name_en="Ghost", summary="invented — out of range"),
        RestaurantLabel(poi_index=0, name_en="dup", summary="duplicate index"),
    ]
    kept = keep_grounded_restaurants(labels, pois)
    assert len(kept) == 1
    c = kept[0]
    assert c.name == "Gusto Shibuya" and c.cuisine == "family restaurant"
    assert c.name_local == "ガスト" and c.lat == 35.6593 and c.lng == 139.7004   # REAL Mapbox coords
    assert c.mapbox_id == "poi.1"


async def test_suggest_restaurants_end_to_end_grounded(monkeypatch):
    import genagents.restaurant as r
    monkeypatch.setattr(r, "build_label_agent", lambda model: object())

    async def fake_runner(agent, user_input):
        return SimpleNamespace(final_output=RestaurantResult(suggestions=[
            RestaurantLabel(poi_index=1, name_en="Saigon Shibuya", cuisine="vietnamese",
                            summary="Fresh pho a block from the crossing")]))

    kept = await suggest_restaurants([("Shibuya Crossing", 35.6595, 139.7003)], city="Tokyo",
                                     client=_mock_client(_FEATURES), runner=fake_runner)
    assert len(kept) == 1
    assert kept[0].name == "Saigon Shibuya" and kept[0].name_local == "サイゴン 渋谷"
    assert kept[0].lat == 35.6594 and kept[0].mapbox_id == "poi.2"


async def test_suggest_restaurants_empty_places_short_circuits():
    async def boom(agent, user_input):
        raise AssertionError("runner must not be called for an empty place list")
    assert await suggest_restaurants([], runner=boom) == []


async def test_suggest_restaurants_no_pois_skips_llm(monkeypatch):
    async def boom(agent, user_input):
        raise AssertionError("runner must not be called when Mapbox returns no POIs")
    kept = await suggest_restaurants([("A", 35.6, 139.7)], client=_mock_client({"features": []}),
                                     runner=boom)
    assert kept == []


async def test_suggest_restaurants_falls_back_on_model_error(monkeypatch):
    import genagents.restaurant as r
    monkeypatch.setattr(r, "_model_errors", lambda: (RuntimeError,))
    monkeypatch.setattr(r, "build_label_agent", lambda model: object())
    calls = {"n": 0}

    async def flaky_runner(agent, user_input):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("primary model down")
        return SimpleNamespace(final_output=RestaurantResult(suggestions=[
            RestaurantLabel(poi_index=0, name_en="Gusto", summary="ok")]))

    kept = await suggest_restaurants([("A", 35.6, 139.7)], client=_mock_client(_FEATURES),
                                     runner=flaky_runner)
    assert calls["n"] == 2 and [c.name for c in kept] == ["Gusto"]


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("MAPBOX_SECRET_TOKEN", raising=False)
    import importlib

    import genagents.restaurant as r
    importlib.reload(r)
    assert r.keep_grounded_restaurants([], []) == []


@pytest.mark.live
async def test_live_suggests_grounded_restaurants():
    kept = await suggest_restaurants([("Shibuya Crossing", 35.6595, 139.7003)], city="Tokyo")
    assert all(c.lat is not None and c.lng is not None and c.name for c in kept)
