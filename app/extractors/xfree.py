"""
Xfree extractor (xfree.com — short-form / "TikTok porn" clips).

Video pages live at https://www.xfree.com/video?id=NNNNN and are a Nuxt SSR app
behind a Cloudflare-style bot gate: plain requests get through a few times then
start receiving an empty challenge page. curl_cffi with a real Chrome fingerprint
passes reliably, with cloudscraper as a fallback.

The direct MP4 (`https://cdn.xfree.com/.../full.mp4`) is public, supports range
requests and needs no auth/referer — so it plays straight in the dashboard once
the extractor rewrites the stored watch URL to the stream URL.
"""
from __future__ import annotations

import html as _html
import logging
import re
from typing import Any, Dict, Optional

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class XfreeExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "Xfree"

    @property
    def domains(self):
        return ["xfree.com"]

    def can_handle(self, url: str) -> bool:
        return "xfree.com" in (url or "").lower()

    def is_playable_stream(self, url: str) -> bool:
        low = (url or "").strip().lower()
        return low.startswith("http") and "cdn.xfree.com" in low and ".mp4" in low

    def _normalize_watch_url(self, url: str) -> str:
        """Accept /video?id=N, bare numeric ids, and full URLs; return a watch URL."""
        raw = str(url or "").strip()
        if raw.isdigit():
            return f"https://www.xfree.com/video?id={raw}"
        m = re.search(r"[?&]id=(\d+)", raw)
        if m:
            return f"https://www.xfree.com/video?id={m.group(1)}"
        return raw

    def _fetch(self, url: str) -> str:
        """Fetch page HTML past the bot gate. curl_cffi first, cloudscraper fallback."""
        headers = {"User-Agent": _UA, "Referer": "https://www.xfree.com/"}
        # 1) curl_cffi with Chrome TLS/JA3 fingerprint — cleanest, no JS solving
        try:
            from curl_cffi import requests as cr
            resp = cr.get(url, headers=headers, impersonate="chrome", timeout=25)
            if resp.status_code == 200 and "cdn.xfree.com" in resp.text:
                return resp.text
        except Exception as exc:
            logger.debug("Xfree curl_cffi fetch failed: %s", exc)
        # 2) cloudscraper fallback (solves the JS challenge if present)
        try:
            import cloudscraper
            s = cloudscraper.create_scraper()
            resp = s.get(url, headers=headers, timeout=30)
            if resp.status_code == 200:
                return resp.text or ""
        except Exception as exc:
            logger.debug("Xfree cloudscraper fetch failed: %s", exc)
        return ""

    def _meta(self, html: str, prop: str) -> str:
        for pat in (
            rf'<meta[^>]+(?:property|name)="{re.escape(prop)}"[^>]+content="([^"]*)"',
            rf'<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="{re.escape(prop)}"',
        ):
            m = re.search(pat, html, re.I)
            if m:
                return _html.unescape(m.group(1)).strip()
        return ""

    def _clean_title(self, title: str) -> str:
        # strip the "- @user's Sex Reel On xfree.com – TikTok Porn & Shorts" suffix
        t = re.sub(r"\s*[-–|]\s*[^-–|]*\bxfree\.com\b.*$", "", title, flags=re.I).strip()
        return t or title.strip()

    @staticmethod
    def _stream_from_html(page_html: str) -> str:
        """Read a direct MP4 whether Nuxt wrote it as HTML or JSON-escaped."""
        patterns = (
            r'https://cdn\.xfree\.com/[^\s"\']+?\.mp4(?:\?[^\s"\']*)?',
            r'https:\\\\/\\\\/cdn\.xfree\.com/[^\s"\']+?\.mp4(?:\\?[^\s"\']*)?',
        )
        for pattern in patterns:
            match = re.search(pattern, page_html)
            if match:
                return _html.unescape(match.group(0)).replace("\\/", "/").replace("\\u0026", "&")
        return ""

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        watch_url = self._normalize_watch_url(url)
        logger.info("Extracting Xfree: %s", watch_url)
        html = self._fetch(watch_url)
        if not html:
            logger.warning("Xfree: could not fetch %s (bot gate?)", watch_url)
            return None

        stream_url = self._stream_from_html(html)

        title = self._clean_title(self._meta(html, "og:title") or self._meta(html, "twitter:title"))
        thumbnail = self._meta(html, "og:image") or self._meta(html, "twitter:image")
        description = self._meta(html, "og:description")

        # duration: prefer og:video:duration, then a JSON "duration": N
        duration = 0
        dur_m = re.search(r'og:video:duration"[^>]+content="(\d+)"', html) \
            or re.search(r'"duration"\s*:\s*(\d+)', html)
        if dur_m:
            try:
                duration = int(dur_m.group(1))
            except Exception:
                duration = 0

        # Xfree does not expose reliable technical metadata in its page JSON.
        # Probe the public MP4 itself: two short range reads supply duration,
        # file size and the encoded dimensions without downloading the video.
        width = height = size_bytes = 0
        if stream_url:
            try:
                from app.mp4_probe import probe_mp4_cached
                probe = await probe_mp4_cached(watch_url, stream_url, headers={
                    "User-Agent": _UA,
                    "Referer": "https://www.xfree.com/",
                })
                duration = duration or int(probe.get("duration") or 0)
                width = int(probe.get("width") or 0)
                height = int(probe.get("height") or 0)
                size_bytes = int(probe.get("size") or 0)
            except Exception as exc:
                logger.debug("Xfree MP4 metadata probe failed: %s", exc)

        # tags from #hashtags in the description
        tags = [t.lower() for t in re.findall(r"#(\w{2,30})", description)]

        # uploader: "@handle" in the title/description
        up_m = re.search(r"@([A-Za-z0-9_.]{2,40})", title + " " + description)
        uploader = up_m.group(1) if up_m else ""

        m_id = re.search(r"[?&]id=(\d+)", watch_url)

        if not stream_url:
            logger.warning("Xfree: no stream URL found for %s", watch_url)

        return {
            "id": m_id.group(1) if m_id else None,
            "title": title or "Xfree Video",
            "description": description,
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": stream_url,
            "width": width,
            "height": height,
            "size_bytes": size_bytes,
            "tags": tags,
            "uploader": uploader,
            "is_hls": False,
            "source_url": watch_url,
        }
