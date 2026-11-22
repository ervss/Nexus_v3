"""XVideos adapter for the unified Fusion Hub.

Not a KVS site, so this is a standalone HubAdapter.

Live-verified DOM facts (2026-07-16, browser console):
  * listing card selector `div.thumb-block`  (31 on /?k=kiss)
  * card carries `data-id` (numeric), `data-eid`, and `data-nvs-url` (absolute watch URL)
  * search pagination is `?k={query}&p={n}` and is 0-INDEXED (page 2 => p=1)
  * watch page ld+json carries `contentUrl` (direct MP4), ISO-8601 `duration`, `uploadDate`

XVideos rotates its watch-URL shape: it currently emits `/video.{eid}/{slug}` but has
also used `/video{id}/{slug}`. Never pin a regex to one of them — the parser prefers the
card's own `data-nvs-url` and otherwise accepts any `/video…` anchor, so both shapes (and
the next one) keep working. `data-id`/`data-eid` give a stable tile id independent of the
URL shape.

Title/duration/thumbnail element lookups below are deliberately tolerant (several
candidates + fallbacks) because the captured card sample was truncated before those
nodes; the card/href/pagination rules above are exact. `resolve` reuses the existing
`XVideosExtractor` (yt-dlp + Playwright fallback) rather than re-deriving streams.
"""
from __future__ import annotations

import asyncio
import re
import threading
import urllib.parse
from typing import Any, Optional

from curl_cffi import requests as cr

from .base import (HubAdapter, Page, Tile, iso_duration_to_secs,
                   label_without_count, secs_to_pretty)
from .kvs import ENRICH_MAX

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_ORIGIN = "https://www.xvideos.com"
#: Hub sort id -> the `sort=` value on `/?k={query}`. Live-verified 2026-07-25:
#: each one returns a visibly different first page. The value set comes from the
#: site's own sort dropdown.
#:
#: KEYWORD SEARCH ONLY. `/tags/{tag}?sort=…` was checked against every value and
#: returned byte-identical card ids each time, and `/best/{yyyy-mm}` ignores the
#: parameter as well — XVideos simply has no sorted browse listing, so with no
#: query typed the buttons cannot do anything. That is why the tuple below is
#: documented as search-only rather than silently applied everywhere.
_SEARCH_SORT = {
    "relevance": "relevance",
    "recent": "uploaddate",
    "top_rated": "rating",
    "most_viewed": "views",
    "longest": "length",
}
# XVideos' tag counts are search-MATCH counts, so bare function words match nearly
# every title and outrank real tags ("and" = 545K vs "amateur" = 64K). They are the
# only junk in the count-sorted head; everything else there is a genuine category.
_TAG_STOPWORDS = frozenset((
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "he", "her",
    "his", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "she", "that",
    "the", "their", "them", "they", "this", "to", "was", "we", "were", "with", "you",
    "your",
))


def _duration_from_text(text: str) -> int:
    """XVideos shows '7:09' or '10 min' style labels."""
    m = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?", text or "")
    if m:
        if m.group(3) is not None:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        return int(m.group(1)) * 60 + int(m.group(2))
    m = re.search(r"(\d+)\s*min", text or "", re.I)
    if m:
        return int(m.group(1)) * 60
    m = re.search(r"(\d+)\s*sec", text or "", re.I)
    return int(m.group(1)) if m else 0


class XVideosHub(HubAdapter):
    source = "xvideos"
    label = "XVideos"
    needs_enrich = True  # listing has no resolution badge; height comes from the watch page
    media_hosts = ("xvideos.com", "xvideos-cdn.com", "xvideos4.com")
    stream_referer = "https://www.xvideos.com/"
    #: See `_SEARCH_SORT`: real on the keyword search, and only there — the tag
    #: browse has no sort parameter at all (verified value by value).
    supported_sorts = ("relevance", "recent", "top_rated", "most_viewed", "longest")
    #: The card gives a duration and a `data-pvv` hover preview. The "1080p" text
    #: in the card body is not read by `_parse_tiles` (only `.video-hd-mark` is),
    #: so height stays an enrich-only field and is not claimed here.
    listing_fields = frozenset({"duration", "preview"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self.cache_seconds = 45
        # One curl_cffi Session per thread, not a shared pool: Sessions are unsafe
        # under concurrent use and every request runs in its own asyncio.to_thread
        # worker, so the owning thread is the sole user — and the TLS handshake is
        # paid once per thread instead of once per watch page during enrich.
        self._local = threading.local()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
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

    def _search_url(self, query: str, page: int, category: str = "",
                    sort: str = "") -> str:
        # Live-verified: search paging is 0-indexed (?p=0 is page 1).
        query = (query or "").strip()
        category = (category or "").strip()
        if not query and category:
            # Categories are tags here: /tags/{slug}, paginated by a trailing path
            # segment that is 0-INDEXED too (/tags/x == /tags/x/0, /tags/x/1 == page 2).
            # No `sort=` — this listing ignores it (see _SEARCH_SORT).
            return (f"{_ORIGIN}/tags/{urllib.parse.quote(category)}"
                    f"{'' if page <= 1 else f'/{page - 1}'}")
        if not query:
            # `?k=&p=N` 500s on xvideos — there's no "empty search" browse mode.
            # The homepage IS the newest-first listing and its own "Next" link
            # points at /new/{n} (1-indexed, page 1 = "/"). The old /best/{page}
            # form redirected every page back to /best/{yyyy-mm}, so a query-less
            # browse re-served page 1 forever.
            return _ORIGIN + "/" if page <= 1 else f"{_ORIGIN}/new/{page}"
        q = urllib.parse.quote_plus(query)
        url = f"{_ORIGIN}/?k={q}&p={max(0, page - 1)}"
        order = _SEARCH_SORT.get((sort or "").strip().lower(), "")
        return f"{url}&sort={order}" if order else url

    def _parse_tiles(self, html: str) -> list[dict]:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        for block in soup.select("div.thumb-block"):
            # `data-nvs-url` is absolute; otherwise take the first /video… anchor.
            url = (block.get("data-nvs-url") or "").strip()
            if not url:
                link = (block.select_one("p.title a") or block.select_one(".thumb-under a")
                        or block.find("a", href=True))
                href = (link.get("href") or "") if link else ""
                if "/video" not in href:
                    continue
                url = urllib.parse.urljoin(_ORIGIN, href)
            url = url.split("?", 1)[0]
            if not url or url in seen:
                continue
            seen.add(url)

            title_link = block.select_one("p.title a") or block.select_one(".thumb-under a")
            title = ""
            if title_link:
                title = (title_link.get("title") or title_link.get_text(" ", strip=True) or "").strip()
            if not title or re.fullmatch(r"\d{3,4}p", title):
                slug = url.rstrip("/").split("/")[-1]
                title = slug.replace("_", " ").replace("-", " ").strip().capitalize() or "XVideos video"

            image = block.find("img")
            thumb = ""
            if image:
                thumb = (image.get("data-src") or image.get("src") or "").strip()
                if thumb.startswith("data:"):
                    thumb = ""
                # `data-src` is a client-side scrubber template — the site's own
                # onpage JS (`xv.thumbs.prepareVideo(id)`) fills the frame number
                # in at hover time. A static fetch never runs that script, so a
                # fraction of cards keep the literal placeholder verbatim
                # (`…/xv_THUMBNUM_t.jpg`, confirmed live to 404) instead of a real
                # frame number (`…/xv_1_t.jpg`). `data-mzl` is the one thumb URL
                # every card carries pre-resolved, with no frame number at all —
                # use it whenever the scrubber template never got substituted.
                if "THUMBNUM" in thumb:
                    thumb = (image.get("data-mzl") or "").strip()
            preview = (image.get("data-pvv") or "") if image else ""

            block_text = block.get_text(" ", strip=True)
            duration_el = block.select_one(".duration, [class*='duration']")
            duration_sec = _duration_from_text(
                duration_el.get_text(" ", strip=True) if duration_el else block_text)

            hd_el = block.select_one(".video-hd-mark, [class*='hd-mark'], .quality")
            hd_text = hd_el.get_text(" ", strip=True) if hd_el else ""
            height = 2160 if re.search(r"\b4k|2160\b", hd_text, re.I) else 0
            if not height:
                m = re.search(r"\b(1440|1080|720|480|360)\b", hd_text)
                height = int(m.group(1)) if m else 0

            items.append(Tile(
                id=(block.get("data-id") or block.get("data-eid") or url),
                title=title,
                url=url,
                thumb=thumb,
                preview=preview if preview and not preview.startswith("data:") else "",
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
        url = self._search_url(query.strip(), page, category.strip(), sort)
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"XVideos HTTP {status}")
        items = self._parse_tiles(html)
        result = Page(items=items, page=page,
                      has_more=bool(items) and self._has_next(html),
                      took_ms=int((time.perf_counter() - started) * 1000),
                      extra={"source": self.source, "page_url": url})
        self._page_cache[url] = (time.monotonic(), result)
        return result

    @staticmethod
    def _has_next(html: str) -> bool:
        """Is there a page after this one, per the site's own pager?

        XVideos CLAMPS an out-of-range page instead of 404ing (`?k=teen&p=9999`
        answers 200 with the last page's 4 tiles), so "we got tiles" can never end
        a listing. Every pager here marks the forward link `a.next-page`; on the
        `/best/{yyyy-mm}` grid the links are `a[data-page]` instead, so fall back
        to "some data-page is above the current one".
        """
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        if soup.select_one("a.next-page"):
            return True
        pager = soup.select_one("div.pagination")
        if not pager:
            return False
        current = pager.select_one("a.current, a.active")
        try:
            current_page = int(current.get("data-page") or 0) if current else 0
        except (TypeError, ValueError):
            current_page = 0
        for anchor in pager.select("a[data-page]"):
            try:
                if int(anchor["data-page"]) > current_page:
                    return True
            except (TypeError, ValueError):
                continue
        return False

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """Live-verified 2026-07-16: XVideos has no /categories — tags are the taxonomy.

        `/tags` holds `ul.tags-list li a` = exactly 2000 real tags, each with a
        `span.navbadge` video count. The page's alphabet index (`/tags/a`, `/tags/09`)
        lives OUTSIDE `ul.tags-list`, so scoping to that container drops it without
        needing a slug blocklist.

        The list is ALPHABETICAL, so the 120-row cap would otherwise hand the UI
        "0-pussy", "1-on-1", "1080p"… — sorting by the badge count first makes the cap
        keep the 120 biggest tags instead, minus the stopwords that ranking drags up
        (see `_TAG_STOPWORDS`). Labels stay in the site's own lower case.
        """
        status, html = await self._get_html(f"{_ORIGIN}/tags")
        if status != 200:
            return []
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")
        scored: list[tuple[int, str, str]] = []
        for anchor in soup.select('ul.tags-list li a[href^="/tags/"]'):
            slug = (anchor.get("href") or "").split("/tags/")[-1].split("?")[0].strip("/")
            if not slug or "/" in slug or slug in _TAG_STOPWORDS:
                continue
            badge = anchor.select_one("span.navbadge")
            digits = re.sub(r"\D", "", badge.get_text(strip=True) if badge else "")
            scored.append((int(digits or 0), slug, label_without_count(anchor)))
        scored.sort(key=lambda row: -row[0])
        return [(slug, name) for _, slug, name in scored]

    async def _hls_master(self, master_url: str) -> str:
        def _do() -> str:
            response = self._session().get(
                master_url, headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                impersonate="chrome", timeout=15)
            return response.text if response.status_code == 200 else ""
        try:
            return await asyncio.to_thread(_do)
        except Exception:  # noqa: BLE001
            return ""

    def _hls_renditions(self, manifest: str) -> list[dict]:
        """Parse every #EXT-X-STREAM-INF line into {height, bandwidth}.

        Reads attributes per-line (order-independent) rather than with two
        separate ad-hoc regexes, and prefers the site's own NAME="1080p" label
        over raw RESOLUTION=WIDTHxHEIGHT pixels: portrait/vertical uploads have
        RESOLUTION=1080x1920 (width x height, per the HLS spec) for what
        XVideos itself calls "1080p" — taking the raw second number as height
        reported a nonsensical "1920p" for a rendition XVideos considers 1080p.
        Falls back to min(w, h) — the orientation-independent short side — when
        a line has no NAME attribute.
        """
        out: list[dict] = []
        for line in (manifest or "").splitlines():
            if not line.startswith("#EXT-X-STREAM-INF"):
                continue
            bw_m = re.search(r"BANDWIDTH=(\d+)", line)
            res_m = re.search(r"RESOLUTION=(\d+)x(\d+)", line)
            name_m = re.search(r'NAME="(\d+)p"', line)
            if not bw_m and not res_m:
                continue
            if name_m:
                height = int(name_m.group(1))
            elif res_m:
                height = min(int(res_m.group(1)), int(res_m.group(2)))
            else:
                height = 0
            out.append({"height": height, "bandwidth": int(bw_m.group(1)) if bw_m else 0})
        return out

    async def _hls_height(self, master_url: str) -> int:
        """Best rendition height advertised by the HLS master playlist (~0.07s)."""
        renditions = self._hls_renditions(await self._hls_master(master_url))
        heights = [r["height"] for r in renditions if r["height"]]
        return max(heights) if heights else 0

    async def _hls_best_bandwidth(self, master_url: str) -> int:
        """BANDWIDTH= (bits/sec) of the highest-resolution rendition in the
        master playlist — used to derive a real size for the stream that
        actually plays, since XVideos only exposes a Content-Length for the
        unrelated SD progressive fallback file (see `enrich()`)."""
        renditions = self._hls_renditions(await self._hls_master(master_url))
        if not renditions:
            return 0
        best = max(renditions, key=lambda r: r["height"])
        return best["bandwidth"]

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

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        """Real resolution + file size + duration + upload date from the watch page.

        XVideos' ld+json carries `duration`/`uploadDate` but NOT `height`, so quality
        used to come back empty. The resolution lives in the HLS master playlist
        (`setVideoHLS(...)` -> `#EXT-X-STREAM-INF:...RESOLUTION=1920x1080`), which lists
        every rendition — take the largest.

        Size comes from a HEAD on `setVideoUrlHigh`. Note that High and Low currently
        hand back the SAME mp4_sd.mp4 URL, so this is the size of the progressive SD
        file, not of the HLS rendition the player actually streams — it is the only file
        XVideos exposes a length for.
        """
        if not urls:
            return {}
        import json as _json

        sem = asyncio.Semaphore(5)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    status, html = await self._get_html(url)
                except Exception:
                    return url, {}
            if status != 200 or not html:
                return url, {}
            meta: dict = {}
            for match in re.finditer(
                    r'<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>',
                    html, re.S | re.I):
                try:
                    data = _json.loads(match.group(1).strip())
                except Exception:
                    continue
                if isinstance(data, list):
                    data = next((d for d in data if isinstance(d, dict)
                                 and d.get("@type") == "VideoObject"), None)
                if not isinstance(data, dict) or data.get("@type") != "VideoObject":
                    continue
                duration = iso_duration_to_secs(str(data.get("duration") or ""))
                if duration:
                    meta["duration_sec"] = duration
                upload = str(data.get("uploadDate") or "")
                if upload:
                    meta["added"] = upload[:10]
                break

            # ld+json has no `height` on XVideos — the HLS manifest is the only place
            # the real renditions are listed.
            height = 0
            hls = re.search(r"setVideoHLS\('([^']+)'\)", html)
            if hls:
                height = await self._hls_height(hls.group(1))
            if height:
                meta["height"] = height
                meta["quality"] = "4K" if height >= 2160 else f"{height}p"
                meta["hd"] = height >= 720

            # Prefer a size DERIVED from the best HLS rendition's BANDWIDTH — the
            # HEAD-measured mp4 below is the SD progressive fallback (see the
            # docstring), so it undersells an HD/4K video's real size. Fall back
            # to the HEAD size only when the manifest has no bandwidth info.
            size_mb = None
            estimated = False
            if hls:
                bw = await self._hls_best_bandwidth(hls.group(1))
                duration = meta.get("duration_sec") or 0
                if bw and duration:
                    size_mb = round(bw * duration / 8 / 1048576, 1)
                    estimated = True
            if size_mb is None:
                best = re.search(r"setVideoUrlHigh\('([^']+)'\)", html) or \
                    re.search(r"setVideoUrlLow\('([^']+)'\)", html)
                if best:
                    size_bytes = await self._head_size(best.group(1))
                    if size_bytes:
                        size_mb = round(size_bytes / 1048576, 1)
                        estimated = False
            if size_mb:
                meta["size_mb"] = size_mb
                meta["size_estimated"] = estimated
            return url, meta

        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: meta for url, meta in results if meta}

    async def related(self, url: str) -> Page:
        """Related videos off the watch page. XVideos ships them as an inline
        `video_related = [...]` JSON array (NOT thumb-block cards), so parse that."""
        import json as _json
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        match = re.search(r"video_related\s*=\s*(\[.*?\])\s*;", html, re.S)
        if not match:
            return Page(items=[], has_more=False)
        try:
            rows = _json.loads(match.group(1))
        except Exception:  # noqa: BLE001
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items: list[dict] = []
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            watch = urllib.parse.urljoin(_ORIGIN, str(row.get("u") or "")).split("?", 1)[0]
            if not watch or watch.rstrip("/") == current or watch in seen:
                continue
            seen.add(watch)
            duration_sec = int(row.get("d") or 0) if str(row.get("d") or "").isdigit() else \
                _duration_from_text(str(row.get("d") or ""))
            height = 2160 if str(row.get("hp") or row.get("h") or "").lower() in ("4k", "2160") else 0
            items.append(Tile(
                id=str(row.get("id") or row.get("eid") or watch),
                title=str(row.get("t") or row.get("tf") or "XVideos video").strip(),
                url=watch,
                thumb=str(row.get("if") or row.get("il") or row.get("i") or ""),
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                quality="4K" if height >= 2160 else "",
                height=height,
                hd=height >= 720,
            ).to_dict())
        return Page(items=items[:36], has_more=False, extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        from ..extractors.xvideos import XVideosExtractor

        data = await XVideosExtractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("XVideos: stream sa nepodarilo získať")
        stream_url = data["stream_url"]
        return {
            "stream_url": stream_url,
            "is_hls": bool(data.get("is_hls")) or ".m3u8" in str(stream_url).lower(),
            "title": data.get("title") or "XVideos video",
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
