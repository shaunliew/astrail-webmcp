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

import asyncio
import os
import time

from fastapi import Header, HTTPException, Query
from jose import JWTError, jwt

# Module-level cache of {kid: jwk_dict}, populated lazily on first use and
# refreshed on a cache miss (handles Supabase signing-key rotation). See
# `_get_jwk` for the cache/fetch policy, which guards against an
# unauthenticated refetch-amplification DoS: JWKS lookups happen during auth
# (i.e. pre-authentication) on public routes, so without a debounce an
# attacker flooding requests with random, unknown `kid`s would force a 1:1
# outbound fetch against Supabase's auth endpoint per request.
_JWKS_CACHE: dict[str, dict] = {}
_JWKS_LAST_FETCH: float = 0.0  # time.monotonic() timestamp of the last (attempted) fetch
_JWKS_LOCK = asyncio.Lock()

_JWKS_TTL_S = 600  # positive-cache freshness; also bounds the key-revocation window
_JWKS_MIN_REFETCH_S = 30  # debounce: at most one fetch per this many seconds


async def _fetch_jwks() -> dict[str, dict]:
    """Fetch the Supabase project's JWKS and return it keyed by kid.

    Creates a fresh `httpx.AsyncClient` per call — a shared pooled client is
    NOT wired up here. The debounce in `_get_jwk` already keeps fetches rare
    (at most one per `_JWKS_MIN_REFETCH_S`), so the connection-reuse win from
    a shared client is a micro-optimization deferred until measured.
    """
    import httpx

    supabase_url = os.environ["SUPABASE_URL"]
    jwks_url = f"{supabase_url}/auth/v1/.well-known/jwks.json"
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(jwks_url)
        response.raise_for_status()
    keys = response.json().get("keys", [])
    return {key["kid"]: key for key in keys if "kid" in key}


async def _get_jwk(kid: str) -> dict:
    """Look up the JWK for `kid`, refreshing the cache per the policy below.

    - Fast path (no lock): a cached, still-fresh (< `_JWKS_TTL_S` old) `kid`
      returns immediately without touching the lock or the network.
    - A cache miss (or stale cache) acquires `_JWKS_LOCK` and re-checks
      inside it — a concurrent coroutine may have just refreshed the cache —
      so concurrent misses coalesce into a single fetch.
    - Debounce: even inside the lock, a fetch only runs if at least
      `_JWKS_MIN_REFETCH_S` has elapsed since the last one, so a flood of
      distinct unknown `kid`s can force at most one fetch per that window.
      A legitimately rotated new `kid` still resolves within that window.
    - Fails closed: any fetch/parse error is swallowed (never surfaced —
      it may embed request/response details) and, like a debounced skip,
      falls through to the 401 below if `kid` is still absent.
    """
    global _JWKS_LAST_FETCH
    now = time.monotonic()
    if kid in _JWKS_CACHE and now - _JWKS_LAST_FETCH < _JWKS_TTL_S:
        return _JWKS_CACHE[kid]

    async with _JWKS_LOCK:
        now = time.monotonic()
        if kid in _JWKS_CACHE and now - _JWKS_LAST_FETCH < _JWKS_TTL_S:
            return _JWKS_CACHE[kid]

        if now - _JWKS_LAST_FETCH >= _JWKS_MIN_REFETCH_S:
            try:
                _JWKS_CACHE.update(await _fetch_jwks())
            except Exception:
                pass
            finally:
                _JWKS_LAST_FETCH = now

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
