import re
import asyncio
import logging
from curl_cffi import requests as crequests
from .base import VideoExtractor as BaseExtractor

logger = logging.getLogger(__name__)

# xxxdbx.com is a video-database/aggregator. The /view/<id> page embeds a
# <video> with multiple <source> mp4 tags served from d.v1d30.com. Those CDN
# URLs carry a signed token that regenerates on every page fetch, so the view
# page URL is the stable key and mp4 must be re-resolved at playback time (JIT).
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def _quality_of(url: str) -> int:
    m = re.search(r"/(\d{3,4})\.mp4", url)
    return int(m.group(1)) if m else 0


class XxxdbxExtractor(BaseExtractor):
    @property
    def name(self) -> str:
        return "Xxxdbx"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        return "xxxdbx.com" in u or "d.v1d30.com" in u

    async def extract(self, url: str) -> dict:
        return await asyncio.to_thread(self._extract_sync, url)

    def _extract_sync(self, url: str) -> dict:
        headers = {"User-Agent": _UA, "Referer": "https://xxxdbx.com/"}
        try:
            resp = crequests.get(url, headers=headers, impersonate="chrome", timeout=25)
        except Exception as e:
            logger.error("Xxxdbx fetch failed: %s", e)
            return {}
        if resp.status_code != 200:
            logger.warning("Xxxdbx %s -> %s", url, resp.status_code)
            return {}
        html = resp.text

        # Collect <source src="//d.v1d30.com/.../<height>.mp4" type="video/mp4">
        srcs = re.findall(r'<source[^>]+src="([^"]+\.mp4[^"]*)"', html)
        srcs = [("https:" + s) if s.startswith("//") else s for s in srcs]
        srcs = [s for s in srcs if s.startswith("http")]
        if not srcs:
            logger.warning("Xxxdbx: no mp4 sources on %s", url)
            return {}

        best = max(srcs, key=_quality_of)
        height = _quality_of(best)

        # Title
        title = "Xxxdbx Video"
        m = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        if not m:
            m = re.search(r"<title>([^<]+)</title>", html)
        if m:
            title = re.sub(r"\s*&ndash;\s*xx?dbx\s*$", "", m.group(1)).strip() or title
            title = (title.replace("&amp;", "&").replace("&#039;", "'")
                          .replace("&quot;", '"').replace("&ndash;", "–"))

        # Thumbnail (og:image or the v_pic jpg)
        thumbnail = ""
        tm = re.search(r'<meta property="og:image" content="([^"]+)"', html)
        if tm:
            thumbnail = tm.group(1)
        if not thumbnail:
            im = re.search(r'<video[^>]+poster="([^"]+)"', html)
            if im:
                thumbnail = im.group(1)
        if thumbnail.startswith("//"):
            thumbnail = "https:" + thumbnail

        # Duration from a visible badge like 19:45 / 1:15:32 (best-effort)
        duration = 0
        dm = re.search(r'"duration"\s*:\s*"?(\d+)', html)
        if dm:
            duration = int(dm.group(1))

        return {
            "title": title,
            "thumbnail": thumbnail,
            "stream_url": best,
            "height": height,
            "duration": duration,
            "is_hls": False,
            "http_headers": {"Referer": "https://xxxdbx.com/"},
        }
