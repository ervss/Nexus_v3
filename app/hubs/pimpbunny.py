"""PimpBunny adapter for the unified Fusion Hub.

NOT a `KvsHub` subclass — deliberately. PimpBunny's *player* is KVS (see
`app/extractors/pimpbunny.py`: `kt_player`, inline `license_code`, scrambled
`get_file` tokens), and the backend still speaks KVS query params
(`?sort_by=`, `?videos_per_page=`, `/contents/videos_screenshots/…`). But the
*gallery skin* on top of it is a bespoke, CSS-in-JS build whose two structural
differences make `KvsHub` actively wrong here:

  1. Watch URLs carry NO numeric id — they are `/videos/{slug}/`, e.g.
     `/videos/audreydevil-fucks-her-holes-with-two-cucumbers-and-milk/`. Browse
     pagination is `/videos/{N}/`. `KvsHub.video_re` (`/videos/\\d+`) therefore
     matches nothing but the *pagination links*, so a KVS-based adapter would
     have returned a grid of page numbers and zero real videos.
  2. Card classes are build-hashed (`ui-card-root__0dWeQJ`,
     `includes-pagination-wrapper__dMu7Yi`), so `KvsHub._parse_tiles`'
     `.item`/`.box`/`.thumb` card lookup finds no card container.

What it is NOT either: JSON-hydrated. Probed live 2026-07-25 — there is no
`__NEXT_DATA__`, no `window.initials`, no `<script type="application/json">`
anywhere on any listing. Every card is fully server-rendered HTML; the earlier
"only 7 `<a href="/videos/N/">` links" reading was an artefact of looking for
RELATIVE hrefs — card links are absolute (`https://pimpbunny.com/videos/…`),
and the 7 relative ones were the pagination strip. So: plain DOM scraping,
anchored on the stable, un-hashed class PREFIX `ui-card-link` (hashed suffix
matched with `[class*=]`), with `.b6m-video` as the card-container fallback.

Live-verified 2026-07-25
------------------------
* browse    `/videos/`, page N = `/videos/{N}/` (32 cards/page, 2985 pages,
            page 2986 -> 404)
* category  `/categories/{slug}/`, page N = `/categories/{slug}/{N}/` (32/page)
* model     `/models/{slug}/` or `/onlyfans-creators/{slug}/`, page N appended
            as `/{N}/` (32/page)
* search    `/search/{slug}/` — pagination is `?from_videos={N}`, NOT a path
            segment: `/search/teen/2/` answers **404**. Exactly the opposite of
            every other listing here, and the same trap documented for
            CamWhores. 30 cards/page, hard-capped at 200 pages / 6000 hits.
            `/search/?q=…` is the site's own form action and returns the
            identical page, so either shape works; the slug form is used.
* sorts     `?sort_by=post_date | video_viewed | rating` are honoured on browse,
            category, search AND model listings (all four re-ordered live).
            `sort_by=duration` is the odd one out: 200 on /search/ but **404**
            on /videos/ and /categories/ — a sort that 404s two of four surfaces
            is not a sort we advertise, so `longest` is absent from
            `supported_sorts` (it stays mapped so an explicit request still
            lands somewhere real on search).
* listing   every card carries duration, a relative date ("1 hour ago"), views,
            likes, uploader and a `data-preview` mp4. Resolution is only ever a
            "4K" badge (7 of 32 cards) — an absent badge means "not 4K", not
            "SD", so `height` is NOT claimed in `listing_fields` and waits for
            enrich(). No tags in the listing either.
* media     thumbs are `https://pimpbunny.com/contents/videos_screenshots/…`
            and streams redirect to `https://st{N}.pimpbunny.com/…`; both
            covered by the single `pimpbunny.com` suffix rule. Fetched a real
            thumb WITH and WITHOUT a `Referer` header: 200 / image/jpeg /
            identical 316532 bytes both ways — PimpBunny does NOT hotlink-
            protect, so the proxy is a convenience, not a requirement (unlike
            RedTube/HQPorner).

`resolve`/`enrich` reuse `PimpBunnyExtractor` rather than re-deriving the
`license_code` hash de-scramble; the raw flashvars tokens 404 without it.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
import time
import urllib.parse
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import (HubAdapter, Page, Tile, dedupe_categories,
                   iso_duration_to_secs, secs_to_pretty)
from .kvs import ENRICH_MAX

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_ORIGIN = "https://pimpbunny.com"

#: Cards per full page, measured live. Search really does serve 30 while every
#: other surface serves 32, and the two are used to decide `has_more`.
_PAGE_SIZE_SEARCH = 30
_PAGE_SIZE_LIST = 32

#: hub sort id -> KVS `?sort_by=` value. "recent" is the native order of every
#: listing (post_date), so it maps to no query at all.
_SORT_QUERY = {
    "recent": "",
    "top_rated": "rating",
    "rating": "rating",
    "most_viewed": "video_viewed",
    "hottest": "rating",
    # search-only; 404s on /videos/ and /categories/ — see module docstring.
    "longest": "duration",
}

#: `/videos/2/` is page two; `/videos/some-slug/` is a watch page. The whole
#: listing parser hinges on telling those apart, so it gets one named rule.
_PAGINATION_HREF = re.compile(r"/videos/\d+/?$", re.I)
_WATCH_HREF = re.compile(r"/videos/(?!\d+/?$)([^/?#]+)/?$", re.I)


def _duration_secs(text: str) -> int:
    match = re.search(r"(?<!\d)(\d{1,3}):(\d{2})(?::(\d{2}))?", text or "")
    if not match:
        return 0
    if match.group(3) is not None:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
    return int(match.group(1)) * 60 + int(match.group(2))


def _slug(value: str) -> str:
    clean = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return urllib.parse.quote(clean, safe="-")


class PimpBunnyHub(HubAdapter):
    source = "pimpbunny"
    label = "PimpBunny"
    #: The listing has no resolution beyond a 4K badge and no file size, both of
    #: which the watch page's flashvars ladder does carry -> a real enrich pass.
    needs_enrich = True
    media_hosts = ("pimpbunny.com",)
    stream_referer = "https://pimpbunny.com/"
    #: Verified to re-order live on browse, category, search and model listings.
    #: `longest` is intentionally missing — see the module docstring.
    supported_sorts = ("recent", "top_rated", "most_viewed")
    #: Measured on 32 browse cards + 30 search cards: duration 32/32,
    #: relative date 32/32, views 32/32, data-preview 32/32. `height` is a 4K
    #: badge on 7/32 only (absence != SD) and there are no listing tags, so
    #: neither is claimed.
    listing_fields = frozenset({"duration", "date", "views", "preview"})

    cache_seconds = 45

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self._categories_cache: tuple[float, list[dict]] = (0.0, [])
        self._detail_cache: dict[str, tuple[float, dict]] = {}
        # curl_cffi Sessions are not safe for concurrent use and every request
        # runs inside asyncio.to_thread, so one Session per thread: the owning
        # thread is the only user (no lock) and an enrich pass pays one TLS
        # handshake per worker instead of one per watch page.
        self._local = threading.local()

    # ── transport ────────────────────────────────────────────────────────────

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    async def _get_html(self, url: str, referer: str = "") -> tuple[int, str, str]:
        def _do() -> tuple[int, str, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": referer or _ORIGIN + "/"},
                impersonate="chrome", timeout=25, allow_redirects=True)
            return response.status_code, response.text, str(response.url)
        return await asyncio.to_thread(_do)

    async def _head_size(self, url: str) -> int:
        def _do() -> int:
            response = self._session().head(
                url, headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                impersonate="chrome", timeout=15, allow_redirects=True)
            if response.status_code >= 400:
                return 0
            try:
                return int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                return 0
        try:
            return await asyncio.to_thread(_do)
        except Exception:  # noqa: BLE001
            return 0

    # ── URL policy ───────────────────────────────────────────────────────────

    @staticmethod
    def _with_sort(url: str, sort: str) -> str:
        value = _SORT_QUERY.get((sort or "").strip().lower(), "")
        if not value:
            return url
        return url + ("&" if "?" in url else "?") + "sort_by=" + value

    def _list_url(self, query: str, category: str, sort: str, page: int) -> str:
        """One (query|category|browse) x sort x page -> a real URL.

        Search pages through a `?from_videos=` QUERY while every other listing
        pages through a trailing PATH segment. `/search/{q}/2/` is a hard 404,
        so the two forms are not interchangeable.
        """
        page = max(1, int(page or 1))
        if query:
            base = f"{_ORIGIN}/search/{_slug(query)}/"
            url = self._with_sort(base, sort)
            if page > 1:
                url += ("&" if "?" in url else "?") + f"from_videos={page}"
            return url
        if category:
            base = f"{_ORIGIN}/categories/{_slug(category)}/"
        else:
            base = f"{_ORIGIN}/videos/"
        if page > 1:
            base = f"{base}{page}/"
        return self._with_sort(base, sort)

    @staticmethod
    def _absolute(value: str) -> str:
        return urllib.parse.urljoin(_ORIGIN + "/", value or "")

    # ── listing parser ───────────────────────────────────────────────────────

    @staticmethod
    def _total_videos(html: str) -> int:
        """The listing's own "95516 videos" badge -> int, else 0.

        This is the only honest end-of-listing signal: a search page can serve
        29 of 30 cards (one pulled entry) mid-listing, so "short page = last
        page" would stop paging early. Search pages carry a models count too,
        hence the explicit `videos` anchor in the pattern.
        """
        match = re.search(r"includes-pagination-count[^>]*>\s*([\d\s,.]+?)\s*videos?\s*<",
                          html or "", re.I)
        if not match:
            return 0
        try:
            return int(re.sub(r"\D", "", match.group(1)) or 0)
        except ValueError:
            return 0

    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        # Hashed suffixes (`ui-card-link__KxRw6l`) change on every deploy, so
        # match the stable prefix only.
        for anchor in soup.select("a[class*='ui-card-link']"):
            href = anchor.get("href") or ""
            if "/videos/" not in href or _PAGINATION_HREF.search(href):
                continue
            match = _WATCH_HREF.search(href.split("?", 1)[0])
            if not match:
                continue
            url = self._absolute(href).split("?", 1)[0].split("#", 1)[0]
            if url in seen:
                continue
            seen.add(url)
            slug = match.group(1)

            card = anchor.find_parent(class_="b6m-video") or anchor.parent or anchor
            image = anchor.find("img") or card.find("img")

            title = ""
            if image:
                title = (image.get("alt") or "").strip()
            if not title:
                node = card.select_one("[class*='ui-card-title']")
                title = node.get_text(" ", strip=True) if node else ""
            if not title:
                title = slug.replace("-", " ").strip().title() or "PimpBunny video"

            thumb = preview = ""
            if image:
                # `src` is a base64 lazy-load placeholder on every card.
                thumb = (image.get("data-original") or image.get("data-webp") or "").strip()
                preview = (image.get("data-preview") or "").strip()
            if thumb.startswith("data:"):
                thumb = ""

            duration_el = card.select_one("[class*='ui-card-duration']")
            duration_sec = _duration_secs(
                duration_el.get_text(" ", strip=True) if duration_el else "")

            # Resolution shows up ONLY as a "4K" chip inside the duration badge.
            # No badge means "not 4K" — not "SD" — so height stays 0 and the
            # tile is left unjudged until enrich().
            height = 2160 if card.select_one("[class*='pbn-4k']") else 0

            views = added = ""
            info = card.select_one("[class*='ui-card-info__']")
            if info:
                cells = [c.get_text(" ", strip=True) for c in info.find_all("div", recursive=False)]
                cells = [c for c in cells if c]
                for cell in cells:
                    if re.search(r"(ago|yesterday|today|\d{4}-\d{2}-\d{2})", cell, re.I):
                        added = cell
                        break
                if cells and cells[0] != added:
                    views = cells[0]

            uploader = uploader_url = ""
            model = card.select_one("[class*='ui-card-related-models'] a")
            if model:
                uploader = model.get_text(" ", strip=True)
                uploader_url = self._absolute(model.get("href") or "")

            items.append(Tile(
                id=slug,
                title=title,
                url=url,
                thumb=thumb,
                preview=preview,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                views=f"{views} views" if views else "",
                uploader=uploader,
                uploader_url=uploader_url,
                quality="4K" if height else "",
                height=height,
                hd=bool(height),
                added=added,
            ).to_dict())
        return items

    async def _listing(self, url: str, *, page: int, page_size: int,
                       extra: Optional[dict] = None) -> Page:
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]
        started = time.perf_counter()
        status, html, final_url = await self._get_html(url)
        if status != 200:
            # Paging past the end is a plain 404 here (verified: /videos/2986/),
            # so it's the end of the listing rather than an error worth raising.
            if status == 404 and page > 1:
                return Page(items=[], page=page, has_more=False,
                            extra={"source": self.source, "page_url": url})
            raise RuntimeError(f"PimpBunny HTTP {status}")
        items = self._parse_tiles(html)
        total = self._total_videos(html)
        has_more = (page * page_size < total) if total else len(items) >= page_size
        result = Page(
            items=items,
            page=page,
            has_more=bool(items) and has_more,
            total=total or None,
            took_ms=round((time.perf_counter() - started) * 1000),
            extra={"source": self.source, "page_url": final_url, **(extra or {})},
        )
        self._page_cache[url] = (time.monotonic(), result)
        return result

    # ── surfaces ─────────────────────────────────────────────────────────────

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        query = (query or "").strip()
        category = (category or "").strip()
        page = max(1, int(page or 1))
        url = self._list_url(query, category, sort or "recent", page)
        size = _PAGE_SIZE_SEARCH if query else _PAGE_SIZE_LIST
        return await self._listing(url, page=page, page_size=size)

    async def browse(self, *, sort: str = "recent", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        return await self.search("", sort=sort or "recent", category=category, page=page)

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """`/categories/` -> 30 clean `(slug, name)` rows, live-verified 2026-07-25.

        Category anchors are the only stable handle (classes are build-hashed),
        and the page also links every localised `/es/categories/` variant, so the
        pattern pins the English root and a single trailing slug segment.
        """
        status, html, _ = await self._get_html(f"{_ORIGIN}/categories/")
        if status != 200:
            return []
        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        for anchor in soup.select('a[href*="/categories/"]'):
            match = re.match(r"^(?:https://pimpbunny\.com)?/categories/([a-z0-9-]+)/?$",
                             (anchor.get("href") or "").split("?")[0])
            if match:
                rows.append((match.group(1), anchor.get_text(" ", strip=True)))
        return rows

    # ── performers ───────────────────────────────────────────────────────────
    # PimpBunny splits its talent over TWO namespaces: `/models/` (320 site
    # models) and `/onlyfans-creators/` (which is where nearly every card's
    # performer link actually points). Both serve the identical 32-card listing
    # with `/{N}/` paging, so a slug is tried in both before giving up.

    _PERFORMER_PATHS = ("models", "onlyfans-creators")

    async def _performer_page(self, slug: str, sort: str, page: int) -> tuple[str, str, str]:
        """(kind, html, final_url) for whichever namespace holds this slug."""
        last_status = 404
        for kind in self._PERFORMER_PATHS:
            base = f"{_ORIGIN}/{kind}/{slug}/"
            if page > 1:
                base = f"{base}{page}/"
            url = self._with_sort(base, sort)
            status, html, final_url = await self._get_html(url)
            if status == 200:
                return kind, html, final_url
            last_status = status
        raise RuntimeError(f"PimpBunny HTTP {last_status}")

    async def pornstar_videos(self, slug: str, *, sort: str = "recent", page: int = 1) -> Page:
        clean = re.sub(r"[^a-z0-9-]+", "-", urllib.parse.unquote(slug or "").lower()).strip("-")
        if not clean:
            raise ValueError("Neplatné meno modela")
        page = max(1, int(page or 1))
        started = time.perf_counter()
        try:
            kind, html, final_url = await self._performer_page(clean, sort or "recent", page)
        except RuntimeError:
            if page > 1:
                return Page(items=[], page=page, has_more=False)
            raise
        items = self._parse_tiles(html)
        total = self._total_videos(html)
        soup = BeautifulSoup(html, "html.parser")
        title = soup.select_one("title")
        name = (title.get_text(" ", strip=True).split("|")[0].strip() if title else "")
        name = re.sub(r"\s+(?:porn|onlyfans leaks|videos?)\s*$", "", name, flags=re.I).strip()
        name = name or clean.replace("-", " ").title()
        return Page(
            items=items, page=page,
            has_more=bool(items) and ((page * _PAGE_SIZE_LIST < total) if total
                                      else len(items) >= _PAGE_SIZE_LIST),
            total=total or None,
            took_ms=round((time.perf_counter() - started) * 1000),
            extra={"view": "pornstar", "slug": clean, "name": name,
                   "kind": kind, "page_url": final_url, "native_sort": "recent"},
        )

    async def find_pornstar(self, ref: str) -> dict:
        ref = (ref or "").strip()
        match = re.search(r"/(?:models|onlyfans-creators)/([^/?#]+)", ref, re.I)
        clean = match.group(1) if match else re.sub(r"[^a-z0-9-]+", "-", ref.lower()).strip("-")
        if not clean:
            return {"found": False}
        try:
            result = await self.pornstar_videos(clean, page=1)
        except Exception:  # noqa: BLE001
            return {"found": False}
        if not result.items:
            return {"found": False}
        return {"found": True, "slug": clean,
                "name": result.extra.get("name") or clean.replace("-", " ").title(),
                "avatar": ""}

    # ── enrich ───────────────────────────────────────────────────────────────

    async def _detail_metadata(self, url: str) -> dict:
        cached = self._detail_cache.get(url)
        if cached and time.time() - cached[0] < 86400:
            return dict(cached[1])

        status, html, _ = await self._get_html(url, referer=_ORIGIN + "/")
        if status != 200:
            raise RuntimeError(f"PimpBunny HTTP {status}")
        soup = BeautifulSoup(html, "html.parser")

        structured: dict = {}
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                value = json.loads(script.string or script.get_text() or "{}")
            except (TypeError, ValueError):
                continue
            for row in (value if isinstance(value, list) else [value]):
                if isinstance(row, dict) and row.get("@type") == "VideoObject":
                    structured = row
                    break
            if structured:
                break

        duration_sec = iso_duration_to_secs(str(structured.get("duration") or ""))
        thumb = structured.get("thumbnailUrl") or ""
        if isinstance(thumb, list):
            thumb = thumb[0] if thumb else ""

        # The rendition ladder + its heights only exist inside the KVS flashvars,
        # and only after the license_code de-scramble — reuse the extractor's
        # implementation rather than restating that math here.
        from ..extractors.pimpbunny import PimpBunnyExtractor

        streams = PimpBunnyExtractor()._flashvars_streams(html)
        height = max((s.get("height") or 0) for s in streams) if streams else 0
        size_mb = None
        if height:
            best = max(streams, key=lambda s: s.get("height") or 0)
            size_bytes = await self._head_size(best["url"])
            if size_bytes:
                size_mb = round(size_bytes / 1048576, 1)

        # The video's own categories are the `/categories/` anchors inside
        # <main>; the header nav lists all 30 of them, so scoping is required.
        tags: list[str] = []
        main = soup.find("main")
        if main:
            for anchor in main.select('a[href*="/categories/"]'):
                if re.match(r"^(?:https://pimpbunny\.com)?/categories/[a-z0-9-]+/?$",
                            (anchor.get("href") or "").split("?")[0]):
                    name = anchor.get_text(" ", strip=True)
                    if name and name not in tags:
                        tags.append(name)

        result = {
            "title": str(structured.get("name") or "").strip(),
            "thumbnail": str(thumb),
            "duration_sec": duration_sec,
            "duration": secs_to_pretty(duration_sec),
            "height": height,
            "quality": "4K" if height >= 2160 else (f"{height}p" if height else ""),
            "size_mb": size_mb,
            # A HEAD content-length on the real rendition, never a bitrate guess.
            "size_estimated": False,
            "codec": "mp4" if streams else "",
            "hd": height >= 720,
            "tags": tags[:20],
            "video_tags": tags[:20],
            "upload_date": str(structured.get("uploadDate") or "")[:10],
            "added": str(structured.get("uploadDate") or "")[:10],
            "description": str(structured.get("description") or "").strip(),
        }
        self._detail_cache[url] = (time.time(), result)
        return dict(result)

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        sem = asyncio.Semaphore(4)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    return url, await self._detail_metadata(url)
                except Exception:  # noqa: BLE001
                    return url, {}
        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: data for url, data in results if data}

    async def enrich_stream(self, urls: list[str]):
        sem = asyncio.Semaphore(4)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                return url, await self._detail_metadata(url)

        tasks = [asyncio.create_task(one(u)) for u in list(urls)[:ENRICH_MAX]]
        for task in asyncio.as_completed(tasks):
            try:
                yield await task
            except Exception:  # noqa: BLE001
                continue

    # ── watch surfaces ───────────────────────────────────────────────────────

    async def related(self, url: str) -> Page:
        """The watch page's own related rail — the same card markup as a listing."""
        status, html, _ = await self._get_html(url, referer=_ORIGIN + "/")
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._parse_tiles(html)
                 if it.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False,
                    extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        from ..extractors.pimpbunny import PimpBunnyExtractor

        data = await PimpBunnyExtractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("PimpBunny: stream sa nepodarilo získať")
        stream_url = str(data["stream_url"])
        return {
            "stream_url": stream_url,
            "is_hls": bool(data.get("is_hls")) or ".m3u8" in stream_url.lower(),
            "title": data.get("title") or "PimpBunny video",
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
