"""
Faphouse video extractor.
Extracts video metadata and direct/HLS streams from faphouse.com using stored cookies.
Strictly ignores short previews/trailers in favor of full direct video streams.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
import urllib.request

from ..cookie_jar import build_cookie_header, build_opener, resolve_cookiefile
from .base import VideoExtractor

logger = logging.getLogger(__name__)


class FaphouseAccessError(RuntimeError):
    """The page loaded fine but this account may not stream the full video.

    Kept distinct from a parse failure so callers can tell "Faphouse says no"
    (premium video / signed-out session — a fresh cookie export fixes it) from
    "our parser broke" (a code fix is needed). Faphouse only ever ships the
    trailer to a session without access, and a trailer silently substituted for
    the feature is worse than an explicit refusal.
    """


# The player's real source lives on the page's main <video> element, either as
# a <source src> child or its data-fallback attribute:
#   https://video-nss.flixcdn.com/<sig>,<expiry>/Ll/LlsWIC/trailer/2160.mp4
#                                                 ^^id^^  ^kind^ ^height^
# `kind` is "trailer"/"preview" for a locked video and the feature path once
# the session may stream it. Height is the filename, which is where the real
# resolution comes from — the page never states it separately.
_VIDEO_TAG_RE = re.compile(r"<video[^>]*\bid=[\"']video-[^\"']*[\"'][^>]*>.*?</video>", re.I | re.S)
_ANY_VIDEO_TAG_RE = re.compile(r"<video[^>]*>.*?</video>", re.I | re.S)
_SOURCE_SRC_RE = re.compile(r"<source[^>]+\bsrc=[\"']([^\"']+\.mp4[^\"']*)[\"']", re.I)
_DATA_FALLBACK_RE = re.compile(r"\bdata-fallback=[\"']([^\"']+\.mp4[^\"']*)[\"']", re.I)
_STREAM_SHAPE_RE = re.compile(r"/(?P<kind>[a-z0-9_-]+)/(?P<height>\d{3,4})\.mp4(?:$|[?#])", re.I)
_TRAILER_KINDS = {"trailer", "preview", "sample", "intro", "teaser"}

# Faphouse also ships the full watch page with an HLS master template — the
# same one the extension popup (faphouse_grid_importer.js) reads to build its
# JDownloader export, which the "GB, not MB" verification proved correct:
#   .../media=hls4/multi=426x240:240,...,3840x2160:2160/<id2>/<id>/format/_TPL_.mp4.m3u8
# `_TPL_` is a placeholder swapped for the tallest number in `multi=`, giving
# the top-quality manifest URL. Direct .m3u8/.mp4 URLs elsewhere on the page
# (the alternate-quality picker, or a video with no manifest) are candidates
# too. Sidebar "recommended" clips live under /preview/ or /trailer/ paths and
# are excluded the same way the popup does it — by path, not by domain, since
# they share flixcdn with the real stream.
_MANIFEST_TPL_RE = re.compile(r"https?://[^\"'\\\s<>]+_TPL_[^\"'\\\s<>]*\.m3u8", re.I)
_ANY_STREAM_RE = re.compile(r"https?://[^\"'\\\s<>]+\.(?:m3u8|mp4)(?:\?[^\"'\\\s<>]*)?", re.I)
_MULTI_RE = re.compile(r"multi=([^/]+)", re.I)
_HEIGHT_IN_URL_RE = re.compile(r"(?:^|[^\d])(2160|1440|1080|720|480|360|240)(?:p)?(?:[^\d]|$)", re.I)
_AV1_RE = re.compile(r"\.av1\.mp4", re.I)


def _expand_manifest_template(manifest_url: str) -> tuple[str, int]:
    """`_TPL_` master URL -> (url with the tallest `multi=` height, that height)."""
    multi = _MULTI_RE.search(manifest_url)
    if not multi:
        return manifest_url.replace("_TPL_", "1080"), 1080
    heights = [int(h) for h in re.findall(r":(\d{3,4})", multi.group(1)) if h]
    best = max(heights) if heights else 1080
    return manifest_url.replace("_TPL_", str(best)), best


def _find_best_stream(page_html: str) -> Tuple[str, str, int]:
    """(stream_url, kind, height) — the highest-quality playable stream on the page.

    Scans the whole page for HLS manifests and direct MP4s instead of the main
    <video> tag alone: Faphouse serves the top quality only via the `_TPL_`
    manifest, which isn't inside <video> at all (JS swaps it in client-side).
    Candidates under /trailer/ or /preview/ are dropped — that's how the
    proven-working extension popup avoids the ~79 sidebar recommendation clips
    that also live on flixcdn. Among what's left, HLS wins over plain MP4, then
    tallest height, then non-AV1 over AV1 (same height, far lower bitrate —
    picking it silently would turn a "4K" tile into a ~500 MB file).
    """
    unescaped = html.unescape(page_html or "")
    candidates: Dict[str, Tuple[int, bool, bool]] = {}  # url -> (height, is_hls, is_av1)

    def add(raw: str) -> None:
        url = (raw or "").strip()
        if not url:
            return
        if "/trailer/" in url.lower() or "/preview/" in url.lower():
            return
        if "_TPL_" in url:
            url, height = _expand_manifest_template(url)
        else:
            m = _HEIGHT_IN_URL_RE.search(url)
            height = int(m.group(1)) if m else 0
        is_hls = ".m3u8" in url.lower()
        is_av1 = bool(_AV1_RE.search(url))
        prev = candidates.get(url)
        if prev is None or height > prev[0]:
            candidates[url] = (height, is_hls, is_av1)

    for m in _MANIFEST_TPL_RE.finditer(unescaped):
        add(m.group(0))
    for m in _ANY_STREAM_RE.finditer(unescaped):
        add(m.group(0))

    if not candidates:
        return "", "", 0

    best_url = max(
        candidates,
        key=lambda u: (candidates[u][1], candidates[u][0], not candidates[u][2]),
    )
    height, is_hls, _ = candidates[best_url]
    return best_url, "", height


class FaphouseExtractor(VideoExtractor):
    USER_AGENT = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    )

    @property
    def name(self) -> str:
        return "Faphouse"

    @property
    def domains(self) -> List[str]:
        return ["faphouse.com", "www.faphouse.com"]

    def can_handle(self, url: str) -> bool:
        low = (url or "").lower()
        return "faphouse.com" in low

    #: Checked in order; first existing non-empty file wins. Shared with the
    #: hub adapter (app/hubs/faphouse.py) via app.cookie_jar so both send the
    #: exact same session on every request.
    COOKIE_CANDIDATES = (
        "faphouse_cookies.txt",
        "faphouse.netscape.txt",
        "faphouse.cookies.txt",
        "app/faphouse_cookies.txt",
        "app/faphouse.netscape.txt",
        "app/faphouse.cookies.txt",
        "cookies.netscape.txt",
        "cookies.txt",
    )

    def _resolve_cookiefile(self) -> Optional[str]:
        return resolve_cookiefile(*self.COOKIE_CANDIDATES)

    def _build_cookie_header(self) -> str:
        return build_cookie_header(self._resolve_cookiefile())

    def _build_opener(self) -> urllib.request.OpenerDirector:
        return build_opener(self._resolve_cookiefile())

    @staticmethod
    def _view_state(page_html: str) -> Dict[str, Any]:
        """The page's own `view-state-data` blob — the authoritative metadata.

        Everything worth having (real duration, access flags, studio, video id)
        is stated exactly once here, so reading it beats regex-scraping the
        rendered markup: the loose `duration|length` pattern this replaced was
        matching the 120 s trailer instead of the 3331 s feature.
        """
        m = re.search(r'<script[^>]*id="view-state-data"[^>]*>(.*?)</script>', page_html, re.S)
        if not m:
            return {}
        try:
            data = json.loads(m.group(1).strip())
            return data if isinstance(data, dict) else {}
        except (ValueError, TypeError):
            return {}

    @staticmethod
    def _find_player_stream(page_html: str) -> Tuple[str, str, int]:
        """(stream_url, kind, height) taken from the page's MAIN <video> only.

        Scoping to that element is the whole point: the page also carries ~79
        `thumb-ah.flixcdn.com/.../preview/big-720.mp4` clips, one per recommended
        video in the sidebar. A page-wide "first .mp4 wins" scrape returns one of
        those — a real, playable, completely unrelated video, which is a far
        worse failure than finding nothing.
        """
        unescaped = html.unescape(page_html or "")
        block = _VIDEO_TAG_RE.search(unescaped) or _ANY_VIDEO_TAG_RE.search(unescaped)
        if not block:
            return "", "", 0
        markup = block.group(0)

        stream_url = ""
        for pattern in (_SOURCE_SRC_RE, _DATA_FALLBACK_RE):
            found = pattern.search(markup)
            if found:
                stream_url = found.group(1).strip()
                break
        if not stream_url:
            return "", "", 0
        if stream_url.startswith("//"):
            stream_url = "https:" + stream_url

        shape = _STREAM_SHAPE_RE.search(stream_url)
        kind = (shape.group("kind") or "").lower() if shape else ""
        height = int(shape.group("height")) if shape else 0
        return stream_url, kind, height

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        return await asyncio.to_thread(self._extract_sync, url)

    def _extract_sync(self, url: str) -> Optional[Dict[str, Any]]:
        clean_url = str(url or "").split("#")[0].strip()
        if not clean_url:
            return None

        # Check if URL itself is already a direct full stream (from extension capture)
        clean_low = clean_url.lower()
        if any(ext in clean_low for ext in [".mp4", ".m3u8"]):
            if "trailer" not in clean_low and "preview" not in clean_low:
                qm = re.search(r'(?:^|[\\/_.-])(2160|1440|1080|720|480)(?:p)?(?:[\\/_.-]|$)', clean_url)
                height = int(qm.group(1)) if qm else 1080
                return {
                    "id": clean_url,
                    "title": "Faphouse Direct Video",
                    "description": "",
                    "thumbnail": "",
                    "duration": 0,
                    "stream_url": clean_url,
                    "width": int(height * (16 / 9)),
                    "height": height,
                    "tags": ["faphouse"],
                    "uploader": "",
                    "is_hls": ".m3u8" in clean_low,
                }

        opener = self._build_opener()
        cookie_hdr = self._build_cookie_header()
        headers = {
            "User-Agent": self.USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://faphouse.com/videos",
        }
        if cookie_hdr:
            headers["Cookie"] = cookie_hdr

        req = urllib.request.Request(clean_url, headers=headers)

        try:
            with opener.open(req, timeout=20) as resp:
                page_html = resp.read().decode("utf-8", errors="ignore")
        except Exception as exc:
            logger.error(f"[Faphouse] Request failed for {clean_url}: {exc}")
            return None

        # 1. Parse Title
        title = ""
        title_match = re.search(r'<title>(.*?)</title>', page_html, re.I | re.DOTALL)
        if title_match:
            raw_title = html.unescape(title_match.group(1).strip())
            title = re.sub(r'\s*\|\s*Faphouse.*$', '', raw_title, flags=re.I).strip()

        og_title = re.search(r'<meta property="og:title" content="([^"]+)"', page_html)
        if og_title and not title:
            title = html.unescape(og_title.group(1).strip())

        # 2. Parse Thumbnail
        thumbnail = ""
        og_img = re.search(r'<meta property="og:image" content="([^"]+)"', page_html)
        if og_img:
            thumbnail = html.unescape(og_img.group(1).strip())
        if not thumbnail:
            thumb_match = re.search(r'(https?://[^"\'\s<>]*(?:flixcdn\.com)[^"\'\s<>]*/(?:frame|original)/[^"\'\s<>]+)', page_html)
            if thumb_match:
                thumbnail = thumb_match.group(1)

        # 3. Real duration + access state, straight from the page's own state blob
        view_state = self._view_state(page_html)
        video_state = view_state.get("video") or {}
        user_state = view_state.get("user") or {}

        duration = 0
        try:
            duration = int(float(video_state.get("duration") or 0))
        except (TypeError, ValueError):
            duration = 0
        if not duration:
            dur_text = re.search(r'class="t-vi"[^>]*>.*?(?:<span>)?(\d{1,2}:\d{2}(?::\d{2})?)(?:</span>)?', page_html, re.I | re.DOTALL)
            if dur_text:
                parts = [int(p) for p in dur_text.group(1).split(":")]
                duration = parts[0] * 60 + parts[1] if len(parts) == 2 else parts[0] * 3600 + parts[1] * 60 + parts[2]

        # 4. The player's stream. Whole-page scan first (finds the `_TPL_` HLS
        # master, which is the only place the top quality actually lives); the
        # narrow <video>-tag scan is a fallback for a page with no manifest.
        stream_url, stream_kind, height = _find_best_stream(page_html)
        if not stream_url:
            stream_url, stream_kind, height = self._find_player_stream(page_html)
        width = int(height * (16 / 9)) if height else 0

        # 5. Refuse a trailer instead of passing it off as the video. Faphouse
        # serves the trailer to any session that may not stream the feature, so
        # the trailer IS the "no access" signal; `videoViewAllowed` states the
        # same thing outright and is checked first when the page provides it.
        view_allowed = video_state.get("videoViewAllowed")
        locked = view_allowed is False or stream_kind in _TRAILER_KINDS
        if locked:
            access_type = str(video_state.get("videoAccessType") or "premium")
            signed_in = bool(user_state.get("currentUserId"))
            if signed_in:
                detail = f"prihlásený účet nemá prístup k tomuto videu ({access_type})"
            else:
                detail = (f"video je {access_type} a relácia nie je prihlásená — "
                          "obnov faphouse.netscape.txt z prihláseného prehliadača")
            logger.warning("[Faphouse] No full-stream access for %s (%s, kind=%s, signed_in=%s)",
                           clean_url, access_type, stream_kind or "n/a", signed_in)
            raise FaphouseAccessError(detail)

        if not stream_url:
            logger.warning("[Faphouse] No stream found on the player element for %s", clean_url)
            return None

        # 6. Extract Tags & Actors
        tags: List[str] = []
        for t in re.finditer(r'/tags/[^"\'>]+["\']>([^<]+)</a>', page_html):
            tag_name = html.unescape(t.group(1).strip())
            if tag_name and tag_name not in tags:
                tags.append(tag_name)

        uploader = str(video_state.get("studioName") or "").strip()
        if not uploader:
            model_match = re.search(r'/(?:models|studios|channels)/[^"\'>]+["\']>([^<]+)</a>', page_html)
            if model_match:
                uploader = html.unescape(model_match.group(1).strip())

        slug_match = re.search(r'/videos/[^/?#]*-([a-zA-Z0-9]+)', clean_url)
        video_id = slug_match.group(1) if slug_match else clean_url

        # The watch page used to be returned here whenever no stream was found,
        # on the theory that a caller would take over with browser capture. No
        # caller does: the tester and the player both feed stream_url straight
        # to a <video>, which then loads HTML and fails with no usable error —
        # this was the whole "faphouse videos don't play" symptom. A missing
        # stream is now an explicit failure above instead.
        return {
            "id": f"faphouse:{video_id}",
            "title": title or f"Faphouse Video {video_id}",
            "description": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "stream_url": stream_url,
            "width": width,
            "height": height,
            "tags": tags,
            "uploader": uploader,
            "is_hls": ".m3u8" in stream_url.lower(),
        }