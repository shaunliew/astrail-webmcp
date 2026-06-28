"""Capture command — offline: producers injected, no live call, import needs no keys."""
import capture
from models.place import PlaceResult
from models.reel import ReelData
from scrape.apify_direct import ApifyScrapeError


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


async def test_run_capture_prints_place_details(capsys):
    # the result is printed for human inspection (name, coords, evidence, source)
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [PlaceResult(name="Harry Potter Cafe", category="restaurant", confidence=0.65,
                            evidence_quote="Harry Potter Cafe", lat=35.6730773, lng=139.7363882,
                            source_url="https://hpcafe.jp/information/")]

    await capture.run_capture(["u1"], token="T", scrape=scrape, extract=extract)
    out = capsys.readouterr().out
    assert "Harry Potter Cafe" in out
    assert "hpcafe.jp" in out
    assert "evidence" in out
    assert "35.6731,139.7364" in out


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


async def test_run_capture_prints_safe_apify_error_detail(capsys):
    async def scrape(url, *, token):
        raise ApifyScrapeError(f"Apify could not scrape {url}: blocked by Instagram")

    async def extract(reel):
        return []

    await capture.run_capture(["u1"], token="SECRET123", scrape=scrape, extract=extract)
    err = capsys.readouterr().err
    assert "blocked by Instagram" in err
    assert "SECRET123" not in err


async def test_run_capture_grounds_coords_via_injected_resolver():
    # an injected async resolver overrides coords (Mapbox grounding)
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [_place("Cafe")]  # lat=35.6, lng=139.7

    async def resolve(place):
        return place.model_copy(update={"lat": 35.71, "lng": 139.80, "formatted_address": "Asakusa"})

    _, places = await capture.run_capture(
        ["u1"], token="T", scrape=scrape, extract=extract, resolve=resolve)
    assert len(places) == 1
    assert abs(places[0].lat - 35.71) < 1e-9 and abs(places[0].lng - 139.80) < 1e-9
    assert places[0].formatted_address == "Asakusa"


async def test_run_capture_default_resolve_keeps_llm_coords():
    # no resolver injected → identity no-op → LLM coords unchanged
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [_place("Cafe")]

    _, places = await capture.run_capture(["u1"], token="T", scrape=scrape, extract=extract)
    assert abs(places[0].lat - 35.6) < 1e-9 and abs(places[0].lng - 139.7) < 1e-9


async def test_run_capture_geocode_error_keeps_place_and_no_token_leak(capsys):
    # a resolver failure must NOT lose the place, and its message (may carry a token) is never printed
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        return [_place("Cafe")]

    async def resolve(place):
        raise RuntimeError("mapbox down token=MBSECRET")

    _, places = await capture.run_capture(
        ["u1"], token="T", scrape=scrape, extract=extract, resolve=resolve)
    assert len(places) == 1                       # place kept
    assert abs(places[0].lat - 35.6) < 1e-9       # LLM coords preserved on geocode failure
    err = capsys.readouterr().err
    assert "MBSECRET" not in err
    assert "geocode-skip" in err


def test_main_returns_nonzero_and_does_not_write_empty_capture(monkeypatch, tmp_path, capsys):
    async def empty_capture(*args, **kwargs):
        return [], []

    wrote = {"value": False}

    def fake_write(*args, **kwargs):
        wrote["value"] = True

    monkeypatch.setenv("APIFY_TOKEN", "T")
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    monkeypatch.setattr(capture, "run_capture", empty_capture)
    monkeypatch.setattr(capture, "_write_fixtures", fake_write)

    rc = capture.main([
        "--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/",
        "--out-dir", str(tmp_path),
    ])
    assert rc == 1
    assert wrote["value"] is False
    assert "captured 0 reels" in capsys.readouterr().err


def test_import_capture_needs_no_keys(monkeypatch):
    monkeypatch.delenv("APIFY_TOKEN", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    importlib.reload(capture)  # import time: no key required, no live call
    assert hasattr(capture, "run_capture")
