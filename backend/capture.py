"""Opt-in LIVE capture: scrape reels (Apify) + extract places (LLM) + ground coords
(Mapbox) → refresh offline fixtures.

LIVE — needs OPENAI_API_KEY. Scraping also needs APIFY_TOKEN. Set MAPBOX_SECRET_TOKEN
(server-side `sk`, Search Box scope; the public `pk` is frontend-only) to ground each
place's coords + address via the Mapbox Search Box /forward API; without it, capture
keeps the LLM coords and warns. NEVER run by the test suite (the unit test injects fake
producers; the live producers + keys are loaded only in main()).
Run by a human to refresh evals/fixtures/* from real reels, or build manual fixtures
during an IG block wave:

    python -m capture --reels <url,url,...> [--out-dir evals/fixtures] [--include-transcript]
    python -m capture --manual-caption "<pasted caption>" [--manual-location "<tag>"] \
        [--manual-source-url <reel url>]   # Apify IG-block contingency: no scrape, no Apify token
                                           # manual-only writes to captures/ by default;
                                           # pass --out-dir evals/fixtures to refresh #16

Importing this module pulls in no SDK, needs no key, and makes no call.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from geocode.mapbox_forward import TOKYO
from models.place import PlaceResult
from models.reel import ReelData
from pipeline.geo import haversine_m
from pipeline.sources import record_fixture
from scrape.apify_direct import ApifyScrapeError
from scrape.manual_input import manual_reeldata
from scrape.reel_url import normalize_reel_url

EVALS_FIXTURES = Path(__file__).parent / "evals" / "fixtures"
CAPTURES_DEFAULT = Path(__file__).parent / "captures"  # gitignored; manual-only default

# Beta geo-policy: Astrail v1 targets Japan → bias proximity to Tokyo and filter to JP.
# The query LANGUAGE is per-place (geocode.policy detects it from the query's script).
# SCALING (multi-country): derive country + proximity from the trip destination
# (see docs/superpowers/plans/2026-06-29-mapbox-coord-authority-name-local.md "Scalability").
BETA_COUNTRY = "jp"
BETA_PROXIMITY = TOKYO


async def _identity_resolve(place: PlaceResult) -> PlaceResult:
    """Default no-op resolver — keeps the place's existing (LLM) coords. Used in tests
    and whenever MAPBOX_SECRET_TOKEN is absent, so capture works without Mapbox."""
    return place


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
        if moved and None not in original_coords and grounded.lat is not None and grounded.lng is not None:
            d = haversine_m(original_coords[0], original_coords[1], grounded.lat, grounded.lng)
            print(f"           llm-coords: {original_coords[0]:.4f},{original_coords[1]:.4f}"
                  f"  (Δ {d:.0f} m from mapbox)", file=sys.stderr)


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


def _format_place(p: PlaceResult, coords_src: str = "llm") -> str:
    """A readable multi-line summary of one extracted place (for human inspection)."""
    coords = f"{p.lat:.4f},{p.lng:.4f}" if (p.lat is not None and p.lng is not None) else "no-coords"
    return (
        f"         - {p.name}  [{p.category}]  @ {coords} (coords={coords_src})  conf={p.confidence}\n"
        f"           evidence: {p.evidence_quote!r}\n"
        f"           source:   {p.source_url or '(none)'}"
    )


def _write_fixtures(reels: list[ReelData], places: list[PlaceResult], out_dir: Path) -> None:
    record_fixture(out_dir / "japan_demo_reels.json", "reels", [r.model_dump() for r in reels])
    record_fixture(out_dir / "expected_places.json", "places", [p.model_dump() for p in places])


def main(argv: list[str] | None = None) -> int:
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

    # Load backend/.env (the documented key location). Lazy (here, not at import) so
    # `import capture` stays keyless — the import-time invariant.
    from dotenv import find_dotenv, load_dotenv
    load_dotenv(find_dotenv())

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

    manual_reels_arg: list[ReelData] = []
    if args.manual_caption:
        manual_reels_arg.append(manual_reeldata(
            args.manual_caption,
            location_name=args.manual_location,
            source_url=args.manual_source_url,
        ))

    if not urls and not manual_reels_arg:
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

    # Mapbox coord resolution — authoritative coords for surviving places. Only wired
    # when the token is present; without it we warn and keep the LLM coords (graceful).
    mapbox_token = os.environ.get("MAPBOX_SECRET_TOKEN")
    resolve = None
    if mapbox_token:
        from geocode.mapbox_forward import apply_geocode, forward_geocode
        from geocode.policy import geocode_query

        async def _resolve(place: PlaceResult) -> PlaceResult:
            query, language = geocode_query(place)
            geo = await forward_geocode(query, token=mapbox_token, language=language,
                                        country=BETA_COUNTRY, proximity_lng_lat=BETA_PROXIMITY)
            return apply_geocode(place, geo)
        resolve = _resolve
    else:
        print("MAPBOX_SECRET_TOKEN not set — skipping Mapbox coord resolution "
              "(keeping LLM coords).", file=sys.stderr)

    async def _scrape(url: str, *, token: str) -> ReelData:
        from scrape.apify_direct import scrape_reel
        return await scrape_reel(url, token=token, include_transcript=args.include_transcript)

    reels, places = asyncio.run(
        run_capture(urls, token=token or "", scrape=_scrape, extract=extract_places,
                    resolve=resolve, manual_reels=manual_reels_arg))
    if not reels:
        print("captured 0 reels; not writing empty fixtures.", file=sys.stderr)
        return 1
    _write_fixtures(reels, places, out_dir)
    print(f"captured {len(reels)} reel(s), {len(places)} place(s) -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
