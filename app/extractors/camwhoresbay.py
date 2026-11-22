import html as html_lib
import re
import logging
import aiohttp
import asyncio
from bs4 import BeautifulSoup
from curl_cffi import requests as cr
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)


class CamwhoresbayExtractor(VideoExtractor):
    """Extractor for CamWhoresBay videos.

    CamWhoresBay.com is a close sibling of Camwhores.tv — same operator, same
    KVS getEmbed/get_file/kt_player template, different domain/brand
    (live-verified 2026-09-04: /latest-updates/ has 70 active cards, watch
    pages use the same script pattern). This extractor mirrors the fast
    flashvars-based path CamwhoresExtractor uses for its non-Playwright
    fallback, rather than the full multi-path (curl_cffi/Playwright) resolver
    — that one is tuned against camwhores.tv's specific CDN/CF behaviour which
    hasn't been live-verified here. If get_file probing on camwhoresbay.com
    turns out to need the heavier Playwright path too, promote this file to
    mirror app/extractors/camwhores.py's full CamwhoresExtractor.
    """

    @property
    def name(self) -> str:
        return "CamWhoresBay"

    @property
    def domains(self):
        return ["camwhoresbay.com", "www.camwhoresbay.com"]

    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    @staticmethod
    def _parse_flashvars(html: str) -> Dict[str, str]:
        if not html:
            return {}
        m = re.search(r"var\s+flashvars\s*=\s*\{(.+?)\};", html, re.S)
        if not m:
            m = re.search(r"flashvars\s*=\s*\{(.+?)\};", html, re.S)
        if not m:
            return {}
        out: Dict[str, str] = {}
        for k, v in re.findall(r"(\w+)\s*:\s*'([^']*)'", m.group(1)):
            out[k] = v.replace('\\/', '/')
        return out

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract video metadata and direct stream URL from CamWhoresBay.
        Fast regex/flashvars-based extraction, same shape as PornTrex/WhoresHub
        and the fast path of CamwhoresExtractor.
        """
        try:
            logger.info(f"[CAMWHORESBAY_FAST] Extracting metadata from {url}")

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.camwhoresbay.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            }

            html = None
            # Prefer curl_cffi (Chrome TLS impersonation + system DNS) — aiohttp's
            # resolver frequently times out on camwhoresbay.com on Windows.
            try:
                def _fetch_sync():
                    resp = cr.get(
                        url,
                        headers=headers,
                        impersonate="chrome",
                        timeout=15,
                        allow_redirects=True,
                    )
                    return resp.status_code, resp.text

                status, body = await asyncio.to_thread(_fetch_sync)
                if status == 200 and body:
                    html = body
                else:
                    logger.warning(f"[CAMWHORESBAY_FAST] curl_cffi HTTP {status} for {url}")
            except Exception as e:
                logger.warning(f"[CAMWHORESBAY_FAST] curl_cffi failed for {url}: {e}")

            if not html:
                try:
                    async with aiohttp.ClientSession(headers=headers) as session:
                        async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                            if resp.status != 200:
                                logger.error(f"[CAMWHORESBAY_FAST] HTTP {resp.status} for {url}")
                                return None
                            html = await resp.text()
                except Exception as e:
                    logger.error(f"[CAMWHORESBAY_FAST] Failed to fetch {url}: {e}")
                    return None

            if not html:
                return None

            flashvars = self._parse_flashvars(html)

            # Title
            title = flashvars.get("video_title") or "CamWhoresBay Video"
            if title == "CamWhoresBay Video":
                title_match = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if title_match:
                    title = title_match.group(1).strip()
                else:
                    title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
                    if title_match:
                        title = re.sub(r'\s*-\s*CamWhoresBay.*$', '', title_match.group(1), flags=re.I).strip()

            # Thumbnail
            thumbnail = flashvars.get("preview_url1") or flashvars.get("preview_url") or None
            if not thumbnail:
                thumb_match = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if thumb_match:
                    thumbnail = thumb_match.group(1)
            if thumbnail and thumbnail.startswith('//'):
                thumbnail = 'https:' + thumbnail

            # Duration
            duration = 0
            duration_match = re.search(r'<meta\s+property=["\']video:duration["\']\s+content=["\'](\d+)["\']', html, re.IGNORECASE)
            if duration_match:
                try:
                    duration = int(duration_match.group(1))
                except Exception:
                    pass

            # Height: preview_height1 mirrors the video's real resolution on the
            # camwhores.tv sibling site (verified against mp4 tkhd there); apply
            # the same read here, falling back to explicit video_height.
            height = 0
            raw_height = flashvars.get("preview_height1") or flashvars.get("video_height") or ""
            if str(raw_height).isdigit():
                height = int(raw_height)

            # Stream URL via KVS flashvars quality tiers, same as camwhores.tv.
            stream_url = None
            quality_map: Dict[int, str] = {}
            bu = flashvars.get("video_url")
            if bu and bu.startswith("http"):
                quality_map[height or 480] = html_lib.unescape(bu)
            for suffix in ['', '2', '3', '4', '5', '6', '7', '8', '9']:
                au = flashvars.get(f"video_alt_url{suffix}")
                at = flashvars.get(f"video_alt_url{suffix}_text")
                if au and au.startswith("http"):
                    h = 0
                    if at:
                        q = re.search(r'(\d{3,4})', at)
                        h = int(q.group(1)) if q else 0
                    quality_map[h or (480 + len(quality_map) * 240)] = html_lib.unescape(au)
            if quality_map:
                best_h = max(quality_map.keys())
                stream_url = quality_map[best_h]
                if best_h:
                    height = best_h

            # Fallback: raw get_file URL in the page.
            if not stream_url:
                gf_match = re.search(
                    r'(https?://(?:www\.)?camwhoresbay\.com/get_file/[^\s"\'<>]+)', html, re.I)
                if gf_match:
                    stream_url = gf_match.group(1).replace('\\/', '/')

            if not stream_url:
                soup = BeautifulSoup(html, 'html.parser')
                video_tag = soup.find('video')
                if video_tag:
                    src = video_tag.get('src')
                    if src:
                        stream_url = src
                    else:
                        source_tag = video_tag.find('source')
                        if source_tag and source_tag.get('src'):
                            stream_url = source_tag.get('src')

            if not stream_url:
                logger.error(f"[CAMWHORESBAY] No stream URL found for {url}")
                return None

            width = int(height * 16 / 9) if height else 0

            # Tags/categories/models (same flashvars keys as camwhores.tv)
            tags = [t.strip() for t in re.split(r"[,\|]", flashvars.get("video_tags") or "") if t.strip()]

            uploader = ""
            member = re.search(
                r'<a[^>]+href=["\'][^"\']*/members/(\d+)/?[^"\']*["\'][^>]*>(.*?)</a>',
                html, re.I | re.S,
            )
            if member:
                uploader = re.sub(r"<[^>]+>", "", member.group(2)).strip()

            logger.info(f"[CAMWHORESBAY_FAST] Successfully extracted: {title} ({height}p)")

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
                "views": 0,
                "upload_date": None,
                "uploader": uploader,
                "is_hls": False,
            }

        except Exception as e:
            logger.error(f"[CAMWHORESBAY] Extraction failed for {url}: {e}", exc_info=True)
            return None
