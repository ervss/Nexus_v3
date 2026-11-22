"""SpankBang adapter for the unified Fusion Hub.

Not a KVS gallery-engine site and not JSON-hydrated either: the current SpankBang
front-end is server-rendered Tailwind + Alpine.js, so the listing is real HTML.
Everything below was captured from live responses on 2026-07-25.

Cloudflare (the one fact everything else depends on)
----------------------------------------------------
spankbang.com sits behind a Cloudflare *interactive* managed challenge. Every
`impersonate="chrome*"` / `safari*` / `edge*` fingerprint curl_cffi offers is
answered with **HTTP 403 "Just a moment..."** — including the `impersonate="chrome"`
this codebase uses for every other adapter. `impersonate="firefox"` sails through
with a 200 on the same URL, same headers, same second (measured across 10
fingerprints × 4 URLs). So this is the one hub that must NOT copy the chrome
convention; it copies the *session-per-thread* convention instead.

The challenge is also sticky per session: once a Session is served the interstitial
it keeps getting it, so `_get_html` throws the session away and retries with a fresh
one rather than looping on a poisoned cookie jar.

No age gate / consent wall
--------------------------
A brand-new cookie-less session gets the real watch page (569 KB, `stream_data`
present) on the first request. The site sets its own `av=simple:True:True` and
`cookie_consent` cookies in the response; nothing has to be sent up front, unlike
RedTube's `age_verified`.

Listing (live-verified 2026-07-25)
----------------------------------
Cards are `div[data-testid="video-item"][data-id="17025835"]`, and every listing
page ships **two** `div.js-media-list` grids:

  * one with the extra class `js-forced-layout` — 8 promoted/"exclusive" tiles that
    are byte-identical on /new_videos/, /s/milf/ and every watch page,
  * the real result grid (64 cards) with no `js-forced-layout`.

Parsing "all video-item nodes" therefore prepends the same 8 sponsored videos to
every single page, which is why `_result_grid` picks the largest grid that is *not*
`js-forced-layout`.

Per card the listing genuinely carries:
  * `a[href*="/video/"][title]`  -> watch URL + full title
  * `img[src]`                   -> tbi.sb-cd.com thumbnail
  * `source[data-src]`           -> tbv.sb-cd.com hover preview (.mp4)
  * `[data-testid=video-item-length]`     -> duration, **minute granularity only**
                                             ("49m", "115m" — never seconds)
  * `[data-testid=video-item-resolution]` -> "HD" or "4K" and nothing else; the
                                             exact height is not in the listing
  * `[data-testid=views]`  -> "220" / "420K"
  * `[data-testid=rates]`  -> "95%"
  * `a[data-testid=title]` -> **the CHANNEL**, not the video title (a real trap:
    the video title lives on the plain `a[title]` a few nodes below it)

There is NO upload date and NO per-card tag list anywhere in the listing markup —
`<time datetime>` and `live_keywords` exist only on the watch page. Hence
`listing_fields` claims duration/preview/views and nothing else, and
`needs_enrich = True`.

Pagination
----------
A trailing PATH segment: `/s/milf/2/`, `/new_videos/2/`. Verified by diffing page 1
against page 2 (first ids `15191843…` vs `10754216…`). `?page=2` answers 200 and
silently re-serves page 1 — the same trap xHamster has. The real end-of-list signal
is `div.pagination`, whose numeric links include the last page ("1000").

Sorts (each one diffed against the default on the SAME query)
-------------------------------------------------------------
Search takes `?o=`:
  * (none) / `?o=all` -> relevance          (default order)
  * `?o=new`          -> newest             DIFFERENT, and still query-filtered
                                            (only 2/64 ids overlap /new_videos/)
  * `?o=top`          -> most viewed        DIFFERENT
  * `?o=popular`      -> byte-identical to `?o=top`
  * `?o=rating`, `?o=views`, `?o=duration`, `?o=length`, `?o=trending`,
    `?sort=…`, `?s=…` -> ALL return the default page unchanged => fake, not declared
Browse uses dedicated landing paths instead (`?o=` is not a thing there):
  /trending_videos/ , /new_videos/ , /most_popular/ — all three verified distinct.
A category is just `/s/{tag}/`, so it inherits the search vocabulary.
Only the three sorts that exist in ALL of search, browse and category are declared.

Extra real filters (accepted via **filters, never guessed): `?q=hd|fhd|uhd`
(720p/1080p/4k) and `?d=10|20|40` (minimum minutes).

Categories
----------
`/tags` -> `ul.top_tags_list li a.keyword` = 87 curated tags linking to `/s/{slug}/`
(slugs use `+` for spaces: `big+ass`). The page also carries ~2000 long-tail
`a.keyword` links further down; only the curated block is used.

Watch page -> stream
--------------------
`<script>var stream_data = {...};</script>` — a *Python-style* dict literal (single
quotes) with a real, playable MP4 per rendition:

    '720p': ['https://vdownload-46.sb-cd.com/1/7/17025835-720p.mp4?secure=…,1784995021&m=46&d=1&_tid=17025835']
    '4k'  : [...]  'm3u8': ['https://hls-uranus.sb-cd.com/hls/…/master.m3u8?secure=…']
    'length': 481   'thumbnail': 'https://tbi.sb-cd.com/…'   'main': [...]

Verified end-to-end: a `HEAD` on the 4K rendition of /4nnkw/video/… returned
`200 content-length: 183424614 video/mp4`. Empty lists mean "that rendition does not
exist" — a 720p-only upload has `'1080p': []`. The `secure=` token embeds an expiry
(~12 h), so `resolve()` must stay JIT; it is never cached.

Hotlink policy (checked with AND without `Referer: https://spankbang.com/`)
--------------------------------------------------------------------------
tbi.sb-cd.com (thumbs), tbv.sb-cd.com (previews), vdownload-*.sb-cd.com (mp4) and
hls-uranus.sb-cd.com (m3u8) all answered 206/200 with NO Referer, and under the
chrome fingerprint too (the CDN is not Cloudflare-fronted). SpankBang therefore does
NOT need to be in the frontend's proxy-first list; `fetch_media` exists only as the
generic fallback path.
"""
from __future__ import annotations

import ast
import asyncio
import re
import threading
import time
import urllib.parse
from typing import Any

from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, keywords_from_title, secs_to_pretty
from .kvs import ENRICH_MAX

_ORIGIN = "https://spankbang.com"
#: Firefox UA, to match the ONLY TLS fingerprint Cloudflare lets through here.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) "
       "Gecko/20100101 Firefox/133.0")
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
}
#: A full result grid is 64 cards on feed, search and category alike.
_PAGE_SIZE = 64
#: The Cloudflare interstitial — a 200 is not enough, this text must be absent.
_CHALLENGE_RE = re.compile(r"Just a moment\.\.\.|__cf_chl_opt", re.I)
_WATCH_RE = re.compile(r"^/[a-z0-9]+/video/", re.I)
#: `var stream_data = {...};` — single-quoted, i.e. a Python literal, not JSON.
_STREAM_RE = re.compile(r"var\s+stream_data\s*=\s*(\{.*?\})\s*;", re.S)
_TIME_RE = re.compile(r'<time\s+datetime="([0-9]{4}-[0-9]{2}-[0-9]{2})')
_KEYWORDS_RE = re.compile(r"var\s+live_keywords\s*=\s*'([^']*)'")

#: search / category order values. See the module docstring: everything not listed
#: here was measured returning the default page unchanged.
_SEARCH_ORDER = {
    "relevance": "",
    "recent": "new",
    "most_viewed": "top",
}
#: browse has no `?o=`; each order is its own landing path.
_BROWSE_PATH = {
    "relevance": "/trending_videos/",
    "recent": "/new_videos/",
    "most_viewed": "/most_popular/",
}
#: `?q=` quality filter, straight out of the site's own dropdown JSON.
_QUALITY_FILTER = {"720": "hd", "720p": "hd", "hd": "hd",
                   "1080": "fhd", "1080p": "fhd", "fhd": "fhd",
                   "2160": "uhd", "4k": "uhd", "uhd": "uhd"}
#: rendition key -> height, best first. Keys are exactly what stream_data uses.
_RENDITIONS = (("4k", 2160), ("1080p", 1080), ("720p", 720),
               ("480p", 480), ("320p", 320), ("240p", 240))


def _duration_from_badge(text: str) -> int:
    """"49m" -> 2940. The listing badge is minutes-only; `1h 5m` is handled anyway."""
    text = (text or "").strip().lower()
    hours = re.search(r"(\d+)\s*h", text)
    minutes = re.search(r"(\d+)\s*m", text)
    seconds = re.search(r"(\d+)\s*s\b", text)
    total = (int(hours.group(1)) * 3600 if hours else 0)
    total += (int(minutes.group(1)) * 60 if minutes else 0)
    total += (int(seconds.group(1)) if seconds else 0)
    if total:
        return total
    match = re.search(r"(\d+):(\d{2})", text)
    return int(match.group(1)) * 60 + int(match.group(2)) if match else 0


class SpankBangHub(HubAdapter):
    source = "spankbang"
    label = "SpankBang"
    #: The listing badge is "HD"/"4K", never a height, and carries no date and no
    #: tags — all three come from the watch page, so the enrich pass is real work.
    needs_enrich = True
    #: The exact byte size needs one extra HEAD on the signed CDN URL -> opt-in.
    supports_deep_enrich = True
    #: Live-verified: none of these hotlink-protect, so the media proxy is a
    #: fallback rather than the default path.
    media_hosts = ("spankbang.com", "sb-cd.com")
    stream_referer = "https://spankbang.com/"
    supported_sorts = ("relevance", "recent", "most_viewed")
    #: duration is minute-granular but real; preview is the site's own hover clip;
    #: views is on every card. No `date`, no `tags`, no `height` — see the docstring.
    listing_fields = frozenset({"duration", "preview", "views"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self.cache_seconds = 45
        # Same convention as xHamster: one curl_cffi Session per thread (they are
        # not safe for concurrent use, and every request here runs inside
        # asyncio.to_thread), so an enrich pass reuses one TLS handshake instead of
        # paying 24 of them.
        self._local = threading.local()

    # ── HTTP ────────────────────────────────────────────────────────────────
    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            # firefox, NOT chrome: chrome/edge/safari fingerprints are all 403'd by
            # the Cloudflare managed challenge on this host. Verified 2026-07-25.
            session = cr.Session(impersonate="firefox")
            self._local.session = session
        return session

    async def _get_html(self, url: str, *, tries: int = 3) -> tuple[int, str]:
        """GET with a Cloudflare-challenge retry that DISCARDS the poisoned session.

        The interstitial sticks to whichever session received it (a challenged
        session keeps being challenged on every following URL), so retrying on the
        same Session is guaranteed to fail — the session is dropped instead.
        """
        def _do() -> tuple[int, str]:
            status, text = 0, ""
            for _ in range(max(1, tries)):
                try:
                    response = self._session().get(
                        url, headers=_HEADERS, timeout=25, allow_redirects=True)
                except Exception:  # noqa: BLE001 — a dead socket is also retryable
                    self._local.session = None
                    continue
                status, text = response.status_code, response.text
                if status == 200 and not _CHALLENGE_RE.search(text[:6000]):
                    return status, text
                self._local.session = None
            return status, text
        return await asyncio.to_thread(_do)

    # ── URLs ────────────────────────────────────────────────────────────────
    @staticmethod
    def _slug(value: str) -> str:
        """"big ass" -> "big+ass" — SpankBang's own tag/search slug form."""
        return urllib.parse.quote_plus(" ".join((value or "").split()).lower(), safe="+")

    def _list_url(self, query: str, category: str, page: int, sort: str,
                  filters: dict) -> str:
        sort = (sort or "recent").strip().lower()
        page = max(1, int(page or 1))
        term = query or category
        if term:
            base = f"{_ORIGIN}/s/{self._slug(term)}/"
            order = _SEARCH_ORDER.get(sort, "")
            params = {"o": order} if order else {}
        else:
            base = _ORIGIN + _BROWSE_PATH.get(sort, "/new_videos/")
            params = {}  # browse expresses order as the path itself
        if page > 1:
            base = f"{base}{page}/"

        quality = _QUALITY_FILTER.get(str(filters.get("quality") or "").lower())
        if quality:
            params["q"] = quality
        try:
            minutes = int(filters.get("min_minutes") or 0)
        except (TypeError, ValueError):
            minutes = 0
        if minutes >= 40:
            params["d"] = "40"
        elif minutes >= 20:
            params["d"] = "20"
        elif minutes >= 10:
            params["d"] = "10"
        return base + ("?" + urllib.parse.urlencode(params) if params else "")

    # ── parsing ─────────────────────────────────────────────────────────────
    @staticmethod
    def _result_grid(soup):
        """The REAL result grid.

        Every page carries a `js-forced-layout` grid of 8 promoted tiles that is
        identical everywhere (same 8 ids on /new_videos/, /s/milf/ and watch pages).
        Taking all `[data-testid=video-item]` nodes would paste those 8 sponsored
        videos on top of every result set, so they are excluded by class and the
        biggest remaining grid wins.
        """
        grids = [g for g in soup.select("div.js-media-list")
                 if "js-forced-layout" not in (g.get("class") or [])]
        if not grids:
            return None
        return max(grids, key=lambda g: len(g.select("[data-testid=video-item]")))

    def _tile_from_card(self, card) -> dict | None:
        # The video title is on the plain `a[title]`; `a[data-testid=title]` is the
        # CHANNEL link, which is why it is matched separately below.
        link = None
        for anchor in card.select("a[href]"):
            if _WATCH_RE.match((anchor.get("href") or "").split("?", 1)[0]):
                link = anchor
                break
        if link is None:
            return None
        url = urllib.parse.urljoin(_ORIGIN, link.get("href").split("?", 1)[0])

        title = ""
        for anchor in card.select("a[title]"):
            if _WATCH_RE.match((anchor.get("href") or "").split("?", 1)[0]):
                title = (anchor.get("title") or "").strip()
                if title:
                    break
        image = card.find("img")
        if not title and image:
            title = (image.get("alt") or "").strip()
        if not title:
            slug = urllib.parse.unquote_plus(url.rstrip("/").split("/")[-1])
            title = slug.strip().capitalize() or "SpankBang video"

        thumb = ""
        if image:
            thumb = (image.get("src") or image.get("data-src") or "").strip()
            if thumb.startswith("data:"):
                thumb = ""
        source_tag = card.select_one("video source[data-src], video source[src]")
        preview = ((source_tag.get("data-src") or source_tag.get("src") or "").strip()
                   if source_tag else "")

        length_el = card.select_one("[data-testid=video-item-length]")
        duration_sec = _duration_from_badge(length_el.get_text(" ", strip=True)
                                            if length_el else "")

        badge_el = card.select_one("[data-testid=video-item-resolution]")
        badge = (badge_el.get_text(" ", strip=True) if badge_el else "").upper()
        # Only "4K" carries a real height. "HD" means ">=720 somewhere" and nothing
        # more, so height stays 0 (unknown) rather than being invented as 720.
        height = 2160 if "4K" in badge else 0

        views_el = card.select_one("[data-testid=views]")
        views = views_el.get_text(" ", strip=True) if views_el else ""
        rates_el = card.select_one("[data-testid=rates]")
        rating = rates_el.get_text(" ", strip=True) if rates_el else ""

        channel = card.select_one("a[data-testid=title][href]")
        uploader = channel.get_text(" ", strip=True) if channel else ""
        uploader_url = (urllib.parse.urljoin(_ORIGIN, channel.get("href"))
                        if channel else "")

        return Tile(
            id=str(card.get("data-id") or url),
            title=title,
            url=url,
            thumb=thumb,
            preview=preview,
            duration_sec=duration_sec,
            duration=secs_to_pretty(duration_sec),
            views=f"{views} views" if views else "",
            rating=rating,
            uploader=uploader,
            uploader_url=uploader_url,
            quality="4K" if height else "",
            height=height,
            hd=bool(badge),
        ).to_dict()

    def _parse_tiles(self, html: str) -> list[dict]:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        grid = self._result_grid(soup)
        if grid is None:
            return []
        items: list[dict] = []
        seen: set[str] = set()
        for card in grid.select("[data-testid=video-item]"):
            tile = self._tile_from_card(card)
            if not tile or tile["url"] in seen:
                continue
            seen.add(tile["url"])
            items.append(tile)
        return items

    @staticmethod
    def _last_page(html: str) -> int:
        """The highest page number `div.pagination` links to (0 = no pager).

        This is the only honest "is there a page N+1" signal: a full 64-card page
        says nothing, and `?page=` re-serving page 1 means a naive "we got tiles"
        check would page forever.
        """
        block = re.search(r'<div class="pagination">(.*?)</div>', html or "", re.S)
        if not block:
            return 0
        numbers = [int(n) for n in re.findall(r">(\d{1,5})</a>", block.group(1))]
        return max(numbers) if numbers else 0

    # ── surfaces ────────────────────────────────────────────────────────────
    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        page = max(1, int(page or 1))
        url = self._list_url((query or "").strip(), (category or "").strip(),
                             page, sort, filters)
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200 or _CHALLENGE_RE.search(html[:6000]):
            raise RuntimeError(
                f"SpankBang HTTP {status}"
                + (" (Cloudflare challenge)" if _CHALLENGE_RE.search(html[:6000]) else ""))
        items = self._parse_tiles(html)
        last = self._last_page(html)
        has_more = (page < last) if last else len(items) >= _PAGE_SIZE
        result = Page(items=items, page=page, has_more=bool(items) and has_more,
                      took_ms=int((time.perf_counter() - started) * 1000),
                      extra={"source": self.source, "page_url": url})
        self._page_cache[url] = (time.monotonic(), result)
        return result

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """`/tags` -> the curated `ul.top_tags_list` block (87 rows, 2026-07-25).

        The same page also holds ~2000 long-tail `a.keyword` links; only the curated
        list is taken, because the rest is search-suggestion noise ("lil tay
        onlyfans") rather than a taxonomy. Slugs keep SpankBang's `+` form, which is
        exactly what `/s/{slug}/` wants back.
        """
        status, html = await self._get_html(f"{_ORIGIN}/tags")
        if status != 200:
            return []
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        for anchor in soup.select("ul.top_tags_list li a.keyword"):
            match = re.match(r"^/s/([^/]+)/?$", (anchor.get("href") or "").split("?")[0])
            if match:
                rows.append((match.group(1), anchor.get_text(" ", strip=True)))
        return rows

    # ── watch page ──────────────────────────────────────────────────────────
    @staticmethod
    def _stream_data(html: str) -> dict:
        """`var stream_data = {...}` -> dict. It is a Python literal, not JSON.

        `ast.literal_eval` (not `eval`) parses the single-quoted dict safely; a shape
        change just yields {} instead of raising into the caller.
        """
        match = _STREAM_RE.search(html or "")
        if not match:
            return {}
        try:
            data = ast.literal_eval(match.group(1))
        except Exception:  # noqa: BLE001
            return {}
        return data if isinstance(data, dict) else {}

    @staticmethod
    def _best_rendition(stream: dict) -> tuple[str, int]:
        """(mp4_url, height) for the best MP4 the page actually lists.

        Renditions that do not exist are present as EMPTY lists (`'1080p': []`), so
        "the key is there" is not a claim that the file is.
        """
        for key, height in _RENDITIONS:
            urls = stream.get(key)
            if isinstance(urls, list) and urls and isinstance(urls[0], str):
                return urls[0], height
        main = stream.get("main")
        if isinstance(main, list) and main:
            match = re.search(r"-(\d{3,4}p|4k)\.mp4", str(main[0]), re.I)
            height = dict(_RENDITIONS).get((match.group(1).lower() if match else ""), 0)
            return str(main[0]), height
        return "", 0

    async def resolve(self, url: str) -> dict:
        """Watch URL -> a real, signed CDN MP4 (HLS master.m3u8 as the fallback).

        The `secure=` token in those URLs carries its own expiry (~12 h), so this is
        deliberately re-fetched per play and never cached.
        """
        if "spankbang" not in (url or ""):
            raise ValueError("Not a SpankBang URL")
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"SpankBang HTTP {status}")
        stream = self._stream_data(html)
        if not stream:
            raise RuntimeError("SpankBang: stream_data sa nenašlo")

        stream_url, height = self._best_rendition(stream)
        is_hls = False
        if not stream_url:
            hls = stream.get("m3u8")
            if isinstance(hls, list) and hls:
                stream_url, is_hls = str(hls[0]), True
        if not stream_url:
            raise RuntimeError("SpankBang: stream sa nepodarilo získať")

        title_el = re.search(r'data-testid=video-title[^>]*>([^<]+)<', html)
        try:
            duration = int(stream.get("length") or 0)
        except (TypeError, ValueError):
            duration = 0
        return {
            "stream_url": stream_url,
            "is_hls": is_hls or ".m3u8" in stream_url.lower(),
            "title": (title_el.group(1).strip() if title_el else "") or "SpankBang video",
            "duration": duration,
            "thumbnail": str(stream.get("cover_image") or stream.get("thumbnail") or ""),
            "height": height,
        }

    async def enrich(self, urls: list[str], *, deep: bool = False) -> dict[str, dict]:
        """Watch page -> real height, exact duration, upload date and tags.

        Everything the listing cannot give, in ONE request per tile:
          * height   — the best non-empty key in `stream_data` (4k/1080p/720p/…)
          * duration — `stream_data['length']`, exact seconds (the listing rounds
                       to whole minutes)
          * added    — `<time datetime="2026-07-24T00:50:13+00:00">`
          * tags     — `var live_keywords = 'Brittany Bardot,MILF,Wife,…'`

        deep=True adds one HEAD on the signed MP4 for a MEASURED byte size (verified:
        `content-length: 183424614` on a 4K rendition) — a real number, not the
        bitrate estimate HLS-only sources are stuck with, but a second round-trip per
        tile, hence opt-in.
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

            meta: dict = {}
            stream = self._stream_data(html)
            mp4_url, height = self._best_rendition(stream) if stream else ("", 0)
            if height:
                meta["height"] = height
                meta["quality"] = "4K" if height >= 2160 else f"{height}p"
                meta["hd"] = height >= 720
            try:
                duration = int((stream or {}).get("length") or 0)
            except (TypeError, ValueError):
                duration = 0
            if duration:
                meta["duration_sec"] = duration

            date_match = _TIME_RE.search(html)
            if date_match:
                meta["added"] = date_match.group(1)

            kw_match = _KEYWORDS_RE.search(html)
            if kw_match:
                # `live_keywords` mixes real tags with SpankBang's internal flags
                # ("sb_verified" leads the list on verified uploads) — those are
                # site plumbing, not something a user ever searches for.
                tags = [t.strip() for t in kw_match.group(1).split(",")
                        if t.strip() and not t.strip().lower().startswith("sb_")]
                if tags:
                    meta["tags"] = tags[:20]

            if deep and mp4_url:
                size_mb = await self._size_mb(mp4_url)
                if size_mb:
                    meta["size_mb"] = size_mb
            return url, meta

        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: meta for url, meta in results if meta}

    async def _size_mb(self, url: str) -> float | None:
        """Measured size via HEAD on the signed CDN URL. None if the CDN won't say."""
        def _do() -> float | None:
            try:
                response = self._session().head(url, headers={"User-Agent": _UA},
                                                timeout=20, allow_redirects=True)
                length = int(response.headers.get("content-length") or 0)
            except Exception:  # noqa: BLE001
                return None
            return round(length / 1048576, 1) if length else None
        return await asyncio.to_thread(_do)

    async def related(self, url: str) -> Page:
        """Same-source related rail.

        A watch page carries several `js-media-list` rails of its own ("more videos
        like this"), which `_parse_tiles` picks up unchanged — the promoted
        `js-forced-layout` grid is excluded there exactly as on a listing. If that
        yields nothing, fall back to the video's own `live_keywords` (its real tags)
        and finally to `keywords_from_title` on the URL slug, fed back into search.
        """
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._parse_tiles(html)
                 if it.get("url", "").rstrip("/") != current]
        if items:
            return Page(items=items[:36], has_more=False,
                        extra={"source": self.source, "related_mode": "same-source"})

        kw_match = _KEYWORDS_RE.search(html)
        tags = [t.strip() for t in (kw_match.group(1) if kw_match else "").split(",")
                if t.strip()]
        query = " ".join(tags[:3])
        if not query:
            slug = urllib.parse.unquote_plus(url.rstrip("/").split("/")[-1])
            query = keywords_from_title(slug)
        if not query:
            return Page(items=[], has_more=False)
        page = await self.search(query, sort="relevance", page=1)
        page.items = [it for it in page.items
                      if it.get("url", "").rstrip("/") != current][:36]
        page.extra["related_mode"] = "same-source-tags"
        return page

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        """Generic proxy path. Live-verified that none of the sb-cd.com hosts need
        it (they serve with no Referer at all), so this is a safety net, not the
        default route for thumbnails."""
        def _do() -> tuple[bytes, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": self.stream_referer},
                timeout=25)
            return (response.content,
                    response.headers.get("content-type", "application/octet-stream"))
        return await asyncio.to_thread(_do)
