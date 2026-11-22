"""BitTorrent Web integration endpoints.

Extracted from the main.py monolith to establish the router-per-feature pattern.
The route handlers stay thin and pull the shared helpers (_extract_bittorrent_items,
_stream_file_response, ...) from app.main via a late import inside each handler —
the same pattern app/routers/system_health.py already uses — so there is no
circular import at module load time (app.main imports this router at startup;
this router only touches app.main once a request is actually served).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

router = APIRouter(tags=["bittorrent-web"])


def _require_auth(request: Request) -> None:
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.get("/api/integrations/bittorrent-web/status")
async def bittorrent_web_status(request: Request):
    _require_auth(request)
    from app.main import _get_bittorrent_web_status
    return _get_bittorrent_web_status()


@router.get("/api/integrations/bittorrent-web/items")
async def bittorrent_web_items(request: Request, limit: int = 40):
    _require_auth(request)
    from app.main import _extract_bittorrent_items
    return {"items": _extract_bittorrent_items(limit=max(1, min(limit, 200)))}


@router.get("/api/integrations/bittorrent-web/stream/{infohash}")
async def bittorrent_web_stream(infohash: str, request: Request):
    _require_auth(request)
    from app.main import _extract_bittorrent_items, _stream_file_response
    items = _extract_bittorrent_items(limit=200)
    match = next((item for item in items if item.get("infohash") == infohash), None)
    if not match:
        raise HTTPException(status_code=404, detail="Torrent item not found")
    if not match.get("path"):
        raise HTTPException(status_code=404, detail="Playable video file not found for this torrent")
    return _stream_file_response(
        str(match["path"]), request, allow_growing=bool(match.get("status") != "ready")
    )


@router.post("/api/integrations/bittorrent-web/open")
async def open_bittorrent_web(request: Request):
    _require_auth(request)
    import logging
    from app.main import _launch_bittorrent_web, BITTORRENT_WEB_EXE_PATH
    try:
        status = _launch_bittorrent_web()
        return {"ok": True, "message": "BitTorrent Web launch requested.", **status}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"BitTorrent Web not found at {BITTORRENT_WEB_EXE_PATH}")
    except Exception as exc:
        logging.exception("Failed to launch BitTorrent Web")
        raise HTTPException(status_code=500, detail=f"Failed to launch BitTorrent Web: {exc}")
