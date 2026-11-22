"""
RedTube extractor.

RedTube is fully supported by yt-dlp, so the primary path resolves the direct
mp4/HLS stream + metadata through it. A lightweight HTML/JSON-LD parse is used as
a fast metadata refresh and as a fallback when yt-dlp is unavailable or throttled.

Import from RedTube is extension-first (see redtube_grid_importer.js): cards are
selected and metadata fetched on redtube.com itself, then pushed to the generic
/api/v1/import/bulk endpoint. This backend extractor exists so the dashboard can
still refresh a stream/metadata for a stored RedTube video (JIT link refresh).
"""
from __future__ import annotations

import asyncio
import datetime
import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

try:
    import yt_dlp  # type: ignore
except Exception:  # pragma: no cover - yt_dlp should be installed
    yt_dlp = None  # type: ignore

logger = logging.getLogger(__name__)


class RedTubeExtractor:
    def __init__(self):
        self.session = requests.Session()

    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    )

    @property
    def name(self) -> str:
        return "RedTube"

    @property
    def domains(self):
        return ["redtube.com", "www.redtube.com", "de.redtube.com", "fr.redtube.com"]

    def can_handle(self, url: str) -> bool:
        low = (url or "").lower()
        return "redtube.com" in low

    def is_playable_stream(self, url: str) -> bool:
        low = (url or "").strip().lower()
        if not low.startswith(("http://", "https://")):
            return False
        if self._is_watch_page(low):
            return False
        if low.endswith(".ts") or "/seg-" in low:
            return False
        return ".m3u8" in low or ".mp4" in low

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        page_url = self._normalize_url(url)
        if not page_url:
            return None

        # 1) yt-dlp (best quality + reliable stream resolution)
        if yt_dlp is not None:
            try:
                result = await asyncio.to_thread(self._extract_ytdlp, page_url)
                if result and result.get("stream_url"):
                    return result
            except Exception as exc:
                logger.warning("RedTube: yt-dlp path failed for %s: %s", page_url, exc)

        # 2) HTML / JSON-LD fallback
        try:
            return await asyncio.to_thread(self._extract_html, page_url)
        except Exception as exc:
            logger.error("RedTube extraction failed for %s: %s", page_url, exc, exc_info=True)
            return self._fallback_result(page_url)

    # ---------------------------------------------------------------- yt-dlp
    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        opts = {
            "quiet": True,
            "ignoreerrors": True,
            "no_warnings": True,
            "format": "bestvideo+bestaudio/best",
            "extract_flat": False,
            "socket_timeout": 30,
            "retries": 3,
            "http_headers": {
                "User-Agent": self.USER_AGENT,
                "Referer": "https://www.redtube.com/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        }
        for cookie_path in ("redtube.netscape.txt", "redtube.cookies.txt", "cookies.netscape.txt"):
            if os.path.exists(cookie_path):
                opts["cookiefile"] = cookie_path
                break

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not info:
            return None

        best_format = None
        best_height = 0
        for fmt in info.get("formats", []) or []:
            if not fmt.get("url") or not fmt.get("height"):
                continue
            height = fmt.get("height") or 0
            if height > best_height:
                best_format = fmt
                best_height = height

        stream_url = best_format["url"] if best_format else info.get("url")
        if not stream_url:
            return None
        width = (best_format or {}).get("width") or info.get("width") or 0
        height = (best_format or {}).get("height") or info.get("height") or 0
        is_hls = ".m3u8" in str(stream_url).lower() or (best_format or {}).get("protocol", "").startswith("m3u8")

        # yt-dlp usually reports neither filesize nor filesize_approx for RedTube, so the
        # progressive mp4 gets a HEAD — the same probe the HTML path already does. Skipped
        # for HLS, where the manifest URL has no meaningful content-length.
        size_bytes = int((best_format or {}).get("filesize")
                         or (best_format or {}).get("filesize_approx") or 0)
        if not size_bytes and stream_url and not is_hls:
            size_bytes = self._head_size(stream_url, referer=url)

        return {
            "id": str(info.get("id") or self._extract_id(url) or "") or None,
            "title": (info.get("title") or self._title_from_url(url) or "RedTube Video").strip(),
            "description": info.get("description") or "",
            "thumbnail": info.get("thumbnail") or "",
            "duration": int(info.get("duration") or 0),
            "stream_url": stream_url,
            "width": int(width or 0),
            "height": int(height or 0),
            "tags": [t for t in (info.get("tags") or []) if t],
            "categories": [c for c in (info.get("categories") or []) if c],
            "views": int(info.get("view_count") or 0),
            "uploader": info.get("uploader") or "",
            "is_hls": bool(is_hls),
            "quality": self._quality_label(int(height or 0)),
            "size_bytes": size_bytes,
            "upload_date": self._format_upload_date(info.get("upload_date")),
            "source_url": url,
        }

    # ------------------------------------------------------------------ HTML
    def _extract_html(self, url: str) -> Dict[str, Any]:
        html, final_url = self._fetch_text(url, referer="https://www.redtube.com/")
        if not html:
            return self._fallback_result(url)

        title = self._extract_title(html) or self._title_from_url(final_url)
        thumbnail = self._extract_meta(html, ("og:image", "twitter:image")) or ""
        duration = self._extract_duration(html)
        stream_url, width, height, is_hls = self._extract_stream(html, referer=final_url)
        upload_date = self._extract_upload_date(html)
        tags = self._extract_tags(html)
        size_bytes = self._head_size(stream_url, referer=final_url) if (stream_url and not is_hls) else 0

        return {
            "id": self._extract_id(final_url) or None,
            "title": title or "RedTube Video",
            "description": "",
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": stream_url or "",
            "width": width,
            "height": height,
            "tags": tags,
            "categories": [],
            "views": 0,
            "uploader": "",
            "is_hls": is_hls,
            "quality": self._quality_label(height),
            "size_bytes": size_bytes,
            "upload_date": upload_date,
            "source_url": final_url,
        }

    def _fallback_result(self, url: str) -> Dict[str, Any]:
        return {
            "id": self._extract_id(url) or None,
            "title": self._title_from_url(url) or "RedTube Video",
            "description": "",
            "thumbnail": "",
            "duration": 0,
            "stream_url": "",
            "width": 0,
            "height": 0,
            "tags": [],
            "categories": [],
            "views": 0,
            "uploader": "",
            "is_hls": False,
            "quality": "SD",
            "size_bytes": 0,
            "upload_date": "",
            "source_url": self._normalize_url(url),
        }

    # --------------------------------------------------------------- helpers
    def _fetch_text(self, url: str, referer: str = "") -> Tuple[str, str]:
        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if referer:
            headers["Referer"] = referer
        try:
            from .base import ntc_get_sync
            from app.ntc import NTCStatusError
            html = ntc_get_sync(url, domain="redtube.com", headers=headers, deadline=28.0)
            return html or "", url
        except NTCStatusError:
            return "", url
        except Exception:
            resp = self.session.get(url, headers=headers, timeout=20, allow_redirects=True)
            if resp.status_code >= 400:
                return "", url
            return resp.text or "", resp.url or url

    def _normalize_url(self, value: str) -> str:
        raw = str(value or "").strip()
        if not raw:
            return ""
        if raw.startswith("//"):
            return f"https:{raw}"
        if raw.startswith(("http://", "https://")):
            return raw
        return ""

    def _extract_id(self, url: str) -> str:
        # RedTube watch pages look like https://www.redtube.com/12345678
        m = re.search(r"redtube\.com/(?:[a-z]{2}/)?(\d{4,})", str(url or ""), re.I)
        return m.group(1) if m else ""

    def _title_from_url(self, url: str) -> str:
        raw = str(url or "").rstrip("/").split("/")[-1]
        raw = re.sub(r"^\d+", "", raw).strip("-_ ")
        return raw.replace("-", " ").replace("_", " ").strip().title()

    def _extract_meta(self, html: str, names) -> str:
        for name in names:
            m = re.search(
                rf'<meta[^>]+(?:property|name)=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
                html, re.I,
            )
            if m:
                return self._abs(m.group(1))
        return ""

    def _extract_title(self, html: str) -> str:
        og = self._extract_meta(html, ("og:title", "twitter:title"))
        if og:
            return re.sub(r"\s*[-|]\s*RedTube.*$", "", og, flags=re.I).strip()
        m = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
        if m:
            return re.sub(r"\s*[-|]\s*RedTube.*$", "", m.group(1), flags=re.I).strip()
        return ""

    def _extract_duration(self, html: str) -> int:
        m = re.search(r'"duration"\s*:\s*"?(PT[\dHMS]+)"?', html, re.I)
        if m:
            iso = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", m.group(1), re.I)
            if iso:
                return int(iso.group(1) or 0) * 3600 + int(iso.group(2) or 0) * 60 + int(iso.group(3) or 0)
        m = re.search(r'"video:duration"[^>]+content=["\'](\d+)["\']', html, re.I)
        if m:
            return int(m.group(1))
        m = re.search(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b", html)
        if m:
            if m.group(3):
                return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
            return int(m.group(1)) * 60 + int(m.group(2))
        return 0

    def _extract_max_quality(self, html: str) -> int:
        """Highest advertised height from "defaultQuality":[480,240,720,1080]."""
        m = re.search(r'"defaultQuality"\s*:\s*\[([\d,\s]+)\]', html, re.I)
        if not m:
            return 0
        nums = [int(n) for n in re.findall(r"\d+", m.group(1))]
        return max(nums) if nums else 0

    def _extract_media_endpoint(self, html: str) -> Tuple[str, bool]:
        """Return the relative /media/mp4 (preferred) or /media/hls endpoint."""
        m = re.search(r'"format"\s*:\s*"mp4"\s*,\s*"videoUrl"\s*:\s*"([^"]+)"', html, re.I)
        if not m:
            m = re.search(r'"videoUrl"\s*:\s*"([^"]*\\?/media\\?/mp4[^"]*)"', html, re.I)
        if m:
            return m.group(1).replace("\\/", "/"), False
        m = re.search(r'"format"\s*:\s*"hls"\s*,\s*"videoUrl"\s*:\s*"([^"]+)"', html, re.I)
        if not m:
            m = re.search(r'"videoUrl"\s*:\s*"([^"]*\\?/media\\?/hls[^"]*)"', html, re.I)
        if m:
            return m.group(1).replace("\\/", "/"), True
        return "", False

    def _resolve_media_endpoint(self, endpoint: str, referer: str) -> Tuple[str, int]:
        """Resolve /media/mp4?s=... into the best direct mp4 (url, height)."""
        if not endpoint:
            return "", 0
        abs_url = endpoint if endpoint.startswith("http") else f"https://www.redtube.com{'' if endpoint.startswith('/') else '/'}{endpoint}"
        try:
            headers = {"User-Agent": self.USER_AGENT, "Accept": "application/json, */*"}
            if referer:
                headers["Referer"] = referer
            resp = self.session.get(abs_url, headers=headers, timeout=15, allow_redirects=True)
            if resp.status_code >= 400:
                return "", 0
            arr = resp.json()
            if not isinstance(arr, list):
                return "", 0
            best_url, best_h = "", 0
            for entry in arr:
                try:
                    q = int(str(entry.get("quality") or "").strip() or self._infer_height(entry.get("videoUrl", "")))
                except Exception:
                    q = self._infer_height(entry.get("videoUrl", ""))
                u = str(entry.get("videoUrl") or "").replace("\\/", "/")
                if q > best_h and ".mp4" in u.lower():
                    best_url, best_h = u, q
            return best_url, best_h
        except Exception:
            return "", 0

    def _extract_stream(self, html: str, referer: str = "https://www.redtube.com/") -> Tuple[str, int, int, bool]:
        page_max = self._extract_max_quality(html)
        endpoint, is_hls = self._extract_media_endpoint(html)

        best_url, best_height = "", 0
        if endpoint and not is_hls:
            best_url, best_height = self._resolve_media_endpoint(endpoint, referer)

        # Fallback: JSON-LD contentUrl (older pages)
        if not best_url:
            m = re.search(r'"contentUrl"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"', html, re.I)
            if m:
                best_url = m.group(1).replace("\\/", "/")
                best_height = self._infer_height(best_url)

        height = page_max or best_height or self._infer_height(best_url)
        stream_is_hls = is_hls and not best_url
        return best_url, self._width_for_height(height), height, stream_is_hls

    def _extract_upload_date(self, html: str) -> str:
        m = re.search(r'"uploadDate"\s*:\s*"([^"]+)"', html, re.I)
        if m:
            raw = m.group(1)
            for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
                try:
                    return datetime.datetime.strptime(raw[:len(datetime.datetime.now().strftime(fmt)) if "%z" not in fmt else len(raw)], fmt).strftime("%b %d, %Y")
                except Exception:
                    continue
            try:
                return datetime.datetime.fromisoformat(raw.replace("Z", "+00:00")).strftime("%b %d, %Y")
            except Exception:
                return raw
        return ""

    def _extract_tags(self, html: str) -> List[str]:
        tags = re.findall(r'href=["\'][^"\']*/tags?/[^"\']+["\'][^>]*>([^<]{2,40})<', html, re.I)
        cleaned = [t.strip() for t in tags if t.strip()]
        seen, out = set(), []
        for t in cleaned:
            key = t.lower()
            if key not in seen:
                seen.add(key)
                out.append(t)
        return out[:25]

    def _format_upload_date(self, raw: Optional[str]) -> str:
        raw = str(raw or "").strip()
        if raw and len(raw) == 8 and raw.isdigit():
            try:
                return datetime.datetime.strptime(raw, "%Y%m%d").strftime("%b %d, %Y")
            except Exception:
                return ""
        return ""

    def _head_size(self, url: str, referer: str = "") -> int:
        candidate = self._normalize_url(url)
        if not candidate:
            return 0
        headers = {"User-Agent": self.USER_AGENT, "Accept": "*/*"}
        if referer:
            headers["Referer"] = referer
        try:
            resp = self.session.head(candidate, headers=headers, timeout=10, allow_redirects=True)
            content_length = resp.headers.get("Content-Length")
            if content_length and str(content_length).isdigit():
                return int(content_length)
        except Exception:
            pass
        return 0

    def _infer_height(self, value: str) -> int:
        m = re.search(r"(2160|1440|1080|720|480|360|240)(?:p)?", str(value or ""), re.I)
        return int(m.group(1)) if m else 0

    def _width_for_height(self, height: int) -> int:
        return {
            2160: 3840, 1440: 2560, 1080: 1920,
            720: 1280, 480: 854, 360: 640, 240: 426,
        }.get(int(height or 0), 0)

    def _quality_label(self, height: int) -> str:
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
        if h >= 360:
            return "360p"
        if h >= 240:
            return "240p"
        return "SD"

    def _is_watch_page(self, raw: str) -> bool:
        return bool(re.search(r"redtube\.com/(?:[a-z]{2}/)?\d{4,}", (raw or "").lower()))

    def _abs(self, raw: str) -> str:
        value = str(raw or "").strip().replace("\\/", "/")
        if value.startswith("//"):
            return f"https:{value}"
        return value
