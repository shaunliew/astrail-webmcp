"""Reel/post URL normalize + validate — pure, offline."""
import pytest

from scrape.reel_url import (
    is_supported_ig_url,
    normalize_reel_url,
    short_code_of,
    url_kind,
)


@pytest.mark.parametrize("url,ok", [
    ("https://www.instagram.com/reel/DYbmT-SNzVK/", True),
    ("https://instagram.com/reels/DYbmT-SNzVK", True),
    ("http://www.instagram.com/reel/ABC123/?igsh=xyz", True),
    ("https://www.instagram.com/p/DYbmT-SNzVK/", True),    # carousel/photo post — now supported
    ("https://www.instagram.com/tv/DYbmT-SNzVK/", True),   # legacy IGTV shape
    ("https://www.tiktok.com/@x/video/123", False),
    ("https://notinstagram.com/p/ABC123/", False),         # look-alike host
    ("https://instagram.com.evil.com/p/ABC123/", False),   # look-alike host
    ("https://www.instagram.com/stories/user/123/", False),  # not a post shape
    ("not a url", False),
    ("", False),
])
def test_is_supported_ig_url(url, ok):
    assert is_supported_ig_url(url) is ok


def test_normalize_reel_unchanged():
    assert normalize_reel_url("https://www.instagram.com/reel/ABC123/?igsh=z") == \
        "https://www.instagram.com/reel/ABC123"


def test_normalize_reels_canonicalizes_to_reel():
    # /reels/ (plural) still collapses to the /reel/ canonical (regression)
    assert normalize_reel_url("https://instagram.com/reels/ABC123") == \
        "https://www.instagram.com/reel/ABC123"


def test_normalize_post_canonical_and_kind():
    url = "https://www.instagram.com/p/DQwdZ8ZCWZx/"
    assert normalize_reel_url(url) == "https://www.instagram.com/p/DQwdZ8ZCWZx"
    assert url_kind(url) == "post"


def test_normalize_tv_canonicalizes_to_p():
    # IGTV is retired; /tv/ folds into the /p/ canonical
    assert normalize_reel_url("https://www.instagram.com/tv/DQwdZ8ZCWZx/") == \
        "https://www.instagram.com/p/DQwdZ8ZCWZx"
    assert url_kind("https://www.instagram.com/tv/DQwdZ8ZCWZx/") == "post"


def test_normalize_post_strips_query_and_fragment():
    assert normalize_reel_url(
        "https://www.instagram.com/p/DQwdZ8ZCWZx/?img_index=4#comments"
    ) == "https://www.instagram.com/p/DQwdZ8ZCWZx"


def test_normalize_rejects_unsupported():
    with pytest.raises(ValueError):
        normalize_reel_url("https://www.instagram.com/stories/user/123/")


def test_url_kind_reel_post_none():
    assert url_kind("https://www.instagram.com/reel/ABC123/") == "reel"
    assert url_kind("https://instagram.com/reels/ABC123") == "reel"
    assert url_kind("https://www.instagram.com/p/ABC123/") == "post"
    assert url_kind("https://www.instagram.com/tv/ABC123/") == "post"
    assert url_kind("not a url") is None
    assert url_kind("https://notinstagram.com/p/ABC123/") is None


def test_short_code():
    assert short_code_of("https://www.instagram.com/reel/DYbmT-SNzVK/") == "DYbmT-SNzVK"
    assert short_code_of("https://www.instagram.com/p/DYbmT-SNzVK/") == "DYbmT-SNzVK"
    assert short_code_of("https://x.com/y") is None


@pytest.mark.parametrize("hostile", [
    "https://instagram.com:notaport/p/ABC123/",   # non-numeric port -> urlparse .port raises
    "https://instagram.com:99999/p/ABC123/",      # out-of-range port -> urlparse .port raises
])
def test_invalid_port_is_rejected(hostile):
    # urlparse().hostname silently ignores a malformed/out-of-range port, so without the
    # `parsed.port` guard the widened /p/ regex would accept these hostile netlocs.
    assert is_supported_ig_url(hostile) is False
    assert url_kind(hostile) is None
    with pytest.raises(ValueError):
        normalize_reel_url(hostile)


def test_valid_explicit_port_is_still_accepted():
    # The guard rejects only unparseable/out-of-range ports; a syntactically valid explicit
    # port preserves the historic reel behavior.
    url = "https://www.instagram.com:443/reel/ABC123/"
    assert is_supported_ig_url(url) is True
    assert url_kind(url) == "reel"
    assert normalize_reel_url(url) == "https://www.instagram.com/reel/ABC123"
