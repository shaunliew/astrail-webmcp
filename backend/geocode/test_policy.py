"""Geocode query policy — pure, offline, no key, no network."""
from geocode.policy import geocode_query, query_language
from models.place import PlaceResult


def _place(**kw):
    base = dict(name="Tokyo Tower", category="attraction", confidence=0.9, evidence_quote="x")
    base.update(kw)
    return PlaceResult(**base)


def test_query_language_japanese_scripts():
    assert query_language("東京タワー") == "ja"   # kanji
    assert query_language("サンドイッチ") == "ja"   # katakana
    assert query_language("ひらがな") == "ja"       # hiragana


def test_query_language_halfwidth_katakana_is_ja():
    # NFKC folds halfwidth katakana to fullwidth → detected as Japanese, not mis-routed to en
    assert query_language("ﾄｰｷｮｰﾀﾜｰ") == "ja"


def test_query_language_latin_is_english():
    assert query_language("Tokyo Tower") == "en"
    assert query_language("SANDO LAB TOKYO") == "en"


def test_geocode_query_prefers_local_name_in_detected_language():
    # English canonical name, Japanese name_local → query the Japanese form in ja
    q, lang = geocode_query(_place(name="Tokyo Tower", name_local="東京タワー"))
    assert q == "東京タワー" and lang == "ja"


def test_geocode_query_japanese_name_without_local_still_ja():
    # name itself is Japanese, name_local absent → still detected as ja (not mis-queried as en)
    q, lang = geocode_query(_place(name="サンドイッチ ポポー", name_local=None))
    assert q == "サンドイッチ ポポー" and lang == "ja"


def test_geocode_query_english_name_without_local_is_english():
    q, lang = geocode_query(_place(name="Harry Potter Cafe", name_local=None))
    assert q == "Harry Potter Cafe" and lang == "en"
