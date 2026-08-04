"""Hotel-search tests. Pure SSE parse + injected-client logic stay offline (Travala is keyless, but
MockTransport keeps pytest network-free). The real call is one @pytest.mark.live test, skipped by default."""
import json

import httpx
import pytest

from genagents.hotel import _parse_sse, search_hotels

# One SSE-framed JSON-RPC response: result.content[0].text = a JSON string with hotels + sessionId.
_HOTELS_TEXT = (
    '{"sessionId":"sess-1","totalFound":2,"hotels":['
    '{"name":"Park Hyatt Tokyo","star":5,"rating":9.6,"pricePerNight":1176,"totalPrice":1176,'
    '"currency":"USD","hotelId":13278,"packageId":"pkg-a","headline":"In Tokyo (Shinjuku)"},'
    '{"name":"APA Nishishinjuku","star":3,"pricePerNight":181,"totalPrice":181,"currency":"USD",'
    '"hotelId":44978,"packageId":"pkg-b","address":"Nishishinjuku"}]}'
)
_SSE_BODY = ('event: message\n'
             'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":'
             + __import__("json").dumps(_HOTELS_TEXT) + '}]}}\n\n')


def _mock_client(text=None, *, status=200, payload=None):
    def handler(request):
        if payload is not None:
            return httpx.Response(status, json=payload)
        return httpx.Response(status, text=text)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_parse_sse_concats_data_lines():
    msg = _parse_sse('event: message\ndata: {"a":\ndata: 1}\n\n')
    assert msg == {"a": 1}


def test_parse_sse_empty_raises():
    with pytest.raises(RuntimeError):
        _parse_sse("event: ping\n\n")


async def test_search_hotels_parses():
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(_SSE_BODY))
    assert session == "sess-1"
    assert [h["name"] for h in hotels] == ["Park Hyatt Tokyo", "APA Nishishinjuku"]
    assert hotels[0]["star"] == 5 and hotels[0]["hotelId"] == 13278


async def test_search_hotels_non_200_raises():
    with pytest.raises(RuntimeError) as exc:
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                            client=_mock_client("nope", status=502))
    assert "502" in str(exc.value)


async def test_search_hotels_request_error_sanitized():
    def boom(request):
        raise httpx.ConnectError("boom")
    client = httpx.AsyncClient(transport=httpx.MockTransport(boom))
    with pytest.raises(RuntimeError) as exc:
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"], client=client)
    assert "ConnectError" in str(exc.value)


async def test_search_hotels_jsonrpc_error_raises():
    body = 'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"bad"}}\n\n'
    with pytest.raises(RuntimeError):
        await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"], client=_mock_client(body))


async def test_search_hotels_empty_content_returns_empty():
    body = 'data: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n'
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(body))
    assert session is None and hotels == []


# --- T1: Travala's second content block (narrative details incl. real street address) ---
# content[0] = compact list (no street address); content[1] = narrative details keyed by hotelId.
# hotelIds are STRINGS to match the real Travala wire format (both content blocks use
# string ids, e.g. "18119"); an int/str drift on one side would silently break the merge.
_COMPACT_TEXT = (
    '{"sessionId":"sess-2","totalFound":2,"hotels":['
    '{"name":"Park Hyatt Tokyo","star":5,"pricePerNight":1176,"currency":"USD",'
    '"hotelId":"13278","headline":"In Shinjuku"},'
    '{"name":"APA Nishishinjuku","star":3,"pricePerNight":181,"currency":"USD","hotelId":"44978"}]}'
)
# Narrative listed in the OPPOSITE order to prove matching is by hotelId, not position.
_NARRATIVE_TEXT = (
    '{"hotels":['
    '{"hotelId":"44978","address":"7-8-9 Nishishinjuku","location":"Shinjuku, Tokyo"},'
    '{"hotelId":"13278","address":"3-7-1-2 Nishi-Shinjuku","location":"Shinjuku, Tokyo",'
    '"thumbnail":"http://img/13278.jpg","headline":"Narrative headline"}]}'
)


def _two_block_body(compact_text, narrative_text):
    """SSE-framed JSON-RPC whose result.content has TWO text blocks (compact + narrative)."""
    return ('event: message\n'
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":['
            '{"type":"text","text":' + json.dumps(compact_text) + '},'
            '{"type":"text","text":' + json.dumps(narrative_text) + '}]}}\n\n')


def _one_block_body(compact_text):
    return ('event: message\n'
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":['
            '{"type":"text","text":' + json.dumps(compact_text) + '}]}}\n\n')


async def test_search_hotels_merges_address_from_second_block():
    body = _two_block_body(_COMPACT_TEXT, _NARRATIVE_TEXT)
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(body))
    assert session == "sess-2"
    by_id = {h["hotelId"]: h for h in hotels}
    # street address merged onto each hotel, matched by hotelId (narrative was in reverse order)
    assert by_id["13278"]["address"] == "3-7-1-2 Nishi-Shinjuku"
    assert by_id["44978"]["address"] == "7-8-9 Nishishinjuku"
    # optional narrative fields carried through
    assert by_id["13278"]["location"] == "Shinjuku, Tokyo"
    assert by_id["13278"]["thumbnail"] == "http://img/13278.jpg"
    # compact-block fields are NOT clobbered by the narrative block (additive merge)
    assert by_id["13278"]["headline"] == "In Shinjuku"


async def test_search_hotels_single_block_no_address():
    # content[0] only → hotels returned unchanged, no address invented, no crash
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(_one_block_body(_COMPACT_TEXT)))
    assert [h["name"] for h in hotels] == ["Park Hyatt Tokyo", "APA Nishishinjuku"]
    assert all("address" not in h for h in hotels)


async def test_search_hotels_malformed_second_block_skipped():
    # content[1] text is not JSON → merge skipped safely, hotels intact, no address, no raise
    body = ('event: message\n'
            'data: {"jsonrpc":"2.0","id":1,"result":{"content":['
            '{"type":"text","text":' + json.dumps(_COMPACT_TEXT) + '},'
            '{"type":"text","text":' + json.dumps("not json at all") + '}]}}\n\n')
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(body))
    assert [h["name"] for h in hotels] == ["Park Hyatt Tokyo", "APA Nishishinjuku"]
    assert all("address" not in h for h in hotels)


async def test_search_hotels_second_block_mismatched_id_skipped():
    # narrative entries whose hotelId matches nothing, plus one missing hotelId → no merge, no raise
    narrative = ('{"hotels":[{"hotelId":"99999","address":"Nowhere St"},'
                 '{"address":"No-Id St"}]}')
    body = _two_block_body(_COMPACT_TEXT, narrative)
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"],
                                          client=_mock_client(body))
    assert [h["name"] for h in hotels] == ["Park Hyatt Tokyo", "APA Nishishinjuku"]
    assert all("address" not in h for h in hotels)


def test_import_needs_no_keys(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import importlib
    import genagents.hotel as h
    importlib.reload(h)
    assert h._parse_sse('data: {"x":1}\n') == {"x": 1}


@pytest.mark.live
async def test_live_search_hotels_tokyo():
    session, hotels = await search_hotels("Tokyo", "2026-08-01", "2026-08-02", ["2"])
    assert hotels and all(h.get("name") for h in hotels)
