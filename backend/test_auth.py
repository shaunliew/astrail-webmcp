import os
import pytest
from jose import jwt
from fastapi import HTTPException

os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret-please-change")
from auth import get_current_user_id, get_user_id_from_query_or_header  # noqa: E402

SECRET = os.environ["SUPABASE_JWT_SECRET"]


def _token(claims: dict, secret: str = SECRET) -> str:
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.mark.asyncio
async def test_header_valid_token_returns_sub():
    tok = _token({"sub": "user-123", "aud": "authenticated"})
    assert await get_current_user_id(f"Bearer {tok}") == "user-123"


@pytest.mark.asyncio
async def test_header_missing_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(None)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_header_wrong_secret_raises_401():
    tok = _token({"sub": "u", "aud": "authenticated"}, secret="other")
    with pytest.raises(HTTPException) as ei:
        await get_current_user_id(f"Bearer {tok}")
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_query_token_wins():
    tok = _token({"sub": "user-q", "aud": "authenticated"})
    assert await get_user_id_from_query_or_header(token=tok, authorization=None) == "user-q"


@pytest.mark.asyncio
async def test_query_falls_back_to_header():
    tok = _token({"sub": "user-h", "aud": "authenticated"})
    assert await get_user_id_from_query_or_header(token=None, authorization=f"Bearer {tok}") == "user-h"


@pytest.mark.asyncio
async def test_query_missing_both_raises_401():
    with pytest.raises(HTTPException) as ei:
        await get_user_id_from_query_or_header(token=None, authorization=None)
    assert ei.value.status_code == 401
