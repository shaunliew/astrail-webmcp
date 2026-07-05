"""Optional, no-op-by-default tracing seam for pipeline timings.

Step 3 records timings offline. Forwarding them to Langfuse (the chosen
observability layer, already a dependency) is OPTIONAL and happens only when a
real Tracer is explicitly injected. The DEFAULT is a pure no-op: no langfuse
import, no network, no credentials. Real Langfuse emission is wired in a later
live-run step (when real agents + creds exist) by providing a Tracer
implementation — this seam means that step won't have to re-plumb the call sites.
"""
from __future__ import annotations

from typing import Protocol


class Tracer(Protocol):
    def record_timings(self, run_label: str, timings: dict) -> None: ...


class NullTracer:
    """Default tracer — does nothing. Keeps the offline path credential-free."""

    def record_timings(self, run_label: str, timings: dict) -> None:
        return None
