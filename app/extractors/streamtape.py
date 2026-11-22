import requests
import re
import logging
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class StreamtapeExtractor:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": "https://streamtape.com/",
        })

    def can_handle(self, url: str) -> bool:
        return "streamtape.com" in url

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")

            # Title
            title_el = soup.find("h2") or soup.find("h1") or soup.find("title")
            title = title_el.get_text(strip=True) if title_el else "Streamtape Video"
            title = re.sub(r'\s*at\s+Streamtape\.com\s*$', '', title, flags=re.I).strip()
            title = re.sub(r'\.mp4$', '', title, flags=re.I).strip()

            # Direct stream URL — ideoooolink div has the real token
            stream_url = None
            link_div = soup.find(id="ideoooolink")
            if link_div:
                raw = link_div.get_text(strip=True)
                # Format: /streamtape.com/get_video?... (single slash — prepend https:/)
                if raw.startswith("//"):
                    raw = "https:" + raw
                elif raw.startswith("/"):
                    raw = "https:/" + raw
                stream_url = raw

            if not stream_url:
                # Fallback: scan page for get_video URLs (first one is real, second has fake token)
                matches = re.findall(r'/streamtape\.com/get_video\?[^\s"\'<>]+', resp.text)
                if matches:
                    stream_url = "https:/" + matches[0]

            if not stream_url:
                return None

            # Thumbnail — video poster or og:image
            thumbnail = ""
            video_el = soup.find("video", id="mainvideo")
            if video_el and video_el.get("poster"):
                thumbnail = video_el["poster"]
            if not thumbnail:
                og_img = soup.find("meta", property="og:image")
                if og_img:
                    thumbnail = og_img.get("content", "")

            # Duration — not available on page, try HEAD on stream URL
            duration = 0

            return {
                "title": title,
                "stream_url": stream_url,
                "thumbnail": thumbnail,
                "duration": duration,
                "source_url": url,
                "is_hls": False,
            }
        except Exception as e:
            logger.error(f"[Streamtape] extract error for {url}: {e}")
            return None
