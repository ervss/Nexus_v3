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

from sqlalchemy import func, text
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


def _search_library(db: Session, query: str, min_height: int, limit: int) -> List[Dict[str, Any]]:
    tokens = _tokenize(query)
    if not tokens:
        return []

    rows: List[Any] = []
    if _table_exists(db, "videos_fts"):
        fts_expr = _build_fts_prefix_expr(query)
        if fts_expr:
            sql = text(
                """
                SELECT v.id, v.title, v.url, v.source_url, v.thumbnail_path, v.original_thumbnail_url,
                       v.duration, v.height, v.quality, v.file_size_mb, v.tags, v.ai_tags,
                       v.models, v.batch_name, v.storage_type, v.status, v.created_at
                FROM videos_fts f
                JOIN videos v ON v.id = f.rowid
                WHERE videos_fts MATCH :match_expr
                  AND (:min_h <= 0 OR COALESCE(v.height, 0) >= :min_h)
                ORDER BY bm25(videos_fts), COALESCE(v.height, 0) DESC, v.id DESC
                LIMIT :lim
                """
            )
            rows = db.execute(sql, {"match_expr": fts_expr, "min_h": min_height, "lim": limit}).mappings().all()

    if not rows:
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
            q = q.filter(Video.height >= min_height)
        orm_rows = q.order_by(Video.height.desc(), Video.id.desc()).limit(limit).all()
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
    return items


def _search_telegram(db: Session, query: str, min_height: int, limit: int) -> List[Dict[str, Any]]:
    if not _table_exists(db, "telegram_media_index"):
        return []
    hits = search_telegram_fts(
        db,
        query=query,
        limit=limit,
        min_quality=min_height,
        sort="relevance",
        deduplicate=True,
    )
    items: List[Dict[str, Any]] = []
    for row in hits:
        chat_id = row.get("chat_id")
        message_id = row.get("message_id")
        title = str(row.get("title") or row.get("file_name") or row.get("caption") or "Telegram video").strip()
        h = _infer_height(row.get("effective_res") or row.get("height"), row.get("quality"), title)
        if min_height > 0 and h < min_height:
            continue
        stream_url = row.get("stream_url") or (f"/api/v1/telegram/stream/{chat_id}/{message_id}" if chat_id and message_id else "")
        size_bytes = float(row.get("size_bytes") or 0)
        channel = str(row.get("channel") or row.get("author") or "").strip()
        items.append({
            "id": f"telegram:{chat_id}:{message_id}",
            "bucket": "telegram",
            "source_label": f"Telegram · {channel}" if channel else "Telegram",
            "title": title,
            "subtitle": str(row.get("file_name") or row.get("caption") or "")[:120],
            "url": row.get("url") or stream_url,
            "source_url": row.get("url") or "",
            "thumbnail": str(row.get("thumbnail") or ""),
            "duration_sec": int(float(row.get("duration_sec") or 0)),
            "height": h,
            "quality": _quality_label(h, row.get("quality") or ""),
            "size_mb": round(size_bytes / 1048576.0, 1) if size_bytes > 0 else None,
            "status": "indexed",
            "video_id": None,
            "can_import": bool(chat_id and message_id),
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
    return items


def _search_forums(db: Session, query: str, min_height: int, limit: int) -> List[Dict[str, Any]]:
    if not _table_exists(db, "forum_links"):
        return []
    tokens = _tokenize(query)
    if not tokens:
        return []

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

    rows = q.order_by(ForumLink.id.desc()).limit(limit * 2).all()
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
        if len(items) >= limit:
            break
    return items


def _search_filester(
    query: str,
    min_height: int,
    limit: int,
    db_paths: Optional[Sequence[Path]] = None,
) -> List[Dict[str, Any]]:
    tokens = _tokenize(query)
    if not tokens:
        return []
    paths = list(db_paths) if db_paths is not None else default_filester_db_paths()
    if not paths:
        return []

    fts_expr = _build_fts_prefix_expr(query)
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
            if has_fts and fts_expr:
                try:
                    rows = cur.execute(
                        """
                        SELECT p.url, p.folder_id, p.title, p.description, p.file_count,
                               p.filenames, p.tags, p.source, p.last_seen
                        FROM pages_fts f
                        JOIN pages p ON p.rowid = f.rowid
                        WHERE pages_fts MATCH ?
                        LIMIT ?
                        """,
                        (fts_expr, limit * 2),
                    ).fetchall()
                except sqlite3.Error:
                    rows = []

            if not rows:
                where_parts = ["(LOWER(COALESCE(title,'') || ' ' || COALESCE(description,'') || ' ' || COALESCE(filenames,'') || ' ' || COALESCE(tags,'')) LIKE ?)"] * len(tokens)
                params: List[Any] = [f"%{t}%" for t in tokens] + [limit * 2]
                rows = cur.execute(
                    f"""
                    SELECT url, folder_id, title, description, file_count, filenames, tags, source, last_seen
                    FROM pages
                    WHERE {' AND '.join(where_parts)}
                    ORDER BY COALESCE(file_count, 0) DESC, last_seen DESC
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
                items.append({
                    "id": f"filester:{folder_key}",
                    "bucket": "filester",
                    "source_label": f"Filester ({r['source'] or 'index'})",
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
                if len(items) >= limit:
                    return items
        except sqlite3.Error as exc:
            logger.debug("[VaultSearch] Filester DB %s skipped: %s", db_path, exc)
        finally:
            if conn is not None:
                conn.close()
    return items


def _search_mega(db: Session, query: str, min_height: int, limit: int) -> List[Dict[str, Any]]:
    if not _table_exists(db, "mega_hub_entries"):
        return []
    tokens = _tokenize(query)
    if not tokens:
        return []

    entries = db.query(MegaHubEntry).order_by(MegaHubEntry.id.desc()).all()
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
            if _matches_all_tokens(tokens, root_title, vname):
                h = _infer_height(0, "", vname)
                if min_height > 0 and h < min_height:
                    continue
                ref = str(vid.get("ref") or "").strip()
                size_bytes = float(vid.get("size") or 0)
                items.append({
                    "id": f"mega:{entry.id}:{ref or vname[:30]}",
                    "bucket": "mega",
                    "source_label": "MEGA Súbor",
                    "title": vname,
                    "subtitle": f"Priečinok: {root_title}",
                    "url": entry.url,
                    "source_url": entry.url,
                    "thumbnail": "",
                    "duration_sec": int(float(vid.get("duration") or 0)),
                    "height": h,
                    "quality": _quality_label(h),
                    "size_mb": round(size_bytes / 1048576.0, 1) if size_bytes > 0 else None,
                    "status": "indexed",
                    "video_id": None,
                    "can_import": False,
                    "playable_url": "",
                    "created_at": _iso_date(entry.updated_at or entry.added_at),
                })
                matched_nested += 1
                if len(items) >= limit:
                    return items

        # Also check nested folders & root folder title
        if matched_nested == 0 and _matches_all_tokens(tokens, root_title, json.dumps(snap.get("folders") or [], ensure_ascii=False)):
            h = _infer_height(0, "", root_title)
            if min_height <= 0 or h >= min_height:
                video_cnt = len(snap.get("videos") or [])
                items.append({
                    "id": f"mega:{entry.id}",
                    "bucket": "mega",
                    "source_label": "MEGA Priečinok",
                    "title": root_title,
                    "subtitle": f"{video_cnt} videí v snapshote",
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
                if len(items) >= limit:
                    return items

    return items


def _search_queue(db: Session, query: str, min_height: int, limit: int) -> List[Dict[str, Any]]:
    tokens = _tokenize(query)
    if not tokens:
        return []

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
            dq = dq.filter(DiscoveredVideo.height >= min_height)
        for d in dq.order_by(DiscoveredVideo.id.desc()).limit(limit).all():
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

    if _table_exists(db, "import_job_items") and len(items) < limit:
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
            iq = iq.filter(ImportJobItem.height >= min_height)
        for it in iq.order_by(ImportJobItem.id.desc()).limit(limit * 2).all():
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
            if len(items) >= limit:
                break

    return items[:limit]


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
    filester_db_paths: Optional[Sequence[Path]] = None,
) -> Dict[str, Any]:
    """Run unified local search across selected Nexus vault buckets."""
    t0 = time.perf_counter()
    cleaned = (query or "").strip()
    selected = [b for b in (buckets or VAULT_BUCKETS) if b in VAULT_BUCKETS]
    if not selected:
        selected = list(VAULT_BUCKETS)

    capped_limit = max(1, min(int(limit_per_bucket or 100), 500))
    min_h = max(0, int(min_height or 0))
    min_dur = max(0, int(min_duration or 0))
    min_sz = max(0.0, float(min_size_mb or 0))
    src_sub = (source_filter or "").strip().casefold()
    sort_key = (sort or "relevance").strip().lower()

    if not cleaned:
        return {
            "query": "",
            "elapsed_ms": 0,
            "total": 0,
            "bucket_counts": {b: 0 for b in selected},
            "errors": {},
            "items": [],
        }

    runners: Dict[str, Callable[[], List[Dict[str, Any]]]] = {
        "library": lambda: _search_library(db, cleaned, min_h, capped_limit),
        "telegram": lambda: _search_telegram(db, cleaned, min_h, capped_limit),
        "forum": lambda: _search_forums(db, cleaned, min_h, capped_limit),
        "filester": lambda: _search_filester(cleaned, min_h, capped_limit, db_paths=filester_db_paths),
        "mega": lambda: _search_mega(db, cleaned, min_h, capped_limit),
        "queue": lambda: _search_queue(db, cleaned, min_h, capped_limit),
    }

    all_items: List[Dict[str, Any]] = []
    bucket_counts: Dict[str, int] = {}
    errors: Dict[str, str] = {}

    for bucket in selected:
        try:
            hits = runners[bucket]()
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
                filtered.append(item)
            bucket_counts[bucket] = len(filtered)
            all_items.extend(filtered)
        except Exception as exc:  # noqa: BLE001 — isolate bucket failures
            logger.warning("[VaultSearch] bucket '%s' failed: %s", bucket, exc)
            bucket_counts[bucket] = 0
            errors[bucket] = str(exc)[:200]

    tokens = _tokenize(cleaned)
    bucket_priority = {b: idx for idx, b in enumerate(VAULT_BUCKETS)}

    def _rel_key(item: Dict[str, Any]) -> Tuple[int, int, int, int]:
        title_low = (item.get("title") or "").casefold()
        exact = int(cleaned.casefold() in title_low)
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
    else:
        all_items.sort(key=_rel_key, reverse=True)

    elapsed_ms = int((time.perf_counter() - t0) * 1000)

    return {
        "query": cleaned,
        "elapsed_ms": elapsed_ms,
        "total": len(all_items),
        "bucket_counts": bucket_counts,
        "errors": errors,
        "items": all_items,
    }
