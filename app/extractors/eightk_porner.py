import re
import logging
import requests
from .base import VideoExtractor
from typing import Optional, Dict, Any

class EightKPornerExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "8KPorner"
    
    @property
    def domains(self):
        return ["8kporner.com"]
    
    def can_handle(self, url: str) -> bool:
        return any(domain in url for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info(f"Extracting metadata from 8KPorner: {url}")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://8kporner.com/'
        }
        
        try:
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code != 200:
                return None
            
            html = resp.text
            stream_url = None
            height = 720
            
            # Extract JWPlayer sources and select highest quality
            sources = []
            for match in re.finditer(r'["\']file["\']\s*:\s*["\'](https?://[^"\']+)["\']', html):
                file_url = match.group(1).replace('\\/', '/')
                # Validate as dynamic video cdn or explicit extension
                if "vkuser.net" in file_url or "vk.com" in file_url or any(ext in file_url.lower() for ext in [".mp4", ".m3u8", ".webm", ".m4v"]):
                    # Look for quality label within immediate context window
                    label = "720"
                    start_idx = max(0, match.start() - 100)
                    end_idx = min(len(html), match.end() + 100)
                    context = html[start_idx:end_idx]
                    label_match = re.search(r'["\']label["\']\s*:\s*["\'](\d+)[pP]?["\']', context)
                    if label_match:
                        label = label_match.group(1)
                    sources.append((int(label) if label.isdigit() else 720, file_url))
            
            # Fallback patterns
            if not sources:
                source_match = re.search(r'<source\s+src=["\'](https?://[^"\']+\.mp4[^"\']*)["\']', html, re.IGNORECASE)
                if source_match:
                    sources.append((720, source_match.group(1)))
                    
            if sources:
                # Sort by quality descending
                sources.sort(key=lambda x: x[0], reverse=True)
                stream_url = sources[0][1]
                height = sources[0][0]

            if not stream_url:
                return None

            # Metadata
            title = "8KPorner Video"
            title_match = re.search(r'<title>(.*?)</title>', html)
            if title_match:
                title = title_match.group(1).split('|')[0].split('-')[0].strip()
            
            thumb_url = None
            thumb_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
            if thumb_match:
                thumb_url = thumb_match.group(1)
            
            return {
                "id": url.split('/')[-1].replace('.html', '').split('_')[-1],
                "title": title,
                "description": title,
                "thumbnail": thumb_url,
                "duration": 0,
                "stream_url": stream_url,
                "width": 0,
                "height": height,
                "tags": [],
                "views": 0,
                "upload_date": None,
                "uploader": "8KPorner",
                "is_hls": ".m3u8" in stream_url.lower()
            }
        except Exception as e:
            logging.error(f"8KPorner extraction failed: {e}")
            return None
