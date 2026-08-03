from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.errors import register_error_handlers


def _app() -> FastAPI:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom-http")
    async def boom_http():
        raise HTTPException(status_code=404, detail="Trip not found")

    @app.get("/boom-500")
    async def boom_500():
        raise RuntimeError("secret db dsn leaked here")

    # Task 3: dict-detail branch — an internally-raised HTTPException whose detail is a
    # {"code","message"} dict is unpacked into the envelope (vs the string path below).
    @app.get("/boom-dict-code")
    async def boom_dict_code():
        raise HTTPException(
            status_code=403,
            detail={"code": "trial_exhausted", "message": "Your free trip is planned."},
        )

    @app.get("/boom-dict-503")
    async def boom_dict_503():
        raise HTTPException(
            status_code=503,
            detail={"code": "generation_unavailable",
                    "message": "Trip generation temporarily unavailable"},
        )

    @app.get("/boom-dict-nocode")
    async def boom_dict_nocode():
        raise HTTPException(status_code=403, detail={"message": "no code here"})

    @app.get("/boom-429-string")
    async def boom_429_string():
        raise HTTPException(status_code=429, detail="slow down")

    @app.get("/boom-dict-nomessage")
    async def boom_dict_nomessage():
        raise HTTPException(status_code=400, detail={"foo": "bar"})

    return app


def test_http_exception_is_enveloped():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-http")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Trip not found"}}


def test_unhandled_exception_does_not_leak():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-500")
    assert r.status_code == 500
    body = r.json()
    assert body["error"]["code"] == "internal_error"
    assert "secret db dsn" not in body["error"]["message"]


def test_framework_404_is_enveloped():
    # Starlette's routing layer raises the base starlette.exceptions.HTTPException
    # for an unmatched route, NOT fastapi.HTTPException. The handler must be
    # registered so it catches this base class too, or framework 404s leak the
    # raw {"detail": "Not Found"} shape past the envelope.
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/no-such-route")
    assert r.status_code == 404
    assert r.json() == {"error": {"code": "not_found", "message": "Not Found"}}


def test_framework_405_is_enveloped():
    # Same base-class issue as above, but for Starlette's "method not allowed".
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.post("/boom-http")
    assert r.status_code == 405
    body = r.json()
    assert "error" in body
    assert body["error"]["message"] == "Method Not Allowed"


# ── Task 3: dict-detail branch in http_exception_handler ──────────────────────────
# A {"code","message"} dict detail is unpacked into the envelope; the string path is
# unchanged; a code-less dict slugs by status; a message-less dict falls through to str().


def test_dict_detail_passes_code_and_message_through():
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-dict-code")
    assert r.status_code == 403
    assert r.json() == {
        "error": {"code": "trial_exhausted", "message": "Your free trip is planned."}
    }


def test_dict_detail_503_code_passthrough():
    # 503 has no slug in _STATUS_CODE_SLUG, but the dict carries an explicit code.
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-dict-503")
    assert r.status_code == 503
    assert r.json() == {
        "error": {"code": "generation_unavailable",
                  "message": "Trip generation temporarily unavailable"}
    }


def test_dict_detail_without_code_falls_back_to_status_slug():
    # detail.get("code") is None -> build_error_response uses the 403 slug "forbidden".
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-dict-nocode")
    assert r.status_code == 403
    assert r.json() == {"error": {"code": "forbidden", "message": "no code here"}}


def test_string_detail_429_still_slugs_rate_limited():
    # The string path is pinned unchanged — a plain-string 429 still slugs rate_limited.
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-429-string")
    assert r.status_code == 429
    assert r.json() == {"error": {"code": "rate_limited", "message": "slow down"}}


def test_dict_without_message_key_falls_through_to_string_path():
    # The `and "message" in detail` guard: a dict lacking "message" must NOT KeyError —
    # it stringifies via the unchanged string path and slugs by status.
    client = TestClient(_app(), raise_server_exceptions=False)
    r = client.get("/boom-dict-nomessage")
    assert r.status_code == 400
    assert r.json() == {"error": {"code": "bad_request", "message": str({"foo": "bar"})}}
