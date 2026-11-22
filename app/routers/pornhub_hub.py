"""
PornHub Hub API — discovery surfaces for the in-dashboard hub.

    GET /ph/feed        browse (sort/period/category/filters)
    GET /ph/search      keyword search (+ all filters)
    GET /ph/categories  category chips
    GET /ph/related     related videos for a watch URL
    GET /ph/media       referer-bypassing proxy for thumbs + webm previews
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .. import pornhub_hub as ph
from ..auth import check_auth
from ..database import ImportJobItem, PornhubQueueItem, Video, get_db
from ..intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker, normalize_intake_url, serialize_job

logger = logging.getLogger(__name__)
router = APIRouter(tags=["pornhub-hub"])

_PH_HOSTS = ("pornhub.com", "pornhub.org", "pornhub.net")


def _is_pornhub_url(value: str) -> bool:
    """Require an actual PornHub host instead of accepting a substring."""
    try:
        host = (urlparse(value or "").hostname or "").lower()
    except ValueError:
        return False
    return any(host == domain or host.endswith("." + domain) for domain in _PH_HOSTS)


def _is_ph_media_url(value: str) -> bool:
    try:
        host = (urlparse(value or "").hostname or "").lower()
    except ValueError:
        return False
    return _is_pornhub_url(value) or host == "phncdn.com" or host.endswith(".phncdn.com")


def _queue_tags(value: str) -> list[str]:
    return [tag.strip() for tag in (value or "").split(",") if tag.strip()]


def _library_duplicate(db: Session, url: str) -> Video | None:
    """Fast exact duplicate check used before spending a resolver call."""
    return db.query(Video).filter(or_(Video.url == url, Video.source_url == url)).first()


def _serialize_queue_item(item: PornhubQueueItem) -> dict:
    return {
        "id": item.id,
        "url": item.url,
        "source_url": item.source_url or item.url,
        "title": item.title or "PornHub video",
        "thumb": item.thumbnail or "",
        "duration_sec": int(item.duration or 0),
        "height": int(item.height or 0),
        "quality": ph._quality_str(int(item.height or 0)),
        "size_mb": item.file_size_mb or None,
        "upload_date": item.upload_date or "",
        "tags": _queue_tags(item.tags),
        "query": item.query or "",
        "status": item.status,
        "duplicate_video_id": item.duplicate_video_id,
        "import_job_id": item.import_job_id,
        "error": item.error or "",
        "added_at": item.added_at.isoformat() if item.added_at else None,
        "analyzed_at": item.analyzed_at.isoformat() if item.analyzed_at else None,
    }


def _sync_queue_import_states(db: Session, items: list[PornhubQueueItem]) -> None:
    """Reflect the intake worker's result in the persistent discovery queue."""
    item_ids = [row.import_job_item_id for row in items if row.import_job_item_id]
    if not item_ids:
        return
    jobs = {
        row.id: row
        for row in db.query(ImportJobItem).filter(ImportJobItem.id.in_(item_ids)).all()
    }
    changed = False
    for row in items:
        imported = jobs.get(row.import_job_item_id)
        if not imported:
            continue
        if imported.status == "imported":
            row.status, row.error = "imported", ""
            changed = True
        elif imported.status == "duplicate":
            row.status, row.duplicate_video_id, row.error = "duplicate", imported.video_id, ""
            changed = True
        elif imported.status == "failed":
            row.status, row.error = "failed", imported.error or "Import zlyhal"
            changed = True
    if changed:
        db.commit()


class _QueueCandidate(BaseModel):
    url: str
    title: str = ""
    thumb: str = ""
    duration_sec: int = 0
    height: int = 0
    size_mb: float = 0
    upload_date: str = ""
    tags: list[str] = []
    query: str = ""


class _QueueAddBody(BaseModel):
    items: list[_QueueCandidate] = []


class _QueueIdsBody(BaseModel):
    ids: list[int] = []
    batch_name: str = ""


@router.get("/ph/feed")
async def ph_feed(
    sort: str = "hottest",
    period: str = "",
    category: str = "",
    page: int = 1,
    hd: bool = False,
    production: str = "",
    dur: str = "",
    auth: bool = Depends(check_auth),
):
    try:
        return await ph.browse(sort=sort, period=period, category=category,
                               page=page, hd=hd, production=production, dur=dur)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH feed failed: {exc}")


@router.get("/ph/search")
async def ph_search(
    q: str = Query(..., min_length=1),
    sort: str = "",
    period: str = "",
    page: int = 1,
    hd: bool = False,
    production: str = "",
    dur: str = "",
    auth: bool = Depends(check_auth),
):
    try:
        return await ph.search(query=q, sort=sort, period=period, page=page,
                               hd=hd, production=production, dur=dur)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH search failed: {exc}")


@router.get("/ph/categories")
async def ph_categories(auth: bool = Depends(check_auth)):
    return {"categories": await ph.categories()}


@router.get("/ph/pornstars")
async def ph_pornstars(q: str = "", page: int = 1, auth: bool = Depends(check_auth)):
    try:
        return await ph.pornstars(query=q, page=page)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH pornstars failed: {exc}")


@router.get("/ph/pornstar")
async def ph_pornstar_videos(slug: str, kind: str = "pornstar",
                             sort: str = "", page: int = 1, period: str = "",
                             hd: bool = False, production: str = "", dur: str = "",
                             auth: bool = Depends(check_auth)):
    try:
        return await ph.pornstar_videos(slug=slug, kind=kind, sort=sort, page=page,
                                        period=period, hd=hd, production=production,
                                        dur=dur)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH pornstar videos failed: {exc}")


class _EnrichBody(BaseModel):
    urls: list[str] = []


@router.post("/ph/enrich")
async def ph_enrich(body: _EnrichBody, auth: bool = Depends(check_auth)):
    """Resolve real quality + file size + tags for a batch of watch URLs."""
    urls = [u for u in (body.urls or []) if _is_pornhub_url(u)][:60]
    if not urls:
        return {"results": {}}
    try:
        return {"results": await ph.enrich(urls)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH enrich failed: {exc}")


@router.get("/ph/resolve")
async def ph_resolve(url: str = Query(..., min_length=8), auth: bool = Depends(check_auth)):
    """JIT-resolve a watch URL into a playable stream for the in-hub player."""
    if not _is_pornhub_url(url):
        raise HTTPException(400, detail="Not a PornHub URL")
    try:
        from ..extractors.pornhub import PornhubExtractor
        res = await PornhubExtractor().extract(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH resolve failed: {exc}")
    if not res or not res.get("stream_url"):
        raise HTTPException(502, detail="Could not resolve a stream (premium or geo-blocked?)")
    return {
        "stream_url": res["stream_url"],
        "is_hls": bool(res.get("is_hls")),
        "title": res.get("title", ""),
        "duration": res.get("duration", 0),
        "thumbnail": res.get("thumbnail", ""),
    }


@router.get("/ph/related")
async def ph_related(url: str = Query(..., min_length=8), auth: bool = Depends(check_auth)):
    if not _is_pornhub_url(url):
        raise HTTPException(400, detail="Not a PornHub URL")
    try:
        return await ph.related(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH related failed: {exc}")


@router.get("/ph/video-playlists")
async def ph_video_playlists(url: str = Query(..., min_length=8), auth: bool = Depends(check_auth)):
    """Public playlists a video is featured in (shown under the in-hub player)."""
    if not _is_pornhub_url(url):
        raise HTTPException(400, detail="Not a PornHub URL")
    try:
        return {"playlists": await ph.video_playlists(url)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH video-playlists failed: {exc}")


@router.get("/ph/search-playlists")
async def ph_search_playlists(q: str = Query(..., min_length=1), auth: bool = Depends(check_auth)):
    """Search public playlists relevant to a keyword."""
    try:
        return {"playlists": await ph.search_playlists(q)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH search-playlists failed: {exc}")


@router.get("/ph/playlist")
async def ph_playlist(
    playlist_id: str = Query(..., min_length=1, max_length=120),
    page: int = Query(1, ge=1, le=200),
    all_pages: bool = Query(True),
    auth: bool = Depends(check_auth),
):
    """Videos from one public PornHub playlist, displayed inside the hub."""
    try:
        return await ph.playlist_videos(playlist_id, page=page, all_pages=all_pages)
    except ValueError as exc:
        raise HTTPException(400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH playlist failed: {exc}")


@router.get("/ph/media")
async def ph_media(url: str = Query(..., min_length=8), auth: bool = Depends(check_auth)):
    if not _is_ph_media_url(url):
        raise HTTPException(400, detail="Only phncdn/pornhub media is proxied")
    try:
        content, ctype = await ph.fetch_media(url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, detail=f"PH media failed: {exc}")
    if not content or len(content) < 64:
        raise HTTPException(404, detail="Empty media")
    return Response(
        content=content,
        media_type=ctype,
        headers={
            "Cache-Control": "public, max-age=86400",
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
        },
    )


# --------------------------------------------------------------------------- #
# Smart Discovery Queue: collect first, analyze only selected cards, then import
# --------------------------------------------------------------------------- #
@router.get("/ph/queue")
async def ph_queue(
    include_finished: bool = False,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    query = db.query(PornhubQueueItem)
    if not include_finished:
        query = query.filter(PornhubQueueItem.status.notin_(["dismissed", "imported"]))
    items = query.order_by(PornhubQueueItem.added_at.desc()).limit(240).all()
    _sync_queue_import_states(db, items)
    return {"items": [_serialize_queue_item(item) for item in items]}


@router.post("/ph/queue")
async def ph_queue_add(
    body: _QueueAddBody,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    created = existing = duplicates = 0
    saved: list[PornhubQueueItem] = []
    for candidate in (body.items or [])[:60]:
        url = normalize_intake_url(candidate.url)
        if not _is_pornhub_url(url):
            continue
        row = db.query(PornhubQueueItem).filter(PornhubQueueItem.url == url).first()
        if row:
            existing += 1
            saved.append(row)
            continue
        duplicate = _library_duplicate(db, url)
        row = PornhubQueueItem(
            url=url,
            source_url=url,
            title=(candidate.title or "PornHub video").strip(),
            thumbnail=(candidate.thumb or "").strip(),
            duration=max(0, candidate.duration_sec or 0),
            height=max(0, candidate.height or 0),
            file_size_mb=max(0, candidate.size_mb or 0),
            upload_date=(candidate.upload_date or "").strip() or None,
            tags=",".join(tag.strip() for tag in candidate.tags if tag.strip()),
            query=(candidate.query or "").strip(),
            status="duplicate" if duplicate else "new",
            duplicate_video_id=duplicate.id if duplicate else None,
        )
        db.add(row)
        saved.append(row)
        created += 1
        duplicates += int(bool(duplicate))
    db.commit()
    for row in saved:
        db.refresh(row)
    return {
        "created": created,
        "existing": existing,
        "duplicates": duplicates,
        "items": [_serialize_queue_item(row) for row in saved],
    }


@router.post("/ph/queue/analyze")
async def ph_queue_analyze(
    body: _QueueIdsBody,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    ids = list(dict.fromkeys(body.ids or []))[:30]
    rows = db.query(PornhubQueueItem).filter(PornhubQueueItem.id.in_(ids)).all()
    rows = [row for row in rows if row.status not in ("duplicate", "queued", "imported", "dismissed")]
    if not rows:
        return {"updated": 0, "items": []}
    for row in rows:
        row.status, row.error = "analyzing", None
    db.commit()

    results = await ph.enrich([row.url for row in rows], concurrency=4)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    refreshed = db.query(PornhubQueueItem).filter(PornhubQueueItem.id.in_([row.id for row in rows])).all()
    updated = 0
    for row in refreshed:
        duplicate = _library_duplicate(db, row.url)
        data = results.get(row.url)
        if duplicate:
            row.status, row.duplicate_video_id, row.error = "duplicate", duplicate.id, None
        elif not data:
            row.status, row.error = "failed", "Nepodarilo sa získať metadáta. Skús znova neskôr."
        else:
            row.duration = float(data.get("duration_sec") or row.duration or 0)
            row.height = int(data.get("height") or row.height or 0)
            row.file_size_mb = float(data.get("size_mb") or row.file_size_mb or 0)
            row.upload_date = data.get("upload_date") or row.upload_date
            tags = data.get("tags") or []
            if tags:
                row.tags = ",".join(str(tag).strip() for tag in tags if str(tag).strip())
            row.status, row.error, row.analyzed_at = "ready", None, now
            updated += 1
    db.commit()
    return {"updated": updated, "items": [_serialize_queue_item(row) for row in refreshed]}


@router.post("/ph/queue/import")
async def ph_queue_import(
    body: _QueueIdsBody,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    ids = list(dict.fromkeys(body.ids or []))[:60]
    rows = db.query(PornhubQueueItem).filter(PornhubQueueItem.id.in_(ids)).all()
    rows = [row for row in rows if row.status in ("new", "ready", "failed")]
    if not rows:
        raise HTTPException(400, detail="Vyber nové alebo pripravené položky z queue.")
    request = IntakeImportRequest(
        candidates=[
            IntakeCandidate(
                url=row.url,
                source_url=row.source_url or row.url,
                title=row.title or "PornHub video",
                thumbnail=row.thumbnail or "",
                duration=float(row.duration or 0),
                height=int(row.height or 0),
                file_size_mb=float(row.file_size_mb or 0),
                upload_date=row.upload_date,
                tags=_queue_tags(row.tags),
                source="pornhub",
            )
            for row in rows
        ],
        batch_name=(body.batch_name or "PornHub Smart Queue").strip(),
        source_mode="pornhub",
        auto_metadata=True,
        playwright_fallback=False,
    )
    job = create_import_job(request, db)
    job_items = {
        row.normalized_url: row
        for row in db.query(ImportJobItem).filter(ImportJobItem.job_id == job.id).all()
    }
    for row in rows:
        imported = job_items.get(normalize_intake_url(row.url))
        row.import_job_id = job.id
        row.import_job_item_id = imported.id if imported else None
        if imported and imported.status == "duplicate":
            row.status, row.duplicate_video_id, row.error = "duplicate", imported.video_id, None
        else:
            row.status, row.error = "queued", None
    db.commit()
    intake_worker.start()
    return {"job": serialize_job(job), "items": [_serialize_queue_item(row) for row in rows]}


@router.post("/ph/queue/remove")
async def ph_queue_remove_many(
    body: _QueueIdsBody,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Remove a reviewed group (typically library duplicates) in one request."""
    ids = list(dict.fromkeys(body.ids or []))[:240]
    rows = db.query(PornhubQueueItem).filter(PornhubQueueItem.id.in_(ids)).all()
    removed = []
    skipped = []
    for row in rows:
        if row.status == "queued":
            skipped.append(row.id)
            continue
        removed.append(row.id)
        db.delete(row)
    db.commit()
    return {"removed": removed, "skipped": skipped}


@router.delete("/ph/queue/{item_id}")
async def ph_queue_remove(
    item_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    row = db.query(PornhubQueueItem).filter(PornhubQueueItem.id == item_id).first()
    if not row:
        raise HTTPException(404, detail="Queue položka sa nenašla")
    if row.status == "queued":
        raise HTTPException(409, detail="Položka už je vo fronte importu; odstráň ju cez Import Monitor.")
    db.delete(row)
    db.commit()
    return {"removed": item_id}
