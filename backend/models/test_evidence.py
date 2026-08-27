from models.evidence import TripPlaceEvidence


def test_evidence_model_fields_match_the_contract():
    assert set(TripPlaceEvidence.model_fields) == {
        "confidence", "source_url", "source_reel_url", "quote", "quotes", "rationale",
        "evidence_kind"}


def test_evidence_model_defaults():
    ev = TripPlaceEvidence(confidence=0.9, evidence_kind="reel_quote")
    assert ev.quote is None and ev.quotes == [] and ev.rationale is None and ev.source_url is None
    assert ev.source_reel_url is None


def test_source_url_and_source_reel_url_are_distinct_concepts():
    # `source_url` is an independent research/venue page — the extractor's
    # `is_independent_source_url()` gate drops places whose source_url is not third-party
    # research, so it can never be a Reel. Conflating the two is what put a map.yahoo.co.jp
    # link under a "From reel" label in the UI.
    ev = TripPlaceEvidence(
        confidence=0.95,
        evidence_kind="reel_quote",
        source_url="https://map.yahoo.co.jp/v3/place/JpggG2MZB5o",
        source_reel_url="https://www.instagram.com/reel/AAA/",
    )
    assert ev.source_url != ev.source_reel_url
    assert "instagram.com" in ev.source_reel_url
