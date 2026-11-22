import re
import logging
from typing import Optional, Dict, Any
from .base import VideoExtractor
from bs4 import BeautifulSoup
import httpx

logger = logging.getLogger(__name__)

class PornonahobkaExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Pornonahobka"

    def can_handle(self, url: str) -> bool:
        return "pornonahobka.icu" in url.lower()

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extracts metadata from pornonahobka.icu.
        Uses the rich metadata available in the site's HTML (DLE engine).
        """
        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                headers = {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                }
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
                html = resp.text

            soup = BeautifulSoup(html, 'html.parser')

            # Extract using ya:ovs and og tags
            def get_meta(property_name):
                tag = soup.find("meta", property=property_name) or soup.find("meta", name=property_name)
                return tag["content"] if tag and tag.has_attr("content") else None

            title = get_meta("og:title") or soup.find("h1").text.strip() if soup.find("h1") else "Unknown Title"
            thumbnail = get_meta("og:image") or get_meta("ya:ovs:poster")
            duration_raw = get_meta("video:duration") or get_meta("ya:ovs:duration")
            
            # Duration parsing
            duration = 0
            if duration_raw:
                try:
                    duration = int(duration_raw)
                except ValueError:
                    # Try parsing PT14M2S format if present
                    match = re.search(r'PT(?:(\d+)M)?(?:(\d+)S)?', duration_raw)
                    if match:
                        m = int(match.group(1) or 0)
                        s = int(match.group(2) or 0)
                        duration = m * 60 + s

            # Stream URL - the site has ya:ovs:content_url pointing to the mp4
            stream_url = get_meta("ya:ovs:content_url")
            
            # Fallback for stream_url: check for pornoembed.info iframe
            if not stream_url:
                iframe = soup.find("iframe", src=re.compile(r"pornoembed\.info/embed/"))
                if iframe:
                    # We can't easily get the direct MP4 from just the embed URL without further scraping,
                    # but if ya:ovs:content_url is present, it's much better.
                    # If not, we'll return the embed URL as stream_url and hope the player handles it,
                    # or the extension will capture the actual MP4 during playback.
                    stream_url = iframe["src"]

            # Tags and categories
            tags = []
            tag_metas = soup.find_all("meta", property="video:tag")
            for t in tag_metas:
                if t.has_attr("content"):
                    content = t["content"]
                    if "," in content:
                        tags.extend([tag.strip() for tag in content.split(",")])
                    else:
                        tags.append(content.strip())
            
            if not tags:
                keywords = get_meta("keywords")
                if keywords:
                    tags = [k.strip() for k in keywords.split(",")]

            source_id = get_meta("ya:ovs:id") or re.search(r'/(\d+)-', url).group(1) if re.search(r'/(\d+)-', url) else url

            return {
                "id": source_id,
                "title": title,
                "description": get_meta("og:description") or "",
                "thumbnail": thumbnail,
                "duration": duration,
                "stream_url": stream_url,
                "tags": tags,
                "is_hls": ".m3u8" in (stream_url or "").lower()
            }

        except Exception as e:
            logger.error(f"Pornonahobka extraction failed: {e}")
            return None
