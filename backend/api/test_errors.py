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
