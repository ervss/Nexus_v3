import re
import json
import logging
import asyncio
from typing import Optional, Dict, Any
from urllib.parse import urljoin
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

try:
    from curl_cffi import requests as creq
except ImportError:
    creq = None


class DjavExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "DJAV"

    @property
    def domains(self):
        return ["djav.org", "www.djav.org"]

    def can_handle(self, url: str) -> bool:
        if not url:
            return False
        return any(domain in url.lower() for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logger.info(f"[DJAV] Extracting from {url}")

        html = await self._fetch_page(url)
        if not html:
            logger.error(f"[DJAV] Failed to fetch HTML for {url}")
            return None

        # Extract video ID from URL
        m_id = re.search(r'-(\d+)\.html', url)
        video_id = m_id.group(1) if m_id else re.sub(r'[^a-z0-9]+', '-', url.lower()).strip('-')

        soup = BeautifulSoup(html, "lxml")

        # Stream URL extraction
        stream_url = None

        # 1. Look for <source src="...mp4">
        for s in soup.select('video source, source'):
            src = s.get('src', '').strip()
            if src and re.search(r'\.(?:mp4|m3u8)', src, re.I):
                stream_url = src.split('#')[0]
                break

        # 2. Look for download button / link
        if not stream_url:
            for a in soup.select('a[href*=".mp4"]'):
                href = a.get('href', '').strip()
                if href and re.search(r'\.(?:mp4|m3u8)', href, re.I):
                    stream_url = href.split('#')[0]
                    break

        # 3. Regex search for cdn.xvix.eu or direct mp4
        if not stream_url:
            m_mp4 = re.search(r'(https?://cdn\.xvix\.eu/videos/[^\s"\'<>]+\.mp4)', html)
            if m_mp4:
                stream_url = m_mp4.group(1)

        if not stream_url:
            m_any = re.search(r'(https?://[^\s"\'<>]+\.(?:mp4|m3u8)[^\s"\'<>]*)', html)
            if m_any:
                stream_url = m_any.group(1).split('#')[0]

        if not stream_url:
            logger.error(f"[DJAV] Could not extract stream URL for {url}")
            return None

        # Title extraction
        title = ""
        m_og_title = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']', html, re.I)
        if m_og_title:
            title = m_og_title.group(1).strip()
        if not title:
            h1 = soup.select_one('h1.entry-title, h1')
            if h1:
                title = h1.get_text(strip=True)
        if not title and soup.title:
            title = soup.title.get_text(strip=True)
        # Clean suffix
        for suf in (" - Videos - djav tube the best premium porn", " - djav tube", " - djav.org"):
            if title.endswith(suf):
                title = title[:-len(suf)].strip()

        # Thumbnail extraction
        thumbnail = ""
        m_poster = soup.select_one('video[poster]')
        if m_poster and m_poster.get('poster'):
            thumbnail = m_poster['poster'].strip()
        if not thumbnail:
            m_og_img = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\'](https?://[^"\']+)["\']', html, re.I)
            if m_og_img:
                thumbnail = m_og_img.group(1).strip()

        # Duration extraction
        duration = 0
        m_iso = re.search(r'duration["\']?\s*:\s*["\']P?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?["\']', html, re.I)
        if m_iso and any(m_iso.groups()):
            h = int(m_iso.group(1) or 0)
            m = int(m_iso.group(2) or 0)
            s = int(m_iso.group(3) or 0)
            duration = h * 3600 + m * 60 + s

        if not duration:
            el_len = soup.select_one('.info-elem.-length, .sub-label')
            if el_len:
                txt = el_len.get_text(strip=True)
                m_txt = re.search(r'\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b', txt)
                if m_txt:
                    h = int(m_txt.group(1) or 0)
                    m = int(m_txt.group(2) or 0)
                    s = int(m_txt.group(3) or 0)
                    duration = h * 3600 + m * 60 + s

        # Tags extraction
        tags = []
        for a in soup.select('a[href*="/tag/"]'):
            t = a.get_text(strip=True)
            if t and t not in tags:
                tags.append(t)

        return {
            "id": video_id,
            "title": title or f"DJAV - {video_id}",
            "description": "",
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": stream_url,
            "playback_referer": "https://djav.org/",
            "width": 1920,
            "height": 1080,
            "tags": tags,
            "uploader": "DJAV",
            "is_hls": ".m3u8" in stream_url,
        }

    async def _fetch_page(self, url: str) -> Optional[str]:
        def _get():
            try:
                if creq:
                    r = creq.get(url, impersonate='chrome', timeout=18,
                                  headers={'Referer': 'https://djav.org/'})
                    if r.status_code == 200:
                        return r.text
            except Exception as e:
                logger.warning(f"[DJAV] curl_cffi fetch error: {e}")
            return None

        return await asyncio.to_thread(_get)
