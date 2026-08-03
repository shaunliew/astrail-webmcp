import httpx
import pytest

from genagents.transport import (
    _leg_geometry,
    fetch_directions_legs,
    is_drawable_linestring,
    profile_to_mode,
)


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
    # exact dict equality — pins the FULL leg contract, geometry included (this payload has no steps)
    assert legs[0] == {"duration_s": 610, "distance_m": 821, "code": "Ok", "geometry": None}
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
    # Positive assertion the sanitize path actually fired — httpx.ConnectError("connect boom")
    # str()s to just "connect boom" (no URL), so the absence checks above would pass even if
    # the code leaked; this proves the RuntimeError carries the exception TYPE name instead.
    assert "ConnectError" in str(exc.value)


# --------------------------------------------------------------- is_drawable_linestring
# THE MASKING RULE: every validator fixture below carries a SECOND VALID, DISTINCT coordinate.
# Without it, deleting the guard under test leaves a 1-point line, which the DISTINCTNESS guard
# rejects anyway — the test would stay green and prove nothing.


def test_is_drawable_linestring_rejects_wrong_type():
    # Two valid DISTINCT coords are load-bearing: with a degenerate fixture the distinctness
    # guard rejects it anyway and deleting the type check would change nothing.
    geom = {"type": "Polygon", "coordinates": [[139.7, 35.0], [139.8, 35.7]]}
    assert is_drawable_linestring(geom) is False


def test_is_drawable_linestring_rejects_all_identical():
    geom = {"type": "LineString", "coordinates": [[139.7, 35.0], [139.7, 35.0]]}
    assert is_drawable_linestring(geom) is False


def test_is_drawable_linestring_rejects_invalid_point():
    # The ONLY test of the predicate's own `any(c is None ...)` guard: every other bad-coordinate
    # test enters through _leg_geometry, which rejects bad points earlier in its own loop, so the
    # predicate's copy is shadowed. Without this guard `cleaned` is [(139.7,35.0), None],
    # distinctness sees two different values, and the predicate returns True.
    geom = {"type": "LineString", "coordinates": [[139.7, 35.0], [999.0, 35.7]]}
    assert is_drawable_linestring(geom) is False


def test_is_drawable_linestring_rejects_empty_coordinates():
    # distinctness — and no exception (the generator never evaluates cleaned[0] on an empty list)
    assert is_drawable_linestring({"type": "LineString", "coordinates": []}) is False


def test_is_drawable_linestring_rejects_tuple_coordinates():
    # isinstance(coords, list) — nothing else in the suite proves the OUTER container type.
    assert is_drawable_linestring({"type": "LineString", "coordinates": ([1, 2], [3, 4])}) is False


def test_is_drawable_linestring_rejects_mixed_list_and_tuple_identical_points():
    # NORMALIZED comparison. [1,2] != (1,2) in Python but both serialize to [1,2], so comparing
    # the RAW containers would accept a physically all-identical, undrawable line.
    assert is_drawable_linestring({"type": "LineString", "coordinates": [[1, 2], (1, 2)]}) is False


def test_is_drawable_linestring_is_total():
    # DECLARED SHARED property pin — not single-guard attributable. Asserts only "never raises".
    for bad in (None, "str", [], {}, 1, {"type": "LineString"},
                {"type": "LineString", "coordinates": None}):
        assert is_drawable_linestring(bad) is False


# ------------------------------------------------------------------------- _leg_geometry


def test_leg_geometry_collapses_duplicate_step_boundaries():
    # Probe finding 1: 71/71 step boundaries repeat the previous step's last coordinate.
    leg = {"steps": [
        {"geometry": {"coordinates": [[139.70, 35.65], [139.71, 35.66]]}},
        {"geometry": {"coordinates": [[139.71, 35.66], [139.72, 35.67]]}},
    ]}
    assert _leg_geometry(leg) == {"type": "LineString", "coordinates": [
        [139.70, 35.65], [139.71, 35.66], [139.72, 35.67],
    ]}


def test_leg_geometry_collapses_degenerate_arrive_step():
    # Probe finding 2: each leg's final "arrive" step is degenerate ([P, P]). P must appear ONCE.
    leg = {"steps": [
        {"geometry": {"coordinates": [[139.70, 35.65], [139.71, 35.66]]}},
        {"geometry": {"coordinates": [[139.71, 35.66], [139.71, 35.66]]}},
    ]}
    assert _leg_geometry(leg) == {"type": "LineString", "coordinates": [
        [139.70, 35.65], [139.71, 35.66],
    ]}


def test_leg_geometry_none_for_single_point():
    # DISTINCTNESS (there is no length guard — it would be dead code). Remove distinctness and a
    # 1-point LineString is returned.
    leg = {"steps": [{"geometry": {"coordinates": [[139.70, 35.65]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_all_identical_points():
    # DISTINCTNESS, and only distinctness: removing COLLAPSE leaves [P,P], which distinctness
    # still rejects (green); removing DISTINCTNESS makes collapse yield [P], which is returned.
    leg = {"steps": [{"geometry": {"coordinates": [[139.70, 35.65], [139.70, 35.65]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_out_of_range_coord():
    leg = {"steps": [{"geometry": {"coordinates": [[999.0, 35.0], [139.8, 35.7]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_bool_coord():
    # bool is an int subclass — True would otherwise clean to a valid-looking 1.0
    leg = {"steps": [{"geometry": {"coordinates": [[True, 35.0], [139.8, 35.7]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_non_numeric_coord():
    leg = {"steps": [{"geometry": {"coordinates": [["139.7", 35.0], [139.8, 35.7]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_wrong_arity_coord():
    leg = {"steps": [{"geometry": {"coordinates": [[139.7, 35.0, 12.0], [139.8, 35.7]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_dict_coord():
    # CONTAINER TYPE. Without the isinstance check a 2-key dict unpacks its KEYS and yields a
    # drawable-looking (1.0, 2.0).
    leg = {"steps": [{"geometry": {"coordinates": [{1: "x", 2: "y"}, [139.8, 35.7]]}}]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_malformed_step_geometry():
    # isinstance(geometry, dict) — the fixture MUST be a non-dict. With {} the coordinates guard
    # catches it instead and deleting the dict check would leave this green.
    assert _leg_geometry({"steps": [{"geometry": 1}]}) is None


def test_leg_geometry_none_for_non_dict_step():
    assert _leg_geometry({"steps": [1]}) is None


def test_leg_geometry_none_for_non_list_steps():
    # isinstance ONLY — `or []` is a TRUTHINESS guard: {"steps": 1} yields 1 and `for step in 1`
    # raises TypeError, which persist_transport's per-day except converts into losing the whole
    # day's duration/distance.
    assert _leg_geometry({"steps": 1}) is None


def test_leg_geometry_none_for_non_list_coordinates():
    # isinstance(pts, list) — the fixture MUST be an integer. A string is rejected later by
    # _clean_coord anyway, which would leave this green after deleting the intended guard.
    assert _leg_geometry({"steps": [{"geometry": {"coordinates": 1}}]}) is None


def test_leg_geometry_none_for_empty_intermediate_step():
    # NO PARTIAL RESULTS. The preceding step carries 2 distinct valid points, else distinctness
    # masks the guard under test: skipping the empty step would return a plausible-looking
    # polyline that ends in the wrong place.
    leg = {"steps": [
        {"geometry": {"coordinates": [[139.70, 35.65], [139.71, 35.66]]}},
        {"geometry": {"coordinates": []}},
    ]}
    assert _leg_geometry(leg) is None


def test_leg_geometry_none_for_non_dict_leg():
    assert _leg_geometry("not-a-leg") is None


def test_leg_geometry_gate_calls_the_shared_predicate(monkeypatch):
    # THE PRODUCER'S GATE. Without this the gate is bypassable: `return out if len(coords) >= 2
    # else None` passes every other Task 1 test, because the coord loop has already normalized,
    # validated and collapsed by then. The spy must CONTROL, not merely observe — an
    # implementation that calls the predicate and discards its result satisfies an
    # argument-only assertion.
    seen = {}

    def spy(obj):
        seen["arg"] = obj
        return False

    monkeypatch.setattr("genagents.transport.is_drawable_linestring", spy)
    leg = {"steps": [{"geometry": {"coordinates": [[139.70, 35.65], [139.71, 35.66]]}}]}
    assert _leg_geometry(leg) is None
    assert seen["arg"] == {"type": "LineString", "coordinates": [[139.70, 35.65], [139.71, 35.66]]}


def test_leg_geometry_is_total_over_malformed_inputs():
    # DECLARED SHARED property pin — totality, not single-guard attributable. A raise here would
    # be caught by persist_transport's per-day except and lose the whole day's metrics.
    for bad in (None, "x", 1, [], {}, {"steps": None}, {"steps": [None]},
                {"steps": [{"geometry": None}]},
                {"steps": [{"geometry": {"coordinates": None}}]},
                {"steps": [{"geometry": {"coordinates": [None]}}]},
                {"steps": [{"geometry": {"coordinates": [[1]]}}]},
                {"steps": [{"geometry": {"coordinates": [{"a": 1}]}}]}):
        assert _leg_geometry(bad) is None


# ------------------------------------------------------- request params + production wiring


def _capture(seen: dict) -> httpx.AsyncClient:
    def handler(request):
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, json={"code": "Ok", "routes": [{"legs": [
            {"duration": 1, "distance": 2},
        ]}]})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_legs_requests_steps():
    seen = {}
    async with _capture(seen) as client:
        await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert seen["params"]["steps"] == "true"        # per-leg geometry lives in legs[i].steps[j]


@pytest.mark.asyncio
async def test_fetch_legs_requests_geojson_geometries():
    seen = {}
    async with _capture(seen) as client:
        await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert seen["params"]["geometries"] == "geojson"


@pytest.mark.asyncio
async def test_fetch_legs_requests_overview_false():
    seen = {}
    async with _capture(seen) as client:
        await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert seen["params"]["overview"] == "false"    # route-level polyline is dead weight


@pytest.mark.asyncio
async def test_fetch_legs_no_route_legs_carry_null_geometry():
    async with _mock({"code": "NoRoute", "routes": []}) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    # SUBSCRIPT, not .get() — .get() also returns None for a MISSING key
    assert legs[0]["geometry"] is None


@pytest.mark.asyncio
async def test_fetch_directions_legs_builds_distinct_geometry_per_leg():
    # THE PRODUCTION WIRING. Every other test calls _leg_geometry directly, so `"geometry": None`
    # could be written in production and the suite would stay green. Two legs with DISTINCT step
    # geometries also pin per-leg alignment. The steps carry NO duplicate boundaries, so the
    # collapse guard reddens exactly the two collapse tests and this stays about wiring.
    payload = {"code": "Ok", "routes": [{"legs": [
        {"duration": 610.4, "distance": 820.9,
         "steps": [{"geometry": {"coordinates": [[139.70, 35.65], [139.71, 35.66]]}}]},
        {"duration": 300.0, "distance": 410.0,
         "steps": [{"geometry": {"coordinates": [[139.72, 35.67], [139.73, 35.68]]}}]},
    ]}]}
    async with _mock(payload) as client:
        legs = await fetch_directions_legs(
            [(35.66, 139.75), (35.67, 139.76), (35.68, 139.77)], client=client)
    assert legs[0]["geometry"] == {"type": "LineString",
                                   "coordinates": [[139.70, 35.65], [139.71, 35.66]]}
    assert legs[1]["geometry"] == {"type": "LineString",
                                   "coordinates": [[139.72, 35.67], [139.73, 35.68]]}


@pytest.mark.asyncio
async def test_fetch_legs_malformed_steps_preserve_metrics():
    # D1 AT THE SEAM THAT ACTUALLY CONSUMES STEPS. DECLARED SHARED / non-single-guard-
    # attributable: "malformed steps" can be caught by several guards, so this proves the seam
    # end-to-end, not one guard. persist_transport never sees Mapbox steps, so this cannot live
    # in its tests.
    payload = {"code": "Ok", "routes": [{"legs": [
        {"duration": 610.4, "distance": 820.9, "steps": [{"geometry": 1}]},
    ]}]}
    async with _mock(payload) as client:
        legs = await fetch_directions_legs([(35.66, 139.75), (35.67, 139.76)], client=client)
    assert legs[0] == {"duration_s": 610, "distance_m": 821, "code": "Ok", "geometry": None}
