import httpx
import pytest

from genagents.weather import _wmo_summary, fetch_weather


def test_wmo_summary_buckets():
    assert _wmo_summary(0) == "Clear"
    assert _wmo_summary(2) == "Partly cloudy"
    assert _wmo_summary(63) == "Rain"
    assert _wmo_summary(75) == "Snow"
    assert _wmo_summary(95) == "Thunderstorm"
    assert _wmo_summary(9999) == "Unknown"


def _mock(daily: dict) -> httpx.AsyncClient:
    def handler(request):
        assert "open-meteo.com" in str(request.url)
        return httpx.Response(200, json={"daily": daily})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_fetch_weather_maps_daily_arrays():
    async with _mock({
        "time": ["2026-08-01", "2026-08-02"],
        "temperature_2m_max": [31.2, 29.0],
        "temperature_2m_min": [24.1, 23.5],
        "precipitation_sum": [0.0, 4.2],
        "weather_code": [2, 63],
    }) as client:
        reports = await fetch_weather(35.66, 139.75, ["2026-08-01", "2026-08-02"], client=client)
    assert len(reports) == 2
    assert reports[0].date == "2026-08-01" and reports[0].weather_code == 2
    assert reports[0].summary.startswith("Partly cloudy")
    assert reports[1].summary.startswith("Rain")
    assert reports[1].precipitation_mm == 4.2


@pytest.mark.asyncio
async def test_fetch_weather_skips_null_days_beyond_horizon():
    async with _mock({
        "time": ["2026-08-01", "2026-08-02"],
        "temperature_2m_max": [31.2, None],
        "temperature_2m_min": [24.1, None],
        "precipitation_sum": [0.0, None],
        "weather_code": [2, None],
    }) as client:
        reports = await fetch_weather(35.66, 139.75, ["2026-08-01", "2026-08-02"], client=client)
    assert len(reports) == 1 and reports[0].date == "2026-08-01"


@pytest.mark.asyncio
async def test_fetch_weather_empty_dates_returns_empty():
    reports = await fetch_weather(35.66, 139.75, [])   # no network call
    assert reports == []


@pytest.mark.asyncio
async def test_fetch_weather_raises_on_http_error():
    def handler(request): return httpx.Response(500)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await fetch_weather(35.66, 139.75, ["2026-08-01"], client=client)
