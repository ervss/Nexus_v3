import re
import logging
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor, ntc_get

logger = logging.getLogger(__name__)


class PorntrexExtractor(VideoExtractor):
    """Extractor for Porntrex videos."""

    @property
    def name(self) -> str:
        return "Porntrex"

    @property
    def domains(self):
        return ["porntrex.com", "www.porntrex.com"]

    def can_handle(self, url: str) -> bool:
        """Check if this extractor can handle the given URL."""
        return any(domain in url for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract video metadata and direct stream URL from Porntrex.
        OPTIMIZED: Fast regex-based extraction, similar to Eporner.

        Args:
            url: Porntrex video URL

        Returns:
            Dictionary with video metadata or None if extraction fails
        """
        try:
            logger.info(f"[PORNTREX_FAST] Extracting metadata from {url}")

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.porntrex.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            }

            # Fetch page asynchronously
            html = None
            try:
                html = await ntc_get(url, domain="porntrex.com", headers=headers, deadline=28.0)
            except Exception as e:
                logger.error(f"[PORNTREX_FAST] Failed to fetch {url}: {e}")
                return None

            if not html:
                return None

            # FAST PATH: Extract metadata using REGEX FIRST (avoid BeautifulSoup overhead)

            # Extract title - FAST regex first
            title = "Porntrex Video"
            title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
            if title_match:
                title = title_match.group(1).replace(' - PORNTREX', '').replace(' - Porntrex', '').strip()
            else:
                # Fallback: og:title meta tag
                title_match = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if title_match:
                    title = title_match.group(1).strip()

            # Extract thumbnail - FAST regex
            thumbnail = None
            thumb_match = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if thumb_match:
                thumbnail = thumb_match.group(1)
            else:
                # Fallback: poster attribute
                poster_match = re.search(r'poster=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if poster_match:
                    thumbnail = poster_match.group(1)

            # Extract duration via timeline_screens_interval * timeline_screens_count
            # NOTE: The generic 'duration' regex picks up adv_pre_skip_duration (5s ad skip)!
            duration = 0
            fv_interval = re.search(r"timeline_screens_interval\s*:\s*'(\d+)'", html)
            fv_count = re.search(r"timeline_screens_count\s*:\s*'(\d+)'", html)
            if fv_interval and fv_count:
                try:
                    duration = int(fv_interval.group(1)) * int(fv_count.group(1))
                except Exception:
                    duration = 0
            if duration == 0:
                # Fallback: meta video:duration
                duration_match = re.search(r'<meta[^>]+(?:property|name)=["\'](?:video:duration|og:video:duration)["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if duration_match:
                    try:
                        duration = int(duration_match.group(1))
                    except Exception:
                        pass

            # FAST PATH: Extract video sources from flashvars (video_url, video_alt_url, video_alt_url2, ...)
            # This is the most reliable source — flashvars contains all quality options with text labels
            stream_url = None
            width = 0
            height = 0
            quality_map = {}

            fv_match = re.search(r'var\s+flashvars\s*=\s*\{(.+?)\};', html, re.DOTALL)
            if fv_match:
                fv = fv_match.group(1)
                quality_map = {}
                # Base URL
                bu = re.search(r"video_url\s*:\s*'([^']+)'", fv)
                bt = re.search(r"video_url_text\s*:\s*'([^']+)'", fv)
                if bu and bt:
                    q = re.search(r'(\d{3,4})', bt.group(1))
                    h = int(q.group(1)) if q else 480
                    quality_map[h] = bu.group(1).rstrip('/')
                # Alt URLs (video_alt_url, video_alt_url2 ... video_alt_url9)
                for suffix in ['', '2', '3', '4', '5', '6', '7', '8', '9']:
                    au = re.search(rf"video_alt_url{suffix}\s*:\s*'([^']+)'", fv)
                    at = re.search(rf"video_alt_url{suffix}_text\s*:\s*'([^']+)'", fv)
                    if au and at:
                        q = re.search(r'(\d{3,4})', at.group(1))
                        h = int(q.group(1)) if q else 480
                        quality_map[h] = au.group(1).rstrip('/')
                if quality_map:
                    height = max(quality_map.keys())
                    width = int(height * 16 / 9)
                    stream_url = quality_map[height]
                    logger.info(f"[PORNTREX_FAST] Found {height}p URL via flashvars")


            # Strategy 3: SLOW FALLBACK - Parse video tag sources
            if not stream_url:
                logger.info(f"[PORNTREX_FAST] Regex extraction failed, trying video tag parsing...")
                soup = BeautifulSoup(html, 'html.parser')
                video_tag = soup.find('video')
                if video_tag:
                    source_tags = video_tag.find_all('source')
                    best_source = None
                    best_height = 0

                    for source in source_tags:
                        src = source.get('src')
                        label = source.get('label', '').lower()
                        res = source.get('res', '').lower()

                        if src:
                            h = 0
                            if '2160' in label or '4k' in label or '2160' in res: h = 2160
                            elif '1440' in label or '1440' in res: h = 1440
                            elif '1080' in label or '1080' in res: h = 1080
                            elif '720' in label or '720' in res: h = 720
                            elif '480' in label or '480' in res: h = 480

                            if h > best_height:
                                best_height = h
                                best_source = src

                    if best_source:
                        stream_url = best_source
                        height = best_height if best_height > 0 else 1080
                        width = int(height * 16 / 9)

            if not stream_url:
                logger.error(f"[PORNTREX] No stream URL found for {url}")
                return None

            # Extract views - FAST regex
            views = 0
            views_match = re.search(r'(\d+(?:,\d+)*)\s*views?', html, re.IGNORECASE)
            if views_match:
                try: views = int(views_match.group(1).replace(',', ''))
                except: pass

            # Extract tags - FAST regex
            tags = []
            tags_matches = re.findall(r'(?:class=["\'](?:tag|category)[^>]*>|/tags?/[^"\'<>]+["\'])[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if tags_matches:
                tags = [tag.strip() for tag in tags_matches if tag.strip()]

            # Extract uploader - FAST regex
            uploader = ""
            uploader_match = re.search(r'(?:uploader|author|user)[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if uploader_match:
                uploader = uploader_match.group(1).strip()

            logger.info(f"[PORNTREX_FAST] Successfully extracted: {title} ({height}p)")

            return {
                "id": None,
                "title": title,
                "description": "",
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "width": width,
                "height": height,
                "tags": tags,
                "views": views,
                "upload_date": None,
                "uploader": uploader,
                "is_hls": False,
                "fallback_urls": [quality_map[h] for h in sorted(quality_map, reverse=True) if quality_map[h] != stream_url][:3],
            }

        except Exception as e:
            logger.error(f"[PORNTREX] Extraction failed for {url}: {e}", exc_info=True)
            return None
