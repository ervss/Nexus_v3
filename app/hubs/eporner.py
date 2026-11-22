"""
Eporner Hub adapter.

Eporner ships an official JSON API (api/v2), so unlike scrape-based hubs every
tile arrives with FULL metadata in a single call — id, title, keywords (tags),
views, rating, duration, and multi-size thumbnails — and the endpoint answers in
a few ms. That means `needs_enrich = False`: no second round-trip for duration
or tags. Playback is JIT-resolved through the existing EpornerExtractor, exactly
as the PornHub Hub resolves via PornhubExtractor.

Docs: https://github.com/eporner/API  ·  endpoint: /api/v2/video/{search,id}/
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import threading
import time
import urllib.parse
from pathlib import Path
from threading import RLock
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

logger = logging.getLogger(__name__)

API = "https://www.eporner.com/api/v2/video"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_COOKIES = {"age_verified": "1"}


# --------------------------------------------------------------------------- #
# IP protection: proxy / Tor + throttle
#
# The enrich + pornstar surfaces scrape one page per video, so a naive burst
# hits Eporner from the real IP and earns a 429/509 (and eventually a ban). To
# avoid that we (a) optionally route every request through a proxy — Tor is just
# a socks5h proxy, so no Tor-specific code is needed — and (b) throttle to a
# minimum gap + jitter, backing off (and rotating the Tor circuit) on 429/509.
#
# Enable via env (no code change):
#   EPORNER_USE_TOR=1                      -> socks5h://127.0.0.1:9050 (+ NEWNYM
#                                             rotation via the 9051 control port)
#   EPORNER_HTTP_PROXY=socks5h://host:port -> any explicit proxy
#   (falls back to HTTPS_PROXY / HTTP_PROXY / ALL_PROXY, like the ixxx extractor)
#   EPORNER_MIN_GAP=1.5                    -> min seconds between requests
#   EPORNER_MAX_CONCURRENCY=3             -> parallel scrape cap
# --------------------------------------------------------------------------- #
def _default_tor_proxy() -> str:
    host = (os.getenv("TOR_SOCKS_HOST") or "127.0.0.1").strip()
    port = (os.getenv("TOR_SOCKS_PORT") or "9050").strip()
    return f"socks5h://{host}:{port}"


def _network_mode() -> str:
    """direct, tor, or fast direct with automatic Tor fallback."""
    raw = (os.getenv("EPORNER_NETWORK_MODE") or "auto").strip().lower()
    if raw in {"direct", "tor", "auto"}:
        return raw
    return "tor" if os.getenv("EPORNER_USE_TOR", "").strip().lower() in ("1", "true", "yes") else "direct"


def _proxy(*, force_tor: bool = False) -> Optional[str]:
    mode = _network_mode()
    if force_tor or mode == "tor":
        return os.getenv("EPORNER_TOR_PROXY", "").strip() or _default_tor_proxy()
    if mode == "direct":
        return None
    return (
        os.getenv("EPORNER_HTTP_PROXY", "").strip()
        or None
    )


def _proxies(*, force_tor: bool = False) -> Optional[dict]:
    p = _proxy(force_tor=force_tor)
    return {"http": p, "https": p} if p else None


def _min_gap() -> float:
    try:
        return max(0.0, float(os.getenv("EPORNER_MIN_GAP", "1.5")))
    except ValueError:
        return 1.5


def _max_concurrency() -> int:
    try:
        return max(1, int(os.getenv("EPORNER_MAX_CONCURRENCY", "3")))
    except ValueError:
        return 3


def _enrich_concurrency() -> int:
    # Higher default than before: the streaming enrich emits per-page, so a big
    # concurrency window fills the visible grid fast without a slow page blocking
    # the rest. Proxy/Tor can push harder; direct stays conservative to avoid 429.
    try:
        default = "16" if _network_mode() == "tor" else "12"
        return min(24, max(1, int(os.getenv("EPORNER_ENRICH_CONCURRENCY", default))))
    except ValueError:
        return 12


def _enrich_stagger() -> float:
    # Near-zero stagger for streaming: with as-completed emission and backoff on
    # 429/509 we don't need to hand-space every request; the first cards should
    # land almost immediately.
    try:
        default = "0.03" if _network_mode() == "tor" else "0.06"
        return max(0.0, float(os.getenv("EPORNER_ENRICH_STAGGER", default)))
    except ValueError:
        return 0.06


def _enrich_timeout() -> float:
    try:
        return max(4.0, float(os.getenv("EPORNER_ENRICH_TIMEOUT", "9")))
    except ValueError:
        return 9.0


def _cache_enabled() -> bool:
    return os.getenv("EPORNER_ENRICH_CACHE", "1").strip().lower() not in ("0", "false", "no")


def _load_enrich_cache() -> None:
    global _ENRICH_CACHE_LOADED, _ENRICH_CACHE
    if _ENRICH_CACHE_LOADED:
        return
    with _ENRICH_CACHE_LOCK:
        if _ENRICH_CACHE_LOADED:
            return
        try:
            if _ENRICH_CACHE_PATH.exists():
                data = json.loads(_ENRICH_CACHE_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    _ENRICH_CACHE = data
        except Exception as exc:  # noqa: BLE001
            logger.debug("[Eporner Hub] enrich cache load failed: %s", exc)
            _ENRICH_CACHE = {}
        _ENRICH_CACHE_LOADED = True


def _save_enrich_cache() -> None:
    if not _cache_enabled():
        return
    with _ENRICH_CACHE_LOCK:
        try:
            _ENRICH_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            now = time.time()
            items = [
                (url, row) for url, row in _ENRICH_CACHE.items()
                if now - float(row.get("at") or 0) < _ENRICH_CACHE_TTL
            ]
            items.sort(key=lambda item: float(item[1].get("at") or 0), reverse=True)
            compact = dict(items[:_ENRICH_CACHE_MAX])
            _ENRICH_CACHE.clear()
            _ENRICH_CACHE.update(compact)
            _ENRICH_CACHE_PATH.write_text(json.dumps(compact, ensure_ascii=False), encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            logger.debug("[Eporner Hub] enrich cache save failed: %s", exc)


def _cache_get(url: str) -> Optional[dict]:
    if not _cache_enabled():
        return None
    _load_enrich_cache()
    with _ENRICH_CACHE_LOCK:
        row = _ENRICH_CACHE.get(url)
        if not row:
            return None
        if time.time() - float(row.get("at") or 0) > _ENRICH_CACHE_TTL:
            _ENRICH_CACHE.pop(url, None)
            return None
        data = row.get("data")
        return dict(data) if isinstance(data, dict) else None


def _cache_put_many(results: dict[str, dict]) -> None:
    if not results or not _cache_enabled():
        return
    _load_enrich_cache()
    now = time.time()
    with _ENRICH_CACHE_LOCK:
        for url, data in results.items():
            if data:
                _ENRICH_CACHE[url] = {"at": now, "data": data}
    _save_enrich_cache()


def _tor_new_circuit() -> None:
    """Ask Tor for a fresh exit (NEWNYM) so a rate-limited exit IP is swapped out.
    Best-effort: needs an open/cookie-less control port (ControlPort 9051 with
    no auth, or set EPORNER_TOR_CONTROL_PW). Silently no-ops otherwise."""
    if _network_mode() not in {"auto", "tor"}:
        return
    try:
        from ..tor_service import tor_service
        state = tor_service.new_identity()
        if state.get("last_error"):
            raise RuntimeError(state["last_error"])
        logger.info("[Eporner Hub] requested new Tor circuit")
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Eporner Hub] Tor NEWNYM failed: %s", exc)


# Process-wide throttle so concurrent enrich tasks still space their requests.
# The lock is created lazily so it binds to the running event loop, not the
# (possibly different) loop present at import time.
_last_request_ts = 0.0
_throttle_lock: Optional[asyncio.Lock] = None


async def _throttle() -> None:
    global _last_request_ts, _throttle_lock
    if _throttle_lock is None:
        _throttle_lock = asyncio.Lock()
    async with _throttle_lock:
        gap = _min_gap()
        now = time.monotonic()
        wait = _last_request_ts + gap - now
        if wait > 0:
            await asyncio.sleep(wait + random.uniform(0, 0.6))  # jitter
        _last_request_ts = time.monotonic()


def _force_ipv4() -> bool:
    return os.getenv("EPORNER_FORCE_IPV4", "1").strip().lower() not in ("0", "false", "no")


#: One curl_cffi Session per (thread, ipv4-mode). Sessions are NOT safe for
#: concurrent use and every call below runs inside asyncio.to_thread, so a
#: threading.local beats a shared pool: the owning thread is the only user, no
#: lock is needed, and the TLS handshake is paid once per thread instead of once
#: per request. Two variants because CURLOPT_IPRESOLVE is a session-construction
#: option in curl_cffi (it cannot be passed per request), while the proxy can.
_SESSIONS = threading.local()


def _session(force_ipv4: bool):
    cache: dict = getattr(_SESSIONS, "by_mode", None)
    if cache is None:
        cache = {}
        _SESSIONS.by_mode = cache
    session = cache.get(force_ipv4)
    if session is None:
        kwargs: dict = {"impersonate": "chrome"}
        if force_ipv4:
            from curl_cffi.const import CurlOpt
            kwargs["curl_options"] = {CurlOpt.IPRESOLVE: 1}  # CURL_IPRESOLVE_V4
        session = cr.Session(**kwargs)
        cache[force_ipv4] = session
    return session


def _cget(url: str, *, force_tor: bool = False, **kw):
    """curl_cffi GET with impersonation + the resolved proxy applied.

    Eporner publishes AAAA records; on hosts with a broken/absent IPv6 route
    curl burns the ENTIRE connect timeout on the v6 attempt instead of falling
    back (unlike aiohttp), which made every hub call die with curl error 28.
    Force IPv4 unless a proxy handles resolution (EPORNER_FORCE_IPV4=0 opts out).
    """
    proxies = _proxies(force_tor=force_tor)
    ipv4 = False
    if proxies:
        kw["proxies"] = proxies
    elif _force_ipv4():
        ipv4 = True
    return _session(ipv4).get(url, impersonate="chrome",
                              timeout=kw.pop("timeout", 25), **kw)

# Watch-page download rows look like:  MP4 (2160p, h264, 2744.25 MB)
# The page lists every rendition; the user wants the HIGHEST resolution and,
# within it, the LARGEST file (h264 tends to beat AV1 at equal height).
_DLOAD_RE = re.compile(
    r"MP4 \((\d+)p[^,]*,\s*([A-Za-z0-9]+),\s*([\d.]+)\s*([MG]B)\)",
    re.IGNORECASE,
)

# Unified sort ids (shared across all hubs in the UI) -> Eporner `order` values.
_ORDER = {
    "hottest": "top-weekly",
    "top_rated": "top-rated",
    "most_viewed": "most-popular",
    "recent": "latest",
    "longest": "longest",
    "top_monthly": "top-monthly",
}
_DEFAULT_PER_PAGE = 120
_MAX_PER_PAGE = 300

# A handful of category slugs whose keyword differs from a clean slug->words
# expansion (or where a tighter keyword gives better API results). Everything
# not listed just uses the scraped category NAME as the search keyword.
_CATEGORY_QUERY = {
    "4k-porn": "4k",
    "vr-porn": "vr",
    "pov-porn": "pov",
    "60fps": "60fps",
}

# categories/playlists are scraped once and cached process-wide (slugs + names
# rarely change); TTL keeps them fresh across a long-running server.
_CAT_CACHE: dict[str, Any] = {"at": 0.0, "items": []}
_CAT_TTL = 6 * 3600
_PLAYLIST_META: dict[str, dict[str, Any]] = {}
_ENRICH_CACHE_PATH = Path("data") / "eporner_enrich_cache.json"
_ENRICH_CACHE_TTL = 14 * 24 * 3600
_ENRICH_CACHE_MAX = 5000
_ENRICH_CACHE: dict[str, dict[str, Any]] = {}
_ENRICH_CACHE_LOADED = False
_ENRICH_CACHE_LOCK = RLock()


def _quality_str(h: int) -> str:
    if h >= 2160:
        return "4K"
    if h >= 1440:
        return "1440p"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    return f"{h}p" if h > 0 else ""


def _thumb(video: dict) -> str:
    # The API's default thumb is the same stable image Eporner uses on result
    # pages. Some alternate sizes intermittently render as blank hotlink loads.
    dt = video.get("default_thumb") or {}
    if dt.get("src"):
        return dt["src"]
    thumbs = video.get("thumbs") or []
    if thumbs:
        # Pick the widest <= 480 for crispness without huge payloads.
        best = None
        for t in thumbs:
            w = int(t.get("width") or 0)
            if w and w <= 480 and (best is None or w > int(best.get("width") or 0)):
                best = t
        chosen = best or thumbs[-1]
        if chosen.get("src"):
            return chosen["src"]
    return ""


def _tags(video: dict) -> list[str]:
    raw = video.get("keywords") or ""
    out, seen = [], set()
    for part in raw.split(","):
        t = part.strip()
        low = t.lower()
        if t and low not in seen and len(t) <= 28:
            seen.add(low)
            out.append(t)
        if len(out) >= 24:
            break
    return out


def _dur_to_sec(text: str) -> int:
    parts = [p for p in re.split(r"[:]", (text or "").strip()) if p.isdigit()]
    sec = 0
    for p in parts:
        sec = sec * 60 + int(p)
    return sec


def _height_from_q(q: str) -> int:
    q = (q or "").lower()
    if "4k" in q or "2160" in q:
        return 2160
    m = re.search(r"(\d{3,4})", q)
    return int(m.group(1)) if m else 0


def _per_page() -> int:
    try:
        return min(_MAX_PER_PAGE, max(40, int(os.getenv("EPORNER_PER_PAGE", str(_DEFAULT_PER_PAGE)))))
    except ValueError:
        return _DEFAULT_PER_PAGE


def _num(value: Any) -> float:
    try:
        return float(str(value or "0").replace(",", "").strip() or 0)
    except Exception:
        return 0.0


def _relevance_score(video: dict, query: str) -> float:
    """Score API results locally so multi-word searches feel exact immediately."""
    q = (query or "").strip().lower()
    if not q:
        return 0.0
    terms = [t for t in re.split(r"[^a-z0-9]+", q) if len(t) >= 2]
    title = (video.get("title") or "").lower()
    keywords = (video.get("keywords") or "").lower()
    hay = f"{title} {keywords}"
    score = 0.0
    if q in title:
        score += 90
    if q in keywords:
        score += 55
    if terms:
        title_hits = sum(1 for t in terms if t in title)
        tag_hits = sum(1 for t in terms if t in keywords)
        all_hits = sum(1 for t in terms if t in hay)
        score += title_hits * 28
        score += tag_hits * 18
        score += all_hits * 8
        if all_hits == len(terms):
            score += 45
    score += min(_num(video.get("rate")), 100) * 0.25
    score += min(_num(video.get("views")) / 100000.0, 20)
    score += min(_num(video.get("length_sec")) / 600.0, 8)
    return score


def slugify_name(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s


def _abs(href: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return "https://www.eporner.com" + href
    return href


def _parse_ps_tiles(html: str) -> list[dict]:
    """Parse the video tiles on a pornstar page. These already carry quality +
    duration on the listing, so no enrich is needed for those two."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for mb in soup.select("div.mb[data-id]"):
        a = mb.select_one(".mbcontent a[href*='/video-'], a[href*='/video-']")
        if not a:
            continue
        url = _abs(a.get("href") or "")
        if not url or url in seen:
            continue
        seen.add(url)
        img = mb.select_one("img")
        title = ((img.get("alt") if img else None) or a.get("title") or "").strip()
        thumb = _abs((img.get("data-src") or img.get("src") or "") if img else "")
        if thumb.startswith("data:"):
            thumb = ""
        qel = mb.select_one(".mvhdico span")
        quality = qel.get_text(strip=True) if qel else ""
        dtxt = (mb.select_one(".mbtim").get_text(strip=True) if mb.select_one(".mbtim") else "")
        rate = (mb.select_one(".mbrate").get_text(strip=True) if mb.select_one(".mbrate") else "")
        views = (mb.select_one(".mbvie").get_text(strip=True) if mb.select_one(".mbvie") else "")
        upload_date = _tile_upload_date(mb)
        height = _height_from_q(quality)
        length = _dur_to_sec(dtxt)
        tile = Tile(
            id=str(mb.get("data-id") or ""),
            title=title, url=url, thumb=thumb,
            duration_sec=length, duration=dtxt or secs_to_pretty(length),
            views=views, rating=rate,
            quality=quality, height=height, hd=height >= 720,
            enriched=True,
        ).to_dict()
        if upload_date:
            tile["upload_date"] = upload_date
        out.append(tile)
    return out


def _tile_upload_date(mb) -> str:
    """Read a listing tile's upload date when Eporner exposes one."""
    for el in mb.select("[itemprop='uploadDate'], [datetime], [data-date], [data-upload-date]"):
        value = el.get("content") or el.get("datetime") or el.get("data-date") or el.get("data-upload-date") or el.get_text(" ", strip=True)
        match = re.search(r"\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b", value or "")
        if match:
            return match.group(1).replace("/", "-")
    return ""


def _latest_tile_date(tiles: list[dict]) -> str:
    dates = [str(tile.get("upload_date") or "") for tile in tiles]
    normalized = [date for date in dates if re.match(r"^\d{4}-\d{1,2}-\d{1,2}$", date)]
    if not normalized:
        return ""
    return max(normalized, key=lambda value: tuple(int(part) for part in value.split("-")))


def _parse_categories(html: str) -> list[dict]:
    """Parse Eporner's /categories/ index into {slug, name, thumb}. Skips the
    generic 'all' entry; de-dupes by slug in document order (most-popular first)."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for a in soup.select("a[href*='/cat/']"):
        m = re.search(r"/cat/([a-z0-9\-]+)/", a.get("href") or "")
        if not m:
            continue
        slug = m.group(1)
        if slug in seen or slug == "all":
            continue
        # clean name: prefer the anchor's title, then its <span>, then link text
        span = a.select_one("span")
        name = (a.get("title") or (span.get_text(strip=True) if span else "")
                or a.get_text(strip=True) or slug.replace("-", " ")).strip()
        name = re.sub(r"\s*porn$", "", name, flags=re.I).strip()
        # Eporner sometimes doubles a leading badge token (e.g. "4K4K", "VRVR").
        name = re.sub(r"^(\S+?)\1\b", r"\1", name).strip()
        name = name or slug.replace("-", " ").title()
        img = a.select_one("img")
        thumb = _abs((img.get("data-src") or img.get("src") or "") if img else "")
        if thumb.startswith("data:"):
            thumb = ""
        seen.add(slug)
        out.append({"slug": slug, "name": name, "thumb": thumb})
    return out


def _parse_playlists(html: str) -> list[dict]:
    """Parse a /best-playlists/ page into playlist cards:
    {id, url, title, thumb, count}. The canonical fetch path is /playlist/{id}/,
    so we keep the short id (the profile-prefixed URL 404s empty)."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for mb in soup.select("div.mb"):
        a = mb.select_one("a[href*='/playlist/']")
        if not a:
            continue
        href = a.get("href") or ""
        m = re.search(r"/playlist/([A-Za-z0-9]+)/", href)
        if not m:
            continue
        pid = m.group(1)
        if pid in seen:
            continue
        seen.add(pid)
        img = a.select_one("img")
        title = ((img.get("alt") if img else None) or a.get("title")
                 or a.get_text(strip=True) or "Playlist").strip()
        thumb = _abs((img.get("data-src") or img.get("src") or "") if img else "")
        if thumb.startswith("data:"):
            thumb = ""
        cnt_el = mb.select_one(".mbphoto2_playlistico, .mbphoto2_galleryico")
        try:
            count = int(re.sub(r"[^\d]", "", cnt_el.get_text() if cnt_el else "") or 0)
        except ValueError:
            count = 0
        out.append({
            "id": pid,
            "url": _abs(href),
            "title": title, "thumb": thumb, "count": count,
        })
        _PLAYLIST_META[pid] = {"url": _abs(href), "title": title, "count": count}
    return out


def _tile(video: dict) -> Tile:
    length = int(video.get("length_sec") or 0)
    # API "added" is "YYYY-MM-DD HH:MM:SS"; keep just the date for the card.
    added = (video.get("added") or "").strip().split(" ")[0]
    return Tile(
        id=str(video.get("id") or ""),
        title=(video.get("title") or "").strip(),
        url=video.get("url") or "",
        thumb=_thumb(video),
        preview="",  # eporner API has no per-tile webm preview; player resolves on click
        duration_sec=length,
        duration=video.get("length_min") or secs_to_pretty(length),
        views=str(video.get("views") or ""),
        rating=str(video.get("rate") or ""),
        tags=_tags(video),
        # The API listing carries NO resolution, so there is nothing honest to put
        # here until enrich() reads the watch page's download table. The old value
        # was `hd=length > 0`, i.e. a badge derived from the DURATION — it claimed a
        # resolution the listing never returned, and lit up on every non-empty clip.
        hd=False,
        height=0,
        quality="",
        added=added,
        enriched=True,  # full meta already present
    )


class EpornerHub(HubAdapter):
    source = "eporner"
    label = "Eporner"
    # Duration/tags/views come free from the API listing, but the real available
    # quality + file size live only on the watch page, so the quality/size pass
    # is an opt-in enrich (one page fetch per video, run in parallel).
    needs_enrich = True
    media_hosts = ("eporner.com", "static-ca-cdn.eporner.com", "cdn.eporner.com",
                   "static-eu-cdn.eporner.com")
    stream_referer = "https://www.eporner.com/"
    #: Everything in `_ORDER` is a real API `order` value, plus "relevance", which
    #: search() implements by pulling a broad most-popular pool and ranking it with
    #: `_relevance_score`. "popular" is intentionally absent: the API's equivalent
    #: is most-popular, which "most_viewed" already occupies.
    supported_sorts = ("relevance", "recent", "hottest", "top_rated",
                       "most_viewed", "longest")
    #: The JSON listing returns keywords, added, views and length_sec for every
    #: video — but no resolution anywhere, which is exactly what enrich() is for.
    listing_fields = frozenset({"tags", "date", "views", "duration"})

    def net_status(self) -> dict:
        """Reported to the UI so the user can see whether their IP is protected."""
        network_mode = _network_mode()
        use_tor = network_mode in {"auto", "tor"}
        proxy = _proxy()
        tor = None
        if use_tor:
            from ..tor_service import tor_service
            tor = tor_service.status()
        tor_ready = bool(tor and tor.get("ready"))
        if network_mode == "tor":
            mode = "tor" if tor_ready else "tor-offline"
        elif network_mode == "auto":
            mode = "auto"
        else:
            mode = "proxy" if proxy else "direct"
        return {
            "mode": mode,
            "network_mode": network_mode,
            "protected": tor_ready if network_mode == "tor" else mode == "proxy",
            "fallback_available": bool(network_mode == "auto" and tor_ready),
            "tor": tor,
            "min_gap": _min_gap(),
            "concurrency": _max_concurrency(),
            "enrich_concurrency": _enrich_concurrency(),
            "enrich_stagger": _enrich_stagger(),
            "enrich_timeout": _enrich_timeout(),
            "enrich_cache": _cache_enabled(),
            # never leak full proxy creds; just the scheme/host hint
            "proxy_hint": (proxy.split("://", 1)[0] + "://…") if proxy else None,
        }

    async def _fetch(self, url: str, *, referer: str = "", retries: int = 3) -> tuple[int, str]:
        """Throttled, proxied GET with backoff + Tor-circuit rotation on 429/509.
        Every scrape/API call goes through here so the real IP is never hit in a
        burst and rate-limited exits get swapped out instead of banning us."""
        headers = {"User-Agent": _UA}
        if referer:
            headers["Referer"] = referer
        last_status = 0
        network_mode = _network_mode()
        tor_route = network_mode == "tor"
        for attempt in range(1, retries + 1):
            await _throttle()

            def _do():
                r = _cget(url, headers=headers, cookies=_COOKIES, force_tor=tor_route)
                return r.status_code, r.text

            try:
                status, text = await asyncio.to_thread(_do)
            except Exception:
                if network_mode == "auto" and not tor_route and attempt < retries:
                    from ..tor_service import tor_service
                    state = await asyncio.to_thread(tor_service.start, 45)
                    if state.get("ready"):
                        tor_route = True
                        continue
                raise
            last_status = status
            if status == 200:
                return status, text
            if status in (403, 429, 503, 509) and attempt < retries:
                if network_mode == "auto" and not tor_route:
                    from ..tor_service import tor_service
                    state = await asyncio.to_thread(tor_service.start, 45)
                    if state.get("ready"):
                        tor_route = True
                        continue
                if tor_route:
                    _tor_new_circuit()
                await asyncio.sleep(2.0 * attempt + random.uniform(0, 1.5))
                continue
            return status, text
        return last_status, ""

    async def _api(self, method: str, params: dict) -> dict:
        import json as _json
        params = {**params, "format": "json"}
        url = f"{API}/{method}/?" + urllib.parse.urlencode(params)
        status, text = await self._fetch(url)
        if status != 200:
            raise RuntimeError(f"Eporner API {status}")
        return _json.loads(text)

    async def search(self, query: str, *, sort: str = "", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        cat = (category or "").strip().lower()
        q = (query or "").strip()
        # Pure category browse (no free-text query): scrape Eporner's REAL
        # /cat/{slug}/{page}/ page so the results and their order match the site
        # exactly (its own "latest updates" feed) and infinite scroll works —
        # rather than approximating with a keyword search. When the user ALSO
        # typed a query, fall back to the keyword API (AND of query + category),
        # since /cat/ can't take a search term.
        if cat and not q:
            return await self.category_videos(cat, page=page)

        cat_kw = _CATEGORY_QUERY.get(cat, cat)
        effective = " ".join(t for t in [q, cat_kw] if t).strip()
        use_relevance = bool(q and sort in ("", "relevance"))
        # For relevance, ask Eporner for a broad popular pool and rank it locally.
        # Other sort buttons keep their explicit source ordering.
        order = "most-popular" if use_relevance else _ORDER.get(sort or "recent", "latest")
        params = {
            "query": effective or "all",   # empty query -> browse all
            "per_page": _per_page(),
            "page": max(1, int(page or 1)),
            "thumbsize": "medium",
            "order": order,
            "gay": 0,
            "lq": 1,   # include low-quality too; UI filters by real duration
        }
        data = await self._api("search", params)
        videos = data.get("videos") or []
        if use_relevance:
            videos = sorted(videos, key=lambda v: _relevance_score(v, effective), reverse=True)
        tiles = [_tile(v).to_dict() for v in videos if v.get("url")]
        total = int(data.get("total_count") or 0)
        total_pages = int(data.get("total_pages") or 0)
        cur = int(data.get("page") or page)
        return Page(
            items=tiles,
            page=cur,
            has_more=cur < total_pages,
            total=total,
            took_ms=int(data.get("time_ms") or 0),
            extra={"query": query, "category": category},
        )

    async def category_videos(self, slug: str, *, page: int = 1) -> Page:
        """Scrape a category's videos straight from /cat/{slug}/{page}/ so the
        feed matches Eporner 1:1 (same videos, same 'latest' order) and paginates
        for infinite scroll. Tiles already carry quality + duration."""
        slug = slugify_name(slug)
        base = f"https://www.eporner.com/cat/{slug}"
        url = f"{base}/" if page <= 1 else f"{base}/{page}/"
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"category page {status}")
        tiles = _parse_ps_tiles(html)
        return Page(
            items=tiles, page=page,
            has_more=len(tiles) >= 20,
            extra={"view": "category", "category": slug},
        )

    def _watch_performers(self, html: str) -> list[dict]:
        """The video's own performer(s) from the .video-info-tags block (not the
        related-pornstars sidebar). Drops the generic 'Pornstar' category link."""
        soup = BeautifulSoup(html, "html.parser")
        box = soup.select_one("#video-info-tags, .video-info-tags")
        if not box:
            return []
        out, seen = [], set()
        for a in box.select("a[href*='/pornstar/']"):
            m = re.search(r"/pornstar/([a-z0-9\-]+)", a.get("href") or "")
            name = a.get_text(strip=True)
            if not m or not name or name.lower() == "pornstar":
                continue
            slug = m.group(1)
            if slug in seen:
                continue
            seen.add(slug)
            out.append({"slug": slug, "name": name})
        return out[:4]

    def _watch_categories(self, html: str) -> list[dict]:
        """The video's own categories from the .video-info-tags block
        (li.vit-category), as {slug, name}. Skips the generic 'Pornstar' entry."""
        soup = BeautifulSoup(html, "html.parser")
        box = soup.select_one("#video-info-tags, .video-info-tags")
        if not box:
            return []
        out, seen = [], set()
        for a in box.select("li.vit-category a[href*='/cat/']"):
            m = re.search(r"/cat/([a-z0-9\-]+)/", a.get("href") or "")
            name = a.get_text(strip=True)
            if not m or not name or m.group(1) in ("all", "pornstar"):
                continue
            slug = m.group(1)
            if slug in seen:
                continue
            seen.add(slug)
            out.append({"slug": slug, "name": name})
        return out[:12]

    def _watch_tags(self, html: str) -> list[str]:
        """The video's own tags from the .video-info-tags block (/tag/ links)."""
        soup = BeautifulSoup(html, "html.parser")
        box = soup.select_one("#video-info-tags, .video-info-tags")
        if not box:
            return []
        out, seen = [], set()
        for a in box.select("a[href*='/tag/']"):
            name = a.get_text(strip=True)
            low = name.lower()
            if name and low not in seen and len(name) <= 28:
                seen.add(low)
                out.append(name)
            if len(out) >= 16:
                break
        return out

    def _watch_upload_date(self, html: str) -> str:
        """The video's upload date from the watch page, as 'YYYY-MM-DD'.

        Category/pornstar grid tiles carry no date (only the JSON API does), so
        after a full fetch the card would otherwise show no upload date. Prefer
        the JSON-LD `uploadDate` (reliable, machine-formatted); fall back to the
        visible '#cinfoadded'/'Added:' label."""
        m = re.search(r'"uploadDate"\s*:\s*"(\d{4}-\d{2}-\d{2})', html)
        if m:
            return m.group(1)
        soup = BeautifulSoup(html, "html.parser")
        el = soup.select_one("#cinfoadded, .cinfo-added, [itemprop='uploadDate']")
        if el:
            txt = (el.get("content") or el.get_text(" ", strip=True) or "").strip()
            # "Added: Jul 12, 2026" -> "Jul 12, 2026"
            txt = re.sub(r"(?i)^\s*added\s*:?\s*", "", txt)
            dm = re.search(r"\w{3,9}\s+\d{1,2},\s+\d{4}", txt)
            if dm:
                return dm.group(0)
            if txt:
                return txt
        return ""

    async def _get_html(self, url: str) -> tuple[int, str]:
        return await self._fetch(url)

    async def _fetch_enrich_html(self, url: str, *, retries: int = 2) -> tuple[int, str]:
        """Fast watch-page GET for enrichment.

        Search/category pages still use the conservative shared throttle. Enrich
        uses its own concurrency cap + stagger because each result page is
        independent and users expect the visible top results quickly. If Eporner
        pushes back, this backs off and lets the caller simply miss that tile.
        """
        headers = {"User-Agent": _UA, "Referer": "https://www.eporner.com/"}
        last_status = 0
        network_mode = _network_mode()
        tor_route = network_mode == "tor"
        for attempt in range(1, retries + 1):
            def _do():
                r = _cget(
                    url, headers=headers, cookies=_COOKIES,
                    timeout=_enrich_timeout(), force_tor=tor_route,
                )
                return r.status_code, r.text

            try:
                status, text = await asyncio.to_thread(_do)
            except Exception:
                if network_mode == "auto" and not tor_route and attempt < retries:
                    from ..tor_service import tor_service
                    state = await asyncio.to_thread(tor_service.start, 45)
                    if state.get("ready"):
                        tor_route = True
                        continue
                raise
            last_status = status
            if status == 200:
                return status, text
            if status in (403, 429, 503, 509) and attempt < retries:
                if network_mode == "auto" and not tor_route:
                    from ..tor_service import tor_service
                    state = await asyncio.to_thread(tor_service.start, 45)
                    if state.get("ready"):
                        tor_route = True
                        continue
                if tor_route:
                    _tor_new_circuit()
                await asyncio.sleep(1.6 * attempt + random.uniform(0.4, 1.2))
                continue
            return status, text
        return last_status, ""

    async def pornstar_videos(self, slug: str, *, sort: str = "", page: int = 1) -> Page:
        """Scrape a performer's videos: /pornstar/{slug}/[{order}/][{page}/].
        Listing tiles already carry quality + duration, so the feed's sort/filter/
        min-duration all work immediately without enrich."""
        slug = slugify_name(slug)
        order = _ORDER.get(sort or "", "")
        parts = [f"https://www.eporner.com/pornstar/{slug}"]
        if order:
            parts.append(order)
        if page and page > 1:
            parts.append(str(page))
        url = "/".join(parts) + "/"
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"pornstar page {status}")
        tiles = _parse_ps_tiles(html)
        # canonical name + avatar from the page header
        soup = BeautifulSoup(html, "html.parser")
        name = slug.replace("-", " ").title()
        h1 = soup.select_one("h1")
        if h1 and h1.get_text(strip=True):
            name = re.sub(r"\s+(Porn|Videos).*$", "", h1.get_text(strip=True)).strip() or name
        avatar = ""
        av = soup.select_one(".pornstar-info img, .profileimg img, img.pornstarpic")
        if av:
            avatar = av.get("src") or av.get("data-src") or ""
        return Page(
            items=tiles, page=page, has_more=len(tiles) >= 20,
            extra={"view": "pornstar", "slug": slug, "name": name, "avatar": avatar},
        )

    async def find_pornstar(self, name: str) -> dict:
        """Resolve a typed name to a performer page. Eporner slugs are predictable
        (lowercase, spaces→hyphens); we validate by loading the page and reading
        its header + first tiles."""
        slug = slugify_name(name)
        if not slug:
            return {"found": False}
        status, html = await self._get_html(f"https://www.eporner.com/pornstar/{slug}/")
        if status != 200:
            return {"found": False, "slug": slug}
        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.select_one("h1")
        display = name.title()
        if h1 and h1.get_text(strip=True):
            display = re.sub(r"\s+(Porn|Videos).*$", "", h1.get_text(strip=True)).strip() or display
        tiles = _parse_ps_tiles(html)
        return {
            "found": bool(tiles),
            "slug": slug,
            "name": display,
            "count_hint": len(tiles),
        }

    async def categories(self) -> list[dict]:
        """Live category list scraped from /categories/ (cached). Each item is
        {slug, name, thumb}; the UI renders them as chips and drives browsing via
        search(category=slug)."""
        now = time.monotonic()
        if _CAT_CACHE["items"] and (now - _CAT_CACHE["at"]) < _CAT_TTL:
            return _CAT_CACHE["items"]
        try:
            status, html = await self._get_html("https://www.eporner.com/categories/")
            if status == 200:
                items = _parse_categories(html)
                if items:
                    _CAT_CACHE["items"] = items
                    _CAT_CACHE["at"] = now
                    return items
        except Exception as exc:  # noqa: BLE001
            logger.warning("[Eporner Hub] categories scrape failed: %s", exc)
        return _CAT_CACHE["items"]  # stale-but-usable, or [] on first-ever failure

    async def playlists(self, *, page: int = 1) -> Page:
        """Recently-updated public playlists from /best-playlists/{page}/.
        Cards carry title, thumb and video count; open one with playlist_videos()."""
        page = max(1, int(page or 1))
        path = "https://www.eporner.com/best-playlists/"
        if page > 1:
            path += f"{page}/"
        status, html = await self._get_html(path)
        # Eporner serves usable HTML even on its 404 shell, so accept both.
        if status not in (200, 404):
            raise RuntimeError(f"playlists page {status}")
        items = _parse_playlists(html)
        return Page(
            items=items, page=page,
            has_more=len(items) >= 40,
            extra={"view": "playlists"},
        )

    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:
        """Videos inside the real profile-prefixed playlist page."""
        raw_pid = (pid or "").strip()
        url_match = re.search(r"/playlist/([A-Za-z0-9]+)/", raw_pid)
        clean_pid = url_match.group(1) if url_match else re.sub(r"[^A-Za-z0-9]", "", raw_pid)
        if not clean_pid:
            raise ValueError("empty playlist id")
        meta = _PLAYLIST_META.get(clean_pid) or {}
        canonical = raw_pid if raw_pid.startswith("http") else str(meta.get("url") or "")
        if not canonical:
            raise ValueError("Playlist URL is unknown; open it from playlist search")
        base = canonical.rstrip("/")
        url = f"{base}/" if page <= 1 else f"{base}/{page}/"
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"playlist page {status}")
        soup = BeautifulSoup(html, "html.parser")
        # Four recommendation cards live in #profile_sidebar; only .profilemain
        # contains the native playlist items.
        playlist_scope = soup.select_one(".profilemain")
        tiles = _parse_ps_tiles(str(playlist_scope or ""))
        latest_upload_date = _latest_tile_date(tiles)
        # Playlist pages are ordered newest-first. If the listing tile does not
        # expose its date, resolve only that first video instead of probing the
        # whole playlist.
        if not latest_upload_date and tiles:
            try:
                _, first_video_html = await self._fetch_enrich_html(tiles[0]["url"])
                latest_upload_date = self._watch_upload_date(first_video_html)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[Eporner Hub] playlist latest date unavailable: %s", exc)
        name = str(meta.get("title") or "") or "Playlist"
        total = int(meta.get("count") or 0)
        return Page(
            items=tiles, page=page,
            # A reported total may still include deleted/private entries.
            # Only a full 20-card page is evidence that another page exists.
            has_more=len(tiles) >= 20 and (not total or page * 20 < total),
            total=total or len(tiles),
            extra={
                "view": "playlist", "pid": clean_pid, "name": name, "url": canonical,
                "latest_upload_date": latest_upload_date,
            },
        )

    async def find_playlist(self, ref: str) -> dict:
        """Resolve a pasted playlist URL/id, or keyword-search playlists by title.
        Eporner has a REAL playlist search (/search-playlists/{q}/), so we use it
        and return ALL matches so the UI can offer a pick-list."""
        ref = (ref or "").strip()
        if not ref:
            return {"found": False}
        m = re.search(r"/playlist/([A-Za-z0-9]+)", ref)
        if m:
            _PLAYLIST_META[m.group(1)] = {"url": ref, "title": "", "count": 0}
            return {"found": True, "id": m.group(1), "name": ""}
        # bare id (all alnum, no spaces) -> treat as id directly
        if re.fullmatch(r"[A-Za-z0-9]{6,}", ref):
            return {"found": True, "id": ref, "name": ""}

        # Real keyword search endpoint. Slugify the query the way Eporner does.
        slug = re.sub(r"[^a-z0-9]+", "-", ref.lower()).strip("-")
        if not slug:
            return {"found": False}
        matches: list[dict] = []
        seen: set[str] = set()
        needle = ref.lower()
        for pg in (1, 2):
            url = f"https://www.eporner.com/search-playlists/{slug}/"
            if pg > 1:
                url += f"{pg}/"
            try:
                status, html = await self._get_html(url)
            except Exception:  # noqa: BLE001
                break
            if status not in (200, 404):
                break
            items = _parse_playlists(html)
            if not items:
                break
            for it in items:
                pid = it.get("id")
                title = (it.get("title") or "")
                if not pid or pid in seen:
                    continue
                seen.add(pid)
                tl = title.lower()
                rank = 0 if tl == needle else 1 if tl.startswith(needle) else 2
                matches.append({"id": pid, "name": title, "thumb": it.get("thumb", ""),
                                "count": it.get("count", ""), "_rank": rank})
            if len(items) < 40 or len(matches) >= 60:
                break
        if not matches:
            return {"found": False}
        matches.sort(key=lambda x: x.pop("_rank"))
        best = matches[0]
        return {"found": True, "id": best["id"], "name": best["name"], "matches": matches}

    def _best_download(self, html: str) -> Optional[dict]:
        """Highest resolution + its largest file size, parsed from the watch page,
        plus the video's performer(s), categories and tags."""
        best = None  # (height, size_mb, codec)
        for h, codec, size, unit in _DLOAD_RE.findall(html):
            height = int(h)
            mb = float(size) * (1024 if unit.upper() == "GB" else 1)
            if best is None or height > best[0] or (height == best[0] and mb > best[1]):
                best = (height, mb, codec.lower())
        performers = self._watch_performers(html)
        categories = self._watch_categories(html)
        vtags = self._watch_tags(html)
        upload_date = self._watch_upload_date(html)
        if not best:
            # still return meta if we found any (quality table missing)
            if performers or categories or vtags or upload_date:
                return {"performers": performers, "categories": categories,
                        "video_tags": vtags, "upload_date": upload_date}
            return None
        height, mb, codec = best
        return {
            "height": height,
            "quality": _quality_str(height),
            "size_mb": round(mb, 1),
            # Eporner prints the real file size next to each rendition, so this is
            # a measured value — not a bitrate × duration guess.
            "size_estimated": False,
            "codec": codec,
            "performers": performers,
            "categories": categories,
            "video_tags": vtags,
            "upload_date": upload_date,
        }

    async def enrich(self, urls: list[str], concurrency: Optional[int] = None) -> dict[str, dict]:
        """
        url -> {height, quality, size_mb, codec, performers}. Fetches each watch
        page and reads the download table + performer(s). Results are cached so
        repeated searches do not re-fetch the same watch pages. Uncached pages
        use a faster, staggered concurrency cap with backoff on rate limits.
        """
        ordered_urls: list[str] = []
        seen: set[str] = set()
        for u in urls or []:
            if u and u not in seen:
                seen.add(u)
                ordered_urls.append(u)

        results: dict[str, dict] = {}
        uncached: list[str] = []
        for u in ordered_urls:
            cached = _cache_get(u)
            if cached:
                results[u] = cached
            else:
                uncached.append(u)

        if not uncached:
            return results

        sem = asyncio.Semaphore(concurrency or _enrich_concurrency())
        stagger = _enrich_stagger()

        async def _one(idx: int, u: str) -> tuple[str, Optional[dict]]:
            if "eporner.com" not in u:
                return u, None
            if stagger:
                await asyncio.sleep((idx % max(1, concurrency or _enrich_concurrency())) * stagger)
            async with sem:
                try:
                    status, html = await self._fetch_enrich_html(u)
                    return u, (self._best_download(html) if status == 200 else None)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("[Eporner Hub] enrich failed %s: %s", u, exc)
                    return u, None

        pairs = await asyncio.gather(*[_one(i, u) for i, u in enumerate(uncached)])
        fresh = {u: d for u, d in pairs if d}
        _cache_put_many(fresh)
        results.update(fresh)
        return results

    async def enrich_stream(self, urls: list[str], concurrency: Optional[int] = None):
        """Streaming enrich: yields (url, data|None) the INSTANT each watch page
        resolves — not batched, not gather-at-end. Cached tiles are emitted first
        (zero round-trip), then uncached pages complete-as-they-finish so the UI
        fills the fastest cards immediately instead of waiting for a slow one to
        drag a whole chunk. Fresh results are persisted to the cache as they land.
        """
        ordered_urls: list[str] = []
        seen: set[str] = set()
        for u in urls or []:
            if u and u not in seen:
                seen.add(u)
                ordered_urls.append(u)

        uncached: list[str] = []
        for u in ordered_urls:
            cached = _cache_get(u)
            if cached:
                yield u, cached          # instant: no fetch
            else:
                uncached.append(u)

        if not uncached:
            return

        conc = concurrency or _enrich_concurrency()
        sem = asyncio.Semaphore(conc)
        stagger = _enrich_stagger()
        fresh: dict[str, dict] = {}

        async def _one(idx: int, u: str) -> tuple[str, Optional[dict]]:
            if "eporner.com" not in u:
                return u, None
            if stagger:
                await asyncio.sleep((idx % max(1, conc)) * stagger)
            async with sem:
                try:
                    status, html = await self._fetch_enrich_html(u)
                    return u, (self._best_download(html) if status == 200 else None)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("[Eporner Hub] enrich failed %s: %s", u, exc)
                    return u, None

        tasks = [asyncio.create_task(_one(i, u)) for i, u in enumerate(uncached)]
        try:
            for coro in asyncio.as_completed(tasks):
                u, d = await coro
                if d:
                    fresh[u] = d
                yield u, d               # emit as soon as this page finishes
        finally:
            if fresh:
                _cache_put_many(fresh)

    async def related(self, url: str) -> Page:
        """Related videos via the video's OWN tags (from its watch page) fed back
        into the keyword search, so the rail stays on-topic. Falls back to the
        title slug when the tag block is missing."""
        from .base import keywords_from_title
        status, html = await self._get_html(url)
        query = ""
        if status == 200:
            tags = self._watch_tags(html)
            query = " ".join(tags[:4])
        if not query:
            slug = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
            query = keywords_from_title(slug.replace("-", " "))
        if not query:
            return Page(items=[], has_more=False)
        page = await self.search(query, sort="relevance", page=1)
        current = url.rstrip("/")
        page.items = [it for it in page.items if it.get("url", "").rstrip("/") != current][:36]
        page.extra["related_mode"] = "same-source-tags"
        return page

    async def resolve(self, url: str) -> dict:
        if "eporner.com" not in url:
            raise ValueError("Not an Eporner URL")
        from ..extractors.eporner import EpornerExtractor
        res = await EpornerExtractor().extract(url)
        if not res or not res.get("stream_url"):
            raise RuntimeError("Could not resolve an Eporner stream")
        return {
            "stream_url": res["stream_url"],
            "is_hls": bool(res.get("is_hls")),
            "title": res.get("title", ""),
            "duration": res.get("duration", 0),
            "thumbnail": res.get("thumbnail", ""),
        }

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do():
            r = _cget(url, headers={"User-Agent": _UA, "Referer": "https://www.eporner.com/"},
                      cookies=_COOKIES)
            return r.content, r.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)
