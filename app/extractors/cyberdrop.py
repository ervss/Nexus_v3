import logging
import re
from typing import Optional, Dict, Any

import httpx

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_DOMAINS = ("cyberdrop.cr", "cyberdrop.me", "cyberdrop.to", "cyberdrop.cc", "cyberdrop.nl")
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://cyberdrop.cr/",
}


class CyberDropExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "CyberDrop"

    def can_handle(self, url: str) -> bool:
        # CyberDrop exposes the same file under /f/ (file page) and /e/ (embed).
        # Both resolve via the identical /api/file/info/{slug} endpoint.
        return any(d in url for d in _DOMAINS) and ("/e/" in url or "/f/" in url)

    def _api_base(self, url: str) -> str:
        for d in _DOMAINS:
            if d in url:
                return f"https://api.{d}"
        return "https://api.cyberdrop.cr"

    def _slug(self, url: str) -> str:
        m = re.search(r"/[ef]/([^/?#]+)", url)
        return m.group(1) if m else ""

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        slug = self._slug(url)
        if not slug:
            logger.warning("[CyberDrop] Cannot extract slug from %s", url)
            return None

        api_base = self._api_base(url)

        try:
            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(15.0, connect=8.0),
                verify=False,
                headers=_HEADERS,
            ) as client:
                # Step 1: file info → title, mime type, size, auth_url
                r1 = await client.get(f"{api_base}/api/file/info/{slug}")
                if r1.status_code == 404:
                    logger.warning("[CyberDrop] File not found (404): %s", url)
                    return None
                r1.raise_for_status()
                info = r1.json()

                if not isinstance(info, dict) or info.get("error"):
                    logger.warning("[CyberDrop] API error for %s: %s", url, info)
                    return None

                mime = info.get("type") or info.get("mime_type") or ""
                if not mime.startswith("video"):
                    logger.info("[CyberDrop] Not a video (%s): %s", mime, url)
                    return None

                title = info.get("name") or info.get("filename") or slug
                # Strip extension from title for display
                title_display = re.sub(r'\.[a-z0-9]{2,5}$', '', title, flags=re.I) or title
                size_bytes = int(info.get("size") or 0)
                thumbnail = info.get("thumbnail_url") or info.get("thumbnail") or info.get("thumb") or ""
                auth_url = info.get("auth_url") or ""

                stream_url = ""

                # Step 2: resolve auth_url → signed CDN URL
                if auth_url:
                    r2 = await client.get(auth_url, headers={**_HEADERS, "Accept": "application/json"})
                    if r2.is_success:
                        auth_data = r2.json()
                        stream_url = str(auth_data.get("url") or "").strip()

                # Fallback: direct CDN guess from info
                if not stream_url:
                    cdn = info.get("url") or info.get("download_url") or info.get("cdn_url") or ""
                    if cdn and cdn.startswith("http"):
                        stream_url = cdn

                if not stream_url:
                    logger.warning("[CyberDrop] Could not resolve stream URL for %s", url)
                    return None

                # Infer resolution from filename / URL
                height = 0
                for src in (title, stream_url):
                    m = re.search(r'[_\-\s](\d{3,4})[pP]', src)
                    if m:
                        try:
                            height = int(m.group(1))
                            break
                        except ValueError:
                            pass

                width = {2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854}.get(height, 0)

                return {
                    "id": slug,
                    "title": title_display,
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "width": width,
                    "height": height,
                    "size_bytes": size_bytes,
                    "tags": [],
                    "uploader": "",
                    "is_hls": stream_url.lower().endswith(".m3u8"),
                    "source_url": url,
                }

        except httpx.HTTPStatusError as exc:
            logger.warning("[CyberDrop] HTTP %s for %s", exc.response.status_code, url)
            return None
        except Exception as exc:
            logger.error("[CyberDrop] extract failed for %s: %s", url, exc)
            return None
