import asyncio
import logging
import time
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from datetime import datetime, timezone

from app.database import get_db, VKSource, DiscoveredVideo, Video, ImportJob, ImportJobItem
from app.extractors.vk import VKExtractor

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/vk", tags=["vk"])

class SourceCreate(BaseModel):
    name: str
    url: str
    source_type: Optional[str] = "group"
    notes: Optional[str] = None

class ScanRequest(BaseModel):
    source_id: Optional[int] = None
    url: Optional[str] = None
    keyword: Optional[str] = None
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None

class ImportVideosRequest(BaseModel):
    discovered_ids: List[int]
    batch_prefix: Optional[str] = "VK"

@router.post("/import-sources")
def import_sources(sources: List[SourceCreate], db: Session = Depends(get_db)):
    added = 0
    for s in sources:
        # Check duplicate
        existing = db.query(VKSource).filter(VKSource.url == s.url).first()
        if not existing:
            new_source = VKSource(
                name=s.name,
                url=s.url,
                source_type=s.source_type,
                notes=s.notes,
                is_active=True
            )
            db.add(new_source)
            added += 1
    db.commit()
    return {"success": True, "added_count": added}

@router.get("/sources")
def get_sources(db: Session = Depends(get_db)):
    sources = db.query(VKSource).order_by(VKSource.created_at.desc()).all()
    return {
        "success": True,
        "sources": [
            {
                "id": s.id,
                "name": s.name,
                "url": s.url,
                "source_type": s.source_type,
                "is_active": s.is_active,
                "last_scanned": s.last_scanned.isoformat() if s.last_scanned else None,
                "notes": s.notes,
                "created_at": s.created_at.isoformat() if s.created_at else None
            }
            for s in sources
        ]
    }

def _run_vk_scan(target_url: str, keyword: Optional[str], min_duration: Optional[int], max_duration: Optional[int], source_name: str, db: Session):
    try:
        import yt_dlp
        import os

        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        ydl_opts = {
            'quiet': True,
            'extract_flat': True,
            'ignoreerrors': True,
            'no_warnings': True,
            'user_agent': user_agent,
        }

        vk_cookie_candidates = [
            os.path.join("app", "vkvideo.ru_cookies.txt"),
            os.path.join("app", "vk.com_cookies.txt"),
            "vkvideo.ru_cookies.txt",
            "vk.com_cookies.txt",
        ]
        _cookie_file = next((p for p in vk_cookie_candidates if os.path.exists(p)), None)
        if _cookie_file:
            ydl_opts['cookiefile'] = _cookie_file

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # If keyword is provided and no specific source URL, search VK
            if keyword and ("search" in target_url or not target_url.startswith("http")):
                search_query = f"ytsearch20:{keyword}"
                info = ydl.extract_info(search_query, download=False)
            else:
                info = ydl.extract_info(target_url, download=False)

            entries = info.get('entries', []) if info and 'entries' in info else ([info] if info else [])

            found_count = 0
            for entry in entries:
                if not entry or not entry.get('url'):
                    continue

                title = entry.get('title') or "Untitled VK Video"
                if keyword and keyword.lower() not in title.lower():
                    continue

                duration = entry.get('duration') or 0
                if min_duration and duration < min_duration:
                    continue
                if max_duration and duration > max_duration:
                    continue

                video_url = entry.get('url')
                if not video_url.startswith('http'):
                    video_url = f"https://vk.com/{video_url.lstrip('/')}"

                # Check if already in discovered_videos or main videos
                existing_disc = db.query(DiscoveredVideo).filter(DiscoveredVideo.url == video_url).first()
                existing_main = db.query(Video).filter(Video.url == video_url).first()

                if not existing_disc and not existing_main:
                    disc = DiscoveredVideo(
                        profile_id=0,
                        profile_name=source_name,
                        title=title,
                        url=video_url,
                        source_url=target_url,
                        thumbnail=entry.get('thumbnails', [{}])[-1].get('url') if entry.get('thumbnails') else (entry.get('thumbnail') or ''),
                        duration=duration,
                        source="vk",
                        imported=False
                    )
                    db.add(disc)
                    found_count += 1

            db.commit()
            logger.info(f"VK scan completed for {target_url}. Found {found_count} new videos.")
    except Exception as e:
        logger.error(f"Error during VK scan of {target_url}: {e}")

@router.post("/scan-source")
def scan_source(req: ScanRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    target_url = req.url
    source_name = "VK Scan"

    if req.source_id:
        src = db.query(VKSource).filter(VKSource.id == req.source_id).first()
        if not src:
            raise HTTPException(status_code=404, detail="Source not found")
        target_url = src.url
        source_name = src.name
        src.last_scanned = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

    if not target_url and req.keyword:
        target_url = "search"
        source_name = f"Search: {req.keyword}"

    if not target_url:
        raise HTTPException(status_code=400, detail="Must provide source_id, url, or keyword")

    background_tasks.add_task(_run_vk_scan, target_url, req.keyword, req.min_duration, req.max_duration, source_name, db)
    return {"success": True, "message": f"Background scan started for {source_name}"}

class DiscoverSourcesRequest(BaseModel):
    keyword: str
    limit_sources: Optional[int] = 20
    scan_limit: Optional[int] = 100 # How many videos to scan to find sources

@router.post("/discover-sources")
async def discover_sources(req: DiscoverSourcesRequest, db: Session = Depends(get_db)):
    """
    Searches VK for a keyword and adds found unique authors/groups to the watchlist.
    """
    # Note: VK blocks generic backend search queries (HTTP 429) and yt-dlp falls back to YouTube.
    # Therefore, backend VK search by keyword is currently unsupported.
    return {
        "success": False, 
        "error": "Backendové vyhľadávanie priamo na VK je blokované (VK vracia Error 429 pre botov). Na hľadanie nových VK skupín použi prosím vyhľadávanie priamo vo svojom prehliadači na vk.com a klikni na modré tlačidlo '🎯 Track Source', ktoré tam pridala naša extenzia."
    }

@router.get("/discovered")
def get_discovered(db: Session = Depends(get_db)):
    videos = db.query(DiscoveredVideo).filter(DiscoveredVideo.source == "vk", DiscoveredVideo.imported == False).order_by(DiscoveredVideo.discovered_at.desc()).all()
    return {
        "success": True,
        "videos": [
            {
                "id": v.id,
                "title": v.title,
                "url": v.url,
                "source_url": v.source_url,
                "thumbnail": v.thumbnail,
                "duration": v.duration,
                "profile_name": v.profile_name,
                "discovered_at": v.discovered_at.isoformat() if v.discovered_at else None
            }
            for v in videos
        ]
    }

@router.post("/import-videos")
async def import_videos(req: ImportVideosRequest, db: Session = Depends(get_db)):
    imported_count = 0
    batch_name = f"{req.batch_prefix}-{datetime.now(timezone.utc).replace(tzinfo=None).strftime('%Y%m%d')}"

    discovered = db.query(DiscoveredVideo).filter(DiscoveredVideo.id.in_(req.discovered_ids)).all()

    for d in discovered:
        existing = db.get(Video, d.video_id) if d.video_id else None
        if not existing:
            existing = db.query(Video).filter(Video.url == d.url).first()
        if not existing:
            new_video = Video(
                title=d.title,
                url=d.url,
                source_url=d.url, # VK JIT refreshing uses original url
                thumbnail_path=d.thumbnail,
                duration=d.duration,
                batch_name=batch_name,
                storage_type="remote",
                status="pending"
            )
            db.add(new_video)
            db.flush()
            d.imported = True
            d.video_id = new_video.id
            d.imported_at = datetime.now(timezone.utc).replace(tzinfo=None)
            imported_count += 1
            existing = new_video

        # Repeated imports also repair shells left pending by the old handler.
        d.imported = True
        d.video_id = existing.id
        d.imported_at = d.imported_at or datetime.now(timezone.utc).replace(tzinfo=None)
        if existing.status in {"pending", "error", "failed"}:
            queue_vk_video(db, existing)

    db.commit()
    from app.intake import intake_worker
    intake_worker.start()
    return {"success": True, "imported_count": imported_count}


def queue_vk_video(db: Session, video: Video) -> None:
    """Persist work for an existing VK shell, without creating another card."""
    from app.intake import normalize_intake_url
    active = db.query(ImportJobItem).filter(
        ImportJobItem.video_id == video.id,
        ImportJobItem.status.in_(["pending", "pending_retry", "running"]),
    ).first()
    if active:
        return
    job = ImportJob(batch_name=video.batch_name, source_mode="vk", status="queued",
                    options={"process_existing_video": True}, total_items=1, pending_items=1)
    db.add(job)
    db.flush()
    db.add(ImportJobItem(job_id=job.id, video_id=video.id, url=video.source_url or video.url,
                        source_url=video.source_url or video.url,
                        normalized_url=normalize_intake_url(video.source_url or video.url),
                        normalized_source="vk", title=video.title, status="pending"))


# ── helpers ───────────────────────────────────────────────────────────────────

def _save_discovered_videos(raw_videos: List[Dict[str, Any]], profile_name: str, db: Session) -> List[DiscoveredVideo]:
    """Upsert a list of raw VK video dicts into DiscoveredVideo; return newly-created rows."""
    created = []
    for v in raw_videos:
        url = v.get("url", "")
        if not url:
            continue
        if db.query(DiscoveredVideo).filter(DiscoveredVideo.url == url).first():
            continue
        if db.query(Video).filter(Video.url == url).first():
            continue
        row = DiscoveredVideo(
            profile_id=0,
            profile_name=v.get("channel_name") or profile_name,
            title=v.get("title") or "VK Video",
            url=url,
            source_url=v.get("source_url") or url,
            thumbnail=v.get("thumbnail") or "",
            duration=int(v.get("duration") or 0),
            source="vk",
            imported=False,
        )
        db.add(row)
        created.append(row)
    db.commit()
    for row in created:
        db.refresh(row)
    return created


def _disc_to_dict(d: DiscoveredVideo) -> Dict[str, Any]:
    return {
        "id": d.id,
        "title": d.title,
        "url": d.url,
        "source_url": d.source_url,
        "thumbnail": d.thumbnail,
        "duration": d.duration,
        "profile_name": d.profile_name,
        "discovered_at": d.discovered_at.isoformat() if d.discovered_at else None,
    }


# ── latest followed feed ──────────────────────────────────────────────────────

class LatestFollowedRequest(BaseModel):
    limit: Optional[int] = 30
    refresh: Optional[bool] = True
    max_feed_videos: Optional[int] = 120


@router.post("/latest-followed")
def latest_followed(req: LatestFollowedRequest, db: Session = Depends(get_db)):
    from app.vk_ko_discovery import scan_vk_following_feed_recent_videos_sync
    feed_refresh: Dict[str, Any] = {}
    try:
        if req.refresh:
            result = scan_vk_following_feed_recent_videos_sync(max_videos=int(req.max_feed_videos or 120))
            feed_refresh = {
                "videos_seen": result.get("video_count", 0),
                "channels_seen": result.get("channel_count", 0),
            }
            _save_discovered_videos(result.get("videos", []), "VK Following Feed", db)
    except Exception as exc:
        logger.warning("VK following feed scan failed: %s", exc)
        feed_refresh = {"error": str(exc)}

    limit = max(1, min(int(req.limit or 30), 200))
    rows = (
        db.query(DiscoveredVideo)
        .filter(DiscoveredVideo.source == "vk", DiscoveredVideo.imported == False)
        .order_by(DiscoveredVideo.discovered_at.desc())
        .limit(limit)
        .all()
    )
    return {"success": True, "videos": [_disc_to_dict(r) for r in rows], "feed_refresh": feed_refresh}


# ── import followed groups ────────────────────────────────────────────────────

class ImportFollowedGroupsRequest(BaseModel):
    max_groups: Optional[int] = 300


@router.post("/import-followed-groups")
def import_followed_groups(req: ImportFollowedGroupsRequest, db: Session = Depends(get_db)):
    from app.vk_ko_discovery import scan_followed_vk_groups_sync
    try:
        groups = scan_followed_vk_groups_sync(max_groups=int(req.max_groups or 300))
    except Exception as exc:
        logger.error("VK followed groups scan failed: %s", exc)
        return {"success": False, "error": str(exc)}

    found = len(groups)
    added = 0
    existing_count = 0
    for g in groups:
        url = g.get("url", "")
        if not url:
            continue
        if db.query(VKSource).filter(VKSource.url == url).first():
            existing_count += 1
            continue
        db.add(VKSource(
            name=g.get("name") or url.rsplit("@", 1)[-1],
            url=url,
            source_type=g.get("source_type") or "group",
            notes=g.get("notes") or "Auto-imported from followed communities",
            is_active=True,
        ))
        added += 1
    db.commit()
    return {"success": True, "found": found, "added": added, "existing": existing_count}


# ── refresh all followed (feed + all sources) ─────────────────────────────────

class RefreshAllFollowedRequest(BaseModel):
    max_groups: Optional[int] = 300
    max_sources: Optional[int] = 40
    max_videos_per_source: Optional[int] = 40
    max_playlist_videos: Optional[int] = 80
    max_feed_videos: Optional[int] = 200


@router.post("/refresh-all-followed")
def refresh_all_followed(req: RefreshAllFollowedRequest, db: Session = Depends(get_db)):
    from app.vk_ko_discovery import (
        scan_vk_following_feed_recent_videos_sync,
        scan_vk_source_recent_videos_sync,
    )
    feed_result: Dict[str, Any] = {}
    try:
        fr = scan_vk_following_feed_recent_videos_sync(max_videos=int(req.max_feed_videos or 200))
        _save_discovered_videos(fr.get("videos", []), "VK Following Feed", db)
        feed_result = {"videos_seen": fr.get("video_count", 0), "channels_seen": fr.get("channel_count", 0)}
    except Exception as exc:
        logger.warning("VK feed refresh failed: %s", exc)
        feed_result = {"error": str(exc)}

    sources = (
        db.query(VKSource)
        .filter(VKSource.is_active == True)
        .order_by(VKSource.last_scanned.asc().nullsfirst())
        .limit(int(req.max_sources or 40))
        .all()
    )
    sources_scanned = 0
    for src in sources:
        try:
            res = scan_vk_source_recent_videos_sync(src.url, max_videos=int(req.max_videos_per_source or 40))
            _save_discovered_videos(res.get("videos", []), src.name, db)
            src.last_scanned = datetime.now(timezone.utc).replace(tzinfo=None)
            db.commit()
            sources_scanned += 1
        except Exception as exc:
            logger.warning("VK source refresh failed for %s: %s", src.url, exc)

    return {
        "success": True,
        "following_feed": feed_result,
        "sources_refresh": {"sources_scanned": sources_scanned},
    }


# ── source keyword search ─────────────────────────────────────────────────────

class SourceKeywordSearchRequest(BaseModel):
    keyword: str
    source_ids: Optional[List[int]] = None
    max_sources: Optional[int] = 40
    max_videos_per_source: Optional[int] = 40
    max_playlist_videos: Optional[int] = 80
    include_playlists: Optional[bool] = True
    min_quality: Optional[int] = 0


@router.post("/source-keyword-search")
def source_keyword_search(req: SourceKeywordSearchRequest, db: Session = Depends(get_db)):
    from app.vk_ko_discovery import scan_vk_source_recent_videos_sync
    kw = (req.keyword or "").strip().lower()
    if not kw:
        return {"success": False, "error": "keyword is required"}

    query = db.query(VKSource).filter(VKSource.is_active == True)
    if req.source_ids:
        query = query.filter(VKSource.id.in_(req.source_ids))
    sources = query.order_by(VKSource.last_scanned.asc().nullsfirst()).limit(int(req.max_sources or 40)).all()

    results: List[Dict[str, Any]] = []
    sources_scanned = 0
    videos_scanned = 0
    playlists_scanned = 0

    for src in sources:
        try:
            res = scan_vk_source_recent_videos_sync(src.url, max_videos=int(req.max_videos_per_source or 40))
            sources_scanned += 1
            for v in res.get("videos", []):
                videos_scanned += 1
                if kw in (v.get("title") or "").lower():
                    row = _save_discovered_videos([v], src.name, db)
                    if row:
                        d = row[0]
                        results.append({**_disc_to_dict(d), "item_type": "video", "community_name": src.name,
                                        "quality": "", "width": 0, "height": 0, "file_size_mb": None, "result_key": f"video:{d.url}"})
                    else:
                        # already in DB
                        existing = db.query(DiscoveredVideo).filter(DiscoveredVideo.url == v["url"]).first()
                        if existing:
                            results.append({**_disc_to_dict(existing), "item_type": "video", "community_name": src.name,
                                            "quality": "", "width": 0, "height": 0, "file_size_mb": None, "result_key": f"video:{existing.url}"})
            if req.include_playlists:
                for p in res.get("playlists", []):
                    playlists_scanned += 1
                    if kw in (p.get("title") or "").lower():
                        results.append({
                            "item_type": "playlist", "url": p["url"], "title": p.get("title") or "VK playlist",
                            "community_name": src.name, "thumbnail": p.get("thumbnail") or "",
                            "video_count": p.get("video_count") or 0,
                            "result_key": f"playlist:{p['url']}",
                        })
        except Exception as exc:
            logger.warning("source-keyword-search failed for %s: %s", src.url, exc)

    return {
        "success": True, "keyword": req.keyword, "result_count": len(results), "results": results,
        "sources_scanned": sources_scanned, "videos_scanned": videos_scanned, "playlists_scanned": playlists_scanned,
    }


# ── KO playlist search (external search engines) ──────────────────────────────

class KoPlaylistSearchRequest(BaseModel):
    keyword: str
    engines: Optional[List[str]] = None
    pages: Optional[int] = 2
    site_domain: Optional[str] = "vkvideo.ru/playlist"
    extra_terms: Optional[str] = "vk video playlist porn"
    exclude_terms: Optional[str] = ""
    min_video_count: Optional[int] = 0
    max_results: Optional[int] = 300
    target_results: Optional[int] = 100
    min_quality: Optional[int] = 720


@router.post("/ko-playlist-search")
async def ko_playlist_search(req: KoPlaylistSearchRequest):
    from app.vk_ko_discovery import (
        scan_external_playlist_search_sync,
        enrich_vk_playlist_results,
    )
    engines = req.engines or ["yandex", "duckduckgo", "google"]
    all_playlists: List[Dict[str, Any]] = []
    seen_urls: set = set()
    target = int(req.target_results or 100)
    max_results = int(req.max_results or 300)

    try:
        all_playlists = await asyncio.wait_for(
            asyncio.to_thread(
                scan_external_playlist_search_sync,
                req.keyword,
                engines,
                int(req.pages or 2),
                req.site_domain or "vkvideo.ru/playlist",
                req.extra_terms or "",
                req.exclude_terms or "",
                int(req.min_video_count or 0),
                max_results,
            ),
            timeout=90,
        )
    except Exception as exc:
        logger.exception("ko-playlist-search playwright failed")
        detail = f"{type(exc).__name__}: {exc}".strip()
        return {"success": False, "error": detail or "VK search timed out or failed; check server logs."}

    try:
        all_playlists = enrich_vk_playlist_results(all_playlists)
    except Exception as exc:
        logger.warning("Enrich failed (returning unenriched): %s", exc)

    min_vc = int(req.min_video_count or 0)
    if min_vc:
        all_playlists = [p for p in all_playlists if (p.get("video_count") or 0) >= min_vc]
    all_playlists.sort(key=lambda p: p.get("video_count") or 0, reverse=True)

    shortfall = max(0, target - len(all_playlists))
    return {
        "success": True,
        "result_count": len(all_playlists),
        "target_results": target,
        "min_quality": req.min_quality or 720,
        "shortfall": shortfall,
        "playlists": all_playlists[:max_results],
    }


# ── KO playlist extract from pasted text ──────────────────────────────────────

class KoPlaylistExtractRequest(BaseModel):
    raw_text: str
    source_engine: Optional[str] = "yandex"


@router.post("/ko-playlist-extract")
def ko_playlist_extract(req: KoPlaylistExtractRequest):
    from app.vk_ko_discovery import extract_playlist_results_from_text, enrich_vk_playlist_results
    try:
        playlists = extract_playlist_results_from_text(req.raw_text or "", source_engine=req.source_engine or "yandex")
        if playlists:
            try:
                playlists = enrich_vk_playlist_results(playlists)
            except Exception as exc:
                logger.warning("Enrich after paste failed: %s", exc)
        return {"success": True, "total": len(playlists), "playlists": playlists}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ── KO community playlists scan ───────────────────────────────────────────────

class KoCommunityPlaylistsRequest(BaseModel):
    url: str


@router.post("/ko-community-playlists")
def ko_community_playlists(req: KoCommunityPlaylistsRequest):
    from app.vk_ko_discovery import scan_vk_source_recent_videos_sync, enrich_vk_playlist_results
    try:
        res = scan_vk_source_recent_videos_sync(req.url, max_videos=10)
        playlists = res.get("playlists", [])
        if playlists:
            try:
                playlists = enrich_vk_playlist_results(playlists)
            except Exception as exc:
                logger.warning("Community playlist enrich failed: %s", exc)
        return {"success": True, "total": len(playlists), "playlists": playlists}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ── KO playlist preview (probe video metadata) ────────────────────────────────

class KoPlaylistPreviewRequest(BaseModel):
    url: str
    title: Optional[str] = ""
    min_quality: Optional[int] = 720
    max_videos: Optional[int] = 30
    require_complete_metadata: Optional[bool] = True


@router.post("/ko-playlist-preview")
def ko_playlist_preview(req: KoPlaylistPreviewRequest):
    from app.vk_ko_discovery import scan_vk_playlist_videos_sync
    import yt_dlp, os

    try:
        result = scan_vk_playlist_videos_sync(req.url, max_videos=int(req.max_videos or 30))
    except Exception as exc:
        return {"success": False, "error": str(exc)}

    raw_videos = result.get("videos", [])
    min_q = int(req.min_quality or 0)
    probed_videos: List[Dict[str, Any]] = []

    user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    ydl_opts = {
        'quiet': True, 'skip_download': True, 'ignoreerrors': True, 'no_warnings': True,
        'user_agent': user_agent,
    }
    cookie_candidates = ["app/vkvideo.ru_cookies.txt", "app/vk.com_cookies.txt", "vkvideo.ru_cookies.txt", "vk.com_cookies.txt"]
    cf = next((p for p in cookie_candidates if os.path.exists(p)), None)
    if cf:
        ydl_opts['cookiefile'] = cf

    ready = 0
    for v in raw_videos[:int(req.max_videos or 30)]:
        vurl = v.get("url", "")
        if not vurl:
            continue
        probe: Dict[str, Any] = {"url": vurl, "title": v.get("title") or "VK Video",
                                  "thumbnail": v.get("thumbnail") or "", "duration": 0,
                                  "quality": "", "width": 0, "height": 0, "file_size_mb": None,
                                  "metadata_ready": False, "missing_metadata": []}
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(vurl, download=False)
            if info:
                probe["title"] = info.get("title") or probe["title"]
                probe["thumbnail"] = info.get("thumbnail") or probe["thumbnail"]
                probe["duration"] = int(info.get("duration") or 0)
                fmts = [f for f in (info.get("formats") or []) if f.get("vcodec") != "none" and f.get("height")]
                if fmts:
                    best = max(fmts, key=lambda f: (f.get("height") or 0))
                    probe["height"] = best.get("height") or 0
                    probe["width"] = best.get("width") or 0
                    probe["quality"] = f"{probe['height']}p"
                    probe["file_size_mb"] = round(best.get("filesize", 0) / 1048576, 1) if best.get("filesize") else None
        except Exception:
            pass
        missing = []
        if not probe.get("title"):
            missing.append("title")
        if not probe.get("thumbnail"):
            missing.append("thumbnail")
        if not probe.get("duration"):
            missing.append("duration")
        if not probe.get("height"):
            missing.append("quality")
        probe["missing_metadata"] = missing
        is_ready = not missing and (not min_q or probe["height"] >= min_q)
        probe["metadata_ready"] = is_ready
        if is_ready:
            ready += 1
        probed_videos.append(probe)

    return {
        "success": True,
        "videos": probed_videos,
        "probed": len(probed_videos),
        "ready_count": ready,
        "total_links": len(raw_videos),
        "min_quality": min_q,
    }


# ── KO import playlist ────────────────────────────────────────────────────────

class KoImportPlaylistRequest(BaseModel):
    url: str
    title: Optional[str] = ""
    min_quality: Optional[int] = 720
    require_complete_metadata: Optional[bool] = True


@router.post("/import-ko-playlist")
def import_ko_playlist(req: KoImportPlaylistRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    def _bg_import(url: str, title: str, min_q: int):
        from app.vk_ko_discovery import scan_vk_playlist_videos_sync
        import yt_dlp, os
        try:
            result = scan_vk_playlist_videos_sync(url, max_videos=500)
        except Exception as exc:
            logger.error("KO playlist expand failed for %s: %s", url, exc)
            return

        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        ydl_opts = {
            'quiet': True, 'skip_download': True, 'ignoreerrors': True, 'no_warnings': True,
            'user_agent': user_agent,
        }
        cookie_candidates = ["app/vkvideo.ru_cookies.txt", "app/vk.com_cookies.txt", "vkvideo.ru_cookies.txt", "vk.com_cookies.txt"]
        cf = next((p for p in cookie_candidates if os.path.exists(p)), None)
        if cf:
            ydl_opts['cookiefile'] = cf

        batch = title or f"VK-KO-{datetime.now(timezone.utc).replace(tzinfo=None).strftime('%Y%m%d')}"
        from app.database import SessionLocal
        db2 = SessionLocal()
        try:
            for v in result.get("videos", []):
                vurl = v.get("url", "")
                if not vurl:
                    continue
                if db2.query(Video).filter(Video.url == vurl).first():
                    continue
                height = 0
                vtitle = v.get("title") or "VK Video"
                thumbnail = v.get("thumbnail") or ""
                if min_q:
                    try:
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            info = ydl.extract_info(vurl, download=False)
                        if info:
                            fmts = [f for f in (info.get("formats") or []) if f.get("vcodec") != "none" and f.get("height")]
                            if fmts:
                                best = max(fmts, key=lambda f: (f.get("height") or 0))
                                height = best.get("height") or 0
                            vtitle = info.get("title") or vtitle
                            thumbnail = info.get("thumbnail") or thumbnail
                    except Exception:
                        pass
                    if height and height < min_q:
                        continue
                db2.add(Video(
                    title=vtitle, url=vurl, source_url=vurl, thumbnail_path=thumbnail,
                    batch_name=batch, storage_type="remote", status="pending",
                ))
            db2.commit()
        finally:
            db2.close()

    background_tasks.add_task(_bg_import, req.url, req.title or "", int(req.min_quality or 0))
    return {"success": True, "message": f"Background playlist import started for {req.url}"}


# --------------------------------------------------------------------------- #
# Cookie auto-refresh — pushed by the Nexus_Gallery browser extension
# (chrome.cookies.getAll on a timer + on-change listener), same pattern as
# Faphouse's /api/v1/faphouse/cookies/sync. VK is a two-domain session
# (vk.com + vkvideo.ru); see app/vk_cookie_sync.py for why this writes to
# every path any of the 3 existing VK cookie readers checks, not just one.
# --------------------------------------------------------------------------- #

class VKCookieRow(BaseModel):
    name: str
    value: str
    domain: str = ""
    path: str = "/"
    secure: bool = False
    expirationDate: Optional[float] = None


class VKCookieSyncPayload(BaseModel):
    # {"vk.com": [...], "vkvideo.ru": [...]} — either key optional, so the
    # extension can sync whichever domain's tab actually changed cookies.
    cookies: Dict[str, List[VKCookieRow]] = {}


@router.post("/cookies/sync")
def sync_vk_cookies(payload: VKCookieSyncPayload):
    from app.vk_cookie_sync import write_vk_cookies

    by_domain = {domain: [row.model_dump() for row in rows] for domain, rows in payload.cookies.items()}
    return write_vk_cookies(by_domain)


@router.get("/cookies/status")
def vk_cookies_status():
    import os

    def _status(rel: str) -> Optional[float]:
        try:
            return os.path.getmtime(rel) if os.path.exists(rel) and os.path.getsize(rel) > 0 else None
        except OSError:
            return None

    now = time.time()
    out = {}
    for domain, primary in (("vk.com", "vk.com_cookies.txt"), ("vkvideo.ru", "vkvideo.ru_cookies.txt")):
        mtime = _status(primary)
        out[domain] = {
            "cookie_file": primary if mtime else None,
            "cookie_present": bool(mtime),
            "cookie_mtime": mtime,
            "age_seconds": (now - mtime) if mtime else None,
        }
    return out
