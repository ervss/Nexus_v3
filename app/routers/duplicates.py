from __future__ import annotations

import datetime
import logging
import re
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.database import Video
from app.duplicate_detector import compute_all_phashes, find_duplicates, mark_as_duplicate
from app.media_match import media_name_key, thumb_fingerprint

logger = logging.getLogger(__name__)

router = APIRouter(tags=["duplicates"])


class MarkDuplicateBody(BaseModel):
    duplicate_id: int
    original_id: int


class UrlExistsBody(BaseModel):
    urls: list[str]


class AlbumCompareItem(BaseModel):
    url: str
    title: str = ""
    size_bytes: int = 0
    duration: float = 0.0
    height: int = 0
    thumb: str = ""


class AlbumCompareBody(BaseModel):
    items: list[AlbumCompareItem]


class ReplacementItem(BaseModel):
    existing_id: int
    url: str
    source_url: Optional[str] = None
    title: Optional[str] = None
    duration: Optional[float] = None
    height: Optional[int] = None
    width: Optional[int] = None
    file_size_mb: Optional[float] = None
    thumbnail: Optional[str] = None


class ReplaceVideosBody(BaseModel):
    replacements: list[ReplacementItem]


class _LibraryLookupIndex:
    def __init__(self, ttl: float = 45.0):
        self.ttl = ttl
        self._last_built = 0.0
        self._lock = threading.Lock()
        self._by_url: Dict[str, dict] = {}
        self._by_name: Dict[str, List[dict]] = {}

    @staticmethod
    def clean_name_key(title: str, url: str = "") -> str:
        base = (title or "").strip()
        if not base and url:
            try:
                base = url.split("?")[0].rsplit("/", 1)[-1]
            except Exception:
                base = ""
        # Odstranenie beznych oznaceni kvality a hostingov, aby video_720p a video_1080p mali rovnaky kluc
        base = re.sub(
            r"\b(?:2160p?|4k|1440p?|1080p?|720p?|480p?|360p?|240p?|fhd|uhd|hd|sd|bunkr|filester|pixeldrain|gofile)\b",
            " ",
            base,
            flags=re.IGNORECASE,
        )
        return media_name_key(base, url)

    def rebuild_if_needed(self, db: Session, force: bool = False):
        with self._lock:
            now = time.monotonic()
            if not force and (now - self._last_built < self.ttl) and self._by_url:
                return

            by_url = {}
            by_name = {}
            rows = (
                db.query(
                    Video.id,
                    Video.title,
                    Video.url,
                    Video.source_url,
                    Video.height,
                    Video.duration,
                    Video.file_size_mb,
                    Video.batch_name,
                )
                .filter(Video.status != "error")
                .all()
            )

            for r in rows:
                vid_dict = {
                    "id": r.id,
                    "title": r.title or "",
                    "url": r.url or "",
                    "source_url": r.source_url or "",
                    "height": int(r.height or 0),
                    "duration": float(r.duration or 0),
                    "file_size_mb": float(r.file_size_mb or 0),
                    "batch_name": r.batch_name or "",
                }
                if r.url:
                    by_url[r.url.strip().lower()] = vid_dict
                if r.source_url:
                    by_url[r.source_url.strip().lower()] = vid_dict

                name_key = self.clean_name_key(r.title, r.url)
                if name_key:
                    by_name.setdefault(name_key, []).append(vid_dict)

            self._by_url = by_url
            self._by_name = by_name
            self._last_built = now

    def lookup(self, url: str, title: str = "", duration: float = 0.0) -> Optional[dict]:
        with self._lock:
            by_url = self._by_url
            by_name = self._by_name

        if url:
            match = by_url.get(url.strip().lower())
            if match:
                return match

        name_key = self.clean_name_key(title, url)
        if name_key and name_key in by_name:
            candidates = by_name[name_key]
            if len(candidates) == 1:
                return candidates[0]
            if duration > 0:
                best = min(candidates, key=lambda c: abs(c["duration"] - duration))
                if abs(best["duration"] - duration) <= max(15.0, duration * 0.15):
                    return best
            return candidates[0]

        return None


_lib_index = _LibraryLookupIndex()


@router.post("/duplicates/scan")
async def scan_duplicates(background_tasks: BackgroundTasks):
    def scan_task():
        db_local = SessionLocal()
        try:
            compute_all_phashes(db_local)
            duplicates = find_duplicates(db_local, threshold=5)
            logging.info(f"Found {len(duplicates)} potential duplicates")
        finally:
            db_local.close()

    background_tasks.add_task(scan_task)
    return {"status": "scanning", "message": "Duplicate scan started in background"}


@router.get("/duplicates")
def get_duplicates(db: Session = Depends(get_db)):
    duplicates = find_duplicates(db, threshold=5)
    return {"duplicates": duplicates, "count": len(duplicates)}


@router.post("/duplicates/mark")
def mark_duplicate(body: MarkDuplicateBody, db: Session = Depends(get_db)):
    success = mark_as_duplicate(db, body.duplicate_id, body.original_id)
    return {"success": success}


@router.post("/videos/exists")
def videos_exist(body: UrlExistsBody, db: Session = Depends(get_db)):
    urls = [str(url).strip() for url in (body.urls or []) if str(url).strip()]
    if not urls:
        return {"existing": [], "count": 0}

    rows = db.query(Video.url, Video.source_url).filter(
        or_(Video.url.in_(urls), Video.source_url.in_(urls))
    ).all()

    existing = set()
    requested = set(urls)
    for row in rows:
        if row.url in requested:
            existing.add(row.url)
        if row.source_url in requested:
            existing.add(row.source_url)

    return {"existing": sorted(existing), "count": len(existing)}


@router.post("/duplicates/compare-album")
def compare_album(body: AlbumCompareBody, db: Session = Depends(get_db)):
    """Porovna videa na albume s databazou v dashboarde.
    Urcuje status: 'better' (lepsia kvalita), 'worse' (horsia kvalita), 'duplicate' (duplikat), 'new' (nove).
    """
    _lib_index.rebuild_if_needed(db)

    results: List[Dict[str, Any]] = []
    better_count = 0
    worse_count = 0
    duplicate_count = 0
    new_count = 0

    seen_album_keys: Dict[str, Dict[str, Any]] = {}

    for item in body.items:
        url = item.url.strip()
        matched = _lib_index.lookup(url, item.title, item.duration)
        bunkr_height = int(item.height or 0)
        bunkr_size_mb = round(item.size_bytes / (1024 * 1024), 2) if item.size_bytes else 0.0
        bunkr_duration = float(item.duration or 0)

        status = "new"
        reason = "Nové video (nenájdené v knižnici)"
        needs_probe = False

        if matched:
            db_height = int(matched.get("height") or 0)
            db_size_mb = float(matched.get("file_size_mb") or 0.0)
            db_duration = float(matched.get("duration") or 0.0)
            matched_title = matched.get("title") or ""

            # 1. Porovnanie podla rozlisenia (height)
            if bunkr_height > 0 and db_height > 0:
                if bunkr_height > db_height:
                    status = "better"
                    better_count += 1
                    reason = f"★ Lepšia kvalita: {bunkr_height}p vs v knižnici {db_height}p"
                elif bunkr_height < db_height:
                    status = "worse"
                    worse_count += 1
                    reason = f"Horšia kvalita: {bunkr_height}p vs v knižnici {db_height}p"
                else:
                    # Rovnake rozlisenie -> porovname velkost (bitrate)
                    if bunkr_size_mb > 0 and db_size_mb > 0:
                        if bunkr_size_mb >= db_size_mb * 1.15:
                            status = "better"
                            better_count += 1
                            reason = f"★ Lepšia kvalita: {bunkr_size_mb:.1f} MB vs {db_size_mb:.1f} MB (rovnaké {bunkr_height}p, vyšší bitrate)"
                        elif bunkr_size_mb <= db_size_mb * 0.85:
                            status = "worse"
                            worse_count += 1
                            reason = f"Horšia kvalita: {bunkr_size_mb:.1f} MB vs {db_size_mb:.1f} MB (rovnaké {bunkr_height}p, nižší bitrate)"
                        else:
                            status = "duplicate"
                            duplicate_count += 1
                            reason = f"Duplikát: {bunkr_height}p ({bunkr_size_mb:.1f} MB v knižnici)"
                    else:
                        status = "duplicate"
                        duplicate_count += 1
                        reason = f"Duplikát: rovnaké rozlíšenie {bunkr_height}p"

            # 2. Ak Bunkr nema zistenu vysku (nebol fetch), rozhoduje velkost (vacsinou velkost povie o kvalite)
            elif bunkr_size_mb > 0 and db_size_mb > 0:
                needs_probe = True
                if bunkr_size_mb >= db_size_mb * 1.25:
                    status = "better"
                    better_count += 1
                    reason = f"★ Lepšia kvalita (veľkosť): {bunkr_size_mb:.1f} MB vs {db_size_mb:.1f} MB"
                elif bunkr_size_mb <= db_size_mb * 0.75:
                    status = "worse"
                    worse_count += 1
                    reason = f"Horšia kvalita (veľkosť): {bunkr_size_mb:.1f} MB vs {db_size_mb:.1f} MB"
                else:
                    status = "duplicate"
                    duplicate_count += 1
                    reason = f"Duplikát: podobná veľkosť ({bunkr_size_mb:.1f} MB)"

            else:
                # Zhoda len podla URL / nazvu, bez velkosti
                status = "duplicate"
                duplicate_count += 1
                needs_probe = True
                reason = "Duplikát: video je už v knižnici"

        else:
            # Kontrola intra-album duplicit (rovnake video viackrat v albume)
            name_key = _LibraryLookupIndex.clean_name_key(item.title, url)
            if name_key:
                if name_key in seen_album_keys:
                    prev = seen_album_keys[name_key]
                    prev_size = prev.get("size_bytes") or 0
                    prev_height = prev.get("height") or 0
                    if (bunkr_height and bunkr_height > prev_height) or (bunkr_size_mb and item.size_bytes > prev_size * 1.15):
                        status = "better"
                        better_count += 1
                        reason = "★ Lepšia kvalita v rámci albumu"
                    else:
                        status = "worse"
                        worse_count += 1
                        reason = "Duplikát v tomto albume (horšia kópia)"
                else:
                    seen_album_keys[name_key] = {"url": url, "size_bytes": item.size_bytes, "height": bunkr_height}
                    new_count += 1
            else:
                new_count += 1

        results.append({
            "url": url,
            "status": status,
            "reason": reason,
            "needs_probe": needs_probe,
            "matched_video": matched,
            "bunkr_meta": {
                "height": bunkr_height,
                "size_mb": bunkr_size_mb,
                "duration": bunkr_duration,
            },
        })

    return {
        "results": results,
        "counts": {
            "total": len(body.items),
            "better": better_count,
            "worse": worse_count,
            "duplicate": duplicate_count,
            "new": new_count,
        },
    }


@router.post("/duplicates/replace")
def replace_videos(body: ReplaceVideosBody, db: Session = Depends(get_db)):
    """Nahradi existujuce horsie videa v kniznici novymi lepsimi verziami z Bunkru."""
    replaced = []
    errors = []

    for item in body.replacements:
        video = db.query(Video).filter(Video.id == item.existing_id).first()
        if not video:
            errors.append({"existing_id": item.existing_id, "error": "Video nenájdené v DB"})
            continue

        old_meta = {
            "id": video.id,
            "title": video.title,
            "url": video.url,
            "height": video.height,
            "duration": video.duration,
            "file_size_mb": video.file_size_mb,
        }

        # Aktualizacia odkazu a kvality pri zachovani povodneho batchu, tagov a oblubenych
        video.url = item.url
        video.source_url = item.source_url or item.url
        if item.title:
            video.title = item.title
        if item.height:
            video.height = item.height
            video.quality = f"{item.height}p"
        if item.width:
            video.width = item.width
        if item.duration:
            video.duration = item.duration
        if item.file_size_mb:
            video.file_size_mb = item.file_size_mb
        if item.thumbnail:
            video.original_thumbnail_url = item.thumbnail

        video.status = "ready_to_stream"
        video.link_status = "working"
        video.last_checked = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

        replaced.append({
            "id": video.id,
            "title": video.title,
            "new_url": video.url,
            "old_meta": old_meta,
            "new_meta": {
                "height": video.height,
                "duration": video.duration,
                "file_size_mb": video.file_size_mb,
            },
        })

    db.commit()
    _lib_index.rebuild_if_needed(db, force=True)

    return {
        "success": True,
        "replaced_count": len(replaced),
        "replaced": replaced,
        "errors": errors,
    }

