# Mapbox Coord Authority via Local-Language Name (`name_local`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Mapbox the coord authority for the 3D-map display by letting the extractor emit a verbatim **local-language** venue name (`name_local`), then geocoding the best available name in the language matching its **script**, so Mapbox grounds POIs it only indexes in the local script (Japan today). Falls back to the LLM web-search coords on a miss — never loses a place.

**Architecture:** The Mapbox `/forward` client (`geocode/mapbox_forward.py`) already takes `language`, `country`, and `proximity` as parameters. This change adds (1) `name_local` on `PlaceResult`, (2) a small **pure policy** module `geocode/policy.py` that decides *(query, language)* per place by detecting the query's script, and (3) caller wiring in `capture.main()` that supplies the Japan beta geo-policy (country + proximity). The extractor's `name` stays as-is (most-recognizable form, often English for famous venues); `name_local` carries the caption's local-script form so it can be queried in `ja`.

```
extractor → PlaceResult{ name (canonical, often EN), name_local (local script | None) }
                         │
        geocode_query(place)  ← pure policy (geocode/policy.py)
          query = name_local or name
          language = query_language(query)   # JP script → "ja", else "en"
                         ▼
   forward_geocode(query, language=…, country="jp", proximity=Tokyo)  ← already parameterized
                         │  hit → Mapbox coords (authority)   miss → None
                         ▼
              apply_geocode(place, geo)  ← keeps LLM coords on miss
```

**Why script-detection (not a flat caller constant):** `name` may be English (famous venues canonicalize to English) OR Japanese (creator-tagged in Japanese). A flat `language="ja"` would mis-query an English name; a flat `"en"` would mis-query a Japanese name and miss a groundable POI. Picking language from the *script of the actual query string* is correct for either. For the Japan beta, "contains kana/kanji → `ja`, else `en`" is unambiguous. (The Han `ja`/`zh` ambiguity only matters when China is added — see Scalability.)

**Tech Stack:** Python 3.14, Pydantic v2, openai-agents 0.17.7, httpx (mocked in tests), pytest. No new dependencies.

**Scalability:** US/UK cost nothing — English names query in `en` through the existing path (subject to Mapbox Search Box coverage for that geography). Non-Latin locales (Korea, Thailand) reuse the same `name_local` + script-detection mechanism; only `query_language`'s script→language map and the caller's `country`/`proximity` policy grow — additive, never a geocode-layer rewrite. The one known limit: Han characters are shared by Japanese and Chinese, so when China is added, `query_language` must disambiguate via the trip destination (documented extension point; NOT built now — YAGNI).

## Global Constraints

- **Geocode transport stays parameterized; policy lives outside it.** `forward_geocode` keeps `language`/`country`/`proximity_lng_lat` as params. The query/language decision lives in `geocode/policy.py` (pure), and the trip's `country`/`proximity` are caller policy in `capture.main()` (beta Japan constants). No product/geo policy inside the HTTP module. (The module's `"jp"`/`"en"`/`TOKYO` *defaults* stay as documentation, but the caller passes values explicitly so scaling never relies on them.)
- **Guardrail #1 (no hallucinated places) + #11 (untrusted content):** `name_local`, when set, MUST be a verbatim substring of `caption + location_name` (same rule + same case-folded `.lower()` check as `evidence_quote`). The extractor never translates/transliterates; `keep_valid_places` defensively nulls a non-verbatim `name_local` (keeps the place — it still geocodes via `name`).
- **Agents SDK strict schema:** every output property is required-on-the-wire even when nullable, so the prompt instructs the model to **always include `name_local`, set it to `null` when absent** (not omit it).
- **Never lose a place:** a geocode miss (or absent local name) keeps the LLM coords via `apply_geocode` — unchanged.
- **Token safety:** unchanged. `forward_geocode`'s sanitized errors stand; new capture log lines print only coords/place names, never the token.
- **Offline suite + `#16` eval stay green.** `name_local` is optional, default `None`. `run_eval` loads and scores `places` but **ignores unknown keys**, so #16 stays green; produced places now carry `name_local: null` (an additive optional key) — the only change to the serialized shape, not a contract break. All new tests are offline (pure / mocked transport / injected producers).
- **Schema parity (guardrail #4):** `PlaceResult` is NOT mirrored in `frontend/lib/trip/backend-types.ts` yet (it mirrors only SSE + request/response), so adding `name_local` creates no TS drift now. Flag for Zhi Hao when place types are built — NOT a task here.
- **Import-time invariant:** unchanged — `import capture` / `geocode.mapbox_forward` / `geocode.policy` need no key, no SDK, no network.

---

### Task 1: `name_local` contract + extractor emission

**Files:**
- Modify: `backend/models/place.py` (`PlaceResult`)
- Modify: `backend/genagents/place_extractor.py` (prompt + `keep_valid_places`)
- Test: `backend/genagents/test_place_extractor.py`

**Interfaces:**
- Produces: `PlaceResult.name_local: str | None` (default `None`); `keep_valid_places` nulls a non-verbatim `name_local`. `CanonicalPlace` inherits the field.

- [ ] **Step 1: Write the failing tests**

Add to `backend/genagents/test_place_extractor.py`:

```python
from genagents.place_extractor import keep_valid_places
from models.place import PlaceResult
from models.reel import ReelData


def _reel_with(caption):
    return ReelData(reel_url="manual:x", caption=caption, capture_status="MANUAL")


def test_place_result_name_local_defaults_none():
    p = PlaceResult(name="X", category="other", confidence=0.5, evidence_quote="X")
    assert p.name_local is None


def test_keep_valid_places_keeps_verbatim_name_local():
    # famous venue canonicalized to English `name`, Japanese form present in the caption
    reel = _reel_with("最高の夜景 📍東京タワー at night")
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.95,
                    evidence_quote="📍東京タワー", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1 and kept[0].name_local == "東京タワー"


def test_keep_valid_places_nulls_non_verbatim_name_local_but_keeps_place():
    reel = _reel_with("amazing tower 📍Tokyo Tower")          # no Japanese in caption
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.9,
                    evidence_quote="📍Tokyo Tower", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")                    # not in the caption
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1 and kept[0].name_local is None       # place kept, bad local name dropped
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest genagents/test_place_extractor.py -q -k name_local`
Expected: FAIL — `PlaceResult` has no `name_local`; `keep_valid_places` doesn't null it.

- [ ] **Step 3: Add the field to `PlaceResult`**

In `backend/models/place.py`, add to `PlaceResult` after `formatted_address`:

```python
    name_local: str | None = Field(
        default=None,
        description="Venue name in the local language/script, verbatim from the caption "
                    "(e.g. '東京タワー'), or None when the caption has no local-script name. "
                    "Used to ground coords in providers that index POIs in the local script.",
    )
```

- [ ] **Step 4: Emit `name_local` from the extractor + validate it verbatim**

In `backend/genagents/place_extractor.py`, add to `PLACE_EXTRACTOR_INSTRUCTIONS` Step-4 per-place field list (after the `name:` line — leave the `name:` guidance unchanged):

```
  - name_local: the venue's name in the LOCAL language/script EXACTLY as written in the \
    caption or location tag (e.g. "東京タワー") — a verbatim substring, character for \
    character. ALWAYS include this field; set it to null when the caption has no \
    local-script name (e.g. an English-only caption). NEVER translate or transliterate it \
    yourself. It grounds coordinates in map providers that index POIs in the local script.
```

Add to the `Rules:` block:

```
  - name_local, when non-null, MUST be a verbatim substring of the caption/location tag \
    (like evidence_quote). If there is no local-script name in the text, set it to null.
```

Update `keep_valid_places`:

```python
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
        if p.name_local and p.name_local.lower() not in corpus:
            p = p.model_copy(update={"name_local": None})  # drop only the unreliable local name
        kept.append(p)
    return kept
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest genagents/test_place_extractor.py -q`
Expected: PASS — new tests + all pre-existing extractor tests (unchanged behavior for places without `name_local`).

- [ ] **Step 6: Confirm the offline suite + eval are unaffected**

Run: `cd backend && uv run pytest -q` (all pass, 1 live skip)
Run: `cd backend && uv run python -m evals.run_eval --subject baseline && uv run python -m evals.run_eval --subject pipeline` (both `OVERALL: PASS` — `name_local` is optional; eval ignores unknown keys)

- [ ] **Step 7: Commit**

```bash
cd backend && git add models/place.py genagents/place_extractor.py genagents/test_place_extractor.py
git commit -m "feat(extractor): emit verbatim name_local for local-language geocoding"
```

---

### Task 2: Script-aware geocode policy + capture wiring + LLM↔Mapbox delta logging

**Files:**
- Create: `backend/geocode/policy.py`
- Test: `backend/geocode/test_policy.py`
- Modify: `backend/capture.py` (resolver + beta geo-policy constants + delta logging)
- Test: `backend/test_capture.py`, `backend/geocode/test_mapbox_forward.py` (add a `language=ja` request assertion)

**Interfaces:**
- Produces (in `geocode/policy.py`): `query_language(query: str) -> str` (`"ja"` if the query contains Japanese kana/kanji, else `"en"`); `geocode_query(place: PlaceResult) -> tuple[str, str]` returning `(query, language)`.
- `capture` gains module constants `BETA_COUNTRY = "jp"`, `BETA_PROXIMITY = TOKYO`, and a `_haversine_m` helper; the live resolver uses `geocode_query` + passes `country`/`proximity_lng_lat` explicitly.

- [ ] **Step 1: Write the failing tests**

Create `backend/geocode/test_policy.py`:

```python
"""Geocode query policy — pure, offline, no key, no network."""
from geocode.policy import geocode_query, query_language
from models.place import PlaceResult


def _place(**kw):
    base = dict(name="Tokyo Tower", category="attraction", confidence=0.9, evidence_quote="x")
    base.update(kw)
    return PlaceResult(**base)


def test_query_language_japanese_scripts():
    assert query_language("東京タワー") == "ja"   # kanji
    assert query_language("サンドイッチ") == "ja"   # katakana
    assert query_language("ひらがな") == "ja"       # hiragana


def test_query_language_latin_is_english():
    assert query_language("Tokyo Tower") == "en"
    assert query_language("SANDO LAB TOKYO") == "en"


def test_geocode_query_prefers_local_name_in_detected_language():
    # English canonical name, Japanese name_local → query the Japanese form in ja
    q, lang = geocode_query(_place(name="Tokyo Tower", name_local="東京タワー"))
    assert q == "東京タワー" and lang == "ja"


def test_geocode_query_japanese_name_without_local_still_ja():
    # name itself is Japanese, name_local absent → still detected as ja (not mis-queried as en)
    q, lang = geocode_query(_place(name="サンドイッチ ポポー", name_local=None))
    assert q == "サンドイッチ ポポー" and lang == "ja"


def test_geocode_query_english_name_without_local_is_english():
    q, lang = geocode_query(_place(name="Harry Potter Cafe", name_local=None))
    assert q == "Harry Potter Cafe" and lang == "en"
```

Add to `backend/geocode/test_mapbox_forward.py` (a Japanese-language request assertion — mirror the existing `test_forward_geocode_request_params`):

```python
async def test_forward_geocode_passes_language_ja():
    import httpx
    from urllib.parse import parse_qs, urlparse
    from geocode.mapbox_forward import forward_geocode, TOKYO
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        return httpx.Response(200, json={"type": "FeatureCollection", "features": []})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await forward_geocode("東京タワー", token="TKN", language="ja",
                          country="jp", proximity_lng_lat=TOKYO, client=client)
    qs = parse_qs(urlparse(seen["url"]).query)
    assert qs.get("language") == ["ja"]
    assert qs.get("country") == ["jp"]
    assert qs.get("q") == ["東京タワー"]
    assert qs.get("proximity") == ["139.7671,35.6812"]
```

Add to `backend/test_capture.py`:

```python
async def test_run_capture_logs_llm_to_mapbox_delta_when_moved(capsys):
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [_place("Cafe")]  # LLM coords lat=35.6, lng=139.7

    async def resolve(place):
        return place.model_copy(update={"lat": 35.71, "lng": 139.80})  # Mapbox moves it

    await capture.run_capture(["u1"], token="T", scrape=scrape, extract=extract, resolve=resolve)
    err = capsys.readouterr().err
    assert "llm-coords" in err and "35.6000,139.7000" in err and "Δ" in err
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest geocode/test_policy.py geocode/test_mapbox_forward.py test_capture.py -q -k "query or language_ja or delta"`
Expected: FAIL — `geocode.policy` doesn't exist; capture prints no `llm-coords` line. (The `language=ja` test passes already, since `forward_geocode` accepts the param — keep it as a regression guard.)

- [ ] **Step 3: Create the pure policy module**

Create `backend/geocode/policy.py`:

```python
"""Geocode query policy — choose (query, language) for a place. Pure, offline, no key.

Mapbox indexes Japan POIs in Japanese, so a Japanese-script query must be sent with
language="ja"; a Latin query uses "en". The query string itself may be either script
(a famous venue's `name` is often English; a creator tag is often Japanese), so the
language is detected from the chosen query's SCRIPT, not assumed from a constant.
"""
from __future__ import annotations

from models.place import PlaceResult


def _has_japanese(text: str) -> bool:
    """True if `text` contains Hiragana/Katakana (U+3040-30FF) or CJK ideographs
    (U+4E00-9FFF, i.e. Kanji)."""
    return any(
        0x3040 <= ord(ch) <= 0x30FF or 0x4E00 <= ord(ch) <= 0x9FFF
        for ch in text
    )


def query_language(query: str) -> str:
    """Pick the Mapbox query language from the query's script.

    Beta: Japanese script → "ja" (Mapbox indexes Japan POIs in Japanese); otherwise "en".
    SCALING: extend per added locale. Han (U+4E00-9FFF) is shared by Japanese and Chinese,
    so when China is added this must disambiguate via the trip destination, not script alone.
    """
    return "ja" if _has_japanese(query) else "en"


def geocode_query(place: PlaceResult) -> tuple[str, str]:
    """Choose (query, language) for geocoding `place`: prefer the verbatim local-script
    name_local over the (possibly English) name, then detect the language from that query."""
    query = place.name_local or place.name
    return query, query_language(query)
```

- [ ] **Step 4: Run the policy + forward tests**

Run: `cd backend && uv run pytest geocode/test_policy.py geocode/test_mapbox_forward.py -q`
Expected: PASS.

- [ ] **Step 5: Wire the policy + beta geo-constants + delta logging into capture**

In `backend/capture.py`, import `TOKYO` and add beta constants near `EVALS_FIXTURES`/`CAPTURES_DEFAULT`:

```python
from geocode.mapbox_forward import TOKYO

# Beta geo-policy: Astrail v1 targets Japan → bias proximity to Tokyo and filter to JP.
# The query LANGUAGE is per-place (geocode.policy detects it from the query's script).
# SCALING (multi-country): derive country + proximity from the trip destination
# (see docs/superpowers/plans/2026-06-29-mapbox-coord-authority-name-local.md "Scalability").
BETA_COUNTRY = "jp"
BETA_PROXIMITY = TOKYO
```

Add the haversine diagnostic helper:

```python
def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres between (lat, lng) points — for the LLM↔Mapbox
    coord-delta diagnostic only."""
    import math
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat, dlng = lat2 - lat1, lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))
```

In the per-place loop of `_collect_reel`, after the `print(_format_place(...))` line, emit the delta when Mapbox moved the coord:

```python
        moved = (grounded.lat, grounded.lng) != original_coords
        places.append(grounded)
        print(_format_place(grounded, coords_src="mapbox" if moved else "llm"))
        if moved and None not in original_coords and grounded.lat is not None and grounded.lng is not None:
            d = _haversine_m(original_coords, (grounded.lat, grounded.lng))
            print(f"           llm-coords: {original_coords[0]:.4f},{original_coords[1]:.4f}"
                  f"  (Δ {d:.0f} m from mapbox)", file=sys.stderr)
```

Update the live resolver in `main()` (lazy-import `geocode_query`):

```python
    if mapbox_token:
        from geocode.mapbox_forward import apply_geocode, forward_geocode
        from geocode.policy import geocode_query

        async def _resolve(place: PlaceResult) -> PlaceResult:
            query, language = geocode_query(place)
            geo = await forward_geocode(query, token=mapbox_token, language=language,
                                        country=BETA_COUNTRY, proximity_lng_lat=BETA_PROXIMITY)
            return apply_geocode(place, geo)
        resolve = _resolve
```

- [ ] **Step 6: Run the capture tests + full suite + eval + import invariant**

Run: `cd backend && uv run pytest test_capture.py geocode -q` (all pass)
Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import capture, geocode.policy, geocode.mapbox_forward; print('keyless import OK')"`
Run: `cd backend && uv run pytest -q` (all pass, 1 live skip)
Run: `cd backend && uv run python -m evals.run_eval --subject baseline && uv run python -m evals.run_eval --subject pipeline` (both `OVERALL: PASS`)

- [ ] **Step 7: Commit**

```bash
cd backend && git add geocode/policy.py geocode/test_policy.py geocode/mapbox_forward.py geocode/test_mapbox_forward.py capture.py test_capture.py
git commit -m "feat(geocode): script-aware local-language grounding (Mapbox authority for Japan)"
```

---

## Manual verification (human, optional — live)

Hits OpenAI + Mapbox; needs `OPENAI_API_KEY` + `MAPBOX_SECRET_TOKEN`. Confirms Mapbox grounds a Japanese-named place AND shows the LLM↔Mapbox delta you wanted before trusting the switch:

```bash
cd backend && uv run python -m capture --reels "https://www.instagram.com/reel/DXwcVVliX3B/" --out-dir captures
```
Expect: places whose caption carried a Japanese name now show `(coords=mapbox)` + a `llm-coords: … (Δ N m from mapbox)` line; English-only names stay `coords=llm`.

## NOT in scope / deferred

- **Forcing `name`=English** (approach A) — rejected; we keep `name` flexible and detect script (decision B, 2026-06-29).
- **Multi-country language derivation / Han `ja`-vs-`zh` disambiguation** — the beta detects Japanese script; China/Korea extend `query_language` + caller `country`/`proximity` when added (YAGNI).
- **TS `PlaceResult` mirror** — no mirror exists yet; flag for Zhi Hao when place types land.
- **Reverse-geocoding to rescue dropped (null-coord) places** — unchanged; Mapbox refines surviving coords only.

## Rollback / risk

- **Blast radius:** one optional model field, one extractor prompt addition + a defensive null, one new pure 30-line module, and a capture resolver/diagnostic tweak. No change to `forward_geocode`'s HTTP path, token safety, or `apply_geocode`. Revert = drop the two commits.
- **Risk:** Low. `name_local` is optional/defaulted → existing data/fixtures/eval unaffected; non-Japan and English-only places behave exactly as today. The only live-behavior change: a Japanese-script query now goes to Mapbox in `ja` (grounds, or misses → LLM coords as before). The delta logging is stderr-only and offline-tested.
