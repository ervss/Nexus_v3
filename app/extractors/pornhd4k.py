import re
import logging
import requests
import hashlib
import random
import string
from .base import VideoExtractor
from typing import Optional, Dict, Any

class PornHD4KExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "PornHD4K"
    
    @property
    def domains(self):
        return ["pornhd4k.net"]
    
    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info(f"Extracting metadata from PornHD4K: {url}")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://pornhd4k.net/'
        }
        
        try:
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                return None
            
            html = resp.text
            
            # 1. Parse movie/episode ID
            movie_id = None
            id_match = re.search(r'episode-id=["\']([^"\']+)["\']', html)
            if id_match:
                movie_id = id_match.group(1)
            
            if not movie_id:
                # Fallback to movie JSON block
                id_match = re.search(r'id\s*:\s*["\']([^"\']+)["\']', html)
                if id_match:
                    movie_id = id_match.group(1)
            
            if not movie_id:
                logging.error(f"Could not find movie/episode ID on PornHD4K page: {url}")
                return None
            
            # 2. Cryptographic cookie & hash generation
            rand_chars = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
            md5_input = movie_id + rand_chars + "98126avrbi6m49vd7shxkn985"
            md5_hash = hashlib.md5(md5_input.encode('utf-8')).hexdigest()
            
            cookie_key = "826avrbi6m49vd7shxkn985m" + movie_id + "k06twz87wwxtp3dqiicks2df"
            cookie_value = rand_chars
            
            ajax_url = f"https://pornhd4k.net/ajax/get_sources/{movie_id}/{md5_hash}?count=1&mobile=false"
            ajax_headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Referer": url,
                "X-Requested-With": "XMLHttpRequest",
                "Cookie": f"{cookie_key}={cookie_value}"
            }
            
            ajax_resp = requests.get(ajax_url, headers=ajax_headers, timeout=10)
            if ajax_resp.status_code != 200:
                logging.error(f"PornHD4K sources AJAX request failed with status {ajax_resp.status_code}")
                return None
            
            try:
                data = ajax_resp.json()
            except Exception:
                logging.error("Failed to parse PornHD4K sources AJAX response as JSON")
                return None
                
            playlist = data.get("playlist", [])
            if not playlist:
                logging.error("PornHD4K AJAX returned empty playlist")
                return None
                
            item = playlist[0]
            sources = item.get("sources", [])
            if not sources:
                logging.error("PornHD4K playlist item contains no sources")
                return None
                
            # Grab first source stream
            stream_url = sources[0].get("file")
            if not stream_url:
                logging.error("PornHD4K source item has no file stream URL")
                return None
                
            # Clean stream URL
            stream_url = stream_url.replace('\\/', '/')
            
            # Metadata
            title = "PornHD4K Video"
            title_match = re.search(r'<title>(.*?)</title>', html)
            if title_match:
                title = title_match.group(1).split('|')[0].strip()
            
            thumb_url = item.get("image")
            if not thumb_url:
                thumb_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
                if thumb_match:
                    thumb_url = thumb_match.group(1)
            
            return {
                "id": movie_id,
                "title": title,
                "description": title,
                "thumbnail": thumb_url,
                "duration": 0,
                "stream_url": stream_url,
                "width": 0,
                "height": 720,
                "tags": [],
                "views": 0,
                "upload_date": None,
                "uploader": "PornHD4K",
                "is_hls": ".m3u8" in stream_url.lower() or "playlist" in stream_url.lower()
            }
        except Exception as e:
            logging.error(f"PornHD4K extraction failed: {e}")
            return None
