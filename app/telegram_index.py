"""
Telegram FTS5 Indexing & Search Service.
Provides sub-millisecond local search across cached Telegram videos
without triggering FloodWait errors from Telegram servers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from .database import TelegramMediaIndex, sanitize_fts_query, utcnow
from .telegram_metadata import extract_telegram_metadata

logger = logging.getLogger(__name__)

_NEG_TOKEN_RE = re.compile(r"^(?:-|!)(\S+)$")
_SPLIT_COMPOUND_RE = re.compile(r"[^\W_]+", flags=re.UNICODE)
_CAMEL_BOUNDARY_RE = re.compile(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])")
_HASHTAG_RE = re.compile(r"#([\w]+)", flags=re.UNICODE)
_LIBRARY_ID_CACHE: dict[tuple, tuple[float, set[str]]] = {}
_LIBRARY_ID_CACHE_TTL = 10.0


def _split_compound_tokens(raw: str) -> List[str]:
    """Split a phrase into lowercase tokens, breaking on whitespace and underscores."""
    tokens = []
    for part in _SPLIT_COMPOUND_RE.findall(raw or ""):
        low = part.casefold()
        if low and low not in tokens:
            tokens.append(low)
    return tokens


def _extract_normalized_fts_tokens(title: str = "", caption: str = "", file_name: str = "") -> str:
    """Extract normalized hashtags, CamelCase subwords, and filename parts for FTS5 indexing."""
    tokens: List[str] = []
    seen: set[str] = set()

    def _add(tok: str) -> None:
        low = tok.strip().casefold()
        if len(low) >= 2 and low not in seen:
            seen.add(low)
            tokens.append(low)

    for tag_match in _HASHTAG_RE.finditer(f"{title} {caption}"):
        raw_tag = tag_match.group(1)
        _add(raw_tag.replace("_", ""))
        for part in _SPLIT_COMPOUND_RE.findall(raw_tag):
            _add(part)
            for sub in _CAMEL_BOUNDARY_RE.split(part):
                _add(sub)

    for source_text in (file_name, title, caption):
        if not source_text:
            continue
        stem = re.sub(r"\.[a-z0-9]{2,4}$", "", source_text, flags=re.I)
        for part in _SPLIT_COMPOUND_RE.findall(stem):
            _add(part)
            for sub in _CAMEL_BOUNDARY_RE.split(part):
                _add(sub)

    return " ".join(tokens)


def _parse_search_query(raw_query: str, exclude_raw: str = "") -> tuple[str, List[List[str]], List[str]]:
    """Parse query + exclude string into (fts5_match_expr, positive_or_groups, negative_tokens)."""
    cleaned = (raw_query or "").strip()
    negative_tokens: List[str] = []

    if exclude_raw:
        for chunk in re.split(r"[,|\s]+", exclude_raw.strip()):
            for tok in _split_compound_tokens(chunk.lstrip("-!")):
                if tok not in negative_tokens:
                    negative_tokens.append(tok)

    if not cleaned or cleaned == "*":
        return "", [], negative_tokens

    phrases = [p.strip() for p in re.split(r"[,|]+", cleaned) if p.strip()]
    if not phrases:
        return "", [], negative_tokens

    or_blocks: List[str] = []
    positive_groups: List[List[str]] = []

    for phrase in phrases:
        pos_words: List[str] = []
        like_tokens: List[str] = []
        for raw_tok in phrase.split():
            neg_match = _NEG_TOKEN_RE.match(raw_tok)
            if neg_match:
                for nt in _split_compound_tokens(neg_match.group(1)):
                    if nt not in negative_tokens:
                        negative_tokens.append(nt)
                continue
            sanitized = sanitize_fts_query(raw_tok)
            for t in sanitized.split():
                clean_t = t.strip('"')
                if clean_t:
                    pos_words.append(clean_t)
            for lt in _split_compound_tokens(raw_tok):
                if lt not in like_tokens:
                    like_tokens.append(lt)

        if pos_words:
            or_blocks.append(" AND ".join(f'"{t}"*' for t in pos_words))
        if like_tokens:
            positive_groups.append(like_tokens)

    if not or_blocks:
        fts_expr = ""
    elif len(or_blocks) == 1:
        fts_expr = or_blocks[0]
    else:
        fts_expr = " OR ".join(f"({b})" if " AND " in b else b for b in or_blocks)

    return fts_expr, positive_groups, negative_tokens


def _build_fts5_query_string(raw_query: str) -> str:
    """Transform user query into robust FTS5 match expression.
    Supports comma/pipe-separated terms (OR), multiple words (AND prefix match), exclusions (-word), and phrase protection.
    """
    fts_expr, _pos, _neg = _parse_search_query(raw_query)
    return fts_expr


def upsert_telegram_media_batch(db: Session, items: List[Dict[str, Any]], *, commit: bool = True) -> int:
    """Upsert a batch of video dictionary payloads into telegram_media_index.
    The database triggers automatically keep telegram_media_fts synchronized.
    """
    if not items:
        return 0

    valid_count = 0
    now = utcnow()
    mega_link_candidates: List[Dict[str, Any]] = []

    for item in items:
        if not isinstance(item, dict):
            continue

        try:
            chat_id = int(item.get("chat_id") or item.get("channel_id") or 0)
            message_id = int(item.get("message_id") or item.get("id") or 0)
        except (ValueError, TypeError):
            continue

        if not chat_id or not message_id:
            continue

        caption = str(item.get("text") or item.get("caption") or "").strip()
        file_name = str(item.get("file_name") or "").strip()
        raw_title = str(item.get("title") or "").strip()
        parsed_meta = extract_telegram_metadata(caption, file_name, raw_title, message_id)
        title = parsed_meta["title"] or raw_title or (caption[:140] if caption else file_name or f"Telegram #{message_id}")

        file_name = str(item.get("file_name") or "").strip()
        channel = str(item.get("channel") or "").strip()
        channel_title = str(item.get("channel_title") or item.get("author") or "").strip()
        author = str(item.get("author") or "").strip()
        file_id = str(item.get("file_id") or "")

        try:
            duration_sec = int(item.get("duration_sec") or 0)
        except (ValueError, TypeError):
            duration_sec = 0

        duration = str(item.get("duration") or "")
        try:
            size_bytes = int(item.get("size_bytes") or item.get("size") or 0)
        except (ValueError, TypeError):
            size_bytes = 0

        try:
            width = int(item.get("width") or 0)
            height = int(item.get("height") or 0)
            effective_res = int(item.get("effective_res") or (min(width, height) if width and height else max(width, height)))
        except (ValueError, TypeError):
            width = height = effective_res = 0

        quality = str(item.get("quality") or "")
        orientation = str(item.get("orientation") or ("portrait" if height > width > 0 else "landscape"))

        try:
            views = int(item.get("views") or 0)
            forwards = int(item.get("forwards") or 0)
            reactions = int(item.get("reactions") or 0)
        except (ValueError, TypeError):
            views = forwards = reactions = 0

        date_val = str(item.get("date") or "")
        url = str(item.get("url") or "")
        stream_url = str(item.get("stream_url") or item.get("video_url") or "")
        video_url = str(item.get("video_url") or stream_url)
        thumbnail = str(item.get("thumbnail") or item.get("thumb_url") or "")
        has_thumb = bool(thumbnail)
        media_type = str(item.get("media_type") or "video")
        supports_streaming = bool(item.get("supports_streaming", True))
        nosound = bool(item.get("nosound", False))
        source_channels = item.get("source_channels")
        if not source_channels:
            source_channels = [channel_title or channel] if channel_title or channel else []

        # Execute atomic SQLite INSERT OR REPLACE / ON CONFLICT DO UPDATE
        stmt = text("""
            INSERT INTO telegram_media_index (
                chat_id, message_id, channel, channel_title, author, file_id,
                title, caption, file_name, duration_sec, duration, size_bytes,
                width, height, quality, effective_res, orientation, views, forwards,
                reactions, date, url, stream_url, video_url, thumbnail, has_thumb,
                media_type, supports_streaming, nosound, source_channels, indexed_at
            ) VALUES (
                :chat_id, :message_id, :channel, :channel_title, :author, :file_id,
                :title, :caption, :file_name, :duration_sec, :duration, :size_bytes,
                :width, :height, :quality, :effective_res, :orientation, :views, :forwards,
                :reactions, :date, :url, :stream_url, :video_url, :thumbnail, :has_thumb,
                :media_type, :supports_streaming, :nosound, :source_channels, :indexed_at
            )
            ON CONFLICT(chat_id, message_id) DO UPDATE SET
                channel = coalesce(excluded.channel, telegram_media_index.channel),
                channel_title = coalesce(excluded.channel_title, telegram_media_index.channel_title),
                author = coalesce(excluded.author, telegram_media_index.author),
                file_id = coalesce(nullif(excluded.file_id, ''), telegram_media_index.file_id),
                title = coalesce(excluded.title, telegram_media_index.title),
                caption = coalesce(excluded.caption, telegram_media_index.caption),
                file_name = coalesce(excluded.file_name, telegram_media_index.file_name),
                duration_sec = CASE WHEN excluded.duration_sec > 0 THEN excluded.duration_sec ELSE telegram_media_index.duration_sec END,
                duration = coalesce(excluded.duration, telegram_media_index.duration),
                size_bytes = CASE WHEN excluded.size_bytes > 0 THEN excluded.size_bytes ELSE telegram_media_index.size_bytes END,
                width = CASE WHEN excluded.width > 0 THEN excluded.width ELSE telegram_media_index.width END,
                height = CASE WHEN excluded.height > 0 THEN excluded.height ELSE telegram_media_index.height END,
                quality = coalesce(excluded.quality, telegram_media_index.quality),
                effective_res = CASE WHEN excluded.effective_res > 0 THEN excluded.effective_res ELSE telegram_media_index.effective_res END,
                views = CASE WHEN excluded.views > 0 THEN excluded.views ELSE telegram_media_index.views END,
                forwards = CASE WHEN excluded.forwards > 0 THEN excluded.forwards ELSE telegram_media_index.forwards END,
                reactions = CASE WHEN excluded.reactions > 0 THEN excluded.reactions ELSE telegram_media_index.reactions END,
                stream_url = coalesce(excluded.stream_url, telegram_media_index.stream_url),
                video_url = coalesce(excluded.video_url, telegram_media_index.video_url),
                thumbnail = coalesce(excluded.thumbnail, telegram_media_index.thumbnail),
                has_thumb = excluded.has_thumb OR telegram_media_index.has_thumb,
                indexed_at = excluded.indexed_at
        """)

        db.execute(stmt, {
            "chat_id": chat_id,
            "message_id": message_id,
            "channel": channel,
            "channel_title": channel_title,
            "author": author,
            "file_id": file_id,
            "title": title,
            "caption": caption,
            "file_name": file_name,
            "duration_sec": duration_sec,
            "duration": duration,
            "size_bytes": size_bytes,
            "width": width,
            "height": height,
            "quality": quality,
            "effective_res": effective_res,
            "orientation": orientation,
            "views": views,
            "forwards": forwards,
            "reactions": reactions,
            "date": date_val,
            "url": url,
            "stream_url": stream_url,
            "video_url": video_url,
            "thumbnail": thumbnail,
            "has_thumb": has_thumb,
            "media_type": media_type,
            "supports_streaming": supports_streaming,
            "nosound": nosound,
            "source_channels": json.dumps(source_channels),
            "indexed_at": now,
        })
        norm_tokens = _extract_normalized_fts_tokens(title, caption, file_name)
        if norm_tokens:
            try:
                db.execute(
                    text("""
                        UPDATE telegram_media_fts
                        SET file_name = :fts_file_name,
                            caption = :fts_caption
                        WHERE rowid = (
                            SELECT id FROM telegram_media_index
                            WHERE chat_id = :chat_id AND message_id = :message_id
                        )
                    """),
                    {
                        "fts_file_name": f"{file_name} {norm_tokens}".strip(),
                        "fts_caption": f"{caption} {norm_tokens}".strip(),
                        "chat_id": chat_id,
                        "message_id": message_id,
                    },
                )
            except Exception:
                pass
        low_caption = caption.lower()
        if any(
            hint in low_caption
            for hint in (
                "mega.",
                "onlyshare.info/",
                "speedy-links.com/",
                "megadropz.",
                "links2megas.com/",
                "link-center.net/",
                "link-hub.net/",
                "link-target.net/",
                "direct-link.net/",
                "linkvertise.com/",
                "bstlar.com/",
            )
        ):
            mega_link_candidates.append({
                "chat_id": chat_id,
                "message_id": message_id,
                "channel": channel,
                "channel_title": channel_title or channel,
                "fallback_title": title or file_name or f"Telegram #{message_id}",
                "caption": caption,
                "post_url": url,
                "thumbnail": thumbnail,
                "has_thumb": has_thumb,
                "date": date_val,
                "views": views,
                "reactions": reactions,
            })
        valid_count += 1

    try:
        if commit:
            db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("Failed to commit telegram media batch: %s", exc)
        raise

    if mega_link_candidates:
        try:
            from sqlalchemy import inspect as sa_inspect
            bind = db.get_bind() if hasattr(db, "get_bind") else None
            if bind is not None and sa_inspect(bind).has_table("telegram_link_posts"):
                from .mega_link_extractor import _domain_of, extract_pack_title, extract_text_links
                from .telegram_links import upsert_telegram_link_posts

                extracted_posts: List[Dict[str, Any]] = []
                for cand in mega_link_candidates:
                    parsed = extract_text_links(cand["caption"])
                    if not parsed:
                        continue
                    pack_title = extract_pack_title(cand["caption"], fallback=cand["fallback_title"])
                    mega_urls = parsed.get("mega_urls") or []
                    if mega_urls:
                        for mega_url in mega_urls:
                            extracted_posts.append({
                                "chat_id": cand["chat_id"],
                                "message_id": cand["message_id"],
                                "channel": cand["channel"],
                                "channel_title": cand["channel_title"],
                                "title": pack_title,
                                "caption": cand["caption"],
                                "post_url": cand["post_url"],
                                "raw_url": mega_url,
                                "final_url": mega_url,
                                "domain": "mega.nz",
                                "link_kind": "direct_mega",
                                "resolved_mega_url": mega_url,
                                "has_photo": bool(cand["has_thumb"]),
                                "thumbnail": cand["thumbnail"],
                                "date": cand["date"],
                                "views": cand["views"],
                                "reactions": cand["reactions"],
                            })
                    elif parsed.get("primary_url"):
                        primary_url = parsed["primary_url"]
                        extracted_posts.append({
                            "chat_id": cand["chat_id"],
                            "message_id": cand["message_id"],
                            "channel": cand["channel"],
                            "channel_title": cand["channel_title"],
                            "title": pack_title,
                            "caption": cand["caption"],
                            "post_url": cand["post_url"],
                            "raw_url": primary_url,
                            "final_url": primary_url,
                            "domain": parsed.get("domain") or _domain_of(primary_url),
                            "link_kind": "external",
                            "resolved_mega_url": None,
                            "has_photo": bool(cand["has_thumb"]),
                            "thumbnail": cand["thumbnail"],
                            "date": cand["date"],
                            "views": cand["views"],
                            "reactions": cand["reactions"],
                        })
                if extracted_posts:
                    upsert_telegram_link_posts(db, extracted_posts, commit=commit)
        except Exception:
            logger.debug("Pasívna extrakcia MEGA odkazov z video indexu preskočená", exc_info=True)

    return valid_count


def _row_to_video_dict(row) -> Dict[str, Any]:
    """Convert DB row or Mapping into standard Telegram video dictionary."""
    chat_id = getattr(row, "chat_id", None) or row["chat_id"]
    message_id = getattr(row, "message_id", None) or row["message_id"]
    channel = getattr(row, "channel", None) or row["channel"] or ""
    author = getattr(row, "author", None) or row["author"] or ""
    title = getattr(row, "title", None) or row["title"] or ""
    caption = getattr(row, "caption", None) or row["caption"] or ""
    file_name = getattr(row, "file_name", None) or row["file_name"] or ""
    file_id = str((row.get("file_id") if hasattr(row, "get") else getattr(row, "file_id", None)) or "")
    duration = getattr(row, "duration", None) or row["duration"] or ""
    duration_sec = getattr(row, "duration_sec", None) or row["duration_sec"] or 0
    size_bytes = getattr(row, "size_bytes", None) or row["size_bytes"] or 0
    width = getattr(row, "width", None) or row["width"] or 0
    height = getattr(row, "height", None) or row["height"] or 0
    effective_res = getattr(row, "effective_res", None) or row["effective_res"] or 0
    quality = getattr(row, "quality", None) or row["quality"] or ""
    orientation = getattr(row, "orientation", None) or row["orientation"] or "landscape"
    views = getattr(row, "views", None) or row["views"] or 0
    forwards = getattr(row, "forwards", None) or row["forwards"] or 0
    reactions = getattr(row, "reactions", None) or row["reactions"] or 0
    date_val = getattr(row, "date", None) or row["date"] or ""
    url = getattr(row, "url", None) or row["url"] or ""
    stream_url = getattr(row, "stream_url", None) or row["stream_url"] or f"/api/v1/telegram/stream/{chat_id}/{message_id}"
    video_url = getattr(row, "video_url", None) or row["video_url"] or stream_url
    thumbnail = getattr(row, "thumbnail", None) or row["thumbnail"] or ""
    has_thumb = getattr(row, "has_thumb", None) or row["has_thumb"] or False
    if not thumbnail and has_thumb:
        thumbnail = f"/api/v1/telegram/thumb/{chat_id}/{message_id}"

    source_channels_raw = getattr(row, "source_channels", None) or row.get("source_channels") if isinstance(row, dict) else getattr(row, "source_channels", None)
    if isinstance(source_channels_raw, str):
        try:
            source_channels = json.loads(source_channels_raw)
        except Exception:
            source_channels = [source_channels_raw]
    elif isinstance(source_channels_raw, list):
        source_channels = source_channels_raw
    else:
        source_channels = [channel] if channel else []

    row_id = getattr(row, "id", None)
    if row_id is None and hasattr(row, "get"):
        row_id = row.get("id")
    metadata = extract_telegram_metadata(caption, file_name, title, message_id)
    out_dict = {
        "id": int(message_id),
        "message_id": int(message_id),
        "chat_id": int(chat_id),
        "channel_id": int(chat_id),
        "file_id": file_id,
        "channel": channel,
        "author": author or channel,
        **metadata,
        "title": metadata["title"],
        "text": caption,
        "file_name": file_name,
        "duration": duration,
        "duration_sec": int(duration_sec),
        "size_bytes": int(size_bytes),
        "width": int(width),
        "height": int(height),
        "quality": quality or (f"{effective_res}p" if effective_res else ""),
        "effective_res": int(effective_res),
        "orientation": orientation,
        "views": int(views),
        "forwards": int(forwards),
        "reactions": int(reactions),
        "date": date_val,
        "url": url or f"https://t.me/c/{chat_id}/{message_id}",
        "video_url": video_url,
        "stream_url": stream_url,
        "thumbnail": thumbnail,
        "thumb_url": thumbnail,
        "media_type": getattr(row, "media_type", "video") or "video",
        "supports_streaming": bool(getattr(row, "supports_streaming", True)),
        "nosound": bool(getattr(row, "nosound", False)),
        "source": "Telegram",
        "source_channels": source_channels,
        "source_type": "fts5_local",
        "preview_unavailable": False,
    }
    if row_id is not None:
        out_dict["_catalog_id"] = int(row_id)
    if "mega." in caption.lower():
        try:
            from .mega_link_extractor import extract_mega_urls
            mega_urls = extract_mega_urls(caption)
            if mega_urls:
                out_dict["mega_urls"] = mega_urls
        except Exception:
            pass
    return out_dict


def telegram_library_identities(db, usernames):
    """Telegram message identities in the library, including legacy URLs."""
    from sqlalchemy import or_
    from .database import Video
    from .telegram_service import _coerce_pair, _pair_from_text, _username_from_text
    from .telegram_stream import public_chat_id

    bind = db.get_bind() if hasattr(db, "get_bind") else None
    has_pending = bool(getattr(db, "new", None) or getattr(db, "dirty", None) or getattr(db, "deleted", None))
    uname_key = tuple(sorted((usernames or {}).items()))
    cache_key = None
    if bind is not None and not has_pending:
        try:
            sig = db.execute(text("SELECT COUNT(*), COALESCE(MAX(id), 0) FROM videos")).one()
            cache_key = (id(bind), int(sig[0] or 0), int(sig[1] or 0), uname_key)
            cached = _LIBRARY_ID_CACHE.get(cache_key)
            if cached is not None and (time.monotonic() - cached[0]) < _LIBRARY_ID_CACHE_TTL:
                return set(cached[1])
        except Exception:
            cache_key = None

    identities = set()
    rows = db.query(
        Video.telegram_chat_id, Video.telegram_message_id, Video.url, Video.source_url
    ).filter(
        or_(
            (Video.telegram_chat_id.isnot(None)) & (Video.telegram_chat_id != "") & (Video.telegram_message_id.isnot(None)),
            Video.url.like("%telegram%"),
            Video.url.like("%t.me%"),
            Video.source_url.like("%telegram%"),
            Video.source_url.like("%t.me%"),
        )
    ).all()
    for chat, message, url, source_url in rows:
        pair = _coerce_pair(chat, message)
        if pair:
            identities.add(f'{public_chat_id(pair[0])}:{pair[1]}')
        for value in (url, source_url):
            pair = _pair_from_text(value or '')
            if pair:
                identities.add(f'{public_chat_id(pair[0])}:{pair[1]}')
            named = _username_from_text(value or '')
            if named and named[0].lower() in usernames:
                identities.add(f'{usernames[named[0].lower()]}:{named[1]}')

    if cache_key is not None:
        if len(_LIBRARY_ID_CACHE) >= 32:
            _LIBRARY_ID_CACHE.clear()
        _LIBRARY_ID_CACHE[cache_key] = (time.monotonic(), frozenset(identities))
    return identities


_SORT_ORDER_SQL = {
    "relevance": "rank, tmi.date DESC, tmi.id DESC",
    "date": "tmi.date DESC, tmi.id DESC",
    "views": "tmi.views DESC, tmi.date DESC, tmi.id DESC",
    "duration": "tmi.duration_sec DESC, tmi.date DESC, tmi.id DESC",
    "quality": "tmi.effective_res DESC, tmi.size_bytes DESC, tmi.date DESC, tmi.id DESC",
    "size": "tmi.size_bytes DESC, tmi.date DESC, tmi.id DESC",
}
_PLAIN_ORDER_SQL = {
    "relevance": "date DESC, id DESC",
    "date": "date DESC, id DESC",
    "views": "views DESC, date DESC, id DESC",
    "duration": "duration_sec DESC, date DESC, id DESC",
    "quality": "effective_res DESC, size_bytes DESC, date DESC, id DESC",
    "size": "size_bytes DESC, date DESC, id DESC",
}


def _deduplicate_video_dicts(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse duplicate reposts sharing the same Telegram file_id while merging channels."""
    out: List[Dict[str, Any]] = []
    by_key: dict[tuple, Dict[str, Any]] = {}
    for item in items:
        fid = str(item.get("file_id") or "").strip()
        key = ("fid", fid) if fid else ("msg", int(item.get("chat_id") or 0), int(item.get("message_id") or 0))
        existing = by_key.get(key)
        if existing is None:
            by_key[key] = item
            out.append(item)
            continue
        for ch in item.get("source_channels") or []:
            if ch and ch not in existing["source_channels"]:
                existing["source_channels"].append(ch)
        for stat in ("views", "forwards", "reactions"):
            if int(item.get(stat) or 0) > int(existing.get(stat) or 0):
                existing[stat] = item[stat]
        if len(str(item.get("text") or "")) > len(str(existing.get("text") or "")):
            existing["text"] = item["text"]
        if (
            len(str(item.get("title") or "")) > len(str(existing.get("title") or ""))
            and not str(item.get("title") or "").startswith("Telegram #")
        ):
            existing["title"] = item["title"]
    return out


def _sort_video_dicts(items: List[Dict[str, Any]], sort_key: str) -> List[Dict[str, Any]]:
    if sort_key == "views":
        return sorted(items, key=lambda v: (int(v.get("views") or 0), str(v.get("date") or ""), int(v.get("message_id") or 0)), reverse=True)
    if sort_key == "duration":
        return sorted(items, key=lambda v: (int(v.get("duration_sec") or 0), str(v.get("date") or ""), int(v.get("message_id") or 0)), reverse=True)
    if sort_key == "quality":
        return sorted(items, key=lambda v: (int(v.get("effective_res") or 0), int(v.get("size_bytes") or 0), str(v.get("date") or ""), int(v.get("message_id") or 0)), reverse=True)
    if sort_key == "size":
        return sorted(items, key=lambda v: (int(v.get("size_bytes") or 0), str(v.get("date") or ""), int(v.get("message_id") or 0)), reverse=True)
    if sort_key == "date":
        return sorted(items, key=lambda v: (str(v.get("date") or ""), int(v.get("message_id") or 0)), reverse=True)
    return items


def _build_negative_sql(neg_tokens: List[str], alias: str, params: Dict[str, Any]) -> str:
    if not neg_tokens:
        return ""
    prefix = f"{alias}." if alias else ""
    hay = (
        f"LOWER(COALESCE({prefix}title, '') || ' ' || COALESCE({prefix}caption, '') "
        f"|| ' ' || COALESCE({prefix}file_name, '') || ' ' || COALESCE({prefix}channel, ''))"
    )
    clauses = []
    for idx, tok in enumerate(neg_tokens[:12]):
        key = f"neg_{idx}"
        params[key] = f"%{tok.lower()}%"
        clauses.append(f"AND {hay} NOT LIKE :{key}")
    return "\n              ".join(clauses)


def _build_positive_like_sql(pos_groups: List[List[str]], params: Dict[str, Any]) -> str:
    if not pos_groups:
        return ""
    or_clauses = []
    p_idx = 0
    for group in pos_groups[:8]:
        and_parts = []
        for tok in group[:6]:
            key = f"pos_{p_idx}"
            p_idx += 1
            params[key] = f"%{tok}%"
            and_parts.append(
                f"(title LIKE :{key} OR caption LIKE :{key} OR file_name LIKE :{key} OR channel LIKE :{key})"
            )
        if and_parts:
            or_clauses.append("(" + " AND ".join(and_parts) + ")")
    return "(" + " OR ".join(or_clauses) + ")" if or_clauses else ""


def search_telegram_fts(
    db: Session,
    query: str,
    limit: int = 50,
    min_duration: int = 0,
    min_quality: int = 0,
    min_size_mb: float = 0,
    channel: Optional[str] = None,
    chat_ids: Optional[list[int]] = None,
    offset: int = 0,
    new_only: bool = False,
    before_date: Optional[str] = None,
    before_id: int = 0,
    sort: str = "relevance",
    exclude: str = "",
    deduplicate: bool = True,
) -> List[Dict[str, Any]]:
    """Hybrid FTS5 + compound-substring local search across indexed Telegram videos."""
    raw_query = (query or "").strip()
    capped_limit = max(1, min(int(limit or 50), 2001))
    offset = max(0, int(offset or 0))
    min_size_bytes = int(min_size_mb * 1048576) if min_size_mb > 0 else 0
    chat_filter = json.dumps(chat_ids) if chat_ids else None
    sort_key = sort if sort in _PLAIN_ORDER_SQL else "relevance"

    if new_only:
        # Compare Telegram message identity, not captions or filenames. Legacy
        # library entries can carry the identity in either URL instead of columns.
        from .database import TelegramCatalogChannel
        from .telegram_stream import public_chat_id

        channels = db.query(TelegramCatalogChannel).filter_by(active=True).all()
        active = {public_chat_id(int(c.peer_id)) for c in channels}
        usernames = {str(c.username).lower().lstrip('@'): public_chat_id(int(c.peer_id))
                     for c in channels if c.username}
        identities = telegram_library_identities(db, usernames)
        rows = db.execute(text('''
            SELECT * FROM telegram_media_index
            WHERE chat_id IN (SELECT value FROM json_each(:active))
              AND (CAST(chat_id AS TEXT) || ':' || CAST(message_id AS TEXT))
                  NOT IN (SELECT value FROM json_each(:identities))
              AND (:before_id = 0 OR COALESCE(date, '') < :before_date OR
                   (COALESCE(date, '') = :before_date AND id < :before_id))
            ORDER BY COALESCE(date, '') DESC, id DESC
            LIMIT :limit OFFSET :offset
        '''), {'active': json.dumps(list(active)), 'identities': json.dumps(list(identities)),
                'limit': capped_limit, 'offset': offset, 'before_date': before_date or '',
                'before_id': max(0, before_id)}).mappings().all()
        return [{**_row_to_video_dict(row), '_catalog_id': row['id']} for row in rows]

    match_expr, pos_groups, neg_tokens = _parse_search_query(raw_query, exclude)
    use_chrono_cursor = bool(
        before_id and int(before_id) > 0
        and sort_key in {"date", "relevance"}
    )
    effective_offset = 0 if use_chrono_cursor else offset
    fetch_window = min(6000, max(capped_limit + effective_offset, (capped_limit + effective_offset) * 2)) if deduplicate else (capped_limit + effective_offset)

    base_params: Dict[str, Any] = {
        "min_duration": min_duration,
        "min_quality": min_quality,
        "min_size_bytes": min_size_bytes,
        "channel": channel.strip() if channel else None,
        "chat_ids": chat_filter,
        "before_date": (before_date or "") if use_chrono_cursor else "",
        "before_id": max(0, int(before_id or 0)) if use_chrono_cursor else 0,
        "limit": fetch_window,
    }

    # Blank / wildcard / negative-only queries list matching videos directly; pure punctuation returns []
    if not match_expr and not pos_groups:
        if raw_query and raw_query != "*" and not neg_tokens:
            return []
        neg_sql = _build_negative_sql(neg_tokens, "", base_params)
        order_sql = _PLAIN_ORDER_SQL[sort_key]
        sql = text(f"""
            SELECT * FROM telegram_media_index
            WHERE (:min_duration = 0 OR duration_sec >= :min_duration)
              AND (:min_quality = 0 OR effective_res >= :min_quality)
              AND (:min_size_bytes = 0 OR size_bytes >= :min_size_bytes)
              AND (:channel IS NULL OR channel = :channel)
              AND (:chat_ids IS NULL OR chat_id IN (SELECT value FROM json_each(:chat_ids)))
              AND (:before_id = 0 OR COALESCE(date, '') < :before_date OR
                   (COALESCE(date, '') = :before_date AND id < :before_id))
              {neg_sql}
            ORDER BY {order_sql}
            LIMIT :limit OFFSET :sql_offset
        """)
        params = dict(base_params, sql_offset=0 if deduplicate else effective_offset)
        if not deduplicate:
            params["limit"] = capped_limit
        rows = db.execute(sql, params).mappings().all()
        items = [_row_to_video_dict(r) for r in rows]
        if deduplicate:
            items = _deduplicate_video_dicts(items)
            return items[effective_offset:effective_offset + capped_limit]
        return items

    combined_dicts: List[Dict[str, Any]] = []
    seen_row_ids: set[int] = set()

    if match_expr:
        try:
            fts_params = dict(base_params, match_expr=match_expr)
            neg_sql = _build_negative_sql(neg_tokens, "tmi", fts_params)
            order_sql = _SORT_ORDER_SQL[sort_key]
            fts_sql = text(f"""
                SELECT tmi.*, rank
                FROM telegram_media_index tmi
                JOIN telegram_media_fts fts ON tmi.id = fts.rowid
                WHERE telegram_media_fts MATCH :match_expr
                  AND (:min_duration = 0 OR tmi.duration_sec >= :min_duration)
                  AND (:min_quality = 0 OR tmi.effective_res >= :min_quality)
                  AND (:min_size_bytes = 0 OR tmi.size_bytes >= :min_size_bytes)
                  AND (:channel IS NULL OR tmi.channel = :channel)
                  AND (:chat_ids IS NULL OR tmi.chat_id IN (SELECT value FROM json_each(:chat_ids)))
                  AND (:before_id = 0 OR COALESCE(tmi.date, '') < :before_date OR
                       (COALESCE(tmi.date, '') = :before_date AND tmi.id < :before_id))
                  {neg_sql}
                ORDER BY {order_sql}
                LIMIT :limit
            """)
            fts_rows = db.execute(fts_sql, fts_params).mappings().all()
            for r in fts_rows:
                rid = int(r["id"])
                seen_row_ids.add(rid)
                combined_dicts.append(_row_to_video_dict(r))
        except Exception as exc:
            logger.warning("FTS5 match failed for '%s' (%s), falling back to LIKE query: %s", raw_query, match_expr, exc)

    # Augment with compound/substring LIKE matches when FTS5 has not filled the requested window
    need_like = bool(pos_groups and len(combined_dicts) < fetch_window)
    if need_like:
        like_params = dict(base_params)
        like_clause = _build_positive_like_sql(pos_groups, like_params)
        if like_clause:
            neg_sql = _build_negative_sql(neg_tokens, "", like_params)
            order_sql = _PLAIN_ORDER_SQL[sort_key]
            like_sql = text(f"""
                SELECT * FROM telegram_media_index
                WHERE {like_clause}
                  AND (:min_duration = 0 OR duration_sec >= :min_duration)
                  AND (:min_quality = 0 OR effective_res >= :min_quality)
                  AND (:min_size_bytes = 0 OR size_bytes >= :min_size_bytes)
                  AND (:channel IS NULL OR channel = :channel)
                  AND (:chat_ids IS NULL OR chat_id IN (SELECT value FROM json_each(:chat_ids)))
                  AND (:before_id = 0 OR COALESCE(date, '') < :before_date OR
                       (COALESCE(date, '') = :before_date AND id < :before_id))
                  {neg_sql}
                ORDER BY {order_sql}
                LIMIT :limit
            """)
            like_rows = db.execute(like_sql, like_params).mappings().all()
            for r in like_rows:
                rid = int(r["id"])
                if rid not in seen_row_ids:
                    seen_row_ids.add(rid)
                    combined_dicts.append(_row_to_video_dict(r))

    if deduplicate:
        combined_dicts = _deduplicate_video_dicts(combined_dicts)
    if sort_key != "relevance":
        combined_dicts = _sort_video_dicts(combined_dicts, sort_key)
    return combined_dicts[effective_offset:effective_offset + capped_limit]


def measure_telegram_like_coverage(db: Session, queries: List[str]) -> Dict[str, Any]:
    """Measure how many hits are already covered by FTS5 with normalized tokens vs requiring LIKE fallback."""
    report = []
    fts_total = 0
    combined_total = 0
    for q in queries or []:
        match_expr, pos_groups, _ = _parse_search_query(q)
        fts_ids: set[int] = set()
        if match_expr:
            rows = db.execute(
                text("SELECT rowid FROM telegram_media_fts WHERE telegram_media_fts MATCH :m"),
                {"m": match_expr},
            ).scalars().all()
            fts_ids = {int(r) for r in rows}
        like_ids: set[int] = set()
        if pos_groups:
            params: Dict[str, Any] = {}
            clause = _build_positive_like_sql(pos_groups, params)
            if clause:
                lrows = db.execute(text(f"SELECT id FROM telegram_media_index WHERE {clause}"), params).scalars().all()
                like_ids = {int(r) for r in lrows}
        union_ids = fts_ids | like_ids
        fts_only_cov = (len(fts_ids) / len(union_ids)) if union_ids else 1.0
        fts_total += len(fts_ids)
        combined_total += len(union_ids)
        report.append({
            "query": q,
            "fts_hits": len(fts_ids),
            "total_hits": len(union_ids),
            "like_only_hits": len(like_ids - fts_ids),
            "fts_coverage_ratio": round(fts_only_cov, 4),
        })
    return {
        "queries": report,
        "overall_fts_coverage": round((fts_total / combined_total) if combined_total else 1.0, 4),
    }


def get_telegram_index_stats(db: Session) -> Dict[str, Any]:
    """Return summary statistics of the local Telegram index."""
    try:
        row = db.execute(text("""
            SELECT
                COUNT(*) as total_videos,
                COUNT(DISTINCT channel) as total_channels,
                COALESCE(SUM(size_bytes), 0) as total_size_bytes,
                MAX(date) as newest_message_date,
                MAX(indexed_at) as last_indexed_at
            FROM telegram_media_index
        """)).mappings().one()

        top_channels = db.execute(text("""
            SELECT channel, COUNT(*) as count
            FROM telegram_media_index
            WHERE channel IS NOT NULL AND channel != ''
            GROUP BY channel
            ORDER BY count DESC
            LIMIT 10
        """)).mappings().all()

        last_idx = row["last_indexed_at"]
        last_indexed_str = last_idx.isoformat() if hasattr(last_idx, "isoformat") else (str(last_idx) if last_idx else None)

        return {
            "total_videos": int(row["total_videos"] or 0),
            "total_channels": int(row["total_channels"] or 0),
            "total_size_bytes": int(row["total_size_bytes"] or 0),
            "total_size_mb": round(int(row["total_size_bytes"] or 0) / (1024 * 1024), 1),
            "newest_message_date": row["newest_message_date"],
            "last_indexed_at": last_indexed_str,
            "top_channels": [{"channel": r["channel"], "count": int(r["count"])} for r in top_channels],
            "fts_enabled": True,
        }
    except Exception as exc:
        logger.error("Failed to fetch telegram index stats: %s", exc)
        return {
            "total_videos": 0,
            "total_channels": 0,
            "total_size_bytes": 0,
            "error": str(exc),
            "fts_enabled": False,
        }


def clear_telegram_index(db: Session) -> int:
    """Clear all records from local telegram index."""
    try:
        count = db.execute(text("SELECT COUNT(*) FROM telegram_media_index")).scalar() or 0
        db.execute(text("DELETE FROM telegram_media_index"))
        db.commit()
        return count
    except Exception as exc:
        db.rollback()
        logger.error("Failed to clear telegram index: %s", exc)
        raise


async def sync_channel_to_index(channel_name: str, limit: int = 200, query: Optional[str] = None) -> Dict[str, Any]:
    """Fetch video metadata from a channel and store in local FTS5 index."""
    from .database import SessionLocal
    from .telegram_service import scrape_channel_via_telethon

    try:
        videos = await scrape_channel_via_telethon(channel_name, limit, query=query, with_topics=False)
        with SessionLocal() as db:
            upserted = upsert_telegram_media_batch(db, videos)
        return {
            "channel": channel_name,
            "fetched": len(videos),
            "upserted": upserted,
            "status": "ok",
        }
    except Exception as exc:
        logger.error("Failed to sync channel %s to index: %s", channel_name, exc)
        return {
            "channel": channel_name,
            "fetched": 0,
            "upserted": 0,
            "status": "error",
            "error": str(exc),
        }
