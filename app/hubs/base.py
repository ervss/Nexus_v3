"""
Nexus Hub Framework — base adapter contract.

A "Hub" is a fast, in-dashboard discovery surface for one source (Eporner,
Camwhores, XVideos, …). Every source is just an adapter implementing this
contract; the single router (app/routers/hub.py) and the single frontend
component drive all of them. Adding a source = writing one adapter.

Design goals distilled from the PornHub Hub (which the user likes for being
"live and fast"):

  * Uniform tile shape  -> one frontend renders every source.
  * Full meta as early as possible. If the source has an API that returns
    duration/tags/thumbs in the listing (Eporner does), `search`/`browse`
    already fill them and `needs_enrich` is False — no second round-trip.
  * `enrich` is the optional heavy pass (real quality + file size) for sources
    whose listing is meta-poor; run in parallel with a semaphore.
  * `resolve` JIT-turns a watch URL into a playable stream for the in-hub player.
  * `media` proxies hot-link-protected thumbs/previews with the right Referer.
"""
from __future__ import annotations

import abc
import asyncio
from collections import OrderedDict
import re
import threading
import time
from copy import copy
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Optional

#: A node holding only this is a video-count badge, not part of the category name.
_COUNT_RE = re.compile(r"^[\d][\d\s,.]*[KMkm]?$")


@dataclass
class Tile:
    """One uniform discovery tile. Extra/source-specific data goes in `extra`."""
    id: str
    title: str
    url: str
    thumb: str = ""
    preview: str = ""            # webm/mp4 hover preview URL (optional)
    duration_sec: int = 0
    duration: str = ""           # pretty "12:34"
    views: str = ""
    rating: str = ""             # 0..5 or percent, source-defined
    uploader: str = ""
    uploader_url: str = ""
    tags: list[str] = field(default_factory=list)
    quality: str = ""            # "1080p" etc. (may be filled by enrich)
    height: int = 0
    size_mb: Optional[float] = None
    hd: bool = False
    added: str = ""              # upload date, source-formatted (e.g. "2026-06-29")
    enriched: bool = False
    #: >1 marks this tile as a folder/album card (e.g. turbo.cr): `thumb` is
    #: the first video's thumbnail and `thumbs` holds up to 4 for a 2x2
    #: montage. Default 1 keeps every single-video source's tiles unchanged.
    item_count: int = 1
    thumbs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Page:
    """A page of tiles plus paging metadata the frontend uses for infinite scroll."""
    items: list[dict]
    page: int = 1
    has_more: bool = True
    total: Optional[int] = None
    took_ms: Optional[int] = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("extra", None)
        d.update(self.extra)
        return d


#: words too generic to help a "related" search — dropped from title-derived queries.
_QUERY_STOPWORDS = frozenset((
    "the", "and", "with", "from", "this", "that", "for", "her", "his", "she", "him",
    "xxx", "porn", "video", "videos", "free", "you", "your", "are", "was", "get",
    "big", "hot", "new", "full", "part", "scene",
))


def keywords_from_title(title: str, limit: int = 5) -> str:
    """A short search query distilled from a video title (for title-based `related`).

    Lower-cases, keeps the first `limit` distinct meaningful words (>2 chars, not a
    stopword). Used by sources whose listing parser can't be reused on a watch page,
    so "related" becomes a same-source keyword search instead of an empty rail.
    """
    words = re.findall(r"[a-z0-9]+", (title or "").lower())
    picked = [w for w in dict.fromkeys(words) if len(w) > 2 and w not in _QUERY_STOPWORDS]
    return " ".join(picked[:limit])


def secs_to_pretty(sec: int) -> str:
    sec = int(sec or 0)
    if sec <= 0:
        return ""
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def iso_duration_to_secs(value: str) -> int:
    """ISO-8601 'PT43M40S' -> 2620. Every source's ld+json VideoObject uses this."""
    match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?",
                         (value or "").strip(), re.I)
    if not match:
        return 0
    return int(int(match.group(1) or 0) * 3600
               + int(match.group(2) or 0) * 60
               + float(match.group(3) or 0))


def label_without_count(anchor) -> str:
    """A category anchor's text minus its video-count badge.

    Sources hang the count in a sibling node next to the name
    (`<a><span>Onlyfans</span><b>15040</b></a>`), so a plain get_text() yields
    "Onlyfans 15040". Any child whose ENTIRE text is a number is that badge — keying on
    structure rather than a trailing-digits regex leaves names that legitimately end in
    a numeral ("1 on 1") intact. Works on a copy so the caller's soup is untouched.
    """
    node = copy(anchor)
    for child in node.find_all(True):
        if _COUNT_RE.match(child.get_text(" ", strip=True) or ""):
            child.extract()
    return node.get_text(" ", strip=True)


def dedupe_categories(rows: Iterable[tuple[str, str]], limit: int = 120) -> list[dict]:
    """(slug, name) pairs -> deduped [{slug, name}], first occurrence wins.

    Sources list a category many times over (nav dropdown + grid + footer), and some
    hand back a bare slug with no label, so a missing/absurd name falls back to the
    prettified slug rather than dropping the row.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for slug, name in rows:
        slug = (slug or "").strip().strip("/").lower()
        if not slug or slug in seen:
            continue
        name = " ".join((name or "").split())
        if not 1 < len(name) < 50:
            name = slug.replace("-", " ").title()
        seen.add(slug)
        out.append({"slug": slug, "name": name})
        if len(out) >= limit:
            break
    return out


class HubAdapter(abc.ABC):
    """One source. Subclasses fill the surfaces they support."""

    #: url-safe id used in /hub/{source}/… routes, e.g. "eporner"
    source: str = ""
    #: human label for the UI
    label: str = ""
    #: True if the listing is meta-poor and needs the enrich() pass for
    #: quality/size. Eporner returns everything up front -> False.
    needs_enrich: bool = True
    #: hostnames whose media the /hub/{source}/media proxy is allowed to fetch
    media_hosts: tuple[str, ...] = ()
    #: Sort ids this adapter genuinely honours. The UI renders exactly these
    #: buttons, so listing a sort the search() ignores is a lie the user pays
    #: for: they click "top rated", wait out a full round-trip, and get the same
    #: newest-first page back with no way to tell it never applied. Valid ids:
    #: recent relevance popular hottest top_rated most_viewed longest.
    #: The default is the one thing every adapter can do.
    supported_sorts: tuple[str, ...] = ("recent",)
    #: What the LISTING (not enrich) can be trusted to carry, out of:
    #: tags date height preview views duration. Drives both the relevance gate
    #: and the frontend's badges — a tile whose height is unknown must not be
    #: filtered as if it were SD, and a source with no listing `tags` must not
    #: be judged against one that has them. Empty = the listing gives titles and
    #: thumbs and nothing else may be assumed.
    listing_fields: frozenset[str] = frozenset()
    #: categories() cache: (monotonic_ts, rows). Class-level default; instances rebind
    #: it, never mutate it, so subclasses can't leak rows into each other.
    _categories_cache: tuple[float, list[dict]] = (0.0, [])
    _categories_ttl: float = 1800.0

    @abc.abstractmethod
    async def search(self, query: str, *, sort: str = "", page: int = 1,
                     **filters: Any) -> Page:
        ...

    async def browse(self, *, sort: str = "", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        """Default browse = empty-query search; override if the source differs."""
        return await self.search("", sort=sort, page=page, category=category, **filters)

    async def categories(self) -> list[dict]:
        """Category chips, cached. Adapters supply rows via `_fetch_categories()`.

        A source with no category taxonomy at all (NoodleMagazine) legitimately keeps
        the default and returns []. On a fetch error the last good rows are served
        rather than blanking the chips over one bad request.
        """
        ts, cached = self._categories_cache
        if cached and time.monotonic() - ts < self._categories_ttl:
            return cached
        try:
            rows = await self._fetch_categories()
        except Exception:  # noqa: BLE001
            return cached or []
        out = dedupe_categories(rows)
        if out:
            self._categories_cache = (time.monotonic(), out)
        return out or cached or []

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """(slug, name) pairs from the source's category index. [] = no taxonomy."""
        return []

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        """url -> {quality,height,size_mb,tags,duration_sec}. No-op by default."""
        return {}

    async def resolve(self, url: str) -> dict:
        """Watch URL -> {stream_url,is_hls,title,duration,thumbnail}."""
        raise NotImplementedError(f"{self.source} has no resolve()")

    async def related(self, url: str) -> Page:
        return Page(items=[], has_more=False)

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        """Default referer-aware media proxy using Chrome TLS impersonation."""
        referer = getattr(self, "stream_referer", "") or ""
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        }
        if referer:
            headers["Referer"] = referer

        def _do() -> tuple[bytes, str]:
            from curl_cffi import requests as cr
            resp = cr.get(
                url,
                headers=headers,
                impersonate="chrome",
                timeout=15,
                allow_redirects=True,
            )
            if resp.status_code >= 400 or not resp.content:
                return b"", "application/octet-stream"
            return resp.content, resp.headers.get("content-type", "image/jpeg")

        return await asyncio.to_thread(_do)


_MEDIA_CACHE_MAX = 300
_MEDIA_CACHE_TTL = 300.0
_MEDIA_CACHE_MAX_BYTES = 2 * 1024 * 1024
_MEDIA_CACHE: OrderedDict[str, tuple[float, bytes, str]] = OrderedDict()
_MEDIA_CACHE_LOCK = threading.Lock()


def media_cache_get(key: str) -> Optional[tuple[bytes, str]]:
    now = time.monotonic()
    with _MEDIA_CACHE_LOCK:
        entry = _MEDIA_CACHE.get(key)
        if not entry:
            return None
        ts, content, ctype = entry
        if now - ts > _MEDIA_CACHE_TTL:
            _MEDIA_CACHE.pop(key, None)
            return None
        _MEDIA_CACHE.move_to_end(key)
        return content, ctype


def media_cache_put(key: str, content: bytes, ctype: str) -> None:
    if not content or len(content) > _MEDIA_CACHE_MAX_BYTES:
        return
    with _MEDIA_CACHE_LOCK:
        _MEDIA_CACHE[key] = (time.monotonic(), content, ctype)
        _MEDIA_CACHE.move_to_end(key)
        while len(_MEDIA_CACHE) > _MEDIA_CACHE_MAX:
            _MEDIA_CACHE.popitem(last=False)


async def http_get_text(
    url: str,
    *,
    referer: str = "",
    timeout: float = 20.0,
) -> tuple[int, str]:
    """Fetch HTML/text via curl_cffi (Chrome TLS) with httpx fallback."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
    }
    if referer:
        headers["Referer"] = referer

    def _cf() -> tuple[int, str]:
        from curl_cffi import requests as cr
        resp = cr.get(
            url,
            headers=headers,
            impersonate="chrome",
            timeout=timeout,
            allow_redirects=True,
        )
        return resp.status_code, resp.text

    try:
        return await asyncio.to_thread(_cf)
    except Exception:
        import httpx
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), follow_redirects=True) as client:
            resp = await client.get(url, headers=headers)
            return resp.status_code, resp.text
