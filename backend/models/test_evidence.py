from models.evidence import TripPlaceEvidence


def test_evidence_model_fields_match_the_contract():
    assert set(TripPlaceEvidence.model_fields) == {
        "confidence", "source_url", "quote", "quotes", "rationale", "evidence_kind"}


def test_evidence_model_defaults():
    ev = TripPlaceEvidence(confidence=0.9, evidence_kind="reel_quote")
    assert ev.quote is None and ev.quotes == [] and ev.rationale is None and ev.source_url is None
