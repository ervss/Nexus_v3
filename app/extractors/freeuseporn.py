import logging
import re
import aiohttp
from typing import Optional, Dict, Any
from bs4 import BeautifulSoup

from .base import VideoExtractor

logger = logging.getLogger(__name__)

class FreeusepornExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Freeuseporn"

    def can_handle(self, url: str) -> bool:
        return "freeuseporn.com" in url.lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Referer': 'https://www.freeuseporn.com/'
            }
            async with aiohttp.ClientSession(headers=headers) as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                    if resp.status != 200:
                        logger.error(f"Freeuseporn extraction failed, status {resp.status} for {url}")
                        return None
                    html = await resp.text()

            soup = BeautifulSoup(html, 'html.parser')

            # Extract title
            title = ""
            title_tag = soup.find('h1') or soup.find('h2', class_='title')
            if title_tag:
                title = title_tag.get_text(strip=True)
            if not title and soup.title:
                title = soup.title.get_text(strip=True)
            
            title = re.sub(r'(?i)\s*-\s*Freeuseporn(?:\.com)?\s*$', '', title).strip()
            if not title:
                title = "Freeuseporn Video"

            # Extract thumbnail
            thumbnail = ""
            video_tag = soup.find('video')
            if video_tag and video_tag.get('poster'):
                thumbnail = video_tag.get('poster')
            
            if not thumbnail:
                og_image = soup.find('meta', property='og:image')
                if og_image:
                    thumbnail = og_image.get('content', '')

            if thumbnail and thumbnail.startswith('/'):
                thumbnail = f"https://www.freeuseporn.com{thumbnail}"

            # Extract video URL (highest resolution first)
            stream_url = None
            height = 0
            
            if video_tag:
                sources = video_tag.find_all('source')
                
                best_source = None
                best_res = 0
                
                for source in sources:
                    src_url = source.get('src')
                    if not src_url:
                        continue
                        
                    res_str = source.get('res') or source.get('label') or '0'
                    res_val = 0
                    try:
                        res_val = int(re.sub(r'\D', '', res_str))
                    except ValueError:
                        if '1080' in src_url: res_val = 1080
                        elif '720' in src_url: res_val = 720
                        elif '480' in src_url: res_val = 480
                    
                    if res_val > best_res:
                        best_res = res_val
                        best_source = src_url
                        
                if best_source:
                    stream_url = best_source
                    height = best_res

            if not stream_url:
                # Fallback: regex search for mp4
                mp4_matches = re.findall(r'https?://[^"\']+\.mp4', html)
                if mp4_matches:
                    stream_url = mp4_matches[0]
                    if '1080' in stream_url: height = 1080
                    elif '720' in stream_url: height = 720
                    elif '480' in stream_url: height = 480
                    else: height = 720

            if not stream_url:
                logger.error(f"Freeuseporn: No stream URL found for {url}")
                return None
                
            if stream_url.startswith('/'):
                stream_url = f"https://www.freeuseporn.com{stream_url}"

            # ID
            video_id = ""
            m = re.search(r'/video/(\d+)', url)
            if m:
                video_id = m.group(1)
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
                "height": height or 720,
                "size_bytes": 0,
                "tags": [],
                "uploader": "Freeuseporn",
                "is_hls": '.m3u8' in stream_url.lower(),
            }

        except Exception as e:
            logger.error(f"Freeuseporn extraction failed for {url}: {e}", exc_info=True)
            return None
