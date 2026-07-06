from models.enrichment import DayNarration, NarrationResult


def test_narration_result_defaults():
    r = NarrationResult()
    assert r.days == [] and r.trip_title is None and r.trip_summary == ""


def test_day_narration_shape():
    d = DayNarration(day_number=1, title="Day 1", summary="Start early.")
    assert d.day_number == 1 and d.title == "Day 1" and d.summary == "Start early."


def test_narration_result_carries_days_and_trip_overview():
    r = NarrationResult(days=[DayNarration(day_number=1, title="t", summary="s")],
                        trip_title="Tokyo Trip", trip_summary="A short run.")
    assert len(r.days) == 1 and r.trip_title == "Tokyo Trip" and r.trip_summary == "A short run."
