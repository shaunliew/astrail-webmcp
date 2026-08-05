"""Service-layer wrappers for the account-deletion request/cancel RPCs (Task 2).

Keeps main.py lean: these call the two security-definer RPCs via the service-role client
and hand back typed outcomes the endpoints map to HTTP. NOTHING destructive runs here —
the RPCs only flip `public.users.account_status` into / out of the 7-day cancellable grace
and write the FK-free `account_deletion_log`. The delete engine + sweep is Task 3.

`user_id` is ALWAYS the caller's authenticated JWT sub — the endpoints never accept a
client-supplied id, and the RPCs are privilege-pinned to service_role so a client cannot
reach them for another uuid via PostgREST.
"""
from __future__ import annotations


async def account_is_pending_deletion(client, user_id: str) -> bool:
    """True when the account is in the deletion grace ('pending_deletion') or being deleted
    ('deleting') — the generation-freeze read (plan §3.6), shared by all three generation
    entrypoints (POST /generate-trip, POST /saved-reels/organize, the Telegram ingest worker).

    INERT while every account is 'active' (the shipping state), so this UX gate ships UNGATED.
    Fails OPEN — a status-read blip must not break generation for everyone. The load-bearing
    freeze is `persist_trip_memory`'s fail-closed add + the auth-delete cascade (they actually
    stop new data for a to-be-deleted account); this early return is only the friendly response.
    """
    try:
        res = await (client.table("users").select("account_status")
                     .eq("id", user_id).maybe_single().execute())
    except Exception:                                     # noqa: BLE001 — fail open (UX gate only)
        return False
    row = getattr(res, "data", None) if res is not None else None
    status = row.get("account_status") if isinstance(row, dict) else None
    return status in ("pending_deletion", "deleting")


class DeletionRPCUnavailable(Exception):
    """The request/cancel RPC is absent from the live DB (PostgREST PGRST202).

    Deploys are manual and can lag a migration, so a missing RPC must fail CLOSED with a
    distinct signal (endpoint → 503) rather than surface as a 500 — mirrors the request_seat
    / reserve-wrapper handling of PGRST202.
    """


async def request_account_deletion(client, user_id: str) -> str | None:
    """Enter the 7-day deletion grace for `user_id`.

    Returns the scheduled deletion time (an ISO timestamptz string, as PostgREST yields it),
    or ``None`` when the CAS matched nothing — i.e. the account was not 'active' (already
    pending/deleting, or absent), which the endpoint maps to 409.
    """
    from postgrest.exceptions import APIError

    try:
        resp = await client.rpc("request_account_deletion", {"p_user_id": user_id}).execute()
    except APIError as exc:
        if getattr(exc, "code", None) == "PGRST202":
            raise DeletionRPCUnavailable("request_account_deletion RPC is not deployed") from None
        raise
    # Scalar-RPC convention (see request_seat): `.execute().data` IS the returned value —
    # the timestamptz string, or None when the RPC returned NULL.
    return resp.data


async def cancel_account_deletion(client, user_id: str) -> str:
    """Cancel the pending deletion for `user_id`.

    Returns the RPC's status string: ``'cancelled'`` (flipped back to active),
    ``'already_deleting'`` (the sweeper already claimed it — endpoint → 409
    deletion_already_started), or ``'not_pending'`` (nothing to cancel).
    """
    from postgrest.exceptions import APIError

    try:
        resp = await client.rpc("cancel_account_deletion", {"p_user_id": user_id}).execute()
    except APIError as exc:
        if getattr(exc, "code", None) == "PGRST202":
            raise DeletionRPCUnavailable("cancel_account_deletion RPC is not deployed") from None
        raise
    return resp.data
