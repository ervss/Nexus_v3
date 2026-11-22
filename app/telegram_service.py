"""Logged-in Telegram channel scrape.

The function lives here, not under ``app/services/``, because ``app/services.py``
is the existing dashboard module. A ``services`` package would replace it.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

from telethon.errors import FloodWaitError
from telethon.tl.functions.messages import (
    GetForumTopicsByIDRequest,
    GetForumTopicsRequest,
    GetSearchCountersRequest,
    SearchRequest,
)
from telethon.tl.types import (
    Chat,
    ChatForbidden,
    DocumentAttributeFilename,
    DocumentAttributeVideo,
    ForumTopic,
    InputMessagesFilterVideo,
)

from .telegram_stream import client, public_chat_id
from .telegram_metadata import extract_telegram_metadata

logger = logging.getLogger(__name__)

_PAGE = 20
_PAGE_PAUSE = 0.4
_GLOBAL_PAUSE = 0.5
_FLOOD_CAP = 45
_GLOBAL_FLOOD_CAP = 90
_TOPIC_COUNT_CAP = 50
_TOPIC_COUNT_BATCH = 40
_TOPIC_REFRESH_CAP = 200
_TOPIC_LIST_CACHE: dict[str, tuple[float, dict]] = {}
_TOPIC_LIST_TTL = 600
_SEARCH_SEM: asyncio.Semaphore | None = None
_SEARCH_COOLDOWN = 0.0
_LINK_RE = re.compile(r"^(?:https?://)?(?:t\.me|telegram\.me)/", re.I)


def normalize_channel_name(channel_name: str) -> str:
    name = (channel_name or "").strip()
    name = _LINK_RE.sub("", name)
    name = name.split("?", 1)[0].strip("/")
    if name.lower().startswith("s/"):
        name = name[2:]
    name = name.split("/", 1)[0]
    if name.startswith("@"):
        name = name[1:]
    name = re.sub(r"\s+", "", name)
    return name


def _duration_label(seconds: int | None) -> str | None:
    if not seconds:
        return None
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


_QUALITY_HINT_RE = re.compile(r"\b(2160p|4k|uhd|1440p|2k|1080p|fhd|full[\s_-]?hd|720p|hd|480p|sd|360p)\b", re.I)


def _resolve_quality(w: int, h: int, hint_text: str = "") -> tuple[int, str]:
    short_edge = min(w, h) if (w > 0 and h > 0) else max(w, h)
    long_edge = max(w, h)
    if short_edge >= 2160 or long_edge >= 3840:
        return max(short_edge, 2160), "4K"
    if short_edge >= 1440 or long_edge >= 2560:
        return max(short_edge, 1440), "1440p"
    if short_edge >= 1080 or long_edge >= 1920:
        return max(short_edge, 1080), "1080p"
    if short_edge >= 720 or long_edge >= 1280:
        return max(short_edge, 720), "720p"
    if short_edge >= 480 or long_edge >= 840:
        return max(short_edge, 480), "480p"
    if short_edge > 0:
        return short_edge, f"{short_edge}p"

    if hint_text:
        match = _QUALITY_HINT_RE.search(hint_text)
        if match:
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


def _document(message):
    document = getattr(message, "document", None)
    if document is not None:
        return document
    media = getattr(message, "media", None)
    return getattr(media, "document", None)


def topic_id_from_message(message) -> int | None:
    """Forum topic id carried by a message. General (id 1) stays unlabeled."""
    reply = getattr(message, "reply_to", None)
    if reply is None:
        return None

    def _positive(value) -> int:
        try:
            number = int(value)
        except (TypeError, ValueError):
            return 0
        return number if number > 1 else 0

    raw_top = getattr(reply, "reply_to_top_id", None)
    if raw_top is not None:
        return _positive(raw_top) or None
    if getattr(reply, "forum_topic", None):
        return _positive(getattr(reply, "reply_to_msg_id", None)) or None
    return None


def topic_page_url(entity, channel_name: str, topic_id: int) -> str:
    username = getattr(entity, "username", None)
    if username:
        return f"https://t.me/{username}/{int(topic_id)}"
    raw = int(getattr(entity, "id", 0) or 0)
    bare = public_chat_id(raw)
    if bare < 0:
        bare = abs(bare)
    return f"https://t.me/c/{bare}/{int(topic_id)}"


def _video_meta(message) -> dict | None:
    document = _document(message)
    if document is None:
        return None
    attributes = list(getattr(document, "attributes", None) or [])
    video_attr = next((item for item in attributes if isinstance(item, DocumentAttributeVideo)), None)
    filename_attr = next((item for item in attributes if isinstance(item, DocumentAttributeFilename)), None)
    mime = str(getattr(document, "mime_type", "") or "")
    if video_attr is None and not mime.startswith("video/") and not getattr(message, "video", None):
        return None
    round_video = bool(getattr(video_attr, "round_message", False))
    raw_duration = getattr(video_attr, "duration", None) if video_attr else None

    w = int(getattr(video_attr, "w", 0) or 0)
    h = int(getattr(video_attr, "h", 0) or 0)
    file_name = str(getattr(filename_attr, "file_name", "") or "")
    text_content = str(getattr(message, "message", "") or "")
    effective_res, quality = _resolve_quality(w, h, f"{file_name} {text_content}")

    orientation = "portrait" if (h > w and w > 0) else ("landscape" if (w > h and h > 0) else "landscape")
    file_name = str(getattr(filename_attr, "file_name", "") or "")
    size_bytes = int(getattr(document, "size", 0) or 0)
    supports_streaming = bool(getattr(video_attr, "supports_streaming", False))
    nosound = bool(getattr(video_attr, "nosound", False))

    total_reactions = 0
    reactions = getattr(message, "reactions", None)
    if reactions and hasattr(reactions, "results"):
        total_reactions = sum(int(getattr(r, "count", 0) or 0) for r in reactions.results)

    return {
        "duration": _duration_label(raw_duration),
        "duration_sec": int(raw_duration) if raw_duration is not None else 0,
        "media_type": "round_video" if round_video else "video",
        "has_thumb": bool(getattr(document, "thumbs", None)),
        "width": w,
        "height": h,
        "effective_res": effective_res,
        "quality": quality,
        "orientation": orientation,
        "size_bytes": size_bytes,
        "file_name": file_name,
        "supports_streaming": supports_streaming,
        "nosound": nosound,
        "reactions": total_reactions,
    }


def _row(message, entity, channel_name: str, forced_topic_id: int | None = None) -> dict | None:
    meta = _video_meta(message)
    if meta is None or not getattr(message, "id", None):
        return None
    raw_id = int(getattr(entity, "id"))
    chat_id = -abs(raw_id) if isinstance(entity, (Chat, ChatForbidden)) else public_chat_id(raw_id)
    username = getattr(entity, "username", None) or channel_name
    text = (getattr(message, "message", None) or "").strip()
    metadata = extract_telegram_metadata(text, meta["file_name"], message_id=message.id)
    date = getattr(message, "date", None)
    topic_id = topic_id_from_message(message)
    if topic_id is None and forced_topic_id and int(forced_topic_id) > 1:
        topic_id = int(forced_topic_id)
    document = _document(message)
    return {
        "id": int(message.id),
        "channel": username,
        "url": f"https://t.me/{username}/{message.id}" if getattr(entity, "username", None) else f"https://t.me/c/{chat_id}/{message.id}",
        "video_url": f"/api/v1/telegram/stream/{chat_id}/{message.id}",
        "thumbnail": f"/api/v1/telegram/thumb/{chat_id}/{message.id}" if meta["has_thumb"] else None,
        "duration": meta["duration"],
        "duration_sec": meta["duration_sec"],
        "media_type": meta["media_type"],
        "date": date.isoformat() if date else None,
        "text": text,
        **metadata,
        "file_id": str(getattr(document, "id", "") or ""),
        "channel_title": getattr(entity, "title", None) or channel_name,
        "views": int(getattr(message, "views", 0) or 0),
        "forwards": int(getattr(message, "forwards", 0) or 0),
        "reactions": meta["reactions"],
        "size_bytes": meta["size_bytes"],
        "width": meta["width"],
        "height": meta["height"],
        "effective_res": meta["effective_res"],
        "quality": meta["quality"],
        "orientation": meta["orientation"],
        "file_name": meta["file_name"],
        "supports_streaming": meta["supports_streaming"],
        "nosound": meta["nosound"],
        "author": getattr(message, "post_author", None) or getattr(entity, "title", None),
        "preview_unavailable": False,
        "chat_id": chat_id,
        "message_id": int(message.id),
        "topic_id": topic_id,
        "topic_title": None,
        "topic_video_count": None,
        "topic_url": topic_page_url(entity, channel_name, topic_id) if topic_id else None,
        "topic_channel": getattr(entity, "username", None) or channel_name,
    }


def _search_semaphore() -> asyncio.Semaphore:
    global _SEARCH_SEM
    if _SEARCH_SEM is None:
        _SEARCH_SEM = asyncio.Semaphore(1)
    return _SEARCH_SEM


async def _telegram_call(connection, action, *, background: bool = False, max_flood: int | None = None):
    global _SEARCH_COOLDOWN
    remaining = _SEARCH_COOLDOWN - time.monotonic()
    if remaining > 0:
        if background or (max_flood is not None and remaining > max_flood):
            raise FloodWaitError(request=None, capture=int(remaining) + 1)
        await asyncio.sleep(remaining)

    async def attempt():
        global _SEARCH_COOLDOWN
        try:
            return await action()
        except FloodWaitError as exc:
            wait = int(exc.seconds) + 1
            _SEARCH_COOLDOWN = max(_SEARCH_COOLDOWN, time.monotonic() + wait)
            if background or (max_flood is not None and wait > max_flood):
                raise
            logger.warning("Telegram flood wait %ss while scraping", wait)
            await asyncio.sleep(wait)
            return await action()

    async with _search_semaphore():
        return await attempt()


async def _get_messages(connection, entity, **kwargs):
    topic_id = kwargs.pop("topic_id", None)
    background = kwargs.pop("_background", False)

    async def action():
        if not topic_id:
            return await connection.get_messages(entity, **kwargs)
        video_filter = kwargs.get("filter") or InputMessagesFilterVideo()
        if isinstance(video_filter, type):
            video_filter = video_filter()
        result = await connection(SearchRequest(
            peer=entity,
            q=kwargs.get("search") or "",
            filter=video_filter,
            min_date=None,
            max_date=None,
            offset_id=int(kwargs.get("offset_id") or 0),
            add_offset=0,
            limit=int(kwargs.get("limit") or _PAGE),
            max_id=0,
            min_id=0,
            hash=0,
            top_msg_id=int(topic_id),
        ))
        messages = [item for item in (getattr(result, "messages", None) or []) if getattr(item, "id", None)]
        messages.sort(key=lambda item: int(item.id), reverse=True)
        return messages

    return await _telegram_call(connection, action, background=background)


class _TopicBook:
    def __init__(self):
        self.titles: dict[int, str] = {}
        self.counts: dict[int, int | None] = {}

    def public(self) -> list[dict]:
        rows = []
        for topic_id, title in self.titles.items():
            rows.append({
                "id": topic_id,
                "title": title,
                "video_count": self.counts.get(topic_id),
            })
        return rows


def _stamp_topics(rows: list[dict], book: _TopicBook) -> None:
    for row in rows:
        topic_id = row.get("topic_id")
        if not topic_id:
            continue
        title = book.titles.get(int(topic_id))
        if title:
            row["topic_title"] = title
        if int(topic_id) in book.counts:
            row["topic_video_count"] = book.counts[int(topic_id)]


async def _load_topic_titles(connection, entity, topic_ids: list[int], book: _TopicBook) -> None:
    missing = [int(topic_id) for topic_id in topic_ids if int(topic_id) not in book.titles]
    for start in range(0, len(missing), 50):
        chunk = missing[start:start + 50]
        try:
            result = await _telegram_call(
                connection,
                lambda chunk=chunk: connection(GetForumTopicsByIDRequest(peer=entity, topics=chunk)),
            )
        except Exception as exc:
            logger.warning("Forum topic titles failed: %s", exc)
            break
        for topic in getattr(result, "topics", None) or []:
            topic_id = getattr(topic, "id", None)
            if not topic_id:
                continue
            title = getattr(topic, "title", None)
            if title and not getattr(topic, "title_missing", False):
                book.titles[int(topic_id)] = str(title)
            elif type(topic).__name__ == "ForumTopicDeleted":
                book.titles[int(topic_id)] = "Zmazaný thread"
    for topic_id in missing:
        book.titles.setdefault(int(topic_id), f"Thread {int(topic_id)}")


async def _load_topic_counts(connection, entity, topic_ids: list[int], book: _TopicBook, limit: int | None = None) -> bool:
    """Ask Telegram for video totals. False means the batch stopped before every id."""
    cap = _TOPIC_COUNT_CAP if limit is None else max(0, int(limit))
    missing = [int(topic_id) for topic_id in topic_ids if int(topic_id) not in book.counts]
    asked = missing[:cap]
    for index, topic_id in enumerate(asked):
        if index:
            await asyncio.sleep(_PAGE_PAUSE)
        try:
            result = await _telegram_call(
                connection,
                lambda topic_id=topic_id: connection(GetSearchCountersRequest(
                    peer=entity,
                    filters=[InputMessagesFilterVideo()],
                    top_msg_id=int(topic_id),
                )),
                max_flood=15,
            )
        except FloodWaitError:
            logger.warning("Stopped topic video counts after FloodWait")
            return False
        except Exception as exc:
            logger.warning("Topic %s video count failed: %s", topic_id, exc)
            book.counts[int(topic_id)] = None
            continue
        counters = list(result or [])
        book.counts[int(topic_id)] = int(getattr(counters[0], "count", 0) or 0) if counters else 0
    return len(asked) == len(missing)


async def _fill_topics(connection, entity, rows: list[dict], book: _TopicBook, *, counts: bool) -> None:
    topic_ids = []
    seen = set()
    for row in rows:
        topic_id = row.get("topic_id")
        if not topic_id or int(topic_id) in seen:
            continue
        seen.add(int(topic_id))
        topic_ids.append(int(topic_id))
    if not topic_ids:
        return
    try:
        await _load_topic_titles(connection, entity, topic_ids, book)
        if counts:
            await _load_topic_counts(connection, entity, topic_ids, book)
        _stamp_topics(rows, book)
    except Exception:
        logger.warning("Topic metadata failed", exc_info=True)


async def _open_channel(channel_name: str):
    name = normalize_channel_name(channel_name)
    if not name:
        raise ValueError("channel is required")
    connection = await client()
    entity = await connection.get_entity(int(name) if name.lstrip("-").isdigit() else name)
    return connection, entity, name


def _advance_offset(offset_id: int, batch) -> int | None:
    new_offset = int(batch[-1].id)
    if offset_id and new_offset == offset_id:
        return None
    return new_offset


async def joined_video_chats() -> list[dict]:
    """List joined channels/groups and Telegram's video-filter totals."""
    connection = await client()
    dialogs = [dialog async for dialog in connection.iter_dialogs() if dialog.is_channel or dialog.is_group]
    semaphore = asyncio.Semaphore(4)

    async def describe(dialog):
        entity = dialog.entity
        async with semaphore:
            try:
                messages = await _get_messages(connection, entity, limit=0, filter=InputMessagesFilterVideo)
                video_count = int(messages.total)
            except Exception as exc:
                logger.warning("Could not count Telegram videos in %s: %s", dialog.id, exc)
                video_count = None
        return {
            "id": str(dialog.id),
            "title": dialog.title or str(dialog.id),
            "username": getattr(entity, "username", None),
            "kind": "group" if dialog.is_group else "channel",
            "video_count": video_count,
        }

    return await asyncio.gather(*(describe(dialog) for dialog in dialogs))


def _file_id(message) -> int | None:
    document = getattr(message, "document", None)
    file_id = getattr(document, "id", None)
    if file_id:
        return int(file_id)
    video = getattr(message, "video", None)
    video_id = getattr(video, "id", None)
    return int(video_id) if video_id else None


def _channel_label(entity, fallback: str) -> str:
    username = getattr(entity, "username", None)
    if username:
        return f"@{username}"
    title = getattr(entity, "title", None) or getattr(entity, "first_name", None)
    return str(title or fallback)


async def _entity_for(connection, message):
    cached = getattr(message, "chat", None)
    if cached is not None:
        return cached
    peer = getattr(message, "peer_id", None)
    if peer is None:
        return None
    try:
        return await connection.get_entity(peer)
    except FloodWaitError as exc:
        wait = int(exc.seconds)
        logger.warning("Telegram flood wait %ss while resolving a chat", wait)
        if wait > _GLOBAL_FLOOD_CAP:
            raise
        await asyncio.sleep(wait)
        return await connection.get_entity(peer)


def _merge_global(groups: dict, order: list, message, entity) -> None:
    meta = _video_meta(message)
    file_id = _file_id(message)
    if meta is None or file_id is None or entity is None or not getattr(message, "id", None):
        return
    label = _channel_label(entity, "chat")
    existing = groups.get(file_id)
    if existing is not None:
        if label not in existing["source_channels"]:
            existing["source_channels"].append(label)
        return
    raw_id = int(getattr(entity, "id"))
    chat_id = -abs(raw_id) if isinstance(entity, (Chat, ChatForbidden)) else public_chat_id(raw_id)
    username = getattr(entity, "username", None)
    text = " ".join((getattr(message, "message", None) or "").split())
    date = getattr(message, "date", None)
    stream_url = f"/api/v1/telegram/stream/{chat_id}/{message.id}"
    groups[file_id] = {
        "message_id": int(message.id),
        "channel_id": chat_id,
        "stream_url": stream_url,
        "date": date.isoformat() if date else None,
        "views": int(getattr(message, "views", 0) or 0),
        "forwards": int(getattr(message, "forwards", 0) or 0),
        "reactions": meta["reactions"],
        "size_bytes": meta["size_bytes"],
        "width": meta["width"],
        "height": meta["height"],
        "effective_res": meta["effective_res"],
        "quality": meta["quality"],
        "orientation": meta["orientation"],
        "file_name": meta["file_name"],
        "supports_streaming": meta["supports_streaming"],
        "nosound": meta["nosound"],
        "duration": meta["duration"],
        "duration_sec": meta["duration_sec"],
        "file_id": file_id,
        "source_channels": [label],
        "id": int(message.id),
        "channel": username or label.lstrip("@"),
        "url": f"https://t.me/{username}/{message.id}" if username else f"https://t.me/c/{chat_id}/{message.id}",
        "video_url": stream_url,
        "thumbnail": f"/api/v1/telegram/thumb/{chat_id}/{message.id}" if meta["has_thumb"] else None,
        "media_type": meta["media_type"],
        "text": text,
        "title": (text[:140] or f"Telegram {message.id}"),
        "author": label,
        "preview_unavailable": False,
        "chat_id": chat_id,
    }
    order.append(file_id)


async def search_all_joined_channels(
    query: str, limit: int = 50, _retried: bool = False, min_duration: int = 0, min_quality: int = 0,
    min_size_mb: float = 0
) -> list[dict]:
    """Search videos across every dialog the logged-in account can read.

    Pages are fetched one after another. The same Telegram file is returned
    once, with every chat it was found in listed on ``source_channels``.
    """
    global _SEARCH_COOLDOWN
    remaining = _SEARCH_COOLDOWN - time.monotonic()
    if remaining > 0:
        await asyncio.sleep(remaining)
    raw_query = (query or "").strip()
    if not raw_query:
        return []
    capped = max(1, min(int(limit or 50), 2000))
    # Support multiple keywords separated by commas (OR search across terms)
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()]
    if not keywords:
        return []

    connection = await client()
    groups: dict = {}
    order: list = []
    seen_ids: set[tuple[int, int]] = set()
    scanned = 0
    scan_limit = 5000 if (min_duration > 0 or min_quality > 0 or min_size_mb > 0) else capped
    try:
        async with _search_semaphore():
            for word in keywords:
                if len(order) >= capped:
                    break
                async for message in connection.iter_messages(
                    None,
                    search=word,
                    limit=scan_limit,
                    filter=InputMessagesFilterVideo,
                    wait_time=_GLOBAL_PAUSE,
                ):
                    if scanned and scanned % _PAGE == 0:
                        await asyncio.sleep(_GLOBAL_PAUSE)
                    scanned += 1
                    document = getattr(message, "document", None)
                    mime = str(getattr(document, "mime_type", "") or "")
                    meta = _video_meta(message)
                    if not (getattr(message, "video", None) or mime.startswith("video/") or meta):
                        continue
                    if min_duration > 0 and (meta.get("duration_sec") if meta else 0) < min_duration:
                        continue
                    if min_quality > 0 and (meta.get("effective_res") if meta else 0) < min_quality:
                        continue
                    if min_size_mb > 0 and (meta.get("size_bytes") if meta else 0) < min_size_mb * 1048576:
                        continue
                    entity = await _entity_for(connection, message)
                    raw_id = int(getattr(entity, "id", 0) or 0)
                    msg_id = int(getattr(message, "id", 0) or 0)
                    pair = (raw_id, msg_id)
                    if pair in seen_ids:
                        continue
                    seen_ids.add(pair)
                    _merge_global(groups, order, message, entity)
                    if len(order) >= capped:
                        break
    except FloodWaitError as exc:
        wait = int(exc.seconds)
        _SEARCH_COOLDOWN = max(_SEARCH_COOLDOWN, time.monotonic() + wait + 1)
        logger.warning("Global search hit FloodWait %ss", wait)
        if wait > _GLOBAL_FLOOD_CAP:
            return [groups[key] for key in order[:capped]]
        await asyncio.sleep(wait)
        if not _retried and not order:
            return await search_all_joined_channels(
                query, capped, _retried=True, min_duration=min_duration, min_quality=min_quality,
                min_size_mb=min_size_mb
            )
    return [groups[key] for key in order[:capped]]


def _clean_topic_id(topic_id) -> int | None:
    try:
        number = int(topic_id or 0)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


async def scrape_channel_via_telethon(
    channel_name: str, limit: int, query: str | None = None, min_duration: int = 0, min_quality: int = 0,
    min_size_mb: float = 0, topic_id: int | None = None, with_topics: bool = True,
) -> list[dict]:
    """Return video posts from a channel the logged-in account can read."""
    capped = max(1, min(int(limit), 2000))
    raw_query = (query or "").strip()
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()] if raw_query else []
    search_terms = keywords if keywords else [None]
    chosen_topic = _clean_topic_id(topic_id)

    connection, entity, name = await _open_channel(channel_name)
    rows: list[dict] = []
    seen_ids: set[int] = set()

    for word in search_terms:
        if len(rows) >= capped:
            break
        offset_id = 0
        consecutive_empty_batches = 0
        while len(rows) < capped:
            if offset_id:
                await asyncio.sleep(_PAGE_PAUSE)
            batch = await _get_messages(
                connection,
                entity,
                limit=_PAGE,
                offset_id=offset_id,
                search=word,
                filter=InputMessagesFilterVideo,
                topic_id=chosen_topic,
            )
            if not batch:
                break
            matched_in_batch = 0
            for message in batch:
                msg_id = getattr(message, "id", None)
                if not msg_id or int(msg_id) in seen_ids:
                    continue
                row = _row(message, entity, name, forced_topic_id=chosen_topic)
                if row is not None:
                    if min_duration > 0 and (row.get("duration_sec") or 0) < min_duration:
                        continue
                    if min_quality > 0 and (row.get("effective_res") or 0) < min_quality:
                        continue
                    if min_size_mb > 0 and (row.get("size_bytes") or 0) < min_size_mb * 1048576:
                        continue
                    seen_ids.add(int(msg_id))
                    rows.append(row)
                    matched_in_batch += 1
                    if len(rows) >= capped:
                        break
            new_offset = _advance_offset(offset_id, batch)
            if new_offset is None:
                break
            offset_id = new_offset
            if matched_in_batch == 0:
                consecutive_empty_batches += 1
                if consecutive_empty_batches >= (500 if (min_duration > 0 or min_quality > 0 or min_size_mb > 0) else 30):
                    break
            else:
                consecutive_empty_batches = 0
            if len(batch) < _PAGE:
                break
    if with_topics and rows:
        book = _TopicBook()
        await _fill_topics(connection, entity, rows, book, counts=True)
    return rows


async def stream_scrape_channel_via_telethon(
    channel_name: str, limit: int, query: str | None = None, min_duration: int = 0, min_quality: int = 0,
    min_size_mb: float = 0, topic_id: int | None = None, with_topics: bool = True,
):
    """Yield real-time search progress batches from Telethon."""
    capped = max(1, min(int(limit), 2000))
    raw_query = (query or "").strip()
    keywords = [k.strip() for k in raw_query.split(",") if k.strip()] if raw_query else []
    search_terms = keywords if keywords else [None]
    chosen_topic = _clean_topic_id(topic_id)
    preview_name = normalize_channel_name(channel_name)
    topic_note = f", thread {chosen_topic}" if chosen_topic else ""
    yield {"status": "connecting", "message": f"Pripájanie cez Telegram účet ku kanálu @{preview_name}{topic_note}..."}
    connection, entity, name = await _open_channel(channel_name)
    rows: list[dict] = []
    seen_ids: set[int] = set()
    scanned = 0
    batch_num = 0
    book = _TopicBook()

    for word in search_terms:
        if len(rows) >= capped:
            break
        offset_id = 0
        consecutive_empty_batches = 0
        term_desc = f" [{word}]" if word else ""

        while len(rows) < capped:
            if offset_id:
                await asyncio.sleep(_PAGE_PAUSE)
            batch_num += 1
            yield {
                "status": "searching",
                "message": f"Prehľadávanie dávky {batch_num}{term_desc}...",
                "scanned": scanned,
                "matched": len(rows),
                "target": capped,
            }
            batch = await _get_messages(
                connection,
                entity,
                limit=_PAGE,
                offset_id=offset_id,
                search=word,
                filter=InputMessagesFilterVideo,
                topic_id=chosen_topic,
            )
            if not batch:
                break
            scanned += len(batch)
            new_in_batch = []
            for message in batch:
                msg_id = getattr(message, "id", None)
                if not msg_id or int(msg_id) in seen_ids:
                    continue
                row = _row(message, entity, name, forced_topic_id=chosen_topic)
                if row is not None:
                    if min_duration > 0 and (row.get("duration_sec") or 0) < min_duration:
                        continue
                    if min_quality > 0 and (row.get("effective_res") or 0) < min_quality:
                        continue
                    if min_size_mb > 0 and (row.get("size_bytes") or 0) < min_size_mb * 1048576:
                        continue
                    seen_ids.add(int(msg_id))
                    rows.append(row)
                    new_in_batch.append(row)
                    if len(rows) >= capped:
                        break
            if new_in_batch and with_topics:
                await _fill_topics(connection, entity, new_in_batch, book, counts=False)
            if new_in_batch:
                yield {
                    "status": "progress",
                    "message": f"Nájdených {len(rows)} / {capped} videí (dávka {batch_num}{term_desc})...",
                    "scanned": scanned,
                    "matched": len(rows),
                    "target": capped,
                    "new_videos": new_in_batch,
                }
            new_offset = _advance_offset(offset_id, batch)
            if new_offset is None:
                break
            offset_id = new_offset
            if len(new_in_batch) == 0:
                consecutive_empty_batches += 1
                if consecutive_empty_batches >= (500 if (min_duration > 0 or min_quality > 0 or min_size_mb > 0) else 30):
                    break
            else:
                consecutive_empty_batches = 0
            if len(batch) < _PAGE:
                break

    if with_topics and rows:
        await _fill_topics(connection, entity, rows, book, counts=True)
        topics = [topic for topic in book.public() if topic.get("title")]
        if topics:
            yield {"status": "topics", "topics": topics}

    yield {
        "status": "done",
        "message": f"Hľadanie dokončené. Nájdených {len(rows)} videí.",
        "scanned": scanned,
        "matched": len(rows),
        "target": capped,
        "videos": rows,
        "source": "telethon",
    }


def merge_forum_topics(saved: list[dict], fresh: list[dict]) -> list[dict]:
    """Keep topics we already stored and overlay anything a newer read found."""
    saved_by_id = {int(item["id"]): dict(item) for item in saved if item.get("id")}
    merged = []
    seen: set[int] = set()
    for topic in fresh:
        topic_id = int(topic["id"])
        previous = saved_by_id.get(topic_id, {})
        row = {**previous, **topic}
        if topic.get("video_count") is None and previous.get("video_count") is not None:
            row["video_count"] = previous["video_count"]
        if not topic.get("last_message_at") and previous.get("last_message_at"):
            row["last_message_at"] = previous["last_message_at"]
        merged.append(row)
        seen.add(topic_id)
    for topic_id, topic in saved_by_id.items():
        if topic_id not in seen:
            merged.append(topic)
    return merged


def _topic_rows(rows) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = {}
    for row in rows:
        grouped.setdefault(row.peer_id, []).append({
            "id": int(row.topic_id),
            "title": row.title or f"Thread {row.topic_id}",
            "video_count": row.video_count,
            "closed": bool(row.closed),
            "pinned": bool(row.pinned),
            "url": row.url or "",
            "last_message_at": row.last_message_at,
        })
    return grouped


def load_saved_forum_topics(peer_id: str | None = None) -> dict[str, list[dict]]:
    from .database import SessionLocal, TelegramForumTopic

    with SessionLocal() as db:
        query = db.query(TelegramForumTopic)
        if peer_id:
            query = query.filter(TelegramForumTopic.peer_id == peer_id)
        rows = query.order_by(TelegramForumTopic.pinned.desc(), TelegramForumTopic.title).all()
        return _topic_rows(rows)


def save_forum_topics(peer_id: str, topics: list[dict]) -> None:
    from .database import SessionLocal, TelegramForumTopic

    now = time.time()
    with SessionLocal() as db:
        for topic in topics:
            topic_id = int(topic["id"])
            row = db.get(TelegramForumTopic, (peer_id, topic_id))
            if row is None:
                row = TelegramForumTopic(peer_id=peer_id, topic_id=topic_id)
                db.add(row)
            row.title = str(topic.get("title") or row.title or f"Thread {topic_id}")
            if topic.get("video_count") is not None:
                row.video_count = int(topic["video_count"])
            row.closed = bool(topic.get("closed"))
            row.pinned = bool(topic.get("pinned"))
            if topic.get("url"):
                row.url = str(topic["url"])
            stamp = topic.get("last_message_at")
            if stamp:
                row.last_message_at = float(stamp)
            elif stamp is not None and row.last_message_at is None:
                row.last_message_at = 0.0
            row.updated_at = now
        db.commit()


def _saved_topic_payload(name: str, topics: list[dict], *, stale: bool = False, counts_limited: bool = False) -> dict:
    return {
        "channel": name,
        "forum": bool(topics),
        "topics": topics,
        "counts_partial": any(item.get("video_count") is None for item in topics),
        "counts_limited": counts_limited,
        "stale": stale,
    }


def _topic_timestamp(topic, message_dates: dict) -> float | None:
    """Unix time of the topic's latest message. The list call returns that message."""
    top = int(getattr(topic, "top_message", 0) or 0)
    when = message_dates.get(top)
    if when is None:
        return None
    try:
        return float(when.timestamp())
    except (AttributeError, OSError, OverflowError, ValueError):
        return None


def _count_known(topics: list[dict]) -> int:
    return sum(1 for item in topics if item.get("video_count") is not None)


async def _apply_topic_counts(connection, entity, topics: list[dict], *, mode: str, limit: int | None = None, skip: int = 0) -> tuple[bool, int]:
    """Fill video totals. Returns whether every requested id was asked, and how many this call asked.

    mode 'missing' skips threads that already have a number.
    mode 'all' walks topic ids in a stable order so skip continues on the next call.
    """
    cap = _TOPIC_REFRESH_CAP if limit is None else max(1, min(int(limit), _TOPIC_REFRESH_CAP))
    if mode == "all":
        pending = sorted(int(item["id"]) for item in topics)
    else:
        pending = [int(item["id"]) for item in topics if item.get("video_count") is None]
    pending = pending[max(0, int(skip)):]
    if not pending:
        return True, 0
    book = _TopicBook()
    finished = await _load_topic_counts(connection, entity, pending, book, limit=cap)
    for item in topics:
        topic_id = int(item["id"])
        if topic_id in book.counts and book.counts[topic_id] is not None:
            item["video_count"] = book.counts[topic_id]
    asked = sum(1 for item in topics if int(item["id"]) in book.counts)
    return finished, asked


def _store_forum_topics(name: str, topics: list[dict], *, counts_limited: bool = False, stale: bool = False) -> dict:
    try:
        save_forum_topics(name, topics)
    except Exception:
        logger.warning("Saving forum topics failed for %s", name, exc_info=True)
    payload = _saved_topic_payload(name, topics, stale=stale, counts_limited=counts_limited)
    _TOPIC_LIST_CACHE[name] = (time.monotonic(), payload)
    return payload


async def list_forum_topics(channel_name: str, counts: str = "auto", batch: int = 0, skip: int = 0) -> dict:
    """Titles and video counts for topics in one forum group.

    auto asks for the first 50 missing totals so the list can open quickly.
    missing asks again only for threads that still have no number.
    all recounts every thread in the group.
    batch limits how many totals one missing/all call asks for.
    skip continues an 'all' recount from that position in topic-id order.
    """
    if counts not in {"auto", "missing", "all"}:
        counts = "auto"
    batch_limit = batch if batch > 0 else (_TOPIC_COUNT_BATCH if counts == "missing" else _TOPIC_REFRESH_CAP)
    name = normalize_channel_name(channel_name)
    saved = load_saved_forum_topics(name).get(name, []) if name else []
    cached = _TOPIC_LIST_CACHE.get(name)
    cached_topics = (cached[1].get("topics") or []) if cached else []
    dates_ready = all(item.get("last_message_at") is not None for item in cached_topics)
    if counts == "auto" and cached and dates_ready and time.monotonic() - cached[0] < _TOPIC_LIST_TTL:
        return cached[1]
    needs_dates = any(item.get("last_message_at") is None for item in saved)
    if counts in {"missing", "all"} and saved and not needs_dates:
        try:
            connection, entity, name = await _open_channel(channel_name)
        except Exception:
            return _saved_topic_payload(name, saved, stale=True)
        saved = [dict(item) for item in load_saved_forum_topics(name).get(name, saved)]
        if not getattr(entity, "forum", False):
            return _store_forum_topics(name, saved)
        before = _count_known(saved)
        finished, asked = await _apply_topic_counts(
            connection, entity, saved, mode=counts, limit=batch_limit, skip=skip if counts == "all" else 0,
        )
        payload = _store_forum_topics(name, saved, counts_limited=not finished)
        payload["filled"] = _count_known(saved) - before
        payload["asked"] = asked
        return payload
    try:
        connection, entity, name = await _open_channel(channel_name)
    except Exception:
        if saved:
            return _saved_topic_payload(name, saved, stale=True)
        raise
    saved = load_saved_forum_topics(name).get(name, saved)
    if not getattr(entity, "forum", False):
        payload = _saved_topic_payload(name, saved) if saved else {
            "channel": name, "forum": False, "topics": [], "counts_partial": False, "stale": False,
        }
        _TOPIC_LIST_CACHE[name] = (time.monotonic(), payload)
        return payload

    collected = []
    seen: set[int] = set()
    message_dates = {}
    offset_topic = 0
    offset_id = 0
    offset_date = None
    while len(collected) < 200:
        try:
            result = await _telegram_call(
                connection,
                lambda offset_topic=offset_topic, offset_id=offset_id, offset_date=offset_date: connection(
                    GetForumTopicsRequest(
                        peer=entity,
                        offset_date=offset_date,
                        offset_id=offset_id,
                        offset_topic=offset_topic,
                        limit=100,
                    )
                ),
            )
        except Exception as exc:
            logger.warning("Forum topics failed for %s: %s", name, exc)
            if collected:
                break
            if saved:
                return _saved_topic_payload(name, saved, stale=True)
            payload = {"channel": name, "forum": False, "topics": [], "counts_partial": False, "stale": False}
            return payload
        batch = list(getattr(result, "topics", None) or [])
        for message in getattr(result, "messages", None) or []:
            message_id = getattr(message, "id", None)
            when = getattr(message, "date", None)
            if message_id and when:
                message_dates[int(message_id)] = when
        fresh = []
        for topic in batch:
            topic_key = getattr(topic, "id", None)
            if not topic_key or int(topic_key) in seen:
                continue
            seen.add(int(topic_key))
            if not isinstance(topic, ForumTopic):
                continue
            fresh.append(topic)
        if not fresh:
            break
        collected.extend(fresh)
        if len(batch) < 100:
            break
        last = fresh[-1]
        offset_topic = int(last.id)
        offset_id = int(getattr(last, "top_message", 0) or 0)
        offset_date = getattr(last, "date", None)

    book = _TopicBook()
    for topic in collected:
        title = getattr(topic, "title", None)
        book.titles[int(topic.id)] = str(title) if title and not getattr(topic, "title_missing", False) else f"Thread {int(topic.id)}"
    topics = []
    for topic in collected:
        topic_key = int(topic.id)
        topics.append({
            "id": topic_key,
            "title": book.titles.get(topic_key) or f"Thread {topic_key}",
            "video_count": None,
            "closed": bool(getattr(topic, "closed", False)),
            "pinned": bool(getattr(topic, "pinned", False)),
            "url": topic_page_url(entity, name, topic_key),
            "last_message_at": _topic_timestamp(topic, message_dates) or 0,
        })
    topics = merge_forum_topics(saved, topics)
    before = _count_known(topics)
    finished = True
    asked = 0
    if counts == "auto":
        missing_ids = [int(item["id"]) for item in topics if item.get("video_count") is None]
        count_book = _TopicBook()
        finished = await _load_topic_counts(connection, entity, missing_ids, count_book)
        for item in topics:
            topic_id = int(item["id"])
            if topic_id in count_book.counts and count_book.counts[topic_id] is not None:
                item["video_count"] = count_book.counts[topic_id]
        asked = sum(1 for item in topics if int(item["id"]) in count_book.counts)
    elif counts in {"missing", "all"}:
        finished, asked = await _apply_topic_counts(
            connection, entity, topics, mode=counts, limit=batch_limit, skip=skip if counts == "all" else 0,
        )
    payload = _store_forum_topics(name, topics, counts_limited=not finished)
    payload["filled"] = _count_known(topics) - before
    payload["asked"] = asked
    return payload


_STREAM_PATH_RE = re.compile(r"/telegram/stream/(-?\d+)/(\d+)")
_TELEGRAM_THUMB_PATH_RE = re.compile(r"(?:^|/)api/v1/telegram/thumb/-?\d+/\d+/?$", re.I)
_TME_C_RE = re.compile(r"https?://(?:t\.me|telegram\.me)/c/(\d+)/(\d+)", re.I)
_TME_USER_RE = re.compile(r"https?://(?:t\.me|telegram\.me)/(?!c/)([A-Za-z0-9_]{3,})/(\d+)", re.I)


def telegram_stream_path(chat_id: int, message_id: int) -> str:
    return f"/api/v1/telegram/stream/{int(chat_id)}/{int(message_id)}"


def telegram_thumb_path(chat_id: int, message_id: int) -> str:
    return f"/api/v1/telegram/thumb/{int(chat_id)}/{int(message_id)}"


def is_telegram_thumbnail_path(value: str | None) -> bool:
    path = str(value or "").strip().split("?", 1)[0].split("#", 1)[0]
    return bool(_TELEGRAM_THUMB_PATH_RE.search(path))


def duration_to_seconds(value) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    raw = str(value).strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", raw):
        return max(0.0, float(raw))
    if re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", raw):
        total = 0
        for part in raw.split(":"):
            total = total * 60 + int(part)
        return float(total)
    return 0.0


def _pair_from_text(value: str) -> tuple[int, int] | None:
    text = str(value or "")
    match = _STREAM_PATH_RE.search(text) or _TME_C_RE.search(text)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def _username_from_text(value: str) -> tuple[str, int] | None:
    match = _TME_USER_RE.search(str(value or ""))
    if not match:
        return None
    return match.group(1), int(match.group(2))


def _coerce_pair(chat_id, message_id) -> tuple[int, int] | None:
    try:
        chat = int(chat_id)
        message = int(message_id)
    except (TypeError, ValueError):
        return None
    if message <= 0:
        return None
    return chat, message


def is_telegram_library_video(video) -> bool:
    storage = str(getattr(video, "storage_type", "") or "").lower()
    if storage == "telegram":
        return True
    if getattr(video, "telegram_chat_id", None) and getattr(video, "telegram_message_id", None):
        return True
    blob = f"{getattr(video, 'url', '') or ''} {getattr(video, 'source_url', '') or ''}"
    lowered = blob.lower()
    return (
        "/telegram/stream/" in lowered
        or "/telegram/thumb/" in lowered
        or "t.me/" in lowered
        or "telegram.me/" in lowered
    )


def telegram_import_spec(url: str, item: dict | None = None) -> dict | None:
    """Identifiers carried by a Quantum Search card or an already stored row."""
    item = item or {}
    values = [
        item.get("stream_url"),
        item.get("video_url"),
        url,
        item.get("url"),
        item.get("source_url"),
    ]
    blob = " ".join(str(value or "") for value in values).lower()
    source = str(item.get("source") or "").lower()
    marked = (
        source == "telegram"
        or "/telegram/stream/" in blob
        or "t.me/" in blob
        or "telegram.me/" in blob
    )
    if not marked:
        return None
    pair = None
    username = None
    for value in values:
        pair = _pair_from_text(str(value or ""))
        if pair:
            break
    if pair is None:
        pair = _coerce_pair(
            item.get("chat_id") or item.get("channel_id") or item.get("telegram_chat_id"),
            item.get("message_id") or item.get("telegram_message_id") or item.get("id"),
        )
    if pair is None:
        for value in values:
            username = _username_from_text(str(value or ""))
            if username:
                break
    page = ""
    for value in (item.get("source_url"), item.get("url"), url):
        text = str(value or "")
        if text.startswith(("http://", "https://")) and ("t.me/" in text or "telegram.me/" in text):
            page = text
            break
    if pair is None and username is None:
        return None
    return {
        "chat_id": pair[0] if pair else None,
        "message_id": pair[1] if pair else username[1],
        "username": None if pair else username[0],
        "source_url": page,
        "title": str(item.get("title") or item.get("text") or "")[:500],
        "thumbnail": str(item.get("thumbnail") or item.get("thumb_url") or ""),
        "duration": duration_to_seconds(item.get("duration") or item.get("duration_seconds")),
        "views": item.get("views"),
        "upload_date": str(item.get("upload_date") or item.get("date") or "")[:100],
        "quality": str(item.get("quality") or ""),
        "width": int(item.get("width") or 0),
        "height": int(item.get("height") or 0),
        "effective_res": int(item.get("effective_res") or 0),
        "size_bytes": int(item.get("size_bytes") or 0),
        "orientation": str(item.get("orientation") or ""),
    }


def library_telegram_stream_path(video) -> str | None:
    pair = _coerce_pair(getattr(video, "telegram_chat_id", None), getattr(video, "telegram_message_id", None))
    if pair is None:
        pair = _pair_from_text(getattr(video, "url", "") or "") or _pair_from_text(getattr(video, "source_url", "") or "")
    if pair is None:
        return None
    return telegram_stream_path(*pair)


def apply_telegram_library_target(video) -> bool:
    """Point a library row at the stable Telegram stream. No network call."""
    if not is_telegram_library_video(video):
        return False
    path = library_telegram_stream_path(video)
    if not path:
        return False
    pair = _pair_from_text(path)
    video.url = path
    video.telegram_chat_id = str(pair[0])
    video.telegram_message_id = pair[1]
    video.storage_type = "telegram"
    if (video.status or "") in {"pending", "error", "processing", "failed"}:
        video.status = "ready_to_stream"
    video.error_msg = None
    if not video.thumbnail_path:
        video.thumbnail_path = telegram_thumb_path(*pair)
    return True


async def _chat_id_for_username(username: str) -> int:
    connection = await client()
    entity = await connection.get_entity(username)
    return public_chat_id(int(entity.id))


async def verify_telegram_library_video(video) -> dict | None:
    """Confirm the Telegram file still exists and keep the same stream path.

    Returns None when the row is not a Telegram video. Telethon reads the
    message itself, so this does not ask a website for a new CDN token.
    """
    if not is_telegram_library_video(video):
        return None
    from .telegram_stream import get_video_message

    pair = _coerce_pair(getattr(video, "telegram_chat_id", None), getattr(video, "telegram_message_id", None))
    if pair is None:
        pair = _pair_from_text(getattr(video, "url", "") or "") or _pair_from_text(getattr(video, "source_url", "") or "")
    if pair is None:
        username = _username_from_text(getattr(video, "source_url", "") or "") or _username_from_text(getattr(video, "url", "") or "")
        if username is None:
            return {"supported": False, "reason": "Telegram chat_id or message_id missing"}
        try:
            pair = (await _chat_id_for_username(username[0]), username[1])
        except Exception as exc:
            logger.warning("Telegram refresh could not resolve a chat: %s", exc)
            return {"supported": False, "reason": "Telegram chat_id or message_id missing"}
    chat_id, message_id = pair
    path = telegram_stream_path(chat_id, message_id)
    try:
        await get_video_message(chat_id, message_id)
    except FileNotFoundError:
        video.url = path
        video.telegram_chat_id = str(chat_id)
        video.telegram_message_id = message_id
        video.storage_type = "telegram"
        video.link_status = "broken"
        video.error_msg = "Telegram video is no longer available"
        return {"supported": False, "reason": "Telegram video is no longer available", "stream_url": path}
    except PermissionError as exc:
        return {"supported": False, "reason": str(exc), "stream_url": path}
    video.url = path
    if not (video.source_url or "").startswith(("http://", "https://")):
        video.source_url = f"https://t.me/c/{chat_id}/{message_id}"
    video.telegram_chat_id = str(chat_id)
    video.telegram_message_id = message_id
    video.storage_type = "telegram"
    video.status = "ready_to_stream"
    video.link_status = "working"
    video.error_msg = None
    if not video.thumbnail_path:
        video.thumbnail_path = telegram_thumb_path(chat_id, message_id)
    return {
        "supported": True,
        "stream_url": path,
        "is_hls": False,
        "extractor": "telegram",
    }


def save_telegram_library_video(db, spec: dict, batch_name: str = "Quantum Search"):
    """Insert or update one playable Telegram library row. Returns (video, created)."""
    from datetime import datetime

    from sqlalchemy import or_

    from .database import Video

    chat_id = int(spec["chat_id"])
    message_id = int(spec["message_id"])
    path = telegram_stream_path(chat_id, message_id)
    page = str(spec.get("source_url") or "").strip() or f"https://t.me/c/{chat_id}/{message_id}"
    existing = db.query(Video).filter(or_(
        Video.url == path,
        (Video.telegram_chat_id == str(chat_id)) & (Video.telegram_message_id == message_id),
    )).first()
    created = existing is None
    video = existing or Video(batch_name=batch_name or "Quantum Search")
    if created:
        db.add(video)
    video.url = path
    video.source_url = page
    video.telegram_chat_id = str(chat_id)
    video.telegram_message_id = message_id
    video.storage_type = "telegram"
    video.status = "ready_to_stream"
    video.link_status = "working"
    video.error_msg = None
    title = str(spec.get("title") or "").strip()
    if title:
        video.title = title[:500]
    elif not video.title:
        video.title = f"Telegram {message_id}"
    thumb = str(spec.get("thumbnail") or "").strip() or telegram_thumb_path(chat_id, message_id)
    video.thumbnail_path = thumb
    duration = duration_to_seconds(spec.get("duration"))
    if duration:
        video.duration = duration
    upload_date = str(spec.get("upload_date") or "")[:100]
    if upload_date:
        video.upload_date = upload_date
    try:
        views = spec.get("views")
        if views is not None and str(views).strip() != "":
            video.views = int(views)
    except (TypeError, ValueError):
        pass

    q = str(spec.get("quality") or "").strip()
    eff = int(spec.get("effective_res") or 0)
    w = int(spec.get("width") or 0)
    h = int(spec.get("height") or 0)
    if not q:
        if eff >= 2160 or h >= 2160 or w >= 2160:
            q = "4K"
        elif eff >= 1440 or h >= 1440 or w >= 1440:
            q = "1440p"
        elif eff >= 1080 or h >= 1080 or w >= 1080:
            q = "1080p"
        elif eff >= 720 or h >= 720 or w >= 720:
            q = "720p"
        elif eff >= 480 or h >= 480 or w >= 480:
            q = "480p"
        elif eff > 0:
            q = f"{eff}p"
        else:
            q = "HD"
    video.quality = q
    video.width = w
    video.height = h
    size_bytes = int(spec.get("size_bytes") or 0)
    if size_bytes > 0:
        video.file_size_mb = round(size_bytes / (1024 * 1024), 1)
    orient = str(spec.get("orientation") or "")
    if not orient and (w > 0 or h > 0):
        orient = "portrait" if h > w else "landscape"
    if orient:
        video.orientation = orient
    video.last_checked = datetime.now()
    db.commit()
    db.refresh(video)
    return video, created
