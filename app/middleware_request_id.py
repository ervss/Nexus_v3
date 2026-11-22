"""Attach X-Request-ID to each request/response."""
from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from .request_context import request_id_ctx


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        if request.method == "OPTIONS" and request.headers.get("Access-Control-Request-Private-Network") == "true":
            origin = request.headers.get("Origin") or "*"
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH",
                    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") or "*",
                    "Access-Control-Allow-Private-Network": "true",
                    "Access-Control-Max-Age": "86400",
                },
            )
        incoming = request.headers.get("X-Request-ID")
        rid = incoming.strip() if incoming and incoming.strip() else str(uuid.uuid4())
        token = request_id_ctx.set(rid)
        try:
            response = await call_next(request)
            response.headers["X-Request-ID"] = rid
            response.headers["Access-Control-Allow-Private-Network"] = "true"
            return response
        finally:
            request_id_ctx.reset(token)
