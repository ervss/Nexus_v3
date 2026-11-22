"""CyberFile public file and folder extractor."""
from __future__ import annotations

import html as html_lib
import asyncio
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)
_VIDEO_EXTENSIONS = (".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".wmv", ".flv", ".ts")
_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}


class CyberFileExtractor(VideoExtractor):
    """Resolve public ``cyberfile.me`` files and enumerate shared folders."""

    @property
    def name(self) -> str:
        return "CyberFile"

    def can_handle(self, url: str) -> bool:
        try:
            host = (urlparse(url).hostname or "").lower()
        except ValueError:
            return False
        return host == "cyberfile.me" or host.endswith(".cyberfile.me")

    # CyberFile accepts the metadata API at a much higher rate than its media
    # CDN.  Keep file-detail calls in one small lane nevertheless: a folder
    # import must never create a burst that makes the first playback fail.
    _resolve_lock = asyncio.Lock()
    _last_resolve_at = 0.0
    _resolve_spacing_seconds = 1.25

    @classmethod
    async def _wait_for_resolution_slot(cls) -> None:
        async with cls._resolve_lock:
            now = asyncio.get_running_loop().time()
            delay = cls._resolve_spacing_seconds - (now - cls._last_resolve_at)
            if delay > 0:
                await asyncio.sleep(delay)
            cls._last_resolve_at = asyncio.get_running_loop().time()

    @staticmethod
    def _folder_id(page_html: str) -> str:
        match = re.search(r"loadImages\(\s*['\"]folder['\"]\s*,\s*['\"]?(\d+)", page_html or "", re.I)
        return match.group(1) if match else ""

    @staticmethod
    def _is_video(name: str) -> bool:
        return (name or "").lower().split("?", 1)[0].endswith(_VIDEO_EXTENSIONS)

    @staticmethod
    def _size(value: Any) -> int:
        try:
            return max(0, int(float(str(value or "0").replace(",", ""))))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _upload_date(value: str) -> str:
        value = (value or "").strip()
        for pattern in ("%d/%m/%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(value, pattern).strftime("%Y-%m-%d")
            except ValueError:
                pass
        return value[:10]

    @classmethod
    def _parse_listing(cls, listing_html: str, source_url: str) -> List[Dict[str, Any]]:
        soup = BeautifulSoup(listing_html or "", "html.parser")
        rows: List[Dict[str, Any]] = []
        seen: set[str] = set()
        for node in soup.select(".fileIconLi[dtfullurl]"):
            file_url = urljoin(source_url, (node.get("dtfullurl") or "").strip())
            title = (node.get("dttitle") or node.get("dtfilename") or "").strip()
            if not file_url or not title or not cls._is_video(title) or file_url in seen:
                continue
            seen.add(file_url)
            image = node.select_one("img[src]")
            thumb = urljoin(source_url, image.get("src")) if image else ""
            size_bytes = cls._size(node.get("dtsizeraw"))
            rows.append({"id": str(node.get("fileid") or file_url.rsplit("/", 1)[-1]), "title": title,
                # A stable public file page is queued; the signed CDN link is
                # resolved only when Nexus processes the individual card.
                "url": file_url, "stream_url": "", "source_url": file_url, "item_url": file_url,
                "thumbnail": thumb, "duration": 0, "size_bytes": size_bytes,
                "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
                "upload_date": cls._upload_date(node.get("dtuploaddate") or ""), "uploader": "CyberFile",
                "is_hls": False, "width": 0, "height": 0, "quality": ""})
        return rows

    async def extract_album_entries(self, url: str) -> List[Dict[str, Any]]:
        if "/folder/" not in (urlparse(url).path or "").lower():
            return []
        try:
            async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=20) as client:
                page = await client.get(url)
                page.raise_for_status()
                folder_id = self._folder_id(page.text)
                if not folder_id:
                    logger.warning("[CyberFile] Folder id not found for %s", url)
                    return []
                response = await client.post("https://cyberfile.me/account/ajax/load_files", data={
                    "pageType": "folder", "nodeId": folder_id, "pageStart": "1", "perPage": "500",
                    "filterOrderBy": "", "additionalParams": ""})
                response.raise_for_status()
                return self._parse_listing(str(response.json().get("html") or ""), url)
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.warning("[CyberFile] folder extraction failed for %s: %s", url, exc)
            return []

    async def extract_album(self, url: str) -> List[Dict[str, Any]]:
        return await self.extract_album_entries(url)

    @staticmethod
    def _file_id(page_html: str) -> str:
        match = re.search(r"showFileInformation\(\s*(\d+)\s*\)", page_html or "")
        return match.group(1) if match else ""

    @staticmethod
    def _stream_url(details_html: str) -> str:
        # ``\\s`` inside a negative class excludes literal "s" rather than
        # whitespace, which truncates many filenames before their media suffix.
        match = re.search(r"https?://p\d+\.cyberfile\.me/[^\"'<>\s]+", details_html or "", re.I)
        return html_lib.unescape(match.group(0)).replace("\\/", "/") if match else ""

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if "/folder/" in (urlparse(url).path or "").lower():
            entries = await self.extract_album_entries(url)
            if not entries:
                return None
            first = entries[0]
            return {**first, "title": f"CyberFile priečinok ({len(entries)} videí)", "video_count": len(entries),
                    "item_count": len(entries), "album_items": entries,
                    "album_size_bytes": sum(int(item.get("size_bytes") or 0) for item in entries)}
        try:
            await self._wait_for_resolution_slot()
            async with httpx.AsyncClient(headers=_HEADERS, follow_redirects=True, timeout=20) as client:
                page = await client.get(url)
                page.raise_for_status()
                file_id = self._file_id(page.text)
                if not file_id:
                    return None
                details = await client.post("https://cyberfile.me/account/ajax/file_details", data={"u": file_id})
                details.raise_for_status()
                stream_url = self._stream_url(str(details.json().get("html") or ""))
                if not stream_url:
                    return None
                soup = BeautifulSoup(page.text, "html.parser")
                title = (soup.title.string if soup.title else "") or file_id
                title = re.sub(r"\s*-\s*CyberFile(?:\s*-\s*CyberFile)?\s*$", "", title, flags=re.I).strip()
                image = soup.select_one("meta[property='og:image']")
                return {"id": file_id, "title": title, "description": "", "thumbnail": image.get("content") if image else "",
                    "duration": 0, "stream_url": stream_url, "source_url": url, "width": 0, "height": 0,
                    "size_bytes": 0, "tags": [], "uploader": "CyberFile",
                    "is_hls": stream_url.lower().split("?", 1)[0].endswith(".m3u8")}
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.warning("[CyberFile] file extraction failed for %s: %s", url, exc)
            return None
