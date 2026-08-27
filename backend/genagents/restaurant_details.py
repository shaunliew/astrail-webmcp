"""Restaurant details enricher — opening hours + official website, via hosted web search.

WHY THIS IS A SEPARATE AGENT, and not a tool added to `genagents/restaurant.py`.

That module's docstring states the labeller "has NO web-search/tool, so there is no tool-call
injection surface. The prompt-injection surface is closed by construction." That property is
load-bearing and is NOT given up here: the labeller keeps its zero tools. This module is a second,
narrower agent whose input is exclusively MAPBOX-SOURCED strings — the POI's own name, its
`full_address`, and the city we searched. It never sees a reel caption, a transcript, or a
persisted `places.name` (which DOES descend from caption text via place_extractor). So the
"untrusted input" and "has a tool" properties are still never held by the same agent.

The residual vector is a business NAMED to look like an instruction — Mapbox POI names are
third-party data. That is answered structurally rather than by prompt wording:

  - the only tool is hosted web search, which reads and cannot write;
  - the output is a strict schema, so a steered model can still only return strings;
  - every returned string is VALIDATED here before it is persisted — index in range, URL scheme
    http(s), hours length-capped and newline-stripped;
  - `poi_index` anchors each result to a POI the caller supplied, exactly as
    `keep_grounded_restaurants` does, so a detail cannot attach to a venue we never searched.

EVIDENCE DISCIPLINE (guardrail #1). Opening hours are a claim about the world, so they are kept
ONLY when the model returns the `source_url` it read them from. No source, no hours — a plausible
"Mon–Sat 11:30–22:00" with nothing behind it is precisely the failure this product promises not to
make, and a map popup is where it would look most authoritative.

Import discipline (guardrail #9, mirrors restaurant.py): the Agents SDK is lazy-imported inside
functions, so importing this module loads nothing heavy, needs no key, and makes no call.
"""
from __future__ import annotations

import os
import sys

from models.enrichment import RestaurantDetail, RestaurantDetailSet

DEFAULT_MODEL = "gpt-5.5-2026-04-23"
FALLBACK_MODEL = "gpt-4o"

# A single line a traveller can read on a map popup. Anything longer is a pasted opening-hours
# table, which does not belong in a 300px card and is usually a sign the model summarised a page
# rather than the venue.
MAX_HOURS_CHARS = 120

DETAIL_INSTRUCTIONS = """\
You are given a numbered list of real restaurants, each with its name as published locally, its \
full street address, and its city. For each one, search the web for THAT EXACT venue at THAT \
address and report only what you can verify.

Return one entry per restaurant you could verify, each with:
  - poi_index: the number of the restaurant from the input list
  - opening_hours: ONE short line, in English, e.g. "Mon-Sat 11:30-14:00, 17:30-22:00" or \
"Daily 10:00-20:00, closed Tue". Omit if you cannot find published hours.
  - website: the venue's own official website, if it has one. Not a directory listing, not a \
review aggregator, not a social media profile.
  - source_url: the page you actually read these from. REQUIRED whenever you give hours or a \
website.

RULES, in order of importance:
1. If you cannot confirm the listing is the SAME venue at that address, return nothing for it. A \
same-named restaurant in another city is a wrong answer, not a near miss.
2. Never infer, average, or complete opening hours. Report only hours a page states.
3. If a page is undated or looks stale, prefer omitting the hours to reporting them.
4. Returning an empty list is a correct, expected outcome. Small local restaurants often publish \
nothing, and saying so is more useful than a confident guess.
"""


def build_detail_input(pois: list[dict], city: str | None = None) -> str:
    """The prompt body. ONLY Mapbox-sourced fields are interpolated — see the module docstring on
    why persisted place names are deliberately excluded."""
    lines = []
    for i, p in enumerate(pois):
        name = (p.get("name") or "").strip()
        address = (p.get("address") or "").strip()
        lines.append(f"{i}. {name} — {address or 'address unknown'}")
    where = f"\nAll of these are in or near {city}.\n" if city else "\n"
    return f"Restaurants:\n" + "\n".join(lines) + where


def _clean_url(raw: str | None) -> str | None:
    """http(s) only. A model-returned URL is untrusted output, and it is rendered as an anchor."""
    if not raw or not isinstance(raw, str):
        return None
    from urllib.parse import urlparse

    try:
        parsed = urlparse(raw.strip())
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return raw.strip()


def _clean_hours(raw: str | None) -> str | None:
    """One line, length-capped. Newlines are collapsed rather than truncated-with-ellipsis so a
    pasted weekly table degrades to something still readable instead of a fragment."""
    if not raw or not isinstance(raw, str):
        return None
    one_line = " ".join(raw.split())
    if not one_line:
        return None
    return one_line if len(one_line) <= MAX_HOURS_CHARS else None


def keep_grounded_details(details: list[RestaurantDetail], pois: list[dict]) -> dict[int, dict]:
    """Fuse each detail to a POI by index and validate it, exactly as keep_grounded_restaurants
    does for labels. Returns {poi_index: {opening_hours?, website?, source_url}}.

    A detail is DROPPED entirely when its index is out of range or duplicated, or when it carries
    no usable source_url — hours without a citation are the thing guardrail #1 forbids. A detail
    whose source survives but whose hours/website do not still yields nothing, since an entry with
    only a citation says nothing worth showing."""
    out: dict[int, dict] = {}
    for d in details:
        i = d.poi_index
        if not isinstance(i, int) or i < 0 or i >= len(pois) or i in out:
            continue
        source = _clean_url(d.source_url)
        if not source:
            continue
        hours = _clean_hours(d.opening_hours)
        website = _clean_url(d.website)
        if not hours and not website:
            continue
        entry: dict = {"source_url": source}
        if hours:
            entry["opening_hours"] = hours
        if website:
            entry["website"] = website
        out[i] = entry
    return out


def build_detail_agent(model: str):
    """Construct the details Agent. Lazy-imports the Agents SDK.

    `tool_choice="required"`: without it the model answers from parametric memory instead of
    searching, which is exactly the confident-stale-hours failure this agent exists to avoid
    (the same reason place_extractor sets it). `search_context_size="low"` because the question is
    narrow — one venue's hours — and this runs once per day of the trip."""
    from agents import Agent, ModelSettings, WebSearchTool

    return Agent(
        name="restaurant_details",
        model=model,
        instructions=DETAIL_INSTRUCTIONS,
        tools=[WebSearchTool(search_context_size="low")],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=RestaurantDetailSet,
    )


async def _default_runner(agent, user_input: str):
    from agents import Runner, set_tracing_disabled

    # Same privacy posture as every other agent here: never export run data to OpenAI's trace store.
    set_tracing_disabled(True)
    return await Runner.run(agent, user_input, max_turns=8)


def _model_errors() -> tuple[type[BaseException], ...]:
    try:
        from openai import APIStatusError, APITimeoutError, BadRequestError
    except Exception:                                        # pragma: no cover - import guard
        return (Exception,)
    return (BadRequestError, APIStatusError, APITimeoutError)


async def fetch_restaurant_details(
    pois: list[dict], *, city: str | None = None, model: str | None = None, runner=None,
) -> dict[int, dict]:
    """Look up opening hours + official website for a day's grounded POIs.

    Returns {poi_index: entry}; an empty dict is a normal outcome, not a failure. Never raises for
    a model/search problem — the caller treats details as best-effort garnish on an itinerary that
    must render without them (guardrail #3)."""
    if not pois:
        return {}
    model = model or os.environ.get("ASTRAIL_RESTAURANT_DETAILS_MODEL", DEFAULT_MODEL)
    run = runner or _default_runner
    user_input = build_detail_input(pois, city=city)
    try:
        result = await run(build_detail_agent(model), user_input)
    except _model_errors():
        try:
            result = await run(build_detail_agent(FALLBACK_MODEL), user_input)
        except Exception:
            print("  [restaurant-details] skipped (model unavailable)", file=sys.stderr)
            return {}
    except Exception:
        print("  [restaurant-details] skipped (run failed)", file=sys.stderr)
        return {}

    kept = keep_grounded_details(result.final_output.details, pois)
    print(f"  [restaurant-details] pois={len(pois)} enriched={len(kept)}", file=sys.stderr)
    return kept
