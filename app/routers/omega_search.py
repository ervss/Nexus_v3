"""FastAPI router pre progresívny 4-vrstvový Omni-Search (/api/v1/search/omega) a správu SearXNG/CB."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from app.extractors.circuit_breaker import extractor_circuit_breaker
from app.search.omega import ALL_LAYERS, OMEGA_SOURCE_CATALOG, clear_omega_cache, stream_omega_search

logger = logging.getLogger("nexus.omega_search.router")
router = APIRouter(tags=["omega-search"])

_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _format_sse(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _searxng_url() -> str:
    return (os.getenv("SEARXNG_URL") or "http://127.0.0.1:8888/search").rstrip("/")


async def _probe_searxng() -> Dict[str, Any]:
    url = _searxng_url()
    host = urlparse(url).netloc or "127.0.0.1:8888"
    running = False
    error = ""
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            resp = await client.get(f"{url}?q=ping&format=json")
            running = resp.status_code == 200
            if not running:
                error = f"HTTP {resp.status_code}"
    except Exception as exc:
        error = str(exc)

    cb_allowed, cb_retry = extractor_circuit_breaker.allow(host)
    return {
        "running": running,
        "url": url,
        "error": error,
        "circuit_open": not cb_allowed,
        "circuit_retry_after_s": cb_retry,
    }


@router.get("/search/omega/sources")
async def omega_sources_status():
    """Vráti katalóg všetkých Omni-Search vrstiev, presetov a stav Circuit Breakera + SearXNG."""
    return {
        **OMEGA_SOURCE_CATALOG,
        "searxng": await _probe_searxng(),
        "circuit_breaker": extractor_circuit_breaker.snapshot(),
    }


@router.get("/search/omega/searxng/status")
async def omega_searxng_status():
    """Rýchla kontrola dostupnosti lokálneho SearXNG."""
    return await _probe_searxng()


@router.post("/search/omega/searxng/start")
async def omega_searxng_start():
    """Spustí lokálny SearXNG na pozadí cez scripts/start_searxng.ps1 a odomkne circuit breaker."""
    status_before = await _probe_searxng()
    host = urlparse(_searxng_url()).netloc or "127.0.0.1:8888"
    extractor_circuit_breaker.reset(host)
    if status_before["running"]:
        return {"ok": True, "already_running": True, **(await _probe_searxng())}

    script = _PROJECT_ROOT / "scripts" / "start_searxng.ps1"
    if not script.exists():
        raise HTTPException(status_code=404, detail=f"Chýba skript {script}")

    def _launch() -> subprocess.CompletedProcess:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        return subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-WaitSeconds", "15"],
            cwd=str(_PROJECT_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            timeout=25,
        )

    proc = await asyncio.to_thread(_launch)
    status_after = await _probe_searxng()
    return {
        "ok": status_after["running"],
        "returncode": proc.returncode,
        "detail": "" if status_after["running"] else "Pozri logs/searxng-server-error.log",
        **status_after,
    }


@router.post("/search/omega/circuit/reset")
async def omega_circuit_reset(domain: Optional[str] = Query(None)):
    """Resetuje circuit breaker (celý alebo konkrétnu doménu) a vymaže cache."""
    cleared = extractor_circuit_breaker.reset(domain)
    cache_cleared = clear_omega_cache()
    return {"ok": True, "circuits_reset": cleared, "cache_cleared": cache_cleared}


@router.get("/search/omega")
async def search_omega(
    query: str = Query(..., min_length=2, max_length=300),
    preset: str = Query("all", description="all | leaks | tubes | fast"),
    layers: Optional[str] = Query(None, description="CSV vrstiev: local_vault,telethon,api,kvs,wp_dle,dork"),
    sources: Optional[str] = Query(None, description="CSV konkrétnych source kľúčov"),
    min_quality: int = Query(0, ge=0, le=4320),
    per_source_limit: int = Query(20, ge=1, le=50),
    timeout_s: float = Query(10.0, ge=2.0, le=45.0),
    use_cache: bool = Query(True),
    stream: bool = Query(True, description="True = SSE text/event-stream, False = agregovaný JSON"),
):
    """Progresívny 4-vrstvový Omni-Search (Local Vault -> Telethon -> API / KVS / WP-DLE / SearXNG Dorks)."""
    clean_q = (query or "").strip()
    if len(clean_q) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")

    selected_layers = None
    if layers:
        parsed_layers = {part.strip().lower() for part in layers.split(",") if part.strip()}
        selected_layers = {l for l in parsed_layers if l in ALL_LAYERS} or set(ALL_LAYERS)

    selected_sources = None
    if sources:
        selected_sources = {part.strip().lower() for part in sources.split(",") if part.strip()} or None

    if not stream:
        all_items: List[Dict[str, Any]] = []
        statuses: List[Dict[str, Any]] = []
        done_payload: Dict[str, Any] = {}
        async for ev in stream_omega_search(
            clean_q,
            preset=preset,
            layers=selected_layers,
            source_keys=selected_sources,
            min_quality=min_quality,
            per_source_limit=per_source_limit,
            timeout_s=timeout_s,
            use_cache=use_cache,
        ):
            name = ev["event"]
            data = ev["data"]
            if name == "results":
                all_items.extend(data.get("items") or [])
                statuses.append({k: v for k, v in data.items() if k != "items"})
            elif name == "source_status":
                statuses.append(data)
            elif name == "done":
                done_payload = data
        return JSONResponse(
            {
                "query": clean_q,
                "total_results": len(all_items),
                "results": all_items,
                "statuses": statuses,
                **done_payload,
            }
        )

    async def _sse_gen() -> AsyncIterator[str]:
        async for ev in stream_omega_search(
            clean_q,
            preset=preset,
            layers=selected_layers,
            source_keys=selected_sources,
            min_quality=min_quality,
            per_source_limit=per_source_limit,
            timeout_s=timeout_s,
            use_cache=use_cache,
        ):
            yield _format_sse(ev["event"], ev["data"])

    return StreamingResponse(
        _sse_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
