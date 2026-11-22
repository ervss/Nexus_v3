import os
import time
import threading
import logging
import asyncio
import httpx
import yt_dlp

from .base import VideoExtractor
from typing import Optional, Dict, Any, Tuple, List

# Krátky cache znižuje počet volaní yt-dlp pri opakovaných requestoch; stále relatívne čerstvé linky.
_VK_PLAYBACK_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}
_VK_CACHE_LOCK = threading.Lock()
VK_PLAYBACK_CACHE_TTL = float(os.environ.get("VK_PLAYBACK_CACHE_TTL", "300"))
VK_PLAYBACK_RETRIES = int(os.environ.get("VK_PLAYBACK_RETRIES", "3"))
VK_PLAYBACK_RETRY_DELAY = float(os.environ.get("VK_PLAYBACK_RETRY_DELAY", "0.8"))

# Socket ceiling for every VK yt-dlp pass. Without it yt-dlp falls back to its
# own generous default and a single unresponsive m.vkvideo.ru challenge request
# can hold a worker thread for minutes.
VK_SOCKET_TIMEOUT = float(os.environ.get("VK_SOCKET_TIMEOUT", "12"))

# VK serves its JS challenge from a rate-limited endpoint. When many videos are
# resolved together it answers 429; yt-dlp surfaces that as "Unable to solve JS
# challenge". A short global cooldown lets the burst drain instead of every
# worker retrying into the same wall.
_VK_THROTTLE_LOCK = threading.Lock()
_VK_THROTTLED_UNTIL = 0.0
VK_THROTTLE_COOLDOWN = float(os.environ.get("VK_THROTTLE_COOLDOWN", "20"))


def _vk_is_rate_limited(err: object) -> bool:
    text = str(err).lower()
    return "429" in text or "too many requests" in text


def _vk_note_rate_limit() -> None:
    """Open a short global cooldown window after VK answers 429."""
    global _VK_THROTTLED_UNTIL
    with _VK_THROTTLE_LOCK:
        _VK_THROTTLED_UNTIL = max(_VK_THROTTLED_UNTIL, time.monotonic() + VK_THROTTLE_COOLDOWN)


def _vk_wait_for_throttle(max_wait: float = 30.0) -> None:
    """Block briefly if VK recently rate-limited us. Bounded so it never hangs."""
    with _VK_THROTTLE_LOCK:
        until = _VK_THROTTLED_UNTIL
    remaining = until - time.monotonic()
    if remaining > 0:
        time.sleep(min(remaining, max_wait))


class _VkYdlLogger:
    """Sees yt-dlp's own error output so 429s can open the cooldown.

    Necessary because these extractors run with ignoreerrors=True: yt-dlp
    swallows a failed challenge and returns None instead of raising, so the
    rate-limit signal exists only in its log stream.
    """

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        if _vk_is_rate_limited(msg):
            _vk_note_rate_limit()

    def error(self, msg):
        if _vk_is_rate_limited(msg):
            _vk_note_rate_limit()
            logging.warning("VK rate-limited (429) — pausing VK work for %ss", VK_THROTTLE_COOLDOWN)
        else:
            logging.debug("yt-dlp VK: %s", msg)

_VK_SIZE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def _vk_direct_mp4_candidates(info: Dict[str, Any]) -> List[Tuple[int, str]]:
    """Direct-MP4 renditions (url144…url1080), best height first.

    VK also exposes dash_/hls_ formats for the same video, but only these
    plain-https `url<height>` ones are single files we can size with one request.
    """
    out: List[Tuple[int, str]] = []
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict) or not fmt.get("url"):
            continue
        if (fmt.get("protocol") or "").lower() != "https":
            continue
        if not str(fmt.get("format_id") or "").startswith("url"):
            continue
        out.append((int(fmt.get("height") or 0), fmt["url"]))
    out.sort(key=lambda item: item[0], reverse=True)
    return out


def _vk_probe_size_bytes(info: Dict[str, Any]) -> int:
    """Exact file size for VK's best direct MP4.

    yt-dlp reports filesize=None for every VK format, so the size has to come
    from the CDN itself. okcdn rejects a bare request with 400 — it needs a
    browser User-Agent — and a 1-byte Range GET returns the full length in
    Content-Range, which costs one request and no real download.
    """
    for height, url in _vk_direct_mp4_candidates(info):
        try:
            with httpx.Client(timeout=15, follow_redirects=True) as client:
                resp = client.get(
                    url,
                    headers={
                        "User-Agent": _VK_SIZE_UA,
                        "Referer": "https://vk.com/",
                        "Range": "bytes=0-0",
                    },
                )
            content_range = resp.headers.get("content-range") or ""
            if "/" in content_range:
                total = content_range.rsplit("/", 1)[-1].strip()
                if total.isdigit() and int(total) > 0:
                    return int(total)
            if resp.status_code == 200:
                cl = resp.headers.get("content-length")
                if cl and cl.isdigit() and int(cl) > 1:
                    return int(cl)
        except Exception as exc:
            logging.debug("VK size probe failed for %sp: %s", height, exc)
    return 0


def _is_vk_dash_format(fmt: Dict[str, Any]) -> bool:
    """Return True for MPEG-DASH / .mpd formats that HTML5 <video> cannot play."""
    proto = str(fmt.get("protocol") or "").lower()
    furl = str(fmt.get("url") or "").lower()
    fid = str(fmt.get("format_id") or "").lower()
    return "dash" in proto or ".mpd" in furl or fid.startswith("dash")


def _is_vk_hls_format(fmt: Dict[str, Any]) -> bool:
    """Return True for HLS / .m3u8 formats."""
    proto = str(fmt.get("protocol") or "").lower()
    furl = str(fmt.get("url") or "").lower()
    fid = str(fmt.get("format_id") or "").lower()
    return "m3u8" in proto or ".m3u8" in furl or "video-hls" in furl or fid.startswith("hls")


def _is_vk_av_playable(fmt: Dict[str, Any]) -> bool:
    """Reject split video-only or audio-only formats (e.g. DASH elementary streams)."""
    vcodec = str(fmt.get("vcodec") or "").lower()
    acodec = str(fmt.get("acodec") or "").lower()
    return vcodec != "none" and acodec != "none"


def _select_vk_best_format(formats: List[Dict[str, Any]]) -> Tuple[Optional[Dict[str, Any]], int]:
    """Select the best directly playable VK format (progressive MP4 first, HLS fallback)."""
    best_format: Optional[Dict[str, Any]] = None
    max_height = -1

    # First pass: progressive MP4 (never DASH .mpd, never HLS .m3u8, never video/audio-only)
    for f in formats:
        if not isinstance(f, dict) or not f.get("url"):
            continue
        if _is_vk_dash_format(f) or _is_vk_hls_format(f) or not _is_vk_av_playable(f):
            continue
        height = int(f.get("height") or 0)
        is_direct_url = str(f.get("format_id") or "").startswith("url")
        if height > max_height or (
            height == max_height
            and is_direct_url
            and not str((best_format or {}).get("format_id") or "").startswith("url")
        ):
            max_height = height
            best_format = f

    # Second pass: HLS fallback (still never DASH .mpd or split streams)
    if not best_format:
        max_height = -1
        for f in formats:
            if not isinstance(f, dict) or not f.get("url"):
                continue
            if _is_vk_dash_format(f) or not _is_vk_av_playable(f):
                continue
            height = int(f.get("height") or 0)
            if height > max_height:
                max_height = height
                best_format = f

    return best_format, max(0, max_height)


class VKExtractor(VideoExtractor):
    @property
    def name(self) -> str:
        return "VK"

    def can_handle(self, url: str) -> bool:
        return any(domain in url.lower() for domain in ['vk.com', 'vk.video', 'vkvideo.ru', 'vkvideo.net', 'vkvideo.com', 'vk.ru', 'okcdn.ru'])

    async def extract(self, url: str) -> Optional[Dict[str, Any]]:
        """
        Extract VK video metadata.
        Note: We store the VK page URL, not the direct stream URL (which expires).
        Stream URLs are extracted on-demand via the streaming endpoint.
        """
        return await asyncio.to_thread(self._extract_ytdlp, url)

    def _extract_ytdlp(self, url: str) -> Optional[Dict[str, Any]]:
        # Better User-Agent to avoid 'registered users' block on some public videos
        user_agent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        ydl_opts = {
            'quiet': True,
            'skip_download': True,
            'lazy_extractors': True,
            'no_check_formats': True,
            'no_check_certificate': True,
            'ignoreerrors': True,
            'no_warnings': True,
            'user_agent': user_agent,
            # Bound every network wait. yt-dlp's own retry ladder is capped too:
            # left at its defaults a rate-limited VK link retries for minutes
            # inside an uncancellable thread and stalls whatever batch it is in.
            'socket_timeout': VK_SOCKET_TIMEOUT,
            'retries': 1,
            'extractor_retries': 1,
            'fragment_retries': 1,
            'logger': _VkYdlLogger(),
            'http_headers': {
                'User-Agent': user_agent,
                'Referer': 'https://vk.com/',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-us,en;q=0.5'
            }
        }
        
        # Try to use cookies if available
        vk_cookie_candidates = [
            os.path.join("app", "vkvideo.ru_cookies.txt"),
            os.path.join("app", "vk.com_cookies.txt"),
            os.path.join("app", "vk.netscape.txt"),
            os.path.join("app", "cookies.netscape.txt"),
            "vkvideo.ru_cookies.txt",
            "vk.com_cookies.txt",
            "vk.netscape.txt",
        ]
        _cookie_file = next((p for p in vk_cookie_candidates if os.path.exists(p)), None)
        if _cookie_file:
            ydl_opts['cookiefile'] = _cookie_file
        
        # Respect a cooldown opened by an earlier 429 before spending a slot.
        _vk_wait_for_throttle()

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                if not info:
                    return None

                # Get best format - prefer progressive MP4 over HLS and never pick DASH (.mpd)
                formats = info.get('formats', [])
                best_format, max_height = _select_vk_best_format(formats)

                # Fallback to info URL if no formats (but never return a DASH .mpd manifest)
                fallback_url = info.get('url')
                if fallback_url and '.mpd' in str(fallback_url).lower():
                    fallback_url = None
                stream_url = best_format['url'] if best_format else fallback_url
                if not stream_url:
                    return None
                
                # Smarter HLS detection using protocol and URL content
                protocol = (best_format.get('protocol') or '').lower() if best_format else ''
                is_hls = 'm3u8' in protocol or '.m3u8' in (stream_url or '').lower() or 'video-hls' in (stream_url or '').lower()
                
                # Force #hls.m3u8 if it is HLS to ensure frontend detection
                if is_hls and '.m3u8' not in (stream_url or '').lower():
                    if '#' in stream_url:
                        stream_url += '&hls.m3u8'
                    else:
                        stream_url += '#hls.m3u8'

                return {
                    "id": info.get('id'),
                    "title": info.get('title') or "VK Video",
                    "description": info.get('description') or "",
                    "thumbnail": info.get('thumbnail'),
                    "duration": info.get('duration') or 0,
                    "stream_url": stream_url,  # Use extracted stream URL
                    "width": best_format.get('width', 0) if best_format else 0,
                    "height": max_height,
                    "tags": info.get('tags', []),
                    "uploader": info.get('uploader') or "",
                    "uploader_url": info.get('uploader_url') or info.get('channel_url') or "",
                    "upload_date": info.get('upload_date') or "",
                    "canonical_url": info.get('webpage_url') or url,
                    "is_hls": is_hls,
                    "source": "vk",  # Mark as VK for special handling
                    "size_bytes": (
                        info.get('filesize')
                        or info.get('filesize_approx')
                        or (best_format.get('filesize') if best_format else 0)
                        or _vk_probe_size_bytes(info)
                        or 0
                    ),
                    "raw_json": info
                }
        except Exception as e:
            if _vk_is_rate_limited(e):
                _vk_note_rate_limit()
                logging.warning(
                    "VK rate-limited (429) for %s — pausing VK work for %ss",
                    url, VK_THROTTLE_COOLDOWN,
                )
            else:
                logging.error(f"VK extraction failed for {url}: {e}")
            return None


def _playback_subset(full: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "stream_url": full["stream_url"],
        "is_hls": full.get("is_hls", False),
        "height": full.get("height") or 0,
        "duration": full.get("duration") or 0,
    }


def _cache_key(url: str) -> str:
    u = (url or "").strip()
    if "?" in u:
        u = u.split("?", 1)[0]
    return u


def extract_vk_playback_resilient(
    page_url: str, *, force_refresh: bool = False
) -> Optional[Dict[str, Any]]:
    """
    Čerstvý playback URL pre VK stránku: retry + krátky in-memory cache.
    force_refresh=True obíde cache (napr. po 403 alebo expirovanom linke).
    """
    key = _cache_key(page_url)
    now = time.monotonic()
    if not force_refresh:
        with _VK_CACHE_LOCK:
            hit = _VK_PLAYBACK_CACHE.get(key)
            if hit and hit[0] > now:
                return dict(hit[1])

    ext = VKExtractor()
    last_err: Optional[Exception] = None
    for attempt in range(1, VK_PLAYBACK_RETRIES + 1):
        try:
            full = ext._extract_ytdlp(page_url)
            if full and full.get("stream_url"):
                payload = _playback_subset(full)
                ttl = VK_PLAYBACK_CACHE_TTL
                with _VK_CACHE_LOCK:
                    _VK_PLAYBACK_CACHE[key] = (now + ttl, dict(payload))
                return payload
        except Exception as e:
            last_err = e
            logging.warning(f"VK playback attempt {attempt}/{VK_PLAYBACK_RETRIES} failed: {e}")
        if attempt < VK_PLAYBACK_RETRIES:
            time.sleep(VK_PLAYBACK_RETRY_DELAY * attempt)

    if last_err:
        logging.error(f"VK playback failed after retries for {page_url}: {last_err}")
    return None
