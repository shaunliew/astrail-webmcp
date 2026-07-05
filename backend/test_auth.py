import asyncio
import base64
import json
import os
import time
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from jose import jwk as jose_jwk
from jose import jwt

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")

import auth  # noqa: E402
from auth import get_current_user_id, get_user_id_from_query_or_header  # noqa: E402

KID = "test-kid"


def _generate_ec_keypair() -> tuple[str, str]:
    """Return (private_pem, public_pem) for a fresh P-256 keypair."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


PRIVATE_PEM, PUBLIC_PEM = _generate_ec_keypair()
OTHER_PRIVATE_PEM, _ = _generate_ec_keypair()  # unrelated keypair, proves sig verification

PUBLIC_JWK = jose_jwk.construct(PUBLIC_PEM, "ES256").to_dict()
PUBLIC_JWK["kid"] = KID


def _token(
    claims: dict, kid: str = KID, private_pem: str = PRIVATE_PEM, algorithm: str = "ES256"
) -> str:
    return jwt.encode(claims, private_pem, algorithm=algorithm, headers={"kid": kid})


@pytest.fixture(autouse=True)
def _fake_jwks(monkeypatch):
    """Reset the module-level JWKS cache state and stub the fetch so no real
    network call is ever made — tests only ever see the self-signed test
    keypair. Resetting `_JWKS_LAST_FETCH` to 0.0 keeps the debounce/TTL
    checks deterministic and independent of the monotonic clock's absolute
    value across test runs."""
    monkeypatch.setattr(auth, "_JWKS_CACHE", {})
    monkeypatch.setattr(auth, "_JWKS_LAST_FETCH", 0.0)

    async def _fake_fetch() -> dict[str, dict]:
        return {KID: PUBLIC_JWK}

    monkeypatch.setattr(auth, "_fetch_jwks", _fake_fetch)
    yield


@pytest.mark.asyncio
async def test_header_valid_es256_token_returns_sub():
    tok = _token({"sub": "user-123", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-123"


@pytest.mark.asyncio
async def test_header_missing_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(None)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_header_malformed_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id("NotBearer sometoken")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_query_token_wins():
    tok = _token({"sub": "user-q", "aud": "authenticated"})
    assert await get_user_id_from_query_or_header(token=tok, authorization=None) == "user-q"


@pytest.mark.asyncio
async def test_query_falls_back_to_header():
    tok = _token({"sub": "user-h", "aud": "authenticated"})
    assert (
        await get_user_id_from_query_or_header(token=None, authorization=f"Bearer {tok}")
        == "user-h"
    )


@pytest.mark.asyncio
async def test_query_missing_both_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_user_id_from_query_or_header(token=None, authorization=None)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_unknown_kid_raises_401():
    tok = _token({"sub": "u", "aud": "authenticated"}, kid="never-seen-kid")
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_token_signed_by_different_key_raises_401():
    """Same kid, but the signature was produced by an unrelated private key —
    verification against the cached JWK's public key must fail."""
    tok = _token({"sub": "u", "aud": "authenticated"}, private_pem=OTHER_PRIVATE_PEM)
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_jwks_fetch_failure_raises_401(monkeypatch):
    """A network/HTTP failure fetching the JWKS must surface as 401, not a
    raw 500 from an unhandled exception."""

    async def _broken_fetch() -> dict[str, dict]:
        raise RuntimeError("connection refused")

    monkeypatch.setattr(auth, "_fetch_jwks", _broken_fetch)
    tok = _token({"sub": "u", "aud": "authenticated"})
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_aud_raises_401():
    tok = _token({"sub": "u"})
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_subject_raises_401():
    tok = _token({"aud": "authenticated"})
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_expired_token_raises_401():
    expired = datetime.now(timezone.utc) - timedelta(hours=1)
    tok = _token({"sub": "u", "aud": "authenticated", "exp": expired})
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_hs256_token_rejected_algorithm_confusion_guard():
    """An HS256 token must never be accepted even though its kid matches a
    cached (ES256) key — accepting HS256 alongside asymmetric algorithms
    would enable the classic JWT algorithm-confusion attack."""
    tok = _token({"sub": "u", "aud": "authenticated"}, private_pem="shared-secret", algorithm="HS256")
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_no_network_call_when_verifying_cached_kid(monkeypatch):
    """A verify against an already-cached, still-fresh kid must take the fast
    path and never re-invoke `_fetch_jwks` at all — proven by counting calls
    against a warmed cache, not by relying on the autouse network stub (which
    would pass this test even on a cache miss)."""
    monkeypatch.setattr(auth, "_JWKS_CACHE", {KID: PUBLIC_JWK})
    monkeypatch.setattr(auth, "_JWKS_LAST_FETCH", time.monotonic())

    calls = {"n": 0}

    async def _counting_fetch() -> dict[str, dict]:
        calls["n"] += 1
        return {KID: PUBLIC_JWK}

    monkeypatch.setattr(auth, "_fetch_jwks", _counting_fetch)

    tok = _token({"sub": "user-net", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-net"
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_debounce_limits_refetch_for_flood_of_unknown_kids(monkeypatch):
    """Anti-DoS proof: a flood of DISTINCT unknown kids (the shape of an
    unauthenticated refetch-amplification attack) must trigger at most one
    `_fetch_jwks` call, not one per request."""
    calls = {"n": 0}

    async def _counting_fetch() -> dict[str, dict]:
        calls["n"] += 1
        return {KID: PUBLIC_JWK}

    monkeypatch.setattr(auth, "_fetch_jwks", _counting_fetch)

    for i in range(5):
        tok = _token({"sub": "u", "aud": "authenticated"}, kid=f"unknown-kid-{i}")
        with pytest.raises(HTTPException) as ei:
            await get_current_user_id(f"Bearer {tok}")
        assert ei.value.status_code == 401

    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_concurrent_misses_coalesce_to_one_fetch(monkeypatch):
    """Concurrent verifications that all miss the cache must coalesce into a
    single `_fetch_jwks` call via `_JWKS_LOCK`, not one fetch per coroutine."""
    calls = {"n": 0}

    async def _counting_fetch() -> dict[str, dict]:
        calls["n"] += 1
        await asyncio.sleep(0.01)  # widen the race window across concurrent callers
        return {KID: PUBLIC_JWK}

    monkeypatch.setattr(auth, "_fetch_jwks", _counting_fetch)

    tok = _token({"sub": "user-concurrent", "aud": "authenticated"})
    results = await asyncio.gather(*[get_current_user_id(f"Bearer {tok}") for _ in range(5)])

    assert results == ["user-concurrent"] * 5
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_ttl_expiry_triggers_refetch(monkeypatch):
    """A cached kid older than `_JWKS_TTL_S` is no longer trusted as fresh —
    the next verify must trigger a refetch (bounds the revocation window)."""
    monkeypatch.setattr(auth, "_JWKS_CACHE", {KID: PUBLIC_JWK})
    stale_timestamp = time.monotonic() - auth._JWKS_TTL_S - 1
    monkeypatch.setattr(auth, "_JWKS_LAST_FETCH", stale_timestamp)

    calls = {"n": 0}

    async def _counting_fetch() -> dict[str, dict]:
        calls["n"] += 1
        return {KID: PUBLIC_JWK}

    monkeypatch.setattr(auth, "_fetch_jwks", _counting_fetch)

    tok = _token({"sub": "user-ttl", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-ttl"
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_rotated_kid_verifies_after_refetch(monkeypatch):
    """An initially-unknown kid that appears in the JWKS after a
    (debounce-allowed) refetch must verify successfully — proves key
    rotation still works under the new cache policy."""
    new_private_pem, new_public_pem = _generate_ec_keypair()
    new_kid = "rotated-kid"
    new_jwk = jose_jwk.construct(new_public_pem, "ES256").to_dict()
    new_jwk["kid"] = new_kid

    async def _rotated_fetch() -> dict[str, dict]:
        return {KID: PUBLIC_JWK, new_kid: new_jwk}

    monkeypatch.setattr(auth, "_fetch_jwks", _rotated_fetch)
    tok = _token(
        {"sub": "user-rotated", "aud": "authenticated"}, kid=new_kid, private_pem=new_private_pem
    )
    assert await get_current_user_id(f"Bearer {tok}") == "user-rotated"


@pytest.mark.asyncio
async def test_alg_none_unsigned_token_raises_401():
    """An explicit `alg: none` unsigned token must never be accepted, even
    though its `kid` matches a cached key."""

    def _b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    header = _b64url(json.dumps({"alg": "none", "kid": KID}).encode())
    payload = _b64url(json.dumps({"sub": "u", "aud": "authenticated"}).encode())
    tok = f"{header}.{payload}."

    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_garbage_bearer_token_raises_401():
    """A `Bearer <garbage-non-jwt>` header must fail closed with 401, not an
    unhandled exception."""
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id("Bearer not-a-jwt-at-all")
    assert ei.value.status_code == 401
