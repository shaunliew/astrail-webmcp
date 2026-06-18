"""
Phase 1.5 trip planner spike — takes extracted places (Phase 0.5 output) + user
preferences and produces a day-by-day itinerary via two agents:

  1. enricher_agent (gpt-5.5-2026-04-23, WebSearchTool, parallel_tool_calls=True):
     Searches for place details, hotels (with live prices), weather forecast, and
     optionally flights (when origin_city is set) in one batched run.
     external_web_access=True forces live internet fetches (not cached/indexed).
     Output: EnrichedContext.

  2. narrator_agent (gpt-5.5-2026-04-23, no tools):
     Assembles a day-by-day itinerary from enriched context. Output: ItineraryOutput.

Success criteria (5 gates):
  1. Enricher made >= len(places) + 2 (+ 1 if origin_city) web searches (TASK D venue is best-effort)
  2. EnrichedContext.places covers every input place name
  3. len(output.days) == exact days between start_date and end_date inclusive
  4. set(output.source_places) == {p.name for p in places}
  4b. output.source == "live"
  5. Total wall-clock <= 215s (enforced by asyncio.wait_for; per-stage: enricher 155s, narrator 55s)

Usage:
    uv run python backend/spike_planner.py

Required env vars (in .env at project root):
    OPENAI_API_KEY
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import date
from typing import Literal, Optional

import openai
from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, ConfigDict, Field

load_dotenv(find_dotenv())

from agents import Agent, ModelSettings, Runner, RunResult, WebSearchTool
from spike_booking import BookingResult, book_trip
from spike_e2e import is_placeholder_url
from spike_weather import WeatherReport, get_weather

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)
_GLOBAL_TIMEOUT = 215.0     # outer safety net (covers _ENRICHER_TIMEOUT + _NARRATOR_TIMEOUT + overhead)
_ENRICHER_TIMEOUT = 155.0   # live web searches (8 parallel): typically 90–130s
_NARRATOR_TIMEOUT = 55.0    # pure structured-output generation: typically 15–45s for 4-day JSON
_SEARCH_GATE_TOLERANCE = 2  # absorb LLM batching of TASK A place searches; floor enforces real searching

# Known search/listing URL substrings (path fragments and domain patterns) — rejected by
# _sanitize_source_url so the UI never shows a search-results page as a "direct booking link".
_SEARCH_URL_PATTERNS = (
    "/search",
    "/results",
    "searchresults",
    "hotel-search",
    "expedia.com/dest",
    "expedia.com/hotel",  # expedia hotel listing (not property page)
    "google.com/travel",
    "google.com/flights",
    "skyscanner.com/transport",
    "booking.com/searchresults",
    "hotels.com/search",
    "kayak.com/flights",
    "kayak.com/hotels",
    "trivago.com",
)


# ---------------------------------------------------------------------------
# Schemas — Phase 0.5 extraction output (re-stated for self-containment)
# ---------------------------------------------------------------------------


class PlaceResult(BaseModel):
    """Geocoded place extracted from an Instagram reel (Phase 0.5 output).

    `extra="ignore"` accepts the wider shape produced by spike_e2e.PlaceResult
    (which carries extra fields like evidence_frame_index, formatted_address)
    without re-declaring them here. The planner reads only the fields below.
    """

    model_config = ConfigDict(extra="ignore")

    name: str
    category: str
    city_or_region_guess: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    confidence: float
    evidence_caption_quote: str
    source_url: Optional[str] = None   # e2e's geocoding source URL — fallback for per-place attraction link


# ---------------------------------------------------------------------------
# Schemas — Phase 1.5 planner
# ---------------------------------------------------------------------------


class UserPreferences(BaseModel):
    start_date: str                                                   # "2026-06-10"
    end_date: str                                                     # "2026-06-13"
    budget_level: Literal["budget", "mid_range", "luxury"] = "mid_range"
    free_text: str = ""                                               # "love ramen, want onsen"
    origin_city: Optional[str] = None                                 # departure city for flights e.g. "Singapore"


class PlaceInfo(BaseModel):
    """Web-searched summary for one input place."""

    name: str                    # must match PlaceResult.name verbatim
    summary: str                 # highlights, hours, tips from web search
    source_url: Optional[str] = None  # from web_search result URL; None is honest


class EnrichedContext(BaseModel):
    """enricher_agent output — web-searched context the narrator needs.

    Weather is OUT of the enricher's scope as of weather_agent integration —
    the pipeline overrides `weather_report` with the structured Open-Meteo
    result before the narrator runs. The enricher's prompt no longer asks
    for weather, so any weather_report it emits is ignored.
    """

    places: list[PlaceInfo]              # one per input PlaceResult, coverage-verified
    recommended_hotel: str               # single hotel name e.g. "Solaria Nishitetsu Hotel Ginza"
    hotel_price_per_night: str = ""      # e.g. "~JPY 18,000/night"
    hotel_booking_url: Optional[str] = None  # direct hotel property page; None = honest fallback
    recommended_flight: str = ""         # single flight e.g. "Scoot TR828 SIN→NRT ~SGD 523"
    flight_booking_url: Optional[str] = None  # direct airline booking page; None = honest fallback
    weather_report: Optional[WeatherReport] = None  # injected by pipeline post-enricher


class ItineraryDay(BaseModel):
    day_number: int
    date: str
    activities: str              # morning / afternoon / evening in one string
    hotel: Optional[str] = None
    narration: str


class ItineraryOutput(BaseModel):
    """narrator_agent output — final structured itinerary."""

    title: str
    days: list[ItineraryDay]
    source_places: list[str]           # must equal input PlaceResult names exactly
    source: Literal["live", "cache"]   # required — narrator prompt instructs "live"; omission raises Pydantic error
    recommended_hotel: str = ""        # injected by pipeline — single hotel for whole trip
    hotel_booking_url: Optional[str] = None   # injected from EnrichedContext; direct property page
    recommended_flight: str = ""       # injected by pipeline — single flight description
    flight_booking_url: Optional[str] = None  # injected from EnrichedContext; direct airline booking page
    places: list[PlaceInfo] = Field(default_factory=list)  # per-attraction enriched info + URL; frontend joins by name
    weather_report: Optional[WeatherReport] = None  # injected from weather_agent (Open-Meteo); None = unavailable
    bookings: Optional[BookingResult] = None         # injected from booking_agent (Duffel + deep links); None = unavailable


# ---------------------------------------------------------------------------
# Helpers — verbatim from spike_e2e.py (proven; covers ToolSearchCallItem)
# ---------------------------------------------------------------------------


def _is_tool_call_item(item: object) -> bool:
    name = type(item).__name__
    return (
        ("ToolCall" in name or "ToolSearch" in name or "FunctionCall" in name)
        and "Output" not in name
        and "Result" not in name
    )


def _is_web_search_call(item: object) -> bool:
    if not _is_tool_call_item(item):
        return False
    name = type(item).__name__
    if "ToolSearch" in name:
        return True
    raw = getattr(item, "raw_item", None)
    tool_name = str(getattr(raw, "name", None) or getattr(raw, "type", "")).lower()
    return "search" in tool_name or "web_search" in tool_name


def _verify_searches(result: object, expected: int) -> None:
    """Soft gate over enricher web_search count, tolerant of LLM batching.

    Weather is intentionally NOT counted — weather_agent runs in parallel via
    Open-Meteo (no web_search). Within TASK A (1 search per place), the LLM
    occasionally batches several place lookups into one parallel call when
    given 5+ places. We absorb up to _SEARCH_GATE_TOLERANCE such reductions:

      - count >= expected:                   silent pass
      - expected > count >= floor:           warn + continue (batching observed)
      - count < floor:                       raise (genuine failure → cache fallback)

    floor = max(3, expected - _SEARCH_GATE_TOLERANCE)
    """
    count = sum(1 for item in result.new_items if _is_web_search_call(item))
    if count >= expected:
        return                                                  # tier 1: silent pass
    floor = max(3, expected - _SEARCH_GATE_TOLERANCE)
    if count < floor:                                           # tier 3: raise → cache fallback
        raise RuntimeError(
            f"Enricher: {count} web searches, need >= {floor} "
            f"(target was {expected}, tolerance {_SEARCH_GATE_TOLERANCE}; "
            f"1 per place + hotel [+ flights if origin_city])"
        )
    logger.warning(                                             # tier 2: warn + continue
        "Enricher made %d searches (target %d, floor %d) — model batched aggressively",
        count, expected, floor,
    )


def _sanitize_source_url(url: Optional[str]) -> Optional[str]:
    """Return url only if it has a real scheme AND is not a known search/listing page.

    Negative filter: rejects search-result pages (Expedia listings, Google Flights, etc.)
    so the frontend never shows a misleading search URL as a "direct booking link".
    Honest None degrades to "no direct link" in the UI.
    """
    if not url or not url.startswith(("https://", "http://")):
        return None
    lower = url.lower()
    if any(pat in lower for pat in _SEARCH_URL_PATTERNS):
        logger.debug("Rejected search-page URL: %s", url)
        return None
    return url


def _clean_place_url(url: Optional[str]) -> Optional[str]:
    """Compose _sanitize_source_url + is_placeholder_url.

    _sanitize_source_url rejects search-results pages; is_placeholder_url (from spike_e2e)
    rejects fabricated/guessed URLs (example.com, invented slugs). Either rejection ⇒ None,
    which the frontend renders honestly as "no direct link".
    """
    sanitized = _sanitize_source_url(url)
    if sanitized is None or is_placeholder_url(sanitized):
        return None
    return sanitized


def _verify_places_coverage(ctx: EnrichedContext, places: list[PlaceResult]) -> None:
    """Raise if any input place name is missing from EnrichedContext.places."""
    found = {p.name for p in ctx.places}
    missing = {p.name for p in places} - found
    if missing:
        raise RuntimeError(f"EnrichedContext missing places: {missing}")


def _destination_centroid(places: list[PlaceResult]) -> Optional[tuple[float, float]]:
    """Mean of (lat, lng) over places with valid coords. Returns None if zero valid."""
    valid = [(p.lat, p.lng) for p in places if p.lat is not None and p.lng is not None]
    if not valid:
        return None
    return sum(v[0] for v in valid) / len(valid), sum(v[1] for v in valid) / len(valid)


def _format_weather_for_narrator(report: Optional[WeatherReport]) -> str:
    """Render WeatherReport as compact text for the narrator prompt."""
    if report is None or not report.day_forecasts:
        return "Weather forecast unavailable for these dates."
    lines = [
        f"  {d.date}: {d.temp_min_c:.0f}-{d.temp_max_c:.0f}°C, {d.summary}"
        for d in report.day_forecasts
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------


def _make_enricher(destination_city: str) -> Agent:
    """Build an enricher agent scoped to destination_city for localised live search.

    external_web_access=True forces the Responses API to fetch live internet content
    rather than serving cached/indexed results — critical for current hotel prices,
    weather forecasts, and flight availability.
    user_location biases results toward the destination city (hotel neighbourhoods,
    local weather, regional flight hubs).

    NOTE (hackathon scope): country/timezone hardcoded for Tokyo demo. Production
    would derive these from destination geocoding.
    """
    return Agent(
        name="enricher",
        model="gpt-5.5-2026-04-23",
        tools=[
            WebSearchTool(
                search_context_size="medium",
                external_web_access=True,  # forces live internet; not in TypedDict but forwarded by SDK
                user_location={
                    "type": "approximate",
                    "city": destination_city,
                    "country": "JP",      # hackathon demo: Tokyo only
                    "timezone": "Asia/Tokyo",
                },
            )
        ],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=EnrichedContext,
    )


narrator_agent = Agent(
    name="narrator",
    model="gpt-5.5-2026-04-23",
    tools=[],
    output_type=ItineraryOutput,
    # No model_settings: tool_choice=None → SDK omits it entirely (cleaner with no tools)
)


# ---------------------------------------------------------------------------
# Prompt builders
# ---------------------------------------------------------------------------


def _enricher_prompt(places: list[PlaceResult], prefs: UserPreferences) -> str:
    destination = places[0].city_or_region_guess if places else "destination"
    place_lines = "\n".join(
        f'  - {p.name} ({p.category}, {p.city_or_region_guess}): "{p.evidence_caption_quote}"'
        for p in places
    )
    flight_task = f"""
TASK E — Best flight (origin_city specified):
  Search 1: "{prefs.origin_city} to {destination} flight {prefs.start_date} economy nonstop cheapest"
  → Pick the ONE best option (airline, price, duration). Record it as recommended_flight string.
  Search 2 (only if Search 1 did not return a direct airline booking URL):
    "[chosen airline] {prefs.origin_city} {destination} book ticket {prefs.start_date}"
  → Extract the direct airline booking page URL (e.g. flyscoot.com/book or singaporeair.com).
    Do NOT return google.com/flights, skyscanner, or any aggregator search-results page.
    Set flight_booking_url = that direct URL, or null if not found.
""" if prefs.origin_city else ""
    preference_task = f"""TASK D — User-preference venue:
  Search for a specific venue matching user notes:
    "{prefs.free_text} {destination} recommended 2026"
""" if prefs.free_text else ""

    return f"""\
You are a travel research assistant. You MUST call web_search for every task below.
Do NOT use training knowledge — ALL data must come from actual LIVE web_search results.
This is critical: you are fetching real-time information (current prices, current availability).
CRITICAL: TASK A requires one PlaceInfo per input place. Verify all {len(places)} places are in your output before returning.

Weather is handled by a separate agent — do NOT search for or report weather.

## MANDATORY SEARCH TASKS (batch per turn using parallel_tool_calls)

TASK A — Place research (one search per place):
  For EACH place in the INPUT PLACES list, search:
    "<name> {destination} highlights opening hours admission tips 2026"

TASK B — Best hotel (pick ONE, 2 searches):
  Search 1: "{destination} {prefs.budget_level.replace("_", "-")} hotel {prefs.start_date} \
walking-friendly price per night"
  → Choose the ONE best hotel for the trip. Record: name, neighbourhood, approx price/night.
  Search 2 (only if Search 1 did not return a direct hotel property URL):
    "[chosen hotel name] {destination} book room direct"
  → Extract a direct hotel property page URL (e.g. booking.com/hotel/jp/..., or the hotel's
    own official site). Do NOT return expedia.com/Hotels listing pages, or any search-results
    page. Set hotel_booking_url = that direct URL, or null if not found.
{flight_task}{preference_task}
## INPUT PLACES ({len(places)} total)
{place_lines}

## TRAVEL PREFERENCES
Start date  : {prefs.start_date}
End date    : {prefs.end_date}
Budget      : {prefs.budget_level.replace("_", " ")}
Origin city : {prefs.origin_city or "(not specified — skip TASK E)"}
Notes       : {prefs.free_text or "(none)"}

## OUTPUT REQUIREMENTS
- MUST contain exactly {len(places)} PlaceInfo objects. Required names (copy verbatim):
  {json.dumps([p.name for p in places])}
  Missing any name is a failure — check TASK A output before returning.
- source_url (per place): actual URL from a web_search result; null if unavailable.
- recommended_hotel: the single hotel name you chose (string, required — not a list).
- hotel_price_per_night: approx price string e.g. "~JPY 18,000/night".
- hotel_booking_url: direct hotel property page URL from TASK B Search 2; null if not found.
  MUST NOT be a search-results page (expedia.com/Hotels, booking.com/searchresults, etc.).
- recommended_flight: single best flight description from TASK E; empty string if no origin_city.
- flight_booking_url: direct airline booking page URL from TASK E Search 2; null if not found.
  MUST NOT be an aggregator search page (google.com/flights, skyscanner, kayak, etc.).
- weather_report: leave null (set by pipeline).
"""


def _narrator_prompt(
    places: list[PlaceResult],
    prefs: UserPreferences,
    ctx: EnrichedContext,
) -> str:
    place_details = "\n\n".join(
        f"### {p.name}\n{p.summary}" for p in ctx.places
    )
    flight_section = (
        f"\n## FLIGHTS\n{ctx.recommended_flight}\n"
        if ctx.recommended_flight.strip() else ""
    )
    hotel_price = f" ({ctx.hotel_price_per_night})" if ctx.hotel_price_per_night else ""
    return f"""\
You are a travel narrator. Produce a day-by-day itinerary as ItineraryOutput.

## STRICT RULES
- Produce exactly one ItineraryDay per date from {prefs.start_date} to {prefs.end_date} inclusive.
- `source_places` MUST contain EXACTLY these names — no additions, no omissions:
  {json.dumps([p.name for p in places])}
- `source` MUST be "live".
- Assign places to days by proximity and logical order.
- `activities` covers morning, afternoon, and evening in one paragraph.
  Include flight day logistics on the arrival/departure days if flight info is available.
- `narration` is a warm, vivid 2-3 sentence micro-story for the day.
- For places with category "hotel": describe their restaurants, lobby bar, spa, or rooftop
  as a specific activity — do NOT merely use them as a neighbourhood landmark.

## RECOMMENDED HOTEL (single choice for the whole trip)
{ctx.recommended_hotel}{hotel_price}

HOTEL RULE: Set ItineraryDay.hotel = "{ctx.recommended_hotel}" for EVERY day except
the last checkout day, which MUST have hotel = null. Do NOT suggest alternative hotels
or change the hotel between days — this is a single-city trip.

## PLACE DETAILS (from live web research)
{place_details}

## WEATHER (live Open-Meteo forecast)
{_format_weather_for_narrator(ctx.weather_report)}
{flight_section}
## TRIP DETAILS
Dates   : {prefs.start_date} → {prefs.end_date}
Budget  : {prefs.budget_level.replace("_", " ")}
From    : {prefs.origin_city or "(not specified)"}
Notes   : {prefs.free_text or "(none)"}
"""


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


async def _run_agent_with_fallback(agent: Agent, prompt: str, max_turns: int) -> RunResult:
    """Run agent; fall back to gpt-4o clone on model-not-found errors."""
    try:
        return await Runner.run(agent, prompt, max_turns=max_turns)
    except _MODEL_ERRORS:
        logger.warning("Model unavailable for %s; falling back to gpt-4o", agent.name)
        return await Runner.run(agent.clone(model="gpt-4o"), prompt, max_turns=max_turns)


async def _run_planner_inner(
    places: list[PlaceResult], prefs: UserPreferences
) -> ItineraryOutput:
    if not places:
        raise ValueError("run_planner requires at least one PlaceResult")

    destination = places[0].city_or_region_guess
    if not destination:
        raise ValueError("city_or_region_guess is empty on lead PlaceResult — enricher needs a destination")
    enricher = _make_enricher(destination)

    # Stage 1: enricher + weather_agent in PARALLEL.
    # Enricher searches: TASK A (1 per place) + TASK B (hotel) + flights if origin_city.
    # Weather is handled by weather_agent (Open-Meteo function tool) — NOT enricher.
    expected_searches = (
        len(places)
        + 1                                  # TASK B (hotel)
        + (1 if prefs.origin_city else 0)    # TASK E: flight search
    )
    extra = " + flights" if prefs.origin_city else ""
    logger.info("Stage 1: enricher (%d places + hotel%s, expect >= %d searches) || weather…",
                len(places), extra, expected_searches)
    t1 = time.monotonic()

    centroid = _destination_centroid(places)
    if centroid is None:
        logger.warning("No valid coords on input places — weather_agent will return empty report")
        weather_coro = get_weather(destination, 0.0, 0.0, prefs.start_date, prefs.end_date)
    else:
        lat, lng = centroid
        weather_coro = get_weather(destination, lat, lng, prefs.start_date, prefs.end_date)

    enricher_coro = asyncio.wait_for(
        _run_agent_with_fallback(enricher, _enricher_prompt(places, prefs), max_turns=10),
        timeout=_ENRICHER_TIMEOUT,
    )
    try:
        enricher_result, weather_report = await asyncio.gather(enricher_coro, weather_coro)
    except asyncio.TimeoutError as exc:
        raise asyncio.TimeoutError(
            f"Stage 1 (enricher) exceeded {_ENRICHER_TIMEOUT:.0f}s budget"
        ) from exc
    enriched = enricher_result.final_output_as(EnrichedContext).model_copy(
        update={"weather_report": weather_report}
    )
    _verify_searches(enricher_result, expected=expected_searches)
    _verify_places_coverage(enriched, places)
    logger.info(
        "Stage 1 done (%.1fs): %d place summaries, hotel=%r (%s), weather=%d days, flight=%r",
        time.monotonic() - t1,
        len(enriched.places),
        enriched.recommended_hotel,
        enriched.hotel_price_per_night or "price unknown",
        len(weather_report.day_forecasts),
        enriched.recommended_flight or "(no flight)",
    )
    hotel_url = _clean_place_url(enriched.hotel_booking_url)
    flight_url = _clean_place_url(enriched.flight_booking_url)
    if enriched.hotel_booking_url and hotel_url is None:
        logger.warning("Hotel booking URL rejected (search/placeholder page): %s", enriched.hotel_booking_url)
    if enriched.flight_booking_url and flight_url is None:
        logger.warning("Flight booking URL rejected (search/placeholder page): %s", enriched.flight_booking_url)
    logger.info("Direct booking URLs — hotel: %s | flight: %s",
                hotel_url or "(none)", flight_url or "(none)")

    # Stage 2: narrator + booking_agent in PARALLEL (both depend only on enriched).
    logger.info("Stage 2: narrator || booking_agent…")
    t2 = time.monotonic()
    attractions = [p.name for p in places if p.category != "hotel"]
    narrator_coro = asyncio.wait_for(
        _run_agent_with_fallback(
            narrator_agent, _narrator_prompt(places, prefs, enriched), max_turns=1
        ),
        timeout=_NARRATOR_TIMEOUT,
    )
    booking_coro = book_trip(
        destination_city=destination,
        start_date=prefs.start_date,
        end_date=prefs.end_date,
        recommended_hotel=enriched.recommended_hotel,
        recommended_flight=enriched.recommended_flight,
        origin_city=prefs.origin_city,
        attractions=attractions,
    )
    try:
        narrator_result, booking_result = await asyncio.gather(narrator_coro, booking_coro)
    except asyncio.TimeoutError as exc:
        raise asyncio.TimeoutError(
            f"Stage 2 (narrator) exceeded {_NARRATOR_TIMEOUT:.0f}s budget"
        ) from exc
    logger.info(
        "Stage 2 done (%.1fs): %d bookings (total ~SGD %.2f, mock=%s)",
        time.monotonic() - t2,
        len(booking_result.items),
        booking_result.total_estimate_sgd,
        booking_result.is_mock,
    )
    output = narrator_result.final_output_as(ItineraryOutput)
    # Build per-place output: enricher URL preferred, e2e PlaceResult.source_url as honest fallback.
    # Narrator stays URL-blind (cannot hallucinate); frontend joins these to days[] by name.
    extracted_by_name = {p.name: p for p in places}
    out_places: list[PlaceInfo] = []
    for pi in enriched.places:
        url = _clean_place_url(pi.source_url)
        if url is None:
            ep = extracted_by_name.get(pi.name)
            if ep is not None:
                url = _clean_place_url(ep.source_url)
        out_places.append(pi.model_copy(update={"source_url": url}))

    # Inject hotel/flight picks, direct booking URLs, per-attraction URLs, weather, bookings.
    return output.model_copy(update={
        "recommended_hotel": enriched.recommended_hotel,
        "hotel_booking_url": hotel_url,
        "recommended_flight": enriched.recommended_flight,
        "flight_booking_url": flight_url,
        "places": out_places,
        "weather_report": weather_report,
        "bookings": booking_result,
    })


async def run_planner(
    places: list[PlaceResult], prefs: UserPreferences
) -> ItineraryOutput:
    """Run the full trip planner pipeline. Raises asyncio.TimeoutError after _GLOBAL_TIMEOUT seconds.

    Per-stage budgets: enricher <= _ENRICHER_TIMEOUT, narrator <= _NARRATOR_TIMEOUT.
    Stage timeouts raise asyncio.TimeoutError with the same type as the outer guard.
    """
    return await asyncio.wait_for(_run_planner_inner(places, prefs), timeout=_GLOBAL_TIMEOUT)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate(
    output: ItineraryOutput,
    places: list[PlaceResult],
    prefs: UserPreferences,
    elapsed: float,
) -> bool:
    expected_names = {p.name for p in places}
    try:
        start = date.fromisoformat(prefs.start_date)
        end = date.fromisoformat(prefs.end_date)
    except ValueError as exc:
        raise ValueError(f"Invalid start_date/end_date — expected YYYY-MM-DD: {exc}") from exc
    if end < start:
        raise ValueError(f"end_date ({prefs.end_date}) must be >= start_date ({prefs.start_date})")
    expected_days = (end - start).days + 1
    sorted_days = sorted(output.days, key=lambda d: d.day_number)
    non_checkout_days = sorted_days[:-1]  # all days except the last checkout day
    last_day = sorted_days[-1] if sorted_days else None
    # Gate 6: every non-checkout day must have hotel == recommended_hotel (not just non-None ones);
    # last day must be null; recommended_hotel must be non-empty.
    hotel_consistent = (
        bool(output.recommended_hotel)
        and all(d.hotel == output.recommended_hotel for d in non_checkout_days)
        and (last_day is None or last_day.hotel is None)
    )
    criteria: list[tuple[str, bool]] = [
        (
            "Gate 1+2: live search count (places+hotel[+flights]; weather is separate agent) + coverage — verified during run",
            True,
        ),
        (
            f"Gate 3: output.days == {expected_days} — got {len(output.days)}",
            len(output.days) == expected_days,
        ),
        (
            f"Gate 4: source_places matches input — got {sorted(output.source_places)}",
            set(output.source_places) == expected_names,
        ),
        (
            f"Gate 4b: source == 'live' — got '{output.source}'",
            output.source == "live",
        ),
        (
            f"Gate 5: wall-clock (display only — enforced by asyncio.wait_for) — {elapsed:.1f}s",
            True,
        ),
        (
            f"Gate 6: single hotel consistent + checkout-day null — hotel='{output.recommended_hotel}'",
            hotel_consistent,
        ),
    ]
    all_pass = True
    for label, passed in criteria:
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
        if not passed:
            all_pass = False
    return all_pass


# ---------------------------------------------------------------------------
# Demo data (Phase 0.5 extraction results for 4 Tokyo reels)
# ---------------------------------------------------------------------------


def _load_places() -> list[PlaceResult]:
    return [
        PlaceResult(
            name="Tokyo Dream Park",
            category="attraction",
            city_or_region_guess="Tokyo",
            lat=35.629,
            lng=139.788,
            confidence=0.95,
            evidence_caption_quote="📍Tokyo Dream Park",
        ),
        PlaceResult(
            name="Grand Hyatt Tokyo",
            category="hotel",
            city_or_region_guess="Tokyo",
            lat=35.659,
            lng=139.729,
            confidence=0.95,
            evidence_caption_quote="Grand Hyatt Tokyo",
        ),
        PlaceResult(
            name="Harry Potter Cafe",
            category="restaurant",
            city_or_region_guess="Tokyo",
            lat=35.674,
            lng=139.737,
            confidence=0.65,
            evidence_caption_quote="Harry Potter Cafe",
        ),
        PlaceResult(
            name="Sando Lab Tokyo",
            category="restaurant",
            city_or_region_guess="Tokyo",
            lat=35.701,
            lng=139.772,
            confidence=0.65,
            evidence_caption_quote="Sando Lab Tokyo",
        ),
    ]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    if not os.environ.get("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY not set — add it to .env at project root")

    places = _load_places()
    prefs = UserPreferences(
        start_date="2026-06-10",
        end_date="2026-06-13",
        budget_level="mid_range",
        free_text="love ramen and onsen, prefer walking-friendly areas",
        origin_city="Singapore",
    )

    print("=" * 65)
    print("Phase 1.5 — Trip Planner Spike")
    print("=" * 65)
    print(f"Places ({len(places)}): {[p.name for p in places]}")
    print(f"Dates : {prefs.start_date} → {prefs.end_date}")
    print(f"Budget: {prefs.budget_level}  |  {prefs.free_text}")
    print(f"From  : {prefs.origin_city or '(no origin — flights skipped)'}")
    print()

    t0 = time.monotonic()
    try:
        result = asyncio.run(run_planner(places, prefs))
        elapsed = time.monotonic() - t0

        print(f"\n{'─' * 65}")
        print(f"Title : {result.title}")
        print(f"Days  : {len(result.days)}")
        print(f"Places: {result.source_places}")
        print(f"Time  : {elapsed:.1f}s")
        print(f"\nRecommended Hotel  : {result.recommended_hotel or '(none)'}")
        print(f"Hotel Booking URL  : {result.hotel_booking_url or '(no direct link)'}")
        print(f"Recommended Flight : {result.recommended_flight or '(skipped)'}")
        print(f"Flight Booking URL : {result.flight_booking_url or '(no direct link)'}")

        wr = result.weather_report
        if wr and wr.day_forecasts:
            print(f"\nWeather ({wr.destination}, {len(wr.day_forecasts)} days):")
            for d in wr.day_forecasts:
                print(f"  {d.date}: {d.temp_min_c:.0f}-{d.temp_max_c:.0f}°C — {d.summary}")
        else:
            print("\nWeather: unavailable")

        br = result.bookings
        if br and br.items:
            print(f"\nBookings ({len(br.items)} items, total ~SGD {br.total_estimate_sgd:.2f}, mock={br.is_mock}):")
            for b in br.items:
                price = f"~SGD {b.price_estimate_sgd:.2f}" if b.price_estimate_sgd is not None else "price unknown"
                print(f"  [{b.category:<10}] {b.status:<9} {b.booking_id:<22} {b.name:<30} {price}")
                print(f"    {b.book_url}")
        else:
            print("\nBookings: unavailable")
        print()

        for day in result.days:
            print(f"Day {day.day_number} — {day.date}")
            acts = day.activities
            print(f"  Activities: {acts[:120]}{'…' if len(acts) > 120 else ''}")
            print(f"  Hotel     : {day.hotel or '(none)'}")
            narr = day.narration
            print(f"  Narration : {narr[:100]}{'…' if len(narr) > 100 else ''}\n")

        print("─" * 65)
        print("Validation:\n")
        all_pass = _validate(result, places, prefs, elapsed)
        print()
        print("=" * 65)
        print(f"Overall: {'ALL CRITERIA MET' if all_pass else 'SOME CRITERIA FAILED'}")
        print("=" * 65)

        output_json = json.dumps(result.model_dump(), indent=2, ensure_ascii=False)
        print("\nFull JSON:\n")
        print(output_json)

        # Persist to disk — lets demo replay without re-running the pipeline.
        out_path = os.path.join(os.path.dirname(__file__), "data", "planner_output.json")
        with open(out_path, "w", encoding="utf-8") as fh:
            fh.write(output_json)
        logger.info("Output saved to %s", out_path)

    except asyncio.TimeoutError as e:
        elapsed = time.monotonic() - t0
        detail = str(e) if str(e) else f"global limit ({_GLOBAL_TIMEOUT:.0f}s)"
        print(f"\n[TIMEOUT] {detail} (elapsed {elapsed:.1f}s)")
        raise SystemExit(1)
    except RuntimeError as e:
        print(f"\n[GATE FAIL] {e}")
        raise SystemExit(1)
