"""Offline tests for the hosted mem0 singleton — no network, no real key."""
import asyncio
import time

import mem0_client


def _reset():
    mem0_client._client = None
    mem0_client._initialized = False
    mem0_client._init_failed = False


def test_no_key_returns_none(monkeypatch):
    _reset()
    monkeypatch.delenv("MEM0_API_KEY", raising=False)
    assert asyncio.run(mem0_client.get_mem0_client()) is None


def test_construct_once_and_memoized(monkeypatch):
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    calls = {"n": 0}

    def fake_construct():
        calls["n"] += 1
        return object()

    monkeypatch.setattr(mem0_client, "_construct", fake_construct)

    async def go():
        a = await mem0_client.get_mem0_client()
        b = await mem0_client.get_mem0_client()
        return a, b

    a, b = asyncio.run(go())
    assert a is b is not None
    assert calls["n"] == 1


def test_concurrent_construction_coalesces_to_one_construct(monkeypatch):
    """Proves the lock's concurrency guarantee (mirrors test_auth.py's
    test_concurrent_misses_coalesce_to_one_fetch, ~lines 224-241): five
    concurrent first-callers must coalesce into a single `_construct()` call
    via `_lock`, not one construction per coroutine. Without `async with
    _lock:` all 5 would race past the `_initialized` check and each call
    `_construct` themselves."""
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    calls = {"n": 0}

    def slow_construct():
        calls["n"] += 1
        time.sleep(0.02)  # runs in an executor thread — widens the race window
        return object()

    monkeypatch.setattr(mem0_client, "_construct", slow_construct)

    async def go():
        return await asyncio.gather(*[mem0_client.get_mem0_client() for _ in range(5)])

    results = asyncio.run(go())

    assert calls["n"] == 1
    assert all(r is results[0] for r in results)
    assert results[0] is not None


def test_construction_failure_disables_memory(monkeypatch):
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")

    def boom():
        raise RuntimeError("mem0 unreachable")

    monkeypatch.setattr(mem0_client, "_construct", boom)
    assert asyncio.run(mem0_client.get_mem0_client()) is None


def test_transient_failure_then_success(monkeypatch):
    """A6: a boot-time blip must retry, not disable memory for the process life."""
    _reset()
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")

    def boom():
        raise RuntimeError("mem0 unreachable")

    monkeypatch.setattr(mem0_client, "_construct", boom)
    assert asyncio.run(mem0_client.get_mem0_client()) is None
    assert mem0_client._initialized is False
    assert mem0_client._init_failed is True

    def fake_construct():
        return object()

    monkeypatch.setattr(mem0_client, "_construct", fake_construct)
    result = asyncio.run(mem0_client.get_mem0_client())
    assert result is not None
    assert mem0_client._initialized is True
    # A recovery must CLEAR the failure flag, not just stop looking at it. mem0_status()
    # short-circuits on `_client is not None`, so a stale _init_failed=True is invisible
    # today — and would silently become a lie the moment that check order changes.
    assert mem0_client._init_failed is False


def test_mem0_status_disabled_without_key(monkeypatch):
    import mem0_client
    monkeypatch.delenv("MEM0_API_KEY", raising=False)
    assert mem0_client.mem0_status() == "disabled"


def test_mem0_status_configured_when_client_built(monkeypatch):
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", object())
    assert mem0_client.mem0_status() == "configured"


def test_mem0_status_init_failed_after_a_failed_attempt(monkeypatch):
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", None)
    monkeypatch.setattr(mem0_client, "_init_failed", True)
    assert mem0_client.mem0_status() == "init_failed"


def test_mem0_status_never_constructs_a_client(monkeypatch):
    # THE point of this accessor: /readiness is polled, and get_mem0_client() retries an
    # 8s blocking constructor after a failure. The probe must never trigger that.
    import mem0_client
    monkeypatch.setenv("MEM0_API_KEY", "m0-test")
    monkeypatch.setattr(mem0_client, "_client", None)
    monkeypatch.setattr(mem0_client, "_init_failed", False)

    def _boom():
        raise AssertionError("mem0_status must not construct a client")

    monkeypatch.setattr(mem0_client, "_construct", _boom)
    assert mem0_client.mem0_status() == "not_initialized"      # observed, not triggered
