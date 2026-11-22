import re
import asyncio
import logging
from urllib.parse import urlparse
from curl_cffi import requests as crequests
from .base import VideoExtractor as BaseExtractor

logger = logging.getLogger(__name__)

# Civitai hosts AI-generated media. Videos come back from the public API
# with type == "video" and a directly playable .mp4 URL on image.civitai.com
# (reachable CDN, supports HTTP Range). NSFW browsing needs nsfw=X.
API = "https://civitai.com/api/v1/images"


class CivitaiExtractor(BaseExtractor):
    @property
    def name(self) -> str:
        return "Civitai"

    def can_handle(self, url: str) -> bool:
        return "civitai.com" in (url or "").lower()

    def _image_id(self, url: str):
        # https://civitai.com/images/<id>
        m = re.search(r"/images/(\d+)", url)
        if m:
            return m.group(1)
        # image.civitai.com direct media URL -> already a stream
        return None

    async def extract(self, url: str) -> dict:
        return await asyncio.to_thread(self._extract_sync, url)

    def _extract_sync(self, url: str) -> dict:
        # Direct CDN media URL (no metadata lookup needed).
        if "image.civitai.com" in url and url.lower().endswith((".mp4", ".webm")):
            return {
                "title": "Civitai Video",
                "stream_url": url,
                "is_hls": False,
                "http_headers": {"Referer": "https://civitai.com/"},
            }

        image_id = self._image_id(url)
        if not image_id:
            logger.warning("Civitai: cannot parse image id from %s", url)
            return {}

        try:
            resp = crequests.get(
                f"{API}?imageId={image_id}&nsfw=X",
                impersonate="chrome", timeout=25,
            )
            data = resp.json()
        except Exception as e:
            logger.error("Civitai API failed: %s", e)
            return {}

        items = data.get("items", []) or []
        if not items:
            return {}
        it = items[0]

        if it.get("type") != "video":
            logger.info("Civitai item %s is not a video (type=%s)", image_id, it.get("type"))
            return {}

        media_url = it.get("url", "")
        if not media_url:
            return {}

        meta = it.get("meta") or {}
        prompt = meta.get("prompt") or ""
        title = (prompt[:80].strip() + "…") if prompt else f"Civitai {image_id}"

        return {
            "id": str(image_id),
            "title": title,
            "description": prompt[:500],
            "thumbnail": media_url.replace("original=true", "width=450,anim=false") if "original=true" in media_url else media_url,
            "stream_url": media_url,
            "width": it.get("width"),
            "height": it.get("height"),
            "uploader": it.get("username", ""),
            "is_hls": False,
            "http_headers": {"Referer": "https://civitai.com/"},
        }
