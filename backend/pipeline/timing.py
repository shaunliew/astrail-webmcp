"""Offline timing — a tiny stopwatch with an INJECTABLE clock for deterministic tests.

Default clock is time.perf_counter (monotonic wall-clock). Tests inject a fake
clock so per-stage durations are exact and assertable. Stdlib only; no network.
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator

Clock = Callable[[], float]


class Stopwatch:
    """Records per-stage elapsed seconds into `.timings`, plus a total outer span.

    `total` is a real outer span (clock at first start -> clock at mark_total),
    NOT the sum of stages — so it stays correct if a stage later runs concurrently.
    """

    def __init__(self, clock: Clock = time.perf_counter) -> None:
        self._clock = clock
        self.timings: dict[str, float] = {}

    @contextmanager
    def stage(self, name: str) -> Iterator[None]:
        start = self._clock()
        try:
            yield
        finally:
            self.timings[name] = round(self._clock() - start, 6)

    def mark_total(self, start: float) -> None:
        """Record the total span as clock_now - `start` (the clock value before stage 1)."""
        self.timings["total"] = round(self._clock() - start, 6)
