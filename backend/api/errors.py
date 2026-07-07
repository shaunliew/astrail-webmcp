"""Consistent JSON error envelope for the API: {"error": {"code", "message"}}.

Errors-only normalization (success responses keep their existing shapes). Every
shape here has a TypeScript mirror in frontend/lib/trip/backend-types.ts
(guardrail #4). The unhandled-exception handler must never leak internals.
"""
from __future__ import annotations

import logging

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("astrail.errors")

_STATUS_CODE_SLUG = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    409: "conflict",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
}


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorResponse(BaseModel):
    error: ErrorDetail


def build_error_response(status_code: int, message: str, code: str | None = None) -> JSONResponse:
    """Shared error-envelope builder. Public so the rate-limit 429 handler in
    main.py reuses it instead of hand-rolling the shape (DRY — F3)."""
    slug = code or _STATUS_CODE_SLUG.get(status_code, "error")
    return JSONResponse(status_code=status_code, content={"error": {"code": slug, "message": message}})


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    return build_error_response(exc.status_code, str(exc.detail))


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return build_error_response(422, "Request validation failed", code="validation_error")


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Log the real error server-side; return a generic message so nothing leaks.
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return build_error_response(500, "Internal server error", code="internal_error")


def register_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
