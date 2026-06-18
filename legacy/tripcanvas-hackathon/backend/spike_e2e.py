"""
Phase 0.5 end-to-end spike — chains Apify MCP reel scraper → place extraction agent
(WebSearchTool) to verify the full caption-only pipeline.

Supports 1 or more reel URLs:
  - Stage 1 (Apify scrape): sequential within a single MCP context
  - Stage 2 (place extraction): parallel via asyncio.gather — latency = max(single reel)

Verifies:
  1. Apify MCP scrapes reel → structured ReelData (caption, locationName, shortCode)
  2. Place extractor agent (WebSearchTool) identifies real places with lat/lng
  3. output_type=ExtractionResult (Pydantic wrapper) enforces schema
  4. Tier-1 📍 signals in caption → ground-truth venue, anti-hallucination enforced
  5. source_url is a real webpage URL (not a hallucinated placeholder like example.com)

Usage:
    uv run python backend/spike_e2e.py

Required env vars (in .env at project root):
    OPENAI_API_KEY
    APIFY_TOKEN
    DEMO_REEL_URLS  # comma-separated, e.g. https://www.instagram.com/reel/A/,https://...
    DEMO_REEL_URL   # fallback single-URL alias
"""

import asyncio
import json
import os
import re
from typing import Optional
from urllib.parse import urlparse

import openai
from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, ConfigDict, Field

load_dotenv(find_dotenv())

from agents import Agent, ModelSettings, Runner, WebSearchTool
from agents.mcp import MCPServerStreamableHttp

_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)

DEMO_REEL_URL = os.environ.get("DEMO_REEL_URL", "")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class ReelData(BaseModel):
    """Structured output from the Apify reel scraper agent."""

    model_config = ConfigDict(populate_by_name=True)

    caption: str = Field(default="")
    video_url: Optional[str] = Field(None, alias="videoUrl")
    audio_url: Optional[str] = Field(None, alias="audioUrl")
    location_name: Optional[str] = Field(None, alias="locationName")
    location_id: Optional[str] = Field(None, alias="locationId")
    short_code: Optional[str] = Field(None, alias="shortCode")


class PlaceResult(BaseModel):
    """A single identified place with geocoordinates."""

    name: str = Field(description="Canonical name of the place")
    category: str = Field(description="One of: restaurant, hotel, attraction, transport, other")
    city_or_region_guess: str = Field(description="City or region, e.g. 'Tokyo'")
    lat: Optional[float] = Field(None, description="Latitude in decimal degrees", ge=-90.0, le=90.0)
    lng: Optional[float] = Field(None, description="Longitude in decimal degrees", ge=-180.0, le=180.0)
    formatted_address: Optional[str] = Field(None, description="Full address from web search")
    confidence: float = Field(description="0.0–1.0 confidence score", ge=0.0, le=1.0)
    evidence_caption_quote: str = Field(
        description="Exact verbatim phrase copied from the caption or Instagram location tag"
    )
    source_url: Optional[str] = Field(None, description="URL where coordinates were found")


class ExtractionResult(BaseModel):
    """Wrapper required by OpenAI Agents SDK output_type (must be single Pydantic model)."""

    places: list[PlaceResult] = Field(
        description="All identified places. Drop any with confidence < 0.5 or no lat/lng."
    )


# ---------------------------------------------------------------------------
# URL validation helper
# ---------------------------------------------------------------------------

_FAKE_DOMAINS: frozenset[str] = frozenset({
    "example.com", "example.org", "example.net",
    "test.com", "placeholder.com",
    "yourwebsite.com", "website.com",
})
_PLACEHOLDER_PATH_RE = re.compile(
    r"placeholder|example|your[-_]?(url|link|website)|insert[-_]?(url|link)",
    re.IGNORECASE,
)


def is_placeholder_url(url: Optional[str]) -> bool:
    """Return True when url looks like a hallucinated/placeholder value."""
    if not url or not url.strip():
        return True
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return True
    hostname = (parsed.hostname or "").lower()
    if not hostname or "." not in hostname:
        return True
    if hostname in ("localhost", "127.0.0.1", "0.0.0.0"):
        return True
    if any(hostname == d or hostname.endswith("." + d) for d in _FAKE_DOMAINS):
        return True
    # Only flag suspicious paths when combined with a generic/short domain
    if _PLACEHOLDER_PATH_RE.search(url) and len(hostname.split(".")) <= 2 and len(hostname) < 20:
        return True
    return False


# ---------------------------------------------------------------------------
# Stage 1: Reel scraper agent instructions
# ---------------------------------------------------------------------------

REEL_SCRAPER_INSTRUCTIONS = (
    "You have Apify MCP tools. Follow these steps in order:\n"
    "1. Call apify--instagram-reel-scraper with {\"username\": [\"<reel URL>\"], \"resultsLimit\": 1}.\n"
    "2. From the result, get the datasetId from storages.datasets.default.id.\n"
    "3. Call get-dataset-items with that datasetId and "
    "fields=\"caption,videoUrl,audioUrl,locationName,locationId,shortCode\" and limit=1.\n"
    "4. Populate the output fields from the dataset item:\n"
    "   caption      ← caption (empty string if missing)\n"
    "   videoUrl     ← videoUrl\n"
    "   audioUrl     ← audioUrl\n"
    "   locationName ← locationName\n"
    "   locationId   ← locationId\n"
    "   shortCode    ← shortCode\n"
    "Use null for any optional field that is missing or empty."
)

# ---------------------------------------------------------------------------
# Stage 2: Place extractor agent instructions
# ---------------------------------------------------------------------------

PLACE_EXTRACTOR_INSTRUCTIONS = """\
You are a travel place-extraction agent. You receive an Instagram reel caption and an \
optional Instagram location tag.

## MANDATORY RULE — web_search required for every place

You MUST call web_search for EVERY candidate place before populating lat, lng, \
formatted_address, or source_url. Do NOT use training knowledge or prior memory for \
coordinates. Even if you believe you know where a place is, you MUST verify via \
web_search first. Returning a place without a web_search call for it is a violation.

## Step 1 — Scan for explicit location signals FIRST (highest confidence)

Before reading any free text, scan the caption for these creator-tagged signals in priority order:

  TIER 1 (confidence = 0.95): 📍<Name> or 📌<Name> — creator's own pin tag
  TIER 2 (confidence = 0.85): @<Name> — check-in style mention
  TIER 3 (confidence = 0.75): #<PlaceName> — hashtag that is a recognisable venue or \
    place (e.g. #IchiranRamen, #MeijiShrine, #TokyoDreamPark). \
    Skip generic hashtags like #Tokyo or #Travel.

Extract the name text that follows each emoji or # character as a candidate place. \
These candidates are your GROUND TRUTH — they represent what the creator explicitly \
tagged as their location.

## Step 2 — Extract additional places from free text

Scan the caption for any remaining named places (restaurants, cafes, \
shrines, hotels, attractions, transport hubs) not already found in Step 1. \
Ignore generic words like "city", "area", "place".

## Step 3 — Verify each candidate via web_search

For every candidate from Steps 1 and 2:
a. Search: "<candidate name> <city hint> official site OR address coordinates"
b. Read the top result. Check that the result describes the SAME venue as the candidate \
   name — name, category, and city must all match.
c. ANTI-HALLUCINATION CHECK: if the web search returns a well-known venue \
   (e.g. "Tokyo Dome City", "Shibuya Crossing") but that exact venue name does NOT \
   appear anywhere in the caption or location tag, reject this result and search again \
   with a more specific query. Do not accept a famous nearby venue as a stand-in.
d. Record lat/lng and formatted_address ONLY from the verified result.

## Step 4 — Return ExtractionResult

For each PlaceResult:
- name: canonical English name (use the creator-tagged name for Tier 1/2 candidates)
- category: restaurant | hotel | attraction | transport | other
- city_or_region_guess: inferred from context or location hint
- lat / lng: from web search (null if not found)
- formatted_address: MUST include city AND country \
  (e.g. "3-3-8 Ariake, Kōtō-ku, Tokyo, Japan")
- confidence: use tier value from Step 1 for tagged places; \
  0.5–0.7 for free-text-only places
- evidence_caption_quote: COPY THE EXACT PHRASE verbatim from the caption — \
  must be a literal substring, character for character, including emoji \
  if that is how it appears (e.g. "📍Tokyo Dream Park")
- source_url: URL of the page where you found the coordinates

## Rules

- evidence_caption_quote MUST be a verbatim substring of the caption. No paraphrasing.
- A Tier 1 📍-tagged place overrides any conflicting inference from free text. \
  If the caption says 📍Tokyo Dream Park, do NOT return a different venue even if \
  web search suggests a more famous nearby venue.
- Drop places with confidence < 0.5.
- Drop places where you cannot find lat/lng via web search after two attempts.
- Do NOT invent coordinates, addresses, or source URLs — only populate these fields \
  with values returned directly by web_search. Use null for any field you cannot fill \
  from an actual search result.
- source_url MUST be copied verbatim from an actual URL returned by web_search. \
  If no URL is available from the search result, set source_url to null. \
  Do NOT construct, guess, or template a URL. Never use example.com or any placeholder.
- formatted_address must contain both city and country name.
- If caption and location tag are both city-level only (e.g. "Tokyo, Japan") and no \
  specific venue is extractable, return an empty places list rather than inventing a venue.
"""


def build_extractor_input(caption: str, location_name: str) -> str:
    """Build the place extractor input message from reel data."""
    parts: list[str] = []
    if location_name:
        parts.append(
            f"Instagram location tag (highest-confidence signal): {location_name}"
        )
    if caption:
        parts.append(f"Caption:\n{caption}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Item type helpers — covers both ToolCallItem and ToolSearchCallItem
# ---------------------------------------------------------------------------


def _is_tool_call_item(item: object) -> bool:
    """Return True for any SDK item that represents a tool/search call (not its output)."""
    name = type(item).__name__
    return (
        ("ToolCall" in name or "ToolSearch" in name or "FunctionCall" in name)
        and "Output" not in name
        and "Result" not in name
    )


def _is_web_search_call(item: object) -> bool:
    """Return True if item is specifically a web-search tool call."""
    if not _is_tool_call_item(item):
        return False
    name = type(item).__name__
    if "ToolSearch" in name:
        return True
    raw = getattr(item, "raw_item", None)
    tool_name = str(getattr(raw, "name", None) or getattr(raw, "type", "")).lower()
    return "search" in tool_name or "web_search" in tool_name


# ---------------------------------------------------------------------------
# Stage 1 coroutine — scrape one reel
# ---------------------------------------------------------------------------


async def _scrape_reel(
    server: MCPServerStreamableHttp, url: str
) -> tuple[str, ReelData, int]:
    """Scrape a single reel via Apify MCP. Returns (url, reel_data, turns_used)."""
    scraper = Agent(
        name="reel_scraper",
        model="gpt-5.5-2026-04-23",
        instructions=REEL_SCRAPER_INSTRUCTIONS,
        mcp_servers=[server],
        output_type=ReelData,
    )
    try:
        result = await Runner.run(scraper, url, max_turns=6)
    except _MODEL_ERRORS as e:
        print(f"  [WARN] {scraper.model} unavailable ({type(e).__name__}), retrying with gpt-4o")
        scraper = Agent(
            name="reel_scraper",
            model="gpt-4o",
            instructions=REEL_SCRAPER_INSTRUCTIONS,
            mcp_servers=[server],
            output_type=ReelData,
        )
        result = await Runner.run(scraper, url, max_turns=6)
    return url, result.final_output, len(result.new_items)


# ---------------------------------------------------------------------------
# Stage 2 coroutine — extract places for one reel
# ---------------------------------------------------------------------------


async def _extract_for_reel(
    reel: ReelData, url: str
) -> tuple[ExtractionResult, int, int]:
    """Extract places for one reel. Returns (extraction, total_items, web_search_calls).
    parallel_tool_calls=True lets the model fire multiple web searches per turn."""
    extractor_input = build_extractor_input(reel.caption, reel.location_name or "")
    if not extractor_input.strip():
        return ExtractionResult(places=[]), 0, 0

    extractor = Agent(
        name="place_extractor",
        model="gpt-5.5-2026-04-23",
        instructions=PLACE_EXTRACTOR_INSTRUCTIONS,
        tools=[WebSearchTool(search_context_size="high")],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=ExtractionResult,
    )
    try:
        result = await Runner.run(extractor, extractor_input, max_turns=12)
    except _MODEL_ERRORS as e:
        print(f"  [WARN] {extractor.model} unavailable ({type(e).__name__}), retrying with gpt-4o")
        extractor = Agent(
            name="place_extractor",
            model="gpt-4o",
            instructions=PLACE_EXTRACTOR_INSTRUCTIONS,
            tools=[WebSearchTool(search_context_size="high")],
            model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
            output_type=ExtractionResult,
        )
        result = await Runner.run(extractor, extractor_input, max_turns=12)

    if not any(_is_tool_call_item(item) for item in result.new_items):
        raise RuntimeError(
            f"place_extractor [{url}]: zero tool calls "
            f"(total_items={len(result.new_items)}). "
            "Verify tool_choice='required' is supported by the installed model."
        )

    web_search_calls = sum(1 for item in result.new_items if _is_web_search_call(item))
    return result.final_output, len(result.new_items), web_search_calls


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


async def run_spike(reel_urls: list[str]) -> None:
    n = len(reel_urls)
    print("=" * 65)
    print(f"Phase 0.5 E2E Spike — Apify → Place Extraction ({n} reel{'s' if n > 1 else ''})")
    print("=" * 65)
    for i, url in enumerate(reel_urls, 1):
        print(f"  [{i}] {url}")
    print()

    # ------------------------------------------------------------------
    # Stage 1: Scrape all reels sequentially within one MCP context
    # ------------------------------------------------------------------
    print("─" * 65)
    print(f"Stage 1: Apify MCP reel scrape ({n} reel{'s' if n > 1 else ''}, sequential)…\n")

    scrape_records: list[tuple[str, ReelData, int]] = []
    async with MCPServerStreamableHttp(
        name="Apify MCP Server",
        params={
            "url": "https://mcp.apify.com/?tools=actors,docs,apify/instagram-reel-scraper",
            "headers": {"Authorization": f"Bearer {os.environ['APIFY_TOKEN']}"},
            "timeout": 120,
        },
        cache_tools_list=True,
        max_retry_attempts=3,
        client_session_timeout_seconds=300,
    ) as server:
        for url in reel_urls:
            print(f"  Scraping: {url}")
            rec = await _scrape_reel(server, url)
            _, reel, turns = rec
            caption_preview = reel.caption[:80] + "…" if len(reel.caption) > 80 else reel.caption
            print(f"    turns={turns}  location={reel.location_name or '(none)'}")
            print(f"    caption={caption_preview!r}\n")
            scrape_records.append(rec)

    valid_records = [r for r in scrape_records if r[1].caption or r[1].location_name]
    if not valid_records:
        print("[ABORT] All reels returned empty caption + location_name.")
        return
    print(f"  {len(valid_records)}/{n} reels have usable content.\n")

    # ------------------------------------------------------------------
    # Stage 2: Extract places from all reels in parallel
    # ------------------------------------------------------------------
    print("─" * 65)
    print(f"Stage 2: Place extraction ({len(valid_records)} reel{'s' if len(valid_records) > 1 else ''}, parallel)…\n")

    extract_tasks = [_extract_for_reel(reel, url) for url, reel, _ in valid_records]
    extract_records: list[tuple[ExtractionResult, int, int] | BaseException] = (
        await asyncio.gather(*extract_tasks, return_exceptions=True)
    )

    # ------------------------------------------------------------------
    # Per-reel results
    # ------------------------------------------------------------------
    all_places: list[PlaceResult] = []
    total_web_searches = 0

    for idx, ((url, reel, _), extract_record) in enumerate(
        zip(valid_records, extract_records), 1
    ):
        print(f"  ── Reel {idx}: {url}")
        if isinstance(extract_record, BaseException):
            print(f"  [ERROR] {extract_record}\n")
            continue

        extraction, extractor_items, web_search_calls = extract_record
        places = extraction.places
        total_web_searches += web_search_calls

        print(f"  Web search calls : {web_search_calls}")
        print(f"  Total items      : {extractor_items}")
        print(f"  Places found     : {len(places)}\n")

        for i, place in enumerate(places, 1):
            print(f"    [{i}] {place.name}")
            print(f"         category  : {place.category}")
            print(f"         lat/lng   : {place.lat}, {place.lng}")
            print(f"         address   : {place.formatted_address}")
            print(f"         confidence: {place.confidence:.2f}")
            print(f"         evidence  : \"{place.evidence_caption_quote}\"")
            print(f"         source_url: {place.source_url or '(none)'}")
        print()

        all_places.extend(places)

    # ------------------------------------------------------------------
    # Aggregate success criteria
    # ------------------------------------------------------------------
    print("─" * 65)
    print("Aggregate validation…\n")

    places_with_coords = [p for p in all_places if p.lat is not None and p.lng is not None]
    places_without_coords = [p for p in all_places if p.lat is None or p.lng is None]
    places_with_real_source_url = [
        p for p in places_with_coords if not is_placeholder_url(p.source_url)
    ]

    # Per-reel evidence validation (verbatim substring check)
    places_with_valid_evidence: list[PlaceResult] = []
    for (_, reel, _), extract_record in zip(valid_records, extract_records):
        if isinstance(extract_record, BaseException):
            continue
        extraction, _, _ = extract_record
        combined = (reel.caption + " " + (reel.location_name or "")).lower()
        for p in extraction.places:
            if p.evidence_caption_quote and p.evidence_caption_quote.lower() in combined:
                places_with_valid_evidence.append(p)

    failed_reels = sum(1 for r in extract_records if isinstance(r, BaseException))

    criteria = [
        (
            f"All reels scraped successfully — {len(valid_records)}/{n} with content",
            len(valid_records) == n,
        ),
        (
            f"No reel extraction errors — {failed_reels} failed",
            failed_reels == 0,
        ),
        (
            f"≥{n} places with valid lat/lng across all reels — got {len(places_with_coords)}",
            len(places_with_coords) >= n,
        ),
        (
            f"No places returned without lat/lng — {len(places_without_coords)} invalid",
            len(places_without_coords) == 0,
        ),
        (
            f"All evidence_caption_quote are verbatim substrings — "
            f"{len(places_with_valid_evidence)}/{len(all_places)} valid",
            len(all_places) > 0 and len(places_with_valid_evidence) == len(all_places),
        ),
        (
            f"web_search called ≥1 per place total — searches={total_web_searches}, places={len(all_places)}",
            len(all_places) == 0 or total_web_searches >= len(all_places),
        ),
        (
            f"All geocoded places have a real source_url — "
            f"{len(places_with_real_source_url)}/{len(places_with_coords)} valid",
            len(places_with_coords) == 0
            or len(places_with_real_source_url) == len(places_with_coords),
        ),
    ]

    all_pass = True
    for label, passed in criteria:
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {label}")
        if not passed:
            all_pass = False

    print()
    print("=" * 65)
    overall = "ALL CRITERIA MET" if all_pass else "SOME CRITERIA FAILED"
    print(f"Overall: {overall} — {len(all_places)} places from {n} reel{'s' if n > 1 else ''}")
    print("=" * 65)

    print("\nFull extraction JSON:\n")
    output: dict = {"reels": []}
    for (url, reel, _), extract_record in zip(valid_records, extract_records):
        if not isinstance(extract_record, BaseException):
            extraction, _, _ = extract_record
            output["reels"].append({
                "url": url,
                "short_code": reel.short_code,
                "location_name": reel.location_name,
                "places": extraction.model_dump()["places"],
            })
    print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    if not os.environ.get("OPENAI_API_KEY"):
        raise EnvironmentError("OPENAI_API_KEY not set — add it to .env at project root")
    if not os.environ.get("APIFY_TOKEN"):
        raise EnvironmentError("APIFY_TOKEN not set — add it to .env at project root")

    raw_urls = os.environ.get("DEMO_REEL_URLS") or os.environ.get("DEMO_REEL_URL", "")
    reel_urls = [u.strip() for u in raw_urls.split(",") if u.strip()]
    if not reel_urls:
        raise EnvironmentError(
            "No reel URLs configured — set DEMO_REEL_URLS (comma-separated) or "
            "DEMO_REEL_URL in .env"
        )

    asyncio.run(run_spike(reel_urls))
