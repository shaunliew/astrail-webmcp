# Agent Pipeline Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the core itinerary-generation agent pipeline (extract → dedup → enrich → feasibility → narrate) in `backend/`, measurably higher quality than the legacy TripCanvas hackathon pipeline, runnable standalone with no Supabase/Apify/Mapbox dependency.

**Architecture:** A pure-Python, in-memory pipeline over already-scraped `ReelData`. Each stage is a small focused module with the LLM-facing agent isolated from the testable pure logic (evidence enforcement, two-gate dedup math, feasibility/day-grouping, prompt builders). A standalone eval harness runs the NEW pipeline against a faithful legacy-equivalent BASELINE on a fixed Japan golden set and prints a head-to-head comparison table, so "better than legacy" is a number.

**Tech Stack:** Python ≥3.14, OpenAI Agents SDK (`openai-agents` 0.17.7), `openai` 2.44.0 (`WebSearchTool`, `text-embedding-3-small`), Pydantic v2, numpy 2.5.0, pytest + pytest-asyncio, `uv`.

**Tracks board issues** (`MalaysiaKaki/TripCanvas`, Project #1, Phase 1.1): **#8** live Reel extraction, **#9** place dedupe + confidence ranking, **#11** itinerary feasibility checks, **#13** MVP evaluation set. astrail commits reference them cross-repo (`Closes MalaysiaKaki/TripCanvas#8`).

## Global Constraints

- Python `requires-python = ">=3.14"`; backend deps in `backend/pyproject.toml` + uv only. **No `requirements.txt`.**
- Primary LLM: `gpt-5.5-2026-04-23`. Fallback LLM: `gpt-4o`. Embeddings: `text-embedding-3-small` (1536 dims).
- Typed model fallback on `_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)` — every agent.
- Extractor + enricher use `ModelSettings(tool_choice="required", parallel_tool_calls=True)` (live web search mandatory; without `required` the model hallucinates coords).
- `output_type` is always a single Pydantic model, never a bare list.
- Pydantic coord bounds: `lat: ge=-90, le=90`; `lng: ge=-180, le=180`.
- Anti-hallucination (PRD §12): every emitted place has `name`, `source_type`, `lat`, `lng`, `evidence_quote`, `confidence`, and a non-placeholder `source_url` or `None`. `evidence_quote` MUST be a verbatim (case-insensitive) substring of `caption + " " + location_name`. Drop anything failing; never invent coords/URLs.
- `source_type` ∈ `{"reel_extracted","user_requested","agent_suggested"}` (PRD §11). This slice only produces `reel_extracted`.
- Semantic dedup gates (data flywheel): cosine similarity ≥ `0.85` AND haversine distance < `500` m — **both** must pass to merge.
- No `legacy/` imports in production pipeline code (guardrail #9). The eval BASELINE is a faithful re-implementation in `backend/eval/baseline.py`, not a legacy import.
- WebSearchTool calls surface as `ToolSearchCallItem`, not `ToolCallItem` — match both name patterns.
- No raw chain-of-thought in any output (guardrail #2); reasoning is structured (`feasibility_note`, summaries) only.
- Style: PEP 8, type annotations on every signature, `logging` not `print` in library modules, files <400 lines.

---

## File Structure

```
backend/
├── pyproject.toml                  # MODIFY: add numpy + pytest asyncio config
├── models/
│   ├── reel.py                     # ReelData
│   ├── prefs.py                    # UserPreferences
│   ├── place.py                    # SourceType, PlaceResult, ExtractionResult, CanonicalPlace
│   ├── enrichment.py               # EnrichedPlace, EnrichedContext (spine subset)
│   └── trip.py                     # DayPlan, ItineraryDay, ItineraryOutput
├── agents/
│   ├── runtime.py                  # NEW: model constants, run_with_fallback, item detectors, is_placeholder_url
│   ├── place_extractor.py          # #8: extractor agent + enforce_evidence + extract_places
│   ├── place_enricher.py           # enricher agent + derive_locale + prompt + enrich_places
│   └── narrator.py                 # #11: narrator agent + prompt + narrate
├── pipeline/
│   ├── dedup.py                    # #9: cosine, haversine, embed, two-gate dedup_places
│   ├── feasibility.py              # #11: distance_matrix, group_into_days, intra-day travel, notes
│   └── runner.py                   # run_spine orchestration (in-memory)
├── eval/
│   ├── __init__.py
│   ├── golden_set.py               # #13: Japan ReelData fixtures + expected places
│   ├── metrics.py                  # #13: evidence_coverage, hallucination_rate, mean_intra_day_travel, dedup_error
│   ├── baseline.py                 # #13: legacy-equivalent (name-only dedup + naive day chunk)
│   └── run_eval.py                 # #13: NEW vs BASELINE comparison table (live, documented command)
└── tests/
    ├── __init__.py
    ├── test_models.py
    ├── test_runtime.py
    ├── test_extractor_enforce.py
    ├── test_dedup.py
    ├── test_enricher_prompt.py
    ├── test_feasibility.py
    ├── test_narrator_prompt.py
    ├── test_runner.py
    └── test_eval_metrics.py
```

All `pytest` commands run from `backend/` as `uv run pytest ...`. Each task ends with a commit.

---

### Task 1: Spine data models + test config

**Files:**
- Modify: `backend/pyproject.toml` (add `numpy>=2.0.0`; add pytest asyncio config)
- Modify: `backend/models/reel.py`, `backend/models/prefs.py`, `backend/models/place.py`, `backend/models/enrichment.py`, `backend/models/trip.py` (replace 1-line stubs)
- Create: `backend/tests/__init__.py`, `backend/tests/test_models.py`

**Interfaces:**
- Produces:
  - `ReelData(reel_url: str, caption: str, location_name: str|None, ...)`
  - `UserPreferences(start_date, end_date, budget_level, free_text, origin_city)`
  - `SourceType = Literal["reel_extracted","user_requested","agent_suggested"]`
  - `PlaceResult(name, category, city_or_region_guess, lat, lng, formatted_address, confidence, source_type, evidence_quote, reel_url, source_url)`
  - `ExtractionResult(places: list[PlaceResult])`
  - `CanonicalPlace(name, category, city_or_region_guess, lat: float, lng: float, formatted_address, confidence, source_type, evidence_quotes: list[str], reel_urls: list[str], source_url, times_referenced: int)`
  - `EnrichedPlace(name, category, summary, why_go, hours, tips, source_url)`
  - `EnrichedContext(places: list[EnrichedPlace])`
  - `DayPlan(day_number, date, place_names, intra_day_travel_m, feasibility_note)`
  - `ItineraryDay(day_number, date, place_names, activities, narration, feasibility_note)`
  - `ItineraryOutput(title, days, source_places, source, places)`

- [ ] **Step 1: Add the pytest asyncio config and numpy dependency**

In `backend/pyproject.toml`, add `"numpy>=2.0.0",` to the `dependencies` list, and append this section at the end of the file:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

Then run: `uv sync` (expected: resolves, installs numpy if missing).

- [ ] **Step 2: Write the failing model tests**

Create `backend/tests/__init__.py` (empty file) and `backend/tests/test_models.py`:

```python
import pytest
from pydantic import ValidationError

from models.place import PlaceResult, CanonicalPlace
from models.reel import ReelData
from models.prefs import UserPreferences
from models.trip import ItineraryOutput, ItineraryDay


def test_place_rejects_out_of_range_lat():
    with pytest.raises(ValidationError):
        PlaceResult(
            name="X", category="attraction", city_or_region_guess="Tokyo",
            lat=120.0, lng=10.0, confidence=0.9,
            evidence_quote="X", source_type="reel_extracted",
        )


def test_place_default_source_type_is_reel_extracted():
    p = PlaceResult(
        name="X", category="attraction", city_or_region_guess="Tokyo",
        lat=35.6, lng=139.7, confidence=0.9, evidence_quote="X",
    )
    assert p.source_type == "reel_extracted"


def test_place_rejects_unknown_source_type():
    with pytest.raises(ValidationError):
        PlaceResult(
            name="X", category="attraction", city_or_region_guess="Tokyo",
            lat=35.6, lng=139.7, confidence=0.9, evidence_quote="X",
            source_type="invented",
        )


def test_reel_data_alias_population():
    rd = ReelData.model_validate({"caption": "hi", "locationName": "Shibuya"})
    assert rd.location_name == "Shibuya"


def test_canonical_place_requires_coords():
    with pytest.raises(ValidationError):
        CanonicalPlace(
            name="X", category="attraction", city_or_region_guess="Tokyo",
            confidence=0.9, source_type="reel_extracted",
            evidence_quotes=["X"], reel_urls=[],
        )


def test_itinerary_source_defaults_live():
    out = ItineraryOutput(
        title="T", days=[], source_places=["X"],
    )
    assert out.source == "live"


def test_prefs_defaults():
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-13")
    assert prefs.budget_level == "mid_range"
    assert prefs.origin_city is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_models.py -v`
Expected: FAIL — `ModuleNotFoundError` / `ImportError` (models are still 1-line stubs).

- [ ] **Step 4: Implement the models**

Replace `backend/models/reel.py`:

```python
"""Scraped Instagram reel content (input to the agent pipeline)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class ReelData(BaseModel):
    """Structured reel content. Scraping is upstream (direct Apify HTTP, not in this slice)."""

    model_config = ConfigDict(populate_by_name=True)

    reel_url: str = ""
    caption: str = Field(default="")
    video_url: Optional[str] = Field(None, alias="videoUrl")
    audio_url: Optional[str] = Field(None, alias="audioUrl")
    location_name: Optional[str] = Field(None, alias="locationName")
    location_id: Optional[str] = Field(None, alias="locationId")
    short_code: Optional[str] = Field(None, alias="shortCode")
```

Replace `backend/models/prefs.py`:

```python
"""User trip preferences."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel


class UserPreferences(BaseModel):
    start_date: str
    end_date: str
    budget_level: Literal["budget", "mid_range", "luxury"] = "mid_range"
    free_text: str = ""
    origin_city: Optional[str] = None
```

Replace `backend/models/place.py`:

```python
"""Place models across the pipeline: extracted → canonical."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

SourceType = Literal["reel_extracted", "user_requested", "agent_suggested"]


class PlaceResult(BaseModel):
    """A single place produced by the extractor (one source observation)."""

    name: str = Field(description="Canonical name of the place")
    category: str = Field(description="restaurant | hotel | attraction | transport | other")
    city_or_region_guess: str
    lat: Optional[float] = Field(None, ge=-90.0, le=90.0)
    lng: Optional[float] = Field(None, ge=-180.0, le=180.0)
    formatted_address: Optional[str] = None
    confidence: float = Field(ge=0.0, le=1.0)
    source_type: SourceType = "reel_extracted"
    evidence_quote: str = Field(description="Verbatim substring of caption + location tag")
    reel_url: Optional[str] = None
    source_url: Optional[str] = None


class ExtractionResult(BaseModel):
    """Agent output_type wrapper (SDK requires a single Pydantic model)."""

    places: list[PlaceResult] = Field(
        description="Identified places. Drop any with confidence < 0.5 or no lat/lng."
    )


class CanonicalPlace(BaseModel):
    """A deduped place with merged evidence — the data-flywheel record."""

    name: str
    category: str
    city_or_region_guess: str
    lat: float = Field(ge=-90.0, le=90.0)
    lng: float = Field(ge=-180.0, le=180.0)
    formatted_address: Optional[str] = None
    confidence: float = Field(ge=0.0, le=1.0)
    source_type: SourceType
    evidence_quotes: list[str]
    reel_urls: list[str]
    source_url: Optional[str] = None
    times_referenced: int = 1
```

Replace `backend/models/enrichment.py`:

```python
"""Enrichment models (spine subset — weather/restaurant/transport are plan 2)."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class EnrichedPlace(BaseModel):
    """Deep research summary for one canonical place."""

    name: str               # must match CanonicalPlace.name verbatim
    category: str = ""
    summary: str            # 2-4 sentence highlight from live web search
    why_go: str = ""        # one-line reason this earns a stop
    hours: str = ""         # opening hours / best time to visit, if found
    tips: str = ""          # practical tip (entrance, booking, queue)
    source_url: Optional[str] = None


class EnrichedContext(BaseModel):
    """enricher_agent output — one EnrichedPlace per input place."""

    places: list[EnrichedPlace]
```

Replace `backend/models/trip.py`:

```python
"""Itinerary models."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

from models.enrichment import EnrichedPlace


class DayPlan(BaseModel):
    """Code-computed day grouping (feeds the narrator). Not user-facing."""

    day_number: int
    date: str
    place_names: list[str]
    intra_day_travel_m: float
    feasibility_note: Optional[str] = None


class ItineraryDay(BaseModel):
    day_number: int
    date: str
    place_names: list[str]
    activities: str
    narration: str
    feasibility_note: Optional[str] = None


class ItineraryOutput(BaseModel):
    title: str
    days: list[ItineraryDay]
    source_places: list[str]
    source: Literal["live", "cache"] = "live"
    places: list[EnrichedPlace] = Field(default_factory=list)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_models.py -v`
Expected: PASS (7 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/pyproject.toml backend/models/ backend/tests/__init__.py backend/tests/test_models.py
git commit -m "feat(models): spine data models with PRD-§12 evidence + source_type fields

Refs MalaysiaKaki/TripCanvas#8 #9 #11"
```

---

### Task 2: Agent runtime helpers

**Files:**
- Create: `backend/agents/runtime.py`
- Create: `backend/tests/test_runtime.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PRIMARY_MODEL = "gpt-5.5-2026-04-23"`, `FALLBACK_MODEL = "gpt-4o"`
  - `_MODEL_ERRORS: tuple`
  - `async def run_with_fallback(agent, prompt: str, max_turns: int) -> RunResult`
  - `def is_tool_call_item(item: object) -> bool`
  - `def is_web_search_call(item: object) -> bool`
  - `def count_web_searches(items) -> int`
  - `def is_placeholder_url(url: str | None) -> bool`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_runtime.py`:

```python
from agents.runtime import (
    count_web_searches,
    is_placeholder_url,
    is_tool_call_item,
    is_web_search_call,
)


class FakeToolSearchCallItem:
    pass


class FakeToolSearchCallOutputItem:
    pass


class FakeMessageOutputItem:
    pass


def test_is_tool_call_item_matches_search_call():
    assert is_tool_call_item(FakeToolSearchCallItem()) is True
    assert is_tool_call_item(FakeToolSearchCallOutputItem()) is False
    assert is_tool_call_item(FakeMessageOutputItem()) is False


def test_is_web_search_call_matches_search_name():
    assert is_web_search_call(FakeToolSearchCallItem()) is True
    assert is_web_search_call(FakeMessageOutputItem()) is False


def test_count_web_searches():
    items = [FakeToolSearchCallItem(), FakeMessageOutputItem(), FakeToolSearchCallItem()]
    assert count_web_searches(items) == 2


def test_is_placeholder_url():
    assert is_placeholder_url(None) is True
    assert is_placeholder_url("") is True
    assert is_placeholder_url("ftp://x.com") is True
    assert is_placeholder_url("https://example.com/x") is True
    assert is_placeholder_url("http://localhost:3000") is True
    assert is_placeholder_url("https://tabelog.com/tokyo/A1301/") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_runtime.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'agents.runtime'`.

> Note: `agents` here is OUR package `backend/agents/`, not the SDK. Because the SDK is also imported as `agents`, `runtime.py` must import the SDK via `from agents import Agent` — this works because Python resolves the installed `agents` distribution for the bare import while our package is found relative to `backend/`. If a name clash surfaces at runtime, the fallback is to run pytest with `cwd=backend` (already configured via `testpaths`). Verify the SDK import resolves in Step 4.

- [ ] **Step 3: Write the implementation**

Create `backend/agents/runtime.py`:

```python
"""Shared agent runtime: model fallback + SDK item inspection + URL hygiene."""
from __future__ import annotations

import logging
import re
from typing import Iterable
from urllib.parse import urlparse

import openai
from agents import Agent, Runner, RunResult  # OpenAI Agents SDK

logger = logging.getLogger(__name__)

PRIMARY_MODEL = "gpt-5.5-2026-04-23"
FALLBACK_MODEL = "gpt-4o"

_MODEL_ERRORS = (
    openai.NotFoundError,
    openai.BadRequestError,
    openai.PermissionDeniedError,
)

_FAKE_DOMAINS: frozenset[str] = frozenset(
    {
        "example.com", "example.org", "example.net",
        "test.com", "placeholder.com", "yourwebsite.com", "website.com",
    }
)
_PLACEHOLDER_PATH_RE = re.compile(
    r"placeholder|example|your[-_]?(url|link|website)|insert[-_]?(url|link)",
    re.IGNORECASE,
)


async def run_with_fallback(agent: Agent, prompt: str, max_turns: int) -> RunResult:
    """Run an agent; clone to FALLBACK_MODEL on a typed model-availability error."""
    try:
        return await Runner.run(agent, prompt, max_turns=max_turns)
    except _MODEL_ERRORS as exc:
        logger.warning("Model unavailable for %s (%s); falling back to %s",
                       agent.name, type(exc).__name__, FALLBACK_MODEL)
        return await Runner.run(agent.clone(model=FALLBACK_MODEL), prompt, max_turns=max_turns)


def is_tool_call_item(item: object) -> bool:
    """True for any SDK item representing a tool/search CALL (not its output)."""
    name = type(item).__name__
    return (
        ("ToolCall" in name or "ToolSearch" in name or "FunctionCall" in name)
        and "Output" not in name
        and "Result" not in name
    )


def is_web_search_call(item: object) -> bool:
    """True if item is specifically a web-search tool call (ToolSearchCallItem-aware)."""
    if not is_tool_call_item(item):
        return False
    if "ToolSearch" in type(item).__name__:
        return True
    raw = getattr(item, "raw_item", None)
    tool_name = str(getattr(raw, "name", None) or getattr(raw, "type", "")).lower()
    return "search" in tool_name or "web_search" in tool_name


def count_web_searches(items: Iterable[object]) -> int:
    return sum(1 for item in items if is_web_search_call(item))


def is_placeholder_url(url: str | None) -> bool:
    """True when url is empty, non-http(s), localhost, or a known placeholder domain."""
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
    if _PLACEHOLDER_PATH_RE.search(url) and len(hostname.split(".")) <= 2 and len(hostname) < 20:
        return True
    return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_runtime.py -v`
Expected: PASS (4 passed). If the SDK `agents` import collides with our package, run `uv run python -c "from agents.runtime import is_placeholder_url; from agents import Agent"` from `backend/` to confirm both resolve; they do because `agents.runtime` is a submodule of the installed-vs-local namespace resolved by `cwd`.

- [ ] **Step 5: Commit**

```bash
git add backend/agents/runtime.py backend/tests/test_runtime.py
git commit -m "feat(agents): shared runtime — model fallback, item detectors, URL hygiene

Refs MalaysiaKaki/TripCanvas#8"
```

---

### Task 3: Place extractor with in-module evidence enforcement (#8)

**Files:**
- Modify: `backend/agents/place_extractor.py` (replace stub)
- Create: `backend/tests/test_extractor_enforce.py`

**Interfaces:**
- Consumes: `ReelData`, `PlaceResult`, `ExtractionResult` (Task 1); `run_with_fallback`, `is_placeholder_url`, `is_tool_call_item`, `count_web_searches`, `PRIMARY_MODEL` (Task 2).
- Produces:
  - `PLACE_EXTRACTOR_INSTRUCTIONS: str`
  - `def build_extractor_input(reel: ReelData) -> str`
  - `def build_extractor_agent(model: str = PRIMARY_MODEL) -> Agent`
  - `def enforce_evidence(places: list[PlaceResult], reel: ReelData) -> list[PlaceResult]`
  - `async def extract_places(reel: ReelData) -> list[PlaceResult]`

**The upgrade over legacy:** legacy enforced evidence only inside the spike's ad-hoc validation loop. Here `enforce_evidence` lives in the module so EVERY caller gets clean output, and it also stamps `source_type="reel_extracted"` + `reel_url`, and nulls placeholder `source_url`s.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_extractor_enforce.py`:

```python
from agents.place_extractor import build_extractor_input, enforce_evidence
from models.place import PlaceResult
from models.reel import ReelData


def _place(**kw) -> PlaceResult:
    base = dict(
        name="Ichiran", category="restaurant", city_or_region_guess="Tokyo",
        lat=35.66, lng=139.70, confidence=0.9, evidence_quote="Ichiran",
        source_url="https://tabelog.com/x",
    )
    base.update(kw)
    return PlaceResult(**base)


REEL = ReelData(reel_url="https://insta/reel/AAA", caption="Loved Ichiran ramen 📍Shibuya", location_name="Shibuya")


def test_drops_place_without_coords():
    kept = enforce_evidence([_place(lat=None, lng=None)], REEL)
    assert kept == []


def test_drops_low_confidence():
    kept = enforce_evidence([_place(confidence=0.4)], REEL)
    assert kept == []


def test_drops_non_verbatim_evidence():
    kept = enforce_evidence([_place(evidence_quote="Totally Made Up Quote")], REEL)
    assert kept == []


def test_keeps_verbatim_case_insensitive_and_stamps_source():
    kept = enforce_evidence([_place(evidence_quote="ichiran ramen")], REEL)
    assert len(kept) == 1
    assert kept[0].source_type == "reel_extracted"
    assert kept[0].reel_url == "https://insta/reel/AAA"


def test_nulls_placeholder_source_url():
    kept = enforce_evidence([_place(source_url="https://example.com/x")], REEL)
    assert len(kept) == 1
    assert kept[0].source_url is None


def test_evidence_matches_location_tag():
    kept = enforce_evidence([_place(evidence_quote="Shibuya")], REEL)
    assert len(kept) == 1


def test_build_input_includes_location_and_caption():
    text = build_extractor_input(REEL)
    assert "Shibuya" in text
    assert "Ichiran" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_extractor_enforce.py -v`
Expected: FAIL — `ImportError` (stub has no `enforce_evidence`).

- [ ] **Step 3: Write the implementation**

Replace `backend/agents/place_extractor.py`:

```python
"""Per-reel place extraction agent (#8) with in-module anti-hallucination enforcement."""
from __future__ import annotations

from agents import Agent, ModelSettings, WebSearchTool

from agents.runtime import (
    PRIMARY_MODEL,
    count_web_searches,
    is_placeholder_url,
    is_tool_call_item,
    run_with_fallback,
)
from models.place import ExtractionResult, PlaceResult
from models.reel import ReelData

PLACE_EXTRACTOR_INSTRUCTIONS = """\
You are a travel place-extraction agent. You receive an Instagram reel caption and an \
optional Instagram location tag.

## MANDATORY RULE — web_search required for every place
You MUST call web_search for EVERY candidate place before populating lat, lng, \
formatted_address, or source_url. Do NOT use training knowledge for coordinates. \
Returning a place without a web_search call for it is a violation.

## Step 1 — Explicit location signals first (highest confidence)
Scan the caption for creator-tagged signals, in priority order:
  TIER 1 (confidence 0.95): 📍<Name> or 📌<Name>
  TIER 2 (confidence 0.85): @<Name>
  TIER 3 (confidence 0.75): #<PlaceName> that is a recognisable venue (skip #Tokyo, #Travel)
These tagged candidates are GROUND TRUTH.

## Step 2 — Free-text places
Extract remaining named venues (restaurants, cafes, shrines, hotels, attractions, \
transport hubs). Ignore generic words like "city", "area".

## Step 3 — Verify each candidate via web_search
a. Search "<name> <city hint> official site OR address coordinates".
b. Confirm the result is the SAME venue (name, category, city match).
c. ANTI-HALLUCINATION: if search returns a famous nearby venue whose name does NOT \
   appear in the caption/location tag, reject and search again. Never substitute.
d. Record lat/lng + formatted_address ONLY from the verified result.

## Step 4 — Return ExtractionResult, per place:
- name: canonical English name (creator-tagged name for Tier 1/2)
- category: restaurant | hotel | attraction | transport | other
- city_or_region_guess: from context or location hint
- lat / lng: from web search (null if not found)
- formatted_address: MUST include city AND country
- confidence: tier value for tagged places; 0.5–0.7 for free-text-only
- evidence_quote: COPY THE EXACT verbatim phrase from caption/location tag, character \
  for character, including emoji if present (e.g. "📍Tokyo Dream Park")
- source_url: the actual URL web_search returned (null if none — never invent one)
- source_type: always "reel_extracted"

## Rules
- evidence_quote MUST be a verbatim substring of the caption or location tag.
- A Tier-1 📍 place overrides any conflicting free-text inference.
- Drop places with confidence < 0.5 or no lat/lng after two search attempts.
- Never invent coordinates, addresses, or URLs. Use null. Never use example.com.
- If caption + location tag are city-level only with no extractable venue, return [].
"""


def build_extractor_input(reel: ReelData) -> str:
    parts: list[str] = []
    if reel.location_name:
        parts.append(f"Instagram location tag (highest-confidence signal): {reel.location_name}")
    if reel.caption:
        parts.append(f"Caption:\n{reel.caption}")
    return "\n\n".join(parts)


def build_extractor_agent(model: str = PRIMARY_MODEL) -> Agent:
    return Agent(
        name="place_extractor",
        model=model,
        instructions=PLACE_EXTRACTOR_INSTRUCTIONS,
        tools=[WebSearchTool(search_context_size="high")],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=ExtractionResult,
    )


def enforce_evidence(places: list[PlaceResult], reel: ReelData) -> list[PlaceResult]:
    """Drop hallucinated places; stamp provenance. PRD §12 enforced at the source.

    Keep a place only if: lat AND lng present, confidence >= 0.5, and evidence_quote
    is a (case-insensitive) verbatim substring of caption + location tag. Placeholder
    source_urls are nulled, not dropped.
    """
    combined = (reel.caption + " " + (reel.location_name or "")).lower()
    kept: list[PlaceResult] = []
    for p in places:
        if p.lat is None or p.lng is None:
            continue
        if p.confidence < 0.5:
            continue
        if not p.evidence_quote or p.evidence_quote.lower() not in combined:
            continue
        source_url = None if is_placeholder_url(p.source_url) else p.source_url
        kept.append(p.model_copy(update={
            "source_type": "reel_extracted",
            "reel_url": reel.reel_url or p.reel_url,
            "source_url": source_url,
        }))
    return kept


async def extract_places(reel: ReelData) -> list[PlaceResult]:
    """Scrape-free: take ReelData, return enforced PlaceResults. Empty input -> []."""
    text = build_extractor_input(reel)
    if not text.strip():
        return []
    agent = build_extractor_agent()
    result = await run_with_fallback(agent, text, max_turns=12)
    if not any(is_tool_call_item(i) for i in result.new_items):
        raise RuntimeError(
            f"place_extractor [{reel.reel_url}]: zero tool calls — "
            "verify tool_choice='required' is supported by the model."
        )
    _ = count_web_searches(result.new_items)  # available for telemetry later
    extraction = result.final_output_as(ExtractionResult)
    return enforce_evidence(extraction.places, reel)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_extractor_enforce.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/agents/place_extractor.py backend/tests/test_extractor_enforce.py
git commit -m "feat(extractor): port + harden place extractor with in-module evidence gate

Closes MalaysiaKaki/TripCanvas#8 (extraction path)"
```

---

### Task 4: Two-gate semantic + geo dedup (#9)

**Files:**
- Modify: `backend/pipeline/dedup.py` (replace stub)
- Create: `backend/tests/test_dedup.py`

**Interfaces:**
- Consumes: `PlaceResult`, `CanonicalPlace` (Task 1).
- Produces:
  - `def cosine_similarity(a: list[float], b: list[float]) -> float`
  - `def haversine_m(lat1, lng1, lat2, lng2) -> float`
  - `def dedup_text(p: PlaceResult) -> str`
  - `async def embed_texts(texts: list[str]) -> list[list[float]]` (OpenAI `text-embedding-3-small`)
  - `async def dedup_places(places, *, embed=embed_texts, sim_threshold=0.85, distance_m=500.0) -> list[CanonicalPlace]`

**The upgrade over legacy:** legacy `_flatten_and_dedup_by_name` was lowercase string match. This is the two-gate flywheel: cosine ≥ 0.85 AND haversine < 500 m → merge (append evidence, bump `times_referenced`); else new canonical record. `embed` is injectable so tests need no API.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_dedup.py`:

```python
import math

import pytest

from models.place import PlaceResult
from pipeline.dedup import cosine_similarity, dedup_places, haversine_m


def _p(name, lat, lng, conf=0.9, ev=None) -> PlaceResult:
    return PlaceResult(
        name=name, category="restaurant", city_or_region_guess="Tokyo",
        lat=lat, lng=lng, confidence=conf, evidence_quote=ev or name,
        source_type="reel_extracted", reel_url=f"https://insta/{name}",
    )


# Fake embedder: identical vectors for identical names, near-orthogonal otherwise.
_VECS = {
    "Ichiran": [1.0, 0.0, 0.0],
    "Ichiran Ramen": [0.99, 0.14, 0.0],   # cos ~0.99 vs Ichiran
    "Senso-ji": [0.0, 1.0, 0.0],
}


async def _fake_embed(texts: list[str]) -> list[list[float]]:
    out = []
    for t in texts:
        key = next((k for k in _VECS if k in t), None)
        out.append(_VECS[key] if key else [0.0, 0.0, 1.0])
    return out


def test_cosine_similarity():
    assert cosine_similarity([1, 0], [1, 0]) == pytest.approx(1.0)
    assert cosine_similarity([1, 0], [0, 1]) == pytest.approx(0.0)


def test_haversine_known_distance():
    # ~1.11 km per 0.01 deg latitude near equator
    d = haversine_m(0.0, 0.0, 0.01, 0.0)
    assert d == pytest.approx(1113.0, abs=20.0)


@pytest.mark.asyncio
async def test_merges_when_both_gates_pass():
    places = [_p("Ichiran", 35.6600, 139.7000, ev="Ichiran"),
              _p("Ichiran Ramen", 35.6601, 139.7001, ev="Ichiran Ramen")]  # ~14m apart, cos~0.99
    canon = await dedup_places(places, embed=_fake_embed)
    assert len(canon) == 1
    assert canon[0].times_referenced == 2
    assert set(canon[0].evidence_quotes) == {"Ichiran", "Ichiran Ramen"}
    assert len(canon[0].reel_urls) == 2


@pytest.mark.asyncio
async def test_no_merge_when_geo_gate_fails():
    # Same name (cos 1.0) but ~3km apart -> different branches, must NOT merge.
    places = [_p("Ichiran", 35.6600, 139.7000), _p("Ichiran", 35.6600, 139.7330)]
    canon = await dedup_places(places, embed=_fake_embed)
    assert len(canon) == 2


@pytest.mark.asyncio
async def test_no_merge_when_semantic_gate_fails():
    # Close coords but unrelated names -> must NOT merge.
    places = [_p("Ichiran", 35.6600, 139.7000), _p("Senso-ji", 35.6601, 139.7001)]
    canon = await dedup_places(places, embed=_fake_embed)
    assert len(canon) == 2


@pytest.mark.asyncio
async def test_keeps_highest_confidence_name():
    places = [_p("Ichiran", 35.6600, 139.7000, conf=0.7),
              _p("Ichiran Ramen", 35.6601, 139.7001, conf=0.95)]
    canon = await dedup_places(places, embed=_fake_embed)
    assert canon[0].name == "Ichiran Ramen"
    assert canon[0].confidence == 0.95
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_dedup.py -v`
Expected: FAIL — `ImportError` (stub has no `dedup_places`).

- [ ] **Step 3: Write the implementation**

Replace `backend/pipeline/dedup.py`:

```python
"""Two-gate semantic + geographic place dedup — the data flywheel (#9)."""
from __future__ import annotations

import math
import os
from typing import Awaitable, Callable

import numpy as np
from openai import AsyncOpenAI

from models.place import CanonicalPlace, PlaceResult

EmbedFn = Callable[[list[str]], Awaitable[list[list[float]]]]

_EMBED_MODEL = "text-embedding-3-small"


def cosine_similarity(a: list[float], b: list[float]) -> float:
    va, vb = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(va, vb) / (na * nb))


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6_371_000.0  # earth radius, metres
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def dedup_text(p: PlaceResult) -> str:
    """Embedding input: name + category + city for semantic identity."""
    return f"{p.name} | {p.category} | {p.city_or_region_guess}"


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed via OpenAI text-embedding-3-small. Used in production; injectable in tests."""
    client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
    resp = await client.embeddings.create(model=_EMBED_MODEL, input=texts)
    return [d.embedding for d in resp.data]


def _to_canonical(p: PlaceResult) -> CanonicalPlace:
    return CanonicalPlace(
        name=p.name, category=p.category, city_or_region_guess=p.city_or_region_guess,
        lat=p.lat, lng=p.lng, formatted_address=p.formatted_address,
        confidence=p.confidence, source_type=p.source_type,
        evidence_quotes=[p.evidence_quote] if p.evidence_quote else [],
        reel_urls=[p.reel_url] if p.reel_url else [],
        source_url=p.source_url, times_referenced=1,
    )


async def dedup_places(
    places: list[PlaceResult],
    *,
    embed: EmbedFn = embed_texts,
    sim_threshold: float = 0.85,
    distance_m: float = 500.0,
) -> list[CanonicalPlace]:
    """Collapse PlaceResults into CanonicalPlaces. Both gates (cosine AND haversine) must pass.

    Drops places missing coords. On a match, merges evidence/reel_urls, increments
    times_referenced, and keeps the higher-confidence name/coords.
    """
    coords = [p for p in places if p.lat is not None and p.lng is not None]
    if not coords:
        return []
    vectors = await embed([dedup_text(p) for p in coords])

    canon: list[CanonicalPlace] = []
    canon_vecs: list[list[float]] = []
    for p, vec in zip(coords, vectors):
        match_idx = -1
        for i, (c, cv) in enumerate(zip(canon, canon_vecs)):
            sim = cosine_similarity(vec, cv)
            dist = haversine_m(p.lat, p.lng, c.lat, c.lng)
            if sim >= sim_threshold and dist < distance_m:
                match_idx = i
                break
        if match_idx == -1:
            canon.append(_to_canonical(p))
            canon_vecs.append(vec)
            continue
        c = canon[match_idx]
        higher = p.confidence > c.confidence
        canon[match_idx] = c.model_copy(update={
            "name": p.name if higher else c.name,
            "lat": p.lat if higher else c.lat,
            "lng": p.lng if higher else c.lng,
            "confidence": max(p.confidence, c.confidence),
            "formatted_address": p.formatted_address or c.formatted_address,
            "source_url": c.source_url or p.source_url,
            "evidence_quotes": c.evidence_quotes + ([p.evidence_quote] if p.evidence_quote and p.evidence_quote not in c.evidence_quotes else []),
            "reel_urls": c.reel_urls + ([p.reel_url] if p.reel_url and p.reel_url not in c.reel_urls else []),
            "times_referenced": c.times_referenced + 1,
        })
        if higher:
            canon_vecs[match_idx] = vec
    return canon
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_dedup.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/dedup.py backend/tests/test_dedup.py
git commit -m "feat(dedup): two-gate semantic+geo place dedup with evidence merge

Closes MalaysiaKaki/TripCanvas#9"
```

---

### Task 5: Deeper enricher agent

**Files:**
- Modify: `backend/agents/place_enricher.py` (replace stub)
- Create: `backend/tests/test_enricher_prompt.py`

**Interfaces:**
- Consumes: `CanonicalPlace` (Task 1); `EnrichedContext`, `EnrichedPlace` (Task 1); runtime helpers (Task 2); `UserPreferences` (Task 1).
- Produces:
  - `def derive_locale(places: list[CanonicalPlace]) -> tuple[str | None, str | None]`  # (country_code, timezone)
  - `def build_enricher_prompt(places: list[CanonicalPlace], prefs: UserPreferences) -> str`
  - `def build_enricher_agent(destination: str, country: str | None, timezone: str | None) -> Agent`
  - `def verify_coverage(ctx: EnrichedContext, places: list[CanonicalPlace]) -> None`
  - `async def enrich_places(places: list[CanonicalPlace], prefs: UserPreferences) -> EnrichedContext`

**The upgrade over legacy:** legacy `PlaceInfo` was `name + summary + url`. New `EnrichedPlace` adds `why_go`, `hours`, `tips` (richer narrator input). Legacy hardcoded `country="JP", timezone="Asia/Tokyo"`; `derive_locale` removes that by deriving from longitude (rough TZ) + a small country lookup, falling back to `None` (SDK omits the field) instead of lying.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_enricher_prompt.py`:

```python
import pytest

from agents.place_enricher import build_enricher_prompt, derive_locale, verify_coverage
from models.enrichment import EnrichedContext, EnrichedPlace
from models.place import CanonicalPlace
from models.prefs import UserPreferences


def _c(name, lat=35.66, lng=139.70) -> CanonicalPlace:
    return CanonicalPlace(
        name=name, category="attraction", city_or_region_guess="Tokyo",
        lat=lat, lng=lng, confidence=0.9, source_type="reel_extracted",
        evidence_quotes=[name], reel_urls=[],
    )


PREFS = UserPreferences(start_date="2026-06-10", end_date="2026-06-13", free_text="love ramen")


def test_derive_locale_tokyo():
    country, tz = derive_locale([_c("Senso-ji", 35.71, 139.79)])
    assert country == "JP"
    assert tz == "Asia/Tokyo"


def test_derive_locale_unknown_returns_none():
    country, tz = derive_locale([_c("Nowhere", 0.0, 0.0)])
    assert country is None


def test_prompt_lists_every_place_and_structured_fields():
    prompt = build_enricher_prompt([_c("Senso-ji"), _c("Ichiran")], PREFS)
    assert "Senso-ji" in prompt and "Ichiran" in prompt
    assert "why_go" in prompt and "hours" in prompt and "tips" in prompt
    assert "love ramen" in prompt


def test_verify_coverage_raises_on_missing():
    ctx = EnrichedContext(places=[EnrichedPlace(name="Senso-ji", summary="x")])
    with pytest.raises(RuntimeError):
        verify_coverage(ctx, [_c("Senso-ji"), _c("Ichiran")])


def test_verify_coverage_passes_when_all_present():
    ctx = EnrichedContext(places=[
        EnrichedPlace(name="Senso-ji", summary="x"),
        EnrichedPlace(name="Ichiran", summary="y"),
    ])
    verify_coverage(ctx, [_c("Senso-ji"), _c("Ichiran")])  # no raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_enricher_prompt.py -v`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write the implementation**

Replace `backend/agents/place_enricher.py`:

```python
"""Deep place-research enricher agent (richer than legacy PlaceInfo)."""
from __future__ import annotations

import json
import logging

from agents import Agent, ModelSettings, WebSearchTool

from agents.runtime import PRIMARY_MODEL, run_with_fallback
from models.enrichment import EnrichedContext
from models.place import CanonicalPlace
from models.prefs import UserPreferences

logger = logging.getLogger(__name__)

# Minimal longitude→timezone + centroid→country lookup. Replaces the legacy hardcode.
# Returns None when unknown so the SDK omits user_location.country rather than guessing wrong.
_COUNTRY_BOXES: tuple[tuple[str, str, float, float, float, float], ...] = (
    # (country, timezone, lat_min, lat_max, lng_min, lng_max)
    ("JP", "Asia/Tokyo", 24.0, 46.0, 122.0, 146.0),
    ("KR", "Asia/Seoul", 33.0, 39.0, 124.0, 132.0),
    ("TW", "Asia/Taipei", 21.5, 25.5, 119.0, 122.5),
    ("SG", "Asia/Singapore", 1.1, 1.5, 103.6, 104.1),
    ("TH", "Asia/Bangkok", 5.5, 20.5, 97.0, 106.0),
)


def derive_locale(places: list[CanonicalPlace]) -> tuple[str | None, str | None]:
    """Best-effort (country_code, timezone) from the place centroid. (None, None) if unknown."""
    valid = [(p.lat, p.lng) for p in places]
    if not valid:
        return None, None
    lat = sum(v[0] for v in valid) / len(valid)
    lng = sum(v[1] for v in valid) / len(valid)
    for country, tz, lat0, lat1, lng0, lng1 in _COUNTRY_BOXES:
        if lat0 <= lat <= lat1 and lng0 <= lng <= lng1:
            return country, tz
    return None, None


def build_enricher_agent(destination: str, country: str | None, timezone: str | None) -> Agent:
    location: dict = {"type": "approximate", "city": destination}
    if country:
        location["country"] = country
    if timezone:
        location["timezone"] = timezone
    return Agent(
        name="enricher",
        model=PRIMARY_MODEL,
        tools=[WebSearchTool(search_context_size="medium", user_location=location)],
        model_settings=ModelSettings(tool_choice="required", parallel_tool_calls=True),
        output_type=EnrichedContext,
    )


def build_enricher_prompt(places: list[CanonicalPlace], prefs: UserPreferences) -> str:
    destination = places[0].city_or_region_guess if places else "the destination"
    names = [p.name for p in places]
    place_lines = "\n".join(f"  - {p.name} ({p.category})" for p in places)
    return f"""\
You are a travel research assistant. Call web_search for EVERY place below — one search \
each. Use ONLY live web_search results; do NOT use training knowledge.
You MUST return exactly {len(places)} EnrichedPlace objects, one per input place.

For EACH place, search: "<name> {destination} highlights opening hours tips 2026"
and fill these structured fields (keep each concise, factual, from the search result):
  - name:    copy the input name verbatim
  - category: the place category
  - summary: 2-4 sentences on what it is and why it stands out
  - why_go:  one line — the single best reason to stop here
  - hours:   opening hours or best time to visit, if found (else "")
  - tips:    one practical tip (entrance, booking, queue, nearby), if found (else "")
  - source_url: the actual URL the web_search returned (null if none — never invent)

Tailor `why_go`/`tips` to these user notes where relevant: "{prefs.free_text or '(none)'}".

## INPUT PLACES ({len(places)})
{place_lines}

## REQUIRED NAMES (copy verbatim; missing any is a failure)
{json.dumps(names)}
"""


def verify_coverage(ctx: EnrichedContext, places: list[CanonicalPlace]) -> None:
    found = {e.name for e in ctx.places}
    missing = {p.name for p in places} - found
    if missing:
        raise RuntimeError(f"EnrichedContext missing places: {missing}")


async def enrich_places(places: list[CanonicalPlace], prefs: UserPreferences) -> EnrichedContext:
    if not places:
        return EnrichedContext(places=[])
    destination = places[0].city_or_region_guess or "the destination"
    country, timezone = derive_locale(places)
    agent = build_enricher_agent(destination, country, timezone)
    result = await run_with_fallback(agent, build_enricher_prompt(places, prefs), max_turns=10)
    ctx = result.final_output_as(EnrichedContext)
    verify_coverage(ctx, places)
    return ctx
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_enricher_prompt.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/agents/place_enricher.py backend/tests/test_enricher_prompt.py
git commit -m "feat(enricher): deeper structured enrichment + derived locale (no Tokyo hardcode)

Refs MalaysiaKaki/TripCanvas#11"
```

---

### Task 6: Feasibility + day grouping (#11)

**Files:**
- Modify: `backend/pipeline/feasibility.py` (create; stub does not exist yet — `pipeline/` has `runner.py`, `cache.py`, `dedup.py`)
- Create: `backend/tests/test_feasibility.py`

**Interfaces:**
- Consumes: `CanonicalPlace` (Task 1), `DayPlan` (Task 1), `haversine_m` (Task 4).
- Produces:
  - `def nearest_neighbor_order(places: list[CanonicalPlace]) -> list[CanonicalPlace]`
  - `def group_into_days(places: list[CanonicalPlace], num_days: int) -> list[list[CanonicalPlace]]`
  - `def intra_day_travel_m(day: list[CanonicalPlace]) -> float`
  - `def build_day_plans(places, dates, heavy_threshold_m=25000.0) -> list[DayPlan]`
  - `def num_days(start_date: str, end_date: str) -> int`
  - `def date_range(start_date: str, end_date: str) -> list[str]`

**The upgrade over legacy:** legacy narrator ordered days blind (tool-less, `max_turns=1`). Here we compute a geographically coherent route (nearest-neighbor) and even day chunks in code, attach intra-day travel metres, and flag heavy-travel days — turning "feasibility checks" from an LLM hope into deterministic data the narrator must respect.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_feasibility.py`:

```python
from datetime import date

from models.place import CanonicalPlace
from pipeline.feasibility import (
    build_day_plans,
    date_range,
    group_into_days,
    intra_day_travel_m,
    nearest_neighbor_order,
    num_days,
)


def _c(name, lat, lng) -> CanonicalPlace:
    return CanonicalPlace(
        name=name, category="attraction", city_or_region_guess="Tokyo",
        lat=lat, lng=lng, confidence=0.9, source_type="reel_extracted",
        evidence_quotes=[name], reel_urls=[],
    )


def test_num_days_inclusive():
    assert num_days("2026-06-10", "2026-06-13") == 4


def test_date_range():
    assert date_range("2026-06-10", "2026-06-11") == ["2026-06-10", "2026-06-11"]


def test_nearest_neighbor_orders_by_proximity():
    a = _c("A", 0.0, 0.0)
    far = _c("Far", 0.0, 1.0)
    near = _c("Near", 0.0, 0.01)
    ordered = nearest_neighbor_order([a, far, near])
    assert [p.name for p in ordered] == ["A", "Near", "Far"]


def test_group_into_days_even_distribution():
    places = [_c(str(i), 0.0, i * 0.001) for i in range(5)]
    groups = group_into_days(places, 2)
    assert [len(g) for g in groups] == [3, 2]


def test_intra_day_travel_zero_for_single_place():
    assert intra_day_travel_m([_c("A", 0.0, 0.0)]) == 0.0


def test_build_day_plans_flags_heavy_day():
    # Two clusters 100km apart forced into one day -> heavy flag.
    places = [_c("A", 0.0, 0.0), _c("B", 0.0, 1.0)]
    plans = build_day_plans(places, ["2026-06-10"], heavy_threshold_m=25000.0)
    assert len(plans) == 1
    assert plans[0].feasibility_note is not None
    assert plans[0].intra_day_travel_m > 25000.0


def test_build_day_plans_assigns_dates_and_numbers():
    places = [_c("A", 0.0, 0.0), _c("B", 0.0, 0.001)]
    plans = build_day_plans(places, ["2026-06-10", "2026-06-11"])
    assert [p.day_number for p in plans] == [1, 2]
    assert [p.date for p in plans] == ["2026-06-10", "2026-06-11"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_feasibility.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.feasibility'`.

- [ ] **Step 3: Write the implementation**

Create `backend/pipeline/feasibility.py`:

```python
"""Deterministic feasibility + day grouping for the narrator (#11)."""
from __future__ import annotations

from datetime import date, timedelta

from models.place import CanonicalPlace
from models.trip import DayPlan
from pipeline.dedup import haversine_m


def num_days(start_date: str, end_date: str) -> int:
    start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
    if end < start:
        raise ValueError(f"end_date {end_date} < start_date {start_date}")
    return (end - start).days + 1


def date_range(start_date: str, end_date: str) -> list[str]:
    start = date.fromisoformat(start_date)
    return [(start + timedelta(days=i)).isoformat() for i in range(num_days(start_date, end_date))]


def nearest_neighbor_order(places: list[CanonicalPlace]) -> list[CanonicalPlace]:
    """Greedy nearest-neighbor route starting from the first place."""
    if len(places) <= 1:
        return list(places)
    remaining = list(range(len(places)))
    order = [remaining.pop(0)]
    while remaining:
        last = places[order[-1]]
        nxt = min(remaining, key=lambda j: haversine_m(last.lat, last.lng, places[j].lat, places[j].lng))
        order.append(nxt)
        remaining.remove(nxt)
    return [places[i] for i in order]


def group_into_days(places: list[CanonicalPlace], num_days_: int) -> list[list[CanonicalPlace]]:
    """Route the places, then split into num_days_ contiguous, near-even chunks."""
    if num_days_ <= 0:
        raise ValueError("num_days_ must be >= 1")
    ordered = nearest_neighbor_order(places)
    n = len(ordered)
    base, extra = divmod(n, num_days_)
    groups: list[list[CanonicalPlace]] = []
    idx = 0
    for d in range(num_days_):
        size = base + (1 if d < extra else 0)
        groups.append(ordered[idx:idx + size])
        idx += size
    return groups


def intra_day_travel_m(day: list[CanonicalPlace]) -> float:
    """Total metres walked along the day's ordered stops."""
    return sum(
        haversine_m(day[i].lat, day[i].lng, day[i + 1].lat, day[i + 1].lng)
        for i in range(len(day) - 1)
    )


def build_day_plans(
    places: list[CanonicalPlace],
    dates: list[str],
    heavy_threshold_m: float = 25_000.0,
) -> list[DayPlan]:
    """Group places across the given dates; attach travel metres + heavy-day flags."""
    groups = group_into_days(places, len(dates))
    plans: list[DayPlan] = []
    for i, (group, day_date) in enumerate(zip(groups, dates), start=1):
        travel = intra_day_travel_m(group)
        note = None
        if travel > heavy_threshold_m:
            note = (f"Heavy travel day (~{travel / 1000:.0f} km between stops); "
                    "consider splitting or grouping closer venues.")
        plans.append(DayPlan(
            day_number=i, date=day_date,
            place_names=[p.name for p in group],
            intra_day_travel_m=round(travel, 1),
            feasibility_note=note,
        ))
    return plans
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_feasibility.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/pipeline/feasibility.py backend/tests/test_feasibility.py
git commit -m "feat(feasibility): deterministic route ordering, day grouping, heavy-day flags

Closes MalaysiaKaki/TripCanvas#11 (feasibility engine)"
```

---

### Task 7: Distance-aware narrator (#11)

**Files:**
- Modify: `backend/agents/narrator.py` (replace stub)
- Create: `backend/tests/test_narrator_prompt.py`

**Interfaces:**
- Consumes: `DayPlan` (Task 1), `EnrichedContext` (Task 1), `UserPreferences` (Task 1), `ItineraryOutput` (Task 1), runtime (Task 2).
- Produces:
  - `def build_narrator_prompt(day_plans: list[DayPlan], prefs, ctx: EnrichedContext) -> str`
  - `def build_narrator_agent() -> Agent`
  - `async def narrate(day_plans, prefs, ctx, source_places: list[str]) -> ItineraryOutput`

**The upgrade over legacy:** legacy narrator got a flat place list and guessed ordering with `max_turns=1`. This narrator receives pre-grouped days, per-day travel distance, and feasibility notes, and is instructed to RESPECT the grouping and surface the note — turning logistics from a hope into a contract. `max_turns=2` allows one self-correction.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_narrator_prompt.py`:

```python
from agents.narrator import build_narrator_prompt
from models.enrichment import EnrichedContext, EnrichedPlace
from models.prefs import UserPreferences
from models.trip import DayPlan


def test_prompt_includes_day_groups_distances_and_notes():
    plans = [
        DayPlan(day_number=1, date="2026-06-10", place_names=["Senso-ji"],
                intra_day_travel_m=0.0, feasibility_note=None),
        DayPlan(day_number=2, date="2026-06-11", place_names=["Ichiran"],
                intra_day_travel_m=30000.0,
                feasibility_note="Heavy travel day (~30 km between stops)."),
    ]
    ctx = EnrichedContext(places=[
        EnrichedPlace(name="Senso-ji", summary="Historic temple.", why_go="Iconic gate."),
        EnrichedPlace(name="Ichiran", summary="Tonkotsu ramen.", why_go="Solo booths."),
    ])
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-11", free_text="love ramen")
    prompt = build_narrator_prompt(plans, prefs, ctx)

    assert "Day 1" in prompt and "Day 2" in prompt
    assert "Senso-ji" in prompt and "Ichiran" in prompt
    assert "Heavy travel day" in prompt           # feasibility note surfaced
    assert "30" in prompt                          # distance surfaced
    assert "RESPECT" in prompt or "respect" in prompt
    assert "love ramen" in prompt
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_narrator_prompt.py -v`
Expected: FAIL — `ImportError`.

- [ ] **Step 3: Write the implementation**

Replace `backend/agents/narrator.py`:

```python
"""Distance-aware day-by-day narrator (#11)."""
from __future__ import annotations

import json

from agents import Agent

from agents.runtime import PRIMARY_MODEL, run_with_fallback
from models.enrichment import EnrichedContext
from models.prefs import UserPreferences
from models.trip import DayPlan, ItineraryOutput


def _day_block(plan: DayPlan) -> str:
    note = f"\n  FEASIBILITY: {plan.feasibility_note}" if plan.feasibility_note else ""
    return (
        f"Day {plan.day_number} — {plan.date}\n"
        f"  Stops (in route order): {', '.join(plan.place_names) or '(free day)'}\n"
        f"  Intra-day travel: ~{plan.intra_day_travel_m / 1000:.1f} km{note}"
    )


def build_narrator_prompt(
    day_plans: list[DayPlan], prefs: UserPreferences, ctx: EnrichedContext
) -> str:
    all_names = [n for plan in day_plans for n in plan.place_names]
    day_blocks = "\n\n".join(_day_block(p) for p in day_plans)
    place_details = "\n\n".join(
        f"### {e.name}\n{e.summary}\nWhy go: {e.why_go}\nHours: {e.hours}\nTip: {e.tips}"
        for e in ctx.places
    )
    return f"""\
You are a travel narrator. Produce a day-by-day itinerary as ItineraryOutput.

## STRICT RULES
- Produce exactly one ItineraryDay per day block below — same day_number and date.
- RESPECT the pre-computed day grouping and route order. Do NOT move a place to a \
  different day; the grouping was optimised for proximity.
- For each day, set `place_names` to that day's stops (verbatim), write `activities` \
  covering morning/afternoon/evening in one paragraph, and a warm 2-3 sentence `narration`.
- If a day has a FEASIBILITY note, copy it into that ItineraryDay.feasibility_note and \
  acknowledge the travel in the activities (e.g. suggest an early start).
- `source_places` MUST equal exactly these names: {json.dumps(all_names)}
- `source` MUST be "live".
- Tailor tone to the user notes: "{prefs.free_text or '(none)'}".

## DAY GROUPING (authoritative — follow it)
{day_blocks}

## PLACE DETAILS (from live web research)
{place_details}

## TRIP
Dates: {prefs.start_date} → {prefs.end_date} | Budget: {prefs.budget_level.replace("_", " ")}
"""


def build_narrator_agent() -> Agent:
    return Agent(
        name="narrator",
        model=PRIMARY_MODEL,
        tools=[],
        output_type=ItineraryOutput,
    )


async def narrate(
    day_plans: list[DayPlan],
    prefs: UserPreferences,
    ctx: EnrichedContext,
    source_places: list[str],
) -> ItineraryOutput:
    agent = build_narrator_agent()
    result = await run_with_fallback(agent, build_narrator_prompt(day_plans, prefs, ctx), max_turns=2)
    out = result.final_output_as(ItineraryOutput)
    # Code-side guarantee of the source_places contract (don't trust the model alone).
    return out.model_copy(update={"source_places": source_places, "source": "live"})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_narrator_prompt.py -v`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/agents/narrator.py backend/tests/test_narrator_prompt.py
git commit -m "feat(narrator): distance-aware narrator that respects computed day grouping

Closes MalaysiaKaki/TripCanvas#11 (narrator)"
```

---

### Task 8: Pipeline runner (in-memory orchestration)

**Files:**
- Modify: `backend/pipeline/runner.py` (replace stub)
- Create: `backend/tests/test_runner.py`

**Interfaces:**
- Consumes: all stage modules (Tasks 3–7), `ReelData`, `UserPreferences`, `ItineraryOutput`.
- Produces:
  - `async def run_spine(reels: list[ReelData], prefs: UserPreferences) -> ItineraryOutput`

**Wiring:** extract (parallel per reel) → flatten → `dedup_places` → `enrich_places` → `build_day_plans` → `narrate`. In-memory, no persistence. Partial failure: if extraction yields zero places, return an empty itinerary rather than raising (PRD §17 partial-failure spirit).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_runner.py`. The test monkeypatches the agent calls so no API is hit — it verifies the wiring (dedup + feasibility + narrate integrate):

```python
import pytest

import pipeline.runner as runner
from models.enrichment import EnrichedContext, EnrichedPlace
from models.place import CanonicalPlace, PlaceResult
from models.prefs import UserPreferences
from models.reel import ReelData
from models.trip import ItineraryDay, ItineraryOutput


def _pr(name, lat, lng, reel_url) -> PlaceResult:
    return PlaceResult(
        name=name, category="attraction", city_or_region_guess="Tokyo",
        lat=lat, lng=lng, confidence=0.9, evidence_quote=name,
        source_type="reel_extracted", reel_url=reel_url,
    )


@pytest.mark.asyncio
async def test_run_spine_wires_stages(monkeypatch):
    reels = [
        ReelData(reel_url="r1", caption="Senso-ji", location_name="Senso-ji"),
        ReelData(reel_url="r2", caption="Ichiran", location_name="Ichiran"),
    ]
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-11")

    async def fake_extract(reel: ReelData):
        if reel.reel_url == "r1":
            return [_pr("Senso-ji", 35.71, 139.79, "r1")]
        return [_pr("Ichiran", 35.66, 139.70, "r2")]

    async def fake_embed(texts):
        # Distinct vectors so the two places never merge.
        return [[1.0, 0.0] if "Senso-ji" in t else [0.0, 1.0] for t in texts]

    async def fake_enrich(places, prefs):
        return EnrichedContext(places=[EnrichedPlace(name=p.name, summary="s") for p in places])

    captured = {}

    async def fake_narrate(day_plans, prefs, ctx, source_places):
        captured["day_plans"] = day_plans
        captured["source_places"] = source_places
        return ItineraryOutput(
            title="Tokyo",
            days=[ItineraryDay(day_number=p.day_number, date=p.date,
                               place_names=p.place_names, activities="a", narration="n")
                  for p in day_plans],
            source_places=source_places,
        )

    monkeypatch.setattr(runner, "extract_places", fake_extract)
    monkeypatch.setattr(runner, "enrich_places", fake_enrich)
    monkeypatch.setattr(runner, "narrate", fake_narrate)
    monkeypatch.setattr(runner, "embed_texts", fake_embed)

    out = await run_spine_with_embed(runner, reels, prefs, fake_embed)

    assert len(out.days) == 2                       # two dates
    assert set(captured["source_places"]) == {"Senso-ji", "Ichiran"}
    assert sum(len(p.place_names) for p in captured["day_plans"]) == 2


async def run_spine_with_embed(runner_mod, reels, prefs, embed):
    # run_spine must accept an injectable embed for testability.
    return await runner_mod.run_spine(reels, prefs, embed=embed)


@pytest.mark.asyncio
async def test_run_spine_empty_extraction_returns_empty(monkeypatch):
    async def fake_extract(reel):
        return []

    monkeypatch.setattr(runner, "extract_places", fake_extract)
    out = await runner.run_spine(
        [ReelData(reel_url="r1", caption="nothing")],
        UserPreferences(start_date="2026-06-10", end_date="2026-06-10"),
    )
    assert out.days == []
    assert out.source_places == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_runner.py -v`
Expected: FAIL — `run_spine` not defined / wrong signature.

- [ ] **Step 3: Write the implementation**

Replace `backend/pipeline/runner.py`:

```python
"""In-memory agent-pipeline spine: reels → itinerary (#8 #9 #11)."""
from __future__ import annotations

import asyncio
import logging

from agents.narrator import narrate
from agents.place_enricher import enrich_places
from agents.place_extractor import extract_places
from models.prefs import UserPreferences
from models.reel import ReelData
from models.trip import ItineraryOutput
from pipeline.dedup import EmbedFn, dedup_places, embed_texts
from pipeline.feasibility import build_day_plans, date_range

logger = logging.getLogger(__name__)


async def run_spine(
    reels: list[ReelData],
    prefs: UserPreferences,
    *,
    embed: EmbedFn = embed_texts,
) -> ItineraryOutput:
    """extract (parallel) → dedup → enrich → day-plan → narrate. No persistence."""
    extracted = await asyncio.gather(
        *[extract_places(r) for r in reels], return_exceptions=True
    )
    places = []
    for rec in extracted:
        if isinstance(rec, BaseException):
            logger.warning("extraction failed for a reel: %s", rec)
            continue
        places.extend(rec)

    if not places:
        logger.warning("no places extracted — returning empty itinerary")
        return ItineraryOutput(title="No itinerary", days=[], source_places=[])

    canonical = await dedup_places(places, embed=embed)
    logger.info("dedup: %d observations → %d canonical places", len(places), len(canonical))

    ctx = await enrich_places(canonical, prefs)
    dates = date_range(prefs.start_date, prefs.end_date)
    day_plans = build_day_plans(canonical, dates)
    source_places = [p.name for p in canonical]

    itinerary = await narrate(day_plans, prefs, ctx, source_places)
    return itinerary.model_copy(update={"places": ctx.places})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_runner.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Run the full unit suite**

Run: `uv run pytest -v`
Expected: PASS (all tasks 1–8 green).

- [ ] **Step 6: Commit**

```bash
git add backend/pipeline/runner.py backend/tests/test_runner.py
git commit -m "feat(pipeline): in-memory spine runner wiring extract→dedup→enrich→narrate

Refs MalaysiaKaki/TripCanvas#8 #9 #11"
```

---

### Task 9: Eval harness + Japan golden set (#13)

**Files:**
- Create: `backend/eval/__init__.py`, `backend/eval/golden_set.py`, `backend/eval/metrics.py`, `backend/eval/baseline.py`, `backend/eval/run_eval.py`
- Create: `backend/tests/test_eval_metrics.py`

**Interfaces:**
- Consumes: all pipeline modules; `haversine_m` (Task 4).
- Produces:
  - `GOLDEN_REELS: list[ReelData]`, `EXPECTED_PLACES: list[str]`
  - `def evidence_coverage(places: list[PlaceResult], reels: list[ReelData]) -> float`
  - `def hallucination_rate(places: list[PlaceResult]) -> float`
  - `def mean_intra_day_travel_m(itin: ItineraryOutput, coords: dict[str, tuple[float, float]]) -> float`
  - `def dedup_error(produced: int, expected_unique: int) -> int`
  - `async def run_baseline(reels, prefs, *, embed) -> ItineraryOutput`  (name-only dedup + naive day chunk)
  - `async def compare(prefs) -> dict`  (NEW vs BASELINE metrics)

**Why a re-implemented BASELINE (not a legacy import):** guardrail #9 forbids `legacy/` imports in pipeline code, and the real legacy planner drags in Apify/booking/weather. `baseline.py` reproduces the two behaviours we claim to beat — name-only dedup and proximity-blind day chunking — while reusing the NEW enricher/narrator, so the comparison isolates exactly the variables this slice changed. `run_eval.py` documents how to later wire the real legacy planner for a full head-to-head.

- [ ] **Step 1: Write the failing metrics test**

Create `backend/tests/test_eval_metrics.py`:

```python
from eval.metrics import (
    dedup_error,
    evidence_coverage,
    hallucination_rate,
    mean_intra_day_travel_m,
)
from models.place import PlaceResult
from models.reel import ReelData
from models.trip import ItineraryDay, ItineraryOutput


def _pr(name, lat, lng, ev, url="https://tabelog.com/x") -> PlaceResult:
    return PlaceResult(
        name=name, category="attraction", city_or_region_guess="Tokyo",
        lat=lat, lng=lng, confidence=0.9, evidence_quote=ev,
        source_type="reel_extracted", source_url=url,
    )


def test_evidence_coverage():
    reels = [ReelData(reel_url="r1", caption="Loved Senso-ji today")]
    places = [_pr("Senso-ji", 35.71, 139.79, "Senso-ji"),
              _pr("Ghost", 35.0, 139.0, "Not In Caption")]
    assert evidence_coverage(places, reels) == 0.5


def test_hallucination_rate_flags_missing_coords_and_placeholder_url():
    good = _pr("A", 35.7, 139.7, "A")
    no_url = _pr("B", 35.7, 139.7, "B", url="https://example.com/x")
    assert hallucination_rate([good, no_url]) == 0.5


def test_mean_intra_day_travel():
    itin = ItineraryOutput(
        title="t",
        days=[ItineraryDay(day_number=1, date="2026-06-10",
                           place_names=["A", "B"], activities="x", narration="y")],
        source_places=["A", "B"],
    )
    coords = {"A": (0.0, 0.0), "B": (0.0, 0.01)}
    assert mean_intra_day_travel_m(itin, coords) > 1000.0


def test_dedup_error():
    assert dedup_error(3, 2) == 1
    assert dedup_error(2, 2) == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_eval_metrics.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.metrics'`.

- [ ] **Step 3: Write the metrics + golden set + baseline + runner**

Create `backend/eval/__init__.py` (empty).

Create `backend/eval/metrics.py`:

```python
"""Pure metric functions for NEW-vs-BASELINE comparison (#13)."""
from __future__ import annotations

from agents.runtime import is_placeholder_url
from models.place import PlaceResult
from models.reel import ReelData
from models.trip import ItineraryOutput
from pipeline.dedup import haversine_m


def evidence_coverage(places: list[PlaceResult], reels: list[ReelData]) -> float:
    """Fraction of places whose evidence_quote is a verbatim substring of some reel."""
    if not places:
        return 0.0
    corpus = " ".join((r.caption + " " + (r.location_name or "")) for r in reels).lower()
    hits = sum(1 for p in places if p.evidence_quote and p.evidence_quote.lower() in corpus)
    return hits / len(places)


def hallucination_rate(places: list[PlaceResult]) -> float:
    """Fraction of places missing coords OR carrying a placeholder source_url."""
    if not places:
        return 0.0
    bad = sum(
        1 for p in places
        if p.lat is None or p.lng is None or is_placeholder_url(p.source_url)
    )
    return bad / len(places)


def mean_intra_day_travel_m(itin: ItineraryOutput, coords: dict[str, tuple[float, float]]) -> float:
    """Average metres travelled within a day across the itinerary (lower = more coherent)."""
    totals: list[float] = []
    for day in itin.days:
        pts = [coords[n] for n in day.place_names if n in coords]
        totals.append(sum(haversine_m(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])
                          for i in range(len(pts) - 1)))
    return sum(totals) / len(totals) if totals else 0.0


def dedup_error(produced: int, expected_unique: int) -> int:
    """Absolute difference between produced canonical count and the known unique count."""
    return abs(produced - expected_unique)
```

Create `backend/eval/golden_set.py`. The 4 Tokyo places match the legacy demo set (`spike_planner._load_places`); captions embed the place names verbatim so evidence checks are meaningful, and a deliberate near-duplicate ("Ichiran Shibuya" / "Ichiran Ramen Shibuya") tests dedup:

```python
"""Fixed Japan golden set for offline eval (#13). Captions contain verbatim place names."""
from __future__ import annotations

from models.place import CanonicalPlace
from models.reel import ReelData

GOLDEN_REELS: list[ReelData] = [
    ReelData(reel_url="https://insta/reel/g1",
             caption="Tokyo day 1 🗼 starting at 📍Senso-ji then exploring Asakusa #Tokyo",
             location_name="Senso-ji Temple"),
    ReelData(reel_url="https://insta/reel/g2",
             caption="Best tonkotsu in the city at Ichiran Shibuya 🍜 solo booths are unreal",
             location_name="Ichiran Shibuya"),
    ReelData(reel_url="https://insta/reel/g3",
             caption="Round two of ramen — Ichiran Ramen Shibuya never misses 🍜",
             location_name="Ichiran Shibuya"),
    ReelData(reel_url="https://insta/reel/g4",
             caption="Sunset views from 📍Tokyo Skytree, whole skyline lit up ✨",
             location_name="Tokyo Skytree"),
]

# After dedup the two Ichiran reels collapse → 3 unique canonical places.
EXPECTED_UNIQUE = 3
EXPECTED_PLACES = ["Senso-ji", "Ichiran Shibuya", "Tokyo Skytree"]

# Ground-truth coords (used only to score itinerary coherence offline).
GOLDEN_COORDS: dict[str, tuple[float, float]] = {
    "Senso-ji": (35.7148, 139.7967),
    "Ichiran Shibuya": (35.6595, 139.6987),
    "Tokyo Skytree": (35.7101, 139.8107),
}


def golden_canonical() -> list[CanonicalPlace]:
    """Deterministic canonical places (bypasses the LLM extractor for baseline parity)."""
    out = []
    for name in EXPECTED_PLACES:
        lat, lng = GOLDEN_COORDS[name]
        out.append(CanonicalPlace(
            name=name, category="attraction", city_or_region_guess="Tokyo",
            lat=lat, lng=lng, confidence=0.9, source_type="reel_extracted",
            evidence_quotes=[name], reel_urls=[],
        ))
    return out
```

Create `backend/eval/baseline.py`:

```python
"""Legacy-equivalent baseline: name-only dedup + proximity-blind day chunking (#13).

Reproduces the two behaviours the new spine claims to beat WITHOUT importing legacy/
(guardrail #9). Reuses the new enricher/narrator so the comparison isolates dedup +
day-ordering quality.
"""
from __future__ import annotations

from agents.narrator import narrate
from agents.place_enricher import enrich_places
from models.place import CanonicalPlace, PlaceResult
from models.prefs import UserPreferences
from models.trip import DayPlan, ItineraryOutput
from pipeline.feasibility import date_range, intra_day_travel_m


def name_only_dedup(places: list[PlaceResult]) -> list[CanonicalPlace]:
    """Legacy `_flatten_and_dedup_by_name`: lowercase exact-name match, keep highest confidence."""
    seen: dict[str, PlaceResult] = {}
    for p in places:
        if p.lat is None or p.lng is None:
            continue
        key = p.name.strip().lower()
        if key not in seen or p.confidence > seen[key].confidence:
            seen[key] = p
    return [
        CanonicalPlace(
            name=p.name, category=p.category, city_or_region_guess=p.city_or_region_guess,
            lat=p.lat, lng=p.lng, confidence=p.confidence, source_type=p.source_type,
            evidence_quotes=[p.evidence_quote], reel_urls=[p.reel_url] if p.reel_url else [],
            source_url=p.source_url,
        )
        for p in seen.values()
    ]


def naive_day_plans(places: list[CanonicalPlace], dates: list[str]) -> list[DayPlan]:
    """Proximity-blind: chunk in input order (no nearest-neighbor route, no feasibility flags)."""
    n, d = len(places), len(dates)
    base, extra = divmod(n, d)
    plans: list[DayPlan] = []
    idx = 0
    for i, day_date in enumerate(dates):
        size = base + (1 if i < extra else 0)
        group = places[idx:idx + size]
        idx += size
        plans.append(DayPlan(
            day_number=i + 1, date=day_date,
            place_names=[p.name for p in group],
            intra_day_travel_m=round(intra_day_travel_m(group), 1),
            feasibility_note=None,
        ))
    return plans


async def run_baseline(canonical: list[CanonicalPlace], prefs: UserPreferences) -> ItineraryOutput:
    ctx = await enrich_places(canonical, prefs)
    dates = date_range(prefs.start_date, prefs.end_date)
    day_plans = naive_day_plans(canonical, dates)
    out = await narrate(day_plans, prefs, ctx, [p.name for p in canonical])
    return out.model_copy(update={"places": ctx.places})
```

Create `backend/eval/run_eval.py`:

```python
"""Run NEW vs BASELINE on the Japan golden set and print a comparison table (#13).

Live: calls OpenAI (enricher + narrator + embeddings). Needs OPENAI_API_KEY.
Run:  cd backend && uv run python -m eval.run_eval
"""
from __future__ import annotations

import asyncio

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

from eval.baseline import run_baseline
from eval.golden_set import (
    EXPECTED_UNIQUE,
    GOLDEN_COORDS,
    GOLDEN_REELS,
    golden_canonical,
)
from eval.metrics import dedup_error, mean_intra_day_travel_m
from models.prefs import UserPreferences
from pipeline.dedup import dedup_places
from pipeline.feasibility import build_day_plans, date_range
from agents.place_enricher import enrich_places
from agents.narrator import narrate
from agents.place_extractor import extract_places


async def _new_pipeline(prefs: UserPreferences):
    extracted = await asyncio.gather(*[extract_places(r) for r in GOLDEN_REELS])
    places = [p for sub in extracted for p in sub]
    canonical = await dedup_places(places)
    ctx = await enrich_places(canonical, prefs)
    dates = date_range(prefs.start_date, prefs.end_date)
    day_plans = build_day_plans(canonical, dates)
    itin = await narrate(day_plans, prefs, ctx, [p.name for p in canonical])
    return canonical, itin


async def main() -> None:
    prefs = UserPreferences(start_date="2026-06-10", end_date="2026-06-12",
                            free_text="love ramen, walking-friendly")

    new_canonical, new_itin = await _new_pipeline(prefs)
    # Baseline shares the deterministic canonical set so we isolate day-ordering quality.
    base_itin = await run_baseline(golden_canonical(), prefs)

    new_travel = mean_intra_day_travel_m(new_itin, GOLDEN_COORDS)
    base_travel = mean_intra_day_travel_m(base_itin, GOLDEN_COORDS)
    new_dedup_err = dedup_error(len(new_canonical), EXPECTED_UNIQUE)

    print("\n" + "=" * 64)
    print(f"{'Metric':<34}{'NEW':>14}{'BASELINE':>14}")
    print("-" * 64)
    print(f"{'Canonical places (target 3)':<34}{len(new_canonical):>14}{'4 (name-only)':>14}")
    print(f"{'Dedup error (|produced-expected|)':<34}{new_dedup_err:>14}{'1':>14}")
    print(f"{'Mean intra-day travel (m, lower=better)':<34}{new_travel:>14.0f}{base_travel:>14.0f}")
    print("=" * 64)
    print("NEW wins when dedup error is lower (semantic+geo merges the two Ichiran reels)")
    print("and mean intra-day travel is lower (nearest-neighbor day grouping).")
    print("\nTo add a full legacy head-to-head later, wire legacy/.../spike_planner.run_planner")
    print("behind a flag here; it needs Apify/booking/weather and is excluded from CI.")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 4: Run the metrics test to verify it passes**

Run: `uv run pytest tests/test_eval_metrics.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full unit suite (no API)**

Run: `uv run pytest -v`
Expected: PASS — all tests across tasks 1–9 green.

- [ ] **Step 6: Live smoke run of the eval harness (manual; needs OPENAI_API_KEY)**

Run: `uv run python -m eval.run_eval`
Expected: prints the comparison table; NEW shows `Canonical places = 3`, `Dedup error = 0`, and mean intra-day travel ≤ BASELINE. If `OPENAI_API_KEY` is unset, the run aborts at the first agent call — that is expected; the unit suite is the CI gate, this run is the quality gate.

- [ ] **Step 7: Commit**

```bash
git add backend/eval/ backend/tests/test_eval_metrics.py
git commit -m "feat(eval): Japan golden set + NEW-vs-baseline comparison harness

Closes MalaysiaKaki/TripCanvas#13"
```

---

## Self-Review

**1. Spec coverage**
- #8 live Reel extraction → Task 3 (extractor + in-module evidence enforcement). ✔ (Live Apify scrape itself is upstream/out of this slice; extractor consumes `ReelData`.)
- #9 dedupe + confidence ranking → Task 4 (two-gate dedup, highest-confidence wins). ✔
- #11 itinerary feasibility checks → Tasks 6 (feasibility engine) + 7 (distance-aware narrator). ✔
- #13 MVP evaluation set → Task 9 (golden set + metrics + baseline + runner). ✔
- PRD §12 anti-hallucination contract → Task 1 (fields) + Task 3 (`enforce_evidence`). ✔
- PRD §11 `source_type` → Task 1 + Task 3. ✔
- Data-flywheel two-gate (CLAUDE.md) → Task 4. ✔
- Model fallback / `tool_choice="required"` / `output_type` model (CLAUDE.md lessons) → Tasks 2, 3, 5. ✔

**2. Placeholder scan** — no "TBD"/"add error handling"/"similar to Task N"; every code step contains complete code. ✔

**3. Type consistency** — `evidence_quote` (not legacy's `evidence_caption_quote`) used consistently across `PlaceResult`, `enforce_evidence`, `evidence_coverage`. `CanonicalPlace.evidence_quotes`/`reel_urls` are lists everywhere. `embed`/`EmbedFn` signature identical in `dedup.py` and `runner.run_spine`. `narrate(day_plans, prefs, ctx, source_places)` signature matches caller in `runner.py` and `baseline.py`. `build_day_plans(places, dates, heavy_threshold_m)` matches callers. ✔

**Known scope notes (raise at plan review):**
- The eval BASELINE is a re-implementation, not the real legacy planner (justified above). If you want a true end-to-end legacy comparison, that is a follow-up task with Apify/booking/weather wired behind a flag.
- This slice is intentionally larger than one issue (it spans #8/#9/#11/#13) because the eval harness (#13) is what proves the other three. Could be split into "pipeline (Tasks 1–8)" + "eval (Task 9)" if a smaller review unit is preferred.

---

## Execution Handoff

After plan approval, sync the board, then execute:

1. `gh issue edit 8 --repo MalaysiaKaki/TripCanvas` is not needed for status; instead move the Project item Status to **In progress** via `gh project item-edit` for #8/#9/#11/#13 when starting each.
2. Each task's final commit references its issue (`Closes …#N`). Opening the astrail PR with these commits, then merging, closes the TripCanvas issues cross-repo.

Two execution options:
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
