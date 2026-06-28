"""Opt-in LIVE capture: scrape reels (Apify) + extract places (LLM) → refresh offline fixtures.

LIVE — needs APIFY_TOKEN + OPENAI_API_KEY. NEVER run by the test suite (the unit
test injects fake producers; the live producers + keys are loaded only in main()).
Run by a human to refresh evals/fixtures/* from real reels:

    python -m capture --reels <url,url,...> [--out-dir evals/fixtures] [--include-transcript]

Importing this module pulls in no SDK, needs no key, and makes no call.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from models.place import PlaceResult
from models.reel import ReelData
from pipeline.sources import record_fixture
from scrape.reel_url import normalize_reel_url

EVALS_FIXTURES = Path(__file__).parent / "evals" / "fixtures"


async def run_capture(
    reel_urls: list[str], *, token: str, scrape, extract
) -> tuple[list[ReelData], list[PlaceResult]]:
    """Scrape + extract each reel; per-reel errors are logged and skipped (never the token).

    `scrape(url, token=...)` -> ReelData ; `extract(reel)` -> list[PlaceResult].
    Producers are injected so this is offline-testable. Returns (reels, places).
    """
    reels: list[ReelData] = []
    places: list[PlaceResult] = []
    for url in reel_urls:
        try:
            reel = await scrape(url, token=token)
            reel_places = await extract(reel)
        except Exception as exc:  # per-reel tolerance — keep going.
            # Log the URL + error TYPE only; the exception MESSAGE may carry the token.
            print(f"  [skip] {url}: {type(exc).__name__}", file=sys.stderr)
            continue
        reels.append(reel)
        places.extend(reel_places)
        print(f"  [ok]   {url}: {len(reel_places)} place(s)")
        for p in reel_places:
            print(_format_place(p))
    return reels, places


def _format_place(p: PlaceResult) -> str:
    """A readable multi-line summary of one extracted place (for human inspection)."""
    coords = f"{p.lat:.4f},{p.lng:.4f}" if (p.lat is not None and p.lng is not None) else "no-coords"
    return (
        f"         - {p.name}  [{p.category}]  @ {coords}  conf={p.confidence}\n"
        f"           evidence: {p.evidence_quote!r}\n"
        f"           source:   {p.source_url or '(none)'}"
    )


def _write_fixtures(reels: list[ReelData], places: list[PlaceResult], out_dir: Path) -> None:
    record_fixture(out_dir / "japan_demo_reels.json", "reels", [r.model_dump() for r in reels])
    record_fixture(out_dir / "expected_places.json", "places", [p.model_dump() for p in places])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Opt-in live capture → refresh offline fixtures")
    parser.add_argument("--reels", required=True, help="comma-separated reel URLs")
    parser.add_argument("--out-dir", default=str(EVALS_FIXTURES))
    parser.add_argument("--include-transcript", action="store_true")
    args = parser.parse_args(argv)

    # Load backend/.env (the documented key location). Lazy (here, not at import) so
    # `import capture` stays keyless — the import-time invariant.
    from dotenv import find_dotenv, load_dotenv
    load_dotenv(find_dotenv())

    token = os.environ.get("APIFY_TOKEN")
    if not token or not os.environ.get("OPENAI_API_KEY"):
        print("capture needs APIFY_TOKEN + OPENAI_API_KEY in the environment.", file=sys.stderr)
        return 2

    # Live producers imported here only (keeps `import capture` SDK-free + keyless).
    from genagents.place_extractor import extract_places
    from scrape.apify_direct import scrape_reel

    urls: list[str] = []
    for raw in args.reels.split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            urls.append(normalize_reel_url(raw))
        except ValueError:
            print(f"  [skip] not a reel URL: {raw}", file=sys.stderr)
    if not urls:
        print("no valid reel URLs given.", file=sys.stderr)
        return 2

    async def _scrape(url, *, token):
        return await scrape_reel(url, token=token, include_transcript=args.include_transcript)

    reels, places = asyncio.run(
        run_capture(urls, token=token, scrape=_scrape, extract=extract_places))
    _write_fixtures(reels, places, Path(args.out_dir))
    print(f"captured {len(reels)} reel(s), {len(places)} place(s) -> {args.out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
