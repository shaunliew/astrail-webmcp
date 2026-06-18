"""
Phase 0.5 spike — verify an Agent with WebSearchTool can identify real places
from an Instagram reel caption/transcript and return structured coordinates.

Verifies:
  1. Agent recognises named places from free text
  2. Agent returns structured output: {name, lat, lng, formatted_address, confidence}
  3. OpenAI built-in WebSearchTool works (no Tavily key needed)
  4. output_type=ExtractionResult (single Pydantic model) works correctly

Usage:
    cd /path/to/tripcanvas          # project root (pyproject.toml lives here)
    uv run python backend/spike_places.py

Required env vars (in .env at project root):
    OPENAI_API_KEY
"""

import asyncio
import json
import os
from typing import Optional

from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, Field

load_dotenv(find_dotenv())

from agents import Agent, Runner, WebSearchTool

# ---------------------------------------------------------------------------
# Hardcoded sample reel data (no Apify call needed for this spike)
# ---------------------------------------------------------------------------

SAMPLE_CAPTION = (
    "Rainy day in Tokyo 🌧️ Started at Ichiran Ramen in Shibuya, walked to Meiji Shrine, "
    "ended with matcha at % Arabica in Omotesando #Tokyo #Japan"
)

SAMPLE_TRANSCRIPT = (
    "Today we explored Tokyo in the rain. First stop was Ichiran Ramen in Shibuya for "
    "solo dining. Then we walked through the forest to Meiji Shrine. Finished with "
    "amazing coffee at percent Arabica in Omotesando."
)

# ---------------------------------------------------------------------------
# Pydantic schemas (inline — no imports from lib/)
# ---------------------------------------------------------------------------


class PlaceResult(BaseModel):
    """A single identified place with geocoordinates."""

    name: str = Field(description="Canonical name of the place, e.g. 'Ichiran Ramen Shibuya'")
    category: str = Field(
        description="One of: restaurant, hotel, attraction, transport, other"
    )
    city_or_region_guess: str = Field(
        description="City or region where the place is located, e.g. 'Tokyo'"
    )
    lat: Optional[float] = Field(None, description="Latitude in decimal degrees")
    lng: Optional[float] = Field(None, description="Longitude in decimal degrees")
    formatted_address: Optional[str] = Field(
        None, description="Full address string returned by search, e.g. '1-2-3 Udagawacho, Shibuya, Tokyo'"
    )
    confidence: float = Field(
        description="Extraction confidence 0.0–1.0. Drop below 0.5.", ge=0.0, le=1.0
    )
    evidence_caption_quote: str = Field(
        description="Verbatim substring of the caption or transcript that names this place"
    )
    source_url: Optional[str] = Field(
        None, description="URL of the web search result used to find the coordinates"
    )


class ExtractionResult(BaseModel):
    """Wrapper so output_type can be a single Pydantic model (SDK requirement)."""

    places: list[PlaceResult] = Field(
        description="All places found, each with coordinates. Drop places with confidence < 0.5."
    )


# ---------------------------------------------------------------------------
# Agent definition
# ---------------------------------------------------------------------------

PLACE_EXTRACTOR_INSTRUCTIONS = """\
You are a travel place-extraction agent. You receive an Instagram reel caption and audio \
transcript. Your job is to:

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

Scan the caption and transcript for any remaining named places (restaurants, cafes, \
shrines, hotels, attractions, transport hubs) not already found in Step 1. \
Ignore generic words like "city", "area", "place".

## Step 3 — Verify each candidate via web_search

For every candidate from Steps 1 and 2:
a. Search: "<candidate name> <city hint> official site OR address coordinates"
b. Read the top result. Check that the result describes the SAME venue as the candidate \
   name — name, category, and city must all match.
c. ANTI-HALLUCINATION CHECK: if the web search returns a well-known venue \
   (e.g. "Tokyo Dome City", "Shibuya Crossing") but that exact venue name does NOT \
   appear anywhere in the caption or transcript, reject this result and search again \
   with a more specific query. Do not accept a famous nearby venue as a stand-in.
d. Record lat/lng and formatted_address ONLY from the verified result.

## Step 4 — Return ExtractionResult

For each PlaceResult:
- name: canonical English name (use the creator-tagged name for Tier 1/2 candidates)
- category: restaurant | hotel | attraction | transport | other
- city_or_region_guess: inferred from context
- lat / lng: decimal degrees from your web search (null if not found)
- formatted_address: MUST include city AND country \
  (e.g. "3-3-8 Ariake, Kōtō-ku, Tokyo, Japan")
- confidence: use tier value from Step 1 for tagged places; \
  0.5–0.7 for free-text-only places
- evidence_caption_quote: copy the EXACT phrase from the caption or transcript \
  that names this place — must be a verbatim substring, including emoji if present \
  (e.g. "📍Tokyo Dream Park")
- source_url: the URL of the web page where you found the coordinates

## Rules

- evidence_caption_quote MUST be a verbatim substring of the input. No paraphrasing.
- A Tier 1 📍-tagged place overrides any conflicting inference from free text. \
  If the caption says 📍Tokyo Dream Park, do NOT return a different venue even if \
  web search suggests a more famous nearby venue.
- Drop any place with confidence < 0.5.
- Drop any place you cannot find at least an approximate lat/lng for via web search \
  after two attempts.
- Do NOT invent addresses or coordinates — only use what web search returns.
- The formatted_address MUST contain both city and country name \
  (e.g. "Tokyo, Japan"). Reject any result that only contains a district name.
"""


def build_agent() -> Agent:
    return Agent(
        name="place_extractor",
        model="gpt-4o",
        instructions=PLACE_EXTRACTOR_INSTRUCTIONS,
        tools=[WebSearchTool()],
        output_type=ExtractionResult,
    )


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


async def run_spike() -> None:
    user_message = (
        f"Caption: {SAMPLE_CAPTION}\n\n"
        f"Transcript: {SAMPLE_TRANSCRIPT}\n\n"
        "Extract all real places with coordinates."
    )

    print("=" * 60)
    print("Phase 0.5 Spike — Place Extraction with WebSearchTool")
    print("=" * 60)
    print(f"\nCaption:\n  {SAMPLE_CAPTION}\n")
    print(f"Transcript:\n  {SAMPLE_TRANSCRIPT}\n")
    print("-" * 60)
    print("Running agent… (this may take 15–30s for web searches)\n")

    agent = build_agent()
    result = await Runner.run(agent, user_message, max_turns=12)

    turns_used = len(result.new_items)
    extraction: ExtractionResult = result.final_output
    places = extraction.places

    print(f"Turns used : {turns_used} (≥8 for 3 places = performance risk for production)")
    print(f"Places found: {len(places)}\n")

    # Pretty-print each place
    for i, place in enumerate(places, 1):
        print(f"  [{i}] {place.name}")
        print(f"       category          : {place.category}")
        print(f"       city/region       : {place.city_or_region_guess}")
        print(f"       lat/lng           : {place.lat}, {place.lng}")
        print(f"       formatted_address : {place.formatted_address}")
        print(f"       confidence        : {place.confidence:.2f}")
        print(f"       evidence_quote    : \"{place.evidence_caption_quote}\"")
        print(f"       source_url        : {place.source_url or '(not provided)'}")
        print()

    # ---------------------------------------------------------------------------
    # Success criteria validation
    # ---------------------------------------------------------------------------
    print("-" * 60)
    print("Validating success criteria…\n")

    combined_text = (SAMPLE_CAPTION + " " + SAMPLE_TRANSCRIPT).lower()

    # Tokyo metropolitan bounding box — any coordinate outside this is wrong for this caption
    # lat: 35.5–35.9, lng: 139.3–140.0
    TOKYO_LAT_MIN, TOKYO_LAT_MAX = 35.5, 35.9
    TOKYO_LNG_MIN, TOKYO_LNG_MAX = 139.3, 140.0

    places_with_coords = [p for p in places if p.lat is not None and p.lng is not None]
    places_in_tokyo_bbox = [
        p for p in places_with_coords
        if TOKYO_LAT_MIN <= p.lat <= TOKYO_LAT_MAX
        and TOKYO_LNG_MIN <= p.lng <= TOKYO_LNG_MAX
    ]
    addresses_with_tokyo_or_japan = [
        p for p in places
        if p.formatted_address
        and ("tokyo" in p.formatted_address.lower() or "japan" in p.formatted_address.lower())
    ]
    # Case-insensitive substring check (evidence_caption_quote may differ in capitalisation)
    places_with_valid_evidence = [
        p for p in places
        if p.evidence_caption_quote
        and p.evidence_caption_quote.lower() in combined_text
    ]
    performance_ok = turns_used < 8

    criteria = [
        (
            f"≥2 places with valid lat/lng — got {len(places_with_coords)}",
            len(places_with_coords) >= 2,
        ),
        (
            f"All coords inside Tokyo bounding box — {len(places_in_tokyo_bbox)}/{len(places_with_coords)} in range",
            len(places_in_tokyo_bbox) == len(places_with_coords) and len(places_with_coords) > 0,
        ),
        (
            f"≥1 formatted_address containing 'Tokyo' or 'Japan' — got {len(addresses_with_tokyo_or_japan)}",
            len(addresses_with_tokyo_or_japan) >= 1,
        ),
        (
            f"All evidence_caption_quote are case-insensitive substrings of input — {len(places_with_valid_evidence)}/{len(places)} valid",
            len(places_with_valid_evidence) == len(places) and len(places) > 0,
        ),
        (
            f"Turns used < 8 (performance gate) — used {turns_used}",
            performance_ok,
        ),
    ]

    all_pass = True
    for label, passed in criteria:
        status = "PASS" if passed else "FAIL"
        print(f"  [{status}] {label}")
        if not passed:
            all_pass = False

    print()
    print("=" * 60)
    print(f"Overall: {'ALL CRITERIA MET — spike passed' if all_pass else 'SOME CRITERIA FAILED — review output above'}")
    print("=" * 60)

    # Dump full JSON for inspection
    print("\nFull JSON output:\n")
    print(json.dumps(extraction.model_dump(), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    # Validate required env var early
    if not os.environ.get("OPENAI_API_KEY"):
        raise EnvironmentError(
            "OPENAI_API_KEY is not set. Add it to .env at the project root."
        )

    asyncio.run(run_spike())
