"""Is a reel already read? READ-ONLY — tells you what a generation will actually cost.

A cache hit at the CURRENT extractor version skips both the Apify scrape and the daily
analysis quota charge (organizer.py's `if places is None:` guard, and runner.py's
per-reel cache lookup). A miss is a real Apify call and a real quota slot.

    cd backend && uv run python -m scripts.check_reel_cache <url> [<url> ...]
"""
from __future__ import annotations
import asyncio, os, sys

if not os.environ.get("SUPABASE_URL"):
    from dotenv import find_dotenv, load_dotenv
    load_dotenv(find_dotenv(usecwd=True))


async def main(urls: list[str]) -> int:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from supabase_client import get_supabase_client
    from genagents.place_extractor import EXTRACTOR_VERSION
    from scrape.reel_url import normalize_reel_url

    c = await get_supabase_client()
    print(f"extractor version: {EXTRACTOR_VERSION}\n")
    hits = 0
    for raw in urls:
        try:
            key = normalize_reel_url(raw)
        except ValueError:
            print(f"  INVALID      {raw}")
            continue
        rows = (await c.table("reel_cache")
                .select("extractor_version, extracted_places")
                .eq("normalized_url", key).execute()).data or []
        cur = [r for r in rows if r.get("extractor_version") == EXTRACTOR_VERSION
               and isinstance(r.get("extracted_places"), list)]
        if cur:
            hits += 1
            print(f"  CACHED  {len(cur[0]['extracted_places']):>3} places   {key}")
        elif rows:
            print(f"  STALE   re-scrape needed  {key}  (cached at {rows[0].get('extractor_version')})")
        else:
            print(f"  MISS    will scrape       {key}")
    n = len(urls)
    print(f"\n  {hits}/{n} cached -> {n - hits} Apify call(s) and {n - hits} analysis quota slot(s)")
    return 0


if len(sys.argv) < 2:
    print(__doc__)
    raise SystemExit(2)
raise SystemExit(asyncio.run(main(sys.argv[1:])))
