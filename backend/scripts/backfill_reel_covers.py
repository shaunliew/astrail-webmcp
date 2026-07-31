"""One-time backfill of NULL `reel_cache.thumbnail_url` covers (migration 20260731120000 companion).

Existing `reel_cache` rows predate the cover wiring, so their `thumbnail_url` is NULL and their raw
Apify `displayUrl` has long expired. This re-scrapes each such reel through Apify to obtain a FRESH
`displayUrl`, re-hosts it into the public `reel-covers` Storage bucket, and writes the stable public URL
(plus the `display_url` repair pointer in `raw_payload`) back to the row.

SPENDS APIFY CREDITS (one actor run per NULL reel). It therefore REFUSES to run without an explicit
`--confirm`, and a `--dry-run` COUNTS the NULL rows without scraping (no credits). Re-runnable and
idempotent: only still-NULL rows are ever touched.

PAGINATION — keyset, not offset and not drain-the-first-page. Each page selects
`where thumbnail_url is null and source_platform='instagram' and normalized_url > :cursor
 order by normalized_url limit N`, then advances `cursor` to the last `normalized_url` of the batch.
Because the cursor advances PAST every processed row — success OR persistent failure — a row that can
never be re-hosted is attempted exactly once and never re-fetched, so the loop always terminates.
(Offset pagination would skip rows: updated rows fall out of the NULL set and shift later offsets.
Draining the first NULL page would loop forever on a stuck row.)

Import stays keyless: `_cover_key` (pure) is imported at module scope; the service-role client, the
Apify scraper, and `rehost_cover` are imported lazily inside the run body, and `APIFY_TOKEN` is read
only on the confirmed run. So this module imports with no env set (guardrail #16).

Usage (from backend/):
    uv run --env-file .env python -m scripts.backfill_reel_covers --dry-run   # count NULL rows, no credits
    uv run --env-file .env python -m scripts.backfill_reel_covers             # refuses, prints how to confirm
    uv run --env-file .env python -m scripts.backfill_reel_covers --confirm   # re-scrapes + re-hosts (SPENDS credits)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections.abc import Awaitable, Callable

from pipeline.cache import _cover_key

TABLE = "reel_cache"
_BATCH_SIZE = 100
_CONCURRENCY = 4

_REFUSE_MSG = (
    "refusing: this re-scrapes every NULL-cover reel through Apify and SPENDS APIFY CREDITS "
    "(one actor run per row). Use --dry-run to COUNT the affected rows without spending, then re-run "
    "with --confirm to proceed."
)


def _null_query(client, cursor: str, batch_size: int):
    """The keyset page of NULL-cover Instagram rows after `cursor`, ordered by `normalized_url`.

    The strict `> cursor` bound is added only when `cursor` is set; the first page is unbounded below."""
    query = (
        client.table(TABLE)
        .select("normalized_url")
        .is_("thumbnail_url", "null")
        .eq("source_platform", "instagram")
    )
    if cursor:
        query = query.gt("normalized_url", cursor)
    return query.order("normalized_url").limit(batch_size)


async def _count_null(client) -> int:
    """Count NULL-cover Instagram rows without transferring any row bodies (dry-run; no credits)."""
    resp = await (
        client.table(TABLE)
        .select("normalized_url", count="exact", head=True)
        .is_("thumbnail_url", "null")
        .eq("source_platform", "instagram")
        .execute()
    )
    return resp.count or 0


async def _process_row(
    client,
    row: dict,
    *,
    scrape,
    rehost,
    token: str,
    tally: dict[str, int],
    lock: asyncio.Lock,
    semaphore: asyncio.Semaphore,
) -> None:
    """Re-scrape + re-host one row's cover, updating it on success. Never raises: a bad row is counted
    and isolated so it can never abort the run. Outcomes: done (re-hosted + written) / failed (scrape
    raised or re-host returned None) / skipped (the reel exposes no cover to re-host)."""
    normalized_url = row["normalized_url"]
    async with semaphore:
        try:
            reel = await scrape(normalized_url, token=token)
            display_url = getattr(reel, "display_url", None)
            if not display_url:
                async with lock:
                    tally["skipped"] += 1
                return
            thumbnail_url = await rehost(client, display_url, _cover_key(normalized_url))
            if not thumbnail_url:
                async with lock:
                    tally["failed"] += 1
                return
            await (
                client.table(TABLE)
                .update({"thumbnail_url": thumbnail_url, "raw_payload": {"display_url": display_url}})
                .eq("normalized_url", normalized_url)
                .execute()
            )
            async with lock:
                tally["done"] += 1
        except Exception as exc:  # noqa: BLE001 — isolate one bad row; log the type only (token-safe)
            async with lock:
                tally["failed"] += 1
            print(f"  [backfill] failed {normalized_url}: {type(exc).__name__}", file=sys.stderr)


async def run_backfill(
    client,
    *,
    scrape,
    rehost,
    token: str,
    batch_size: int = _BATCH_SIZE,
    concurrency: int = _CONCURRENCY,
) -> dict[str, int]:
    """Keyset-paginate every NULL-cover Instagram row, re-hosting each cover with bounded concurrency.
    Returns a `{done, failed, skipped}` tally. Terminates because the cursor advances past every row."""
    tally = {"done": 0, "failed": 0, "skipped": 0}
    lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(concurrency)
    cursor = ""
    while True:
        batch = (await _null_query(client, cursor, batch_size).execute()).data or []
        if not batch:
            break
        await asyncio.gather(
            *(
                _process_row(
                    client, row, scrape=scrape, rehost=rehost, token=token,
                    tally=tally, lock=lock, semaphore=semaphore,
                )
                for row in batch
            )
        )
        cursor = batch[-1]["normalized_url"]   # advance PAST every processed row (success OR failure)
    return tally


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="backfill_reel_covers",
        description="Backfill NULL reel_cache.thumbnail_url by re-scraping + re-hosting reel covers (SPENDS Apify credits).",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="required to actually run — re-scrapes every NULL-cover reel and SPENDS Apify credits",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="only COUNT the NULL-cover rows; no scrape, no credits, no writes",
    )
    parser.add_argument("--batch-size", type=int, default=_BATCH_SIZE, help="keyset page size")
    parser.add_argument("--concurrency", type=int, default=_CONCURRENCY, help="max concurrent rows")
    return parser.parse_args(argv)


async def _resolve_client(client_factory: Callable[[], Awaitable] | None):
    """The injected client (tests) or the lazily-imported service-role client (production, keyless import)."""
    if client_factory is None:
        from supabase_client import get_supabase_client

        client_factory = get_supabase_client
    return await client_factory()


async def main(
    argv: list[str] | None = None,
    *,
    client_factory: Callable[[], Awaitable] | None = None,
    scrape=None,
    rehost=None,
    token: str | None = None,
) -> int:
    """Return an exit code. `--dry-run` counts (safe, no credits); a bare run refuses (non-zero) before
    building any client; `--confirm` runs the backfill. `client_factory`/`scrape`/`rehost`/`token` are
    injected in tests; in production they default to the service-role client, the Apify scraper,
    `rehost_cover`, and `$APIFY_TOKEN` (all imported/read lazily so this module imports keyless)."""
    args = _parse_args(argv)

    if args.dry_run:
        client = await _resolve_client(client_factory)
        count = await _count_null(client)
        print(
            f"[backfill] dry-run: {count} reel_cache rows have NULL thumbnail_url (instagram). "
            "No scrape, no Apify credits spent.",
            file=sys.stderr,
        )
        return 0

    if not args.confirm:
        print(_REFUSE_MSG, file=sys.stderr)
        return 2

    if scrape is None:
        from scrape.apify_direct import scrape_reel

        scrape = scrape_reel
    if rehost is None:
        from pipeline.thumbnails import rehost_cover

        rehost = rehost_cover
    if token is None:
        token = os.environ["APIFY_TOKEN"]

    client = await _resolve_client(client_factory)
    print("Backfilling NULL reel covers (re-scraping via Apify — this SPENDS credits)…", file=sys.stderr)
    tally = await run_backfill(
        client, scrape=scrape, rehost=rehost, token=token,
        batch_size=args.batch_size, concurrency=args.concurrency,
    )
    print(
        f"[backfill] complete: done={tally['done']} failed={tally['failed']} skipped={tally['skipped']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
