import asyncio
import html as html_lib
import http.cookiejar
import json
import logging
import os
import re
from typing import Any, Dict, Optional

import requests
import yt_dlp

from .base import VideoExtractor

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class NoodleMagazineExtractor(VideoExtractor):
    @staticmethod
    def _is_preview_clip_url(url: str) -> bool:
        """Return True for Noodle's short ``tr_<quality>.mp4`` teaser asset.

        The page metadata describes the full movie, while this CDN asset is a
        five-second preview.  Treating it as the main stream leaves a library
        card that claims a long duration but can only play the teaser.
        """
        return bool(re.search(r"/tr_\d{3,4}p\.mp4(?:[?#]|$)", url or "", re.I))

    @staticmethod
    def _family_domains() -> tuple[str, ...]:
        return ("noodlemagazine.com", "ukdevilz.com")

    @classmethod
    def _matches_family(cls, value: str) -> bool:
        raw = (value or "").lower()
        return any(domain in raw for domain in cls._family_domains())

    @staticmethod
    def _base_origin(url: str) -> str:
        m = re.match(r"^(https?://[^/]+)", str(url or "").strip(), re.I)
        return m.group(1) if m else "https://noodlemagazine.com"

    @staticmethod
    def _collect_playlist_sources(html_text: str) -> list[str]:
        """Read the full ``window.playlist`` object without regex-truncating it.

        Playlist source entries are themselves JSON objects, so a non-greedy
        ``{.*?}`` match stops after the first quality.  That used to make the
        caller scan the entire HTML and occasionally select a related video's
        ``tr_*.mp4`` teaser instead of this video's real stream.
        """
        match = re.search(r"window\.playlist\s*=\s*", html_text, re.IGNORECASE)
        if not match:
            return []
        try:
            playlist, _ = json.JSONDecoder().raw_decode(html_text[match.end():].lstrip())
        except Exception:
            return []
        if not isinstance(playlist, dict):
            return []
        sources = playlist.get("sources") or []
        if not isinstance(sources, list):
            return []
        urls = []
        for item in sources:
            if isinstance(item, dict) and item.get("file"):
                urls.append(str(item["file"]).replace("\\/", "/"))
        return urls

    @staticmethod
    def _resolve_cookiefile() -> Optional[str]:
        env_cookiefile = (os.getenv("NOODLEMAGAZINE_COOKIEFILE") or "").strip()
        candidates = [
            env_cookiefile,
            "noodlemagazine.netscape.txt",
            "cookies.netscape.txt",
            "cookies.txt",
        ]
        for path in candidates:
            if path and os.path.exists(path):
                return path
        return None

    @property
    def name(self) -> str:
        return "NoodleMagazine"

    def can_handle(self, url: str) -> bool:
        u = (url or "").lower()
        return self._matches_family(u) and ("/watch/" in u or "/video/" in u)

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        manual = await asyncio.to_thread(self._extract_manual, url)
        if manual and manual.get("stream_url"):
            return manual
        return await asyncio.to_thread(self._extract_ytdlp, url)

    def _extract_manual(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            cookiefile = self._resolve_cookiefile()
            cookie_jar = None
            cookie_header = ""
            base_origin = self._base_origin(url)
            if cookiefile:
                try:
                    jar = http.cookiejar.MozillaCookieJar(cookiefile)
                    jar.load(ignore_discard=True, ignore_expires=True)
                    cookie_jar = jar
                    cookie_header = "; ".join(
                        f"{c.name}={c.value}"
                        for c in jar
                        if self._matches_family(c.domain or "")
                    )
                except Exception as exc:
                    logger.warning("[NoodleMagazine] Failed to load cookiefile %s: %s", cookiefile, exc)

            headers = {
                "User-Agent": _UA,
                "Referer": f"{base_origin}/",
                "Accept-Language": "en-US,en;q=0.9",
            }
            if cookie_header:
                headers["Cookie"] = cookie_header

            # Cloudflare challenge is often bypassed only with browser-like TLS impersonation.
            html = ""
            try:
                from .base import ntc_get_sync
                from app.ntc import NTCStatusError
                html = ntc_get_sync(
                    url,
                    domain="noodlemagazine.com",
                    headers=headers,
                    deadline=28.0,
                    impersonate="chrome124",
                )
            except NTCStatusError as exc:
                logger.warning("[NoodleMagazine] HTTP %s for %s", exc.status_code, url)
                return None
            except Exception:
                resp = None
                try:
                    from curl_cffi import requests as cffi_requests
                    resp = cffi_requests.get(
                        url,
                        impersonate="chrome124",
                        headers=headers,
                        timeout=20,
                    )
                except Exception:
                    pass
                if resp is None:
                    resp = requests.get(
                        url,
                        headers=headers,
                        cookies=cookie_jar,
                        timeout=20,
                    )
                if resp.status_code != 200:
                    logger.warning("[NoodleMagazine] HTTP %s for %s", resp.status_code, url)
                    return None
                html = resp.text or ""
            if not html:
                return None

            title = ""
            thumbnail = ""
            duration = 0
            tags = []

            ld_match = re.search(
                r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                html,
                re.DOTALL | re.IGNORECASE,
            )
            if ld_match:
                try:
                    ld = json.loads(ld_match.group(1))
                    if isinstance(ld, list) and ld:
                        ld = ld[0]
                    if isinstance(ld, dict):
                        title = str(ld.get("name") or ld.get("headline") or "").strip()
                        t = ld.get("thumbnailUrl") or ld.get("thumbnail")
                        if isinstance(t, list):
                            thumbnail = (t[0] or "").strip() if t else ""
                        elif isinstance(t, dict):
                            thumbnail = str(t.get("url") or "").strip()
                        else:
                            thumbnail = str(t or "").strip()
                        tags = ld.get("keywords") or []
                        if isinstance(tags, str):
                            tags = [x.strip() for x in tags.split(",") if x.strip()]
                        dur_raw = str(ld.get("duration") or "")
                        dm = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", dur_raw, re.I)
                        if dm:
                            duration = (
                                int(dm.group(1) or 0) * 3600
                                + int(dm.group(2) or 0) * 60
                                + int(dm.group(3) or 0)
                            )
                except Exception:
                    pass

            if not title:
                m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
                if m:
                    title = re.sub(r"\s+", " ", m.group(1)).strip()
            if not thumbnail:
                m = re.search(
                    r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
                    html,
                    re.I,
                )
                if m:
                    thumbnail = m.group(1).strip()
            if not duration:
                m = re.search(
                    r'<meta[^>]+property=["\']video:duration["\'][^>]+content=["\'](\d+)["\']',
                    html,
                    re.I,
                )
                if m:
                    duration = int(m.group(1))

            stream_url = None
            playlist_sources = self._collect_playlist_sources(html)
            candidates = list(playlist_sources)
            patterns = [
                r'["\']?(https?://[^"\'>\s]+\.m3u8[^"\'>\s]*)["\']?',
                r'["\']?(https?://[^"\'>\s]+\.mp4[^"\'>\s]*)["\']?',
                r'file\s*:\s*["\'](https?://[^"\']+)["\']',
                r'sources?\s*:\s*(\[[^\]]+\])',
            ]
            # A parsed player playlist is authoritative.  Only use the broad
            # HTML scan for legacy pages that do not expose one; it also sees
            # teaser URLs belonging to related-video cards.
            if not playlist_sources:
                for pat in patterns:
                    for match in re.findall(pat, html, re.I | re.S):
                        if isinstance(match, str):
                            if pat.endswith(r"(\[[^\]]+\])"):
                                try:
                                    arr = json.loads(match)
                                    if isinstance(arr, list):
                                        for item in arr:
                                            if isinstance(item, dict) and item.get("file"):
                                                candidates.append(str(item["file"]).replace("\\/", "/"))
                                except Exception:
                                    continue
                            else:
                                candidates.append(html_lib.unescape(match.replace("\\/", "/")))

            best_score = -1
            for c in candidates:
                if not c.startswith("http"):
                    continue
                low = c.lower()
                score = 0
                if ".m3u8" in low:
                    score += 2000
                if ".mp4" in low:
                    score += 1000
                if "pvvstream" in low:
                    score += 5000
                if "/videofile/" in low:
                    score -= 4000
                q = re.search(r"(\d{3,4})p", low)
                if q:
                    score += int(q.group(1))
                if score > best_score:
                    best_score = score
                    stream_url = c

            if not stream_url:
                return None

            # A trailer is useful to the source website, but it is never a
            # valid replacement for a full-length imported video.  Returning
            # None lets the yt-dlp fallback try a real stream; if that is
            # unavailable (for example because the source needs a session),
            # the caller reports a failed refresh instead of silently storing
            # a five-second clip as a 30+ minute movie.
            if duration > 60 and self._is_preview_clip_url(stream_url):
                logger.warning(
                    "[NoodleMagazine] rejecting preview-only stream for %s (declared duration=%ss)",
                    url,
                    duration,
                )
                return None

            is_hls = ".m3u8" in stream_url.lower()
            height = 0
            qmatch = re.search(r"(2160|1440|1080|720|480)p", stream_url.lower())
            if qmatch:
                height = int(qmatch.group(1))
            return {
                "id": None,
                "title": title or "NoodleMagazine Video",
                "description": "",
                "thumbnail": thumbnail or None,
                "duration": int(duration or 0),
                "stream_url": stream_url,
                "width": 0,
                "height": height,
                "tags": tags if isinstance(tags, list) else [],
                "uploader": "",
                "is_hls": is_hls,
            }
        except Exception as exc:
            logger.warning("[NoodleMagazine] manual extraction failed for %s: %s", url, exc)
            return None

    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        try:
            opts = {
                "quiet": True,
                "skip_download": True,
                "no_warnings": True,
                "extract_flat": False,
                "format": "best[protocol*=m3u8]/best[ext=mp4]/best",
                "user_agent": _UA,
                "http_headers": {
                    "User-Agent": _UA,
                    "Referer": f"{self._base_origin(url)}/",
                },
            }
            cookiefile = self._resolve_cookiefile()
            if cookiefile:
                opts["cookiefile"] = cookiefile
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            if not info:
                return None
            stream_url = info.get("url")
            if not stream_url:
                fmts = [f for f in (info.get("formats") or []) if f.get("url")]
                if fmts:
                    fmts.sort(key=lambda f: (f.get("height") or 0), reverse=True)
                    stream_url = fmts[0]["url"]
            if not stream_url:
                return None
            return {
                "id": info.get("id"),
                "title": info.get("title") or "NoodleMagazine Video",
                "description": info.get("description") or "",
                "thumbnail": info.get("thumbnail"),
                "duration": int(info.get("duration") or 0),
                "stream_url": stream_url,
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "tags": info.get("tags") or [],
                "uploader": info.get("uploader") or "",
                "is_hls": ".m3u8" in str(stream_url).lower(),
            }
        except Exception as exc:
            logger.warning("[NoodleMagazine] yt-dlp fallback failed for %s: %s", url, exc)
            return None
