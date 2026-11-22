"""
Nexus LITE — Fast Ingest Server & Live Gallery Hub
===================================================
Ultra-ľahká, bleskovo sa spúšťajúca verzia Nexusu:
- Okamžitý štart (< 1s) a nízka spotreba RAM (~40 MB)
- API endpointy pre Tampermonkey/Userscripty a rozšírenia (Bunkr, GoFile, Mega, FapHouse, VK, DDG...)
- Asynchrónne spracovanie importov na pozadí s ukladaním priamo do nexus.db
- SSE (Server-Sent Events) live feed pre okamžité pridávanie kariet na dashboard
- Range-aware video stream proxy pre okamžité otestovanie funkčnosti streamu
"""

from __future__ import annotations

import asyncio
import inspect
import datetime
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional
from urllib.parse import quote, unquote, urljoin, urlparse
import mimetypes
import re

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import case, desc, func, or_, text
from sqlalchemy.orm import Session

from .config import config
from .database import (
    DiscoveredVideo,
    ImportJob,
    ImportJobEvent,
    ImportJobItem,
    SessionLocal,
    SourceBoard,
    Video,
    VideoSource,
    get_db,
)
from .extractors import ExtractorRegistry, register_extended_extractors
from .intake import (
    IntakeCandidate,
    IntakeImportRequest,
    _coerce_duration,
    _coerce_int,
    create_import_job,
    intake_worker,
    serialize_job,
)
from .routers import extension_bridge, extractor_health, link_tester, mega, mega_hub, source_boards

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("nexus.lite")

# Root directory
BASE_DIR = Path(__file__).resolve().parent.parent
APP_DIR = Path(__file__).resolve().parent

@asynccontextmanager
async def lite_lifespan(_app: FastAPI):
    logger.info(">>> Nexus LITE Server spustený na porte %s <<<", config.SERVER_PORT or 8000)
    mega_hub.ensure_tables()
    try:
        register_extended_extractors()
    except Exception as exc:
        logger.warning("Could not register extended extractors: %s", exc)
    intake_worker.start()
    try:
        yield
    finally:
        await intake_worker.stop()
        from .tor_service import tor_service
        await asyncio.to_thread(tor_service.shutdown)


app = FastAPI(
    title="Nexus LITE",
    description="Fast Ingest Server & Live Gallery Dashboard",
    version="2.0-LITE",
    lifespan=lite_lifespan,
)

# CORS: allow everything so userscripts, Tampermonkey and extensions can connect seamlessly
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compress responses > 1KB for faster dashboard loading
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Static caching for instant sub-sequent loads
class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = (
                "no-cache" if path.lower().endswith((".js", ".css", ".html")) else "public, max-age=86400"
            )
        return response

# Static & Templates setup
templates = Jinja2Templates(directory=str(APP_DIR / "templates"))

static_dir = APP_DIR / "static"
# follow_symlink=True so Windows junctions into NexusPWC_fresh_v2-data resolve.
if static_dir.exists():
    app.mount(
        "/static",
        CachedStaticFiles(directory=str(static_dir), follow_symlink=True),
        name="static",
    )

# Mount thumbnails if present
for thumb_cand in [
    APP_DIR / "static" / "thumbnails",
    BASE_DIR / "thumbnails",
    APP_DIR / "thumbnails",
]:
    if thumb_cand.exists():
        app.mount(
            "/thumbnails",
            CachedStaticFiles(directory=str(thumb_cand), follow_symlink=True),
            name="thumbnails",
        )
        break

# Include modular sub-routers for extension support
app.include_router(extension_bridge.router)
app.include_router(link_tester.router)
app.include_router(extractor_health.router)
# Router paths already include their resource segment (for example
# ``/mega/add`` and ``/source-boards``). Prefix only the API namespace here;
# repeating the resource produced accidental /mega/mega routes.
app.include_router(mega.router, prefix="/api/v1")
app.include_router(mega_hub.router, prefix="/api/v1")
app.include_router(
    mega.router,
    generate_unique_id_function=lambda route: (
        f"legacy_{route.name}_{route.path_format.replace('/', '_').strip('_')}"
        f"_{'_'.join(sorted(route.methods or []))}"
    ),
)
app.include_router(source_boards.router, prefix="/api/v1")
app.include_router(source_boards.router, prefix="/api")

from .routers import quality_hunt as _routes_quality_hunt
app.include_router(_routes_quality_hunt.router, prefix="/api/v1")
app.include_router(_routes_quality_hunt.router, prefix="/api")

# ---------------------------------------------------------------------------
# SSE Live Event Bus (Pre okamžité naskakovanie kariet na dashboarde)
# ---------------------------------------------------------------------------
class LiteEventBus:
    def __init__(self):
        self._subscribers: List[asyncio.Queue] = []

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue(maxsize=100)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def broadcast(self, event_type: str, data: Any):
        dead = []
        payload = json.dumps({"type": event_type, "data": data, "ts": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat()})
        for q in self._subscribers:
            try:
                q.put_nowait(payload)
            except (asyncio.QueueFull, Exception):
                dead.append(q)
        for d in dead:
            self.unsubscribe(d)

event_bus = LiteEventBus()


# ---------------------------------------------------------------------------
# Favicon (zabraňuje 404 logu v prehliadači)
# ---------------------------------------------------------------------------
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    # Vrátime prázdnu 204 No Content odpoveď — žiadny súbor favicon nie je potrebný
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Health & Ping Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
@app.get("/api/health")
@app.get("/bridge/ping")
async def health_check():
    return {
        "status": "ok",
        "service": "Nexus LITE Ingest & Gallery",
        "mode": "lite",
        "timestamp": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).isoformat(),
    }


class LiteBulkVideo(BaseModel):
    url: str
    title: Optional[str] = None
    source_url: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[Any] = 0
    quality: Optional[Any] = None
    file_size_mb: Optional[Any] = None
    filesize: Optional[Any] = None
    tags: Optional[str] = ""
    direct_url: Optional[str] = None
    height: Optional[int] = 0
    width: Optional[int] = 0


class LiteBulkImportRequest(BaseModel):
    batch_name: Optional[str] = "Bulk Import"
    videos: List[LiteBulkVideo] = Field(default_factory=list)


def _lite_height_from_quality(quality: Any, fallback: int = 0) -> int:
    if fallback:
        return fallback
    text = str(quality or "")
    if re.search(r"\b(4k|2160)\b", text, re.I):
        return 2160
    match = re.search(r"(2160|1440|1080|720|480|360|240)", text)
    return int(match.group(1)) if match else 0


def _lite_size_mb(video: LiteBulkVideo) -> float:
    raw = video.file_size_mb
    if raw not in (None, "", 0, "0"):
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
    text = str(video.filesize or "")
    match = re.search(r"(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)", text, re.I)
    if not match:
        return 0.0
    amount = float(match.group(1))
    return amount * 1024 if match.group(2).lower().startswith("g") else amount


@app.post("/api/v1/import/bulk")
@app.post("/api/legacy/v1/import/bulk")
async def lite_import_bulk(payload: LiteBulkImportRequest, db: Session = Depends(get_db)):
    """Accept the same payload the Chrome extensions POST to full Nexus.

    LITE previously only advertised /health, so Faphouse/selector imports got
    FastAPI's generic 404 ``Not Found``.
    """
    candidates: List[IntakeCandidate] = []
    for video in payload.videos or []:
        stream = str(video.direct_url or video.url or "").strip()
        source = str(video.source_url or video.url or "").strip()
        if not stream:
            continue
        tags = [part.strip() for part in str(video.tags or "").split(",") if part.strip()]
        source_host = urlparse(source or stream).netloc.lower()
        source_name = "faphouse" if "faphouse.com" in source_host else "extension"
        candidates.append(IntakeCandidate(
            title=(video.title or "Imported Video").strip() or "Imported Video",
            url=stream,
            source_url=source or stream,
            thumbnail=str(video.thumbnail or ""),
            duration=_coerce_duration(video.duration),
            height=_lite_height_from_quality(video.quality, _coerce_int(video.height)),
            width=_coerce_int(video.width),
            file_size_mb=_lite_size_mb(video),
            tags=tags,
            source=source_name,
            confidence=0.95,
        ))
    if not candidates:
        raise HTTPException(status_code=400, detail="No videos were prepared for import")

    req = IntakeImportRequest(
        candidates=candidates,
        batch_name=(payload.batch_name or "").strip() or "Bulk Import",
        source_mode="extension-bulk",
        auto_metadata=False,
        playwright_fallback=False,
    )
    job = create_import_job(req, db)
    intake_worker.start()
    await event_bus.broadcast("job_queued", {
        "job_id": job.id,
        "batch_name": job.batch_name,
        "total_items": job.total_items,
    })
    return {
        "success": True,
        "count": len(candidates),
        "imported": len(candidates),
        "job_id": job.id,
        "job": serialize_job(job),
    }


# ---------------------------------------------------------------------------
# Userscript & Extension Intake Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/v1/intake/import")
@app.post("/api/legacy/v1/intake/import")
@app.post("/api/intake/import")
async def intake_import(request: IntakeImportRequest, db: Session = Depends(get_db)):
    job = create_import_job(request, db)
    logger.info("[Lite Intake] Job #%s QUEUED batch=%r items=%s", job.id, job.batch_name, job.total_items)
    intake_worker.start()
    
    # Broadcast new job event
    await event_bus.broadcast("job_queued", {
        "job_id": job.id,
        "batch_name": job.batch_name,
        "total_items": job.total_items,
    })
    
    return {"success": True, "job": serialize_job(job)}


@app.get("/api/v1/dashboard/import-monitor")
@app.get("/api/legacy/v1/dashboard/import-monitor")
@app.get("/api/lite/import-monitor")
async def get_import_monitor(limit: int = 15, db: Session = Depends(get_db)):
    jobs = db.query(ImportJob).order_by(desc(ImportJob.id)).limit(max(1, min(limit, 50))).all()
    from .intake import reconcile_job_counts
    reconcile_job_counts(db, jobs)
    active_jobs = [j for j in jobs if j.status in ("pending", "queued", "running", "extracting")]
    return {
        "success": True,
        "active_count": len(active_jobs),
        "jobs": [serialize_job(j, include_items=True, db=db) for j in jobs],
    }


# Hunter Push Endpoint
class HunterPushRequest(BaseModel):
    session_id: Optional[str] = None
    query: Optional[str] = None
    links: List[str] = []
    source: Optional[str] = None

@app.post("/api/v1/hunter/push", operation_id="hunter_push_api_v1")
@app.post("/api/hunter/push", operation_id="hunter_push_legacy")
async def hunter_push(payload: HunterPushRequest, db: Session = Depends(get_db)):
    if not payload.links:
        return {"success": False, "message": "No links provided"}
    
    req = IntakeImportRequest(
        urls=payload.links,
        batch_name=f"Hunter - {payload.query or 'Discovery'}",
        source_mode="hunter",
    )
    job = create_import_job(req, db)
    intake_worker.start()
    await event_bus.broadcast("job_queued", {"job_id": job.id, "batch_name": job.batch_name, "total_items": len(payload.links)})
    return {"success": True, "job_id": job.id, "queued": len(payload.links)}


# Link Tester / Batch Meta Extractor Endpoint
class BatchMetaRequest(BaseModel):
    urls: List[str]

@app.post("/api/tester/batch-meta")
async def batch_meta_extract(payload: BatchMetaRequest):
    results = []
    for raw_url in payload.urls[:30]:
        clean_url = (raw_url or "").strip()
        if not clean_url:
            continue
        try:
            finder = getattr(ExtractorRegistry, "get_extractor", None) or ExtractorRegistry.find_extractor
            ext = finder(clean_url)
            if ext:
                info = await ext.extract(clean_url) or {}
                def value(name: str, default=None):
                    if isinstance(info, dict):
                        return info.get(name, default)
                    return getattr(info, name, default)

                size_bytes = value("size_bytes", 0) or value("filesize", 0) or value("size", 0)
                if not size_bytes and value("file_size_mb", 0):
                    size_bytes = float(value("file_size_mb", 0)) * 1024 * 1024
                height = int(value("height", 0) or 0)
                quality = value("quality", "") or (f"{height}p" if height else "HD")
                results.append({
                    "url": clean_url,
                    "title": value("title") or Path(urlparse(clean_url).path).name,
                    "thumbnail": value("thumbnail_url") or value("thumbnail"),
                    "duration": value("duration", 0) or 0,
                    "width": int(value("width", 0) or 0),
                    "height": height,
                    "size_bytes": int(float(size_bytes or 0)),
                    "stream_url": value("stream_url") or value("direct_url") or value("url") or "",
                    "quality": quality,
                    "status": "success",
                })
            else:
                results.append({
                    "url": clean_url,
                    "title": Path(urlparse(clean_url).path).name or clean_url,
                    "status": "unsupported",
                })
        except Exception as e:
            results.append({"url": clean_url, "status": "error", "error": str(e)})
    return {"success": True, "results": results}


# ---------------------------------------------------------------------------
# Live Gallery Dashboard Endpoints & UI
# ---------------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def lite_gallery_page(request: Request):
    return templates.TemplateResponse(request=request, name="lite_gallery.html")


@app.get("/tester", response_class=HTMLResponse)
async def lite_tester_page(request: Request):
    return templates.TemplateResponse(request=request, name="tester.html")


@app.get("/discovery-hub", response_class=HTMLResponse)
async def lite_discovery_hub_page(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/api/lite/videos")
async def get_lite_videos(
    limit: int = Query(48, ge=1, le=200),
    offset: int = Query(0, ge=0),
    filter_mode: str = Query("all"),  # all, today, ready, pending, error
    q: Optional[str] = Query(None),
    batch_name: Optional[str] = Query(None),
    source_board_id: Optional[int] = Query(None, ge=1),
    sort_by: str = Query("date"),
    sort_order: str = Query("desc"),
    quality: Optional[str] = Query(None),
    ids: Optional[str] = Query(None, description="Comma-separated card IDs for LITE refresh polling"),
    db: Session = Depends(get_db),
):
    query = db.query(Video)

    if ids:
        try:
            requested_ids = list(dict.fromkeys(int(value) for value in ids.split(",") if value.strip()))[:200]
        except ValueError:
            raise HTTPException(status_code=422, detail="ids musí obsahovať číselné ID")
        if not requested_ids:
            return {"success": True, "total": 0, "offset": 0, "limit": limit, "items": []}
        query = query.filter(Video.id.in_(requested_ids))
    
    if q and q.strip():
        from sqlalchemy import text
        from .database import sanitize_fts_query
        
        safe_q = sanitize_fts_query(q.strip())
        if safe_q:
            # Append wildcard prefix to support partial matches safely
            fts_match = " ".join([f'"{w}"*' for w in safe_q.split()])
            fts_subq = text("SELECT rowid FROM videos_fts WHERE videos_fts MATCH :q").columns(rowid=Video.id.type)
            query = query.filter(Video.id.in_(fts_subq)).params(q=fts_match)
        else:
            term = f"%{q.strip()}%"
            query = query.filter(or_(Video.title.ilike(term), Video.tags.ilike(term), Video.batch_name.ilike(term)))

    if batch_name and batch_name.strip():
        query = query.filter(Video.batch_name == batch_name.strip())

    if source_board_id is not None:
        board = db.query(SourceBoard).filter(SourceBoard.id == source_board_id).first()
        if board and board.batch_name:
            query = query.filter(Video.id.in_(source_boards.board_video_ids(db, board)))
        else:
            # A deleted/invalid board must never silently fall back to the full library.
            query = query.filter(Video.id == -1)
        
    if filter_mode == "today":
        today_start = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).replace(hour=0, minute=0, second=0, microsecond=0)
        query = query.filter(Video.created_at >= today_start)
    elif filter_mode == "pending":
        query = query.filter(Video.status.in_(["pending", "extracting", "downloading"]))
    elif filter_mode == "error":
        query = query.filter(Video.status.in_(["error", "failed"]))
    elif filter_mode == "ready":
        query = query.filter(Video.status.in_(["ready", "completed", "working"]))

    quality_key = func.lower(func.coalesce(Video.quality, ""))
    if quality and quality.lower() in {"4k", "1080p", "720p", "480p", "hd", "sd"}:
        quality_value = quality.lower()
        if quality_value == "4k":
            query = query.filter(or_(quality_key.like("%4k%"), quality_key.like("%2160%")))
        elif quality_value == "1080p":
            query = query.filter(or_(quality_key.like("%1080%"), quality_key.like("%4k%"), quality_key.like("%2160%")))
        elif quality_value == "720p":
            query = query.filter(or_(quality_key.like("%720%"), quality_key.like("%1080%"), quality_key.like("%4k%"), quality_key.like("%2160%")))
        elif quality_value == "480p":
            query = query.filter(or_(quality_key.like("%480%"), quality_key.like("%sd%")))
        elif quality_value == "hd":
            query = query.filter(or_(quality_key.like("%hd%"), quality_key.like("%720%"), quality_key.like("%1080%"), quality_key.like("%4k%"), quality_key.like("%2160%")))
        else:
            query = query.filter(or_(quality_key.like("%sd%"), quality_key.like("%360%"), quality_key.like("%480%")))

    if filter_mode == "all" and not q and not batch_name and source_board_id is None and not quality and not ids:
        # Rýchle počítanie cez covering index, bez konfliktu s lokálnym importom text
        from sqlalchemy import select
        total_count = db.scalar(select(func.count()).select_from(Video)) or 0
    else:
        total_count = query.count()
    quality_rank = case(
        (quality_key.like("%2160%"), 5),
        (quality_key.like("%4k%"), 5),
        (quality_key.like("%1080%"), 4),
        (quality_key.like("%720%"), 3),
        (quality_key.like("%480%"), 2),
        (quality_key.like("%hd%"), 3),
        (quality_key.like("%sd%"), 1),
        else_=0,
    )
    sort_column = {
        "duration": Video.duration,
        "size": Video.file_size_mb,
        "quality": quality_rank,
        "date": Video.id,
    }.get(sort_by.lower(), Video.id)
    order_clause = sort_column.asc() if sort_order.lower() == "asc" else sort_column.desc()
    
    if sort_column is Video.id:
        videos = query.with_entities(
            Video.id, Video.title, Video.url, Video.source_url,
            Video.thumbnail_path, Video.original_thumbnail_url,
            Video.duration, Video.quality, Video.file_size_mb,
            Video.status, Video.batch_name, Video.created_at, Video.storage_type
        ).order_by(order_clause).offset(offset).limit(limit).all()
    else:
        videos = query.with_entities(
            Video.id, Video.title, Video.url, Video.source_url,
            Video.thumbnail_path, Video.original_thumbnail_url,
            Video.duration, Video.quality, Video.file_size_mb,
            Video.status, Video.batch_name, Video.created_at, Video.storage_type
        ).order_by(order_clause, desc(Video.id)).offset(offset).limit(limit).all()
    
    items = []
    for v in videos:
        # Resolve best thumbnail URL
        thumb = _usable_thumbnail_url(v)
        if thumb and not thumb.startswith("http") and not thumb.startswith("/"):
            thumb = f"/{thumb}"
            
        items.append({
            "id": v.id,
            "title": v.title or "Bez názvu",
            "url": v.url,
            "source_url": v.source_url,
            "thumbnail": thumb,
            "duration": v.duration or 0,
            "duration_str": format_duration(v.duration or 0),
            "quality": v.quality or "HD",
            "file_size_mb": round(v.file_size_mb or 0, 1),
            "status": v.status or "ready",
            "batch_name": v.batch_name or "Import",
            "created_at": v.created_at.strftime("%H:%M · %d.%m.%Y") if v.created_at else "",
            "is_local": v.storage_type == "local",
        })
        
    return {
        "success": True,
        "total": total_count,
        "offset": offset,
        "limit": limit,
        "items": items,
    }


@app.get("/api/lite/filter-options")
async def get_lite_filter_options(db: Session = Depends(get_db)):
    """Small, server-derived menus used by the LITE Gallery filters."""
    batch_rows = (
        db.query(Video.batch_name, func.count(Video.id).label("count"))
        .filter(Video.batch_name.isnot(None), Video.batch_name != "")
        .group_by(Video.batch_name)
        .order_by(desc("count"), Video.batch_name.asc())
        .limit(500)
        .all()
    )
    boards = (
        db.query(SourceBoard)
        .filter(SourceBoard.batch_name.isnot(None), SourceBoard.batch_name != "")
        .order_by(SourceBoard.pinned.desc(), SourceBoard.sort_order.asc(), SourceBoard.name.asc())
        .all()
    )
    return {
        "success": True,
        "batches": [
            {"name": row.batch_name, "count": int(row.count or 0)}
            for row in batch_rows
        ],
        "source_boards": [
            {
                "id": board.id,
                "name": board.name,
                "batch_name": board.batch_name,
                "count": source_boards._board_counts(db, board)[0],
            }
            for board in boards
        ],
    }


@app.get("/api/lite/stats")
async def get_lite_stats(db: Session = Depends(get_db)):
    total_videos = db.query(func.count(Video.id)).scalar() or 0
    today_start = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).replace(hour=0, minute=0, second=0, microsecond=0)
    today_count = db.query(func.count(Video.id)).filter(Video.created_at >= today_start).scalar() or 0
    pending_count = db.query(func.count(ImportJobItem.id)).filter(ImportJobItem.status.in_(["pending", "running"])).scalar() or 0
    active_jobs = db.query(func.count(ImportJob.id)).filter(ImportJob.status.in_(["pending", "running"])).scalar() or 0
    
    return {
        "total_videos": total_videos,
        "today_count": today_count,
        "pending_queue": pending_count,
        "active_jobs": active_jobs,
    }


# Quick URL intake directly from the dashboard topbar
class QuickImportPayload(BaseModel):
    urls: List[str]
    batch_name: Optional[str] = "Quick Lite Import"


class LiteBatchActionPayload(BaseModel):
    """The deliberately small set of actions exposed by the LITE gallery."""
    video_ids: List[int] = Field(min_length=1, max_length=200)
    action: str

@app.post("/api/lite/quick-import")
async def quick_import_handler(payload: QuickImportPayload, db: Session = Depends(get_db)):
    cleaned_urls = [u.strip() for u in payload.urls if u.strip()]
    if not cleaned_urls:
        return {"success": False, "message": "Zadajte aspoň jednu URL adresu"}
    
    req = IntakeImportRequest(
        urls=cleaned_urls,
        batch_name=payload.batch_name or "Quick Lite Import",
    )
    job = create_import_job(req, db)
    intake_worker.start()
    await event_bus.broadcast("job_queued", {"job_id": job.id, "batch_name": job.batch_name, "total_items": len(cleaned_urls)})
    return {"success": True, "job_id": job.id, "queued": len(cleaned_urls)}


async def _refresh_lite_video_links(video_ids: List[int]) -> None:
    """Resolve source pages and refresh playback metadata before rethumbing."""
    db = SessionLocal()
    try:
        for video_id in video_ids:
            video = db.query(Video).filter(Video.id == video_id).first()
            if not video:
                continue
            source = video.source_url or video.url or ""
            if not source:
                continue
            try:
                finder = getattr(ExtractorRegistry, "get_extractor", None) or ExtractorRegistry.find_extractor
                extractor = finder(source)
                info = await extractor.extract(source) if extractor else None
                if isinstance(info, dict):
                    direct_url = info.get("stream_url") or info.get("direct_url") or info.get("url")
                    if direct_url:
                        video.url = str(direct_url)
                    if info.get("duration"):
                        video.duration = float(info["duration"])
                    if info.get("height"):
                        video.height = int(info["height"])
                    if info.get("width"):
                        video.width = int(info["width"])
                    size_bytes = info.get("size_bytes") or info.get("filesize") or info.get("size")
                    if size_bytes:
                        video.file_size_mb = round(float(size_bytes) / (1024 * 1024), 2)
                    if info.get("quality"):
                        video.quality = str(info["quality"])
                    # FileDitch's thumbsditch poster is frequently a dead 404;
                    # let the canonical processor generate a fresh local thumb.
                    if "fileditch" in source.lower() or "thumbsditch" in str(video.thumbnail_path or "").lower():
                        video.thumbnail_path = None
                    video.last_checked = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                    db.commit()
                    await event_bus.broadcast("video_link_refreshed", {"video_id": video.id})
                    continue

                direct_url = await _jit_resolve_stream_url(source, video.storage_type or "remote")
                if direct_url:
                    video.url = direct_url
                    video.last_checked = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
                    db.commit()
                    await event_bus.broadcast("video_link_refreshed", {"video_id": video.id})
            except Exception as exc:
                db.rollback()
                logger.warning("[Lite batch refresh] video_id=%s: %s", video_id, exc)
    finally:
        db.close()


async def _rethumb_lite_videos(video_ids: List[int]) -> None:
    """Reuse the canonical processor so LITE produces the same card visuals."""
    try:
        # Imported on demand: keeping this out of the LITE startup path is important.
        from .services import VIPVideoProcessor
        await VIPVideoProcessor().process_batch(video_ids)
        await event_bus.broadcast("video_rethumb_queued", {"video_ids": video_ids})
    except Exception as exc:
        logger.exception("[Lite batch rethumb] failed: %s", exc)


@app.post("/api/lite/batch-action")
async def lite_batch_action(
    payload: LiteBatchActionPayload,
    bg_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Batch operations owned by the LITE server; never proxy to the full UI."""
    video_ids = list(dict.fromkeys(payload.video_ids))
    action = (payload.action or "").strip().lower()
    if action not in {"delete", "favorite", "unfavorite", "refresh_links", "rethumb"}:
        raise HTTPException(status_code=400, detail="Nepodporovaná batch akcia")

    if action == "delete":
        deleted = db.query(Video).filter(Video.id.in_(video_ids)).delete(synchronize_session=False)
        db.commit()
        await event_bus.broadcast("video_deleted", {"video_ids": video_ids})
        return {"success": True, "queued": 0, "changed": deleted}

    if action in {"favorite", "unfavorite"}:
        changed = db.query(Video).filter(Video.id.in_(video_ids)).update(
            {Video.is_favorite: action == "favorite"}, synchronize_session=False
        )
        db.commit()
        return {"success": True, "queued": 0, "changed": changed}

    if action == "refresh_links":
        bg_tasks.add_task(_refresh_lite_video_links, video_ids)
    else:  # rethumb
        bg_tasks.add_task(_rethumb_lite_videos, video_ids)
    return {"success": True, "queued": len(video_ids), "changed": 0}


@app.delete("/api/lite/videos/{video_id}")
async def delete_lite_video(video_id: int, db: Session = Depends(get_db)):
    v = db.query(Video).filter(Video.id == video_id).first()
    if not v:
        raise HTTPException(status_code=404, detail="Video nebolo nájdené")
    db.delete(v)
    db.commit()
    await event_bus.broadcast("video_deleted", {"video_id": video_id})
    return {"success": True, "message": "Video vymazané"}


# ---------------------------------------------------------------------------
# Helpers — rozpoznávanie priamych streamovateľných URL
# ---------------------------------------------------------------------------
_DIRECT_EXTENSIONS = (".mp4", ".m4v", ".webm", ".mkv", ".mov", ".ts", ".m3u8", ".mpd")
_CDN_PATTERNS = (
    "cdn.", ".cdn.", "/cdn/", "cdnjs.", "cloudfront.net", "akamaized.net",
    "fastly.", "b-cdn.net", ".b-cdn.", "cr.com", "pixeldrain.com/api/file",
    "bunkr.si/v/", "pmvhaven.com/videos/", "pvvstream.pro", "fpo.xxx/get_file",
    "storage_type=cdn_direct",
)

def _is_direct_streamable(url: str) -> bool:
    """Vráti True ak URL je priamy CDN/mp4 link, ktorý prehliadač vie prehrať bez resolve."""
    if not url:
        return False
    lower = url.lower()
    # FileDitch's public "pretty" URL ends in .mp4, but it is an HTML viewer
    # guarded by a proof-of-work redirect. Treating it as a direct file first
    # can leave the dashboard with the viewer page instead of the signed CDN
    # URL. Real FileDitch CDN URLs use other hosts (for example
    # fileditchstuff / freakingfileditch).
    if "fileditchfiles." in lower:
        return False
    # SxyPrn serves MP4 bytes under signed .vid URLs (including CDN redirects
    # to trafficdeposit). These must pass both resolve validation and the
    # Range-aware proxy; redirecting them to the browser loses the referer.
    parsed = urlparse(lower)
    host = parsed.hostname or ""
    if parsed.path.endswith(".vid") and (
        host in {"sxyprn.com", "sxyprn.net", "trafficdeposit.com"}
        or host.endswith((".sxyprn.com", ".sxyprn.net", ".trafficdeposit.com"))
    ):
        return True
    # Priame súborové prípony
    for ext in _DIRECT_EXTENSIONS:
        if ext in lower:
            return True
    # Známe CDN vzory
    for pat in _CDN_PATTERNS:
        if pat in lower:
            return True
    return False


def _local_video_path(raw_url: str) -> Optional[Path]:
    """Normalize the local URL forms written by the classic and LITE importers."""
    raw = (raw_url or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if parsed.scheme.lower() == "file":
        path_text = unquote(parsed.path or "")
        # file:///C:/video.mp4 is parsed as /C:/video.mp4 on Windows.
        if os.name == "nt" and len(path_text) >= 3 and path_text[0] == "/" and path_text[2] == ":":
            path_text = path_text[1:]
        return Path(path_text)
    path = Path(raw)
    if not path.is_absolute():
        path = BASE_DIR / path
    return path


def _usable_thumbnail_url(video: Any) -> str:
    """Hide known-dead FileDitch posters from Lite cards."""
    for candidate in (video.thumbnail_path, video.original_thumbnail_url):
        value = str(candidate or "").strip()
        if value and "thumbsditch.b-cdn.net" not in value.lower():
            return value
    return "/static/placeholder.jpg"


async def _jit_resolve_stream_url(watch_url: str, storage_type: str = "remote") -> Optional[str]:
    """
    JIT resolver — používa Nexus extraktory alebo yt_dlp na vytiahnutie
    priameho CDN stream URL z watch-page URL. Beží asynchrónne v thread pool.
    Vráti priamy CDN link, alebo None ak resolve zlyhal.
    """
    def _resolve_sync() -> Optional[str]:
        # 1. Najprv skús Nexus ExtractorRegistry
        try:
            finder = getattr(ExtractorRegistry, "get_extractor", None) or ExtractorRegistry.find_extractor
            ext = finder(watch_url)
            if ext:
                if hasattr(ext, "extract_stream_url"):
                    result = ext.extract_stream_url(watch_url)  # type: ignore[attr-defined]
                    if inspect.isawaitable(result):
                        result = asyncio.run(result)
                    if result:
                        return result
                if hasattr(ext, "extract"):
                    result = asyncio.run(ext.extract(watch_url))
                    if isinstance(result, dict):
                        stream_url = result.get("stream_url") or result.get("direct_url")
                        if stream_url:
                            return str(stream_url)
        except Exception:
            logger.exception("[Lite JIT Resolve] extractor failed for %s", watch_url)

        # 2. Fallback: yt_dlp — univerzálny, zvládne 99% stránok
        try:
            import yt_dlp
            ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            opts = {
                "quiet": True,
                "skip_download": True,
                "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
                "extract_flat": False,
                "socket_timeout": 20,
                "user_agent": ua,
                "http_headers": {"User-Agent": ua, "Referer": watch_url},
                "nocheckcertificate": True,
            }
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(watch_url, download=False) or {}

            stream_url = info.get("url", "")
            if not stream_url and info.get("formats"):
                fmts = [f for f in info["formats"] if f.get("url") and f.get("vcodec") != "none"]
                if fmts:
                    fmts.sort(key=lambda f: (f.get("height") or 0), reverse=True)
                    stream_url = fmts[0]["url"]
            return stream_url or None
        except Exception as e:
            logger.warning("[Lite JIT Resolve] yt_dlp failed for %s: %s", watch_url, e)
            return None

    # Spusti synchrónny resolve v thread pool — nablokuje event loop
    return await asyncio.get_event_loop().run_in_executor(None, _resolve_sync)


# ---------------------------------------------------------------------------
# Range-Aware Video Stream Proxy & Local Player Endpoint
# ---------------------------------------------------------------------------
@app.get("/api/lite/resolve/{video_id}")
async def resolve_lite_playback(video_id: int, refresh: bool = False, db: Session = Depends(get_db)):
    """Resolve against the stable source, including cards with expired HLS URLs."""
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(404, detail="Video nenájdené")
    if video.storage_type in {"local", "local_direct", "bittorrent", "mega"}:
        return {"stream_url": f"/api/lite/stream/{video_id}", "is_hls": False, "method": "lokálny stream / bridge"}
    candidate = str(video.url or "")
    source = str(video.source_url or candidate)
    # Refresh every stored watch-page-backed link before starting. A direct
    # file with no stable source can only be retried, not re-extracted.
    needs_resolve = refresh or not _is_direct_streamable(candidate) or (source != candidate and not _is_direct_streamable(source))
    if needs_resolve:
        try:
            direct = await asyncio.wait_for(_jit_resolve_stream_url(source, video.storage_type), timeout=45)
        except asyncio.TimeoutError:
            raise HTTPException(504, detail="Zdroj nevrátil nový stream ani token počas 45 sekúnd")
        if not direct or not _is_direct_streamable(direct):
            raise HTTPException(502, detail="Zdroj nevrátil prehrateľný stream. Overte dostupnosť videa a prihlásenie na pôvodnej stránke")
        candidate = direct
        video.url = direct
        db.commit()
    if not candidate:
        raise HTTPException(400, detail="Video nemá URL ani pôvodný zdroj")
    is_hls = ".m3u8" in candidate.lower()
    return {
        "stream_url": (f"/api/lite/hls?url={quote(candidate, safe='')}&referer={quote(source, safe='')}" if is_hls else f"/api/lite/stream/{video_id}"),
        "url": candidate, "is_hls": is_hls,
        "method": "čerstvý odkaz z pôvodného zdroja" if needs_resolve else "uložený priamy stream",
    }


@app.get("/api/lite/hls")
async def lite_hls_proxy(url: str, request: Request, referer: str = ""):
    """Proxy HLS manifests and segments so Chromium can play cross-origin HLS."""
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Invalid HLS URL")
    parsed = urlparse(target)
    origin = f"{parsed.scheme}://{parsed.netloc}/"
    headers = {
        "User-Agent": request.headers.get("user-agent", "Mozilla/5.0"),
        "Accept": "*/*",
        "Referer": referer or origin,
    }
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]

    client = httpx.AsyncClient(timeout=httpx.Timeout(35.0, connect=10.0), follow_redirects=True, verify=False)
    upstream = await client.send(client.build_request("GET", target, headers=headers), stream=True)
    if upstream.status_code >= 400:
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(status_code=upstream.status_code, detail="HLS upstream unavailable")

    content_type = upstream.headers.get("content-type", "")
    is_manifest = target.lower().split("?", 1)[0].endswith(".m3u8") or "mpegurl" in content_type.lower()
    if is_manifest:
        body = (await upstream.aread()).decode("utf-8", errors="replace")
        manifest_base = str(upstream.url)
        await upstream.aclose()
        await client.aclose()
        encoded_referer = quote(referer or origin, safe="")
        rewritten = []
        for line in body.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                child = urljoin(manifest_base, stripped)
                rewritten.append(f"/api/lite/hls?url={quote(child, safe='')}&referer={encoded_referer}")
                continue  # Never also append the original relative segment.
            elif stripped.startswith("#") and 'URI="' in stripped:
                def rewrite_uri(match):
                    child = urljoin(manifest_base, match.group(1))
                    return f'URI="/api/lite/hls?url={quote(child, safe="")}&referer={encoded_referer}"'
                line = re.sub(r'URI="([^"]+)"', rewrite_uri, line)
            rewritten.append(line)
        return Response(
            content="\n".join(rewritten),
            media_type="application/vnd.apple.mpegurl",
            headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"},
        )

    async def stream_body():
        try:
            async for chunk in upstream.aiter_bytes(chunk_size=1024 * 1024):
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    response_headers = {"Access-Control-Allow-Origin": "*", "Accept-Ranges": "bytes"}
    for key in ("content-length", "content-range"):
        if upstream.headers.get(key):
            response_headers[key.title()] = upstream.headers[key]
    return StreamingResponse(stream_body(), status_code=upstream.status_code,
                             media_type=content_type or "video/mp2t", headers=response_headers)


@app.get("/api/lite/stream/{video_id}")
async def stream_lite_video(video_id: int, request: Request, db: Session = Depends(get_db)):
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(status_code=404, detail="Video nenájdené")

    # 1. Lokálny súbor — priamy FileResponse
    if video.storage_type in ("local", "local_direct", "bittorrent") and (video.url or video.source_url):
        local_path = _local_video_path(video.url or video.source_url or "")
        if local_path and local_path.exists() and local_path.is_file():
            media_type = mimetypes.guess_type(local_path.name)[0] or "application/octet-stream"
            return FileResponse(
                path=str(local_path),
                media_type=media_type,
                filename=local_path.name,
            )

    # 2. Mega storage — presmeruj na mega router
    if video.storage_type == "mega" or str(video.url or "").lower().startswith("mega:"):
        return Response(status_code=307, headers={"Location": f"/api/v1/mega/stream/{video_id}"})

    # Vyber najlepší dostupný URL
    candidate_url = video.url or video.source_url or ""
    source_url = video.source_url or ""
    is_faphouse = "faphouse.com" in f"{candidate_url} {source_url}".lower()
    is_eporner = "eporner.com" in f"{candidate_url} {source_url}".lower()
    if is_eporner and "/dload/" not in candidate_url.lower() and "/dload/" in source_url.lower():
        candidate_url = video.url or source_url
    elif is_eporner and ".eporner.com/" in candidate_url.lower() and "/dload/" not in candidate_url.lower():
        source_url = candidate_url

    # 3. CDN direct / priamy mp4 link — stream proxy s Range support
    if _is_direct_streamable(candidate_url) or video.storage_type == "cdn_direct":
        # An HLS manifest contains relative segment URLs.  Redirect it so the
        # browser/Hls.js keeps the CDN URL as the manifest base; streaming the
        # manifest through this endpoint would make segments resolve locally.
        if ".m3u8" in candidate_url.lower():
            if source_url and source_url != candidate_url and not _is_direct_streamable(source_url):
                resolved = await resolve_lite_playback(video_id, refresh=True, db=db)
                return Response(status_code=302, headers={"Location": resolved["stream_url"]})
            # FapHouse signs FlixCDN playlists for its origin. A browser
            # redirect drops that referer, so route the manifest and segments
            # through the existing proxy instead.
            if is_faphouse:
                referer = source_url or "https://faphouse.com/"
                proxy_url = f"/api/lite/hls?url={quote(candidate_url, safe='')}&referer={quote(referer, safe='')}"
                return Response(status_code=302, headers={"Location": proxy_url})
            return Response(status_code=302, headers={"Location": candidate_url})
        range_header = request.headers.get("range", "bytes=0-")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Range": range_header,
            "Accept-Encoding": "identity",
        }
        if video.thumbnail_referer:
            headers["Referer"] = video.thumbnail_referer
        elif source_url:
            headers["Referer"] = source_url

        # GoFile CDN URLs need the same short-lived tokens as the main proxy.
        if "gofile.io" in candidate_url.lower() or "gofile.io" in source_url.lower():
            try:
                from .extractors.gofile import GoFileExtractor
                gofile_token = GoFileExtractor._get_token()
                if gofile_token:
                    headers["Authorization"] = f"Bearer {gofile_token}"
                    headers["Cookie"] = f"accountToken={gofile_token}"
                    headers["X-BL"] = "en-US"
                    website_token = GoFileExtractor._generate_website_token(gofile_token)
                    if website_token:
                        headers["X-Website-Token"] = website_token
            except Exception as exc:
                logger.debug("[Lite Stream] GoFile token injection failed: %s", exc)

        client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
        try:
            req = client.build_request("GET", candidate_url, headers=headers)
            res = await client.send(req, stream=True)

            # Ak CDN vráti redirect alebo CDN blokovanie → JIT resolve
            if res.status_code in (403, 401, 404, 410, 429) or res.status_code >= 500:
                await res.aclose()
                await client.aclose()
                raise ValueError(f"CDN returned {res.status_code}, trying JIT resolve")

            content_type = res.headers.get("content-type", "")
            if content_type.lower().startswith("text/html"):
                await res.aclose()
                await client.aclose()
                raise ValueError("CDN returned HTML instead of media bytes, trying JIT resolve")

            async def content_generator():
                try:
                    async for chunk in res.aiter_bytes(chunk_size=1024 * 64):
                        yield chunk
                finally:
                    await res.aclose()
                    await client.aclose()

            resp_headers = {
                "Content-Type": content_type or mimetypes.guess_type(candidate_url.split("?", 1)[0])[0] or "video/mp4",
                "Accept-Ranges": "bytes",
                # Keep byte offsets/lengths intact and flush media immediately.
                # GZipMiddleware otherwise compresses and buffers this stream.
                "Content-Encoding": "identity",
            }
            if "content-range" in res.headers:
                resp_headers["Content-Range"] = res.headers["content-range"]
            if "content-length" in res.headers:
                resp_headers["Content-Length"] = res.headers["content-length"]

            return StreamingResponse(
                content_generator(),
                status_code=res.status_code,
                headers=resp_headers,
            )
        except Exception as e:
            try:
                await client.aclose()
            except Exception:
                pass
            # Padni cez na JIT resolve nižšie
            logger.info("[Lite Stream] Direct proxy failed (%s), trying JIT resolve for id=%s", e, video_id)

    # 4. Watch-page URL → JIT resolve pomocou yt_dlp / Nexus extraktorov
    if not candidate_url:
        raise HTTPException(status_code=400, detail="Video nemá zadanú URL adresu")

    # Cached CDN URLs expire.  Resolve their immutable watch page again rather
    # than sending an expired signed URL to the extractor.
    resolve_url = source_url if _is_direct_streamable(candidate_url) and source_url else candidate_url
    logger.info("[Lite Stream] JIT resolving stream for video_id=%s url=%s", video_id, resolve_url[:80])
    try:
        direct_url = await asyncio.wait_for(
            _jit_resolve_stream_url(resolve_url, video.storage_type),
            timeout=22.0,
        )
    except asyncio.TimeoutError:
        direct_url = None

    if direct_url:
        logger.info("[Lite Stream] JIT resolved → %s", direct_url[:80])
        # Krátkodobý cache: ulož resolved URL späť do DB pre rýchlejšie ďalšie prehrávanie
        try:
            if _is_direct_streamable(direct_url) and direct_url != video.url:
                video.url = direct_url
                db.commit()
        except Exception:
            pass
        # Prehliadač si streamnuje priamy CDN link sám (bez servera ako medzičlánka)
        location = direct_url
        if ".m3u8" in direct_url.lower():
            location = f"/api/lite/hls?url={quote(direct_url, safe='')}&referer={quote(resolve_url, safe='')}"
        return Response(status_code=302, headers={"Location": location})

    # 5. Absolútny fallback — presmeruj priamo na watch page alebo zdroj
    logger.warning("[Lite Stream] JIT resolve failed for video_id=%s, fallback redirect", video_id)
    raise HTTPException(502, detail="Obnova streamu z pôvodného zdroja zlyhala. Overte dostupnosť videa alebo prihlásenie na zdroji")


# ---------------------------------------------------------------------------
# Real-Time SSE Stream Endpoint
# ---------------------------------------------------------------------------
@app.get("/api/lite/events")
async def sse_event_stream(request: Request):
    q = event_bus.subscribe()
    
    async def event_generator() -> AsyncGenerator[str, None]:
        try:
            # Send initial keepalive
            yield f"event: ping\ndata: {json.dumps({'status': 'connected'})}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"event: update\ndata: {payload}\n\n"
                except asyncio.TimeoutError:
                    yield f"event: ping\ndata: {json.dumps({'time': time.time()})}\n\n"
        finally:
            event_bus.unsubscribe(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def format_duration(seconds: float) -> str:
    if not seconds or seconds <= 0:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


