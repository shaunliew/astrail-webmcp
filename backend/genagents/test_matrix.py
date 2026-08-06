import httpx
import pytest

from genagents.matrix import Matrix, fetch_matrix


@pytest.fixture(autouse=True)
def _mapbox_token(monkeypatch):
    # fetch_matrix falls back to os.environ["MAPBOX_SECRET_TOKEN"] when no token is passed
    # (mirrors transport.fetch_directions_legs). A dummy value keeps this suite credential-free:
    # httpx.MockTransport means the token is never sent over the wire, so no real secret is needed.
    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")


def _mock(payload: dict, status: int = 200) -> httpx.AsyncClient:
    def handler(request):
        assert "api.mapbox.com/directions-matrix" in str(request.url)
        return httpx.Response(status, json=payload)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_matrix_parses_durations_and_distances():
    # 1 source (hotel) × 2 destinations (places) → row-major 1×2 matrices.
    payload = {
        "code": "Ok",
        "durations": [[573.2, 601.0]],
        "distances": [[1234.5, 1300.0]],
    }
    async with _mock(payload) as client:
        m = await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76), (35.68, 139.77)], client=client)
    assert isinstance(m, Matrix)
    assert m.durations == [[573.2, 601.0]]
    assert m.distances == [[1234.5, 1300.0]]


@pytest.mark.asyncio
async def test_fetch_matrix_sends_lng_lat_coords_and_index_arrays():
    # Coordinate order (Mapbox wants lng,lat) and the sources/destinations INDEX arrays into the
    # combined coord list are both load-bearing — a wrong index maps a duration to the wrong pair.
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"code": "Ok", "durations": [[0.0, 0.0]], "distances": [[0.0, 0.0]]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76), (35.68, 139.77)], client=client)
    # coordinates are lng,lat (longitude first)
    assert "139.75,35.66" in seen["url"]   # source 0
    assert "139.76,35.67" in seen["url"]   # destination 0
    assert "139.77,35.68" in seen["url"]   # destination 1
    # index arrays: 1 source at index 0, 2 destinations at indices 1;2 in the combined list
    assert seen["params"]["sources"] == "0"
    assert seen["params"]["destinations"] == "1;2"
    assert seen["params"]["annotations"] == "duration,distance"


@pytest.mark.asyncio
async def test_fetch_matrix_two_sources_offsets_and_row_mapping():
    # The real ranking case is N>1 sources (≤3 candidate hotels × places). This pins that
    # destination indices are offset by the SOURCE COUNT (not hardcoded to start at 1) and that
    # response row i maps to source i — the one place a future edit could silently transpose.
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["params"] = dict(request.url.params)
        # row-major: row = source, col = destination. Distinct values so a transpose would surface.
        return httpx.Response(200, json={
            "code": "Ok",
            "durations": [[10.0, 11.0, 12.0], [20.0, 21.0, 22.0]],
            "distances": [[100.0, 110.0, 120.0], [200.0, 210.0, 220.0]],
        })

    sources = [(1.0, 10.0), (2.0, 20.0)]                    # 2 hotels (lat,lng)
    destinations = [(3.0, 30.0), (4.0, 40.0), (5.0, 50.0)]  # 3 places
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        m = await fetch_matrix(sources, destinations, client=client)
    # sources occupy combined-list indices 0..1, destinations 2..4 (offset by source count)
    assert seen["params"]["sources"] == "0;1"
    assert seen["params"]["destinations"] == "2;3;4"
    # coords emitted lng,lat, sources first then destinations
    assert "10.0,1.0;20.0,2.0;30.0,3.0;40.0,4.0;50.0,5.0" in seen["url"]
    # row i == source i, col j == destination j (a transpose bug would swap these)
    assert m.durations[0] == [10.0, 11.0, 12.0]   # source 0 → all 3 destinations
    assert m.durations[1] == [20.0, 21.0, 22.0]   # source 1 → all 3 destinations
    assert m.distances[1][2] == 220.0             # source 1 → destination 2


@pytest.mark.asyncio
async def test_fetch_matrix_preserves_null_cell():
    # An unreachable pair is null in Mapbox's matrix — preserve None, never coerce to 0/drop.
    payload = {"code": "Ok", "durations": [[0.0, None]], "distances": [[0.0, None]]}
    async with _mock(payload) as client:
        m = await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76), (35.68, 139.77)], client=client)
    assert m is not None
    assert m.durations == [[0.0, None]]
    assert m.distances == [[0.0, None]]


@pytest.mark.asyncio
async def test_fetch_matrix_non_2xx_returns_none():
    async with _mock({}, status=422) as client:
        m = await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76)], client=client)
    assert m is None


@pytest.mark.asyncio
async def test_fetch_matrix_non_ok_code_returns_none():
    async with _mock({"code": "InvalidInput"}) as client:
        m = await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76)], client=client)
    assert m is None


@pytest.mark.asyncio
async def test_fetch_matrix_network_error_returns_none():
    # A ConnectError/timeout str() carries the request URL (with the token). fetch_matrix must
    # degrade to None WITHOUT re-raising, so nothing token-bearing is ever constructed or logged.
    def handler(request):
        raise httpx.ConnectError("connect boom", request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        m = await fetch_matrix([(35.66, 139.75)], [(35.67, 139.76)], client=client)
    assert m is None


@pytest.mark.asyncio
async def test_fetch_matrix_over_cap_raises_before_network():
    # sources + destinations share ONE coordinate list; >25 combined exceeds the Matrix cap.
    # This is a caller bug (the caller must trim to fit) → raise, and never touch the network.
    called = {"hit": False}

    def handler(request):
        called["hit"] = True
        return httpx.Response(200, json={"code": "Ok", "durations": [[0.0]], "distances": [[0.0]]})

    src = [(35.0 + i * 0.01, 139.0) for i in range(13)]
    dst = [(35.5 + i * 0.01, 139.5) for i in range(13)]   # 13 + 13 = 26 > 25
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ValueError):
            await fetch_matrix(src, dst, client=client)
    assert called["hit"] is False   # guarded before any request was made
