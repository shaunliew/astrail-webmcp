"""Unit tests for the saved Reel capture persistence seam."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from api.schemas import CaptureSavedReelRequest, CaptureSavedReelResponse, SavedReel
from saved_reels import capture_saved_reel


class _RpcCall:
    def __init__(self, data):
        self._data = data

    async def execute(self):
        return SimpleNamespace(data=self._data)


class _RpcFake:
    def __init__(self, data):
        self.data = data
        self.rpc_calls: list[tuple[str, dict]] = []
        self.table_calls: list[tuple[tuple, dict]] = []

    def rpc(self, function_name: str, params: dict):
        self.rpc_calls.append((function_name, params))
        return _RpcCall(self.data)

    def table(self, *args, **kwargs):
        self.table_calls.append((args, kwargs))
        raise AssertionError("capture must use the atomic RPC, not a table upsert")


_ROW = {
    "id": "saved-reel-id",
    "user_id": "jwt-user-id",
    "normalized_url": "https://www.instagram.com/reel/ABC123",
    "source_platform": "instagram",
    "reel_cache_id": None,
    "analysis_status": "not_analyzed",
    "personal_label": None,
    "retry_after": None,
    "analyzed_at": None,
    "created_at": "2026-07-18T00:00:00Z",
    "updated_at": "2026-07-18T00:00:00Z",
}


def test_capture_models_expose_only_the_planned_fields():
    assert set(CaptureSavedReelRequest.model_fields) == {"url"}
    assert set(SavedReel.model_fields) == set(_ROW)
    assert set(CaptureSavedReelResponse.model_fields) == {"saved_reel"}


@pytest.mark.asyncio
async def test_capture_normalizes_and_calls_only_atomic_rpc():
    client = _RpcFake([_ROW])

    saved_reel = await capture_saved_reel(
        client,
        "jwt-user-id",
        "https://www.instagram.com/reel/ABC123/?igsh=tracking",
    )

    assert saved_reel == _ROW
    assert client.rpc_calls == [
        (
            "capture_saved_reel",
            {
                "p_user_id": "jwt-user-id",
                "p_normalized_url": "https://www.instagram.com/reel/ABC123",
                "p_source_platform": "instagram",
            },
        )
    ]
    assert client.table_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw_url",
    [
        "https://www.instagram.com/p/ABC123/",
        "https://www.tiktok.com/@creator/video/123",
        "not a URL",
    ],
)
async def test_capture_rejects_invalid_urls_before_any_database_call(raw_url):
    client = _RpcFake([_ROW])

    with pytest.raises(ValueError):
        await capture_saved_reel(client, "jwt-user-id", raw_url)

    assert client.rpc_calls == []
    assert client.table_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("rows", [[], [_ROW, _ROW]])
async def test_capture_fails_closed_unless_rpc_returns_exactly_one_row(rows):
    client = _RpcFake(rows)

    with pytest.raises(RuntimeError, match="exactly one"):
        await capture_saved_reel(client, "jwt-user-id", "https://www.instagram.com/reel/ABC123")

