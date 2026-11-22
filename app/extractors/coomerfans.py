import os
import re
import asyncio
import logging
from urllib.parse import urlparse
from curl_cffi import requests as crequests
from .base import VideoExtractor as BaseExtractor

logger = logging.getLogger(__name__)

# Coomer / Kemono share the same API + storage backend.
# The public site is a SPA, so the video URL is NOT in the initial HTML.
# It must be resolved from the JSON API. The API host rejects normal JSON
# requests with 403 and explicitly instructs scrapers to send "Accept: text/css".
API_HEADERS = {"Accept": "text/css"}

# API/frontend hosts (reachable). File data nodes live on a separate
# IP range (n1-n4.<domain>) that many ISPs / regions firewall-block.
COOMER_HOSTS = ("coomer.st", "coomer.su", "coomer.party")
KEMONO_HOSTS = ("kemono.cr", "kemono.su", "kemono.party")

# Signed CDN file URLs, e.g.
#   https://img5.coomerfans.com/storage/2/zh/ok/<uuid>.m4v?e=<expiry>&hash=<sig>
# These are already the stream; there is no post API to consult.
_DIRECT_HOST = re.compile(r"^(?:img|n)\d*\.coomerfans\.com$", re.I)
_VIDEO_EXT = (".mp4", ".m4v", ".mov", ".webm", ".mkv")


class CoomerfansExtractor(BaseExtractor):
    @property
    def name(self) -> str:
        return "Coomerfans"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        return any(h in u for h in COOMER_HOSTS + KEMONO_HOSTS) or "coomerfans.com" in u

    def _api_base(self, host: str) -> str:
        # Normalise to a currently-live API host for the family.
        if any(k in host for k in KEMONO_HOSTS) or "kemono" in host:
            return "https://kemono.cr"
        return "https://coomer.st"

    def _parse_url(self, url: str):
        """
        Expected forms:
          https://coomer.st/onlyfans/user/<creator>/post/<id>
          https://coomer.st/fansly/user/<creator>/post/<id>
          https://kemono.cr/patreon/user/<creator>/post/<id>
        """
        p = urlparse(url)
        parts = [x for x in p.path.split("/") if x]
        # [service, 'user', creator, 'post', postid]
        if len(parts) >= 5 and parts[1] == "user" and parts[3] == "post":
            return p.netloc, parts[0], parts[2], parts[4]
        return p.netloc, None, None, None

    def _proxy(self):
        # Optional: route CDN/API through a proxy when the file nodes are
        # blocked on the local network. e.g. COOMER_PROXY=http://user:pass@host:port
        return os.getenv("COOMER_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY")

    async def extract(self, url: str) -> dict:
        return await asyncio.to_thread(self._extract_sync, url)

    @staticmethod
    def _is_direct_file(url: str) -> bool:
        p = urlparse(url)
        return bool(_DIRECT_HOST.match(p.netloc or "")) and p.path.lower().endswith(_VIDEO_EXT)

    def _extract_direct(self, url: str, proxies) -> dict:
        """A signed CDN URL is already playable — describe it, don't re-resolve it."""
        name = os.path.basename(urlparse(url).path)
        size_bytes = 0
        headers = {"Referer": "https://coomerfans.com/"}

        try:
            # HEAD is often refused by these nodes; a 1-byte range always answers.
            resp = crequests.get(
                url, headers={**headers, "Range": "bytes=0-0"},
                impersonate="chrome", timeout=20, proxies=proxies,
            )
            if resp.status_code in (200, 206):
                content_range = resp.headers.get("content-range", "")
                if "/" in content_range:
                    size_bytes = int(content_range.rsplit("/", 1)[-1] or 0)
                elif resp.status_code == 200:
                    size_bytes = int(resp.headers.get("content-length") or 0)
            elif resp.status_code in (403, 410):
                logger.warning("Coomer CDN link expired or forbidden (%s): %s", resp.status_code, url)
                return {}
        except Exception as e:  # noqa: BLE001 — a missing size must not fail the resolve
            logger.warning("Coomer direct probe failed: %s", e)

        return {
            "id": os.path.splitext(name)[0],
            "title": os.path.splitext(name)[0] or "Coomer Video",
            "thumbnail": "",
            "stream_url": url,
            "is_hls": False,
            "size_bytes": size_bytes,
            "http_headers": headers,
        }

    def _extract_sync(self, url: str) -> dict:
        proxies = None
        px = self._proxy()
        if px:
            proxies = {"http": px, "https": px}

        if self._is_direct_file(url):
            return self._extract_direct(url, proxies)

        host, service, creator, post_id = self._parse_url(url)

        if not (service and creator and post_id):
            # Not a post URL we can resolve via API.
            logger.warning("Coomer: unsupported URL shape: %s", url)
            return {}

        api = self._api_base(host)
        api_url = f"{api}/api/v1/{service}/user/{creator}/post/{post_id}"

        try:
            resp = crequests.get(
                api_url, headers=API_HEADERS, impersonate="chrome",
                timeout=25, proxies=proxies,
            )
        except Exception as e:
            logger.error("Coomer API request failed: %s", e)
            return {}

        if resp.status_code != 200:
            logger.warning("Coomer API %s -> %s", api_url, resp.status_code)
            return {}

        try:
            data = resp.json()
        except Exception:
            return {}

        post = data.get("post", {}) or {}
        videos = data.get("videos", []) or []
        attachments = data.get("attachments", []) or []
        previews = data.get("previews", []) or []

        # Prefer explicit video entries; fall back to video-ext attachments.
        candidates = list(videos)
        if not candidates:
            for a in attachments:
                if str(a.get("path", "")).lower().endswith(
                    (".mp4", ".m4v", ".mov", ".webm", ".mkv")
                ):
                    candidates.append(a)

        if not candidates:
            return {}

        v = candidates[0]
        server = (v.get("server") or api).rstrip("/")
        path = v.get("path", "")
        name = v.get("name", "")
        # Storage layout is <server>/data<path>?f=<name>
        stream_url = f"{server}/data{path}"
        if name:
            stream_url += f"?f={name}"

        # Thumbnail: first image preview, else post file image.
        thumbnail = ""
        for pv in previews:
            if pv.get("type") == "thumbnail" and pv.get("path"):
                psrv = (pv.get("server") or api).rstrip("/")
                thumbnail = f"{psrv}/data{pv['path']}"
                break

        title = post.get("title") or name or "Coomer Video"

        return {
            "id": str(post_id),
            "title": title.strip(),
            "description": re.sub(r"<[^>]+>", " ", post.get("content", "") or "").strip()[:500],
            "thumbnail": thumbnail,
            "stream_url": stream_url,
            "uploader": creator,
            "is_hls": False,
            # Downstream proxy should send this Referer for the CDN nodes.
            "http_headers": {"Referer": f"{api}/"},
        }
