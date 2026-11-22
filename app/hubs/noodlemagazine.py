"""NoodleMagazine adapter for the unified Fusion Hub.

Not a KVS site, so this is a standalone HubAdapter.

Live-verified DOM facts (re-captured 2026-07-17, full card this time):
  * listing card selector `.item`  (24 per page)
  * `a.item_link` href is the relative `/watch/{owner_id}_{video_id}` form. The card has
    NO `data-nvs-url` — 0 of 24 carry it, despite an earlier note claiming otherwise —
    so the href is the only source of the watch URL.
  * inner `.i_img` carries `data-trailer_url` (a preview mp4)
  * per-card meta each sits in its own node: `.i_info .title` (clean title),
    `.m_time` (duration), `.m_views` (VIEW count — the eye icon; NOT a file size),
    `.hd_mark` (HD flag, 23 of 24)
  * search URL is `/video/{query}`, pagination is `?p={n}`  (NOT `?page=`)
  * watch page exposes `window.playlist` for the stream and an ld+json VideoObject
    with `uploadDate` / `thumbnailUrl`; `og:video` is an nmcorp embed player URL

Card meta is read from those exact nodes rather than from the card's whole text: the
title selector must not be a comma group like `a.title, .title, a.item_link`, because
soupsieve returns the first match in DOCUMENT order (the wrapping `a.item_link`), which
made every title come out as "HD 38.22M 43:40 <real title>".

`resolve` reuses the existing `NoodleMagazineExtractor`, which already handles Cloudflare
via curl_cffi impersonation.

No `_fetch_categories()` on purpose: NoodleMagazine has no category taxonomy to scrape.
`/categories` and `/tags` both 404, and the only in-page links are `/video/{term}`
related-searches plus the `/new-video`, `/popular/month`, `/now` sort modes. A curated
chip list would be invented, not sourced, so `categories()` legitimately returns [].
"""
from __future__ import annotations

import asyncio
import re
import threading
import urllib.parse
from typing import Any

from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, iso_duration_to_secs, secs_to_pretty
from .kvs import ENRICH_MAX

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_ORIGIN = "https://noodlemagazine.com"
#: `.item` cards per /video/{term} page — the same 24 on every page and every
#: term, which makes it the only end-of-listing signal this site offers.
_PAGE_SIZE = 24


def _duration_from_text(text: str) -> int:
    m = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?", text or "")
    if not m:
        return 0
    if m.group(3) is not None:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
    return int(m.group(1)) * 60 + int(m.group(2))


class NoodleMagazineHub(HubAdapter):
    source = "noodlemagazine"
    label = "NoodleMagazine"
    needs_enrich = True
    media_hosts = ("noodlemagazine.com", "adult.noodlemagazine.com",
                   "pvvstream.pro", "cdn2.pvvstream.pro", "nmcorp.video")
    stream_referer = "https://noodlemagazine.com/"
    #: NoodleMagazine has no sort at all on its listing: `?s=`, `?sort=` and every
    #: value of either were checked live 2026-07-25 and returned byte-identical
    #: card ids. `/now` and `/new-video` are separate feeds that take no search
    #: term, so they cannot back a sort button either — hence the default only.
    supported_sorts = ("recent",)
    #: `.m_time`, `.m_views` and the `.i_img[data-trailer_url]` preview. The card
    #: shows only an HD flag, never a height, and carries no upload date.
    listing_fields = frozenset({"duration", "views", "preview"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self.cache_seconds = 45
        # One curl_cffi Session per thread, not a shared pool: Sessions are unsafe
        # under concurrent use while each request here owns its asyncio.to_thread
        # worker outright — so no lock, and one TLS handshake per thread.
        self._local = threading.local()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            # Cloudflare-fronted: impersonate a real Chrome TLS fingerprint.
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

    def _list_url(self, query: str, page: int) -> str:
        # Live-verified: /video/{query} with ?p={n} paging. The site is a client-
        # rendered SPA — the homepage and a bare /video/ both serve an empty shell
        # (no .item cards) over plain HTTP, but /video/{any-term} is server-rendered
        # with a real listing regardless of whether the term matches anything, so
        # a query-less browse falls back to a fixed term instead of the bare path.
        term = (query or "").strip() or "new"
        slug = urllib.parse.quote(term)
        base = f"{_ORIGIN}/video/{slug}"
        return base if page <= 1 else f"{base}?p={page}"

    def _parse_tiles(self, html: str) -> list[dict]:
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        for card in soup.select(".item"):
            link = card.select_one("a.item_link") or card.find("a", href=True)
            href = (link.get("href") or "") if link else ""
            if "/watch/" not in href:
                continue
            url = urllib.parse.urljoin(_ORIGIN, href).split("?", 1)[0]
            if not url or url in seen:
                continue
            seen.add(url)

            image = card.select_one(".i_img img") or card.find("img")
            thumb = ""
            if image:
                thumb = (image.get("data-src") or image.get("src") or "").strip()
                if thumb.startswith("data:"):
                    thumb = ""

            holder = card.select_one(".i_img")
            preview = (holder.get("data-trailer_url") or "") if holder else ""

            # Scoped to .i_info so the wrapping anchor's text (which includes the HD /
            # views / duration badges) can never stand in for the title.
            title_el = card.select_one(".i_info .title")
            title = title_el.get_text(" ", strip=True) if title_el else ""
            if not title and image:
                title = (image.get("alt") or "").strip()
            if not title:
                title = "NoodleMagazine video"

            time_el = card.select_one(".m_time")
            duration_sec = _duration_from_text(
                time_el.get_text(" ", strip=True) if time_el else "")

            views_el = card.select_one(".m_views")
            views = views_el.get_text(" ", strip=True) if views_el else ""

            video_id = url.rstrip("/").split("/")[-1]
            items.append(Tile(
                id=video_id or url,
                title=title,
                url=url,
                thumb=thumb,
                preview=preview,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                views=f"{views} views" if views else "",
                hd=bool(card.select_one(".hd_mark")),
            ).to_dict())
        return items

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        import time

        page = max(1, int(page or 1))
        term = query.strip() or category.strip()
        url = self._list_url(term, page)
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]

        started = time.perf_counter()
        status, html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"NoodleMagazine HTTP {status}")
        items = self._parse_tiles(html)
        # The SPA renders its pager client-side, so there is no next-page anchor to
        # look for: a short page is the end. `bool(items)` never was — it kept
        # promising more after the listing had run out.
        result = Page(items=items, page=page, has_more=len(items) >= _PAGE_SIZE,
                      took_ms=int((time.perf_counter() - started) * 1000),
                      extra={"source": self.source, "page_url": url})
        self._page_cache[url] = (time.monotonic(), result)
        return result

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
        """Watch page -> real height, file size, tags and upload date.

        The listing carries no resolution at all (just an HD flag), which is exactly
        what `needs_enrich = True` promises to fill in — and this adapter previously
        inherited the no-op `enrich()`, so the UI's "Full metadata" pass reported every
        tile as failed forever.

        Everything needed is already inline on the watch page, so no yt-dlp/resolve pass
        is involved: `window.playlist.sources[]` has one entry per rendition with `label`
        = the height, and the ld+json VideoObject has `duration` / `uploadDate` /
        `keywords`. Only the size needs a HEAD, against the signed URL the page just
        handed us (~0.1s, and gated by the same semaphore as the page fetch).
        """
        if not urls:
            return {}
        import json as _json

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
                for match in re.finditer(
                        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
                        html, re.S | re.I):
                    try:
                        data = _json.loads(match.group(1).strip())
                    except Exception:  # noqa: BLE001
                        continue
                    if isinstance(data, list):
                        data = next((d for d in data if isinstance(d, dict)), None)
                    if not isinstance(data, dict):
                        continue
                    duration = iso_duration_to_secs(str(data.get("duration") or ""))
                    if duration:
                        meta["duration_sec"] = duration
                    upload = str(data.get("uploadDate") or "")
                    if upload:
                        meta["added"] = upload[:10]
                    keywords = data.get("keywords") or []
                    if isinstance(keywords, str):
                        keywords = [k.strip() for k in keywords.split(",") if k.strip()]
                    if isinstance(keywords, list) and keywords:
                        meta["tags"] = [str(k) for k in keywords[:20]]
                    break

                best_file, height = "", 0
                playlist = re.search(r"window\.playlist\s*=\s*(\{.*?\})\s*;", html, re.S)
                if playlist:
                    try:
                        sources = _json.loads(playlist.group(1)).get("sources") or []
                    except Exception:  # noqa: BLE001
                        sources = []
                    for source in sources:
                        label = int(re.sub(r"\D", "", str(source.get("label") or "")) or 0)
                        if label > height:
                            height, best_file = label, str(source.get("file") or "")
                if height:
                    meta["height"] = height
                    meta["quality"] = "4K" if height >= 2160 else f"{height}p"
                    meta["hd"] = height >= 720

                if best_file:
                    size_bytes = await self._head_size(best_file)
                    if size_bytes:
                        meta["size_mb"] = round(size_bytes / 1048576, 1)
                        # HEAD content-length on the signed rendition URL the page
                        # just handed us — measured, not derived from a bitrate.
                        meta["size_estimated"] = False
                return url, meta

        results = await asyncio.gather(*(one(u) for u in list(urls)[:ENRICH_MAX]))
        return {url: meta for url, meta in results if meta}

    async def related(self, url: str) -> Page:
        """Related videos parsed off the watch page (same /video/ card markup)."""
        status, html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [it for it in self._parse_tiles(html) if it.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False, extra={"related_mode": "same-source"})

    async def resolve(self, url: str) -> dict:
        from ..extractors.noodlemagazine import NoodleMagazineExtractor

        data = await NoodleMagazineExtractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("NoodleMagazine: stream sa nepodarilo získať")
        stream_url = data["stream_url"]
        return {
            "stream_url": stream_url,
            "is_hls": bool(data.get("is_hls")) or ".m3u8" in str(stream_url).lower(),
            "title": data.get("title") or "NoodleMagazine video",
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
