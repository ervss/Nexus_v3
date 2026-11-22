"""Quality Hunt API — POST start job, GET poll results."""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional, Literal, Annotated

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from .extension_bridge import ensure_bridge_token
from .. import quality_hunt as qh

router = APIRouter(tags=["quality-hunt"])


class QualityHuntRequest(BaseModel):
    title: str = Field(..., min_length=2, max_length=1000)
    page_url: str = ""
    stream_url: str = Field(default="", max_length=10000)
    duration_sec: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    height: int = Field(default=0, ge=0, le=16384)
    size_bytes: int = Field(default=0, ge=0)
    thumbnail_url: str = ""
    poster_url: str = ""
    frame_jpeg: str = Field(default="", max_length=2_800_000)
    frames: List[Annotated[str, Field(max_length=2_800_000)]] = Field(default_factory=list, max_length=3)
    mode: Literal["quick", "deep"] = "quick"
    allow_visual_search: bool = False
    visual_only: bool = False
    manual_keywords: str = Field(default="", max_length=300)
    performer: str = Field(default="", max_length=120)
    force_refresh: bool = False
    retry_job_id: str = Field(default='', max_length=40)
    coverage_target: int = Field(default=5, ge=0, le=50)


class QualityMetaRequest(BaseModel):
    urls: List[str] = Field(default_factory=list, max_length=16)
    job_id: str = ""
    fast: bool = False


@router.post("/quality-hunt/meta")
async def quality_hunt_meta(
    body: QualityMetaRequest,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Resolve watch pages to height + stream. Used to label cards and to play them."""
    ensure_bridge_token(x_nexus_token)
    urls = []
    for raw in body.urls[:16]:
        url = str(raw or "").strip()
        if url.startswith("http") and url not in urls:
            urls.append(url)
    if not urls:
        return {"items": []}

    import asyncio
    from .. import nexus_intel as intel
    from ..media_dates import normalize_upload_date, fetch_upload_date

    sem = asyncio.Semaphore(4)
    job = qh.get_job(body.job_id) if body.job_id else None

    async def one(url: str) -> Dict[str, Any]:
        async with sem:
            try:
                existing = next((c for c in (job or {}).get('candidates', []) if c['url'] == url), {})
                data = existing if body.fast and existing.get('stream_url') and existing.get('metadata_status') == 'ok' else await asyncio.wait_for(intel.resolve_cached(url), timeout=12 if body.fast else 20)
            except Exception as exc:  # noqa: BLE001
                return {"url": url, "height": 0, "error": type(exc).__name__}
            if not data:
                return {"url": url, "height": 0}
            upload_date = normalize_upload_date(data.get("upload_date"))
            if body.fast and not upload_date:
                upload_date = await fetch_upload_date(url)
            size_bytes = int(data.get('size_bytes') or 0)
            if body.fast and data.get('stream_url') and not size_bytes and not data.get('is_hls'):
                size_bytes = await qh.probe_media_size(data['stream_url'], url)
            return {
                "url": url,
                "height": int(data.get("height") or 0),
                "is_hls": bool(data.get("is_hls")),
                "stream_url": str(data.get("stream_url") or ""),
                "title": str(data.get("title") or ""),
                "thumbnail": str(data.get("thumbnail") or data.get("poster") or ""),
                "duration_sec": float(data.get("duration") or data.get("duration_sec") or 0),
                'size_bytes': size_bytes,
                'upload_date': upload_date,
            }

    items = await asyncio.gather(*[one(u) for u in urls])
    qh._dbg("H6", "meta", {
        "asked": len(urls),
        "with_height": sum(1 for i in items if i.get("height")),
        "with_stream": sum(1 for i in items if i.get("stream_url")),
    })
    job = qh.get_job(body.job_id) if body.job_id else None
    if job:
        identity = qh.ClipIdentity(**job["identity"])
        candidates = []
        by_url = {item["url"]: item for item in items}
        original_groups = {'all': job['candidates']} if job.get('candidates') is not None else job['groups']
        for cards in original_groups.values():
            for card in cards:
                candidate = qh.HuntCandidate(**{k: v for k, v in card.items() if k in qh.HuntCandidate.__dataclass_fields__})
                item = by_url.get(candidate.url)
                if item:
                    candidate.metadata_checked_at = qh.time.time()
                    candidate.metadata_status = 'error' if item.get('error') else 'ok' if item.get('height') or item.get('duration_sec') or item.get('stream_url') else 'empty'
                    candidate.metadata_reason = item.get('error') or 'Doplnenie metadát'
                    if item.get('height'):
                        candidate.height = int(item['height'])
                        candidate.height_source = 'metadata'
                    candidate.stream_url = item.get("stream_url") or candidate.stream_url
                    if candidate.stream_url:
                        candidate.requires_login = False
                    if not item.get("error"):
                        candidate.is_hls = bool(item.get("is_hls"))
                    if item.get("duration_sec"):
                        candidate.duration_sec = item["duration_sec"]
                    if item.get('upload_date'):
                        candidate.upload_date = item['upload_date']
                    if item.get('size_bytes'):
                        candidate.size_bytes = item['size_bytes']
                    if item.get('thumbnail') and not candidate.thumbnail:
                        candidate.thumbnail = item['thumbnail']
                    if item.get('title') and not candidate.title:
                        candidate.title = item['title']
                    live = (job.get('_candidate_objects') or {}).get(candidate.url)
                    if live:
                        for field in ('height', 'height_source', 'duration_sec', 'stream_url', 'size_bytes', 'upload_date', 'thumbnail', 'title', 'is_hls', 'metadata_status', 'metadata_reason', 'metadata_checked_at'):
                            setattr(live, field, getattr(candidate, field))
                candidates.append(qh.fuse_evidence(identity, candidate))
                for mirror in card.get("mirrors") or []:
                    # Clustering occurs within one match group; preserve each mirror.
                    mirrored = qh.HuntCandidate(**{k: v for k, v in mirror.items() if k in qh.HuntCandidate.__dataclass_fields__})
                    mirror_meta = by_url.get(mirrored.url)
                    if mirror_meta:
                        mirrored.upload_date = mirror_meta.get('upload_date') or mirrored.upload_date
                        mirrored.height = int(mirror_meta.get("height") or 0)
                        mirrored.height_source = "metadata" if mirrored.height else "unknown"
                        mirrored.stream_url = mirror_meta.get("stream_url") or ""
                        if mirrored.stream_url:
                            mirrored.requires_login = False
                        mirrored.is_hls = bool(mirror_meta.get("is_hls"))
                        if mirror_meta.get("duration_sec"):
                            mirrored.duration_sec = mirror_meta["duration_sec"]
                    candidates.append(qh.fuse_evidence(identity, mirrored))
        qh.refresh_job(job, candidates)
        cached = qh._cache.get(job.get("_cache_key"))
        if cached:
            import copy
            cached["groups"] = copy.deepcopy(job["groups"])
            cached['snapshot'] = qh.job_response(job)
        return {"items": items, **qh.job_response(job)}
    return {"items": items}


@router.post("/quality-hunt")
async def quality_hunt_start(
    body: QualityHuntRequest,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    ensure_bridge_token(x_nexus_token)
    try:
        return await qh.start_hunt(body.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"quality-hunt failed: {exc}") from exc


@router.get("/quality-hunt/{job_id}")
async def quality_hunt_status(
    job_id: str,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    ensure_bridge_token(x_nexus_token)
    job = qh.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return qh.job_response(job)


class PlaybackReport(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=40)
    outcome: Literal['playing', 'error']
    height: int = Field(default=0, ge=0, le=16384)
    duration_sec: float = Field(default=0, ge=0, le=86400, allow_inf_nan=False)
    stream_url: str = Field(default='', max_length=10000)
    is_hls: bool = False
    size_bytes: int = Field(default=0, ge=0)


@router.post('/quality-hunt/{job_id}/playback')
async def quality_hunt_playback(job_id: str, body: PlaybackReport,
    x_nexus_token: Optional[str] = Header(default=None, alias='X-Nexus-Token')):
    ensure_bridge_token(x_nexus_token)
    job = qh.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail='job not found')
    target = next((c for c in job.get('candidates', []) if c['id'] == body.candidate_id), None)
    if not target:
        raise HTTPException(status_code=404, detail='candidate not found')
    target['availability_state'] = 'playable' if body.outcome == 'playing' else 'unavailable'
    target['availability_reason'] = 'Prehrávanie overené v prehliadači' if body.outcome == 'playing' else 'Prehrávanie v prehliadači zlyhalo'
    target['availability_checked_at'] = qh.time.time()
    if body.outcome == 'playing':
        target['requires_login'] = False
        old_duration = float(target.get('duration_sec') or 0)
        if old_duration and body.duration_sec and not qh.duration_within(old_duration, body.duration_sec):
            # The resolved media may be a short promo instead of the indexed file.
            target['size_bytes'] = 0
            target['metadata_reason'] = 'Prehraná dĺžka sa líši od údajov zdroja; veľkosť treba zmerať znova'
        if body.stream_url.startswith(('https://', 'http://')):
            if target.get('stream_url') != body.stream_url:
                target['size_bytes'] = body.size_bytes
            target['stream_url'] = body.stream_url
            target['is_hls'] = body.is_hls
        if body.height:
            target.update(height=body.height, height_source='metadata', metadata_checked_at=qh.time.time(), metadata_status='ok')
        if body.duration_sec:
            target['duration_sec'] = body.duration_sec
    objects = [qh.HuntCandidate(**{k: v for k, v in c.items() if k in qh.HuntCandidate.__dataclass_fields__}) for c in job['candidates']]
    for candidate in (job.get('_candidate_objects') or {}).values():
        if candidate.to_dict()['id'] == body.candidate_id:
            for key, value in target.items():
                if key in qh.HuntCandidate.__dataclass_fields__:
                    setattr(candidate, key, value)
    qh.refresh_job(job, objects)
    cached = qh._cache.get(job.get('_cache_key'))
    if cached:
        cached['groups'] = qh.copy.deepcopy(job['groups'])
        cached['snapshot'] = qh.job_response(job)
    return qh.job_response(job)


@router.post("/quality-hunt/{job_id}/cancel")
async def quality_hunt_cancel(job_id: str, x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    ensure_bridge_token(x_nexus_token)
    job = qh.cancel_hunt(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    task = qh._tasks.get(job_id)
    if task:
        await asyncio.wait({task}, timeout=2)
    return qh.job_response(job)


@router.post("/quality-hunt/parse")
async def quality_hunt_parse(body: Dict[str, Any], x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """Debug / unit helper: return parsed identity for a title."""
    ensure_bridge_token(x_nexus_token)
    title = str(body.get("title") or "")[:1000]
    ident = qh.parse_title_identity(title)
    return {
        "raw_title": ident.raw_title,
        "scene": ident.scene,
        "studio": ident.studio,
        "date": ident.date,
        "quality_height": ident.quality_height,
    }
