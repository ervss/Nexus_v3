from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session
from typing import Any, List, Optional
from pydantic import BaseModel
import re
import os
import datetime
import time
import urllib.parse
import hashlib
import httpx
import logging
import asyncio

from app.database import get_db, SessionLocal, Video, VideoSource
from app.media_match import MediaFacts, looks_like_same_video
from app.media_urls import is_pimpbunny_remote_media
from app.source_catalog import classify_library_source_name
from app.services import VIPVideoProcessor
from app.extractors.bunkr import BunkrExtractor
from app.extractors.beeg import BeegExtractor
from app.extractors.camwhores import CamwhoresExtractor
from app.extractors.archivebate import ArchivebateExtractor
from app.extractors.recurbate import RecurbateExtractor
from app.extractors.erome import EromeExtractor
from app.extractors.oneporn import OnePornExtractor
from app.extractors.turbo import TurboExtractor
from app.extractors.bigporn import BigPornExtractor
from app.extractors.baddiehub import BaddieHubExtractor
from app.extractors.xgroovy import XGroovyExtractor
from app.extractors.pimpbunny import PimpBunnyExtractor
from app.extractors.redtube import RedTubeExtractor
from app.routers.extension_bridge import ensure_bridge_token

router = APIRouter()

# Clips shorter than this are discarded on import — not worth the storage, and we
# don't waste time/bandwidth probing thumbnails/size for them.
MIN_DURATION_SECONDS = 10


def is_explicit_fapfolder_media(url: str, source_url: str, tags: str) -> bool:
    """Keep short files explicitly selected in the authenticated gallery tool."""
    host = (urllib.parse.urlparse(str(source_url or "")).hostname or "").lower()
    return bool(
        (host == "fapfolder.club" or host.endswith(".fapfolder.club"))
        and re.search(r"\.(mp4|webm|mov|mkv)(\?|$)", str(url or ""), re.I)
        and "extension" in str(tags or "").split(",")
    )


def _has_expired_epoch_parameter(url: str, now: Optional[float] = None) -> bool:
    """Some CDNs use e=28800 as duration, not as an expiry timestamp."""
    current_time = now if now is not None else time.time()
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    except ValueError:
        return False
    for key in ("e", "exp", "expires", "expiry"):
        for raw in query.get(key, []):
            try:
                expiry = float(raw)
            except (TypeError, ValueError):
                continue
            if expiry >= 1e12:
                expiry /= 1000
            if expiry >= 1e9 and expiry < current_time:
                return True
    return False


_remote_thumb_slots = None
_ffmpeg_thumb_slots = None


def _background_slot(kind: str) -> asyncio.Semaphore:
    """Cap thumbnail work started after a bulk import returns.

    Starlette runs BackgroundTasks one after another, so these coroutines are
    scheduled on the event loop instead. The semaphore keeps a few downloads
    in flight without opening one ffmpeg per imported file.
    """
    global _remote_thumb_slots, _ffmpeg_thumb_slots
    if kind == "ffmpeg":
        if _ffmpeg_thumb_slots is None:
            _ffmpeg_thumb_slots = asyncio.Semaphore(2)
        return _ffmpeg_thumb_slots
    if _remote_thumb_slots is None:
        _remote_thumb_slots = asyncio.Semaphore(4)
    return _remote_thumb_slots

class BulkImportVideo(BaseModel):
    url: str
    title: Optional[str] = None
    source_url: Optional[str] = None
    # Fresh browser-resolved media URL. The stable watch page remains in
    # source_url for future refreshes.
    direct_url: Optional[str] = None
    # Alternate hoster pages (lulustream/vidara/...) found by the extension.
    # Stored as VideoSource rows so playback can mint fresh tokens later.
    mirror_urls: Optional[List[str]] = None
    # A discovery page (profile/folder) is shared by many distinct videos.
    source_scope: str = "auto"
    thumbnail: Optional[str] = None
    filesize: Optional[Any] = 0
    file_size_mb: Optional[Any] = None
    quality: Optional[Any] = 0  # may arrive as "720p", "HD", or int
    duration: Optional[Any] = 0  # may arrive as "0:16" string or seconds float
    height: Optional[int] = 0   # explicit pixel height from extension
    width: Optional[int] = 0
    tags: Optional[str] = ""
    views: Optional[Any] = 0
    upload_date: Optional[str] = ""
    # Some protected viewer pages (notably FileDitch) cannot provide a durable
    # poster to the extension. Request a fresh local frame after the row exists.
    auto_rethumb: bool = False

    def quality_px(self) -> int:
        q = self.quality
        if isinstance(q, int): return q
        if isinstance(q, float): return int(q)
        if isinstance(q, str):
            m = re.search(r'\d+', q)
            return int(m.group()) if m else 0
        return 0

    def duration_secs(self) -> float:
        d = self.duration
        if isinstance(d, (int, float)): return float(d)
        if isinstance(d, str):
            d_clean = d.lower().strip()
            # If duration has "min" or "m" and no colon, it's likely minutes
            if ('min' in d_clean or ('m' in d_clean and 'h' not in d_clean)) and ':' not in d_clean:
                try:
                    import re
                    nums = re.findall(r'[\d.]+', d_clean)
                    if nums:
                        val = float(nums[0])
                        return float(round(val * 60))
                except Exception:
                    pass

            parts = [p for p in d.replace(',', ':').split(':') if p.strip()]
            try:
                import re
                cleaned_parts = []
                for p in parts:
                    nums = re.findall(r'\d+', p)
                    if nums:
                        cleaned_parts.append(int(nums[0]))
                    else:
                        cleaned_parts.append(0)
                
                if len(cleaned_parts) == 3: return float(cleaned_parts[0]*3600 + cleaned_parts[1]*60 + cleaned_parts[2])
                if len(cleaned_parts) == 2: return float(cleaned_parts[0]*60 + cleaned_parts[1])
                if len(cleaned_parts) == 1: return float(cleaned_parts[0])
            except: pass
        return 0.0

    def filesize_bytes(self) -> int:
        if self.file_size_mb is not None:
            try:
                val = float(str(self.file_size_mb).strip().replace(",", "."))
                if val > 0:
                    return int(val * 1024 * 1024)
            except Exception:
                pass
        s = self.filesize
        if isinstance(s, (int, float)):
            return int(s)
        if isinstance(s, str):
            t = s.strip().upper().replace(",", ".")
            try:
                m = re.search(r"([\d.]+)\s*(TB|GB|MB|KB|B)?", t)
                if not m:
                    return int(float(re.sub(r"[^\d.]", "", t)))
                val = float(m.group(1))
                unit = (m.group(2) or "B").upper()
                mult = {
                    "B": 1,
                    "KB": 1024,
                    "MB": 1024 * 1024,
                    "GB": 1024 * 1024 * 1024,
                    "TB": 1024 * 1024 * 1024 * 1024,
                }
                return int(val * mult.get(unit, 1))
            except Exception:
                return 0
        return 0

class BulkImportRequest(BaseModel):
    batch_name: str = "Bulk Import"
    videos: List[BulkImportVideo]


async def _background_localize_remote_thumbnail(
    video_id: int,
    thumbnail_url: str,
    referer: Optional[str] = None,
    filename_prefix: str = "thumb",
) -> None:
    if not thumbnail_url or not thumbnail_url.startswith("http"):
        return

    async with _background_slot("remote"):
        await _localize_remote_thumbnail_limited(video_id, thumbnail_url, referer, filename_prefix)


async def _localize_remote_thumbnail_limited(
    video_id: int,
    thumbnail_url: str,
    referer: Optional[str] = None,
    filename_prefix: str = "thumb",
) -> None:
    db = SessionLocal()
    try:
        video = db.query(Video).get(video_id)
        if not video:
            return

        current_thumb = str(video.thumbnail_path or "").strip()
        if current_thumb.startswith("/static/"):
            return

        # Do not keep a database connection checked out while downloading from
        # a remote host. Large imports schedule many of these jobs at once.
        db.close()
        db = None

        thumb_dir = os.path.join("app", "static", "thumbnails")
        os.makedirs(thumb_dir, exist_ok=True)

        thumb_hash = hashlib.md5(f"{video_id}|{thumbnail_url}".encode("utf-8", errors="ignore")).hexdigest()
        thumb_filename = f"{filename_prefix}_{thumb_hash}.jpg"
        thumb_path = os.path.join(thumb_dir, thumb_filename)

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Accept": "image/*",
        }
        if referer:
            headers["Referer"] = referer

        async with httpx.AsyncClient(timeout=10, follow_redirects=True, verify=False) as client:
            resp = await client.get(thumbnail_url, headers=headers)
            if resp.status_code != 200 or not resp.content:
                return
            with open(thumb_path, "wb") as f:
                f.write(resp.content)

        db = SessionLocal()
        video = db.get(Video, video_id)
        if video:
            video.thumbnail_path = f"/static/thumbnails/{thumb_filename}"
            db.commit()
            logging.info("[Thumb-bg] localized thumbnail for video_id=%s -> %s", video_id, video.thumbnail_path)
    except Exception as exc:
        logging.warning("[Thumb-bg] failed for video_id=%s url=%s error=%s", video_id, thumbnail_url[:180], exc)
    finally:
        if db is not None:
            db.close()

async def _background_ffmpeg_thumbnail(
    video_id: int,
    stream_url: str,
    duration: float = 0,
    referer: Optional[str] = None,
    source_url: Optional[str] = None,
) -> None:
    """Generate thumbnail: FFmpeg from stream URL, or og:image scrape as fallback."""
    async with _background_slot("ffmpeg"):
        await _ffmpeg_thumbnail_limited(video_id, stream_url, duration, referer, source_url)


async def _ffmpeg_thumbnail_limited(
    video_id: int,
    stream_url: str,
    duration: float = 0,
    referer: Optional[str] = None,
    source_url: Optional[str] = None,
) -> None:
    db = SessionLocal()
    try:
        video = db.query(Video).get(video_id)
        if not video:
            return
        current_thumb = str(video.thumbnail_path or "").strip()
        if current_thumb.startswith("/static/thumbnails/thumb_"):
            return
        video_source_url = video.source_url

        # FFmpeg/network fallbacks can take minutes. Release this connection
        # before doing that work so a batch cannot exhaust SQLAlchemy's pool.
        db.close()
        db = None

        from app.services import THUMB_DIR, FFMPEG_CMD, FFMPEG_NETWORK_ARGS
        import os as _os

        thumb_out = _os.path.join(THUMB_DIR, f"thumb_{video_id}.jpg")
        if _os.path.exists(thumb_out):
            _os.remove(thumb_out)

        # FileDitch's public viewer and CDN hosts rotate.  Re-fetch the stable
        # viewer page to get a fresh CDN URL before running FFmpeg.
        from app.extractors.filester import is_fileditch_url
        _fdf_host = is_fileditch_url(stream_url)
        _fdf_src = source_url or video_source_url or ""
        if _fdf_host or is_fileditch_url(_fdf_src):
            _page_url = _fdf_src if is_fileditch_url(_fdf_src) else ""
            if _page_url:
                try:
                    from app.extractors.filester import FilesterExtractor
                    _fdf_extractor = FilesterExtractor()
                    _fdf_meta = await _fdf_extractor.extract(_page_url)
                    if _fdf_meta and _fdf_meta.get("stream_url"):
                        stream_url = _fdf_meta["stream_url"]
                        logging.info("[FFmpeg-thumb-bg] FileDitch fresh CDN URL for video_id=%s", video_id)
                except Exception as _e:
                    logging.warning("[FFmpeg-thumb-bg] FileDitch re-fetch failed video_id=%s: %s", video_id, _e)

        _sxyprn_src = source_url or video_source_url or ""
        if "sxyprn." in _sxyprn_src.lower():
            try:
                from app.extractors.sxyprn import SxyPrnExtractor
                from app.sxyprn_playback import probe_media, provider_referer
                fresh_meta = await SxyPrnExtractor().extract(_sxyprn_src)
                fresh_url = str((fresh_meta or {}).get("stream_url") or "").strip()
                fresh_referer = provider_referer(fresh_url, _sxyprn_src)
                if fresh_url and await probe_media(fresh_url, fresh_referer):
                    stream_url = fresh_url
                    referer = fresh_referer
                    thumb_db = SessionLocal()
                    try:
                        current_video = thumb_db.get(Video, video_id)
                        if current_video and current_video.url != fresh_url:
                            current_video.url = fresh_url
                            thumb_db.commit()
                    finally:
                        thumb_db.close()
                    logging.info("[FFmpeg-thumb-bg] refreshed SxyPrn stream for video_id=%s", video_id)
            except Exception as refresh_error:
                logging.warning(
                    "[FFmpeg-thumb-bg] SxyPrn re-fetch failed video_id=%s: %s",
                    video_id, refresh_error,
                )

        # Skip only URLs with an expired Unix timestamp, not duration params such as tnmr's e=28800.
        is_expired_cdn = _has_expired_epoch_parameter(stream_url)

        if not is_expired_cdn:
            headers_str = "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n"
            source_page = source_url or video_source_url or ""
            referer = referer or source_page
            if "sxyprn." in source_page.lower():
                from app.sxyprn_playback import provider_headers
                headers = provider_headers(stream_url, referer)
                headers_str = "".join(f"{key}: {value}\r\n" for key, value in headers.items())
                referer = headers["Referer"]
            elif referer:
                headers_str += f"Referer: {referer}\r\n"

            seek = str(max(3.0, duration * 0.1)) if duration > 10 else "3"
            cmds = [
                [FFMPEG_CMD, '-y', '-hide_banner', '-loglevel', 'error']
                + FFMPEG_NETWORK_ARGS
                + ['-headers', headers_str, '-ss', seek, '-i', stream_url,
                   '-vf', 'scale=640:-1', '-vframes', '1', '-q:v', '4', thumb_out],
                [FFMPEG_CMD, '-y', '-hide_banner', '-loglevel', 'error']
                + FFMPEG_NETWORK_ARGS
                + ['-headers', headers_str, '-i', stream_url,
                   '-vf', 'thumbnail,scale=640:-1', '-frames:v', '1', thumb_out],
            ]
            from app.services import run_subprocess_capture
            for cmd in cmds:
                if _os.path.exists(thumb_out):
                    break
                try:
                    await run_subprocess_capture(cmd, timeout=60)
                except Exception as e:
                    logging.warning("[FFmpeg-thumb-bg] cmd failed for video_id=%s: %s", video_id, e)

        # Fallback: scrape og:image from post page (no token needed)
        if not _os.path.exists(thumb_out):
            _src = source_url or video_source_url
            if _src and ("coomerfans.com" in _src or "sxyprn." in _src.lower()) \
                    and not re.search(r'https?://img\d+\.coomerfans\.com/', _src):
                try:
                    page_referer = "https://coomerfans.com/" if "coomerfans.com" in _src else "https://www.sxyprn.net/"
                    async with httpx.AsyncClient(timeout=15, follow_redirects=True, verify=False) as client:
                        resp = await client.get(_src, headers={
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            "Referer": page_referer
                        })
                        if resp.status_code == 200:
                            from bs4 import BeautifulSoup
                            soup = BeautifulSoup(resp.text, "html.parser")
                            image = soup.find("meta", property="og:image")
                            image_url = str(image.get("content") or "").strip() if image else ""
                            if not image_url:
                                poster = soup.find("video")
                                image_url = str((poster or {}).get("poster") or "").strip()
                            if image_url:
                                image_url = urllib.parse.urljoin(_src, image_url)
                                img_referer = "https://coomerfans.com/" if "coomerfans.com" in _src else _src
                                img_resp = await client.get(image_url, headers={"Referer": img_referer})
                                if img_resp.status_code == 200 and img_resp.content:
                                    with open(thumb_out, "wb") as f:
                                        f.write(img_resp.content)
                                    logging.info("[FFmpeg-thumb-bg] page image fallback saved for video_id=%s", video_id)
                except Exception as e:
                    logging.warning("[FFmpeg-thumb-bg] page image fallback failed for video_id=%s: %s", video_id, e)

        if _os.path.exists(thumb_out):
            db = SessionLocal()
            video = db.get(Video, video_id)
            if video:
                video.thumbnail_path = f"/static/thumbnails/thumb_{video_id}.jpg"
                db.commit()
                logging.info("[FFmpeg-thumb-bg] thumbnail saved for video_id=%s", video_id)
        else:
            logging.warning("[FFmpeg-thumb-bg] no output for video_id=%s url=%s", video_id, stream_url[:80])
    except Exception as exc:
        logging.warning("[FFmpeg-thumb-bg] error for video_id=%s: %s", video_id, exc)
    finally:
        if db is not None:
            db.close()


@router.post("/api/v1/import/bulk")
async def import_bulk(req: BulkImportRequest, bg_tasks: BackgroundTasks, db: Session = Depends(get_db), x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token")):
    """
    Bulk import pre-scraped video metadata from extensions (gofile explorer, etc.).
    Each video entry already has direct URL + metadata — no yt-dlp needed.
    """
    ensure_bridge_token(x_nexus_token)

    def _normalize_video_url(value: Optional[str]) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        try:
            parsed = urllib.parse.urlparse(raw)
            if not parsed.scheme or not parsed.netloc:
                return raw.rstrip("/")
            scheme = parsed.scheme.lower()
            host = parsed.netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            path = re.sub(r"/+", "/", parsed.path or "/").rstrip("/") or "/"
            return urllib.parse.urlunparse((scheme, host, path, "", parsed.query, ""))
        except Exception:
            return raw.rstrip("/")

    def _find_existing_video(url_value: Optional[str], source_value: Optional[str], source_scope: str = "auto") -> Optional[Video]:
        candidates = {
            _normalize_video_url(url_value),
        }
        source_norm = _normalize_video_url(source_value)
        # Prevent deduplication via album URLs, which are shared across multiple distinct videos
        if source_norm and source_scope != "collection" and not re.search(r"/(a|albums?|playlists?|users?|channels?|profiles?|models?|pornstars?)(?:/|$)", urllib.parse.urlparse(source_norm).path.lower()):
            candidates.add(source_norm)

        candidates.discard("")
        if not candidates:
            return None
        # One prefetch for the whole request. A miss means the URL was not in
        # the library at the start of this batch, so we do not query again.
        cached = getattr(_find_existing_video, "_cache", None)
        if isinstance(cached, dict):
            for key in candidates:
                row = cached.get(key)
                if row is not None:
                    return row
            return None
        rows = db.query(Video).filter(
            (Video.url.in_(list(candidates))) | (Video.source_url.in_(list(candidates)))
        ).all()
        for row in rows:
            if _normalize_video_url(row.url) in candidates or _normalize_video_url(row.source_url) in candidates:
                return row
        return None

    _mirror_rows: dict = {}

    def _find_cross_host_match(v: "BulkImportVideo") -> Optional[Video]:
        """Same "same upload, different host" check as the dashboard/Source
        Boards intake path (see IntakeWorker._find_cross_host_match in
        intake.py) — kept in sync there since this router builds Video rows
        through its own code path rather than the shared intake worker.
        """
        title = (v.title or "").strip()
        size_mb = float(v.file_size_mb or (v.filesize_bytes() / (1024 * 1024) if v.filesize_bytes() else 0) or 0)
        duration = v.duration_secs()
        if not title and not size_mb and not duration:
            return None
        candidate = MediaFacts.from_fields(
            title=title, url=v.url, thumbnail=v.thumbnail or "",
            size_bytes=size_mb * 1024 * 1024, duration=duration, height=v.height,
        )
        if not candidate.name and not candidate.thumb_fp and not (candidate.size_bytes and candidate.duration_sec):
            return None

        query = db.query(Video).filter(Video.status != "error")
        if size_mb > 0:
            query = query.filter(Video.file_size_mb.between(size_mb * 0.97, size_mb * 1.03))
        elif duration > 0:
            query = query.filter(Video.duration.between(duration - 5, duration + 5))
        else:
            return None

        cache_key = ("size", round(size_mb, 2)) if size_mb > 0 else ("dur", int(duration))
        rows = _mirror_rows.get(cache_key)
        if rows is None:
            rows = query.limit(80).all()
            _mirror_rows[cache_key] = rows
        for row in rows:
            row_facts = MediaFacts.from_fields(
                title=row.title or "", url=row.url or "",
                thumbnail=row.original_thumbnail_url or row.thumbnail_path or "",
                size_bytes=(row.file_size_mb or 0) * 1024 * 1024,
                duration=row.duration or 0, height=row.height or 0,
            )
            if looks_like_same_video(candidate, row_facts):
                return row
        return None

    def _attach_mirror(existing: Video, v: "BulkImportVideo") -> None:
        already = db.query(VideoSource).filter(VideoSource.video_id == existing.id).count()
        if already == 0 and existing.url:
            db.add(VideoSource(
                video_id=existing.id, url=existing.url, source_url=existing.source_url,
                label=classify_library_source_name(existing.url, existing.source_url),
                quality=existing.quality, height=existing.height or 0,
                size_mb=existing.file_size_mb or 0, is_primary=True,
                link_status=existing.link_status or "unknown",
            ))
        dup = db.query(VideoSource).filter(
            VideoSource.video_id == existing.id, VideoSource.url == v.url,
        ).first()
        if dup:
            return
        db.add(VideoSource(
            video_id=existing.id, url=v.url, source_url=v.source_url or v.url,
            label=classify_library_source_name(v.url, v.source_url),
            quality=str(v.quality or ""), height=int(v.height or 0),
            size_mb=float(v.file_size_mb or 0), is_primary=False,
        ))
        db.commit()

    def _estimate_xgroovy_size_bytes(stream_value: str, duration_value: float) -> int:
        if not stream_value or not duration_value or duration_value < 5:
            return 0
        match = re.search(r"[?&]br=(\d{2,6})", stream_value, re.I)
        if not match:
            return 0
        try:
            return int(int(match.group(1)) * 1000 * float(duration_value) / 8)
        except Exception:
            return 0

    async def _head_content_length(url: str, referer: Optional[str]) -> int:
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "*/*",
            }
            if referer:
                headers["Referer"] = referer
            async with httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False) as client:
                resp = await client.head(url, headers=headers)
                content_len = resp.headers.get("Content-Length")
                if content_len and str(content_len).isdigit():
                    return int(content_len)
                # Niektoré CDN ignorujú HEAD, skúšame malé GET
                headers["Range"] = "bytes=0-0"
                resp = await client.get(url, headers=headers)
                content_range = resp.headers.get("Content-Range", "")
                m = re.search(r"/(\d+)$", content_range)
                if m:
                    return int(m.group(1))
                content_len = resp.headers.get("Content-Length")
                if content_len and str(content_len).isdigit():
                    return int(content_len)
        except Exception:
            pass
        return 0

    def _has_strong_filester_metadata(title_value: str, duration_value: float, height_value: int, filesize_value: int) -> bool:
        clean_title = str(title_value or "").strip().lower()
        return bool(
            clean_title
            and not clean_title.startswith("queued")
            and duration_value > 0
            and height_value >= 480
            and filesize_value > 0
        )

    def _has_strong_pimpbunny_metadata(title_value: str, duration_value: float, height_value: int, filesize_value: int, thumbnail_value: Optional[str]) -> bool:
        clean_title = str(title_value or "").strip().lower()
        thumb = str(thumbnail_value or "").strip()
        return bool(
            clean_title
            and not clean_title.startswith("queued")
            and duration_value > 0
            and height_value >= 720
            and filesize_value > 0
            and thumb
        )

    def _is_direct_media_url(url_value: Optional[str]) -> bool:
        low = str(url_value or "").strip().lower()
        return is_pimpbunny_remote_media(low) or bool(re.search(r"\.(mp4|webm|mov|mkv|m3u8|mpd)(\?|$)", low))

    def _coerce_views(value: Any) -> int:
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            m = re.search(r"([\d.,]+)\s*([km])?", value.strip(), re.I)
            if not m:
                return 0
            try:
                num = float(m.group(1).replace(",", ""))
            except ValueError:
                return 0
            suffix = (m.group(2) or "").lower()
            if suffix == "m":
                num *= 1_000_000
            elif suffix == "k":
                num *= 1_000
            return int(num)
        return 0

    def _is_xhamster_cdn_url(url_value: Optional[str]) -> bool:
        low = str(url_value or "").strip().lower()
        return "xhcdn.com/key=" in low or re.search(r"https?://video\d+\.xhcdn\.com/key=", low) is not None

    def _is_xhamster_watch_url(url_value: Optional[str]) -> bool:
        low = str(url_value or "").strip().lower()
        return bool(re.search(r"https?://([^/]+\.)?xhamster(?:-fr)?\.com/videos/", low) or "xhamster.desi/videos/" in low)

    def _has_strong_erome_metadata(title_value: str, thumbnail_value: Optional[str], duration_value: float, height_value: int) -> bool:
        clean_title = str(title_value or "").strip().lower()
        thumb = str(thumbnail_value or "").strip()
        return bool(
            clean_title
            and not clean_title.startswith("queued")
            and clean_title not in {"erome", "video"}
            and thumb
            and (duration_value > 0 or height_value >= 480)
        )

    new_ids = []
    results = []
    process_ids = []
    skipped = []
    thumb_uploads = []  # [{id, url}] returned to extension for browser-side upload
    processor = VIPVideoProcessor()
    bunkr_extractor = BunkrExtractor()
    beeg_extractor = BeegExtractor()
    camwhores_extractor = CamwhoresExtractor()
    archivebate_extractor = ArchivebateExtractor()
    oneporn_extractor = OnePornExtractor()
    recurbate_extractor = RecurbateExtractor()
    erome_extractor = EromeExtractor()
    turbo_extractor = TurboExtractor()
    bigporn_extractor = BigPornExtractor()
    xgroovy_extractor = XGroovyExtractor()
    pimpbunny_extractor = PimpBunnyExtractor()
    redtube_extractor = RedTubeExtractor()
    filester_extractor = None
    total_incoming = len(req.videos)
    logging.info("[BulkImport] batch=%r received %d item(s)", req.batch_name, total_incoming)
    existing_index = {}
    raw_urls = []
    seen_raw = set()
    for video in req.videos:
        for value in (video.url, video.source_url):
            text = str(value or "").strip()
            if text and text not in seen_raw:
                seen_raw.add(text)
                raw_urls.append(text)
    for offset in range(0, len(raw_urls), 400):
        chunk = raw_urls[offset:offset + 400]
        matched = db.query(Video).filter(
            (Video.url.in_(chunk)) | (Video.source_url.in_(chunk))
        ).all()
        for row in matched:
            for value in (row.url, row.source_url):
                key = _normalize_video_url(value)
                if key and key not in existing_index:
                    existing_index[key] = row
    _find_existing_video._cache = existing_index
    thumb_jobs = []
    for _idx, v in enumerate(req.videos, 1):
        def record_result(status, video_id=None, reason=None):
            result = {"index": _idx - 1, "url": v.url, "source_url": v.source_url or v.url, "status": status}
            if video_id is not None:
                result["video_id"] = video_id
            if reason:
                result["reason"] = reason
            results.append(result)

        existing = _find_existing_video(v.url, v.source_url or v.url, v.source_scope)
        if existing:
            record_result("duplicate", existing.id)
            continue

        # Not an exact URL repeat — check whether it's the same upload on a
        # different host (same filename, or matching thumbnail/size/duration)
        # before importing it as a near-duplicate card.
        mirror_of = _find_cross_host_match(v)
        if mirror_of:
            _attach_mirror(mirror_of, v)
            record_result("mirror_attached", mirror_of.id)
            continue

        # Early discard: the caller already told us it's a sub-10s clip → skip
        # before any extraction/probe so we spend zero time or bandwidth on it.
        _incoming_dur = v.duration_secs()
        preserve_short_clip = is_explicit_fapfolder_media(v.url, v.source_url, v.tags)
        if 0 < _incoming_dur < MIN_DURATION_SECONDS and not preserve_short_clip:
            skipped.append({"url": v.url, "reason": "too_short"})
            record_result("skipped", reason="too_short")
            continue

        logging.info("[BulkImport] (%d/%d) resolving: %s", _idx, total_incoming, (v.title or v.url or "")[:90])

        title = v.title or "Queued..."
        stream_url = v.url
        source_url = v.source_url or v.url
        thumbnail = v.thumbnail
        duration = v.duration_secs()
        height = int(v.height or 0) or v.quality_px()
        width = int(v.width or 0)
        filesize = v.filesize_bytes()
        status = "pending"
        deferred_thumbnail_url = None
        deferred_thumbnail_referer = None
        deferred_thumbnail_prefix = "thumb"

        # The RedTube content script resolves /media/mp4 in the browser.  The
        # old request model silently discarded that value, leaving only a watch
        # page for the backend to process.  Store the browser-resolved stream
        # immediately and retain the stable watch URL as source_url.
        is_redtube = redtube_extractor.can_handle(stream_url or "") or redtube_extractor.can_handle(source_url or "")
        if is_redtube:
            redtube_page = source_url if redtube_extractor.can_handle(source_url or "") else stream_url
            browser_stream = str(v.direct_url or "").strip()
            if browser_stream and _is_direct_media_url(browser_stream):
                stream_url = browser_stream
                source_url = redtube_page
                status = "ready_to_stream"
                logging.info("[RedTube-import] using browser-resolved stream for %s", (redtube_page or "")[:120])
            else:
                try:
                    meta_rt = await redtube_extractor.extract(redtube_page)
                    resolved_stream = str((meta_rt or {}).get("stream_url") or "").strip()
                    if resolved_stream:
                        stream_url = resolved_stream
                        source_url = str((meta_rt or {}).get("source_url") or redtube_page).strip() or redtube_page
                        status = "ready_to_stream"
                    if (not title or title.lower().startswith("queued")) and (meta_rt or {}).get("title"):
                        title = str(meta_rt["title"]).strip()
                    if not thumbnail and (meta_rt or {}).get("thumbnail"):
                        thumbnail = str(meta_rt["thumbnail"]).strip()
                    duration = duration or float((meta_rt or {}).get("duration") or 0)
                    width = width or int((meta_rt or {}).get("width") or 0)
                    height = height or int((meta_rt or {}).get("height") or 0)
                    filesize = filesize or int((meta_rt or {}).get("size_bytes") or 0)
                except Exception as exc:
                    logging.warning("[RedTube-import] extraction failed for %s: %s", redtube_page, exc)

        if _is_xhamster_cdn_url(stream_url) and not _is_xhamster_watch_url(source_url):
            record_result("skipped", reason="xhamster_cdn_without_watch_page")
            skipped.append({
                "url": stream_url,
                "reason": "xhamster_cdn_without_watch_page",
            })
            logging.warning(
                "[BulkImport] skipped xHamster CDN-only item; source_url is not a refreshable watch page: %s",
                (stream_url or "")[:120],
            )
            continue

        # Filester extension often sends:
        # - url = https://filester.../d/<id>   (file page, good for extraction/refresh)
        # - source_url = https://filester.../f/<id> (folder page)
        # Use the file page as source_url so refresh/proxy can resolve a playable stream.
        stream_low = (stream_url or "").lower()
        source_low = (source_url or "").lower()
        is_filester_file_page = "filester." in stream_low and "/d/" in stream_low
        if is_filester_file_page and ("filester." in source_low and "/f/" in source_low):
            source_url = stream_url

        is_turbo = "turbo.cr" in (stream_url or "").lower() or "turbo.cr" in (source_url or "").lower()
        if is_turbo:
            turbo_page = source_url if turbo_extractor.can_handle(source_url or "") else stream_url
            try:
                meta_turbo = await turbo_extractor.extract(turbo_page)
                if meta_turbo:
                    resolved = str(meta_turbo.get("stream_url") or "").strip()
                    if resolved:
                        stream_url = resolved
                        status = "ready_to_stream"
                    # Keep watch-page URL as source_url for JIT re-extraction later
                    source_url = turbo_extractor._canonical_watch_url(turbo_page)
                    if meta_turbo.get("title") and (not title or title.lower().startswith("queued")):
                        title = str(meta_turbo["title"]).strip()
                    if meta_turbo.get("thumbnail") and not thumbnail:
                        thumbnail = meta_turbo["thumbnail"]
                        if thumbnail and str(thumbnail).startswith("http"):
                            deferred_thumbnail_url = str(thumbnail)
                            deferred_thumbnail_referer = source_url
                    duration = duration or float(meta_turbo.get("duration") or 0)
                    width = width or int(meta_turbo.get("width") or 0)
                    height = height or int(meta_turbo.get("height") or 0)

                    # Only ffprobe when the caller didn't already resolve both
                    # duration and resolution — keeps large tester imports fast.
                    if stream_url and (not duration or not height):
                        ff_meta = {"duration": duration, "height": height, "width": width}
                        try:
                            ff_meta = await processor._ffprobe_fallback(
                                stream_url,
                                ff_meta,
                                referer=source_url or "https://turbo.cr/"
                            )
                            duration = float(ff_meta.get("duration") or duration or 0)
                            height = int(ff_meta.get("height") or height or 0)
                            width = int(ff_meta.get("width") or width or 0)
                        except Exception as ff_err:
                            logging.warning(f"[Turbo-import] ffprobe failed for {stream_url}: {ff_err}")
                else:
                    # Extraction failed but it's still a turbo page - mark remote so JIT can retry
                    source_url = turbo_extractor._canonical_watch_url(turbo_page)
            except Exception as e:
                logging.warning(f"[Turbo-import] extractor failed: {e}")
                source_url = turbo_extractor._canonical_watch_url(turbo_page)

        # The browser extension may send whichever quality is currently playing
        # (commonly 720p). The stable PimpBunny watch page contains every variant,
        # so resolve it again and always store the best playable stream.
        is_pimpbunny_watch = "pimpbunny.com/videos/" in (source_url or "").lower()
        # Only re-extract when the extension did NOT already supply strong metadata.
        # The re-extraction fetches the page + HEAD-probes every quality variant,
        # which is slow; skipping it when we already have height+size+title+thumb
        # keeps bulk PimpBunny imports fast and off the critical path.
        if is_pimpbunny_watch and not _has_strong_pimpbunny_metadata(title, duration, height, filesize, thumbnail):
            try:
                meta_pb = await pimpbunny_extractor.extract(source_url)
                selected_stream = str((meta_pb or {}).get("stream_url") or "").strip()
                if selected_stream:
                    stream_url = selected_stream
                    selected_height = int((meta_pb or {}).get("height") or 0)
                    selected_size = int((meta_pb or {}).get("size_bytes") or 0)
                    if selected_height:
                        height = selected_height
                    if selected_size:
                        filesize = selected_size
                    if (not title or title.lower().startswith("queued")) and meta_pb.get("title"):
                        title = str(meta_pb["title"]).strip()
                    if not thumbnail and meta_pb.get("thumbnail"):
                        thumbnail = str(meta_pb["thumbnail"]).strip()
                    logging.info(
                        "[PimpBunny-import] selected best variant h=%s size=%s variants=%s",
                        selected_height,
                        selected_size,
                        (meta_pb or {}).get("quality_variants") or [],
                    )
            except Exception as e:
                # Keep the extension's known-working stream when a temporary anti-bot wall blocks re-extraction.
                logging.warning("[PimpBunny-import] best-quality extraction failed: %s", e)

        is_bigporn = bigporn_extractor.can_handle(stream_url or "") or bigporn_extractor.can_handle(source_url or "")
        if is_bigporn:
            bigporn_page = source_url if bigporn_extractor.can_handle(source_url or "") else stream_url
            try:
                meta_bp = await bigporn_extractor.extract(bigporn_page)
                if meta_bp and meta_bp.get("stream_url"):
                    stream_url = meta_bp["stream_url"]
                    status = "ready_to_stream"
                    if meta_bp.get("title") and (not title or title.lower().startswith("queued")):
                        title = str(meta_bp["title"]).strip()
                    if meta_bp.get("thumbnail") and not thumbnail:
                        thumbnail = meta_bp["thumbnail"]
                        if thumbnail and str(thumbnail).startswith("http"):
                            deferred_thumbnail_url = str(thumbnail)
                            deferred_thumbnail_referer = "https://www.bigporn.com/"
                    duration = duration or float(meta_bp.get("duration") or 0)
                    width = width or int(meta_bp.get("width") or 0)
                    height = height or int(meta_bp.get("height") or 0)
            except Exception as e:
                logging.warning("[BigPorn-import] extractor failed: %s", e)

        is_oneporn = "1porn.tv" in (stream_url or "").lower() or "1porn.tv" in (source_url or "").lower()
        if is_oneporn:
            oneporn_page = source_url if oneporn_extractor.can_handle(source_url or "") else stream_url
            try:
                meta_1p = await oneporn_extractor.extract(oneporn_page)
                if meta_1p:
                    resolved = str(meta_1p.get("stream_url") or "").strip()
                    if resolved:
                        stream_url = resolved
                        status = "ready_to_stream"
                    if meta_1p.get("title") and (not title or title.lower().startswith("queued")):
                        title = str(meta_1p["title"]).strip()
                    if meta_1p.get("thumbnail") and not thumbnail:
                        thumbnail = meta_1p["thumbnail"]
                    duration = duration or float(meta_1p.get("duration") or 0)
                    width = width or int(meta_1p.get("width") or 0)
                    height = height or int(meta_1p.get("height") or 0)
            except Exception as e:
                logging.warning(f"[1porn] extractor failed: {e}")

        is_beeg = (
            "beeg.com" in (stream_url or "").lower()
            or "beeg.com" in (source_url or "").lower()
            or "video.beeg.com" in (stream_url or "").lower()
        )
        if is_beeg:
            beeg_page_url = source_url if beeg_extractor.can_handle(source_url) else stream_url
            try:
                meta_beeg = await beeg_extractor.extract(beeg_page_url)
                if meta_beeg:
                    resolved_stream = str(meta_beeg.get("stream_url") or "").strip()
                    resolved_source = str(meta_beeg.get("source_url") or beeg_page_url or source_url or stream_url).strip()
                    if resolved_stream:
                        stream_url = resolved_stream
                        status = "ready_to_stream"
                    if resolved_source:
                        source_url = resolved_source
                    if meta_beeg.get("title"):
                        clean_title = str(meta_beeg.get("title") or "").strip()
                        if clean_title and (not title or title.lower().startswith("queued") or title.strip().lower() == "beeg"):
                            title = clean_title
                    if meta_beeg.get("thumbnail"):
                        thumbnail = meta_beeg.get("thumbnail") or thumbnail
                    duration = duration or float(meta_beeg.get("duration") or 0)
                    width = width or int(meta_beeg.get("width") or 0)
                    height = height or int(meta_beeg.get("height") or 0)
                    filesize = filesize or int(meta_beeg.get("size_bytes") or 0)
                    if not filesize and resolved_stream:
                        filesize = await _head_content_length(resolved_stream, source_url or beeg_page_url)
                    if thumbnail and str(thumbnail).startswith("http"):
                        deferred_thumbnail_url = str(thumbnail)
                        deferred_thumbnail_referer = source_url or beeg_page_url or stream_url
                    logging.info(
                        "[Beeg-import] source=%s stream=%s dur=%.1f h=%s",
                        (source_url or "")[:120],
                        (stream_url or "")[:120],
                        duration,
                        height,
                    )
            except Exception as e:
                logging.warning(f"Beeg pre-import extract failed for {beeg_page_url}: {e}")

        is_erome = (
            "erome.com" in (stream_url or "").lower()
            or "erome.com" in (source_url or "").lower()
        )
        if is_erome and not _has_strong_erome_metadata(title, thumbnail, duration, height):
            try:
                erome_page_url = ""
                if erome_extractor.can_handle(source_url or ""):
                    erome_page_url = source_url
                elif erome_extractor.can_handle(stream_url or ""):
                    erome_page_url = stream_url

                meta_erome = await erome_extractor.extract(erome_page_url) if erome_page_url else None
                if meta_erome:
                    resolved_stream = str(meta_erome.get("stream_url") or "").strip()
                    resolved_source = str(meta_erome.get("source_url") or erome_page_url or source_url or stream_url).strip()
                    if resolved_stream and (not _is_direct_media_url(stream_url) or not stream_url.strip()):
                        stream_url = resolved_stream
                    elif resolved_stream and _is_direct_media_url(stream_url):
                        stream_url = stream_url or resolved_stream
                    if resolved_source:
                        source_url = resolved_source
                    clean_title = str(meta_erome.get("title") or "").strip()
                    if clean_title and (not title or title.lower().startswith("queued") or title.strip().lower() in {"erome", "video"}):
                        title = clean_title
                    if meta_erome.get("thumbnail"):
                        thumbnail = meta_erome.get("thumbnail") or thumbnail
                    duration = duration or float(meta_erome.get("duration") or 0)
                    height = height or int(meta_erome.get("height") or 0)
                    width = width or int(meta_erome.get("width") or 0)

                    if stream_url and (not duration or not height):
                        ff_meta = {"duration": duration, "height": height, "width": width}
                        ff_meta = await processor._ffprobe_fallback(
                            stream_url,
                            ff_meta,
                            referer="https://www.erome.com/",
                        )
                        duration = float(ff_meta.get("duration") or duration or 0)
                        height = int(ff_meta.get("height") or height or 0)
                        width = int(ff_meta.get("width") or width or 0)

                    if not filesize and stream_url:
                        filesize = await _head_content_length(stream_url, "https://www.erome.com/")

                    if thumbnail and str(thumbnail).startswith("http"):
                        deferred_thumbnail_url = str(thumbnail)
                        deferred_thumbnail_referer = source_url or erome_page_url or "https://www.erome.com/"
                    logging.info(
                        "[Erome-import] source=%s stream=%s dur=%.1f h=%s",
                        (source_url or "")[:120],
                        (stream_url or "")[:120],
                        duration,
                        height,
                    )
            except Exception as e:
                logging.warning(f"Erome pre-import extract failed for {source_url or stream_url}: {e}")

        is_bunkr = "bunkr" in (stream_url or "").lower() or "bunkr" in (source_url or "").lower() or "scdn.st" in (stream_url or "").lower()
        if is_bunkr and _is_direct_media_url(stream_url) and duration >= MIN_DURATION_SECONDS:
            # Extension or userscript already resolved a playable file and its
            # length. Re-fetching the Bunkr page and ffprobing it again is what
            # made large albums take minutes.
            status = "ready_to_stream"
            if thumbnail and str(thumbnail).startswith("http") and not deferred_thumbnail_url:
                deferred_thumbnail_url = str(thumbnail)
                deferred_thumbnail_referer = source_url or stream_url
            logging.info("[Bunkr-import] direct fast-path: %s", (title or stream_url)[:80])
        elif is_bunkr:
            # Correct Referer for Bunkr CDN: must be from a bunkr.* domain root, not CDN itself
            def _bunkr_cdn_referer(url_hint: str) -> str:
                try:
                    import urllib.parse as _up
                    p = _up.urlparse(url_hint or "")
                    h = p.netloc.lower()
                    if h and "bunkr" in h:
                        return f"{p.scheme}://{p.netloc}/"
                except Exception:
                    pass
                return "https://bunkr.cr/"

            # Prefer /f/ or /v/ page URL as source_url
            source_candidate = None
            if "/f/" in (source_url or "") or "/v/" in (source_url or ""):
                source_candidate = source_url
            elif "/f/" in (stream_url or "") or "/v/" in (stream_url or ""):
                source_candidate = stream_url

            # Fallback: if stream_url OR source_url is a Bunkr CDN direct URL (scdn.st, media-files,
            # milkshake, stream-files), reconstruct a bunkr.cr/f/<slug> page URL from the CDN path.
            # This ensures the DB source_url points to a stable page rather than an ephemeral CDN token.
            if not source_candidate:
                _cdn_lookup_url = stream_url or source_url or ""
                _cdn_lookup_low = _cdn_lookup_url.lower()
                if re.search(r"(?:bunkr|bunkrr|scdn|media-files|milkshake|stream-files)\.", _cdn_lookup_low, re.I) and not re.search(r"/(a|album|albums)/", _cdn_lookup_low):
                    try:
                        import urllib.parse as _up_bi
                        _cdn_p = _up_bi.urlparse(_cdn_lookup_url)
                        _cdn_path_raw = (_cdn_p.path or "").rstrip("/")
                        _cdn_slug = _cdn_path_raw.rsplit("/", 1)[-1]
                        # Strip media extension — CDN slug often includes .mp4
                        _cdn_slug_clean = re.sub(r'\.[a-z0-9]{2,4}$', '', _cdn_slug, flags=re.I)
                        if _cdn_slug_clean:
                            _reconstructed_page = f"https://bunkr.cr/f/{_cdn_slug_clean}"
                            logging.info(f"[Bunkr-import] CDN direct: reconstructing page URL '{_reconstructed_page}' from slug '{_cdn_slug_clean}'")
                            try:
                                meta_cdn = await bunkr_extractor.extract(_reconstructed_page)
                                if meta_cdn and meta_cdn.get("stream_url"):
                                    stream_url = meta_cdn["stream_url"]
                                    source_url = _reconstructed_page  # stable page URL for future refreshes
                                    if (not title or title.lower().startswith("queued")) and meta_cdn.get("title"):
                                        title = meta_cdn["title"]
                                    if not thumbnail and meta_cdn.get("thumbnail"):
                                        thumbnail = meta_cdn["thumbnail"]
                                    duration = duration or float(meta_cdn.get("duration") or 0)
                                    width = int(meta_cdn.get("width") or 0)
                                    height = height or int(meta_cdn.get("height") or 0)
                                    logging.info(f"[Bunkr-import] CDN-slug resolved: source_url set to page URL for future refreshes")
                                else:
                                    # Extraction failed — still set source_url to reconstructed page
                                    # so future JIT refresh can try again
                                    source_url = _reconstructed_page
                                    logging.warning(f"[Bunkr-import] CDN-slug page extraction failed, keeping CDN stream but setting source_url={_reconstructed_page}")
                            except Exception as _cdn_e:
                                logging.warning(f"[Bunkr-import] CDN-slug page extraction error: {_cdn_e}")
                                source_url = _reconstructed_page  # still set page URL for future refreshes
                    except Exception as _slug_e:
                        logging.warning(f"[Bunkr-import] CDN slug extraction error: {_slug_e}")

            if source_candidate and bunkr_extractor.can_handle(source_candidate):
                try:
                    meta = await bunkr_extractor.extract(source_candidate)
                    if meta and meta.get("stream_url"):
                        stream_url = meta.get("stream_url") or stream_url
                        source_url = source_candidate
                        if (not title or title.lower().startswith("queued")) and meta.get("title"):
                            title = meta.get("title")
                        if not thumbnail and meta.get("thumbnail"):
                            thumbnail = meta.get("thumbnail")
                        duration = duration or float(meta.get("duration") or 0)
                        width = int(meta.get("width") or 0)
                        height = height or int(meta.get("height") or 0)
                except Exception as e:
                    logging.warning(f"Bunkr pre-import extract failed for {source_candidate}: {e}")

            # CDN Referer: use bunkr domain root (scdn.st is NOT accepted as Referer by its own CDN)
            cdn_ref = _bunkr_cdn_referer(source_url or stream_url)
            # Only probe when the caller didn't already send both — the extension's
            # "Fetch durations & quality" step already did this exact network
            # round-trip; re-probing here just adds a redundant ~20s-timeout ffprobe
            # per item on top of the page resolve above, which is what made batches
            # of Bunkr imports take minutes instead of seconds.
            if not duration:
                ff_meta = {"duration": duration, "height": height, "width": width}
                ff_meta = await processor._ffprobe_fallback(stream_url, ff_meta, referer=cdn_ref)
                duration = float(ff_meta.get("duration") or duration or 0)
                height = int(ff_meta.get("height") or height or 0)
                width = int(ff_meta.get("width") or width or 0)
            if not filesize and stream_url:
                filesize = await _head_content_length(stream_url, cdn_ref)
            if _is_direct_media_url(stream_url):
                status = "ready_to_stream"

        from app.extractors.filester import is_fileditch_url
        _filester_url_low = (stream_url or "").lower()
        is_filester = (
            not is_bunkr
            and ("filester." in _filester_url_low or is_fileditch_url(stream_url))
            and (
                "/d/" in _filester_url_low
                or "/f/" in _filester_url_low
                or "/file.php" in _filester_url_low
                or re.search(r"/[a-z0-9_-]{2,8}/[a-z0-9_%-]{4,}", _filester_url_low) is not None
                or is_fileditch_url(stream_url)
            )
        )
        if is_filester:
            try:
                if filester_extractor is None:
                    from app.extractors.filester import FilesterExtractor
                    filester_extractor = FilesterExtractor()
                filester_meta_ready = _has_strong_filester_metadata(title, duration, height, filesize)
                meta_f = await filester_extractor.extract(stream_url)
                if meta_f and meta_f.get("stream_url"):
                    stream_url = meta_f["stream_url"]
                    if (not title or title.lower().startswith("queued") or title.lower() == "file") and meta_f.get("title"):
                        title = meta_f["title"]
                    if not thumbnail and meta_f.get("thumbnail"):
                        thumbnail = meta_f["thumbnail"]
                    duration = duration or float(meta_f.get("duration") or 0)
                    height = height or int(meta_f.get("height") or 0)
                    width = width or int(meta_f.get("width") or 0)
                    if not filesize and meta_f.get("size_bytes"):
                        filesize = meta_f["size_bytes"]

                    # Fast path: if extension already sent good metadata, skip expensive ffprobe/HEAD fallbacks.
                    if filester_meta_ready:
                        logging.info(
                            "[Filester-import] fast-path for %s (duration=%.1f height=%s size=%s)",
                            (title or stream_url)[:80],
                            duration,
                            height,
                            filesize,
                        )
                    else:
                        if not duration or not height:
                            # ffprobe fallback: resolve duration + resolution from the actual CDN stream.
                            # Filester HTML/direct-viewer pages usually expose the stream but not duration.
                            _filester_ref = source_url or v.source_url or v.url or stream_url
                            try:
                                ff_meta = await processor._ffprobe_fallback(
                                    stream_url,
                                    {"duration": duration, "height": height, "width": width},
                                    referer=_filester_ref,
                                )
                                duration = float(ff_meta.get("duration") or duration or 0)
                                height = int(ff_meta.get("height") or height or 0)
                                width = int(ff_meta.get("width") or width or 0)
                                logging.info("[Filester-import] ffprobe result: dur=%.1f h=%s w=%s", duration, height, width)
                            except Exception as ff_err:
                                logging.warning("[Filester-import] ffprobe failed for %s: %s", (stream_url or "")[:80], ff_err)

                        # Fallback filesize via HEAD if extractor didn't provide it
                        if not filesize and stream_url:
                            try:
                                filesize = await _head_content_length(stream_url, source_url or v.source_url or v.url or stream_url)
                            except Exception:
                                pass

                    # Direct-viewer format: stream URL is resolved — mark ready immediately,
                    # but only after the metadata fallback above had a chance to fill duration.
                    if meta_f.get("needs_ffmpeg_thumb") or _is_direct_media_url(stream_url):
                        status = "ready_to_stream"
                        logging.info(
                            "[Filester-import] direct-viewer ready_to_stream: %s dur=%.1f h=%s",
                            (title or stream_url)[:80],
                            duration,
                            height,
                        )

                    if thumbnail and thumbnail.startswith("http"):
                        deferred_thumbnail_url = thumbnail
                        deferred_thumbnail_referer = source_url or v.source_url or v.url or stream_url
            except Exception as e:
                logging.warning(f"Filester pre-import extract failed for {stream_url}: {e}")

        is_pimpbunny = (
            not is_bunkr
            and "pimpbunny.com/videos/" in (source_url or "").lower()
            and "pimpbunny.com/remote_control.php" in (stream_url or "").lower()
        )
        if is_pimpbunny and _has_strong_pimpbunny_metadata(title, duration, height, filesize, thumbnail):
            status = "ready_to_stream"
            if thumbnail and thumbnail.startswith("http"):
                deferred_thumbnail_url = thumbnail
                deferred_thumbnail_referer = source_url or v.source_url or v.url or stream_url
            logging.info(
                "[PimpBunny-import] fast-path ready video=%s dur=%.1f h=%s size=%s",
                (title or stream_url)[:80],
                duration,
                height,
                filesize,
            )

        is_xgroovy = (
            not is_bunkr
            and not is_filester
            and (
                xgroovy_extractor.can_handle(source_url or "")
                or xgroovy_extractor.can_handle(stream_url or "")
            )
        )
        if is_xgroovy:
            xgroovy_watch = source_url if xgroovy_extractor.can_handle(source_url or "") else stream_url
            try:
                meta_xg = await xgroovy_extractor.extract(xgroovy_watch)
                if meta_xg and meta_xg.get("stream_url"):
                    stream_url = str(meta_xg["stream_url"]).strip()
                    source_url = str(meta_xg.get("source_url") or xgroovy_watch or source_url).strip()
                    if (not title or title.lower().startswith("queued")) and meta_xg.get("title"):
                        title = str(meta_xg["title"]).strip()
                    if not thumbnail and meta_xg.get("thumbnail"):
                        thumbnail = str(meta_xg["thumbnail"]).strip()
                    duration = duration or float(meta_xg.get("duration") or 0)
                    height = height or int(meta_xg.get("height") or 0)
                    width = width or int(meta_xg.get("width") or 0)
                    if not filesize:
                        filesize = await _head_content_length(stream_url, source_url or xgroovy_watch)
                    if not filesize:
                        filesize = _estimate_xgroovy_size_bytes(stream_url, duration)
                    status = "ready_to_stream"
                    if thumbnail and str(thumbnail).startswith("http"):
                        deferred_thumbnail_url = thumbnail
                        deferred_thumbnail_referer = source_url or xgroovy_watch
                        deferred_thumbnail_prefix = "xg"
                    logging.info(
                        "[XGroovy-import] stream=%s dur=%.1f h=%s size=%s",
                        (stream_url or "")[:80],
                        duration,
                        height,
                        filesize,
                    )
            except Exception as e:
                logging.warning(f"XGroovy pre-import extract failed for {xgroovy_watch}: {e}")

        is_camwhores_watch = (
            not is_bunkr
            and not is_filester
            and "camwhores.tv" in (v.url or "").lower()
            and "/videos/" in (v.url or "").lower()
            and "get_file" not in (v.url or "").lower()
        )
        if is_camwhores_watch and camwhores_extractor.can_handle(v.url):
            watch_page = v.url
            try:
                # Resolve the fresh signed get_file URL via the shared browser-first extractor.
                meta_cw = await camwhores_extractor.extract(watch_page)
                if meta_cw and meta_cw.get("stream_url"):
                    stream_url = meta_cw["stream_url"]
                    if "camwhores.tv/videos/" not in (source_url or "").lower():
                        source_url = watch_page
                    if (not title or title.lower().startswith("queued")) and meta_cw.get("title"):
                        title = meta_cw["title"]
                    if not thumbnail and meta_cw.get("thumbnail"):
                        thumbnail = meta_cw["thumbnail"]
                    duration = duration or float(meta_cw.get("duration") or 0)
                    height = height or int(meta_cw.get("height") or 0)
                    width = width or int(meta_cw.get("width") or 0)
            except Exception as e:
                logging.warning(f"Camwhores pre-import extract failed for {watch_page}: {e}")
            if stream_url and "get_file" in stream_url:
                ff_meta = {"duration": duration, "height": height, "width": width}
                _cw_ffprobe_referer = watch_page if watch_page else "https://www.camwhores.tv/"
                try:
                    ff_meta = await processor._ffprobe_fallback(
                        stream_url, ff_meta, referer=_cw_ffprobe_referer
                    )
                    duration = float(ff_meta.get("duration") or duration or 0)
                    height = int(ff_meta.get("height") or height or 0)
                    width = int(ff_meta.get("width") or width or 0)
                    if not filesize:
                        filesize = await _head_content_length(
                            stream_url, _cw_ffprobe_referer
                        )
                except Exception as ff_err:
                    logging.warning(
                        "[CW-import] ffprobe/size probe failed for watch=%s stream=%s: %s",
                        watch_page,
                        (stream_url or "")[:120],
                        ff_err,
                    )

        # CW get_file URL imported directly from extension (token is fresh now — run ffprobe immediately)
        is_cw_getfile_direct = (
            not is_bunkr
            and not is_camwhores_watch
            and "camwhores.tv/get_file" in (stream_url or "").lower()
            and "camwhores.tv/videos/" in (source_url or "").lower()
        )
        if is_cw_getfile_direct and (not height or not duration):
            logging.info("[CW-import] get_file direct — running ffprobe while token is fresh: %s", (stream_url or "")[:80])
            ff_meta = {"duration": duration, "height": height, "width": width}
            _cw_ffprobe_ref = source_url  # watch page as Referer
            try:
                ff_meta = await processor._ffprobe_fallback(stream_url, ff_meta, referer=_cw_ffprobe_ref)
                duration = float(ff_meta.get("duration") or duration or 0)
                height = int(ff_meta.get("height") or height or 0)
                width = int(ff_meta.get("width") or width or 0)
                if not filesize:
                    filesize = await _head_content_length(stream_url, _cw_ffprobe_ref)
                logging.info("[CW-import] ffprobe result: dur=%.1f h=%s w=%s", duration, height, width)
            except Exception as ff_err:
                logging.warning(
                    "[CW-import] direct get_file ffprobe/size probe failed for source=%s stream=%s: %s",
                    source_url,
                    (stream_url or "")[:120],
                    ff_err,
                )

        # ── PornHoarder: extract stream URL at import time ──────────────────
        is_pornhoarder = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and ("pornhoarder.io" in (stream_url or "").lower()
                 or "pornhoarder.net" in (stream_url or "").lower()
                 or "pornhoarder.io" in (source_url or "").lower())
        )
        if is_pornhoarder:
            try:
                from .extractors.pornhoarder import PornHoarderExtractor
                _ph_extractor = PornHoarderExtractor()
                _ph_url = source_url if "pornhoarder.io/watch/" in (source_url or "") else stream_url
                meta_ph = await _ph_extractor.extract(_ph_url)
                if meta_ph and meta_ph.get("stream_url"):
                    stream_url = meta_ph["stream_url"]
                    if (not title or title.lower().startswith("queued")) and meta_ph.get("title"):
                        title = meta_ph["title"]
                    if not thumbnail and meta_ph.get("thumbnail"):
                        thumbnail = meta_ph["thumbnail"]
                    duration = duration or float(meta_ph.get("duration") or 0)
                    height = height or int(meta_ph.get("height") or 0)
                    width = width or int(meta_ph.get("width") or 0)
                    filesize = filesize or int(meta_ph.get("filesize") or 0)
                    logging.info("[PornHoarder-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"PornHoarder pre-import extract failed for {stream_url}: {e}")

        # Archivebate watch/embed URLs need resolving before Nexus can probe/play them.
        is_archivebate = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and (
                archivebate_extractor.can_handle(stream_url)
                or archivebate_extractor.can_handle(source_url)
            )
        )
        if is_archivebate:
            try:
                archivebate_url = source_url if archivebate_extractor.can_handle(source_url) else stream_url
                meta_ab = await archivebate_extractor.extract(archivebate_url)
                if meta_ab and meta_ab.get("stream_url"):
                    stream_url = meta_ab["stream_url"]
                    if archivebate_extractor.can_handle(archivebate_url):
                        source_url = archivebate_url
                    if (not title or title.lower().startswith("queued")) and meta_ab.get("title"):
                        title = meta_ab["title"]
                    if not thumbnail and meta_ab.get("thumbnail"):
                        thumbnail = meta_ab["thumbnail"]
                    duration = duration or float(meta_ab.get("duration") or 0)
                    height = height or int(meta_ab.get("height") or 0)
                    width = width or int(meta_ab.get("width") or 0)
                    filesize = filesize or int(meta_ab.get("size_bytes") or 0)
                    logging.info("[Archivebate-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"Archivebate pre-import extract failed for {stream_url}: {e}")

        is_recurbate = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and (
                recurbate_extractor.can_handle(stream_url)
                or recurbate_extractor.can_handle(source_url)
            )
        )
        if is_recurbate:
            try:
                recurbate_url = source_url if recurbate_extractor.can_handle(source_url) else stream_url
                meta_rb = await recurbate_extractor.extract(recurbate_url)
                if meta_rb and meta_rb.get("stream_url"):
                    stream_url = meta_rb["stream_url"]
                    source_url = meta_rb.get("source_url") or recurbate_url
                    if (not title or title.lower().startswith("queued")) and meta_rb.get("title"):
                        title = meta_rb["title"]
                    if not thumbnail and meta_rb.get("thumbnail"):
                        thumbnail = meta_rb["thumbnail"]
                    duration = duration or float(meta_rb.get("duration") or 0)
                    height = height or int(meta_rb.get("height") or 0)
                    width = width or int(meta_rb.get("width") or 0)
                    filesize = filesize or int(meta_rb.get("size_bytes") or meta_rb.get("filesize") or 0)
                    status = "ready_to_stream"
                    logging.info("[Recurbate-import] stream=%s dur=%.1f h=%s",
                                 (stream_url or "")[:80], duration, height)
            except Exception as e:
                logging.warning(f"Recurbate pre-import extract failed for {stream_url}: {e}")

        # ── NSFW247: extract stream URL, thumbnail, duration, height, size at import time ──
        is_nsfw247 = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and ("nsfw247.to" in (stream_url or "").lower()
                 or "nsfw247.to" in (source_url or "").lower()
                 or "nsfwclips.co" in (stream_url or "").lower())
        )
        if is_nsfw247:
            try:
                from .extractors.nsfw247 import NSFW247Extractor
                _nsfw_extractor = NSFW247Extractor()
                _nsfw_url = source_url if "nsfw247.to" in (source_url or "") else stream_url
                meta_nsfw = await _nsfw_extractor.extract(_nsfw_url)
                if meta_nsfw and meta_nsfw.get("stream_url"):
                    stream_url = meta_nsfw["stream_url"]
                    if (not title or title.lower().startswith("queued")) and meta_nsfw.get("title"):
                        title = meta_nsfw["title"]
                    if not thumbnail and meta_nsfw.get("thumbnail"):
                        thumbnail = meta_nsfw["thumbnail"]
                    duration = duration or float(meta_nsfw.get("duration") or 0)
                    height = height or int(meta_nsfw.get("height") or 0)
                    width = width or int(meta_nsfw.get("width") or 0)
                    
                    logging.info("[NSFW247-import] Running pre-import ffprobe for: %s", stream_url)
                    ff_meta = {"duration": duration, "height": height, "width": width}
                    ff_meta = await processor._ffprobe_fallback(stream_url, ff_meta, referer="https://nsfw247.to/")
                    duration = float(ff_meta.get("duration") or duration or 0)
                    height = int(ff_meta.get("height") or height or 0)
                    width = int(ff_meta.get("width") or width or 0)
                    logging.info("[NSFW247-import] ffprobe success: duration=%.1f, height=%d, width=%d", duration, height, width)
                    
                    if not filesize and stream_url:
                        filesize = await _head_content_length(stream_url, "https://nsfw247.to/")
            except Exception as e:
                logging.warning(f"NSFW247 pre-import extract/ffprobe failed: {e}")

        # ── Coomerfans: CDN URLs are IP-locked — ffprobe always fails from the server.
        # The extension sends duration/height/quality directly; trust that metadata.
        is_coomerfans_import = (
            not is_bunkr
            and not is_filester
            and not is_camwhores_watch
            and (
                "coomerfans.com" in (stream_url or "").lower()
                or "coomerfans.com" in (source_url or "").lower()
            )
            and (
                any(ext in (stream_url or "").lower() for ext in [".mp4", ".webm", ".mov"])
                or re.search(r'https?://img\d+\.coomerfans\.com/', stream_url or "")
            )
        )
        if is_coomerfans_import:
            # Mark ready immediately — CDN direct, no background processing needed.
            status = "ready_to_stream"
            logging.info("[Coomerfans-import] cdn_direct import: dur=%.1f h=%s url=%s", duration, height, (stream_url or "")[:80])

        if is_coomerfans_import and not thumbnail:
            try:
                # Thumbnail: scrape post page og:image — doesn't expire unlike CDN token URLs
                # Only try if source_url is a real post page, not a CDN URL
                _cf_src = source_url or ""
                _cf_is_post = "coomerfans.com" in _cf_src and not re.search(r'https?://img\d+\.coomerfans\.com/', _cf_src)
                if _cf_is_post:
                    import httpx as _httpx
                    _cf_headers = {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                        "Referer": "https://coomerfans.com/"
                    }
                    async with _httpx.AsyncClient(timeout=10, follow_redirects=True) as _cf_client:
                        _cf_resp = await _cf_client.get(_cf_src, headers=_cf_headers)
                    if _cf_resp.status_code == 200:
                        from bs4 import BeautifulSoup as _BS
                        _cf_soup = _BS(_cf_resp.text, "html.parser")
                        _og_img = _cf_soup.find("meta", property="og:image")
                        if _og_img and _og_img.get("content"):
                            thumbnail = _og_img["content"]
                            logging.info("[Coomerfans-import] thumbnail from og:image: %s", thumbnail[:80])
            except Exception as e:
                logging.warning(f"[Coomerfans-import] thumbnail scrape failed: {e}")

        # Coomerfans CDN is IP-locked — server can't fetch thumbnails.
        # Queue for browser-side upload via extension instead.
        if is_coomerfans_import and thumbnail and str(thumbnail).startswith("http"):
            pass  # thumb_uploads populated below after video.id is known

        # ── Generic direct-media metadata fallback ─────────────────────────────
        # Catches every direct-file host without a dedicated block above
        # (Pixeldrain, CyberDrop, and any future host). If we still lack duration
        # or resolution but have a playable direct-media URL, ffprobe it once with
        # the source page as Referer. Coomer CDN is IP-locked (ffprobe always
        # fails) so we skip it and trust the metadata the tester already sent.
        _generic_low = (stream_url or "").lower()
        _is_direct_stream = _is_direct_media_url(stream_url) or bool(
            re.search(r"(pixeldrain\.com/api/|gigachad-cdn|turbocdn\.st|/api/file/d/)", _generic_low)
        )
        # The Faphouse content script resolves a fresh, signed full-video HLS
        # or MP4 URL inside the logged-in browser before it calls this endpoint.
        # That stream is already playable; sending it through the generic video
        # processor leaves it in pending/processing while the processor tries to
        # re-extract the signed CDN URL from the public watch page.  Keep the
        # stable watch page in source_url for a later refresh, but make the
        # browser-resolved stream available immediately.
        _faphouse_source_low = (source_url or "").lower()
        is_faphouse_direct = bool(
            _is_direct_stream
            and "faphouse.com" in _faphouse_source_low
            and not re.search(r"/(?:trailer|preview)/", (stream_url or ""), re.I)
        )
        if is_faphouse_direct:
            status = "ready_to_stream"
            logging.info(
                "[Faphouse-import] direct stream ready: source=%s stream=%s",
                (source_url or "")[:100],
                (stream_url or "")[:100],
            )
        if (
            _is_direct_stream
            and not is_coomerfans_import
            and not duration
        ):
            try:
                from urllib.parse import urlparse as _urlparse
                _ref_host = _urlparse(source_url or stream_url or "")
                _generic_ref = (
                    f"{_ref_host.scheme}://{_ref_host.netloc}/"
                    if _ref_host.scheme and _ref_host.netloc else None
                )
                ff_meta = await processor._ffprobe_fallback(
                    stream_url,
                    {"duration": duration, "height": height, "width": width},
                    referer=_generic_ref,
                )
                duration = float(ff_meta.get("duration") or duration or 0)
                height = int(ff_meta.get("height") or height or 0)
                width = int(ff_meta.get("width") or width or 0)
                logging.info(
                    "[Generic-import] ffprobe %s dur=%.1f h=%s",
                    (stream_url or "")[:70], duration, height,
                )
            except Exception as _ge:
                logging.warning("[Generic-import] ffprobe failed for %s: %s", (stream_url or "")[:70], _ge)

        # Late discard: now that duration is resolved, drop sub-10s clips before
        # the expensive thumbnail generation / size HEAD — don't waste resources.
        if 0 < duration < MIN_DURATION_SECONDS and not preserve_short_clip:
            skipped.append({"url": stream_url, "reason": "too_short"})
            record_result("skipped", reason="too_short")
            logging.info("[BulkImport] discarded sub-%ss clip (%.1fs): %s",
                         MIN_DURATION_SECONDS, duration, (stream_url or "")[:70])
            continue

        # Backfill resolution from the quality label when ffprobe couldn't run
        # (e.g. IP-locked Coomer) but the tester sent a quality/height hint.
        if not height:
            _q_hint = str(getattr(v, "quality", "") or "").lower()
            _q_map = {"4k": 2160, "2160p": 2160, "1440p": 1440, "2k": 1440,
                      "fhd": 1080, "1080p": 1080, "hd": 720, "720p": 720,
                      "480p": 480, "360p": 360}
            for _k, _hv in _q_map.items():
                if _k in _q_hint:
                    height = _hv
                    break

        # Direct-media size backfill: HEAD the stream if we still have no size.
        if _is_direct_stream and not filesize and not is_coomerfans_import and stream_url:
            try:
                from urllib.parse import urlparse as _urlparse2
                _sp = _urlparse2(source_url or stream_url or "")
                _size_ref = f"{_sp.scheme}://{_sp.netloc}/" if _sp.scheme and _sp.netloc else None
                filesize = await _head_content_length(stream_url, _size_ref)
            except Exception:
                pass

        # Derive quality label from the SHORTER side so portrait clips read right
        # (1080x1920 vertical = FHD, not 2K).
        def _height_to_quality(h: int, w: int = 0) -> str:
            short = min(int(w or 0), int(h or 0)) if (w and h) else int(h or 0)
            if short >= 2160: return "4K"
            if short >= 1440: return "2K"
            if short >= 1080: return "FHD"
            if short >= 720:  return "HD"
            if short >= 480:  return "SD"
            return "SD"

        # For coomerfans base64 data: thumbnails — save to disk immediately (no network needed)
        _cf_saved_thumb = None
        if is_coomerfans_import and thumbnail and str(thumbnail).startswith("data:image"):
            try:
                import base64 as _b64, hashlib as _hs, os as _os
                _data_part = str(thumbnail).split(",", 1)
                if len(_data_part) == 2:
                    _raw = _b64.b64decode(_data_part[1])
                    _thumb_dir = _os.path.join("app", "static", "thumbnails")
                    _os.makedirs(_thumb_dir, exist_ok=True)
                    _fname = f"cf_{_hs.md5(str(stream_url).encode()).hexdigest()}.jpg"
                    _fpath = _os.path.join(_thumb_dir, _fname)
                    with open(_fpath, "wb") as _f:
                        _f.write(_raw)
                    _cf_saved_thumb = f"/static/thumbnails/{_fname}"
                    logging.info("[Coomerfans-import] saved base64 thumbnail -> %s", _cf_saved_thumb)
            except Exception as _e:
                logging.warning("[Coomerfans-import] base64 thumb save failed: %s", _e)

        # For coomerfans HTTP CDN thumbnails: IP-locked, queue for browser-side binary upload.
        # For base64 thumbnails: already saved above (_cf_saved_thumb set).
        if (
            status != "ready_to_stream"
            and not is_coomerfans_import
            and _is_direct_media_url(stream_url)
        ):
            # Playable file URL. The VIP processor would download the page,
            # probe, and thumbnail this same file a second time.
            status = "ready_to_stream"
        if (
            not is_coomerfans_import
            and thumbnail
            and str(thumbnail).startswith(("http://", "https://"))
            and not deferred_thumbnail_url
            and not re.search(r"placeholder|video\.svg|/icon[./]|sprite\.svg", str(thumbnail), re.I)
        ):
            deferred_thumbnail_url = str(thumbnail)
            deferred_thumbnail_referer = deferred_thumbnail_referer or source_url or stream_url
        stored_thumbnail = _cf_saved_thumb if is_coomerfans_import else thumbnail

        from app.related_query_planner import sanitize_video_tags_csv
        video = Video(
            title=title,
            url=stream_url,
            source_url=source_url,
            thumbnail_path=stored_thumbnail,
            original_thumbnail_url=thumbnail if str(thumbnail or "").startswith(("http://", "https://")) else "",
            thumbnail_referer=source_url,
            duration=duration,
            height=height,
            width=width,
            quality=_height_to_quality(height, width),
            file_size_mb=round(filesize / (1024 * 1024), 2) if filesize else 0,
            batch_name=req.batch_name,
            tags=sanitize_video_tags_csv(v.tags or ""),
            views=_coerce_views(v.views),
            upload_date=str(v.upload_date or "").strip(),
            storage_type="cdn_direct" if is_coomerfans_import else ("external_direct" if is_oneporn else "remote"),
            status=status,
            download_stats={"size_mb": round(filesize / (1024 * 1024), 2)} if filesize else None,
        )
        db.add(video)
        db.flush()
        # Commit per item (not once at the end of the whole batch): each row becomes
        # visible in the dashboard/DB the moment it's resolved, instead of the entire
        # batch staying invisible until every single item finishes.
        db.commit()
        for value in (video.url, video.source_url):
            key = _normalize_video_url(value)
            if key:
                existing_index[key] = video
        logging.info("[BulkImport] (%d/%d) saved video id=%s dur=%.1fs h=%s: %s",
                     _idx, total_incoming, video.id, duration, height, title[:90])
        new_ids.append(video.id)
        try:
            for _mirror in [m for m in (v.mirror_urls or []) if isinstance(m, str) and m.startswith(("http://", "https://"))][:6]:
                if _mirror == stream_url:
                    continue
                db.add(VideoSource(
                    video_id=video.id, url=_mirror, source_url=_mirror,
                    label=classify_library_source_name(_mirror, _mirror),
                    quality=str(v.quality or ""), height=int(v.height or 0),
                    size_mb=float(v.file_size_mb or 0), is_primary=False,
                ))
            if v.mirror_urls:
                db.commit()
        except Exception:
            db.rollback()
            logging.warning("[BulkImport] mirror_urls attach failed for video %s", video.id, exc_info=True)
        record_result("imported", video.id)
        if status != "ready_to_stream":
            process_ids.append(video.id)
        if v.auto_rethumb:
            # Do not rely on a remote FileDitch poster: it can be missing or expire
            # before the browser renders the card. This worker re-resolves the stable
            # source URL and writes a local thumbnail asynchronously.
            _ffmpeg_referer = source_url or stream_url or ""
            thumb_jobs.append((
                "ffmpeg",
                (video.id, stream_url, duration, _ffmpeg_referer, source_url),
            ))
        elif not stored_thumbnail or not str(stored_thumbnail).startswith("/static/thumbnails/"):
            if is_coomerfans_import:
                # CDN tokens expire — browser must fetch og:image from post page and upload
                _cf_post_url = source_url if (source_url and "coomerfans.com/p/" in (source_url or "")) else ""
                thumb_uploads.append({
                    "id": video.id,
                    "url": str(thumbnail) if thumbnail and str(thumbnail).startswith("http") else "",
                    "source_url": _cf_post_url,
                })
            elif not deferred_thumbnail_url:
                # Only fall back to FFmpeg when no remote thumbnail URL is available.
                # If deferred_thumbnail_url is set, _background_localize_remote_thumbnail
                # will handle it below — running FFmpeg in parallel would race and may
                # overwrite a successfully downloaded remote thumbnail.
                _ffmpeg_referer = source_url or stream_url or ""
                thumb_jobs.append((
                    "ffmpeg",
                    (video.id, stream_url, duration, _ffmpeg_referer, source_url),
                ))
        if deferred_thumbnail_url:
            thumb_jobs.append((
                "remote",
                (video.id, deferred_thumbnail_url, deferred_thumbnail_referer, deferred_thumbnail_prefix),
            ))
    db.commit()
    for kind, args in thumb_jobs:
        if kind == "ffmpeg":
            asyncio.create_task(_background_ffmpeg_thumbnail(*args))
        else:
            asyncio.create_task(_background_localize_remote_thumbnail(*args))
    if process_ids:
        bg_tasks.add_task(processor.process_batch, process_ids)
    return {
        "status": "ok",
        "count": len(new_ids),
        "imported": len(new_ids),
        "video_ids": new_ids,
        "duplicates": sum(item["status"] == "duplicate" for item in results),
        "mirrors": sum(item["status"] == "mirror_attached" for item in results),
        "results": results,
        "errors": len(skipped),
        "skipped": skipped,
        "batch": req.batch_name,
        "thumb_uploads": thumb_uploads,
    }


@router.post("/api/v1/thumbnail/{video_id}")
async def upload_thumbnail(
    video_id: int,
    request: Request,
    db: Session = Depends(get_db),
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """Accept binary image uploaded by extension (browser-fetched from IP-locked CDN)."""
    ensure_bridge_token(x_nexus_token)
    body = await request.body()
    if not body:
        return {"ok": False, "error": "empty body"}
    video = db.query(Video).get(video_id)
    if not video:
        raise HTTPException(404, "video not found")
    content_type = request.headers.get("content-type", "image/jpeg")
    ext = "png" if "png" in content_type else "webp" if "webp" in content_type else "jpg"
    thumb_dir = os.path.join("app", "static", "thumbnails")
    os.makedirs(thumb_dir, exist_ok=True)
    filename = f"cf_{video_id}_{int(time.time())}.{ext}"
    filepath = os.path.join(thumb_dir, filename)
    with open(filepath, "wb") as f:
        f.write(body)
    video.thumbnail_path = f"/static/thumbnails/{filename}"
    db.commit()
    logging.info("[Thumb-upload] video_id=%s -> %s", video_id, video.thumbnail_path)
    return {"ok": True, "path": video.thumbnail_path}


class BrowserFetchRequest(BaseModel):
    url: str
    html: str
    source_url: Optional[str] = None
    batch_name: Optional[str] = None
    title: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[Any] = None


@router.post("/api/v1/intake/browser-fetch")
async def browser_fetch_extract(
    req: BrowserFetchRequest,
    x_nexus_token: Optional[str] = Header(default=None, alias="X-Nexus-Token"),
):
    """
    Extension sends page HTML fetched by the browser (bypasses backend IP bans).
    Backend extracts stream URL and metadata from the HTML using the appropriate extractor.
    """
    ensure_bridge_token(x_nexus_token)

    url = req.url.strip()
    html = req.html
    if not url or not html:
        raise HTTPException(400, "url and html are required")

    logging.info(f"[browser-fetch] Received HTML for {url} ({len(html)} chars)")

    result = None

    if "eporner.com" in url:
        from app.extractors.eporner import EpornerExtractor
        ext = EpornerExtractor()
        try:
            result = await ext.extract(url, pre_fetched_html=html)
        except Exception as e:
            logging.warning(f"[browser-fetch] Eporner extractor failed: {e}")

    if not result and ("xgroovy.com" in url or "xgroovy-fr.com" in url):
        from app.extractors.xgroovy import XGroovyExtractor
        ext = XGroovyExtractor()
        try:
            result = await ext.extract(url, pre_fetched_html=html)
        except Exception as e:
            logging.warning(f"[browser-fetch] XGroovy extractor failed: {e}")

    if not result:
        try:
            from app.extractors.media_router import default_router
            routed = await asyncio.to_thread(default_router.extract, url, pre_fetched_html=html)
            if routed:
                result = routed.to_dict()
        except Exception as e:
            logging.warning(f"[browser-fetch] Media router extractor failed: {e}")

    if not result:
        return {"ok": False, "error": "No extractor could process this URL", "url": url}

    if req.title and not result.get("title"):
        result["title"] = req.title
    if req.thumbnail and not result.get("thumbnail"):
        result["thumbnail"] = req.thumbnail
    if req.duration and not result.get("duration"):
        try:
            result["duration"] = float(req.duration)
        except (TypeError, ValueError):
            pass

    return {
        "ok": True,
        "url": url,
        "stream_url": result.get("stream_url"),
        "title": result.get("title"),
        "thumbnail": result.get("thumbnail"),
        "duration": result.get("duration"),
        "width": result.get("width"),
        "height": result.get("height"),
        "quality": f"{result.get('height', 0)}p" if result.get("height") else "HD",
        "tags": result.get("tags", []),
        "views": result.get("views"),
        "upload_date": result.get("upload_date"),
        "extractor": result.get("extractor"),
    }
