import re
import logging
import httpx
import urllib.parse
from bs4 import BeautifulSoup
from typing import Optional, Dict, Any
from .base import VideoExtractor

logger = logging.getLogger(__name__)

class LuluStreamExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "LuluStream"

    def can_handle(self, url: str) -> bool:
        domains = ["lulustream.com", "luluvid.com", "luluvdo.com", "lulu.stream", "luluvid.net", "luluvids.com", "luluvids.top", "lulust.com", "lplaygo.com"]
        return any(domain in url.lower() for domain in domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        if not url.startswith('http'):
            url = 'https://' + url
        # Normalize /d/CODE or bare /CODE to /e/CODE, keeping working domains
        # (lulustream.com redirects automatically to active mirror e.g. lplaygo.com)
        code_match = re.search(
            r'https?://(?:[^/]+\.)?(?:luluvid|lulustream|luluvdo|luluvids|lulu\.stream|lulust|lplaygo)\.(?:com|net|top)/(?:(?:e|d)/)?([^/?#]+)',
            url, re.IGNORECASE
        )
        code = code_match.group(1) if code_match else url.split('/')[-1].split('?')[0]
        candidate_urls = [
            f"https://lulustream.com/e/{code}",
            f"https://lplaygo.com/e/{code}",
            f"https://luluvdo.com/e/{code}",
        ]
        # Keep original URL first if it's already an /e/ URL on a non-dead host
        if "/e/" in url and "luluvdo.com" not in url.lower() and "luluvid.com" not in url.lower():
            candidate_urls.insert(0, url)
        candidate_urls = list(dict.fromkeys(candidate_urls))

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Referer': 'https://lulustream.com/'
        }

        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True, verify=False) as client:
                html = ""
                final_url = url
                for cand in candidate_urls:
                    try:
                        resp = await client.get(cand, headers=headers)
                        if resp.status_code == 200 and resp.text:
                            html = resp.text
                            final_url = str(resp.url)
                            break
                    except Exception as fetch_err:
                        logger.debug(f"LuluStream: Candidate {cand} failed: {fetch_err}")
                if not html:
                    logger.warning(f"LuluStream: Failed to fetch {url} from all candidates")
                    return None
                
                soup = BeautifulSoup(html, 'html.parser')
                
                # 1. Try to find the Packer-obfuscated script
                stream_url = None
                packer_match = re.search(r'eval\(function\(p,a,c,k,e,d\).*?\.split\(\'\|\'\)\)\)', html)
                if packer_match:
                    packed_js = packer_match.group(0)
                    unpacked = self._unpack_packer(packed_js)
                    if unpacked:
                        # Search for master.m3u8 or similar in unpacked JS
                        m3u8_match = re.search(r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', unpacked)
                        if m3u8_match:
                            stream_url = m3u8_match.group(1)
                            logger.info(f"LuluStream: Extracted stream from unpacked JS: {stream_url}")

                # 2. Fallback: Check for sources in setup scripts
                if not stream_url:
                    match = re.search(r'sources\s*:\s*\[\s*{\s*file\s*:\s*["\']([^"\']+)["\']', html)
                    if match:
                        stream_url = match.group(1)
                        logger.info(f"LuluStream: Found stream in setup script: {stream_url}")

                if not stream_url:
                    logger.warning(f"LuluStream: Could not find stream URL in {url}")
                    return None

                # Extract Metadata
                title = ""
                og_title = soup.find('meta', attrs={'name': 'og:title'}) or soup.find('meta', property='og:title')
                if og_title:
                    title = og_title.get('content', '').strip()
                if not title:
                    title_tag = soup.find('title')
                    if title_tag:
                        title = title_tag.text.strip()
                        title = re.sub(r'\s*-\s*LuluStream.*$', '', title, flags=re.IGNORECASE).strip()

                thumbnail = ""
                og_image = (soup.find('meta', attrs={'name': 'og:image'})
                            or soup.find('meta', property='og:image')
                            or soup.find('meta', attrs={'name': 'twitter:image'}))
                if og_image:
                    thumbnail = og_image.get('content', '').strip()
                # Fallback: construct from video code (lulucdn.com pattern)
                if not thumbnail:
                    code = url.split('/e/')[-1].split('?')[0].strip()
                    if code:
                        thumbnail = f"https://img.lulucdn.com/{code}_xt.jpg"

                return {
                    "id": url.split('/')[-1].split('?')[0],
                    "title": title or "LuluStream Video",
                    "description": "",
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "stream_url": stream_url,
                    "is_hls": ".m3u8" in stream_url.lower(),
                    "extractor": self.name
                }
                
        except Exception as e:
            logger.error(f"LuluStream extraction failed for {url}: {e}")
            return None

    def _unpack_packer(self, packed_js: str) -> Optional[str]:
        """Simple LuluStream-specific Packer unpacker logic."""
        try:
            # Extract p, a, c, k, e, d
            match = re.search(r"}\s*\('(.*)',\s*(\d+),\s*(\d+),\s*'(.*)'\.split\('\|'\)", packed_js)
            if not match:
                return None
            
            p, a, c, k = match.groups()
            a = int(a)
            c = int(c)
            k = k.split('|')
            
            def baseN(num, b):
                if num == 0: return '0'
                digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                res = ""
                while num:
                    res = digits[num % b] + res
                    num //= b
                return res

            # Replacement logic
            for i in range(c - 1, -1, -1):
                if k[i]:
                    p = re.sub(r'\b' + baseN(i, a) + r'\b', k[i], p)
            
            return p
        except Exception as e:
            logger.error(f"LuluStream: Packer unpacking failed: {e}")
            return None
