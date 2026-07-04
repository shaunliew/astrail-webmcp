import importlib

def test_client_is_memoized(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key")
    import supabase_client
    importlib.reload(supabase_client)
    calls = []
    monkeypatch.setattr(supabase_client, "create_client",
                        lambda url, key: calls.append((url, key)) or object())
    a = supabase_client.get_supabase_client()
    b = supabase_client.get_supabase_client()
    assert a is b and len(calls) == 1
    assert calls[0] == ("https://example.supabase.co", "service-role-key")
