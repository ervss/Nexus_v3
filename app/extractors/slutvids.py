import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

# Ordered preference: try these embed domains first (best extraction support)
_PREFERRED_EMBED_DOMAINS = [
    "luluvids.top", "lulustream.com", "luluvid.com", "luluvdo.com", "luluvid.net", "luluvids.com",
    "cdnvids.top",
    "abysscdn.com",
]


class SlutVidsExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "SlutVids"

    def can_handle(self, url: str) -> bool:
        try:
            host = urlparse(url).hostname or ""
            return host == "slutvids.net.lv" or host.endswith(".slutvids.net.lv")
        except Exception:
            return "slutvids.net.lv" in str(url or "").lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://slutvids.net.lv/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, verify=False) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code >= 400:
                    logger.warning("SlutVids: failed to fetch %s, status=%s", url, resp.status_code)
                    return None

            soup = BeautifulSoup(resp.text, "html.parser")
            canonical = self._canonical_url(soup, str(resp.url or url))
            title = self._title(soup)
            thumbnail = self._thumbnail(soup, canonical)
            duration = self._duration(soup)

            # Find embed URLs from data-embed attributes
            embed_urls = [
                str(tag.get("data-embed") or "").strip()
                for tag in soup.select("[data-embed]")
                if tag.get("data-embed")
            ]

            stream_url = await self._resolve_embed(embed_urls, canonical)

            if not stream_url:
                logger.warning("SlutVids: could not resolve stream for %s", url)
                return None

            return {
                "id": self._slug(canonical),
                "title": title or "SlutVids Video",
                "description": "",
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": 0,
                "height": 0,
                "tags": [],
                "uploader": "SlutVids",
                "is_hls": ".m3u8" in stream_url.lower(),
                "source_url": canonical,
                "extractor": self.name,
            }
        except Exception as exc:
            logger.error("SlutVids extraction failed for %s: %s", url, exc)
            return None

    async def _resolve_embed(self, embed_urls: list, page_url: str) -> Optional[str]:
        """Try each embed URL in preference order, return first resolved stream."""
        if not embed_urls:
            return None

        # Sort by preferred domains
        def _priority(u: str) -> int:
            ul = u.lower()
            for i, domain in enumerate(_PREFERRED_EMBED_DOMAINS):
                if domain in ul:
                    return i
            return len(_PREFERRED_EMBED_DOMAINS)

        sorted_embeds = sorted(embed_urls, key=_priority)

        for embed_url in sorted_embeds:
            stream = await self._try_extract_embed(embed_url, page_url)
            if stream:
                return stream

        return None

    async def _try_extract_embed(self, embed_url: str, referer: str) -> Optional[str]:
        """Attempt stream extraction from an embed URL using known extractors."""
        el = embed_url.lower()

        # LuluStream family
        if any(d in el for d in ("lulustream", "luluvid", "luluvdo", "luluvids", "lulu.stream")):
            try:
                from .lulustream import LuluStreamExtractor
                res = await LuluStreamExtractor().extract(embed_url)
                if res and res.get("stream_url"):
                    logger.info("SlutVids: resolved via LuluStream: %s", res["stream_url"][:80])
                    return res["stream_url"]
            except Exception as exc:
                logger.warning("SlutVids: LuluStream failed for %s: %s", embed_url, exc)

        # AbyssCDN / generic embed — try fetching iframe source directly
        if "abysscdn.com" in el or "cdnvids.top" in el:
            try:
                stream = await self._scrape_embed_iframe(embed_url, referer)
                if stream:
                    return stream
            except Exception as exc:
                logger.warning("SlutVids: iframe scrape failed for %s: %s", embed_url, exc)

        return None

    async def _scrape_embed_iframe(self, embed_url: str, referer: str) -> Optional[str]:
        """Fetch embed page and extract .mp4/.m3u8 from scripts."""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": referer,
            "Accept": "text/html,*/*;q=0.9",
        }
        async with httpx.AsyncClient(timeout=12, follow_redirects=True, verify=False) as client:
            resp = await client.get(embed_url, headers=headers)
            if resp.status_code >= 400:
                return None
            html = resp.text

        patterns = [
            r'["\']?(https?://[^"\'<>\s]+\.(?:mp4|m3u8)(?:\?[^"\'<>\s]*)?)["\']?',
            r'file\s*:\s*["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
            r'src\s*:\s*["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
        ]
        for p in patterns:
            m = re.search(p, html, re.I)
            if m:
                candidate = m.group(1)
                if candidate.startswith("http"):
                    return candidate
        return None

    def _canonical_url(self, soup: BeautifulSoup, fallback: str) -> str:
        href = ""
        canonical = soup.find("link", rel=lambda value: value and "canonical" in value)
        if canonical:
            href = str(canonical.get("href") or "").strip()
        if not href:
            og_url = soup.find("meta", property="og:url")
            href = str(og_url.get("content") or "").strip() if og_url else ""
        out = urljoin(fallback, href or fallback)
        parsed = urlparse(out)
        path = re.sub(r"/+", "/", parsed.path or "/").rstrip("/") or "/"
        return parsed._replace(fragment="", query="", path=path).geturl()

    def _title(self, soup: BeautifulSoup) -> str:
        title = ""
        for candidate in (
            soup.find("h1"),
            soup.find("meta", property="og:title"),
            soup.find("title"),
        ):
            if not candidate:
                continue
            title = str(candidate.get("content") if candidate.name == "meta" else candidate.get_text(" ", strip=True) or "").strip()
            if title:
                break
        title = re.sub(r"\s*[-|]\s*SlutVids.*$", "", title, flags=re.I).strip()
        title = re.sub(r"\s*[-|]\s*slutvids\.net\.lv.*$", "", title, flags=re.I).strip()
        return title

    def _thumbnail(self, soup: BeautifulSoup, base_url: str) -> str:
        for selector in (
            ('meta', {"property": "og:image"}, "content"),
            ('meta', {"name": "twitter:image"}, "content"),
            ('div', {"data-thum": True}, "data-thum"),
            ('video', {}, "poster"),
            ('img', {"data-src": True}, "data-src"),
            ('img', {"src": True}, "src"),
        ):
            tag_name, attrs, attr_name = selector
            node = soup.find(tag_name, attrs=attrs)
            value = str(node.get(attr_name) or "").strip() if node else ""
            if value:
                return urljoin(base_url, value)
        return ""

    def _duration(self, soup: BeautifulSoup) -> int:
        # Try ISO 8601 duration from schema.org meta
        meta_dur = soup.find("meta", itemprop="duration")
        if meta_dur:
            iso = str(meta_dur.get("content") or "")
            m = re.search(r"P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso)
            if m:
                days, hours, mins, secs = (int(x or 0) for x in m.groups())
                total = days * 86400 + hours * 3600 + mins * 60 + secs
                if total > 0:
                    return total

        text = " ".join(
            node.get_text(" ", strip=True)
            for node in soup.select(".duration, .time, time, [class*=duration], [class*=time]")
        )
        if not text:
            text = soup.get_text(" ", strip=True)
        match = re.search(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b", text)
        if not match:
            return 0
        parts = [int(p) for p in match.groups(default="0")]
        if match.group(3) is not None:
            return parts[0] * 3600 + parts[1] * 60 + parts[2]
        return parts[0] * 60 + parts[1]

    def _slug(self, url: str) -> str:
        path = urlparse(url).path.strip("/")
        return path.split("/")[-1] if path else url
