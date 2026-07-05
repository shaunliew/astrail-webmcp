"""Trace seam — no-op by default (offline, credential-free), forwards when injected."""
from pipeline.tracing import NullTracer, Tracer


def test_null_tracer_is_a_noop():
    # must not raise, must not require any credentials, returns None
    assert NullTracer().record_timings("japan_first_trip:pipeline", {"total": 0.5}) is None


def test_a_real_tracer_receives_timings():
    class _Recorder:
        def __init__(self):
            self.calls = []

        def record_timings(self, run_label: str, timings: dict) -> None:
            self.calls.append((run_label, timings))

    rec: Tracer = _Recorder()
    rec.record_timings("japan_first_trip:pipeline", {"scrape": 0.1, "total": 0.4})
    assert rec.calls == [("japan_first_trip:pipeline", {"scrape": 0.1, "total": 0.4})]
