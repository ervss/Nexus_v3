import logging
import os
import asyncio
import json
import time
import threading
from contextlib import asynccontextmanager
from functools import lru_cache
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import unquote, urlparse
from sqlalchemy.orm import Session
from sqlalchemy import func, or_
from app.database import Video
from app.duplicate_detector import compute_phash, hamming_distance
import re
import httpx
from bs4 import BeautifulSoup


def _video_path_from_static(static_path: str | None) -> str | None:
    if not static_path:
        return None
    if not static_path.startswith("/static/"):
        return None
    return f"app{static_path.split('?')[0]}"


def _is_mega_video(video: Video) -> bool:
    return (video.storage_type or "").lower() == "mega" or (video.url or "").strip().lower().startswith("mega:")


def _local_video_file_path(video: Video) -> str | None:
    """Return the readable filesystem path for a locally stored Video.

    Local-folder indexing stores a ``file:///`` URL; uploaded videos use a
    ``/static/local_videos/...`` URL.  FFmpeg needs a filesystem path for both,
    not either of those browser-facing URL forms.
    """
    raw = (video.url or "").strip()
    if not raw:
        return None
    if raw.startswith("/static/"):
        candidate = _video_path_from_static(raw)
    elif raw.lower().startswith("file:"):
        parsed = urlparse(raw)
        candidate = unquote(parsed.path)
        # file:///C:/... becomes /C:/... after urlparse on Windows.
        if os.name == "nt" and re.match(r"^/[A-Za-z]:/", candidate):
            candidate = candidate[1:]
    else:
        return None
    return candidate if candidate and os.path.isfile(candidate) else None


def _video_has_usable_thumbnail(video: Video) -> bool:
    thumb = (video.thumbnail_path or "").strip()
    if not thumb:
        return False
    if thumb.startswith("data:"):
        return True
    if thumb.startswith(("http://", "https://")):
        return False
    thumb_path = _video_path_from_static(thumb)
    return bool(thumb_path and os.path.exists(thumb_path))


def delete_video_assets(video: Video) -> None:
    for asset in (video.thumbnail_path, video.gif_preview_path):
        asset_path = _video_path_from_static(asset)
        if asset_path and os.path.exists(asset_path):
            try:
                os.remove(asset_path)
            except OSError:
                pass

    preview_file = os.path.join("app", "static", "previews", f"preview_{video.id}.mp4")
    if os.path.exists(preview_file):
        try:
            os.remove(preview_file)
        except OSError:
            pass

def get_duplicates_by_name(db: Session):
    """Find videos with the same title"""
    # Group by title and count
    duplicates = db.query(
        Video.title, 
        func.count(Video.id).label('count')
    ).group_by(Video.title).having(func.count(Video.id) > 1).all()
    
    results = []
    for dup in duplicates:
        videos = db.query(Video).filter(Video.title == dup.title).all()
        results.append({
            "title": dup.title,
            "count": dup.count,
            "videos": [
                {
                    "id": v.id,
                    "height": v.height,
                    "width": v.width,
                    "duration": v.duration,
                    "status": v.status,
                    "batch": v.batch_name
                } for v in videos
            ]
        })
    return results

def get_duplicates_by_hash(db: Session, threshold: int = 5):
    """Find videos with similar phashes"""
    videos = db.query(Video).filter(Video.phash.isnot(None)).all()
    groups = []
    seen = set()
    
    for i, v1 in enumerate(videos):
        if v1.id in seen:
            continue
            
        group = [v1]
        for v2 in videos[i+1:]:
            if v2.id in seen:
                continue
            
            distance = hamming_distance(v1.phash, v2.phash)
            if distance <= threshold:
                group.append(v2)
                seen.add(v2.id)
        
        if len(group) > 1:
            groups.append({
                "representative": v1.title,
                "count": len(group),
                "videos": [
                    {
                        "id": v.id,
                        "title": v.title,
                        "height": v.height,
                        "width": v.width,
                        "duration": v.duration,
                        "status": v.status,
                        "batch": v.batch_name
                    } for v in group
                ]
            })
            seen.add(v1.id)
            
    return groups

def auto_resolve_duplicates(db: Session, type: str = "name"):
    """
    Automatically resolve duplicates by keeping the best quality one.
    Best quality = highest (height * width), then longest duration.
    """
    if type == "name":
        groups = get_duplicates_by_name(db)
    else:
        groups = get_duplicates_by_hash(db)
        
    resolved_count = 0
    deleted_count = 0
    
    for group in groups:
        videos = group['videos']
        # Sort by quality: resolution DESC, duration DESC
        videos.sort(key=lambda x: (x['height'] * x['width'], x['duration']), reverse=True)
        
        # Keep the first one, delete the rest
        to_keep = videos[0]
        to_delete = videos[1:]
        
        for v_meta in to_delete:
            v = db.query(Video).get(v_meta['id'])
            if v:
                # Delete thumbnail
                delete_video_assets(v)
                
                db.delete(v)
                deleted_count += 1
        
        resolved_count += 1
        
    db.commit()
    res = {"resolved_groups": resolved_count, "deleted_videos": deleted_count}
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"Auto-resolved {resolved_count} {type} duplicate groups. Deleted {deleted_count} videos.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    return res

def cleanup_broken_links(db: Session, delete_permanently: bool = False):
    """Remove or mark videos that are broken and cannot be refreshed"""
    broken = db.query(Video).filter(Video.link_status == "broken").all()
    count = 0
    
    for v in broken:
        # If it has no source_url, it can't be refreshed
        if not v.source_url or delete_permanently:
            delete_video_assets(v)
            db.delete(v)
            count += 1
            
    db.commit()
    res = {"deleted": count}
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"Cleanup complete. Removed {count} broken links.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    return res

def normalize_all_titles(db: Session):
    """Remove common junk from titles"""
    videos = db.query(Video).all()
    count = 0
    
    # Common patterns to remove
    patterns = [
        r"\[.*?\]",           # [text]
        r"\(.*?\)",           # (text)
        r"www\..*?\.(com|net|org|tv)", # www.site.com
        r"\.(mp4|mkv|avi|webm|mov)$", # extensions
        r"^\d+\s*-\s*",       # 123 - title
        r"^\s*-\s*",          # - title
        r"\s+$",              # trailing space
        r"^\s+",              # leading space
    ]
    
    for v in videos:
        original = v.title
        new_title = original
        for p in patterns:
            new_title = re.sub(p, "", new_title, flags=re.IGNORECASE).strip()
        
        if new_title != original and new_title:
            v.title = new_title
            count += 1
            
    db.commit()
    res = {"updated": count}
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"Title normalization complete. Updated {count} videos.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    return res

async def fix_broken_thumbnails(db: Session):
    """Find videos with missing thumbnails and re-trigger processing"""
    from app.services import VIPVideoProcessor
    videos = db.query(Video).filter(
        or_(
            Video.thumbnail_path.is_(None),
            Video.thumbnail_path == "",
            Video.preview_retry_needed == True,
            Video.thumbnail_path.like("http%"),
        )
    ).all()

    p_ids = [v.id for v in videos if not _video_has_usable_thumbnail(v) or bool(v.preview_retry_needed)]
    if p_ids:
        processor = VIPVideoProcessor()
        await processor.process_batch(p_ids)
    
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"Thumbnail repair session finished for {len(p_ids)} videos.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    return {"retriggered": len(p_ids)}


async def retry_flagged_previews(db: Session):
    """
    Run one final thumbnail/preview regeneration pass for imports marked after
    a failed visual generation. Items that still have no usable thumbnail after
    this retry are deleted for a cleaner gallery.
    """
    from app.services import VIPVideoProcessor

    processor = VIPVideoProcessor()
    candidates = (
        db.query(Video)
        .filter(Video.preview_retry_needed == True)
        .order_by(Video.id.asc())
        .all()
    )

    results = {"retried": 0, "recovered": 0, "deleted": 0, "failed": 0}

    for video in candidates:
        video.preview_retry_count = max(int(video.preview_retry_count or 0), 1)
        db.commit()
        results["retried"] += 1

        try:
            await processor.process_single_video(video.id, force=True, extractor="auto")
        except Exception as exc:
            logging.warning("Second-pass preview regeneration crashed for %s: %s", video.id, exc)

        db.expire_all()
        refreshed = db.query(Video).get(video.id)
        if not refreshed:
            continue

        if _video_has_usable_thumbnail(refreshed):
            refreshed.preview_retry_needed = False
            refreshed.preview_retry_count = 0
            refreshed.preview_last_error = None
            db.commit()
            results["recovered"] += 1
            continue

        refreshed.preview_retry_needed = True
        refreshed.preview_last_error = refreshed.preview_last_error or "Preview retry failed"
        delete_video_assets(refreshed)
        db.delete(refreshed)
        db.commit()
        results["deleted"] += 1
        results["failed"] += 1

    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({
            "type": "log",
            "message": (
                f"Preview second-pass finished. Retried {results['retried']}, "
                f"recovered {results['recovered']}, deleted {results['deleted']}."
            ),
            "level": "success",
        })
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except:
        pass

    return results

def sync_video_durations(db: Session):
    """Update durations for videos that have 0 or null"""
    from app.services import VIPVideoProcessor
    from sqlalchemy import or_
    videos = db.query(Video).filter(or_(Video.duration == 0, Video.duration.is_(None))).all()
    count = 0
    
    processor = VIPVideoProcessor()
    for v in videos:
        # Use ffprobe to get duration if possible
        try:
            referer = v.source_url or v.url
            # Camwhores videos need full re-extraction (rnd= expires, plugin must re-run)
            is_camwhores = "camwhores.tv" in (v.url or "").lower() or "camwhores.tv" in (v.source_url or "").lower()
            if is_camwhores:
                asyncio.run(processor.process_single_video(v.id, force=True, extractor="auto"))
                db.expire_all()
                refreshed = db.query(Video).get(v.id)
                if refreshed and (refreshed.duration or 0) > 0:
                    count += 1
                continue
            meta = asyncio.run(processor._ffprobe_fallback(v.url, {}, referer=referer))
            if meta.get('duration'):
                v.duration = meta['duration']
                if meta.get('height') and not v.height:
                    v.height = meta['height']
                if meta.get('width') and not v.width:
                    v.width = meta['width']
                count += 1
                continue
            # File-host imports often keep a resolvable source page even when the current
            # stream URL is weak on metadata. Re-run the normal resolver as a fallback.
            if v.source_url and any(host in (v.source_url or "").lower() for host in ("filester.", "bunkr", "pixeldrain.com", "gofile.io")):
                asyncio.run(processor.process_single_video(v.id, force=True, extractor="auto"))
                db.expire_all()
                refreshed = db.query(Video).get(v.id)
                if refreshed and (refreshed.duration or 0) > 0:
                    count += 1
        except:
            pass
            
    db.commit()
    return {"updated": count}

def scan_and_extract_file_sizes(db: Session):
    """Scan all videos and extract their file size if missing"""
    import requests
    videos = db.query(Video).all()
    updated_count = 0
    
    for v in videos:
        # Logic to check if we already have it
        stats = v.download_stats or {}
        if stats.get('size_mb'):
            continue
            
        size_mb = 0
        if v.storage_type == "local":
            # Extract from /static/ URL format
            path_part = v.url.replace('/static/', '', 1).lstrip('/')
            local_path = os.path.join("app", "static", path_part)
            if os.path.exists(local_path):
                size_mb = round(os.path.getsize(local_path) / (1024 * 1024), 2)
        elif v.url and v.url.startswith('http'):
            # Remote file - try HEAD request or HLS estimation
            try:
                headers = {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                }
                if v.source_url:
                    headers['Referer'] = v.source_url
                
                is_hls = ".m3u8" in v.url.lower() or "hls" in v.url.lower()
                if is_hls:
                    # HLS size resolution / estimation
                    duration = float(v.duration or 0)
                    height = int(v.height or 0)
                    if duration > 0:
                        bandwidth = 0
                        try:
                            resp = requests.get(v.url, headers=headers, timeout=5)
                            if resp.status_code == 200:
                                lines = resp.text.split('\n')
                                best_bw = 0
                                for line in lines:
                                    if "#EXT-X-STREAM-INF" in line:
                                        m_bw = re.search(r'BANDWIDTH=(\d+)', line)
                                        m_res = re.search(r'RESOLUTION=\d+x(\d+)', line)
                                        if m_bw:
                                            bw = int(m_bw.group(1))
                                            res_h = int(m_res.group(1)) if m_res else 0
                                            if res_h == height:
                                                bandwidth = bw
                                                break
                                            elif bw > best_bw:
                                                best_bw = bw
                                if not bandwidth and best_bw:
                                    bandwidth = best_bw
                        except:
                            pass
                        
                        if bandwidth > 0:
                            size_mb = round((bandwidth * duration) / (8 * 1024 * 1024), 2)
                        elif height > 0:
                            if height >= 2160: bitrate = 12000000
                            elif height >= 1080: bitrate = 3500000
                            elif height >= 720: bitrate = 1800000
                            elif height >= 480: bitrate = 800000
                            else: bitrate = 400000
                            size_mb = round((bitrate * duration) / (8 * 1024 * 1024), 2)
                        else:
                            size_mb = round((800000 * duration) / (8 * 1024 * 1024), 2)
                else:
                    # We use stream=True for requests.get if HEAD is blocked, but let's try HEAD first
                    resp = requests.head(v.url, headers=headers, timeout=5, allow_redirects=True)
                    if resp.status_code == 200:
                        content_length = int(resp.headers.get('Content-Length', 0))
                        if content_length > 0:
                            size_mb = round(content_length / (1024 * 1024), 2)
                    elif resp.status_code == 405 or resp.status_code == 403:
                        # Retry with GET and closing immediately if HEAD failed
                        with requests.get(v.url, headers=headers, timeout=5, stream=True) as r:
                             content_length = int(r.headers.get('Content-Length', 0))
                             if content_length > 0:
                                 size_mb = round(content_length / (1024 * 1024), 2)
            except:
                pass
                
        if size_mb > 0:
            stats['size_mb'] = size_mb
            v.download_stats = stats
            # Force SQLAlchemy to see the update for JSON column
            from sqlalchemy.orm.attributes import flag_modified
            flag_modified(v, "download_stats")
            updated_count += 1
            
    db.commit()
    res = {"updated_sizes": updated_count}
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"File size scan complete. Updated {updated_count} videos.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    return res

async def refresh_poor_metadata(db: Session):
    """Find videos with zero duration, low resolution or missing thumbnails and re-extract data"""
    from app.services import VIPVideoProcessor
    from app.websockets import manager
    import json
    import asyncio

    # Identify videos with poor metadata
    # Criteria: duration <= 1 (usually 0 or placeholder), height <= 0 (missing resolution), or missing thumbnail
    videos = db.query(Video).filter(
        or_(
            Video.duration <= 1,
            Video.height <= 0,
            Video.thumbnail_path.is_(None),
            Video.thumbnail_path == ""
        )
    ).all()

    video_ids = [v.id for v in videos]
    count = len(video_ids)

    if video_ids:
        # Utilize the high-performance processor
        processor = VIPVideoProcessor()

        # We use force=True to ensure it re-extracts everything
        max_workers = 4
        semaphore = asyncio.Semaphore(max_workers)

        async def process_with_limit(vid):
            async with semaphore:
                await processor.process_single_video(vid, force=True)

        tasks = [process_with_limit(vid) for vid in video_ids]
        await asyncio.gather(*tasks, return_exceptions=True)
    
    from app.websockets import manager
    import json
    import asyncio
    try:
        loop = asyncio.get_event_loop()
        msg = json.dumps({"type": "log", "message": f"Metadata refresh complete. Re-processed {count} videos.", "level": "success"})
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except: pass
    
    return {"refreshed": count}


def _merge_csv_tags(existing: str | None, additions: list[str], max_items: int = 120) -> str:
    seen = set()
    merged: list[str] = []
    for raw in ((existing or "").split(",") + additions):
        t = re.sub(r"\s+", " ", (raw or "").strip())
        if not t:
            continue
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(t)
        if len(merged) >= max_items:
            break
    return ",".join(merged)


def _clean_tokens(values: list[str], max_len: int = 50) -> list[str]:
    out: list[str] = []
    seen = set()
    for raw in values:
        t = re.sub(r"\s+", " ", (raw or "").strip())
        if len(t) < 2:
            continue
        if len(t) > max_len:
            t = t[:max_len].strip()
        key = t.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(t)
    return out


async def _fetch_taxonomy_from_source(source_url: str, timeout_sec: int = 20) -> dict:
    if not source_url:
        return {"tags": [], "categories": [], "performers": []}

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Referer": source_url,
    }
    tags: list[str] = []
    categories: list[str] = []
    performers: list[str] = []
    host = (urlparse(source_url).netloc or "").lower()
    blocked_hosts = (
        "filester",
        "pixeldrain.com",
        "bunkr",
        "gofile.io",
        "turbo.",
        "fileditch",
        "wsfiles.cz",
        "webshare.",
    )
    if any(x in host for x in blocked_hosts):
        return {"tags": [], "categories": [], "performers": []}

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout_sec) as client:
            resp = await client.get(source_url, headers=headers)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            for meta in soup.select('meta[name="keywords"], meta[property="video:tag"], meta[property="article:tag"]'):
                content = (meta.get("content") or "").strip()
                if content:
                    tags.extend([p.strip() for p in content.split(",") if p.strip()])

            if "whoreshub" in host:
                for el in soup.select(".single_tags a, .post-tags a, .video-tags a, .tags a"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        tags.append(txt)
                for el in soup.select(".single_categories a, .post-categories a, .categories a"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        categories.append(txt)
                for el in soup.select(".author a, .profile a, a[href*='/model/'], a[href*='/pornstar/']"):
                    txt = el.get_text(" ", strip=True)
                    if txt and not any(k in txt.lower() for k in ("share", "report", "download")):
                        performers.append(txt)

            if "eporner.com" in host:
                for el in soup.select("a[href*='/cat/'], a[href*='/categories/']"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        categories.append(txt)
                for el in soup.select("a[href*='/pornstar/'], a[href*='/pornstars/'], a[href*='/model/']"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        performers.append(txt)
                for el in soup.select("a[href*='/keyword/'], a[href*='/search/'], .vtag a, .video-tags a, .tags a"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        tags.append(txt)

            if not tags:
                for el in soup.select("a[rel='tag'], .tag a, .tags a"):
                    txt = el.get_text(" ", strip=True)
                    if txt:
                        tags.append(txt)
    except Exception as exc:
        logging.warning("taxonomy scrape failed for %s: %s", source_url, exc)

    return {
        "tags": _clean_tokens(tags, max_len=40),
        "categories": _clean_tokens(categories, max_len=40),
        "performers": _clean_tokens(performers, max_len=50),
    }


async def enrich_video_tags(db: Session, video: Video, overwrite: bool = False) -> dict:
    if not video:
        return {"updated": False, "reason": "missing_video"}

    payload = await _fetch_taxonomy_from_source(video.source_url) if video.source_url else {}
    src_tags = payload.get("tags", [])
    src_categories = payload.get("categories", [])
    src_performers = payload.get("performers", [])

    # If the source page has weak/no taxonomy, enrich from NLP (title + batch_name + URL) and local GPU embedding.
    if not (src_tags or src_categories or src_performers):
        try:
            from app.ai_tagger_batch import classify_embedding_zero_shot, extract_nlp_tags_and_models
            from app.database import VideoEmbedding
            import numpy as _np

            nlp_payload = extract_nlp_tags_and_models(
                title=video.title or "",
                batch_name=getattr(video, "batch_name", "") or "",
                source_url=video.source_url or video.url or "",
                existing_models=getattr(video, "models", "") or "",
                existing_categories=getattr(video, "categories", "") or "",
            )
            src_tags.extend(nlp_payload.get("tags") or [])
            src_performers.extend(nlp_payload.get("performers") or [])

            emb_row = db.query(VideoEmbedding).filter(VideoEmbedding.video_id == int(video.id)).first()
            if emb_row and emb_row.image_vec and len(emb_row.image_vec) >= 512:
                ivec = _np.frombuffer(emb_row.image_vec, dtype=_np.float16).astype(_np.float32)
                vis_payload = classify_embedding_zero_shot(ivec, video_id=int(video.id))
                src_tags.extend(vis_payload.get("tags") or [])
                if vis_payload.get("model_guess") and not src_performers:
                    src_performers.append(vis_payload["model_guess"])
        except Exception:
            pass

        title_words = set(re.findall(r"\b(pov|bbc|interracial|milf|anal|blowjob|creampie|cumshot|amateur|lesbian|threesome|busty|asian|latina|ebony|vr|onlyfans|hardcore)\b", (video.title or "").lower()))
        src_tags.extend(sorted(title_words))

    combined_plain = src_tags + src_categories + src_performers
    combined_prefixed = (
        [f"cat:{x}" for x in src_categories]
        + [f"actor:{x}" for x in src_performers]
        + [f"tag:{x}" for x in src_tags]
    )

    if not combined_plain:
        return {"updated": False, "reason": "no_taxonomy_found"}

    if overwrite:
        video.tags = ",".join(_clean_tokens(combined_plain))
        video.ai_tags = ",".join(_clean_tokens(combined_prefixed, max_len=70))
    else:
        video.tags = _merge_csv_tags(video.tags, combined_plain)
        video.ai_tags = _merge_csv_tags(video.ai_tags, combined_prefixed)

    db.commit()
    return {"updated": True, "video_id": video.id}


async def enrich_tags_for_selection(
    db: Session,
    video_ids: list[int] | None = None,
    batch_name: str | None = None,
    only_missing: bool = True,
    limit: int = 250,
    overwrite: bool = False,
) -> dict:
    query = db.query(Video).filter(Video.source_url.isnot(None), Video.source_url != "")
    if video_ids:
        query = query.filter(Video.id.in_(video_ids))
    if batch_name and batch_name != "All":
        query = query.filter(Video.batch_name == batch_name)
    if only_missing:
        query = query.filter(or_(Video.tags.is_(None), Video.tags == "", Video.ai_tags.is_(None), Video.ai_tags == ""))

    items = query.order_by(Video.id.desc()).limit(max(1, min(limit, 2000))).all()
    stats = {"scanned": len(items), "updated": 0, "skipped": 0, "failed": 0}

    for v in items:
        try:
            res = await enrich_video_tags(db, v, overwrite=overwrite)
            if res.get("updated"):
                stats["updated"] += 1
            else:
                stats["skipped"] += 1
        except Exception as exc:
            stats["failed"] += 1
            logging.warning("enrich_tags failed for video_id=%s: %s", v.id, exc)

    try:
        from app.websockets import manager
        loop = asyncio.get_event_loop()
        msg = json.dumps({
            "type": "log",
            "level": "success",
            "message": (
                f"Tag enrichment done. scanned={stats['scanned']} updated={stats['updated']} "
                f"skipped={stats['skipped']} failed={stats['failed']}"
            ),
        })
        if loop.is_running():
            asyncio.run_coroutine_threadsafe(manager.broadcast(msg), loop)
    except Exception:
        pass

    return stats


# ---------------------------------------------------------------------------
# Smart Thumbnail Worker
# ---------------------------------------------------------------------------

from app import fast_thumb  # noqa: E402  (rýchla Range cesta + SQLite stav úloh)

_SMART_THUMB_RUNNING = False
_SMART_THUMB_MIN_FILE_BYTES = 10_000   # thumbs < 10 KB are considered poor quality
_SMART_THUMB_CONCURRENCY = 32   # štart; WorkerLimiter škáluje dynamicky (NEXUS_THUMB_WORKERS / _MAX)


@lru_cache(maxsize=4096)
def _thumbnail_image_info(path: str, modified_ns: int, byte_size: int):
    """Inspect each file revision once; card refreshes reuse the result."""
    from PIL import Image
    with Image.open(path) as image:
        width, height = image.size
        image.verify()
    return width, height, _image_score(path)


def _candidate_thumb_score(path: str) -> float:
    """Accept only images that also meet the gallery's OK quality threshold."""
    try:
        stat = os.stat(path)
        width, height, score = _thumbnail_image_info(path, stat.st_mtime_ns, stat.st_size)
        short, long = sorted((width, height))
        return score if score > 0 and long >= 480 and short >= 270 else 0.0
    except (OSError, ValueError, SyntaxError):
        return 0.0


def thumbnail_quality(video: Video) -> dict:
    """Return a conservative quality assessment for a card thumbnail.

    This assesses the preview image, rather than the source video's resolution:
    a 4K source can still have a tiny provider poster.  Remote posters are kept
    as ``unknown`` so the UI never claims a preview is good without inspecting it.
    """
    thumb = (video.thumbnail_path or "").split("?", 1)[0].strip()
    base = {"status": "unknown", "label": "NEOVERENÉ", "reason": "Náhľad sa nedá lokálne overiť"}
    if not thumb or "placeholder" in thumb.lower():
        return {"status": "poor", "label": "CHÝBA", "reason": "Chýba platný náhľad"}
    if thumb.startswith(("http://", "https://", "data:")):
        return base

    if "/telegram/thumb/" in thumb:
        match = re.search(r"/telegram/thumb/(-?\d+)/(\d+)", thumb)
        if match:
            tg_file = os.path.join("data", "telegram_thumbs", f"{match.group(1)}_{match.group(2)}.jpg")
            if os.path.isfile(tg_file):
                path = tg_file
            else:
                return {"status": "ok", "label": "TG", "reason": "Telegram náhľad (streamovaný cez Telethon)"}
        else:
            return {"status": "ok", "label": "TG", "reason": "Telegram náhľad"}
    else:
        path = _video_path_from_static(thumb)
        if not path or not os.path.isfile(path):
            return {"status": "poor", "label": "CHÝBA", "reason": "Lokálny súbor náhľadu sa nenašiel"}
    try:
        stat = os.stat(path)
        byte_size = stat.st_size
        width, height, score = _thumbnail_image_info(path, stat.st_mtime_ns, byte_size)
    except Exception:
        return {"status": "poor", "label": "CHYBNÝ", "reason": "Náhľad nie je čitateľný obrázok"}

    details = f"{width}×{height} · {max(1, round(byte_size / 1024))} KB"
    if score <= 0:
        return {"status": "poor", "label": "SLABÝ", "reason": f"Prázdny, tmavý alebo nečitateľný náhľad ({details})"}
    is_tg = "/telegram/thumb/" in thumb or str(getattr(video, "storage_type", "")).lower() == "telegram"
    if is_tg:
        return {"status": "ok", "label": "TG", "reason": f"Telegram originálny náhľad ({details})"}
    short, long = sorted((width, height))
    if long < 480 or short < 270:
        return {"status": "poor", "label": "SLABÝ", "reason": f"Príliš malý alebo komprimovaný náhľad ({details})"}
    if long >= 960 and short >= 540:
        return {"status": "high", "label": "HQ", "reason": f"Veľký náhľad ({details})"}
    return {"status": "ok", "label": "OK", "reason": f"Použiteľný náhľad ({details})"}

# Last ffmpeg/stderr excerpt per video — lets the report explain WHY a rethumb
# failed instead of a bare "failed" counter. Cleared at the start of each attempt.
_THUMB_FAIL_DETAIL: dict[int, str] = {}
_THUMB_KEEP_EXISTING: set[int] = set()
_THUMB_HOST_RETRY_AT: dict[str, float] = {}

# In-memory summary of the most recent run (library scan or batch/selection),
# served by /maintenance/smart-rethumb/report for the maintenance panel.
_LAST_RETHUMB_REPORT: Optional[dict] = None

# Rate-limit handling for token-signed CDNs (Bunkr cdn.cr / scdn.st especially).
# A burst of concurrent range requests earns a 429 that ffmpeg surfaces as a
# generic "4XX Client Error"; without a retry the whole batch looks permanently
# dead. Bunkr also throttles hard, so it gets a much smaller lane than the rest.
_BUNKR_THUMB_CONCURRENCY = 2
_SMART_THUMB_PROGRESS: dict = {}
_BUNKR_ALBUM_LISTINGS: dict = {}
_SMART_THUMB_PENDING = False
_SMART_THUMB_START_LOCK = threading.Lock()
_SMART_THUMB_STOP = threading.Event()
_SMART_THUMB_AUTO_PAUSED = False


def _rethumb_queue(videos):
    fast_thumb.get_store().enqueue([v.id for v in videos])
    fast_thumb.METRICS.reset()
    _SMART_THUMB_PROGRESS.update(
        started_epoch=time.time(), finished_epoch=None, active=[],
        queued=[{"id": v.id, "title": (v.title or "")[:120]} for v in videos],
        recent=[], improved=0,
    )


def _rethumb_started(video):
    progress = _SMART_THUMB_PROGRESS
    progress["started_count"] = progress.get("started_count", 0) + 1
    fast_thumb.get_store().mark(video.id, "running")
    progress["queued"] = [v for v in progress.get("queued", []) if v["id"] != video.id]
    progress.setdefault("active", []).append({
        "id": video.id, "title": (video.title or "")[:120],
        "started_epoch": time.time(), "stage": "Načítavam stream a vyberám snímku",
    })


def _rethumb_finished(video, stats, outcome=None):
    progress = _SMART_THUMB_PROGRESS
    active = next((v for v in progress.get("active", []) if v["id"] == video.id), {})
    progress["active"] = [v for v in progress.get("active", []) if v["id"] != video.id]
    failed = outcome == "failed" if outcome else stats["failed"] > progress.get("failed", 0)
    deferred = failed and _is_rate_limited(_THUMB_FAIL_DETAIL.get(video.id, ""))
    if deferred:
        outcome = "deferred"
        progress["deferred"] = progress.get("deferred", 0) + 1
    progress["recent"] = ([{
        "id": video.id, "title": (video.title or "")[:120],
        "seconds": round(time.time() - active.get("started_epoch", time.time()), 1),
        "status": outcome or ("failed" if failed else "finished"),
        "reason": _THUMB_FAIL_DETAIL.get(video.id, "Náhľad sa nepodarilo vytvoriť") if failed else "",
    }] + progress.get("recent", []))[:8]
    progress.update(improved=stats["improved"], failed=stats["failed"], skipped=stats.get("skipped", 0),
                    done=stats["improved"] + stats["failed"] + stats.get("skipped", 0))
    if deferred:
        delay = max(600, _THUMB_HOST_RETRY_AT.get(urlparse(video.url or '').netloc.lower(), 0) - time.monotonic())
        fast_thumb.get_store().defer(video.id, _THUMB_FAIL_DETAIL.get(video.id), delay=delay)
    else:
        fast_thumb.get_store().mark(video.id, "failed" if failed else "done",
                                    _THUMB_FAIL_DETAIL.get(video.id) if failed else None)


def _rethumb_snapshot():
    progress = dict(_SMART_THUMB_PROGRESS)
    now = time.time()
    started = progress.get("started_epoch")
    elapsed = max(0, (progress.get("finished_epoch") or now) - started) if started else 0
    done = progress.get("done", 0)
    remaining = max(0, progress.get("total", 0) - done)
    progress.update(elapsed_seconds=round(elapsed),
                    eta_seconds=round(elapsed / done * remaining) if done and remaining else None,
                    queued_count=len(progress.get("queued", [])))
    progress["queued"] = progress.get("queued", [])[:5]
    net = progress["net"] = fast_thumb.metrics_snapshot()
    if progress.get("running") and net["requests"]:
        progress["message"] = (f"{progress.get('message') or 'Prebieha'} · ⚡ {net['speed_mb_s']} MB/s "
                               f"({net['speed_mbps']} Mbit/s) · {net['active_connections']} spojení · "
                               f"{net['active_videos']} videí naraz")
    progress["active"] = [dict(v, elapsed_seconds=round(now - v["started_epoch"]))
                          for v in progress.get("active", [])]
    return progress


def reserve_smart_rethumb() -> bool:
    global _SMART_THUMB_PENDING
    with _SMART_THUMB_START_LOCK:
        if _SMART_THUMB_RUNNING or _SMART_THUMB_PENDING:
            return False
        _SMART_THUMB_STOP.clear()
        _SMART_THUMB_PENDING = True
        return True


def stop_smart_rethumb() -> bool:
    """Pause automatic runs and request cancellation of the current run."""
    global _SMART_THUMB_AUTO_PAUSED
    with _SMART_THUMB_START_LOCK:
        _SMART_THUMB_AUTO_PAUSED = True
        if not (_SMART_THUMB_RUNNING or _SMART_THUMB_PENDING):
            return False
        _SMART_THUMB_STOP.set()
        _SMART_THUMB_PROGRESS.update(stopping=True, message="Zastavujem rozpracované videá…")
        return True


async def _generate_rethumb_or_stop(video, thumb_dir, **kwargs):
    """Cancel the active extraction as well as waiting work on stop."""
    task = asyncio.create_task(_generate_thumb_from_stream(video, thumb_dir, **kwargs))
    try:
        while not task.done():
            if _SMART_THUMB_STOP.is_set():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                return None
            await asyncio.wait({task}, timeout=0.2)
        return await task
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _finish_rethumb_stop():
    if not _SMART_THUMB_STOP.is_set():
        return False
    for item in _SMART_THUMB_PROGRESS.get("queued", []) + _SMART_THUMB_PROGRESS.get("active", []):
        fast_thumb.get_store().mark(item["id"], "cancelled")
    _SMART_THUMB_PROGRESS.update(queued=[], active=[], stopping=False, cancelled=True)
    return True


def release_smart_rethumb_reservation():
    global _SMART_THUMB_PENDING
    with _SMART_THUMB_START_LOCK:
        _SMART_THUMB_PENDING = False
_CYBERFILE_THUMB_CONCURRENCY = 16

_RATE_LIMIT_MARKERS = (
    "429",
    "Too Many Requests",
    "Server returned 5XX",
)


def _is_rate_limited(stderr: str) -> bool:
    """True when ffmpeg's failure looks like throttling rather than a dead file."""
    return (any(m.lower() in (stderr or "").lower() for m in _RATE_LIMIT_MARKERS)
            or bool(re.search(r"HTTP\s+5\d\d\b", stderr or "", re.I)))


@asynccontextmanager
async def _rethumb_gate(global_gate, host_gate):
    async with host_gate:
        if host_gate is global_gate:
            yield
        else:
            async with global_gate:
                yield


def _match_bunkr_album_item(video: Video, items: list[dict]) -> str:
    """Match identity, never album order or a non-unique display title."""
    def identities(value):
        # Directory UUIDs identify a CDN bucket shared by many unrelated files.
        filename = unquote(urlparse(value or "").path).rsplit("/", 1)[-1]
        return set(re.findall(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", filename, re.I))
    def filename_key(value):
        filename = unquote(urlparse(value or "").path).rsplit("/", 1)[-1]
        return re.sub(r"\.(?:mp4|mkv|webm|mov|m4v|jpe?g|png|webp)$", "", filename, flags=re.I)
    keys = identities(video.url) | identities(video.original_thumbnail_url)
    matches = [item for item in items if keys & (identities(item.get("thumb")) | identities(item.get("url")))]
    if not matches:
        filenames = {filename_key(value) for value in (video.url, video.original_thumbnail_url)} - {""}
        matches = [item for item in items if filenames & {filename_key(item.get("thumb")), filename_key(item.get("url"))}]
    if not matches:
        title = (video.title or "").strip().casefold()
        matches = [item for item in items if title and (item.get("title") or "").strip().casefold() == title]
    pages = {item.get("url", "") for item in matches if re.search(r"/(f|v)/", item.get("url", ""))}
    return next(iter(pages)) if len(pages) == 1 else ""


async def _thumb_http_status(url: str, headers: dict) -> int | None:
    # Stream only response headers: never download a video to classify an error.
    from app.streaming.playback_control import control
    if control.remaining(url) > 0:
        return 503
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            async with client.stream("GET", url, headers={**headers, "Range": "bytes=0-0"}) as response:
                from app.streaming.playback_control import control
                from app.ntc.bunkr_scheduler import retry_after
                control.cooldown(url, response.status_code, retry_after(response.headers) or 60)
                return response.status_code
    except httpx.HTTPError:
        return None


def _is_cyberfile_url(*urls: str) -> bool:
    return "cyberfile.me" in " ".join(u or "" for u in urls).lower()


def _is_gofile_url(*urls: str) -> bool:
    return "gofile.io" in " ".join(u or "" for u in urls).lower()


def _match_gofile_album_item(video: Video, items: list[dict]) -> dict | None:
    """Match a Video row to the exact GoFile file entry in a multi-file folder."""
    if not items:
        return None
    if len(items) == 1:
        return items[0]

    url = (video.url or "").strip()
    src = (video.source_url or "").strip()
    thumb = (video.original_thumbnail_url or video.thumbnail_path or "").strip()

    def _extract_uuids(val: str) -> set[str]:
        return {m.lower() for m in re.findall(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", val or "", re.I)}

    def _filename(val: str) -> str:
        path = unquote(urlparse(val or "").path)
        return path.rsplit("/", 1)[-1].strip().casefold() if "/" in path else ""

    target_uuids = _extract_uuids(url) | _extract_uuids(src) | _extract_uuids(thumb)
    if target_uuids:
        for item in items:
            item_uuids = (
                _extract_uuids(str(item.get("id") or ""))
                | _extract_uuids(str(item.get("stream_url") or item.get("url") or ""))
                | _extract_uuids(str(item.get("source_url") or ""))
            )
            if target_uuids & item_uuids:
                return item

    target_fname = _filename(url)
    if target_fname:
        for item in items:
            if _filename(str(item.get("stream_url") or item.get("url") or "")) == target_fname:
                return item
            if str(item.get("title") or "").strip().casefold() == target_fname:
                return item

    title_cf = (video.title or "").strip().casefold()
    if title_cf:
        for item in items:
            if str(item.get("title") or "").strip().casefold() == title_cf:
                return item

    return items[0]


def _match_erome_album_item(video: Video, items: list[dict]) -> str:
    """Resolve the same Erome CDN file from a refreshed album listing."""
    target_path = unquote(urlparse(video.url or "").path).rstrip("/").casefold()
    if target_path:
        path_matches = [
            str(item.get("stream_url") or item.get("url") or "").strip()
            for item in items
            if unquote(urlparse(str(item.get("stream_url") or item.get("url") or "")).path)
            .rstrip("/")
            .casefold() == target_path
        ]
        path_matches = [url for url in path_matches if url]
        if len(path_matches) == 1:
            return path_matches[0]
        if len(path_matches) > 1:
            return ""

    target_name = target_path.rsplit("/", 1)[-1]
    if target_name:
        filename_matches = [
            str(item.get("stream_url") or item.get("url") or "").strip()
            for item in items
            if unquote(urlparse(str(item.get("stream_url") or item.get("url") or "")).path)
            .rsplit("/", 1)[-1]
            .casefold() == target_name
        ]
        filename_matches = [url for url in filename_matches if url]
        if len(filename_matches) == 1:
            return filename_matches[0]
        if len(filename_matches) > 1:
            return ""

    if len(items) == 1:
        return str(items[0].get("stream_url") or items[0].get("url") or "").strip()
    return ""


def _is_serial_thumb_cdn(url: str) -> bool:
    """Hosts that punish concurrent range-requests (or mint single-use tokens)."""
    u = (url or "").lower()
    return any(t in u for t in ("cdn.cr", "scdn.st", "bunkr", "cyberfile.me", "gofile.io"))


def _thumb_probe_positions(duration: float, url: str,
                           seek_frac: Optional[float] = None) -> list[float]:
    """Seek times ffmpeg should try. Fragile CDNs with unknown duration get one
    early probe — parallel 8/15/30s seeks burn a single-use CyberFile token and
    sit on the HTTP request until the 40s subprocess timeout."""
    duration = float(duration or 0)
    fragile = _is_serial_thumb_cdn(url)
    if duration >= 60:
        probes = [duration * frac for frac in (0.25, 0.50, 0.75)]
    elif duration >= 20:
        probes = [duration * frac for frac in (0.20, 0.40, 0.60)]
    elif duration > 0:
        probes = [max(0.05, duration * frac) for frac in (0.20, 0.45, 0.70)]
    elif fragile:
        probes = [1.5]
    else:
        probes = [8.0, 15.0, 30.0]

    if seek_frac is not None:
        frac = min(0.95, max(0.02, float(seek_frac)))
        if duration > 0:
            want = duration * frac
        elif fragile:
            want = 1.5 + frac * 8.0
        else:
            want = 5.0 + frac * 120.0
        probes = [want] + [p for p in probes if abs(p - want) > 2.0]
    return probes


def _is_embed_page(url: str) -> bool:
    """Embed/watch pages are HTML, not media — ffmpeg can never grab a frame.

    These need the extractor to resolve a real stream first, so a rethumb should
    skip them instead of burning retries and reporting a misleading failure.
    """
    u = (url or "").lower()
    if not u:
        return True
    if re.search(r"/(e|embed)/[a-z0-9]+/?$", u):
        return True
    return u.rstrip("/").endswith((".html", ".php"))


def _rethumb_fix_options(video: Video) -> list[str]:
    """Host-aware suggestions for a video whose rethumb failed."""
    lu = ((video.url or "") + " " + (video.source_url or "")).lower()
    opts: list[str] = []
    if (video.storage_type or "").lower() in {"local", "local_direct"} or (video.url or "").startswith(("file:", "/static/")):
        opts.append("Skontroluj, že lokálny súbor je stále na pôvodnej ceste a že ho môže čítať FFmpeg")
    if any(t in lu for t in ("bunkr", "cdn.cr", "scdn.st")):
        opts.append("Spusti 'Refresh Bunkr Links' (obnoví expirovaný CDN token) a rethumb zopakuj")
    elif any(t in lu for t in ("turbo.cr", "turbocdn", "cyberdrop", "gigachad-cdn", "filester", "fileditch")):
        opts.append("Klikni R (Smart Refresh) na karte — znovu podpíše expirovaný stream")
    elif "cyberfile.me" in lu:
        opts.append("CyberFile nemá náhľady a token je jednorazový — smart rethumb musí najprv vytiahnuť čerstvý stream")
    if _is_embed_page((video.url or "").lower()):
        opts.append("URL je embed stránka — R (Smart Refresh) najprv vyrieši priamy stream")
    if not opts:
        opts.append("Klikni R (Smart Refresh) na karte, potom rethumb zopakuj")
    opts.append("Ak zdroj video zmazal, karta sa dá vyradiť cez Cleanup Broken Links")
    return opts


def _classify_rethumb_failure(video: Video) -> dict:
    """Build a human-readable (Slovak) failure record for the maintenance panel."""
    url = (video.url or "").strip()
    lu = url.lower()
    detail = _THUMB_FAIL_DETAIL.get(video.id, "")
    dl = detail.lower()
    try:
        host = urlparse(url).netloc or urlparse(video.source_url or "").netloc
    except Exception:
        host = ""

    from .telegram_service import is_telegram_library_video
    if not is_telegram_library_video(video) and not _is_mega_video(video) and not lu.startswith(("http://", "https://")) and not _local_video_file_path(video):
        reason = "Lokálny súbor sa nenašiel alebo nie je čitateľný"
    elif "dostatočným rozlíšením a kvalitou" in dl:
        reason = detail
    elif "cyberfile" in dl:
        reason = "CyberFile nevrátil čerstvý stream — ffmpeg by na HTML stránke timeoutol"
    elif _is_embed_page(lu):
        reason = "URL je embed/HTML stránka, nie priamy stream — ffmpeg z nej frame nevytiahne"
    elif "403" in dl or "401" in dl or "forbidden" in dl:
        reason = "CDN odmietol prístup (403/401) — expirovaný token alebo hotlink ochrana"
    elif "410" in dl:
        reason = "CDN odkaz už nie je dostupný (410 Gone) — obnov zdroj alebo over, či súbor nebol zmazaný"
    elif re.search(r"(?:http\s+|server returned\s+)404\b", dl):
        reason = "Súbor na CDN neexistuje (404) — zdroj ho pravdepodobne zmazal"
    elif _is_rate_limited(detail):
        reason = "Dočasná chyba CDN (429/5XX) — spracovanie je odložené"
    elif "moov atom" in dl:
        reason = "CDN nevrátil video dáta (chýba moov atom) — typicky HTML/chybová odpoveď namiesto MP4"
    elif "invalid data" in dl:
        reason = "Odpoveď nie je dekódovateľné video (Invalid data) — pravdepodobne HTML shell alebo poškodený súbor"
    elif "timed out" in dl or "timeout" in dl:
        reason = "Časový limit — CDN odpovedá príliš pomaly"
    elif detail:
        reason = f"ffmpeg zlyhal: {detail[:160]}"
    else:
        reason = "Stream nevrátil použiteľný frame (žiadny kandidát neprešiel kvalitatívnym filtrom)"

    return {
        "id": video.id,
        "title": (video.title or f"Video #{video.id}")[:120],
        "host": host,
        "reason": reason,
        "detail": detail[:300],
        "options": _rethumb_fix_options(video),
        "source_url": video.source_url or "",
    }


def _fileditch_poster_url(*url_hints) -> "str | None":
    """Derive FileDitch's hosted poster PNG from a file-page URL.

    FileDitch's `.mp4` pages now serve an anti-bot HTML shell (real link
    injected client-side by an obfuscated WASM script), so ffmpeg can't decode
    a frame. Every page embeds a poster at a predictable CDN path though:
        /<bucket>/<id>/<file>.mp4 -> thumbsditch.b-cdn.net/<bucket>/<id>/thumbs.png
    Return that URL for the first fileditch-looking hint, else None.
    Kept in sync with VIPVideoProcessor._fileditch_poster_url in services.py.
    """
    for hint in url_hints:
        try:
            p = urlparse(hint or "")
            if "fileditchfiles." not in p.netloc.lower():
                continue
            segs = [s for s in (p.path or "").split("/") if s]
            if len(segs) < 2:
                continue
            base = "/".join(segs[:-1])  # bucket/id
            return f"https://thumbsditch.b-cdn.net/{base}/thumbs.png"
        except Exception:
            continue
    return None


async def _download_poster_to_thumb(poster_url: str, thumb_out: str, storyboard: bool = False) -> bool:
    """Download a remote poster image straight to the thumbnail path.

    Returns True only when the file lands and is above the poor-quality floor.
    """
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) "
                          "Chrome/124.0.0.0 Safari/537.36",
        }
        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            r = await client.get(poster_url, headers=headers)
        if r.status_code != 200 or not r.content:
            return False
        from io import BytesIO
        from PIL import Image, ImageOps
        import tempfile
        with tempfile.TemporaryDirectory(prefix="nx_poster_", dir=os.path.dirname(thumb_out)) as directory:
            candidate = os.path.join(directory, "poster.jpg")
            with Image.open(BytesIO(r.content)) as image:
                image = ImageOps.exif_transpose(image).convert("RGB")
                if storyboard:
                    frames = []
                    for i in range(16):
                        path = os.path.join(directory, f"frame_{i}.jpg")
                        frame = image.crop((i % 4 * image.width // 4, i // 4 * image.height // 4,
                                            (i % 4 + 1) * image.width // 4, (i // 4 + 1) * image.height // 4))
                        frame.thumbnail((854, 480))
                        frame.save(path, "JPEG", quality=90)
                        frames.append((_image_score(path), path))
                    score, best = max(frames)
                    if score <= 0:
                        return False
                    os.replace(best, candidate)
                else:
                    image.thumbnail((854, 480))
                    image.save(candidate, "JPEG", quality=90)
            if _image_score(candidate) <= 0:
                return False
            os.replace(candidate, thumb_out)
        return True
    except Exception as exc:
        logging.debug("Poster download failed (%s): %s", poster_url, exc)
        return False


async def _bunkr_cover_to_thumb(video: Video, thumb_out: str) -> bool:
    """Use a verified Bunkr file page's cover before opening the video stream."""
    import html
    import tempfile
    from urllib.parse import urljoin
    from app import bunkr_cache

    page = (video.source_url or "").strip()
    host = (urlparse(page).hostname or "").lower()
    if not (host == "bunkr.cr" or host.endswith(".bunkr.cr")) or not re.search(r"/(?:f|v)/", urlparse(page).path):
        return False
    match = None
    cached = bunkr_cache.file_meta_get(page) or {}
    cover = cached.get("storyboard_url", "") if cached.get("storyboard_kind") in ("sprite", "cover") else ""
    kind = cached.get("storyboard_kind")
    if not cover:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=9) as client:
                response = await client.get(page, headers={"User-Agent": _THUMB_UA, "Referer": "https://bunkr.cr/"})
            if response.status_code != 200:
                return False
            text = response.text
            match = re.search(r"videoCoverUrl\s*=\s*['\"]([^'\"]+)['\"]", text)
            if not match:
                match = re.search(r"<meta\b[^>]*\bproperty\s*=\s*['\"]og:image['\"][^>]*\bcontent\s*=\s*['\"]([^'\"]+)", text, re.I)
            if not match:
                match = re.search(r"<meta\b[^>]*\bcontent\s*=\s*['\"]([^'\"]+)['\"][^>]*\bproperty\s*=\s*['\"]og:image['\"]", text, re.I)
            if not match or "video.svg" in match.group(1):
                return False
            cover = urljoin(page, html.unescape(match.group(1)).replace(r"\/", "/"))
            kind = "sprite" if "videoCoverUrl" in match.group(0) else "cover"
            bunkr_cache.file_meta_put(page, {**cached, "storyboard_url": cover, "storyboard_kind": kind, "thumbnail_checked": True})
        except Exception:
            return False
    if urlparse(cover).scheme not in ("http", "https"):
        return False
    with tempfile.TemporaryDirectory(prefix="nx_bunkr_cover_", dir=os.path.dirname(thumb_out)) as directory:
        candidate = os.path.join(directory, "cover.jpg")
        if not await _download_poster_to_thumb(cover, candidate, storyboard=kind == "sprite"):
            return False
        if not _candidate_thumb_score(candidate):
            return False  # A small provider image needs the stream fallback.
        previous = _video_path_from_static(video.thumbnail_path)
        if previous and os.path.isfile(previous) and not _is_poor_thumbnail(video) and _image_score(previous) > _image_score(candidate) + 3:
            _THUMB_KEEP_EXISTING.add(video.id)
            return False
        os.replace(candidate, thumb_out)
        return True


def _is_poor_thumbnail(video: Video) -> bool:
    """Return True if this video needs a better thumbnail extracted via ffmpeg."""
    # Keep the rethumb queue and visible badge in sync. Unknown remote posters
    # are candidates because the worker can replace them with a local frame.
    return thumbnail_quality(video)["status"] in {"poor", "unknown"}


def _smart_thumb_candidates(db: Session, limit: int = 500, *, retry_failed: bool = False, exclude_ids=None) -> list[Video]:
    """Return videos that have a playable stream URL but a poor thumbnail."""
    query = (
        db.query(Video)
        .filter(
            Video.status.in_(["ready_to_stream", "ready"]),
            Video.url.isnot(None),
            Video.url != "",
            # Automatic processing must not spin forever on a host that keeps
            # rejecting a frame request. A manual rethumb can still retry it.
            Video.smart_rethumb_at.is_(None),
        )
    )
    if not retry_failed:
        query = query.filter(Video.smart_rethumb_error.is_(None))
    excluded = set(exclude_ids or ())
    result = []
    cursor = None
    while True:
        # Newest imports first, continuing through the whole library by ID.
        # A fixed first-page window could hide eligible cards farther down.
        page_query = query.filter(Video.id < cursor) if cursor is not None else query
        page = page_query.order_by(Video.id.desc()).limit(400).all()
        if not page:
            break
        for v in page:
            cursor = v.id
            if v.id in excluded:
                continue
            url = (v.url or "").strip().lower()
            from .telegram_service import is_telegram_library_video
            if not is_telegram_library_video(v) and not _is_mega_video(v) and not url.startswith(("http://", "https://")) and not _local_video_file_path(v):
                continue
            if _is_embed_page(url):
                continue
            if _is_poor_thumbnail(v):
                result.append(v)
            if len(result) >= limit:
                return result
    return result


def _image_score(path: str) -> float:
    """Score decoded pixels at a fixed size, rejecting blank/dark frames.

    JPEG byte variance measures compression, not visual quality. Ignore the
    outer border (letterboxing) and balance exposure, detail and sharpness.
    This is a visual heuristic, not a face or scene recognizer.
    """
    try:
        from PIL import Image, ImageFilter, ImageStat
        with Image.open(path) as image:
            image.thumbnail((256, 256))
            gray = image.convert("L")
        w, h = gray.size
        if min(w, h) < 16:
            return 0.0
        gray = gray.crop((w // 10, h // 10, w - w // 10, h - h // 10))
        stats = ImageStat.Stat(gray)
        mean, contrast = stats.mean[0], stats.stddev[0]
        entropy = gray.entropy()
        if mean < 12 or mean > 244 or contrast < 8 or entropy < 2.25:
            return 0.0
        edges = gray.filter(ImageFilter.FIND_EDGES)
        edges = edges.crop((1, 1, edges.width - 1, edges.height - 1))
        sharpness = ImageStat.Stat(edges).stddev[0]
        exposure = min(1.0, mean / 55, (255 - mean) / 45)
        return round(exposure * (entropy * 7 + min(contrast, 64) * .35 + min(sharpness, 40) * .6), 3)
    except Exception:
        return 0.0


def _turbo_source_page(video: Video) -> str:
    """Durable turbo.cr/v/ page for a Turbo video, from source_url or the CDN id."""
    src = (video.source_url or "").strip()
    if re.search(r"turbo\.cr/(?:v|d|embed)/", src, re.I):
        return src
    m = re.search(r"turbocdn\.st/(?:turbo/)?data/([^/?#.]+)", (video.url or ""), re.I)
    if m:
        return f"https://turbo.cr/v/{m.group(1)}"
    return ""


async def _fresh_stream_for_thumb(video: Video) -> tuple[str, str]:
    """Re-resolve a fresh, playable stream URL for hosts whose stored URL expires.

    Turbo/CyberDrop store a signed CDN URL with a short-lived `exp`/`token`; by
    rethumb time it's dead (403/404) so ffmpeg gets nothing. Re-sign from the
    durable source page. Returns (url, referer); ("", "") if not applicable.
    """
    url = (video.url or "").strip()
    src = (video.source_url or "").strip()

    # FapFolder imports carry a four-hour R2 signature. The same object is
    # served by its durable media CDN; scope the mapping to FapFolder posts
    # and the observed bucket prefix, never rewrite unrelated signed URLs.
    if (urlparse(src).hostname or "").lower() == "fapfolder.club":
        parsed = urlparse(url)
        if ((parsed.hostname or "").endswith(".r2.cloudflarestorage.com")
                and parsed.path.startswith("/ffolder/uploads/videos/")
                and parsed.path.lower().endswith(".mp4")):
            return "https://fap.onl" + parsed.path[len("/ffolder"):], "https://fapfolder.club/"

    # Turbo — signed turbocdn.st URL expires; re-sign from turbo.cr/v/{id}.
    if "turbocdn.st" in url or re.search(r"turbo\.cr/", src, re.I):
        page = _turbo_source_page(video)
        if page:
            try:
                from app.extractors.turbo import TurboExtractor
                res = await TurboExtractor().extract(page)
                stream = (res or {}).get("stream_url", "")
                if stream and "turbocdn.st" in stream:
                    return stream, "https://turbo.cr/"
            except Exception as exc:
                logging.info("rethumb: turbo re-sign failed for %s: %s", video.id, exc)

    # CyberDrop — signed gigachad-cdn URL expires; re-resolve from /f/ or /e/ page.
    if "gigachad-cdn" in url or re.search(r"cyberdrop\.[a-z]+/[ef]/", src, re.I):
        page = src if re.search(r"cyberdrop\.[a-z]+/[ef]/", src, re.I) else ""
        if page:
            try:
                from app.extractors.cyberdrop import CyberDropExtractor
                res = await CyberDropExtractor().extract(page)
                stream = (res or {}).get("stream_url", "")
                if stream:
                    return stream, "https://cyberdrop.cr/"
            except Exception as exc:
                logging.info("rethumb: cyberdrop re-resolve failed for %s: %s", video.id, exc)

    # Bunkr — CDN token expires; re-resolve from the /f/ or /v/ page.
    if re.search(r"bunkr|scdn\.st|cdn\.cr", url, re.I) or re.search(r"bunkr", src, re.I):
        page = src if re.search(r"bunkr.*/(f|v)/", src, re.I) else ""
        if not page and re.search(r"bunkr.*/a/", src, re.I):
            from app.extractors.bunkr import BunkrExtractor
            cached = _BUNKR_ALBUM_LISTINGS.get(src)
            if not cached or time.monotonic() - cached[0] > 300:
                try:
                    items = await asyncio.wait_for(BunkrExtractor().extract_album(src, listing_only=True), 30)
                    if len(_BUNKR_ALBUM_LISTINGS) >= 64:
                        _BUNKR_ALBUM_LISTINGS.clear()
                    _BUNKR_ALBUM_LISTINGS[src] = (time.monotonic(), items)
                except Exception as exc:
                    _THUMB_FAIL_DETAIL[video.id] = f"Bunkr album sa nepodarilo načítať: {type(exc).__name__}"
                    return "", ""
            page = _match_bunkr_album_item(video, _BUNKR_ALBUM_LISTINGS[src][1])
            if not page:
                _THUMB_FAIL_DETAIL[video.id] = "Bunkr: súbor sa v albume nedá jednoznačne identifikovať"
                return "", ""
        if page:
            try:
                from app.extractors.bunkr import BunkrExtractor
                res = await asyncio.wait_for(BunkrExtractor().extract(page), 30)
                stream = (res or {}).get("stream_url", "")
                if stream:
                    video.source_url = page
                    from urllib.parse import urlparse as _up
                    p = _up(page)
                    return stream, f"{p.scheme}://{p.netloc}/"
            except Exception as exc:
                logging.info("meta: bunkr re-resolve failed for %s: %s", video.id, exc)

    # Filester / fileditch — signed CDN link expires; re-resolve from the file page.
    if re.search(r"filester\.|fileditchfiles\.|donotshare", url, re.I) or re.search(r"filester\.|fileditchfiles\.", src, re.I):
        page = src if re.search(r"filester\.|fileditchfiles\.", src, re.I) else url
        if page:
            try:
                from app.extractors.filester import FilesterExtractor
                res = await FilesterExtractor().extract(page)
                stream = (res or {}).get("stream_url", "")
                if stream:
                    return stream, page
            except Exception as exc:
                logging.info("meta: filester re-resolve failed for %s: %s", video.id, exc)

    # CyberFile — folder import stores the public file PAGE, not an MP4. The
    # CDN token is short-lived and often single-use, so always re-resolve from
    # the durable page before ffmpeg. Hitting the HTML page itself just sits
    # on the 40s subprocess timeout.
    if _is_cyberfile_url(url, src):
        page = ""
        for candidate in (src, url):
            c = (candidate or "").strip()
            cl = c.lower()
            if ("cyberfile.me" in cl and "/folder/" not in cl
                    and not re.search(r"https?://p\d+\.cyberfile\.me/", cl)):
                page = c
                break
        if page:
            try:
                from app.extractors.cyberfile import CyberFileExtractor
                res = await CyberFileExtractor().extract(page)
                stream = (res or {}).get("stream_url", "")
                if stream:
                    return stream, "https://cyberfile.me/"
            except Exception as exc:
                logging.info("rethumb: cyberfile re-resolve failed for %s: %s", video.id, exc)

    # GoFile — direct download links (*.gofile.io/download/web/...) return a 200
    # text/html shell unless the current GoFile accountToken has authorized the
    # folder/content via api.gofile.io/contents/{id} AND the request includes
    # Cookie: accountToken=... + Authorization: Bearer ... + X-Website-Token.
    if _is_gofile_url(url, src):
        page = ""
        for candidate in (src, url):
            c = (candidate or "").strip()
            if re.search(r"gofile\.io/(?:d|c)/[A-Za-z0-9_-]+", c, re.I):
                page = c
                break
        if page:
            try:
                from app.extractors.gofile import GoFileExtractor
                entries = await GoFileExtractor().extract_album_entries(page)
                matched = _match_gofile_album_item(video, entries)
                if matched:
                    stream = str(matched.get("stream_url") or matched.get("url") or "").strip()
                    if matched.get("duration") and not video.duration:
                        try:
                            video.duration = float(matched["duration"])
                        except (TypeError, ValueError):
                            pass
                    if stream:
                        return stream, page
            except Exception as exc:
                logging.info("rethumb: gofile re-resolve failed for %s: %s", video.id, exc)
        else:
            # Even if only a direct download link is stored, ensure a valid GoFile
            # guest token is initialized for _thumb_request_headers.
            try:
                from app.extractors.gofile import GoFileExtractor
                await asyncio.to_thread(GoFileExtractor._get_token)
            except Exception:
                pass
        if url.startswith(("http://", "https://")):
            return url, "https://gofile.io/"

    # Erome's video CDN requires the source page as Referer and stored stream
    # URLs may stop working. Match the refreshed album entry rather than
    # silently selecting the first video in a multi-video album.
    if re.search(r"erome\.com", url + " " + src, re.I):
        page = ""
        for candidate in (src, url):
            parsed = urlparse(candidate)
            host = (parsed.hostname or "").lower()
            if ((host == "erome.com" or host.endswith(".erome.com"))
                    and not re.fullmatch(r"v\d*\.erome\.com", host)):
                page = candidate
                break
        if page:
            try:
                from app.extractors.erome import EromeExtractor
                items = await asyncio.wait_for(EromeExtractor().extract_album_entries(page), 30)
                stream = _match_erome_album_item(video, items)
                if stream:
                    return stream, page
                _THUMB_FAIL_DETAIL[video.id] = (
                    "Erome: zdrojový príspevok neobsahuje jednoznačne zodpovedajúce video"
                    if items else "Erome: zo zdrojovej stránky sa nepodarilo obnoviť stream"
                )
            except Exception as exc:
                _THUMB_FAIL_DETAIL[video.id] = f"Erome: obnovenie streamu zlyhalo ({type(exc).__name__})"
                logging.info("rethumb: erome re-resolve failed for %s: %s", video.id, exc)
        return "", ""

    return "", ""


_THUMB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
_NEEDS_FRESH_STREAM = re.compile(r"turbocdn|gigachad|bunkr|cdn\.cr|scdn\.st|filester|fileditch|cyberfile|gofile\.io|fap\.onl|erome\.com"
                                 r"|r2\.cloudflarestorage|donotshare", re.I)


def _thumb_request_headers(url: str, extra_referer: str = "") -> dict:
    headers = {"User-Agent": _THUMB_UA}
    if extra_referer:
        headers["Referer"] = extra_referer
    elif "cdn.cr" in url or "scdn.st" in url or "bunkr" in url:
        headers["Referer"] = "https://bunkr.cr/"
    elif "lv.tnmr.org" in url or "cdn-tnmr.org" in url or "tnmr.org" in url:
        headers["Referer"] = "https://luluvdo.com/"
    elif "cyberfile.me" in url:
        headers["Referer"] = "https://cyberfile.me/"
    elif "gofile.io" in url.lower():
        headers["Referer"] = "https://gofile.io/"
    if "gofile.io" in url.lower():
        try:
            from app.extractors.gofile import GoFileExtractor
            headers["User-Agent"] = GoFileExtractor._user_agent
            token = GoFileExtractor._cached_token or GoFileExtractor._user_token or os.environ.get("GOFILE_TOKEN", "").strip()
            if not token:
                token = GoFileExtractor._get_token()
            if token:
                headers["Authorization"] = f"Bearer {token}"
                headers["Cookie"] = f"accountToken={token}"
                headers["X-BL"] = GoFileExtractor._language
                wt = GoFileExtractor._generate_website_token(token)
                if wt:
                    headers["X-Website-Token"] = wt
        except Exception as exc:
            logging.debug("rethumb: gofile header injection failed: %s", exc)
    return headers


async def _run_thumb_process(cmd: list, timeout: float) -> tuple[bool, str]:
    """Own the child process so a cancelled video timeout also stops FFmpeg."""
    import subprocess
    process = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    communication = asyncio.create_task(asyncio.to_thread(process.communicate, timeout=timeout))
    try:
        _, stderr = await asyncio.shield(communication)
        return process.returncode == 0, (stderr or b"").decode("utf-8", "replace")
    except BaseException:
        if process.poll() is None:
            process.kill()
        # Shielding keeps communicate alive to reap the child after cancellation.
        try:
            await asyncio.shield(communication)
        except subprocess.TimeoutExpired:
            await asyncio.to_thread(process.communicate)
        raise


async def _run_cdn_thumb_process(cmd, timeout, url):
    from app.streaming.playback_control import control
    if control.remaining(url) > 0:
        return False, "HTTP 503: spoločný cooldown CDN"
    async with control.background(url, lane="network"):
        result = await _run_cdn_thumb_process_admitted(cmd, timeout, url)
        if not result[0]:
            status = 429 if _is_rate_limited(result[1]) else 503 if "503" in result[1] else 0
            control.cooldown(url, status, 60)
        return result


async def _run_cdn_thumb_process_admitted(cmd, timeout, url):
    if not _is_serial_thumb_cdn(url):
        return await _run_thumb_process(cmd, timeout)
    # Both clients acquire the same limiter on the network loop.
    await asyncio.wrap_future(fast_thumb.NET.submit(fast_thumb.NET.acquire_decoder(url)))
    try:
        return await _run_thumb_process(cmd, timeout)
    finally:
        await asyncio.wrap_future(fast_thumb.NET.submit(fast_thumb.NET.release_decoder(url)))


async def _generate_thumb_from_stream(video: Video, thumb_dir: str,
                                      seek_frac: Optional[float] = None) -> bool:
    # One extraction budget. Transport retries are owned by the Range client;
    # temporary refusals must not restart the whole decoder pipeline.
    host = urlparse(video.url or '').netloc.lower()
    from app.streaming.playback_control import control
    if (_THUMB_HOST_RETRY_AT.get(host, 0) > time.monotonic()
            or control.remaining(video.url or '') > 0):
        _THUMB_FAIL_DETAIL[video.id] = "HTTP 503: dočasná chyba CDN, ďalší pokus je odložený"
        return False
    try:
        from app.streaming.playback_control import control
        async with control.background(video.url or ""):
            return await asyncio.wait_for(_generate_thumb_from_stream_impl(video, thumb_dir, seek_frac), 150)
    except asyncio.TimeoutError:
        _THUMB_FAIL_DETAIL[video.id] = "Časový limit 150 sekúnd pri vytváraní náhľadu"
        return False


async def _generate_thumb_from_stream_impl(video: Video, thumb_dir: str,
                                          seek_frac: Optional[float] = None) -> bool:
    """
    Extract multiple candidate frames from different seek positions,
    score each for visual richness, keep the best one.

    Probe points: 25%, 50%, 75% of duration (at most 3 candidates).
    Falls back to a single early frame if duration unknown.

    `seek_frac` (0..1): when given, that position is tried FIRST. The batch worker
    leaves it None (deterministic best-of); the per-card manual button passes a
    random fraction to vary the first candidate on a manual reroll. Fragile CDNs
    stop on a detailed, well-exposed frame, or compare more positions if needed.

    Returns True on success.
    """
    import shutil
    import tempfile

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    url = (video.url or "").strip()
    _THUMB_FAIL_DETAIL.pop(video.id, None)
    _THUMB_KEEP_EXISTING.discard(video.id)
    if not url:
        return False

    from .telegram_service import is_telegram_library_video, library_telegram_stream_path
    if is_telegram_library_video(video):
        from .telegram_rethumb import repair_thumbnail
        path = library_telegram_stream_path(video) or ""
        pair = re.search(r"/telegram/stream/(-?\d+)/(\d+)", path)
        if not pair:
            _THUMB_FAIL_DETAIL[video.id] = "Chýba Telegram identifikátor videa"
            return False
        try:
            generated = await repair_thumbnail(int(pair.group(1)), int(pair.group(2)), video.duration or 0)
            os.makedirs(thumb_dir, exist_ok=True)
            import shutil
            import tempfile
            with tempfile.NamedTemporaryFile(dir=thumb_dir, suffix=".jpg", delete=False) as tmp:
                temp_name = tmp.name
            try:
                shutil.copyfile(generated, temp_name)
                os.replace(temp_name, os.path.join(thumb_dir, f"thumb_{video.id}.jpg"))
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
            return True
        except Exception as exc:
            _THUMB_FAIL_DETAIL[video.id] = str(exc)[:300]
            return False

    is_mega = _is_mega_video(video)
    if is_mega:
        from app.config import config
        url = f"http://127.0.0.1:{config.SERVER_PORT}/api/v1/mega/stream/{video.id}"
    local_path = None if is_mega else _local_video_file_path(video)
    if not url.startswith(("http://", "https://")) and not local_path:
        _THUMB_FAIL_DETAIL[video.id] = "Lokálny súbor sa nenašiel alebo nie je čitateľný"
        return False
    is_local_file = bool(local_path)
    if local_path:
        url = local_path

    os.makedirs(thumb_dir, exist_ok=True)
    thumb_out = os.path.join(thumb_dir, f"thumb_{video.id}.jpg")
    if not is_local_file and not is_mega and seek_frac is None:
        if await _bunkr_cover_to_thumb(video, thumb_out):
            return True
        if video.id in _THUMB_KEEP_EXISTING:
            return False

    # A still-valid Bunkr CDN signature can be used directly. Re-extract only
    # expired/unknown signatures; resolution costs another network round trip.
    from urllib.parse import parse_qs
    parsed_url = urlparse(url)
    signed_bunkr = False
    if (parsed_url.hostname or "").endswith((".cdn.cr", ".scdn.st")):
        query = parse_qs(parsed_url.query)
        try:
            signed_bunkr = bool(query.get("token")) and float(query.get("ex", [0])[0]) > time.time() + 180
        except (TypeError, ValueError):
            pass
    # Hosts whose stored CDN URL carries an expiring token — re-sign a fresh one
    # from the durable source page, else ffmpeg gets a dead 403/404 link.
    extra_referer = ""
    fresh_url, fresh_ref = await _fresh_stream_for_thumb(video) if not (is_local_file or signed_bunkr or is_mega) else ("", "")
    if fresh_url:
        url, extra_referer = fresh_url, fresh_ref
        video.url = fresh_url
    elif not signed_bunkr and re.search(r"bunkr|scdn\.st|cdn\.cr", url + " " + (video.source_url or ""), re.I):
        _THUMB_FAIL_DETAIL.setdefault(video.id, "Bunkr nevrátil čerstvý stream; obnov zdrojový odkaz")
        return False
    elif not is_local_file and _is_cyberfile_url(video.url, video.source_url):
        # Never let ffmpeg chew 40s on the HTML file page / a spent token.
        _THUMB_FAIL_DETAIL[video.id] = "CyberFile nevrátil čerstvý stream"
        return False
    elif not is_local_file and re.search(r"erome\.com", video.url + " " + (video.source_url or ""), re.I):
        _THUMB_FAIL_DETAIL.setdefault(video.id, "Erome nevrátil čerstvý stream")
        return False

    vid_id = video.id
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_out = os.path.join(thumb_dir, f"thumb_{vid_id}.jpg")

    # FileDitch fast-path: the .mp4 page is an anti-bot HTML shell, so ffmpeg
    # cannot decode a frame from it. Use FileDitch's hosted poster PNG instead
    # (predictable CDN path), which is what the import flow now relies on too.
    fd_poster = _fileditch_poster_url(video.url, video.source_url)
    if fd_poster:
        with tempfile.TemporaryDirectory(prefix="nx_poster_check_", dir=thumb_dir) as directory:
            candidate = os.path.join(directory, "poster.jpg")
            if await _download_poster_to_thumb(fd_poster, candidate) and _candidate_thumb_score(candidate):
                previous = _video_path_from_static(video.thumbnail_path)
                if previous and os.path.isfile(previous) and not _is_poor_thumbnail(video) and _image_score(previous) > _image_score(candidate) + 3:
                    _THUMB_KEEP_EXISTING.add(video.id)
                    return False
                os.replace(candidate, thumb_out)
                return True
        # Poster fetch failed — fall through to ffmpeg, which will also likely
        # fail on the HTML shell, but keeps behaviour graceful.
    duration = float(video.duration or 0)
    probes = _thumb_probe_positions(duration, url, seek_frac=seek_frac)

    network_args = [] if is_local_file else [
        "-reconnect", "1", "-reconnect_streamed", "1",
        "-reconnect_delay_max", "8",
        "-timeout", "15000000",
    ]
    ua = _THUMB_UA
    request_headers = _thumb_request_headers(url, extra_referer)
    headers_str = "".join(f"{k}: {v}\r\n" for k, v in request_headers.items())

    base_args = [ffmpeg, "-y", "-threads", "2", "-hide_banner", "-loglevel", "error"]
    stream_refused = False

    async def _run(cmd: list, timeout: float) -> bool:
        nonlocal stream_refused
        # Popen + communicate in a worker thread also works on Windows loops
        # without subprocess support. The helper kills/reaps on cancellation.
        #
        # Retries on CDN rate-limiting: Bunkr (cdn.cr/scdn.st) answers a burst of
        # range requests with 429, which ffmpeg reports as "4XX Client Error, but
        # not one of 40{0,1,3,4}". That is a *temporary* refusal, but the old code
        # only saw returncode != 0 and recorded it as a permanent failure — so a
        # whole batch could be written off as dead when the files were fine.
        for attempt in range(1):
            try:
                ok, err = await _run_cdn_thumb_process(cmd, timeout, url)
            except Exception as exc:
                ok, err = False, str(exc)
            if ok:
                return True
            if "4XX Client Error, but not one of 40{0,1,3,4}" in err:
                status = await _thumb_http_status(url, {"User-Agent": ua, "Referer": extra_referer or "https://bunkr.cr/"})
                err = f"HTTP {status}: CDN odmietol stream" if status and status >= 400 else "CDN odmietol stream (neznáma HTTP chyba)"
            retryable = _is_rate_limited(err)
            if retryable:
                _THUMB_HOST_RETRY_AT[urlparse(url).netloc.lower()] = time.monotonic() + 60
                _SMART_THUMB_PROGRESS.update(message=f"Video #{video.id}: dočasná chyba CDN, odkladám")
            if err:
                stream_refused = retryable or bool(re.search(r"HTTP (401|403|404|410)|Server returned (401|403|404|410)", err)) or "neznáma HTTP chyba" in err
                compact = err.strip().replace("\n", " | ")
                _THUMB_FAIL_DETAIL[video.id] = compact[:300]
                logging.info("rethumb: ffmpeg failed for %s: %s", video.id, compact[:200])
            return False
        return False

    def _build_seek_cmd(seek_s: float, out_path: str, *, accurate_seek: bool = False) -> list:
        input_args = ["-i", url, "-ss", str(seek_s)] if accurate_seek else ["-ss", str(seek_s), "-i", url]
        return (
            base_args
            + network_args
            + ([] if is_local_file else ["-headers", headers_str])
            + input_args
            # Explicit full-range JPEG avoids FFmpeg 8 rejecting valid
            # yuv420p frames from locally indexed mobile/HLS remuxed MP4s.
            # Scale up to 1280x720 (HD) so generated thumbnails earn the HQ badge.
            + ["-vf", "scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p"]
            + ["-vframes", "1", "-q:v", "2", out_path]
        )

    tmp_dir = tempfile.mkdtemp(prefix="nx_thumb_", dir=thumb_dir)
    candidates: list[tuple[float, str]] = []  # (score, path)

    try:
        async def _probe_one(i: int, seek_s: float):
            nonlocal url, headers_str, signed_bunkr, stream_refused
            cand_path = os.path.join(tmp_dir, f"cand_{i}.jpg")
            ok = await _run(_build_seek_cmd(seek_s, cand_path), timeout=40)
            if not ok and signed_bunkr and stream_refused and not _is_rate_limited(_THUMB_FAIL_DETAIL.get(video.id, '')):
                # A signature can be revoked before its advertised expiry.
                # Retry once with a freshly resolved URL before giving up.
                signed_bunkr = False
                renewed_url, renewed_ref = await _fresh_stream_for_thumb(video)
                if renewed_url:
                    url = video.url = renewed_url
                    headers_str = f"User-Agent: {ua}\r\nReferer: {renewed_ref or 'https://bunkr.cr/'}\r\n"
                    stream_refused = False
                    ok = await _run(_build_seek_cmd(seek_s, cand_path), timeout=40)
            # Some fragmented MP4s advertise keyframes in a way that makes a
            # pre-input (fast) seek return zero frames.  A local file is cheap
            # to seek accurately, so retry after opening the file.
            usable = ok and os.path.exists(cand_path) and os.path.getsize(cand_path) > 0
            if not usable and is_local_file:
                ok = await _run(_build_seek_cmd(seek_s, cand_path, accurate_seek=True), timeout=40)
            if ok and os.path.exists(cand_path) and os.path.getsize(cand_path) > 0:
                score = await asyncio.get_event_loop().run_in_executor(None, _candidate_thumb_score, cand_path)
                if score > 0:
                    return (score, cand_path)
            return None

        # Some CDNs (Bunkr c*.cdn.cr / scdn.st) rate-limit concurrent range
        # requests from one IP. Compare two positions serially; a third is only
        # needed when both are weak. CyberFile's single-use token gets one shot.
        # Rýchla cesta: paralelné Range requesty (8-32 spojení) + dekódovanie v pamäti.
        # Pri nepodporovanom zdroji / odmietnutí sa pokračuje klasickým ffmpeg.
        if (not is_local_file and not is_mega and not _is_cyberfile_url(url, video.source_url)
                and fast_thumb.eligible(url)):
            try:
                fast_paths = await fast_thumb.extract_candidates(
                    url, request_headers, duration, fast_thumb.fractions_for(seek_frac), tmp_dir)
                loop = asyncio.get_event_loop()
                for fast_path in fast_paths:
                    score = await loop.run_in_executor(None, _candidate_thumb_score, fast_path)
                    if score > 0:
                        candidates.append((score, fast_path))
            except fast_thumb.FastThumbThrottled as exc:
                _THUMB_FAIL_DETAIL[video.id] = str(exc)
                _THUMB_HOST_RETRY_AT[urlparse(url).netloc.lower()] = time.monotonic() + max(60, exc.retry_after)
                return False
            except fast_thumb.FastThumbError as exc:
                logging.info("fast_thumb: %s -> ffmpeg fallback (%s)", video.id, exc)

        serial_cdn = not is_local_file and _is_serial_thumb_cdn(url)
        if candidates:
            pass
        elif serial_cdn:
            for i, s in enumerate(probes):
                res = await _probe_one(i, s)
                if res is not None:
                    candidates.append(res)
                    if _is_cyberfile_url(url, video.source_url):
                        break
                    if res[0] >= 80:
                        break  # Already well exposed and detailed; avoid another CDN seek.
                    if len(candidates) >= 2 and max(c[0] for c in candidates) >= 55:
                        break
                if stream_refused:
                    break  # Other seek positions cannot repair a refused stream.
        else:
            results = await asyncio.gather(*[_probe_one(i, s) for i, s in enumerate(probes)])
            for res in results:
                if res is not None:
                    candidates.append(res)

        if not candidates:
            # Some FapFolder objects answer FFmpeg's seek requests too slowly,
            # while explicit bounded HTTP ranges work. Their fast-start MP4
            # prefix contains moov + early frames; never download the full file.
            if extra_referer == "https://fapfolder.club/" and urlparse(url).hostname == "fap.onl":
                prefix_path = os.path.join(tmp_dir, "prefix.mp4")
                prefix_thumb = os.path.join(tmp_dir, "prefix.jpg")
                cap = 8 * 1024 * 1024
                try:
                    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                        async with client.stream("GET", url, headers={"Range": f"bytes=0-{cap - 1}"}) as response:
                            response.raise_for_status()
                            remaining = cap
                            with open(prefix_path, "wb") as output:
                                async for chunk in response.aiter_bytes(64 * 1024):
                                    output.write(chunk[:remaining])
                                    remaining -= min(remaining, len(chunk))
                                    if remaining == 0:
                                        break
                    cmd = base_args + ["-ss", "3", "-i", prefix_path,
                                       "-vf", "scale=w='min(iw,854)':h='min(ih,480)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
                                       "-vframes", "1", "-q:v", "3", prefix_thumb]
                    if (await _run(cmd, timeout=20) and os.path.exists(prefix_thumb)
                            and os.path.getsize(prefix_thumb) > _SMART_THUMB_MIN_FILE_BYTES):
                        score = _candidate_thumb_score(prefix_thumb)
                        if score > 0:
                            candidates.append((score, prefix_thumb))
                except Exception as exc:
                    logging.info("rethumb: bounded FapFolder prefix failed for %s: %s", video.id, type(exc).__name__)
            if not candidates:
                _THUMB_FAIL_DETAIL.setdefault(video.id, "Nepodarilo sa získať náhľad s dostatočným rozlíšením a kvalitou")
                return False

        # Pick highest-scoring frame
        best_score, best_path = max(candidates, key=lambda x: x[0])

        # Keep an already usable preview if the replacement is clearly worse.
        # A small tolerance allows a manual reroll of similarly good frames.
        previous = _video_path_from_static(video.thumbnail_path)
        if previous and os.path.isfile(previous) and not _is_poor_thumbnail(video):
            if _image_score(previous) > best_score + 3:
                _THUMB_KEEP_EXISTING.add(video.id)
                return False

        # Atomic replace prevents partial JPEGs in the gallery and preserves
        # the current preview if generation or validation fails.
        os.replace(best_path, thumb_out)
        return True

    finally:
        # Clean up temp files
        import shutil as _sh
        try:
            _sh.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


async def smart_rethumb_worker(
    db: Session,
    limit: int = 200,
    dry_run: bool = False,
    retry_failed: bool = False,
    exclude_ids=None,
) -> dict:
    """
    Background worker that scans all ready videos with poor thumbnails and
    regenerates them using ffmpeg directly from the stream URL.
    Broadcasts progress over WebSocket.
    """
    global _SMART_THUMB_RUNNING
    if _SMART_THUMB_RUNNING:
        return {"status": "already_running"}
    _SMART_THUMB_RUNNING = True

    from app.websockets import manager
    from app.database import SessionLocal
    from app.services import THUMB_DIR

    def _broadcast(msg: str, level: str = "info"):
        try:
            loop = asyncio.get_event_loop()
            data = json.dumps({"type": "log", "message": msg, "level": level})
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(manager.broadcast(data), loop)
        except Exception:
            pass

    stats = {"scanned": 0, "improved": 0, "failed": 0, "skipped": 0}
    _SMART_THUMB_PROGRESS.clear()
    _SMART_THUMB_PROGRESS.update(total=0, done=0, failed=0, label="Celá knižnica", running=True, message="Vyhľadávam videá…")
    failed_items: list[dict] = []
    report: dict = {"kind": "library", "started_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat()}

    try:
        def find_candidates():
            with SessionLocal() as fresh_db:
                return _smart_thumb_candidates(fresh_db, limit=limit, retry_failed=retry_failed, exclude_ids=exclude_ids)
        candidates = await asyncio.to_thread(find_candidates)

        if _SMART_THUMB_STOP.is_set():
            return stats
        stats["scanned"] = len(candidates)
        if exclude_ids is not None:
            exclude_ids.update(v.id for v in candidates)
        _rethumb_queue(candidates)
        _SMART_THUMB_PROGRESS.update(total=len(candidates))
        _broadcast(f"Smart Rethumb: {len(candidates)} videos queued for thumbnail upgrade.", "working")

        if dry_run:
            return {"status": "dry_run", **stats, "candidate_ids": [v.id for v in candidates]}

        semaphore = fast_thumb.WorkerLimiter()
        fast_thumb.get_store().purge_done()
        prefetch_task = _start_prefetch(candidates, semaphore)
        # Bunkr throttles aggressively — give it its own narrow lane so a big
        # batch doesn't 429 itself into a wall of false "failed" results.
        bunkr_semaphore = asyncio.Semaphore(_BUNKR_THUMB_CONCURRENCY)
        cyberfile_semaphore = asyncio.Semaphore(_CYBERFILE_THUMB_CONCURRENCY)

        async def _process_one(video: Video):
            url = (video.url or "").lower()
            # HTML embed pages can't yield a frame — skip rather than fail them.
            if _is_embed_page(url):
                stats["skipped"] += 1
                _rethumb_started(video)
                _rethumb_finished(video, stats)
                return
            if _is_cyberfile_url(url, video.source_url):
                gate = cyberfile_semaphore
            elif any(t in url for t in ("cdn.cr", "scdn.st", "bunkr")):
                gate = bunkr_semaphore
            else:
                gate = semaphore
            async with _rethumb_gate(semaphore, gate):
                if _SMART_THUMB_STOP.is_set():
                    return
                vid_id = video.id
                _rethumb_started(video)
                _SMART_THUMB_PROGRESS.update(message=f"Spracúvam video #{vid_id}")
                try:
                    ok = await _generate_rethumb_or_stop(video, THUMB_DIR)
                    if ok is None:
                        return
                    if vid_id in _THUMB_KEEP_EXISTING:
                        _THUMB_KEEP_EXISTING.discard(vid_id)
                        stats["skipped"] += 1
                        _rethumb_finished(video, stats, "skipped")
                        return
                    work_db = SessionLocal()
                    try:
                        v = work_db.query(Video).get(vid_id)
                        if v:
                            v.url = video.url
                            v.source_url = video.source_url
                        if ok and v:
                            new_path = f"/static/thumbnails/thumb_{vid_id}.jpg"
                            v.thumbnail_path = new_path
                            v.preview_retry_needed = False
                            v.smart_rethumb_at = datetime.now(timezone.utc).replace(tzinfo=None)
                            v.smart_rethumb_error = None
                            work_db.commit()
                            # Broadcast card update so the UI refreshes live
                            upd = json.dumps({
                                "type": "thumbnail_updated",
                                "video_id": vid_id,
                                "thumbnail_path": new_path,
                                "thumbnail_quality": thumbnail_quality(v),
                                "smart_rethumb_at": v.smart_rethumb_at.isoformat(),
                            })
                            try:
                                loop = asyncio.get_event_loop()
                                if loop.is_running():
                                    asyncio.run_coroutine_threadsafe(manager.broadcast(upd), loop)
                            except Exception:
                                pass
                            stats["improved"] += 1
                        else:
                            stats["failed"] += 1
                            fail = _classify_rethumb_failure(video)
                            failed_items.append(fail)
                            if v:
                                v.smart_rethumb_error = fail["reason"]
                                work_db.commit()
                    finally:
                        work_db.close()
                except Exception as exc:
                    logging.warning("smart_rethumb failed for video %s: %s", vid_id, exc)
                    stats["failed"] += 1
                    _THUMB_FAIL_DETAIL[vid_id] = str(exc)[:300]
                    failed_items.append(_classify_rethumb_failure(video))

                _rethumb_finished(video, stats)

        tasks = [_process_one(v) for v in candidates]
        await asyncio.gather(*tasks, return_exceptions=True)
        if prefetch_task:
            prefetch_task.cancel()

        _broadcast(
            f"Smart Rethumb done. improved={stats['improved']} failed={stats['failed']} scanned={stats['scanned']}",
            "success",
        )
    except Exception as exc:
        logging.exception("smart_rethumb_worker crashed")
        stats["status"] = "error"
        stats["error"] = str(exc)
        _broadcast(f"Smart Rethumb error: {exc}", "error")
    finally:
        _SMART_THUMB_RUNNING = False
        _SMART_THUMB_PROGRESS["finished_epoch"] = time.time()
        stopped = _finish_rethumb_stop()
        _SMART_THUMB_PROGRESS.update(running=False, message="Zastavené" if stopped else (f"Chyba: {stats['error']}" if stats.get("status") == "error" else ("Žiadne vhodné videá na spracovanie" if not stats["scanned"] else "Dokončené")), done=stats["improved"] + stats["failed"] + stats["skipped"])
        global _LAST_RETHUMB_REPORT
        report.update(finished_at=datetime.now(timezone.utc).replace(tzinfo=None).isoformat(), **stats,
                      skipped_done=0, failed_items=failed_items[:100])
        _LAST_RETHUMB_REPORT = report

    return stats


_JOBS_RECOVERED = False


async def auto_smart_rethumb_tick(limit: int = 100, manual: bool = False) -> dict:
    """Drain poor previews in consecutive 100-item batches.

    The scheduler wakes every ten minutes, and this job keeps taking another
    batch as soon as the previous one is finished until no eligible candidate
    remains. Reserving before opening a database session closes the race with
    an operator pressing the manual rethumb button at the same moment.
    """
    global _SMART_THUMB_AUTO_PAUSED
    if manual:
        _SMART_THUMB_AUTO_PAUSED = False
    elif _SMART_THUMB_AUTO_PAUSED:
        return {"status": "paused"}
    if not reserve_smart_rethumb():
        return {"status": "already_running"}
    from app.database import SessionLocal
    db = SessionLocal()
    try:
        batch_size = 100
        due = fast_thumb.get_store().due()
        if due:
            rows = db.query(Video).filter(Video.id.in_(due)).all()
            for v in rows:
                if not _is_poor_thumbnail(v):
                    fast_thumb.get_store().mark(v.id, 'done')
            rows = [v for v in rows if _is_poor_thumbnail(v)]
            if rows:
                await smart_rethumb_videos(rows, label="Opakovaný pokus po chybe CDN")
        global _JOBS_RECOVERED
        if not _JOBS_RECOVERED:
            _JOBS_RECOVERED = True
            interrupted = await asyncio.to_thread(fast_thumb.get_store().recover)
            if interrupted:
                rows = db.query(Video).filter(Video.id.in_(interrupted)).all()
                rows = [v for v in rows if _is_poor_thumbnail(v) or v.smart_rethumb_at is None]
                if rows:
                    logging.info("smart_rethumb: obnovujem %d prerušených úloh po páde", len(rows))
                    await smart_rethumb_videos(rows, label="Obnova po páde")
        total = {"scanned": 0, "improved": 0, "failed": 0, "skipped": 0, "batches": 0}
        attempted_ids = set()
        while not _SMART_THUMB_STOP.is_set():
            previous_progress = dict(_SMART_THUMB_PROGRESS)
            if manual:
                result = await smart_rethumb_worker(db, limit=batch_size, retry_failed=True, exclude_ids=attempted_ids)
            else:
                result = await smart_rethumb_worker(db, limit=batch_size)
            if result.get("status") == "error":
                return {"status": "error", "error": result.get("error"), **total}
            if not result.get("scanned") and total["scanned"]:
                _SMART_THUMB_PROGRESS.clear()
                _SMART_THUMB_PROGRESS.update(previous_progress)
                _SMART_THUMB_PROGRESS.update(running=False, message="Dokončené", finished_epoch=time.time())
            if result.get("status") == "already_running":
                return {"status": "already_running", **total}
            total["batches"] += 1
            for key in ("scanned", "improved", "failed", "skipped"):
                total[key] += int(result.get(key) or 0)
            # A short final batch means there cannot be another full set. If
            # it was full, probe once more: retries are excluded by the query.
            if int(result.get("scanned") or 0) < batch_size:
                break
        if _SMART_THUMB_STOP.is_set():
            _finish_rethumb_stop()
            _SMART_THUMB_PROGRESS.update(running=False, cancelled=True, stopping=False, message="Zastavené", finished_epoch=time.time())
            return {"status": "cancelled", **total}
        return {"status": "completed", **total}
    finally:
        db.close()
        release_smart_rethumb_reservation()


def smart_rethumb_status(db: Session, limit: int = 300) -> dict:
    """Cheap polling snapshot. Never open thousands of images to report progress."""
    done = db.query(func.count(Video.id)).filter(Video.smart_rethumb_at.isnot(None)).scalar() or 0
    failed = db.query(func.count(Video.id)).filter(Video.smart_rethumb_error.isnot(None)).scalar() or 0
    return {"running": _SMART_THUMB_RUNNING or _SMART_THUMB_PENDING, "progress": _rethumb_snapshot(), "candidates": None,
            "done": done, "failed": failed}


def smart_rethumb_report(db: Session, limit: int = 100) -> dict:
    """Full picture for the maintenance panel: counts, the last run's summary and
    a durable (DB-backed) list of failed videos with reason + suggested fixes."""
    done = db.query(func.count(Video.id)).filter(Video.smart_rethumb_at.isnot(None)).scalar() or 0
    failed_q = db.query(Video).filter(Video.smart_rethumb_error.isnot(None))
    failed_count = failed_q.count()
    failed_items = []
    for v in failed_q.order_by(Video.id.desc()).limit(limit).all():
        try:
            host = urlparse(v.url or "").netloc or urlparse(v.source_url or "").netloc
        except Exception:
            host = ""
        failed_items.append({
            "id": v.id,
            "title": (v.title or f"Video #{v.id}")[:120],
            "host": host,
            "reason": v.smart_rethumb_error,
            "detail": _THUMB_FAIL_DETAIL.get(v.id, ""),
            "options": _rethumb_fix_options(v),
            "source_url": v.source_url or "",
        })
    return {
        "running": _SMART_THUMB_RUNNING,
        "done": done,
        "failed": failed_count,
        "candidates": None,
        "failed_items": failed_items,
        "last_run": _LAST_RETHUMB_REPORT,
    }


def _resolve_rethumb_targets(db: Session, video_ids=None, batch_name: str = "",
                             limit: Optional[int] = 300) -> list[Video]:
    """Return the concrete Video rows a batch/selection rethumb should process."""
    q = db.query(Video).filter(Video.url.isnot(None), Video.url != "")
    if video_ids:
        q = q.filter(Video.id.in_([int(i) for i in video_ids]))
    elif batch_name:
        q = q.filter(Video.batch_name == batch_name)
    else:
        return _smart_thumb_candidates(db, limit=limit)
    if limit is not None:
        q = q.limit(max(limit, len(video_ids or [])) or limit)
    rows = q.all()
    # A rethumb can use a direct remote stream or a locally indexed/uploaded file.
    return [v for v in rows if (v.url or "").strip().lower().startswith(("http://", "https://"))
            or _is_mega_video(v) or _local_video_file_path(v)]


def _start_prefetch(videos, limiter):
    """Predhreje začiatok/koniec súborov pre ďalšie videá vo fronte (8 s dopredu)."""
    items = []
    for v in videos:
        url = (v.url or "").strip()
        if (fast_thumb.eligible(url) and not _NEEDS_FRESH_STREAM.search(url + " " + (v.source_url or ""))):
            items.append((url, _thumb_request_headers(url)))
    if items:
        return asyncio.ensure_future(fast_thumb.prefetch_ahead(
            items, lambda: _SMART_THUMB_PROGRESS.get("started_count", 0), limiter.limit))


async def smart_rethumb_videos(videos: list[Video], concurrency: Optional[int] = None,
                               skipped_done: int = 0, label: str = "",
                               seek_frac: Optional[float] = None) -> dict:
    """Regenerate thumbnails for an explicit set of videos (batch / selection).

    Mirrors `smart_rethumb_worker` but operates on a caller-supplied list rather
    than scanning for poor thumbnails, so the "this batch" / "selected" buttons
    work even on videos whose current thumbnail looks fine.

    `skipped_done` is how many videos the caller dropped up-front because they
    already carry a smart rethumb — surfaced in the progress UI and report.
    """
    global _SMART_THUMB_RUNNING, _LAST_RETHUMB_REPORT
    if _SMART_THUMB_RUNNING:
        return {"status": "already_running"}
    _SMART_THUMB_RUNNING = True

    videos = sorted(videos, key=lambda video: video.id, reverse=True)

    from app.websockets import manager
    from app.database import SessionLocal
    from app.services import THUMB_DIR

    stats = {"scanned": len(videos), "improved": 0, "failed": 0, "skipped": 0,
             "skipped_done": int(skipped_done or 0)}
    _SMART_THUMB_PROGRESS.clear()
    _SMART_THUMB_PROGRESS.update(total=len(videos), done=0, failed=0, label=label, running=True, message="Pripravujem náhľady…")
    _rethumb_queue(videos)
    failed_items: list[dict] = []
    report: dict = {"kind": "batch", "label": label,
                    "started_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat()}
    # Bez explicitného nastavenia používateľa beží dynamický limit (štart 32, max 64).
    sem = fast_thumb.WorkerLimiter(max(1, int(concurrency)) if concurrency else None)
    prefetch_task = _start_prefetch(videos, sem)
    bunkr_sem = asyncio.Semaphore(_BUNKR_THUMB_CONCURRENCY)
    cyberfile_sem = asyncio.Semaphore(_CYBERFILE_THUMB_CONCURRENCY)

    def _broadcast(payload: dict):
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(manager.broadcast(json.dumps(payload)), loop)
        except Exception:
            pass

    try:
        _broadcast({"type": "batch_rethumb_start", "total": len(videos),
                    "skipped_done": stats["skipped_done"], "label": label})

        async def _one(video: Video):
            url = (video.url or "").lower()
            if _is_cyberfile_url(url, video.source_url):
                gate = cyberfile_sem
            elif any(t in url for t in ("cdn.cr", "scdn.st", "bunkr")):
                gate = bunkr_sem
            else:
                gate = sem
            async with _rethumb_gate(sem, gate):
                if _SMART_THUMB_STOP.is_set():
                    return
                vid_id = video.id
                _rethumb_started(video)
                _SMART_THUMB_PROGRESS.update(message=f"Spracúvam video #{vid_id}: {(video.title or '')[:80]}")
                try:
                    ok = await _generate_rethumb_or_stop(video, THUMB_DIR, seek_frac=seek_frac)
                    if ok is None:
                        return
                    if vid_id in _THUMB_KEEP_EXISTING:
                        _THUMB_KEEP_EXISTING.discard(vid_id)
                        stats["skipped"] += 1
                        _rethumb_finished(video, stats, "skipped")
                        _broadcast({"type": "thumbnail_unchanged", "video_id": vid_id,
                                    "message": "Pôvodný náhľad je lepší a zostal zachovaný"})
                        return
                    wdb = SessionLocal()
                    try:
                        v = wdb.query(Video).get(vid_id)
                        if v:
                            v.url = video.url
                            v.source_url = video.source_url
                        if ok and v:
                            new_path = f"/static/thumbnails/thumb_{vid_id}.jpg"
                            v.thumbnail_path = new_path
                            v.preview_retry_needed = False
                            v.smart_rethumb_at = datetime.now(timezone.utc).replace(tzinfo=None)
                            v.smart_rethumb_error = None
                            wdb.commit()
                            stats["improved"] += 1
                            _broadcast({"type": "thumbnail_updated", "video_id": vid_id,
                                        "thumbnail_path": new_path,
                                        "thumbnail_quality": thumbnail_quality(v),
                                        "smart_rethumb_at": v.smart_rethumb_at.isoformat()})
                        else:
                            stats["failed"] += 1
                            fail = _classify_rethumb_failure(video)
                            failed_items.append(fail)
                            _broadcast({"type": "thumbnail_failed", "video_id": vid_id, "message": fail["reason"]})
                            if v:
                                v.smart_rethumb_error = fail["reason"]
                                wdb.commit()
                    finally:
                        wdb.close()
                except Exception as exc:
                    logging.warning("smart_rethumb (batch) failed for %s: %s", vid_id, exc)
                    stats["failed"] += 1
                    _THUMB_FAIL_DETAIL[vid_id] = "Časový limit 150 sekúnd" if isinstance(exc, asyncio.TimeoutError) else str(exc)[:300]
                    failed_items.append(_classify_rethumb_failure(video))
                    with SessionLocal() as error_db:
                        failed_video = error_db.get(Video, vid_id)
                        if failed_video:
                            failed_video.smart_rethumb_error = _THUMB_FAIL_DETAIL[vid_id]
                            error_db.commit()
                _rethumb_finished(video, stats)
                _broadcast({"type": "batch_rethumb_progress",
                            "done": stats["improved"] + stats["failed"] + stats["skipped"],
                            "failed": stats["failed"],
                            "skipped": stats["skipped_done"],
                            "total": len(videos)})

        await asyncio.gather(*[_one(v) for v in videos], return_exceptions=True)
        if prefetch_task:
            prefetch_task.cancel()
        _broadcast({"type": "batch_rethumb_done", "cancelled": _SMART_THUMB_STOP.is_set(), **stats})
    except Exception as exc:
        logging.error("smart_rethumb_videos crashed: %s", exc)
    finally:
        _SMART_THUMB_RUNNING = False
        stopped = _finish_rethumb_stop()
        _SMART_THUMB_PROGRESS.update(running=False, message="Zastavené" if stopped else "Dokončené", done=stats["improved"] + stats["failed"] + stats["skipped"])
        _SMART_THUMB_PROGRESS["finished_epoch"] = time.time()
        report.update(finished_at=datetime.now(timezone.utc).replace(tzinfo=None).isoformat(), **stats,
                      failed_items=failed_items[:100])
        _LAST_RETHUMB_REPORT = report
    return stats


# ── Metadata backfill ──────────────────────────────────────────────────────────
def _quality_from_dims(height: int, width: int = 0) -> str:
    """Quality label from the SHORTER side so portrait clips read correctly:
    a 1080x1920 vertical video is FHD (1080p), not 2K."""
    h = int(height or 0)
    w = int(width or 0)
    short = min(w, h) if (w and h) else h
    if short >= 2160: return "4K"
    if short >= 1440: return "2K"
    if short >= 1080: return "FHD"
    if short >= 720:  return "HD"
    if short >= 480:  return "SD"
    return "SD"


def _height_to_quality(h: int) -> str:
    return _quality_from_dims(h)


def _video_needs_metadata(v: Video) -> bool:
    """A playable video that's missing duration or resolution."""
    if (v.url or "").strip() == "" and (v.source_url or "").strip() == "":
        return False
    return (not v.duration) or (not v.height)


def metadata_backfill_candidates(db: Session, batch_name: str = "", limit: int = 1000) -> list[Video]:
    q = db.query(Video).filter(
        or_(Video.duration == None, Video.duration == 0,
            Video.height == None, Video.height == 0)
    )
    if batch_name:
        q = q.filter(Video.batch_name == batch_name)
    rows = q.order_by(Video.id.desc()).limit(limit).all()
    return [v for v in rows if _video_needs_metadata(v)]


async def _resolve_video_metadata(video: Video) -> dict:
    """Resolve duration/height/width/size_bytes for one existing video.

    - Re-signs a fresh CDN stream for expiring hosts (Turbo/CyberDrop/Bunkr/Filester).
    - ffprobe for duration+resolution (works for all IP-open hosts, now that the
      subprocess call is loop-agnostic).
    - Coomer CDN is IP-locked from the server → read the MP4 moov atom + size over
      HTTP range instead (same technique the tester uses).
    """
    out = {"duration": float(video.duration or 0), "height": int(video.height or 0),
           "width": int(video.width or 0), "size_bytes": 0}

    stream = (video.url or "").strip()
    src = (video.source_url or "").strip()
    referer = None

    # Coomer: ffprobe can't reach the IP-locked CDN — use the moov-atom probe.
    low = (stream or src).lower()
    if "coomerfans.com" in low:
        try:
            import httpx
            from app.routers.link_tester import _probe_mp4_http, _COOMER_REFERER
            probe_url = stream if stream.lower().endswith((".mp4", ".m4v", ".mov", ".webm")) else ""
            if probe_url:
                async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0),
                                             follow_redirects=True, verify=False) as client:
                    head = await client.get(probe_url, headers={
                        "User-Agent": _HTTP_UA, "Referer": _COOMER_REFERER, "Range": "bytes=0-0"})
                    size_bytes = 0
                    cr = head.headers.get("content-range", "")
                    if "/" in cr:
                        size_bytes = int(cr.rsplit("/", 1)[-1] or 0)
                    probed = await _probe_mp4_http(client, probe_url, size_bytes, _COOMER_REFERER)
                    out["duration"] = float(probed.get("duration") or out["duration"] or 0)
                    out["height"] = int(probed.get("height") or out["height"] or 0)
                    out["width"] = int(probed.get("width") or out["width"] or 0)
                    out["size_bytes"] = size_bytes
        except Exception as exc:
            logging.info("meta-backfill: coomer probe failed for %s: %s", video.id, exc)
        return out

    # Everyone else: get a fresh stream (if the host's URL expires) then ffprobe.
    fresh, fresh_ref = await _fresh_stream_for_thumb(video)
    if fresh:
        stream, referer = fresh, fresh_ref
    if not stream:
        return out
    if referer is None:
        try:
            from urllib.parse import urlparse as _up
            p = _up(src or stream)
            if p.scheme and p.netloc:
                referer = f"{p.scheme}://{p.netloc}/"
        except Exception:
            referer = None

    try:
        from app.services import VIPVideoProcessor
        proc = VIPVideoProcessor()
        ff = await proc._ffprobe_fallback(
            stream, {"duration": out["duration"], "height": out["height"], "width": out["width"]},
            referer=referer)
        out["duration"] = float(ff.get("duration") or out["duration"] or 0)
        out["height"] = int(ff.get("height") or out["height"] or 0)
        out["width"] = int(ff.get("width") or out["width"] or 0)
    except Exception as exc:
        logging.info("meta-backfill: ffprobe failed for %s: %s", video.id, exc)

    # Size via HEAD/Range if still unknown.
    if not out["size_bytes"] and not video.file_size_mb:
        try:
            import httpx
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=6.0),
                                         follow_redirects=True, verify=False) as client:
                h = {"User-Agent": _HTTP_UA}
                if referer:
                    h["Referer"] = referer
                r = await client.get(stream, headers={**h, "Range": "bytes=0-0"})
                cr = r.headers.get("content-range", "")
                _sz = 0
                if "/" in cr:
                    _sz = int(cr.rsplit("/", 1)[-1] or 0)
                elif r.headers.get("content-length"):
                    _sz = int(r.headers["content-length"])
                # Ignore tiny responses — a dead CDN link answers with a small
                # HTML error page, not a real video.
                if _sz >= 10240:
                    out["size_bytes"] = _sz
        except Exception:
            pass

    # Direct-MP4 moov fallback: some CDNs (Bunkr cdn.cr, …) refuse ffprobe but
    # serve HTTP range requests. Read the moov atom directly for duration+resolution.
    if (not out["duration"] or not out["height"]) and \
            re.search(r"\.(mp4|m4v|mov)(?:[?#]|$)", stream, re.I):
        try:
            import httpx
            from app.routers.link_tester import _probe_mp4_http
            async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0),
                                         follow_redirects=True, verify=False) as client:
                size = out["size_bytes"]
                if not size:
                    h = {"User-Agent": _HTTP_UA}
                    if referer:
                        h["Referer"] = referer
                    rr = await client.get(stream, headers={**h, "Range": "bytes=0-0"})
                    cr = rr.headers.get("content-range", "")
                    if "/" in cr:
                        size = int(cr.rsplit("/", 1)[-1] or 0)
                    out["size_bytes"] = size or out["size_bytes"]
                if size:
                    probed = await _probe_mp4_http(client, stream, size, referer or "")
                    out["duration"] = float(probed.get("duration") or out["duration"] or 0)
                    out["height"] = int(probed.get("height") or out["height"] or 0)
                    out["width"] = int(probed.get("width") or out["width"] or 0)
        except Exception as exc:
            logging.info("meta-backfill: moov probe failed for %s: %s", video.id, exc)

    return out


_HTTP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
_METADATA_BACKFILL_RUNNING = False


async def metadata_backfill_videos(videos: list[Video], concurrency: int = 6) -> dict:
    """Re-resolve and persist duration/height/quality/size for existing videos."""
    global _METADATA_BACKFILL_RUNNING
    _METADATA_BACKFILL_RUNNING = True

    from app.websockets import manager
    from app.database import SessionLocal

    stats = {"scanned": len(videos), "improved": 0, "failed": 0, "unchanged": 0}
    sem = asyncio.Semaphore(max(1, int(concurrency or 6)))

    def _broadcast(payload: dict):
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(manager.broadcast(json.dumps(payload)), loop)
        except Exception:
            pass

    try:
        _broadcast({"type": "metadata_backfill_start", "total": len(videos)})

        async def _one(video: Video):
            async with sem:
                vid_id = video.id
                try:
                    meta = await _resolve_video_metadata(video)
                    wdb = SessionLocal()
                    try:
                        v = wdb.query(Video).get(vid_id)
                        if not v:
                            stats["failed"] += 1
                            return
                        changed = False
                        if meta["duration"] and abs(float(v.duration or 0) - meta["duration"]) > 0.5:
                            v.duration = meta["duration"]; changed = True
                        if meta["height"] and int(v.height or 0) != meta["height"]:
                            v.height = meta["height"]
                            v.width = meta["width"] or v.width
                            changed = True
                        # Recompute quality from the (possibly just-updated) dims —
                        # also corrects mislabels like a 1080x1920 portrait as "2K".
                        _correct_q = _quality_from_dims(v.height or 0, v.width or 0)
                        if (v.height or 0) and v.quality != _correct_q:
                            v.quality = _correct_q
                            changed = True
                        if meta["size_bytes"] and not v.file_size_mb:
                            v.file_size_mb = round(meta["size_bytes"] / (1024 * 1024), 2)
                            changed = True
                        if changed:
                            wdb.commit()
                            stats["improved"] += 1
                            _broadcast({"type": "metadata_updated", "video_id": vid_id,
                                        "duration": v.duration, "height": v.height,
                                        "quality": v.quality})
                        else:
                            stats["unchanged"] += 1
                    finally:
                        wdb.close()
                except Exception as exc:
                    logging.warning("metadata_backfill failed for %s: %s", vid_id, exc)
                    stats["failed"] += 1
                _broadcast({"type": "metadata_backfill_progress",
                            "done": stats["improved"] + stats["failed"] + stats["unchanged"],
                            "total": len(videos)})

        await asyncio.gather(*[_one(v) for v in videos], return_exceptions=True)
        _broadcast({"type": "metadata_backfill_done", **stats})
    except Exception as exc:
        logging.error("metadata_backfill_videos crashed: %s", exc)
    finally:
        _METADATA_BACKFILL_RUNNING = False
    return stats
