from __future__ import annotations

import html as _html
import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def _abs_url(raw: str, base_url: str) -> str:
    value = str(raw or "").strip().replace("\\/", "/").replace("&amp;", "&")
    if not value:
        return ""
    if value.startswith("//"):
        value = "https:" + value
    try:
        return urljoin(base_url, value)
    except Exception:
        return value


def _height_from_text(value: str) -> int:
    m = re.search(r"(2160|1440|1080|720|480|360|240)p?", str(value or ""), re.I)
    if m:
        return int(m.group(1))
    if re.search(r"\b4k\b|uhd", str(value or ""), re.I):
        return 2160
    return 0


def _is_good_stream(url: str) -> bool:
    low = str(url or "").lower()
    if not low.startswith("http"):
        return False
    if any(x in low for x in ("preview.xgroovy.com", "preview_", "_pr640", "thumb", "sprite")):
        return False
    return bool(re.search(r"\.(mp4|m3u8|mpd|webm|mov)(?:[/?#]|$)", low) or "/get_file/" in low)


class XGroovyExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "XGroovy"

    @property
    def domains(self):
        return ["xgroovy.com", "xgroovy-fr.com"]

    def can_handle(self, url: str) -> bool:
        low = str(url or "").lower()
        return any(domain in low for domain in self.domains)

    def _fetch_html(self, url: str) -> str:
        headers = {
            "User-Agent": _UA,
            "Referer": "https://xgroovy.com/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        try:
            from curl_cffi import requests as cr

            resp = cr.get(url, headers=headers, impersonate="chrome", timeout=25)
            if resp.status_code == 200 and resp.text:
                return resp.text
            logger.warning("[XGroovy] curl_cffi HTTP %s for %s", resp.status_code, url[:100])
        except Exception as exc:
            logger.debug("[XGroovy] curl_cffi fetch failed: %s", exc)

        try:
            import requests

            resp = requests.get(url, headers=headers, timeout=20)
            if resp.status_code == 200:
                return resp.text or ""
            logger.warning("[XGroovy] requests HTTP %s for %s", resp.status_code, url[:100])
        except Exception as exc:
            logger.debug("[XGroovy] requests fetch failed: %s", exc)
        return ""

    def _meta(self, soup: BeautifulSoup, prop: str) -> str:
        tag = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
        return _html.unescape(str(tag.get("content") or "")).strip() if tag else ""

    def _extract_sources(self, html: str, base_url: str) -> List[Dict[str, Any]]:
        soup = BeautifulSoup(html, "html.parser")
        sources: Dict[str, Dict[str, Any]] = {}

        def add(raw: str, label: str = "") -> None:
            url = _abs_url(raw, base_url)
            if not _is_good_stream(url):
                return
            height = _height_from_text(f"{label} {url}")
            prev = sources.get(url)
            if not prev or height > int(prev.get("height") or 0):
                sources[url] = {
                    "url": url,
                    "height": height,
                    "label": label,
                    "is_hls": ".m3u8" in url.lower() or ".mpd" in url.lower(),
                }

        for video in soup.find_all("video"):
            add(video.get("src") or "", video.get("label") or video.get("res") or "")
            for source in video.find_all("source"):
                add(
                    source.get("src") or "",
                    " ".join(
                        str(source.get(k) or "")
                        for k in ("label", "res", "title", "data-res", "data-quality")
                    ),
                )

        for match in re.finditer(
            r"https?://[^\s\"'<>]+(?:/get_file/|\.)(?:[^\s\"'<>]*?)(?:mp4|m3u8|mpd|webm|mov)(?:[^\s\"'<>]*)?",
            html.replace("\\/", "/").replace("&amp;", "&"),
            re.I,
        ):
            add(match.group(0))

        out = list(sources.values())
        out.sort(key=lambda item: (int(item.get("height") or 0), 1 if "/get_file/" in item["url"] else 0), reverse=True)
        return out

    async def extract(self, url: str, pre_fetched_html: Optional[str] = None) -> Optional[Dict[str, Any]]:
        watch_url = str(url or "").strip()
        if not watch_url:
            return None
        logger.info("[XGroovy] extracting %s", watch_url[:120])

        html = pre_fetched_html or self._fetch_html(watch_url)
        if not html or len(html) < 1000:
            logger.warning("[XGroovy] empty/short HTML for %s", watch_url[:100])
            return None

        sources = self._extract_sources(html, watch_url)
        if not sources:
            logger.warning("[XGroovy] no playable sources for %s", watch_url[:100])
            return None

        best = sources[0]
        stream_url = best["url"]
        height = int(best.get("height") or 0)
        width = {2160: 3840, 1440: 2560, 1080: 1920, 720: 1280, 480: 854, 360: 640, 240: 426}.get(height, 0)
        soup = BeautifulSoup(html, "html.parser")

        title = self._meta(soup, "og:title")
        if not title:
            title_tag = soup.find("title")
            title = title_tag.get_text(" ", strip=True) if title_tag else ""

        thumbnail = self._meta(soup, "og:image")
        if not thumbnail:
            video_tag = soup.find("video")
            thumbnail = str(video_tag.get("poster") or "") if video_tag else ""
        thumbnail = _abs_url(thumbnail, watch_url) if thumbnail else ""

        duration = 0
        for pattern in (
            r'<meta[^>]+property=["\']video:duration["\'][^>]+content=["\'](\d+)["\']',
            r'"duration"\s*:\s*"?(\d{2,6})"?',
            r"video_duration['\"]?\s*[:=]\s*['\"]?(\d+)",
        ):
            m = re.search(pattern, html, re.I)
            if m:
                try:
                    duration = int(m.group(1))
                    break
                except Exception:
                    pass

        id_match = re.search(r"/videos?/(\d+)", watch_url)
        return {
            "id": id_match.group(1) if id_match else None,
            "title": _html.unescape(title).strip() or "XGroovy Video",
            "description": self._meta(soup, "description") or self._meta(soup, "og:description"),
            "thumbnail": thumbnail or None,
            "duration": duration,
            "stream_url": stream_url,
            "source_url": watch_url,
            "width": width,
            "height": height,
            "tags": [],
            "uploader": "",
            "is_hls": bool(best.get("is_hls")),
            "extractor": self.name,
        }
