"""HQPorner Hub adapter for the unified Fusion Hub.

HQPorner is NOT a KVS site. It uses a custom gallery engine with:
  - Listing:  section.box.feature inside grid columns (div[class~="6u"])
  - Watch:    /hdporn/{numeric-id}-{slug}.html  (or bare /hdporn/{id} redirect)
  - Search:   /?q={query}&p={page}  (1-indexed)
  - Category: /category/{slug}  paginated as /category/{slug}/{n}
  - Recent:   homepage, paginated as /?p={n} (its "Next" points at /hdporn/{n})
  - Top:      /top, paginated as /top/{n}

Stream resolution is delegated to the existing HQPornerExtractor
(extractors/hqporner.py) which handles the mydaddy.cc / bigcdn.cc chain.

Live-verified 2026-07-20:
  66 026 total videos, +14 added today.
  Anti-bot: lightweight Cloudflare cookie banner (JS overlay only) — a
  server-side curl_cffi impersonate="chrome" fetch with Referer bypasses it.

Re-verified 2026-07-25, three URL rules had rotted and every one of them 404'd:
  * `/cat/{slug}` is gone — categories live at `/category/{slug}` and their index
    is `/categories`, not `/cat/`.
  * `/most-popular/` never existed on this engine; the ordered listing is `/top`.
  * category/top paging is a PATH segment; `?page=`/`?p=` are ignored there and
    silently re-serve page 1 (only the homepage and search honour `?p=`).
"""
from __future__ import annotations

import asyncio
import re
import threading
import time
import urllib.parse
from typing import Any

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

_ORIGIN = "https://hqporner.com"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
# age_verified bypasses the age gate; needed on listing requests too.
_COOKIES = {"age_verified": "1"}

# Watch-page URL shape — verified from extractor source.
# Matches both /hdporn/12345-slug.html and the bare /hdporn/12345 redirect.
_WATCH_RE = re.compile(
    r"(?:https?://(?:www\.)?hqporner\.com)?/hdporn/(\d+)(?:[/-][^/?#]*)?(?:\.html)?/?",
    re.I,
)


# ── helpers ──────────────────────────────────────────────────────────────────

# Every part is optional, so this pattern also matches the EMPTY string — which
# it did at offset 0 of every card, making `_duration_secs` return 0 for the whole
# site. Hence finditer + "first match that actually captured something".
_WORDY_DURATION_RE = re.compile(r"(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?", re.I)


def _duration_secs(text: str) -> int:
    """Parse "1h 47m 33s", "47m 34s", "13m 33s" into seconds."""
    match = next((m for m in _WORDY_DURATION_RE.finditer((text or "").strip())
                  if any(m.groups())), None)
    if not match:
        # fallback: colon-separated MM:SS or HH:MM:SS
        c = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)", text or "")
        if not c:
            return 0
        if c.group(3) is not None:
            return int(c.group(1)) * 3600 + int(c.group(2)) * 60 + int(c.group(3))
        return int(c.group(1)) * 60 + int(c.group(2))
    return (
        int(match.group(1) or 0) * 3600
        + int(match.group(2) or 0) * 60
        + int(match.group(3) or 0)
    )


def _quality(text: str) -> tuple[int, str]:
    """Return (height_px, quality_label) from card text."""
    t = (text or "").upper()
    if "4K" in t or "2160" in t:
        return 2160, "4K"
    for h in (1440, 1080, 720, 480, 360):
        if str(h) in t:
            return h, f"{h}p"
    return 0, ""


# ── adapter ──────────────────────────────────────────────────────────────────

class HQPornerHub(HubAdapter):
    source = "hqporner"
    label = "HQPorner"
    needs_enrich = False          # listing already contains quality from text badges
    media_hosts = ("hqporner.com", "bigcdn.cc", "mydaddy.cc")
    stream_referer = "https://hqporner.com/"
    #: The homepage (newest first) and /top are the only two orders this engine
    #: exposes — there is no most-viewed or longest listing to point a button at.
    #: Categories and search have no order control at all and always come back
    #: newest-first, so a sort is only meaningful on a query-less browse.
    supported_sorts = ("recent", "top_rated")
    #: A card is exactly "<title> 1h 9m 25s" — measured 2026-07-25, the views,
    #: rating, date and resolution regexes in `_parse_tiles` all come back empty
    #: because this skin prints no such badges. `_quality()` only ever fires on a
    #: title that happens to contain "1080"/"4K", so height is not a field.
    listing_fields = frozenset({"duration"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self._categories_cache: tuple[float, list[dict]] = (0.0, [])
        self.cache_seconds = 60
        # One curl_cffi Session per thread rather than a shared pool: Sessions are
        # unsafe for concurrent use, and every request below runs alone inside its
        # own asyncio.to_thread worker — so no lock, one handshake per thread.
        self._local = threading.local()

    # ── network ──────────────────────────────────────────────────────────────

    @staticmethod
    def _extractor():
        from ..extractors.hqporner import HQPornerExtractor
        return HQPornerExtractor()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    async def _get_html(self, url: str) -> tuple[int, str]:
        def _do() -> tuple[int, str]:
            resp = self._session().get(
                url,
                headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                cookies=_COOKIES,
                impersonate="chrome",
                timeout=20,
                allow_redirects=True,
            )
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    # ── URL builders ─────────────────────────────────────────────────────────

    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        """Search pages via `?p=`; every browse listing pages via a path segment.

        Live-verified 2026-07-25 — `/category/{slug}?p=2` and `/top?p=2` answer
        200 with page 1, so the query form looks fine and never advances, while
        the previous `/cat/{slug}/` and `/most-popular/` paths 404 outright.
        """
        page = max(1, page)
        if query:
            base = f"{_ORIGIN}/?q={urllib.parse.quote_plus(query)}"
            return base if page <= 1 else f"{base}&p={page}"
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/category/{slug}"
            return base if page <= 1 else f"{base}/{page}"
        if sort in {"top_rated", "rating", "most_viewed", "popular", "hottest"}:
            return f"{_ORIGIN}/top" if page <= 1 else f"{_ORIGIN}/top/{page}"
        # default → recent / homepage
        return f"{_ORIGIN}/" if page <= 1 else f"{_ORIGIN}/?p={page}"

    # ── tile parser ──────────────────────────────────────────────────────────

    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()

        # Primary selector: section.box.feature (used on search + category + listing)
        containers = soup.select("section.box.feature")
        if not containers:
            # Fallback: any section.box that wraps a video link
            containers = [
                s for s in soup.find_all("section", class_="box")
                if s.find("a", href=_WATCH_RE)
            ]

        for container in containers:
            link = container.find("a", href=_WATCH_RE)
            if not link:
                continue
            href = link.get("href") or ""
            m = _WATCH_RE.search(href)
            if not m:
                continue
            vid_id = m.group(1)
            # Keep the FULL slug URL — HQPorner serves the player iframe only on
            # /hdporn/{id}-{slug}.html; a bare /hdporn/{id} returns a 200 page
            # with NO player, which breaks both playback and refresh.
            url = href.split("?")[0].split("#")[0]
            if not url.startswith("http"):
                url = _ORIGIN + "/" + url.lstrip("/")
            if url in seen:
                continue
            seen.add(url)

            # title: anchor title attr → img alt → h3/h2 text
            img = container.find("img")
            title = (
                link.get("title")
                or (img.get("alt") if img else "")
                or (container.select_one("h3, h2") or {}).get_text(" ", strip=True)
                or ""
            ).strip()
            if not title:
                title = f"HQPorner #{vid_id}"

            thumb = ""
            if img:
                thumb = (
                    img.get("data-src") or img.get("data-original") or img.get("src") or ""
                )
                if thumb.startswith("//"):
                    thumb = "https:" + thumb
                elif thumb.startswith("/"):
                    thumb = _ORIGIN + thumb
                if thumb.startswith("data:"):
                    thumb = ""

            card_text = container.get_text(" ", strip=True)
            duration_sec = _duration_secs(card_text)
            height, quality_label = _quality(card_text)

            views_m = re.search(r"([\d,.]+\s*[KMB]?)\s*views?", card_text, re.I)
            rating_m = re.search(r"(\d{1,3}(?:\.\d+)?)%", card_text)
            date_m = re.search(
                r"(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago"
                r"|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2})",
                card_text, re.I,
            )

            items.append(Tile(
                id=vid_id,
                title=title,
                url=url,
                thumb=thumb,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                views=views_m.group(1) + " views" if views_m else "",
                rating=rating_m.group(1) + "%" if rating_m else "",
                quality=quality_label,
                height=height,
                hd=height >= 720,
                added=date_m.group(0) if date_m else "",
            ).to_dict())

        return items

    # ── HubAdapter contract ───────────────────────────────────────────────────

    async def search(
        self,
        query: str,
        *,
        sort: str = "recent",
        page: int = 1,
        category: str = "",
        **filters: Any,
    ) -> Page:
        page = max(1, int(page or 1))
        url = self._list_url(query.strip(), sort or "recent", category.strip(), page)

        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HQPorner HTTP {status} — {url}")

        items = self._parse_tiles(html)

        # End of pagination: HQPorner's paginator drops its "Next" anchor on the
        # last page (and the last page says "Wanna see more?" instead), so that
        # anchor is the signal. Matching any "page+1" href would also match the
        # numbered links a middle page always carries, which never go away.
        soup = BeautifulSoup(html, "html.parser")
        paginator = soup.select_one(".paginator, .pagination")
        has_next = bool(paginator and any(
            "next" in (a.get_text(" ", strip=True) or "").lower()
            for a in paginator.find_all("a", href=True)))

        result = Page(
            items=items,
            page=page,
            has_more=bool(items) and has_next,
            took_ms=round((time.perf_counter() - started) * 1000),
            extra={"source": self.source, "page_url": url},
        )
        self._page_cache[url] = (time.monotonic(), result)
        return result

    async def browse(
        self, *, sort: str = "recent", category: str = "", page: int = 1, **filters: Any
    ) -> Page:
        return await self.search("", sort=sort or "recent", category=category, page=page)

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """Scrape the /categories index for all category slugs + names."""
        status, html = await self._get_html(f"{_ORIGIN}/categories")
        if status != 200:
            return _CURATED_CATEGORIES
        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=re.compile(r"/category/[^/?#]+")):
            m = re.search(r"/category/([^/?#]+)", anchor.get("href") or "")
            if not m:
                continue
            slug = m.group(1).strip("/").lower()
            if not slug or slug in seen:
                continue
            name = (
                anchor.get("title")
                or anchor.get_text(" ", strip=True)
                or slug.replace("-", " ").title()
            ).strip()
            if not name or len(name) > 60:
                name = slug.replace("-", " ").title()
            seen.add(slug)
            rows.append((slug, name))
        return rows or _CURATED_CATEGORIES

    async def related(self, url: str) -> Page:
        """Related tiles from the watch page sidebar."""
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._parse_tiles(html)
                 if it.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False,
                    extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        """Delegate stream resolution to the existing HQPornerExtractor."""
        ex = self._extractor()
        data = await ex.extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("HQPorner: stream sa nepodarilo získať")
        return {
            "stream_url": data["stream_url"],
            "is_hls": bool(data.get("is_hls")),
            "title": data.get("title") or "HQPorner video",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            resp = cr.get(
                url,
                headers={"Referer": self.stream_referer, "User-Agent": _UA},
                impersonate="chrome",
                timeout=25,
            )
            return resp.content, resp.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)


# ── curated fallback (shown if /cat/ scrape fails) ───────────────────────────

_CURATED_CATEGORIES: list[tuple[str, str]] = [
    ("4k-porn", "4K"),
    ("1080p-porn", "1080p HD"),
    ("60fps", "60 FPS"),
    ("anal", "Anal"),
    ("asian", "Asian"),
    ("babe", "Babe"),
    ("bdsm", "BDSM"),
    ("big-ass", "Big Ass"),
    ("big-tits", "Big Tits"),
    ("blonde", "Blonde"),
    ("blowjob", "Blowjob"),
    ("brunette", "Brunette"),
    ("casting", "Casting"),
    ("creampie", "Creampie"),
    ("cumshot", "Cumshot"),
    ("deepthroat", "Deepthroat"),
    ("ebony", "Ebony"),
    ("gangbang", "Gangbang"),
    ("group-sex", "Group Sex"),
    ("interracial", "Interracial"),
    ("japanese", "Japanese"),
    ("latina", "Latina"),
    ("lesbian", "Lesbian"),
    ("mature", "Mature"),
    ("milf", "MILF"),
    ("pov", "POV"),
    ("public", "Public"),
    ("redhead", "Redhead"),
    ("russian", "Russian"),
    ("squirt", "Squirt"),
    ("teen-porn", "Teen (18+)"),
    ("threesome", "Threesome"),
    ("vintage", "Vintage"),
]
