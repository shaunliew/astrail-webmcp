from types import SimpleNamespace

import pytest
from starlette.requests import Request

import rate_limit


def _fake_request(user_id=None, client_host="1.2.3.4") -> Request:
    scope = {
        "type": "http",
        "headers": [],
        "client": (client_host, 12345),
        "state": {},
    }
    req = Request(scope)
    if user_id is not None:
        req.state.user_id = user_id
    return req


def test_key_func_uses_user_id_when_present():
    req = _fake_request(user_id="user-abc")
    assert rate_limit.rate_limit_key(req) == "user-abc"


def test_key_func_falls_back_to_ip_when_no_user():
    req = _fake_request(user_id=None, client_host="9.9.9.9")
    assert rate_limit.rate_limit_key(req) == "9.9.9.9"


def test_defaults():
    assert rate_limit.DAILY_TRIP_QUOTA == 5
    assert rate_limit.BURST_LIMIT == "3/minute"


class _FakeRPC:
    def __init__(self, data):
        self._data = data
    def execute(self):
        async def _run():
            return type("Resp", (), {"data": self._data})()
        return _run()


class _FakeClient:
    def __init__(self, data):
        self._data = data
        self.calls = []
    def rpc(self, name, params):
        self.calls.append((name, params))
        return _FakeRPC(self._data)


@pytest.mark.asyncio
async def test_quota_allows_when_rpc_returns_count():
    client = _FakeClient(data=3)
    allowed = await rate_limit.check_and_increment_daily_quota(client, "user-1", 5)
    assert allowed is True
    assert client.calls[0][0] == "increment_daily_trip_usage"
    assert client.calls[0][1] == {"p_user_id": "user-1", "p_limit": 5}


@pytest.mark.asyncio
async def test_quota_rejects_when_rpc_returns_none():
    client = _FakeClient(data=None)
    allowed = await rate_limit.check_and_increment_daily_quota(client, "user-1", 5)
    assert allowed is False


@pytest.mark.asyncio
async def test_refund_calls_decrement():
    client = _FakeClient(data=2)
    await rate_limit.refund_daily_quota(client, "user-1")
    assert client.calls[0][0] == "decrement_daily_trip_usage"
    assert client.calls[0][1] == {"p_user_id": "user-1"}


@pytest.mark.asyncio
async def test_quota_missing_rpc_fails_closed_503():
    # Codex HIGH #4: RPC absent from the live DB (migration lagged deploy) -> PGRST202
    # -> fail CLOSED with 503, not an opaque 500 and not fail-open.
    from fastapi import HTTPException
    from postgrest.exceptions import APIError

    class _RaisingRPC:
        def execute(self):
            async def _run():
                raise APIError({"code": "PGRST202", "message": "function not found"})
            return _run()

    class _RaisingClient:
        def rpc(self, name, params):
            return _RaisingRPC()

    with pytest.raises(HTTPException) as ei:
        await rate_limit.check_and_increment_daily_quota(_RaisingClient(), "user-1", 5)
    assert ei.value.status_code == 503
