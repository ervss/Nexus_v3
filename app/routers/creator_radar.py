"""Creator Radar & Browser Vault Companion REST API."""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import check_auth
from ..creator_radar import (
    follow_creator,
    get_creator_dossier,
    list_radar_creators,
    probe_companion_targets,
    unfollow_creator,
)
from ..creator_thumbs import (
    enhance_creator_thumbnail,
    enhance_creator_thumbnails_iter,
    resolve_cached_thumb_file,
)
from ..database import get_db
from .extension_bridge import ensure_bridge_token

logger = logging.getLogger(__name__)
router = APIRouter(tags=["Creator Radar & Companion"])


class FollowCreatorRequest(BaseModel):
    name: str = Field(..., min_length=2, max_length=160)
    notes: str = Field("", max_length=500)
    source_hint: str = Field("", max_length=200)


class ProbeCandidate(BaseModel):
    url: str = ""
    title: str = ""


class CompanionProbeRequest(BaseModel):
    query: str = Field("", max_length=200)
    page_url: str = Field("", max_length=2000)
    page_title: str = Field("", max_length=300)
    candidates: List[ProbeCandidate] = Field(default_factory=list, max_length=100)


class RadarRethumbRequest(BaseModel):
    item: Dict[str, Any]
    reroll: bool = False


class RadarRethumbBatchRequest(BaseModel):
    items: List[Dict[str, Any]] = Field(default_factory=list, min_length=1, max_length=120)
    reroll: bool = False


def _authorize_companion(request: Request, x_nexus_token: Optional[str]) -> None:
    """Authorize Chrome extensions / userscripts via bridge token or dashboard session."""
    if request and request.session.get("authenticated"):
        return
    ensure_bridge_token(x_nexus_token)


@router.get("/api/v1/radar/creators")
async def radar_creators(
    q: str = Query("", max_length=160),
    limit: int = Query(60, ge=1, le=200),
    only_followed: bool = Query(False),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    return list_radar_creators(db, q=q, limit=limit, only_followed=only_followed)


@router.post("/api/v1/radar/follow")
async def radar_follow(
    body: FollowCreatorRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    try:
        return follow_creator(db, name=body.name, notes=body.notes, source_hint=body.source_hint)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/v1/radar/thumb/{thumb_key}.jpg", include_in_schema=False)
async def radar_cached_thumb(
    thumb_key: str,
    auth: bool = Depends(check_auth),
):
    path = resolve_cached_thumb_file(thumb_key)
    if not path:
        raise HTTPException(status_code=404, detail="Náhľad nebol nájdený alebo expiroval")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/api/v1/radar/rethumb")
async def radar_rethumb_single(
    body: RadarRethumbRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    try:
        return await enhance_creator_thumbnail(db, body.item, reroll=body.reroll)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("Creator Radar rethumb failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc) or "Náhľad sa nepodarilo vylepšiť") from exc


@router.post("/api/v1/radar/rethumb-batch")
async def radar_rethumb_batch(
    body: RadarRethumbBatchRequest,
    auth: bool = Depends(check_auth),
):
    async def _stream():
        done = 0
        failed = 0
        async for ev in enhance_creator_thumbnails_iter(body.items, reroll=body.reroll, concurrency=4):
            if ev.get("ok"):
                done += 1
            else:
                failed += 1
            yield json.dumps({"type": "progress", **ev}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "done": done, "failed": failed}, ensure_ascii=False) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@router.delete("/api/v1/radar/follow/{creator_id}")
async def radar_unfollow(
    creator_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    deleted = unfollow_creator(db, creator_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Tvorca nebol nájdený")
    return {"ok": True, "deleted": True, "id": creator_id}


@router.get("/api/v1/radar/dossier")
async def radar_dossier(
    name: str = Query(..., min_length=2, max_length=160),
    limit: int = Query(48, ge=1, le=150),
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    try:
        return get_creator_dossier(db, name=name, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/v1/radar/thumb/{thumb_key}.jpg", include_in_schema=False)
async def radar_cached_thumb(
    thumb_key: str,
    auth: bool = Depends(check_auth),
):
    path = resolve_cached_thumb_file(thumb_key)
    if not path:
        raise HTTPException(status_code=404, detail="Náhľad nebol nájdený alebo expiroval")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/api/v1/radar/rethumb")
async def radar_rethumb_single(
    body: RadarRethumbRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    try:
        return await enhance_creator_thumbnail(db, body.item, reroll=body.reroll)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("Creator Radar rethumb failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc) or "Náhľad sa nepodarilo vylepšiť") from exc


@router.post("/api/v1/radar/rethumb-batch")
async def radar_rethumb_batch(
    body: RadarRethumbBatchRequest,
    auth: bool = Depends(check_auth),
):
    async def _stream():
        done = 0
        failed = 0
        async for ev in enhance_creator_thumbnails_iter(body.items, reroll=body.reroll, concurrency=4):
            if ev.get("ok"):
                done += 1
            else:
                failed += 1
            yield json.dumps({"type": "progress", **ev}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "done": done, "failed": failed}, ensure_ascii=False) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")


@router.post("/api/v1/companion/probe")
async def companion_probe(
    body: CompanionProbeRequest,
    request: Request,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
    db: Session = Depends(get_db),
):
    _authorize_companion(request, x_nexus_token)
    cands = [c.model_dump() for c in body.candidates]
    return probe_companion_targets(
        db,
        query=body.query,
        page_url=body.page_url,
        page_title=body.page_title,
        candidates=cands,
    )


@router.post("/api/v1/companion/follow")
async def companion_follow(
    body: FollowCreatorRequest,
    request: Request,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
    db: Session = Depends(get_db),
):
    _authorize_companion(request, x_nexus_token)
    try:
        return follow_creator(db, name=body.name, notes=body.notes, source_hint=body.source_hint)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/api/v1/radar/thumb/{thumb_key}.jpg", include_in_schema=False)
async def radar_cached_thumb(
    thumb_key: str,
    auth: bool = Depends(check_auth),
):
    path = resolve_cached_thumb_file(thumb_key)
    if not path:
        raise HTTPException(status_code=404, detail="Náhľad nebol nájdený alebo expiroval")
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/api/v1/radar/rethumb")
async def radar_rethumb_single(
    body: RadarRethumbRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    try:
        return await enhance_creator_thumbnail(db, body.item, reroll=body.reroll)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("Creator Radar rethumb failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc) or "Náhľad sa nepodarilo vylepšiť") from exc


@router.post("/api/v1/radar/rethumb-batch")
async def radar_rethumb_batch(
    body: RadarRethumbBatchRequest,
    auth: bool = Depends(check_auth),
):
    async def _stream():
        done = 0
        failed = 0
        async for ev in enhance_creator_thumbnails_iter(body.items, reroll=body.reroll, concurrency=4):
            if ev.get("ok"):
                done += 1
            else:
                failed += 1
            yield json.dumps({"type": "progress", **ev}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "done": done, "failed": failed}, ensure_ascii=False) + "\n"

    return StreamingResponse(_stream(), media_type="application/x-ndjson")
