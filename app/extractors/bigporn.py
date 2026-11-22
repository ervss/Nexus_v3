"""
bigporn.com extractor — watch page stream resolution.

BigPorn embeds an ok.xxx player with multiple <source> tags directly in HTML.
We pick the highest-resolution MP4 source available.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import aiohttp
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_QUALITY_ORDER = ("2160", "1080", "720", "480", "360")


def _quality_height(label: str) -> int:
    m = re.search(r"(\d{3,4})", str(label))
    return int(m.group(1)) if m else 0


def _pick_best_source(sources: List[Dict[str, str]]) -> Optional[Dict[str, str]]:
    """Return the highest-quality source dict from a list of {url, label} dicts."""
    if not sources:
        return None
    for q in _QUALITY_ORDER:
        for s in sources:
            if q in s.get("label", "").lower() or q in s.get("url", "").lower():
                return s
    return sources[0]


class BigPornExtractor(VideoExtractor):

    @property
    def name(self) -> str:
        return "BigPorn"

    def can_handle(self, url: str) -> bool:
        try:
            host = urlparse(url).netloc.lower()
            if host.startswith("www."):
                host = host[4:]
            return host == "bigporn.com"
        except Exception:
            return "bigporn.com" in str(url).lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logger.info("[BigPorn] extracting %s", url[:100])

        headers = {
            "User-Agent": _UA,
            "Referer": "https://www.bigporn.com/",
            "Accept-Language": "en-US,en;q=0.9",
        }

        html: str = ""
        try:
            timeout = aiohttp.ClientTimeout(total=30, connect=10)
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=timeout, allow_redirects=True) as resp:
                    if resp.status == 200:
                        html = await resp.text(errors="replace")
                    else:
                        logger.warning("[BigPorn] HTTP %s for %s", resp.status, url[:80])
        except Exception as exc:
            logger.warning("[BigPorn] fetch failed: %s", exc)

        if not html:
            return None

        soup = BeautifulSoup(html, "lxml")

        # --- Title ---
        title = ""
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title = og_title["content"].strip()
        if not title:
            h1 = soup.find("h1")
            if h1:
                title = h1.get_text(" ", strip=True)
        if not title:
            t = soup.find("title")
            if t:
                title = t.get_text(" ", strip=True)

        # --- Thumbnail ---
        thumbnail = ""
        og_img = soup.find("meta", property="og:image")
        if og_img and og_img.get("content"):
            thumbnail = og_img["content"].strip()
        if not thumbnail:
            video_tag = soup.find("video")
            if video_tag and video_tag.get("poster"):
                thumbnail = video_tag["poster"].strip()

        # --- Duration ---
        duration = 0
        og_dur = soup.find("meta", property="video:duration")
        if og_dur and og_dur.get("content", "").isdigit():
            duration = int(og_dur["content"])
        if not duration:
            m = re.search(r'"duration"\s*:\s*"?(\d+)"?', html)
            if m:
                duration = int(m.group(1))

        # --- Video sources ---
        # BigPorn uses ok.xxx player; sources are <source src="..." label="720p"> inside <video>
        sources: List[Dict[str, str]] = []
        video_tag = soup.find("video", id="my-video") or soup.find("video")
        if video_tag:
            for src in video_tag.find_all("source", src=True):
                src_url = src.get("src", "").strip()
                label = src.get("label", src.get("title", "")).strip()
                if src_url and src_url.startswith("http"):
                    sources.append({"url": src_url, "label": label})

        # Fallback: regex scan for ok.xxx get_file URLs in HTML
        if not sources:
            for m in re.finditer(
                r'["\'](?P<u>https?://[^"\']+/get_file/[^"\']+\.mp4/?)["\']',
                html,
                re.I,
            ):
                sources.append({"url": m.group("u"), "label": ""})

        if not sources:
            logger.warning("[BigPorn] no video sources found for %s", url[:80])
            return None

        best = _pick_best_source(sources)
        if not best:
            return None

        stream_url = best["url"]
        height = _quality_height(best.get("label", "") or stream_url)
        width = {2160: 3840, 1080: 1920, 720: 1280, 480: 854, 360: 640}.get(height, 0)

        logger.info(
            "[BigPorn] resolved %s -> %s (%s)",
            url[:60], stream_url[:80], best.get("label", "?"),
        )

        return {
            "id": None,
            "title": title or "BigPorn Video",
            "description": "",
            "thumbnail": thumbnail or None,
            "duration": duration,
            "stream_url": stream_url,
            "width": width,
            "height": height,
            "tags": [],
            "uploader": "",
            "is_hls": False,
        }
