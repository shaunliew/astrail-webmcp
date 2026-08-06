"""Unit tests for the saved Reel capture persistence seam."""
from __future__ import annotations

import os
from types import SimpleNamespace

import httpx
import pytest

os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")

import main  # noqa: E402
import rate_limit  # noqa: E402
from api.schemas import CaptureSavedReelRequest, CaptureSavedReelResponse, SavedReel
from fastapi import Request  # noqa: E402
from rate_limit import get_current_user_id_stashed  # noqa: E402
from saved_reels import capture_saved_reel


@pytest.fixture(autouse=True)
def _reset_limiter():
    """slowapi's burst counts are process-global; capture is now burst-limited, so one
    test's calls would otherwise bleed into the next test's budget."""
    rate_limit.limiter.reset()
    yield


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
        "https://www.instagram.com/stories/someone/123/",
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


def _route_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=main.app, raise_app_exceptions=False),
        base_url="http://test",
    )


async def test_saved_reel_route_returns_the_exact_typed_response(monkeypatch):
    client = object()
    captured: list[tuple[object, str, str]] = []

    async def _current_user_id(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    async def _get_client():
        return client

    async def _capture(actual_client, user_id, url):
        captured.append((actual_client, user_id, url))
        return _ROW

    main.app.dependency_overrides[get_current_user_id_stashed] = _current_user_id
    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "capture_saved_reel", _capture, raising=False)
    try:
        async with _route_client() as ac:
            response = await ac.post(
                "/saved-reels",
                json={"url": "https://www.instagram.com/reel/ABC123"},
            )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"saved_reel": _ROW}
    assert captured == [
        (client, "authenticated-user-id", "https://www.instagram.com/reel/ABC123")
    ]


async def test_saved_reel_route_has_per_user_burst_limit(monkeypatch):
    """Capture creates an authenticated row per call, so it carries BURST_LIMIT (3/minute)
    like every other mutating endpoint. The 4th call in the window is rejected BEFORE the
    handler body — `captured` proving the limiter fires ahead of the persistence seam."""
    captured: list[str] = []

    async def _stashed(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    async def _get_client():
        return object()

    async def _capture(_client, _user_id, url):
        captured.append(url)
        return _ROW

    main.app.dependency_overrides[get_current_user_id_stashed] = _stashed
    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "capture_saved_reel", _capture, raising=False)
    try:
        async with _route_client() as ac:
            for _ in range(3):
                allowed = await ac.post(
                    "/saved-reels", json={"url": "https://www.instagram.com/reel/ABC123"}
                )
                assert allowed.status_code == 200
            limited = await ac.post(
                "/saved-reels", json={"url": "https://www.instagram.com/reel/ABC123"}
            )
    finally:
        main.app.dependency_overrides.clear()

    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "rate_limited"
    assert len(captured) == 3


async def test_saved_reel_route_rejects_invalid_url_with_the_standard_422_envelope(monkeypatch):
    async def _current_user_id(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    main.app.dependency_overrides[get_current_user_id_stashed] = _current_user_id
    try:
        async with _route_client() as ac:
            response = await ac.post("/saved-reels", json={"url": "https://www.instagram.com/stories/someone/123/"})
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 422
    assert response.json() == {
        "error": {
            "code": "validation_error",
            "message": "A valid Instagram Reel URL is required",
        }
    }


async def test_saved_reel_route_requires_authentication():
    async with _route_client() as ac:
        response = await ac.post(
            "/saved-reels",
            json={"url": "https://www.instagram.com/reel/ABC123"},
        )

    assert response.status_code == 401
    assert response.json() == {
        "error": {
            "code": "unauthorized",
            "message": "Missing or malformed Authorization header",
        }
    }


async def test_saved_reel_route_reuses_the_atomic_row_without_background_work(monkeypatch):
    calls: list[tuple[object, str, str]] = []

    async def _current_user_id(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    async def _get_client():
        return object()

    async def _capture(client, user_id, url):
        calls.append((client, user_id, url))
        return _ROW

    async def _unexpected(*_args, **_kwargs):
        raise AssertionError("capture must not consume trip quota or dispatch generation work")

    main.app.dependency_overrides[get_current_user_id_stashed] = _current_user_id
    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "capture_saved_reel", _capture, raising=False)
    monkeypatch.setattr(main, "check_and_increment_daily_quota", _unexpected)
    monkeypatch.setattr(main, "enqueue_job", _unexpected)
    monkeypatch.setattr(main, "run_generation", _unexpected)
    try:
        async with _route_client() as ac:
            first = await ac.post("/saved-reels", json={"url": "https://www.instagram.com/reel/ABC123"})
            second = await ac.post("/saved-reels", json={"url": "https://www.instagram.com/reel/ABC123"})
    finally:
        main.app.dependency_overrides.clear()

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json() == {"saved_reel": _ROW}
    assert len(calls) == 2
    assert "scrape_reel_direct" not in main.__dict__
    assert "extract_places_agent" not in main.__dict__


@pytest.mark.parametrize("failure", [RuntimeError("database unavailable"), RuntimeError("exactly one row")])
async def test_saved_reel_route_hides_persistence_failures(monkeypatch, failure):
    async def _current_user_id(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    async def _get_client():
        return object()

    async def _capture(*_args, **_kwargs):
        raise failure

    main.app.dependency_overrides[get_current_user_id_stashed] = _current_user_id
    monkeypatch.setattr(main, "get_supabase_client", _get_client)
    monkeypatch.setattr(main, "capture_saved_reel", _capture, raising=False)
    try:
        async with _route_client() as ac:
            response = await ac.post("/saved-reels", json={"url": "https://www.instagram.com/reel/ABC123"})
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "internal_error", "message": "Internal server error"}
    }
    assert "database unavailable" not in response.text
    assert "exactly one row" not in response.text


@pytest.mark.parametrize("extra_field", ["user_id", "analysis_status", "reel_cache_id"])
async def test_saved_reel_route_rejects_client_owned_backend_fields(monkeypatch, extra_field):
    async def _current_user_id(request: Request):
        request.state.user_id = "authenticated-user-id"
        return "authenticated-user-id"

    main.app.dependency_overrides[get_current_user_id_stashed] = _current_user_id
    try:
        async with _route_client() as ac:
            response = await ac.post(
                "/saved-reels",
                json={
                    "url": "https://www.instagram.com/reel/ABC123",
                    extra_field: "client-controlled-value",
                },
            )
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 422
    assert response.json() == {
        "error": {"code": "validation_error", "message": "Request validation failed"}
    }
