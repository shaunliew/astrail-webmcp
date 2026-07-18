"""Local Supabase smoke test for the saved Reel capture RPC."""
from __future__ import annotations

import os
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from supabase import acreate_client
from supabase.lib.client_options import AsyncClientOptions
from supabase_auth.types import AdminUserAttributes

from api.schemas import SavedReel
from saved_reels import capture_saved_reel

pytestmark = pytest.mark.integration
RUN = os.environ.get("RUN_DB_INTEGRATION") == "1"


@pytest.mark.skipif(not RUN, reason="set RUN_DB_INTEGRATION=1 to run against local Supabase")
async def test_capture_saved_reel_against_local_supabase():
    url = os.environ["ASTRAIL_LOCAL_SUPABASE_URL"]
    if urlparse(url).hostname not in {"localhost", "127.0.0.1"}:
        raise RuntimeError("refusing to run saved Reel integration against a non-local Supabase URL")

    http_client = httpx.AsyncClient()
    client = await acreate_client(
        url,
        os.environ["ASTRAIL_LOCAL_SUPABASE_SERVICE_ROLE_KEY"],
        options=AsyncClientOptions(httpx_client=http_client),
    )
    user_id: str | None = None
    try:
        user = await client.auth.admin.create_user(
            AdminUserAttributes(
                email=f"saved-reel-{uuid4().hex}@example.test",
                email_confirm=True,
            )
        )
        user_id = user.user.id
        shortcode = f"task3{uuid4().hex}"
        raw_url = f"https://www.instagram.com/reel/{shortcode}/?igsh=integration"

        first = SavedReel.model_validate(await capture_saved_reel(client, user_id, raw_url))
        second = SavedReel.model_validate(await capture_saved_reel(client, user_id, raw_url))

        assert first.user_id == user_id
        assert first.normalized_url == f"https://www.instagram.com/reel/{shortcode}"
        assert second.id == first.id
    finally:
        if user_id is not None:
            await client.auth.admin.delete_user(user_id)
        await http_client.aclose()
