"""Authenticated, bounded, local playback telemetry and admission state."""
import time
from collections import OrderedDict
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.auth import check_auth
from app.config import config
from app.streaming.external_devices import (
    cast_to_dlna_device,
    discover_dlna_devices,
    get_lan_ip_for_target,
    launch_vlc,
)
from app.streaming.playback_control import control
from app.streaming.resolution import get_resolver

router = APIRouter(prefix="/playback", tags=["playback"])
_recent = OrderedDict()


class Metrics(BaseModel):
    startup_ms: float | None = Field(None, ge=0, le=86400000)
    stalls: int = Field(0, ge=0, le=1000000)
    stall_ms: float = Field(0, ge=0, le=86400000)
    recovery_ms: float | None = Field(None, ge=0, le=86400000)
    recoveries: int = Field(0, ge=0, le=1000000)
    observed_ms: float = Field(0, ge=0, le=86400000)


class Activity(BaseModel):
    session_id: str = Field(min_length=12, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    phase: Literal["loading", "buffering", "recovering", "playing", "paused", "stopped", "ended", "error"]
    video_id: int = Field(0, ge=0)
    sequence: int = Field(0, ge=0)
    metrics: Metrics = Field(default_factory=Metrics)


@router.post("/activity", dependencies=[Depends(check_auth)])
async def playback_activity(body: Activity):
    previous = _recent.get(body.session_id)
    if previous and body.sequence <= previous["sequence"]:
        return control.snapshot()
    _recent[body.session_id] = {"video_id": body.video_id, "phase": body.phase,
                               "sequence": body.sequence, "at": time.time(), **body.metrics.model_dump()}
    _recent.move_to_end(body.session_id)
    while len(_recent) > 128:
        _recent.popitem(last=False)
    return control.report(body.session_id, body.phase, body.video_id)


@router.get("/metrics", dependencies=[Depends(check_auth)])
async def playback_metrics():
    resolver = get_resolver()
    return {"control": control.snapshot(), "resolver": {"hits": resolver.hits,
            "extractions": resolver.extractions, "inflight": len(resolver.coalescer._inflight)},
            "sessions": list(_recent.values())}


class OpenVlcRequest(BaseModel):
    video_id: int | None = None
    url: str = ""
    playback_src: str = ""
    source_url: str = ""
    title: str = ""


class CastTvRequest(BaseModel):
    control_url: str
    service_type: str = "urn:schemas-upnp-org:service:AVTransport:1"
    device_ip: str = ""
    device_name: str = ""
    video_id: int | None = None
    url: str = ""
    playback_src: str = ""
    title: str = ""


def _resolve_vlc_target(body: OpenVlcRequest) -> str:
    """Vyberie najlepšiu URL pre lokálne spustenie vo VLC."""
    src = (body.playback_src or "").strip()
    url = (body.url or "").strip()
    port = int(getattr(config, "SERVER_PORT", 8000) or 8000)

    if src.startswith("/") and not src.startswith("//"):
        return f"http://127.0.0.1:{port}{src}"
    if src.startswith(("http://127.0.0.1", "http://localhost")):
        return src
    if url.startswith(("http://", "https://")):
        return url
    if src.startswith(("http://", "https://")):
        return src
    if body.video_id:
        return f"http://127.0.0.1:{port}/stream_proxy/{body.video_id}.mp4"
    return ""


def _resolve_tv_media_url(body: CastTvRequest) -> str:
    """Vyberie URL dostupnú pre Smart TV v lokálnej sieti."""
    src = (body.playback_src or "").strip()
    url = (body.url or "").strip()
    port = int(getattr(config, "SERVER_PORT", 8000) or 8000)
    server_host = str(getattr(config, "SERVER_HOST", "127.0.0.1") or "127.0.0.1").strip()

    def _lan_proxy_url(path: str) -> str:
        if server_host in ("127.0.0.1", "localhost"):
            raise HTTPException(
                status_code=400,
                detail="Toto video beží cez lokálnu proxy a server počúva len na 127.0.0.1. Pre TV nastav SERVER_HOST=0.0.0.0 v .env a reštartuj Nexus.",
            )
        lan_ip = get_lan_ip_for_target(body.device_ip)
        return f"http://{lan_ip}:{port}{path}"

    # Ak máme relatívnu lokálnu cestu (napr. Telegram/Mega/lokálny súbor), TV potrebuje LAN IP.
    if src.startswith("/") and not src.startswith("//"):
        # Ak je to len všeobecná proxy, ale máme priamu verejnú HTTP(S) URL, preferujeme ju pre TV.
        if url.startswith(("http://", "https://")) and not any(
            h in url.lower() for h in ("127.0.0.1", "localhost")
        ) and src.startswith("/stream_proxy/"):
            return url
        return _lan_proxy_url(src)

    if url.startswith(("http://", "https://")) and not any(
        h in url.lower() for h in ("127.0.0.1", "localhost")
    ):
        return url

    if body.video_id:
        return _lan_proxy_url(f"/stream_proxy/{body.video_id}.mp4")

    return ""


@router.post("/open-vlc", dependencies=[Depends(check_auth)])
async def playback_open_vlc(body: OpenVlcRequest):
    target_url = _resolve_vlc_target(body)
    if not target_url:
        raise HTTPException(status_code=400, detail="Video nemá platnú URL na otvorenie vo VLC.")
    try:
        vlc_path = launch_vlc(target_url, title=body.title, referer=body.source_url)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Nepodarilo sa spustiť VLC: {exc}") from exc
    return {"ok": True, "url": target_url, "vlc_path": vlc_path}


@router.get("/tv/discover", dependencies=[Depends(check_auth)])
async def playback_discover_tv(refresh: bool = Query(False)):
    devices = await discover_dlna_devices(refresh=refresh)
    return {
        "devices": devices,
        "server_host": getattr(config, "SERVER_HOST", "127.0.0.1"),
        "server_port": int(getattr(config, "SERVER_PORT", 8000) or 8000),
    }


@router.post("/tv/cast", dependencies=[Depends(check_auth)])
async def playback_cast_tv(body: CastTvRequest):
    media_url = _resolve_tv_media_url(body)
    if not media_url:
        raise HTTPException(status_code=400, detail="Video nemá platnú URL na odoslanie do TV.")
    try:
        await cast_to_dlna_device(
            control_url=body.control_url,
            service_type=body.service_type,
            media_url=media_url,
            title=body.title or "Nexus Video",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Odoslanie do TV zlyhalo: {exc}") from exc
    return {"ok": True, "device_name": body.device_name or body.device_ip, "media_url": media_url}
