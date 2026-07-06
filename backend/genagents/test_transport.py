import httpx
import pytest

from genagents.transport import fetch_directions_legs, profile_to_mode


@pytest.fixture(autouse=True)
def _mapbox_token(monkeypatch):
    # fetch_directions_legs reads os.environ["MAPBOX_SECRET_TOKEN"] unconditionally (by
    # design — Task 3's missing-token test relies on the real KeyError). A dummy value here
    # keeps these tests credential-free: httpx.MockTransport means it's never sent over the
    # wire, so no real secret is ever required to run this suite.
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")


def test_profile_to_mode():
    assert profile_to_mode("walking") == "walk"
    assert profile_to_mode("driving") == "drive"
    assert profile_to_mode("driving-traffic") == "drive"
    assert profile_to_mode("cycling") == "cycle"
    assert profile_to_mode("rocket") == "unknown"


def _mock(payload: dict, status: int = 200) -> httpx.AsyncClient:
    def handler(request):
        assert "api.mapbox.com/directions" in str(request.url)
        return httpx.Response(status, json=payload)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_legs_maps_per_leg_duration_distance():
    payload = {"code": "Ok", "routes": [{"legs": [
        {"duration": 610.4, "distance": 820.9},
        {"duration": 300.0, "distance": 410.0},
    ]}]}
    async with _mock(payload) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76), (35.68, 139.77)], client=client)
    assert len(legs) == 2
    assert legs[0] == {"duration_s": 610, "distance_m": 821, "code": "Ok"}
    assert legs[1]["duration_s"] == 300


@pytest.mark.asyncio
async def test_fetch_legs_lng_lat_order_in_url():
    seen = {}
    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"code": "Ok", "routes": [{"legs": [{"duration": 1, "distance": 2}]}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    # coordinates must be lng,lat — longitude (139.x) FIRST
    assert "139.75,35.66" in seen["url"]


@pytest.mark.asyncio
async def test_fetch_legs_under_two_coords_returns_empty():
    legs = await fetch_directions_legs([(35.66, 139.75)])   # no network call
    assert legs == []


@pytest.mark.asyncio
async def test_fetch_legs_no_route_code_marks_all_legs():
    async with _mock({"code": "NoRoute", "routes": []}) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert len(legs) == 1 and legs[0]["code"] == "NoRoute"
    assert legs[0]["duration_s"] is None and legs[0]["distance_m"] is None


@pytest.mark.asyncio
async def test_fetch_legs_raises_sanitized_on_http_error():
    async with _mock({}, status=422) as client:
        with pytest.raises(RuntimeError) as exc:
            await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert "access_token" not in str(exc.value) and "mapbox.com" not in str(exc.value).lower()


@pytest.mark.asyncio
async def test_fetch_legs_sanitizes_network_error():
    # a ConnectError/timeout str() carries the request URL (with the token) — must be sanitized
    def handler(request):
        raise httpx.ConnectError("connect boom", request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(RuntimeError) as exc:
            await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert "access_token" not in str(exc.value) and "139.75" not in str(exc.value)
