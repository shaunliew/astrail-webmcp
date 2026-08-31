"""Geocode query policy — pure, offline, no key, no network."""
from geocode.policy import choose_query, geocode_query, query_language
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


# --------------------------------------------------------------------------- choose_query


def test_choose_query_prefers_the_local_script_name():
    # The add_place case: the user types English, the agent supplies the local-script name.
    # Mapbox's Japan POI index carries ONLY Japanese names, so the query must be the Japanese one.
    assert choose_query("Tokyo Disneyland", "東京ディズニーランド") == ("東京ディズニーランド", "ja")


def test_choose_query_falls_back_to_the_plain_name():
    assert choose_query("Tokyo Disneyland", None) == ("Tokyo Disneyland", "en")
    assert choose_query("Tokyo Disneyland", "") == ("Tokyo Disneyland", "en")
    assert choose_query("Tokyo Disneyland", "   ") == ("Tokyo Disneyland", "en")


def test_choose_query_strips_both_names():
    assert choose_query("  Tokyo Tower  ", None) == ("Tokyo Tower", "en")
    assert choose_query("Tokyo Tower", "  東京タワー ") == ("東京タワー", "ja")


def test_geocode_query_is_choose_query_over_a_place():
    # One rule, one implementation: the reel path and the add_place path cannot drift apart.
    place = _place(name="Tokyo Tower", name_local="東京タワー")
    assert geocode_query(place) == choose_query(place.name, place.name_local)
