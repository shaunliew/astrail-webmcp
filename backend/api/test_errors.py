import pytest
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
