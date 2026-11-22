"""Creator Radar & Vault Companion service.

Builds creator/performer dossiers across the local Nexus library (`videos`) and
multi-store Local Vault (`search_local_vault`), manages `followed_creators`, and
powers the batch `/api/v1/companion/probe` endpoint for the Chrome extension and
Tampermonkey userscript.
"""
from __future__ import annotations

import datetime as dt
import re
import urllib.parse
from collections import defaultdict
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from .creator_thumbs import get_cached_thumb_url
from .database import Video
from .vault_search import search_local_vault

_SPLIT_CREATORS_RE = re.compile(r"[,;|/]+")
_WHITESPACE_RE = re.compile(r"\s+")
_NOISE_CREATORS = {
    "",
    "unknown",
    "n/a",
    "na",
    "none",
    "null",
    "untitled",
    "pornhub",
    "eporner",
    "bunkr",
    "filester",
    "simpcity",
    "telegram",
    "coomer",
    "kemono",
    "redgifs",
    "xhamster",
    "xvideos",
}


def _utcnow_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def normalize_creator_name(name: str) -> str:
    return _WHITESPACE_RE.sub(" ", str(name or "").strip())


def normalize_creator_slug(name: str) -> str:
    cleaned = normalize_creator_name(name).casefold()
    cleaned = re.sub(r"[^0-9a-z\u00C0-\u024F\s_-]+", "", cleaned)
    return _WHITESPACE_RE.sub(" ", cleaned).strip()


def normalize_media_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    try:
        parsed = urllib.parse.urlsplit(value)
        if not parsed.scheme or not parsed.netloc:
            return value.rstrip("/").casefold()
        path = parsed.path.rstrip("/")
        normalized = urllib.parse.urlunsplit(
            (parsed.scheme.lower(), parsed.netloc.lower(), path, parsed.query, "")
        )
        return normalized
    except Exception:
        return value.rstrip("/").casefold()


def parse_creator_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    out: List[str] = []
    seen = set()
    for part in _SPLIT_CREATORS_RE.split(str(raw)):
        cleaned = normalize_creator_name(part)
        slug = normalize_creator_slug(cleaned)
        if not cleaned or len(slug) < 2 or slug in _NOISE_CREATORS:
            continue
        if slug not in seen:
            seen.add(slug)
            out.append(cleaned)
    return out


def quality_from_height(height: int, fallback: str = "") -> str:
    h = int(height or 0)
    if h >= 2160:
        return "4K"
    if h >= 1440:
        return "1440p"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    if h > 0:
        return f"{h}p"
    return (fallback or "").strip() or "SD"


def ensure_creator_radar_schema(db: Session) -> None:
    """Create `followed_creators` table cleanly if it does not yet exist."""
    db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS followed_creators (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                slug TEXT NOT NULL UNIQUE,
                notes TEXT DEFAULT '',
                source_hint TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                last_opened_at TEXT
            )
            """
        )
    )
    db.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_followed_creators_slug ON followed_creators (slug)"
        )
    )
    db.commit()


def _serialize_library_video(v: Video) -> Dict[str, Any]:
    height = int(getattr(v, "height", 0) or 0)
    raw_url = str(v.url or "").strip()
    source_url = str(v.source_url or raw_url).strip()
    is_hls = ".m3u8" in raw_url.lower()
    if raw_url.startswith("/api/") or raw_url.startswith("/hls_proxy"):
        playable_url = raw_url
    elif is_hls and raw_url.startswith(("http://", "https://")):
        playable_url = (
            f"/hls_proxy?url={urllib.parse.quote(raw_url, safe='')}"
            f"&referer={urllib.parse.quote(source_url, safe='')}"
        )
    else:
        playable_url = f"/stream_proxy/{int(v.id)}.mp4"
    created_raw = getattr(v, "created_at", None)
    created_iso = created_raw.isoformat() if hasattr(created_raw, "isoformat") else str(created_raw or "")
    return {
        "id": v.id,
        "video_id": v.id,
        "title": v.title or f"Video #{v.id}",
        "url": raw_url,
        "source_url": source_url,
        "playable_url": playable_url,
        "is_hls": is_hls,
        "thumbnail": v.thumbnail_path or v.original_thumbnail_url or "",
        "duration_sec": int(round(float(getattr(v, "duration", 0) or 0))),
        "height": height,
        "quality": quality_from_height(height, getattr(v, "quality", "") or ""),
        "size_mb": round(float(getattr(v, "file_size_mb", 0) or 0), 1),
        "storage_type": getattr(v, "storage_type", "remote") or "remote",
        "batch_name": getattr(v, "batch_name", "") or "",
        "models": getattr(v, "models", "") or "",
        "is_favorite": bool(getattr(v, "is_favorite", False)),
        "created_at": created_iso,
    }


def _match_video_tokens(video: Video, slug: str, tokens: Sequence[str]) -> bool:
    if not tokens:
        return False
    for creator in parse_creator_list(getattr(video, "models", "")):
        if normalize_creator_slug(creator) == slug:
            return True
    haystack = " ".join(
        [
            str(getattr(video, "models", "") or ""),
            str(getattr(video, "title", "") or ""),
            str(getattr(video, "tags", "") or ""),
        ]
    ).casefold()
    return all(tok in haystack for tok in tokens)


def _fetch_followed_rows(db: Session) -> Dict[str, Dict[str, Any]]:
    ensure_creator_radar_schema(db)
    rows = db.execute(
        text(
            "SELECT id, name, slug, notes, source_hint, created_at, last_opened_at "
            "FROM followed_creators ORDER BY id DESC"
        )
    ).mappings()
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        out[str(row["slug"])] = {
            "id": int(row["id"]),
            "name": row["name"],
            "slug": row["slug"],
            "notes": row["notes"] or "",
            "source_hint": row["source_hint"] or "",
            "created_at": row["created_at"],
            "last_opened_at": row["last_opened_at"],
        }
    return out


def discover_library_creators(db: Session) -> Dict[str, Dict[str, Any]]:
    """Aggregate creator metrics directly from indexed library videos."""
    agg: Dict[str, Dict[str, Any]] = {}
    rows = (
        db.query(
            Video.id,
            Video.models,
            Video.height,
            Video.quality,
            Video.storage_type,
            Video.file_size_mb,
            Video.thumbnail_path,
            Video.original_thumbnail_url,
            Video.created_at,
        )
        .filter(Video.models.isnot(None), Video.models != "")
        .all()
    )

    name_votes: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))

    for row in rows:
        creators = parse_creator_list(row.models)
        if not creators:
            continue
        height = int(row.height or 0)
        is_local = (row.storage_type or "remote") == "local"
        size_mb = float(row.file_size_mb or 0)
        thumb = row.thumbnail_path or row.original_thumbnail_url or ""

        for raw_name in creators:
            slug = normalize_creator_slug(raw_name)
            name_votes[slug][raw_name] += 1
            entry = agg.get(slug)
            if entry is None:
                entry = {
                    "name": raw_name,
                    "slug": slug,
                    "video_count": 0,
                    "local_count": 0,
                    "best_height": 0,
                    "best_quality": "SD",
                    "total_size_mb": 0.0,
                    "sample_thumb": "",
                    "latest_video_id": int(row.id),
                }
                agg[slug] = entry
            entry["video_count"] += 1
            if is_local:
                entry["local_count"] += 1
            entry["total_size_mb"] += size_mb
            if height > entry["best_height"]:
                entry["best_height"] = height
                entry["best_quality"] = quality_from_height(height, row.quality or "")
                if thumb:
                    entry["sample_thumb"] = thumb
            elif not entry["sample_thumb"] and thumb:
                entry["sample_thumb"] = thumb
            if int(row.id) > entry["latest_video_id"]:
                entry["latest_video_id"] = int(row.id)

    for slug, votes in name_votes.items():
        if slug in agg and votes:
            agg[slug]["name"] = max(votes.items(), key=lambda kv: kv[1])[0]
            agg[slug]["total_size_mb"] = round(agg[slug]["total_size_mb"], 1)

    return agg


def _quick_title_stats_for_creator(db: Session, name: str) -> Dict[str, Any]:
    tokens = [tok for tok in normalize_creator_slug(name).split() if len(tok) >= 2]
    if not tokens:
        return {"video_count": 0, "local_count": 0, "best_height": 0, "best_quality": "SD", "sample_thumb": ""}
    first_tok = tokens[0]
    pattern = f"%{first_tok}%"
    candidates = (
        db.query(Video)
        .filter(
            or_(
                Video.models.ilike(pattern),
                Video.title.ilike(pattern),
                Video.tags.ilike(pattern),
            )
        )
        .order_by(Video.height.desc(), Video.id.desc())
        .limit(160)
        .all()
    )
    slug = normalize_creator_slug(name)
    matched = [v for v in candidates if _match_video_tokens(v, slug, tokens)]
    best_height = max((int(v.height or 0) for v in matched), default=0)
    sample_thumb = next((v.thumbnail_path or v.original_thumbnail_url or "" for v in matched if (v.thumbnail_path or v.original_thumbnail_url)), "")
    return {
        "video_count": len(matched),
        "local_count": sum(1 for v in matched if (v.storage_type or "") == "local"),
        "best_height": best_height,
        "best_quality": quality_from_height(best_height) if matched else "SD",
        "sample_thumb": sample_thumb,
    }


def list_radar_creators(
    db: Session,
    q: str = "",
    limit: int = 60,
    only_followed: bool = False,
) -> Dict[str, Any]:
    followed = _fetch_followed_rows(db)
    discovered = discover_library_creators(db)

    combined: Dict[str, Dict[str, Any]] = {}

    for slug, stats in discovered.items():
        pin = followed.get(slug)
        combined[slug] = {
            "id": pin["id"] if pin else None,
            "name": pin["name"] if pin else stats["name"],
            "slug": slug,
            "followed": bool(pin),
            "notes": pin["notes"] if pin else "",
            "source_hint": pin["source_hint"] if pin else "",
            "created_at": pin["created_at"] if pin else None,
            "video_count": stats["video_count"],
            "local_count": stats["local_count"],
            "best_height": stats["best_height"],
            "best_quality": stats["best_quality"],
            "total_size_mb": stats["total_size_mb"],
            "sample_thumb": stats["sample_thumb"],
        }

    for slug, pin in followed.items():
        if slug not in combined:
            quick = _quick_title_stats_for_creator(db, pin["name"])
            combined[slug] = {
                "id": pin["id"],
                "name": pin["name"],
                "slug": slug,
                "followed": True,
                "notes": pin["notes"],
                "source_hint": pin["source_hint"],
                "created_at": pin["created_at"],
                "video_count": quick["video_count"],
                "local_count": quick["local_count"],
                "best_height": quick["best_height"],
                "best_quality": quick["best_quality"],
                "total_size_mb": 0.0,
                "sample_thumb": quick["sample_thumb"],
            }

    items = list(combined.values())
    if only_followed:
        items = [it for it in items if it["followed"]]

    q_norm = normalize_creator_slug(q)
    if q_norm:
        items = [it for it in items if q_norm in it["slug"] or q_norm in normalize_creator_name(it["name"]).casefold()]

    items.sort(
        key=lambda it: (
            1 if it["followed"] else 0,
            int(it["video_count"]),
            int(it["local_count"]),
            int(it["best_height"]),
        ),
        reverse=True,
    )

    total = len(items)
    sliced = items[: max(1, min(int(limit or 60), 200))]
    return {
        "creators": sliced,
        "total": total,
        "followed_count": sum(1 for it in combined.values() if it["followed"]),
        "discovered_count": len(discovered),
    }


def follow_creator(
    db: Session,
    name: str,
    notes: str = "",
    source_hint: str = "",
) -> Dict[str, Any]:
    ensure_creator_radar_schema(db)
    clean_name = normalize_creator_name(name)
    slug = normalize_creator_slug(clean_name)
    if not clean_name or len(slug) < 2:
        raise ValueError("Zadaj platné meno tvorcu (min. 2 znaky).")

    now = _utcnow_iso()
    existing = db.execute(
        text("SELECT id, name, slug, notes, source_hint, created_at FROM followed_creators WHERE slug = :slug"),
        {"slug": slug},
    ).mappings().first()

    if existing:
        updated_notes = notes if notes else (existing["notes"] or "")
        updated_hint = source_hint if source_hint else (existing["source_hint"] or "")
        db.execute(
            text(
                "UPDATE followed_creators SET name = :name, notes = :notes, source_hint = :hint WHERE id = :id"
            ),
            {"id": existing["id"], "name": clean_name, "notes": updated_notes, "hint": updated_hint},
        )
        db.commit()
        return {
            "id": int(existing["id"]),
            "name": clean_name,
            "slug": slug,
            "notes": updated_notes,
            "source_hint": updated_hint,
            "followed": True,
            "created": False,
        }

    db.execute(
        text(
            "INSERT INTO followed_creators (name, slug, notes, source_hint, created_at) "
            "VALUES (:name, :slug, :notes, :hint, :created_at)"
        ),
        {
            "name": clean_name,
            "slug": slug,
            "notes": (notes or "").strip()[:500],
            "hint": (source_hint or "").strip()[:200],
            "created_at": now,
        },
    )
    db.commit()
    row = db.execute(
        text("SELECT id FROM followed_creators WHERE slug = :slug"),
        {"slug": slug},
    ).mappings().first()
    return {
        "id": int(row["id"]) if row else 0,
        "name": clean_name,
        "slug": slug,
        "notes": (notes or "").strip()[:500],
        "source_hint": (source_hint or "").strip()[:200],
        "followed": True,
        "created": True,
    }


def unfollow_creator(db: Session, creator_id: int) -> bool:
    ensure_creator_radar_schema(db)
    res = db.execute(
        text("DELETE FROM followed_creators WHERE id = :id"),
        {"id": int(creator_id)},
    )
    db.commit()
    return bool(res.rowcount)


def get_creator_dossier(db: Session, name: str, limit: int = 48) -> Dict[str, Any]:
    ensure_creator_radar_schema(db)
    clean_name = normalize_creator_name(name)
    slug = normalize_creator_slug(clean_name)
    if not clean_name or len(slug) < 2:
        raise ValueError("Chýba platné meno tvorcu.")

    followed = _fetch_followed_rows(db).get(slug)
    if followed:
        db.execute(
            text("UPDATE followed_creators SET last_opened_at = :ts WHERE id = :id"),
            {"ts": _utcnow_iso(), "id": followed["id"]},
        )
        db.commit()

    tokens = [tok for tok in slug.split() if len(tok) >= 2]
    first_tok = tokens[0] if tokens else slug
    pattern = f"%{first_tok}%"

    raw_videos = (
        db.query(Video)
        .filter(
            or_(
                Video.models.ilike(pattern),
                Video.title.ilike(pattern),
                Video.tags.ilike(pattern),
            )
        )
        .order_by(Video.height.desc(), Video.id.desc())
        .limit(400)
        .all()
    )
    library_videos = [v for v in raw_videos if _match_video_tokens(v, slug, tokens)]
    library_serialized = [_serialize_library_video(v) for v in library_videos[:limit]]

    known_urls = set()
    for v in library_videos:
        if v.url:
            known_urls.add(normalize_media_url(v.url))
        if v.source_url:
            known_urls.add(normalize_media_url(v.source_url))

    vault_res = search_local_vault(
        db,
        clean_name,
        buckets=["telegram", "forum", "filester", "mega", "queue"],
        limit_per_bucket=max(25, min(int(limit or 60), 80)),
    )
    vault_raw = vault_res.get("items") or []
    vault_hidden = []
    for item in vault_raw:
        u1 = normalize_media_url(item.get("url") or "")
        u2 = normalize_media_url(item.get("source_url") or "")
        if (u1 and u1 in known_urls) or (u2 and u2 in known_urls):
            continue
        cached_thumb = get_cached_thumb_url(item)
        if cached_thumb:
            item["thumbnail"] = cached_thumb
            item["thumb_enhanced"] = True
            if isinstance(item.get("telegram_meta"), dict):
                item["telegram_meta"]["thumbnail"] = cached_thumb
        vault_hidden.append(item)

    best_height = max((int(v.height or 0) for v in library_videos), default=0)
    local_count = sum(1 for v in library_videos if (v.storage_type or "") == "local")
    sample_thumb = next(
        (v["thumbnail"] for v in library_serialized if v["thumbnail"]),
        next((item.get("thumbnail") or "" for item in vault_hidden if item.get("thumbnail")), ""),
    )

    return {
        "creator": {
            "id": followed["id"] if followed else None,
            "name": followed["name"] if followed else clean_name,
            "slug": slug,
            "followed": bool(followed),
            "notes": followed["notes"] if followed else "",
            "source_hint": followed["source_hint"] if followed else "",
            "video_count": len(library_videos),
            "local_count": local_count,
            "best_height": best_height,
            "best_quality": quality_from_height(best_height) if library_videos else "SD",
            "vault_hidden_count": len(vault_hidden),
            "sample_thumb": sample_thumb,
        },
        "library_videos": library_serialized,
        "vault_findings": vault_hidden[:limit],
        "vault_counts": vault_res.get("bucket_counts") or {},
    }


def _match_urls_in_library(db: Session, urls: Sequence[str]) -> Dict[str, Dict[str, Any]]:
    clean_map: Dict[str, str] = {}
    lookup_candidates: List[str] = []
    for raw in urls[:120]:
        raw_s = str(raw or "").strip()
        if not raw_s:
            continue
        norm = normalize_media_url(raw_s)
        if not norm:
            continue
        clean_map[raw_s] = norm
        lookup_candidates.append(raw_s)
        if norm != raw_s:
            lookup_candidates.append(norm)
        lookup_candidates.append(raw_s.rstrip("/") + "/")

    if not lookup_candidates:
        return {}

    unique_candidates = list(dict.fromkeys(lookup_candidates))[:250]
    matched_rows = (
        db.query(Video)
        .filter(
            or_(
                Video.url.in_(unique_candidates),
                Video.source_url.in_(unique_candidates),
            )
        )
        .all()
    )

    by_norm: Dict[str, Dict[str, Any]] = {}
    for v in matched_rows:
        info = _serialize_library_video(v)
        for key_url in (v.url, v.source_url):
            norm_k = normalize_media_url(key_url or "")
            if norm_k:
                by_norm[norm_k] = info

    result: Dict[str, Dict[str, Any]] = {}
    for raw_url, norm_url in clean_map.items():
        if norm_url in by_norm:
            result[raw_url] = {
                "in_library": True,
                "video_id": by_norm[norm_url]["id"],
                "title": by_norm[norm_url]["title"],
                "quality": by_norm[norm_url]["quality"],
                "storage_type": by_norm[norm_url]["storage_type"],
            }
    return result


def probe_companion_targets(
    db: Session,
    query: str = "",
    page_url: str = "",
    page_title: str = "",
    candidates: Optional[Sequence[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Probe current webpage URLs + active query/creator against Library and Local Vault."""
    ensure_creator_radar_schema(db)
    cand_list = list(candidates or [])[:80]
    urls_to_check: List[str] = []
    if page_url:
        urls_to_check.append(page_url)
    for cand in cand_list:
        u = str((cand or {}).get("url") or "").strip()
        if u:
            urls_to_check.append(u)

    url_matches = _match_urls_in_library(db, urls_to_check)

    clean_query = normalize_creator_name(query or "")
    slug = normalize_creator_slug(clean_query)
    is_followed = False
    library_samples: List[Dict[str, Any]] = []
    library_count = 0
    library_local_count = 0
    vault_samples: List[Dict[str, Any]] = []
    vault_count = 0

    if clean_query and len(slug) >= 2:
        followed = _fetch_followed_rows(db)
        is_followed = slug in followed
        tokens = [tok for tok in slug.split() if len(tok) >= 2]
        first_tok = tokens[0] if tokens else slug
        pattern = f"%{first_tok}%"
        raw_videos = (
            db.query(Video)
            .filter(
                or_(
                    Video.models.ilike(pattern),
                    Video.title.ilike(pattern),
                    Video.tags.ilike(pattern),
                )
            )
            .order_by(Video.height.desc(), Video.id.desc())
            .limit(200)
            .all()
        )
        matched_videos = [v for v in raw_videos if _match_video_tokens(v, slug, tokens)]
        library_count = len(matched_videos)
        library_local_count = sum(1 for v in matched_videos if (v.storage_type or "") == "local")
        library_samples = [_serialize_library_video(v) for v in matched_videos[:6]]

        vault_res = search_local_vault(
            db,
            clean_query,
            buckets=["telegram", "forum", "filester", "mega", "queue"],
            limit_per_bucket=6,
        )
        vault_items = vault_res.get("items") or []
        vault_count = sum(int(v) for v in (vault_res.get("bucket_counts") or {}).values()) or len(vault_items)
        vault_samples = vault_items[:6]

    return {
        "ok": True,
        "query": clean_query,
        "page_url": page_url,
        "page_in_library": url_matches.get(page_url),
        "is_followed": is_followed,
        "library_count": library_count,
        "library_local_count": library_local_count,
        "vault_count": vault_count,
        "url_matches": url_matches,
        "library_samples": library_samples,
        "vault_samples": vault_samples,
    }
