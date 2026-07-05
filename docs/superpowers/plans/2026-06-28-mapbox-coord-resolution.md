# Step 5.5 — Mapbox Coordinate Resolution (ground LLM-extracted places) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make **coordinates authoritative** — resolve each LLM-extracted place name to canonical `lat/lng/formatted_address` via the **Mapbox Search Box `/forward`** API (the locked stack's geocoder), instead of trusting the LLM's web-search coords. Runs in the **opt-in capture path only** (live, behind the `MAPBOX_SECRET_TOKEN` seam); the offline pipeline + #16 eval stay credential-free and green. Sequenced **before Step 6** so the two-gate geo-dedup runs on trustworthy coords.

**Architecture:** Split the place's job by tool strength: the LLM extractor already gives **name + category + evidence_quote** (what the reel says); a new `geocode/mapbox_forward.py` calls Mapbox `/forward` to get **coords + formatted_address + context** (where it is). A pure `apply_geocode(place, geocode)` overrides the place's coords/address with Mapbox's when Mapbox resolves it (LLM coords kept as fallback on a Mapbox miss). The capture command gains a stage: `scrape → extract → resolve(Mapbox) → write fixtures`. The offline harness/eval are untouched (they replay already-resolved fixtures). Unit tests mock the Mapbox HTTP; the live call happens only in capture.

**Tech Stack:** Python ≥3.14, `httpx` (dep), Pydantic v2 contracts. No new runtime deps. Verified endpoint: `GET https://api.mapbox.com/search/searchbox/v1/forward` (Search Box API ref, docs.mapbox.com/api/search/search-box). Japan note: the "Japanese-only" caveat is the *older* Search API; **Search Box supports `language=en` for `country=jp`** (the docs show both EN and JA `/forward` examples).

**Guiding principle — feasible-first, minimal, maintainable:** add Mapbox grounding as a capture-path stage; do NOT rewrite the extractor prompt yet (its web-search coords stay as a fallback). Keep the offline default + eval untouched.

## Global Constraints

- **Offline default + #16 eval stay green, credential-free.** Mapbox is called only in the capture command with `MAPBOX_SECRET_TOKEN` present. The unit suite mocks Mapbox HTTP; importing any module needs no key and makes no call (import-time invariant test).
- **Direct HTTP, server-side secret token.** `sk` token (`MAPBOX_SECRET_TOKEN`), never a public `pk`; never interpolated into error text/logs.
- **Mapbox is the coordinate authority.** On a successful `/forward`, override `lat/lng/formatted_address`; on a miss, keep the LLM's values (so a place is never *lost* to a geocode miss — it falls back).
- **Contract unchanged where possible.** Reuse `PlaceResult` fields (`lat`, `lng`, `formatted_address`). A small `GeocodeResult` models the Mapbox reply.
- **Japan-first params:** `language=en`, `country=jp`, `types=poi`, `proximity=<Tokyo>`, `limit=1`.
- **No `legacy/` imports, no new deps, no Supabase/SSE/frontend/mem0, no board edits, no PR.**
- **`backend/.env` needs `MAPBOX_SECRET_TOKEN`** (server-side `sk`, URL-unrestricted, Search Box scope) — a one-time human setup; documented, not committed.

## Verified Mapbox contract (Search Box `/forward`)

```
GET https://api.mapbox.com/search/searchbox/v1/forward
    ?q={name}&language=en&country=jp&proximity={lon},{lat}&types=poi&limit=1
    &access_token={MAPBOX_SECRET_TOKEN}
→ GeoJSON FeatureCollection:
    features[0].geometry.coordinates = [lon, lat]
    features[0].properties.name            = canonical name
    features[0].properties.full_address    (or place_formatted) = formatted address
    features[0].properties.feature_type    = "poi"
    features[0].properties.mapbox_id        = stable feature id
```
`/forward` is a single request (no `session_token` — that's only for the interactive `/suggest`+`/retrieve` flow). Tokyo proximity default: `139.7671,35.6812` (Tokyo Station).

## File Structure

```
backend/geocode/
├── __init__.py          # NEW — package marker
├── mapbox_forward.py    # NEW — forward_geocode() direct HTTP → GeocodeResult; apply_geocode()
├── test_mapbox_forward.py  # NEW — mocked httpx (hit/miss/error/token-safe), apply_geocode pure
backend/models/
├── geocode.py           # NEW — GeocodeResult (lat, lng, formatted_address, mapbox_id, name)
├── test_geocode.py      # NEW
backend/capture.py       # MODIFY — add resolve stage: scrape → extract → resolve(Mapbox) → fixtures
backend/test_capture.py  # MODIFY — resolve injected (offline); a Mapbox-grounded place test
.claude/CLAUDE.md        # MODIFY — note MAPBOX_SECRET_TOKEN powers capture (.env.example already declares it)
```

No changes to `evals/*`, `pipeline/*`, `genagents/place_extractor.py` (extractor unchanged this step), `baseline.py`, fixtures content, or `pyproject.toml`.

## Active vs Deferred

| Concern | This step (active) | Deferred |
|---|---|---|
| Mapbox `/forward` coord+address grounding | `geocode/mapbox_forward.py`, in capture | — |
| Mapbox as coord authority (override LLM) | `apply_geocode`, fallback on miss | — |
| Extractor prompt simplification (stop web-searching coords) | — (kept as fallback) | a later cleanup once Mapbox grounding is trusted |
| Mapbox in the live *pipeline* (not just capture) | — | with `LiveReelSource` (deferred) |
| Mapbox Directions (transport legs) | — | the transport step |
| Geocoding API v6 fallback (if Search Box POI coverage thin) | — | add if a venue class fails to resolve |

---

### Task 1: GeocodeResult model

**Files:** Create `backend/models/geocode.py`, `backend/models/test_geocode.py`.
**Interfaces:** `GeocodeResult(BaseModel)`: `lat: float (ge=-90,le=90)`, `lng: float (ge=-180,le=180)`, `formatted_address: str | None = None`, `name: str | None = None`, `mapbox_id: str | None = None`.

- [ ] **Step 1: Failing test** — construct a GeocodeResult; lat/lng bounds reject out-of-range (ValidationError). - [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `feat(models): GeocodeResult contract for Mapbox-resolved coords (mapbox coord resolution)`.

---

### Task 2: Mapbox forward geocoder + apply

**Files:** Create `backend/geocode/__init__.py`, `backend/geocode/mapbox_forward.py`, `backend/geocode/test_mapbox_forward.py`.
**Interfaces:**
- `parse_forward_response(data: dict) -> GeocodeResult | None` (pure — first feature → GeocodeResult; None if no features). **`geometry.coordinates` is `[lng, lat]` (lon first) — map `coordinates[0]→lng`, `coordinates[1]→lat`; do NOT swap.**
- `TOKYO: tuple[float, float] = (139.7671, 35.6812)` — **(lng, lat)** order, Tokyo Station.
- `async forward_geocode(query: str, *, token: str, proximity_lng_lat: tuple[float,float] = TOKYO, country: str = "jp", language: str = "en", client=None, timeout_s: int = 15) -> GeocodeResult | None`. Sends `proximity=f"{lng},{lat}"`.
- `apply_geocode(place: PlaceResult, geo: GeocodeResult | None) -> PlaceResult` (pure, immutable via `model_copy(update=...)`: on a hit, copy with `lat/lng/formatted_address` from Mapbox; on None, return the place unchanged).

**Error/token safety (review finding):** do NOT call `resp.raise_for_status()` (its message includes the full URL, which carries `access_token` in the query string). Check `resp.status_code` manually and raise `RuntimeError(f"Mapbox forward failed for {query!r} (HTTP {status})")`. Wrap the request in `try/except httpx.RequestError` (timeout/network) and re-raise a sanitized `RuntimeError(f"Mapbox forward error for {query!r}: {type(exc).__name__}")` — never let an httpx message (URL-bearing) escape.

- [ ] **Step 1: Failing tests** (offline, `httpx.MockTransport`):
  - `parse_forward_response` maps a FeatureCollection → GeocodeResult — and a swap guard: a feature with `coordinates=[139.77, 35.68]` yields `lng≈139.77, lat≈35.68` (NOT swapped); empty `features` → None.
  - `forward_geocode` GETs `…/searchbox/v1/forward`; asserts the request URL has `country=jp`, `types=poi`, `language=en`, and `proximity=139.7671,35.6812`; returns the parsed result; empty FeatureCollection → None (miss, not error).
  - **Token safety:** a `403` response with `token="SECRET"` raises with `"SECRET" not in str(e)`; and a request that raises `httpx.ConnectTimeout` is re-raised sanitized with `"SECRET" not in str(e)`.
  - `apply_geocode(place, geo)` overrides lat/lng/formatted_address; `apply_geocode(place, None)` returns the place unchanged.
- [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement** (manual status check + `try/except httpx.RequestError`, sanitized messages; `model_copy` apply). - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `feat(geocode): Mapbox Search Box /forward client + apply_geocode (mapbox coord resolution)`.

---

### Task 3: Resolve stage in the capture command

**Files:** Modify `backend/capture.py`, `backend/test_capture.py`.
**Interfaces:** `run_capture(reel_urls, *, token, scrape, extract, resolve=None)` — `resolve` is an injected **async** callable `async (place: PlaceResult) -> PlaceResult` (it `await`s the async Mapbox `/forward`; it MUST be a coroutine since `run_capture` is already async). **The default is an async IDENTITY no-op** (`async def _identity_resolve(p): return p` — returns the place unchanged, makes no Mapbox call) so the existing offline tests and the no-key path stay live-free. `main()` injects the **live async** resolver (an `async def` wrapping `forward_geocode` + `apply_geocode` with `MAPBOX_SECRET_TOKEN`) **only when the token is present**; without it, `main()` logs a one-line warning and leaves `resolve` as the identity no-op (capture still works on LLM coords). After `extract`, **each place is `await resolve(place)`-d individually inside its OWN `try/except`** — a geocode error or miss keeps that place's LLM coords (a place is never lost to a Mapbox failure), and the failure is logged by place name + error type, never the token.

> Limitation (state it, per review): the extractor still requires + keeps only places that already have coords (`keep_valid_places` drops null-coord places before capture), so this step **refines/overrides the coords of surviving places** — it does not yet *rescue* coord-less places. Fully shifting coordinate-sourcing to Mapbox (extractor stops web-searching coords; the null-coord drop moves to *after* resolution) is a deferred follow-up.

- [ ] **Step 1: Failing tests** (all fake resolvers are `async def`, awaited by `run_capture`) — (a) `run_capture` with an `async` fake `resolve` injected: the resolved place's coords come from the fake resolver (stage runs), offline; (b) **default `resolve=None` is the async identity** — coords unchanged, no call (existing `test_run_capture_*` still pass); (c) an `async` fake `resolve` that **raises** keeps the place with its original (LLM) coords and never logs a token. - [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement** (`await resolve(place)` per place in its own try/except, between extract and append; default `_identity_resolve` async no-op; `main()` injects the live async resolver only when `MAPBOX_SECRET_TOKEN` set, else warn + identity). - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Full offline verification + commit.**

- [ ] **Step 6: Full offline verification**
  ```bash
  cd backend
  uv run pytest scrape/ genagents/ geocode/ models/ pipeline/ evals/ . -q   # offline, no key, no network
  uv run python -m evals.run_eval                 # OVERALL: PASS (unchanged)
  uv run python -m evals.run_eval --subject pipeline   # OVERALL: PASS (unchanged)
  ```
  Commit `feat(capture): resolve coords via Mapbox before writing fixtures (mapbox coord resolution)`.

- [ ] **Step 7 (manual, opt-in — human): live smoke** with `MAPBOX_SECRET_TOKEN` + the other keys in `backend/.env`:
  ```bash
  cd backend && uv run python -m capture --reels "https://www.instagram.com/reel/DYGH3jFBZHz/" --out-dir captures
  ```
  Confirm the place prints `coords=mapbox` with Mapbox-grounded lat/lng + formatted address.

---

### Task 4: Document the new key (small)

`.env.example` **already declares `MAPBOX_SECRET_TOKEN`** (verified) — no change needed there. Just add a one-line note in `.claude/CLAUDE.md` that the capture/geocode path requires `MAPBOX_SECRET_TOKEN` (server-side `sk`, Search Box scope; the public `pk` stays frontend-only). Optional — fold into Task 3's docs if trivial.
- [ ] Add + commit `docs: note MAPBOX_SECRET_TOKEN powers the capture/geocode path (mapbox coord resolution)`.

---

## Non-Goals

- No live Mapbox in the default test suite / offline pipeline / eval; no credentials for `pytest` or `run_eval`.
- No extractor-prompt change (its web-search coords stay as a fallback this step).
- No Mapbox in the live *pipeline* run (deferred with LiveReelSource), no Mapbox Directions/transport, no Geocoding-v6 fallback yet.
- No dedup (Step 6), no Supabase/SSE/frontend/mem0, no new deps, no board edits, no PR.

## Acceptance Criteria

- [ ] `geocode/mapbox_forward.py` calls the verified `…/searchbox/v1/forward` shape (`country=jp`, `types=poi`, `language=en`), parses the FeatureCollection → `GeocodeResult`; tested with **mocked httpx** (hit / miss / error / **no token in error**).
- [ ] `apply_geocode` overrides coords/address on a hit and is a no-op (LLM coords kept) on a miss — pure + unit-tested.
- [ ] Capture resolves coords via Mapbox before writing fixtures using an **awaited async** resolver; runs without the token (skips resolution + warns) so it degrades gracefully; the per-place print shows `coords=mapbox|llm`.
- [ ] `uv run pytest … -q` passes with **no API key, no network**; `run_eval` (both subjects) stays `OVERALL: PASS`.
- [ ] `MAPBOX_SECRET_TOKEN` noted in CLAUDE.md (`.env.example` already declares it — not re-added). No `legacy/` imports, no new deps.

## Local Run / Verification

```bash
cd backend
uv run pytest scrape/ genagents/ geocode/ models/ pipeline/ evals/ . -q
uv run python -m evals.run_eval
uv run python -m evals.run_eval --subject pipeline
# opt-in live (human, needs MAPBOX_SECRET_TOKEN): uv run python -m capture --reels "<reel>" --out-dir captures
```

## Parallelization

- Lane A: Task 1 (`models/geocode.py`) → Task 2 (`geocode/mapbox_forward.py`, needs GeocodeResult).
- Then Task 3 (`capture.py`, needs Task 2), Task 4 (docs). Task 1+2 are one short lane; 3 integrates.

## Risks / Rollback

- **Mapbox POI coverage / English Japan queries.** Search Box supports `language=en` for `country=jp` (verified in docs), but a specific venue may not resolve. Mitigation: `apply_geocode` falls back to the LLM coords on a miss (no place is lost); the `coords=` provenance tag surfaces which source won. Geocoding-v6 fallback is a documented later option.
- **Token safety.** `access_token` goes in the query string (Mapbox standard) but is never echoed into error messages/logs — tested.
- **Capture without the token.** Degrades gracefully (skips resolution, keeps LLM coords, warns) — capture still works.
- **Rollback:** every task is an isolated commit; Tasks 1–2 add unreferenced modules; Task 3 adds an injected stage with a graceful no-token path. The offline default + eval are untouched, so reverting any task leaves the suite green.

## Self-Review Notes

- **Decision folded:** sequenced before Step 6 (user choice) so dedup runs on Mapbox-grounded coords.
- **Grounding:** Search Box `/forward` endpoint + params verified via the mapbox-search-patterns skill + the Mapbox docs MCP (Search Box API ref + the Japan-considerations page — the Japanese-only caveat is the *older* Search API, not Search Box).
- **Feasible-first:** capture-path stage only; extractor unchanged; eval untouched; graceful no-token degradation. **Placeholder scan:** every code step is concrete.
