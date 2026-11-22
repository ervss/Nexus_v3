from .base import VideoExtractor
import httpx
import re
import json
import base64
import logging
from typing import Optional, Dict, Any, List

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def _b64url_decode(value: str) -> bytes:
    """Byse ships base64url without padding; restore it before decoding."""
    s = value.replace("-", "+").replace("_", "/")
    s += "=" * ((4 - len(s) % 4) % 4)
    return base64.b64decode(s)


def _decrypt_playback(playback: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Decrypt the Byse ``playback`` blob into the sources JSON.

    The whole key is public in the metadata — no token or fingerprint is
    needed. The player picks two of ``key_parts`` by a per-version index pair
    ``[version, 31 - version]`` (1-indexed), concatenates their raw bytes into a
    32-byte AES-256 key, and AES-256-GCM-decrypts ``payload`` with ``iv``.
    Verified live: the version rotates every request but the index rule holds.
    """
    try:
        parts: List[str] = playback.get("key_parts") or []
        if not parts:
            return None
        version = int(str(playback.get("version") or "0"))
        idx_a, idx_b = version, 31 - version
        n = len(parts)
        if not (1 <= idx_a <= n and 1 <= idx_b <= n):
            return None
        key = _b64url_decode(parts[idx_a - 1]) + _b64url_decode(parts[idx_b - 1])
        if len(key) != 32:
            return None
        iv = _b64url_decode(playback["iv"])
        payload = _b64url_decode(playback["payload"])
        plaintext = AESGCM(key).decrypt(iv, payload, None)
        return json.loads(plaintext.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - any decode failure = unusable
        logger.warning("[69tubed] playback decrypt failed: %s", exc)
        return None


class Tubed69Extractor(VideoExtractor):
    """69tubed.com — WordPress front, Byse (AES-GCM) video backend.

    Flow (all verified live, no browser/fingerprint required):
      69tubed watch page  ->  embed host + short code  (in page HTML)
      https://<embed_host>/api/videos/<code>/          (public metadata)
      playback blob -> AES-256-GCM decrypt -> HLS/MP4 sources + qualities
    """

    @property
    def name(self) -> str:
        return "69Tubed"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        return "69tubed.com" in u or "69tubed.live" in u

    def _find_embed(self, page_html: str):
        """Return (embed_host, code) from a 69tubed watch page."""
        m = re.search(
            r"https?://([^/\"'\s]+)/e/([a-z0-9]+)/",
            page_html,
            re.I,
        )
        if not m:
            return None, None
        return m.group(1), m.group(2)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        headers = {"User-Agent": _UA}
        try:
            async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
                embed_host = code = None

                # Direct embed / API URLs let us skip the watch page.
                direct = re.search(r"https?://([^/]+)/(?:e|api/videos)/([a-z0-9]+)", url, re.I)
                if direct and "/e/" in url or (direct and "/api/videos/" in url):
                    embed_host, code = direct.group(1), direct.group(2)

                if not code:
                    resp = await client.get(url, headers=headers)
                    resp.raise_for_status()
                    page = resp.text
                    embed_host, code = self._find_embed(page)
                    # Grab a title/poster from the watch page as a fallback.
                    og_title = re.search(
                        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)', page, re.I)
                    og_image = re.search(
                        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', page, re.I)
                    page_title = (og_title.group(1).strip() if og_title else "")
                    page_poster = (og_image.group(1).strip() if og_image else "")
                else:
                    page_title = page_poster = ""

                if not code:
                    logger.warning("[69tubed] no embed code found for %s", url)
                    return None
                # The embed host serves the same API; q8y5z.com is the fallback.
                api_hosts = [h for h in (embed_host, "q8y5z.com") if h]

                meta = None
                for host in api_hosts:
                    try:
                        r = await client.get(
                            f"https://{host}/api/videos/{code}/",
                            headers={**headers, "Referer": f"https://{host}/"},
                        )
                        if r.status_code == 200 and "playback" in r.text:
                            meta = r.json()
                            break
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("[69tubed] api host %s failed: %s", host, exc)

                if not meta:
                    logger.warning("[69tubed] metadata API failed for code %s", code)
                    return None

                sources_json = _decrypt_playback(meta.get("playback") or {})
                sources = (sources_json or {}).get("sources") or []
                if not sources:
                    logger.warning("[69tubed] no playable sources for code %s", code)
                    return None

                # Pick the highest quality by pixel height (then bitrate).
                best = max(
                    sources,
                    key=lambda s: (int(s.get("height") or 0), int(s.get("bitrate_kbps") or 0)),
                )
                stream_url = best.get("url") or ""
                if not stream_url:
                    return None

                height = int(best.get("height") or 0)
                kbps = int(best.get("bitrate_kbps") or 0)
                size_bytes = int(best.get("size_bytes") or 0)
                is_hls = "m3u8" in stream_url.lower() or "mpegurl" in str(best.get("mime_type") or "").lower()

                title = (
                    (meta.get("title") or "").replace("-", " ").strip()
                    or page_title
                    or "69Tubed Video"
                )
                poster = (
                    meta.get("poster_url")
                    or (sources_json or {}).get("poster_url")
                    or page_poster
                    or ""
                )
                duration = int(meta.get("duration_seconds") or 0)

                return {
                    "id": code,
                    "title": title,
                    "description": meta.get("description") or "",
                    "thumbnail": poster,
                    "duration": duration,
                    "stream_url": stream_url,
                    "width": 0,
                    "height": height,
                    "size_bytes": size_bytes,
                    "bitrate_kbps": kbps,
                    "tags": [],
                    "uploader": meta.get("owner_login") or "69Tubed",
                    "is_hls": is_hls,
                }

        except Exception as exc:  # noqa: BLE001
            logger.error("[69tubed] extraction error: %s", exc)
            return None
