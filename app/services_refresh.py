"""Unified, bounded, deduplicated async video-link refresh service."""
from __future__ import annotations

import asyncio
import datetime
import logging
import os
import re
from typing import Optional

from app.database import SessionLocal, Video
from app.extractors.circuit_breaker import extractor_circuit_breaker
from app.stats_cache import stats_cache

logger = logging.getLogger(__name__)

_TURBO_CDN_ID_RE = re.compile(r"turbocdn\.[^/]+/turbo/data/([A-Za-z0-9_-]+)\.", re.IGNORECASE)
_REFRESH_SEMAPHORE = asyncio.Semaphore(4)
_INFLIGHT_REFRESHES: dict[int, asyncio.Task] = {}


def turbo_page_url_from_cdn(url: str) -> Optional[str]:
    """Reconstruct a canonical https://turbo.cr/v/<id> page URL from a turbocdn media URL."""
    match = _TURBO_CDN_ID_RE.search(url or "")
    if match:
        return f"https://turbo.cr/v/{match.group(1)}"
    return None


def _apply_extracted_meta(video: Video, meta: dict) -> None:
    video.url = meta["stream_url"]
    if meta.get("title") and (
        not video.title or any(x in str(video.title).lower() for x in ("queued", "untitled"))
    ):
        video.title = meta["title"]
    if meta.get("height"):
        h = int(meta["height"])
        video.height = h
        video.quality = (
            "4K" if h >= 2160
            else "1440p" if h >= 1440
            else "FHD" if h >= 1080
            else "HD" if h >= 720
            else "SD"
        )
    if meta.get("width"):
        video.width = int(meta["width"])
    if meta.get("duration") and not video.duration:
        video.duration = float(meta["duration"])
    if meta.get("size_bytes") and not video.file_size_mb:
        video.file_size_mb = round(int(meta["size_bytes"]) / (1024 * 1024), 2)
    video.last_checked = datetime.datetime.now()
    video.status = "ready_to_stream"
    video.error_msg = None


async def _do_refresh_video_link(video_id: int) -> Optional[str]:
    db = SessionLocal()
    try:
        v = db.query(Video).get(video_id)
        if not v or not (v.source_url or v.url):
            return None

        from app.telegram_service import apply_telegram_library_target, is_telegram_library_video
        if is_telegram_library_video(v):
            apply_telegram_library_target(v)
            v.last_checked = datetime.datetime.now()
            db.commit()
            stats_cache.invalidate("health_sources")
            return v.url

        # 1. Registered extractor plugins (Filester, FileDitch, Turbo, Bunkr, Eporner, Camwhores, etc.)
        try:
            from app.extractors import init_registry, register_extended_extractors
            from app.extractors.registry import ExtractorRegistry

            init_registry()
            register_extended_extractors()

            lookup_target = v.source_url or v.url or ""
            plugin = ExtractorRegistry.find_extractor(lookup_target)
            if not plugin:
                turbo_page = turbo_page_url_from_cdn(v.url or "")
                if turbo_page:
                    lookup_target = turbo_page
                    plugin = ExtractorRegistry.find_extractor(lookup_target)

            if plugin:
                allowed, retry_after = extractor_circuit_breaker.allow(lookup_target)
                if not allowed:
                    logger.info(
                        "[Refresh] Circuit open for %s (retry in %.1fs), skipping video %s",
                        lookup_target,
                        retry_after,
                        video_id,
                    )
                    return None
                meta = await asyncio.wait_for(plugin.extract(lookup_target), timeout=35.0)
                if meta and meta.get("stream_url"):
                    extractor_circuit_breaker.record_success(lookup_target)
                    _apply_extracted_meta(v, meta)
                    db.commit()
                    stats_cache.invalidate("health_sources")
                    logger.info("[Refresh] Healed video %s via %s", video_id, plugin.name)
                    return v.url
                extractor_circuit_breaker.record_failure(lookup_target, "empty stream_url")
        except Exception as plugin_exc:
            logger.warning("[Refresh] Plugin refresh failed for video %s: %s", video_id, plugin_exc)
            extractor_circuit_breaker.record_failure(v.source_url or v.url or "", type(plugin_exc).__name__)

        # 2. Webshare API fallback
        src_or_url = v.source_url or v.url or ""
        if "webshare.cz" in src_or_url or "wsfiles.cz" in src_or_url or src_or_url.startswith("webshare:"):
            try:
                from app.extractors.legacy.webshare import WebshareAPI, parse_webshare_ident
                ident = parse_webshare_ident(v.source_url or "") or parse_webshare_ident(v.url or "")
                if ident:
                    new_link = await asyncio.to_thread(WebshareAPI().get_vip_link, ident)
                    if new_link:
                        v.url = new_link
                        v.last_checked = datetime.datetime.now()
                        v.status = "ready_to_stream"
                        db.commit()
                        stats_cache.invalidate("health_sources")
                        return v.url
            except Exception as ws_exc:
                logger.warning("[Refresh] Webshare refresh failed for video %s: %s", video_id, ws_exc)

        # 3. yt-dlp fallback for generic watch pages (runs in thread pool)
        target_for_ytdlp = v.source_url or v.url or ""
        if target_for_ytdlp.startswith(("http://", "https://")):
            allowed, _ = extractor_circuit_breaker.allow(target_for_ytdlp)
            if not allowed:
                return None
            import yt_dlp

            cookie_file = "xvideos.cookies.txt" if "xvideos.com" in target_for_ytdlp else None
            is_deep = any(
                d in target_for_ytdlp.lower()
                for d in ("xvideos.com", "xhamster.com", "eporner.com")
            )
            opts = {
                "quiet": True,
                "skip_download": True,
                "no_warnings": True,
                "ignoreerrors": True,
                "socket_timeout": 15,
                "retries": 1,
                "format": "best[protocol*=m3u8]/best[ext=mp4]/best",
                "extract_flat": not is_deep,
            }
            if cookie_file and os.path.exists(cookie_file):
                opts["cookiefile"] = cookie_file

            def _extract_yt():
                with yt_dlp.YoutubeDL(opts) as ydl:
                    return ydl.extract_info(target_for_ytdlp, download=False)

            info = await asyncio.wait_for(asyncio.to_thread(_extract_yt), timeout=35.0)
            if info and info.get("url"):
                extractor_circuit_breaker.record_success(target_for_ytdlp)
                v.url = info["url"]
                if info.get("height"):
                    v.height = int(info["height"])
                v.last_checked = datetime.datetime.now()
                v.status = "ready_to_stream"
                db.commit()
                stats_cache.invalidate("health_sources")
                logger.info("[Refresh] Healed video %s via yt-dlp", video_id)
                return v.url
            extractor_circuit_breaker.record_failure(target_for_ytdlp, "yt-dlp empty")
        return None
    except Exception as exc:
        logger.error("[Refresh] Failed for video %s: %s", video_id, exc)
        db.rollback()
        return None
    finally:
        db.close()


async def async_refresh_video_link(video_id: int) -> Optional[str]:
    """Coalesce and throttle concurrent refreshes for the same video_id."""
    existing = _INFLIGHT_REFRESHES.get(video_id)
    if existing and not existing.done():
        return await asyncio.shield(existing)

    async def _runner():
        async with _REFRESH_SEMAPHORE:
            return await _do_refresh_video_link(video_id)

    task = asyncio.create_task(_runner())
    _INFLIGHT_REFRESHES[video_id] = task
    try:
        return await task
    finally:
        if _INFLIGHT_REFRESHES.get(video_id) is task:
            _INFLIGHT_REFRESHES.pop(video_id, None)


def schedule_background_refresh(video_id: int) -> bool:
    """Schedule a deduplicated async refresh on the running event loop when available."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        import threading
        threading.Thread(target=refresh_video_link_sync, args=(video_id,), daemon=True).start()
        return True

    if video_id in _INFLIGHT_REFRESHES and not _INFLIGHT_REFRESHES[video_id].done():
        return False
    loop.create_task(async_refresh_video_link(video_id))
    return True


def refresh_video_link_sync(video_id: int) -> Optional[str]:
    """Synchronous compatibility wrapper for callers running outside an event loop."""
    return asyncio.run(async_refresh_video_link(video_id))
