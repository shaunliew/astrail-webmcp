import importlib

import pytest


@pytest.mark.asyncio
async def test_client_is_memoized(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    import supabase_client
    importlib.reload(supabase_client)

    calls = []

    async def fake_acreate_client(url, key):
        calls.append((url, key))
        return object()

    monkeypatch.setattr(supabase_client, "acreate_client", fake_acreate_client)

    a = await supabase_client.get_supabase_client()
    b = await supabase_client.get_supabase_client()

    assert a is b and len(calls) == 1
    assert calls[0] == ("https://example.supabase.co", "service-role-key")
