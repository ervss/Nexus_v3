"""xHamster adapter for the unified Fusion Hub.

Not a KVS site, so this is a standalone HubAdapter.

Live-verified facts (re-captured 2026-07-25):
  * search URL is `/search/{query}`, pagination is `?page={n}`  (NOT `?p=`)
  * browse and category listings page as a trailing PATH segment instead —
    `/newest/2`, `/categories/teen/2`. `?page=` there answers 200 and re-serves
    page 1, so the query form looks like it works and silently never advances.
  * the listing is JSON-driven: `window.initials.<root>.videoThumbProps` is one
    object per card (46 of 46) carrying `id`, `title`, `pageURL`, `thumbURL`,
    `duration` (seconds), `created` (unix ts) and `views`; `<root>` is
    `searchResult`, `layoutPage.videoListProps` or
    `pagesCategoryComponent.trendingVideoListProps` depending on the surface
  * only the FIRST ~8 cards are server-rendered as real HTML. The rest ship as
    skeleton placeholders — no `<img>`, no title, no duration — and are hydrated
    client-side from that JSON.
  * watch page has no usable `<source>` tags and no ld+json — the stream lives in
    `window.initials` (hex-scrambled), which is exactly what yt-dlp already decodes

The listing is therefore parsed from the JSON, not the DOM: scraping `.video-thumb`
nodes yielded 7 usable tiles out of 46, the rest arriving as empty placeholders with a
slug-derived title. The DOM walk is kept only as a fallback for the day the JSON shape
moves. Card classes are hashed/CSS-in-JS (`container-c9dbd thumb-list__item
video-thumb`), so that fallback matches the stable `video-thumb` token alone.

`resolve` reuses the existing `XHamsterExtractor` rather than re-implementing the
`initials` stream decode.
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import re
import threading
import urllib.parse
from typing import Any

from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty
from .kvs import ENRICH_MAX

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_ORIGIN = "https://xhamster.com"
#: A full xHamster listing page is 46 cards (`initials.perPage`), on every surface.
_PAGE_SIZE = 46

# Live-verified 2026-07-25. xHamster expresses order THREE different ways and
# rejects a wrong value with a 404, so each listing kind needs its own map.
#
#   search  -> `?sort=` , values straight out of `initials.filters.sortSelectorProps`
#              ("relevance" | "newest" | "views" | "best" | "longest")
#   browse  -> a dedicated landing path; `?sort=` is not a thing there
#   category-> a path SEGMENT appended to /categories/{slug}
#
# `longest` exists only in search and `hottest` (= /best/weekly) only in browse,
# so neither is declared in `supported_sorts` — a button that works in one mode
# and silently does nothing in another is exactly the fake button we're removing.
# They stay mapped so an explicitly requested sort still lands somewhere real.
_SEARCH_SORT = {
    "relevance": "",
    "recent": "newest",
    "most_viewed": "views",
    "top_rated": "best",
    "hottest": "best",
    "longest": "longest",
}
_BROWSE_PATH = {
    "relevance": "/newest",
    "recent": "/newest",
    "most_viewed": "/most-viewed",
    "top_rated": "/best",
    "hottest": "/best/weekly",
    "longest": "/newest",
}
_CATEGORY_SEGMENT = {
    "relevance": "",
    "recent": "newest",
    "most_viewed": "most-viewed",
    "top_rated": "best",
    "hottest": "best",
    "longest": "",
}


def _duration_from_text(text: str) -> int:
    m = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?", text or "")
    if not m:
        return 0
    if m.group(3) is not None:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return int(m.group(1)) * 60 + int(m.group(2))


class XHamsterHub(HubAdapter):
    source = "xhamster"
    label = "xHamster"
    needs_enrich = True  # listing shows an HD badge at most; real height needs the watch page
    # Size is bitrate-derived and costs a yt-dlp resolve per video -> opt-in only.
    supports_deep_enrich = True
    media_hosts = ("xhamster.com", "xhcdn.com", "xhamster-cdn.com")
    stream_referer = "https://xhamster.com/"
    #: See `_SEARCH_SORT` / `_BROWSE_PATH` / `_CATEGORY_SEGMENT` — only these four
    #: resolve to a real, differently-ordered listing in ALL THREE listing modes.
    supported_sorts = ("relevance", "recent", "top_rated", "most_viewed")
    #: The listing JSON gives duration, created (date) and a trailer URL for every
    #: card. `views` is in the shape but only populated on a handful of search
    #: hits (0 of 46 on /newest), and `isUHD` is a 4K flag rather than a height —
    #: neither is dependable enough to claim, so both wait for enrich().
    listing_fields = frozenset({"duration", "date", "preview"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self.cache_seconds = 45
        # One curl_cffi Session per thread rather than a shared pool: Sessions are
        # not safe for concurrent use and every request here runs inside
        # asyncio.to_thread, so the owning thread is the only user and no lock is
        # needed — while an enrich pass stops paying 24 TLS handshakes for 24 pages.
        self._local = threading.local()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            # Cloudflare-fronted: TLS impersonation is what gets past the edge.
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    async def _get_html(self, url: str) -> tuple[int, str]:
        def _do() -> tuple[int, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                impersonate="chrome", timeout=20, allow_redirects=True)
            return response.status_code, response.text
        return await asyncio.to_thread(_do)

    def _list_url(self, query: str, category: str, page: int, sort: str = "recent") -> str:
        """The listing URL for one (query|category|browse) × sort × page.

        Paging is NOT uniform: search takes `?page={n}`, while browse and category
        listings page as a trailing PATH segment. `/newest?page=2` answers 200 with
        page 1 — that silent re-serve is why "load N pages" used to append the same
        46 tiles over and over.
        """
        sort = (sort or "recent").strip().lower()
        page = max(1, int(page or 1))
        if query:
            base = f"{_ORIGIN}/search/{urllib.parse.quote(query)}"
            order = _SEARCH_SORT.get(sort, "")
            params = [f"sort={order}"] if order else []
            if page > 1:
                params.append(f"page={page}")
            return base + ("?" + "&".join(params) if params else "")
        if category:
            base = f"{_ORIGIN}/categories/{urllib.parse.quote(category)}"
            segment = _CATEGORY_SEGMENT.get(sort, "")
            if segment:
                base = f"{base}/{segment}"
        else:
            base = _ORIGIN + _BROWSE_PATH.get(sort, "/newest")
        return base if page <= 1 else f"{base}/{page}"

    @staticmethod
    def _initials(html: str) -> dict:
        """`window.initials = {...};</script>` -> dict. Shared by listing and enrich."""
        import json as _json

        match = re.search(r"window\.initials\s*=\s*(\{.*?\});\s*</script>", html or "", re.S)
        if not match:
            return {}
        try:
            data = _json.loads(match.group(1))
        except Exception:  # noqa: BLE001
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _thumb_rows(initials: dict) -> list:
        """The 46 card objects, wherever this listing kind happens to keep them.

        Each surface parks them under a different root: search under
        `searchResult`, browse under `layoutPage.videoListProps`, and a category
        under `pagesCategoryComponent.trendingVideoListProps` — checking only the
        first two returned 0 tiles on every /categories/ page.
        """
        roots = (
            initials.get("searchResult"),
            initials.get("layoutPage"),
            initials.get("pagesCategoryComponent"),
        )
        for root in roots:
            if not isinstance(root, dict):
                continue
            rows = root.get("videoThumbProps")
            if rows:
                return rows
            for key in ("videoListProps", "trendingVideoListProps"):
                rows = (root.get(key) or {}).get("videoThumbProps") or []
                if rows:
                    return rows
        return []

    @staticmethod
    def _paging(initials: dict) -> tuple[int, int]:
        """(current_page, last_page) as the page itself reports them, else (0, 0).

        Search publishes `initials.pagination` ({active, maxPages}); browse and
        category publish `paginationProps` ({currentPageNumber, lastPageNumber})
        under their own root. This is the only honest end-of-listing signal —
        a full page of 46 tiles says nothing about whether a 47th exists.
        """
        search = initials.get("pagination")
        if isinstance(search, dict) and search.get("maxPages"):
            return int(search.get("active") or 1), int(search["maxPages"])
        for key in ("layoutPage", "pagesCategoryComponent"):
            root = initials.get(key)
            if not isinstance(root, dict):
                continue
            props = root.get("paginationProps") or {}
            if props.get("lastPageNumber"):
                return (int(props.get("currentPageNumber") or 1),
                        int(props["lastPageNumber"]))
        return 0, 0

    def _tiles_from_json(self, html: str) -> list[dict]:
        """Build tiles from the listing JSON that hydrates the placeholder cards.

        This is the primary path: the server only renders ~8 cards as HTML and leaves
        the other ~38 as skeletons, so DOM scraping loses most of the page.
        """
        videos = self._thumb_rows(self._initials(html))
        items: list[dict] = []
        seen: set[str] = set()
        for video in videos:
            if not isinstance(video, dict):
                continue
            url = str(video.get("pageURL") or "").split("?", 1)[0]
            if not url or url in seen:
                continue
            seen.add(url)

            try:
                duration_sec = int(video.get("duration") or 0)
            except (TypeError, ValueError):
                duration_sec = 0

            added = ""
            created = video.get("created")
            if created:
                try:
                    added = _dt.datetime.fromtimestamp(
                        int(created), _dt.timezone.utc).strftime("%Y-%m-%d")
                except (TypeError, ValueError, OSError):
                    added = ""

            # isUHD is only present on the few 4K entries; absence means "not 4K",
            # not "unknown". A real height still needs enrich().
            height = 2160 if video.get("isUHD") else 0
            views = video.get("views")

            items.append(Tile(
                id=str(video.get("id") or url),
                title=str(video.get("title") or "").strip() or "xHamster video",
                url=url,
                thumb=str(video.get("thumbURL") or video.get("imageURL") or ""),
                preview=str(video.get("trailerURL") or ""),
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                views=f"{views} views" if views else "",
                quality="4K" if height else "",
                height=height,
                hd=bool(height),
                added=added,
            ).to_dict())
        return items

    def _parse_tiles(self, html: str) -> list[dict]:
        items = self._tiles_from_json(html)
        if items:
            return items
        return self._tiles_from_dom(html)

    def _tiles_from_dom(self, html: str) -> list[dict]:
        """Fallback for a JSON shape change. Only sees the ~8 server-rendered cards."""
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        # Match the stable token only — sibling classes are build-hashed.
        for card in soup.select(".video-thumb"):
            link = (card.select_one("a.video-thumb__image-container")
                    or card.select_one("a.video-thumb__name")
                    or card.find("a", href=True))
            href = (link.get("href") or "") if link else ""
            if "/videos/" not in href:
                continue
            url = urllib.parse.urljoin(_ORIGIN, href).split("?", 1)[0]
            if not url or url in seen:
                continue
            seen.add(url)

            image = card.find("img")
            thumb = ""
            if image:
                thumb = (image.get("data-src") or image.get("src") or "").strip()
                if thumb.startswith("data:"):
                    thumb = ""

            name_el = card.select_one(".video-thumb__name, [class*='video-thumb__name']")
            title = ""
            if name_el:
                title = (name_el.get("title") or name_el.get_text(" ", strip=True) or "").strip()
            if not title and link is not None:
                title = (link.get("title") or "").strip()
            if not title and image:
                title = (image.get("alt") or "").strip()
            if not title:
                slug = url.rstrip("/").split("/")[-1]
                title = slug.replace("-", " ").strip().capitalize() or "xHamster video"

            duration_el = card.select_one(
                "[class*='thumb-image__duration'], [class*='duration']")
            duration_sec = _duration_from_text(
                duration_el.get_text(" ", strip=True) if duration_el
                else card.get_text(" ", strip=True))

            hd_el = card.select_one("[class*='thumb-image__hd'], [class*='hd-badge']")
            hd_text = hd_el.get_text(" ", strip=True) if hd_el else ""
            height = 0
            if hd_text:
                if re.search(r"\b4k|2160\b", hd_text, re.I):
                    height = 2160
                else:
                    m = re.search(r"\b(1440|1080|720)\b", hd_text)
                    height = int(m.group(1)) if m else 0

            items.append(Tile(
                id=(card.get("data-video-id") or url),
                title=title,
                url=url,
                thumb=thumb,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                quality=("4K" if height >= 2160 else (f"{height}p" if height else "")),
                height=height,
                hd=bool(hd_text) or height >= 720,
            ).to_dict())
        return items

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        import time

        page = max(1, int(page or 1))
        url = self._list_url(query.strip(), category.strip(), page, sort)
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"xHamster HTTP {status}")
        items = self._parse_tiles(html)
        # The page states its own last page number; trust that over "we got tiles",
        # which was always True and let the user page forever into 404s.
        current, last = self._paging(self._initials(html))
        has_more = (current < last) if last else len(items) >= _PAGE_SIZE
        result = Page(items=items, page=page, has_more=bool(items) and has_more,
                      took_ms=int((time.perf_counter() - started) * 1000),
                      extra={"source": self.source, "page_url": url})
        self._page_cache[url] = (time.monotonic(), result)
        return result

    async def _estimated_size_mb(self, url: str) -> tuple[float | None, bool]:
        """(size_mb, is_estimate) for one watch URL, via the yt-dlp rendition bitrate."""
        from ..extractors.xhamster import XHamsterExtractor

        try:
            data = await XHamsterExtractor().extract(url)
        except Exception:  # noqa: BLE001
            return None, False
        size_bytes = int((data or {}).get("size_bytes") or 0)
        if not size_bytes:
            return None, False
        return round(size_bytes / 1048576, 1), bool((data or {}).get("size_estimated"))

    async def enrich(self, urls: list[str], *, deep: bool = False) -> dict[str, dict]:
        """Watch page `window.initials` -> real height, duration, upload date, tags.

        The listing only ever shows an HD badge, which is what `needs_enrich = True`
        promises to replace with a real resolution — and this adapter previously
        inherited the no-op `enrich()`, so the UI's "Full metadata" pass marked every
        tile as failed.

        xHamster serves no ld+json, so everything comes from `window.initials`:
          * `videoModel.resolution` -> [width, height]  (the height, no decoding needed)
          * `videoModel.duration`   -> seconds, already an int
          * `videoModel.created`    -> unix ts
          * `videoTagsComponent.tags[].name`
        None of those need the stream, so the default pass stays one plain request per
        tile and never touches `sources`, whose URLs are hex-scrambled.

        Size (deep=True only)
        ---------------------
        xHamster streams HLS: there is no single file to HEAD, and yt-dlp reports neither
        `filesize` nor `filesize_approx`. The renditions do advertise a bitrate, so the
        size is DERIVED as `tbr * duration / 8` — the same arithmetic the browser
        extension uses for its badges. It is an estimate (±, depends on VBR), and it
        costs a full yt-dlp resolve (~2.3s/video), hence deep-only. `size_estimated` is
        set so the UI can mark it as approximate rather than imply a measured byte count.
        """
        if not urls:
            return {}

        sem = asyncio.Semaphore(5)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    status, html = await self._get_html(url)
                except Exception:  # noqa: BLE001
                    return url, {}
            if status != 200 or not html:
                return url, {}
            initials = self._initials(html)
            if not initials:
                return url, {}

            model = initials.get("videoModel") or {}
            meta: dict = {}

            resolution = model.get("resolution")
            height = 0
            if isinstance(resolution, list) and len(resolution) == 2:
                try:
                    height = int(resolution[1])
                except (TypeError, ValueError):
                    height = 0
            if height:
                meta["height"] = height
                meta["quality"] = "4K" if height >= 2160 else f"{height}p"
                meta["hd"] = height >= 720

            try:
                duration = int(model.get("duration") or 0)
            except (TypeError, ValueError):
                duration = 0
            if duration:
                meta["duration_sec"] = duration

            created = model.get("created")
            if created:
                try:
                    meta["added"] = _dt.datetime.fromtimestamp(
                        int(created), _dt.timezone.utc).strftime("%Y-%m-%d")
                except (TypeError, ValueError, OSError):
                    pass

            tags = (initials.get("videoTagsComponent") or {}).get("tags") or []
            names = [str(t.get("name")) for t in tags
                     if isinstance(t, dict) and t.get("name")]
            if names:
                meta["tags"] = names[:20]

            if deep:
                size_mb, estimated = await self._estimated_size_mb(url)
                if size_mb:
                    meta["size_mb"] = size_mb
                    # Always present alongside size_mb so the UI can render "~1.4 GB"
                    # instead of implying a byte count nobody ever measured.
                    meta["size_estimated"] = estimated
            return url, meta

        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: meta for url, meta in results if meta}

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """Live-verified 2026-07-16: /categories lists 655 `/categories/{slug}` anchors.

        Every class on that page is build-hashed (`itemContent-12755`), so the only
        stable anchor is the href shape itself — matching on classes here would break
        at xHamster's next deploy. DOM order is the site's own popularity order, so the
        120-row cap in `dedupe_categories` keeps the useful head.
        """
        status, html = await self._get_html(f"{_ORIGIN}/categories")
        if status != 200:
            return []
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        for anchor in soup.select('a[href*="/categories/"]'):
            match = re.search(r"/categories/([a-z0-9-]+)/?$",
                              (anchor.get("href") or "").split("?")[0])
            if match:
                rows.append((match.group(1), anchor.get_text(" ", strip=True)))
        return rows

    async def related(self, url: str) -> Page:
        """Related videos off the watch page. Tries the listing parser (JSON→DOM);
        the DOM fallback's `.video-thumb` cards cover the related rail."""
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._tiles_from_dom(html)
                 if it.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False, extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        from ..extractors.xhamster import XHamsterExtractor

        data = await XHamsterExtractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("xHamster: stream sa nepodarilo získať")
        stream_url = data["stream_url"]
        return {
            "stream_url": stream_url,
            "is_hls": bool(data.get("is_hls")) or ".m3u8" in str(stream_url).lower(),
            "title": data.get("title") or "xHamster video",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": self.stream_referer},
                impersonate="chrome", timeout=25)
            return response.content, response.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)
