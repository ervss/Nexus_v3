"""Torrent search, qBittorrent handoff, thumbnails and stream-while-downloading."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from ..auth import check_auth
from ..torrent.limit import add_limiter, search_limiter, thumb_limiter
from ..torrent.normalize import canonical_infohash, lookup_download_ref, validate_magnet
from ..torrent.normalize import RejectedURL
from ..torrent.qbittorrent import QbitError, get_client
from ..torrent.search import SearchError, search_torrents
from ..torrent.settings import load_settings
from ..torrent.mypornclub import media_for, proxy_trailer
from ..torrent.stream import stream_torrent
from ..torrent.thumbs import get_thumbnail

logger = logging.getLogger("nexus.torrent")
router = APIRouter(prefix="/api/torrent", tags=["torrent"])
_PLACEHOLDER = Path(__file__).resolve().parents[1] / "static" / "torrent_placeholder.svg"


class AddTorrent(BaseModel):
    magnet: str = ""
    ref: str = Field(default="", max_length=80)


from ..config import config


def _auth(request: Request) -> None:
    if request.session.get("authenticated"):
        return
    token = request.headers.get("X-Nexus-Token")
    if config.NEXUS_BRIDGE_TOKEN:
        if token and token.strip() == config.NEXUS_BRIDGE_TOKEN:
            return
        raise HTTPException(status_code=401, detail="Not authenticated")
    client_host = request.client.host if request.client else ""
    if client_host in ("127.0.0.1", "::1", "localhost", "testclient"):
        return
    raise HTTPException(status_code=401, detail="Not authenticated")


def _limit(limiter) -> None:
    allowed, retry = limiter.allow()
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail="Too many requests",
            headers={"Retry-After": str(int(retry))},
        )


def _hash(value: str) -> str:
    digest = canonical_infohash(value)
    if not digest:
        raise HTTPException(status_code=400, detail="Infohash is not valid")
    return digest


@router.get("/health")
async def torrent_health(request: Request):
    _auth(request)
    settings = load_settings()
    payload = {
        "engine": "prowlarr" if settings.prowlarr_configured else "jackett" if settings.jackett_configured else "none",
        "jackett": {"configured": settings.jackett_configured, "url": settings.jackett_url},
        "prowlarr": {"configured": settings.prowlarr_configured},
        "qbittorrent": {
            "configured": settings.qbit_configured,
            "url": settings.qbit_url,
            "reachable": False,
            "version": None,
        },
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "theporndb": bool(settings.tpdb_api_key),
    }
    if settings.qbit_configured:
        try:
            version = await get_client().version()
            payload["qbittorrent"]["version"] = version
            payload["qbittorrent"]["reachable"] = bool(version)
        except QbitError as exc:
            payload["qbittorrent"]["error"] = exc.message
    return payload


@router.get("/search")
async def torrent_search(
    request: Request,
    q: str = Query(min_length=1, max_length=200),
    cat: int | None = Query(default=None, ge=0, le=999999),
):
    _auth(request)
    _limit(search_limiter)
    try:
        return await search_torrents(q, cat)
    except SearchError as exc:
        logger.warning("torrent search failed: %s", exc.message)
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc


@router.get("/thumb")
async def torrent_thumb(
    request: Request,
    hash: str = "",
    title: str = "",
    details: str = "",
    ref: str = "",
):
    _auth(request)
    _limit(thumb_limiter)
    from ..torrent.normalize import clean_details_url

    digest = _hash(hash) if hash else ""
    cache_key = f"ref:{ref.strip()}" if ref.strip() else ""
    if not digest and not cache_key:
        raise HTTPException(status_code=400, detail="Infohash is not valid")
    try:
        image = await get_thumbnail(
            digest,
            title[:180],
            clean_details_url(details[:800]),
            cache_key=cache_key,
        )
    except Exception:
        logger.exception("thumbnail lookup failed")
        image = None
    if not image:
        return FileResponse(_PLACEHOLDER, media_type="image/svg+xml", headers={"Cache-Control": "private, max-age=600"})
    kind, blob = image
    return Response(content=blob, media_type=kind, headers={"Cache-Control": "private, max-age=86400"})


@router.post("/add")
async def torrent_add(body: AddTorrent, request: Request):
    _auth(request)
    _limit(add_limiter)
    source = ""
    if body.magnet.strip():
        try:
            source = validate_magnet(body.magnet)
        except RejectedURL as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    elif body.ref.strip():
        source = lookup_download_ref(body.ref) or ""
        if not source:
            raise HTTPException(status_code=400, detail="Download reference expired")
    else:
        raise HTTPException(status_code=400, detail="Magnet link is required")
    try:
        digest = await get_client().add(source)
    except QbitError as exc:
        logger.warning("torrent add failed: %s", exc.message)
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc
    return {
        "ok": True,
        "hash": digest,
        "status_url": f"/api/torrent/status?hash={digest}",
        "stream_url": f"/api/torrent/stream?hash={digest}",
    }


@router.get("/status")
async def torrent_status(request: Request, hash: str):
    _auth(request)
    digest = _hash(hash)
    try:
        return await get_client().status(digest)
    except QbitError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc


@router.get("/trailer")
async def torrent_trailer(request: Request, details: str = "", hash: str = ""):
    """Play the MyPornClub preview without adding the torrent."""
    _auth(request)
    _limit(thumb_limiter)
    from ..torrent.normalize import clean_details_url

    page = clean_details_url(details[:800])
    if not page:
        raise HTTPException(status_code=400, detail="Details URL is required")
    media = await media_for(page)
    if not media.trailer:
        raise HTTPException(status_code=404, detail="Tento výsledok nemá trailer")
    logger.info("mypornclub trailer hash=%s", (hash or "")[:12])
    return await proxy_trailer(media.trailer, request, referer=page)


@router.get("/stream")
async def torrent_stream(request: Request, hash: str, t: float = Query(default=0, ge=0, le=86_400)):
    _auth(request)
    return await stream_torrent(_hash(hash), request, start=t)
