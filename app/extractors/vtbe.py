"""Extractor for vtbe.to watch pages.

vTube can expose a normal ``<video>`` source, a JSON player configuration, or
an MSE player.  The latter is resolved by the browser extension at playback
time; this extractor intentionally covers the first two forms so pasted URLs
still receive useful metadata without a browser capture.
"""

import html as html_lib
import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_MEDIA_RE = re.compile(
    r"(?:https?:)?//[^\s\"'<>\\]+?\.(?:mp4|m3u8|mpd|webm)(?:\?[^\s\"'<>\\]*)?",
    re.IGNORECASE,
)


class VtbeExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "vTube"

    def can_handle(self, url: str) -> bool:
        try:
            host = urlparse(url).hostname or ""
            return host.lower() == "vtbe.to" or host.lower().endswith(".vtbe.to")
        except (TypeError, ValueError):
            return False

    @staticmethod
    def _extract_media_url(page_html: str, page_url: str) -> str:
        """Choose the best direct stream embedded in a vTube document."""
        document = html_lib.unescape(page_html or "").replace("\\/", "/")
        candidates = []

        for match in _MEDIA_RE.finditer(document):
            value = match.group(0)
            if value.startswith("//"):
                value = "https:" + value
            candidates.append(value)

        # Some player configs use a relative file/source property.
        for match in re.finditer(
            r"(?:file|source|src)\s*[:=]\s*[\"']([^\"']+)[\"']", document, re.I
        ):
            value = urljoin(page_url, match.group(1).replace("\\/", "/"))
            if re.search(r"\.(?:mp4|m3u8|mpd|webm)(?:[?#]|$)", value, re.I):
                candidates.append(value)

        # Prefer a master/HLS URL when the page publishes both an HLS and a
        # lower-quality MP4 rendition.
        candidates = list(dict.fromkeys(candidates))
        candidates.sort(key=lambda value: (".m3u8" in value.lower(), "master" in value.lower()), reverse=True)
        return candidates[0] if candidates else ""

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "Referer": "https://vtbe.to/",
        }
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()

            page_html = response.text
            stream_url = self._extract_media_url(page_html, str(response.url))
            if not stream_url:
                return None

            soup = BeautifulSoup(page_html, "html.parser")
            title = ""
            for selector, attrs in (("meta", {"property": "og:title"}), ("meta", {"name": "twitter:title"})):
                tag = soup.find(selector, attrs=attrs)
                if tag and tag.get("content"):
                    title = tag["content"].strip()
                    break
            if not title and soup.title:
                title = soup.title.get_text(" ", strip=True)
            title = re.sub(r"\s*(?:[-|]\s*)?(?:vTube|vTube Video Hosting Platform)\s*$", "", title, flags=re.I).strip()

            image = soup.find("meta", attrs={"property": "og:image"})
            thumbnail = urljoin(str(response.url), image["content"].strip()) if image and image.get("content") else ""
            video_id = re.search(r"/([^/?#]+?)(?:\.html)?$", urlparse(str(response.url)).path)

            return {
                "id": video_id.group(1) if video_id else "",
                "title": title or "vTube Video",
                "description": "",
                "thumbnail": thumbnail,
                "duration": 0,
                "stream_url": stream_url,
                "is_hls": ".m3u8" in stream_url.lower(),
                "extractor": self.name,
            }
        except Exception as exc:  # noqa: BLE001 - a failed host must not stop other imports
            logger.warning("[vTube] extraction failed for %s: %s", url, exc)
            return None
