"""Unified local search across all Nexus vaults (SQLite / FTS5 only, zero network calls).

Searches across:
1. library  — Main video library (`videos` + `videos_fts`)
2. telegram — Local Telegram FTS5 index (`telegram_media_index` + `telegram_media_fts`)
3. forum    — Watched forum threads, posts, and extracted links (`forum_links`, `forum_posts`, `forum_threads`)
4. filester — Local Filester Discovery SQLite index (`filester_index.db`, read-only)
5. mega     — MEGA Hub folder snapshots including nested video files (`mega_hub_entries`)
6. queue    — Historical import queue & discovery candidates (`import_job_items`, `discovered_videos`)
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

from sqlalchemy import String, cast, func, or_, text
from sqlalchemy.orm import Session

from .database import (
    DiscoveredVideo,
    ForumLink,
    ForumPost,
    ForumThread,
    ImportJobItem,
    MegaHubEntry,
    TelegramMediaIndex,
    Video,
    sanitize_fts_query,
)
from .telegram_index import search_telegram_fts

logger = logging.getLogger(__name__)

VAULT_BUCKETS: Tuple[str, ...] = (
    "library",
    "telegram",
    "forum",
    "filester",
    "mega",
    "queue",
)

BUCKET_META: Dict[str, Dict[str, str]] = {
    "library": {"label": "Knižnica", "icon": "video_library"},
    "telegram": {"label": "Telegram Index", "icon": "send"},
    "forum": {"label": "Fóra (SimpCity/SMG)", "icon": "forum"},
    "filester": {"label": "Filester Index", "icon": "folder_special"},
    "mega": {"label": "MEGA Hub", "icon": "cloud_queue"},
    "queue": {"label": "Fronta & Discovery", "icon": "history"},
}

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
_QUALITY_RE = re.compile(r"\b(2160|1440|1080|720|480|360)p?\b|4k|uhd", re.IGNORECASE)


def default_filester_db_paths() -> List[Path]:
    """Return candidate read-only Filester SQLite index files on this machine."""
    env_raw = os.environ.get("NEXUS_FILESTER_DB_PATHS", "").strip()
    candidates: List[Path] = []
    if env_raw:
        for chunk in env_raw.split(os.pathsep):
            if chunk.strip():
                candidates.append(Path(chunk.strip()))
    else:
        candidates.extend([
            _PROJECT_ROOT / "extension" / "filester_search" / "filester_index.db",
            Path.home() / "Desktop" / "Filester Search Data" / "filester_index.db",
        ])

    seen: Set[str] = set()
    resolved: List[Path] = []
    for path in candidates:
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = str(path).lower()
        if key in seen:
            continue
        seen.add(key)
        if path.is_file() and path.stat().st_size > 0:
            resolved.append(path)
    return resolved


def _tokenize(query: str) -> List[str]:
    return [tok.casefold() for tok in re.findall(r"\w+", query or "", flags=re.UNICODE) if tok.strip()]


def _build_fts_prefix_expr(query: str) -> str:
    sanitized = sanitize_fts_query(query)
    if not sanitized:
        return ""
    parts = [part.strip('"') for part in sanitized.split() if part.strip('"')]
    return " AND ".join(f'"{part}"*' for part in parts)


def _infer_height(height: Any = 0, quality: Any = "", title: str = "") -> int:
    try:
        h = int(height or 0)
        if h > 0:
            return h
    except (TypeError, ValueError):
        pass
    for text_val in (str(quality or ""), str(title or "")):
        m = _QUALITY_RE.search(text_val)
        if not m:
            continue
        matched = m.group(0).lower()
        if matched in ("4k", "uhd"):
            return 2160
        if m.group(1):
            return int(m.group(1))
    return 0


def _quality_label(height: int, raw_quality: str = "") -> str:
    if height >= 2160:
        return "4K"
    if height > 0:
        return f"{height}p"
    return str(raw_quality or "").strip()


def _iso_date(val: Any) -> str:
    if val is None or val == "":
        return ""
    if hasattr(val, "isoformat"):
        return val.isoformat()
    if isinstance(val, (int, float)) and val > 100000:
        from datetime import datetime, timezone
        try:
            return datetime.fromtimestamp(float(val), tz=timezone.utc).isoformat()
        except (OSError, ValueError, OverflowError):
            return ""
    return str(val).strip()


def _normalize_thumb(path: Optional[str], fallback: Optional[str] = None) -> str:
    val = str(path or "").strip()
    if not val:
        return str(fallback or "").strip()
    if val.startswith(("http://", "https://", "/static/", "/api/")):
        return val
    # Local static thumbnails stored relative to app/static
    norm = val.replace("\\", "/")
    if "static/thumbnails/" in norm:
        idx = norm.index("static/thumbnails/")
        return "/" + norm[idx:]
    return str(fallback or val).strip()


def _matches_all_tokens(tokens: Sequence[str], *haystacks: Any) -> bool:
    if not tokens:
        return True
    blob = " ".join(str(h or "") for h in haystacks).casefold()
    return all(tok in blob for tok in tokens)


def _table_exists(db: Session, table_name: str) -> bool:
    try:
        row = db.execute(
            text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name"),
            {"name": table_name},
        ).scalar()
        return bool(row)
    except Exception:
        return False


def _library_order_sql(sort_key: str, *, use_fts: bool) -> str:
    if sort_key == "quality_desc":
        return "COALESCE(v.height, 0) DESC, COALESCE(v.file_size_mb, 0) DESC, v.id DESC"
    if sort_key == "duration_desc":
        return "COALESCE(v.duration, 0) DESC, COALESCE(v.height, 0) DESC, v.id DESC"
    if sort_key == "size_desc":
        return "COALESCE(v.file_size_mb, 0) DESC, COALESCE(v.height, 0) DESC, v.id DESC"
    if sort_key == "newest":
        return "COALESCE(v.created_at, '') DESC, v.id DESC"
    if sort_key == "title_asc":
        return "LOWER(COALESCE(v.title, '')) ASC, COALESCE(v.height, 0) DESC, v.id DESC"
    if use_fts:
        return "bm25(videos_fts), COALESCE(v.height, 0) DESC, v.id DESC"
    return "COALESCE(v.height, 0) DESC, v.id DESC"


def _search_library(
    db: Session,
    query: str,
    min_height: int,
    limit: int,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_importable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if only_importable:
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False

    src_low = (source_filter or "").strip().casefold()
    src_like = f"%{src_low}%" if src_low else ""
    fetch_lim = limit + 1
    rows: List[Any] = []

    if tokens and _table_exists(db, "videos_fts"):
        fts_expr = _build_fts_prefix_expr(query)
        if fts_expr:
            order_sql = _library_order_sql(sort_key, use_fts=True)
            sql = text(
                f"""
                SELECT v.id, v.title, v.url, v.source_url, v.thumbnail_path, v.original_thumbnail_url,
                       v.duration, v.height, v.quality, v.file_size_mb, v.tags, v.ai_tags,
                       v.models, v.batch_name, v.storage_type, v.status, v.created_at
                FROM videos_fts f
                JOIN videos v ON v.id = f.rowid
                WHERE videos_fts MATCH :match_expr
                  AND (:min_h <= 0 OR COALESCE(v.height, 0) >= :min_h)
                  AND (:min_dur <= 0 OR COALESCE(v.duration, 0) >= :min_dur)
                  AND (:min_sz <= 0 OR COALESCE(v.file_size_mb, 0) >= :min_sz)
                  AND (:src_like = '' OR LOWER(
                        COALESCE(v.storage_type, '') || ' ' || COALESCE(v.batch_name, '') || ' ' ||
                        COALESCE(v.models, '') || ' ' || COALESCE(v.tags, '') || ' ' ||
                        COALESCE(v.url, '') || ' ' || COALESCE(v.source_url, '')
                  ) LIKE :src_like)
                ORDER BY {order_sql}
                LIMIT :lim OFFSET :off
                """
            )
            rows = db.execute(
                sql,
                {
                    "match_expr": fts_expr,
                    "min_h": min_height,
                    "min_dur": min_duration,
                    "min_sz": min_size_mb,
                    "src_like": src_like,
                    "lim": fetch_lim,
                    "off": offset,
                },
            ).mappings().all()

    if not rows and (browse or tokens):
        # Fallback to ORM when FTS table is absent or FTS prefix returned nothing
        q = db.query(Video)
        for tok in tokens:
            like = f"%{tok}%"
            q = q.filter(
                (Video.title.ilike(like))
                | (Video.tags.ilike(like))
                | (Video.ai_tags.ilike(like))
                | (Video.models.ilike(like))
                | (Video.batch_name.ilike(like))
                | (Video.source_url.ilike(like))
            )
        if min_height > 0:
            q = q.filter(func.coalesce(Video.height, 0) >= min_height)
        if min_duration > 0:
            q = q.filter(func.coalesce(Video.duration, 0) >= min_duration)
        if min_size_mb > 0:
            q = q.filter(func.coalesce(Video.file_size_mb, 0) >= min_size_mb)
        if src_like:
            q = q.filter(
                (Video.storage_type.ilike(src_like))
                | (Video.batch_name.ilike(src_like))
                | (Video.models.ilike(src_like))
                | (Video.tags.ilike(src_like))
                | (Video.url.ilike(src_like))
                | (Video.source_url.ilike(src_like))
            )

        if sort_key == "quality_desc":
            q = q.order_by(func.coalesce(Video.height, 0).desc(), func.coalesce(Video.file_size_mb, 0).desc(), Video.id.desc())
        elif sort_key == "duration_desc":
            q = q.order_by(func.coalesce(Video.duration, 0).desc(), func.coalesce(Video.height, 0).desc(), Video.id.desc())
        elif sort_key == "size_desc":
            q = q.order_by(func.coalesce(Video.file_size_mb, 0).desc(), func.coalesce(Video.height, 0).desc(), Video.id.desc())
        elif sort_key == "newest":
            q = q.order_by(Video.created_at.desc(), Video.id.desc())
        elif sort_key == "title_asc":
            q = q.order_by(func.lower(func.coalesce(Video.title, "")).asc(), func.coalesce(Video.height, 0).desc())
        elif browse and not tokens:
            q = q.order_by(Video.id.desc())
        else:
            q = q.order_by(func.coalesce(Video.height, 0).desc(), Video.id.desc())

        orm_rows = q.offset(offset).limit(fetch_lim).all()
        rows = [
            {
                "id": v.id,
                "title": v.title,
                "url": v.url,
                "source_url": v.source_url,
                "thumbnail_path": v.thumbnail_path,
                "original_thumbnail_url": v.original_thumbnail_url,
                "duration": v.duration,
                "height": v.height,
                "quality": v.quality,
                "file_size_mb": v.file_size_mb,
                "tags": v.tags,
                "models": v.models,
                "batch_name": v.batch_name,
                "storage_type": v.storage_type,
                "status": v.status,
                "created_at": v.created_at,
            }
            for v in orm_rows
        ]

    has_more = len(rows) > limit
    rows = rows[:limit]

    items: List[Dict[str, Any]] = []
    for r in rows:
        title = str(r["title"] or "Video bez názvu").strip()
        h = _infer_height(r["height"], r["quality"], title)
        if min_height > 0 and h < min_height:
            continue
        meta_parts = [p for p in (r["batch_name"], r["models"], r["tags"]) if p]
        raw_url = str(r["url"] or "").strip()
        src_url = str(r["source_url"] or raw_url).strip()
        is_hls = ".m3u8" in raw_url.lower()
        if raw_url.startswith("/api/") or raw_url.startswith("/hls_proxy"):
            playable_url = raw_url
        elif is_hls and raw_url.startswith(("http://", "https://")):
            playable_url = (
                f"/hls_proxy?url={urllib.parse.quote(raw_url, safe='')}"
                f"&referer={urllib.parse.quote(src_url, safe='')}"
            )
        else:
            playable_url = f"/stream_proxy/{int(r['id'])}.mp4"
        items.append({
            "id": f"library:{r['id']}",
            "bucket": "library",
            "source_label": f"Knižnica ({r['storage_type'] or 'remote'})",
            "title": title,
            "subtitle": " · ".join(str(p)[:60] for p in meta_parts[:2]),
            "url": raw_url,
            "source_url": src_url,
            "thumbnail": _normalize_thumb(r["thumbnail_path"], r["original_thumbnail_url"]),
            "duration_sec": int(float(r["duration"] or 0)),
            "height": h,
            "quality": _quality_label(h, r["quality"] or ""),
            "size_mb": round(float(r["file_size_mb"]), 1) if r["file_size_mb"] else None,
            "status": "library",
            "video_id": int(r["id"]),
            "can_import": False,
            "is_hls": is_hls,
            "playable_url": playable_url,
            "created_at": _iso_date(r["created_at"]),
        })
    return items, has_more


def _search_telegram(
    db: Session,
    query: str,
    min_height: int,
    limit: int,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_importable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if not _table_exists(db, "telegram_media_index"):
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False

    tg_sort = {
        "quality_desc": "quality",
        "duration_desc": "duration",
        "size_desc": "size",
        "newest": "date",
    }.get(sort_key, "relevance")

    src_low = (source_filter or "").strip().casefold()
    if src_low:
        fetch_lim = min(2000, max(limit + offset + 1, (limit + offset) * 3))
        fetch_off = 0
    else:
        fetch_lim = limit + 1
        fetch_off = offset

    hits = search_telegram_fts(
        db,
        query=query if tokens else "",
        limit=fetch_lim,
        min_duration=min_duration,
        min_quality=min_height,
        min_size_mb=min_size_mb,
        offset=fetch_off,
        sort=tg_sort,
        deduplicate=True,
    )
    items: List[Dict[str, Any]] = []
    for row in hits:
        chat_id = row.get("chat_id")
        message_id = row.get("message_id")
        can_imp = bool(chat_id and message_id)
        if only_importable and not can_imp:
            continue
        title = str(row.get("title") or row.get("file_name") or row.get("caption") or "Telegram video").strip()
        h = _infer_height(row.get("effective_res") or row.get("height"), row.get("quality"), title)
        if min_height > 0 and h < min_height:
            continue
        stream_url = row.get("stream_url") or (f"/api/v1/telegram/stream/{chat_id}/{message_id}" if chat_id and message_id else "")
        size_bytes = float(row.get("size_bytes") or 0)
        channel = str(row.get("channel") or row.get("author") or "").strip()
        source_label = f"Telegram · {channel}" if channel else "Telegram"
        subtitle = str(row.get("file_name") or row.get("caption") or "")[:120]
        url_val = row.get("url") or stream_url
        if src_low:
            hay = f"{source_label} {subtitle} {url_val}".casefold()
            if src_low not in hay:
                continue
        items.append({
            "id": f"telegram:{chat_id}:{message_id}",
            "bucket": "telegram",
            "source_label": source_label,
            "title": title,
            "subtitle": subtitle,
            "url": url_val,
            "source_url": row.get("url") or "",
            "thumbnail": str(row.get("thumbnail") or ""),
            "duration_sec": int(float(row.get("duration_sec") or 0)),
            "height": h,
            "quality": _quality_label(h, row.get("quality") or ""),
            "size_mb": round(size_bytes / 1048576.0, 1) if size_bytes > 0 else None,
            "status": "indexed",
            "video_id": None,
            "can_import": can_imp,
            "playable_url": stream_url,
            "created_at": _iso_date(row.get("date")),
            "telegram_meta": {
                "chat_id": chat_id,
                "message_id": message_id,
                "title": title,
                "duration": row.get("duration_sec") or 0,
                "quality": _quality_label(h, row.get("quality") or ""),
                "width": int(row.get("width") or 0),
                "height": h,
                "size_bytes": int(size_bytes) if size_bytes > 0 else None,
                "thumbnail": str(row.get("thumbnail") or ""),
                "url": row.get("url") or "",
                "stream_url": stream_url,
            },
        })

    if src_low:
        sliced = items[offset : offset + limit]
        return sliced, len(items) > (offset + limit)

    has_more = len(items) > limit
    return items[:limit], has_more


def _search_forums(
    db: Session,
    query: str,
    min_height: int,
    limit: int,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_playable: bool = False,
    only_importable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if only_playable or not _table_exists(db, "forum_links"):
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False

    q = (
        db.query(ForumLink, ForumThread, ForumPost)
        .outerjoin(ForumThread, ForumLink.thread_id == ForumThread.id)
        .outerjoin(ForumPost, ForumLink.post_id == ForumPost.id)
    )
    for tok in tokens:
        like = f"%{tok}%"
        q = q.filter(
            (ForumLink.title.ilike(like))
            | (ForumLink.url.ilike(like))
            | (ForumLink.tags.ilike(like))
            | (ForumLink.platform.ilike(like))
            | (ForumThread.title.ilike(like))
            | (ForumThread.tags.ilike(like))
            | (ForumPost.body_text.ilike(like))
            | (ForumPost.hashtags.ilike(like))
            | (ForumPost.author.ilike(like))
        )
    if min_duration > 0:
        q = q.filter(func.coalesce(ForumLink.duration, 0) >= min_duration)
    if min_size_mb > 0:
        q = q.filter(func.coalesce(ForumLink.size_bytes, 0) >= min_size_mb * 1048576.0)
    if only_importable:
        q = q.filter(or_(ForumLink.status.is_(None), ForumLink.status != "imported"))
    src_low = (source_filter or "").strip().casefold()
    if src_low:
        src_like = f"%{src_low}%"
        q = q.filter(
            (ForumLink.platform.ilike(src_like))
            | (ForumLink.url.ilike(src_like))
            | (ForumThread.board.ilike(src_like))
            | (ForumThread.title.ilike(src_like))
            | (ForumPost.author.ilike(src_like))
        )

    if sort_key == "duration_desc":
        q = q.order_by(func.coalesce(ForumLink.duration, 0).desc(), ForumLink.id.desc())
    elif sort_key == "size_desc":
        q = q.order_by(func.coalesce(ForumLink.size_bytes, 0).desc(), ForumLink.id.desc())
    elif sort_key == "newest":
        q = q.order_by(func.coalesce(ForumPost.posted_at, ForumLink.created_at).desc(), ForumLink.id.desc())
    elif sort_key == "title_asc":
        q = q.order_by(func.lower(func.coalesce(ForumLink.title, ForumThread.title, ForumLink.url)).asc())
    else:
        q = q.order_by(ForumLink.id.desc())

    fetch_mult = 2 if min_height > 0 else 1
    rows = q.offset(offset * fetch_mult).limit((limit + 1) * fetch_mult).all()
    items: List[Dict[str, Any]] = []
    for link, thread, post in rows:
        raw_title = (link.title or "").strip()
        thread_title = (thread.title if thread else "") or ""
        if not raw_title or raw_title.lower() in {"spoiler:", "dm", "link", "here", "download"}:
            display_title = f"{thread_title} — {link.platform or 'odkaz'}" if thread_title else link.url
        else:
            display_title = raw_title
        h = _infer_height(0, link.quality or "", display_title)
        if min_height > 0 and h < min_height:
            continue
        size_bytes = float(link.size_bytes or 0)
        author = (post.author if post else link.author) or ""
        board = (thread.board if thread else "") or ""
        sub_parts = [p for p in (board, thread_title, author) if p]
        items.append({
            "id": f"forum:{link.id}",
            "bucket": "forum",
            "source_label": f"Fórum · {(link.platform or 'link').upper()}",
            "title": display_title,
            "subtitle": " · ".join(sub_parts[:3]),
            "url": link.url,
            "source_url": (post.permalink if post and post.permalink else None) or (thread.url if thread else None) or link.url,
            "thumbnail": str(link.thumbnail or ""),
            "duration_sec": int(float(link.duration or 0)),
            "height": h,
            "quality": _quality_label(h, link.quality or ""),
            "size_mb": round(size_bytes / 1048576.0, 1) if size_bytes > 0 else None,
            "status": link.status or "new",
            "video_id": None,
            "can_import": (link.status or "new") != "imported",
            "playable_url": "",
            "created_at": _iso_date((post.posted_at if post and post.posted_at else None) or link.created_at),
        })
        if len(items) > limit:
            break
    return items[:limit], len(items) > limit


def _search_filester(
    query: str,
    min_height: int,
    limit: int,
    db_paths: Optional[Sequence[Path]] = None,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_playable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if only_playable or min_duration > 0 or min_size_mb > 0:
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False
    paths = list(db_paths) if db_paths is not None else default_filester_db_paths()
    if not paths:
        return [], False

    fts_expr = _build_fts_prefix_expr(query) if tokens else ""
    src_low = (source_filter or "").strip().casefold()
    target_total = offset + limit + 1
    seen_folders: Set[str] = set()
    items: List[Dict[str, Any]] = []

    for db_path in paths:
        if not db_path.is_file():
            continue
        conn = None
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            has_fts = cur.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pages_fts'"
            ).fetchone()
            rows: List[sqlite3.Row] = []
            fetch_lim = target_total * (2 if min_height > 0 else 1)

            if tokens and has_fts and fts_expr:
                try:
                    if src_low:
                        rows = cur.execute(
                            """
                            SELECT p.url, p.folder_id, p.title, p.description, p.file_count,
                                   p.filenames, p.tags, p.source, p.last_seen
                            FROM pages_fts f
                            JOIN pages p ON p.rowid = f.rowid
                            WHERE pages_fts MATCH ?
                              AND LOWER(COALESCE(p.source,'') || ' ' || COALESCE(p.url,'')) LIKE ?
                            LIMIT ?
                            """,
                            (fts_expr, f"%{src_low}%", fetch_lim),
                        ).fetchall()
                    else:
                        rows = cur.execute(
                            """
                            SELECT p.url, p.folder_id, p.title, p.description, p.file_count,
                                   p.filenames, p.tags, p.source, p.last_seen
                            FROM pages_fts f
                            JOIN pages p ON p.rowid = f.rowid
                            WHERE pages_fts MATCH ?
                            LIMIT ?
                            """,
                            (fts_expr, fetch_lim),
                        ).fetchall()
                except sqlite3.Error:
                    rows = []

            if not rows and (browse or tokens):
                where_parts: List[str] = []
                params: List[Any] = []
                for t in tokens:
                    where_parts.append(
                        "(LOWER(COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(filenames,'') || ' ' || COALESCE(tags,'')) LIKE ?)"
                    )
                    params.append(f"%{t}%")
                if src_low:
                    where_parts.append("(LOWER(COALESCE(source,'') || ' ' || COALESCE(url,'')) LIKE ?)")
                    params.append(f"%{src_low}%")
                where_sql = f"WHERE {' AND '.join(where_parts)}" if where_parts else ""
                order_sql = (
                    "LOWER(COALESCE(title, folder_id, '')) ASC"
                    if sort_key == "title_asc"
                    else "last_seen DESC, COALESCE(file_count, 0) DESC"
                    if sort_key == "newest"
                    else "COALESCE(file_count, 0) DESC, last_seen DESC"
                )
                params.append(fetch_lim)
                rows = cur.execute(
                    f"""
                    SELECT url, folder_id, title, description, file_count, filenames, tags, source, last_seen
                    FROM pages
                    {where_sql}
                    ORDER BY {order_sql}
                    LIMIT ?
                    """,
                    params,
                ).fetchall()

            for r in rows:
                folder_key = str(r["folder_id"] or r["url"] or "").strip()
                if not folder_key or folder_key in seen_folders:
                    continue
                seen_folders.add(folder_key)
                title = str(r["title"] or r["folder_id"] or "Filester folder").strip()
                filenames = str(r["filenames"] or "").strip()
                h = _infer_height(0, "", f"{title} {filenames}")
                if min_height > 0 and h < min_height:
                    continue
                fcount = int(r["file_count"] or 0)
                sub = f"{fcount} súborov" if fcount else "Filester priečinok"
                if filenames:
                    sub = f"{sub} · {filenames[:90]}"
                source_label = f"Filester ({r['source'] or 'index'})"
                if src_low and src_low not in f"{source_label} {sub} {r['url'] or ''}".casefold():
                    continue
                items.append({
                    "id": f"filester:{folder_key}",
                    "bucket": "filester",
                    "source_label": source_label,
                    "title": title,
                    "subtitle": sub,
                    "url": str(r["url"] or ""),
                    "source_url": str(r["url"] or ""),
                    "thumbnail": "",
                    "duration_sec": 0,
                    "height": h,
                    "quality": _quality_label(h),
                    "size_mb": None,
                    "status": "indexed",
                    "video_id": None,
                    "can_import": bool(r["url"]),
                    "playable_url": "",
                    "created_at": _iso_date(r["last_seen"]),
                })
                if len(items) >= target_total:
                    break
            if len(items) >= target_total:
                break
        except sqlite3.Error as exc:
            logger.debug("[VaultSearch] Filester DB %s skipped: %s", db_path, exc)
        finally:
            if conn is not None:
                conn.close()

    has_more = len(items) > (offset + limit)
    return items[offset : offset + limit], has_more


def _search_mega(
    db: Session,
    query: str,
    min_height: int,
    limit: int,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_playable: bool = False,
    only_importable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if only_playable or only_importable or not _table_exists(db, "mega_hub_entries"):
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False

    q = db.query(MegaHubEntry)
    for tok in tokens:
        like = f"%{tok}%"
        q = q.filter(
            (MegaHubEntry.title.ilike(like))
            | (MegaHubEntry.url.ilike(like))
            | (cast(MegaHubEntry.snapshot, String).ilike(like))
        )
    src_low = (source_filter or "").strip().casefold()
    if src_low:
        src_like = f"%{src_low}%"
        q = q.filter(
            (MegaHubEntry.title.ilike(src_like))
            | (MegaHubEntry.url.ilike(src_like))
            | (cast(MegaHubEntry.snapshot, String).ilike(src_like))
        )

    entries = q.order_by(MegaHubEntry.id.desc()).all()
    target_total = offset + limit + 1
    items: List[Dict[str, Any]] = []

    for entry in entries:
        snap = entry.snapshot if isinstance(entry.snapshot, dict) else {}
        root_title = str(entry.title or snap.get("title") or "MEGA priečinok").strip()

        # Check matching nested videos first (most actionable)
        matched_nested = 0
        for vid in (snap.get("videos") or []):
            if not isinstance(vid, dict):
                continue
            vname = str(vid.get("name") or "").strip()
            if not vname:
                continue
            if not tokens or _matches_all_tokens(tokens, root_title, vname):
                h = _infer_height(0, "", vname)
                if min_height > 0 and h < min_height:
                    continue
                dur = int(float(vid.get("duration") or 0))
                if min_duration > 0 and dur < min_duration:
                    continue
                size_bytes = float(vid.get("size") or 0)
                size_mb = round(size_bytes / 1048576.0, 1) if size_bytes > 0 else None
                if min_size_mb > 0 and float(size_mb or 0) < min_size_mb:
                    continue
                sub = f"Priečinok: {root_title}"
                if src_low and src_low not in f"mega súbor {sub} {entry.url}".casefold():
                    continue
                ref = str(vid.get("ref") or "").strip()
                items.append({
                    "id": f"mega:{entry.id}:{ref or vname[:30]}",
                    "bucket": "mega",
                    "source_label": "MEGA Súbor",
                    "title": vname,
                    "subtitle": sub,
                    "url": entry.url,
                    "source_url": entry.url,
                    "thumbnail": "",
                    "duration_sec": dur,
                    "height": h,
                    "quality": _quality_label(h),
                    "size_mb": size_mb,
                    "status": "indexed",
                    "video_id": None,
                    "can_import": False,
                    "playable_url": "",
                    "created_at": _iso_date(entry.updated_at or entry.added_at),
                })
                matched_nested += 1
                if sort_key == "relevance" and len(items) >= target_total:
                    break

        # Also check nested folders & root folder title
        if matched_nested == 0 and (
            not tokens or _matches_all_tokens(tokens, root_title, json.dumps(snap.get("folders") or [], ensure_ascii=False))
        ):
            h = _infer_height(0, "", root_title)
            if (min_height <= 0 or h >= min_height) and min_duration <= 0 and min_size_mb <= 0:
                video_cnt = len(snap.get("videos") or [])
                sub = f"{video_cnt} videí v snapshote"
                if not src_low or src_low in f"mega priečinok {sub} {entry.url}".casefold():
                    items.append({
                        "id": f"mega:{entry.id}",
                        "bucket": "mega",
                        "source_label": "MEGA Priečinok",
                        "title": root_title,
                        "subtitle": sub,
                        "url": entry.url,
                        "source_url": entry.url,
                        "thumbnail": "",
                        "duration_sec": 0,
                        "height": h,
                        "quality": _quality_label(h),
                        "size_mb": None,
                        "status": "indexed",
                        "video_id": None,
                        "can_import": False,
                        "playable_url": "",
                        "created_at": _iso_date(entry.updated_at or entry.added_at),
                    })
        if sort_key == "relevance" and len(items) >= target_total:
            break

    if sort_key == "quality_desc":
        items.sort(key=lambda it: (int(it.get("height") or 0), float(it.get("size_mb") or 0)), reverse=True)
    elif sort_key == "duration_desc":
        items.sort(key=lambda it: (int(it.get("duration_sec") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "size_desc":
        items.sort(key=lambda it: (float(it.get("size_mb") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "newest":
        items.sort(key=lambda it: str(it.get("created_at") or ""), reverse=True)
    elif sort_key == "title_asc":
        items.sort(key=lambda it: str(it.get("title") or "").casefold())

    has_more = len(items) > (offset + limit)
    return items[offset : offset + limit], has_more


def _search_queue(
    db: Session,
    query: str,
    min_height: int,
    limit: int,
    *,
    min_duration: int = 0,
    min_size_mb: float = 0.0,
    only_playable: bool = False,
    only_importable: bool = False,
    source_filter: str = "",
    sort_key: str = "relevance",
    offset: int = 0,
    browse: bool = False,
) -> Tuple[List[Dict[str, Any]], bool]:
    if only_playable:
        return [], False
    tokens = _tokenize(query)
    if not tokens and not browse:
        return [], False

    src_low = (source_filter or "").strip().casefold()
    src_like = f"%{src_low}%" if src_low else ""
    target_total = offset + limit + 1
    seen_urls: Set[str] = set()
    items: List[Dict[str, Any]] = []

    if _table_exists(db, "discovered_videos"):
        dq = db.query(DiscoveredVideo)
        for tok in tokens:
            like = f"%{tok}%"
            dq = dq.filter(
                (DiscoveredVideo.title.ilike(like))
                | (DiscoveredVideo.url.ilike(like))
                | (DiscoveredVideo.source.ilike(like))
                | (DiscoveredVideo.models.ilike(like))
                | (DiscoveredVideo.categories.ilike(like))
            )
        if min_height > 0:
            dq = dq.filter(func.coalesce(DiscoveredVideo.height, 0) >= min_height)
        if min_duration > 0:
            dq = dq.filter(func.coalesce(DiscoveredVideo.duration, 0) >= min_duration)
        if min_size_mb > 0:
            dq = dq.filter(func.coalesce(DiscoveredVideo.file_size_mb, 0) >= min_size_mb)
        if only_importable:
            dq = dq.filter(DiscoveredVideo.imported.is_(False))
        if src_like:
            dq = dq.filter(
                (DiscoveredVideo.source.ilike(src_like))
                | (DiscoveredVideo.profile_name.ilike(src_like))
                | (DiscoveredVideo.url.ilike(src_like))
                | (DiscoveredVideo.source_url.ilike(src_like))
            )
        if sort_key == "quality_desc":
            dq = dq.order_by(func.coalesce(DiscoveredVideo.height, 0).desc(), DiscoveredVideo.id.desc())
        elif sort_key == "duration_desc":
            dq = dq.order_by(func.coalesce(DiscoveredVideo.duration, 0).desc(), DiscoveredVideo.id.desc())
        elif sort_key == "size_desc":
            dq = dq.order_by(func.coalesce(DiscoveredVideo.file_size_mb, 0).desc(), DiscoveredVideo.id.desc())
        elif sort_key == "newest":
            dq = dq.order_by(DiscoveredVideo.discovered_at.desc(), DiscoveredVideo.id.desc())
        elif sort_key == "title_asc":
            dq = dq.order_by(func.lower(func.coalesce(DiscoveredVideo.title, DiscoveredVideo.url)).asc())
        else:
            dq = dq.order_by(DiscoveredVideo.id.desc())

        for d in dq.limit(target_total).all():
            key = (d.source_url or d.url or "").strip()
            if not key or key in seen_urls:
                continue
            seen_urls.add(key)
            h = _infer_height(d.height, "", d.title or "")
            items.append({
                "id": f"discovered:{d.id}",
                "bucket": "queue",
                "source_label": f"Discovery · {d.source or 'web'}",
                "title": (d.title or key).strip(),
                "subtitle": d.profile_name or "",
                "url": d.url or key,
                "source_url": key,
                "thumbnail": str(d.thumbnail or ""),
                "duration_sec": int(float(d.duration or 0)),
                "height": h,
                "quality": _quality_label(h),
                "size_mb": round(float(d.file_size_mb), 1) if d.file_size_mb else None,
                "status": "library" if d.imported else "discovered",
                "video_id": int(d.video_id) if d.video_id else None,
                "can_import": not bool(d.imported),
                "playable_url": "",
                "created_at": _iso_date(d.discovered_at),
            })

    if _table_exists(db, "import_job_items"):
        iq = db.query(ImportJobItem)
        for tok in tokens:
            like = f"%{tok}%"
            iq = iq.filter(
                (ImportJobItem.title.ilike(like))
                | (ImportJobItem.source_url.ilike(like))
                | (ImportJobItem.url.ilike(like))
                | (ImportJobItem.tags.ilike(like))
                | (ImportJobItem.actors.ilike(like))
            )
        if min_height > 0:
            iq = iq.filter(func.coalesce(ImportJobItem.height, 0) >= min_height)
        if min_duration > 0:
            iq = iq.filter(func.coalesce(ImportJobItem.duration, 0) >= min_duration)
        if min_size_mb > 0:
            iq = iq.filter(func.coalesce(ImportJobItem.file_size_mb, 0) >= min_size_mb)
        if only_importable:
            iq = iq.filter(
                ImportJobItem.video_id.is_(None),
                or_(ImportJobItem.status.is_(None), ~ImportJobItem.status.in_(["imported", "running", "pending"])),
            )
        if src_like:
            iq = iq.filter(
                (ImportJobItem.status.ilike(src_like))
                | (ImportJobItem.actors.ilike(src_like))
                | (ImportJobItem.tags.ilike(src_like))
                | (ImportJobItem.url.ilike(src_like))
                | (ImportJobItem.source_url.ilike(src_like))
            )
        if sort_key == "quality_desc":
            iq = iq.order_by(func.coalesce(ImportJobItem.height, 0).desc(), ImportJobItem.id.desc())
        elif sort_key == "duration_desc":
            iq = iq.order_by(func.coalesce(ImportJobItem.duration, 0).desc(), ImportJobItem.id.desc())
        elif sort_key == "size_desc":
            iq = iq.order_by(func.coalesce(ImportJobItem.file_size_mb, 0).desc(), ImportJobItem.id.desc())
        elif sort_key == "newest":
            iq = iq.order_by(ImportJobItem.created_at.desc(), ImportJobItem.id.desc())
        elif sort_key == "title_asc":
            iq = iq.order_by(func.lower(func.coalesce(ImportJobItem.title, ImportJobItem.url)).asc())
        else:
            iq = iq.order_by(ImportJobItem.id.desc())

        for it in iq.limit(target_total * 2).all():
            key = (it.source_url or it.url or "").strip()
            if not key or key in seen_urls:
                continue
            seen_urls.add(key)
            h = _infer_height(it.height, it.quality or "", it.title or "")
            if min_height > 0 and h < min_height:
                continue
            items.append({
                "id": f"import:{it.id}",
                "bucket": "queue",
                "source_label": f"Import Fronta ({it.status or 'unknown'})",
                "title": (it.title or key).strip(),
                "subtitle": " · ".join(p for p in (it.actors, it.tags) if p)[:100],
                "url": it.url or key,
                "source_url": key,
                "thumbnail": str(it.thumbnail or ""),
                "duration_sec": int(float(it.duration or 0)),
                "height": h,
                "quality": _quality_label(h, it.quality or ""),
                "size_mb": round(float(it.file_size_mb), 1) if it.file_size_mb else None,
                "status": it.status or "pending",
                "video_id": int(it.video_id) if it.video_id else None,
                "can_import": not bool(it.video_id) and (it.status or "") not in {"imported", "running", "pending"},
                "playable_url": "",
                "created_at": _iso_date(it.created_at),
            })

    if sort_key == "quality_desc":
        items.sort(key=lambda it: (int(it.get("height") or 0), float(it.get("size_mb") or 0)), reverse=True)
    elif sort_key == "duration_desc":
        items.sort(key=lambda it: (int(it.get("duration_sec") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "size_desc":
        items.sort(key=lambda it: (float(it.get("size_mb") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "newest":
        items.sort(key=lambda it: str(it.get("created_at") or ""), reverse=True)
    elif sort_key == "title_asc":
        items.sort(key=lambda it: str(it.get("title") or "").casefold())

    has_more = len(items) > (offset + limit)
    return items[offset : offset + limit], has_more


def get_vault_stats(
    db: Session,
    filester_db_paths: Optional[Sequence[Path]] = None,
) -> Dict[str, Any]:
    """Return record counts across every local vault bucket."""
    counts: Dict[str, int] = {b: 0 for b in VAULT_BUCKETS}

    if _table_exists(db, "videos"):
        counts["library"] = int(db.query(func.count(Video.id)).scalar() or 0)
    if _table_exists(db, "telegram_media_index"):
        counts["telegram"] = int(db.query(func.count(TelegramMediaIndex.id)).scalar() or 0)
    if _table_exists(db, "forum_links"):
        counts["forum"] = int(db.query(func.count(ForumLink.id)).scalar() or 0)
    if _table_exists(db, "mega_hub_entries"):
        mega_rows = db.query(MegaHubEntry.snapshot).all()
        mega_total = len(mega_rows)
        for (snap,) in mega_rows:
            if isinstance(snap, dict):
                mega_total += len(snap.get("videos") or [])
        counts["mega"] = mega_total

    queue_total = 0
    if _table_exists(db, "import_job_items"):
        queue_total += int(db.query(func.count(ImportJobItem.id)).scalar() or 0)
    if _table_exists(db, "discovered_videos"):
        queue_total += int(db.query(func.count(DiscoveredVideo.id)).scalar() or 0)
    counts["queue"] = queue_total

    paths = list(filester_db_paths) if filester_db_paths is not None else default_filester_db_paths()
    seen_folders: Set[str] = set()
    for p in paths:
        if not p.is_file():
            continue
        conn = None
        try:
            conn = sqlite3.connect(f"file:{p}?mode=ro", uri=True, timeout=1.5)
            for (fid,) in conn.execute("SELECT COALESCE(folder_id, url) FROM pages").fetchall():
                if fid:
                    seen_folders.add(str(fid))
        except sqlite3.Error:
            pass
        finally:
            if conn is not None:
                conn.close()
    counts["filester"] = len(seen_folders)

    return {
        "total_records": sum(counts.values()),
        "buckets": [
            {
                "id": b,
                "label": BUCKET_META[b]["label"],
                "icon": BUCKET_META[b]["icon"],
                "count": counts[b],
            }
            for b in VAULT_BUCKETS
        ],
    }


def _dedupe_identity(item: Dict[str, Any]) -> str:
    """Build canonical identity key for cross-bucket deduplication."""
    meta = item.get("telegram_meta")
    if isinstance(meta, dict) and meta.get("chat_id") and meta.get("message_id"):
        return f"tg:{meta['chat_id']}:{meta['message_id']}"

    raw = str(item.get("source_url") or item.get("url") or "").strip()
    if raw.startswith(("http://", "https://")):
        try:
            parsed = urllib.parse.urlsplit(raw)
            host = parsed.netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            path = parsed.path.rstrip("/")
            if host in ("t.me", "telegram.me") and path:
                return f"tme:{path.lower()}"
            query = f"?{parsed.query}" if parsed.query else ""
            return f"url:{host}{path}{query}"
        except ValueError:
            pass
    return ""


def search_local_vault(
    db: Session,
    query: str,
    *,
    buckets: Optional[Iterable[str]] = None,
    min_height: int = 0,
    min_duration: int = 0,
    min_size_mb: float = 0,
    only_playable: bool = False,
    only_importable: bool = False,
    source_filter: str = "",
    sort: str = "relevance",
    limit_per_bucket: int = 25,
    offset: int = 0,
    browse: bool = False,
    deduplicate: bool = True,
    filester_db_paths: Optional[Sequence[Path]] = None,
) -> Dict[str, Any]:
    """Run unified local search across selected Nexus vault buckets."""
    t0 = time.perf_counter()
    cleaned = (query or "").strip()
    selected = [b for b in (buckets or VAULT_BUCKETS) if b in VAULT_BUCKETS]
    if not selected:
        selected = list(VAULT_BUCKETS)

    capped_limit = max(1, min(int(limit_per_bucket or 100), 500))
    safe_offset = max(0, int(offset or 0))
    min_h = max(0, int(min_height or 0))
    min_dur = max(0, int(min_duration or 0))
    min_sz = max(0.0, float(min_size_mb or 0))
    src_sub = (source_filter or "").strip().casefold()
    sort_key = (sort or "relevance").strip().lower()

    if not cleaned and not browse:
        return {
            "query": "",
            "browse": False,
            "offset": safe_offset,
            "limit": capped_limit,
            "has_more": False,
            "bucket_has_more": {b: False for b in selected},
            "elapsed_ms": 0,
            "total": 0,
            "bucket_counts": {b: 0 for b in selected},
            "errors": {},
            "items": [],
        }

    common_kw: Dict[str, Any] = {
        "min_duration": min_dur,
        "min_size_mb": min_sz,
        "only_importable": only_importable,
        "source_filter": src_sub,
        "sort_key": sort_key,
        "offset": safe_offset,
        "browse": browse,
    }

    runners: Dict[str, Callable[[], Tuple[List[Dict[str, Any]], bool]]] = {
        "library": lambda: _search_library(db, cleaned, min_h, capped_limit, **common_kw),
        "telegram": lambda: _search_telegram(db, cleaned, min_h, capped_limit, **common_kw),
        "forum": lambda: _search_forums(db, cleaned, min_h, capped_limit, only_playable=only_playable, **common_kw),
        "filester": lambda: _search_filester(
            cleaned,
            min_h,
            capped_limit,
            db_paths=filester_db_paths,
            min_duration=min_dur,
            min_size_mb=min_sz,
            only_playable=only_playable,
            source_filter=src_sub,
            sort_key=sort_key,
            offset=safe_offset,
            browse=browse,
        ),
        "mega": lambda: _search_mega(db, cleaned, min_h, capped_limit, only_playable=only_playable, **common_kw),
        "queue": lambda: _search_queue(db, cleaned, min_h, capped_limit, only_playable=only_playable, **common_kw),
    }

    all_items: List[Dict[str, Any]] = []
    bucket_counts: Dict[str, int] = {}
    bucket_has_more: Dict[str, bool] = {}
    errors: Dict[str, str] = {}
    seen_identities: Set[str] = set()

    for bucket in selected:
        try:
            hits, more = runners[bucket]()
            filtered: List[Dict[str, Any]] = []
            for item in hits:
                if min_dur > 0 and int(item.get("duration_sec") or 0) < min_dur:
                    continue
                if min_sz > 0 and float(item.get("size_mb") or 0) < min_sz:
                    continue
                if only_playable and not item.get("playable_url"):
                    continue
                if only_importable and not item.get("can_import"):
                    continue
                if src_sub:
                    hay = f"{item.get('source_label', '')} {item.get('subtitle', '')} {item.get('url', '')}".casefold()
                    if src_sub not in hay:
                        continue
                if deduplicate:
                    ident = _dedupe_identity(item)
                    if ident:
                        if ident in seen_identities:
                            continue
                        seen_identities.add(ident)
                filtered.append(item)
            bucket_counts[bucket] = len(filtered)
            bucket_has_more[bucket] = bool(more)
            all_items.extend(filtered)
        except Exception as exc:  # noqa: BLE001 — isolate bucket failures
            logger.warning("[VaultSearch] bucket '%s' failed: %s", bucket, exc)
            bucket_counts[bucket] = 0
            bucket_has_more[bucket] = False
            errors[bucket] = str(exc)[:200]

    tokens = _tokenize(cleaned)
    bucket_priority = {b: idx for idx, b in enumerate(VAULT_BUCKETS)}

    def _rel_key(item: Dict[str, Any]) -> Tuple[int, int, int, int]:
        title_low = (item.get("title") or "").casefold()
        exact = int(bool(cleaned) and cleaned.casefold() in title_low)
        token_hits = sum(1 for t in tokens if t in title_low)
        height = int(item.get("height") or 0)
        prio = -bucket_priority.get(item.get("bucket", ""), 99)
        return (exact, token_hits, height, prio)

    if sort_key == "quality_desc":
        all_items.sort(key=lambda it: (int(it.get("height") or 0), float(it.get("size_mb") or 0), _rel_key(it)), reverse=True)
    elif sort_key == "duration_desc":
        all_items.sort(key=lambda it: (int(it.get("duration_sec") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "size_desc":
        all_items.sort(key=lambda it: (float(it.get("size_mb") or 0), int(it.get("height") or 0)), reverse=True)
    elif sort_key == "newest":
        all_items.sort(key=lambda it: (str(it.get("created_at") or ""), _rel_key(it)), reverse=True)
    elif sort_key == "title_asc":
        all_items.sort(key=lambda it: (str(it.get("title") or "").casefold(), -int(it.get("height") or 0)))
    elif browse and not tokens:
        all_items.sort(key=lambda it: (str(it.get("created_at") or ""), int(it.get("height") or 0)), reverse=True)
    else:
        all_items.sort(key=_rel_key, reverse=True)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    return {
        "query": cleaned,
        "browse": bool(browse and not cleaned),
        "offset": safe_offset,
        "limit": capped_limit,
        "has_more": any(bucket_has_more.values()),
        "bucket_has_more": bucket_has_more,
        "elapsed_ms": elapsed_ms,
        "total": len(all_items),
        "bucket_counts": bucket_counts,
        "errors": errors,
        "items": all_items,
    }
