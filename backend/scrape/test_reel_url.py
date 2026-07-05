"""Reel URL normalize + validate — pure, offline."""
import pytest

from scrape.reel_url import is_reel_url, normalize_reel_url, short_code_of


@pytest.mark.parametrize("url,ok", [
    ("https://www.instagram.com/reel/DYbmT-SNzVK/", True),
    ("https://instagram.com/reels/DYbmT-SNzVK", True),
    ("http://www.instagram.com/reel/ABC123/?igsh=xyz", True),
    ("https://www.instagram.com/p/DYbmT-SNzVK/", False),   # a post, not a reel
    ("https://www.tiktok.com/@x/video/123", False),
    ("not a url", False),
    ("", False),
])
def test_is_reel_url(url, ok):
    assert is_reel_url(url) is ok


def test_normalize_strips_query_and_trailing_slash():
    assert normalize_reel_url("https://www.instagram.com/reel/ABC123/?igsh=z") == \
        "https://www.instagram.com/reel/ABC123"


def test_normalize_rejects_non_reel():
    with pytest.raises(ValueError):
        normalize_reel_url("https://www.instagram.com/p/ABC123/")


def test_short_code():
    assert short_code_of("https://www.instagram.com/reel/DYbmT-SNzVK/") == "DYbmT-SNzVK"
    assert short_code_of("https://x.com/y") is None
