import os
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
    """Reset the module-level JWKS cache and stub the fetch so no real network call
    is ever made — tests only ever see the self-signed test keypair."""
    monkeypatch.setattr(auth, "_JWKS_CACHE", {})

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
    """Guard against regressions that bypass the JWKS cache/stub and hit the
    network directly — the unit tests must never make a real HTTP call."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("must not make a real network call in unit tests")

    monkeypatch.setattr("httpx.AsyncClient.get", _boom)
    tok = _token({"sub": "user-net", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-net"
