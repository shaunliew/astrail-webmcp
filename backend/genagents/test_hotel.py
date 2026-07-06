"""Hotel-search tests. Pure SSE parse + injected-client logic stay offline (Travala is keyless, but
MockTransport keeps pytest network-free). The real call is one @pytest.mark.live test, skipped by default."""
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
