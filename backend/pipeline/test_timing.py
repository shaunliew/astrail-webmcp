"""Stopwatch determinism — timing assertions use an injected fake clock, never wall-clock."""
from pipeline.timing import Stopwatch


class _Ticker:
    """Deterministic clock: returns 0.0, 1.0, 2.0, ... on each call."""

    def __init__(self, step: float = 1.0) -> None:
        self._t = 0.0
        self._step = step

    def __call__(self) -> float:
        v = self._t
        self._t += self._step
        return v


def test_stage_records_elapsed_per_stage():
    clock = _Ticker()
    sw = Stopwatch(clock=clock)
    start = clock()              # 0.0
    with sw.stage("a"):          # start 1.0, end 2.0 -> 1.0
        pass
    with sw.stage("b"):          # start 3.0, end 4.0 -> 1.0
        pass
    sw.mark_total(start)         # end 5.0 - 0.0 -> 5.0
    assert sw.timings == {"a": 1.0, "b": 1.0, "total": 5.0}


def test_stage_records_even_when_body_raises():
    clock = _Ticker()
    sw = Stopwatch(clock=clock)
    try:
        with sw.stage("boom"):   # start 0.0, end 1.0 -> 1.0
            raise RuntimeError("x")
    except RuntimeError:
        pass
    assert sw.timings["boom"] == 1.0


def test_default_clock_is_perf_counter_monotonic():
    # real clock: don't assert a value, just that a stage records a non-negative float
    sw = Stopwatch()
    with sw.stage("real"):
        pass
    assert isinstance(sw.timings["real"], float)
    assert sw.timings["real"] >= 0.0
