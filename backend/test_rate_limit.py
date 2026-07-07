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
