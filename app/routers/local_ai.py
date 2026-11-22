"""
Minimal LM Studio PoC proxy for the Nexus dashboard Log Center.

    POST /local-ai/analyze  →  localhost:1234/v1/chat/completions
"""
from __future__ import annotations

import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter(tags=["local-ai"])

LM_BASE = "http://localhost:1234/v1"
CONNECT_TIMEOUT_S = 3.0
READ_TIMEOUT_S = 90.0
MAX_CONTEXT_CHARS = 10_000  # ~8–12 KB bound
MAX_TOKENS = 1000  # ~800–1200 cap


class AnalyzeRequest(BaseModel):
    context: str = Field(..., min_length=1, max_length=20_000)
    prompt: Optional[str] = Field(
        default="Summarize the key issues and suggest the next concrete actions.",
        max_length=500,
    )


def _truncate(text: str, limit: int = MAX_CONTEXT_CHARS) -> str:
    raw = (text or "").strip()
    if len(raw) <= limit:
        return raw
    return raw[:limit] + "\n…[truncated]"


def _pick_model_id(payload: Any) -> Optional[str]:
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list) or not data:
        return None
    first = data[0]
    if isinstance(first, dict):
        model_id = first.get("id") or first.get("model")
        if model_id:
            return str(model_id)
    return None


@router.post("/local-ai/analyze")
async def local_ai_analyze(req: AnalyzeRequest):
    """Proxy a short log/dashboard context to the local LM Studio server."""
    context = _truncate(req.context)
    if not context:
        raise HTTPException(status_code=400, detail="Empty context")

    timeout = httpx.Timeout(
        connect=CONNECT_TIMEOUT_S,
        read=READ_TIMEOUT_S,
        write=30.0,
        pool=CONNECT_TIMEOUT_S,
    )

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                models_res = await client.get(f"{LM_BASE}/models")
            except httpx.ConnectError as exc:
                raise HTTPException(
                    status_code=503,
                    detail="LM Studio unreachable at http://localhost:1234 (is it running?)",
                ) from exc
            except httpx.TimeoutException as exc:
                raise HTTPException(
                    status_code=504,
                    detail="LM Studio timed out while listing models (connect timeout).",
                ) from exc

            if models_res.status_code >= 400:
                raise HTTPException(
                    status_code=502,
                    detail=f"LM Studio /models failed: HTTP {models_res.status_code}",
                )

            model_id = _pick_model_id(models_res.json())
            if not model_id:
                raise HTTPException(status_code=503, detail="No model loaded in LM Studio")

            body = {
                "model": model_id,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a concise local assistant for the Nexus media dashboard. "
                            "Analyze the provided logs/errors/dashboard snapshot. "
                            "Reply in short bullets: issues found, likely cause, next actions."
                        ),
                    },
                    {
                        "role": "user",
                        "content": f"{req.prompt or ''}\n\n{context}".strip(),
                    },
                ],
                "temperature": 0.2,
                "max_tokens": MAX_TOKENS,
            }

            try:
                chat_res = await client.post(f"{LM_BASE}/chat/completions", json=body)
            except httpx.ConnectError as exc:
                raise HTTPException(
                    status_code=503,
                    detail="LM Studio unreachable at http://localhost:1234 (is it running?)",
                ) from exc
            except httpx.TimeoutException as exc:
                raise HTTPException(
                    status_code=504,
                    detail="LM Studio timed out waiting for a response (inference took too long).",
                ) from exc

            if chat_res.status_code >= 400:
                detail = chat_res.text[:300] if chat_res.text else f"HTTP {chat_res.status_code}"
                raise HTTPException(
                    status_code=502,
                    detail=f"LM Studio chat failed: {detail}",
                )

            data = chat_res.json()
            choices = data.get("choices") if isinstance(data, dict) else None
            content = ""
            if isinstance(choices, list) and choices:
                message = choices[0].get("message") if isinstance(choices[0], dict) else None
                if isinstance(message, dict):
                    content = str(message.get("content") or "").strip()
            if not content:
                raise HTTPException(status_code=502, detail="LM Studio returned an empty reply")

            return {
                "ok": True,
                "model": model_id,
                "reply": content,
                "context_chars": len(context),
            }
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("local-ai analyze failed")
        raise HTTPException(status_code=500, detail=f"Local AI proxy error: {exc}") from exc
