"""XXBrits extractor.

XXBrits runs the KernelVideoSharing (KVS) engine, so stream resolution is delegated
to the shared KVS path in `media_router` rather than reimplemented here:
`xxbrits.com` is listed in `_KVS_DOMAINS`, which routes it to `CyberDropKVSExtractor`
(curl_cffi TLS impersonation to get past Cloudflare + cyberdrop_dl's `_parse_video_vars`
for the scrambled `/get_file/` tokens the kt_player emits).

Engine evidence (structural KVS fingerprints, not guesses):
  * watch URLs  /videos/{id}/{slug}/
  * screenshots /contents/videos_screenshots/{id_bucket}/{id}/{size}/{n}.jpg
  * async block controller  ?mode=async&function=get_block&block_id=...
  * kt_player + inline `flashvars`

The plain-`flashvars` fallback below mirrors `PorntrexExtractor` for KVS variants that
expose unobfuscated `video_url` / `video_alt_url{N}` values.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse, urlunparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)


class XXBritsExtractor(VideoExtractor):
    """Extractor for XXBrits videos (KVS engine)."""

    @property
    def name(self) -> str:
        return "XXBrits"

    @property
    def domains(self):
        return ["xxbrits.com", "www.xxbrits.com"]

    def can_handle(self, url: str) -> bool:
        return any(domain in (url or "") for domain in self.domains)

    _PLAYLIST_PATH_RE = re.compile(r"^/playlists/\d+/[^/]+/?$", re.I)
    _VIDEO_PATH_RE = re.compile(r"/videos/\d+(?:/|$)", re.I)
    _LISTING_BLOCK = "playlist_view_playlist_view"
    _PLAYLIST_HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    @classmethod
    def is_playlist_url(cls, url: str) -> bool:
        """True only for public XXBrits playlist pages, never watch pages."""
        parsed = urlparse(url or "")
        return (
            parsed.hostname in {"xxbrits.com", "www.xxbrits.com"}
            and bool(cls._PLAYLIST_PATH_RE.match(parsed.path or ""))
        )

    @staticmethod
    def _parse_duration(value: str) -> int:
        """Parse the compact KVS card duration (MM:SS or HH:MM:SS)."""
        parts = [part for part in (value or "").strip().split(":") if part.isdigit()]
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
        return 0

    @classmethod
    def _parse_playlist_page(cls, html: str, playlist_url: str) -> tuple[list[Dict[str, Any]], int]:
        """Read a KVS playlist block and its actual next page number.

        KVS renders page one as a full document and later pages as an HTML
        fragment.  Both contain the same ``#playlist_view_playlist_view``
        block, so one parser covers both responses.
        """
        soup = BeautifulSoup(html or "", "html.parser")
        block = soup.select_one(f"#{cls._LISTING_BLOCK}") or soup
        entries: list[Dict[str, Any]] = []
        seen: set[str] = set()

        for card in block.select(".th.item[data-playlist-item], [data-playlist-item]"):
            raw_url = (card.get("data-playlist-item") or "").strip()
            if not raw_url:
                anchor = card.select_one('a[href*="/videos/"]')
                raw_url = anchor.get("href", "").strip() if anchor else ""
            if not raw_url:
                continue
            video_url = raw_url if raw_url.startswith("http") else f"https://www.xxbrits.com{raw_url}"
            video_url = video_url.split("#", 1)[0]
            if not cls._VIDEO_PATH_RE.search(urlparse(video_url).path) or video_url in seen:
                continue
            seen.add(video_url)

            title_anchor = card.select_one("a.title") or card.select_one('a[href*="/videos/"]')
            image = card.select_one("img")
            title = ""
            if title_anchor:
                title = title_anchor.get("title") or title_anchor.get_text(" ", strip=True)
            if not title and image:
                title = image.get("alt") or ""
            thumbnail = ""
            if image:
                thumbnail = image.get("data-original") or image.get("data-webp") or image.get("src") or ""
                if thumbnail.startswith("data:"):
                    thumbnail = ""
            duration = 0
            for span in card.select(".bottom-panel .group .box span"):
                duration = cls._parse_duration(span.get_text(strip=True))
                if duration:
                    break
            entries.append({
                "url": video_url,
                "source_url": video_url,
                "title": (title or "XXBrits video").strip()[:180],
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": "",
            })

        current_page = 1
        active = block.select_one(f"#{cls._LISTING_BLOCK}_pagination .active")
        if active:
            match = re.search(r"\d+", active.get_text(" ", strip=True))
            if match:
                current_page = int(match.group(0))
        next_page = 0
        for anchor in block.select(f"#{cls._LISTING_BLOCK}_pagination a[data-parameters]"):
            params = anchor.get("data-parameters") or ""
            found = re.search(r"(?:^|;)from:(\d+)(?:;|$)", params)
            if not found:
                continue
            page = int(found.group(1))
            if (anchor.get_text(" ", strip=True).lower() == "next" or page > current_page) and (not next_page or page < next_page):
                next_page = page
        return entries, next_page

    @staticmethod
    def _playlist_title(html: str) -> str:
        soup = BeautifulSoup(html or "", "html.parser")
        heading = soup.select_one("h1")
        if heading:
            value = heading.get_text(" ", strip=True)
            if value:
                return value
        title = soup.title.get_text(" ", strip=True) if soup.title else ""
        return re.sub(r"\s*(?:-|\|)\s*XXBRITS\s*$", "", title, flags=re.I).strip()

    async def fetch_playlist_batch(
        self,
        url: str,
        *,
        start_page: int = 1,
        max_pages: int = 10,
    ) -> Dict[str, Any]:
        """Fetch one bounded XXBrits playlist window (10 pages / 100 videos).

        The site exposes 10 cards per KVS page.  We deliberately keep the
        request window bounded so a tester card is useful immediately and the
        UI can explicitly ask for the next 100 instead of silently crawling an
        entire large playlist.
        """
        if not self.is_playlist_url(url):
            return {"items": [], "next_page": 0, "has_more": False}
        start_page = max(1, int(start_page or 1))
        max_pages = max(1, min(10, int(max_pages or 10)))
        parsed = urlparse(url)
        clean_url = urlunparse((parsed.scheme or "https", parsed.netloc, parsed.path.rstrip("/") + "/", "", "", ""))
        timeout = httpx.Timeout(25.0, connect=12.0)
        all_items: list[Dict[str, Any]] = []
        seen: set[str] = set()
        page = start_page
        loaded_pages = 0
        next_page = 0
        title = ""

        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, headers=self._PLAYLIST_HEADERS) as client:
            while page and loaded_pages < max_pages:
                if page == 1:
                    page_url = clean_url
                else:
                    query = urlencode({
                        "mode": "async", "function": "get_block", "block_id": self._LISTING_BLOCK,
                        "sort_by": "added2fav_date", "from": page,
                    })
                    page_url = f"{clean_url}?{query}"
                response = await client.get(page_url, headers={"Referer": clean_url})
                if response.status_code != 200 or not response.text:
                    logger.warning("[XXBrits] playlist page %s returned HTTP %s", page, response.status_code)
                    break
                if not title:
                    title = self._playlist_title(response.text)
                page_items, reported_next = self._parse_playlist_page(response.text, clean_url)
                new_items = [item for item in page_items if item["url"] not in seen]
                if not new_items:
                    break
                for item in new_items:
                    seen.add(item["url"])
                    all_items.append(item)
                loaded_pages += 1
                # Only accept KVS's real pagination transition.  This avoids
                # guessing a page URL after a short/private final page.
                next_page = reported_next if reported_next > page else 0
                page = next_page

        return {
            "items": all_items,
            "title": title or "XXBrits playlist",
            "page_start": start_page,
            "pages_loaded": loaded_pages,
            "next_page": next_page,
            "has_more": bool(next_page),
        }

    async def extract_album_entries(self, url: str):
        """Tester-compatible first playlist batch (up to 10 KVS pages)."""
        return (await self.fetch_playlist_batch(url))["items"]

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if self.is_playlist_url(url):
            return None
        try:
            return await asyncio.to_thread(self._extract_sync, url)
        except Exception as exc:  # noqa: BLE001
            logger.error("[XXBrits] extraction failed for %s: %s", url, exc, exc_info=True)
            return None

    def _extract_sync(self, url: str) -> Optional[Dict[str, Any]]:
        # Shared KVS path: handles Cloudflare + scrambled get_file tokens.
        from .media_router import default_router

        result = default_router.extract(url)
        if result and result.stream_url:
            return {
                "id": None,
                "title": result.title or "XXBrits video",
                "description": "",
                "thumbnail": result.thumbnail or "",
                "duration": int(result.duration or 0),
                "stream_url": result.stream_url,
                "width": int(result.width or 0),
                "height": int(result.height or 0),
                "tags": [],
                "views": 0,
                "upload_date": None,
                "uploader": "",
                "is_hls": bool(result.is_hls),
            }
        logger.warning("[XXBrits] shared KVS router returned no stream for %s", url)
        return None

    @staticmethod
    def _parse_flashvars(html: str) -> tuple[Optional[str], int]:
        """Plain (unobfuscated) KVS flashvars fallback: best `video_url`/`video_alt_url{N}`.

        Returns (stream_url, height). Mirrors the proven PorntrexExtractor logic.
        """
        match = re.search(r"var\s+flashvars\s*=\s*\{(.+?)\};", html or "", re.DOTALL)
        if not match:
            return None, 0
        block = match.group(1)
        quality_map: dict[int, str] = {}
        for suffix in ["", "2", "3", "4", "5", "6", "7", "8", "9"]:
            key = "video_url" if suffix == "" else f"video_alt_url{suffix}"
            url_match = re.search(rf"{key}\s*:\s*'([^']+)'", block)
            text_match = re.search(rf"{key}_text\s*:\s*'([^']+)'", block)
            if not url_match:
                continue
            height = 0
            if text_match:
                digits = re.search(r"(\d{3,4})", text_match.group(1))
                height = int(digits.group(1)) if digits else 0
            quality_map[height or 480] = url_match.group(1).rstrip("/")
        # KVS also exposes an explicit alt key on some skins.
        alt_hd = re.search(r"video_url_hd\s*:\s*'([^']+)'", block)
        if alt_hd:
            quality_map.setdefault(1080, alt_hd.group(1).rstrip("/"))
        if not quality_map:
            return None, 0
        best = max(quality_map)
        return quality_map[best], best
