"""Weather enrich agent — Open-Meteo forecast via direct HTTP. No LLM, no auth, no
Agents SDK (structured API data, not untrusted reel content). Import-keyless: httpx
clients are built inside the function, never at module scope. Live-only — never
imported by the offline eval / offline_harness.
"""
from __future__ import annotations

import httpx

from models.enrichment import WeatherReport

_FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
_DAILY = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code"


def _wmo_summary(code: int) -> str:
    """Bucket a WMO weather_code (table 4677) to a short human label."""
    if code == 0:
        return "Clear"
    if code in (1, 2, 3):
        return "Partly cloudy"
    if code in (45, 48):
        return "Fog"
    if code in (51, 53, 55, 56, 57):
        return "Drizzle"
    if code in (61, 63, 65, 66, 67):
        return "Rain"
    if code in (71, 73, 75, 77):
        return "Snow"
    if code in (80, 81, 82):
        return "Showers"
    if code in (85, 86):
        return "Snow showers"
    if code in (95, 96, 99):
        return "Thunderstorm"
    return "Unknown"


async def fetch_weather(lat, lng, dates, *, client: httpx.AsyncClient | None = None) -> list[WeatherReport]:
    """Per-day forecast for lat/lng across the trip's date range. Returns a WeatherReport
    per date that has data (dates beyond the ~16-day horizon come back null → skipped).
    Raises on a non-2xx response — the caller isolates weather as a non-critical stage."""
    if not dates:
        return []
    params = {"latitude": lat, "longitude": lng, "daily": _DAILY,
              "start_date": dates[0], "end_date": dates[-1], "timezone": "auto"}
    owns = client is None
    http = client or httpx.AsyncClient(timeout=30)
    try:
        resp = await http.get(_FORECAST_URL, params=params)
    finally:
        if owns:
            await http.aclose()
    resp.raise_for_status()
    daily = resp.json().get("daily", {})
    times = daily.get("time", []) or []
    tmax = daily.get("temperature_2m_max", []) or []
    tmin = daily.get("temperature_2m_min", []) or []
    precip = daily.get("precipitation_sum", []) or []
    codes = daily.get("weather_code", []) or []
    reports: list[WeatherReport] = []
    for i, day in enumerate(times):
        if i >= len(codes) or codes[i] is None or i >= len(tmax) or tmax[i] is None \
                or i >= len(tmin) or tmin[i] is None:
            continue                                   # skip out-of-horizon / missing days
        code = int(codes[i])
        p = precip[i] if i < len(precip) and precip[i] is not None else 0.0
        reports.append(WeatherReport(
            date=day, temp_min_c=float(tmin[i]), temp_max_c=float(tmax[i]),
            precipitation_mm=float(p), weather_code=code,
            summary=f"{_wmo_summary(code)}, {round(tmin[i])}-{round(tmax[i])}°C"))
    return reports
