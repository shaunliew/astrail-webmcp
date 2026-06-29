# Mapbox Coord Authority via Local-Language Name (`name_local`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Mapbox the coord authority for the 3D-map display by letting the extractor emit a verbatim **local-language** venue name (`name_local`), then geocoding that name in its own language so Mapbox grounds POIs it only indexes in the local script (Japan today). Falls back to the English name / LLM coords when no local name exists — never loses a place.

**Architecture:** The Mapbox `/forward` client (`geocode/mapbox_forward.py`) is already country-agnostic — it takes `language` and `country` as parameters. This change adds the missing input (a local-script name on `PlaceResult`) and a small, pure query-policy function that decides *(query, language)* per place. The trip's "local language / country" is a single caller-side policy in `capture.main()` — a Japan constant for the beta, with a documented extension point for multi-country. Nothing in the geocode layer hardcodes Japanese.

```
extractor → PlaceResult{ name (EN), name_local (local script | None) }
                         │
                geocode_query_for(place, local_language="ja")   ← pure policy
                         │  name_local? → (name_local, "ja")   else → (name, "en")
                         ▼
        forward_geocode(query, language=…, country="jp")  ← already generic
                         │  hit → Mapbox coords (authority)   miss → None
                         ▼
                  apply_geocode(place, geo)  ← keeps LLM coords on miss
```

**Tech Stack:** Python 3.14, Pydantic v2, openai-agents 0.17.7, httpx (mocked in tests), pytest. No new dependencies.

**Scalability (why this is generic, not Japan-only):** Scaling to US/UK costs **nothing** — English names resolve through the existing English path; `name_local` is simply absent. Scaling to non-Latin scripts (Korea, China, Thailand) reuses the *same* `name_local` mechanism; only the caller-side `local_language`/`country` policy changes (one place), never the geocode module or the model. Adding a country is additive, not a rewrite. We do **not** build the multi-country derivation now (YAGNI) — the beta sets a Japan constant and leaves a documented extension point.

## Global Constraints

- **No hardcoded language inside the geocode module.** `forward_geocode` stays parameterized; the local-language choice lives only in the caller policy (`capture.main`) as a clearly-marked beta constant.
- **Guardrail #1 (no hallucinated places) + #11 (untrusted content):** `name_local`, when set, MUST be a verbatim substring of `caption + location_name` (same rule as `evidence_quote`). The extractor is instructed never to translate/transliterate; `keep_valid_places` defensively nulls a non-verbatim `name_local` (keeps the place — it still geocodes via the English name).
- **Never lose a place:** a geocode miss (or absent `name_local`) keeps the existing LLM coords via `apply_geocode` — unchanged behavior.
- **Token safety (existing invariant):** no secret in any raised exception, log line, or print. `forward_geocode`'s sanitized errors are unchanged; new log lines print only coords/place names, never the token.
- **Offline default suite stays credential-free and green; the `#16` eval stays green.** `name_local` is an optional field defaulting to `None`; `run_eval` reads only `capture_status` on reels, so the eval is unaffected. All new tests are offline (pure functions / mocked transport / injected producers).
- **Schema parity (guardrail #4):** `PlaceResult` is NOT currently mirrored in `frontend/lib/trip/backend-types.ts` (it mirrors only SSE + request/response). Adding `name_local` therefore creates **no** TS drift now. Flagged for Zhi Hao to include when the place-rendering types are built — NOT a task here (inventing a full TS `PlaceResult` mirror is frontend scope).
- **Import-time invariant:** unchanged — `import capture` / `import geocode.mapbox_forward` need no key, no SDK, no network.

---

### Task 1: Add the `name_local` contract + extractor emission

**Files:**
- Modify: `backend/models/place.py` (`PlaceResult`)
- Modify: `backend/genagents/place_extractor.py` (prompt + `keep_valid_places`)
- Test: `backend/models/test_place.py` (create if absent) and `backend/genagents/test_place_extractor.py`

**Interfaces:**
- Produces: `PlaceResult.name_local: str | None` (default `None`); `keep_valid_places` nulls a non-verbatim `name_local`. `CanonicalPlace` inherits the field automatically.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing tests**

Add to `backend/genagents/test_place_extractor.py`:

```python
from genagents.place_extractor import keep_valid_places
from models.place import PlaceResult
from models.reel import ReelData


def _reel_with(caption):
    return ReelData(reel_url="manual:x", caption=caption, capture_status="MANUAL")


def test_keep_valid_places_keeps_verbatim_name_local():
    reel = _reel_with("最高の夜景 📍東京タワー at night")
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.95,
                    evidence_quote="📍東京タワー", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1
    assert kept[0].name_local == "東京タワー"   # present verbatim in caption → kept


def test_keep_valid_places_nulls_non_verbatim_name_local_but_keeps_place():
    reel = _reel_with("amazing tower 📍Tokyo Tower")
    p = PlaceResult(name="Tokyo Tower", category="attraction", confidence=0.9,
                    evidence_quote="📍Tokyo Tower", lat=35.6586, lng=139.7454,
                    name_local="東京タワー")  # NOT in the (English) caption
    kept = keep_valid_places([p], reel)
    assert len(kept) == 1                       # place kept (valid via name + evidence)
    assert kept[0].name_local is None           # unreliable local name dropped


def test_place_result_name_local_defaults_none():
    p = PlaceResult(name="X", category="other", confidence=0.5, evidence_quote="X")
    assert p.name_local is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest genagents/test_place_extractor.py -q -k name_local`
Expected: FAIL — `PlaceResult` has no `name_local` (TypeError/validation), and `keep_valid_places` doesn't null it.

- [ ] **Step 3: Add the field to `PlaceResult`**

In `backend/models/place.py`, add to `PlaceResult` (after `formatted_address`):

```python
    name_local: str | None = Field(
        default=None,
        description="Venue name in the local language/script, verbatim from the caption "
                    "(e.g. '東京タワー'). Used to ground coords in providers that index POIs "
                    "in the local script. None when the caption gives only an English/romaji name.",
    )
```

- [ ] **Step 4: Emit `name_local` from the extractor + validate it verbatim**

In `backend/genagents/place_extractor.py`, add to the `PLACE_EXTRACTOR_INSTRUCTIONS` Step-4 per-place field list (after the `name:` line):

```
  - name_local: the venue's name in the LOCAL language/script EXACTLY as written in the \
    caption or location tag (e.g. "東京タワー") — a verbatim substring, character for \
    character. null when the caption gives only an English/romanized name. NEVER translate \
    or transliterate it yourself. This grounds coordinates in map providers that index POIs \
    in the local script.
```

And add to the `Rules:` block:

```
  - name_local, when set, MUST be a verbatim substring of the caption/location tag (like \
    evidence_quote). If there is no local-script name in the text, set it to null.
```

Then update `keep_valid_places` to defensively null a non-verbatim `name_local` (keep the place):

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
Expected: PASS — the 3 new tests plus all pre-existing extractor tests (unchanged behavior for places without `name_local`).

- [ ] **Step 6: Confirm the offline suite + eval are unaffected**

Run: `cd backend && uv run pytest -q` (all pass, 1 live skip)
Run: `cd backend && uv run python -m evals.run_eval --subject baseline && uv run python -m evals.run_eval --subject pipeline` (both `OVERALL: PASS` — `name_local` is optional, eval reads only `capture_status`).

- [ ] **Step 7: Commit**

```bash
cd backend && git add models/place.py genagents/place_extractor.py genagents/test_place_extractor.py
git commit -m "feat(extractor): emit verbatim name_local for local-language geocoding"
```

---

### Task 2: Geocode query policy + capture wiring + LLM↔Mapbox delta logging

**Files:**
- Modify: `backend/geocode/mapbox_forward.py` (add `geocode_query_for`)
- Modify: `backend/capture.py` (resolver uses the policy + beta constants; log both coords)
- Test: `backend/geocode/test_mapbox_forward.py`, `backend/test_capture.py`

**Interfaces:**
- Consumes: `PlaceResult.name_local` (Task 1).
- Produces: `geocode_query_for(place: PlaceResult, *, local_language: str) -> tuple[str, str]` — pure; returns `(query, language)`. `capture` gains module constants `BETA_LOCAL_LANGUAGE = "ja"`, `BETA_COUNTRY = "jp"`, and a `_haversine_m` helper for the diagnostic.

- [ ] **Step 1: Write the failing tests**

Add to `backend/geocode/test_mapbox_forward.py`:

```python
from geocode.mapbox_forward import geocode_query_for
from models.place import PlaceResult


def _place(**kw):
    base = dict(name="Tokyo Tower", category="attraction", confidence=0.9, evidence_quote="x")
    base.update(kw)
    return PlaceResult(**base)


def test_geocode_query_for_prefers_local_name_in_local_language():
    q, lang = geocode_query_for(_place(name_local="東京タワー"), local_language="ja")
    assert q == "東京タワー" and lang == "ja"


def test_geocode_query_for_falls_back_to_english_name():
    q, lang = geocode_query_for(_place(name_local=None), local_language="ja")
    assert q == "Tokyo Tower" and lang == "en"
```

Add to `backend/test_capture.py`:

```python
async def test_run_capture_logs_llm_to_mapbox_delta_when_moved(capsys):
    # when the resolver moves coords, capture prints the original LLM coord + Δ meters
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [_place("Cafe")]  # lat=35.6, lng=139.7 (LLM)

    async def resolve(place):
        return place.model_copy(update={"lat": 35.71, "lng": 139.80})  # Mapbox moves it

    await capture.run_capture(["u1"], token="T", scrape=scrape, extract=extract, resolve=resolve)
    err = capsys.readouterr().err
    assert "llm-coords" in err
    assert "35.6000,139.7000" in err   # original LLM coord surfaced for comparison
    assert "Δ" in err and "m" in err   # a delta in meters is shown
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest geocode/test_mapbox_forward.py test_capture.py -q -k "geocode_query_for or delta"`
Expected: FAIL — `geocode_query_for` doesn't exist; capture prints no `llm-coords` line.

- [ ] **Step 3: Add the pure query policy to the geocode module**

In `backend/geocode/mapbox_forward.py` (it already imports `PlaceResult`), add:

```python
def geocode_query_for(place: PlaceResult, *, local_language: str) -> tuple[str, str]:
    """Choose (query, language) for geocoding `place`.

    Prefer the verbatim local-language name queried in `local_language`, so Mapbox can
    ground POIs it indexes only in the local script (e.g. Japan); otherwise query the
    English `name` in English. This module stays country-agnostic — the trip's local
    language is the caller's policy (see capture.main / BETA_LOCAL_LANGUAGE).
    """
    if place.name_local:
        return place.name_local, local_language
    return place.name, "en"
```

- [ ] **Step 4: Wire the policy + beta constants + delta logging into capture**

In `backend/capture.py`, add module constants near the top (after `EVALS_FIXTURES` / `CAPTURES_DEFAULT`):

```python
# Beta policy: Astrail v1 targets Japan, so geocode local-language names in Japanese and
# filter to Japan. SCALING (multi-country): derive these per trip from the destination
# (see docs/superpowers/plans/2026-06-29-mapbox-coord-authority-name-local.md "Scalability").
# The geocode module itself stays country-agnostic — this is the single policy point.
BETA_LOCAL_LANGUAGE = "ja"
BETA_COUNTRY = "jp"
```

Add a small haversine helper (used only for the human diagnostic):

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

In the per-place loop of `_collect_reel`, after `places.append(grounded)` / the `print(_format_place(...))`, emit the delta line when Mapbox moved the coord:

```python
        moved = (grounded.lat, grounded.lng) != original_coords
        places.append(grounded)
        print(_format_place(grounded, coords_src="mapbox" if moved else "llm"))
        if moved and None not in original_coords and grounded.lat is not None and grounded.lng is not None:
            d = _haversine_m(original_coords, (grounded.lat, grounded.lng))
            print(f"           llm-coords: {original_coords[0]:.4f},{original_coords[1]:.4f}"
                  f"  (Δ {d:.0f} m from mapbox)", file=sys.stderr)
```

Update the live resolver in `main()` to use the policy + beta constants (lazy import `geocode_query_for` alongside the existing geocode imports):

```python
    if mapbox_token:
        from geocode.mapbox_forward import apply_geocode, forward_geocode, geocode_query_for

        async def _resolve(place: PlaceResult) -> PlaceResult:
            query, language = geocode_query_for(place, local_language=BETA_LOCAL_LANGUAGE)
            geo = await forward_geocode(query, token=mapbox_token,
                                        language=language, country=BETA_COUNTRY)
            return apply_geocode(place, geo)
        resolve = _resolve
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && uv run pytest geocode/test_mapbox_forward.py test_capture.py -q`
Expected: PASS — the new policy + delta tests plus all pre-existing tests (no regressions).

- [ ] **Step 6: Confirm the import invariant + full suite + eval**

Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import capture, geocode.mapbox_forward; print('keyless import OK')"`
Run: `cd backend && uv run pytest -q` (all pass, 1 live skip)
Run: `cd backend && uv run python -m evals.run_eval --subject baseline && uv run python -m evals.run_eval --subject pipeline` (both `OVERALL: PASS`)

- [ ] **Step 7: Commit**

```bash
cd backend && git add geocode/mapbox_forward.py capture.py geocode/test_mapbox_forward.py test_capture.py
git commit -m "feat(geocode): ground coords via local-language name (Mapbox authority for Japan)"
```

---

## Manual verification (human, optional — live)

Hits OpenAI + Mapbox; run with `OPENAI_API_KEY` + `MAPBOX_SECRET_TOKEN` set. Confirms Mapbox now grounds a Japanese-named place AND shows the LLM↔Mapbox delta:

```bash
cd backend && uv run python -m capture --reels "https://www.instagram.com/reel/DXwcVVliX3B/" --out-dir captures
```
Expect: for places whose caption carried a Japanese name, a `(coords=mapbox)` line plus a `llm-coords: … (Δ N m from mapbox)` line — the empirical accuracy delta you wanted before committing to this. English-only names stay `coords=llm`.

## NOT in scope / deferred

- **Multi-country language/country derivation** — beta uses the `BETA_LOCAL_LANGUAGE`/`BETA_COUNTRY` constants; deriving per trip destination (or per place) is the documented extension point, built when a 2nd country lands (YAGNI).
- **TS `PlaceResult` mirror** — `backend-types.ts` doesn't mirror `PlaceResult` yet; no drift to fix now. Flag for Zhi Hao when place types are added.
- **Reverse-geocoding LLM coords to recover dropped places** — the extractor still drops null-coord places before geocoding; Mapbox refines surviving coords, it doesn't rescue dropped ones (unchanged from the earlier Mapbox step).
- **Script-detection for language** — rejected for the beta (Han is ambiguous between `ja`/`zh`); the caller policy is the chosen mechanism.

## Rollback / risk

- **Blast radius:** one optional model field, one extractor prompt addition + a defensive null, one pure policy function, and a capture resolver/diagnostic tweak. No change to the geocode HTTP path, token safety, or `apply_geocode`. Revert = drop the two commits.
- **Risk:** Low. `name_local` is optional and defaulted, so existing data/fixtures/eval are unaffected; non-Japan and English-named places behave exactly as today (English path / LLM fallback). The only live-behavior change is that Japanese-named places now query Mapbox in Japanese — which either grounds (better) or misses (keeps LLM coords, as before).
