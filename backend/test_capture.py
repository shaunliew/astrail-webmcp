"""Capture command — offline: producers injected, no live call, import needs no keys."""
import capture
from models.place import PlaceResult
from models.reel import ReelData


def _reel(url):
    return ReelData(reel_url=url, caption="c", capture_status="CAPTURED")


def _place(name):
    return PlaceResult(name=name, category="restaurant", confidence=0.9,
                       evidence_quote=name, lat=35.6, lng=139.7)


async def test_run_capture_collects_successes_and_skips_failures():
    async def scrape(url, *, token):
        if url == "bad":
            raise RuntimeError("scrape down")
        return _reel(url)

    async def extract(reel):
        return [_place(reel.reel_url)]

    reels, places = await capture.run_capture(
        ["u1", "bad", "u2"], token="T", scrape=scrape, extract=extract)
    assert [r.reel_url for r in reels] == ["u1", "u2"]
    assert [p.name for p in places] == ["u1", "u2"]


async def test_run_capture_never_logs_token_or_secret(capsys):
    # a producer error whose message carries a secret must NOT be printed (Codex P2)
    async def scrape(url, *, token):
        raise RuntimeError("upstream failure token=SECRET123 leaked")

    async def extract(reel):
        return []

    await capture.run_capture(["u1"], token="SECRET123", scrape=scrape, extract=extract)
    err = capsys.readouterr().err
    assert "SECRET123" not in err
    assert "RuntimeError" in err


def test_import_capture_needs_no_keys(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    importlib.reload(capture)  # import time: no key required, no live call
    assert hasattr(capture, "run_capture")
