import logging
import re
import urllib.parse
from typing import Optional, Dict, Any
from bs4 import BeautifulSoup
from curl_cffi.requests import AsyncSession
from .base import VideoExtractor

logger = logging.getLogger(__name__)

_SHARED_BADDIEHUB_SESSION: Optional[AsyncSession] = None

async def get_baddiehub_session() -> AsyncSession:
    global _SHARED_BADDIEHUB_SESSION
    if _SHARED_BADDIEHUB_SESSION is None:
        _SHARED_BADDIEHUB_SESSION = AsyncSession(impersonate="chrome120", timeout=25, verify=False)
    return _SHARED_BADDIEHUB_SESSION

class BaddieHubExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "BaddieHub"

    def can_handle(self, url: str) -> bool:
        # Baddiehub URLs might be like baddiehub.com/video/..., but some tube sites have /v/ or /[id]-[slug]/.
        # Let's catch any baddiehub url that's not just a category or main page.
        if "baddiehub.com" not in url.lower():
            return False
        path = urllib.parse.urlparse(url).path
        if path in ("/", "/categories/", "/page/", "") or path.startswith("/?"):
            return False
        return True

    async def extract(self, url: str) -> Dict[str, Any]:
        """
        Extrakcia metadát a media streamu pre BaddieHub.com.
        """
        logger.info("[BaddieHubExtractor] Pokus o extrakciu z URL: %s", url)

        try:
            session = await get_baddiehub_session()
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Referer": "https://baddiehub.com/",
                "Accept-Language": "en-US,en;q=0.9",
            }
            resp = await session.get(url, headers=headers)
            
            if resp.status_code != 200:
                logger.error("[BaddieHubExtractor] Zlá odpoveď %s pre %s", resp.status_code, url)
                return {"error": f"HTTP {resp.status_code}"}

            html = resp.text
            soup = BeautifulSoup(html, "html.parser")

            title = None
            thumbnailUrl = None
            media_url = None
            duration = None

            # 1. Nájdenie titulku
            og_title = soup.find("meta", property="og:title")
            if og_title and og_title.get("content"):
                title = og_title["content"].strip()
            if not title:
                h1 = soup.find("h1")
                if h1:
                    title = h1.text.strip()
            if not title:
                title = soup.title.string.strip() if soup.title else "BaddieHub Video"
                
            # Odstránenie " - BaddieHub" suffixu ak existuje
            title = re.sub(r'(?i)\s*[-|]\s*BaddieHub.*$', '', title)

            # 2. Nájdenie náhľadu
            og_image = soup.find("meta", property="og:image")
            if og_image and og_image.get("content"):
                thumbnailUrl = og_image["content"].strip()

            # 3. Nájdenie zdroja videa (media_url)
            # a) Hľadanie v klasickom HTML5 prehrávači
            video_tag = soup.find("video")
            if video_tag:
                source_tag = video_tag.find("source")
                if source_tag and source_tag.get("src"):
                    media_url = source_tag["src"]
                elif video_tag.get("src"):
                    media_url = video_tag["src"]

            # b) Hľadanie iframu, ak ide o vložené video (často bunkr, dood atď.)
            if not media_url:
                for iframe in soup.find_all("iframe"):
                    src = iframe.get("src", "")
                    if "bunkr" in src.lower() or "dood" in src.lower() or "voe" in src.lower() or "streamtape" in src.lower() or "filemoon" in src.lower():
                        media_url = src
                        break

            # Ak sme stále nenašli, skúsime regex na source src
            if not media_url:
                match = re.search(r'src=["\']([^"\']+\.(?:mp4|m3u8)[^"\']*)["\']', html)
                if match:
                    media_url = match.group(1)

            if media_url and media_url.startswith("//"):
                media_url = "https:" + media_url

            if not media_url:
                logger.warning("[BaddieHubExtractor] Video URL nenájdené na stránke %s", url)
                return {"error": "Video URL nenájdené"}

            return {
                "title": title,
                "thumbnailUrl": thumbnailUrl,
                "duration": duration,
                "media_streams": [
                    {"url": media_url, "quality": "Auto", "format": "mp4" if ".mp4" in media_url else "hls"}
                ],
                "extractor": self.name
            }

        except Exception as e:
            logger.exception("[BaddieHubExtractor] Chyba pri spracovaní url: %s", url)
            return {"error": str(e)}
