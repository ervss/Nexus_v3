from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Optional
import asyncio
import http.cookiejar
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
from contextlib import AsyncExitStack
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse

import aiohttp
import httpx
from cachetools import TTLCache

from ..extractors.registry import ExtractorRegistry
from ..extractors import init_registry, register_extended_extractors
from ..extractors.bunkr import BunkrExtractor
from ..extractors.faphouse import FaphouseAccessError
from ..extractors.filester import FilesterExtractor, is_fileditch_url
from ..eporner_transport import EpornerListingError
from ..mp4_probe import cache_get as mp4_probe_cache_get, probe_mp4_cached
from ..url_safety import require_public_http_url
from ..database import get_db
from ..ntc import ntc

_EPORNER_LIBRARY_PATH = Path(__file__).resolve().parents[2] / "data" / "eporner_tester_library.json"
_EPORNER_LIBRARY_MAX = 25000
_EPORNER_LIBRARY_MAX_BYTES = 80 * 1024 * 1024

_TURBO_VAULT_PATH = Path(__file__).resolve().parents[2] / "data" / "turbo_vault_library.json"
_TURBO_VAULT_MAX_ALBUMS = 25000
_TURBO_VAULT_MAX_BYTES = 100 * 1024 * 1024

_bunkr_extractor = BunkrExtractor()
_filester_extractor = FilesterExtractor()

# Card-level metadata from listing resolve. Rýchle meta reuses this instead of
# hitting every watch page / HLS playlist again.
_LISTING_META: Dict[str, Dict[str, Any]] = {}
_FULL_CARD_META = TTLCache(maxsize=2000, ttl=900)
_TESTER_LISTING_MAX_PAGES = 2
_TESTER_LISTING_MAX_ENTRIES = 50


def _listing_meta_key(url: str) -> str:
    return (url or "").split("#")[0].split("?")[0].strip()


def _listing_meta_cache_clear() -> None:
    _LISTING_META.clear()


def _remember_listing_meta(url: str, payload: Dict[str, Any]) -> None:
    key = _listing_meta_key(url)
    if not key or not isinstance(payload, dict):
        return
    _LISTING_META[key] = dict(payload)


def _listing_meta_get(url: str) -> Optional[Dict[str, Any]]:
    return _LISTING_META.get(_listing_meta_key(url))

init_registry()
register_extended_extractors()

router = APIRouter(prefix="/api/tester", tags=["tester"])
from ..turbo_overview import router as turbo_overview_router
router.include_router(turbo_overview_router)
logger = logging.getLogger(__name__)


def _require_public_proxy_url(value: str) -> str:
    try:
        return require_public_http_url(value)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


def _read_eporner_library() -> list[dict[str, Any]]:
    try:
        payload = json.loads(_EPORNER_LIBRARY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []
    rows = payload.get("videos") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict) and row.get("id") and row.get("url")][-_EPORNER_LIBRARY_MAX:]


def _write_eporner_library(rows: list[dict[str, Any]]) -> int:
    compact = [row for row in rows if isinstance(row, dict) and row.get("id") and row.get("url")]
    compact = compact[-_EPORNER_LIBRARY_MAX:]
    encoded = json.dumps({"version": 1, "videos": compact}, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _EPORNER_LIBRARY_MAX_BYTES:
        raise ValueError("Eporner tester library is too large")
    _EPORNER_LIBRARY_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = _EPORNER_LIBRARY_PATH.with_suffix(".tmp")
    temporary.write_text(encoded, encoding="utf-8")
    temporary.replace(_EPORNER_LIBRARY_PATH)
    return len(compact)


def _read_turbo_vault_library() -> list[dict[str, Any]]:
    try:
        payload = json.loads(_TURBO_VAULT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return []
    albums = payload.get("albums") if isinstance(payload, dict) else payload
    if not isinstance(albums, list):
        return []
    return [a for a in albums if isinstance(a, dict) and a.get("id")]


def _write_turbo_vault_library(incoming_albums: list[dict[str, Any]]) -> int:
    existing = {a["id"]: a for a in _read_turbo_vault_library() if isinstance(a, dict) and a.get("id")}
    for alb in incoming_albums:
        if isinstance(alb, dict) and alb.get("id"):
            existing[alb["id"]] = alb
    sorted_albums = list(existing.values())[-_TURBO_VAULT_MAX_ALBUMS:]
    encoded = json.dumps({"version": 1, "albums": sorted_albums}, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _TURBO_VAULT_MAX_BYTES:
        raise ValueError("Turbo vault library is too large")
    _TURBO_VAULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = _TURBO_VAULT_PATH.with_suffix(".tmp")
    temporary.write_text(encoded, encoding="utf-8")
    temporary.replace(_TURBO_VAULT_PATH)
    return len(sorted_albums)

MAX_LINKS = 500
MAX_CONCURRENCY = 16
MAX_CONCURRENCY_TURBO = 40  # turbo.cr / cyberdrop — fast API, safe to hammer with 40 parallel

# VK gates video pages behind a JS challenge served from m.vkvideo.ru. That
# endpoint rate-limits per client, so resolving VK links at the default 16-wide
# concurrency earns HTTP 429 ("Unable to solve JS challenge") for most of the
# batch. Keep VK on its own narrower lane. If 429s reappear in the log, lower
# this first — the 429 cooldown in extractors/vk.py absorbs bursts, but it
# cannot fix a concurrency level VK simply refuses.
MAX_CONCURRENCY_VK = int(os.environ.get("TESTER_MAX_CONCURRENCY_VK", "8"))

# Eporner's watch-page resolver performs a page GET and can also resolve a
# download URL.  Sending a whole 60-link selection through the generic 16/50
# wide lanes therefore becomes a short burst of well over 60 requests.  Keep
# these requests in a deliberately small, paced lane instead.  This is a
# courteous client-side limit, not an IP-masking or rate-limit workaround.
MAX_CONCURRENCY_EPORNER = max(1, int(os.environ.get("TESTER_MAX_CONCURRENCY_EPORNER", "1")))
EPORNER_MIN_GAP_SECONDS = max(1.0, float(os.environ.get("TESTER_EPORNER_MIN_GAP_SECONDS", "2.0")))
EPORNER_RETRY_ATTEMPTS = max(1, min(3, int(os.environ.get("TESTER_EPORNER_RETRY_ATTEMPTS", "2"))))
PER_URL_TIMEOUT_SECONDS_EPORNER = max(90, int(os.environ.get("TESTER_EPORNER_TIMEOUT_SECONDS", "120")))
# A full playlist walks every listing page. The 120s watch-page budget cuts that
# walk off after the first pages, so listings get their own ceiling.
PER_URL_TIMEOUT_SECONDS_EPORNER_LISTING = max(
    PER_URL_TIMEOUT_SECONDS_EPORNER,
    int(os.environ.get("TESTER_EPORNER_LISTING_TIMEOUT_SECONDS", "900")),
)

# Requests can arrive through both the normal and SSE tester endpoints at the
# same time.  Reserve starts process-wide so separate batches cannot combine
# into a burst from this machine.  A standard lock is used only for the tiny
# timestamp update; the actual wait remains asynchronous.
_EPORNER_PACE_LOCK = threading.Lock()
_EPORNER_NEXT_START = 0.0

# Hard ceiling for a single link, whatever the host. Extractors run yt-dlp and
# other blocking libraries inside asyncio.to_thread, which cannot be cancelled;
# without this ceiling one wedged link holds its concurrency slot indefinitely
# and the whole batch appears frozen (seen live: a VK batch stuck at 72/110).
# Timing out frees the slot so the remaining links keep flowing.
PER_URL_TIMEOUT_SECONDS = 75
PER_URL_TIMEOUT_SECONDS_VK = 100  # VK adds a challenge round-trip before metadata
_HTTP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

_TURBO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Referer": "https://turbo.cr/",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

_PORNTREX_HEADERS = {
    "User-Agent": _HTTP_HEADERS["User-Agent"],
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.porntrex.com/",
}


async def _ntc_page(url: str, *, domain: Optional[str] = None, headers: Optional[Dict[str, str]] = None,
                    deadline: float = 18.0) -> tuple[int, str, str]:
    """Fetch HTML through NTC. Returns (status, body, final_url)."""
    resp = await ntc.request(url, domain=domain, headers=headers, deadline=deadline)
    return int(resp.status_code or 0), resp.text or "", resp.url or url

# A few video hosts expose a valid HLS stream but publish a poster URL that is
# no longer reachable.  Keep a small in-memory cache of frames generated for
# those cards so scrolling or re-rendering does not start ffmpeg again.
_STREAM_FRAME_CACHE: Dict[str, tuple[float, bytes]] = {}
_STREAM_FRAME_SEMAPHORE = asyncio.Semaphore(3)
_STREAM_FRAME_TTL_SECONDS = 60 * 30


class TestLinksRequest(BaseModel):
    urls: List[str]
    metadata_only: bool = False


class BatchMetaRequest(BaseModel):
    urls: List[str]
    metadata_only: bool = False
    full_metadata: bool = False


class EpornerPlaylistSearchRequest(BaseModel):
    keyword: str
    limit: int = 50
    pages: int = 25
    sort: str = "newest"
    video_keyword: str = ""


class EpornerPlaylistTitlesRequest(BaseModel):
    urls: List[str]


class EpornerMixCreateRequest(BaseModel):
    playlists: List[Dict[str, Any]]
    name: str = ""
    snapshot: Optional[Dict[str, Any]] = None


class EpornerMixUpdateRequest(BaseModel):
    snapshot: Dict[str, Any]


class XXBritsPlaylistBatchRequest(BaseModel):
    playlist_url: str
    start_page: int = 1


class XVideosPlaylistBatchRequest(BaseModel):
    playlist_url: str
    start_page: int = 2


def _normalize_url(raw_url: str) -> str:
    value = (raw_url or "").strip()
    if not value:
        return ""
    if not re.match(r"^https?://", value, re.I):
        return ""
    return value


def _is_porntrex_url(url: str) -> bool:
    host = urlparse(url).netloc.lower().lstrip("www.")
    return host == "porntrex.com" or host.endswith(".porntrex.com")


def _is_eporner_url(url: str) -> bool:
    """Allow only HTTPS Eporner origins, never a lookalike host or HTTP URL."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme.lower() == "https" and (host == "eporner.com" or host.endswith(".eporner.com"))


def _is_eporner_watch_url(url: str) -> bool:
    if not _is_eporner_url(url):
        return False
    path = urlparse(url).path or ""
    return bool(re.search(r"/(?:video-|hd-porn/)[A-Za-z0-9]+", path, re.I))


def _is_eporner_listing_url(url: str) -> bool:
    if not _is_eporner_url(url):
        return False
    path = urlparse(url).path or ""
    return bool(re.search(r"/(?:gallery|playlist|profile)/", path, re.I))


def _eporner_cookie_header() -> str:
    for cookie_path in ("eporner.netscape.txt", "eporner.cookies.txt"):
        if not os.path.exists(cookie_path):
            continue
        try:
            jar = http.cookiejar.MozillaCookieJar(cookie_path)
            jar.load(ignore_discard=True, ignore_expires=True)
            cookies = {c.name: c.value for c in jar if "eporner.com" in (c.domain or "")}
            if cookies:
                return "; ".join(f"{k}={v}" for k, v in cookies.items())
        except Exception:
            logger.debug("[Link Tester] Eporner cookie load failed", exc_info=True)
        break
    return ""


class EpornerPacer:
    """A narrow Eporner lane with process-wide spacing between request starts.

    The semaphore caps work within a batch.  The shared timestamp additionally
    prevents two simultaneous tester requests from producing two independent
    bursts from the same machine.
    """

    def __init__(self, *, concurrency: int = MAX_CONCURRENCY_EPORNER,
                 min_gap_seconds: float = EPORNER_MIN_GAP_SECONDS) -> None:
        self._semaphore = asyncio.Semaphore(max(1, concurrency))
        self._min_gap_seconds = max(0.0, min_gap_seconds)

    async def __aenter__(self):
        await self._semaphore.acquire()
        try:
            await self._wait_for_turn()
        except BaseException:
            self._semaphore.release()
            raise
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        self._semaphore.release()

    async def _wait_for_turn(self) -> None:
        global _EPORNER_NEXT_START
        with _EPORNER_PACE_LOCK:
            now = time.monotonic()
            scheduled = max(now, _EPORNER_NEXT_START)
            _EPORNER_NEXT_START = scheduled + self._min_gap_seconds
        wait = scheduled - now
        if wait > 0:
            await asyncio.sleep(wait)

    async def retry_after(self, seconds: float) -> None:
        """Wait a shared backoff and reserve a normally spaced retry slot."""
        global _EPORNER_NEXT_START
        with _EPORNER_PACE_LOCK:
            now = time.monotonic()
            scheduled = max(now + max(0.0, seconds), _EPORNER_NEXT_START)
            _EPORNER_NEXT_START = scheduled + self._min_gap_seconds
        wait = scheduled - now
        if wait > 0:
            await asyncio.sleep(wait)


def _first_match(patterns: List[str], html: str) -> str:
    for pattern in patterns:
        match = re.search(pattern, html, re.I | re.S)
        if match:
            return re.sub(r"\s+", " ", match.group(1)).strip()
    return ""


def _parse_intish(value: str) -> int:
    match = re.search(r"([\d,.]+)\s*([km])?", value or "", re.I)
    if not match:
        return 0
    try:
        number = float(match.group(1).replace(",", ""))
    except ValueError:
        return 0
    suffix = (match.group(2) or "").lower()
    if suffix == "m":
        number *= 1_000_000
    elif suffix == "k":
        number *= 1_000
    return int(number)


def _parse_duration_text(value: str) -> int:
    text = (value or "").strip()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    match = re.search(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b", text)
    if not match:
        return 0
    h_or_m = int(match.group(1))
    minutes_or_seconds = int(match.group(2))
    seconds = int(match.group(3) or 0)
    if match.group(3) is not None:
        return h_or_m * 3600 + minutes_or_seconds * 60 + seconds
    return h_or_m * 60 + minutes_or_seconds
def _extract_porntrex_meta_from_html(url: str, html: str) -> Dict[str, Any]:
    title = _first_match([
        r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:title["\']',
        r"<h1[^>]*>(.*?)</h1>",
        r"<title[^>]*>(.*?)</title>",
    ], html)
    title = re.sub(r"\s*[-|]\s*(?:porn)?trex\s*$", "", title, flags=re.I).strip() or "Porntrex Video"

    thumbnail = _first_match([
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        r'poster=["\']([^"\']+)["\']',
        r'data-(?:src|original|thumb)=["\']([^"\']+\.(?:jpg|jpeg|png|webp)(?:\?[^"\']*)?)["\']',
        r'<img[^>]+src=["\']([^"\']+\.(?:jpg|jpeg|png|webp)(?:\?[^"\']*)?)["\']',
    ], html)
    if thumbnail:
        thumbnail = urljoin(url, thumbnail.replace("\\/", "/"))

    # --- PORNTREX DURATION: compute from timeline_screens_interval * timeline_screens_count ---
    # The generic duration patterns incorrectly pick up adv_pre_skip_duration (5s ad skip).
    # The only reliable duration source on Porntrex is the player flashvars timeline info.
    duration = 0
    _fv_interval = re.search(r"timeline_screens_interval\s*:\s*'(\d+)'", html)
    _fv_count = re.search(r"timeline_screens_count\s*:\s*'(\d+)'", html)
    if _fv_interval and _fv_count:
        try:
            duration = int(_fv_interval.group(1)) * int(_fv_count.group(1))
        except Exception:
            duration = 0
    if not duration:
        # Fallback: meta tags (video:duration)
        duration = _parse_duration_text(_first_match([
            r'<meta[^>]+(?:property|name)=["\'](?:video:duration|og:video:duration)["\'][^>]+content=["\']([^"\']+)["\']',
            r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:video:duration|og:video:duration)["\']',
        ], html))

    # --- PORNTREX QUALITY & STREAM URL: parse from flashvars video_alt_urlN fields ---
    # flashvars contains: video_url (480p), video_alt_url (720p), video_alt_url2 (1080p), etc.
    stream_url = ""
    height = 0
    _fv_match = re.search(r'var\s+flashvars\s*=\s*\{(.+?)\};', html, re.DOTALL)
    if _fv_match:
        _fv = _fv_match.group(1)
        _quality_map: Dict[int, str] = {}
        # Base URL
        _bu = re.search(r"video_url\s*:\s*'([^']+)'", _fv)
        _bt = re.search(r"video_url_text\s*:\s*'([^']+)'", _fv)
        if _bu and _bt:
            _q = re.search(r'(\d{3,4})', _bt.group(1))
            _h = int(_q.group(1)) if _q else 480
            _quality_map[_h] = _bu.group(1).rstrip('/')
        # Alt URLs (video_alt_url, video_alt_url2 ... video_alt_url9)
        for _suffix in ['', '2', '3', '4', '5', '6', '7', '8', '9']:
            _au = re.search(rf"video_alt_url{_suffix}\s*:\s*'([^']+)'", _fv)
            _at = re.search(rf"video_alt_url{_suffix}_text\s*:\s*'([^']+)'", _fv)
            if _au and _at:
                _q = re.search(r'(\d{3,4})', _at.group(1))
                _h = int(_q.group(1)) if _q else 480
                _quality_map[_h] = _au.group(1).rstrip('/')
        if _quality_map:
            height = max(_quality_map.keys())
            stream_url = _quality_map[height]
    if not height:
        # Fallback: search for quality badge in HTML (first match may be a related video, but better than nothing)
        quality_text = _first_match([r'\b(2160p|1440p|1080p|720p|480p|360p|4k)\b'], html)
        if quality_text:
            if quality_text.lower() == "4k":
                height = 2160
            else:
                try:
                    height = int(re.sub(r"\D", "", quality_text))
                except ValueError:
                    height = 0

    views = _parse_intish(_first_match([
        r'([\d,.]+\s*[km]?)\s*views?',
        r'views?[^0-9]{0,24}([\d,.]+\s*[km]?)',
    ], html))

    tags: List[str] = []
    for tag in re.findall(r'<a[^>]+href=["\'][^"\']*(?:tags?|categories)/[^"\']+["\'][^>]*>(.*?)</a>', html, re.I | re.S):
        clean = re.sub(r"<[^>]+>", "", tag)
        clean = re.sub(r"\s+", " ", clean).strip()
        if clean and clean.lower() not in {t.lower() for t in tags}:
            tags.append(clean)

    uploader = _first_match([
        r'(?:uploader|author|user|model)[^>]*>\s*<a[^>]*>(.*?)</a>',
        r'<a[^>]+href=["\'][^"\']*members/[^"\']+["\'][^>]*>(.*?)</a>',
    ], html)
    uploader = re.sub(r"<[^>]+>", "", uploader).strip()

    return {
        "url": url,
        "ok": True,
        "title": title,
        "thumbnail": thumbnail,
        "duration": duration,
        "views": views,
        "height": height,
        "width": int(height * 16 / 9) if height else 0,
        "quality": "4K" if height >= 2160 else (f"{height}p" if height else ""),
        "tags": tags,
        "uploader": uploader,
        "stream_url": stream_url,
    }


def _guess_result_type(url: str, extractor_name: Optional[str], data: Dict[str, Any]) -> str:
    path = (urlparse(url).path or "").lower()
    if data.get("content_type") in {"vk_playlist", "xxbrits_playlist"} or _is_vk_playlist_url(url):
        return "playlist"
    if "/playlist/" in path or "/playlists/" in path:
        return "playlist"
    if data.get("item_count", 0) > 1 or data.get("video_count", 0) > 1:
        return "album"
    if data.get("stream_url") or data.get("is_hls"):
        return "video"
    if extractor_name == "Bunkr" and ("/f/" in path or "/v/" in path):
        return "video"
    if "/a/" in path or "/album" in path or "/f/" in path or "/folder/" in path:
        return "album"
    if extractor_name in {"Bunkr", "Filester", "Erome", "Porntrex", "CyberFile"} and data.get("thumbnail"):
        return "page"
    return "unknown"


def _looks_like_album_url(url: str) -> bool:
    path = (urlparse(url).path or "").lower()
    return bool(re.search(r"/(?:a|album|albums|f)/[a-z0-9_-]+", path, re.I))


def _safe_int(value: Any) -> int:
    try:
        return int(float(value or 0))
    except (TypeError, ValueError):
        return 0


_HUMAN_SIZE_RE = re.compile(
    r"(?P<value>\d+(?:[.,]\d+)?)\s*(?P<unit>[KMGTPE]?I?B|BYTES?)\b", re.I
)
_SIZE_MULTIPLIERS = {
    "B": 1,
    "KB": 1024,
    "KIB": 1024,
    "MB": 1024 ** 2,
    "MIB": 1024 ** 2,
    "GB": 1024 ** 3,
    "GIB": 1024 ** 3,
    "TB": 1024 ** 4,
    "TIB": 1024 ** 4,
    "PB": 1024 ** 5,
    "PIB": 1024 ** 5,
    "EB": 1024 ** 6,
    "EIB": 1024 ** 6,
}


def _parse_size_bytes(value: Any) -> int:
    """Convert a public human-readable file size (``1.25 GB``) to bytes.

    Bunkr album pages publish each file's size in the card markup, rather than
    exposing an album-total API.  Preserve numeric byte fields as-is, and parse
    the visible unit-bearing value when that is all the source supplies.
    """
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return max(0, int(value))

    text = str(value or "").replace("\u00a0", " ").strip()
    if not text:
        return 0
    if text.isdigit():
        return int(text)

    match = _HUMAN_SIZE_RE.search(text)
    if not match:
        return 0
    try:
        amount = float(match.group("value").replace(",", "."))
    except ValueError:
        return 0

    unit = match.group("unit").upper()
    if unit in {"BYTE", "BYTES"}:
        unit = "B"
    return max(0, int(amount * _SIZE_MULTIPLIERS.get(unit, 0)))


_VK_PLAYLIST_PATH_RE = re.compile(r"^/playlist/-?\d+_-?\d+/?$", re.I)


def _is_vk_playlist_url(url: str) -> bool:
    """True only for a concrete VK Video playlist, never a normal VK video."""
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":", 1)[0]
    return host in {"vkvideo.ru", "m.vkvideo.ru", "vk.com", "m.vk.com"} and bool(
        _VK_PLAYLIST_PATH_RE.match(parsed.path or "")
    )


def _vk_cookie_file() -> Optional[str]:
    candidates = (
        "app/vkvideo.ru_cookies.txt",
        "app/vk.com_cookies.txt",
        "app/vk.netscape.txt",
        "app/cookies.netscape.txt",
        "vkvideo.ru_cookies.txt",
        "vk.com_cookies.txt",
        "vk.netscape.txt",
        "cookies.netscape.txt",
    )
    return next((path for path in candidates if os.path.exists(path)), None)


def _vk_playlist_date_score(entry: Dict[str, Any]) -> int:
    """Best-effort sorting key for the four most recently uploaded previews."""
    timestamp = _safe_int(entry.get("timestamp"))
    if timestamp:
        return timestamp
    digits = re.sub(r"\D", "", str(entry.get("upload_date") or ""))
    return _safe_int(digits) if len(digits) == 8 else 0


def _vk_playlist_item_url(entry: Dict[str, Any]) -> str:
    for key in ("webpage_url", "original_url", "url"):
        value = str(entry.get(key) or "").strip()
        if re.match(r"https?://", value, re.I) and "/video" in value:
            return value
    entry_id = str(entry.get("id") or "").strip()
    if re.fullmatch(r"-?\d+_-?\d+", entry_id):
        return f"https://vkvideo.ru/video{entry_id}"
    return ""


def _vk_video_identity(url: str) -> str:
    """Deduplicate vk.com and vkvideo.ru forms of the same playlist item."""
    match = re.search(r"/video(-?\d+_-?\d+)", url or "", re.I)
    return match.group(1) if match else (url or "").rstrip("/").lower()


def _estimate_vk_playlist_size_bytes(entries: List[Dict[str, Any]], video_count: int) -> int:
    """Fast, intentionally labelled estimate until individual streams are expanded.

    VK does not publish a playlist byte total. Looking up every CDN file here
    would turn a one-card probe into N slow video probes, so use the duration
    carried by yt-dlp's flat playlist entries and refine it after expansion.
    """
    durations = [_safe_int(entry.get("duration")) for entry in entries]
    known_durations = [duration for duration in durations if duration > 0]
    if not known_durations:
        # Flat VK responses sometimes omit every duration. Keep the fast card
        # useful with a deliberately conservative 8-minute / 720p baseline;
        # the UI marks it with ≈ and replaces it after expansion.
        total_seconds = max(1, video_count) * 8 * 60
    else:
        total_seconds = sum(known_durations)
        if video_count > len(known_durations):
            total_seconds = int(total_seconds * (video_count / len(known_durations)))
    heights = [_safe_int(entry.get("height")) for entry in entries]
    typical_height = max((height for height in heights if height > 0), default=720)
    bitrate_kbps = 3000 if typical_height >= 1080 else 1500 if typical_height >= 720 else 800
    return total_seconds * bitrate_kbps * 125


def _extract_vk_playlist_fast(url: str) -> Dict[str, Any]:
    """Return a lightweight, import-ready VK playlist without resolving videos.

    `extract_flat` gives us the count and card details in a single yt-dlp pass.
    Streams are deliberately left unresolved until the user expands the card.
    """
    try:
        import yt_dlp

        user_agent = _HTTP_HEADERS["User-Agent"]
        options: Dict[str, Any] = {
            "quiet": True,
            "skip_download": True,
            "extract_flat": True,
            "ignoreerrors": True,
            "no_warnings": True,
            "no_check_certificate": True,
            "socket_timeout": 15,
            # Cap the retry ladder: a rate-limited VK playlist otherwise keeps
            # retrying inside an uncancellable thread long past the point where
            # the batch has any use for the answer.
            "retries": 1,
            "extractor_retries": 1,
            "user_agent": user_agent,
            "http_headers": {
                "User-Agent": user_agent,
                "Referer": "https://vkvideo.ru/",
                "Accept-Language": "en-US,en;q=0.9",
            },
        }
        cookie_file = _vk_cookie_file()
        if cookie_file:
            options["cookiefile"] = cookie_file

        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=False) or {}

        raw_entries = [entry for entry in (info.get("entries") or []) if isinstance(entry, dict)]
        video_count = _safe_int(info.get("playlist_count")) or len(raw_entries)
        if not raw_entries and not video_count:
            return {"url": url, "ok": False, "error": "playlist empty or inaccessible"}

        # A dated list is explicitly sorted newest-first. If VK omits dates,
        # preserve its page order, which is already the current playlist order.
        if any(_vk_playlist_date_score(entry) for entry in raw_entries):
            raw_entries = [entry for _, entry in sorted(
                enumerate(raw_entries),
                key=lambda pair: (_vk_playlist_date_score(pair[1]), -pair[0]),
                reverse=True,
            )]

        album_items: List[Dict[str, Any]] = []
        for entry in raw_entries[:MAX_LINKS]:
            item_url = _vk_playlist_item_url(entry)
            if not item_url:
                continue
            album_items.append({
                "url": item_url,
                "source_url": item_url,
                "title": str(entry.get("title") or "VK Video").strip(),
                "thumbnail": str(entry.get("thumbnail") or "").strip(),
                "duration": _safe_int(entry.get("duration")),
                "upload_date": str(entry.get("upload_date") or "").strip(),
                "height": _safe_int(entry.get("height")),
                "width": _safe_int(entry.get("width")),
                "quality": str(entry.get("format_note") or "").strip(),
                "stream_url": "",
                "size_bytes": 0,
            })

        # Some VK playlist responses intentionally expose only opaque video IDs
        # in yt-dlp's flat mode. In that case, make one short browser pass for
        # the first visible cards only: it supplies the 2x2 mosaic and human
        # titles, without turning this list-level request into N video probes.
        has_useful_preview = any(
            item.get("thumbnail") or item.get("title") not in {"", "VK Video"}
            for item in album_items[:4]
        )
        if album_items and not has_useful_preview:
            try:
                from ..vk_ko_discovery import scan_vk_playlist_videos_sync

                preview_scan = scan_vk_playlist_videos_sync(url, max_videos=4, scroll_rounds=12)
                preview_items = preview_scan.get("videos") or []
                # VK occasionally paints its cards just after the first
                # headless page is closed. One bounded retry is still much
                # faster than resolving metadata for every playlist video.
                if not preview_items:
                    preview_scan = scan_vk_playlist_videos_sync(url, max_videos=4, scroll_rounds=12)
                    preview_items = preview_scan.get("videos") or []
                visual_items: List[Dict[str, Any]] = []
                preview_ids = set()
                for entry in preview_items[:4]:
                    item_url = str(entry.get("url") or "").strip()
                    item_id = _vk_video_identity(item_url)
                    if not item_url or item_id in preview_ids:
                        continue
                    preview_ids.add(item_id)
                    visual_items.append({
                        "url": item_url,
                        "source_url": item_url,
                        "title": str(entry.get("title") or "VK Video").strip(),
                        "thumbnail": str(entry.get("thumbnail") or "").strip(),
                        "duration": 0,
                        "upload_date": str(entry.get("date_text") or "").strip(),
                        "height": 0,
                        "width": 0,
                        "quality": "",
                        "stream_url": "",
                        "size_bytes": 0,
                    })
                if visual_items:
                    # DOM order is VK's newest-first card order. Keep the raw
                    # yt-dlp entries behind it so full expansion still works.
                    album_items = visual_items + [
                        item for item in album_items
                        if _vk_video_identity(str(item.get("source_url") or item.get("url") or "")) not in preview_ids
                    ]
                    scan_playlist = preview_scan.get("playlist") or {}
                    if str(info.get("title") or "").strip().lower() in {"", "vk playlist"}:
                        scanned_title = str(scan_playlist.get("title") or "").strip()
                        if scanned_title:
                            info["title"] = scanned_title
            except Exception as exc:
                logger.debug("[Link Tester] VK playlist preview scan failed for %s: %s", url, exc)

        # VK's flat extractor can repeat the same video when a playlist contains
        # unavailable/reposted placeholders. One expandable card per actual
        # video is more useful than duplicate child cards; the header retains
        # VK's advertised total so the UI can show e.g. 9/12 available items.
        unique_items: List[Dict[str, Any]] = []
        seen_video_ids = set()
        for item in album_items:
            item_id = _vk_video_identity(str(item.get("source_url") or item.get("url") or ""))
            if not item_id or item_id in seen_video_ids:
                continue
            seen_video_ids.add(item_id)
            unique_items.append(item)
        album_items = unique_items

        if not album_items and video_count:
            return {"url": url, "ok": False, "error": "playlist videos could not be listed"}

        estimated_size_bytes = _estimate_vk_playlist_size_bytes(raw_entries, video_count)
        title = str(info.get("title") or "VK playlist").strip()
        return {
            "url": url,
            "ok": True,
            "title": title,
            "thumbnail": str(info.get("thumbnail") or album_items[0].get("thumbnail") or "").strip(),
            "uploader": str(info.get("uploader") or info.get("channel") or info.get("creator") or "").strip(),
            "upload_date": str(info.get("modified_date") or info.get("release_date") or info.get("upload_date") or "").strip(),
            "duration": sum(_safe_int(item.get("duration")) for item in album_items),
            "item_count": video_count,
            "video_count": video_count,
            "album_items": album_items,
            "album_thumbnails": [item.get("thumbnail") for item in album_items if item.get("thumbnail")][:4],
            "album_size_bytes": estimated_size_bytes,
            "album_size_mb": round(estimated_size_bytes / (1024 * 1024), 1) if estimated_size_bytes else None,
            "album_size_estimated": bool(estimated_size_bytes),
            "content_type": "vk_playlist",
        }
    except Exception as exc:
        logger.info("[Link Tester] VK playlist fetch failed for %s: %s", url, exc)
        return {"url": url, "ok": False, "error": str(exc)}


def _album_item_size_bytes(item: Dict[str, Any]) -> int:
    size_bytes = _safe_int(item.get("size_bytes"))
    if size_bytes > 0:
        return size_bytes
    size_mb = item.get("size_mb")
    if size_mb in (None, ""):
        return 0
    try:
        return max(0, int(float(size_mb) * 1024 * 1024))
    except (TypeError, ValueError):
        return 0


def _album_total_size_bytes(items: List[Dict[str, Any]]) -> int:
    return sum(_album_item_size_bytes(item) for item in items if isinstance(item, dict))


def _latest_album_upload_date(items: List[Dict[str, Any]]) -> str:
    """Newest child upload date, normalized for consistent playlist cards."""
    from ..hubs.metafill import normalise_date

    latest = ""
    for item in items:
        if not isinstance(item, dict):
            continue
        normalized = normalise_date(item.get("upload_date"))
        if normalized and (not latest or normalized > latest):
            latest = normalized
    return latest


async def _eporner_playlist_upload_date(items: List[Dict[str, Any]]) -> str:
    """Best-effort latest upload date for Eporner playlist cards in /tester.

    Eporner playlist tiles often omit a visible date. Those pages are newest-
    first, so when the child rows themselves have no date we probe only the
    first watch page to recover the playlist's last update date.
    """
    latest = _latest_album_upload_date(items)
    if latest or not items:
        return latest

    first = items[0] if isinstance(items[0], dict) else {}
    first_url = str(first.get("source_url") or first.get("url") or "").strip()
    if not first_url:
        return ""

    try:
        from ..hubs.eporner import EpornerHub
        from ..hubs.metafill import normalise_date

        hub = EpornerHub()
        status, html = await hub._fetch_enrich_html(first_url)
        if status != 200:
            return ""
        return normalise_date(hub._watch_upload_date(html))
    except Exception:
        return ""


def _shape_album_items(items: List[Any], source_url: str, limit: int = 500) -> List[Dict[str, Any]]:
    shaped: List[Dict[str, Any]] = []
    for raw in items[:limit]:
        if isinstance(raw, dict):
            item_url = str(raw.get("stream_url") or raw.get("url") or "").strip()
            if not item_url:
                continue
            thumb = str(raw.get("thumbnail") or raw.get("thumb") or "").strip()
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            if (not thumb or "dist/img/logo.png" in thumb) and item_url:
                if "gofile.io" in item_url.lower() or "turbocdn.st" in item_url.lower() or _COOMER_DIRECT_RE.search(urlparse(item_url).netloc or ""):
                    thumb = f"/api/tester/frame?url={quote(item_url, safe='')}"
            # Bunkr's public album list puts sizes in visible card text such as
            # "1.25 GB".  ``int(float(...))`` turns that into zero, which made
            # the tester lose both individual sizes and the album total.
            size_bytes = (
                _parse_size_bytes(raw.get("size_bytes"))
                or _parse_size_bytes(raw.get("filesize"))
                or _parse_size_bytes(raw.get("size"))
            )
            size_mb = raw.get("size_mb")
            if size_bytes <= 0 and size_mb not in (None, ""):
                try:
                    size_bytes = int(float(size_mb) * 1024 * 1024)
                except (TypeError, ValueError):
                    size_bytes = 0
            size_mb = size_mb or (round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None)
            raw_source = str(raw.get("source_url") or "").strip()
            is_parent_url = (
                not raw_source
                or raw_source == source_url
                or bool(re.search(r"/(?:a|album|albums|d)/", raw_source, re.I))
            )
            item_source_url = item_url if is_parent_url else raw_source

            shaped.append({
                "url": item_url,
                "source_url": item_source_url,
                "album_url": source_url,
                "title": raw.get("title") or raw.get("name") or item_url.rsplit("/", 1)[-1],
                "thumbnail": thumb,
                "duration": _safe_int(raw.get("duration")),
                "stream_url": str(raw.get("stream_url") or "").strip(),
                "width": _safe_int(raw.get("width")),
                "height": _safe_int(raw.get("height")),
                "size_bytes": size_bytes,
                "size_mb": size_mb,
                "size_text": str(raw.get("size") or raw.get("filesize") or "").strip(),
                # Filester calls this field ``uploaded_at`` while the tester
                # contract uses ``upload_date``. Keep the source timestamp as
                # the shared name so expanded album cards can render it.
                "upload_date": str(raw.get("upload_date") or raw.get("uploaded_at") or raw.get("created_at") or raw.get("date") or ""),
                "quality": raw.get("quality") or "",
                "is_hls": bool(raw.get("is_hls") or False),
            })
            last = shaped[-1]
            _remember_listing_meta(last.get("source_url") or last.get("url"), {
                "title": last.get("title") or "",
                "duration": last.get("duration") or 0,
                "thumbnail": last.get("thumbnail") or "",
                "height": last.get("height") or 0,
                "width": last.get("width") or 0,
                "quality": last.get("quality") or "",
                "upload_date": last.get("upload_date") or "",
                "size_bytes": last.get("size_bytes") or 0,
                "size_mb": last.get("size_mb"),
            })
        else:
            item_url = str(raw or "").strip()
            if item_url:
                thumb = ""
                if "gofile.io" in item_url.lower() or "turbocdn.st" in item_url.lower():
                    thumb = f"/api/tester/frame?url={quote(item_url, safe='')}"
                shaped.append({
                    "url": item_url,
                    "source_url": item_url,
                    "album_url": source_url,
                    "title": item_url.rsplit("/", 1)[-1],
                    "thumbnail": thumb,
                    "duration": 0,
                    "stream_url": item_url,
                    "width": 0,
                    "height": 0,
                    "size_bytes": 0,
                    "size_mb": None,
                    "quality": "",
                    "is_hls": item_url.lower().endswith(".m3u8"),
                })
    return shaped


def _shape_success(url: str, extractor_name: Optional[str], data: Dict[str, Any], message: str = "") -> Dict[str, Any]:
    thumbnail = data.get("thumbnail") or ""
    if isinstance(thumbnail, str) and thumbnail.startswith("//"):
        thumbnail = "https:" + thumbnail

    height = int(data.get("height") or 0)
    quality = data.get("quality") or ""
    if not quality and height:
        if height >= 2160:
            quality = "4K"
        elif height >= 1080:
            quality = "1080p"
        elif height >= 720:
            quality = "720p"
        elif height >= 480:
            quality = "480p"
        else:
            quality = f"{height}p"

    payload = {
        "title": data.get("title") or "Bez názvu",
        "thumbnail": thumbnail,
        "duration": int(data.get("duration") or 0),
        "stream_url": data.get("stream_url") or "",
        "is_hls": bool(data.get("is_hls") or False),
        "width": int(data.get("width") or 0),
        "height": height,
        "quality": quality,
        "views": int(data.get("views") or 0),
        "tags": data.get("tags") or [],
        "embed_urls": [value for value in (data.get("embed_urls") or [])[:8]
                       if isinstance(value, str) and value.startswith(("https://", "http://"))],
        "uploader": data.get("uploader") or "",
        "upload_date": data.get("upload_date") or "",
        "size_bytes": int(data.get("size_bytes") or 0),
        "size_estimated": bool(data.get("size_estimated") or False),
        "size_mb": data.get("size_mb"),
        "video_count": int(data.get("video_count") or 0),
        "item_count": int(data.get("item_count") or 0),
        "content_type": data.get("content_type") or "",
        "album_size_estimated": bool(data.get("album_size_estimated") or False),
        "playlist_page_start": _safe_int(data.get("playlist_page_start")),
        "playlist_pages_loaded": _safe_int(data.get("playlist_pages_loaded")),
        "playlist_next_page": _safe_int(data.get("playlist_next_page")),
        "playlist_has_more": bool(data.get("playlist_has_more") or False),
    }
    # Pornhub may bind the CDN link to extraction cookies. Expose only an
    # opaque, short-lived handle; the cookies stay inside the local proxy.
    cookies = data.get("proxy_cookies")
    if isinstance(cookies, dict) and cookies:
        from ..proxy_sessions import SESSIONS
        session_id = secrets.token_urlsafe(18)
        SESSIONS[session_id] = {
            "ts": time.time(),
            "cookies": {str(k): str(v) for k, v in cookies.items() if v},
            "referer": data.get("playback_referer") or url,
        }
        payload["proxy_session"] = session_id
    payload["playback_referer"] = data.get("playback_referer") or url
    if (extractor_name or '').lower() == 'pornhub':
        payload['stream_candidates'] = [
            {'url': candidate['url'], 'height': int(candidate.get('height') or 0)}
            for candidate in (data.get('stream_candidates') or [])
            if isinstance(candidate, dict) and isinstance(candidate.get('url'), str)
            and candidate['url'].startswith(('https://', 'http://'))
        ][:12]
    if not payload["size_bytes"] and payload.get("size_mb") not in (None, ""):
        try:
            payload["size_bytes"] = int(float(payload["size_mb"]) * 1024 * 1024)
        except (TypeError, ValueError):
            payload["size_bytes"] = 0
    album_items = data.get("album_items") or []
    if isinstance(album_items, list) and album_items:
        album_size_bytes = _safe_int(data.get("album_size_bytes")) or _album_total_size_bytes(album_items)
        if album_size_bytes > 0 and not payload["size_bytes"]:
            payload["size_bytes"] = album_size_bytes
            payload["size_mb"] = round(album_size_bytes / (1024 * 1024), 1)
        payload["album_size_bytes"] = album_size_bytes
        payload["album_size_mb"] = data.get("album_size_mb") or (round(album_size_bytes / (1024 * 1024), 1) if album_size_bytes > 0 else None)
        payload["album_items"] = album_items
        payload["album_thumbnails"] = [
            item.get("thumbnail")
            for item in album_items
            if isinstance(item, dict) and item.get("thumbnail")
        ][:4]
        if not payload["upload_date"]:
            payload["upload_date"] = _latest_album_upload_date(album_items)
    payload["kind"] = _guess_result_type(url, extractor_name, payload)
    try:
        from ..playback_engine import build_playback_contract
        payload["playback"] = build_playback_contract(url, payload, extractor_name)
    except Exception as pb_exc:
        logger.warning("[Link Tester] Failed to build playback contract for %s: %s", url, pb_exc)
    return {
        "url": url,
        "status": "success",
        "message": message,
        "extractor": extractor_name,
        "data": payload,
    }


async def _basic_http_probe(url: str) -> Dict[str, Any]:
    status_code = 0
    content_type = ""
    body = ""
    final_url = url
    try:
        status_code, body, final_url = await _ntc_page(url, headers=_HTTP_HEADERS, deadline=15.0)
        content_type = "text/html"
    except Exception:
        timeout = httpx.Timeout(12.0, connect=8.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, verify=False, headers=_HTTP_HEADERS) as client:
            try:
                response = await client.head(url)
                if response.status_code >= 400 or response.headers.get("content-type", "").lower().startswith("text/html"):
                    response = await client.get(url)
            except Exception:
                response = await client.get(url)
            status_code = response.status_code
            content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
            body = response.text or ""
            final_url = str(response.url)

    content_type = (content_type or "text/html").split(";")[0].strip().lower()
    title = "Dostupna stranka"
    if "text/html" in content_type or (body and "<title" in body.lower()):
        match = re.search(r"<title>(.*?)</title>", body, re.I | re.S)
        if match:
            title = re.sub(r"\s+", " ", match.group(1)).strip() or title

    data = {
        "title": title,
        "thumbnail": "",
        "duration": 0,
        "stream_url": "",
        "is_hls": "mpegurl" in content_type,
        "content_type": content_type,
        "item_count": 0,
        "video_count": 0,
    }

    if status_code >= 400:
        return {
            "url": url,
            "status": "error",
            "message": f"HTTP {status_code} - odkaz nie je dostupny",
            "extractor": None,
            "data": data,
        }

    if "video" in content_type or url.lower().endswith((".mp4", ".m3u8", ".webm", ".mkv")):
        data["stream_url"] = final_url
        data["kind"] = "video"
        return {
            "url": url,
            "status": "success",
            "message": "Priamy video odkaz je dostupny, ale nepresiel cez specificky extraktor.",
            "extractor": None,
            "data": data,
        }

    data["kind"] = "page"
    return {
        "url": url,
        "status": "warning",
        "message": f"Stranka odpoveda ({status_code}), ale zdroj zatial nema dedikovany extraktor.",
        "extractor": None,
        "data": data,
    }


def _shape_eporner_playlist_search_item(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    url = str(item.get("url") or "").strip()
    if not url:
        return None
    count = _safe_int(item.get("count"))
    return _shape_success(
        url,
        "Eporner playlist search",
        {
            "title": str(item.get("title") or "Eporner playlist").strip(),
            "thumbnail": str(item.get("thumb") or item.get("thumbnail") or "").strip(),
            "duration": 0,
            "stream_url": "",
            "video_count": count,
            "item_count": count,
            "content_type": "eporner_playlist",
        },
        message=(
            f"Nájdený Eporner playlist ({count} videí). "
            "Názvy videí sa načítajú cez rýchly index; streamy až na vyžiadanie."
        ),
    )


async def _search_eporner_playlists_for_tester(
    keyword: str,
    max_pages: int,
    *,
    result_limit: int = 0,
    sort_mode: str = "newest",
) -> tuple[list[dict[str, Any]], bool, int]:
    from app.eporner_playlist_search import search_playlists

    return await search_playlists(
        keyword,
        max_pages,
        result_limit=result_limit,
        sort_mode=sort_mode,
    )


@router.post("/eporner-mixes")
async def create_eporner_mix(request: EpornerMixCreateRequest):
    from ..eporner_mix_store import create_mix

    try:
        mix = await asyncio.to_thread(create_mix, request.playlists, request.name, request.snapshot)
    except (TypeError, ValueError) as exc:
        status = 413 if "too large" in str(exc).lower() else 400
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return {"mix_id": mix["mix_id"], "expires_at": mix["expires_at"]}


@router.get("/eporner-mixes/latest")
async def get_latest_eporner_mix():
    from ..eporner_mix_store import get_latest_mix

    mix = await asyncio.to_thread(get_latest_mix)
    if mix is None:
        raise HTTPException(status_code=404, detail="Nenašiel sa žiadny živý Eporner Tester mix.")
    return mix


@router.get("/eporner-mixes/{mix_id}")
async def get_eporner_mix(mix_id: str):
    from ..eporner_mix_store import get_mix

    mix = await asyncio.to_thread(get_mix, mix_id)
    if mix is None:
        raise HTTPException(status_code=404, detail="Eporner mix neexistuje alebo expiroval.")
    return mix


def _eporner_mix_video_id(url: str) -> str:
    """Use the stable Eporner id when paging a tester mix into Gallery."""
    from ..eporner_playlist_index import video_key

    return video_key(url)


@lru_cache(maxsize=1)
def _eporner_mix_cached_videos(mix_id: str, updated_at: float) -> tuple[dict[str, Any], ...]:
    """Build one read-only Gallery index from the already cached playlist listings.

    This deliberately never calls Eporner.  The Tester has already populated
    ``eporner_playlist_title_cache`` while indexing the mix; Gallery gets a
    paged view of that data instead of trying to put tens of thousands of rows
    into the short-lived mix JSON snapshot.
    """
    from ..eporner_mix_store import get_mix
    from ..eporner_playlist_index import _load_cache

    mix = get_mix(mix_id)
    if mix is None:
        return ()

    unique: dict[str, dict[str, Any]] = {}
    snapshot = mix.get("snapshot") if isinstance(mix.get("snapshot"), dict) else {}
    # Small mixes can still carry the original Studio snapshot.  It is useful
    # before the first Tester index run, but cache rows win when both exist.
    # A Studio selection is the whole handoff: do not pour the cached playlist
    # listing back in, or /tester shows videos the user did not check.
    snapshot_rows = snapshot.get("videos", [])
    if isinstance(snapshot_rows, list):
        for raw in snapshot_rows:
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("source_url") or raw.get("url") or "").strip()
            if not url:
                continue
            unique[_eporner_mix_video_id(url)] = dict(raw)

    if snapshot.get("selection_only") is True:
        return tuple(unique.values())

    for playlist in mix.get("playlists", []):
        if not isinstance(playlist, dict):
            continue
        playlist_url = str(playlist.get("url") or "").strip()
        cached = _load_cache(playlist_url)
        if not cached:
            continue
        for raw in cached.get("items", []):
            if not isinstance(raw, dict):
                continue
            url = str(raw.get("source_url") or raw.get("url") or "").strip()
            if not url:
                continue
            key = _eporner_mix_video_id(url)
            row = unique.get(key)
            if row is None:
                row = dict(raw)
                unique[key] = row
            else:
                # Keep Deep Resolve metadata from a snapshot if it has it,
                # while completing missing listing fields from the title cache.
                for field, value in raw.items():
                    if row.get(field) in (None, "", 0, False) and value not in (None, "", 0, False):
                        row[field] = value
            sources = row.setdefault("playlist_sources", [])
            if not any(source.get("url") == playlist_url for source in sources if isinstance(source, dict)):
                sources.append({"url": playlist_url, "title": playlist.get("title") or playlist_url})

    return tuple(unique.values())


def _eporner_mix_quality(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1440:
        return "1440p"
    if height >= 1080:
        return "1080p"
    if height >= 720:
        return "720p"
    if height >= 480:
        return "480p"
    return "SD"


@router.get("/eporner-mixes/{mix_id}/videos")
async def get_eporner_mix_gallery_videos(
    mix_id: str,
    page: int = Query(1, ge=1),
    limit: int = Query(24, ge=1, le=100),
    search: str = "",
    quality: str = "All",
    qualities: str = "",
    duration_min: int = Query(0, ge=0),
    duration_max: int = Query(99999, ge=0),
    sort: str = "date_desc",
):
    """Serve an indexed Eporner Tester mix as normal, read-only Gallery cards."""
    from ..eporner_mix_store import get_mix

    mix = await asyncio.to_thread(get_mix, mix_id)
    if mix is None:
        raise HTTPException(status_code=404, detail="Eporner mix neexistuje alebo expiroval.")
    rows = await asyncio.to_thread(
        _eporner_mix_cached_videos, mix_id, float(mix.get("updated_at") or mix.get("created_at") or 0),
    )
    tokens = [part.casefold() for part in search.split() if part]
    requested_qualities = {part.strip().casefold() for part in qualities.split(",") if part.strip()}
    if quality and quality != "All":
        requested_qualities.add(quality.casefold())

    filtered: list[dict[str, Any]] = []
    for row in rows:
        duration = max(0, int(row.get("duration") or 0))
        height = max(0, int(row.get("height") or 0))
        label = _eporner_mix_quality(height)
        haystack = " ".join((
            str(row.get("title") or ""), str(row.get("uploader") or ""),
            " ".join(str(source.get("title") or "") for source in row.get("playlist_sources", []) if isinstance(source, dict)),
        )).casefold()
        if tokens and not all(token in haystack for token in tokens):
            continue
        if requested_qualities and label.casefold() not in requested_qualities:
            continue
        if duration < duration_min or duration > duration_max:
            continue
        filtered.append(row)

    if sort in {"title_asc", "title_desc"}:
        filtered.sort(key=lambda row: str(row.get("title") or "").casefold(), reverse=sort == "title_desc")
    elif sort in {"duration_asc", "shortest"}:
        filtered.sort(key=lambda row: int(row.get("duration") or 0))
    elif sort in {"duration_desc", "longest"}:
        filtered.sort(key=lambda row: int(row.get("duration") or 0), reverse=True)
    elif sort in {"size_asc", "smallest"}:
        filtered.sort(key=lambda row: int(row.get("size_bytes") or 0))
    elif sort in {"size_desc", "biggest"}:
        filtered.sort(key=lambda row: int(row.get("size_bytes") or 0), reverse=True)

    start = (page - 1) * limit
    cards = []
    for row in filtered[start:start + limit]:
        source_url = str(row.get("source_url") or row.get("url") or "").strip()
        height = max(0, int(row.get("height") or 0))
        size_bytes = max(0, int(row.get("size_bytes") or 0))
        cards.append({
            "id": f"tester-{mix_id}-{_eporner_mix_video_id(source_url)}",
            "title": str(row.get("title") or "Eporner video"),
            "url": str(row.get("stream_url") or source_url),
            "source_url": source_url,
            "thumbnail_path": str(row.get("thumbnail") or ""),
            "duration": max(0, int(row.get("duration") or 0)),
            "height": height,
            "quality": _eporner_mix_quality(height),
            "file_size_mb": round(size_bytes / (1024 * 1024), 2) if size_bytes else 0,
            "created_at": row.get("upload_date") or None,
            "tags": "eporner, tester-mix",
            "source": "Eporner Tester",
            "storage_type": "tester_index",
            "status": "indexed",
            "link_status": "not_checked",
            "tester_mix": True,
            "playlist_count": len(row.get("playlist_sources") or []),
        })
    return cards


@router.put("/eporner-mixes/{mix_id}")
async def update_eporner_mix(mix_id: str, request: EpornerMixUpdateRequest):
    from ..eporner_mix_store import update_mix

    try:
        mix = await asyncio.to_thread(update_mix, mix_id, request.snapshot)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    if mix is None:
        raise HTTPException(status_code=404, detail="Eporner mix neexistuje alebo expiroval.")
    return {"mix_id": mix_id, "updated_at": mix["updated_at"]}


@router.get("/eporner-library")
async def get_eporner_tester_library():
    return {"version": 1, "videos": await asyncio.to_thread(_read_eporner_library)}


@router.put("/eporner-library")
async def put_eporner_tester_library(request: Request):
    try:
        payload = await request.json()
        rows = payload.get("videos") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ValueError("videos must be a list")
        count = await asyncio.to_thread(_write_eporner_library, rows)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=413 if "too large" in str(exc) else 400, detail=str(exc)) from exc
    return {"version": 1, "count": count}


@router.get("/turbo-vault-library")
async def get_turbo_vault_library():
    albums = await asyncio.to_thread(_read_turbo_vault_library)
    return {"version": 1, "albums": albums, "count": len(albums)}


@router.post("/turbo-vault-library")
@router.put("/turbo-vault-library")
async def save_turbo_vault_library(request: Request):
    try:
        payload = await request.json()
        incoming = payload.get("albums") if isinstance(payload, dict) else payload
        if isinstance(incoming, dict):
            incoming = [incoming]
        if not isinstance(incoming, list):
            raise ValueError("albums must be a list or dict")
        count = await asyncio.to_thread(_write_turbo_vault_library, incoming)
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=413 if "too large" in str(exc) else 400, detail=str(exc)) from exc
    return {"version": 1, "count": count, "ok": True}


@router.post("/eporner-playlists/search")
async def search_eporner_playlists(request: EpornerPlaylistSearchRequest):
    keyword = (request.keyword or "").strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="Keyword je povinný.")

    try:
        limit = max(1, min(int(request.limit or 50), 200))
        pages = max(1, min(int(request.pages or 25), 100))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Limit aj pages musia byť čísla.")

    sort_mode = (request.sort or "newest").strip().lower()
    if sort_mode not in {"newest", "largest", "title"}:
        raise HTTPException(status_code=400, detail="Nepodporované zoradenie playlistov.")

    try:
        items, stopped_by_rate_limit, pages_scanned = await _search_eporner_playlists_for_tester(
            keyword,
            pages,
            result_limit=limit,
            sort_mode=sort_mode,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("[Link Tester] Eporner playlist search failed for %r: %s", keyword, exc)
        raise HTTPException(status_code=502, detail=f"Eporner playlist search failed: {exc}") from exc

    results = []
    for item in items:
        shaped = _shape_eporner_playlist_search_item(item)
        if shaped:
            results.append(shaped)

    total = len(results)
    return {
        "keyword": keyword,
        "sort": sort_mode,
        "total": total,
        "pages_scanned": pages_scanned,
        "stopped_by_rate_limit": bool(stopped_by_rate_limit),
        "results": results,
        "summary": {"total": total, "success": total, "warning": 0, "error": 0},
    }


@router.post("/eporner-playlists/titles/stream")
async def index_eporner_playlist_titles(request: EpornerPlaylistTitlesRequest):
    from ..eporner_playlist_index import playlist_key, stream_playlist_titles

    if not request.urls or len(request.urls) > 200:
        raise HTTPException(status_code=400, detail="Pošli 1 až 200 Eporner playlistov.")
    urls, seen = [], set()
    for raw in request.urls:
        url = _normalize_url(raw)
        if not _is_eporner_url(url) or not re.search(r"/playlist/[A-Za-z0-9]+(?:/|$)", urlparse(url).path):
            raise HTTPException(status_code=400, detail="Index názvov prijíma iba Eporner playlist URL.")
        key = playlist_key(url)
        if key not in seen:
            urls.append(url)
            seen.add(key)

    async def events():
        yield "data: " + json.dumps({"type": "start", "total": len(urls)}) + "\n\n"
        async for event in stream_playlist_titles(urls):
            yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/eporner-playlists/scan/stream")
async def scan_eporner_playlists(request: EpornerPlaylistSearchRequest):
    from ..eporner_playlist_index import stream_playlist_scan

    keyword = (request.keyword or "").strip()
    if not keyword:
        raise HTTPException(status_code=400, detail="Keyword je povinný.")
    try:
        limit = max(1, min(int(request.limit or 50), 200))
        pages = max(1, min(int(request.pages or 25), 100))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Limit aj pages musia byť čísla.")
    sort_mode = (request.sort or "newest").strip().lower()
    if sort_mode not in {"newest", "largest", "title"}:
        raise HTTPException(status_code=400, detail="Nepodporované zoradenie playlistov.")

    async def events():
        yield "data: " + json.dumps({"type": "start", "keyword": keyword, "limit": limit}) + "\n\n"
        try:
            async for event in stream_playlist_scan(
                keyword, pages, result_limit=limit, sort_mode=sort_mode,
                video_keyword=(request.video_keyword or "").strip(),
            ):
                if event.get("type") == "playlist" and event.get("item"):
                    shaped = _shape_eporner_playlist_search_item(event["item"])
                    if not shaped:
                        continue
                    event = {**event, "result": shaped}
                    event.pop("item", None)
                yield "data: " + json.dumps(event, ensure_ascii=False) + "\n\n"
        except ValueError as exc:
            yield "data: " + json.dumps({"type": "error", "error": str(exc)}) + "\n\n"
        except Exception as exc:
            logger.warning("[Link Tester] Eporner playlist scan failed for %r: %s", keyword, exc)
            yield "data: " + json.dumps({"type": "error", "error": f"Eporner playlist search failed: {exc}"}) + "\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/xxbrits-playlist/batch")
async def load_xxbrits_playlist_batch(request: XXBritsPlaylistBatchRequest):
    """Return the next bounded window of an XXBrits KVS playlist."""
    from ..extractors.xxbrits import XXBritsExtractor

    playlist_url = _normalize_url(request.playlist_url)
    extractor = XXBritsExtractor()
    if not extractor.is_playlist_url(playlist_url):
        raise HTTPException(status_code=400, detail="Očakávam verejný XXBrits playlist odkaz.")
    try:
        start_page = max(1, int(request.start_page or 1))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="start_page musí byť číslo.")
    try:
        batch = await extractor.fetch_playlist_batch(playlist_url, start_page=start_page, max_pages=10)
    except httpx.HTTPError as exc:
        logger.warning("[Link Tester] XXBrits playlist batch failed for %s: %s", playlist_url, exc)
        raise HTTPException(status_code=502, detail="XXBrits playlist sa nepodarilo načítať.") from exc

    items = _shape_album_items(batch.get("items") or [], playlist_url)
    return {
        "playlist_url": playlist_url,
        "title": batch.get("title") or "XXBrits playlist",
        "items": items,
        "page_start": batch.get("page_start") or start_page,
        "pages_loaded": batch.get("pages_loaded") or 0,
        "next_page": batch.get("next_page") or 0,
        "has_more": bool(batch.get("has_more")),
    }


@router.post("/xvideos-playlist/batch")
async def load_xvideos_playlist_batch(request: XVideosPlaylistBatchRequest):
    """Return the next bounded page window from an XVideos playlist."""
    from ..extractors.xvideos import XVideosExtractor

    playlist_url = _normalize_url(request.playlist_url)
    extractor = XVideosExtractor()
    if not _is_xvideos_url(playlist_url) or not extractor._is_listing_url(playlist_url):
        raise HTTPException(status_code=400, detail="Očakávam verejný XVideos playlist alebo obľúbené videá.")
    try:
        start_page = max(0, int(request.start_page or 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="start_page musí byť číslo.")
    listing_info: Dict[str, Any] = {}
    try:
        items = await extractor.extract_album_entries(
            playlist_url, start_page=start_page, max_pages=10, max_entries=500, info=listing_info,
        )
    except Exception as exc:
        logger.warning("[Link Tester] XVideos playlist batch failed for %s: %s", playlist_url, exc)
        raise HTTPException(status_code=502, detail="XVideos playlist sa nepodarilo načítať.") from exc

    return {
        "playlist_url": playlist_url,
        "items": _shape_album_items(items, playlist_url),
        "page_start": start_page,
        "pages_loaded": int(listing_info.get("pages_loaded") or 0),
        "next_page": int(listing_info.get("next_page") or 0),
        "has_more": bool(listing_info.get("truncated")),
    }


async def _try_album_extract(url: str, extractor: Any) -> Optional[Dict[str, Any]]:
    # XXBrits playlists expose KVS AJAX pages.  The first tester result is a
    # deliberate, bounded 10-page window; further windows are user-triggered.
    if hasattr(extractor, "fetch_playlist_batch") and getattr(extractor, "is_playlist_url", lambda _url: False)(url):
        batch = await extractor.fetch_playlist_batch(url)
        entries = batch.get("items") or []
        if entries:
            album_items = _shape_album_items(entries, url)
            first = album_items[0]
            return _shape_success(
                url,
                extractor.name,
                {
                    "title": batch.get("title") or "XXBrits playlist",
                    "thumbnail": first.get("thumbnail") or "",
                    "duration": sum(_safe_int(item.get("duration")) for item in album_items),
                    "stream_url": "",
                    "video_count": len(album_items),
                    "item_count": len(album_items),
                    "album_items": album_items,
                    "album_thumbnails": [item.get("thumbnail") for item in album_items if item.get("thumbnail")][:4],
                    "content_type": "xxbrits_playlist",
                    "playlist_page_start": batch.get("page_start") or 1,
                    "playlist_pages_loaded": batch.get("pages_loaded") or 0,
                    "playlist_next_page": batch.get("next_page") or 0,
                    "playlist_has_more": bool(batch.get("has_more")),
                },
                message=(
                    f"XXBrits playlist načítaný: {len(album_items)} videí z {batch.get('pages_loaded') or 0} strán. "
                    + ("Použi Načítať ďalších 100 pre nasledujúcu dávku." if batch.get("has_more") else "Playlist je načítaný celý.")
                ),
            )
    if hasattr(extractor, "extract_album_entries"):
        listing_info: Dict[str, Any] = {}
        extra: Dict[str, Any] = {}
        if extractor.name == "Eporner":
            # Playlists in /tester are always loaded whole. max_pages=0 walks
            # pagination until it ends; max_entries stays unset (no 50-item cut).
            extra = {"max_pages": 0, "info": listing_info}
        elif extractor.name in ("XVideos", "Camwhores"):
            extra = {
                "max_pages": _TESTER_LISTING_MAX_PAGES,
                "max_entries": _TESTER_LISTING_MAX_ENTRIES,
                "info": listing_info,
            }
        entries = await extractor.extract_album_entries(url, **extra)
        if entries:
            if len(entries) == 1 and extractor.name == "GoFile" and hasattr(extractor, "extract"):
                direct = await extractor.extract(url)
                if direct:
                    return _shape_success(
                        url,
                        extractor.name,
                        direct,
                        message=f"{extractor.name} video úspešne načítané.",
                    )
            first = entries[0] if isinstance(entries[0], dict) else {}
            shape_limit = len(entries) if extractor.name == "Eporner" else 500
            album_items = _shape_album_items(entries, url, limit=shape_limit)
            total_size_bytes = _album_total_size_bytes(album_items)
            upload_date = ""
            if extractor.name == "Eporner":
                upload_date = await _eporner_playlist_upload_date(album_items)
            elif extractor.name == "Filester":
                # A public folder has no separate published date. Its newest
                # file timestamp is the only accurate source date for its card.
                upload_date = max((str(item.get("upload_date") or "") for item in album_items), default="")
            return _shape_success(
                url,
                extractor.name,
                {
                    "title": f"{extractor.name} priečinok ({len(entries)} videí)" if extractor.name == "GoFile" else (first.get("album_title") or first.get("title") or f"{extractor.name} album"),
                    "thumbnail": first.get("thumbnail") or "",
                    "duration": sum(_safe_int(item.get("duration")) for item in album_items),
                    "stream_url": first.get("stream_url") or "",
                    "is_hls": first.get("is_hls") or False,
                    "width": first.get("width") or 0,
                    "height": first.get("height") or 0,
                    "video_count": len(entries),
                    "item_count": len(entries),
                    "album_items": album_items,
                    "album_size_bytes": total_size_bytes,
                    "album_size_mb": round(total_size_bytes / (1024 * 1024), 1) if total_size_bytes > 0 else None,
                    "upload_date": upload_date,
                    "content_type": "album",
                    "playlist_has_more": bool(listing_info.get("truncated")),
                    "playlist_pages_loaded": int(listing_info.get("pages_loaded") or _TESTER_LISTING_MAX_PAGES) if extra else None,
                    "playlist_next_page": int(listing_info.get("next_page") or 0),
                },
                message=f"{extractor.name} priečinok úspešne načítaný ({len(entries)} videí). Rozbaľ položky pre zobrazenie jednotlivých videí.",
            )

    if hasattr(extractor, "extract_album"):
        album_items = await extractor.extract_album(url, listing_only=True) if isinstance(extractor, BunkrExtractor) else await extractor.extract_album(url)
        if album_items:
            if len(album_items) == 1 and extractor.name == "GoFile" and hasattr(extractor, "extract"):
                direct = await extractor.extract(url)
                if direct:
                    return _shape_success(
                        url,
                        extractor.name,
                        direct,
                        message=f"{extractor.name} video úspešne načítané.",
                    )
            first = album_items[0]
            if isinstance(first, dict):
                album_items = _shape_album_items(album_items, url)
                data = {
                    "title": first.get("title") or f"{extractor.name} album",
                    "thumbnail": first.get("thumbnail") or first.get("thumb") or "",
                    "duration": first.get("duration") or 0,
                    "stream_url": first.get("stream_url") or first.get("url") or "",
                    "is_hls": first.get("is_hls") or False,
                    "width": first.get("width") or 0,
                    "height": first.get("height") or 0,
                    "video_count": len(album_items),
                    "item_count": len(album_items),
                    "album_items": album_items,
                }
            else:
                shaped_items = _shape_album_items(album_items, url)
                data = {
                    "title": f"{extractor.name} album",
                    "thumbnail": "",
                    "duration": 0,
                    "stream_url": str(first),
                    "is_hls": str(first).lower().endswith(".m3u8"),
                    "video_count": len(album_items),
                    "item_count": len(album_items),
                    "album_items": shaped_items,
                }
            return _shape_success(
                url,
                extractor.name,
                data,
                message=f"Album uspesne rozpoznany ({len(album_items)} poloziek).",
            )
    return None


_VK_HOSTS = ("vkvideo.ru", "vk.com", "vkvid.ru", "vk.ru")


def _is_vk_url(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    host = host[4:] if host.startswith("www.") else host
    host = host[2:] if host.startswith("m.") else host
    return host in _VK_HOSTS


def _is_camwhores_video_url(url: str) -> bool:
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    return (host == "camwhores.tv" or host.endswith(".camwhores.tv")) and bool(
        re.match(r"^/videos/\d+/", parsed.path, re.I)
    )


async def _fast_camwhores_detail(url: str, client: httpx.AsyncClient,
                                 watch_client: Any, external_gate: asyncio.Semaphore) -> Optional[dict]:
    """Share Discovery's watch-page and external-player resolver with Tester."""
    from ..camwhores_discovery import async_extract_detail_metadata

    detail = await async_extract_detail_metadata(
        url, client, watch_client=watch_client, external_gate=external_gate,
    )
    if not detail or not detail.get("enriched"):
        return None
    size = int(detail.get("size_bytes") or 0)
    return {
        **detail,
        "height": int(detail.get("resolution") or 0),
        "size_mb": round(size / 1048576, 1) if size else None,
        "upload_date": detail.get("upload_date") or detail.get("added_date") or "",
        "kind": "video",
    }


async def resolve_single_url(
    url: str,
    semaphore: asyncio.Semaphore,
    shared_client: Optional[httpx.AsyncClient] = None,
    watch_client: Any = None,
    external_gate: Optional[asyncio.Semaphore] = None,
) -> Dict[str, Any]:
    """Resolve one link under a concurrency slot and a hard wall-clock ceiling.

    The ceiling is what keeps a batch honest: blocking extractors run in
    threads that asyncio cannot cancel, so without it a single unresponsive
    host stalls its slot forever and the run looks dead rather than slow.
    """
    is_eporner = _is_eporner_url(url)
    budget = (
        PER_URL_TIMEOUT_SECONDS_EPORNER_LISTING if is_eporner and _is_eporner_listing_url(url)
        else PER_URL_TIMEOUT_SECONDS_EPORNER if is_eporner
        else PER_URL_TIMEOUT_SECONDS_VK if _is_vk_url(url)
        else PER_URL_TIMEOUT_SECONDS
    )
    attempts = EPORNER_RETRY_ATTEMPTS if is_eporner else 1
    async with semaphore:
        for attempt in range(1, attempts + 1):
            try:
                result = await asyncio.wait_for(
                    _resolve_single_url_inner(url, shared_client, watch_client, external_gate), timeout=budget
                )
            except asyncio.TimeoutError:
                logger.warning("[Link Tester] Timed out after %ss: %s", budget, url)
                result = {
                    "url": _normalize_url(url) or url,
                    "status": "error",
                    "message": (
                        f"Časový limit {budget}s vypršal — zdroj neodpovedal. "
                        "Skús odkaz otestovať znova samostatne."
                    ),
                    "extractor": None,
                    "data": {"kind": "unknown"},
                }
            except Exception as exc:
                logger.error("[Link Tester] Unhandled failure for %s: %s", url, exc)
                result = {
                    "url": _normalize_url(url) or url,
                    "status": "error",
                    "message": f"Neočakávaná chyba: {exc}",
                    "extractor": None,
                    "data": {"kind": "unknown"},
                }

            # Eporner often answers a short request burst with a transient
            # block/timeout that its extractor intentionally reports as a
            # normal failed result.  Retry only once, after a shared backoff;
            # do not immediately reissue it or rotate/mask the network path.
            if result.get("status") != "error" or result.get("retryable") is False or attempt == attempts:
                return result
            delay = 8.0 * attempt
            logger.info(
                "[Link Tester] Eporner attempt %s/%s failed; respecting %.1fs cooldown: %s",
                attempt, attempts, delay, url,
            )
            if isinstance(semaphore, EpornerPacer):
                await semaphore.retry_after(delay)
            else:
                await asyncio.sleep(delay)

    raise RuntimeError("unreachable")


async def _resolve_single_url_inner(
    url: str,
    shared_client: Optional[httpx.AsyncClient] = None,
    watch_client: Any = None,
    external_gate: Optional[asyncio.Semaphore] = None,
) -> Dict[str, Any]:
    normalized = _normalize_url(url)
    if not normalized:
        return {
            "url": url,
            "status": "error",
            "message": "Neplatna URL adresa",
            "extractor": None,
            "data": {"kind": "unknown"},
        }

    # VK playlists need a list-level pass. Calling the normal VK extractor
    # here treats the playlist as one unplayable video and loses its count,
    # preview mosaic and expandable entries.
    if _is_vk_playlist_url(normalized):
        playlist = await asyncio.to_thread(_extract_vk_playlist_fast, normalized)
        if playlist.get("ok"):
            visible_count = len(playlist.get("album_items") or [])
            total_count = _safe_int(playlist.get("video_count"))
            listed_suffix = "" if visible_count >= total_count else f"; pripravených prvých {visible_count}"
            return _shape_success(
                normalized,
                "VK playlist",
                playlist,
                message=f"VK playlist načítaný: {total_count} videí{listed_suffix}. Rozbaľ položky pre presné meta a veľkosť.",
            )
        return {
            "url": normalized,
            "status": "error",
            "message": "VK playlist sa nepodarilo načítať. Over prihlásenie/cookies alebo dostupnosť playlistu.",
            "extractor": "VK playlist",
            "data": {"kind": "playlist"},
        }

    extractor = ExtractorRegistry.find_extractor(normalized)

    try:
        logger.info("[Link Tester] Processing %s via %s", normalized, extractor.name)

        if (_is_camwhores_video_url(normalized) and shared_client is not None
                and watch_client is not None and external_gate is not None):
            fast = await _fast_camwhores_detail(normalized, shared_client, watch_client, external_gate)
            if fast and fast.get("stream_url"):
                return _shape_success(normalized, extractor.name, fast,
                                      message="Camwhores stream a metadata načítané rýchlou cestou.")

        # Skip album check for known single-file hosts — saves 1 extra GET per URL
        _is_single = (
            ("turbo.cr" in normalized and re.search(r"turbo\.cr/v/", normalized, re.I))
            or any(d in normalized for d in ("cyberdrop.cr", "cyberdrop.me", "cyberdrop.to", "cyberdrop.cc"))
        )
        if not _is_single:
            album_result = await _try_album_extract(normalized, extractor)
            if album_result:
                return album_result
            if extractor.name == "Eporner" and extractor._is_listing_url(normalized):
                return {
                    "url": normalized, "status": "error", "retryable": False,
                    "message": "Eporner playlist je prázdny alebo nedostupný; nebol skúšaný ako jednotlivé video.",
                    "extractor": extractor.name, "data": {"kind": "playlist"},
                }
            if extractor.name == "XVideos" and extractor._is_listing_url(normalized):
                return {
                    "url": normalized, "status": "error", "retryable": False,
                    "message": "XVideos listing je prázdny alebo nedostupný; nebol skúšaný ako jednotlivé video.",
                    "extractor": extractor.name, "data": {"kind": "playlist"},
                }
            if extractor.name == "Camwhores" and extractor._is_member_url(normalized):
                return {
                    "url": normalized, "status": "error", "retryable": False,
                    "message": "Camwhores member listing je prázdny alebo nedostupný; nebol skúšaný ako jednotlivé video.",
                    "extractor": extractor.name, "data": {"kind": "playlist"},
                }
            if extractor.name == "Filester" and _looks_like_album_url(normalized):
                return {
                    "url": normalized,
                    "status": "warning",
                    "message": "Filester album link bol rozpoznany, ale stranka nevratila ziadne nacitatelne polozky. Moze byt sukromny, zmazany alebo chraneny.",
                    "extractor": extractor.name,
                    "data": {
                        "kind": "album",
                        "title": "Filester album",
                        "thumbnail": "",
                        "duration": 0,
                        "stream_url": "",
                        "item_count": 0,
                        "video_count": 0,
                        "album_items": [],
                        "album_thumbnails": [],
                    },
                }

        # Use shared client for Turbo to avoid per-video connection overhead
        if shared_client is not None and hasattr(extractor, "_extract_with_client"):
            result = await extractor._extract_with_client(normalized, shared_client)
        else:
            result = await extractor.extract(normalized)

        # PornhubExtractor verifies CDN candidates with requests. The media
        # proxy uses that same transport; probing again with aiohttp can return
        # 410 on a stream that requests successfully plays.

        if result:
            message = ""
            if extractor.name == "Camwhores" and result.get("_stream_probe_unavailable"):
                message = "Camwhores stream bol nájdený a je pripravený pre prehrávač; CDN nepovolilo samostatnú serverovú kontrolu veľkosti."
            # Filester/FileDitch ship no og:image and (per _scrape_page_meta/
            # _scrape_direct_viewer) no <video poster> either — extract() flags
            # this with needs_ffmpeg_thumb so the card isn't left permanently
            # blank; render a poster frame from the now-resolved stream instead,
            # same fallback pattern turbo.cr/coomer already use below.
            if result.get("needs_ffmpeg_thumb") and not result.get("thumbnail") and result.get("stream_url"):
                result["thumbnail"] = "/api/tester/frame?url=" + quote(result["stream_url"], safe="")
            return _shape_success(normalized, extractor.name, result, message=message)

        # Camwhores can expose the stream only to browser-like clients.
        # Give the dedicated KVS/yt-dlp router one independent chance
        # before classifying a public watch page as a failure.
        if extractor.name == "Camwhores":
            try:
                from ..extractors.media_router import default_router
                cookie_file = extractor._resolve_cookie_file_path() if hasattr(extractor, "_resolve_cookie_file_path") else None
                routed = await asyncio.to_thread(default_router.extract, normalized, cookie_file=cookie_file)
                if routed and routed.stream_url:
                    routed_data = {
                        "title": routed.title or "Camwhores Video",
                        "thumbnail": routed.thumbnail or "",
                        "duration": int(routed.duration or 0),
                        "stream_url": routed.stream_url,
                        "width": int(routed.width or 0),
                        "height": int(routed.height or 0),
                        "size_bytes": int(getattr(routed, "size_bytes", 0) or 0),
                    }
                    return _shape_success(
                        normalized,
                        "Camwhores fallback",
                        routed_data,
                        message="Camwhores stream bol vyriešený záložným browser-compatible resolverom.",
                    )
            except Exception as fallback_exc:
                logger.info("[Link Tester] Camwhores fallback failed for %s: %s", normalized, fallback_exc)

        if extractor.name == "Porntrex":
            meta = await _fetch_porntrex_meta(normalized, None, asyncio.Semaphore(1))
            if meta.get("ok") and (meta.get("thumbnail") or meta.get("title")):
                return _shape_success(
                    normalized,
                    extractor.name,
                    meta,
                    message="PornTrex metadata nacitane. Priamy stream sa nepodarilo spolahlivo potvrdit.",
                )


    except EpornerListingError as exc:
        return {
            "url": normalized, "status": "error", "retryable": False,
            "message": str(exc), "extractor": "Eporner", "data": {"kind": "playlist"},
        }
    except FaphouseAccessError as exc:
        # Not a parse failure: Faphouse loaded fine and refused the stream. Say
        # so plainly — the old behaviour handed the watch page back as if it
        # were a video, so the card looked fine until playback silently died.
        logger.info("[Link Tester] Faphouse access denied for %s: %s", normalized, exc)
        return {
            "url": normalized,
            "status": "warning",
            "message": f"Faphouse: {exc}. Dostupný je iba trailer, nie celé video.",
            "extractor": extractor.name,
            "data": {"kind": "page"},
        }
    except httpx.HTTPStatusError as exc:
        # A Turbo /a/<id> item can disappear after the album was collected.
        # This is an upstream removal, not a Nexus parsing failure. Keeping the
        # distinction visible avoids a misleading "internal extractor" error
        # across an otherwise consistently deleted batch.
        if extractor.name == "Turbo" and exc.response.status_code == 404:
            return {
                "url": normalized,
                "status": "error",
                "retryable": False,
                "message": "Turbo video už na zdroji nie je dostupné (HTTP 404).",
                "extractor": extractor.name,
                "data": {"kind": "video"},
            }
        logger.info("[Link Tester] Extractor HTTP failure for %s: %s", normalized, exc)
    except Exception as ext_err:
        logger.info("[Link Tester] Extractor stage failed for %s: %s", normalized, ext_err)

    # ─── CASCADE STAGE 2: HubAdapter for domain (max 4.0s) ───
    try:
        from ..hubs.registry import get_by_url
        hub_adapter = get_by_url(normalized)
        if hub_adapter and hasattr(hub_adapter, "resolve"):
            logger.info("[Link Tester] Cascading to HubAdapter %s for %s", hub_adapter.source, normalized)
            hub_res = await asyncio.wait_for(hub_adapter.resolve(normalized), timeout=4.0)
            if hub_res and (hub_res.get("stream_url") or hub_res.get("embed_urls")):
                return _shape_success(
                    normalized,
                    f"{hub_adapter.label} Hub",
                    hub_res,
                    message=f"{hub_adapter.label} stream načítaný cez hub resolver.",
                )
    except Exception as hub_exc:
        logger.info("[Link Tester] HubAdapter cascade failed for %s: %s", normalized, hub_exc)

    # ─── CASCADE STAGE 3: Smart Media Router (yt-dlp / CyberDrop KVS, max 8.0s) ───
    try:
        from ..extractors.media_router import default_router
        cookie_file = extractor._resolve_cookie_file_path() if (extractor and hasattr(extractor, "_resolve_cookie_file_path")) else None
        logger.info("[Link Tester] Cascading to Smart Media Router for %s", normalized)
        routed = await asyncio.wait_for(
            asyncio.to_thread(default_router.extract, normalized, cookie_file=cookie_file),
            timeout=8.0,
        )
        if routed and routed.stream_url:
            routed_data = {
                "title": routed.title or "Video",
                "thumbnail": routed.thumbnail or "",
                "duration": int(routed.duration or 0),
                "stream_url": routed.stream_url,
                "width": int(routed.width or 0),
                "height": int(routed.height or 0),
                "size_bytes": int(getattr(routed, "filesize", 0) or getattr(routed, "size_bytes", 0) or 0),
                "is_hls": bool(routed.is_hls),
            }
            return _shape_success(
                normalized,
                "Smart Media Router",
                routed_data,
                message="Stream vyriešený záložným Smart Media Routerom.",
            )
    except Exception as router_exc:
        logger.info("[Link Tester] Smart Media Router cascade failed for %s: %s", normalized, router_exc)

    # ─── CASCADE STAGE 4: Basic HTTP Probe fallback (max 4.0s) ───
    try:
        logger.info("[Link Tester] Cascading to _basic_http_probe for %s", normalized)
        probe_result = await asyncio.wait_for(_basic_http_probe(normalized), timeout=4.0)
        if (
            extractor.name == "Turbo"
            and probe_result.get("status") == "error"
            and "HTTP 404" in probe_result.get("message", "")
        ):
            probe_result.update({
                "retryable": False,
                "message": "Turbo video už na zdroji nie je dostupné (HTTP 404).",
                "extractor": extractor.name,
            })
            probe_result.setdefault("data", {})["kind"] = "video"
        return probe_result
    except Exception as exc:
        logger.error("[Link Tester] Probe failed for %s: %s", normalized, exc)
        return {
            "url": normalized,
            "status": "error",
            "message": f"Nepodarilo sa overiť dostupnosť odkazu: {exc}",
            "extractor": getattr(extractor, "name", None) if extractor else None,
            "data": {"kind": "unknown"},
        }


@router.post("/resolve")
async def resolve_links(request: TestLinksRequest):
    if not request.urls:
        return {"results": [], "summary": {"total": 0, "success": 0, "warning": 0, "error": 0}}

    cleaned_urls = [_normalize_url(url) for url in request.urls]
    cleaned_urls = [url for url in cleaned_urls if url]
    if len(cleaned_urls) > MAX_LINKS:
        raise HTTPException(status_code=400, detail=f"Prilis vela odkazov na jedenkrat. Maximum je {MAX_LINKS}.")

    # Turbo.cr URLs get a high-concurrency semaphore + shared connection pool
    turbo_sem = asyncio.Semaphore(MAX_CONCURRENCY_TURBO)
    camwhores_sem = asyncio.Semaphore(20)
    camwhores_external_gate = asyncio.Semaphore(6)
    default_sem = asyncio.Semaphore(MAX_CONCURRENCY)
    vk_sem = asyncio.Semaphore(MAX_CONCURRENCY_VK)
    eporner_pacer = EpornerPacer()

    _fast_hosts = ("turbo.cr", "cyberdrop.cr", "cyberdrop.me", "cyberdrop.to", "cyberdrop.cc")

    def _sem_for(url: str) -> asyncio.Semaphore:
        if _is_eporner_url(url):
            return eporner_pacer
        if _is_vk_url(url):
            return vk_sem
        if _is_camwhores_video_url(url):
            return camwhores_sem
        return turbo_sem if any(h in url for h in _fast_hosts) else default_sem

    # One shared httpx client for all turbo.cr requests — reuses TCP connections
    turbo_client_opts = dict(
        timeout=httpx.Timeout(15.0, connect=8.0),
        follow_redirects=True,
        verify=False,
        limits=httpx.Limits(max_connections=60, max_keepalive_connections=40),
    )
    async with httpx.AsyncClient(**turbo_client_opts) as turbo_client, AsyncExitStack() as stack:
        watch_client = None
        if any(_is_camwhores_video_url(url) for url in cleaned_urls):
            from curl_cffi.requests import AsyncSession
            watch_client = await stack.enter_async_context(
                AsyncSession(impersonate="chrome124", timeout=10, verify=False, max_clients=20)
            )

        def _client_for(url: str) -> Optional[httpx.AsyncClient]:
            return turbo_client if "turbo.cr" in url or _is_camwhores_video_url(url) else None

        tasks = [resolve_single_url(url, _sem_for(url), _client_for(url),
                                    watch_client, camwhores_external_gate) for url in cleaned_urls]
        results = await asyncio.gather(*tasks)

    summary = {
        "total": len(results),
        "success": sum(1 for item in results if item.get("status") == "success"),
        "warning": sum(1 for item in results if item.get("status") == "warning"),
        "error": sum(1 for item in results if item.get("status") == "error"),
    }
    return {"results": results, "summary": summary}


@router.post("/resolve/stream")
async def resolve_links_stream(request: TestLinksRequest):
    """Resolve a batch while streaming each completed card to the tester UI."""
    if not request.urls:
        async def empty_stream():
            yield "data: " + json.dumps({"type": "done", "results": [], "summary": {"total": 0, "success": 0, "warning": 0, "error": 0}}) + "\n\n"
        return StreamingResponse(empty_stream(), media_type="text/event-stream")

    cleaned_urls = [_normalize_url(url) for url in request.urls]
    cleaned_urls = [url for url in cleaned_urls if url]
    if len(cleaned_urls) > MAX_LINKS:
        raise HTTPException(status_code=400, detail=f"Prilis vela odkazov na jedenkrat. Maximum je {MAX_LINKS}.")

    async def event_stream():
        total = len(cleaned_urls)
        summary = {"total": total, "success": 0, "warning": 0, "error": 0}
        results: List[Dict[str, Any]] = []
        turbo_sem = asyncio.Semaphore(MAX_CONCURRENCY_TURBO)
        camwhores_sem = asyncio.Semaphore(20)
        camwhores_external_gate = asyncio.Semaphore(6)
        default_sem = asyncio.Semaphore(MAX_CONCURRENCY)
        vk_sem = asyncio.Semaphore(MAX_CONCURRENCY_VK)
        eporner_pacer = EpornerPacer()
        fast_hosts = ("turbo.cr", "cyberdrop.cr", "cyberdrop.me", "cyberdrop.to", "cyberdrop.cc")

        def sem_for(url: str) -> asyncio.Semaphore:
            if _is_eporner_url(url):
                return eporner_pacer
            if _is_vk_url(url):
                return vk_sem
            if _is_camwhores_video_url(url):
                return camwhores_sem
            return turbo_sem if any(host in url for host in fast_hosts) else default_sem

        turbo_client_opts = dict(
            timeout=httpx.Timeout(15.0, connect=8.0),
            follow_redirects=True,
            verify=False,
            limits=httpx.Limits(max_connections=60, max_keepalive_connections=40),
        )
        yield "data: " + json.dumps({"type": "start", "total": total}) + "\n\n"
        async with httpx.AsyncClient(**turbo_client_opts) as turbo_client, AsyncExitStack() as stack:
            watch_client = None
            if any(_is_camwhores_video_url(url) for url in cleaned_urls):
                from curl_cffi.requests import AsyncSession
                watch_client = await stack.enter_async_context(
                    AsyncSession(impersonate="chrome124", timeout=10, verify=False, max_clients=20)
                )

            async def resolve_indexed(index: int, url: str):
                client = turbo_client if "turbo.cr" in url or _is_camwhores_video_url(url) else None
                if request.metadata_only and _is_camwhores_video_url(url):
                    try:
                        async with sem_for(url):
                            fast = await _fast_camwhores_detail(
                                url, turbo_client, watch_client, camwhores_external_gate,
                            )
                    except Exception as exc:
                        logger.debug("[Link Tester] Camwhores metadata failed for %s: %s", url, exc)
                        fast = None
                    if fast:
                        return index, _shape_success(url, "Camwhores", fast,
                            message="Camwhores metadata načítané rýchlou cestou.")
                    return index, {
                        "url": url, "status": "error", "extractor": "Camwhores",
                        "message": "Camwhores metadata nie sú dostupné.", "data": {"kind": "video"},
                    }
                return index, await resolve_single_url(url, sem_for(url), client,
                                                       watch_client, camwhores_external_gate)

            tasks = [asyncio.create_task(resolve_indexed(index, url)) for index, url in enumerate(cleaned_urls)]
            completed = 0
            try:
                for task in asyncio.as_completed(tasks):
                    index, result = await task
                    completed += 1
                    results.append(result)
                    status = result.get("status", "error")
                    if status in summary:
                        summary[status] += 1
                    yield "data: " + json.dumps({
                        "type": "result",
                        "index": index,
                        "result": result,
                        "completed": completed,
                        "total": total,
                        "summary": summary,
                    }, ensure_ascii=False) + "\n\n"
            finally:
                # When the user hits Stop the client drops the SSE connection and
                # this generator is closed. Without an explicit cancel the whole
                # remaining batch keeps resolving in the background — which is why
                # "Zastavujem…" hung and the run went on long after it was stopped.
                pending = [t for t in tasks if not t.done()]
                for t in pending:
                    t.cancel()
                if pending:
                    logger.info("[Link Tester] Stopped — cancelled %s pending link(s)", len(pending))
                    await asyncio.gather(*pending, return_exceptions=True)

        yield "data: " + json.dumps({"type": "done", "results": results, "summary": summary}, ensure_ascii=False) + "\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _extract_turbo_id(url: str) -> str:
    m = re.search(r"turbo\.cr\/(?:v|d|embed)\/([^/?#]+)", url, re.I)
    if m:
        return m.group(1)
    m_cdn = re.search(r"turbocdn\.st\/(?:turbo\/data\/|data\/)?([A-Za-z0-9_-]+)\.mp4", url, re.I)
    return m_cdn.group(1) if m_cdn else ""


async def _fetch_turbo_meta(url: str, client: httpx.AsyncClient, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    """
    Single turbo.cr video: fetch watch page to get duration + og:title, then sign API
    for the CDN URL → HEAD it for Content-Length. Two sequential requests per video,
    but 50 run in parallel so 232 videos finish in ~3-5 s.
    """
    async with semaphore:
        turbo_id = _extract_turbo_id(url)
        if not turbo_id:
            return {"url": url, "ok": False, "error": "bad turbo id"}

        watch_url = f"https://turbo.cr/v/{turbo_id}"
        embed_url = f"https://turbo.cr/embed/{turbo_id}"

        title = ""
        duration = 0
        size_bytes = 0
        cdn_url = ""
        thumbnail = ""
        height = 0
        width = 0

        try:
            # 1. Watch page — title + duration + resolution from og tags
            resp = await client.get(watch_url, headers=_TURBO_HEADERS)
            if resp.is_success:
                html_text = resp.text
                m_title = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html_text, re.I)
                if not m_title:
                    m_title = re.search(r'<title>([^<]+)</title>', html_text, re.I)
                if m_title:
                    title = re.sub(r'\s*[-|]\s*turbo\.cr\s*$', '', m_title.group(1), flags=re.I).strip()

                m_dur = re.search(r'<meta[^>]+(?:property|name)=["\'](?:og:video:duration|video:duration)["\'][^>]+content=["\'](\d+)["\']', html_text, re.I)
                if m_dur:
                    try:
                        duration = int(m_dur.group(1))
                    except ValueError:
                        pass

                m_thumb = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html_text, re.I)
                if m_thumb:
                    thumbnail = m_thumb.group(1).strip()
                # Turbo's og:image is a dead abuse-parked redirect — drop it so we
                # fall back to a server-rendered frame from the signed CDN stream.
                if "cdn.turbo.cr/thumbs/" in thumbnail:
                    thumbnail = ""

                m_w = re.search(r'<meta[^>]+(?:property|name)=["\']og:video:width["\'][^>]+content=["\'](\d+)["\']', html_text, re.I)
                m_h = re.search(r'<meta[^>]+(?:property|name)=["\']og:video:height["\'][^>]+content=["\'](\d+)["\']', html_text, re.I)
                if m_w:
                    try: width = int(m_w.group(1))
                    except ValueError: pass
                if m_h:
                    try: height = int(m_h.group(1))
                    except ValueError: pass

                # Also try VIDEO_DIRECT const or turbocdn pattern for CDN url
                m_direct = re.search(r'const\s+VIDEO_DIRECT\s*=\s*["\']([^"\']+)["\'];', html_text)
                if m_direct:
                    cdn_url = m_direct.group(1).lstrip("\\")
                # Drop a relative or turbo.cr-hotlink VIDEO_DIRECT — it's blocked and
                # 404s. Leaving it set would skip the sign API below (same rule the
                # Turbo extractor applies).
                if cdn_url and (not cdn_url.startswith("http") or
                                re.match(r"^https?://turbo\.cr/[^/?#]+\.[a-z0-9]{2,4}(?:\?|$)", cdn_url, re.I)):
                    cdn_url = ""
                if not cdn_url:
                    m_cdn = re.search(r'(https?://[^"\'\\<>\s]+turbocdn[^"\'\\<>\s]+\.mp4[^"\'\\<>\s]*)', html_text, re.I)
                    if m_cdn:
                        cdn_url = m_cdn.group(1)

            # 2. Sign API — gets signed CDN URL if not found in page
            if not cdn_url:
                sign_resp = await client.get(
                    f"https://turbo.cr/api/sign?v={turbo_id}",
                    headers={**_TURBO_HEADERS, "Accept": "application/json", "Referer": embed_url},
                )
                if sign_resp.is_success:
                    try:
                        sign_data = sign_resp.json()
                        cdn_url = str(sign_data.get("url") or "").strip()
                    except Exception:
                        pass

            # 3. HEAD on CDN URL for Content-Length
            if cdn_url and cdn_url.startswith("http"):
                try:
                    head_resp = await client.head(
                        cdn_url,
                        headers={"User-Agent": _TURBO_HEADERS["User-Agent"], "Referer": "https://turbo.cr/"},
                        follow_redirects=True,
                    )
                    cl = head_resp.headers.get("content-length") or "0"
                    size_bytes = int(cl)
                    if size_bytes == 0:
                        # Some CDNs require GET with Range for size
                        range_resp = await client.get(
                            cdn_url,
                            headers={
                                "User-Agent": _TURBO_HEADERS["User-Agent"],
                                "Referer": "https://turbo.cr/",
                                "Range": "bytes=0-0",
                            },
                        )
                        cr = range_resp.headers.get("content-range", "")
                        m_cr = re.search(r'/(\d+)', cr)
                        if m_cr:
                            size_bytes = int(m_cr.group(1))
                except Exception:
                    pass

        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}

        size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None

        # Infer height from CDN URL path if not found in og tags
        if height == 0 and cdn_url:
            m_res = re.search(r'[/_](2160|1440|1080|720|480|360)p?(?:[/_.]|$)', cdn_url, re.I)
            if m_res:
                try: height = int(m_res.group(1))
                except ValueError: pass

        quality_str = ""
        if height >= 2160: quality_str = "4K"
        elif height >= 1080: quality_str = "1080p"
        elif height >= 720: quality_str = "720p"
        elif height >= 480: quality_str = "480p"
        elif height > 0: quality_str = f"{height}p"

        # Prefer static poster thumbnail from static.scdn.st if resolved or fallback to turbo_id
        if not thumbnail and turbo_id:
            thumbnail = f"https://static.scdn.st/6049fd43-838b-492d-a20a-9aead716dfe7/thumbs/{turbo_id}.jpg"
        if not thumbnail and cdn_url and "turbocdn.st/" in cdn_url:
            thumbnail = "/api/tester/frame?url=" + quote(cdn_url, safe="")

        return {
            "url": url,
            "ok": True,
            "id": turbo_id,
            "title": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "size_bytes": size_bytes,
            "size_mb": size_mb,
            "height": height,
            "width": width,
            "quality": quality_str,
            "stream_url": cdn_url,
            "cdn_url": cdn_url,
        }


_CYBERDROP_DOMAINS = ("cyberdrop.cr", "cyberdrop.me", "cyberdrop.to", "cyberdrop.cc", "cyberdrop.nl")
_CYBERDROP_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://cyberdrop.cr/",
}


def _cyberdrop_api_base(url: str) -> str:
    for d in _CYBERDROP_DOMAINS:
        if d in url:
            return f"https://api.{d}"
    return "https://api.cyberdrop.cr"


def _cyberdrop_slug(url: str) -> str:
    # /f/ (file page) and /e/ (embed) both map to the same file slug.
    m = re.search(r"/[ef]/([^/?#]+)", url)
    return m.group(1) if m else ""


async def _fetch_cyberdrop_meta(url: str, client: httpx.AsyncClient, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    async with semaphore:
        slug = _cyberdrop_slug(url)
        if not slug:
            return {"url": url, "ok": False, "error": "cannot extract slug"}

        api_base = _cyberdrop_api_base(url)

        try:
            r1 = await client.get(
                f"{api_base}/api/file/info/{slug}",
                headers=_CYBERDROP_HEADERS,
            )
            if r1.status_code == 404:
                return {"url": url, "ok": False, "error": "not found (404)"}
            r1.raise_for_status()
            info = r1.json()

            if not isinstance(info, dict) or info.get("error"):
                return {"url": url, "ok": False, "error": str(info.get("error", "api error"))}

            mime = info.get("type") or info.get("mime_type") or ""
            if not mime.startswith("video"):
                return {"url": url, "ok": False, "error": f"not a video ({mime})"}

            title_raw = info.get("name") or info.get("filename") or slug
            title = re.sub(r'\.[a-z0-9]{2,5}$', '', title_raw, flags=re.I) or title_raw
            size_bytes = int(info.get("size") or 0)
            thumbnail = info.get("thumbnail_url") or info.get("thumbnail") or info.get("thumb") or ""
            auth_url = info.get("auth_url") or ""
            stream_url = ""

            if auth_url:
                r2 = await client.get(auth_url, headers={**_CYBERDROP_HEADERS, "Accept": "application/json"})
                if r2.is_success:
                    auth_data = r2.json()
                    stream_url = str(auth_data.get("url") or "").strip()

            if not stream_url:
                cdn = info.get("url") or info.get("download_url") or info.get("cdn_url") or ""
                if cdn and cdn.startswith("http"):
                    stream_url = cdn

            # Infer resolution from filename / CDN path
            height = 0
            for src in (title_raw, stream_url):
                m = re.search(r'[_\-\s](\d{3,4})[pP]', src)
                if m:
                    try:
                        height = int(m.group(1))
                        break
                    except ValueError:
                        pass

            quality_str = ""
            if height >= 2160: quality_str = "4K"
            elif height >= 1080: quality_str = "1080p"
            elif height >= 720: quality_str = "720p"
            elif height >= 480: quality_str = "480p"
            elif height > 0: quality_str = f"{height}p"

            size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None

            return {
                "url": url,
                "ok": True,
                "title": title,
                "thumbnail": thumbnail,
                "duration": 0,  # cyberdrop API doesn't expose duration
                "size_bytes": size_bytes,
                "size_mb": size_mb,
                "height": height,
                "width": 0,
                "quality": quality_str,
                "stream_url": stream_url,
            }

        except httpx.HTTPStatusError as exc:
            return {"url": url, "ok": False, "error": f"HTTP {exc.response.status_code}"}
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}


_BUNKR_DOMAINS_SET = {
    "bunkr.cr", "bunkr.la", "bunkr.si", "bunkr.is", "bunkr.su", "bunkrr.su",
    "bunkr.pk", "bunkr.black", "bunkr.ws", "bunkr.vc", "bunkr.media",
    "bunkr.ru", "bunkr.to", "bunkr.ac", "bunkr.ph", "bunkr.sk", "bunkr.ps",
    "bunkr.fi", "balbums.st", "bunkr-albums.io", "bunkrr.pics"
}

# Bunkr rotates its TLD constantly (.site, .red, .ci … appeared after the set above
# was written). Match the family by shape so a new TLD doesn't silently fall through
# to the generic prober, which cannot read file size or duration.
_BUNKR_HOST_RE = re.compile(r"^(?:www\.)?bunkrr?\.[a-z]{2,8}$")


def _is_bunkr_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    if _BUNKR_HOST_RE.match(host):
        return True
    host = host[4:] if host.startswith("www.") else host
    return any(host == d or host.endswith("." + d) for d in _BUNKR_DOMAINS_SET)


def _parse_mp4_moov(moov: bytes) -> Dict[str, int]:
    """Pull (duration, width, height) out of a decoded MP4 `moov` atom.
    duration from mvhd; resolution from the first visual sample entry."""
    out = {"duration": 0, "width": 0, "height": 0}
    j = moov.find(b"mvhd")
    if j != -1:
        version = moov[j + 4]
        if version == 1:
            timescale = int.from_bytes(moov[j + 24:j + 28], "big")
            dur = int.from_bytes(moov[j + 28:j + 36], "big")
        else:
            timescale = int.from_bytes(moov[j + 16:j + 20], "big")
            dur = int.from_bytes(moov[j + 20:j + 24], "big")
        if timescale:
            out["duration"] = int(round(dur / timescale))
    for codec in (b"avc1", b"hev1", b"hvc1", b"av01", b"mp4v", b"vp09", b"vp08"):
        i = moov.find(codec)
        if i != -1:
            w = int.from_bytes(moov[i + 28:i + 30], "big")
            h = int.from_bytes(moov[i + 30:i + 32], "big")
            if 0 < w <= 16384 and 0 < h <= 16384:
                out["width"], out["height"] = w, h
                break
    return out


async def _probe_mp4_http(client: httpx.AsyncClient, url: str, size: int,
                          referer: str) -> Dict[str, int]:
    """Fast duration+resolution probe for a direct MP4 over HTTP using Range reads.

    Walks the top-level atoms (16-byte reads), jumping over a huge `mdat` via its
    box size without downloading it, and reads only the `moov` atom. Falls back to
    the file tail if `moov` sits at the end and the front walk can't reach it.
    Returns zeros on any failure (never raises). A few hundred KB total, ~1 s.
    """
    empty = {"duration": 0, "width": 0, "height": 0}
    if not size or size < 1024:
        return empty

    async def _read(start: int, length: int) -> bytes:
        length = min(length, size - start)
        if length <= 0:
            return b""
        r = await client.get(url, headers={
            "User-Agent": _HTTP_HEADERS["User-Agent"], "Referer": referer,
            "Range": f"bytes={start}-{start + length - 1}",
        })
        return r.content if r.status_code in (200, 206) else b""

    try:
        pos = 0
        for _ in range(32):
            if pos + 8 > size:
                break
            head = await _read(pos, 16)
            if len(head) < 8:
                break
            box_size = int.from_bytes(head[0:4], "big")
            box_type = head[4:8]
            hdr = 8
            if box_size == 1:
                box_size = int.from_bytes(head[8:16], "big")
                hdr = 16
            if box_type == b"moov":
                moov = await _read(pos + hdr, min(box_size - hdr, 4_000_000))
                if moov:
                    return _parse_mp4_moov(moov)
                break
            if box_size <= 0:
                break
            pos += box_size

        # moov-at-end fallback: grab the tail and scan for the atom.
        tail = await _read(max(0, size - 2_000_000), 2_000_000)
        k = tail.rfind(b"moov")
        if k != -1:
            return _parse_mp4_moov(tail[max(0, k - 4):])
    except Exception:  # noqa: BLE001
        pass
    return empty


def _shape_bunkr_file_meta(url: str, probed: Dict[str, Any], *,
                          title: str = "", thumbnail: str = "",
                          stream_url: str = "", upload_date: str = "") -> Dict[str, Any]:
    size_bytes = int(probed.get("size") or 0)
    duration = int(probed.get("duration") or 0)
    height = int(probed.get("height") or 0)
    width = int(probed.get("width") or 0)
    if height == 0 and stream_url:
        hint = re.search(r'[/_](2160|1440|1080|720|480|360)p?(?:[/_.]|$)', stream_url, re.I)
        if hint:
            height = int(hint.group(1))
    quality = ("4K" if height >= 2160 else "1080p" if height >= 1080 else
               "720p" if height >= 720 else "480p" if height >= 480 else
               f"{height}p" if height > 0 else "")
    return {
        "url": url, "ok": True, "title": title, "thumbnail": thumbnail,
        "duration": duration, "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None,
        "height": height, "width": width, "quality": quality,
        "bitrate_bps": int(size_bytes * 8 / duration) if size_bytes > 0 and duration > 0 else 0,
        "stream_url": stream_url,
        "upload_date": upload_date,
    }


async def _fetch_bunkr_meta(url: str, semaphore: asyncio.Semaphore, *,
                           metadata_only: bool = False) -> Dict[str, Any]:
    path = urlparse(url).path or ""
    is_album = "/a/" in path or "/album/" in path or "/albums/" in path
    if metadata_only and not is_album:
        cached = mp4_probe_cache_get(url)
        if cached and all(int(cached.get(key) or 0) > 0
                          for key in ("duration", "size", "width", "height")):
            # No API resolution, HTML, or CDN reads for a complete cache hit.
            # Never reuse signed stream URLs; metadata-only callers don't need one.
            result = _shape_bunkr_file_meta(url, cached, upload_date=(_listing_meta_get(url) or {}).get("upload_date") or "")
            result["cached"] = True
            return result
    async with semaphore:
        parsed = urlparse(url)
        path = parsed.path or ""
        is_album = "/a/" in path or "/album/" in path or "/albums/" in path

        try:
            if is_album:
                items = await _bunkr_extractor.extract_album(url, listing_only=True)
                if not items:
                    return {"url": url, "ok": False, "error": "album empty or inaccessible"}

                first = items[0] if isinstance(items[0], dict) else {}
                album_items = _shape_album_items(items, url)
                album_size_bytes = _album_total_size_bytes(album_items)
                title = first.get("title") or first.get("name") or f"Bunkr album ({len(items)} súborov)"
                thumbnail = first.get("thumb") or ""
                return {
                    "url": url,
                    "ok": True,
                    "title": title,
                    "thumbnail": thumbnail,
                    "duration": 0,
                    "size_bytes": album_size_bytes,
                    "size_mb": round(album_size_bytes / (1024 * 1024), 1) if album_size_bytes else None,
                    "album_size_bytes": album_size_bytes,
                    "album_size_mb": round(album_size_bytes / (1024 * 1024), 1) if album_size_bytes else None,
                    "height": 0,
                    "width": 0,
                    "quality": "",
                    "item_count": len(items),
                    "video_count": len(items),
                    "stream_url": first.get("url") or "",
                    "album_items": album_items,
                    "album_thumbnails": [
                        item.get("thumbnail") for item in album_items if item.get("thumbnail")
                    ][:4],
                    "content_type": "album",
                    "upload_date": _latest_album_upload_date(album_items),
                }
            else:
                result = (await _bunkr_extractor.extract(url, metadata_only=True)
                          if metadata_only else await _bunkr_extractor.extract(url))
                if not result:
                    return {"url": url, "ok": False, "error": "extraction failed"}

                stream_url = result.get("stream_url") or ""
                size_bytes = 0
                duration = int(result.get("duration") or 0)
                height = int(result.get("height") or 0)
                width = int(result.get("width") or 0)
                if stream_url:
                    try:
                        # One shared, cache-backed probe replaces the old HEAD +
                        # range-size + bespoke moov sequence. `probe_mp4_cached`
                        # gets the exact size from Content-Range, reads only bounded
                        # MP4 ranges, and avoids every CDN request on later album
                        # visits (cache key is the stable Bunkr file page URL).
                        if re.search(r'\.(mp4|m4v|mov)(?:[?#]|$)', stream_url, re.I):
                            probed = await probe_mp4_cached(
                                url,
                                stream_url,
                                headers={
                                    "User-Agent": _HTTP_HEADERS["User-Agent"],
                                    "Referer": "https://bunkr.cr/",
                                },
                            )
                            size_bytes = int(probed.get("size") or 0)
                            duration = duration or int(probed.get("duration") or 0)
                            height = height or int(probed.get("height") or 0)
                            width = width or int(probed.get("width") or 0)
                    except Exception:
                        pass

                return _shape_bunkr_file_meta(
                    url, {"duration": duration, "size": size_bytes,
                          "height": height, "width": width},
                    title=result.get("title") or "",
                    thumbnail=result.get("thumbnail") or "", stream_url=stream_url,
                    upload_date=result.get("upload_date") or (_listing_meta_get(url) or {}).get("upload_date") or "",
                )
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}


async def _fetch_porntrex_meta(url: str, client: Optional[httpx.AsyncClient], semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    async with semaphore:
        try:
            status, html, final_url = await _ntc_page(
                url, domain="porntrex.com", headers=_PORNTREX_HEADERS, deadline=18.0,
            )
            if status >= 400:
                return {"url": url, "ok": False, "error": f"HTTP {status}"}

            data = _extract_porntrex_meta_from_html(final_url, html)
            data["url"] = url

            stream_url = data.get("stream_url") or ""
            for pattern in (
                r'["\'](?:2160p|1440p|1080p|720p|480p|360p)["\']\s*:\s*["\'](https?://[^"\']+\.mp4[^"\']*)["\']',
                r'(https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*)',
            ):
                if stream_url:
                    break
                match = re.search(pattern, html, re.I)
                if match:
                    stream_url = match.group(1).replace("\\/", "/")
                    break
            data["stream_url"] = stream_url
            return data
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}


_COOMER_DIRECT_RE = re.compile(r"^(?:img|n)\d*\.coomerfans\.com$", re.I)
_COOMER_REFERER = "https://coomerfans.com/"


def _is_coomer_direct_url(url: str) -> bool:
    """Signed CDN file: already the stream, but carries no metadata of its own."""
    p = urlparse(url)
    return bool(_COOMER_DIRECT_RE.match(p.netloc or "")) and p.path.lower().endswith(
        (".mp4", ".m4v", ".mov", ".webm", ".mkv")
    )


async def _fetch_coomer_meta(url: str, client: httpx.AsyncClient, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    """Size from the Range header, duration/resolution from the MP4 `moov` atom."""
    async with semaphore:
        headers = {"User-Agent": _HTTP_HEADERS["User-Agent"], "Referer": _COOMER_REFERER}
        try:
            head = await client.get(url, headers={**headers, "Range": "bytes=0-0"})
        except Exception as exc:  # noqa: BLE001
            return {"url": url, "ok": False, "error": str(exc)}

        if head.status_code in (403, 410):
            return {"url": url, "ok": False, "error": "Podpisany odkaz vyprsal (403). Ziskaj novy z povodneho postu."}
        if head.status_code not in (200, 206):
            return {"url": url, "ok": False, "error": f"CDN vratil HTTP {head.status_code}"}

        size_bytes = 0
        content_range = head.headers.get("content-range", "")
        if "/" in content_range:
            size_bytes = int(content_range.rsplit("/", 1)[-1] or 0)
        elif head.status_code == 200:
            size_bytes = int(head.headers.get("content-length") or 0)

        probed = await _probe_mp4_http(client, url, size_bytes, _COOMER_REFERER)
        height = int(probed.get("height") or 0)
        width = int(probed.get("width") or 0)

        # Quality follows the shorter side: a 332x590 portrait clip is 332p, not "480p".
        short = min(width, height) if width and height else height
        if short >= 2160: quality = "4K"
        elif short >= 1080: quality = "1080p"
        elif short >= 720: quality = "720p"
        elif short >= 480: quality = "480p"
        elif short > 0: quality = f"{short}p"
        else: quality = ""

        name = os.path.splitext(os.path.basename(urlparse(url).path))[0]
        return {
            "url": url,
            "ok": True,
            "title": name or "Coomer Video",
            # Rendered on demand by /api/tester/frame — the CDN offers no poster.
            "thumbnail": f"/api/tester/frame?url={quote(url, safe='')}",
            "duration": int(probed.get("duration") or 0),
            "size_bytes": size_bytes,
            "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
            "height": height,
            "width": width,
            "quality": quality,
            "stream_url": url,
        }


def _is_filester_url(url: str) -> bool:
    return is_fileditch_url(url) or "filester." in urlparse(url).netloc.lower()


async def _fetch_filester_meta(url: str, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    async with semaphore:
        try:
            if _filester_extractor._extract_folder_slug(url):
                items = await _filester_extractor.extract_album_entries(url)
                if not items:
                    return {"url": url, "ok": False, "error": "album empty or inaccessible"}
                album_items = _shape_album_items(items, url)
                first = album_items[0] if album_items else {}
                album_size_bytes = _album_total_size_bytes(album_items)
                upload_date = max((str(item.get("upload_date") or "") for item in album_items), default="")
                return {
                    "url": url,
                    "ok": True,
                    "title": first.get("title") or f"Filester album ({len(items)} poloziek)",
                    "thumbnail": first.get("thumbnail") or "",
                    "duration": 0,
                    "size_bytes": album_size_bytes,
                    "size_mb": round(album_size_bytes / (1024 * 1024), 1) if album_size_bytes > 0 else None,
                    "album_size_bytes": album_size_bytes,
                    "album_size_mb": round(album_size_bytes / (1024 * 1024), 1) if album_size_bytes > 0 else None,
                    "height": first.get("height") or 0,
                    "width": first.get("width") or 0,
                    "quality": first.get("quality") or "",
                    "stream_url": first.get("stream_url") or "",
                    "upload_date": upload_date,
                    "item_count": len(items),
                    "video_count": len(items),
                    "album_items": album_items,
                    "album_thumbnails": [item.get("thumbnail") for item in album_items if item.get("thumbnail")][:4],
                }

            result = await _filester_extractor.extract(url)
            if not result:
                # Filester drops /d/ pages under a burst; one pause-and-retry
                # inside the slot recovers live files that Overiť used to mark dead.
                await asyncio.sleep(1.2)
                result = await _filester_extractor.extract(url)
            if not result:
                return {"url": url, "ok": False, "error": "extraction failed"}

            size_bytes = result.get("size_bytes") or 0
            size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None
            height = result.get("height") or 0

            quality_str = result.get("quality") or ""
            if not quality_str and height > 0:
                if height >= 2160: quality_str = "4K"
                elif height >= 1080: quality_str = "1080p"
                elif height >= 720: quality_str = "720p"
                elif height >= 480: quality_str = "480p"
                else: quality_str = f"{height}p"

            return {
                "url": url,
                "ok": True,
                "title": result.get("title") or "",
                "thumbnail": result.get("thumbnail") or "",
                "duration": int(result.get("duration") or 0),
                "size_bytes": size_bytes,
                "size_mb": size_mb,
                "height": height,
                "width": result.get("width") or 0,
                "quality": quality_str,
                "stream_url": result.get("stream_url") or "",
                "content_type": result.get("content_type") or "",
                "is_hls": bool(result.get("is_hls") or False),
                "upload_date": result.get("uploaded_at") or "",
            }
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc) or type(exc).__name__}


def _is_pornhub_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return "pornhub.com" in host or "pornhub.org" in host


def _ph_duration_to_secs(text: str) -> int:
    if not text:
        return 0
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", text, re.I)
    if m:
        return int(m.group(1) or 0) * 3600 + int(m.group(2) or 0) * 60 + int(m.group(3) or 0)
    return _parse_duration_text(text)


def _hls_exact_size_bytes(master_url: str, referer: str = "https://www.pornhub.com/") -> int:
    """Back-compat wrapper — returns only the size."""
    size, _h = _hls_size_and_height(master_url, referer)
    return size


def _hls_size_and_height(master_url: str, referer: str = "https://www.pornhub.com/"):
    """
    (size_bytes, height) of an HLS video. Size = sum of every segment's
    Content-Length (the only accurate way for HLS-only sources). Height comes
    from the chosen (highest) variant's RESOLUTION. Segment HEADs run in
    parallel. Synchronous — call via asyncio.to_thread.
    """
    try:
        from curl_cffi import requests as creq
        import concurrent.futures
        import time
    except Exception:
        return 0, 0

    hdr = {"Referer": referer}
    chosen_height = 0

    def _get(u: str) -> str:
        try:
            r = creq.get(u, impersonate="chrome", timeout=15, headers=hdr)
            return r.text or "" if r.status_code == 200 else ""
        except Exception:
            return ""

    def _best_variant(playlist_text: str, playlist_base: str) -> str:
        """Pick the highest-resolution / highest-bandwidth variant URI."""
        nonlocal chosen_height
        lines = playlist_text.splitlines()
        best_uri = ""
        best_score = -1
        best_h = 0
        for i, ln in enumerate(lines):
            if ln.startswith("#EXT-X-STREAM-INF"):
                res = re.search(r"RESOLUTION=\d+x(\d+)", ln)
                bw = re.search(r"BANDWIDTH=(\d+)", ln)
                h = int(res.group(1)) if res else 0
                score = (h * 1_000_000) + (int(bw.group(1)) if bw else 0)
                # The URI is the next non-comment line.
                for nxt in lines[i + 1:]:
                    s = nxt.strip()
                    if s and not s.startswith("#"):
                        if score > best_score:
                            best_score = score
                            best_uri = s
                            best_h = h
                        break
        if best_h:
            chosen_height = best_h
        if not best_uri:
            # No STREAM-INF tags — fall back to the first media URI.
            for ln in lines:
                s = ln.strip()
                if s and not s.startswith("#"):
                    best_uri = s
                    break
        if not best_uri:
            return ""
        return best_uri if best_uri.startswith("http") else f"{playlist_base}/{best_uri}"

    master = _get(master_url)
    if not master:
        return 0, 0
    base = master_url.rsplit("/", 1)[0]

    variant_url = master_url
    variant = master
    # Descend through up to 2 master levels to reach the media playlist
    # (the one with #EXTINF segment lines), always choosing the best variant.
    for _ in range(2):
        if "#EXTINF" in variant:
            break
        if "#EXT-X-STREAM-INF" not in variant:
            break
        chosen = _best_variant(variant, variant_url.rsplit("/", 1)[0] if variant_url != master_url else base)
        if not chosen:
            return 0, chosen_height
        variant_url = chosen
        variant = _get(variant_url)
    if "#EXTINF" not in variant:
        return 0, chosen_height

    vbase = variant_url.rsplit("/", 1)[0]
    seg_urls = [
        (ln if ln.startswith("http") else f"{vbase}/{ln.strip()}")
        for ln in variant.splitlines()
        if ln and not ln.startswith("#")
    ]
    if not seg_urls:
        return 0, chosen_height

    def _seg_size(su: str) -> int:
        # Retry a couple of times — signed HLS CDNs (xvideos) rate-limit / drop
        # connections under heavy parallelism.
        for attempt in range(3):
            try:
                r = creq.head(su, impersonate="chrome", timeout=12, headers=hdr)
                cl = r.headers.get("content-length")
                if cl and int(cl) > 0:
                    return int(cl)
                # Some CDNs don't answer HEAD with length — try a 0-0 range GET.
                r2 = creq.get(su, impersonate="chrome", timeout=12,
                              headers={**hdr, "Range": "bytes=0-0"})
                cr = r2.headers.get("content-range", "")
                m = re.search(r"/(\d+)", cr)
                if m:
                    return int(m.group(1))
            except Exception:
                pass
            time.sleep(0.3 * (attempt + 1))
        return -1  # signal failure (vs a real 0-byte segment)

    # Moderate concurrency: the batch endpoint already runs many videos in
    # parallel, so keep per-video segment fan-out low to avoid CDN throttling.
    sizes = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        sizes = list(ex.map(_seg_size, seg_urls))

    failed = sum(1 for s in sizes if s < 0)
    good = [s for s in sizes if s >= 0]
    # If too many segments failed the total would be wrong — report 0 (unknown)
    # rather than a misleadingly small size.
    if failed > max(2, len(seg_urls) * 0.1):
        return 0, chosen_height
    # Estimate any few failed segments from the average of good ones.
    total = sum(good)
    if failed and good:
        total += int(failed * (sum(good) / len(good)))
    return total, chosen_height


async def _fetch_pornhub_meta(url: str, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    """
    Pornhub video metadata WITHOUT yt-dlp/PhantomJS. yt-dlp hits a JS math
    challenge (needs PhantomJS); but the watch page itself exposes everything we
    need (og:title, video:duration, mediaDefinitions qualities, og:image) once it
    loads. We fetch with curl_cffi (browser TLS) and retry past the intermittent
    challenge page (which is tiny, <3 KB).
    """
    async with semaphore:
        headers = {
            "Referer": "https://www.pornhub.com/",
            "Cookie": "accessAgeDisclaimerPH=1; accessPH=1; platform=pc; age_verified=1",
        }
        html = ""
        for _ in range(4):
            try:
                _status, html, _final = await _ntc_page(
                    url, domain="pornhub.com", headers=headers, deadline=18.0,
                )
            except Exception as exc:
                return {"url": url, "ok": False, "error": str(exc)}
            # The challenge page is tiny; the real page is hundreds of KB.
            if len(html) > 20000:
                break
            await asyncio.sleep(0.6)

        if len(html) < 20000:
            return {"url": url, "ok": False, "error": "pornhub challenge not passed"}

        title = _first_match([
            r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        ], html) or "Pornhub video"

        duration = 0
        m_dur = re.search(r'video:duration["\'][^>]+content=["\'](\d+)', html)
        if m_dur:
            duration = int(m_dur.group(1))
        if not duration:
            m_ld = re.search(r'"duration"\s*:\s*"(PT[^"]+)"', html)
            if m_ld:
                duration = _ph_duration_to_secs(m_ld.group(1))

        thumbnail = _first_match([
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        ], html)

        # Upload date (JSON-LD VideoObject) → YYYY-MM-DD.
        upload_date = ""
        m_date = re.search(r'"uploadDate"\s*:\s*"(\d{4}-\d{2}-\d{2})', html)
        if m_date:
            upload_date = m_date.group(1)

        # Highest available quality from mediaDefinitions.
        heights = [int(q) for q in re.findall(r'"quality"\s*:\s*"?(\d{3,4})"?', html)]
        height = max(heights) if heights else 0
        if not height:
            m_h = re.search(r'og:video:height["\'][^>]+content=["\'](\d+)', html)
            if m_h:
                height = int(m_h.group(1))

        quality = ""
        if height >= 2160:
            quality = "4K"
        elif height >= 1080:
            quality = "1080p"
        elif height >= 720:
            quality = "720p"
        elif height >= 480:
            quality = "480p"
        elif height > 0:
            quality = f"{height}p"

        # Exact size: Pornhub is HLS-only, so pick the videoUrl for the chosen
        # height and sum its segments. Falls back to any videoUrl if no height match.
        stream_url = ""
        size_bytes = 0
        video_urls = [u.replace("\\/", "/") for u in re.findall(r'"videoUrl"\s*:\s*"([^"]+)"', html)]
        if video_urls:
            chosen = ""
            if height:
                for u in video_urls:
                    if re.search(rf"(?<!\d){height}P_", u) or f"{height}P" in u.upper():
                        chosen = u
                        break
            chosen = chosen or video_urls[0]
            stream_url = chosen
            try:
                size_bytes = await asyncio.to_thread(_hls_exact_size_bytes, chosen)
            except Exception:
                size_bytes = 0

        size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None

        return {
            "url": url,
            "ok": True,
            "title": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "size_bytes": size_bytes,
            "size_mb": size_mb,
            "height": height,
            "width": int(height * 16 / 9) if height else 0,
            "quality": quality,
            "stream_url": stream_url,
            "upload_date": upload_date,
        }


def _is_xvideos_url(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return "xvideos.com" in host or "xvideos.red" in host


async def _fetch_xvideos_meta(url: str, semaphore: asyncio.Semaphore) -> Dict[str, Any]:
    """
    Fast XVideos metadata: scrape the watch page directly with curl_cffi (~0.15s)
    instead of yt-dlp (~1.6s). The page exposes setVideoHLS(), og:title,
    duration (PT…), og:image and uploadDate. Size comes from summing the HLS
    stream's segments (~0.4s). ~5× faster than the yt-dlp resolve path.
    """
    async with semaphore:
        headers = {"Referer": "https://www.xvideos.com/"}
        try:
            status, html, _final = await _ntc_page(
                url, domain="xvideos.com", headers=headers, deadline=18.0,
            )
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}
        if status != 200 or len(html) < 2000:
            return {"url": url, "ok": False, "error": f"HTTP {status}"}

        import html as _htmlmod

        title = _first_match([
            r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        ], html)
        title = _htmlmod.unescape(title) if title else "XVideos video"

        duration = 0
        m_dur = re.search(r'"duration"\s*:\s*"(PT[^"]+)"', html)
        if m_dur:
            duration = _ph_duration_to_secs(m_dur.group(1))
        if not duration:
            m_dur2 = re.search(r'video:duration["\'][^>]+content=["\'](\d+)', html)
            if m_dur2:
                duration = int(m_dur2.group(1))

        thumbnail = _first_match([
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        ], html)

        upload_date = ""
        m_date = re.search(r'"uploadDate"\s*:\s*"(\d{4}-\d{2}-\d{2})', html)
        if m_date:
            upload_date = m_date.group(1)

        m_hls = re.search(r"setVideoHLS\(['\"]([^'\"]+)['\"]", html)
        stream_url = m_hls.group(1) if m_hls else ""

        size_bytes = 0
        height = 0
        if stream_url:
            try:
                size_bytes, height = await asyncio.to_thread(
                    _hls_size_and_height, stream_url, "https://www.xvideos.com/")
            except Exception:
                size_bytes, height = 0, 0

        quality = ""
        if height >= 2160:
            quality = "4K"
        elif height >= 1080:
            quality = "1080p"
        elif height >= 720:
            quality = "720p"
        elif height >= 480:
            quality = "480p"
        elif height > 0:
            quality = f"{height}p"

        size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None
        return {
            "url": url,
            "ok": True,
            "title": title,
            "thumbnail": thumbnail,
            "duration": duration,
            "size_bytes": size_bytes,
            "size_mb": size_mb,
            "height": height,
            "width": int(height * 16 / 9) if height else 0,
            "quality": quality,
            "stream_url": stream_url,
            "upload_date": upload_date,
        }


def _meta_from_resolve_payload(resolved: Dict[str, Any]) -> Dict[str, Any]:
    data = resolved.get("data") or {}
    if resolved.get("status") != "success":
        return {
            "url": resolved.get("url") or "",
            "ok": False,
            "error": resolved.get("message") or "metadata extraction failed",
        }

    size_bytes = int(data.get("size_bytes") or 0)
    if size_bytes <= 0:
        size_mb_value = data.get("size_mb")
        try:
            size_mb_float = float(size_mb_value)
        except (TypeError, ValueError):
            size_mb_float = 0.0
        if size_mb_float > 0:
            size_bytes = int(size_mb_float * 1024 * 1024)

    size_mb = round(size_bytes / (1024 * 1024), 1) if size_bytes > 0 else None
    return {
        "url": resolved.get("url") or "",
        "ok": True,
        "title": data.get("title") or "",
        "filename": data.get("filename") or "",
        "thumbnail": data.get("thumbnail") or "",
        "duration": int(data.get("duration") or 0),
        "size_bytes": size_bytes,
        "size_mb": size_mb,
        "size_estimated": bool(data.get("size_estimated")),
        "height": int(data.get("height") or 0),
        "width": int(data.get("width") or 0),
        "quality": data.get("quality") or "",
        "views": int(data.get("views") or 0),
        "uploader": data.get("uploader") or "",
        "tags": data.get("tags") or [],
        "stream_url": data.get("stream_url") or "",
        "item_count": int(data.get("item_count") or 0),
        "video_count": int(data.get("video_count") or 0),
        "upload_date": data.get("upload_date") or "",
        "album_items": data.get("album_items") or [],
        "album_thumbnails": data.get("album_thumbnails") or [],
        "album_size_bytes": int(data.get("album_size_bytes") or 0),
        "album_size_mb": data.get("album_size_mb"),
    }


async def _enrich_duration_height(
    meta: Dict[str, Any], client: httpx.AsyncClient, referer: str
) -> None:
    """Fill in missing duration/resolution for a direct-MP4 stream by reading its
    moov atom over HTTP range (fast, ~1 s). Mutates `meta` in place. This is what
    lets the tester show real duration + quality for direct-file hosts (Turbo,
    CyberDrop, Pixeldrain …) whose page/API expose neither."""
    if not meta.get("ok"):
        return
    if meta.get("duration") and meta.get("height") and meta.get("size_bytes"):
        return
    stream = str(meta.get("stream_url") or "").strip()
    if not stream.lower().startswith(("http://", "https://")):
        return
    # Only container formats the moov reader understands. Cyberdrop/Turbo/Pixeldrain
    # signed URLs may not end in .mp4, so also allow their known CDN path shapes.
    if not re.search(r"\.(mp4|m4v|mov)(?:[?#]|$)", stream, re.I) and not re.search(
        r"(turbocdn\.st/|gigachad-cdn|/api/file/d/|pixeldrain\.com/api/file/)", stream, re.I
    ):
        return
    try:
        size = int(meta.get("size_bytes") or 0)
        if not size:
            r = await client.get(stream, headers={"User-Agent": _HTTP_HEADERS["User-Agent"],
                                                  "Referer": referer, "Range": "bytes=0-0"})
            cr = r.headers.get("content-range", "")
            if "/" in cr:
                size = int(cr.rsplit("/", 1)[-1] or 0)
            elif r.headers.get("content-length"):
                size = int(r.headers["content-length"])
            if size >= 10240:
                meta["size_bytes"] = size
                meta["size_mb"] = round(size / (1024 * 1024), 1)
        if size:
            probed = await _probe_mp4_http(client, stream, size, referer)
            if probed.get("duration") and not meta.get("duration"):
                meta["duration"] = probed["duration"]
            if probed.get("height") and not meta.get("height"):
                meta["height"] = probed["height"]
                meta["width"] = probed.get("width") or meta.get("width") or 0
                short = min(meta["width"], meta["height"]) if meta.get("width") else meta["height"]
                if short >= 2160: meta["quality"] = "4K"
                elif short >= 1440: meta["quality"] = "1440p"
                elif short >= 1080: meta["quality"] = "1080p"
                elif short >= 720: meta["quality"] = "720p"
                elif short >= 480: meta["quality"] = "480p"
                elif short > 0: meta["quality"] = f"{short}p"
    except Exception:
        pass


def _referer_for_host(url: str) -> str:
    try:
        p = urlparse(url)
        if p.scheme and p.netloc:
            return f"{p.scheme}://{p.netloc}/"
    except Exception:
        pass
    return ""


async def _fetch_eporner_listed_meta(
    url: str,
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
) -> Dict[str, Any]:
    """Same data as the Eporner page 'Fetch sizes/dates' button: watch HTML only.

    The import panel parses the download table + upload date from the video page
    (4 concurrent GETs, no CDN HEAD). Tester used to run the full extractor
    (page GET + /dload HEAD + yt-dlp fallback) behind a 2s pacer, which is why
    sizes felt much slower here.
    """
    from ..extractors.eporner import EpornerExtractor
    from ..eporner_playlist_index import _load_video_meta, video_key

    cached = _load_video_meta(video_key(url)) or {}
    if (cached.get("size_mb") or cached.get("size_bytes")) and all(
        cached.get(field) for field in ("upload_date", "duration", "height")
    ):
        height = int(cached.get("height") or 0)
        quality = "4K" if height >= 2160 else (f"{height}p" if height else "")
        return {
            "url": url,
            "ok": True,
            "title": "",
            "thumbnail": "",
            "duration": int(cached.get("duration") or 0),
            "size_bytes": int(cached.get("size_bytes") or 0),
            "size_mb": cached.get("size_mb"),
            "size_estimated": True,
            "height": height,
            "quality": quality,
            "upload_date": cached.get("upload_date") or "",
            "uploader": cached.get("uploader") or "",
            "filename": "",
            "stream_url": "",
            "cached": True,
        }

    headers = dict(_HTTP_HEADERS)
    headers["Referer"] = "https://www.eporner.com/"
    cookie = _eporner_cookie_header()
    if cookie:
        headers["Cookie"] = cookie
    html = ""
    async with semaphore:
        try:
            status, html, _final = await _ntc_page(url, domain="eporner.com", headers=headers, deadline=18.0)
            if status != 200:
                html = ""
        except Exception as exc:
            logger.debug("[Link Tester] Eporner listed meta GET failed: %s", exc)
    if not html:
        try:
            from ..eporner_transport import fetch_listing
            resp = await fetch_listing(url)
            html = getattr(resp, "text", "") or ""
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc)}
    parsed = EpornerExtractor.parse_watch_page_meta(html)
    ok = bool(parsed.get("size_bytes") or parsed.get("size_mb") or parsed.get("upload_date") or parsed.get("duration"))
    return {
        "url": url,
        "ok": ok,
        "title": parsed.get("title") or "",
        "thumbnail": parsed.get("thumbnail") or "",
        "duration": int(parsed.get("duration") or 0),
        "size_bytes": int(parsed.get("size_bytes") or 0),
        "size_mb": parsed.get("size_mb"),
        "size_estimated": bool(parsed.get("size_estimated")),
        "height": int(parsed.get("height") or 0),
        "quality": parsed.get("quality") or "",
        "upload_date": parsed.get("upload_date") or "",
        "filename": parsed.get("filename") or "",
        "views": int(parsed.get("views") or 0),
        "stream_url": "",
    }


def _full_card_source(url: str) -> str:
    host = (urlparse(url).hostname or "").lower()
    domains = {"porntrex.com": "porntrex", "whoreshub.com": "whoreshub",
               "pornone.com": "pornone", "xhamster.com": "xhamster",
               "eporner.com": "eporner", "xvideos.com": "xvideos",
               "noodlemagazine.com": "noodlemagazine", "ukdevilz.com": "noodlemagazine",
               "camwhores.tv": "camwhores", "pimpbunny.com": "pimpbunny",
               "leakporner.com": "leakporner", "mypornerleak.com": "leakporner",
               "analdin.com": "analdin", "anysex.com": "anysex"}
    return next((source for domain, source in domains.items()
                 if host == domain or host.endswith('.' + domain)), "")


def _card_meta_row(url: str, meta: dict) -> dict:
    duration = meta.get("duration_sec") or meta.get("duration") or 0
    if isinstance(duration, str):
        duration = _parse_duration_text(duration)
    size = int(meta.get("size_bytes") or round(float(meta.get("size_mb") or 0) * 1048576))
    height = int(meta.get("height") or 0)
    return {**meta, "url": url, "ok": bool(meta), "duration": duration,
            "size_bytes": size, "size_mb": round(size / 1048576, 1) if size else None,
            "height": height,
            "quality": meta.get("quality") or ("4K" if height >= 2160 else f"{height}p" if height else ""),
            "upload_date": meta.get("upload_date") or meta.get("added") or ""}


def _parse_pornone_card_meta(url: str, html: str) -> dict:
    from bs4 import BeautifulSoup
    from ..hubs.base import iso_duration_to_secs
    soup = BeautifulSoup(html, "html.parser")
    video = {}
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.get_text())
        except (TypeError, ValueError):
            continue
        rows = value if isinstance(value, list) else [value]
        for row in list(rows):
            if isinstance(row, dict) and isinstance(row.get('@graph'), list):
                rows.extend(row['@graph'])
        video = next((row for row in rows if isinstance(row, dict) and row.get('@type') == 'VideoObject'), {})
        if video:
            break
    sources = []
    player = soup.select_one('#pornone-video-player')
    for node in (player.select('source') if player else soup.select('video source')):
        stream = urljoin(url, node.get('src') or '')
        dimensions = re.search(r'_(\d{3,4})x(\d{3,4})(?:_|\.)', stream)
        label = re.search(r'(\d{3,4})p', node.get('label') or '')
        height = int(dimensions.group(2)) if dimensions else int(label.group(1)) if label else 0
        width = int(dimensions.group(1)) if dimensions else 0
        if stream.startswith(('http://', 'https://')) and node.get('src'):
            sources.append((height, width, stream))
    height, width, stream = max(sources, default=(0, 0, video.get('contentUrl') or ''), key=lambda row: row[0])
    title_node = soup.select_one('h1, .videotitle')
    thumbnail = video.get('thumbnailUrl') or ''
    if isinstance(thumbnail, list):
        thumbnail = thumbnail[0] if thumbnail else ''
    return {"title": video.get('name') or (title_node.get_text(' ', strip=True) if title_node else ''),
            "thumbnail": urljoin(url, thumbnail) if thumbnail else '',
            "duration": iso_duration_to_secs(str(video.get('duration') or '').replace('P0DT', 'PT')),
            "upload_date": str(video.get('uploadDate') or '')[:10],
            "height": height, "width": width, "stream_url": stream,
            "views": (video.get('interactionStatistic') or {}).get('userInteractionCount') or 0,
            "description": video.get('description') or ''}


def _parse_kvs_watch_meta(url: str, html: str) -> dict:
    """Extrahuje metadáta a najvyššiu MP4 URL z KVS watch stránok (Analdin, AnySex)."""
    from bs4 import BeautifulSoup
    from ..hubs.base import iso_duration_to_secs
    from ..search.base import parse_duration_seconds

    soup = BeautifulSoup(html, "html.parser")
    video = {}
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            value = json.loads(script.get_text())
        except (TypeError, ValueError):
            continue
        rows = value if isinstance(value, list) else [value]
        for row in list(rows):
            if isinstance(row, dict) and isinstance(row.get("@graph"), list):
                rows.extend(row["@graph"])
        video = next((row for row in rows if isinstance(row, dict) and row.get("@type") == "VideoObject"), {})
        if video:
            break

    candidates: list[tuple[int, str]] = []
    seen_u: set[str] = set()
    for raw_u in re.findall(r"""https?://[^"'\s<>\\]+\.mp4/?(?:\?[^"'\s<>\\]*)?""", html, re.I):
        cand = raw_u.replace("\\/", "/").strip()
        low = cand.lower()
        if cand in seen_u or any(bad in low for bad in ("preview", "vthumb", "videos_screenshots")):
            continue
        if "/get_file/" not in low and "mp4" not in low:
            continue
        seen_u.add(cand)
        m_res = re.search(r"[_-](\d{3,4})\.mp4", low)
        h = int(m_res.group(1)) if m_res else (720 if "hd.mp4" in low else 480)
        candidates.append((h, cand))

    height, stream = max(candidates, default=(0, ""), key=lambda row: row[0])
    title_node = soup.select_one('meta[property="og:title"]')
    h1_node = soup.select_one("h1")
    title = (title_node.get("content") if title_node else "") or (h1_node.get_text(" ", strip=True) if h1_node else "")
    thumb = video.get("thumbnailUrl") or ""
    if isinstance(thumb, list):
        thumb = thumb[0] if thumb else ""
    if not thumb:
        og_img = soup.select_one('meta[property="og:image"]')
        thumb = (og_img.get("content") if og_img else "") or ""

    duration = iso_duration_to_secs(str(video.get("duration") or "").replace("P0DT", "PT"))
    if not duration:
        dur_meta = soup.select_one('meta[itemprop="duration"]')
        if dur_meta and dur_meta.get("content"):
            duration = iso_duration_to_secs(str(dur_meta["content"]).replace("P0DT", "PT"))
    if not duration:
        dur_el = soup.select_one(".duration, .video-info .time, .info span")
        if dur_el:
            duration = parse_duration_seconds(dur_el.get_text(" ", strip=True)) or _parse_duration_text(dur_el.get_text(" ", strip=True))
    if not duration:
        m_dur = re.search(r'"duration"\s*:\s*"?(\d{1,5})"?|video_duration\s*[:=]\s*[\'"]?(\d{1,5})', html, re.I)
        if m_dur:
            duration = int(m_dur.group(1) or m_dur.group(2) or 0)

    return {
        "title": str(video.get("name") or title or "").strip(),
        "thumbnail": urljoin(url, str(thumb)) if thumb else "",
        "duration": int(duration or 0),
        "upload_date": str(video.get("uploadDate") or "")[:10],
        "height": height,
        "stream_url": stream,
    }


async def _fetch_full_card_meta(url: str, source: str, client, semaphore) -> dict:
    cached = _FULL_CARD_META.get(url)
    if cached:
        return {**cached, "cached": True}
    async with semaphore:
        try:
            if source == "pornone":
                status, html, final_url = await _ntc_page(url, domain="pornone.com", deadline=18.0)
                if status != 200:
                    raise RuntimeError(f"HTTP {status}")
                meta = _parse_pornone_card_meta(final_url or url, html)
                if meta.get("stream_url"):
                    probed = await probe_mp4_cached(url, meta['stream_url'],
                        headers={"Referer": "https://pornone.com/"}, timeout=12)
                    meta['size_bytes'] = probed.get('size') or 0
                    for field in ('duration', 'height', 'width'):
                        if probed.get(field):
                            meta[field] = int(probed[field])
            elif source == "leakporner":
                from ..extractors.leakporner import LeakPornerExtractor
                meta = await LeakPornerExtractor().fetch_watch_metadata(url)
            elif source in {"analdin", "anysex"}:
                from curl_cffi.requests import AsyncSession
                origin = f"{urlparse(url).scheme or 'https'}://{urlparse(url).netloc}"
                async with AsyncSession(impersonate="chrome") as cf_sess:
                    resp = await cf_sess.get(url, headers={"Referer": f"{origin}/"}, timeout=12)
                    if resp.status_code != 200:
                        raise RuntimeError(f"HTTP {resp.status_code}")
                    meta = _parse_kvs_watch_meta(str(resp.url or url), resp.text)
                    stream_u = meta.get("stream_url") or ""
                    if stream_u:
                        probed = await probe_mp4_cached(url, stream_u, headers={"Referer": f"{origin}/"}, timeout=10)
                        meta["size_bytes"] = int(probed.get("size") or 0)
                        for field in ("duration", "height", "width"):
                            if probed.get(field) and not meta.get(field):
                                meta[field] = int(probed[field])
                        if not meta["size_bytes"]:
                            try:
                                r_rng = await cf_sess.get(stream_u, headers={"Referer": url, "Range": "bytes=0-0"}, timeout=8, allow_redirects=True)
                                cr_hdr = str(r_rng.headers.get("content-range") or "")
                                m_cr = re.search(r"/(\d+)\s*$", cr_hdr)
                                if m_cr:
                                    meta["size_bytes"] = int(m_cr.group(1))
                                elif int(r_rng.headers.get("content-length") or 0) > 1024:
                                    meta["size_bytes"] = int(r_rng.headers["content-length"])
                            except Exception:
                                pass
            else:
                from ..hubs.registry import get, init_hubs
                init_hubs()
                hub = get(source)
                if hub is None:
                    raise RuntimeError("Metadata adapter unavailable")
                if source == "xhamster":
                    meta = (await asyncio.wait_for(hub.enrich([url], deep=True), 45)).get(url) or {}
                elif source in {"xvideos", "noodlemagazine"}:
                    meta = (await asyncio.wait_for(hub.enrich([url]), 45)).get(url) or {}
                    if source == "noodlemagazine" and not meta.get("thumbnail"):
                        try:
                            from ..extractors.noodlemagazine import NoodleMagazineExtractor
                            nm_data = await asyncio.to_thread(NoodleMagazineExtractor()._extract_manual, url)
                            if nm_data and nm_data.get("thumbnail"):
                                meta["thumbnail"] = nm_data["thumbnail"]
                            if nm_data and nm_data.get("title") and not meta.get("title"):
                                meta["title"] = nm_data["title"]
                        except Exception:
                            pass
                elif source == "camwhores":
                    meta = await asyncio.wait_for(hub._detail_metadata(url, deep=True), 45)
                else:
                    meta = await hub._detail_metadata(url)
            evidence = ('duration', 'duration_sec', 'height', 'upload_date', 'added')
            if source in {"leakporner", "pimpbunny"}:
                evidence += ('thumbnail',)
            if not meta or not any(meta.get(k) for k in evidence):
                raise RuntimeError("Watch page metadata unavailable")
            row = _card_meta_row(url, meta)
            if all(row.get(k) for k in ('duration', 'height', 'size_bytes', 'upload_date')):
                _FULL_CARD_META[url] = dict(row)
            return row
        except Exception as exc:
            return {"url": url, "ok": False, "error": str(exc) or type(exc).__name__}


async def _fetch_any_meta(
    url: str,
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    bunkr_semaphore: asyncio.Semaphore,
    *, metadata_only: bool = False,
    full_metadata: bool = False,
    filester_semaphore: Optional[asyncio.Semaphore] = None,
    watch_client: Any = None,
    external_gate: Optional[asyncio.Semaphore] = None,
) -> Dict[str, Any]:
    """Route to the right meta-fetcher based on URL host."""
    if _is_camwhores_video_url(url) and watch_client is not None and external_gate is not None:
        async with semaphore:
            fast = await _fast_camwhores_detail(url, client, watch_client, external_gate)
        if fast:
            return _card_meta_row(url, fast)

    source = _full_card_source(url) if full_metadata and metadata_only else ""
    if source and source != "eporner":
        return await _fetch_full_card_meta(url, source, client, semaphore)
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    if metadata_only and host in {"porntrex.com", "whoreshub.com"}:
        # Share the watch-page parser used by Fusion Hub: download table size,
        # resolution and publication date without resolving playback/importing.
        from ..hubs.registry import get, init_hubs
        async with semaphore:
            try:
                init_hubs()
                hub = get(host.split('.')[0])
                if hub is None:
                    raise RuntimeError("Metadata adapter unavailable")
                meta = await hub._detail_metadata(url)
                return {**meta, "url": url, "ok": True,
                        "duration": meta.get("duration_sec") or meta.get("duration") or 0,
                        "size_bytes": round((meta.get("size_mb") or 0) * 1048576)}
            except Exception as exc:
                return {"url": url, "ok": False, "error": str(exc)}
    if metadata_only and _is_eporner_watch_url(url):
        # Playlist cards usually contain title/duration only. Do not let that
        # partial listing cache skip fetching the download table and date.
        return await _fetch_eporner_listed_meta(url, client, semaphore)
    if metadata_only and _is_xvideos_url(url):
        cached = _listing_meta_get(url)
        if cached and (cached.get("duration") or cached.get("title") or cached.get("size_bytes")):
            height = int(cached.get("height") or 0)
            quality = cached.get("quality") or (
                "4K" if height >= 2160 else "1080p" if height >= 1080 else
                "720p" if height >= 720 else "480p" if height >= 480 else
                f"{height}p" if height > 0 else ""
            )
            size_bytes = int(cached.get("size_bytes") or 0)
            size_mb = cached.get("size_mb")
            if size_mb in (None, "") and size_bytes > 0:
                size_mb = round(size_bytes / (1024 * 1024), 1)
            return {
                "url": url,
                "ok": True,
                "title": cached.get("title") or "",
                "thumbnail": cached.get("thumbnail") or "",
                "duration": int(cached.get("duration") or 0),
                "size_bytes": size_bytes,
                "size_mb": size_mb,
                "height": height,
                "width": int(cached.get("width") or 0),
                "quality": quality,
                "upload_date": cached.get("upload_date") or "",
                "stream_url": "",
                "cached": True,
            }
    if _is_vk_playlist_url(url):
        playlist = await asyncio.to_thread(_extract_vk_playlist_fast, url)
        if not playlist.get("ok"):
            return playlist
        return {
            "url": url,
            "ok": True,
            "title": playlist.get("title") or "VK playlist",
            "thumbnail": playlist.get("thumbnail") or "",
            "duration": _safe_int(playlist.get("duration")),
            "size_bytes": _safe_int(playlist.get("album_size_bytes")),
            "size_mb": playlist.get("album_size_mb"),
            "uploader": playlist.get("uploader") or "",
            "upload_date": playlist.get("upload_date") or "",
            "item_count": _safe_int(playlist.get("item_count")),
            "video_count": _safe_int(playlist.get("video_count")),
            "album_items": playlist.get("album_items") or [],
            "album_thumbnails": playlist.get("album_thumbnails") or [],
            "album_size_bytes": _safe_int(playlist.get("album_size_bytes")),
            "album_size_mb": playlist.get("album_size_mb"),
            "album_size_estimated": bool(playlist.get("album_size_estimated")),
        }
    if _is_porntrex_url(url):
        return await _fetch_porntrex_meta(url, client, semaphore)
    if _is_pornhub_url(url) and "view_video" in url:
        return await _fetch_pornhub_meta(url, semaphore)
    if _is_xvideos_url(url) and "/video" in url:
        return await _fetch_xvideos_meta(url, semaphore)
    if any(d in url for d in _CYBERDROP_DOMAINS):
        meta = await _fetch_cyberdrop_meta(url, client, semaphore)
        await _enrich_duration_height(meta, client, "https://cyberdrop.cr/")
        return meta
    if _is_bunkr_url(url):
        return await _fetch_bunkr_meta(url, bunkr_semaphore, metadata_only=metadata_only)
    if _is_coomer_direct_url(url):
        return await _fetch_coomer_meta(url, client, semaphore)
    if _is_filester_url(url):
        return await _fetch_filester_meta(url, filester_semaphore or semaphore)
    if "turbo.cr" in url:
        meta = await _fetch_turbo_meta(url, client, semaphore)
        # Turbo signs the CDN URL under cdn_url; make sure enrichment sees it.
        if not meta.get("stream_url") and meta.get("cdn_url"):
            meta["stream_url"] = meta["cdn_url"]
        await _enrich_duration_height(meta, client, "https://turbo.cr/")
        return meta

    resolved = await resolve_single_url(url, semaphore)
    meta = _meta_from_resolve_payload(resolved)

    # Generic HLS size backfill: many sources (XVideos, …) only give an .m3u8
    # stream with no file size. Sum its segments to get an exact size.
    if meta.get("ok") and not meta.get("size_bytes"):
        stream = (meta.get("stream_url") or "").strip()
        if stream and (".m3u8" in stream.lower() or "/hls/" in stream.lower() or "hls-cdn" in stream.lower()):
            ref = "https://www.xvideos.com/" if "xvideos" in url else f"https://{urlparse(url).netloc}/"
            try:
                sb = await asyncio.to_thread(_hls_exact_size_bytes, stream, ref)
                if sb > 0:
                    meta["size_bytes"] = sb
                    meta["size_mb"] = round(sb / (1024 * 1024), 1)
            except Exception:
                pass

    # Generic direct-MP4 duration/height backfill (Pixeldrain and any other
    # direct-file host that fell through to the generic resolver).
    await _enrich_duration_height(meta, client, _referer_for_host(url))
    return meta


async def _gather_meta_until_disconnect(tasks, http_request=None):
    """Cancel queued async metadata work when the client disconnects."""
    group = asyncio.gather(*tasks)
    if http_request is None:
        return await group

    stop_watching = asyncio.Event()

    async def watch_disconnect():
        while not stop_watching.is_set():
            if await http_request.is_disconnected():
                return
            # Starlette's is_disconnected() uses a cancel scope which can
            # consume cancellation. Cache hits may finish inside that scope;
            # the explicit stop flag ensures cleanup still terminates.
            if stop_watching.is_set():
                return
            await asyncio.sleep(0.25)

    watcher = asyncio.create_task(watch_disconnect())
    try:
        done, _ = await asyncio.wait((group, watcher), return_when=asyncio.FIRST_COMPLETED)
        if group in done:
            return await group
        raise HTTPException(status_code=499, detail="Metadata request cancelled")
    finally:
        stop_watching.set()
        watcher.cancel()
        if not group.done():
            group.cancel()
        await asyncio.gather(watcher, group, return_exceptions=True)


@router.post("/batch-meta")
async def batch_meta(request: BatchMetaRequest, http_request: Request = None):
    """
    Fast bulk metadata fetch for turbo.cr, cyberdrop, and bunkr URLs.
    """
    if not request.urls:
        return {"results": [], "total": 0}

    urls = [_normalize_url(u) for u in request.urls if _normalize_url(u)]
    if len(urls) > MAX_LINKS:
        raise HTTPException(status_code=400, detail=f"Max {MAX_LINKS} URLs per request.")

    BATCH_CONCURRENCY = 50
    BUNKR_CONCURRENCY = 6  # Bunkr is rate-sensitive — keep low
    FILESTER_CONCURRENCY = 3  # Filester /d/ pages 5xx/drop under a burst
    semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)
    bunkr_semaphore = asyncio.Semaphore(BUNKR_CONCURRENCY)
    filester_semaphore = asyncio.Semaphore(FILESTER_CONCURRENCY)
    camwhores_semaphore = asyncio.Semaphore(20)
    camwhores_external_gate = asyncio.Semaphore(6)
    eporner_pacer = EpornerPacer()
    # Listed size/date is one HTML GET per video, like the on-page importer
    # (DETAIL_CONCURRENCY = 4). Full stream resolve stays on the slow pacer.
    eporner_listed = asyncio.Semaphore(4)

    def semaphore_for(url: str):
        if _is_camwhores_video_url(url):
            return camwhores_semaphore
        if _is_eporner_url(url):
            if request.metadata_only and _is_eporner_watch_url(url):
                return eporner_listed
            return eporner_pacer
        return semaphore

    if request.metadata_only and all(_is_bunkr_url(url) for url in urls):
        # Bunkr uses its own shared curl session and MP4 probe clients. Creating
        # the unrelated generic HTTP pool adds overhead even to cache-only runs.
        tasks = [_fetch_bunkr_meta(url, bunkr_semaphore, metadata_only=True) for url in urls]
        results = await _gather_meta_until_disconnect(tasks, http_request)
    else:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=8.0),
            follow_redirects=True,
            verify=False,
            limits=httpx.Limits(max_connections=80, max_keepalive_connections=60),
        ) as client, AsyncExitStack() as stack:
            watch_client = None
            if any(_is_camwhores_video_url(url) for url in urls):
                from curl_cffi.requests import AsyncSession
                watch_client = await stack.enter_async_context(
                    AsyncSession(impersonate="chrome124", timeout=10, verify=False, max_clients=20)
                )
            tasks = [_fetch_any_meta(url, client, semaphore_for(url), bunkr_semaphore,
                                     metadata_only=request.metadata_only,
                                     full_metadata=request.full_metadata,
                                     filester_semaphore=filester_semaphore,
                                     watch_client=watch_client,
                                     external_gate=camwhores_external_gate) for url in urls]
            results = await _gather_meta_until_disconnect(tasks, http_request)

    ok = sum(1 for r in results if r.get("ok"))
    try:
        from ..eporner_playlist_index import remember_video_meta
        for row in results:
            url = row.get("url") or ""
            if row.get("ok") and _is_eporner_url(url):
                remember_video_meta(url, row)
    except Exception:
        logger.debug("[Link Tester] Eporner video meta persist skipped", exc_info=True)
    return {
        "results": list(results),
        "total": len(results),
        "ok": ok,
        "failed": len(results) - ok,
    }


_THUMB_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
}


# Each entry maps a host matcher to the Referer ffmpeg must send to that CDN.
# Turbo (.turbocdn.st) and Coomer both 404/403 without the right Referer, which a
# plain <video poster> cannot supply — so we render the frame server-side instead.
_TURBO_CDN_RE = re.compile(r"^(?:[a-z0-9-]+\.)?turbocdn\.st$", re.I)
_GOFILE_CDN_RE = re.compile(r"^(?:[a-z0-9-]+\.)?gofile\.io$", re.I)
_FILEDITCH_CDN_RE = re.compile(r"^(?:[a-z0-9-]+\.)*(?:fileditchfiles|fileditchvids|theditch|embedditch|fileditchhot|staysharpwakesat5am)\.[a-z0-9]+$", re.I)
_FILESTER_CDN_RE = re.compile(r"^(?:(?:cache|cdn|p)\d*\.filester\.(?:me|gg)|fsc\d*\.cdn\.cr)$", re.I)
_FRAME_ALLOWED_HOSTS = (
    (_COOMER_DIRECT_RE, _COOMER_REFERER),
    (_TURBO_CDN_RE, "https://turbo.cr/"),
    (_GOFILE_CDN_RE, "https://gofile.io/"),
    (_FILEDITCH_CDN_RE, "https://fileditchvids.st/"),
    (_FILESTER_CDN_RE, "https://filester.me/"),
)

# FileDitch's signed CDN hostname isn't stable (freakingfileditch.me,
# donotsharethesetemplinksyouidiot.st, boomditching.com, staysharpwakesat5am.xyz...
# — rotated CDN hostnames). Both the legacy /beta<N>/... format and the newer
# tokenized base64 CDN path format are recognized.
_FILEDITCH_SIGNED_PATH_RE = re.compile(r"^/beta\d+/[0-9a-f]{8,}/[^/]+$", re.I)


def _is_fileditch_signed_url(parsed) -> bool:
    query = parse_qs(parsed.query)
    if _FILEDITCH_SIGNED_PATH_RE.match(parsed.path or "") and "exp" in query and "sig" in query:
        return True
    path_first = (parsed.path or "").strip("/").split("/")[0]
    if len(path_first) > 40 and "." not in path_first:
        try:
            import base64
            padded = path_first + "=" * (-len(path_first) % 4)
            dec = base64.urlsafe_b64decode(padded).decode("utf-8", errors="ignore")
            if any(k in dec for k in ("charlie", "alpha", "bravo", "delta", "echo", ".mp4", ".mkv", ".webm")):
                return True
        except Exception:
            pass
    host = (parsed.netloc or "").lower()
    if any(h in host for h in ("staysharpwakesat5am", "fileditch", "embedditch")):
        return True
    return False


def _frame_referer_for(netloc: str) -> Optional[str]:
    for rx, referer in _FRAME_ALLOWED_HOSTS:
        if rx.match(netloc or ""):
            return referer
    return None


@router.get("/frame", response_model=None)
async def frame_thumbnail(
    url: str = Query(..., description="Direct video URL to grab a poster frame from"),
    at: int = Query(10, ge=0, le=600, description="Seek position in seconds"),
    width: int = Query(480, ge=240, le=1920, description="Maximum poster width in pixels"),
    request: Request = None,
):
    """Render a poster frame for direct video files that ship no thumbnail.

    Restricted to hosts we know serve plain MP4/MOV over HTTP — this shells out to
    ffmpeg, so it must never accept an arbitrary URL.
    """
    # If the client passed an unquoted signed stream with query params (e.g. ?url=https://...?exp=...&token=...&at=3),
    # FastAPI's url query parameter only captures up to the first '&'. Recover the full video URL from the raw query string.
    raw_query = getattr(getattr(request, "url", None), "query", "") or ""
    if "turbocdn.st" in raw_query and ("&token=" in raw_query or "&exp=" in raw_query):
        m_full = re.search(r"url=(https?://.*?)(?:&(?:at|width)=\d+|$)", raw_query)
        if m_full:
            from urllib.parse import unquote
            recovered = unquote(m_full.group(1))
            if recovered.startswith("http"):
                url = recovered

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Invalid URL")
    referer = _frame_referer_for(parsed.netloc or "")
    if referer is None and not _is_fileditch_signed_url(parsed):
        raise HTTPException(status_code=403, detail="Host not allowed for frame extraction")

    ffmpeg_bin = shutil.which("ffmpeg") or os.environ.get("FFMPEG_PATH", r"C:\ffmpeg\bin\ffmpeg.exe")
    if not ffmpeg_bin or (os.path.isabs(ffmpeg_bin) and not os.path.isfile(ffmpeg_bin)):
        raise HTTPException(status_code=503, detail="ffmpeg nie je dostupny")

    def _build_cmd(seek: int) -> list:
        cmd = [ffmpeg_bin, "-hide_banner", "-loglevel", "error"]
        headers_str = f"User-Agent: {_THUMB_HEADERS['User-Agent']}\r\n"
        if referer:
            headers_str += f"Referer: {referer}\r\n"
        if "gofile.io" in (parsed.netloc or "").lower():
            try:
                from ..extractors.gofile import GoFileExtractor
                t = GoFileExtractor._get_token()
                if t:
                    wt = GoFileExtractor._generate_website_token(t)
                    headers_str += (
                        f"Cookie: accountToken={t}\r\n"
                        f"Authorization: Bearer {t}\r\n"
                        "X-BL: en-US\r\n"
                        f"X-Website-Token: {wt}\r\n"
                    )
            except Exception:
                pass
        if headers_str:
            cmd += ["-headers", headers_str]
        return cmd + [
            "-ss", str(seek), "-i", url,
            "-frames:v", "1", "-vf", f"scale=w='min(iw,{width})':h=-2",
            "-q:v", "2", "-f", "mjpeg", "pipe:1",
        ]

    # Run ffmpeg synchronously in a worker thread. asyncio.create_subprocess_exec
    # is unreliable under the running event loop on Windows (no child watcher on a
    # Selector loop), whereas subprocess.run works under any loop.
    def _run_ffmpeg(seek: int) -> "subprocess.CompletedProcess[bytes]":
        return subprocess.run(
            _build_cmd(seek), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30
        )

    # Short clips are common (Turbo/Bunkr): a fixed at=10 s seek overshoots a 3-5 s
    # video and yields no frame. Fall back through progressively earlier seeks
    # (and finally the very first frame) so every playable video gets a poster.
    seek_positions = [s for s in (at, 3, 1, 0) if s <= at]
    seek_positions = list(dict.fromkeys(seek_positions)) or [0]
    proc = None
    try:
        for seek in seek_positions:
            proc = await asyncio.to_thread(_run_ffmpeg, seek)
            if proc.returncode == 0 and proc.stdout:
                break
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Frame extraction timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="ffmpeg nie je dostupny")

    if not proc or proc.returncode != 0 or not proc.stdout:
        logger.warning("[Frame] ffmpeg failed for %s: %s", url[:80], (proc.stderr if proc else b"")[:180])
        raise HTTPException(status_code=502, detail="Nepodarilo sa vytiahnut snimku")

    return Response(
        content=proc.stdout,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/thumb")
async def thumb_proxy(
    url: str = Query(..., description="Thumbnail URL to proxy"),
    referer: str = Query("", description="Original page URL to use as image referer"),
):
    """Proxy external thumbnail images to avoid hotlink protection."""
    url = _require_public_proxy_url(url)
    parsed = urlparse(url)

    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            verify=False,
            timeout=httpx.Timeout(8.0, connect=5.0),
        ) as client:
            referer_candidates = []
            if referer.startswith(("http://", "https://")):
                referer_candidates.append(referer)
            if _is_porntrex_url(url) or _is_porntrex_url(referer):
                referer_candidates.extend([
                    "https://www.porntrex.com/",
                    f"{parsed.scheme}://{parsed.netloc}/",
                ])
            referer_candidates.append(f"{parsed.scheme}://{parsed.netloc}/")

            r = None
            for ref in dict.fromkeys(referer_candidates):
                r = await client.get(url, headers={**_THUMB_HEADERS, "Referer": ref})
                if r.status_code < 400 and r.headers.get("content-type", "").lower().startswith("image/"):
                    break
            if r is None:
                raise HTTPException(status_code=404, detail="Thumbnail not found")
            if r.status_code >= 400:
                raise HTTPException(status_code=404, detail="Thumbnail not found")

            content_type = r.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            if not content_type.startswith("image/"):
                raise HTTPException(status_code=422, detail="Not an image")

            return Response(
                content=r.content,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=3600"},
            )
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[ThumbProxy] Failed for %s: %s", url, exc)
        raise HTTPException(status_code=502, detail="Fetch failed")


@router.get("/stream-frame")
async def stream_frame_proxy(
    stream_url: str = Query(..., description="Resolved HLS/MP4 URL"),
    at: int = Query(5, ge=0, le=600, description="Frame position in seconds"),
    width: int = Query(640, ge=480, le=3840, description="Maximum frame width in pixels"),
):
    """Capture a video frame for previews, preserving source resolution up to width."""
    stream_url = _require_public_proxy_url(stream_url)
    parsed = urlparse(stream_url)
    host = parsed.hostname or ""

    key_data = f"{stream_url}\n{at}\n{width}"
    key = hashlib.sha256(key_data.encode("utf-8")).hexdigest()
    now = time.monotonic()
    cached = _STREAM_FRAME_CACHE.get(key)
    if cached and now - cached[0] < _STREAM_FRAME_TTL_SECONDS:
        return Response(content=cached[1], media_type="image/jpeg", headers={"Cache-Control": "public, max-age=1800"})

    ffmpeg_path = os.environ.get("FFMPEG_PATH", r"C:\\ffmpeg\\bin\\ffmpeg.exe")
    if not os.path.isfile(ffmpeg_path):
        raise HTTPException(status_code=503, detail="Frame generator unavailable")

    try:
        async with _STREAM_FRAME_SEMAPHORE:
            command = [
                ffmpeg_path, "-hide_banner", "-loglevel", "error", "-ss", str(at),
            ]
            referer = _frame_referer_for(parsed.netloc or "")
            if referer:
                command += ["-headers", f"Referer: {referer}\r\n"]
            command += [
                "-i", stream_url, "-frames:v", "1",
                "-vf", f"scale=w='min(iw,{width})':h=-2", "-q:v", "2",
                "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
            ]
            try:
                # Windows' reload server uses an event loop without async process
                # support.  Running the tiny ffmpeg task in a worker thread keeps
                # the endpoint portable while the semaphore limits its cost.
                completed = await asyncio.to_thread(
                    subprocess.run,
                    command,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=18,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                raise HTTPException(status_code=504, detail="Frame generation timed out")
        if completed.returncode != 0 or not completed.stdout:
            logger.info("[StreamFrame] ffmpeg could not create a frame for %s: %s", host, completed.stderr.decode("utf-8", "replace")[-300:])
            raise HTTPException(status_code=422, detail="Frame unavailable")
        _STREAM_FRAME_CACHE[key] = (now, completed.stdout)
        return Response(content=completed.stdout, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=1800"})
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("[StreamFrame] Failed for %s: %s", host, exc)
        raise HTTPException(status_code=502, detail="Frame generation failed")


# ── IDM (Internet Download Manager) hand-off ─────────────────────────────────
# The dashboard runs on the same Windows box as IDM, so the browser doesn't have
# to reach IDM at all — it posts the resolved links here and the server drives
# IDM's documented CLI. That also means the links never leave the machine.
_IDM_KNOWN_PATHS = (
    r"C:\Program Files (x86)\Internet Download Manager\IDMan.exe",
    r"C:\Program Files\Internet Download Manager\IDMan.exe",
)
_WINDOWS_NAME_BAD_CHARS = re.compile(r'[\/:*?"<>|\r\n\t]+')


class IdmItem(BaseModel):
    url: str
    filename: Optional[str] = ""
    source_url: Optional[str] = ""


class IdmDownloadRequest(BaseModel):
    items: List[IdmItem]
    path: Optional[str] = ""
    start: bool = True


def _find_idm_exe() -> str:
    """IDMan.exe path: explicit override, then IDM's own registry key, then the
    standard install dirs. Returns "" when IDM isn't installed."""
    override = (os.environ.get("IDM_PATH") or "").strip('"').strip()
    if override and os.path.isfile(override):
        return override
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\DownloadManager") as key:
            exe = str(winreg.QueryValueEx(key, "ExePath")[0] or "").strip('"')
            if exe and os.path.isfile(exe):
                return exe
    except Exception:  # noqa: BLE001 — non-Windows, key absent, or value missing
        pass
    return next((p for p in _IDM_KNOWN_PATHS if os.path.isfile(p)), "")


def _idm_safe_filename(name: str, url: str) -> str:
    """A Windows-legal filename, falling back to the URL's own basename."""
    candidate = _WINDOWS_NAME_BAD_CHARS.sub(" ", (name or "").strip())
    candidate = re.sub(r"\s+", " ", candidate).strip().rstrip(".")
    if not candidate:
        candidate = os.path.basename(urlparse(url).path) or "video"
        # ".../2160.av1.mp4.m3u8" -> "2160.av1.mp4": drop the playlist suffix so
        # the name describes the file IDM actually writes.
        candidate = re.sub(r"\.m3u8$", "", candidate, flags=re.I)
    if len(candidate) > 150:
        candidate = candidate[:150].rstrip()
    ext = os.path.splitext(candidate)[1]
    if not ext or ext.lower() == ".m3u8":
        # IDM muxes the HLS segments into one MP4, so an .m3u8 extension here
        # would leave a video file carrying a playlist's name.
        url_ext = os.path.splitext(re.sub(r"\.m3u8$", "", urlparse(url).path, flags=re.I))[1]
        candidate = os.path.splitext(candidate)[0] if ext else candidate
        candidate += url_ext if url_ext and len(url_ext) <= 5 else ".mp4"
    return candidate


@router.post("/idm")
async def send_to_idm(body: IdmDownloadRequest, request: Request):
    """Queue resolved direct links in IDM via its command line."""
    idm_exe = _find_idm_exe()
    if not idm_exe:
        raise HTTPException(
            status_code=503,
            detail="IDM sa nenasiel. Nastav premennu IDM_PATH na IDMan.exe alebo nainstaluj IDM.",
        )

    queued: List[str] = []
    skipped: List[Dict[str, str]] = []
    remuxed = 0
    # IDM will fetch this back off us, so point it at the address it actually
    # reached us on rather than assuming a port.
    local_base = str(request.base_url).rstrip("/")

    for item in body.items:
        url = (item.url or "").strip()
        if not url.startswith(("http://", "https://")):
            skipped.append({"url": url, "reason": "nepodporovana URL"})
            continue

        display_name = _idm_safe_filename(item.filename or "", url)

        # 1. Re-resolve / refresh expiring or IP-bound tokens (e.g. Filester CDN)
        is_filester = (
            re.search(r"filester\.|fileditchfiles\.|fsc\d*\.cdn\.cr", url, re.I)
            or (item.source_url and re.search(r"filester\.|fileditchfiles\.", item.source_url, re.I))
        )
        if is_filester:
            slug_source = item.source_url or url
            m = re.search(r"/d/([A-Za-z0-9_-]+)", slug_source, re.I)
            if m:
                slug = m.group(1)
                try:
                    fresh_meta = await _filester_extractor.extract(f"https://filester.me/d/{slug}")
                    if fresh_meta and fresh_meta.get("stream_url"):
                        url = fresh_meta["stream_url"]
                        logger.info("[IDM] Refreshed Filester token for %s: %s", slug, url[:80])
                except Exception as exc:
                    logger.warning("[IDM] Failed to refresh Filester token for %s: %s", slug, exc)

        # 2. Pixeldrain: verify if direct download works or hit anonymous daily quota
        if "pixeldrain.com" in url.lower():
            pd_key = (os.environ.get("PIXELDRAIN_API_KEY") or "").strip()
            needs_bridge = False
            test_headers = {"User-Agent": "Mozilla/5.0"}
            if pd_key:
                auth_b64 = base64.b64encode(f":{pd_key}".encode()).decode()
                test_headers["Authorization"] = f"Basic {auth_b64}"
            try:
                async with httpx.AsyncClient(timeout=4, follow_redirects=True) as client:
                    probe = await client.head(url, headers=test_headers)
                    if probe.status_code == 403:
                        needs_bridge = True
            except Exception:
                pass

            if needs_bridge or pd_key:
                token = base64.urlsafe_b64encode(url.encode("utf-8")).decode().rstrip("=")
                url_safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", display_name).strip("_") or "video.mp4"
                url = f"{local_base}/api/tester/stream-download/{token}/{url_safe_name}"
                remuxed += 1

        elif (
            re.search(r"https?://[^/]*(?:camwhores\.tv|camvideos\.org|cwvids\.com)/", url, re.I)
            and re.search(r"https?://[^/]*camwhores\.tv/videos/\d+", item.source_url or "", re.I)
        ):
            # IDM's own request omits the watch-page Referer and Camwhores
            # get_file replies with a closed connection. The local Range bridge
            # forwards that Referer while keeping IDM's resumable file request.
            payload = json.dumps({"url": url, "referer": item.source_url}).encode("utf-8")
            token = base64.urlsafe_b64encode(payload).decode().rstrip("=")
            url_safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", display_name).strip("_") or "video.mp4"
            url = f"{local_base}/api/tester/stream-download/{token}/{url_safe_name}"
            remuxed += 1

        elif re.search(r"\.m3u8(\?|$)", url, re.I):
            # Hand IDM the local MP4 bridge instead of the playlist — see the
            # _hls_download docstring for why the raw .m3u8 cannot work here.
            token = base64.urlsafe_b64encode(url.encode("utf-8")).decode().rstrip("=")
            # IDM does not percent-decode the path segment it takes the name from,
            # so a "%20" reaches the disk as a literal "-20" ("College-20Casting-20.mp4").
            # Keep the URL segment to characters that never need encoding.
            url_safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", display_name).strip("_") or "video.mp4"
            url = f"{local_base}/api/tester/hls-download/{token}/{url_safe_name}"
            remuxed += 1
        # `/a` is deliberately NOT used for the normal path. It parks the link in
        # the queue without downloading, and `/s` (start scheduler queue) does not
        # reliably kick those off — links landed in IDM and then just sat there.
        # A plain `/d` starts each download straight away, which is the point.
        args = [idm_exe, "/d", url, "/f", display_name, "/n"]
        if not body.start:
            args.append("/a")  # explicit "queue only, don't download yet"
        if body.path:
            args += ["/p", body.path]
        try:
            await asyncio.to_thread(subprocess.run, args, timeout=20, check=False)
            queued.append(url)
        except Exception as exc:  # noqa: BLE001 — one bad link must not sink the batch
            logger.warning("[IDM] Failed to queue %s: %s", url[:90], exc)
            skipped.append({"url": url, "reason": f"IDM chyba: {exc}"})

    # No `/s` here on purpose: each link above already started on its own `/d`,
    # and `/s` would additionally kick off whatever else happens to be sitting in
    # the user's IDM queue — downloads they never asked this button to touch.

    logger.info("[IDM] queued=%s remuxed=%s skipped=%s", len(queued), remuxed, len(skipped))
    return {"queued": len(queued), "remuxed": remuxed, "skipped": skipped, "idm_path": idm_exe}


# ── HLS → MP4 bridge for IDM ─────────────────────────────────────────────────
# IDM has two completely separate paths for HLS. Its browser grabber parses the
# playlist, pulls every segment and muxes them — that is what produces the
# multi-hundred-MB download people see. Its command line does not: handed an
# .m3u8 it treats the playlist as an ordinary file and "finishes" after ~21 KB
# (verified from IDM's own registry entry: FileSize == Downloaded == 21463).
# The grabber cannot be triggered from outside the browser, so instead we hand
# IDM something it *can* download: this endpoint remuxes the HLS into a plain
# MP4 stream on the fly, locally, and IDM saves it like any normal file.
def _ffmpeg_binary() -> str:
    configured = (os.environ.get("FFMPEG_PATH") or "").strip('"').strip()
    if configured and os.path.isfile(configured):
        return configured
    return "ffmpeg"


# The source URL is base64'd into the PATH and the filename is the LAST segment,
# with no query string anywhere. IDM names the saved file by slicing the URL, and
# it ignores both the `/f` switch and Content-Disposition here — with the source
# as a `?url=` parameter it produced files literally named
# "College%20Casting....mp4?url=https%3A%2F%2Fvideo-nss...". Ending the URL on a
# clean ".mp4" segment is the only thing it reliably honours.
@router.get("/hls-download/{token}/{filename}")
async def hls_download(token: str, filename: str):
    try:
        padded = token + "=" * (-len(token) % 4)
        url = base64.urlsafe_b64decode(padded.encode()).decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Bad source token: {exc}") from exc

    url = _require_public_proxy_url(url)
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()

    filename = _idm_safe_filename(filename or "", url)
    command = [
        _ffmpeg_binary(), "-hide_banner", "-loglevel", "error",
        "-i", url,
        "-c", "copy",
        # Fragmented MP4 so the muxer never needs to seek back to patch the
        # header — the output is a pipe, which cannot be rewound.
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "pipe:1",
    ]

    def _stream():
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            while True:
                chunk = proc.stdout.read(256 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            # Covers the client (IDM) hanging up mid-download: without this the
            # ffmpeg process would keep pulling segments with nobody reading.
            if proc.poll() is None:
                proc.kill()
            try:
                proc.stdout.close()
                proc.stderr.close()
            except Exception:  # noqa: BLE001
                pass

    logger.info("[HLS→MP4] streaming %s as %s", url[:100], filename)
    return StreamingResponse(
        _stream(),
        media_type="video/mp4",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


# ── Direct Stream Bridge for IDM ─────────────────────────────────────────────
# Used for hosts that enforce IP binding, special referers, API keys (Pixeldrain),
# or require Tor fallback when anonymous quotas are exceeded.
@router.get("/stream-download/{token}/{filename}")
async def stream_download(token: str, filename: str, request: Request):
    try:
        padded = token + "=" * (-len(token) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode()).decode("utf-8")
        source = json.loads(decoded) if decoded.startswith("{") else None
        url = source.get("url", "") if isinstance(source, dict) else decoded
        source_referer = source.get("referer", "") if isinstance(source, dict) else ""
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Bad source token: {exc}") from exc

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or not host:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if host in {"localhost", "0.0.0.0", "::1"} or host.startswith(("10.", "127.", "192.168.", "172.")):
        raise HTTPException(status_code=403, detail="Private host not allowed")

    filename = _idm_safe_filename(filename or "", url)

    # Prepare upstream headers
    _referer = (
        "https://pixeldrain.com/" if "pixeldrain" in host
        else "https://filester.me/" if any(x in host for x in ("filester", "fsc", "cdn.cr"))
        else "https://fileditchvids.st/" if any(x in host for x in ("fileditch", "staysharpwakesat5am", "embedditch"))
        else str(request.base_url)
    )
    referer_host = (urlparse(source_referer).hostname or "").lower()
    if (
        any(host == domain or host.endswith("." + domain) for domain in ("camwhores.tv", "camvideos.org", "cwvids.com"))
        and (referer_host == "camwhores.tv" or referer_host.endswith(".camwhores.tv"))
    ):
        _referer = source_referer
    upstream_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        "Referer": _referer,
        "Accept": "*/*",
    }
    if "pixeldrain" in host:
        pd_key = (os.environ.get("PIXELDRAIN_API_KEY") or "").strip()
        if pd_key:
            auth_b64 = base64.b64encode(f":{pd_key}".encode()).decode()
            upstream_headers["Authorization"] = f"Basic {auth_b64}"

    range_header = request.headers.get("range")
    if range_header:
        upstream_headers["Range"] = range_header

    tor_proxy = (os.environ.get("EPORNER_TOR_PROXY") or "socks5://127.0.0.1:9050").replace("socks5h://", "socks5://")

    client = None
    resp = None
    try:
        client = httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=10.0), follow_redirects=True, verify=False)
        req = client.build_request("GET", url, headers=upstream_headers)
        resp = await client.send(req, stream=True)

        if resp.status_code == 403 and "pixeldrain" in host:
            # Fallback to Tor proxy if direct IP reached anonymous limit
            await resp.aclose()
            await client.aclose()
            logger.info("[StreamBridge] Pixeldrain returned 403 on direct connection, retrying via Tor proxy %s", tor_proxy)
            client = httpx.AsyncClient(proxy=tor_proxy, timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True, verify=False)
            req = client.build_request("GET", url, headers=upstream_headers)
            resp = await client.send(req, stream=True)

        if resp.status_code >= 400:
            await resp.aclose()
            await client.aclose()
            raise HTTPException(status_code=resp.status_code, detail=f"Upstream returned {resp.status_code}")

        content_type = resp.headers.get("content-type", "video/mp4")
        status_code = resp.status_code

        forward_headers = {
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": resp.headers.get("accept-ranges", "bytes"),
            # Keep byte offsets and length intact through the app's GZip middleware.
            "Content-Encoding": "identity",
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        }
        if "content-range" in resp.headers:
            forward_headers["Content-Range"] = resp.headers["content-range"]
        if "content-length" in resp.headers:
            forward_headers["Content-Length"] = resp.headers["content-length"]
        elif status_code == 206 and "content-range" in resp.headers:
            match = re.match(r"bytes (\d+)-(\d+)/(?:\d+|\*)", resp.headers["content-range"], re.I)
            if match:
                forward_headers["Content-Length"] = str(int(match.group(2)) - int(match.group(1)) + 1)

        async def _stream_chunks():
            try:
                async for chunk in resp.aiter_bytes(65536):
                    yield chunk
            finally:
                await resp.aclose()
                await client.aclose()

        return StreamingResponse(
            _stream_chunks(),
            status_code=status_code,
            media_type=content_type,
            headers=forward_headers,
        )
    except HTTPException:
        raise
    except Exception as exc:
        if resp:
            await resp.aclose()
        if client:
            await client.aclose()
        logger.error("[StreamBridge] Error streaming %s: %s", url[:80], exc)
        raise HTTPException(status_code=502, detail=f"Stream bridge error: {exc}")


class LibraryCheckItem(BaseModel):
    url: str
    stream_url: str = ""
    title: str = ""
    thumbnail: str = ""
    size_bytes: float = 0
    size_mb: float = 0
    duration: float = 0
    height: int = 0


class LibraryCheckRequest(BaseModel):
    items: List[LibraryCheckItem] = Field(default_factory=list)
    include_content: bool = True


_GENERIC_THUMB_LEAVES = frozenset({
    "thumb", "thumbnail", "poster", "preview", "cover", "logo", "default",
    "placeholder", "no-thumb", "nothumb", "image", "img", "index", "video",
})


def _safe_thumb_fp(raw_url: str) -> str:
    from ..media_match import thumb_fingerprint
    fp = thumb_fingerprint(raw_url or "")
    if not fp or len(fp) < 6 or fp in _GENERIC_THUMB_LEAVES:
        return ""
    return fp


def _url_variants(raw: str) -> list[str]:
    u = str(raw or "").strip()
    if not u:
        return []
    out = [u]
    trimmed = u.rstrip("/")
    if trimmed and trimmed not in out:
        out.append(trimmed)
    slashed = trimmed + "/" if trimmed else ""
    if slashed and slashed not in out:
        out.append(slashed)
    for variant in list(out):
        if variant.startswith("https://"):
            out.append("http://" + variant[8:])
        elif variant.startswith("http://"):
            out.append("https://" + variant[7:])
    return list(dict.fromkeys(out))


@router.post("/library-check")
def check_library_duplicates(req: LibraryCheckRequest, db: Session = Depends(get_db)):
    """Check Link Tester cards against the Nexus Dashboard library.

    Distinguishes exact URL / VideoSource matches from content-level matches
    (filename key, safe thumbnail fingerprint, or size+duration) so Tester can
    tell the user *what* a card duplicates and *why*.
    """
    from ..database import Video, VideoSource
    from ..media_match import MediaFacts, media_name_key

    items = (req.items or [])[:1000]
    if not items:
        return {"matches": {}, "checked": 0, "library_total": 0}

    url_to_candidates: dict[str, set[str]] = {}
    all_candidates: set[str] = set()
    for item in items:
        for raw_u in (item.url, item.stream_url):
            for variant in _url_variants(raw_u):
                url_to_candidates.setdefault(variant, set()).add(item.url)
                all_candidates.add(variant)

    def _serialize_video(row) -> dict[str, Any]:
        return {
            "id": row.id,
            "title": row.title or f"Video #{row.id}",
            "batch_name": row.batch_name or "",
            "quality": row.quality or "",
            "height": int(row.height or 0),
            "duration": float(row.duration or 0),
            "file_size_mb": float(row.file_size_mb or 0),
            "storage_type": row.storage_type or "remote",
            "source_url": row.source_url or "",
            "thumbnail_path": row.thumbnail_path or row.original_thumbnail_url or "",
        }

    matches: dict[str, dict[str, Any]] = {}

    if all_candidates:
        exact_rows = db.query(
            Video.id, Video.title, Video.url, Video.source_url, Video.batch_name,
            Video.quality, Video.height, Video.duration, Video.file_size_mb,
            Video.storage_type, Video.thumbnail_path, Video.original_thumbnail_url,
        ).filter(
            Video.duplicate_of.is_(None),
            or_(Video.source_url.in_(all_candidates), Video.url.in_(all_candidates)),
        ).all()
        for row in exact_rows:
            payload = _serialize_video(row)
            for col_val in (row.source_url, row.url):
                if col_val and col_val in url_to_candidates:
                    for orig_url in url_to_candidates[col_val]:
                        if orig_url not in matches:
                            matches[orig_url] = {
                                "match_type": "exact_url",
                                "reason": "zhodná URL v Dashboarde",
                                "video": payload,
                            }

        source_rows = db.query(
            VideoSource.video_id, VideoSource.url, VideoSource.source_url,
        ).filter(
            or_(VideoSource.source_url.in_(all_candidates), VideoSource.url.in_(all_candidates)),
        ).all()
        if source_rows:
            src_video_ids = {sr.video_id for sr in source_rows}
            parent_by_id = {
                r.id: _serialize_video(r)
                for r in db.query(
                    Video.id, Video.title, Video.url, Video.source_url, Video.batch_name,
                    Video.quality, Video.height, Video.duration, Video.file_size_mb,
                    Video.storage_type, Video.thumbnail_path, Video.original_thumbnail_url,
                ).filter(Video.id.in_(src_video_ids), Video.duplicate_of.is_(None)).all()
            }
            for sr in source_rows:
                payload = parent_by_id.get(sr.video_id)
                if not payload:
                    continue
                for col_val in (sr.source_url, sr.url):
                    if col_val and col_val in url_to_candidates:
                        for orig_url in url_to_candidates[col_val]:
                            if orig_url not in matches:
                                matches[orig_url] = {
                                    "match_type": "exact_url",
                                    "reason": "zhodný zdroj (mirror) v Dashboarde",
                                    "video": payload,
                                }

    library_total = 0
    if req.include_content:
        lib_rows = db.query(
            Video.id, Video.title, Video.url, Video.source_url, Video.batch_name,
            Video.quality, Video.height, Video.duration, Video.file_size_mb,
            Video.storage_type, Video.thumbnail_path, Video.original_thumbnail_url,
        ).filter(Video.duplicate_of.is_(None)).all()
        library_total = len(lib_rows)

        by_name: dict[str, list[tuple[Any, MediaFacts]]] = {}
        by_thumb: dict[str, list[tuple[Any, MediaFacts]]] = {}
        by_size_bucket: dict[int, list[tuple[Any, MediaFacts]]] = {}
        size_bucket_bytes = 5 * 1024 * 1024

        for row in lib_rows:
            size_bytes = int(float(row.file_size_mb or 0) * 1024 * 1024)
            facts = MediaFacts(
                name=media_name_key(row.title or "", row.source_url or row.url or ""),
                thumb_fp=_safe_thumb_fp(row.original_thumbnail_url or ""),
                size_bytes=size_bytes,
                duration_sec=float(row.duration or 0),
                height=int(row.height or 0),
            )
            entry = (row, facts)
            if facts.name:
                by_name.setdefault(facts.name, []).append(entry)
            if facts.thumb_fp:
                by_thumb.setdefault(facts.thumb_fp, []).append(entry)
            if facts.size_bytes >= size_bucket_bytes:
                bucket = round(facts.size_bytes / size_bucket_bytes)
                by_size_bucket.setdefault(bucket, []).append(entry)

        for item in items:
            if item.url in matches:
                continue
            cand_size = int(item.size_bytes or (float(item.size_mb or 0) * 1024 * 1024))
            cand_facts = MediaFacts(
                name=media_name_key(item.title or "", item.url or ""),
                thumb_fp=_safe_thumb_fp(item.thumbnail or ""),
                size_bytes=cand_size,
                duration_sec=float(item.duration or 0),
                height=int(item.height or 0),
            )
            matched_row = None
            matched_reason = ""

            if cand_facts.name and cand_facts.name in by_name:
                matched_row = by_name[cand_facts.name][0][0]
                matched_reason = "rovnaký názov v Dashboarde"
            elif cand_facts.thumb_fp and cand_facts.thumb_fp in by_thumb:
                for row, lf in by_thumb[cand_facts.thumb_fp]:
                    if cand_facts.name and lf.name and cand_facts.name != lf.name:
                        continue
                    matched_row = row
                    matched_reason = "rovnaký náhľad v Dashboarde"
                    break
            elif cand_facts.size_bytes >= size_bucket_bytes:
                bucket = round(cand_facts.size_bytes / size_bucket_bytes)
                pool = (
                    by_size_bucket.get(bucket - 1, [])
                    + by_size_bucket.get(bucket, [])
                    + by_size_bucket.get(bucket + 1, [])
                )
                for row, lf in pool:
                    if cand_facts.name and lf.name and cand_facts.name != lf.name:
                        continue
                    size_delta = abs(cand_facts.size_bytes - lf.size_bytes) / max(cand_facts.size_bytes, lf.size_bytes)
                    if cand_facts.duration_sec > 0 and lf.duration_sec > 0:
                        if size_delta <= 0.003 and abs(cand_facts.duration_sec - lf.duration_sec) <= 3:
                            matched_row = row
                            matched_reason = "rovnaká veľkosť a dĺžka v Dashboarde"
                            break
                    elif size_delta <= 0.001:
                        matched_row = row
                        matched_reason = "rovnaká veľkosť v Dashboarde"
                        break

            if matched_row is not None:
                matches[item.url] = {
                    "match_type": "content_match",
                    "reason": matched_reason,
                    "video": _serialize_video(matched_row),
                }

    return {"matches": matches, "checked": len(items), "library_total": library_total}
