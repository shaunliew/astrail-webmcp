"""Keyless unit tests for the user-requested-place geocode policy.

No network, no Mapbox token, no Supabase: every test injects a fake `geocode` callable or
exercises a pure function. The gates here are the difference between a provider-verified
coordinate and a model-recited one (Guardrail #1), so each is asserted from BOTH sides.
"""
from __future__ import annotations

import asyncio

import pytest

from geocode import requested_place as rp
from geocode.errors import ResolveError
from models.geocode import GeocodeResult

# Osaka Castle / Universal Studios Japan — the same fixtures the route tests seed.
_OSAKA_ROWS = [
    {"city": "Osaka", "country": "Japan", "country_code": "JP", "lat": 34.6873, "lng": 135.5262},
    {"city": "Osaka", "country": "Japan", "country_code": "jp", "lat": 34.6654, "lng": 135.4323},
]


def _context(rows=None) -> rp.TripGeoContext:
    return rp.build_trip_geo_context(_OSAKA_ROWS if rows is None else rows)


def _found(lat: float, lng: float, *, country_code="JP", country_name="Japan") -> GeocodeResult:
    return GeocodeResult(lat=lat, lng=lng, country_code=country_code, country_name=country_name)


# --------------------------------------------------------------------------- context


def test_build_trip_geo_context_normalizes_every_axis():
    context = _context()
    assert context.cities == frozenset({"osaka"})
    assert context.countries == frozenset({"japan"})
    assert context.country_codes == frozenset({"JP"})          # lowercase row folded up
    assert context.coordinates == ((34.6654, 135.4323), (34.6873, 135.5262))  # sorted: deterministic
    assert context.has_bias is True


def test_build_trip_geo_context_drops_unusable_values():
    context = _context([
        {"city": "  ", "country": None, "country_code": "JPN", "lat": None, "lng": 1.0},
        {"city": None, "country": "", "country_code": "", "lat": True, "lng": False},
        {},
    ])
    assert context.cities == frozenset()
    assert context.countries == frozenset()
    assert context.country_codes == frozenset()   # "JPN" is not alpha-2
    assert context.coordinates == ()              # bools are not coordinates
    assert context.has_bias is False


# --------------------------------------------------------------------------- bias


def test_country_filter_is_the_single_trip_country_lowercased():
    assert rp.country_filter(_context()) == "jp"


def test_country_filter_is_none_for_a_multi_country_trip():
    context = _context(_OSAKA_ROWS + [
        {"city": "Seoul", "country": "South Korea", "country_code": "KR", "lat": 37.5, "lng": 127.0},
    ])
    # A comma-joined filter would be backfilled verbatim into country_code by
    # strict_forward_geocode, producing a value that fails the ^[A-Z]{2}$ shape everywhere.
    assert rp.country_filter(context) is None


def test_country_filter_is_none_without_a_known_country():
    assert rp.country_filter(_context([{"lat": 1.0, "lng": 2.0}])) is None


def test_proximity_bias_is_the_centroid_in_mapbox_lng_lat_order():
    lng, lat = rp.proximity_bias(_context())
    assert lat == pytest.approx((34.6873 + 34.6654) / 2)
    assert lng == pytest.approx((135.5262 + 135.4323) / 2)


def test_proximity_bias_is_none_without_coordinates():
    assert rp.proximity_bias(_context([{"country_code": "JP"}])) is None


# --------------------------------------------------------------------------- accept gate


def test_accept_geocode_accepts_a_result_inside_the_trip():
    assert rp.accept_geocode(_found(34.6544, 135.5064), _context()) is True


def test_accept_geocode_rejects_another_country():
    # Correct name, wrong country: Universal Studios Singapore.
    assert rp.accept_geocode(_found(1.2540, 103.8238, country_code="SG"), _context()) is False


def test_accept_geocode_rejects_a_cross_border_result_the_distance_gate_would_allow():
    """The country gate has to be load-bearing ON ITS OWN.

    Singapore trip, a Johor Bahru result ~25 km away: well inside MAX_TRIP_DISTANCE_M, so only
    the country check can reject it. The same coordinate labelled SG is accepted, which proves
    the rejection is the border and not the distance.
    """
    singapore = _context([
        {"city": "Singapore", "country": "Singapore", "country_code": "SG",
         "lat": 1.2897, "lng": 103.8501},
    ])
    assert rp.accept_geocode(_found(1.4927, 103.7414, country_code="MY"), singapore) is False
    assert rp.accept_geocode(_found(1.4927, 103.7414, country_code="SG"), singapore) is True


def test_accept_geocode_rejects_a_result_far_from_every_trip_stop():
    # Same country, ~1,000 km away (Sapporo) — beyond MAX_TRIP_DISTANCE_M.
    assert rp.accept_geocode(_found(43.0621, 141.3544), _context()) is False


def test_accept_geocode_accepts_a_far_but_in_range_second_city():
    # Tokyo from an Osaka trip is ~400 km — a real multi-city add, inside the bound.
    assert rp.accept_geocode(_found(35.6586, 139.7454), _context()) is True


def test_accept_geocode_rejects_a_result_nothing_can_check():
    # No trip coordinates and no country on either side: nothing was verified, so nothing is trusted.
    context = _context([{"city": "Osaka"}])
    assert rp.accept_geocode(_found(34.65, 135.50, country_code=None), context) is False


def test_accept_geocode_rejects_a_country_less_result_when_the_trip_knows_its_countries():
    """The check the trip CAN run must actually run — even at point-blank range.

    Mapbox omits the country on some responses, and on a multi-country trip nothing backfills it.
    Accepting on distance alone there is how a cross-border venue the traveller never visits gets
    in: this coordinate is 5 km from Osaka Castle, so distance would wave it straight through.
    """
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code=None), _context()) is False
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code=""), _context()) is False
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code="JP"), _context()) is True


def test_accept_geocode_rejects_a_country_less_result_on_a_multi_country_trip():
    """The end-to-end shape of the hole: a two-country trip pins no filter, so a country-less
    response is exactly what Mapbox returns — and Johor Bahru is 25 km from the Singapore stop."""
    multi = _context([
        {"city": "Singapore", "country": "Singapore", "country_code": "SG",
         "lat": 1.2897, "lng": 103.8501},
        {"city": "Osaka", "country": "Japan", "country_code": "JP",
         "lat": 34.6873, "lng": 135.5262},
    ])
    assert rp.country_filter(multi) is None                      # nothing to backfill from
    assert rp.accept_geocode(_found(1.4927, 103.7414, country_code=None), multi) is False
    # A declared, visited country at the same distance is still fine.
    assert rp.accept_geocode(_found(1.3100, 103.8600, country_code="SG"), multi) is True


def test_accept_geocode_rejects_a_malformed_country_code():
    # A joined or otherwise non-alpha-2 value is not a country the trip can be checked against.
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code="JP,KR"), _context()) is False
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code="JPN"), _context()) is False


def test_accept_geocode_uses_distance_when_the_trip_has_no_country_of_its_own():
    """A trip whose places carry no country (a large share of `places` rows) can still be checked
    geographically, and that check stays load-bearing on its own."""
    country_less_trip = _context([
        {"city": "Osaka", "lat": 34.6873, "lng": 135.5262},
        {"city": "Osaka", "lat": 34.6654, "lng": 135.4323},
    ])
    assert country_less_trip.country_codes == frozenset()
    assert rp.accept_geocode(_found(34.6544, 135.5064, country_code=None), country_less_trip) is True
    assert rp.accept_geocode(_found(43.0621, 141.3544, country_code=None), country_less_trip) is False


# ------------------------------------------------------- the agent's own coordinates


def test_accept_agent_coordinates_rejects_a_pin_nowhere_near_the_trip():
    assert rp.accept_agent_coordinates(48.8584, 2.2945, _context()) is False   # Eiffel Tower


def test_accept_agent_coordinates_accepts_a_pin_on_the_trip():
    assert rp.accept_agent_coordinates(34.6544, 135.5064, _context()) is True


def test_accept_agent_coordinates_stays_open_when_the_trip_has_nothing_to_check():
    """The escape hatch is the ONLY way to place the first stop on an empty trip, so a trip with
    no coordinates cannot be allowed to refuse it."""
    assert rp.accept_agent_coordinates(48.8584, 2.2945, rp.EMPTY_TRIP_GEO_CONTEXT) is True
    assert rp.accept_agent_coordinates(48.8584, 2.2945, _context([{"country_code": "JP"}])) is True


# --------------------------------------------------------------------------- resolver


class _Spy:
    def __init__(self, result=None, raises=None, sleep=None):
        self.result = result
        self.raises = raises
        self.sleep = sleep
        self.calls: list[dict] = []

    async def __call__(self, query, **kwargs):
        self.calls.append({"query": query, **kwargs})
        if self.sleep is not None:
            await asyncio.sleep(self.sleep)
        if self.raises is not None:
            raise self.raises
        return self.result


async def test_geocode_requested_place_returns_a_verified_hit():
    spy = _Spy(result=_found(34.6544, 135.5064))
    result = await rp.geocode_requested_place(
        "Dotonbori", _context(), token="sk.test", geocode=spy,
    )
    assert result is not None and (result.lat, result.lng) == (34.6544, 135.5064)


async def test_geocode_requested_place_biases_the_query_with_trip_context():
    spy = _Spy(result=_found(34.6544, 135.5064))
    await rp.geocode_requested_place("Dotonbori", _context(), token="sk.test", geocode=spy)

    call = spy.calls[0]
    assert call["query"] == "Dotonbori"
    assert call["token"] == "sk.test"
    assert call["country"] == "jp"
    assert call["language"] == "en"
    assert call["types"] == rp.GEOCODE_TYPES
    assert call["proximity_lng_lat"] == rp.proximity_bias(_context())


async def test_geocode_requested_place_sends_japanese_script_as_ja():
    spy = _Spy(result=_found(34.6544, 135.5064))
    await rp.geocode_requested_place("道頓堀", _context(), token="sk.test", geocode=spy)
    assert spy.calls[0]["language"] == "ja"


async def test_geocode_requested_place_never_calls_the_provider_without_a_token():
    spy = _Spy(result=_found(34.6544, 135.5064))
    assert await rp.geocode_requested_place("Dotonbori", _context(), token=None, geocode=spy) is None
    assert await rp.geocode_requested_place("Dotonbori", _context(), token="", geocode=spy) is None
    assert spy.calls == []


async def test_geocode_requested_place_never_calls_the_provider_without_trip_bias():
    spy = _Spy(result=_found(34.6544, 135.5064))
    unbiased = _context([{"city": "Osaka"}])   # a name, but nothing to geocode NEAR
    assert await rp.geocode_requested_place("Chinatown", unbiased, token="sk.test", geocode=spy) is None
    assert spy.calls == []


async def test_geocode_requested_place_never_calls_the_provider_for_a_blank_name():
    spy = _Spy(result=_found(34.6544, 135.5064))
    assert await rp.geocode_requested_place("   ", _context(), token="sk.test", geocode=spy) is None
    assert spy.calls == []


async def test_geocode_requested_place_drops_a_result_the_gate_rejects():
    spy = _Spy(result=_found(1.2540, 103.8238, country_code="SG"))
    assert await rp.geocode_requested_place("Chinatown", _context(), token="sk.test", geocode=spy) is None


async def test_geocode_requested_place_returns_none_on_a_provider_miss():
    spy = _Spy(result=None)
    assert await rp.geocode_requested_place("Nowhere", _context(), token="sk.test", geocode=spy) is None


@pytest.mark.parametrize("error", [ResolveError("mapbox down"), RuntimeError("boom")])
async def test_geocode_requested_place_swallows_a_provider_fault(error):
    spy = _Spy(raises=error)
    assert await rp.geocode_requested_place("Dotonbori", _context(), token="sk.test", geocode=spy) is None


async def test_geocode_requested_place_bounds_a_hanging_provider(monkeypatch):
    monkeypatch.setattr(rp, "GEOCODE_TIMEOUT_S", 0.02)
    monkeypatch.setattr(rp, "GEOCODE_DEADLINE_SLACK_S", 0.03)
    spy = _Spy(result=_found(34.6544, 135.5064), sleep=30)

    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await rp.geocode_requested_place("Dotonbori", _context(), token="sk.test", geocode=spy)

    assert result is None
    assert loop.time() - started < 5          # the add is never held open by the provider


async def test_a_single_country_trip_survives_a_country_less_mapbox_response():
    """The demo path, wired through the REAL geocoder rather than a stand-in.

    `accept_geocode` now REJECTS a result that declares no country, which raises an obvious
    worry: Mapbox omits the country from `context` on some Search Box responses, so does
    "add Tokyo Tower to a Japan trip" degrade to asking? No — and the reason is worth pinning.
    A single-country trip DOES send a `country` filter, and `strict_forward_geocode` backfills
    a missing country_code from it, truthfully, because every returned feature is in that
    country by construction. Only a MULTI-country trip sends no filter, and that is exactly the
    case the tightened gate exists to refuse.

    This runs the real `strict_forward_geocode` over an httpx MockTransport, so it fails if that
    backfill is ever removed — a unit-level stand-in for the geocoder could not see it at all.
    """
    import httpx

    from geocode.mapbox_forward import strict_forward_geocode

    seen: dict = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        seen["country"] = request.url.params.get("country")
        return httpx.Response(200, json={"features": [{
            "geometry": {"coordinates": [139.7454, 35.6586]},
            "properties": {"feature_type": "poi", "name": "Tokyo Tower"},   # no `context`, no country
        }]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as http:
        async def _real(query, **kwargs):
            return await strict_forward_geocode(query, client=http, **kwargs)

        result = await rp.geocode_requested_place(
            "Tokyo Tower", _context(), token="sk.test", geocode=_real,
        )

    assert seen["country"] == "jp"                 # the filter the backfill is derived from
    assert result is not None                      # NOT a degradation to "ask for coordinates"
    assert result.country_code == "JP"
    assert (result.lat, result.lng) == (35.6586, 139.7454)


async def test_geocode_requested_place_never_logs_the_token(caplog):
    spy = _Spy(raises=ResolveError("Mapbox forward failed (HTTP 401)"))
    with caplog.at_level("DEBUG"):
        await rp.geocode_requested_place("Dotonbori", _context(), token="sk.secret", geocode=spy)
    assert "sk.secret" not in caplog.text


# --------------------------------------------------------------------------- local-script name


async def test_geocode_requested_place_queries_the_local_name_first():
    """The Japan bug, at the seam. Mapbox's JP POI index carries only Japanese names — an
    English query returns NOTHING — so the local-script name, when the agent knows it, is the
    one that must be sent."""
    spy = _Spy(result=_found(35.63279624, 139.8806725))
    result = await rp.geocode_requested_place(
        "Tokyo Disneyland", _context(), name_local="東京ディズニーランド",
        token="sk.test", geocode=spy,
    )

    assert result is not None
    assert len(spy.calls) == 1                     # the hit costs exactly one paid call
    assert spy.calls[0]["query"] == "東京ディズニーランド"
    assert spy.calls[0]["language"] == "ja"


async def test_geocode_requested_place_falls_back_to_the_plain_name_on_a_miss():
    """The local name is a MODEL'S GUESS: it can be wrong, or simply not the string the provider
    indexed. A guess that misses must not end an add the plain name would have resolved, so the
    plain name gets the second and LAST attempt."""
    class _MissThenHit(_Spy):
        async def __call__(self, query, **kwargs):
            self.calls.append({"query": query, **kwargs})
            return None if len(self.calls) == 1 else _found(34.6544, 135.5064)

    spy = _MissThenHit()
    result = await rp.geocode_requested_place(
        "Gyeongbokgung Palace", _context(), name_local="경복궁", token="sk.test", geocode=spy,
    )

    assert result is not None
    assert [call["query"] for call in spy.calls] == ["경복궁", "Gyeongbokgung Palace"]
    assert [call["language"] for call in spy.calls] == ["en", "en"]   # neither is Japanese script


async def test_geocode_requested_place_retries_the_plain_name_after_a_rejected_result():
    """A result the trip gate refuses is as much a non-answer as a miss."""
    class _RejectThenHit(_Spy):
        async def __call__(self, query, **kwargs):
            self.calls.append({"query": query, **kwargs})
            if len(self.calls) == 1:
                return _found(1.2540, 103.8238, country_code="SG")   # wrong country
            return _found(34.6544, 135.5064)

    spy = _RejectThenHit()
    result = await rp.geocode_requested_place(
        "Dotonbori", _context(), name_local="道頓堀", token="sk.test", geocode=spy,
    )
    assert result is not None and len(spy.calls) == 2


async def test_geocode_requested_place_still_gates_a_local_name_result():
    """The local name buys a better QUERY, never a weaker check: a hit in the wrong country is
    refused exactly as an English one is."""
    spy = _Spy(result=_found(1.2540, 103.8238, country_code="SG"))
    assert await rp.geocode_requested_place(
        "Chinatown", _context(), name_local="牛車水", token="sk.test", geocode=spy,
    ) is None
    assert len(spy.calls) == 2      # both attempts refused; nothing accepted


async def test_geocode_requested_place_makes_one_call_without_a_local_name():
    """The cost regression that matters most: today's path is unchanged at one paid call."""
    spy = _Spy(result=None)
    assert await rp.geocode_requested_place(
        "Nowhere", _context(), token="sk.test", geocode=spy,
    ) is None
    assert len(spy.calls) == 1


async def test_geocode_requested_place_does_not_pay_twice_for_the_same_query():
    spy = _Spy(result=None)
    await rp.geocode_requested_place(
        "東京タワー", _context(), name_local="  東京タワー  ", token="sk.test", geocode=spy,
    )
    assert len(spy.calls) == 1      # the two candidates collapse to one query


async def test_geocode_requested_place_does_not_retry_after_a_provider_fault():
    """A fault is infra, not a miss — a second paid call would most likely buy the same fault."""
    spy = _Spy(raises=ResolveError("mapbox down"))
    assert await rp.geocode_requested_place(
        "Tokyo Disneyland", _context(), name_local="東京ディズニーランド",
        token="sk.test", geocode=spy,
    ) is None
    assert len(spy.calls) == 1


async def test_geocode_requested_place_bounds_both_attempts_with_one_deadline(monkeypatch):
    """Two attempts must not buy twice the wall clock on a user-approved add."""
    monkeypatch.setattr(rp, "GEOCODE_TIMEOUT_S", 0.02)
    monkeypatch.setattr(rp, "GEOCODE_DEADLINE_SLACK_S", 0.03)
    spy = _Spy(result=_found(34.6544, 135.5064), sleep=30)

    loop = asyncio.get_running_loop()
    started = loop.time()
    result = await rp.geocode_requested_place(
        "Tokyo Disneyland", _context(), name_local="東京ディズニーランド",
        token="sk.test", geocode=spy,
    )

    assert result is None
    assert loop.time() - started < 5
