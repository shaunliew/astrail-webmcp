"""Place extractor — OpenAI Agents SDK agent that turns a ReelData into PlaceResults.

Import discipline (review finding): this module imports NEITHER the Agents SDK
(`from agents import ...`) NOR `openai` at top level. Both are imported inside
functions only, so `import genagents.place_extractor` loads nothing heavy, needs
no key, and makes no call. The pure helpers (input building, evidence/coords/url
filtering) are fully testable offline; the live run is `extract_places`.

Patterns reproduced from the legacy spike (never imported, guardrail #9):
tool_choice="required" + WebSearchTool (no required → model skips search and
hallucinates coords), output_type=ExtractionResult, typed gpt-4o fallback, and a
verbatim-evidence drop. Field names follow OUR contract: evidence_quote / source_type.
"""
from __future__ import annotations

import os
import re
import sys
from urllib.parse import urlparse

from models.place import ExtractionResult, PlaceResult
from models.reel import ReelData

DEFAULT_MODEL = "gpt-5.5-2026-04-23"
FALLBACK_MODEL = "gpt-4o"

PLACE_EXTRACTOR_INSTRUCTIONS = """\
You are a travel place-extraction agent. You receive an Instagram reel caption and an \
optional Instagram location tag.

MANDATORY: call web_search for EVERY candidate place before filling lat, lng, \
formatted_address, or source_url. Never use prior/training knowledge for coordinates.

Step 1 — scan the caption for creator-tagged signals first (highest confidence):
  TIER 1 (0.95): 📍<Name> or 📌<Name>      TIER 2 (0.85): @<Name>
  TIER 3 (0.75): #<RecognisableVenue>   (skip generic tags like #Tokyo, #Travel)
Step 2 — extract any remaining named venues from the free text.
Step 3 — verify each candidate via web_search; record lat/lng + formatted_address ONLY \
from the verified result. If web_search returns a famous nearby venue whose exact name \
is NOT in the caption/location tag, reject it and search again.
Step 4 — return ExtractionResult. For each place:
  - name: canonical name (use the creator-tagged name for Tier 1/2)
  - name_local: the venue's name in the LOCAL language/script EXACTLY as written in the \
    caption or location tag (e.g. "東京タワー") — a verbatim substring, character for \
    character. ALWAYS include this field; set it to null when the caption has no \
    local-script name (e.g. an English-only caption). NEVER translate or transliterate it \
    yourself. It grounds coordinates in map providers that index POIs in the local script.
  - category: restaurant | hotel | attraction | transport | other
  - source_type: "reel_extracted"
  - lat / lng: from web_search (null if not found — Pydantic bounds apply)
  - confidence: tier value for tagged places; 0.5–0.7 for free-text-only
  - evidence_quote: COPY THE EXACT PHRASE verbatim from the caption or location tag — \
    a literal substring, character for character, including emoji (e.g. "📍Tokyo Dream Park")
  - source_url: copied verbatim from a real web_search URL, or null. Never fabricate or \
    template a URL; never use example.com or any placeholder.

Rules:
  - evidence_quote MUST be a verbatim substring of the caption/location tag. No paraphrasing.
  - name_local, when non-null, MUST be a verbatim substring of the caption/location tag \
    (like evidence_quote). If there is no local-script name in the text, set it to null.
  - A Tier 1 📍 place overrides any conflicting inference.
  - Drop places with confidence < 0.5 or with no lat/lng found after two searches.
  - If the caption + location tag are only city-level (e.g. "Tokyo, Japan") with no \
    specific venue, return an empty places list rather than inventing a venue.
"""

_FAKE_DOMAINS = frozenset({
    "example.com", "example.org", "example.net", "test.com",
    "placeholder.com", "yourwebsite.com", "website.com",
})
_PLACEHOLDER_PATH_RE = re.compile(
    r"placeholder|example|your[-_]?(url|link|website)|insert[-_]?(url|link)", re.IGNORECASE
)


def is_placeholder_url(url: str | None) -> bool:
    """True when `url` is empty, non-http(s), localhost, or a known/looks-like placeholder."""
    if not url or not url.strip():
        return True
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return True
    host = (parsed.hostname or "").lower()
    if not host or "." not in host:
        return True
    if host in ("localhost", "127.0.0.1", "0.0.0.0"):
        return True
    if any(host == d or host.endswith("." + d) for d in _FAKE_DOMAINS):
        return True
    if _PLACEHOLDER_PATH_RE.search(url) and len(host.split(".")) <= 2 and len(host) < 20:
        return True
    return False


def build_extractor_input(reel: ReelData) -> str:
    """The extractor's user message: location tag (highest-confidence) then caption."""
    parts: list[str] = []
    if reel.location_name:
        parts.append(f"Instagram location tag (highest-confidence signal): {reel.location_name}")
    if reel.caption:
        parts.append(f"Caption:\n{reel.caption}")
    return "\n\n".join(parts)


def keep_valid_places(places: list[PlaceResult], reel: ReelData) -> list[PlaceResult]:
    """Drop hallucinations: null coords, non-verbatim evidence_quote, or placeholder source_url.
    Also null a non-verbatim name_local (keep the place) so an unreliable local name never
    reaches the geocoder — guardrails #1 (no hallucinated data) and #11 (untrusted content)."""
    corpus = (reel.caption + " " + (reel.location_name or "")).lower()
    kept: list[PlaceResult] = []
    for p in places:
        if p.lat is None or p.lng is None:
            continue
        if not p.evidence_quote or p.evidence_quote.lower() not in corpus:
            continue
        if p.source_url is not None and is_placeholder_url(p.source_url):
            continue
        # Normalize name_local to None unless it is a non-blank verbatim substring of the
        # caption — blank ("" / whitespace) or non-verbatim values never reach the geocoder
        # (guardrails #1/#11). Keep the place either way.
        if p.name_local is not None and (not p.name_local.strip() or p.name_local.lower() not in corpus):
            p = p.model_copy(update={"name_local": None})
        kept.append(p)
    return kept


def _model_errors() -> tuple[type[BaseException], ...]:
    """Lazy: the OpenAI exceptions that should trigger the typed model fallback."""
    import openai
    return (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)


def build_extractor(model: str):
    """Construct the place-extractor Agent. Lazy-imports the Agents SDK."""
    from agents import Agent, ModelSettings, WebSearchTool

    return Agent(
        name="place_extractor",
        model=model,
        instructions=PLACE_EXTRACTOR_INSTRUCTIONS,
        tools=[WebSearchTool(search_context_size="high")],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=ExtractionResult,
    )


async def _default_runner(agent, user_input: str):
    """Real run. Lazy-imports the Agents SDK Runner."""
    from agents import Runner

    return await Runner.run(agent, user_input, max_turns=12)


def _count_web_searches(result) -> int:
    """Count hosted WebSearchTool calls in a run result.

    In openai-agents 0.17.x a hosted web search surfaces as a ToolCallItem whose
    raw_item is ResponseFunctionWebSearch with type == "web_search_call". The
    similarly named ToolSearchCallItem is a separate tool-search feature, not web
    search. Match the raw Responses item type instead of the wrapper class name.
    """
    items = getattr(result, "new_items", None) or []
    count = 0
    for it in items:
        raw = getattr(it, "raw_item", None)
        raw_type = raw.get("type") if isinstance(raw, dict) else getattr(raw, "type", None)
        if raw_type == "web_search_call":
            count += 1
    return count


async def extract_places(reel: ReelData, *, model: str | None = None, runner=None) -> list[PlaceResult]:
    """Run the extractor on one reel → validated PlaceResults (live unless `runner` injected).

    `runner(agent, user_input)` is awaited and must return an object whose
    `.final_output` is an ExtractionResult. Falls back from `model` to gpt-4o on a
    typed model error. Output is filtered by `keep_valid_places`. Prints a one-line
    diagnostic to stderr (model used + web_search calls) so a live run is auditable
    without the OpenAI Traces dashboard.
    """
    model = model or os.environ.get("ASTRAIL_EXTRACT_MODEL", DEFAULT_MODEL)
    run = runner or _default_runner
    user_input = build_extractor_input(reel)
    used = model
    try:
        result = await run(build_extractor(model), user_input)
    except _model_errors():
        used = FALLBACK_MODEL
        result = await run(build_extractor(FALLBACK_MODEL), user_input)
    raw = result.final_output.places
    kept = keep_valid_places(raw, reel)
    print(f"  [extract] model={used} web_search_calls={_count_web_searches(result)} "
          f"places={len(kept)} kept of {len(raw)}", file=sys.stderr)
    return kept
