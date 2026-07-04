"""Supabase JWT validation for authenticated FastAPI endpoints.

Verifies the Supabase-issued access token using asymmetric signing keys
(ES256, via JWKS) and returns the authenticated user id. The live Supabase
project uses ECC (P-256) signing keys, so tokens are verified against the
project's published JSON Web Key Set rather than a shared secret. The POST
route reads the Authorization header; the SSE stream route reads a ?token=
query param (browser EventSource cannot set headers), with a header
fallback. See guardrails #5 (auth) and #6 (owner).
"""
from __future__ import annotations

import os

from fastapi import Header, HTTPException, Query
from jose import JWTError, jwt

# Module-level cache of {kid: jwk_dict}, populated lazily on first use and
# refreshed on an unknown kid (handles Supabase signing-key rotation).
_JWKS_CACHE: dict[str, dict] = {}


async def _fetch_jwks() -> dict[str, dict]:
    """Fetch the Supabase project's JWKS and return it keyed by kid."""
    import httpx

    supabase_url = os.environ["SUPABASE_URL"]
    jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
    async with httpx.AsyncClient() as client:
        response = await client.get(jwks_url)
        response.raise_for_status()
    keys = response.json().get("keys", [])
    return {key["kid"]: key for key in keys if "kid" in key}


async def _get_jwk(kid: str) -> dict:
    """Look up the JWK for `kid`, refetching the JWKS once on a cache miss."""
    if kid not in _JWKS_CACHE:
        try:
            _JWKS_CACHE.update(await _fetch_jwks())
        except Exception:
            # Never surface the underlying exception (may embed request/
            # response details from the JWKS fetch) — 401 and move on.
            raise HTTPException(status_code=401, detail="JWKS fetch failed") from None
    if kid not in _JWKS_CACHE:
        raise HTTPException(status_code=401, detail="Unknown signing key")
    return _JWKS_CACHE[kid]


async def _decode(token: str) -> str:
    """Validate a Supabase ES256/RS256 token via JWKS; return its subject.

    Raises 401 on any verification failure. `algorithms` intentionally
    excludes HS256 — accepting a symmetric algorithm alongside asymmetric
    ones would enable the JWT algorithm-confusion attack, and the project
    does not issue HS256 tokens.
    """
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token header") from None
    kid = header.get("kid")
    if not kid:
        raise HTTPException(status_code=401, detail="Token missing kid")

    key = await _get_jwk(kid)

    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
            options={"require_aud": True},
        )
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from None
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")
    return user_id


async def get_current_user_id(authorization: str | None = Header(None)) -> str:
    """Header-based auth dependency for POST routes."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")
    return await _decode(authorization.removeprefix("Bearer ").strip())


async def get_user_id_from_query_or_header(
    token: str | None = Query(None), authorization: str | None = Header(None)
) -> str:
    """Stream auth: prefer ?token= (EventSource can't set headers), fall back to header."""
    if token:
        return await _decode(token)
    if authorization and authorization.startswith("Bearer "):
        return await _decode(authorization.removeprefix("Bearer ").strip())
    raise HTTPException(status_code=401, detail="Missing token")
