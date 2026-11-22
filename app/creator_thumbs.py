"""Creator Radar smart thumbnail cache, enhancement, and promotion to Dashboard."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import random
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Iterable, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

CREATOR_THUMB_TTL_SECONDS = 14 * 24 * 3600  # 14 dní
CREATOR_THUMB_MAX_FILES = 1500
_CACHE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{4,80}$")
_RADAR_THUMB_URL_RE = re.compile(r"^/api/v1/radar/thumb/([A-Za-z0-9_-]{4,80})\.jpg(?:\?.*)?$")
_TG_THUMB_URL_RE = re.compile(r"^/api/v1/telegram/thumb/(-?\d+)/(\d+)(?:\?.*)?$")
_DIRECT_VIDEO_RE = re.compile(r"\.(?:mp4|m3u8|webm|mov|m4v|mkv)(?:[?#]|$)", re.IGNORECASE)

_cleanup_lock = False
_last_cleanup_ts = 0.0
_item_locks: Dict[str, asyncio.Lock] = {}
_batch_gate = asyncio.Semaphore(4)


def get_creator_thumb_dir() -> Path:
    raw = os.environ.get("NEXUS_CREATOR_THUMB_DIR", "").strip()
    return Path(raw) if raw else Path("data/creator_thumbs")


def get_library_thumb_dir() -> Path:
    raw = os.environ.get("NEXUS_LIBRARY_THUMB_DIR", "").strip()
    return Path(raw) if raw else Path("app/static/thumbnails")


def _extract_tg_pair(item: Dict[str, Any]) -> Optional[tuple[int, int]]:
    from .telegram_stream import public_chat_id

    meta = item.get("telegram_meta") if isinstance(item.get("telegram_meta"), dict) else {}
    cid = meta.get("chat_id")
    mid = meta.get("message_id")
    if cid and mid:
        try:
            pub_cid = public_chat_id(int(cid))
            msg_id = int(mid)
            if pub_cid and msg_id > 0:
                return (pub_cid, msg_id)
        except (TypeError, ValueError):
            pass

    for candidate in (item.get("playable_url"), item.get("url"), item.get("id")):
        text = str(candidate or "")
        m = re.search(r"/telegram/(?:stream|thumb)/(-?\d+)/(\d+)", text)
        if m:
            return (public_chat_id(int(m.group(1))), int(m.group(2)))
        m2 = re.match(r"^telegram:(-?\d+):(\d+)$", text.strip())
        if m2:
            return (public_chat_id(int(m2.group(1))), int(m2.group(2)))
    return None


def cache_key_for_item(item: Dict[str, Any]) -> str:
    """Return a stable, filesystem-safe cache key for a Creator Radar item."""
    tg_pair = _extract_tg_pair(item)
    if tg_pair:
        return f"tg_{tg_pair[0]}_{tg_pair[1]}"

    vid_id = int(item.get("video_id") or 0)
    if vid_id > 0:
        return f"lib_{vid_id}"

    bucket = str(item.get("bucket") or "vault").strip().lower()
    item_id = str(item.get("id") or "").strip()
    target = str(item.get("url") or item.get("source_url") or item.get("title") or "").strip()
    digest = hashlib.sha1(f"{bucket}|{item_id}|{target}".encode("utf-8")).hexdigest()[:24]
    return f"cr_{digest}"


def sanitize_cache_key(raw_key: str) -> str:
    key = str(raw_key or "").strip()
    if key.lower().endswith(".jpg"):
        key = key[:-4]
    if not _CACHE_KEY_RE.match(key):
        raise ValueError("Neplatný kľúč náhľadu")
    return key


def resolve_cached_thumb_file(raw_key: str, *, ttl_seconds: int = CREATOR_THUMB_TTL_SECONDS) -> Optional[Path]:
    """Return cached JPEG path if present and not expired; unlink expired files."""
    try:
        key = sanitize_cache_key(raw_key)
    except ValueError:
        return None
    path = get_creator_thumb_dir() / f"{key}.jpg"
    if not path.is_file():
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    if st.st_size < 100:
        path.unlink(missing_ok=True)
        return None
    if ttl_seconds > 0 and (time.time() - st.st_mtime) > ttl_seconds:
        path.unlink(missing_ok=True)
        return None
    return path


def get_cached_thumb_url(item: Dict[str, Any]) -> Optional[str]:
    key = cache_key_for_item(item)
    path = resolve_cached_thumb_file(key)
    if not path:
        return None
    try:
        ver = int(path.stat().st_mtime)
    except OSError:
        ver = int(time.time())
    return f"/api/v1/radar/thumb/{key}.jpg?v={ver}"


def cleanup_expired_creator_thumbs(
    *,
    ttl_seconds: int = CREATOR_THUMB_TTL_SECONDS,
    max_files: int = CREATOR_THUMB_MAX_FILES,
    force: bool = False,
) -> int:
    """Delete expired creator_thumbs files and enforce max file count."""
    global _cleanup_lock, _last_cleanup_ts
    now = time.time()
    if not force and (_cleanup_lock or (now - _last_cleanup_ts) < 600.0):
        return 0
    _cleanup_lock = True
    _last_cleanup_ts = now
    removed = 0
    try:
        thumb_dir = get_creator_thumb_dir()
        if not thumb_dir.is_dir():
            return 0
        survivors: list[tuple[float, Path]] = []
        for entry in thumb_dir.iterdir():
            if not entry.is_file() or entry.suffix.lower() != ".jpg":
                continue
            try:
                st = entry.stat()
            except OSError:
                continue
            if st.st_size < 100 or (ttl_seconds > 0 and (now - st.st_mtime) > ttl_seconds):
                try:
                    entry.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    pass
            else:
                survivors.append((st.st_mtime, entry))
        if max_files > 0 and len(survivors) > max_files:
            survivors.sort(key=lambda pair: pair[0])
            excess = len(survivors) - max_files
            for _, old_path in survivors[:excess]:
                try:
                    old_path.unlink(missing_ok=True)
                    removed += 1
                except OSError:
                    pass
    finally:
        _cleanup_lock = False
    return removed


def _save_to_creator_cache(src_path: Path, cache_key: str) -> Path:
    dest_dir = get_creator_thumb_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{sanitize_cache_key(cache_key)}.jpg"
    tmp_fd, tmp_name = tempfile.mkstemp(prefix="cr_thumb_", suffix=".jpg", dir=str(dest_dir))
    os.close(tmp_fd)
    try:
        shutil.copyfile(src_path, tmp_name)
        os.replace(tmp_name, dest)
        os.utime(dest, None)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise
    cleanup_expired_creator_thumbs(force=False)
    return dest


def promote_creator_thumb_to_library(thumb_url: str) -> str:
    """Copy a temporary creator_thumbs JPEG into durable app/static/thumbnails/ for Dashboard."""
    raw = str(thumb_url or "").strip()
    if not raw:
        return ""

    tg_match = _TG_THUMB_URL_RE.match(raw)
    if tg_match:
        return f"/api/v1/telegram/thumb/{tg_match.group(1)}/{tg_match.group(2)}"

    radar_match = _RADAR_THUMB_URL_RE.match(raw)
    if not radar_match:
        return raw

    key = radar_match.group(1)
    cached = resolve_cached_thumb_file(key, ttl_seconds=0)
    if not cached:
        return ""

    if key.startswith("tg_"):
        parts = key.split("_")
        if len(parts) == 3:
            try:
                from .telegram_stream import public_chat_id, thumb_path as tg_thumb_path
                cid = public_chat_id(int(parts[1]))
                mid = int(parts[2])
                tg_dest = tg_thumb_path(cid, mid)
                tg_dest.parent.mkdir(parents=True, exist_ok=True)
                if not tg_dest.is_file() or tg_dest.stat().st_size < 100:
                    shutil.copyfile(cached, tg_dest)
                return f"/api/v1/telegram/thumb/{cid}/{mid}"
            except Exception as exc:
                logger.debug("[CreatorThumbs] TG promote fallback to static: %s", exc)

    lib_dir = get_library_thumb_dir()
    lib_dir.mkdir(parents=True, exist_ok=True)
    dest = lib_dir / f"cr_{key}.jpg"
    tmp_fd, tmp_name = tempfile.mkstemp(prefix="cr_lib_", suffix=".jpg", dir=str(lib_dir))
    os.close(tmp_fd)
    try:
        shutil.copyfile(cached, tmp_name)
        os.replace(tmp_name, dest)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        return raw
    return f"/static/thumbnails/cr_{key}.jpg"


def _sync_telegram_thumb_db(db: Session, raw_chat_id: int, pub_chat_id: int, message_id: int, thumb_url: str) -> None:
    from .database import TelegramMediaIndex, Video, utcnow

    indexed = db.query(TelegramMediaIndex).filter_by(chat_id=pub_chat_id, message_id=message_id).first()
    if indexed:
        indexed.thumbnail = thumb_url
        indexed.has_thumb = True

    rows = (
        db.query(Video)
        .filter(
            Video.telegram_chat_id.in_([str(pub_chat_id), str(raw_chat_id)]),
            Video.telegram_message_id == message_id,
        )
        .all()
    )
    for video in rows:
        video.thumbnail_path = thumb_url
        video.smart_rethumb_at = utcnow()
        video.smart_rethumb_error = None
        video.preview_retry_needed = False
    db.commit()


async def _extract_best_frame_from_stream(
    stream_url: str,
    dest_path: Path,
    *,
    duration: float = 0.0,
    referer: str = "",
    reroll: bool = False,
) -> float:
    from .maintenance import _image_score, _run_thumb_process
    from .telegram_rethumb import _pick_points

    ffmpeg_bin = shutil.which("ffmpeg") or "ffmpeg"
    points = _pick_points(duration, reroll=reroll)
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="cr_frame_", dir=str(dest_path.parent)) as temp:
        candidates: list[tuple[float, str]] = []
        for i, position in enumerate(points):
            out_file = str(Path(temp) / f"{i}.jpg")
            cmd = [ffmpeg_bin, "-y", "-hide_banner", "-loglevel", "error", "-threads", "2"]
            if referer and stream_url.startswith(("http://", "https://")) and "127.0.0.1" not in stream_url:
                cmd += ["-headers", f"Referer: {referer}\r\nUser-Agent: Mozilla/5.0\r\n"]
            cmd += [
                "-probesize", "1M",
                "-analyzeduration", "1500000",
                "-noaccurate_seek",
                "-ss", str(round(position, 2)),
                "-i", stream_url,
                "-frames:v", "1",
                "-vf", "scale=w='min(iw,560)':h='min(ih,320)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
                "-q:v", "4",
                out_file,
            ]
            try:
                ok, _ = await _run_thumb_process(cmd, 25)
            except Exception:
                ok = False
            score = await asyncio.to_thread(_image_score, out_file) if ok and os.path.isfile(out_file) else 0.0
            if score > 0:
                candidates.append((score, out_file))
                if score >= (65 if reroll else 55):
                    break

        if not candidates:
            raise RuntimeError("Nepodarilo sa získať použiteľnú snímku zo streamu")
        best_score, best_file = max(candidates, key=lambda pair: pair[0])
        os.replace(best_file, dest_path)
        return float(best_score)


async def _download_and_score_image(image_url: str, dest_path: Path, referer: str = "") -> float:
    import httpx
    from .maintenance import _image_score

    headers = {"User-Agent": "Mozilla/5.0"}
    if referer:
        headers["Referer"] = referer
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(prefix="cr_img_", suffix=".jpg", dir=str(dest_path.parent))
    os.close(tmp_fd)
    try:
        async with httpx.AsyncClient(timeout=12.0, follow_redirects=True) as client:
            resp = await client.get(image_url, headers=headers)
            resp.raise_for_status()
            if len(resp.content) < 512:
                raise RuntimeError("Prázdny náhľadový obrázok")
            Path(tmp_name).write_bytes(resp.content)
        score = await asyncio.to_thread(_image_score, tmp_name)
        if score <= 0:
            raise RuntimeError("Náhľadový obrázok je prázdny alebo príliš tmavý")
        os.replace(tmp_name, dest_path)
        return float(score)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


async def _resolve_vault_stream_candidate(item: Dict[str, Any]) -> tuple[str, str, str]:
    """Return (stream_url, image_fallback_url, referer) for non-Telegram vault items."""
    from .config import config

    port = int(getattr(config, "SERVER_PORT", 8000) or 8000)
    playable = str(item.get("playable_url") or "").strip()
    raw_url = str(item.get("url") or "").strip()
    src_url = str(item.get("source_url") or raw_url).strip()

    if playable.startswith("/api/"):
        return f"http://127.0.0.1:{port}{playable}", "", src_url
    if playable.startswith(("http://", "https://")) and _DIRECT_VIDEO_RE.search(playable):
        return playable, "", src_url
    if raw_url.startswith(("http://", "https://")) and _DIRECT_VIDEO_RE.search(raw_url):
        return raw_url, "", src_url

    target = src_url or raw_url
    if target.startswith(("http://", "https://")):
        try:
            from .extractors.media_router import resolve_media
            info = await asyncio.wait_for(resolve_media(target), timeout=14.0)
            if isinstance(info, dict):
                resolved_stream = str(info.get("stream_url") or info.get("url") or "").strip()
                resolved_thumb = str(info.get("thumbnail") or "").strip()
                if resolved_stream.startswith(("http://", "https://")):
                    return resolved_stream, resolved_thumb, target
                if resolved_thumb.startswith(("http://", "https://")):
                    return "", resolved_thumb, target
        except Exception as exc:
            logger.debug("[CreatorThumbs] resolve_media skipped for %s: %s", target, exc)

    return "", "", src_url


async def enhance_creator_thumbnail(
    db: Session,
    item: Dict[str, Any],
    *,
    reroll: bool = False,
) -> Dict[str, Any]:
    """Generate or upgrade thumbnail for any Creator Radar card (vault or library)."""
    from .config import config
    from .database import Video, utcnow
    from .maintenance import _generate_thumb_from_stream
    from .telegram_rethumb import repair_thumbnail
    from .telegram_service import is_telegram_library_video, library_telegram_stream_path
    from .telegram_stream import public_chat_id

    cache_key = cache_key_for_item(item)
    lock = _item_locks.setdefault(cache_key, asyncio.Lock())

    async with lock:
        video_id = int(item.get("video_id") or 0)
        ts = int(time.time())

        # 1. Položka už v Knižnici
        if video_id > 0:
            video = db.get(Video, video_id)
            if not video:
                raise ValueError("Video v knižnici nebolo nájdené")

            if is_telegram_library_video(video):
                tg_path = library_telegram_stream_path(video) or ""
                m = re.search(r"/telegram/stream/(-?\d+)/(\d+)", tg_path)
                if not m:
                    raise ValueError("Chýba Telegram identifikátor videa")
                raw_cid, msg_id = int(m.group(1)), int(m.group(2))
                pub_cid = public_chat_id(raw_cid)
                generated = await repair_thumbnail(pub_cid, msg_id, float(video.duration or item.get("duration_sec") or 0), reroll=reroll)
                _save_to_creator_cache(generated, cache_key)
                durable_url = f"/api/v1/telegram/thumb/{pub_cid}/{msg_id}"
                _sync_telegram_thumb_db(db, raw_cid, pub_cid, msg_id, durable_url)
                return {
                    "ok": True,
                    "cache_key": cache_key,
                    "thumbnail": f"{durable_url}?v={ts}",
                    "persistent_thumbnail": durable_url,
                    "enhanced": True,
                }

            seek_frac = round(random.uniform(0.14, 0.86), 3)
            thumb_dir = str(get_library_thumb_dir())
            ok = await _generate_thumb_from_stream(video, thumb_dir, seek_frac=seek_frac)
            if not ok or not video.thumbnail_path:
                raise RuntimeError("Nepodarilo sa vygenerovať lepší náhľad z videa")
            video.smart_rethumb_at = utcnow()
            video.smart_rethumb_error = None
            video.preview_retry_needed = False
            db.commit()
            return {
                "ok": True,
                "cache_key": cache_key,
                "thumbnail": f"{video.thumbnail_path}?v={ts}",
                "persistent_thumbnail": video.thumbnail_path,
                "enhanced": True,
            }

        # 2. Telegram položka v Local Vaulte
        tg_pair = _extract_tg_pair(item)
        if tg_pair:
            pub_cid, msg_id = tg_pair
            meta = item.get("telegram_meta") if isinstance(item.get("telegram_meta"), dict) else {}
            raw_cid = int(meta.get("chat_id") or pub_cid)
            duration = float(item.get("duration_sec") or meta.get("duration") or 0)
            generated = await repair_thumbnail(pub_cid, msg_id, duration, reroll=reroll)
            _save_to_creator_cache(generated, cache_key)
            tg_url = f"/api/v1/telegram/thumb/{pub_cid}/{msg_id}"
            _sync_telegram_thumb_db(db, raw_cid, pub_cid, msg_id, tg_url)
            radar_url = f"/api/v1/radar/thumb/{cache_key}.jpg?v={ts}"
            return {
                "ok": True,
                "cache_key": cache_key,
                "thumbnail": radar_url,
                "telegram_thumbnail": f"{tg_url}?v={ts}",
                "enhanced": True,
            }

        # 3. Ostatné položky z Local Vaultu (Fóra / MEGA / Filester / Fronta)
        stream_url, image_fallback, referer = await _resolve_vault_stream_candidate(item)
        if not stream_url and not image_fallback:
            raise ValueError("Táto položka nemá priamy stream na vytvorenie náhľadu")

        dest_dir = get_creator_thumb_dir()
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file = dest_dir / f"{sanitize_cache_key(cache_key)}.jpg"

        if stream_url:
            if stream_url.startswith("/"):
                port = int(getattr(config, "SERVER_PORT", 8000) or 8000)
                stream_url = f"http://127.0.0.1:{port}{stream_url}"
            duration = float(item.get("duration_sec") or 0)
            try:
                score = await _extract_best_frame_from_stream(
                    stream_url,
                    dest_file,
                    duration=duration,
                    referer=referer,
                    reroll=reroll,
                )
            except Exception:
                if image_fallback:
                    score = await _download_and_score_image(image_fallback, dest_file, referer=referer)
                else:
                    raise
        else:
            score = await _download_and_score_image(image_fallback, dest_file, referer=referer)

        cleanup_expired_creator_thumbs(force=False)
        return {
            "ok": True,
            "cache_key": cache_key,
            "thumbnail": f"/api/v1/radar/thumb/{cache_key}.jpg?v={ts}",
            "score": score,
            "enhanced": True,
        }


async def enhance_creator_thumbnails_iter(
    items: Iterable[Dict[str, Any]],
    *,
    reroll: bool = False,
    concurrency: int = 4,
) -> AsyncIterator[Dict[str, Any]]:
    """Run batch thumbnail enhancement concurrently and stream per-item progress."""
    from .database import SessionLocal

    sem = asyncio.Semaphore(max(1, min(6, int(concurrency or 4))))
    indexed_items = list(enumerate(items))

    async def _one(idx: int, item: Dict[str, Any]) -> Dict[str, Any]:
        async with sem, _batch_gate:
            try:
                with SessionLocal() as work_db:
                    res = await enhance_creator_thumbnail(work_db, item, reroll=reroll)
                return {
                    "index": idx,
                    "id": str(item.get("id") or ""),
                    "ok": True,
                    **res,
                }
            except Exception as exc:
                return {
                    "index": idx,
                    "id": str(item.get("id") or ""),
                    "ok": False,
                    "error": str(exc)[:180],
                }

    tasks = [asyncio.create_task(_one(idx, it)) for idx, it in indexed_items]
    try:
        for fut in asyncio.as_completed(tasks):
            yield await fut
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
