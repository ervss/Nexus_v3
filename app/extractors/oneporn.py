import re
import json
import logging
import asyncio
import aiohttp
import yt_dlp
from .base import VideoExtractor
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class OnePornExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "1Porn"

    @property
    def domains(self):
        return ["1porn.tv", "www.1porn.tv"]

    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logger.info(f"[1PORN] Extracting from {url}")

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://www.1porn.tv/'
        }

        # Extract slug from URL as ID (1porn.tv uses slugs, not numeric IDs)
        slug_match = re.search(r'/videos/([^/?#]+)', url.rstrip('/'))
        video_id = slug_match.group(1) if slug_match else re.sub(r'[^a-z0-9]+', '-', url.lower()).strip('-')

        from ..oneporn_client import fetch_1porn_html
        html = await fetch_1porn_html(url, referer="https://www.1porn.tv/")
        if not html:
            logger.warning(f"[1PORN] HTML fetch failed for {url}")

        # Parse metadata from HTML / LD+JSON
        title = ""
        thumbnail = ""
        duration = 0
        tags = []
        stream_url = None

        if html:
            # og:image is the reliable thumbnail — LD+JSON thumbnailUrl returns 404 paths
            m_ogimg = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\'](https?://[^"\']+)["\']', html, re.I)
            if m_ogimg:
                thumbnail = m_ogimg.group(1).strip()

            # LD+JSON VideoObject — title, duration, contentUrl only (skip thumbnailUrl — it's 404)
            for block in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.DOTALL | re.IGNORECASE):
                try:
                    data = json.loads(block)
                    items = data if isinstance(data, list) else data.get('@graph', [data])
                    for item in items:
                        if 'VideoObject' in str(item.get('@type', '')):
                            title = item.get('name', '')
                            iso_dur = item.get('duration', '')
                            dm = re.match(r'P(?:T)?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', iso_dur or '')
                            if dm:
                                duration = int(dm.group(1) or 0)*3600 + int(dm.group(2) or 0)*60 + int(dm.group(3) or 0)
                            content_url = item.get('contentUrl', '')
                            if content_url and re.search(r'\.(mp4|m3u8)', content_url, re.I):
                                stream_url = content_url
                            break
                except Exception:
                    pass

            if not title:
                m = re.search(r'<h1[^>]*>([^<]+)</h1>', html)
                title = m.group(1).strip() if m else ''
            if not title:
                m = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\'](.*?)["\']', html, re.I)
                title = m.group(1).strip() if m else ''

            # Extract tags
            tags = re.findall(r'<a[^>]+href=["\'][^"\']*\/tags?\/[^"\']*["\'][^>]*>([^<]+)</a>', html, re.I)
            tags = [t.strip() for t in tags if t.strip()]

            # Pick best quality from get_file URLs (2160 > 1440 > 1080 > 720 > 480 > 360)
            if not stream_url:
                get_file_urls = re.findall(
                    r'(https://www\.1porn\.tv/get_file/[^\s"\'<>]+\.mp4/?)(?!\?download)',
                    html
                )
                quality_order = ['2160', '1440', '1080', '720', '480', '360']
                best_url = ''
                best_rank = len(quality_order)
                for u in get_file_urls:
                    for rank, q in enumerate(quality_order):
                        if f'_{q}m.mp4' in u and rank < best_rank:
                            best_rank = rank
                            best_url = u
                            break
                if best_url:
                    stream_url = best_url
                    logger.info(f"[1PORN] Best quality URL ({quality_order[best_rank]}p): {stream_url}")

            # Generic fallback patterns
            if not stream_url:
                for pattern in [
                    r'"(?:file|src|videoUrl|contentUrl|video_url)"\s*:\s*"(https?:[^"]+\.mp4[^"]*)"',
                    r'"(?:file|src|videoUrl|contentUrl|video_url)"\s*:\s*"(https?:[^"]+\.m3u8[^"]*)"',
                    r'<source[^>]+src=["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)["\']',
                ]:
                    m = re.search(pattern, html, re.I)
                    if m:
                        stream_url = m.group(1).replace('\\/', '/')
                        break

        title = title or f"1Porn - {video_id}"

        # Fallback: yt-dlp (handles the external iframe player)
        if not stream_url:
            logger.info(f"[1PORN] No stream in HTML, trying yt-dlp for {url}")
            try:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'skip_download': True,
                    'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                }
                loop = asyncio.get_event_loop()
                info = await loop.run_in_executor(None, lambda: self._yt_dlp_extract(url, ydl_opts))
                if info:
                    stream_url = info.get('url') or info.get('manifest_url') or ''
                    if not title:
                        title = info.get('title', title)
                    if not thumbnail:
                        thumbnail = info.get('thumbnail', '') or ''
                    if not duration:
                        duration = int(info.get('duration') or 0)
                    if not tags:
                        tags = info.get('tags', []) or []
            except Exception as e:
                logger.warning(f"[1PORN] yt-dlp failed: {e}")

        if not stream_url:
            logger.error(f"[1PORN] Could not extract stream URL for {url}")
            return None

        if stream_url.startswith('/'):
            stream_url = 'https://www.1porn.tv' + stream_url

        return {
            "id": video_id,
            "title": title,
            "description": "",
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": stream_url,
            "playback_referer": url,
            "width": 1920,
            "height": 1080,
            "tags": tags,
            "uploader": "1Porn",
            "is_hls": '.m3u8' in stream_url,
        }

    def _yt_dlp_extract(self, url: str, opts: dict) -> Optional[dict]:
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return None
                # Pick best format with direct URL
                formats = info.get('formats') or []
                for fmt in reversed(formats):
                    u = fmt.get('url', '')
                    if u and not u.startswith('blob:') and re.search(r'\.(mp4|m3u8|webm)', u, re.I):
                        return {**info, 'url': u}
                return info
        except Exception as e:
            logger.warning(f"[1PORN] yt-dlp inner error: {e}")
            return None
