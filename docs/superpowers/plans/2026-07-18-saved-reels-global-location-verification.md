# Saved Reels Global Location Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin successfully researched Reel places worldwide only when their sourced coordinates and researched country agree with an independent Mapbox reverse-country check, without requiring user correction.

**Architecture:** Apify supplies Reel metadata, the research extractor supplies sourced POI identity/coordinates/country, and a new Mapbox Geocoding v6 reverse adapter verifies the coordinate’s ISO country. A database trust stamp hides every pre-fix mention until it is reverified. The Saved Reels organizer replaces stale links with verified research places only after the ISO codes match; Mapbox GL renders those coordinates. Search Box no longer determines or overwrites Saved Reel countries.

**Tech Stack:** Python 3.14, Pydantic v2, httpx, FastAPI background jobs, Supabase/Postgres, Mapbox Geocoding v6, Mapbox GL JS 3.24, pytest, Vitest.

## Global Constraints

- Accept researched places from any country; Japan, China, and South Korea are the mandatory first acceptance matrix.
- A Reel place is visible only with a verbatim evidence quote, non-placeholder research URL, valid sourced lat/lng, confidence, and an uppercase ISO 3166-1 alpha-2 country code plus nonblank country name.
- Research proposes a candidate; deterministic validators and Mapbox reverse-country verification decide whether it may appear.
- Use Mapbox Geocoding v6 `/search/geocode/v6/reverse` with `types=country`, `limit=1`, `language=en`, and `permanent=true` for stored verification outcomes.
- Do not use Google Maps or Google Places.
- Do not use Mapbox Search Box to determine or overwrite Saved Reel place coordinates/country. Existing restaurant/category-search behavior is outside this plan.
- Cache original research output before verification. Never cache Search Box-mutated place data.
- Country mismatch fails closed. Provider outage automatically retries once, then fails the organize item without displaying an unverified pin. A later Organize action must create a fresh attempt.
- Preserve token sanitization: never log Mapbox request URLs or propagate URL-bearing httpx exception text.
- Preserve auth, RLS, durable organizer jobs, quota semantics, frontend tray grouping, and existing SSE termination.
- No visual polish, correction UI, new dependency, or disputed-boundary worldview policy.
- Only mentions stamped `mapbox-country-v1` may reach `saved_reel_cards` or server-side place authorization. Pre-fix mentions are hidden immediately; reprocessing replaces the Reel's mention set.
- Place reuse requires the same country, exact canonical name, and less than 500 metres distance. Same-name branches farther apart remain distinct; broader alias normalization stays in the trip pipeline.
- Preserve every unrelated dirty file. Stage only the files named by each task.
- GitHub Project #1 is still the task-state source of truth, but the current `gh` token lacks `read:project`. Before implementation, run `gh auth refresh -s project`, reload Project #1 by node/owner, and activate the matching card with Owner `Both` because this locks a shared research/backend/frontend contract.

---

### Task 0: Lock provider feasibility before implementation

**Evidence already collected 2026-07-18:** The configured backend token returned HTTP 200 and `JP`, `CN`, and `KR` for Tokyo, Shanghai, and Seoul from Geocoding v6 reverse requests using `types=country`, `limit=1`, `language=en`, and `permanent=true`. The live response places the country under `features[0].properties.context.country` even when `feature_type` is `address`; adapter fixtures must reproduce that real shape.

- [x] Permanent Geocoding v6 account eligibility confirmed for the acceptance matrix.
- [x] Real response shape inspected without logging the token or request URL.
- [ ] During implementation, rerun this sanitized preflight before changing persistence. Any 401/403/422 blocks the write path; never fall back to Search Box.

---

### Task 1: Add structured researched-country fields to `PlaceResult`

**Files:**
- Modify: `backend/models/place.py:13-38`
- Modify: `backend/genagents/place_extractor.py:27-69`
- Test: `backend/models/test_place.py`
- Test: `backend/genagents/test_place_extractor.py`

**Interfaces:**
- Produces: `PlaceResult.country_code: str | None` and `PlaceResult.country_name: str | None`.
- Invariant: both country fields are set together or both are `None`; code is uppercase two-letter ISO shape; name is nonblank.
- Produces: `EXTRACTOR_VERSION = "2026-07-18.3"`, which makes poisoned older cache rows ineligible, adds the pre-research input guardrail, and caps provider-verification fan-out.
- `keep_valid_places` admits candidates only when the source URL is real and the country pair is complete, so incomplete research never enters the organizer cache.
- Consumers: Task 4’s `_ground_place` requires both fields.

- [ ] **Step 1: Write failing model-contract tests**

Add to `backend/models/test_place.py`:

```python
import pytest
from pydantic import ValidationError

from models.place import PlaceResult


def _place(**overrides):
    values = {
        "name": "Harry Potter Cafe",
        "category": "restaurant",
        "lat": 35.67311,
        "lng": 139.73625,
        "confidence": 0.8,
        "evidence_quote": "Harry Potter Cafe",
        "source_url": "https://hpcafe.jp/",
    }
    values.update(overrides)
    return PlaceResult(**values)


def test_place_result_country_pair_defaults_to_none():
    place = _place()
    assert place.country_code is None
    assert place.country_name is None


def test_place_result_accepts_researched_iso_country_pair():
    place = _place(country_code="JP", country_name="Japan")
    assert (place.country_code, place.country_name) == ("JP", "Japan")


@pytest.mark.parametrize("overrides", [
    {"country_code": "JP", "country_name": None},
    {"country_code": None, "country_name": "Japan"},
    {"country_code": "jpn", "country_name": "Japan"},
    {"country_code": "jp", "country_name": "Japan"},
    {"country_code": "JP", "country_name": "   "},
])
def test_place_result_rejects_invalid_country_pair(overrides):
    with pytest.raises(ValidationError):
        _place(**overrides)
```

- [ ] **Step 2: Run the model tests and confirm red**

Run from `C:\Github\astrail\backend`:

```powershell
uv run pytest models/test_place.py -q -k country
```

Expected: FAIL because `PlaceResult` has no country fields or pair validator.

- [ ] **Step 3: Implement the country contract**

In `backend/models/place.py`, change the Pydantic import and extend `PlaceResult`:

```python
from pydantic import BaseModel, ConfigDict, Field, model_validator


class PlaceResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    category: str = Field(description="restaurant | hotel | attraction | transport | other")
    lat: float | None = Field(default=None, ge=-90.0, le=90.0)
    lng: float | None = Field(default=None, ge=-180.0, le=180.0)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_quote: str
    source_type: PlaceSourceType = "reel_extracted"
    source_url: str | None = None
    city_or_region_guess: str | None = None
    formatted_address: str | None = None
    name_local: str | None = Field(
        default=None,
        description="Venue name in the local language/script, verbatim from the caption "
                    "(e.g. '東京タワー'), or None when the caption has no local-script name. "
                    "Used to ground coords in providers that index POIs in the local script.",
    )
    country_code: str | None = Field(default=None, pattern=r"^[A-Z]{2}$")
    country_name: str | None = None

    @model_validator(mode="after")
    def country_fields_are_a_pair(self) -> "PlaceResult":
        if (self.country_code is None) != (self.country_name is None):
            raise ValueError("country_code and country_name must be set together")
        if self.country_name is not None and not self.country_name.strip():
            raise ValueError("country_name must be nonblank")
        return self
```

- [ ] **Step 4: Run the model tests and confirm green**

Run:

```powershell
uv run pytest models/test_place.py -q
```

Expected: PASS.

- [ ] **Step 5: Write failing extractor-contract tests**

Add to `backend/genagents/test_place_extractor.py`:

```python
from genagents.place_extractor import EXTRACTOR_VERSION, PLACE_EXTRACTOR_INSTRUCTIONS


def test_extractor_version_invalidates_pre_country_cache_rows():
    assert EXTRACTOR_VERSION == "2026-07-18.3"


def test_extractor_requires_researched_country_pair():
    assert "country_code" in PLACE_EXTRACTOR_INSTRUCTIONS
    assert "country_name" in PLACE_EXTRACTOR_INSTRUCTIONS
    assert "ISO 3166-1 alpha-2" in PLACE_EXTRACTOR_INSTRUCTIONS
    assert "web_search" in PLACE_EXTRACTOR_INSTRUCTIONS


@pytest.mark.parametrize("overrides", [
    {"country_code": None, "country_name": None},
    {"source_url": None},
    {"source_url": "https://example.com/place"},
])
def test_keep_valid_places_rejects_incomplete_research_contract(overrides):
    reel = _reel()
    place = _place(
        "Cafe Alpha",
        "📍Cafe Alpha",
        url="https://tabelog.com/tokyo/123",
    ).model_copy(update={"country_code": "JP", "country_name": "Japan", **overrides})

    assert keep_valid_places([place], reel) == []
```

- [ ] **Step 6: Run the extractor tests and confirm red**

Run:

```powershell
uv run pytest genagents/test_place_extractor.py -q -k "country or version"
```

Expected: FAIL because the version and prompt have not changed.

- [ ] **Step 7: Require sourced country output and bump the cache version**

In `backend/genagents/place_extractor.py`, set:

```python
EXTRACTOR_VERSION = "2026-07-18.3"
```

Add these fields to the Step 4 output list immediately after `lat / lng`:

```text
  - country_code: uppercase ISO 3166-1 alpha-2 code for the researched coordinates.
    ALWAYS include it; set it to null only when the country cannot be established from
    web_search evidence. Never infer it from the venue name alone.
  - country_name: researched country display name matching country_code. ALWAYS include
    it; set it to null when country_code is null.
```

Add these rules:

```text
  - country_code and country_name must be supported by the same web_search evidence used
    for the coordinates. Never mix a venue from one country with coordinates from another.
  - If coordinates or their country cannot be verified after two searches, drop the place.
```

Extend `keep_valid_places` to reject a candidate when `source_url` is missing/placeholder or when the validated country pair is absent. Update the existing `_place` test helper's known-good default to a real non-reserved source URL plus `JP`/`Japan`, then preserve the existing focused tests for null coordinates, non-verbatim evidence, placeholder URLs, and local names.

Strengthen `test_live_single_reel_extraction` so every returned place must also have a real source URL and a complete uppercase country pair. This is the live quality check for the LLM prompt; the pure filter remains the deterministic safety boundary.

- [ ] **Step 8: Run focused and full extractor tests**

Run:

```powershell
uv run pytest models/test_place.py genagents/test_place_extractor.py -q
uv run pytest genagents/test_place_extractor.py -q -m live
```

Expected: offline tests pass. Run the live extractor test when credentials/network are available and record its output; it must not be replaced by prompt-string assertions alone.

- [ ] **Step 9: Commit the research contract when commit approval exists**

```powershell
git add backend/models/place.py backend/models/test_place.py backend/genagents/place_extractor.py backend/genagents/test_place_extractor.py
git commit -m "fix(extractor): emit sourced country for global reel places"
```

---

### Task 2: Add a token-safe Mapbox Geocoding v6 reverse-country adapter

**Files:**
- Modify: `backend/models/geocode.py`
- Create: `backend/geocode/mapbox_reverse.py`
- Create: `backend/geocode/test_mapbox_reverse.py`

**Interfaces:**
- Produces: `CountryResult(country_code: str, country_name: str)`.
- Produces: `parse_reverse_country_response(data: object) -> CountryResult | None`; `None` means only a valid empty feature collection, while malformed data raises a sanitized `RuntimeError`.
- Produces: `reverse_country(lat: float, lng: float, *, token: str, client: httpx.AsyncClient | None = None, timeout_s: int = 15, retry_delay_s: float = 0.25) -> CountryResult | None`.
- Retry contract: one retry for network errors and HTTP 5xx; no retry for 4xx; all raised messages are token/URL safe.
- Consumer: Task 4 injects `reverse_country` into `_ground_place`.

- [ ] **Step 1: Write the complete failing adapter test file**

Create `backend/geocode/test_mapbox_reverse.py`:

```python
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from geocode.mapbox_reverse import parse_reverse_country_response, reverse_country


_JP_RESPONSE = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature",
        "properties": {
            "feature_type": "address",
            "name": "5-3-1, Akasaka",
            "context": {
                "country": {
                    "name": "Japan",
                    "country_code": "JP",
                    "country_code_alpha_3": "JPN",
                }
            },
        },
    }],
}


def test_parse_reverse_country_response_reads_country_context():
    result = parse_reverse_country_response(_JP_RESPONSE)
    assert result is not None
    assert result.country_code == "JP"
    assert result.country_name == "Japan"


def test_parse_reverse_country_response_accepts_top_level_country_feature():
    payload = {
        "features": [{
            "properties": {
                "feature_type": "country",
                "name": "South Korea",
                "country_code": "KR",
            }
        }]
    }
    result = parse_reverse_country_response(payload)
    assert result is not None
    assert (result.country_code, result.country_name) == ("KR", "South Korea")


@pytest.mark.parametrize("payload", [
    None,
    {},
    {"features": "bad"},
    {"features": [None]},
    {"features": [{"properties": {"name": "Japan"}}]},
    {"features": [{"properties": {"country_code": "JPN", "name": "Japan"}}]},
])
def test_parse_reverse_country_response_rejects_malformed_shapes(payload):
    with pytest.raises(RuntimeError, match="malformed"):
        parse_reverse_country_response(payload)


def test_parse_reverse_country_response_returns_none_only_for_valid_empty_features():
    assert parse_reverse_country_response({"type": "FeatureCollection", "features": []}) is None


@pytest.mark.asyncio
async def test_reverse_country_sends_permanent_country_only_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    query = parse_qs(urlparse(seen["url"]).query)

    assert query["latitude"] == ["35.67311"]
    assert query["longitude"] == ["139.73625"]
    assert query["types"] == ["country"]
    assert query["limit"] == ["1"]
    assert query["language"] == ["en"]
    assert query["permanent"] == ["true"]
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_retries_one_network_failure():
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectTimeout("contains SECRET URL", request=request)
        return httpx.Response(200, json=_JP_RESPONSE)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await reverse_country(35.67311, 139.73625, token="SECRET", client=client, retry_delay_s=0)
    assert attempts == 2
    assert result is not None and result.country_code == "JP"
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_4xx_is_sanitized_and_not_retried():
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(403)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError) as exc_info:
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    assert attempts == 1
    assert "403" in str(exc_info.value)
    assert "SECRET" not in str(exc_info.value)
    assert "http" not in str(exc_info.value).lower()
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_invalid_json_is_sanitized_provider_failure():
    client = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda _request: httpx.Response(200, content=b"not-json")
    ))
    with pytest.raises(RuntimeError, match="invalid response") as exc_info:
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client)
    assert "SECRET" not in str(exc_info.value)
    assert "http" not in str(exc_info.value).lower()
    await client.aclose()


@pytest.mark.asyncio
async def test_reverse_country_retries_then_raises_on_5xx():
    attempts = 0
    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(503)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RuntimeError, match="503"):
        await reverse_country(35.67311, 139.73625, token="SECRET", client=client, retry_delay_s=0)
    assert attempts == 2
    await client.aclose()
```

- [ ] **Step 2: Run the adapter tests and confirm red**

Run:

```powershell
uv run pytest geocode/test_mapbox_reverse.py -q
```

Expected: FAIL because the module and `CountryResult` do not exist.

- [ ] **Step 3: Add the country result model**

Append to `backend/models/geocode.py`:

```python
class CountryResult(BaseModel):
    """Normalized administrative country returned by Mapbox reverse geocoding."""

    country_code: str = Field(pattern=r"^[A-Z]{2}$")
    country_name: str = Field(min_length=1)
```

- [ ] **Step 4: Implement the complete reverse-country adapter**

Create `backend/geocode/mapbox_reverse.py`:

```python
"""Mapbox Geocoding v6 reverse-country verification with permanent storage mode."""
from __future__ import annotations

import asyncio

import httpx
from pydantic import ValidationError

from models.geocode import CountryResult

_REVERSE_URL = "https://api.mapbox.com/search/geocode/v6/reverse"


def parse_reverse_country_response(data: object) -> CountryResult | None:
    if not isinstance(data, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    features = data.get("features")
    if not isinstance(features, list):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    if not features:
        return None
    if not isinstance(features[0], dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    properties = features[0].get("properties")
    if not isinstance(properties, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    context = properties.get("context")
    country = context.get("country") if isinstance(context, dict) else None
    if not isinstance(country, dict):
        country = properties if properties.get("feature_type") == "country" else None
    if not isinstance(country, dict):
        raise RuntimeError("Mapbox reverse-country returned malformed data")
    code = country.get("country_code") or country.get("short_code")
    name = country.get("name")
    if isinstance(code, str):
        code = code.upper()
    try:
        return CountryResult(country_code=code, country_name=name)
    except ValidationError:
        raise RuntimeError("Mapbox reverse-country returned malformed data") from None


async def reverse_country(
    lat: float,
    lng: float,
    *,
    token: str,
    client: httpx.AsyncClient | None = None,
    timeout_s: int = 15,
    retry_delay_s: float = 0.25,
) -> CountryResult | None:
    params = {
        "longitude": lng,
        "latitude": lat,
        "types": "country",
        "limit": 1,
        "language": "en",
        "permanent": "true",
        "access_token": token,
    }
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout_s)
    try:
        for attempt in range(2):
            try:
                response = await http.get(_REVERSE_URL, params=params, timeout=timeout_s)
            except httpx.RequestError as exc:
                if attempt == 0:
                    await asyncio.sleep(retry_delay_s)
                    continue
                raise RuntimeError(
                    f"Mapbox reverse-country error: {type(exc).__name__}"
                ) from None
            if response.status_code // 100 == 5 and attempt == 0:
                await asyncio.sleep(retry_delay_s)
                continue
            if response.status_code // 100 != 2:
                raise RuntimeError(
                    f"Mapbox reverse-country failed: HTTP {response.status_code}"
                )
            try:
                payload = response.json()
            except ValueError:
                raise RuntimeError("Mapbox reverse-country returned invalid response") from None
            return parse_reverse_country_response(payload)
        raise RuntimeError("Mapbox reverse-country failed after retry")
    finally:
        if owns_client:
            await http.aclose()
```

- [ ] **Step 5: Run focused geocode tests**

Run:

```powershell
uv run pytest geocode/test_mapbox_reverse.py geocode/test_mapbox_forward.py -q
```

Expected: PASS; existing Search Box adapter behavior remains unchanged for its other callers.

- [ ] **Step 6: Commit the reverse-country adapter when commit approval exists**

```powershell
git add backend/models/geocode.py backend/geocode/mapbox_reverse.py backend/geocode/test_mapbox_reverse.py
git commit -m "feat(geocode): verify researched coordinates by country"
```

---

### Task 3: Add a database trust gate and terminal-job reprocessing

**Files:**
- Create: `supabase/migrations/20260718190000_saved_reels_location_verification.sql`
- Create: `supabase/migrations/20260718190100_saved_reels_location_cleanup.sql`
- Modify: `supabase/tests/007_saved_reels_organize.sql`

**Interfaces:**
- Adds nullable `reel_place_mentions.verification_version`; only `mapbox-country-v1` rows are trusted.
- `saved_reel_cards` and the `places_select_when_used_in_own_saved_reel` policy ignore unstamped legacy mentions immediately after migration.
- Replaces the all-time organize-job uniqueness constraint with a partial unique index for `pending`/`processing` jobs, preserving concurrent idempotency while allowing a new attempt after terminal success/failure.
- Commits the verified-only read path independently before cleanup runs.
- Cleanup invalidates `reel_cache.extracted_places` for cache rows with legacy organizer mentions and deletes only those unstamped mentions. It preserves `places`, graph rows, and product references because an unstamped mention does not prove legacy-organizer provenance.

- [ ] **Step 1: Write failing pgTAP regressions**

Extend `supabase/tests/007_saved_reels_organize.sql` with fixtures proving:

1. a legacy mention with `verification_version IS NULL` is absent from `saved_reel_cards.places`;
2. a `mapbox-country-v1` mention is present with its country and coordinates;
3. two terminal jobs may share `(user_id, idempotency_key)`;
4. two active jobs may not share `(user_id, idempotency_key)`;
5. an unstamped mention does not satisfy the authenticated `places` select policy.
6. legacy linked cache payloads are invalidated and unstamped mentions are removed;
7. pre-existing/shared canonical places, graph nodes/edges, product references, and trusted mentions remain intact;
8. the cleanup function is idempotent, service-role-only, and cannot roll back the earlier trust-gate migration.

Run from `C:\Github\astrail`:

```powershell
supabase test db
```

Expected: FAIL because the trust-stamp column and active-only unique index do not exist.

- [ ] **Step 2: Add the trust-gate migration**

Create `supabase/migrations/20260718190000_saved_reels_location_verification.sql`:

```sql
alter table public.reel_place_mentions
  add column verification_version text;

alter table public.reel_place_mentions
  add constraint reel_place_mentions_verification_version_nonblank_check
  check (verification_version is null or btrim(verification_version) <> '');

alter table public.organize_jobs
  drop constraint organize_jobs_user_idempotency_key_unique;

create unique index organize_jobs_active_idempotency_key_unique
  on public.organize_jobs (user_id, idempotency_key)
  where status in ('pending', 'processing');
```

Then recreate `places_select_when_used_in_own_saved_reel` so its mention subquery requires:

```sql
reel_place_mentions.verification_version = 'mapbox-country-v1'
```

Copy the existing `saved_reel_cards` view definition verbatim and change only its mention join:

```sql
left join public.reel_place_mentions
  on reel_place_mentions.reel_cache_id = saved_reels.reel_cache_id
 and reel_place_mentions.verification_version = 'mapbox-country-v1'
```

Keep the existing view ownership/grants/security comments from the source migration. Do not hand-edit unrelated schema.

Keep `20260718190000` additive and trust-gate-only. Create `20260718190100` with `private.cleanup_unverified_saved_reel_locations()`, a `security definer` PL/pgSQL function using `set search_path = ''`, revoked from `public`, `anon`, and `authenticated`, and granted only to `service_role`. Call it once from the second migration and retain it as an idempotent operator seam.

The cleanup may touch only `reel_cache` and unstamped `reel_place_mentions`:

```sql
update public.reel_cache
set extracted_places = '[]'::jsonb,
    extractor_version = 'invalidated-searchbox-2026-07-18'
where exists (
  select 1 from public.reel_place_mentions
  where reel_place_mentions.reel_cache_id = reel_cache.id
    and reel_place_mentions.verification_version is null
);

delete from public.reel_place_mentions
where verification_version is null;

```

Before those statements, take `SHARE ROW EXCLUSIVE` locks on only `reel_cache` and `reel_place_mentions` with a short transaction-local lock timeout. After cleanup succeeds, set `verification_version NOT NULL` in the same second-migration transaction so old code cannot recreate an unstamped link. Never infer place ownership/provenance from an unstamped mention and never delete shared place/graph/product data in this repair. The separate migration boundary guarantees verified-only reads remain active even if cleanup ever fails.

- [ ] **Step 3: Reset local Supabase and run pgTAP**

```powershell
supabase db reset
supabase test db
```

Expected: PASS. Existing Mexico/United States mentions are hidden by the view; their Saved-Reels cache payloads and unstamped links are removed, while unproven shared place/graph rows remain unavailable through the Saved Reels trust path.

- [ ] **Step 4: Commit the trust gate when commit approval exists**

```powershell
git add supabase/migrations/20260718190000_saved_reels_location_verification.sql supabase/migrations/20260718190100_saved_reels_location_cleanup.sql supabase/tests/007_saved_reels_organize.sql
git commit -m "fix(db): expose only verified reel places"
```

---

### Task 4: Make the organizer research-authoritative and fail closed on country mismatch

**Files:**
- Modify: `backend/organizer.py:129-165,270-304`
- Modify: `backend/test_saved_reels_organize.py`

**Interfaces:**
- `_ground_place(place, *, verify_country=reverse_country) -> dict | None`.
- Defines `LOCATION_VERIFICATION_VERSION = "mapbox-country-v1"` as the persistence/read trust contract shared with Task 3.
- Success output remains `{ "place": PlaceResult, "country_code": str, "country_name": str }`, preserving `_persist_place` and safe-view contracts.
- Mapbox empty country or ISO mismatch returns `None` for that candidate.
- Mapbox provider exceptions propagate to the existing item failure path after the adapter’s automatic retry.
- Uncached flow writes original extracted candidates to `reel_cache` before verification; cached flow re-verifies cached research candidates without Apify.
- `_persist_place` reuses a same-name/same-country row only when it is under 500 metres away; farther branches retain their researched coordinates in a new row.
- Every completed verification attempt deletes the cache row's old mention links before inserting only `mapbox-country-v1` links. A crash can hide places, but can never expose an unverified one.
- `create_organize_job` deduplicates only initializing/pending/processing jobs. A terminal job may be followed by a fresh cache-backed attempt.
- `authorize_place_ids` accepts only `mapbox-country-v1` mentions.

- [ ] **Step 1: Replace the obsolete Search Box grounding test with failing global-verification tests**

In `backend/test_saved_reels_organize.py`, remove `test_ground_place_uses_location_hint_without_fake_proximity` and add:

```python
@pytest.mark.asyncio
@pytest.mark.parametrize("code,name,lat,lng", [
    ("JP", "Japan", 35.67311, 139.73625),
    ("CN", "China", 31.2304, 121.4737),
    ("KR", "South Korea", 37.5665, 126.9780),
])
async def test_ground_place_accepts_matching_research_and_reverse_country(
    monkeypatch, code, name, lat, lng
):
    from models.geocode import CountryResult

    calls = []

    async def verify(got_lat, got_lng, **kwargs):
        calls.append((got_lat, got_lng, kwargs))
        return CountryResult(country_code=code, country_name=name)

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Verified place",
        category="attraction",
        lat=lat,
        lng=lng,
        confidence=0.8,
        evidence_quote="Verified place",
        source_url="https://www.gotokyo.org/en/spot/1749/index.html",
        country_code=code,
        country_name=name,
    )

    result = await _ground_place(place, verify_country=verify)

    assert result == {
        "place": place,
        "country_code": code,
        "country_name": name,
    }
    assert calls == [(lat, lng, {"token": "test-token"})]


@pytest.mark.asyncio
async def test_ground_place_rejects_country_mismatch(monkeypatch):
    from models.geocode import CountryResult

    async def verify(*_args, **_kwargs):
        return CountryResult(country_code="MX", country_name="Mexico")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    )

    assert await _ground_place(place, verify_country=verify) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("updates", [
    {"country_code": None, "country_name": None},
    {"lat": None},
    {"lng": None},
    {"source_url": None},
    {"source_url": "https://example.com/place"},
])
async def test_ground_place_rejects_incomplete_research_without_mapbox_call(monkeypatch, updates):
    called = False

    async def verify(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("verification must not run")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    ).model_copy(update=updates)

    assert await _ground_place(place, verify_country=verify) is None
    assert called is False


@pytest.mark.asyncio
async def test_ground_place_propagates_provider_outage_after_adapter_retry(monkeypatch):
    async def verify(*_args, **_kwargs):
        raise RuntimeError("Mapbox reverse-country failed: HTTP 503")

    monkeypatch.setenv("MAPBOX_SECRET_TOKEN", "test-token")
    place = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    )

    with pytest.raises(RuntimeError, match="reverse-country"):
        await _ground_place(place, verify_country=verify)
```

- [ ] **Step 2: Run the grounding tests and confirm red**

Run:

```powershell
uv run pytest test_saved_reels_organize.py -q -k ground_place
```

Expected: FAIL because `_ground_place` still calls Search Box and has no injected reverse verifier.

- [ ] **Step 3: Replace `_ground_place` with the research-authoritative verifier**

Extend the existing extractor import in `backend/organizer.py`:

```python
from genagents.place_extractor import EXTRACTOR_VERSION, is_placeholder_url
```

Replace `backend/organizer.py::_ground_place` with:

```python
async def _ground_place(place: PlaceResult, *, verify_country=None) -> dict | None:
    token = os.environ.get("MAPBOX_SECRET_TOKEN")
    if not token:
        raise RuntimeError("Mapbox reverse-country verification is unavailable")
    if (
        place.lat is None
        or place.lng is None
        or is_placeholder_url(place.source_url)
        or not place.country_code
        or not place.country_name
    ):
        return None
    if verify_country is None:
        from geocode.mapbox_reverse import reverse_country
        verify_country = reverse_country
    country = await verify_country(place.lat, place.lng, token=token)
    if country is None or country.country_code != place.country_code:
        return None
    verified_place = place.model_copy(update={"country_name": country.country_name})
    return {
        "place": verified_place,
        "country_code": country.country_code,
        "country_name": country.country_name,
    }
```

- [ ] **Step 4: Run the grounding tests and confirm green**

Run:

```powershell
uv run pytest test_saved_reels_organize.py -q -k ground_place
```

Expected: PASS for JP/CN/KR, mismatch, incomplete research, and outage cases.

- [ ] **Step 5: Write failing trust-link, reprocessing, and coordinate-preservation regressions**

Add focused tests to `backend/test_saved_reels_organize.py` for these previously uncovered paths:

```text
create_organize_job
  active identical job   -> returns same id
  terminal identical job -> creates a new id

_persist_place
  same name + country + <500m -> reuse existing id
  same name + country + >500m -> insert new row with researched coordinates

run_organize_job
  legacy MX mention + verified JP output
    -> old cache mention set is deleted
    -> only JP link remains
    -> new link has verification_version=mapbox-country-v1
  JP/CN/KR fixtures
    -> each survives grounding, place persistence, mention linking, and safe country output

authorize_place_ids
  unstamped mention -> PermissionError
  mapbox-country-v1 mention -> authorized
```

The poisoned-fixture test is **CRITICAL**: seed the exact cache with a legacy Mexico/United States mention, run a new verified Japan attempt, and assert there is no stale link left. This proves the current user-visible bug is repaired, not only future data.

- [ ] **Step 6: Run the new regressions and confirm red**

```powershell
uv run pytest test_saved_reels_organize.py -q -k "terminal or verification_version or poisoned or same_name or country_matrix or authorize"
```

Expected: FAIL because terminal jobs are still permanent idempotency hits, mentions have no trust stamp/replacement, and place reuse ignores distance.

- [ ] **Step 7: Implement active-only idempotency, trusted mention replacement, and distance-gated reuse**

In `backend/organizer.py`:

1. Define `LOCATION_VERIFICATION_VERSION = "mapbox-country-v1"` beside imports and import `haversine_m` plus `DEFAULT_DISTANCE_M` from the existing pipeline helpers.
2. In both normal and unique-race branches of `create_organize_job`, search only rows whose status is `pending` or `processing`. Task 3's partial unique index remains the concurrency backstop. Terminal rows are history, not idempotency blockers.
3. In `_persist_place`, select all exact-name/exact-country candidates with `id,lat,lng`; reuse only a row whose haversine distance from the researched coordinates is below `DEFAULT_DISTANCE_M`. Insert the original research coordinates when every match is farther away.
4. Add `verification_version: LOCATION_VERIFICATION_VERSION` to `_persist_mention`.
5. In `authorize_place_ids`, select/filter `verification_version` and reject every unstamped mention.
6. After `cache_id` and `grounded` are known, delete all `reel_place_mentions` for that cache id before linking the current verified results. Do this even when `grounded` is empty so a previous trusted set cannot survive a newer failed-closed result. Never delete the global `places` rows.

The replacement sequence is intentionally fail-closed: a database failure may temporarily show no places, but every link that can appear is verified. Do not add a best-effort catch that preserves stale links.

- [ ] **Step 8: Run trust and persistence tests green**

```powershell
uv run pytest test_saved_reels_organize.py -q -k "terminal or verification_version or poisoned or same_name or country_matrix or authorize"
```

Expected: PASS. A second terminal attempt is possible, legacy links are gone/hidden, JP/CN/KR reach persistence, and same-name distant branches keep distinct pins.

- [ ] **Step 9: Write a failing cache-provenance regression**

Add to `backend/test_saved_reels_organize.py`:

```python
@pytest.mark.asyncio
async def test_uncached_reel_caches_research_output_before_country_verification(monkeypatch):
    client = _Client({
        "organize_jobs": [{"id": "job-1", "user_id": "user-a", "status": "pending"}],
        "organize_job_items": [{
            "id": "item-1", "job_id": "job-1", "user_id": "user-a",
            "saved_reel_id": "r1", "status": "queued",
        }],
        "saved_reels": [{
            "id": "r1", "user_id": "user-a",
            "normalized_url": "https://www.instagram.com/reel/A",
            "analysis_status": "queued",
        }],
        "rpc:reserve_daily_reel_analysis": 1,
    })
    research = PlaceResult(
        name="Harry Potter Cafe",
        category="restaurant",
        lat=35.67311,
        lng=139.73625,
        confidence=0.8,
        evidence_quote="Harry Potter Cafe",
        source_url="https://hpcafe.jp/",
        country_code="JP",
        country_name="Japan",
    )
    cached = []

    async def scrape(*_args, **_kwargs):
        return object()

    async def extract(_reel):
        return [research]

    async def cache(_client, _url, _reel, places, _version):
        cached.extend(places)

    async def verify(place):
        assert cached == [research]
        return {"place": place, "country_code": "JP", "country_name": "Japan"}

    monkeypatch.setattr("organizer.get_cached_places", lambda *_args, **_kwargs: None)
    monkeypatch.setattr("organizer.cache_places", cache)

    await run_organize_job(
        "job-1", "user-a", client=client, scrape=scrape, extract=extract, ground=verify
    )

    assert cached[0].lat == 35.67311
    assert cached[0].country_code == "JP"
```

- [ ] **Step 10: Run the cache regression and confirm red**

Run:

```powershell
uv run pytest test_saved_reels_organize.py -q -k cache_provenance
```

Expected: FAIL because the current organizer grounds before caching and caches grounded/mutated places.

- [ ] **Step 11: Move cache write-through before verification**

In the uncached branch of `run_organize_job`, replace the extract/ground/cache sequence with:

```python
places = await _maybe_await(extract(scraped))
# reel_cache.extracted_places is research provenance, not provider-mutated output.
# Persist it before verification so a provider retry never spends Apify/research again.
await cache_places(
    client,
    reel["normalized_url"],
    scraped,
    places,
    EXTRACTOR_VERSION,
)
quota_state = "consumed"
await client.table("organize_job_items").update({
    "analysis_charge_state": quota_state,
    "analysis_consumed_at": _now(),
}).eq("id", item["id"]).eq("user_id", user_id).execute()
grounded = [
    resolved
    for place in places
    if (resolved := await _maybe_await(ground(place))) is not None
]
```

Delete the old call that passed `[r["place"] for r in grounded]` into `cache_places`.

- [ ] **Step 12: Run all organizer tests**

Run:

```powershell
uv run pytest test_saved_reels_organize.py -q
```

Expected: PASS, including quota refund, cache-hit, ownership, SSE, global country verification, and cache provenance.

- [ ] **Step 13: Commit the organizer boundary when commit approval exists**

```powershell
git add backend/organizer.py backend/test_saved_reels_organize.py
git commit -m "fix(organizer): verify global reel countries without search overwrite"
```

---

### Task 5: Prove country trays remain provider-agnostic

**Files:**
- Modify: `frontend/lib/reels/__tests__/organize.test.ts`
- Production frontend changes are limited to verified Mapbox rendering, current-action isolation, failure/empty retry states, Reel attribution, authenticated safe-view loading, and the Mapbox Standard/3D CSP requirement.

**Interfaces:**
- Confirms existing `groupPlacesByCountry(places) -> CountryTray[]` consumes backend-verified `country_code`/`country_name` and does not call or infer Mapbox naming.

- [ ] **Step 1: Add the multi-country regression**

Add to `frontend/lib/reels/__tests__/organize.test.ts`:

```typescript
it('renders backend-verified China, Japan, and Korea trays without renaming them', () => {
  const groups = groupPlacesByCountry([
    place({ place_id: 'jp', name: 'Tokyo place', country_code: 'JP', country_name: 'Japan' }),
    place({ place_id: 'cn', name: 'Shanghai place', country_code: 'CN', country_name: 'China' }),
    place({ place_id: 'kr', name: 'Seoul place', country_code: 'KR', country_name: 'South Korea' }),
  ])

  expect(groups.map(({ country_code, country_name }) => ({ country_code, country_name }))).toEqual([
    { country_code: 'CN', country_name: 'China' },
    { country_code: 'JP', country_name: 'Japan' },
    { country_code: 'KR', country_name: 'South Korea' },
  ])
})
```

- [ ] **Step 2: Run the focused frontend test**

Run from `C:\Github\astrail\frontend`:

```powershell
npm test -- lib/reels/__tests__/organize.test.ts
```

Expected: PASS without production changes, proving the frontend was not the bug source.

- [ ] **Step 3: Commit the regression when commit approval exists**

```powershell
git add frontend/lib/reels/__tests__/organize.test.ts
git commit -m "test(reels): cover verified multi-country trays"
```

---

### Task 6: Full verification and real localhost acceptance

**Implementation amendments discovered by adversarial review and live acceptance:**

- The organizer treats `initializing`, `pending`, and `processing` as active. A partially initialized job becomes replaceable after 120 seconds; startup deletes stale initializing rows and immediately requeues all processing rows because the accepted MVP deployment has one backend process.
- A lost stale-delete race reuses only a live active winner and never returns an obsolete job id.
- Reusing a nearby place refreshes `country_code`, `country`, and Mapbox's canonical `country_name`; an old poisoned display label cannot re-enter the tray.
- Public Reel text passes a serial deterministic Agents SDK input guardrail before the web-search-enabled extractor. This trust-boundary change bumps `EXTRACTOR_VERSION` to `2026-07-18.3`.
- `countries_found` was removed from the API/TypeScript status contract because no durable value existed; tray summaries are derived only from verified safe-view places.
- The frontend now renders exact verified coordinates through Mapbox GL, restricts trays to Reels submitted in the current organize action, preserves Reel attribution into the brief, and returns failed or zero-verified-place jobs to a visible retryable inbox state.
- The protected inbox query waits for Supabase auth hydration. Production CSP includes `'wasm-unsafe-eval'`, as required for Mapbox Standard/3D, while retaining the existing worker/connect restrictions.

**Files:**
- Verification only; no planned production changes.
- Evidence may be recorded in the existing execution receipt of `docs/superpowers/plans/2026-07-18-saved-reels-localhost-mvp.md` only after the run succeeds.

**Interfaces:**
- Proves Mapbox permanent reverse geocoding is enabled for the account.
- Proves JP/CN/KR administrative verification independently of Search Box POI coverage.
- Proves the trust-gate migration immediately hides legacy wrong-country links.
- Proves exact Reel uncached/cached behavior, terminal reprocessing, trusted mention replacement, and Japan tray/pin.

- [ ] **Step 1: Re-read the live board after authentication is repaired**

Run:

```powershell
gh auth refresh -s project
gh project item-list 1 --owner MalaysiaKaki --format json --limit 60
```

If the owner alias still fails, query project node `PVT_kwDOEXlARc4BanGs` through `gh api graphql`, read its actual owner, then rerun `gh project item-list` with that owner. Do not use `gh issue list` as a substitute.

Expected: live Project #1 items load; matching card and Owner/Status are known.

- [ ] **Step 2: Run backend focused and full suites**

Run from `C:\Github\astrail\backend`:

```powershell
uv run pytest models/test_place.py genagents/test_place_extractor.py geocode/test_mapbox_reverse.py geocode/test_mapbox_forward.py test_saved_reels_organize.py -q
uv run pytest -q
uv run pytest evals/ -q
```

Expected: all pass; the frozen offline eval anchor remains unchanged.

- [ ] **Step 3: Run Supabase and frontend gates**

Run from `C:\Github\astrail`:

```powershell
supabase test db
```

Run from `C:\Github\astrail\frontend`:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: pgTAP, Vitest, TypeScript, and production build all pass.

- [ ] **Step 4: Live-check permanent reverse geocoding for the country matrix**

With `MAPBOX_SECRET_TOKEN` loaded, run from `C:\Github\astrail\backend`:

```powershell
uv run python -c "import asyncio,os; from geocode.mapbox_reverse import reverse_country; r=asyncio.run(reverse_country(35.67311,139.73625,token=os.environ['MAPBOX_SECRET_TOKEN'])); print('JP',r.country_code if r else None)"
uv run python -c "import asyncio,os; from geocode.mapbox_reverse import reverse_country; r=asyncio.run(reverse_country(31.2304,121.4737,token=os.environ['MAPBOX_SECRET_TOKEN'])); print('CN',r.country_code if r else None)"
uv run python -c "import asyncio,os; from geocode.mapbox_reverse import reverse_country; r=asyncio.run(reverse_country(37.5665,126.9780,token=os.environ['MAPBOX_SECRET_TOKEN'])); print('KR',r.country_code if r else None)"
```

Expected safe output:

```text
JP JP
CN CN
KR KR
```

Any 401/403/422 blocks shipping until token scope/billing enables permanent Geocoding v6. Do not fall back to temporary Search Box data for persistence.

- [ ] **Step 5: Run the exact Reel through localhost**

Start Supabase, backend, and frontend using their existing local commands. In the authenticated app:

1. Save `https://www.instagram.com/reel/DYGH3jFBZHz`.
2. Before reprocessing, confirm the trust-gate migration has hidden every unstamped legacy Mexico/United States mention from `saved_reel_cards`, then confirm the separate cleanup migration invalidated its old cache payload and deleted the unstamped link while preserving unproven shared place/graph rows for a later provenance audit.
3. Organize it once under extractor version `2026-07-18.3` and verification version `mapbox-country-v1`.
4. Confirm the tray says `Japan` and the Harry Potter Cafe pin is in Tokyo.
5. Inspect the organizer job, mention, and `saved_reel_cards` row: `verification_version=mapbox-country-v1`, `country_code=JP`, `country_name=Japan`, Tokyo coordinates, research source/evidence present, and no stale MX/US link.
6. Organize the same Reel again after the first job is terminal; assert a new job id is returned.
7. Confirm the second run uses cached research output and makes no Apify/extraction call while still running Mapbox country verification.

Expected: no Mexico/United States tray, no stale mention reuse, no distant same-name place-row reuse, and no raw payload/transcript exposed.

- [ ] **Step 6: Run required reviews and browser QA**

- Run `astrail-reviewer` over the whole diff with adversarial cases: Mapbox `MX`, empty result, 503 retry exhaustion, missing research country, poisoned old cache, and same-name place in another country.
- Run gstack `/review` over the complete diff.
- Run gstack `/qa` against the localhost Saved Reel -> Organize -> globe -> tray flow and capture evidence of the Japan tray and Tokyo pin.
- Fix every blocking/material finding and rerun the affected gates.

- [ ] **Step 7: Update task state only after all gates pass**

Move the live Project #1 card to `Done` with Owner `Both`, then mirror the completion into EMDEE. Do not update the board from stale issue numbers.

---

## NOT in scope

- **Automatic research repair loop:** add only when measured mismatch rate shows valid places are being dropped; current behavior fails closed.
- **Mapbox Boundaries/offline point-in-polygon:** add when reverse-geocoding latency/cost becomes material at scale.
- **Search Box POI enrichment:** reintroduce for Saved Reels only after geographic coverage and permanent-storage rights are explicitly proven; it may enrich but never establish country authority.
- **Disputed-boundary worldviews:** define a product policy before supporting disputed coordinates.
- **Manual correction UI:** excluded by product decision.
- **Visual polish:** deferred to the existing next-day design pass.
- **Broader retention cleanup:** rows never linked by the Saved Reels organizer are outside this incident and need a separate audited policy.

## Rollback

Revert task commits in reverse order, but do not remove the database trust filter while unstamped mentions exist. Do not lower `EXTRACTOR_VERSION` back to `2026-07-06.1` unless the cache has been audited or invalidated, because that would reactivate Search Box-overwritten payloads. Rolling back application code before the trust-gate migration is safe and fail-closed: existing unstamped links remain hidden.

## Reviewed execution and coverage map

```text
UNTRUSTED INPUT                         TRUSTED READ PATH
================                       =================
Reel -> Apify -> research extractor
                   |
                   +-- invalid evidence/source/country --------> DROP
                   |
                   +-- valid candidate
                           |
                           +-> cache original research payload
                           |
                           +-> Mapbox reverse country
                                  |-- empty/mismatch -----------> DROP
                                  |-- malformed/outage ---------> FAIL ATTEMPT
                                  `-- matching ISO
                                         |
                                         +-> distance-gated place reuse
                                         +-> replace mention set
                                         +-> stamp mapbox-country-v1
                                                    |
                                                    +-> saved_reel_cards
                                                    +-> authorize_place_ids
                                                    +-> frontend tray + Mapbox GL pin

Legacy unstamped mention ---------------------------------------> HIDDEN
Terminal organize job -> next Organize action ------------------> NEW JOB
```

### What already exists

- `backend/genagents/place_extractor.py` already performs web search, evidence-substring checks, coordinate bounds, and placeholder-URL filtering; this plan extends that contract instead of adding a second research agent.
- `backend/pipeline/cache.py` already provides version-gated extraction cache hits; this plan preserves it and corrects what gets cached.
- `backend/pipeline/geo.py` and `backend/pipeline/dedup.py` already define haversine distance and the 500-metre gate; organizer persistence reuses those constants/helpers.
- `backend/organizer.py` already owns durable jobs, quota accounting, safe event payloads, mentions, and canonical place writes; the fix stays at this authority boundary.
- `saved_reel_cards` already projects backend country fields, and `groupPlacesByCountry` already groups them; no production frontend rewrite is needed.
- Mapbox GL JS already renders arbitrary coordinates. Search Box remains available only for unrelated restaurant discovery.

### Test coverage diagram

```text
CODE PATH COVERAGE PLANNED
==========================
[Task 1] PlaceResult + keep_valid_places
  [TEST] valid JP pair, absent optional pair for old callers
  [TEST] half-pair/lowercase/blank-name rejection
  [TEST] missing/placeholder source and missing country dropped
  [EVAL] live extractor emits sourced URL + country pair

[Task 2] reverse_country
  [TEST] real address-context response -> JP
  [TEST] top-level country response -> KR
  [TEST] valid empty -> None
  [TEST] malformed schema/JSON -> sanitized failure
  [TEST] network/5xx retry once; 4xx no retry; token never leaks

[Task 3] SQL trust gate
  [TEST] unstamped legacy mention hidden
  [TEST] stamped mention visible and authorized
  [TEST] active duplicate job blocked; terminal duplicate allowed

[Task 4] organizer
  [TEST] JP/CN/KR verify and persist end-to-end
  [TEST] MX mismatch and incomplete research fail closed
  [TEST] provider failure marks attempt failed
  [TEST] poisoned mention set replaced
  [TEST] same-name near row reused; far branch inserted
  [TEST] research payload cached before verification
  [TEST] second terminal attempt uses cache

[Task 5/6] user flow [E2E]
  [TEST] backend countries group unchanged in frontend
  [E2E] exact Reel -> Japan tray -> Tokyo pin
  [E2E] second terminal job -> cache hit -> fresh country check
```

### Failure modes

| New path | Production failure | Planned test | Handling | User outcome |
|---|---|---|---|---|
| Research contract | Model omits/guesses country or source | Task 1 offline + live | deterministic drop | no unverified pin |
| Reverse adapter | timeout/503 | Task 2 | one retry, sanitized failure | organize attempt fails safely |
| Reverse adapter | invalid JSON/schema | Task 2 | provider failure, never geographic miss | “could not verify,” not “place absent” |
| Country comparison | research JP, Mapbox MX | Task 4 | candidate rejection | no wrong-country tray |
| Trust migration | legacy MX/US Search Box position remains visible | Task 3/4 | trust gate commits first; cleanup invalidates cache and removes only the unstamped link, preserving unproven shared place/graph rows | wrong tray disappears without unsafe canonical deletion |
| Place reuse | same name, distant branch | Task 4 | 500m gate inserts distinct row | researched pin retained |
| Job retry | prior terminal idempotency hit | Task 3/4 | active-only uniqueness creates new job | user can retry without correction |
| Mention replacement | database write fails after delete | full organizer suite | fail closed; no unverified links | temporary missing place, never wrong pin |

No silent untested failure remains in the planned trust path.

### Parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| Research contract | `backend/models/`, `backend/genagents/` | Task 0 |
| Reverse adapter | `backend/geocode/`, `backend/models/` | Task 0 |
| Trust migration | `supabase/migrations/`, `supabase/tests/` | Task 0 |
| Frontend regression | `frontend/lib/reels/` | locked contract only |
| Organizer integration | `backend/organizer.py`, organizer tests | research + adapter + migration |
| Localhost acceptance | all runtime surfaces | every lane merged |

- Lane A: Task 1 research contract.
- Lane B: Task 2 reverse adapter.
- Lane C: Task 3 database trust gate.
- Lane D: Task 5 frontend regression.
- Integration lane: merge A + B + C, then Task 4 organizer integration.
- Acceptance lane: merge D and the integration lane, then Task 6.

Conflict flag: Tasks 1 and 2 both touch `backend/models/` but disjoint files. Assign explicit file ownership and integrate before Task 4. All other initial lanes have disjoint write scopes.

### Engineering review completion

- Step 0 Scope Challenge: scope expanded only where required to repair already-poisoned data and permit reprocessing.
- Architecture Review: 5 issues found and resolved in the plan.
- Code Quality Review: 3 issues found and resolved in the plan.
- Test Review: diagram produced; 2 missing integration paths added.
- Performance Review: 0 blocking issues; one reverse request per candidate is acceptable for the MVP, with batch/offline containment deferred until measured.
- NOT in scope: written above.
- What already exists: written above.
- TODOS.md updates: 0; deferrals are feature-specific and retained in this plan.
- Failure modes: 0 remaining critical gaps.
- Outside voice: ran twice through an independent Codex subagent; all ten material findings were folded into this reviewed plan.
- Parallelization: 4 initial parallel lanes, 2 sequential integration/acceptance lanes.
- Lake Score: 10/10 findings took the complete trust-preserving option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | ISSUES RESOLVED | 10 findings, 10/10 folded into plan |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 10 issues, 0 critical gaps remain |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Visual polish explicitly deferred |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** Caught stale trusted links/storage, terminal idempotency, same-name coordinate reuse, malformed-response classification, source validation, cache-history wording, missing persistence coverage, and design/migration contradictions; the plan now addresses each.

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED — ready to implement after Project #1 authentication is refreshed.
