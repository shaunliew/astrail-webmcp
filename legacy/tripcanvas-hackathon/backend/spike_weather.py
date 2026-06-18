"""
Weather agent spike — calls Open-Meteo (free, no API key) via a function_tool
and returns a structured WeatherReport. Replaces the planner enricher's
free-text weather_summary field.

Key design decisions:
  - 8s HTTP timeout inside fetch_weather; 12s agent wall budget (covers HTTP + model).
  - fetch_weather NEVER raises — returns {"error": ..., "daily": {}} on any failure.
  - get_weather NEVER raises — returns empty WeatherReport on any failure.
  - Primary model gpt-5.5-2026-04-23, typed fallback to gpt-4o.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, datetime

import httpx
import openai
from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, Field

load_dotenv(find_dotenv())

from agents import Agent, Runner, RunResult, function_tool

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)
_WEATHER_AGENT_TIMEOUT = 12.0  # 8s HTTP + ~4s model headroom
_OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
_OPEN_METEO_TIMEOUT = 8.0
_OPEN_METEO_MAX_DAYS = 16  # Open-Meteo's free-tier forecast horizon


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class DayForecast(BaseModel):
    date: str  # YYYY-MM-DD
    temp_min_c: float
    temp_max_c: float
    precipitation_mm: float
    summary: str  # one short sentence, e.g. "Light rain, 14-19°C"


class WeatherReport(BaseModel):
    destination: str
    day_forecasts: list[DayForecast] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Function tool
# ---------------------------------------------------------------------------


@function_tool
async def fetch_weather(
    lat: float, lng: float, start_date: str, end_date: str
) -> dict:
    """Return raw Open-Meteo daily forecast for lat/lng covering start_date..end_date.

    Uses Open-Meteo's start_date/end_date params (NOT forecast_days, which starts
    from today and misses trips scheduled further out). Both dates are YYYY-MM-DD
    and must fall within Open-Meteo's 16-day forecast horizon from today —
    otherwise the API returns the closest available range.

    8s timeout. On any error (5xx, timeout, JSON parse, etc.), returns
    {"error": "<reason>", "daily": {}} so the agent can synthesize an empty report.
    """
    try:
        # Validate date format early — Open-Meteo rejects malformed dates with 400.
        datetime.strptime(start_date, "%Y-%m-%d").date()
        datetime.strptime(end_date, "%Y-%m-%d").date()
        params = {
            "latitude": lat,
            "longitude": lng,
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum",
            "start_date": start_date,
            "end_date": end_date,
            "timezone": "auto",
        }
        async with httpx.AsyncClient(timeout=_OPEN_METEO_TIMEOUT) as client:
            response = await client.get(_OPEN_METEO_URL, params=params)
            response.raise_for_status()
            return response.json()
    except Exception as exc:  # noqa: BLE001 — tool contract: never raise
        logger.warning("fetch_weather failed for (%s, %s): %s", lat, lng, exc)
        return {"error": str(exc), "daily": {}}


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


weather_agent = Agent(
    name="weather_agent",
    model="gpt-5.5-2026-04-23",
    tools=[fetch_weather],
    instructions=(
        "You are a weather research agent. The user gives you a destination, lat/lng, "
        "and trip dates. Call fetch_weather ONCE with those coordinates and the date "
        "range. From the daily arrays in the response, build a WeatherReport whose "
        "day_forecasts list has exactly one DayForecast per date from start_date to "
        "end_date inclusive. Each summary is one short sentence (e.g. \"Light rain, "
        "14-19°C\"). If the tool returned an error or empty daily data, return a "
        "WeatherReport with the given destination and an empty day_forecasts list — "
        "do NOT fabricate weather."
    ),
    output_type=WeatherReport,
)


# ---------------------------------------------------------------------------
# Runner with typed model fallback
# ---------------------------------------------------------------------------


async def _run_agent_with_fallback(agent: Agent, prompt: str, max_turns: int) -> RunResult:
    try:
        return await Runner.run(agent, prompt, max_turns=max_turns)
    except _MODEL_ERRORS:
        logger.warning("Model unavailable for %s; falling back to gpt-4o", agent.name)
        return await Runner.run(agent.clone(model="gpt-4o"), prompt, max_turns=max_turns)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def get_weather(
    destination: str, lat: float, lng: float, start_date: str, end_date: str
) -> WeatherReport:
    """Run weather_agent; return WeatherReport. Always returns — never raises.

    On any exception (timeout, model error, etc.), returns
    WeatherReport(destination=destination, day_forecasts=[]).
    """
    prompt = (
        f"Destination: {destination}\n"
        f"Coordinates: lat={lat}, lng={lng}\n"
        f"Trip dates: {start_date} to {end_date} (inclusive)\n"
        "Call fetch_weather with these coordinates and dates, then produce a WeatherReport."
    )
    try:
        result = await asyncio.wait_for(
            _run_agent_with_fallback(weather_agent, prompt, max_turns=4),
            timeout=_WEATHER_AGENT_TIMEOUT,
        )
        report = result.final_output_as(WeatherReport)
        # Hallucination guard: drop any forecast dates outside the requested range.
        # Code-enforced (not just prompt-enforced) so model defection cannot leak.
        filtered = [
            d for d in report.day_forecasts if start_date <= d.date <= end_date
        ]
        if len(filtered) != len(report.day_forecasts):
            logger.warning(
                "Dropped %d weather forecasts outside [%s, %s] (hallucination guard)",
                len(report.day_forecasts) - len(filtered), start_date, end_date,
            )
        return report.model_copy(update={"day_forecasts": filtered})
    except Exception as exc:  # noqa: BLE001 — public contract: never raise
        logger.warning("get_weather failed for %s: %s", destination, exc)
        return WeatherReport(destination=destination, day_forecasts=[])


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    print("=" * 65)
    print("spike_weather.py smoke test")
    print("=" * 65)
    result = asyncio.run(
        get_weather("Tokyo", 35.6812, 139.7671, "2026-06-10", "2026-06-13")
    )
    print(json.dumps(result.model_dump(), indent=2, ensure_ascii=False))
    assert isinstance(result, WeatherReport)
    assert result.destination == "Tokyo"
    print(f"\nGot {len(result.day_forecasts)} day forecasts")
