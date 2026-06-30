# Apify IG-Block Contingency — Manual-Paste Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-paste ingestion path so trip generation survives the cases where Apify cannot fully scrape a reel — a global Instagram block wave (`no_items`/blocked) **or** a per-reel restriction (`restricted_page`) — by letting a human paste the reel's caption (+ optional location tag) so the existing extractor pipeline runs unchanged.

**Architecture:** The downstream pipeline only depends on the *text* (`caption` + `location_name`) inside a `ReelData`, not on how it was acquired. Apify is one producer of that text; a manual paste is a second producer behind the same `ReelData` contract. A new pure builder (`scrape/manual_input.py`) constructs a `ReelData` from pasted text; the `capture` CLI gains a manual mode that bypasses scraping (and the Apify token) and feeds the manual `ReelData` through the same extract → ground → write path. Nothing downstream of `ReelData` changes.

**Observed failure modes this rescues (2026-06-29 live runs):**
- **Global block wave** — `no_items` + "Request blocked, retrying with different session" (even maximally-public accounts fail). The original motivation.
- **Per-reel restriction** — `restricted_page` ("Restricted access, only partial data available") on a specific reel (`DYM_I5IvLSv`), while sibling reels scraped fine the same minute. Manual-paste rescues this case too: the human can see the reel even when the logged-out actor only gets partial data. Both surface as a typed `ApifyScrapeError` → graceful skip today; manual-paste turns the skip into a recovery.

**Tech Stack:** Python 3.14, Pydantic v2 (`ReelData`), `hashlib` (stdlib), pytest. No new dependencies. No MCP, no Agents SDK in this path.

**Scope decision (Shaun, 2026-06-29):** Manual-paste **only**. The card's other near-term options are deferred behind their own triggers: multi-actor failover (defer until we observe one actor break while another still works — it does not help the *observed* global-wave failure), probe/SSE status surfacing (defer until the SSE pipeline exists — no consumer yet), authenticated scraping (DECISION GATE), source diversification (v2). Board card: "Backend P1: Reel ingestion resilience — Apify IG block contingency" (Phase 1.1, Shaun).

**Non-goals:**
- No user-facing "paste caption" product UX. This task delivers a **CLI capability** (refresh fixtures / run the pipeline from pasted text during a block). The frontend/API paste UX is a later step, gated on the live `/generate-trip` endpoint + frontend, which do not exist yet.
- No change to the Apify scrape path, the extractor, or any downstream agent.
- No new guardrail work (Agents SDK input guardrails remain Build Order step 21).

## Global Constraints

- **Guardrail #10 (direct HTTP for Apify):** the manual path adds **no** MCP and **no** Agents SDK; it is pure stdlib + Pydantic. Do not touch `scrape/apify_direct.py` scrape logic.
- **Guardrail #11 (untrusted reel content):** manually-pasted caption text is **exactly as untrusted** as scraped text and MUST ride the *same* extractor path — introduce no new trust boundary, no separate "trusted manual" branch. Manual text is not privileged.
- **Guardrail #1 (no hallucinated places):** the manual path MUST still flow through `keep_valid_places`, so `evidence_quote` stays a verbatim substring of the pasted caption/location. Do not bypass the validity filter for manual input.
- **Token safety (existing invariant):** no secret (Apify/OpenAI/Mapbox token) ever appears in a raised exception message, log line, or print. Log error TYPE only for non-`ApifyScrapeError` failures, as the existing code does.
- **Import-time invariant:** `import capture` and `import scrape.manual_input` must require no key, import no SDK, and make no network call. `scrape/manual_input.py` is pure (stdlib + models). Live producers (`extract_places`, `scrape_reel`) stay lazily imported inside `capture.main()`.
- **Offline default suite stays credential-free and green.** Every test in this plan uses injected producers / pure functions — no live call, no key. The `#16` eval must stay green and untouched.
- **Coding style:** PEP 8, type annotations on all signatures, small focused files, immutable Pydantic updates, fail-fast validation at the boundary.

---

### Task 1: Pure manual-paste `ReelData` builder

**Files:**
- Create: `backend/scrape/manual_input.py`
- Test: `backend/scrape/test_manual_input.py`

**Interfaces:**
- Consumes: `models.reel.ReelData`; `scrape.reel_url.is_reel_url`, `scrape.reel_url.normalize_reel_url` (existing).
- Produces: `manual_reeldata(caption: str, *, location_name: str | None = None, source_url: str | None = None) -> ReelData` and the constant `MANUAL_CAPTURE_STATUS: str = "MANUAL"`. Task 2 (`capture.py`) imports both.

- [ ] **Step 1: Write the failing tests**

Create `backend/scrape/test_manual_input.py`:

```python
"""Manual-paste reel ingestion — pure, offline, no key, no network."""
import pytest

from models.reel import ReelData
from scrape.manual_input import MANUAL_CAPTURE_STATUS, manual_reeldata


def test_manual_reeldata_caption_only_uses_manual_sentinel_url():
    reel = manual_reeldata("📍Tokyo Tower — must visit at night")
    assert isinstance(reel, ReelData)
    assert reel.caption == "📍Tokyo Tower — must visit at night"
    assert reel.capture_status == MANUAL_CAPTURE_STATUS
    assert reel.reel_url.startswith("manual:")
    assert reel.location_name is None


def test_manual_reeldata_passes_through_location():
    reel = manual_reeldata("great ramen", location_name="Ichiran, Shibuya")
    assert reel.location_name == "Ichiran, Shibuya"


def test_manual_reeldata_blank_location_becomes_none():
    # a whitespace-only location tag must NOT become a highest-confidence signal
    assert manual_reeldata("cap", location_name="   ").location_name is None


def test_manual_reeldata_reel_source_url_is_normalized_provenance():
    reel = manual_reeldata(
        "caption", source_url="https://www.instagram.com/reels/ABC123/?igsh=xx")
    assert reel.reel_url == "https://www.instagram.com/reel/ABC123"


def test_manual_reeldata_non_reel_source_url_falls_back_to_sentinel():
    reel = manual_reeldata("caption", source_url="https://www.tiktok.com/@x/video/1")
    assert reel.reel_url.startswith("manual:")


def test_manual_reeldata_is_deterministic():
    a = manual_reeldata("same text", location_name="same loc")
    b = manual_reeldata("same text", location_name="same loc")
    assert a.reel_url == b.reel_url


def test_manual_reeldata_distinct_text_distinct_url():
    assert manual_reeldata("text one").reel_url != manual_reeldata("text two").reel_url


@pytest.mark.parametrize("bad", ["", "   ", "\n\t "])
def test_manual_reeldata_blank_caption_raises(bad):
    with pytest.raises(ValueError):
        manual_reeldata(bad)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest scrape/test_manual_input.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'scrape.manual_input'`.

- [ ] **Step 3: Write the minimal implementation**

Create `backend/scrape/manual_input.py`:

```python
"""Manual-paste reel ingestion — the Apify IG-block contingency.

When Instagram block waves take the logged-out Apify actor down globally (see
scrape/probe_apify.py), the scrape stage cannot produce a ReelData. The downstream
pipeline depends only on the *text* (caption + location_name), not on where it came
from — so a human can paste the reel's caption (and optional location tag) and the
extractor runs unchanged. Posture-neutral: no scraping, no Apify token, no login.

Pure + offline: importing this module needs no key, pulls in no SDK, makes no call.
"""
from __future__ import annotations

import hashlib

from models.reel import ReelData
from scrape.reel_url import is_reel_url, normalize_reel_url

MANUAL_CAPTURE_STATUS = "MANUAL"


def manual_reeldata(
    caption: str, *, location_name: str | None = None, source_url: str | None = None
) -> ReelData:
    """Build a ReelData from manually-pasted reel text (Apify-block contingency).

    `caption` is required (the pasted reel text). `location_name` is the optional
    Instagram location tag (a blank/whitespace tag is normalized to None so it can't
    become a spurious highest-confidence signal in build_extractor_input). When
    `source_url` is a real reel URL it is normalized and used as the provenance key;
    otherwise reel_url is a deterministic `manual:<digest>` sentinel so re-pasting the
    same text is idempotent (stable cache/fixture key).

    Raises ValueError on empty/blank caption (fail fast at the boundary).
    """
    if not caption or not caption.strip():
        raise ValueError("manual capture requires non-empty caption text")
    location = (location_name or "").strip() or None  # blank tag → None
    if source_url and is_reel_url(source_url):
        reel_url = normalize_reel_url(source_url)
    else:
        digest = hashlib.sha256(
            f"{caption}\n{location or ''}".encode("utf-8")
        ).hexdigest()[:12]
        reel_url = f"manual:{digest}"
    return ReelData(
        reel_url=reel_url,
        caption=caption,
        location_name=location,
        capture_status=MANUAL_CAPTURE_STATUS,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && uv run pytest scrape/test_manual_input.py -q`
Expected: PASS (8 tests).

- [ ] **Step 5: Verify the import-time invariant (no key, no SDK)**

Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import scrape.manual_input; print('keyless import OK')"`
Expected: prints `keyless import OK` with no error.

- [ ] **Step 6: Commit**

```bash
cd backend && git add scrape/manual_input.py scrape/test_manual_input.py
git commit -m "feat(scrape): manual-paste ReelData builder (Apify IG-block contingency)"
```

---

### Task 2: Wire manual-paste into the `capture` CLI

**Files:**
- Modify: `backend/capture.py`
- Test: `backend/test_capture.py`

**Interfaces:**
- Consumes: `scrape.manual_input.manual_reeldata` (Task 1); existing `run_capture` producers.
- Produces: `run_capture(..., manual_reels: list[ReelData] | None = None)` — manual reels skip scraping and go straight to extract + ground. `capture.main()` gains `--manual-caption`, `--manual-location`, `--manual-source-url`; `--reels` becomes optional; manual-only mode requires no `APIFY_TOKEN`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/test_capture.py` (top, alongside existing imports):

```python
from scrape.manual_input import manual_reeldata
```

Append these tests to `backend/test_capture.py`:

```python
async def test_run_capture_processes_manual_reels_without_scraping():
    # manual reels skip the scrape producer entirely (it must never be called)
    async def scrape(url, *, token):
        raise AssertionError("scrape must not be called for manual reels")

    async def extract(reel):
        return [_place(reel.caption)]

    manual = [manual_reeldata("📍Senso-ji Temple in Asakusa")]
    reels, places = await capture.run_capture(
        [], token="", scrape=scrape, extract=extract, manual_reels=manual)
    assert len(reels) == 1 and reels[0].capture_status == "MANUAL"
    assert [p.name for p in places] == ["📍Senso-ji Temple in Asakusa"]


async def test_run_capture_manual_reels_grounded_via_resolver():
    async def scrape(url, *, token):
        raise AssertionError("scrape must not be called")

    async def extract(reel):
        return [_place("Cafe")]  # lat=35.6, lng=139.7

    async def resolve(place):
        return place.model_copy(update={"lat": 35.71, "lng": 139.80})

    _, places = await capture.run_capture(
        [], token="", scrape=scrape, extract=extract, resolve=resolve,
        manual_reels=[manual_reeldata("Cafe in Tokyo")])
    assert abs(places[0].lat - 35.71) < 1e-9 and abs(places[0].lng - 139.80) < 1e-9


def test_main_manual_only_does_not_require_apify_token(monkeypatch, tmp_path, capsys):
    captured = {}

    async def fake_capture(reel_urls, *, token, scrape, extract, resolve=None, manual_reels=None):
        captured["manual_reels"] = manual_reels
        captured["reel_urls"] = reel_urls
        return [_reel("manual:abc")], [_place("X")]

    monkeypatch.delenv("APIFY_TOKEN", raising=False)   # block wave: no Apify token
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    monkeypatch.setattr(capture, "run_capture", fake_capture)
    monkeypatch.setattr(capture, "_write_fixtures", lambda *a, **k: None)

    rc = capture.main([
        "--manual-caption", "📍Tokyo Tower at night",
        "--manual-location", "Tokyo Tower",
        "--out-dir", str(tmp_path),
    ])
    assert rc == 0
    assert captured["reel_urls"] == []
    assert len(captured["manual_reels"]) == 1
    assert captured["manual_reels"][0].caption == "📍Tokyo Tower at night"


def test_main_requires_at_least_one_source(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main([])  # neither --reels nor --manual-caption
    assert rc == 2
    assert "source" in capsys.readouterr().err.lower()


def test_main_reels_still_require_apify_token(monkeypatch, capsys):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main(["--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/"])
    assert rc == 2
    assert "APIFY_TOKEN" in capsys.readouterr().err


async def test_run_capture_mixed_reels_and_manual_collects_both(capsys):
    # mixed mode: scraped reels first, then manual reels, in one run; a bad scrape is tolerated
    async def scrape(url, *, token):
        if url == "bad":
            raise RuntimeError("scrape down")
        return _reel(url)  # capture_status == "CAPTURED"

    async def extract(reel):
        name = reel.reel_url if reel.capture_status == "CAPTURED" else reel.caption
        return [_place(name)]

    reels, places = await capture.run_capture(
        ["u1", "bad"], token="T", scrape=scrape, extract=extract,
        manual_reels=[manual_reeldata("Manual Spot")])
    assert [r.capture_status for r in reels] == ["CAPTURED", "MANUAL"]  # scraped first, manual after
    assert [p.name for p in places] == ["u1", "Manual Spot"]           # "bad" tolerated


async def test_run_capture_skips_reel_when_extract_fails(capsys):
    # post-refactor: extract failure drops the reel, keeps going, leaks no token (type only)
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        raise RuntimeError("extractor failed token=SECRET123")

    reels, places = await capture.run_capture(
        ["u1"], token="SECRET123", scrape=scrape, extract=extract)
    assert reels == [] and places == []
    err = capsys.readouterr().err
    assert "SECRET123" not in err and "RuntimeError" in err


def test_main_reels_provided_without_token_errors_even_with_manual(monkeypatch, capsys):
    # a --reels arg that needs scraping requires the token even alongside --manual-caption
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main([
        "--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/",
        "--manual-caption", "fallback text",
    ])
    assert rc == 2
    assert "APIFY_TOKEN" in capsys.readouterr().err


def test_main_out_dir_defaults_by_mode(monkeypatch):
    # manual-only defaults to captures/ (protects #16); scraping defaults to evals/fixtures
    seen = {}

    async def fake_capture(reel_urls, *, token, scrape, extract, resolve=None, manual_reels=None):
        return [_reel("r")], [_place("X")]

    monkeypatch.setenv("APIFY_TOKEN", "T")
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    monkeypatch.setattr(capture, "run_capture", fake_capture)
    monkeypatch.setattr(capture, "_write_fixtures",
                        lambda reels, places, out_dir: seen.__setitem__("out_dir", out_dir))

    capture.main(["--manual-caption", "Manual Spot"])                          # manual-only
    assert seen["out_dir"] == capture.CAPTURES_DEFAULT
    capture.main(["--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/"])   # scraping
    assert seen["out_dir"] == capture.EVALS_FIXTURES
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && uv run pytest test_capture.py -q`
Expected: the 9 new tests FAIL (`run_capture() got an unexpected keyword argument 'manual_reels'`, `AttributeError: ... CAPTURES_DEFAULT`, and `main` rejects manual-only / doesn't accept the new flags). Existing tests still pass.

- [ ] **Step 3: Add the manual-paste import and extract the shared per-reel helper**

In `backend/capture.py`, add the import near the other `scrape` imports (top level — `manual_input` is pure/keyless):

```python
from scrape.manual_input import manual_reeldata
```

Replace the body of `run_capture` (the current `for url in reel_urls:` loop) by first extracting a shared helper, then rewriting `run_capture` to call it for both scraped and manual reels:

```python
def _log_skip(label: str, exc: Exception) -> None:
    """Token-safe skip log. `ApifyScrapeError` is defined token-safe, so its detail is
    printed; every other exception is logged by TYPE only (its message may carry a
    token). Used for both scrape and extract failures so the rule is uniform."""
    detail = str(exc) if isinstance(exc, ApifyScrapeError) else type(exc).__name__
    print(f"  [skip] {label}: {detail}", file=sys.stderr)


async def _collect_reel(
    reel: ReelData, *, extract, resolve, reels: list[ReelData],
    places: list[PlaceResult], tag: str, label: str,
) -> None:
    """Extract places from one reel (any source), ground each via `resolve`, then
    print + collect. Extract and geocode failures are tolerated and never leak the
    token (see _log_skip)."""
    try:
        reel_places = await extract(reel)
    except Exception as exc:  # extract failure — keep going (token-safe log)
        _log_skip(label, exc)
        return
    reels.append(reel)
    print(f"  [{tag}] {label}: {len(reel_places)} place(s)")
    for place in reel_places:
        original_coords = (place.lat, place.lng)  # snapshot before resolve (mutating-resolver safe)
        try:
            grounded = await resolve(place)  # Mapbox grounds the coords
        except Exception as exc:  # a geocode failure must NEVER lose the place
            print(f"  [geocode-skip] {place.name}: {type(exc).__name__}", file=sys.stderr)
            grounded = place
        moved = (grounded.lat, grounded.lng) != original_coords
        places.append(grounded)
        print(_format_place(grounded, coords_src="mapbox" if moved else "llm"))


async def run_capture(
    reel_urls: list[str], *, token: str, scrape, extract, resolve=None,
    manual_reels: list[ReelData] | None = None,
) -> tuple[list[ReelData], list[PlaceResult]]:
    """Scrape + extract each reel, then ground each place's coords via `resolve`.

    `manual_reels` are pre-built ReelData from pasted text (the Apify IG-block
    contingency) — they skip scraping (no token used) and go straight to extract +
    ground via the SAME path as scraped reels. `scrape(url, token=...)` -> ReelData ;
    `extract(reel)` -> list[PlaceResult] ; `resolve` is an async `(place) -> PlaceResult`
    (default: identity no-op). Per-reel AND per-place failures are tolerated and skipped
    (never the token). Producers are injected so this is offline-testable.
    """
    resolve = resolve or _identity_resolve
    reels: list[ReelData] = []
    places: list[PlaceResult] = []
    for url in reel_urls:
        try:
            reel = await scrape(url, token=token)
        except Exception as exc:  # per-reel scrape tolerance — keep going (token-safe log)
            _log_skip(url, exc)
            continue
        await _collect_reel(reel, extract=extract, resolve=resolve,
                            reels=reels, places=places, tag="ok", label=url)
    for reel in manual_reels or []:  # Apify-block contingency: no scrape, no token
        await _collect_reel(reel, extract=extract, resolve=resolve,
                            reels=reels, places=places, tag="manual", label=reel.reel_url)
    return reels, places
```

(`_log_skip` centralizes the token-safety rule — `ApifyScrapeError` detail is safe to
print, everything else is type-only — so the refactor reproduces today's behavior on
BOTH the scrape and extract error paths, including the theoretical extract-raises-
`ApifyScrapeError` edge. The `[ok]`/`[manual]` line uses a single space after the tag;
no test asserts the old 3-space `[ok]` spacing.)

- [ ] **Step 4: Update `main()` — new flags, optional `--reels`, conditional token, mode-aware out-dir**

In `backend/capture.py`, add the manual-mode default output dir next to `EVALS_FIXTURES` (module top):

```python
CAPTURES_DEFAULT = Path(__file__).parent / "captures"  # gitignored; manual-only default
```

Then update the argparse block in `main()`:

```python
    parser = argparse.ArgumentParser(description="Opt-in live capture → refresh offline fixtures")
    parser.add_argument("--reels", help="comma-separated reel URLs (scraped via Apify)")
    parser.add_argument("--manual-caption",
                        help="paste a reel caption when Apify is IG-blocked (no scrape, no Apify token)")
    parser.add_argument("--manual-location", help="optional Instagram location tag for --manual-caption")
    parser.add_argument("--manual-source-url", help="optional source reel URL for --manual-caption provenance")
    parser.add_argument("--out-dir", default=None,
                        help="output dir (default: evals/fixtures when scraping, captures/ for manual-only)")
    parser.add_argument("--include-transcript", action="store_true")
    args = parser.parse_args(argv)
```

Replace the env-check + URL-parsing section so the Apify token is required **only** when scraping, and a manual source needs no Apify token. The new ordering in `main()` after `load_dotenv(find_dotenv())`:

```python
    # Parse scrape URLs (optional) and build the optional manual-paste reel.
    urls: list[str] = []
    if args.reels:
        for raw in args.reels.split(","):
            raw = raw.strip()
            if not raw:
                continue
            try:
                urls.append(normalize_reel_url(raw))
            except ValueError:
                print(f"  [skip] not a reel URL: {raw}", file=sys.stderr)

    manual_reels: list[ReelData] = []
    if args.manual_caption:
        manual_reels.append(manual_reeldata(
            args.manual_caption,
            location_name=args.manual_location,
            source_url=args.manual_source_url,
        ))

    if not urls and not manual_reels:
        print("capture needs a source: --reels <url,...> or --manual-caption <text>.", file=sys.stderr)
        return 2
    if not os.environ.get("OPENAI_API_KEY"):
        print("capture needs OPENAI_API_KEY in the environment (the extractor runs).", file=sys.stderr)
        return 2
    token = os.environ.get("APIFY_TOKEN")
    # Key the token requirement off the --reels INPUT (args.reels), NOT the normalized
    # `urls`, so a malformed --reels arg can't silently drop the scrape request and let
    # the run proceed manual-only without a token.
    if args.reels and not token:
        print("capture needs APIFY_TOKEN to scrape reels (use --manual-caption alone during an IG block).",
              file=sys.stderr)
        return 2

    # Output dir: scraping refreshes the committed #16 baseline (evals/fixtures); a
    # manual-only run defaults to the gitignored captures/ dir so a stray paste cannot
    # clobber the baseline. An explicit --out-dir always wins (use --out-dir evals/fixtures
    # to refresh #16 from manual paste during a full block wave).
    if args.out_dir is not None:
        out_dir = Path(args.out_dir)
    elif urls:
        out_dir = EVALS_FIXTURES
    else:
        out_dir = CAPTURES_DEFAULT

    # The extractor runs for BOTH scraped and manual reels, so it is always imported.
    # scrape_reel is imported inside _scrape below, so a manual-only run never reaches
    # the Apify call path. (`scrape.apify_direct` is already imported at module top for
    # ApifyScrapeError, so this is call-path clarity, not import cost.)
    from genagents.place_extractor import extract_places
```

Keep the existing Mapbox-resolve block. Change the `_scrape` closure to import
`scrape_reel` lazily (so a manual-only run never touches it):

```python
    async def _scrape(url, *, token):
        from scrape.apify_direct import scrape_reel
        return await scrape_reel(url, token=token, include_transcript=args.include_transcript)
```

Update the `run_capture` call to pass `manual_reels`, and the fixture-writing block to
use the resolved `out_dir`:

```python
    reels, places = asyncio.run(
        run_capture(urls, token=token or "", scrape=_scrape, extract=extract_places,
                    resolve=resolve, manual_reels=manual_reels))
    if not reels:
        print("captured 0 reels; not writing empty fixtures.", file=sys.stderr)
        return 1
    _write_fixtures(reels, places, out_dir)
    print(f"captured {len(reels)} reel(s), {len(places)} place(s) -> {out_dir}")
    return 0
```

(The old `--reels`-required parsing block and the old combined `token`/`OPENAI_API_KEY`
check are removed — replaced by the blocks above. `_scrape` is only called for `urls`,
so `token or ""` is unused in manual-only mode.)

Update the module docstring usage line to document manual mode:

```python
    python -m capture --reels <url,url,...> [--out-dir evals/fixtures] [--include-transcript]
    python -m capture --manual-caption "<pasted caption>" [--manual-location "<tag>"] \
        [--manual-source-url <reel url>]   # Apify IG-block contingency: no scrape, no Apify token
                                           # manual-only writes to captures/ by default;
                                           # pass --out-dir evals/fixtures to refresh #16
```

- [ ] **Step 5: Run the full capture test file**

Run: `cd backend && uv run pytest test_capture.py -q`
Expected: PASS — the 9 new tests plus all pre-existing tests (no regressions).

- [ ] **Step 6: Verify the import-time invariant still holds**

Run: `cd backend && env -u OPENAI_API_KEY -u APIFY_TOKEN -u MAPBOX_SECRET_TOKEN uv run python -c "import capture; print('keyless import OK')"`
Expected: prints `keyless import OK`.

- [ ] **Step 7: Run the whole offline suite + the eval gate (no regressions, eval green)**

Run: `cd backend && uv run pytest -q`
Expected: all offline tests pass, 1 live test skipped (the existing `@pytest.mark.live` extractor test).

Run: `cd backend && uv run python -m evals.run_eval --subject baseline && uv run python -m evals.run_eval --subject pipeline`
Expected: both report `OVERALL: PASS` (the `#16` eval is unaffected).

- [ ] **Step 8: Commit**

```bash
cd backend && git add capture.py test_capture.py
git commit -m "feat(capture): manual-paste mode for Apify IG-block contingency"
```

---

## Manual verification (human, optional — live)

These are **not** part of the automated suite (they hit OpenAI). Run only to confirm the end-to-end manual path during/after a block wave:

```bash
# Manual-only — needs OPENAI_API_KEY (and optionally MAPBOX_SECRET_TOKEN); NO Apify token.
# Manual-only defaults to captures/ (gitignored), so the #16 baseline is never touched.
cd backend && uv run python -m capture \
  --manual-caption "📍Tokyo Tower — go at sunset, then ramen at 📍Ichiran Shibuya" \
  --manual-location "Tokyo Tower"
```
Expected: `[manual] manual:<digest>: N place(s)` then per-place lines with `coords=llm` (or `coords=mapbox` if a name resolves), and `captured 1 reel(s), N place(s) -> .../captures`.

## Rollback / risk

- **Blast radius:** one new pure module + additive changes to `capture.py`/`test_capture.py`. No change to the scrape path, extractor, models, pipeline, or eval. Revert = drop the two commits.
- **Risk:** Low. Behavioral changes to existing code: the `run_capture` refactor (shared `_collect_reel` + token-safe `_log_skip` helper), `main()`'s now-conditional Apify-token check (keyed off `args.reels`), and the mode-aware `--out-dir` default (manual-only → gitignored `captures/`; scraping → `evals/fixtures`, unchanged). All covered by existing + new tests. `_log_skip` keeps the `ApifyScrapeError`-detail-vs-type-only token safety identical to today on both error paths. The `[ok]`-line print spacing changes cosmetically (single space after the tag); no test asserts the old spacing.
- **Forward note:** when the live `/generate-trip` endpoint + frontend exist, the user-facing "paste caption" UX reuses `manual_reeldata` as its backend seam — no rework expected.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 8 findings (2×P1, 4×P2, 2×P3) — all folded or decided |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 1 arch finding + 2 test gaps; scope accepted as minimal |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** P1 fixture-clobber → manual-only now defaults to the gitignored `captures/` (explicit `--out-dir evals/fixtures` to touch the #16 baseline). P1 single-caption → kept single `--manual-caption` + mixing with `--reels` (feasible-first, your call). 6 hardening items folded: token requirement keyed off `args.reels` (not normalized URLs), `_log_skip` preserves `ApifyScrapeError`-vs-type-only token safety on both error paths, blank `location_name` → `None`, lazy `scrape_reel` import, mixed-mode regression test, extract-failure test.
- **CROSS-MODEL:** Codex and the eng review independently raised the single-`--manual-caption` limitation — agreement, no tension. You chose the feasible-first side (single + mixing).
- **VERDICT:** ENG CLEARED — ready to implement. Scope accepted as minimal (manual-paste only). All 8 Codex findings + 3 eng-review findings folded or explicitly decided; 0 critical gaps.

NO UNRESOLVED DECISIONS
