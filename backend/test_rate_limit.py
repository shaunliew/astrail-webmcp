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


# ── reserve_and_enqueue_trip_job wrapper (Task 2) ───────────────────────────
# The wrapper is a thin passthrough over the atomic reserve=enqueue RPC. It returns
# EVERY outcome verbatim as a ReserveResult (it does NOT branch on outcome — that
# mapping is main.py's job in Task 4). PGRST202 (RPC absent = deploy lag) fails CLOSED
# with a distinct 503; any other APIError propagates (-> 500).

# Full valid kwarg set (keyword-only after client). Reused across the wrapper tests.
_RESERVE_KWARGS = dict(
    user_id="user-1",
    idempotency_key="idem-abc",
    destination_hint="Tokyo",
    start_date="2026-09-01",
    end_date="2026-09-05",
    budget_level="mid",
    origin_city="Singapore",
    preference_summary="likes quiet ramen bars",
    preference_sources=[{"kind": "reel", "quote": "best ramen"}],
    event_payload={"reel_urls": ["https://instagram.com/reel/x"], "pace": "relaxed"},
    trial_limit=1,
    daily_limit=5,
)


@pytest.mark.parametrize(
    "row",
    [
        # created: both ids set.
        {"outcome": "created", "trip_id": "trip-1", "job_id": "job-1"},
        # replay: existing trip, no new job.
        {"outcome": "replay", "trip_id": "trip-2", "job_id": None},
        # rejection / anomaly outcomes: all three nulls, per the RPC.
        {"outcome": "trial_exhausted", "trip_id": None, "job_id": None},
        {"outcome": "daily_exhausted", "trip_id": None, "job_id": None},
        {"outcome": "identity_unavailable", "trip_id": None, "job_id": None},
        # conflict_retry: the loser of a same-key race whose winner already refunded.
        {"outcome": "conflict_retry", "trip_id": None, "job_id": None},
    ],
)
@pytest.mark.asyncio
async def test_reserve_passes_every_outcome_through(row):
    client = _FakeClient(data=[row])
    result = await rate_limit.reserve_and_enqueue_trip_job(client, **_RESERVE_KWARGS)
    assert isinstance(result, rate_limit.ReserveResult)
    # Passthrough: outcome / trip_id / job_id unchanged, no branching, no raise.
    assert result.outcome == row["outcome"]
    assert result.trip_id == row["trip_id"]
    assert result.job_id == row["job_id"]


@pytest.mark.asyncio
async def test_reserve_maps_kwargs_to_p_prefixed_params():
    client = _FakeClient(data=[{"outcome": "created", "trip_id": "t", "job_id": "j"}])
    await rate_limit.reserve_and_enqueue_trip_job(client, **_RESERVE_KWARGS)
    name, params = client.calls[0]
    assert name == "reserve_and_enqueue_trip_job"
    # Full dict-equality on ALL 12 params — keys AND values — so a value-swap among ANY
    # field (not only a spot-checked subset) reds here. The wrapper builds this dict from
    # hand-written literals, so pinning the whole dict genuinely guards the kwarg->p_ mapping.
    assert params == {
        "p_user_id": "user-1",
        "p_idempotency_key": "idem-abc",
        "p_destination_hint": "Tokyo",
        "p_start_date": "2026-09-01",
        "p_end_date": "2026-09-05",
        "p_budget_level": "mid",
        "p_origin_city": "Singapore",
        "p_preference_summary": "likes quiet ramen bars",
        "p_preference_sources": [{"kind": "reel", "quote": "best ramen"}],
        "p_event_payload": {"reel_urls": ["https://instagram.com/reel/x"], "pace": "relaxed"},
        "p_trial_limit": 1,
        "p_daily_limit": 5,
    }


@pytest.mark.asyncio
async def test_reserve_missing_rpc_fails_closed_503():
    # RPC absent from the live DB (migration lagged deploy) -> PGRST202 -> fail CLOSED
    # with a distinct 503 dict detail (pairs with Task 3's errors.py dict branch).
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
        await rate_limit.reserve_and_enqueue_trip_job(_RaisingClient(), **_RESERVE_KWARGS)
    assert ei.value.status_code == 503
    assert ei.value.detail == {
        "code": "generation_unavailable",
        "message": "Trip generation temporarily unavailable",
    }


@pytest.mark.asyncio
async def test_reserve_other_apierror_propagates():
    # Any non-PGRST202 APIError is NOT swallowed: it propagates (-> 500), never a
    # silent success and never rewrapped as an HTTPException.
    from postgrest.exceptions import APIError

    class _RaisingRPC:
        def execute(self):
            async def _run():
                raise APIError({"code": "PGRST301", "message": "jwt expired"})
            return _run()

    class _RaisingClient:
        def rpc(self, name, params):
            return _RaisingRPC()

    with pytest.raises(APIError):
        await rate_limit.reserve_and_enqueue_trip_job(_RaisingClient(), **_RESERVE_KWARGS)
