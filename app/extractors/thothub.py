import re
import logging
import aiohttp
import asyncio
import urllib.parse
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)


class ThothubExtractor(VideoExtractor):
    """Extractor for Thothub videos.

    Thothub.to runs the classic KVS engine (same family as PornTrex/WhoresHub/
    PimpBunny): watch pages carry a `flashvars` JS object with `video_url` +
    `video_alt_url*` quality tiers. Live-verified 2026-09-04: unlike PornTrex/
    WhoresHub, Thothub's flashvars URLs are SCRAMBLED — each is prefixed
    `function/0/…/get_file/<seg>/<HASH>/…` where the first 32 hex chars of
    <HASH> do not match the real file and 404 if requested as-is. The player
    unscrambles them client-side using `license_code`; confirmed by capturing
    the browser's actual `<video>.currentSrc` after playback and comparing it
    byte-for-byte against this same deobfuscation math already used for
    PimpBunny in this codebase (app/extractors/pimpbunny.py, itself a port of
    yt-dlp's generic.py `_kvs_get_real_url`/`_kvs_get_license_token`) — the
    hashes matched exactly, so the same routine is reused here rather than
    reinvented.
    """

    @property
    def name(self) -> str:
        return "Thothub"

    @property
    def domains(self):
        return ["thothub.to", "www.thothub.to"]

    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    @staticmethod
    def _clean_stream_url(raw: str) -> str:
        if not raw:
            return ""
        return raw.replace("\\/", "/").strip()

    # ── KVS get_file token deobfuscation (ported from PimpBunny/yt-dlp) ───────
    @staticmethod
    def _kvs_license_token(license_code: str) -> list[int]:
        license_code = (license_code or "").replace("$", "")
        values = [int(c) for c in license_code]
        modlicense = license_code.replace("0", "1")
        center = len(modlicense) // 2
        fronthalf = int(modlicense[: center + 1])
        backhalf = int(modlicense[center:])
        modlicense = str(4 * abs(fronthalf - backhalf))[: center + 1]
        out: list[int] = []
        mod = [int(c) for c in modlicense]
        for index, current in enumerate(mod):
            for offset in range(4):
                out.append((values[index + offset] + current) % 10)
        return out

    @classmethod
    def _kvs_real_url(cls, video_url: str, license_code: str) -> str:
        """Unscramble the `function/0/…/get_file/<seg>/<HASH>/…` token. If the
        URL isn't prefixed `function/0/` it's already a real (unscrambled)
        URL, so it passes through unchanged."""
        prefix = "function/0/"
        raw = video_url or ""
        if not raw.startswith(prefix):
            return raw
        body = raw[len(prefix):]
        if not license_code:
            return body
        parsed = urllib.parse.urlparse(body)
        parts = parsed.path.split("/")  # ['', 'get_file', '<seg>', '<HASH>', ...]
        HASH_LENGTH = 32
        seg = parts[3] if len(parts) > 3 else ""
        if len(seg) < HASH_LENGTH:
            return parsed.geturl()
        hash_ = seg[:HASH_LENGTH]
        token = cls._kvs_license_token(license_code)
        indices = list(range(HASH_LENGTH))
        accum = 0
        for src in range(HASH_LENGTH - 1, -1, -1):
            accum += token[src] if src < len(token) else 0
            dest = (src + accum) % HASH_LENGTH
            indices[src], indices[dest] = indices[dest], indices[src]
        parts[3] = "".join(hash_[i] for i in indices) + seg[HASH_LENGTH:]
        rebuilt = parsed._replace(path="/".join(parts))
        return urllib.parse.urlunparse(rebuilt)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract video metadata and direct stream URL from Thothub.
        Fast regex-based extraction, same shape as PornTrex/WhoresHub.
        """
        try:
            logger.info(f"[THOTHUB_FAST] Extracting metadata from {url}")

            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://thothub.to/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            }

            html = None
            try:
                async with aiohttp.ClientSession(headers=headers) as session:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                        if resp.status != 200:
                            logger.error(f"[THOTHUB_FAST] HTTP {resp.status} for {url}")
                            return None
                        html = await resp.text()
            except Exception as e:
                logger.error(f"[THOTHUB_FAST] Failed to fetch {url}: {e}")
                return None

            if not html:
                return None

            # Title
            title = "Thothub Video"
            title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
            if title_match:
                title = re.sub(r'\s*-\s*Thothub.*$', '', title_match.group(1), flags=re.I).strip()
            else:
                title_match = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if title_match:
                    title = title_match.group(1).strip()

            # Thumbnail
            thumbnail = None
            thumb_match = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if thumb_match:
                thumbnail = thumb_match.group(1)
            else:
                poster_match = re.search(r'poster=["\']([^"\']+)["\']', html, re.IGNORECASE)
                if poster_match:
                    thumbnail = poster_match.group(1)
            if thumbnail and thumbnail.startswith('//'):
                thumbnail = 'https:' + thumbnail

            # Duration
            duration = 0
            duration_match = re.search(r'<meta[^>]+(?:property|name)=["\'](?:video:duration|og:video:duration)["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if duration_match:
                try:
                    duration = int(duration_match.group(1))
                except Exception:
                    pass
            if duration == 0:
                fv_interval = re.search(r"timeline_screens_interval\s*:\s*'(\d+)'", html)
                fv_count = re.search(r"timeline_screens_count\s*:\s*'(\d+)'", html)
                if fv_interval and fv_count:
                    try:
                        duration = int(fv_interval.group(1)) * int(fv_count.group(1))
                    except Exception:
                        duration = 0

            # KVS flashvars quality tiers (video_url/video_alt_url*)
            stream_url = None
            width = 0
            height = 0

            fv_match = re.search(r'flashvars\s*=\s*\{(.+?)\};', html, re.DOTALL)
            if fv_match:
                fv = fv_match.group(1)
                lic_match = re.search(r"license_code\s*:\s*'([^']+)'", fv)
                license_code = lic_match.group(1) if lic_match else ""
                quality_map: Dict[int, str] = {}
                # Live-verified 2026-09-04: the base `video_url` tier often has
                # NO matching `video_url_text` label (single-quality videos),
                # so requiring both (as PornTrex's skin does) silently drops
                # the only stream this site offers. Accept the URL alone and
                # fall back to preview_height1 for the resolution guess.
                bu = re.search(r"video_url\s*:\s*'([^']+)'", fv)
                bt = re.search(r"video_url_text\s*:\s*'([^']+)'", fv)
                if bu:
                    q = re.search(r'(\d{3,4})', bt.group(1)) if bt else None
                    h = int(q.group(1)) if q else 0
                    real = self._kvs_real_url(self._clean_stream_url(bu.group(1)), license_code)
                    if "get_file" in real:
                        quality_map[h] = real
                for suffix in ['', '2', '3', '4', '5', '6', '7', '8', '9']:
                    au = re.search(rf"video_alt_url{suffix}\s*:\s*'([^']+)'", fv)
                    at = re.search(rf"video_alt_url{suffix}_text\s*:\s*'([^']+)'", fv)
                    if au:
                        q = re.search(r'(\d{3,4})', at.group(1)) if at else None
                        h = int(q.group(1)) if q else 0
                        real = self._kvs_real_url(self._clean_stream_url(au.group(1)), license_code)
                        if "get_file" in real:
                            quality_map[h] = real
                if quality_map:
                    height = max(quality_map.keys())
                    stream_url = quality_map[height]
                    if not height:
                        # No quality label anywhere — use the screenshot height,
                        # which mirrors the source resolution on this KVS family
                        # (verified against mp4 tkhd on the camwhores.tv sibling).
                        ph = re.search(r"preview_height1\s*:\s*'(\d+)'", fv)
                        height = int(ph.group(1)) if ph else 0
                    width = int(height * 16 / 9) if height else 0
                    logger.info(f"[THOTHUB_FAST] Found {height or '?'}p URL via flashvars (license={'yes' if license_code else 'no'})")

            # Fallback: raw get_file URL in the page (currentSrc shape). NOTE:
            # this only helps if the URL is already unscrambled (no
            # `function/0/` prefix in front of it) — a scrambled one needs the
            # flashvars + license_code path above.
            if not stream_url:
                gf_match = re.search(r'(https?://(?:www\.)?thothub\.to/get_file/[^\s"\'<>]+)', html, re.I)
                if gf_match:
                    stream_url = gf_match.group(1).replace('\\/', '/')
                    height = height or 720
                    width = width or 1280

            # Slow fallback: <video><source> tags
            if not stream_url:
                soup = BeautifulSoup(html, 'html.parser')
                video_tag = soup.find('video')
                if video_tag:
                    best_source = None
                    best_height = 0
                    for source in video_tag.find_all('source'):
                        src = source.get('src')
                        label = (source.get('label') or '').lower()
                        res = (source.get('res') or '').lower()
                        if src:
                            h = 0
                            if '2160' in label or '4k' in label or '2160' in res:
                                h = 2160
                            elif '1440' in label or '1440' in res:
                                h = 1440
                            elif '1080' in label or '1080' in res:
                                h = 1080
                            elif '720' in label or '720' in res:
                                h = 720
                            elif '480' in label or '480' in res:
                                h = 480
                            if h > best_height:
                                best_height = h
                                best_source = src
                    if best_source:
                        stream_url = best_source
                        height = best_height if best_height > 0 else 1080
                        width = int(height * 16 / 9)

            if not stream_url:
                logger.error(f"[THOTHUB] No stream URL found for {url}")
                return None

            # Views
            views = 0
            views_match = re.search(r'(\d+(?:,\d+)*)\s*views?', html, re.IGNORECASE)
            if views_match:
                try:
                    views = int(views_match.group(1).replace(',', ''))
                except Exception:
                    pass

            # Tags
            tags = []
            tags_matches = re.findall(r'(?:class=["\'](?:tag|category)[^>]*>|/tags?/[^"\'<>]+["\'])[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if tags_matches:
                tags = [tag.strip() for tag in tags_matches if tag.strip()]

            # Uploader
            uploader = ""
            uploader_match = re.search(r'(?:uploader|author|user|channel)[^>]*>([^<]+)</a>', html, re.IGNORECASE)
            if uploader_match:
                uploader = uploader_match.group(1).strip()

            logger.info(f"[THOTHUB_FAST] Successfully extracted: {title} ({height}p)")

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
            }

        except Exception as e:
            logger.error(f"[THOTHUB] Extraction failed for {url}: {e}", exc_info=True)
            return None
