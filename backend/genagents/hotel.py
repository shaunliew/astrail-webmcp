"""Hotel enricher — Travala Travel MCP hotel search (SEARCH-ONLY, keyless HTTP).

Import discipline (mirrors transport/restaurant, guardrail #9): imports `httpx` lazily inside the
function; `import genagents.hotel` loads nothing heavy and needs no key.

Live-only — never imported by the offline eval / offline_harness.

Travala hotel SEARCH is KEYLESS (no key/OAuth/wallet) — a hosted Streamable-HTTP MCP. We call it as a
DIRECT httpx JSON-RPC POST (the Apify direct-HTTP pattern, guardrail #10), NOT an MCP client. The
response is SSE-framed (concat `data:` lines). Guardrail: SEARCH ONLY — NEVER travala_book / booking /
payment / x402. No LLM, no reel content → no guardrail #11.
"""
from __future__ import annotations

import json
import sys

_ENDPOINT = "https://travel-mcp.travala.com/mcp"


def _parse_sse(text: str) -> dict:
    """The server answers SSE-framed (data: {...}); concat all `data:` lines into one JSON-RPC msg."""
    data_lines = [ln[len("data:"):].strip() for ln in text.splitlines() if ln.startswith("data:")]
    if not data_lines:
        raise RuntimeError("travala: empty/non-SSE response")
    return json.loads("".join(data_lines))


async def search_hotels(location: str, check_in: str, check_out: str, rooms: list[str],
                        *, client=None) -> tuple[str | None, list[dict]]:
    """Search Travala for hotels in `location` for the dates + rooms. Returns (session_id, hotels),
    hotels = the compact list (each a dict: name/star/pricePerNight/totalPrice/currency/hotelId/
    packageId/headline/…). `client` is injectable (an httpx.AsyncClient) for offline tests.

    Sanitizes transport/HTTP errors into a token-free RuntimeError (there IS no token — keyless);
    a malformed-but-200 body or 0 hotels returns (None/…, []). A propagated error → the runner warns."""
    import httpx

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "travala_search_hotel",
                       "arguments": {"location": location, "checkIn": check_in, "checkOut": check_out,
                                     "rooms": rooms, "response_format": "json"}}}
    owns = client is None
    if client is None:
        client = httpx.AsyncClient(timeout=45)
    try:
        try:
            resp = await client.post(_ENDPOINT, json=body,
                                     headers={"Accept": "application/json, text/event-stream"})
        except httpx.RequestError as e:
            raise RuntimeError(f"travala request failed: {type(e).__name__}") from None
        if resp.status_code != 200:
            raise RuntimeError(f"travala HTTP {resp.status_code}")
        try:
            msg = _parse_sse(resp.text)
        except (ValueError, RuntimeError):
            raise RuntimeError("travala: unparseable response") from None
    finally:
        if owns:
            await client.aclose()

    if "error" in msg:
        raise RuntimeError("travala: JSON-RPC error")   # no payload — avoid leaking anything
    content = (msg.get("result") or {}).get("content") or []
    if not content:
        return None, []
    try:
        payload = json.loads(content[0]["text"])
    except (ValueError, KeyError, IndexError, TypeError):
        return None, []
    hotels = payload.get("hotels") or payload.get("results") or []
    session_id = payload.get("sessionId")
    print(f"  [hotels] location={location} {check_in}..{check_out} -> {len(hotels)} hotels", file=sys.stderr)
    return session_id, hotels
