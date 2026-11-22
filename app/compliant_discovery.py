"""
Whitelisted discovery helpers for mainstream / archival video sources.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote_plus

logger = logging.getLogger("compliant_discovery")

COMPLIANT_DISCOVERY_SOURCE_KEYS = frozenset({
    "youtube",
    "vimeo",
    "dailymotion",
    "internetarchive",
})

COMPLIANT_DISCOVERY_SOURCE_OPTIONS: List[Dict[str, Any]] = [
    {"id": "youtube", "label": "YouTube", "has_search": True, "safety": "compliant", "group": "whitelist"},
    {"id": "vimeo", "label": "Vimeo", "has_search": True, "safety": "compliant", "group": "whitelist"},
    {"id": "dailymotion", "label": "Dailymotion", "has_search": True, "safety": "compliant", "group": "whitelist"},
    {"id": "internetarchive", "label": "Internet Archive", "has_search": True, "safety": "compliant", "group": "whitelist"},
]

COMPLIANT_DISCOVERY_PRESETS: List[Dict[str, Any]] = [
    {
        "id": "safe_watchlist",
        "label": "Safe Watchlist",
        "description": "Whitelisted public sources with freshness and metadata scoring.",
        "sources": ["youtube", "vimeo", "dailymotion", "internetarchive"],
        "min_height": 720,
        "max_results": 100,
        "auto_import": False,
        "batch_prefix": "Safe Watchlist",
    }
]


def is_compliant_source(source_key: Optional[str]) -> bool:
    return str(source_key or "").strip().lower() in COMPLIANT_DISCOVERY_SOURCE_KEYS


def _parse_upload_date(raw: Any) -> Optional[dt.datetime]:
    if raw is None:
        return None
    if isinstance(raw, dt.datetime):
        return raw
    text = str(raw).strip()
    if not text:
        return None
    for fmt in ("%Y%m%d", "%Y-%m-%d", "%Y/%m/%d", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(text[: len(fmt)], fmt)
        except ValueError:
            continue
    try:
        return dt.datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _freshness_score(upload_date: Any, now: Optional[dt.datetime] = None) -> float:
    parsed = _parse_upload_date(upload_date)
    if parsed is None:
        return 0.2
    now = now or dt.datetime.now(dt.UTC).replace(tzinfo=None)
    age_days = max(0.0, (now - parsed).total_seconds() / 86400.0)
    if age_days <= 2:
        return 1.0
    if age_days <= 7:
        return 0.92
    if age_days <= 30:
        return 0.8
    if age_days <= 90:
        return 0.62
    if age_days <= 365:
        return 0.42
    return 0.24


def _quality_score(height: Any, width: Any = 0) -> float:
    try:
        h = int(height or 0)
    except (TypeError, ValueError):
        h = 0
    try:
        w = int(width or 0)
    except (TypeError, ValueError):
        w = 0
    if h >= 2160:
        base = 1.0
    elif h >= 1440:
        base = 0.92
    elif h >= 1080:
        base = 0.84
    elif h >= 720:
        base = 0.72
    elif h >= 480:
        base = 0.52
    elif h > 0:
        base = 0.36
    else:
        base = 0.18
    if w >= 1920 and h >= 1080:
        base += 0.04
    return min(base, 1.0)


def _metadata_score(item: Dict[str, Any]) -> float:
    checks = [
        bool(item.get("title")),
        bool(item.get("thumbnail")),
        bool(item.get("duration")),
        bool(item.get("height")),
        bool(item.get("description")),
        bool(item.get("uploader")),
        bool(item.get("upload_date")),
    ]
    return round(sum(1 for ok in checks if ok) / float(len(checks)), 3)


def score_discovery_item(item: Dict[str, Any]) -> Dict[str, Any]:
    meta_score = _metadata_score(item)
    fresh_score = _freshness_score(item.get("upload_date"))
    quality_score = _quality_score(item.get("height"), item.get("width"))
    stream_ready = bool(item.get("url"))
    final_score = round(
        (quality_score * 0.36) + (fresh_score * 0.34) + (meta_score * 0.22) + (0.08 if stream_ready else 0.0),
        4,
    )
    scored = dict(item)
    scored["metadata_score"] = meta_score
    scored["freshness_score"] = fresh_score
    scored["quality_score"] = quality_score
    scored["stream_ready"] = stream_ready
    scored["discovery_score"] = final_score
    return scored


def _quality_label(height: Any) -> str:
    try:
        h = int(height or 0)
    except (TypeError, ValueError):
        h = 0
    if h >= 2160:
        return "4K"
    if h >= 1440:
        return "2K"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    return "SD"


class CompliantVideoDiscoveryEngine:
    def __init__(self) -> None:
        self._ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": False,
            "nocheckcertificate": True,
            "ignoreerrors": True,
            "socket_timeout": 15,
        }

    async def search_sources(self, query: str, source_keys: Iterable[str], result_limit: int = 24) -> List[Dict[str, Any]]:
        keys = [key for key in source_keys if is_compliant_source(key)]
        if not keys:
            keys = list(COMPLIANT_DISCOVERY_SOURCE_KEYS)
        per_source = max(8, min(int(result_limit or 24), 80))
        results = await asyncio.gather(
            *[self.search_source(query, key, per_source) for key in keys],
            return_exceptions=True,
        )
        merged: List[Dict[str, Any]] = []
        seen = set()
        for bucket in results:
            if isinstance(bucket, Exception):
                continue
            for item in bucket or []:
                url = (item.get("url") or "").strip()
                if not url or url in seen:
                    continue
                seen.add(url)
                merged.append(item)
        merged.sort(
            key=lambda item: (
                float(item.get("discovery_score") or 0.0),
                int(item.get("height") or 0),
                int(item.get("duration") or 0),
            ),
            reverse=True,
        )
        return merged[: max(1, min(int(result_limit or 24), 200))]

    async def search_source(self, query: str, source_key: str, result_limit: int = 24) -> List[Dict[str, Any]]:
        key = str(source_key or "").strip().lower()
        if key == "internetarchive":
            return await asyncio.to_thread(self._search_internet_archive, query, result_limit)
        return await asyncio.to_thread(self._search_ytdlp_source, query, key, result_limit)

    def _search_ytdlp_source(self, query: str, source_key: str, result_limit: int) -> List[Dict[str, Any]]:
        import yt_dlp

        prefix_map = {
            "youtube": [f"ytsearch{result_limit}:{query}"],
            "vimeo": [f"vimeosearch{result_limit}:{query}"],
            "dailymotion": [
                f"dmsearch{result_limit}:{query}",
                f"dailymotionsearch{result_limit}:{query}",
            ],
        }
        attempts = prefix_map.get(source_key, [])
        for search_expr in attempts:
            try:
                with yt_dlp.YoutubeDL(self._ydl_opts) as ydl:
                    info = ydl.extract_info(search_expr, download=False)
                items = self._normalize_ytdlp_entries(info, source_key)
                if items:
                    return items
            except Exception as exc:
                logger.debug("Compliant yt-dlp search failed source=%s expr=%s error=%s", source_key, search_expr, exc)
        return []

    def _normalize_ytdlp_entries(self, info: Any, source_key: str) -> List[Dict[str, Any]]:
        entries = []
        raw_entries = []
        if isinstance(info, dict) and isinstance(info.get("entries"), list):
            raw_entries = info["entries"]
        elif isinstance(info, list):
            raw_entries = info
        elif isinstance(info, dict):
            raw_entries = [info]
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            canonical_url = item.get("webpage_url") or item.get("original_url") or item.get("url") or ""
            if not canonical_url.startswith(("http://", "https://")):
                continue
            normalized = {
                "title": str(item.get("title") or "Untitled").strip(),
                "url": canonical_url,
                "source_url": canonical_url,
                "thumbnail": item.get("thumbnail") or "",
                "description": item.get("description") or item.get("uploader") or "",
                "duration": int(item.get("duration") or 0),
                "height": int(item.get("height") or 0),
                "width": int(item.get("width") or 0),
                "upload_date": item.get("upload_date") or item.get("release_date") or "",
                "file_size_mb": round(float(item.get("filesize") or 0) / (1024 * 1024), 2) if item.get("filesize") else 0.0,
                "source": source_key,
                "uploader": item.get("uploader") or item.get("channel") or "",
                "view_count": int(item.get("view_count") or 0),
                "playlist_title": item.get("playlist_title") or "",
            }
            normalized["quality"] = _quality_label(normalized["height"])
            entries.append(score_discovery_item(normalized))
        return entries

    def _search_internet_archive(self, query: str, result_limit: int) -> List[Dict[str, Any]]:
        import requests

        api_url = (
            "https://archive.org/advancedsearch.php"
            f"?q={quote_plus(query)}+AND+mediatype%3A(movies)"
            "&fl[]=identifier&fl[]=title&fl[]=description&fl[]=publicdate&fl[]=creator"
            "&sort[]=publicdate+desc&output=json"
            f"&rows={max(1, min(int(result_limit or 24), 100))}&page=1"
        )
        try:
            resp = requests.get(api_url, timeout=15)
            resp.raise_for_status()
            docs = (((resp.json() or {}).get("response") or {}).get("docs") or [])
        except Exception as exc:
            logger.debug("Internet Archive discovery failed query=%s error=%s", query, exc)
            return []

        results: List[Dict[str, Any]] = []
        for doc in docs:
            if not isinstance(doc, dict):
                continue
            identifier = str(doc.get("identifier") or "").strip()
            if not identifier:
                continue
            url = f"https://archive.org/details/{identifier}"
            item = {
                "title": str(doc.get("title") or identifier).strip(),
                "url": url,
                "source_url": url,
                "thumbnail": f"https://archive.org/services/img/{identifier}",
                "description": str(doc.get("description") or "").strip(),
                "duration": 0,
                "height": 0,
                "width": 0,
                "upload_date": str(doc.get("publicdate") or "").strip(),
                "file_size_mb": 0.0,
                "source": "internetarchive",
                "uploader": str(doc.get("creator") or "").strip(),
                "view_count": 0,
            }
            results.append(score_discovery_item(item))
        return results
