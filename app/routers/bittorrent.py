"""
BitTorrent Web Integration – Router
=====================================
API endpointy pre BitTorrent Web integráciu.
Vyčlenené z app/main.py.

Endpointy:
  GET  /api/integrations/bittorrent-web/status
  GET  /api/integrations/bittorrent-web/items
  GET  /api/integrations/bittorrent-web/stream/{infohash}
  POST /api/integrations/bittorrent-web/open
"""

import logging
from fastapi import APIRouter, HTTPException, Request

from .bittorrent_service import (
    BITTORRENT_WEB_EXE_PATH,
    extract_bittorrent_items,
    get_bittorrent_web_status,
    launch_bittorrent_web,
    stream_file_response,
)

router = APIRouter(
    prefix="/api/integrations/bittorrent-web",
    tags=["BitTorrent Web"],
)


def _require_auth(request: Request) -> None:
    if not request.session.get("authenticated"):
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.get("/status")
async def bittorrent_web_status(request: Request):
    _require_auth(request)
    return get_bittorrent_web_status()


@router.get("/items")
async def bittorrent_web_items(request: Request, limit: int = 40):
    _require_auth(request)
    return {"items": extract_bittorrent_items(limit=max(1, min(limit, 200)))}


@router.get("/stream/{infohash}")
async def bittorrent_web_stream(infohash: str, request: Request):
    _require_auth(request)
    items = extract_bittorrent_items(limit=200)
    match = next((item for item in items if item.get("infohash") == infohash), None)
    if not match:
        raise HTTPException(status_code=404, detail="Torrent item not found")
    if not match.get("path"):
        raise HTTPException(status_code=404, detail="Playable video file not found for this torrent")
    return stream_file_response(
        str(match["path"]),
        dict(request.headers),
        allow_growing=bool(match.get("status") != "ready"),
    )


@router.post("/open")
async def open_bittorrent_web(request: Request):
    _require_auth(request)
    try:
        status = launch_bittorrent_web()
        return {"ok": True, "message": "BitTorrent Web launch requested.", **status}
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=f"BitTorrent Web not found at {BITTORRENT_WEB_EXE_PATH}",
        )
    except Exception as exc:
        logging.exception("Failed to launch BitTorrent Web")
        raise HTTPException(status_code=500, detail=f"Failed to launch BitTorrent Web: {exc}")
