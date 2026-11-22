"""TNAFlix adapter for the unified Fusion Hub.

TNAFlix is NOT a KVS gallery-engine site, so it can't reuse `KvsHub`. Instead this
adapter is a thin async wrapper over the existing, already-verified
`app.extractors.tnaflix.TnaflixExtractor`, which owns the real (sync `requests` +
BeautifulSoup) scraping logic:

  * `discover()`          -> browse / search / category listing (used by search/browse)
  * `enrich_cards_batch()`-> per-card quality/size/duration/upload_date (used by enrich)
  * `extract()`           -> single watch page -> stream (used by resolve)

The extractor is imported lazily inside each method so an import error in it can only
break TNAFlix calls, never the rest of `init_hubs()`.
"""
from __future__ import annotations

import asyncio
import re
import threading
from typing import Any

from .base import HubAdapter, Page, Tile, label_without_count, secs_to_pretty
from .kvs import ENRICH_MAX

_ORIGIN = "https://www.tnaflix.com"
#: `div[data-vid]` cards per listing page — identical on /featured and /search.
_PAGE_SIZE = 60


def _quality_str(height: int) -> str:
    if not height:
        return ""
    return "4K" if height >= 2160 else f"{height}p"


def _sort_for_extractor(sort: str) -> str:
    """Map hub sort tokens to the `sort=` value TNAFlix's search URL takes.

    Kept because the URL grammar still accepts the parameter, but the site
    IGNORES it: `sort=new|views|rating|length|relevance` and no `sort` at all
    were fetched side by side (2026-07-25) and returned the same 60 cards in the
    same order, and the search page ships no sort control to copy a real value
    from. That is why `supported_sorts` is ("recent",) — see the class.
    """
    s = (sort or "").lower()
    if s in {"hottest", "most_viewed", "popular", "views"}:
        return "views"
    if s in {"top_rated", "rating"}:
        return "rating"
    return "new"


class TnaflixHub(HubAdapter):
    source = "tnaflix"
    label = "TNAFlix"
    # Listing cards carry duration/quality but not exact file size -> enrich is worth it.
    needs_enrich = True
    media_hosts = ("tnaflix.com", "cdnl.tnaflix.com", "cdn.tnaflix.com")
    stream_referer = "https://www.tnaflix.com/"
    #: TNAFlix has no working sort — see `_sort_for_extractor` for the live check.
    #: Declaring views/rating here would light up buttons that re-fetch the exact
    #: same 60 cards.
    supported_sorts = ("recent",)
    #: A listing card carries a duration badge and a `.max-quality` resolution
    #: badge. `views` is parsed as None by the extractor and there is no date.
    listing_fields = frozenset({"duration", "height"})

    def __init__(self) -> None:
        # One requests.Session per thread (the scrape below is sync `requests`
        # inside asyncio.to_thread). Sessions are not documented as thread-safe,
        # and per-thread ownership needs no lock while still collapsing a listing
        # or category sweep down to one TLS handshake per thread.
        self._local = threading.local()

    def _http(self):
        session = getattr(self._local, "session", None)
        if session is None:
            import requests
            session = requests.Session()
            self._local.session = session
        return session

    @staticmethod
    def _extractor():
        # Lazy import: keeps a broken extractor from taking down init_hubs().
        from ..extractors.tnaflix import TnaflixExtractor
        return TnaflixExtractor()

    def _tile_from_card(self, card: dict) -> dict:
        """Map a TnaflixExtractor.discover() card to a hub Tile dict.

        discover() card shape: {page_url, title, thumbnail, duration, quality, views}
        where `duration` is seconds (int) and `quality` is a pixel height (int) or None.
        """
        duration_sec = int(card.get("duration") or 0)
        height = int(card.get("quality") or 0)
        views = card.get("views")
        return Tile(
            id=card.get("page_url", ""),
            title=card.get("title") or "TNAFlix video",
            url=card.get("page_url", ""),
            thumb=card.get("thumbnail") or "",
            duration_sec=duration_sec,
            duration=secs_to_pretty(duration_sec),
            views=f"{views} views" if views else "",
            quality=_quality_str(height),
            height=height,
            hd=height >= 720,
        ).to_dict()

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        page = max(1, int(page or 1))
        ex = self._extractor()
        # Every page goes through the adapter's own single-page fetch, including
        # page 1: `discover()` hides the page's `<link rel="next">`, and without it
        # there is no way to tell a real page from the copy of page 1 that TNAFlix
        # serves for any out-of-range number (/featured/9999 == /featured/1, with a
        # "next" that still points at page 2). It also defaults min_quality=720,
        # which would silently drop every SD card from the hub grid.
        cards, next_page = await asyncio.to_thread(
            self._listing_page, ex, query.strip(), category.strip(),
            _sort_for_extractor(sort), page,
        )
        items = [self._tile_from_card(c) for c in (cards or [])]
        return Page(items=items, page=page,
                    has_more=bool(items) and next_page == page + 1,
                    extra={"source": self.source})

    def _listing_page(self, ex, keyword: str, category: str, sort_by: str,
                      page: int) -> tuple[list, int]:
        """One listing page -> (cards, next_page_number).

        Mirrors `TnaflixExtractor.discover()`'s URL rules and card parser (same
        selectors, same `.max-quality` badge first / `_parse_quality_from_card`
        fallback) so the tiles are identical to what the extractor would produce,
        and additionally reports the page's own `rel="next"` target.
        """
        import urllib.parse
        from bs4 import BeautifulSoup
        from ..extractors.tnaflix import tnaflix_category_slug
        if keyword:
            q = urllib.parse.quote_plus(keyword)
            url = f"{_ORIGIN}/search.php?what={q}&sort={sort_by}&page={page}"
        elif category:
            base = f"{_ORIGIN}/{tnaflix_category_slug(category)}"
            url = base if page <= 1 else f"{base}/{page}"
        else:
            url = f"{_ORIGIN}/featured/{page}"
        try:
            resp = self._http().get(url, headers=ex.headers, timeout=20)
            if resp.status_code != 200:
                return [], 0
        except Exception:
            return [], 0
        soup = BeautifulSoup(resp.text, "html.parser")
        cards = soup.select("div[data-vid]")
        if not cards:
            cards = [c for c in soup.select(".col-xs-6, .col-md-4, .col-lg-4")
                     if c.select_one('a.video-thumb, a[href*="/video"]')]
        if not cards:
            cards = soup.select("a.video-thumb")
        results: list = []
        for card in cards:
            anchor = card.select_one('a.video-thumb, a.video-title, a[href*="/video"]')
            if not anchor:
                if card.name == "a" and "/video" in card.get("href", ""):
                    anchor = card
                else:
                    continue
            page_url = anchor.get("href", "")
            if not page_url:
                continue
            if not page_url.startswith("http"):
                page_url = _ORIGIN + page_url
            title_el = card.select_one("a.video-title")
            if title_el:
                title = title_el.get_text(strip=True)
            else:
                img_t = card.select_one("img")
                title = (img_t.get("alt", "").strip() if img_t else "") or "TNAFlix video"
            thumb_anchor = card.select_one("a.video-thumb")
            thumb_el = thumb_anchor.select_one("img") if thumb_anchor else card.select_one("img")
            thumbnail = ""
            if thumb_el:
                thumbnail = (thumb_el.get("data-original") or thumb_el.get("data-src")
                             or thumb_el.get("src") or "")
            duration = 0
            dur_el = card.select_one(".video-duration, .thumb-icon.video-duration, .duration")
            if dur_el:
                parts = dur_el.get_text(strip=True).split(":")
                try:
                    if len(parts) == 3:
                        duration = int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
                    elif len(parts) == 2:
                        duration = int(parts[0]) * 60 + int(parts[1])
                except Exception:
                    pass
            quality = self._card_quality(ex, card)
            results.append({
                "page_url": page_url, "title": title, "thumbnail": thumbnail,
                "duration": duration, "quality": quality or None, "views": None,
            })
        return results, self._next_page(soup)

    @staticmethod
    def _card_quality(ex, card) -> int:
        """Resolution from the card's `.max-quality` badge, else the extractor's
        thumbnail-URL heuristic. The badge reads "1080p"/"4K"/"HD"."""
        el = card.select_one(".max-quality, .thumb-icon.max-quality")
        text = el.get_text(strip=True).lower().replace("p", "").strip() if el else ""
        if text:
            try:
                value = int(text)
                if 240 <= value <= 4320:
                    return value
            except ValueError:
                for needle, height in (("4k", 2160), ("2160", 2160), ("1080", 1080),
                                       ("fhd", 1080), ("720", 720), ("hd", 720),
                                       ("480", 480)):
                    if needle in text:
                        return height
        return ex._parse_quality_from_card(card) or 0

    @staticmethod
    def _next_page(soup) -> int:
        """The page number in `<link rel="next">`, or 0 if the tag is absent.

        Only equality with page+1 proves there IS a next page: an out-of-range
        request re-serves page 1 verbatim, `rel="next"` and all, so "we got 60
        cards" would keep the grid appending the same tiles forever.
        """
        link = soup.select_one('link[rel="next"], a[rel="next"]')
        href = (link.get("href") or "") if link else ""
        match = re.search(r"[?&]page=(\d+)", href) or re.search(r"/(\d+)/?$", href)
        return int(match.group(1)) if match else 0

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """Live-verified 2026-07-16: /categories -> div.category-index div.category-item a.

        The anchor is `<a href="…/babe-videos">Babes Fucking <span>883.5K</span></a>`,
        so the count span is dropped to keep the label clean. href is absolute and its
        last segment is the browse path verbatim (see `tnaflix_category_slug`).
        """
        def _do() -> list[tuple[str, str]]:
            from bs4 import BeautifulSoup
            ex = self._extractor()
            resp = self._http().get(f"{_ORIGIN}/categories",
                                    headers=ex.headers, timeout=20)
            if resp.status_code != 200:
                return []
            soup = BeautifulSoup(resp.text, "html.parser")
            rows: list[tuple[str, str]] = []
            for anchor in soup.select("div.category-index div.category-item a[href]"):
                slug = (anchor.get("href") or "").split("?")[0].rstrip("/").split("/")[-1]
                rows.append((slug, label_without_count(anchor)))
            return rows
        return await asyncio.to_thread(_do)

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        if not urls:
            return {}
        ex = self._extractor()
        rows = await asyncio.to_thread(ex.enrich_cards_batch, list(urls)[:ENRICH_MAX])
        out: dict[str, dict] = {}
        for row in rows or []:
            page_url = row.get("page_url")
            if not page_url or not row.get("ok"):
                continue
            height = int(row.get("quality") or 0)
            size_bytes = int(row.get("size_bytes") or 0)
            out[page_url] = {
                "quality": _quality_str(height),
                "height": height,
                "size_mb": round(size_bytes / 1048576, 1) if size_bytes else None,
                # The extractor reads content-length off the stream — measured.
                "size_estimated": False,
                "duration_sec": int(row.get("duration") or 0),
                "added": row.get("upload_date") or "",
            }
        return out

    async def related(self, url: str) -> Page:
        """TNAFlix listing cards come from the extractor (not a reusable page parser),
        so 'related' is a same-source keyword search seeded from the video's title."""
        from .base import keywords_from_title
        ex = self._extractor()

        def _title() -> str:
            from bs4 import BeautifulSoup
            try:
                resp = self._http().get(url, headers=ex.headers, timeout=20)
                if resp.status_code != 200:
                    return ""
            except Exception:
                return ""
            soup = BeautifulSoup(resp.text, "html.parser")
            og = soup.select_one('meta[property="og:title"]')
            if og and og.get("content"):
                return og["content"]
            h1 = soup.select_one("h1")
            return h1.get_text(" ", strip=True) if h1 else ""

        title = await asyncio.to_thread(_title)
        query = keywords_from_title(title)
        if not query:
            return Page(items=[], has_more=False)
        # sort is deliberately the default: TNAFlix ignores the parameter anyway
        # (see `_sort_for_extractor`), and its search is relevance-ordered already.
        page = await self.search(query, page=1)
        current = url.rstrip("/")
        page.items = [it for it in page.items if it.get("url", "").rstrip("/") != current][:36]
        page.extra["related_mode"] = "same-source-search"
        return page

    async def resolve(self, url: str) -> dict:
        ex = self._extractor()
        data = await asyncio.to_thread(ex.extract, url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("TNAFlix: stream sa nepodarilo získať")
        stream_url = data["stream_url"]
        return {
            "stream_url": stream_url,
            "is_hls": ".m3u8" in str(stream_url).lower(),
            "title": data.get("title") or "TNAFlix video",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    def _media_session(self):
        """Thumb/preview proxying needs curl_cffi's TLS impersonation, so it gets
        its own per-thread session alongside the plain `requests` one."""
        session = getattr(self._local, "media_session", None)
        if session is None:
            from curl_cffi import requests as cr
            session = cr.Session(impersonate="chrome")
            self._local.media_session = session
        return session

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            response = self._media_session().get(
                url, headers={"Referer": self.stream_referer},
                impersonate="chrome", timeout=25)
            return response.content, response.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)
