"""booking_agent — DEMO-SAFE booking confirmations for the TripCanvas demo.

Produces booking confirmations safe to demo on stage:
  - Flights call Duffel's sandbox API (test-mode tokens only, $0 real-money
    risk; test airline is "Duffel Airways"). Falls back to a Skyscanner deep
    link composer if no test token is configured or the sandbox call fails.
  - Hotels and attractions are pure URL composers (Booking.com / Klook
    searches) — no API auth, status is always "reserved".

INVARIANTS (the code reviewer will reject violations):
  1. Every BookingItem.is_mock is True.
  2. status="confirmed" ONLY when source="duffel_sandbox".
  3. DUFFEL_TEST_TOKEN, if present, MUST contain "_test_".

The three @function_tools NEVER raise.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import Any, Literal, Optional
from urllib.parse import quote_plus, urlencode

import httpx
import openai
from dotenv import find_dotenv, load_dotenv
from pydantic import BaseModel, Field

load_dotenv(find_dotenv())

from agents import Agent, Runner, RunResult, function_tool  # noqa: E402

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MODEL_ERRORS = (openai.NotFoundError, openai.BadRequestError, openai.PermissionDeniedError)
_BOOKING_AGENT_TIMEOUT = 25.0  # 5 attractions x 3s + hotel 1s + flight 8s + model 6s
_DUFFEL_URL = "https://api.duffel.com"
_DUFFEL_TIMEOUT = 8.0  # combined budget for both Duffel calls

_BOOKING_AID = os.environ.get("BOOKING_AID", "").strip()
_DUFFEL_TOKEN = os.environ.get("DUFFEL_TEST_TOKEN", "").strip()
_DUFFEL_ENABLED = bool(_DUFFEL_TOKEN) and "_test_" in _DUFFEL_TOKEN

if _DUFFEL_TOKEN and not _DUFFEL_ENABLED:
    raise RuntimeError(
        "DUFFEL_TEST_TOKEN does not contain '_test_'. Refusing to call Duffel in "
        "non-test mode. Get a test-mode token at app.duffel.com (Developer test mode)."
    )
if not _DUFFEL_ENABLED:
    logger.info("DUFFEL_TEST_TOKEN not set — book_flight will use deep-link fallback only.")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class BookingItem(BaseModel):
    booking_id: str
    category: Literal["flight", "hotel", "attraction"]
    name: str
    price_estimate_sgd: Optional[float] = None
    status: Literal["confirmed", "reserved"]
    book_url: str
    source: Literal["duffel_sandbox", "booking_deeplink", "klook_deeplink"]
    is_mock: bool  # ALWAYS True — invariant enforced at tool layer
    notes: str


class BookingResult(BaseModel):
    items: list[BookingItem] = Field(default_factory=list)
    total_estimate_sgd: float = 0.0
    is_mock: bool = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_booking_id(category: str, *parts: str) -> str:
    """Deterministic, replayable mock id. Same inputs -> same id."""
    key = "|".join([category, *parts])
    return "TC-MOCK-" + hashlib.sha1(key.encode("utf-8")).hexdigest()[:8]


def _booking_com_url(city: str, checkin: str, checkout: str, guests: int) -> str:
    params: dict[str, Any] = {
        "ss": city,
        "checkin": checkin,
        "checkout": checkout,
        "group_adults": guests,
        "no_rooms": 1,
    }
    if _BOOKING_AID:
        params["aid"] = _BOOKING_AID
    return f"https://www.booking.com/searchresults.html?{urlencode(params)}"


def _klook_url(name: str) -> str:
    return f"https://www.klook.com/search/?keyword={quote_plus(name)}"


def _skyscanner_fallback_url(origin_iata: str, destination_iata: str, departure_date: str) -> str:
    # Skyscanner uses YYMMDD; used only as a Duffel fallback deep link.
    date_compact = departure_date.replace("-", "")[2:]
    return (
        f"https://www.skyscanner.com/transport/flights/"
        f"{origin_iata.lower()}/{destination_iata.lower()}/{date_compact}/"
    )


def _flight_deeplink_dict(
    origin_iata: str,
    destination_iata: str,
    departure_date: str,
    estimated_price_sgd: Optional[float],
    note: str,
) -> dict[str, Any]:
    # NOTE: Skyscanner URL maps to source="booking_deeplink" because the source
    # enum has no skyscanner_deeplink slot — this is the umbrella for non-Duffel
    # non-Klook deep links.
    return {
        "booking_id": _mock_booking_id("flight", origin_iata, destination_iata, departure_date),
        "category": "flight",
        "name": f"{origin_iata}->{destination_iata} ({departure_date})",
        "price_estimate_sgd": estimated_price_sgd,
        "status": "reserved",
        "book_url": _skyscanner_fallback_url(origin_iata, destination_iata, departure_date),
        "source": "booking_deeplink",
        "is_mock": True,
        "notes": note,
    }


async def _duffel_post(client: httpx.AsyncClient, path: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST to Duffel; return parsed 'data' field. Raises on HTTP errors."""
    headers = {
        "Authorization": f"Bearer {_DUFFEL_TOKEN}",
        "Duffel-Version": "v2",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    resp = await client.post(f"{_DUFFEL_URL}{path}", json=body, headers=headers)
    resp.raise_for_status()
    return (resp.json() or {}).get("data", {}) or {}


async def _duffel_book_flight(
    origin_iata: str, destination_iata: str, departure_date: str
) -> Optional[dict[str, Any]]:
    """Call Duffel sandbox: offer request, then attempt order. Returns dict on
    success or None on failure (caller falls back to deep link)."""
    offer_req_body = {
        "data": {
            "slices": [{
                "origin": origin_iata,
                "destination": destination_iata,
                "departure_date": departure_date,
            }],
            "passengers": [{"type": "adult"}],
            "cabin_class": "economy",
        }
    }
    async with httpx.AsyncClient(timeout=_DUFFEL_TIMEOUT) as client:
        try:
            offer_data = await _duffel_post(client, "/air/offer_requests", offer_req_body)
        except (httpx.HTTPError, ValueError) as exc:
            logger.warning("Duffel offer_requests failed: %s", exc)
            return None

        offers = offer_data.get("offers") or []
        if not offers:
            logger.warning(
                "Duffel returned 0 offers for %s->%s %s",
                origin_iata, destination_iata, departure_date,
            )
            return None
        offer = offers[0]
        offer_id = offer.get("id", "")
        total_amount = offer.get("total_amount")
        total_currency = offer.get("total_currency", "SGD")
        owner_name = (offer.get("owner") or {}).get("name", "Duffel Airways")
        try:
            price: Optional[float] = float(total_amount) if total_amount is not None else None
        except (TypeError, ValueError):
            price = None

        order_body = {
            "data": {
                "selected_offers": [offer_id],
                "passengers": [{
                    "type": "adult", "title": "mr",
                    "given_name": "Demo", "family_name": "User",
                    "born_on": "1990-01-01", "gender": "m",
                    "email": "demo@tripcanvas.dev", "phone_number": "+6512345678",
                }],
                "payments": [{
                    "type": "balance",
                    "currency": total_currency,
                    "amount": str(total_amount) if total_amount is not None else "0",
                }],
            }
        }
        try:
            order_data = await _duffel_post(client, "/air/orders", order_body)
        except (httpx.HTTPError, ValueError) as exc:
            # Graceful degrade: keep offer-level confirmation (sandbox order
            # creation often fails on passenger schema; offer is enough for demo).
            logger.warning("Duffel orders failed (%s); using offer %s", exc, offer_id)
            return {
                "booking_id": offer_id,
                "category": "flight",
                "name": f"{owner_name} {origin_iata}->{destination_iata} ({departure_date})",
                "price_estimate_sgd": price,
                "status": "confirmed",
                "book_url": f"https://app.duffel.com/offers/{offer_id}",
                "source": "duffel_sandbox",
                "is_mock": True,
                "notes": f"Duffel sandbox offer {offer_id}; price {total_currency} {total_amount}.",
            }

        order_id = order_data.get("id") or offer_id
        booking_reference = order_data.get("booking_reference", "")
        return {
            "booking_id": order_id,
            "category": "flight",
            "name": f"{owner_name} {origin_iata}->{destination_iata} ({departure_date})",
            "price_estimate_sgd": price,
            "status": "confirmed",
            "book_url": f"https://app.duffel.com/orders/{order_id}",
            "source": "duffel_sandbox",
            "is_mock": True,
            "notes": (
                f"Duffel sandbox order {order_id} (ref {booking_reference}); "
                f"price {total_currency} {total_amount}."
            ),
        }


# ---------------------------------------------------------------------------
# Function tools
# ---------------------------------------------------------------------------


@function_tool
async def book_flight(
    origin_iata: str,
    destination_iata: str,
    departure_date: str,
    estimated_price_sgd: Optional[float] = None,
) -> dict:
    """Book a flight via Duffel sandbox; fall back to deep-link composer.

    origin_iata and destination_iata are 3-letter IATA codes (e.g. 'SIN', 'NRT').
    departure_date is YYYY-MM-DD. status='confirmed' only when Duffel sandbox
    responds; otherwise status='reserved' with a Skyscanner deep link.
    """
    if not _DUFFEL_ENABLED:
        return _flight_deeplink_dict(
            origin_iata, destination_iata, departure_date, estimated_price_sgd,
            "Duffel sandbox disabled (no DUFFEL_TEST_TOKEN); reserved via deep link only.",
        )
    try:
        result = await _duffel_book_flight(origin_iata, destination_iata, departure_date)
    except Exception as exc:  # noqa: BLE001 — tool must never raise
        logger.warning("Unexpected Duffel error: %s", exc)
        result = None
    if result is None:
        return _flight_deeplink_dict(
            origin_iata, destination_iata, departure_date, estimated_price_sgd,
            "Duffel sandbox unavailable; reserved via deep link only.",
        )
    if result.get("price_estimate_sgd") is None and estimated_price_sgd is not None:
        result["price_estimate_sgd"] = estimated_price_sgd
    return result


@function_tool
async def book_hotel(
    city: str,
    checkin: str,
    checkout: str,
    hotel_name: str,
    estimated_price_per_night_sgd: Optional[float] = None,
    guests: int = 2,
) -> dict:
    """Compose a Booking.com search URL for a hotel; return a reserved BookingItem.

    No external API call — pure URL composition. status='reserved'.
    """
    try:
        return {
            "booking_id": _mock_booking_id("hotel", city, checkin),
            "category": "hotel",
            "name": hotel_name,
            "price_estimate_sgd": estimated_price_per_night_sgd,
            "status": "reserved",
            "book_url": _booking_com_url(city, checkin, checkout, guests),
            "source": "booking_deeplink",
            "is_mock": True,
            "notes": (
                f"Reserved for {checkin}->{checkout} ({guests} adults). "
                "Click book_url to confirm on Booking.com."
            ),
        }
    except Exception as exc:  # noqa: BLE001 — tool must never raise
        logger.warning("book_hotel unexpected error: %s", exc)
        return {
            "booking_id": _mock_booking_id("hotel", city or "unknown", checkin or "unknown"),
            "category": "hotel",
            "name": hotel_name or "(unknown hotel)",
            "price_estimate_sgd": estimated_price_per_night_sgd,
            "status": "reserved",
            "book_url": "https://www.booking.com/",
            "source": "booking_deeplink",
            "is_mock": True,
            "notes": "Reserved via Booking.com (URL composition fallback).",
        }


@function_tool
async def book_attraction(
    name: str,
    city: str,
    estimated_price_sgd: Optional[float] = None,
) -> dict:
    """Compose a Klook search URL for an attraction; return a reserved BookingItem."""
    try:
        return {
            "booking_id": _mock_booking_id("attraction", name, city),
            "category": "attraction",
            "name": name,
            "price_estimate_sgd": estimated_price_sgd,
            "status": "reserved",
            "book_url": _klook_url(name),
            "source": "klook_deeplink",
            "is_mock": True,
            "notes": f"Reserved via Klook search for {name} in {city}.",
        }
    except Exception as exc:  # noqa: BLE001 — tool must never raise
        logger.warning("book_attraction unexpected error: %s", exc)
        return {
            "booking_id": _mock_booking_id("attraction", name or "unknown", city or "unknown"),
            "category": "attraction",
            "name": name or "(unknown attraction)",
            "price_estimate_sgd": estimated_price_sgd,
            "status": "reserved",
            "book_url": "https://www.klook.com/",
            "source": "klook_deeplink",
            "is_mock": True,
            "notes": "Reserved via Klook (URL composition fallback).",
        }


# ---------------------------------------------------------------------------
# Agent + runner
# ---------------------------------------------------------------------------


booking_agent = Agent(
    name="booking_agent",
    model="gpt-5.5-2026-04-23",
    tools=[book_flight, book_hotel, book_attraction],
    instructions=(
        "You are a booking agent. Given enricher output (a recommended hotel, recommended "
        "flight string, and list of attractions), call the appropriate tools to produce a "
        "BookingResult. For flights, convert city names to IATA codes using your knowledge "
        "(Singapore->SIN, Tokyo->NRT or HND, Osaka->KIX, etc.) before calling book_flight. "
        "Call book_hotel ONCE for the recommended hotel. Call book_attraction ONCE for each "
        "attraction. If no flight is recommended (empty string), skip book_flight entirely. "
        "After all tool calls, assemble the BookingResult: items is the list of returned "
        "BookingItems; total_estimate_sgd is the sum of non-null price_estimate_sgd values; "
        "is_mock is True. Do NOT fabricate booking_ids or URLs — only use what the tools return."
    ),
    output_type=BookingResult,
)


async def _run_agent_with_fallback(agent: Agent, prompt: str, max_turns: int) -> RunResult:
    """Run agent; fall back to gpt-4o clone on model-not-found errors."""
    try:
        return await Runner.run(agent, prompt, max_turns=max_turns)
    except _MODEL_ERRORS:
        logger.warning("Model unavailable for %s; falling back to gpt-4o", agent.name)
        return await Runner.run(agent.clone(model="gpt-4o"), prompt, max_turns=max_turns)


def _booking_prompt(
    destination_city: str,
    start_date: str,
    end_date: str,
    recommended_hotel: str,
    recommended_flight: str,
    origin_city: Optional[str],
    attractions: list[str],
) -> str:
    attractions_block = "\n".join(f"  - {a}" for a in attractions) if attractions else "  (none)"
    return (
        f"Destination: {destination_city}\n"
        f"Trip dates: {start_date} -> {end_date}\n"
        f"Origin city: {origin_city or '(none)'}\n"
        f"Recommended hotel: {recommended_hotel}\n"
        f"Recommended flight: {recommended_flight or '(none)'}\n"
        f"Attractions to reserve:\n{attractions_block}\n\n"
        "Call the appropriate booking tools and assemble a BookingResult."
    )


async def book_trip(
    destination_city: str,
    start_date: str,
    end_date: str,
    recommended_hotel: str,
    recommended_flight: str,
    origin_city: Optional[str],
    attractions: list[str],
) -> BookingResult:
    """Run booking_agent under a 25s wall budget. Always returns — never raises."""
    prompt = _booking_prompt(
        destination_city, start_date, end_date,
        recommended_hotel, recommended_flight, origin_city, attractions,
    )
    try:
        run_result = await asyncio.wait_for(
            _run_agent_with_fallback(booking_agent, prompt, max_turns=20),
            timeout=_BOOKING_AGENT_TIMEOUT,
        )
    except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001 — never raise
        logger.warning("book_trip failed (%s); returning empty mock result", exc)
        return BookingResult(items=[], total_estimate_sgd=0.0, is_mock=True)

    final = run_result.final_output
    if isinstance(final, BookingResult):
        # Hard-enforce both invariants regardless of model output:
        #   (1) is_mock=True on every item
        #   (2) status="confirmed" ONLY when source="duffel_sandbox" — demote otherwise.
        sanitized: list[BookingItem] = []
        for item in final.items:
            updates: dict[str, Any] = {"is_mock": True}
            if item.status == "confirmed" and item.source != "duffel_sandbox":
                logger.warning(
                    "Demoting status='confirmed' to 'reserved' for non-sandbox item %s (source=%s)",
                    item.booking_id, item.source,
                )
                updates["status"] = "reserved"
            sanitized.append(item.model_copy(update=updates))
        return BookingResult(items=sanitized, total_estimate_sgd=final.total_estimate_sgd, is_mock=True)
    logger.warning("booking_agent returned non-BookingResult: %s", type(final))
    return BookingResult(items=[], total_estimate_sgd=0.0, is_mock=True)


# ---------------------------------------------------------------------------
# Smoke test
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import json

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    print("=" * 65)
    print("spike_booking.py smoke test")
    print("=" * 65)
    result = asyncio.run(
        book_trip(
            destination_city="Tokyo",
            start_date="2026-06-10",
            end_date="2026-06-13",
            recommended_hotel="Grand Hyatt Tokyo",
            recommended_flight="Scoot TR828 SIN->NRT ~SGD 523",
            origin_city="Singapore",
            attractions=["Tokyo Dream Park", "Harry Potter Cafe", "Sando Lab Tokyo"],
        )
    )
    print(json.dumps(result.model_dump(), indent=2, ensure_ascii=False))
    for item in result.items:
        assert item.is_mock is True, f"is_mock must be True for {item.booking_id}"
        if item.status == "confirmed":
            assert item.source == "duffel_sandbox", (
                f"confirmed only with duffel_sandbox, got {item.source}"
            )
    print(
        f"\n{len(result.items)} bookings, total ~SGD "
        f"{result.total_estimate_sgd:.2f}, mock={result.is_mock}"
    )
