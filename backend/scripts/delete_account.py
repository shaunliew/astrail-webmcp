"""Operator tool: fully delete ONE account now (mem0 purge, then auth cascade).

WHY THIS EXISTS. During the launch window the self-serve deletion engine is GATED OFF
(`_DELETION_EXECUTION_READY=False`), so the only live erasure path is the manual, email-based,
30-day one the privacy policy promises. This script is that manual path. It does NOT hand-roll a
weaker delete: it composes the SAME primitives the automated two-pass engine uses —
`erasure.purge_account_memory` (the strict mem0 choke-point that RAISES unless mem0 is confirmed
empty) and `deletion_engine._admin_hard_delete` (the `auth.admin.delete_user(should_soft_delete=
False)` cascade). Ordering is mem0 FIRST, then the auth cascade — matching the engine — because
deleting auth.users cascades every DB row (see the FK chain), after which the mem0 user_id would
still resolve but the operator would have no record to drive the purge from.

Deleting via the Supabase dashboard instead of this script leaves mem0 preference PII behind and
silently breaks the privacy policy's "erases your remembered preferences (including your mem0
memory)" promise. Always use this script.

Run from backend/:
    uv run --env-file .env python -m scripts.delete_account --user-id <uuid> [--dry-run] [--yes]
    uv run --env-file .env python -m scripts.delete_account --email <addr>   [--dry-run] [--yes]

--dry-run prints the plan and touches nothing. Without --yes you must retype the user_id to confirm.
See docs/runbooks/account-deletion.md.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from erasure import InvalidUserId, _assert_real_uuid, purge_account_memory


async def resolve_user_id(client, *, user_id: str | None, email: str | None) -> str:
    """Return the canonical user_id from --user-id, or resolve --email via the auth admin API."""
    if user_id:
        _assert_real_uuid(user_id)   # strict: exactly the stored spelling, or refuse
        return user_id
    if not email:
        raise SystemExit("Pass exactly one of --user-id or --email.")
    # Best-effort email -> id via the admin list. Paginated; stop at the match.
    page = 1
    while True:
        users = await client.auth.admin.list_users(page=page, per_page=200)
        if not users:
            raise SystemExit(f"No auth user found for email {email!r}. Pass --user-id from the dashboard.")
        for u in users:
            if (getattr(u, "email", None) or "").lower() == email.lower():
                return str(u.id)
        page += 1


async def run(client, mem0, user_id: str, *, dry_run: bool, assume_yes: bool,
              confirm=input, out=print) -> int:
    """Purge mem0 (confirmed), then hard-delete auth (cascade). Idempotent; returns an exit code.

    Split from main() and given injected client/mem0/confirm/out so it is unit-testable without a
    live DB — the test asserts dry-run touches nothing and that a wrong confirmation aborts.
    """
    from deletion_engine import _admin_hard_delete, _auth_user_absent, _read_account_status

    _assert_real_uuid(user_id)
    status = await _read_account_status(client, user_id)
    absent = await _auth_user_absent(client, user_id)
    out(f"account {user_id}: account_status={status!r} auth_user_absent={absent}")

    if dry_run:
        out("[dry-run] would: 1) purge mem0 (confirmed-or-raise)  2) auth.admin.delete_user("
            "should_soft_delete=False) cascade. Nothing changed.")
        return 0

    if absent and status is None:
        out("Already fully absent (no auth user, no account row). Nothing to do.")
        return 0

    if not assume_yes:
        typed = confirm(f"Type the user_id to permanently delete {user_id}: ").strip()
        if typed != user_id:
            out("Confirmation did not match. Aborted — nothing changed.")
            return 1

    # 1) mem0 FIRST — raises (InvalidUserId / MemoryBackendUnavailable / MemoryPurgeError) unless
    #    the purge is CONFIRMED empty, so we never proceed to the irreversible auth delete on an
    #    unconfirmed memory purge.
    await purge_account_memory(client, mem0, user_id)
    out("mem0: purge confirmed empty.")

    # 2) auth cascade — the real, non-recoverable delete. Skip if the auth user is already gone
    #    (idempotent re-run after a partial failure).
    if await _auth_user_absent(client, user_id):
        out("auth: user already absent — skipping delete.")
    else:
        await _admin_hard_delete(client, user_id)
        out("auth: hard-deleted (cascade).")

    out(f"DONE: account {user_id} erased (mem0 + auth cascade).")
    return 0


async def main() -> int:
    p = argparse.ArgumentParser(description="Fully delete one Astrail account (mem0 + auth cascade).")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--user-id", help="canonical lowercase UUID of the account to delete")
    g.add_argument("--email", help="resolve the user_id from this email via the auth admin API")
    p.add_argument("--dry-run", action="store_true", help="print the plan and touch nothing")
    p.add_argument("--yes", action="store_true", help="skip the interactive retype-to-confirm prompt")
    args = p.parse_args()

    from supabase_client import get_supabase_client
    from deletion_engine import _get_mem0

    client = await get_supabase_client()
    try:
        user_id = await resolve_user_id(client, user_id=args.user_id, email=args.email)
    except InvalidUserId as exc:
        print(f"Refusing: {exc}", file=sys.stderr)
        return 2
    mem0 = await _get_mem0()
    return await run(client, mem0, user_id, dry_run=args.dry_run, assume_yes=args.yes)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
