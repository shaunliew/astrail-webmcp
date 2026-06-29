"""Manual-paste reel ingestion — pure, offline, no key, no network."""
import pytest

from models.reel import ReelData
from scrape.manual_input import MANUAL_CAPTURE_STATUS, manual_reeldata


def test_manual_reeldata_caption_only_uses_manual_sentinel_url():
    reel = manual_reeldata("📍Tokyo Tower — must visit at night")
    assert isinstance(reel, ReelData)
    assert reel.caption == "📍Tokyo Tower — must visit at night"
    assert reel.capture_status == MANUAL_CAPTURE_STATUS
    assert reel.reel_url.startswith("manual:")
    assert reel.location_name is None


def test_manual_reeldata_passes_through_location():
    reel = manual_reeldata("great ramen", location_name="Ichiran, Shibuya")
    assert reel.location_name == "Ichiran, Shibuya"


def test_manual_reeldata_blank_location_becomes_none():
    # a whitespace-only location tag must NOT become a highest-confidence signal
    assert manual_reeldata("cap", location_name="   ").location_name is None


def test_manual_reeldata_reel_source_url_is_normalized_provenance():
    reel = manual_reeldata(
        "caption", source_url="https://www.instagram.com/reels/ABC123/?igsh=xx")
    assert reel.reel_url == "https://www.instagram.com/reel/ABC123"


def test_manual_reeldata_non_reel_source_url_falls_back_to_sentinel():
    reel = manual_reeldata("caption", source_url="https://www.tiktok.com/@x/video/1")
    assert reel.reel_url.startswith("manual:")


def test_manual_reeldata_is_deterministic():
    a = manual_reeldata("same text", location_name="same loc")
    b = manual_reeldata("same text", location_name="same loc")
    assert a.reel_url == b.reel_url


def test_manual_reeldata_whitespace_padded_location_same_digest():
    # the digest hashes the NORMALIZED location, so padded == trimmed (regression guard)
    a = manual_reeldata("cap", location_name="loc")
    b = manual_reeldata("cap", location_name="  loc  ")
    assert a.reel_url == b.reel_url


def test_manual_reeldata_distinct_text_distinct_url():
    assert manual_reeldata("text one").reel_url != manual_reeldata("text two").reel_url


@pytest.mark.parametrize("bad", ["", "   ", "\n\t "])
def test_manual_reeldata_blank_caption_raises(bad):
    with pytest.raises(ValueError):
        manual_reeldata(bad)
