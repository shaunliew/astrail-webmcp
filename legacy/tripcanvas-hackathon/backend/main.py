"""
TripCanvas FastAPI backend — two endpoints per CLAUDE.md file structure.

Endpoints:
  POST /extract      reels → places (writes data/places.json as side effect)
  POST /itinerary    places + preferences → SSE stream → ItineraryOutput

SSE termination contract (CLAUDE.md):
  data: {"type": "result", "content": "<final JSON string>"}\\n\\n
  data: [DONE]\\n\\n

Run:
  uv run uvicorn backend.main:app --reload --port 8000

Required env vars (loaded from .env at project root):
  OPENAI_API_KEY
  APIFY_TOKEN
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import time
from typing import Optional

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv())

# Make sibling spike modules importable when running via `uvicorn backend.main:app`.
sys.path.insert(0, os.path.dirname(__file__))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from spike_e2e import PlaceResult as ExtractedPlace
from spike_e2e_planner import (
    _EXTRACTION_TIMEOUT,
    _MAX_PLACES,
    _load_cached_itinerary,
    _load_cached_places,
    _top_n_by_confidence,
    _write_cached_places,
    run_extraction,
)
from spike_planner import (
    PlaceResult as PlannerPlace,
    UserPreferences,
    _GLOBAL_TIMEOUT,
    run_planner,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

_HEARTBEAT_INTERVAL = 5.0  # seconds; keeps proxies + EventSource alive during the 170s planner wait

app = FastAPI(title="TripCanvas Backend", version="0.1.0")

# CORS — Next.js dev server is on :3000 by default.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / response shapes
# ---------------------------------------------------------------------------


class ExtractRequest(BaseModel):
    reel_urls: list[str] = Field(..., min_length=1, max_length=8)


class ExtractResponse(BaseModel):
    places: list[dict]
    source: str           # "live" | "cache"
    count: int


class ItineraryRequest(BaseModel):
    preferences: UserPreferences
    places: Optional[list[dict]] = None   # if None ⇒ server loads from data/places.json


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "tripcanvas-backend"}


# ---------------------------------------------------------------------------
# /extract — reels → places (writes cache as side effect)
# ---------------------------------------------------------------------------


@app.post("/extract", response_model=ExtractResponse)
async def extract(req: ExtractRequest) -> ExtractResponse:
    """Run live extraction with cache fallback.

    Honors CLAUDE.md non-negotiable #5: extraction >_EXTRACTION_TIMEOUT ⇒ cache fallback.
    """
    t0 = time.monotonic()
    try:
        places = await asyncio.wait_for(
            run_extraction(req.reel_urls), timeout=_EXTRACTION_TIMEOUT
        )
        if places:
            _write_cached_places(places)
            logger.info("/extract live: %d places in %.1fs", len(places), time.monotonic() - t0)
            return ExtractResponse(
                places=[p.model_dump(mode="json") for p in places],
                source="live",
                count=len(places),
            )
        logger.warning("/extract returned 0 places — falling back to cache")
    except asyncio.TimeoutError:
        logger.warning("/extract exceeded %.0fs — falling back to cache", _EXTRACTION_TIMEOUT)
    except Exception as exc:
        logger.error("/extract failed (%s) — falling back to cache", exc)

    try:
        cached = _load_cached_places()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail="Extraction failed and no cached places.json available. Run spike_e2e.py once to seed.",
        ) from exc
    return ExtractResponse(
        places=[p.model_dump(mode="json") for p in cached],
        source="cache",
        count=len(cached),
    )


# ---------------------------------------------------------------------------
# /itinerary — places → ItineraryOutput (SSE)
# ---------------------------------------------------------------------------


def _sse_event(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _itinerary_stream(places: list[ExtractedPlace], prefs: UserPreferences):
    """Yield SSE events: start → heartbeats → result → [DONE]."""
    if not places:
        yield _sse_event({"type": "error", "message": "no places provided and cache empty"})
        yield "data: [DONE]\n\n"
        return

    # Cap places to match planner's enricher budget (Phase 2 learning).
    capped = (
        _top_n_by_confidence(places, _MAX_PLACES)
        if len(places) > _MAX_PLACES else places
    )
    planner_places = [PlannerPlace.model_validate(p.model_dump()) for p in capped]

    yield _sse_event({
        "type": "start",
        "n_places_in": len(places),
        "n_places_used": len(capped),
        "destination": planner_places[0].city_or_region_guess,
    })

    t0 = time.monotonic()
    planner_task = asyncio.create_task(
        asyncio.wait_for(run_planner(planner_places, prefs), timeout=_GLOBAL_TIMEOUT)
    )

    # Wrap heartbeat loop + result extraction in try/finally so a client disconnect
    # (generator cancellation) doesn't leak the planner task and burn OpenAI tokens.
    try:
        # Heartbeats keep the connection warm during the ~170s planner wait.
        while not planner_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(planner_task), timeout=_HEARTBEAT_INTERVAL)
            except asyncio.TimeoutError:
                yield _sse_event({
                    "type": "heartbeat",
                    "elapsed_s": round(time.monotonic() - t0, 1),
                })
            except Exception:
                # Planner errored; loop exits via done() check next iter.
                break

        try:
            result = planner_task.result()
        except Exception as exc:
            logger.error("/itinerary planner failed (%s) — trying cached itinerary", exc)
            cached = _load_cached_itinerary()
            if cached is None:
                yield _sse_event({"type": "error", "message": f"planner failed: {exc}"})
                yield "data: [DONE]\n\n"
                return
            result = cached

        elapsed = round(time.monotonic() - t0, 1)
        logger.info("/itinerary done in %.1fs (source=%s)", elapsed, result.source)

        # CLAUDE.md SSE contract: result first, then [DONE].
        yield _sse_event({"type": "result", "content": result.model_dump_json(), "elapsed_s": elapsed})
        yield "data: [DONE]\n\n"
    finally:
        # Client disconnect or any unwind path — cancel pending planner work.
        if not planner_task.done():
            planner_task.cancel()


@app.post("/itinerary")
async def itinerary(req: ItineraryRequest) -> StreamingResponse:
    """Stream planning progress + final ItineraryOutput as SSE."""
    if req.places is not None:
        places = [ExtractedPlace.model_validate(p) for p in req.places]
    else:
        try:
            places = _load_cached_places()
        except FileNotFoundError as exc:
            raise HTTPException(
                status_code=503,
                detail="No places provided and no cached places.json available. Call /extract first.",
            ) from exc

    return StreamingResponse(
        _itinerary_stream(places, req.preferences),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",   # disable nginx buffering if proxied
        },
    )
