"""Apify probe — offline: classifier injected, no live call, import needs no key."""
from scrape.probe_apify import probe_actor


async def test_probe_reports_unblocked_on_real_data():
    async def fetch(body, *, token):
        return [{"url": "https://www.instagram.com/reel/abc", "caption": "hi", "locationName": "Tokyo"}]

    ok, detail = await probe_actor(token="T", fetch=fetch)
    assert ok is True
    assert "OK" in detail


async def test_probe_reports_blocked_on_error_item():
    async def fetch(body, *, token):
        return [{"error": "no_items", "errorDescription": "Empty or private data for provided input"}]

    ok, detail = await probe_actor(token="T", fetch=fetch)
    assert ok is False
    assert "no_items" in detail


async def test_probe_reports_blocked_on_empty_dataset():
    async def fetch(body, *, token):
        return []

    ok, detail = await probe_actor(token="T", fetch=fetch)
    assert ok is False
    assert "0 items" in detail


async def test_probe_verdict_never_echoes_token():
    async def fetch(body, *, token):
        return [{"error": "no_items", "errorDescription": "blocked"}]

    ok, detail = await probe_actor(token="SECRET123", fetch=fetch)
    assert "SECRET123" not in detail
