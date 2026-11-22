import re
import asyncio
from urllib.parse import urljoin
import logging
from typing import Optional, Dict, Any
from .base import VideoExtractor

# Try importing curl_cffi for anti-bot TLS browser impersonation
try:
    from curl_cffi import requests as cffi_req
except ImportError:
    cffi_req = None

class FpoExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Fpo"

    @property
    def domains(self):
        return ["fpo.xxx"]

    def can_handle(self, url: str) -> bool:
        if not url:
            return False
        return any(domain in url.lower() for domain in self.domains)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        logging.info(f"[FpoExtractor] Extracting metadata from URL: {url}")
        
        # Ensure watch URL ends in a trailing slash (standard KVS behavior)
        cleaned_url = url.strip()
        if "/video/" in cleaned_url.lower() and not cleaned_url.endswith("/"):
            cleaned_url += "/"

        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        headers = {
            "User-Agent": ua,
            "Referer": "https://www.fpo.xxx/",
        }

        html = None
        # 1. Attempt with curl_cffi for Chrome TLS fingerprinting (bypasses Cloudflare)
        if cffi_req:
            try:
                logging.info("[FpoExtractor] Fetching page using curl_cffi...")
                resp = await asyncio.to_thread(cffi_req.get,
                    cleaned_url,
                    impersonate="chrome124",
                    headers=headers,
                    timeout=15
                )
                if resp.status_code == 200:
                    html = resp.text
                else:
                    logging.warning(f"[FpoExtractor] curl_cffi returned status code {resp.status_code}")
            except Exception as e:
                logging.warning(f"[FpoExtractor] curl_cffi failed: {e}")

        # 2. Fallback to standard requests
        if not html:
            try:
                logging.info("[FpoExtractor] Fetching page using standard requests fallback...")
                import requests
                resp = await asyncio.to_thread(requests.get, cleaned_url, headers=headers, timeout=12)
                if resp.status_code == 200:
                    html = resp.text
                else:
                    logging.warning(f"[FpoExtractor] requests returned status code {resp.status_code}")
            except Exception as e:
                logging.error(f"[FpoExtractor] requests fallback failed: {e}")

        if not html:
            logging.error(f"[FpoExtractor] Failed to retrieve HTML for {cleaned_url}")
            return None

        # Extract direct video URLs from flashvars
        # FPO.xxx is KVS based and exposes:
        # video_url: 'https://...',
        # video_alt_url: 'https://...', (which is HQ / 720p/1080p if available)
        video_url = None
        video_alt_url = None

        m_alt = re.search(r"video_alt_url\s*:\s*['\"]([^'\"]+)['\"]", html)
        if m_alt:
            video_alt_url = m_alt.group(1).replace("\\/", "/")
            logging.info(f"[FpoExtractor] Found HQ video_alt_url: {video_alt_url[:80]}")

        m_url = re.search(r"video_url\s*:\s*['\"]([^'\"]+)['\"]", html)
        if m_url:
            video_url = m_url.group(1).replace("\\/", "/")
            logging.info(f"[FpoExtractor] Found LQ video_url: {video_url[:80]}")

        # Prefer HQ video_alt_url (usually 720p/1080p) over LQ video_url
        stream_url = video_alt_url or video_url
        if not stream_url:
            # General fallback: check for video source or file pattern
            m_file = re.search(r"['\"]?file['\"]?\s*:\s*['\"](https?://[^'\"]+\.mp4[^'\"]*)['\"]", html)
            if m_file:
                stream_url = m_file.group(1).replace("\\/", "/")
            else:
                m_src = re.search(r"<source\s+src=['\"](https?://[^'\"]+\.mp4[^'\"]*)['\"]", html)
                if m_src:
                    stream_url = m_src.group(1).replace("\\/", "/")

        if not stream_url:
            logging.error(f"[FpoExtractor] Could not extract any playable stream URL from {cleaned_url}")
            return None

        if stream_url.startswith('function/0/'):
            from .pimpbunny import PimpBunnyExtractor
            license_match = re.search(r"license_code\s*:\s*['\"]([^'\"]+)['\"]", html)
            if not license_match:
                # The raw KVS token is not a usable media URL.
                return None
            stream_url = PimpBunnyExtractor._kvs_real_url(stream_url, license_match.group(1))
        stream_url = urljoin(cleaned_url, stream_url)

        # Extract Title
        title = "FPO Video"
        m_title = re.search(r"video_title\s*:\s*['\"]([^'\"]+)['\"]", html)
        if m_title:
            title = m_title.group(1).strip()
        else:
            m_og_title = re.search(r'<meta\s+property=["\']og:title["\']\s+content=["\']([^"\']+)["\']', html)
            if m_og_title:
                title = m_og_title.group(1).strip()
            else:
                m_tag_title = re.search(r"<title>(.*?)</title>", html, re.I)
                if m_tag_title:
                    title = m_tag_title.group(1).strip()
        
        # Clean title from site suffixes
        for suffix in (" - FPO.XXX", " on FPO.XXX", " Free Porn Videos"):
            if title.endswith(suffix):
                title = title[:-len(suffix)].strip()

        # Extract Thumbnail
        thumb_url = None
        m_thumb = re.search(r"preview_url\s*:\s*['\"]([^'\"]+)['\"]", html)
        if m_thumb:
            thumb_url = m_thumb.group(1).replace("\\/", "/")
        else:
            m_og_img = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html)
            if m_og_img:
                thumb_url = m_og_img.group(1).strip()

        # Extract Duration
        duration = 0
        # Check flashvars or meta tags for duration
        m_dur = re.search(r'<meta\s+property=["\']video:duration["\']\s+content=["\'](\d+)["\']', html)
        if m_dur:
            try:
                duration = int(m_dur.group(1))
            except ValueError:
                pass
        
        if not duration:
            # ISO 8601 duration parser (e.g. PT40M26S)
            m_iso = re.search(r'<meta\s+itemprop=["\']duration["\']\s+content=["\'](PT[^"\']+)["\']', html, re.I)
            if m_iso:
                raw_iso = m_iso.group(1)
                pm = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", raw_iso, re.I)
                if pm:
                    try:
                        duration = (
                            int(pm.group(1) or 0) * 3600
                            + int(pm.group(2) or 0) * 60
                            + int(pm.group(3) or 0)
                        )
                    except ValueError:
                        pass

        # Infer height/quality from stream URL if possible
        height = 0
        if "1080p" in stream_url.lower():
            height = 1080
        elif "720p" in stream_url.lower():
            height = 720
        elif "480p" in stream_url.lower():
            height = 480

        width = 1280 if height == 720 else (1920 if height == 1080 else (854 if height == 480 else 0))
        from .pimpbunny import PimpBunnyExtractor
        try:
            variants = PimpBunnyExtractor()._stream_candidates(html)
        except Exception:
            variants = []
        alternatives = [item['url'] for item in sorted(variants, key=lambda item: item.get('height', 0), reverse=True) if item['url'] != stream_url]
        remote = [url for url in alternatives if 'remote_control.php' in url]
        fallback_urls = list(dict.fromkeys([url for url in alternatives if url not in remote][:2] + remote[:1]))[:3]

        return {
            "id": None,
            "title": title,
            "description": "",
            "thumbnail": thumb_url,
            "duration": duration,
            "stream_url": stream_url,
            # FPO's KVS get_file endpoint redirects to a video CDN that keeps
            # validating the original watch-page context.  Consumers must pass
            # this through their media proxy rather than using the CDN URL as a
            # bare <video src>.
            "playback_referer": cleaned_url,
            "width": width,
            "height": height,
            "fallback_urls": fallback_urls,
            "tags": [],
            "views": 0,
            "upload_date": None,
            "uploader": "",
            "is_hls": ".m3u8" in stream_url
        }
