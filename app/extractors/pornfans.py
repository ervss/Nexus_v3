"""Extractor for PornFans watch pages with a Lulu-hosted player iframe."""

import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor
from .lulustream import LuluStreamExtractor

logger = logging.getLogger(__name__)
_LULU_HOST_RE = re.compile(r"(?:^|\.)(?:lulustream|luluvid|luluvdo|luluvids)\.(?:com|net|top)$|(?:^|\.)lulu\.stream$", re.I)


class PornFansExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "PornFans"

    def can_handle(self, url: str) -> bool:
        try:
            host = (urlparse(url).hostname or "").lower()
            return host == "pornfans.net" or host.endswith(".pornfans.net")
        except Exception:
            return "pornfans.net" in str(url or "").lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://pornfans.net/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True, verify=False) as client:
                response = await client.get(url, headers=headers)
            if response.status_code >= 400:
                logger.warning("PornFans: page request failed for %s (%s)", url, response.status_code)
                return None
            page_url = str(response.url or url)
            soup = BeautifulSoup(response.text, "html.parser")
            embed_url = self._embed_url(soup, page_url)
            if not embed_url:
                logger.warning("PornFans: no supported player iframe on %s", page_url)
                return None
            resolved = await LuluStreamExtractor().extract(embed_url)
            stream_url = str((resolved or {}).get("stream_url") or "").strip()
            if not stream_url:
                logger.warning("PornFans: embedded provider did not resolve for %s", page_url)
                return None
            return {
                "id": self._id_from_url(page_url),
                "title": self._meta(soup, "og:title") or self._text(soup.find("h1")) or "PornFans Video",
                "description": self._meta(soup, "og:description"),
                "thumbnail": self._meta(soup, "og:image") or str((resolved or {}).get("thumbnail") or ""),
                "duration": self._duration(soup),
                "stream_url": stream_url,
                "width": 0,
                "height": 0,
                "tags": self._links(soup, "/tag/"),
                "uploader": (self._links(soup, "/model/") or ["PornFans"])[0],
                "is_hls": ".m3u8" in stream_url.lower(),
                "source_url": page_url,
                "embed_url": embed_url,
                "extractor": self.name,
            }
        except Exception as exc:
            logger.error("PornFans extraction failed for %s: %s", url, exc)
            return None

    @staticmethod
    def _meta(soup: BeautifulSoup, name: str) -> str:
        node = soup.find("meta", property=name) or soup.find("meta", attrs={"name": name})
        return str(node.get("content") or "").strip() if node else ""

    @staticmethod
    def _text(node: Any) -> str:
        return node.get_text(" ", strip=True) if node else ""

    @staticmethod
    def _links(soup: BeautifulSoup, path: str) -> list[str]:
        values: list[str] = []
        for link in soup.select(f'a[href*="{path}"]'):
            text = link.get_text(" ", strip=True)
            if text and text not in values:
                values.append(text)
        return values

    @staticmethod
    def _id_from_url(page_url: str) -> str:
        parts = [part for part in urlparse(page_url).path.split("/") if part]
        return parts[-1] if parts else "pornfans"

    @staticmethod
    def _duration(soup: BeautifulSoup) -> int:
        for value in (PornFansExtractor._meta(soup, "og:video:duration"), PornFansExtractor._meta(soup, "video:duration"), soup.get_text(" ", strip=True)):
            match = re.search(r"\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b", value or "")
            if match:
                return int(match.group(1) or 0) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
        return 0

    @staticmethod
    def _embed_url(soup: BeautifulSoup, base_url: str) -> str:
        for frame in soup.select("iframe[src]"):
            candidate = urljoin(base_url, str(frame.get("src") or "").strip())
            if _LULU_HOST_RE.search((urlparse(candidate).hostname or "").lower()):
                return candidate
        return ""
