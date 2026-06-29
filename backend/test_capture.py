"""Capture command — offline: producers injected, no live call, import needs no keys."""
import capture
from models.place import PlaceResult
from models.reel import ReelData
from scrape.apify_direct import ApifyScrapeError
from scrape.manual_input import manual_reeldata


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


async def test_run_capture_processes_manual_reels_without_scraping():
    # manual reels skip the scrape producer entirely (it must never be called)
    async def scrape(url, *, token):
        raise AssertionError("scrape must not be called for manual reels")

    async def extract(reel):
        return [_place(reel.caption)]

    manual = [manual_reeldata("📍Senso-ji Temple in Asakusa")]
    reels, places = await capture.run_capture(
        [], token="", scrape=scrape, extract=extract, manual_reels=manual)
    assert len(reels) == 1 and reels[0].capture_status == "MANUAL"
    assert [p.name for p in places] == ["📍Senso-ji Temple in Asakusa"]


async def test_run_capture_manual_reels_grounded_via_resolver():
    async def scrape(url, *, token):
        raise AssertionError("scrape must not be called")

    async def extract(reel):
        return [_place("Cafe")]  # lat=35.6, lng=139.7

    async def resolve(place):
        return place.model_copy(update={"lat": 35.71, "lng": 139.80})

    _, places = await capture.run_capture(
        [], token="", scrape=scrape, extract=extract, resolve=resolve,
        manual_reels=[manual_reeldata("Cafe in Tokyo")])
    assert abs(places[0].lat - 35.71) < 1e-9 and abs(places[0].lng - 139.80) < 1e-9


def test_main_manual_only_does_not_require_apify_token(monkeypatch, tmp_path, capsys):
    captured = {}

    async def fake_capture(reel_urls, *, token, scrape, extract, resolve=None, manual_reels=None):
        captured["manual_reels"] = manual_reels
        captured["reel_urls"] = reel_urls
        return [_reel("manual:abc")], [_place("X")]

    monkeypatch.delenv("APIFY_TOKEN", raising=False)   # block wave: no Apify token
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    monkeypatch.setattr(capture, "run_capture", fake_capture)
    monkeypatch.setattr(capture, "_write_fixtures", lambda *a, **k: None)

    rc = capture.main([
        "--manual-caption", "📍Tokyo Tower at night",
        "--manual-location", "Tokyo Tower",
        "--out-dir", str(tmp_path),
    ])
    assert rc == 0
    assert captured["reel_urls"] == []
    assert len(captured["manual_reels"]) == 1
    assert captured["manual_reels"][0].caption == "📍Tokyo Tower at night"


def test_main_requires_at_least_one_source(monkeypatch, capsys):
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main([])  # neither --reels nor --manual-caption
    assert rc == 2
    assert "source" in capsys.readouterr().err.lower()


def test_main_reels_still_require_apify_token(monkeypatch, capsys):
    # setenv to "" (falsy) rather than delenv — load_dotenv(override=False) won't
    # overwrite an already-set key, so an empty string reliably simulates "no token"
    # even on dev machines that have APIFY_TOKEN in their .env file.
    monkeypatch.setenv("APIFY_TOKEN", "")
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main(["--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/"])
    assert rc == 2
    assert "APIFY_TOKEN" in capsys.readouterr().err


async def test_run_capture_mixed_reels_and_manual_collects_both(capsys):
    # mixed mode: scraped reels first, then manual reels, in one run; a bad scrape is tolerated
    async def scrape(url, *, token):
        if url == "bad":
            raise RuntimeError("scrape down")
        return _reel(url)  # capture_status == "CAPTURED"

    async def extract(reel):
        name = reel.reel_url if reel.capture_status == "CAPTURED" else reel.caption
        return [_place(name)]

    reels, places = await capture.run_capture(
        ["u1", "bad"], token="T", scrape=scrape, extract=extract,
        manual_reels=[manual_reeldata("Manual Spot")])
    assert [r.capture_status for r in reels] == ["CAPTURED", "MANUAL"]  # scraped first, manual after
    assert [p.name for p in places] == ["u1", "Manual Spot"]            # "bad" tolerated


async def test_run_capture_skips_reel_when_extract_fails(capsys):
    # post-refactor: extract failure drops the reel, keeps going, leaks no token (type only)
    async def scrape(url, *, token):
        return _reel(url)

    async def extract(reel):
        raise RuntimeError("extractor failed token=SECRET123")

    reels, places = await capture.run_capture(
        ["u1"], token="SECRET123", scrape=scrape, extract=extract)
    assert reels == [] and places == []
    err = capsys.readouterr().err
    assert "SECRET123" not in err and "RuntimeError" in err


def test_main_reels_provided_without_token_errors_even_with_manual(monkeypatch, capsys):
    # a --reels arg that needs scraping requires the token even alongside --manual-caption
    # setenv to "" (falsy) rather than delenv — see test_main_reels_still_require_apify_token
    monkeypatch.setenv("APIFY_TOKEN", "")
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    rc = capture.main([
        "--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/",
        "--manual-caption", "fallback text",
    ])
    assert rc == 2
    assert "APIFY_TOKEN" in capsys.readouterr().err


def test_main_out_dir_defaults_by_mode(monkeypatch):
    # manual-only defaults to captures/ (protects #16); scraping defaults to evals/fixtures
    seen = {}

    async def fake_capture(reel_urls, *, token, scrape, extract, resolve=None, manual_reels=None):
        return [_reel("r")], [_place("X")]

    monkeypatch.setenv("APIFY_TOKEN", "T")
    monkeypatch.setenv("OPENAI_API_KEY", "K")
    monkeypatch.setattr(capture, "run_capture", fake_capture)
    monkeypatch.setattr(capture, "_write_fixtures",
                        lambda reels, places, out_dir: seen.__setitem__("out_dir", out_dir))

    capture.main(["--manual-caption", "Manual Spot"])                          # manual-only
    assert seen["out_dir"] == capture.CAPTURES_DEFAULT
    capture.main(["--reels", "https://www.instagram.com/reel/DYGH3jFBZHz/"])   # scraping
    assert seen["out_dir"] == capture.EVALS_FIXTURES
