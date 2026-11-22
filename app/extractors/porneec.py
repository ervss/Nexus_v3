import base64
import logging
import re
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)


class PorneecExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Porneec"

    @property
    def domains(self):
        return ["porneec.com"]

    def can_handle(self, url: str) -> bool:
        return any(domain in (url or "").lower() for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info("Extracting metadata from Porneec: %s", url)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://porneec.com/",
        }

        try:
            resp = requests.get(url, headers=headers, timeout=15)
            if resp.status_code != 200:
                logger.error("Porneec page returned status %s for %s", resp.status_code, url)
                return None

            html = resp.text
            soup = BeautifulSoup(html, "html.parser")

            title = self._clean_title(
                self._meta_itemprop(soup, "name")
                or self._meta_property(soup, "og:title")
                or (soup.find("h1").get_text(" ", strip=True) if soup.find("h1") else "")
                or (soup.title.get_text(" ", strip=True) if soup.title else "")
            )
            description = (
                self._meta_itemprop(soup, "description")
                or self._meta_name(soup, "description")
                or title
            )
            thumbnail = (
                self._meta_itemprop(soup, "thumbnailUrl")
                or self._meta_property(soup, "og:image")
                or ""
            )
            stream_url = (
                self._meta_itemprop(soup, "contentURL")
                or self._meta_itemprop(soup, "contentUrl")
                or self._extract_stream_from_iframe(soup)
            )
            if not stream_url:
                logger.error("Porneec extractor could not find direct stream URL for %s", url)
                return None

            duration = self._parse_iso8601_duration(self._meta_itemprop(soup, "duration"))
            upload_date = self._meta_itemprop(soup, "uploadDate") or None
            tags = self._collect_link_labels(soup, "/tag/")
            categories = self._collect_link_labels(soup, "/c/")
            actors = self._collect_link_labels(soup, "/actor/")
            if not actors:
                actors = self._extract_actor_names_from_title(title)
            uploader = categories[0] if categories else "Porneec"

            video_id = self._extract_id(url, html)
            return {
                "id": video_id,
                "title": title or "Porneec Video",
                "description": description or title or "Porneec Video",
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": 0,
                "height": 0,
                "tags": list(dict.fromkeys(tags + categories)),
                "actors": actors,
                "categories": categories,
                "views": 0,
                "upload_date": upload_date,
                "uploader": uploader,
                "is_hls": ".m3u8" in stream_url.lower(),
            }
        except Exception as exc:
            logger.error("Porneec extraction failed for %s: %s", url, exc)
            return None

    def _meta_itemprop(self, soup: BeautifulSoup, itemprop: str) -> str:
        node = soup.select_one(f'meta[itemprop="{itemprop}"]')
        return (node.get("content") or "").strip() if node else ""

    def _meta_property(self, soup: BeautifulSoup, prop: str) -> str:
        node = soup.select_one(f'meta[property="{prop}"]')
        return (node.get("content") or "").strip() if node else ""

    def _meta_name(self, soup: BeautifulSoup, name: str) -> str:
        node = soup.select_one(f'meta[name="{name}"]')
        return (node.get("content") or "").strip() if node else ""

    def _clean_title(self, value: str) -> str:
        title = str(value or "").strip()
        title = re.sub(r"\s*-\s*Porneec.*$", "", title, flags=re.I).strip()
        return title

    def _parse_iso8601_duration(self, value: str) -> int:
        text = str(value or "").strip().upper()
        if not text:
            return 0
        match = re.match(r"P0DT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", text)
        if not match:
            return 0
        hours = int(match.group(1) or 0)
        minutes = int(match.group(2) or 0)
        seconds = int(match.group(3) or 0)
        return hours * 3600 + minutes * 60 + seconds

    def _collect_link_labels(self, soup: BeautifulSoup, href_fragment: str) -> list[str]:
        out: list[str] = []
        for anchor in soup.select(f'a[href*="{href_fragment}"]'):
            text = anchor.get_text(" ", strip=True)
            href = (anchor.get("href") or "").strip()
            if not text or not href:
                continue
            if text.lower() in {"actors", "show more related videos"}:
                continue
            if text not in out:
                out.append(text)
        return out

    def _extract_actor_names_from_title(self, title: str) -> list[str]:
        match = re.match(r"^\[([^\]]+)\]\s*(.+)$", title or "")
        if not match:
            return []
        body = match.group(2)
        lead = body.split("–", 1)[0].split("-", 1)[0].strip()
        if not lead:
            return []
        pieces = [part.strip() for part in re.split(r",| and ", lead) if part.strip()]
        cleaned = []
        for piece in pieces:
            if len(piece.split()) >= 2 and piece not in cleaned:
                cleaned.append(piece)
        return cleaned

    def _extract_stream_from_iframe(self, soup: BeautifulSoup) -> str:
        iframe = soup.select_one('.video-player iframe[data-litespeed-src], .video-player iframe[src]')
        if not iframe:
            return ""
        encoded = (iframe.get("data-litespeed-src") or iframe.get("src") or "").strip()
        if not encoded:
            return ""
        try:
            parsed = urlparse(encoded)
            payload = parse_qs(parsed.query).get("q", [""])[0]
            if not payload:
                return ""
            decoded = base64.b64decode(payload).decode("utf-8", errors="ignore")
            match = re.search(r'<source[^>]+src="([^"]+)"', decoded, re.I)
            return match.group(1).strip() if match else ""
        except Exception:
            return ""

    def _extract_id(self, url: str, html: str) -> str:
        match = re.search(r"post[_-]id=(\d+)", html, re.I)
        if match:
            return match.group(1)
        path = urlparse(url).path.strip("/").split("/")
        return path[-1] if path and path[-1] else url
