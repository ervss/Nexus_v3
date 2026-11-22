"""RedTube adapter for the unified Fusion Hub.

RedTube is not a KVS gallery-engine site. The existing
`app.extractors.redtube.RedTubeExtractor` already owns a robust async `extract()`
(yt-dlp first, HTML/JSON-LD fallback, `/media/mp4|hls` resolution, HEAD size probe),
so `resolve` and `enrich` are wired straight to it.

Listing
-------
A browser capture (2026-07-16) of `/?search=kiss` found every candidate card class at
count 0 behind a `cookie_consent_wrapper` interstitial, so RedTube's card classes are
NOT known. Rather than guess them, the parser anchors on the two facts that capture DID
verify:

  * watch URLs are bare numeric paths — `redtube.com/{digits}`
  * search paging is `?search={query}&page={n}`

so tiles are found by matching numeric watch anchors and walking up to the nearest
container holding an <img>. That is class-agnostic and survives a redesign.

The consent interstitial is a client-side overlay; a server-side fetch usually receives
the real listing anyway, and `age_verified=1` (the same cookie the Eporner adapter
sends) is included to skip the age wall. If the gate IS served, `_parse_tiles` detects
the wrapper and raises instead of silently returning an empty page.

Live-verified 2026-07-16: the consent cookie IS sufficient — feed, search, categories
and resolve all read fine server-side, and the class-agnostic parser finds real tiles.
Category browse is `/redtube/{slug}` (`?page={n}`); `/categories` is only the index that
lists them.
"""
from __future__ import annotations

import asyncio
import re
import threading
import urllib.parse
from typing import Any

from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty
from .kvs import ENRICH_MAX

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_ORIGIN = "https://www.redtube.com"
# Same age cookie the Eporner adapter relies on; harmless if RedTube ignores it.
_COOKIES = {"age_verified": "1"}
# Verified watch shape: https://www.redtube.com/103102861
_WATCH_RE = re.compile(r"^(?:https?://(?:www\.)?redtube\.com)?/(\d{4,})/?$", re.I)
# Verified from the browser capture's sampleHTML.
_GATE_RE = re.compile(r"cookie_consent_wrapper|age[_-]?disclaimer", re.I)

# Live-verified 2026-07-25. RedTube sorts a listing by its PATH, and a category
# by a `?sorting=` query — the two vocabularies do not overlap.
_BROWSE_PATH = {
    "recent": "/newest",
    "hottest": "/hot",
    "top_rated": "/top",
    "most_viewed": "/mostviewed",
    "longest": "/longest",
}
_CATEGORY_SORTING = {
    "recent": "newest",
    "hottest": "",           # = the category's own default (featured) order
    "top_rated": "rating",
    "most_viewed": "mostviewed",
    "longest": "longest",
}
#: Sort paths that KEEP a `?search=` term. /top, /mostviewed and /hot answer a
#: search URL with a 302 to their unfiltered selves, so routing a query there
#: would quietly return results for a completely different set of videos —
#: worse than not sorting. Those degrade to /newest, which at least answers the
#: question the user asked.
_SEARCH_PATH = {"recent": "/newest", "longest": "/longest"}
#: Cards per listing page, measured across feed/search/category (RedTube pads a
#: page with promoted tiles, so this is the floor, not an exact count).
_PAGE_SIZE = 24


def _duration_from_text(text: str) -> int:
    m = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?", text or "")
    if not m:
        return 0
    if m.group(3) is not None:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return int(m.group(1)) * 60 + int(m.group(2))


def _height_from_quality(quality: str) -> int:
    q = (quality or "").lower().strip()
    if "4k" in q or "2160" in q:
        return 2160
    for h in (1440, 1080, 720, 480, 360, 240):
        if str(h) in q:
            return h
    return 0


class RedTubeHub(HubAdapter):
    source = "redtube"
    label = "RedTube"
    needs_enrich = True
    media_hosts = ("redtube.com", "rdtcdn.com", "phncdn.com")
    stream_referer = "https://www.redtube.com/"
    #: All five are real listings in the feed and (bar "hottest") real `?sorting=`
    #: values on a category. With a free-text query only recent/longest survive —
    #: see `_SEARCH_PATH` for why the rest are not routed to their sort path.
    supported_sorts = ("recent", "hottest", "top_rated", "most_viewed", "longest")
    #: A RedTube card holds a duration and an HD word-badge and nothing else — no
    #: view count, no date, no resolution, no hover preview.
    listing_fields = frozenset({"duration"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self.cache_seconds = 45
        # One curl_cffi Session per thread instead of a pool: Sessions are not safe
        # for concurrent use, and each request already runs alone inside its own
        # asyncio.to_thread worker — so no lock, and one TLS handshake per thread.
        self._local = threading.local()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    @staticmethod
    def _extractor():
        from ..extractors.redtube import RedTubeExtractor
        return RedTubeExtractor()

    async def _get_html(self, url: str) -> tuple[int, str]:
        def _do() -> tuple[int, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                cookies=_COOKIES, impersonate="chrome", timeout=20,
                allow_redirects=True)
            return response.status_code, response.text
        return await asyncio.to_thread(_do)

    def _list_url(self, query: str, page: int, category: str = "", sort: str = "recent") -> str:
        """Listing URL for one (query|category|feed) × sort × page.

        Live-verified 2026-07-25 — the three modes take the sort three ways:
          * feed     `/newest|/hot|/top|/mostviewed|/longest` (+ `?page={n}`)
          * search   `/newest|/longest` + `?search={q}` (+ `&page={n}`)
          * category `/redtube/{slug}` + `?sorting={…}` (+ `&page={n}`)
        Out-of-range pages 404, which `search()` surfaces as an error rather than
        as an endless supply of empty pages.
        """
        page = max(1, int(page or 1))
        query = (query or "").strip()
        category = (category or "").strip()
        sort = (sort or "recent").strip().lower()

        if category:
            base = f"{_ORIGIN}/redtube/{urllib.parse.quote(category)}"
            sorting = _CATEGORY_SORTING.get(sort, "newest")
            if sorting:
                base = f"{base}?sorting={sorting}"
        elif query:
            base = (f"{_ORIGIN}{_SEARCH_PATH.get(sort, '/newest')}"
                    f"?search={urllib.parse.quote_plus(query)}")
        else:
            base = _ORIGIN + _BROWSE_PATH.get(sort, "/newest")
        if page <= 1:
            return base
        return base + ("&" if "?" in base else "?") + f"page={page}"

    def _parse_tiles(self, html: str) -> list[dict]:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=True):
            match = _WATCH_RE.match((anchor.get("href") or "").strip())
            if not match:
                continue
            video_id = match.group(1)
            url = f"{_ORIGIN}/{video_id}"
            if url in seen:
                continue

            # Card classes are unknown — climb to the nearest ANCESTOR holding the
            # thumbnail, which is what every tube card looks like regardless of naming.
            # Start above the anchor: the <img> often lives inside it, while duration
            # and badges sit beside it, so the anchor alone is not the card.
            card = None
            node = anchor.parent
            for _ in range(4):
                if node is None or node.name in ("body", "html"):
                    break
                if node.find("img"):
                    card = node
                    break
                node = node.parent
            if card is None and anchor.find("img"):
                card = anchor  # bare <a><img></a> with no wrapper
            if card is None:
                continue  # nav/footer link, not a video card
            image = card.find("img")
            if image is None:
                continue
            seen.add(url)

            thumb = (image.get("data-src") or image.get("data-original")
                     or image.get("src") or "").strip()
            if thumb.startswith("data:"):
                thumb = (image.get("data-thumb_url") or "").strip()

            title = (anchor.get("title") or "").strip()
            if not title:
                title = (image.get("alt") or "").strip()
            if not title:
                title = (anchor.get_text(" ", strip=True) or "").strip()
            if not title:
                title = "RedTube video"

            card_text = card.get_text(" ", strip=True)
            duration_sec = _duration_from_text(card_text)
            height = 0
            if re.search(r"\b4k|2160\b", card_text, re.I):
                height = 2160
            hd = bool(re.search(r"\bHD\b", card_text)) or height >= 720

            items.append(Tile(
                id=video_id,
                title=title,
                url=url,
                thumb=thumb,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                quality=("4K" if height >= 2160 else ""),
                height=height,
                hd=hd,
            ).to_dict())

        if not items and _GATE_RE.search(html or ""):
            # Fail loudly: an empty grid would look like "no results" instead of a block.
            raise RuntimeError(
                "RedTube vrátil cookie/age gate namiesto výsledkov — listing sa nedá "
                "prečítať bez consent cookies."
            )
        return items

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        import time

        page = max(1, int(page or 1))
        url = self._list_url(query.strip(), page, category.strip(), sort=(sort or "recent").strip())
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"RedTube HTTP {status}")
        items = self._parse_tiles(html)
        # A link to page+1 in the pager is the only positive proof there IS one;
        # a full page is the fallback for the sorted category listings, which ship
        # no pager markup at all. `bool(items)` alone paged into the void forever.
        next_link = re.search(rf'href="[^"]*[?&]page={page + 1}\b', html or "")
        result = Page(items=items, page=page,
                      has_more=bool(items) and bool(next_link or len(items) >= _PAGE_SIZE),
                      took_ms=int((time.perf_counter() - started) * 1000),
                      extra={"source": self.source, "page_url": url})
        self._page_cache[url] = (time.monotonic(), result)
        return result

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """Live-verified 2026-07-16: /categories -> 77 `/redtube/{slug}` anchors.

        The anchor's `aria-label` is the clean display name; its text is empty because
        the label sits on the <img> alt. Unlike the listing (whose card classes the
        original capture never saw past the cookie gate), this page reads fine
        server-side, so the href shape alone is enough.
        """
        status, html = await self._get_html(f"{_ORIGIN}/categories")
        if status != 200:
            return []
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        for anchor in soup.select('a[href^="/redtube/"]'):
            slug = (anchor.get("href") or "").split("/redtube/")[-1].split("?")[0].strip("/")
            if not slug or "/" in slug:
                continue
            image = anchor.find("img")
            name = (anchor.get("aria-label") or (image.get("alt") if image else "")
                    or anchor.get_text(" ", strip=True))
            rows.append((slug, name))
        return rows

    async def related(self, url: str) -> Page:
        """Related videos parsed off the watch page (same tube card markup)."""
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._parse_tiles(html) if it.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False, extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        data = await self._extractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("RedTube: stream sa nepodarilo získať")
        return {
            "stream_url": data["stream_url"],
            "is_hls": bool(data.get("is_hls")),
            "title": data.get("title") or "RedTube video",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        if not urls:
            return {}
        ex = self._extractor()
        sem = asyncio.Semaphore(4)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    data = await ex.extract(url)
                except Exception:
                    return url, {}
            if not data:
                return url, {}
            height = int(data.get("height") or 0) or _height_from_quality(data.get("quality", ""))
            size_bytes = int(data.get("size_bytes") or 0)
            tags = data.get("tags") or []
            return url, {
                "quality": data.get("quality") or ("4K" if height >= 2160 else (f"{height}p" if height else "")),
                "height": height,
                "size_mb": round(size_bytes / 1048576, 1) if size_bytes else None,
                # The extractor takes yt-dlp's `filesize` or HEADs the mp4 itself;
                # nothing here is derived from a bitrate.
                "size_estimated": False,
                "duration_sec": int(data.get("duration") or 0),
                "tags": tags if isinstance(tags, list) else [],
                "added": data.get("upload_date") or "",
            }

        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: meta for url, meta in results if meta}

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            response = self._session().get(
                url, headers={"Referer": self.stream_referer},
                impersonate="chrome", timeout=25)
            return response.content, response.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)
