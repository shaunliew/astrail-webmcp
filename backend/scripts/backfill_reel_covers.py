"""One-time backfill of NULL `reel_cache.thumbnail_url` covers (migration 20260731120000 companion).

Existing `reel_cache` rows predate the cover wiring, so their `thumbnail_url` is NULL. Each row is
repaired POINTER-FIRST (decision B): if the row carries a saved `raw_payload.display_url`, re-host from
THAT into the public `reel-covers` Storage bucket — a FREE repair, NO Apify call. Only a row with no
saved pointer, or whose saved pointer has expired (re-host returns None), falls back to a fresh Apify
scrape → fresh `displayUrl` → re-host (refreshing the saved pointer). The stable public URL is written
back via a compare-and-set (still-NULL) update.

SPENDS APIFY CREDITS only on the re-scrape fallback. It therefore REFUSES to run without an explicit
`--confirm`, and a `--dry-run` COUNTS the NULL rows without scraping (no credits). On the confirmed run
it FIRST verifies the `reel-covers` bucket exists (preflight) and aborts non-zero if it does not, so a
backend-first deploy never scrapes every row only to fail every upload. Re-runnable and idempotent:
only still-NULL rows are ever touched.

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
BUCKET = "reel-covers"
_BATCH_SIZE = 100
_CONCURRENCY = 4

_REFUSE_MSG = (
    "refusing: this re-scrapes every NULL-cover reel through Apify and SPENDS APIFY CREDITS "
    "(one actor run per row). Use --dry-run to COUNT the affected rows without spending, then re-run "
    "with --confirm to proceed."
)

_BUCKET_MISSING_MSG = (
    f"{BUCKET} bucket not found — apply migration 20260731120000 first; "
    "aborting before spending Apify credits"
)


async def _bucket_exists(client) -> bool:
    """Preflight: does the `reel-covers` bucket exist? Verified on the confirmed run BEFORE any Apify
    scrape so a backend-first deploy (bucket not yet created) aborts without spending a single credit,
    rather than scraping every row and then failing every upload."""
    buckets = await client.storage.list_buckets()
    return any(getattr(b, "id", None) == BUCKET or getattr(b, "name", None) == BUCKET for b in buckets)


def _null_query(client, cursor: str, batch_size: int):
    """The keyset page of NULL-cover Instagram rows after `cursor`, ordered by `normalized_url`.

    Selects `raw_payload` alongside `normalized_url` so each row carries its saved `display_url` repair
    pointer (decision B — repair from the saved URL without a re-scrape). The strict `> cursor` bound is
    added only when `cursor` is set; the first page is unbounded below."""
    query = (
        client.table(TABLE)
        .select("normalized_url, raw_payload")
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


async def _write_cover(client, normalized_url: str, thumbnail_url: str, display_url: str) -> None:
    """Compare-and-set the cover: write ONLY while the row is still NULL (`thumbnail_url IS NULL`), so a
    row covered concurrently — e.g. by the organize job — between page-selection and here is never
    clobbered. Also (re)writes the `raw_payload.display_url` repair pointer to the URL that succeeded."""
    await (
        client.table(TABLE)
        .update({"thumbnail_url": thumbnail_url, "raw_payload": {"display_url": display_url}})
        .eq("normalized_url", normalized_url)
        .is_("thumbnail_url", "null")
        .execute()
    )


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
    """Repair one row's cover, updating it on success. Never raises: a bad row is counted and isolated
    so it can never abort the run. Outcomes: done (re-hosted + written) / failed (scrape raised or
    re-host returned None) / skipped (the reel exposes no cover to re-host).

    POINTER-FIRST (decision B): if the row carries a saved `raw_payload.display_url`, re-host from THAT
    first — a FREE repair, no Apify call. Only if there is no saved pointer, or the saved pointer's
    re-host returns None (expired CDN URL → 4xx), fall back to a fresh Apify scrape and re-host the fresh
    `display_url` (refreshing the saved pointer). Both success paths share the `done` tally."""
    normalized_url = row["normalized_url"]
    cover_key = _cover_key(normalized_url)
    async with semaphore:
        try:
            saved_display_url = (row.get("raw_payload") or {}).get("display_url")
            if saved_display_url:
                thumbnail_url = await rehost(client, saved_display_url, cover_key)
                if thumbnail_url:
                    await _write_cover(client, normalized_url, thumbnail_url, saved_display_url)
                    async with lock:
                        tally["done"] += 1
                    print(f"  [backfill] repaired {normalized_url} from saved pointer (no Apify)", file=sys.stderr)
                    return

            reel = await scrape(normalized_url, token=token)
            display_url = getattr(reel, "display_url", None)
            if not display_url:
                async with lock:
                    tally["skipped"] += 1
                return
            thumbnail_url = await rehost(client, display_url, cover_key)
            if not thumbnail_url:
                async with lock:
                    tally["failed"] += 1
                return
            await _write_cover(client, normalized_url, thumbnail_url, display_url)
            async with lock:
                tally["done"] += 1
            print(f"  [backfill] repaired {normalized_url} via re-scrape", file=sys.stderr)
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


def _positive_int(value: str) -> int:
    """argparse `type=` helper: reject non-positive ints. `--concurrency 0` would build `Semaphore(0)`
    (every row blocks forever); a zero/negative `--batch-size` would never make keyset progress."""
    ivalue = int(value)
    if ivalue <= 0:
        raise argparse.ArgumentTypeError(f"must be a positive integer, got {value!r}")
    return ivalue


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
    parser.add_argument("--batch-size", type=_positive_int, default=_BATCH_SIZE, help="keyset page size (positive)")
    parser.add_argument("--concurrency", type=_positive_int, default=_CONCURRENCY, help="max concurrent rows (positive)")
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

    if not await _bucket_exists(client):                 # preflight BEFORE spending any Apify credits
        print(_BUCKET_MISSING_MSG, file=sys.stderr)
        return 3

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
