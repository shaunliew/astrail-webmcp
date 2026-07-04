"""Supabase Python client wrapper (DB / storage / RLS).

Thin accessor around the service-role client used by the agent pipeline for
write-through caches, trip persistence, the durable jobs table, and Storage.
The service-role key bypasses RLS, so it must never reach the frontend.
"""
from __future__ import annotations

import os
from functools import lru_cache

from supabase import Client, create_client


@lru_cache(maxsize=1)
def get_supabase_client() -> Client:
    """Return a memoized service-role Supabase client (server-side only)."""
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
