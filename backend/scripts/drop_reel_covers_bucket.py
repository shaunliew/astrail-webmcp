"""Rollback helper for the `reel-covers` Storage bucket (migration 20260731120000).

The migration is pure-additive (it only creates the public bucket), so it ships NO SQL
rollback: a `delete from storage.objects` would leave the physical objects ORPHANED in the
storage backend (Supabase warns of exactly this). The supported revert is to EMPTY the bucket
then DELETE it through the Storage API, which reclaims the objects first.

DESTRUCTIVE and IRREVERSIBLE — it erases every re-hosted cover. It therefore REFUSES to run
without an explicit `--confirm`, and prints what it will do before doing it. Idempotent: if the
bucket is already gone a 404 from `empty_bucket` degrades to a clean success.

Import stays keyless: `supabase_client` (which reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)
is imported inside the run body, never at module scope — so this file imports with no env set.

Usage (from backend/):
    uv run --env-file .env python -m scripts.drop_reel_covers_bucket           # refuses, prints how to confirm
    uv run --env-file .env python -m scripts.drop_reel_covers_bucket --confirm # empties then deletes
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from collections.abc import Awaitable, Callable

BUCKET = "reel-covers"

# Duck-typed against storage3.StorageApiError.status: a bucket that no longer exists yields a
# 404 on the empty/delete endpoints, which we treat as "already gone" rather than an error.
_NOT_FOUND_STATUSES = frozenset({404, "404"})

_REFUSE_MSG = (
    f"refusing: this EMPTIES and DELETES the {BUCKET!r} Storage bucket (destructive, "
    f"irreversible — erases every re-hosted cover). Re-run with --confirm to proceed."
)


def _is_absent_error(exc: Exception) -> bool:
    """True if `exc` is a Storage 404 (bucket already gone) rather than a real failure."""
    return getattr(exc, "status", None) in _NOT_FOUND_STATUSES


async def _drop_bucket(client) -> int:
    """Empty the bucket (objects first) then delete it. Idempotent on a 404; re-raises otherwise."""
    storage = client.storage
    try:
        await storage.empty_bucket(BUCKET)
    except Exception as exc:  # noqa: BLE001 — inspect status; genuine errors re-raise below
        if _is_absent_error(exc):
            print(f"  [drop] bucket {BUCKET!r} already absent — nothing to do", file=sys.stderr)
            return 0
        raise
    print(f"  [drop] emptied bucket {BUCKET!r}", file=sys.stderr)

    try:
        await storage.delete_bucket(BUCKET)
    except Exception as exc:  # noqa: BLE001 — a racing delete may 404; that is success
        if _is_absent_error(exc):
            print(f"  [drop] bucket {BUCKET!r} already absent — nothing to do", file=sys.stderr)
            return 0
        raise
    print(f"  [drop] deleted bucket {BUCKET!r}", file=sys.stderr)
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="drop_reel_covers_bucket",
        description=f"Empty then delete the {BUCKET!r} Storage bucket (rollback of migration 20260731120000).",
    )
    p.add_argument(
        "--confirm",
        action="store_true",
        help="required: acknowledge this is destructive and irreversible before running",
    )
    return p.parse_args(argv)


async def main(argv: list[str] | None = None, *, client_factory: Callable[[], Awaitable] | None = None) -> int:
    """Return an exit code. Refuses (non-zero) without --confirm, before any client is built.

    `client_factory` is injected in tests; in production it defaults to the service-role client
    (imported lazily so this module imports keyless)."""
    args = _parse_args(argv)
    if not args.confirm:
        print(_REFUSE_MSG, file=sys.stderr)
        return 2

    if client_factory is None:
        from supabase_client import get_supabase_client

        client_factory = get_supabase_client

    print(f"About to EMPTY then DELETE the {BUCKET!r} Storage bucket (destructive, irreversible)…", file=sys.stderr)
    client = await client_factory()
    return await _drop_bucket(client)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
