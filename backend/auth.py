"""Supabase JWT validation for authenticated FastAPI endpoints.

Verifies the Supabase-issued access token (HS256, signed with SUPABASE_JWT_SECRET)
and returns the authenticated user id. The POST route reads the Authorization
header; the SSE stream route reads a ?token= query param (browser EventSource
cannot set headers), with a header fallback. See guardrails #5 (auth) and #6 (owner).
"""
from __future__ import annotations

import os

from fastapi import Header, HTTPException, Query
from jose import JWTError, jwt


def _decode(token: str) -> str:
    """Validate a Supabase HS256 token and return its subject; raise 401 on failure."""
    secret = os.environ["SUPABASE_JWT_SECRET"]
    try:
        claims = jwt.decode(token, secret, algorithms=["HS256"], audience="authenticated")
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")
    return user_id


async def get_current_user_id(authorization: str | None = Header(None)) -> str:
    """Header-based auth dependency for POST routes."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    return _decode(authorization.removeprefix("Bearer ").strip())


async def get_user_id_from_query_or_header(
    token: str | None = Query(None), authorization: str | None = Header(None)
) -> str:
    """Stream auth: prefer ?token= (EventSource can't set headers), fall back to header."""
    if token:
        return _decode(token)
    if authorization and authorization.startswith("Bearer "):
        return _decode(authorization.removeprefix("Bearer ").strip())
    raise HTTPException(status_code=401, detail="Missing token")
