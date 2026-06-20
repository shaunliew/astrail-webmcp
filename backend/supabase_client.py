"""Supabase Python client wrapper (DB / storage / RLS).

Thin accessor around the service-role client used by the agent pipeline for
write-through caches, trip persistence, the durable jobs table, and Storage.
The service-role key bypasses RLS, so it must never reach the frontend.
"""


# TODO: build and cache a client from SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
def get_supabase_client():
    """Return a service-role Supabase client (server-side only)."""
    raise NotImplementedError
