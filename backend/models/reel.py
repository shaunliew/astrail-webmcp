"""ReelData — the scrape-stage contract (Phase 1 output).

Matches the recorded reel fixtures (reel_url + caption + location_name).
`extra="ignore"` tolerates wider Apify payloads (Step 5) without re-declaring
every field. The optional `transcript` is the opt-in caption-thin fallback.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ReelData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reel_url: str
    short_code: str | None = None
    caption: str = ""
    location_name: str | None = None
    capture_status: str = "NEEDS_CAPTURE"
    transcript: str | None = None
