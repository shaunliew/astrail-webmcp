import pytest

from evals.util import (
    evidence_in_corpus,
    haversine_m,
    in_japan,
    is_placeholder_url,
    is_weak_source_url,
    reel_corpus,
)


def test_haversine_known_distance():
    # ~1.11 km per 0.01 deg latitude
    assert haversine_m(0.0, 0.0, 0.01, 0.0) == pytest.approx(1113.0, abs=20.0)


def test_haversine_zero():
    assert haversine_m(35.6, 139.7, 35.6, 139.7) == pytest.approx(0.0)


def test_in_japan():
    assert in_japan(35.66, 139.70) is True       # Tokyo
    assert in_japan(1.35, 103.8) is False         # Singapore
    assert in_japan(None, None) is False


def test_is_placeholder_url():
    assert is_placeholder_url(None) is True
    assert is_placeholder_url("") is True
    assert is_placeholder_url("ftp://x.com") is True
    assert is_placeholder_url("https://example.com/x") is True
    assert is_placeholder_url("http://localhost:3000") is True
    assert is_placeholder_url("https://tabelog.com/tokyo/A1301/") is False


def test_is_weak_source_url():
    assert is_weak_source_url("https://www.google.com/maps/place/x") is True
    assert is_weak_source_url("https://www.google.co.jp/maps?ll=35,139") is True
    assert is_weak_source_url("https://www.google.com/maps/search/?q=x") is True
    assert is_weak_source_url("https://booking.com/searchresults?x=1") is True
    assert is_weak_source_url("https://example.com/x") is True          # placeholder is weak
    assert is_weak_source_url("https://grandhyatt.com/tokyo") is False  # real venue page


def test_reel_corpus_and_evidence():
    reels = [{"caption": "Loved 📍Ichiran", "location_name": "Shibuya"},
             {"caption": None, "location_name": None}]
    corpus = reel_corpus(reels)
    assert "ichiran" in corpus and "shibuya" in corpus
    assert evidence_in_corpus("📍Ichiran", corpus) is True
    assert evidence_in_corpus("Totally Made Up", corpus) is False
    assert evidence_in_corpus(None, corpus) is False


def test_reel_corpus_empty_when_no_captions():
    assert reel_corpus([{"caption": None, "location_name": None}]) == ""
