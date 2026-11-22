import logging
import re
import aiohttp
import asyncio
from typing import Optional, Dict, Any
from bs4 import BeautifulSoup
import yt_dlp

from .base import VideoExtractor
from .registry import ExtractorRegistry

logger = logging.getLogger(__name__)

class FreepornfunExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "FreePornFun"

    def can_handle(self, url: str) -> bool:
        return "freepornfun.com" in url.lower()

    async def _check_direct_size(self, url: str, session: aiohttp.ClientSession) -> Optional[Dict[str, Any]]:
        try:
            async with session.head(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                size = int(resp.headers.get('Content-Length', 0))
                return {
                    "stream_url": url,
                    "size_bytes": size,
                    "height": 0
                }
        except Exception as e:
            logger.debug(f"FreePornFun direct check failed for {url}: {e}")
            return None

    async def _resolve_embed(self, url: str) -> Optional[Dict[str, Any]]:
        # 1. Try internal extractor
        extractor = ExtractorRegistry.find_extractor(url)
        if extractor and extractor.name != self.name:
            try:
                res = await extractor.extract(url)
                if res and res.get('stream_url'):
                    return {
                        "stream_url": res.get("stream_url"),
                        "size_bytes": res.get("size_bytes", 0),
                        "height": res.get("height", 0)
                    }
            except Exception as e:
                logger.debug(f"FreePornFun internal extraction failed for {url}: {e}")
        
        # 2. Try yt-dlp fallback
        def run_ytdlp():
            ydl_opts = {'quiet': True, 'no_warnings': True}
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    if 'entries' in info:
                        info = info['entries'][0]
                    
                    formats = info.get('formats', [])
                    best_size = info.get('filesize') or info.get('filesize_approx') or 0
                    best_url = info.get('url')
                    best_height = info.get('height') or 0
                    
                    for f in formats:
                        sz = f.get('filesize') or f.get('filesize_approx') or 0
                        h = f.get('height') or 0
                        # Pick by size, fallback to height
                        if sz > best_size or (sz == best_size and h > best_height):
                            best_size = sz
                            best_height = h
                            best_url = f.get('url')
                            
                    if best_url:
                        return {
                            "stream_url": best_url,
                            "size_bytes": best_size,
                            "height": best_height
                        }
            except Exception as e:
                logger.debug(f"FreePornFun yt-dlp failed for {url}: {e}")
            return None
            
        res = await asyncio.to_thread(run_ytdlp)
        if res:
            return res

        # 3. Fallback: Generic fetch and regex for mp4
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://freepornfun.com/'
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=10) as resp:
                    html = await resp.text()
                    mp4s = re.findall(r'https?://[^\s"\'\\]+\.mp4[^\s"\'\\]*', html)
                    if mp4s:
                        best_mp4 = mp4s[0]
                        # try to find largest
                        best_size = 0
                        for m in set(mp4s):
                            try:
                                async with session.head(m, timeout=3) as h_resp:
                                    sz = int(h_resp.headers.get('Content-Length', 0))
                                    if sz > best_size:
                                        best_size = sz
                                        best_mp4 = m
                            except: pass
                            
                        return {
                            "stream_url": best_mp4,
                            "size_bytes": best_size,
                            "height": 720
                        }
        except Exception as e:
            logger.debug(f"FreePornFun generic fallback failed for {url}: {e}")
            
        return None

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://freepornfun.com/'
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status != 200:
                        logger.error(f"FreePornFun extraction failed, status {resp.status} for {url}")
                        return None
                    html = await resp.text()

            # Extract Title
            title = "Free Porn Fun Video"
            m_title = re.search(r'video_title\\?":\\?"(.*?)\\?"', html)
            if m_title:
                title = m_title.group(1).replace('\\u0026', '&').encode('utf-8').decode('unicode_escape', errors='ignore')
            else:
                soup = BeautifulSoup(html, 'html.parser')
                title_tag = soup.find('title')
                if title_tag:
                    title = title_tag.get_text(strip=True).replace(' | Free Porn Fun', '')

            # Extract Thumbnail
            thumbnail = ""
            m_thumb = re.search(r'image_details\\?":\[\\?"(https?://.*?)\\?"', html)
            if m_thumb:
                thumbnail = m_thumb.group(1).replace('\\/', '/')
            else:
                m_og = re.search(r'property="og:image"\s+content="([^"]+)"', html)
                if m_og:
                    thumbnail = m_og.group(1)

            # Find all candidate URLs
            candidates = set()
            
            # Embed URLs
            m_embeds = re.findall(r'embed_url\\?":\\?"(https?://.*?)\\?"', html)
            for e in m_embeds:
                u = e.replace('\\/', '/').split('&')[0].split('\\u0026')[0]
                if u and not u.endswith('.jpg') and not u.endswith('.png'):
                    candidates.add(u)
                    
            # Any Next.js strings looking like stream URLs (streamtape, doodstream, hqporner, miiixdrop, mydaddy, etc)
            m_next = re.findall(r'https?://(?:www\.)?(?:streamtape\.com|doodstream\.com|hqporner\.com|miiixdrop\.net|mydaddy\.cc)[^\s"\'\\]+', html)
            for u in m_next:
                candidates.add(u)
                
            # Direct MP4 URLs
            m_mp4 = re.findall(r'https?://[^\s"\'\\]+\.mp4[^\s"\'\\]*', html)
            for u in m_mp4:
                candidates.add(u.replace('\\/', '/'))

            if not candidates:
                logger.error(f"FreePornFun: No candidate servers found for {url}")
                return None

            logger.info(f"FreePornFun: Found {len(candidates)} candidates for {url}")

            # Concurrently resolve candidates
            async with aiohttp.ClientSession(headers=headers) as session:
                tasks = []
                for c in candidates:
                    if '.mp4' in c.lower() or '.m3u8' in c.lower():
                        tasks.append(self._check_direct_size(c, session))
                    else:
                        tasks.append(self._resolve_embed(c))
                        
                results = await asyncio.gather(*tasks, return_exceptions=True)

            valid_results = []
            for r in results:
                if isinstance(r, dict) and r.get('stream_url'):
                    valid_results.append(r)

            if not valid_results:
                logger.error(f"FreePornFun: Could not resolve any stream URLs for {url}")
                return None

            # Sort by size first, then height
            valid_results.sort(key=lambda x: (x.get('size_bytes', 0), x.get('height', 0)), reverse=True)
            
            best = valid_results[0]
            stream_url = best['stream_url']
            size = best.get('size_bytes', 0)
            height = best.get('height', 720)

            # Extract ID
            video_id = ""
            m_id = re.search(r'/post/[^/]+/([^/]+)', url)
            if m_id:
                video_id = m_id.group(1)
            else:
                video_id = url.rstrip('/').split('/')[-1]

            return {
                "id": video_id,
                "title": title,
                "description": title,
                "thumbnail": thumbnail,
                "duration": 0.0,
                "stream_url": stream_url,
                "width": 0,
                "height": height,
                "size_bytes": size,
                "tags": [],
                "uploader": "FreePornFun",
                "is_hls": '.m3u8' in stream_url.lower(),
            }

        except Exception as e:
            logger.error(f"FreePornFun extraction failed for {url}: {e}", exc_info=True)
            return None
