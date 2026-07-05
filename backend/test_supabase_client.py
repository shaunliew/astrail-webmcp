import importlib
import warnings

import httpx
import pytest


@pytest.mark.asyncio
async def test_client_is_memoized(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    import supabase_client
    importlib.reload(supabase_client)

    calls = []

    async def fake_acreate_client(url, key, options=None):
        calls.append((url, key, options))
        return object()

    monkeypatch.setattr(supabase_client, "acreate_client", fake_acreate_client)

    a = await supabase_client.get_supabase_client()
    b = await supabase_client.get_supabase_client()

    assert a is b and len(calls) == 1
    url, key, options = calls[0]
    assert (url, key) == ("https://example.supabase.co", "service-role-key")
    # A pre-configured httpx client is passed so supabase-py skips the deprecated
    # postgrest timeout=/verify= constructor path.
    assert options is not None and isinstance(options.httpx_client, httpx.AsyncClient)


@pytest.mark.asyncio
async def test_no_deprecation_warning_on_construction(monkeypatch):
    """Constructing the real client must NOT emit the supabase-py postgrest
    timeout/verify DeprecationWarning — we hand it a pre-configured httpx client.
    Construction is network-free, so this stays keyless/offline."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    import supabase_client
    importlib.reload(supabase_client)

    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        client = await supabase_client.get_supabase_client()  # real acreate_client, no network
    assert client is not None
