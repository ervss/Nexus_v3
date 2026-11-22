import asyncio
import json
import logging
import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from ..auth import check_auth
from ..database import TelegramLinkPost, get_db, utcnow
from ..telegram_service import (
    normalize_channel_name,
    save_telegram_library_video,
    list_forum_topics,
    load_saved_forum_topics,
    scrape_channel_via_telethon,
    search_all_joined_channels,
    joined_video_chats,
    telegram_import_spec,
    _chat_id_for_username,
)
from sqlalchemy.orm import Session
from ..telegram_index import (
    search_telegram_fts,
    upsert_telegram_media_batch,
    get_telegram_index_stats,
    clear_telegram_index,
    sync_channel_to_index,
)
from ..telegram_stream import (
    ensure_post_thumb,
    ensure_thumb,
    get_video_message,
    iter_video,
    parse_range,
)
from ..telegram_search_history import save_search, list_searches, get_search
from ..telegram_catalog import catalog_status, set_enabled, worker as catalog_worker
from ..telegram_stream import public_chat_id


def _catalog_peers(chat_ids: str) -> list[int]:
    try:
        parts = [part.strip() for part in chat_ids.split(',') if part.strip()]
        if len(parts) > 1000:
            raise ValueError('too many channels')
        return [int(part) for part in parts]
    except ValueError as exc:
        raise HTTPException(400, 'Invalid channel IDs') from exc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/telegram", tags=["telegram"])


class TelegramDiscoveryRequest(BaseModel):
    keywords: str = Field(default="", max_length=200)
    date_from: __import__("datetime").date
    max_joins: int = Field(default=5, ge=1, le=50)
    delay: int = Field(default=30, ge=5, le=3600)
    manual_channels: list[str] = Field(default_factory=list, max_length=100)
    resume: bool = False


@router.post("/discover")
async def telegram_discover(body: TelegramDiscoveryRequest, auth: bool = Depends(check_auth)):
    from ..telegram_discovery import worker, username
    if not body.resume and not body.keywords.strip() and not body.manual_channels:
        raise HTTPException(400, "Zadajte kľúčové slová alebo kanály")
    if any(not username(item) for item in body.manual_channels):
        raise HTTPException(400, "Použite iba verejné @username alebo t.me odkazy na kanály")
    try:
        return await worker.submit({**body.model_dump(), "date_from": body.date_from.isoformat()})
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/discover/status")
async def telegram_discover_status(auth: bool = Depends(check_auth)):
    from ..telegram_discovery import status
    return status()


@router.get("/joined_video_chats")
async def get_joined_video_chats(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Joined Telegram channels and groups with server-side video totals."""
    try:
        cached = catalog_status(db)
        if cached['discovered_at']:
            return {"chats": cached['channels'], "cached": True}
        # Populate the channel registry without waiting for hundreds of video
        # counters. Totals arrive with the first indexing page per channel.
        from ..telegram_stream import client
        await catalog_worker.discover(await client())
        db.expire_all()
        return {"chats": catalog_status(db)['channels'], "cached": True}
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except Exception as exc:
        logger.warning("Could not list joined Telegram chats: %s", exc)
        raise HTTPException(502, "Telegram channels could not be loaded") from exc


@router.get("/topics/saved")
async def telegram_topics_saved(auth: bool = Depends(check_auth)):
    """Topics already stored locally, so the picker can show them before Telegram answers."""
    try:
        return {"channels": load_saved_forum_topics()}
    except Exception as exc:
        logger.warning("Could not read saved Telegram topics: %s", exc)
        raise HTTPException(502, "Uložené thready sa nepodarilo načítať") from exc


@router.get("/topics")
async def telegram_topics(channel: str, counts: str = "auto", batch: int = 0, skip: int = 0, auth: bool = Depends(check_auth)):
    """Forum topics for one joined channel or group, with video counts.

    counts=missing fills only threads that still have no number.
    counts=all recounts every thread and skips the short cache.
    batch is how many totals to ask for in this call.
    skip continues an all recount in topic-id order.
    """
    if counts not in {"auto", "missing", "all"}:
        raise HTTPException(400, "counts must be auto, missing, or all")
    if batch < 0 or batch > 200:
        raise HTTPException(400, "batch must be 0..200")
    if skip < 0 or skip > 1000:
        raise HTTPException(400, "skip must be 0..1000")
    try:
        return await list_forum_topics(channel, counts=counts, batch=batch, skip=skip)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.warning("Could not list Telegram topics for %s: %s", channel, exc)
        raise HTTPException(502, "Thready sa nepodarilo načítať") from exc


class TelegramHistorySave(BaseModel):
    query: str = Field(default="", max_length=200)
    chats: list[dict] = Field(default_factory=list, max_length=100)
    results: list[dict] = Field(default_factory=list, max_length=100000)
    displayed_results: list[dict] = Field(default_factory=list, max_length=100000)
    filters: dict = Field(default_factory=dict)


class TelegramCatalogCommand(BaseModel):
    enabled: bool
    priority_chat_ids: list[str] | None = Field(default=None, max_length=1000)


@router.get('/catalog')
async def telegram_catalog_status(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    return catalog_status(db)


@router.post('/catalog')
async def telegram_catalog_command(body: TelegramCatalogCommand, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    set_enabled(body.enabled, body.priority_chat_ids)
    if body.priority_chat_ids is not None:
        catalog_worker.pending_priorities = set(body.priority_chat_ids)
    await catalog_worker.start()
    return catalog_status(db)


@router.get('/catalog/search')
async def telegram_catalog_search(query: str = '', limit: int = 50, min_duration: int = 0,
                                  min_quality: int = 0, min_size_mb: float = 0, chat_ids: str = '', offset: int = 0,
                                  new_only: bool = False,
                                  before_date: str = '', before_id: int = 0,
                                  sort: str = 'relevance', exclude: str = '',
                                  db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    limit = max(1, min(limit, 2000))
    offset = max(0, offset)
    videos = search_telegram_fts(
        db, query, limit=limit + 1, offset=offset, min_duration=min_duration,
        min_quality=min_quality, min_size_mb=min_size_mb,
        chat_ids=[public_chat_id(peer) for peer in _catalog_peers(chat_ids)], new_only=new_only,
        before_date=before_date, before_id=before_id,
        sort=sort, exclude=exclude,
    )
    return {"source": "fts5_local", "videos": videos[:limit], "has_more": len(videos) > limit, "coverage": catalog_status(db), "new_only": new_only}


@router.get('/live-new-stream')
async def telegram_live_new_stream(auth: bool = Depends(check_auth)):
    from ..telegram_live_new import stream_new_videos
    async def events():
        async for payload in stream_new_videos():
            yield f'data: {json.dumps(payload)}\n\n'
    return StreamingResponse(events(), media_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@router.get("/search_history")
async def telegram_search_history(auth: bool = Depends(check_auth)):
    return {"searches": list_searches()}


@router.get("/search_history/{search_id}")
async def telegram_search_history_item(search_id: str, auth: bool = Depends(check_auth)):
    record = get_search(search_id)
    if record is None:
        raise HTTPException(404, "Search not found")
    return record


@router.post("/search_history")
async def save_telegram_search_history(body: TelegramHistorySave, auth: bool = Depends(check_auth)):
    return save_search(body.query, body.chats, body.results, body.displayed_results, body.filters)


def _headers(start: int, end: int, size: int, *, partial: bool) -> dict:
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        "Cache-Control": "private",
    }
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return headers


@router.api_route("/stream/{chat_id}/{message_id}", methods=["GET", "HEAD"])
async def stream_video(chat_id: int, message_id: int, request: Request):
    from telethon.errors import FloodWaitError
    try:
        connection, _message, document = await get_video_message(chat_id, message_id)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except FloodWaitError as exc:
        wait = max(1, int(getattr(exc, "seconds", 5) or 5))
        raise HTTPException(503, f"Telegram rate limit ({wait}s)", headers={"Retry-After": str(wait)}) from exc

    size = int(document.size or 0)
    if size <= 0:
        raise HTTPException(404, "empty video")
    try:
        span = parse_range(request.headers.get("range"), size)
    except ValueError:
        return Response(status_code=416, headers={
            "Content-Range": f"bytes */{size}",
            "Accept-Ranges": "bytes",
        })

    start, end = span or (0, size - 1)
    partial = span is not None
    headers = _headers(start, end, size, partial=partial)
    media_type = document.mime_type or "video/mp4"
    if request.method == "HEAD":
        return Response(status_code=206 if partial else 200, headers=headers, media_type=media_type)
    return StreamingResponse(
        iter_video(connection, document, start, end, chat_id=chat_id, message_id=message_id,
                   preview_only=request.query_params.get("preview") == "1"),
        status_code=206 if partial else 200,
        media_type=media_type,
        headers=headers,
    )


class TelegramThumbItem(BaseModel):
    chat_id: int
    message_id: int = Field(gt=0)
    has_thumbnail: bool = True


class TelegramThumbInspect(BaseModel):
    items: list[TelegramThumbItem] = Field(max_length=5000)


class TelegramThumbRepair(BaseModel):
    chat_id: int
    message_id: int = Field(gt=0)
    duration: float = Field(default=0, ge=0)


class TelegramThumbRepairBatch(BaseModel):
    items: list[TelegramThumbRepair] = Field(max_length=1000)


def _mark_thumb_repaired(db: Session, raw_chat_id: int, chat_id: int, message_id: int, path: str) -> None:
    from ..database import TelegramMediaIndex, Video, utcnow
    indexed = db.query(TelegramMediaIndex).filter_by(chat_id=chat_id, message_id=message_id).first()
    if indexed:
        indexed.thumbnail, indexed.has_thumb = path, True
    rows = db.query(Video).filter(
        Video.telegram_chat_id.in_([str(chat_id), str(raw_chat_id)]),
        Video.telegram_message_id == message_id,
    ).all()
    for video in rows:
        video.thumbnail_path = path
        video.smart_rethumb_at = utcnow()
        video.smart_rethumb_error = None
        video.preview_retry_needed = False
    db.commit()


@router.post("/thumbs/inspect")
async def inspect_telegram_thumbs(body: TelegramThumbInspect, auth: bool = Depends(check_auth)):
    from ..telegram_rethumb import inspect_thumbnail
    def inspect_all():
        return [dict(chat_id=item.chat_id, message_id=item.message_id,
                     **inspect_thumbnail(item.chat_id, item.message_id, item.has_thumbnail))
                for item in body.items]
    return {"items": await asyncio.to_thread(inspect_all)}


@router.post("/thumbs/repair")
async def repair_telegram_thumb(body: TelegramThumbRepair, db: Session = Depends(get_db),
                                auth: bool = Depends(check_auth)):
    from ..telegram_rethumb import repair_thumbnail
    chat_id = public_chat_id(body.chat_id)
    try:
        await repair_thumbnail(chat_id, body.message_id, body.duration)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.warning("Telegram thumbnail repair failed: %s", exc)
        raise HTTPException(502, "Snímku z Telegram videa sa nepodarilo načítať") from exc
    path = f"/api/v1/telegram/thumb/{chat_id}/{body.message_id}"
    _mark_thumb_repaired(db, body.chat_id, chat_id, body.message_id, path)
    return {"ok": True, "thumbnail": path}


@router.post("/thumbs/repair-batch")
async def repair_telegram_thumbs_batch(
    body: TelegramThumbRepairBatch,
    auth: bool = Depends(check_auth),
):
    """Stream parallel Telegram thumbnail repairs as NDJSON."""
    import json
    from fastapi.responses import StreamingResponse
    from ..database import SessionLocal
    from ..telegram_rethumb import repair_thumbnails_iter

    triples = [(it.chat_id, it.message_id, it.duration) for it in body.items]

    async def _gen():
        done = 0
        failed = 0
        async for ev in repair_thumbnails_iter(triples, concurrency=5):
            if ev.get("ok"):
                done += 1
                try:
                    with SessionLocal() as db:
                        _mark_thumb_repaired(
                            db, ev["raw_chat_id"], ev["chat_id"], ev["message_id"], ev["thumbnail"]
                        )
                except Exception as db_exc:  # noqa: BLE001
                    logger.warning("Telegram batch thumb DB update failed: %s", db_exc)
            else:
                failed += 1
            yield json.dumps({"type": "progress", **ev}, ensure_ascii=False) + "\n"
        yield json.dumps({"type": "done", "done": done, "failed": failed}, ensure_ascii=False) + "\n"

    return StreamingResponse(
        _gen(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/thumb/{chat_id}/{message_id}")
async def video_thumb(chat_id: int, message_id: int):
    try:
        path = await ensure_thumb(chat_id, message_id)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, no-cache"})


_VIDEO_TYPES = ("video", "round_video")


class TelegramScrapeRequest(BaseModel):
    channel: str = Field(min_length=1, max_length=128)
    limit: int = Field(default=100, ge=1, le=2000)
    query: Optional[str] = Field(default=None, max_length=200)
    min_duration: int = Field(default=0, ge=0)
    min_quality: int = Field(default=0, ge=0)
    min_size_mb: float = Field(default=0, ge=0)
    topic_id: int = Field(default=0, ge=0)
    with_topics: bool = True


def _parse_clip_duration(duration) -> int:
    if not duration:
        return 0
    if isinstance(duration, (int, float)):
        return int(duration)
    parts = str(duration).split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        return int(parts[0])
    except (ValueError, TypeError):
        return 0


_QUALITY_HINT_RE = re.compile(r"\b(2160p|4k|uhd|1440p|2k|1080p|fhd|full[\s_-]?hd|720p|hd|480p|sd|360p)\b", re.I)


def _parse_quality_text(text: str) -> tuple[int, str]:
    if not text:
        return 0, ""
    match = _QUALITY_HINT_RE.search(text)
    if not match:
        return 0, ""
    token = match.group(1).lower()
    if token in ("2160p", "4k", "uhd"):
        return 2160, "4K"
    if token in ("1440p", "2k"):
        return 1440, "1440p"
    if token in ("1080p", "fhd", "fullhd", "full-hd", "full_hd"):
        return 1080, "1080p"
    if token in ("720p", "hd"):
        return 720, "720p"
    if token in ("480p", "sd"):
        return 480, "480p"
    if token == "360p":
        return 360, "360p"
    return 0, ""


def _video_rows(messages, min_duration: int = 0, min_quality: int = 0, min_size_mb: float = 0) -> list[dict]:
    rows = []
    for message in messages:
        clips = [item for item in message.media if item.type in _VIDEO_TYPES]
        if not clips:
            continue
        text = " ".join((message.text or "").split())
        for clip in clips:
            dur_sec = _parse_clip_duration(clip.duration)
            if min_duration > 0 and dur_sec < min_duration:
                continue
            raw_q = getattr(clip, "quality", "") or ""
            clip_title = getattr(clip, "title", "") or ""
            clip_url = getattr(clip, "url", "") or ""
            res, quality = _parse_quality_text(f"{raw_q} {clip_title} {text} {clip_url}")
            if min_quality > 0 and res < min_quality:
                continue
            if min_size_mb > 0 and (getattr(clip, "size", 0) or 0) < min_size_mb * 1048576:
                continue
            rows.append({
                "id": message.id,
                "channel": message.channel,
                "url": message.url,
                "video_url": clip.url,
                "thumbnail": clip.thumbnail,
                "duration": clip.duration,
                "duration_sec": dur_sec,
                "media_type": clip.type,
                "date": message.date.isoformat() if message.date else None,
                "text": text[:500],
                "views": getattr(message, "views", 0) or 0,
                "size_bytes": getattr(clip, "size", 0) or 0,
                "quality": quality or raw_q,
                "effective_res": res,
                "width": 0,
                "height": res,
                "orientation": "landscape",
                "author": message.author,
                "preview_unavailable": not clip.url,
            })
    return rows


def _scrape_channel(channel: str, limit: int, query: Optional[str], min_duration: int = 0, min_quality: int = 0, min_size_mb: float = 0) -> dict:
    import tgscraper as tg
    from tgscraper.client import ChannelNotFound, ScraperError

    cleaned = channel.strip()
    word = (query or "").strip() or None
    try:
        messages = tg.scrape(
            cleaned,
            limit,
            query=word,
            media_types=list(_VIDEO_TYPES),
            max_pages=max(12, limit * 4 if (min_duration > 0 or min_quality > 0 or min_size_mb > 0) else limit * 2),
        )
    except (ChannelNotFound, ValueError) as exc:
        raise HTTPException(404, str(exc)) from exc
    except ScraperError as exc:
        raise HTTPException(502, str(exc)) from exc
    videos = _video_rows(messages, min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb)
    return {
        "channel": tg.normalize_channel(cleaned),
        "query": word,
        "limit": limit,
        "count": len(videos),
        "videos": videos,
    }


def _payload(channel: str, query: Optional[str], limit: int, videos: list, source: str) -> dict:
    return {
        "channel": channel,
        "query": query,
        "limit": limit,
        "count": len(videos),
        "source": source,
        "videos": videos,
    }


@router.post("/scrape")
async def scrape_channel(body: TelegramScrapeRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Read channel videos with the logged-in Telethon account, then the public preview."""
    word = (body.query or "").strip() or None
    name = normalize_channel_name(body.channel)
    timeout_sec = max(90, min(300, int(body.limit) * 2))
    try:
        videos = await asyncio.wait_for(
            scrape_channel_via_telethon(
                body.channel, body.limit, query=word, min_duration=body.min_duration, min_quality=body.min_quality,
                min_size_mb=body.min_size_mb, topic_id=body.topic_id or None, with_topics=body.with_topics,
            ),
            timeout=timeout_sec,
        )
        if videos:
            try:
                upsert_telegram_media_batch(db, videos)
            except Exception as idx_err:
                logger.warning("Auto-indexing telethon channel scrape failed: %s", idx_err)
        return _payload(name, word, body.limit, videos, "telethon")
    except asyncio.TimeoutError as exc:
        raise HTTPException(504, "Telegram scrape timed out") from exc
    except Exception as exc:
        logger.warning("Telethon scrape failed for %s, using public preview: %s", name, exc)
        if body.topic_id:
            raise HTTPException(502, "Thread sa nepodarilo načítať") from exc
    try:
        web = await asyncio.wait_for(
            asyncio.to_thread(_scrape_channel, body.channel, body.limit, word, body.min_duration, body.min_quality, body.min_size_mb),
            timeout=timeout_sec,
        )
        if web.get("videos"):
            try:
                upsert_telegram_media_batch(db, web["videos"])
            except Exception as idx_err:
                logger.warning("Auto-indexing web channel scrape failed: %s", idx_err)
    except asyncio.TimeoutError as exc:
        raise HTTPException(504, "Telegram scrape timed out") from exc
    web["source"] = "tgscraper"
    return web


def _index_scraped_videos(items: list[dict]) -> None:
    if not items:
        return
    try:
        from ..database import SessionLocal
        with SessionLocal() as index_db:
            upsert_telegram_media_batch(index_db, items)
    except Exception as idx_err:
        logger.warning("Auto-indexing telegram stream results failed: %s", idx_err)


async def stream_channel_scrape(
    channel_name: str,
    limit: int,
    query: Optional[str] = None,
    min_duration: int = 0,
    min_quality: int = 0,
    min_size_mb: float = 0,
    topic_id: int = 0,
):
    name = normalize_channel_name(channel_name)
    capped = max(1, min(int(limit), 2000))
    word = (query or "").strip() or None

    yield {
        "status": "init",
        "message": f"Iniciujem vyhľadávanie v kanáli @{name}...",
        "channel": name,
        "target": capped,
        "scanned": 0,
        "matched": 0,
    }

    # Step 1: Try Telethon
    telethon_failed = False
    try:
        from ..telegram_service import stream_scrape_channel_via_telethon

        async for evt in stream_scrape_channel_via_telethon(
            name, capped, word, min_duration, min_quality, min_size_mb, topic_id=topic_id or None,
        ):
            if evt.get("status") == "done" and evt.get("videos"):
                await asyncio.to_thread(_index_scraped_videos, evt["videos"])
            yield evt
            if evt.get("status") == "done":
                return
    except Exception as exc:
        telethon_failed = True
        logger.warning("Telethon scrape failed for %s, falling back to web preview: %s", name, exc)
        if topic_id:
            yield {
                "status": "error",
                "error": "Thread sa nepodarilo načítať. Verejný náhľad thready nevidí.",
                "channel": name,
            }
            return
        err_text = str(exc)
        is_db_locked = "database is locked" in err_text.lower()
        is_numeric_id = name.lstrip("-").isdigit()
        is_auth_error = isinstance(exc, PermissionError) or "API ID and Hash are required" in err_text
        if is_db_locked:
            yield {
                "status": "error",
                "error": "Databáza Telegram session je momentálne uzamknutá (používa ju iný proces alebo požiadavka). Skúste to znova o chvíľu alebo reštartujte server.",
                "channel": name,
            }
            return
        if is_numeric_id:
            if is_auth_error:
                yield {
                    "status": "error",
                    "error": f"Pre prístup ku kanálu s numerickým ID @{name} je potrebné prihlásiť sa do Telegram účtu v Nastaveniach aplikácie (verejný webový náhľad podporuje len @username).",
                    "needs_auth": True,
                    "channel": name,
                }
            else:
                yield {
                    "status": "error",
                    "error": f"Chyba pri načítaní kanála @{name} cez Telegram účet: {exc}",
                    "channel": name,
                }
            return
        yield {
            "status": "info",
            "message": (
                "Telegram účet nie je pripojený. Prepínam na verejný webový náhľad kanála..."
                if is_auth_error
                else f"Telegram účet zlyhal ({exc}). Prepínam na verejný webový náhľad kanála..."
            ),
            "channel": name,
        }

    # Step 2: Fallback to web preview (tgscraper)
    if telethon_failed:
        from tgscraper import Scraper
        from tgscraper.client import ChannelNotFound, ScraperError

        yield {
            "status": "connecting",
            "message": f"Pripájanie k verejnému náhľadu https://t.me/s/{name}...",
            "channel": name,
            "target": capped,
        }

        scraper = Scraper()
        rows = []
        scanned = 0
        buffer = []

        def fetch_all():
            try:
                pages_max = max(12, capped * 4 if (min_duration > 0 or min_quality > 0 or min_size_mb > 0) else capped * 2)
                messages = []
                raw_word = (word or "").strip()
                keywords = [k.lower().strip() for k in raw_word.split(",") if k.strip()] if raw_word else []
                if len(keywords) > 1:
                    for msg in scraper.iter_messages(name, limit=capped * 4, query=None, max_pages=pages_max):
                        text = (getattr(msg, "text", "") or "").lower()
                        if any(kw in text for kw in keywords):
                            messages.append(msg)
                            if len(messages) >= capped * 4:
                                break
                else:
                    single_query = keywords[0] if keywords else None
                    for msg in scraper.iter_messages(name, limit=capped * 4, query=single_query, max_pages=pages_max):
                        messages.append(msg)
                        if len(messages) >= capped * 4:
                            break
                return messages, None
            except Exception as e:
                return None, e

        messages, err = await asyncio.to_thread(fetch_all)
        if err is not None:
            if isinstance(err, (ChannelNotFound, ValueError)):
                yield {
                    "status": "error",
                    "error": f"Kanál @{name} nemá verejný webový náhľad (Telegram blokuje webový náhľad pre 18+ kanály). Pre prístup k tomuto kanálu je potrebné prihlásiť sa do Telegram účtu v Nastaveniach aplikácie.",
                    "needs_auth": True,
                    "channel": name,
                }
                return
            yield {
                "status": "error",
                "error": f"Chyba pri čítaní verejného náhľadu kanála: {err}",
                "channel": name,
            }
            return

        for i, msg in enumerate(messages):
            scanned += 1
            batch_rows = _video_rows([msg], min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb)
            for r in batch_rows:
                rows.append(r)
                buffer.append(r)
                if len(rows) >= capped:
                    break
            if buffer and (len(buffer) >= 3 or len(rows) >= capped or i == len(messages) - 1):
                yield {
                    "status": "progress",
                    "message": f"Nájdených {len(rows)}/{capped} videí (prehľadaných {scanned} správ)...",
                    "scanned": scanned,
                    "matched": len(rows),
                    "target": capped,
                    "new_videos": buffer,
                }
                buffer = []
            if len(rows) >= capped:
                break

        if rows:
            await asyncio.to_thread(_index_scraped_videos, rows)

        yield {
            "status": "done",
            "message": f"Hľadanie dokončené. Nájdených {len(rows)} videí.",
            "scanned": scanned,
            "matched": len(rows),
            "target": capped,
            "videos": rows,
            "source": "tgscraper",
        }


@router.get("/scrape_stream")
async def scrape_channel_stream(
    channel: str,
    limit: int = 50,
    query: Optional[str] = None,
    min_duration: int = 0,
    min_quality: int = 0,
    min_size_mb: float = 0,
    topic_id: int = 0,
    auth: bool = Depends(check_auth),
):
    """Real-time streaming scrape for Telegram channels via Server-Sent Events."""
    async def event_generator():
        try:
            async for payload in stream_channel_scrape(
                channel, limit, query=query, min_duration=min_duration, min_quality=min_quality,
                min_size_mb=min_size_mb, topic_id=topic_id,
            ):
                yield f"data: {json.dumps(payload)}\n\n"
        except asyncio.CancelledError:
            logger.info("Client cancelled scrape stream for %s", channel)
            yield f"data: {json.dumps({'status': 'stopped', 'message': 'Scrape zastavený používateľom'})}\n\n"
        except Exception as exc:
            logger.exception("Scrape stream failed for %s: %s", channel, exc)
            yield f"data: {json.dumps({'status': 'error', 'error': str(exc)})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class TelegramIndexSyncRequest(BaseModel):
    channel: Optional[str] = None
    limit: int = Field(default=100, ge=1, le=1000)
    query: Optional[str] = None


@router.get("/index/stats")
async def telegram_index_stats(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Return local Telegram FTS5 index stats (number of cached videos, channels, sizes)."""
    return get_telegram_index_stats(db)


@router.post("/index/sync")
async def telegram_index_sync(body: TelegramIndexSyncRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Manually sync a channel into the local FTS5 index."""
    if body.channel:
        res = await sync_channel_to_index(body.channel, limit=body.limit, query=body.query)
        return res
    raise HTTPException(400, "Channel parameter required for direct sync")


@router.delete("/index/clear")
async def telegram_index_clear(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Clear all records from local Telegram FTS5 index."""
    set_enabled(False)
    await catalog_worker.stop()
    from ..database import TelegramCatalogChannel, TelegramCatalogControl
    db.query(TelegramCatalogChannel).update({
        'cursor': 0, 'head_id': 0, 'refresh_cursor': 0, 'refresh_target': 0,
        'scanned': 0, 'complete': False, 'last_sync': 0, 'retry_at': 0, 'error': '',
    })
    db.query(TelegramCatalogControl).update({'rate': 0, 'last_batch_at': 0})
    deleted = clear_telegram_index(db)
    return {"status": "ok", "deleted": deleted}


@router.get("/search_global")
async def search_global(
    query: str = "", limit: int = 50, min_duration: int = 0, min_quality: int = 0, min_size_mb: float = 0,
    force_live: bool = False,
    chat_ids: str = '',
    sort: str = 'relevance',
    exclude: str = '',
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth)
):
    """Search videos across every channel, group, and chat.
    Uses local SQLite FTS5 + compound hybrid index for instant retrieval.
    Falls back to live Telethon network search if local index has no matches or force_live is True,
    merging newly discovered live hits back into the local index.
    """
    from ..telegram_index import _parse_search_query
    word = (query or "").strip()
    capped = max(1, min(int(limit or 50), 2000))
    peers = _catalog_peers(chat_ids)
    public_peers = [public_chat_id(peer) for peer in peers]
    if not word:
        return {"query": "", "limit": capped, "count": 0, "source": "empty", "videos": []}

    # 1. Instant local hybrid FTS5 search
    if not force_live:
        fts_videos = search_telegram_fts(
            db, word, limit=capped, min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb,
            chat_ids=public_peers, sort=sort, exclude=exclude,
        )
        if fts_videos:
            return {
                "query": word,
                "limit": capped,
                "count": len(fts_videos),
                "source": "fts5_local",
                "videos": fts_videos,
            }

    # 2. Live Telethon network search fallback (or when force_live is requested)
    _fts_expr, pos_groups, _neg_tokens = _parse_search_query(word, exclude)
    live_query = ", ".join(" ".join(group) for group in pos_groups) if pos_groups else word
    try:
        timeout_sec = max(90, min(300, capped * 2))
        async def live_search():
            if not peers:
                return await search_all_joined_channels(live_query, capped, min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb)
            per_peer = max(10, -(-capped // len(peers)))
            found = []
            for peer in peers:
                found.extend(await scrape_channel_via_telethon(str(peer), per_peer, query=live_query,
                    min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb, with_topics=False))
            return found
        videos = await asyncio.wait_for(
            live_search(),
            timeout=timeout_sec,
        )
        # 3. Auto-populate local FTS5 index and merge local + live hits
        if videos:
            try:
                upsert_telegram_media_batch(db, videos)
            except Exception as e:
                logger.warning("Failed to auto-index live telegram results: %s", e)
        merged = search_telegram_fts(
            db, word, limit=capped, min_duration=min_duration, min_quality=min_quality, min_size_mb=min_size_mb,
            chat_ids=public_peers, sort=sort, exclude=exclude,
        )
        if merged:
            videos = merged
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except asyncio.TimeoutError as exc:
        raise HTTPException(504, "Global search timed out") from exc
    except Exception as exc:
        logger.warning("Global Telegram search failed: %s", exc)
        raise HTTPException(502, "Global search failed") from exc

    return {"query": word, "limit": capped, "count": len(videos or []), "source": "telethon_live", "videos": videos or []}


class TelegramImportRequest(BaseModel):
    batch_name: Optional[str] = None
    chat_id: Optional[int] = None
    message_id: Optional[int] = None
    channel_id: Optional[int] = None
    source_url: str = ""
    stream_url: str = ""
    url: str = ""
    title: str = ""
    thumbnail: str = ""
    duration: Optional[str | int | float] = None
    views: Optional[int] = None
    upload_date: str = ""
    quality: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    effective_res: Optional[int] = None
    size_bytes: Optional[int] = None
    orientation: Optional[str] = None


@router.post("/import")
async def import_telegram_video(body: TelegramImportRequest, db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Store a Quantum Search Telegram hit as a library row that plays through Telethon."""
    spec = telegram_import_spec(body.url or body.source_url or body.stream_url, body.model_dump())
    if spec is None:
        raise HTTPException(422, "Telegram chat_id and message_id are required")
    if not spec.get("chat_id"):
        username = spec.get("username")
        if not username:
            raise HTTPException(422, "Telegram chat_id and message_id are required")
        try:
            spec["chat_id"] = await _chat_id_for_username(username)
        except Exception as exc:
            logger.warning("Telegram import could not resolve a chat: %s", exc)
            raise HTTPException(422, "Telegram chat_id and message_id are required") from exc
    video, created = save_telegram_library_video(db, spec, batch_name=(body.batch_name or "Quantum Search")[:255])
    if created:
        from ..services import VIPVideoProcessor
        VIPVideoProcessor().broadcast_new_video(video)
    return {
        "id": video.id,
        "status": video.status,
        "existing": not created,
        "url": video.url,
        "source_url": video.source_url,
        "chat_id": video.telegram_chat_id,
        "message_id": video.telegram_message_id,
        "storage_type": video.storage_type,
    }


@router.get("/post-thumb/{chat_id}/{message_id}")
async def post_thumb(chat_id: int, message_id: int):
    try:
        path = await ensure_post_thumb(chat_id, message_id)
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})


class TelegramLinkScanRequest(BaseModel):
    query: str = Field(default="", max_length=200)
    channel: str = Field(default="", max_length=128)
    chat_ids: list[int] = Field(default_factory=list, max_length=50)
    limit: int = Field(default=80, ge=10, le=400)


class TelegramLinkSendToHubRequest(BaseModel):
    mega_url: Optional[str] = Field(default=None, max_length=512)


class TelegramLinkStatusRequest(BaseModel):
    status: Literal["new", "opened", "in_hub", "dead", "skipped"]


@router.get("/links")
def list_telegram_links(
    query: str = "",
    channel: str = "",
    chat_ids: str = "",
    status: str = "active",
    link_kind: str = "all",
    sort: str = "newest",
    limit: int = 60,
    offset: int = 0,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..telegram_links import search_telegram_links_local

    peers = _catalog_peers(chat_ids) if chat_ids.strip() else None
    return search_telegram_links_local(
        db,
        query=query,
        channel=channel,
        chat_ids=peers,
        status=status,
        link_kind=link_kind,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.post("/links/scan")
async def scan_telegram_links(
    body: TelegramLinkScanRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..telegram_links import scan_telegram_links_live

    try:
        return await scan_telegram_links_live(
            db,
            query=body.query,
            channel=body.channel,
            chat_ids=body.chat_ids or None,
            limit=body.limit,
        )
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/links/seed")
def seed_telegram_links(
    limit: int = 5000,
    chat_ids: str = "",
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..telegram_links import seed_links_from_media_index

    peers = _catalog_peers(chat_ids) if chat_ids.strip() else None
    return seed_links_from_media_index(db, limit=limit, chat_ids=peers)


@router.get("/links/channels-stats")
def telegram_link_channels_stats(
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Vráti rebríček Telegram kanálov podľa kvality (priame MEGA, rentry/paste bez brány, skryté entity, mŕtve)."""
    from ..telegram_links import get_telegram_link_channels_stats

    return get_telegram_link_channels_stats(db)


class TelegramLinkBackfillRequest(BaseModel):
    chat_ids: list[int] = Field(default_factory=list, max_length=30)
    query: str = Field(default="", max_length=200)
    limit: int = Field(default=300, ge=10, le=2000)
    only_missing: bool = True
    resolve_pastes: bool = True
    max_paste_crawls: int = Field(default=40, ge=0, le=200)


@router.post("/links/backfill-entities")
async def backfill_telegram_links(
    body: TelegramLinkBackfillRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Hromadne doplní skryté Telegram entity (MessageEntityTextUrl + inline tlačidlá) pre staršie karty."""
    from ..telegram_links import backfill_telegram_link_entities

    try:
        return await backfill_telegram_link_entities(
            db,
            chat_ids=body.chat_ids or None,
            query=body.query,
            limit=body.limit,
            only_missing=body.only_missing,
            resolve_pastes=body.resolve_pastes,
            max_paste_crawls=body.max_paste_crawls,
        )
    except PermissionError as exc:
        raise HTTPException(401, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/links/{post_id}/resolve")
async def resolve_telegram_link(
    post_id: int,
    alt_url: Optional[str] = None,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    import httpx

    from .. import mega_autopilot
    from ..mega_link_extractor import extract_text_links
    from ..telegram_links import (
        _sync_hub_entries_state,
        parse_extracted_links,
        serialize_link_post,
        summarize_discovered_links,
    )
    from . import mega_hub

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    target_url: Optional[str] = None
    if alt_url:
        parsed_caption = extract_text_links(post.caption or "")
        extracted = parse_extracted_links(post)
        allowed = (
            set((parsed_caption or {}).get("external_urls") or [])
            | {str(e.get("url") or "") for e in extracted}
            | {str(e.get("raw_url") or "") for e in extracted}
            | {str(e.get("decoded_url") or "") for e in extracted}
            | {post.raw_url, post.final_url}
        )
        cleaned_alt = alt_url.strip()
        if cleaned_alt in allowed:
            target_url = cleaned_alt
        else:
            raise HTTPException(400, "Zadaný alternatívny odkaz nepatrí k tomuto príspevku.")

    try:
        res = await mega_autopilot.resolve_post_candidates(db, post, target_url=target_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (httpx.HTTPError, TimeoutError):
        return {
            "item": serialize_link_post(post),
            "mega_status": "retry",
            "hops": 0,
            "resolved_target_url": target_url or post.raw_url,
            "error": "Cieľová adresa momentálne neodpovedá.",
        }

    bag = res["bag"]
    mega_status = "external_gate"
    if len(bag["mega"]) > 1:
        v_res = await mega_autopilot.verify_discovered_megas(db, post)
        mega_status = "available" if v_res["summary"]["mega_alive"] > 0 else "unavailable"
    elif bag["mega"]:
        mega_url = bag["mega"][0]["url"]
        snap = await mega_hub._inspect(mega_hub.parse_share(mega_url))
        mega_status = snap.get("status", "retry")
        bag["mega"][0]["status"] = mega_status
        if snap.get("title"):
            bag["mega"][0]["title"] = str(snap["title"])[:180]
        if mega_status == "available":
            vcount = len(snap.get("videos", []))
            bag["mega"][0]["video_count"] = vcount
            post.mega_video_count = vcount
        elif mega_status == "unavailable":
            bag["mega"][0]["video_count"] = 0
            if not bag["media"]:
                post.status = "dead"
        from ..telegram_links import save_post_discovered_links
        save_post_discovered_links(post, bag)
        db.commit()
    elif bag["media"]:
        mega_status = "media_only"

    _sync_hub_entries_state(db)
    db.refresh(post)
    return {
        "item": serialize_link_post(post),
        "mega_status": mega_status,
        "hops": int(res.get("hops", 0)),
        "resolved_target_url": res["final_url"],
        "resolved_via": res.get("resolved_via", "clean_http"),
        "harvest_summary": summarize_discovered_links(bag),
    }


class TelegramLinkHarvestRequest(BaseModel):
    raw_text: str = Field(default="", max_length=20000)
    source_url: Optional[str] = Field(default=None, max_length=1024)
    mega_urls: list[str] = Field(default_factory=list, max_length=80)
    media_urls: list[str] = Field(default_factory=list, max_length=80)
    verify: bool = True


class TelegramLinkSendAllMegaRequest(BaseModel):
    mega_urls: list[str] = Field(default_factory=list, max_length=60)


class TelegramLinkSendMediaIntakeRequest(BaseModel):
    media_urls: list[str] = Field(default_factory=list, max_length=40)


@router.post("/links/{post_id}/harvest")
async def harvest_telegram_link_post(
    post_id: int,
    body: TelegramLinkHarvestRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Vloží a spracuje text / rentry URL / zoznam viacerých MEGA a non-MEGA odkazov pre kartu."""
    from .. import mega_autopilot
    from ..mega_link_extractor import (
        classify_media_url,
        decode_local_wrapper_url,
        extract_mega_urls,
        extract_paste_container_urls,
        extract_supported_media_urls,
        extract_text_links,
        resolve_clean_redirect,
    )
    from ..telegram_links import (
        _sync_hub_entries_state,
        merge_discovered_links,
        parse_discovered_links,
        save_cached_resolution,
        save_post_discovered_links,
        serialize_link_post,
        summarize_discovered_links,
    )

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    raw_text = (body.raw_text or "").strip()
    megas = list(extract_mega_urls(raw_text, extra_urls=body.mega_urls))
    medias = list(extract_supported_media_urls(raw_text, extra_urls=body.media_urls))
    containers = list(extract_paste_container_urls(raw_text, extra_urls=[body.source_url] if body.source_url else ()))

    # Ak používateľ vložil rentry/pastebin alebo dynamic?r= URL (prípadne link-to.net), rovno ju rozbalíme!
    urls_to_crawl: list[str] = []
    if raw_text:
        parsed_input = extract_text_links(raw_text)
        if parsed_input:
            for ext_u in parsed_input.get("external_urls") or []:
                dec = decode_local_wrapper_url(ext_u) or ext_u
                if not classify_media_url(dec):
                    urls_to_crawl.append(dec)
    for cont in containers:
        if cont["url"] not in urls_to_crawl:
            urls_to_crawl.append(cont["url"])

    for crawl_u in urls_to_crawl[:3]:
        try:
            crawled = await resolve_clean_redirect(crawl_u)
        except Exception:  # noqa: BLE001
            continue
        for m in crawled.get("mega_urls") or []:
            if m not in megas:
                megas.append(m)
        seen_med = {x["url"] for x in medias}
        for med in crawled.get("media_urls") or []:
            if med.get("url") and med["url"] not in seen_med:
                seen_med.add(med["url"])
                medias.append(med)
        for c in crawled.get("container_urls") or []:
            containers.append(c)

    if not megas and not medias and not containers:
        raise HTTPException(400, "V zadanom texte sa nenašli žiadne MEGA, Bunkr/Gofile/Pixeldrain ani paste odkazy.")

    bag = merge_discovered_links(
        parse_discovered_links(post),
        mega_urls=megas,
        media_urls=medias,
        container_urls=containers,
    )
    save_post_discovered_links(post, bag)
    if megas and not post.resolved_mega_url:
        post.resolved_mega_url = megas[0]
        post.final_url = megas[0]
        post.domain = "mega.nz"
        if post.link_kind == "external":
            post.link_kind = "resolved_mega"
    post.updated_at = utcnow()
    db.commit()

    # Zapíšeme do lokálnej cache pre pôvodnú URL karty aj vloženú paste URL
    for key_u in dict.fromkeys(u for u in (post.raw_url, post.final_url, body.source_url, *urls_to_crawl[:2]) if u and "mega.nz" not in u.lower()):
        save_cached_resolution(
            db,
            key_u,
            final_url=megas[0] if megas else (medias[0]["url"] if medias else key_u),
            mega_urls=megas,
            media_urls=medias,
            container_urls=containers,
            provider="manual_harvest",
        )

    if body.verify and bag["mega"]:
        await mega_autopilot.verify_discovered_megas(db, post)

    _sync_hub_entries_state(db)
    db.refresh(post)
    final_bag = parse_discovered_links(post)
    return {
        "ok": True,
        "summary": summarize_discovered_links(final_bag),
        "item": serialize_link_post(post),
    }


@router.post("/links/{post_id}/send-all-mega")
async def send_all_mega_links_to_hub(
    post_id: int,
    body: TelegramLinkSendAllMegaRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Hromadne odošle vybrané (alebo všetky živé) objavené MEGA priečinky z karty do MEGA Hubu."""
    from ..telegram_links import (
        _sync_hub_entries_state,
        parse_discovered_links,
        serialize_link_post,
    )
    from . import mega_hub

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    bag = parse_discovered_links(post)
    requested = [u.strip() for u in (body.mega_urls or []) if u and u.strip()]
    if requested:
        targets = list(dict.fromkeys(requested))
    else:
        targets = [
            m["url"]
            for m in bag["mega"]
            if m.get("status") in {"available", "unchecked", "retry", ""} and not m.get("hub_entry_id")
        ]
    if not targets:
        raise HTTPException(400, "Žiadne dostupné MEGA odkazy na odoslanie do Hubu.")

    added = 0
    exists = 0
    failed = 0
    entries: list[dict] = []
    for u in targets:
        try:
            res = await mega_hub.add_share_to_hub(
                db,
                url=u,
                title_override=post.title,
                link_post_id=post.id,
                keep_handoff=True,
            )
            st = res.get("status")
            if st == "added":
                added += 1
            elif st == "exists":
                exists += 1
            else:
                failed += 1
            if res.get("entry"):
                entries.append(res["entry"])
        except Exception:  # noqa: BLE001
            db.rollback()
            failed += 1

    _sync_hub_entries_state(db)
    db.refresh(post)
    return {
        "ok": True,
        "added": added,
        "exists": exists,
        "failed": failed,
        "entries": entries,
        "item": serialize_link_post(post),
    }


@router.post("/links/{post_id}/send-media-intake")
def send_discovered_media_to_intake(
    post_id: int,
    body: TelegramLinkSendMediaIntakeRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Pošle objavené non-MEGA media odkazy (Bunkr, Gofile, Pixeldrain, Cyberdrop, Erome...) do Nexus Intake fronty."""
    from ..intake import IntakeCandidate, IntakeImportRequest, create_import_job, intake_worker, serialize_job
    from ..mega_link_extractor import classify_media_url
    from ..telegram_links import parse_discovered_links, serialize_link_post

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    bag = parse_discovered_links(post)
    media_map = {m["url"]: m for m in bag["media"]}
    raw_targets = [u.strip() for u in (body.media_urls or []) if u and u.strip()]
    targets: list[dict] = []
    if raw_targets:
        for u in dict.fromkeys(raw_targets):
            if u in media_map:
                targets.append(media_map[u])
            else:
                info = classify_media_url(u)
                if info:
                    targets.append(info)
    else:
        targets = list(bag["media"])

    if not targets:
        raise HTTPException(400, "Karta neobsahuje žiadne podporované media odkazy pre Intake.")

    candidates = [
        IntakeCandidate(
            title=f"{post.title or 'Telegram'} · {item.get('label') or item.get('host') or 'Media'}",
            url=item["url"],
            source_url=item["url"],
            thumbnail=post.thumbnail or "",
            source=str(item.get("host") or "external"),
            confidence=0.85,
            warnings=["telegram_link_harvest", f"tg_link_post_id:{post.id}"],
        )
        for item in targets
    ]
    batch_name = f"TG Links - {(post.title or post.channel_title or 'Pack')[:60]}"
    job = create_import_job(
        IntakeImportRequest(
            candidates=candidates,
            batch_name=batch_name,
            source_mode="mixed",
            auto_metadata=True,
            playwright_fallback=True,
        ),
        db,
    )
    intake_worker.start()
    return {
        "ok": True,
        "imported": len(candidates),
        "job": serialize_job(job),
        "item": serialize_link_post(post),
    }


@router.post("/links/{post_id}/send-to-hub")
async def send_telegram_link_to_hub(
    post_id: int,
    body: TelegramLinkSendToHubRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..mega_link_extractor import combine_mega_url_and_key, extract_keyless_mega_urls
    from ..telegram_links import serialize_link_post
    from . import mega_hub

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    raw_input = (body.mega_url or "").strip()
    combined_from_key = False
    keyless_list = extract_keyless_mega_urls(post.caption or "", extra_urls=(post.raw_url or "",))
    if raw_input and keyless_list:
        combined = combine_mega_url_and_key(keyless_list[0]["url"], raw_input)
        if combined:
            combined_from_key = not raw_input.lower().startswith(("http://", "https://", "mega."))
            raw_input = combined

    target_url = raw_input or (post.resolved_mega_url or "").strip()
    if not target_url and post.link_kind == "direct_mega":
        target_url = (post.raw_url or "").strip()
    if not target_url:
        raise HTTPException(400, "Chýba priamy mega.nz odkaz alebo dešifrovací kľúč.")

    res = await mega_hub.add_share_to_hub(
        db,
        url=target_url,
        title_override=post.title,
        link_post_id=post.id,
    )
    db.refresh(post)
    if combined_from_key and res.get("status") == "open_in_mega":
        raise HTTPException(400, "Zadaný kľúč neodomkol tento MEGA priečinok — skontroluj, či patrí k tejto karte.")
    if res.get("status") == "unavailable" and post.status != "in_hub":
        post.status = "dead"
        post.updated_at = utcnow()
        db.commit()
        db.refresh(post)
    return {**res, "item": serialize_link_post(post)}


@router.post("/links/{post_id}/handoff")
def handoff_telegram_link(
    post_id: int,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..mega_link_extractor import extract_keyless_mega_urls
    from ..telegram_links import serialize_link_post
    from . import mega_hub

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    if post.status == "new":
        post.status = "opened"
        post.updated_at = utcnow()
        db.commit()
        db.refresh(post)

    keyless = extract_keyless_mega_urls(post.caption or "", extra_urls=(post.raw_url or "",))
    kl = keyless[0] if keyless else None
    handoff = mega_hub.register_link_handoff(
        post.id,
        post.title or post.channel_title or post.channel or "",
        post.raw_url,
        keyless_mega_url=kl["url"] if kl else None,
        keyless_mega_kind=kl["kind"] if kl else None,
    )
    return {"ok": True, "handoff": handoff, "item": serialize_link_post(post)}


@router.post("/links/{post_id}/status")
def update_telegram_link_status(
    post_id: int,
    body: TelegramLinkStatusRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from ..telegram_links import serialize_link_post

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")

    post.status = body.status
    post.updated_at = utcnow()
    db.commit()
    db.refresh(post)
    return {"ok": True, "item": serialize_link_post(post)}


class MegaAutopilotConfigRequest(BaseModel):
    enabled: Optional[bool] = None
    min_videos: Optional[int] = Field(default=None, ge=1, le=500)
    auto_scan: Optional[bool] = None
    auto_add: Optional[bool] = None
    scan_chat_ids: Optional[list[int]] = Field(default=None, max_length=20)


@router.get("/links/autopilot")
def mega_autopilot_status(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    from .. import mega_autopilot

    return mega_autopilot.get_status(db)


@router.post("/links/autopilot/config")
def mega_autopilot_config(
    body: MegaAutopilotConfigRequest,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    from .. import mega_autopilot

    mega_autopilot.configure(**body.model_dump())
    return mega_autopilot.get_status(db)


@router.post("/links/autopilot/run")
async def mega_autopilot_run(db: Session = Depends(get_db), auth: bool = Depends(check_auth)):
    """Okamžitý beh pipeline (aj keď je autopilot vypnutý)."""
    from .. import mega_autopilot

    stats = await mega_autopilot.autopilot_tick(force=True)
    return {"stats": stats, **mega_autopilot.get_status(db)}


@router.post("/links/{post_id}/process")
async def process_telegram_link(
    post_id: int,
    add: bool = True,
    db: Session = Depends(get_db),
    auth: bool = Depends(check_auth),
):
    """Jedno tlačidlo: rozbaliť -> overiť -> (add=true) poslať do MEGA Hubu.

    Ručná voľba používateľa ignoruje prah min_videos (stačí 1 video)."""
    from .. import mega_autopilot

    post = db.get(TelegramLinkPost, post_id)
    if post is None:
        raise HTTPException(404, "Telegram link príspevok sa nenašiel.")
    return await mega_autopilot.process_post(db, post, add=add, min_videos=1)


class DirectMegaSearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=200)
    verify: bool = True
    max_verify: int = Field(default=24, ge=1, le=50)
    only_alive: bool = True


@router.post("/links/direct-search")
async def direct_mega_search(
    body: DirectMegaSearchRequest,
    auth: bool = Depends(check_auth),
):
    """Vyhľadá priame mega.nz odkazy (web, paste, telegra.ph, Reddit, t.me/s) a hneď ich overí."""
    from ..mega_direct_search import search_direct_mega_links

    return await search_direct_mega_links(
        body.query,
        verify=body.verify,
        max_verify=body.max_verify,
        only_alive=body.only_alive,
    )