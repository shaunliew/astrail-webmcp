# Step 5 — Direct Apify Reel Extraction (live capture path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first *live* path — scrape real Instagram reels via **direct Apify HTTP** (no MCP) into `ReelData`, then extract real places via the **OpenAI Agents SDK** place-extractor into the frozen `ExtractionResult` contract — exposed only through an **opt-in `capture` command** that refreshes the offline fixtures. The **offline default + the #16 eval stay credential-free and green**; the unit suite makes **zero live calls**.

**Architecture:** `scrape/apify_direct.py` POSTs to Apify `run-sync-get-dataset-items` and maps items → `ReelData`. `genagents/place_extractor.py` runs an Agents SDK agent (`WebSearchTool`, `ModelSettings(tool_choice="required")`, `output_type=ExtractionResult`) and drops places that lack coords, fail the verbatim-`evidence_quote` check, or carry a placeholder URL; typed `gpt-4o` fallback. `capture.py` chains scrape→extract over the demo reels and writes `evals/fixtures/*`. The offline pipeline/eval are untouched and replay whatever the capture wrote. Live calls happen **only** in the capture command, with `APIFY_TOKEN` + `OPENAI_API_KEY`; unit tests mock the HTTP transport and the agent run, and the one real-extraction test is `@pytest.mark.live`, skipped unless `--run-live`.

**Tech Stack:** Python ≥3.14, `httpx` (dep) for Apify, `openai-agents` 0.17.7 + `openai` (deps) for the extractor, Pydantic v2 contracts (Step 4). No new runtime dependencies. Sources: Apify input verified (`username` accepts direct reel URLs) — `apify.com/apify/instagram-reel-scraper/input-schema`; endpoint `docs.apify.com/api/v2/act-run-sync-get-dataset-items-post`; Agents SDK `developers.openai.com/api/docs/guides/agents/quickstart`.

**Guiding principle — feasible-first, minimal, maintainable** (astrail-plan-and-review Core Engineering Rule): smallest working live path; the capture command is the deliverable; **defer** `LiveReelSource`/resolve-wiring until a live pipeline run is needed; use the **SDK's built-in OpenAI tracing** for observability now; **defer Langfuse**.

## Global Constraints

- **Offline stays the default + the #16 eval stays green, credential-free.** `run_eval` (baseline + pipeline) still `OVERALL: PASS` with **no API key**. The unit suite makes **zero live calls / needs no key** — Apify HTTP is mocked, the agent run is mocked, and a real-extraction test is `@pytest.mark.live` skipped by default.
- **Live calls are opt-in only** — only `python -m capture` with `APIFY_TOKEN` + `OPENAI_API_KEY`. Importing any module triggers no live call and needs no key (asserted by import-time tests).
- **Direct Apify HTTP, no MCP, no Agents SDK in the scrape loop** (guardrail #10). Transcripts via Apify's `includeTranscript`; no yt-dlp/ffmpeg/Whisper.
- **Contract frozen (Step 4):** extractor `output_type = ExtractionResult`; **our** field names `evidence_quote`, `source_type` (never legacy `evidence_caption_quote`).
- **Anti-hallucination (guardrail #1):** `ModelSettings(tool_choice="required", parallel_tool_calls=True)`; **drop places with null lat/lng**, with non-verbatim `evidence_quote`, or with a placeholder `source_url`; typed `_MODEL_ERRORS` fallback to `gpt-4o`; match `WebSearchTool` calls as `ToolSearchCallItem`.
- **Package name:** our agent code lives in **`backend/genagents/`** — NOT `backend/agents/`, which the OpenAI SDK's `agents` package shadows (empirically: `import agents.narrator` → `ModuleNotFoundError`). Renaming once fixes it for every agent step.
- **Secrets:** never interpolate `APIFY_TOKEN`/keys into exception text or logs.
- **No `legacy/` imports** (guardrail #9). No Supabase/auth/SSE/frontend/mem0/Mapbox. No new deps. No board edits, no PR.

---

## Data flow

```
python -m capture --reels <url,...>   (opt-in; needs APIFY_TOKEN + OPENAI_API_KEY)
  reel_urls ─ scrape/reel_url.py: normalize + validate
            ─ scrape/apify_direct.py: POST run-sync-get-dataset-items → ReelData   (httpx; 300s cap → 408)
            ─ genagents/place_extractor.py: Agent(WebSearchTool, tool_choice=required,
                 output_type=ExtractionResult) → Runner.run(max_turns=12) → ExtractionResult
                 drop: null coords | non-verbatim evidence_quote | placeholder source_url ; gpt-4o fallback
            ─ write evals/fixtures/japan_demo_reels.json + expected_places.json
                          │
                          ▼  (offline, default, no keys — UNCHANGED)
        run_offline_pipeline / run_eval  replays the captured fixtures

DEFERRED: LiveReelSource behind resolve() (a live *pipeline* run) — not needed until a later step.
```

## File Structure

```
backend/genagents/            # RENAMED from backend/agents/ (SDK clash) — package marker + moved stubs
├── __init__.py               # NEW
├── place_extractor.py        # FILL — extractor: pure helpers + agent factory + live run wrapper
├── (narrator.py, enricher.py, weather.py, restaurant.py, hotel.py, transport.py, orchestrator.py)  # moved stubs, untouched
└── test_place_extractor.py   # NEW — pure helpers + mocked run (offline); 1 @pytest.mark.live test

backend/scrape/
├── reel_url.py               # FILL — normalize + validate (pure)
├── apify_direct.py           # FILL — direct-HTTP scraper → ReelData (httpx injected)
├── test_reel_url.py          # NEW
└── test_apify_direct.py      # NEW — mocked httpx (incl. 408), no live

backend/capture.py            # NEW — opt-in scrape+extract → fixtures; per-reel error handling
backend/test_capture.py       # NEW — producers injected (offline) + import-time invariant test
backend/conftest.py           # NEW — `--run-live` gate that skips @pytest.mark.live by default
backend/pyproject.toml        # MODIFY — [tool.pytest.ini_options]: asyncio_mode + markers (no new deps)

.claude/CLAUDE.md             # MODIFY — project-structure: backend/agents/ → backend/genagents/ + note the SDK clash
```

No changes to `evals/*` runtime, `baseline.py`, `models/*`, `pipeline/*`, `timing.py`, `tracing.py`, `output.py`, or fixture *content* (capture writes them, but CI never runs capture).

## Active vs Deferred

| Concern | Step 5 (active) | Deferred |
|---|---|---|
| Rename `agents/` → `genagents/` (SDK clash fix) | once, all stubs + CLAUDE.md | — |
| Apify scrape (direct HTTP → ReelData) | `apify_direct.py` | — |
| LLM extractor → ExtractionResult (coords/evidence/url drop) | `place_extractor.py` | — |
| Capture command (refresh fixtures) | `capture.py`, opt-in | — |
| Agent-trace observability | **SDK built-in OpenAI tracing** (free) | **Langfuse** via Step-3 seam |
| `LiveReelSource` behind `resolve()` (live pipeline run) | — | later step (not needed yet; capture calls producers directly) |
| transcript fallback | `includeTranscript` flag wired, off | auto-trigger heuristic |
| dedup / confidence cap | name-only is fine | two-gate dedup → **Step 6** |

---

### Task 1: Rename `backend/agents/` → `backend/genagents/` (fix the SDK package clash)

**Files:** `git mv backend/agents/ backend/genagents/`; add `backend/genagents/__init__.py`; Modify `.claude/CLAUDE.md`.

**Why:** `openai-agents` installs a top-level `agents` package that shadows `backend/agents/` (verified: `import agents.narrator` → `ModuleNotFoundError`). All our agent modules must live under a non-clashing name. `genagents` (generation agents) is unambiguous and lets `from agents import Agent` resolve to the SDK inside our modules.

- [ ] **Step 1:** `git mv backend/agents backend/genagents`. Create `backend/genagents/__init__.py` with a one-line docstring.
- [ ] **Step 2:** In `.claude/CLAUDE.md`, update the Project Structure block: `backend/agents/` → `backend/genagents/`, and add a one-line note: *"Named `genagents/` (not `agents/`) because the OpenAI Agents SDK owns the top-level `agents` package and would shadow it."*
- [ ] **Step 3: Verify** the stubs are now importable and the SDK still resolves:
  ```bash
  cd backend && uv run python -c "import genagents.narrator; from agents import Agent; print('genagents OK + SDK Agent OK')"
  uv run pytest -q   # nothing references the old path; suite still green
  ```
- [ ] **Step 4: Commit** `refactor(genagents): rename backend/agents/ -> backend/genagents/ to avoid OpenAI SDK package shadowing (step 5: direct apify reel extraction)`.

---

### Task 2: Reel URL normalize + validate

**Files:** Modify `backend/scrape/reel_url.py`; Test `backend/scrape/test_reel_url.py`.
**Interfaces:** `normalize_reel_url(url) -> str`, `is_reel_url(url) -> bool`, `short_code_of(url) -> str | None`. Pure stdlib (`urllib.parse` + a `/(reels?)/<code>` regex).

- [ ] **Step 1: Failing test** (parametrized: reel vs post vs non-instagram vs junk; normalize strips query + trailing slash; short_code extraction). - [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `feat(scrape): instagram reel URL normalize + validate (step 5: direct apify reel extraction)`.

---

### Task 3: Apify direct-HTTP scraper → ReelData

**Files:** Modify `backend/scrape/apify_direct.py`; Test `backend/scrape/test_apify_direct.py`.
**Interfaces:** `map_item_to_reeldata(item: dict, reel_url: str) -> ReelData` (pure); `async scrape_reel(reel_url, *, token, include_transcript=False, client=None, timeout_s=120) -> ReelData`.
**Verified input/endpoint:** `POST https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items?timeout={timeout_s}`, header `Authorization: Bearer {token}`, body `{"username": [reel_url], "resultsLimit": 1}` (+ `"includeTranscript": true` when flagged). `username` accepts direct reel URLs (verified). Response = JSON array of items.

- [ ] **Step 1: Failing test** (offline, `httpx.MockTransport`): map item → ReelData; `scrape_reel` POSTs to `run-sync-get-dataset-items` with `Authorization: Bearer TKN` and the right body; **empty dataset → `ValueError`**; **`408` response → a clear error whose message does NOT contain the token**.
  ```python
  @pytest.mark.asyncio
  async def test_scrape_reel_408_is_clear_and_tokenless():
      client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(408)))
      with pytest.raises(Exception) as e:
          await scrape_reel("https://www.instagram.com/reel/X/", token="SECRET", client=client)
      assert "SECRET" not in str(e.value)
  ```
- [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement** (`raise_for_status()` wrapped so the raised message references the reel URL + status, never the token/URL-with-token; `params={"timeout": timeout_s}`; default `httpx.AsyncClient(timeout=timeout_s + 10)`). - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `feat(scrape): direct-HTTP Apify reel scraper -> ReelData (step 5: direct apify reel extraction)`.

> pytest async: confirm `[tool.pytest.ini_options] asyncio_mode = "auto"` is set in `pyproject.toml` (Task 6 Step 0). `pytest-asyncio` is already a dev dep.

---

### Task 4: Place-extractor — pure helpers (offline)

**Files:** Modify `backend/genagents/place_extractor.py`; Test `backend/genagents/test_place_extractor.py`.
**Interfaces (pure, SDK-free at import):** `build_extractor_input(reel: ReelData) -> str`; `is_placeholder_url(url) -> bool`; `keep_valid_places(places: list[PlaceResult], reel: ReelData) -> list[PlaceResult]` — drops places with **null lat/lng**, with `evidence_quote` not a case-insensitive substring of `caption + " " + location_name`, or with a placeholder `source_url`; `PLACE_EXTRACTOR_INSTRUCTIONS` (ported, using `evidence_quote`/`source_type`).

**Import discipline (review finding, Codex):** `genagents/place_extractor.py` must import **neither** the Agents SDK (`from agents import …`) **nor** `openai` at module top level. Both are imported *inside* functions only. The model-error tuple is a lazy helper:

```python
def _model_errors() -> tuple[type[Exception], ...]:
    import openai
    return (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)
```

This keeps the import-time invariant airtight: `import genagents.place_extractor` (and `import capture`) load nothing heavy, need no key, and make no call — asserted by the import-time test.

- [ ] **Step 1: Failing test** — covers: input includes location+caption; `keep_valid_places` drops null-coords, non-verbatim-evidence, and placeholder-url places, keeps a good one; `is_placeholder_url`. **The test imports only the pure helpers; the module must not import the OpenAI SDK at top level** (lazy-import the SDK inside the factory/run wrapper). Add an explicit assert that importing the module needs no key.
- [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement** the helpers (the coords + evidence + url drop live in `keep_valid_places`). - [ ] **Step 4: Run → pass.** - [ ] **Step 5: Commit** `feat(genagents): place-extractor pure helpers incl. coords/evidence/url drop (step 5: direct apify reel extraction)`.

---

### Task 5: Place-extractor — agent factory + live run wrapper

**Files:** Modify `backend/genagents/place_extractor.py`; Test `backend/genagents/test_place_extractor.py`.
**Interfaces:** `build_extractor(model: str) -> "Agent"` (lazy-imports `from agents import Agent, Runner, ModelSettings, WebSearchTool` *inside the function*); `async extract_places(reel, *, model=None, runner=None) -> list[PlaceResult]` — `model` defaults to `os.environ.get("ASTRAIL_EXTRACT_MODEL", "gpt-5.5-2026-04-23")`; runs the agent, reads `result.final_output.places`, applies `keep_valid_places`, falls back to `gpt-4o` on `except _model_errors()` (the lazy helper from Task 4). `runner` is injectable (default = a thin wrapper around the real `Runner.run`, imported lazily) so unit tests mock it without loading the SDK.

- [ ] **Step 1: Tests** — (a) a default unit test injecting a fake `runner` that returns an `ExtractionResult` stub, asserting `extract_places` filters correctly and (b) returns `gpt-4o` results when the first runner raises a `_MODEL_ERRORS` member — **no live call**; (c) one `@pytest.mark.live` test doing a real single-reel extraction (skipped unless `--run-live` + keys).
- [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement** (env-var model default; typed fallback; lazy SDK import). - [ ] **Step 4: Run → pass** (live skipped). - [ ] **Step 5: Commit** `feat(genagents): live place extraction via Agents SDK with typed fallback + env model (step 5: direct apify reel extraction)`.

---

### Task 6: Capture command + pytest live-gate config

**Files:** Create `backend/capture.py`, `backend/test_capture.py`, `backend/conftest.py`; Modify `backend/pyproject.toml`.

- [ ] **Step 0: pytest config + live gate.** In `pyproject.toml` add:
  ```toml
  [tool.pytest.ini_options]
  asyncio_mode = "auto"
  markers = ["live: makes real OpenAI/Apify calls; skipped unless --run-live"]
  ```
  Create `backend/conftest.py`:
  ```python
  import pytest

  def pytest_addoption(parser):
      parser.addoption("--run-live", action="store_true", default=False,
                       help="run @pytest.mark.live tests (real OpenAI/Apify calls)")

  def pytest_collection_modifyitems(config, items):
      if config.getoption("--run-live"):
          return
      skip = pytest.mark.skip(reason="needs --run-live (real API calls)")
      for item in items:
          if "live" in item.keywords:
              item.add_marker(skip)
  ```
  Verify: `uv run pytest -q` skips live; `uv run pytest --run-live -q` would attempt them.

- [ ] **Interfaces:** `async run_capture(reel_urls, *, token, scrape, extract) -> tuple[list[ReelData], list[PlaceResult]]` — both producers injected; **per-reel try/except** that logs `reel_url + error type` (never the token) and continues; returns whatever succeeded. `main()` reads `APIFY_TOKEN`/`OPENAI_API_KEY` (exits clearly if missing), wires the real `scrape_reel`/`extract_places`, writes fixtures via `pipeline.sources.record_fixture`, prints a one-line per-reel summary.
- [ ] **Step 1: Tests** — `run_capture` with fake scrape+extract (one succeeds, one raises) asserts it continues + returns the successes (offline); **an import-time invariant test**: `import capture` and `import genagents.place_extractor` with `APIFY_TOKEN`/`OPENAI_API_KEY` unset must not raise and must make no call.
- [ ] **Step 2: Run → fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Full offline verification**
  ```bash
  cd backend
  uv run pytest scrape/ genagents/ pipeline/ models/ evals/ . -q   # offline, no key, no network; live tests skipped
  uv run python -m evals.run_eval                                   # OVERALL: PASS (unchanged)
  uv run python -m evals.run_eval --subject pipeline                # OVERALL: PASS (unchanged)
  ```
- [ ] **Step 6: Commit** `feat(capture): opt-in scrape+extract capture command + pytest live-gate (step 5: direct apify reel extraction)`.

- [ ] **Step 7 (manual, opt-in — NOT CI): live smoke** with keys from `backend/.env`:
  ```bash
  cd backend && uv run python -m capture --reels https://www.instagram.com/reel/DYbmT-SNzVK/
  ```
  Confirm: scrapes the reel, extracts ≥1 coords-and-evidence-backed place, writes fixtures; traces visible at `platform.openai.com/traces`. Human-run only.

---

## Non-Goals

- No live calls in the default suite / offline pipeline / eval; no credentials for `pytest` or `run_eval`.
- No MCP, no Agents SDK in the scrape loop; no yt-dlp/ffmpeg/Whisper.
- **No `LiveReelSource`/resolve-wiring** (deferred), no semantic dedup (Step 6), no enrichment/narrator/Mapbox/Supabase/SSE/frontend/mem0.
- **No Langfuse** — built-in OpenAI tracing covers Step 5.
- No new dependencies, no board edits, no PR.

## Acceptance Criteria

- [ ] `backend/agents/` renamed to `backend/genagents/` (stubs moved, importable; CLAUDE.md updated); `from agents import Agent` resolves to the SDK inside our modules.
- [ ] `scrape/reel_url.py`, `scrape/apify_direct.py`, `genagents/place_extractor.py`, `capture.py` exist + typed.
- [ ] Apify scrape POSTs the verified `run-sync-get-dataset-items` shape; tested with mocked httpx incl. a **408 case** and **no token in error text**.
- [ ] Extractor drops null-coords / non-verbatim-evidence / placeholder-url places, `gpt-4o` typed fallback, env-var model; filtering + fallback **unit-tested offline** (runner mocked); the real run is `@pytest.mark.live`, skipped by default via `conftest.py --run-live`.
- [ ] `python -m capture` is opt-in (needs both keys), per-reel error-tolerant, refreshes fixtures, never run by the suite; import-time invariant test proves no key/call at import.
- [ ] `uv run pytest … -q` passes with **no API key, no network**; `run_eval` (both subjects) stays `OVERALL: PASS`.
- [ ] No `legacy/` imports; no new deps; `evals/*` runtime + `models/*` + `pipeline/*` + `baseline.py` unchanged.

## Local Run / Verification

```bash
cd backend
uv run pytest scrape/ genagents/ pipeline/ models/ evals/ . -q
uv run python -m evals.run_eval
uv run python -m evals.run_eval --subject pipeline
# opt-in live (human only): uv run python -m capture --reels <reel_url>
```

## Parallelization

- Task 1 (rename) is a prerequisite for the genagents tasks — do it first, alone.
- Then Lane A: Task 2 (`reel_url`) → Task 3 (`apify_direct`); Lane B: Task 4 (extractor helpers) → Task 5 (run wrapper). A and B parallel.
- Then Task 6 (capture, needs Tasks 3+5).

## Risks / Rollback

- **Package clash (now fixed by Task 1).** Verified empirically. Task 1 must land first; everything else imports `genagents.*` and the SDK as `agents`.
- **Apify input/limits.** Input shape verified against the actor schema; `resultsLimit` is ignored for direct URLs (harmless). 300s sync cap → 408 handled + tested. Token never leaks into errors.
- **Live cost.** Capture is opt-in, single-reel default, never CI; the `@pytest.mark.live` test is skipped by default.
- **Model id `gpt-5.5-2026-04-23` unvalidated.** Env-var override (`ASTRAIL_EXTRACT_MODEL`) + `gpt-4o` typed fallback bound the blast radius to one failing call.
- **Rollback:** Task 1 is a pure rename (revertible). Tasks 2–6 add modules + an opt-in command; nothing changes the offline default, so reverting any task leaves the eval green.

## Self-Review Notes

- **Decisions folded:** rename `agents/`→`genagents/` (Task 1); `LiveReelSource` deferred (removed). **Codex P1/P2 folded:** coords-drop in `keep_valid_places`; real pytest `--run-live` gate + `[tool.pytest.ini_options]`; 408 + token-safe errors + test; env-var model default; import-time invariant tests; Apify input corrected (dropped speculative `resultsType`).
- **Grounding:** Apify input verified (`username` accepts direct reel URLs); endpoint + Agents SDK symbols verified in-venv (`Agent`, `Runner.run(..., max_turns=...)`, `result.final_output`); legacy patterns reproduced, not imported.
- **Placeholder scan:** no placeholders; every code step is concrete.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | Step-0 scope (rename + defer LiveReelSource) decided; package clash found + proven |
| Outside Voice | Codex (`codex exec`, read-only, high effort) | Independent plan review | 1 | issues_found | 3 P1, 4 P2, 2 P3 — all folded or decided |
| Research | legacy-extractor agent + openaiDeveloperDocs MCP + Apify web (per user) | Ground the live integrations | 3 | done | extractor patterns, Agents SDK 0.17.7 symbols, Apify input schema verified |

**CODEX:** confirmed the **package clash** (both reviewers; I proved it empirically — `import agents.narrator` → `ModuleNotFoundError`, the SDK shadows `backend/agents/`) → **renamed to `backend/genagents/`** (user decision). Folded the rest: **drop null-coords places** in `keep_valid_places` (else captured fixtures fail `#16 coords_present`); a real **`conftest.py --run-live` gate + `[tool.pytest.ini_options]`** (the bare `@pytest.mark.live` doesn't skip; corrected the "no pyproject changes" claim); **408 handling + a token-safe error test** (no secret in exception text); **env-var model default** (`ASTRAIL_EXTRACT_MODEL`) + `gpt-4o` fallback; **import-time invariant tests** (no key/call at import); and **deferred `LiveReelSource`** (user decision — removes the resolve-swallows-errors + asyncio-in-loop risks). The **Apify input was verified** against the actor schema (`username` accepts direct reel URLs) — dropped the speculative `resultsType`.

**CROSS-MODEL:** no tension — planner review + Codex agree; the package clash was found by both and verified empirically.

**Step-0 scope:** `backend/agents/` → `backend/genagents/` (fix-once for all agent steps); `LiveReelSource` deferred (capture command is the deliverable; live calls stay visible because capture calls producers directly, not through `resolve()`).

**Observability:** the OpenAI Agents SDK has **built-in tracing** to `platform.openai.com/traces` (free, automatic on live runs) — covers Step 5; **Langfuse deferred** to a later observability step via the Step-3 seam.

**Failure modes:** Apify 408 / empty dataset → clear, token-free error (tested); a reel that fails scrape/extract → capture logs + continues (per-reel try/except); wrong model id → one failing call then `gpt-4o`. The offline default + eval are untouched, so no offline regression path.

**VERDICT:** ENG REVIEW CLEARED (pending the two decisions, now made). Plan is final + ready to hand to Codex for verification, then implement. Implementation gated on user approval — it is the first step that makes live paid API calls (capture only; suite stays offline).

NO UNRESOLVED DECISIONS
