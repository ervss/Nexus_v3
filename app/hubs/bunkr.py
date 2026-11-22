"""Bunkr Hub adapter for the unified Fusion Hub.

Bunkr (balbums.st + bunkrr.pics) is structurally unlike every other adapter:
there is no per-video watch page, only albums full of files. The scraping,
paging (cursor-based on the API, page-based on balbums.st) and per-album stats
already live in the standalone Discovery Hub (`app/main.py`, the `_dh_*`
helpers + `discovery_hub_bunkr()` + `_album_files_events()`), built and tuned
across many sessions — reimplementing that here would either duplicate ~2000
lines or ship a worse copy. This adapter is a thin translation layer: it calls
those functions directly and maps their item shape onto `Tile`.

  * search()/browse()  -> discovery_hub_bunkr(mode=..., query=...)
      - a query        -> mode="files"  (file-level results, same as the
                          Discovery Hub "Súbory" tab; these ARE Tiles already)
      - sort="popular"/"hottest"/"top_rated" -> mode="trending"
      - no query, else  -> mode="latest"
    "album" rows (no query, trending/latest modes serve albums, not files) are
    expanded into their member files via related(), not returned directly —
    the HubAdapter contract is one row = one playable thing.
  * related(album_url) -> discovery_hub_album_files() unrolled to Tiles.
  * resolve()           -> BunkrExtractor (file or album URL -> stream_url).
  * enrich()            -> discovery_hub_refetch_meta's per-file logic, reused
                            via BunkrExtractor + mp4_probe for rows that came
                            back from trending/latest without duration/height.
"""
from __future__ import annotations

import asyncio
from typing import Any

from .base import HubAdapter, Page, Tile, secs_to_pretty


def _item_to_tile(item: dict) -> dict:
    """Map a Discovery Hub bunkr item (_dh_make_item shape) onto a Tile."""
    height = int(item.get("height") or 0)
    duration_sec = int(item.get("duration") or 0)
    size_mb = None
    size_bytes = item.get("size_bytes") or item.get("total_size_bytes") or 0
    if size_bytes:
        size_mb = round(int(size_bytes) / (1024 * 1024), 1)
    quality = item.get("quality") or ""
    if not quality and height:
        quality = f"{height}p" if height < 2000 else "4K"
    added = item.get("first_upload_at") or item.get("created_at") or ""
    file_count = int(item.get("file_count") or 0)
    title = item.get("title") or "Bunkr"
    if item.get("type") == "album" and file_count:
        title = f"{title} ({file_count} súborov)"
    return Tile(
        id=str(item.get("id") or item.get("url") or ""),
        title=title,
        url=item.get("url") or item.get("canonical_url") or "",
        thumb=item.get("thumbnail") or "",
        duration_sec=duration_sec,
        duration=secs_to_pretty(duration_sec),
        quality=quality,
        height=height,
        size_mb=size_mb,
        hd=height >= 720,
        added=added,
        enriched=bool(item.get("enriched")) or bool(duration_sec or height),
    ).to_dict()


def _is_playable(item: dict) -> bool:
    """Albums with no member-file listing yet aren't a Tile the player can open."""
    return (item.get("type") or "") in {"video", "file"}


class BunkrHub(HubAdapter):
    source = "bunkr"
    label = "Bunkr"
    needs_enrich = True
    # CDN hosts are per-file signed subdomains (media-files*.bunkr.*, *.scdn.st, …)
    # decided at resolve time — no fixed allowlist can name them in advance, so the
    # media/stream proxy check in app/routers/hub.py is intentionally left open
    # (empty media_hosts = no host check, same as it would be for any dynamic CDN).
    media_hosts = ()
    stream_referer = "https://bunkr.cr/"
    supported_sorts = ("recent", "popular", "hottest")
    # Discovery Hub's own listing already resolves duration/height for "files"
    # mode results (that's what the Album Viewer's per-file enrich patches are
    # for); trending/latest album rows carry none of that until expanded.
    listing_fields = frozenset({"date", "preview"})

    def __init__(self) -> None:
        self._extractor = None
        self._media_client = None
        # url -> (monotonic_ts, base_items); empty list = negative cache for 404/dead albums
        self._album_cache: dict[str, tuple[float, list[dict]]] = {}

    def _get_media_client(self):
        if self._media_client is None or self._media_client.is_closed:
            import httpx
            self._media_client = httpx.AsyncClient(
                timeout=httpx.Timeout(12.0),
                follow_redirects=True,
                verify=False,
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            )
        return self._media_client

    def _get_extractor(self):
        if self._extractor is None:
            from ..extractors.bunkr import BunkrExtractor
            self._extractor = BunkrExtractor()
        return self._extractor

    @staticmethod
    def _mode_for(query: str, sort: str) -> str:
        if query:
            return "files"
        if sort in {"popular", "hottest", "top_rated", "most_viewed"}:
            return "trending"
        return "latest"

    async def _call_discovery_hub(self, *, query: str, mode: str, page: int) -> dict:
        from .. import main as _app_main
        return await _app_main.discovery_hub_bunkr(query=query, mode=mode, page=page)

    async def _album_base_items(self, url: str) -> list[dict]:
        """Just the album's file listing — one page fetch, no per-file enrich.

        `_album_files_events` yields a cheap "base" event (the listing) before
        it starts resolving each file's stream/duration/size one at a time —
        that per-file pass is what `discovery_hub_album_files` (used by
        `related()`) blocks on, and on a 1000+ file album that's minutes, not
        seconds. The grid only needs titles/thumbs/urls to render tiles, so it
        takes the base event and cancels the generator instead of draining it.
        """
        import time
        now = time.monotonic()
        cached = self._album_cache.get(url)
        if cached is not None:
            ts, cached_items = cached
            ttl = 600.0 if cached_items else 300.0
            if now - ts < ttl:
                return cached_items

        from .. import main as _app_main
        result: list[dict] = []
        async for ev in _app_main._album_files_events(url, limit=0):
            if ev.get("type") == "base":
                result = ev.get("items") or []
                break
            if ev.get("type") == "error":
                result = []
                break

        self._album_cache[url] = (now, result)
        if len(self._album_cache) > 500:
            # Evict oldest entry to keep memory bounded
            oldest = next(iter(self._album_cache))
            self._album_cache.pop(oldest, None)
        return result

    async def search(self, query: str, *, sort: str = "", page: int = 1,
                     **filters: Any) -> Page:
        page = max(1, int(page or 1))
        query = (query or "").strip()
        mode = self._mode_for(query, sort or "")
        data = await self._call_discovery_hub(query=query, mode=mode, page=page)
        # NB: this endpoint's field is "results", not "items" — mixing the two
        # up silently returns an empty page (see memory: discovery-hub-sort-
        # thumbnail-bug.md, the same trap bit the frontend once already).
        raw_items = data.get("results") or []

        # trending/latest hand back albums; a bare album isn't a playable Tile,
        # so surface its files instead (bounded — an album can hold hundreds).
        # Use the cheap base listing (no per-file enrich) so a page of ~30-60
        # albums resolves in a few seconds instead of minutes; the grid's own
        # enrich() pass (below) fills quality/duration for the visible tiles.
        sem = asyncio.Semaphore(6)

        async def _expand(url: str) -> list[dict]:
            async with sem:
                try:
                    base_items = await asyncio.wait_for(self._album_base_items(url), timeout=6.0)
                except Exception:
                    return []
            return [_item_to_tile(it) for it in base_items[:24] if _is_playable(it)]

        items: list[dict] = []
        to_expand = []
        for item in raw_items:
            if _is_playable(item):
                items.append(_item_to_tile(item))
            elif item.get("url"):
                to_expand.append(item["url"])

        # Expand albums in small waves and stop as soon as we have enough tiles
        # for the page (60). Expanding all 40-60 albums when 3-5 already yield 60+
        # files was the main cause of >25s browse latency.
        if to_expand and len(items) < 60:
            batch_size = 6
            for i in range(0, min(len(to_expand), 18), batch_size):
                if len(items) >= 60:
                    break
                batch = to_expand[i:i + batch_size]
                expanded_lists = await asyncio.gather(
                    *[_expand(u) for u in batch], return_exceptions=False
                )
                for lst in expanded_lists:
                    items.extend(lst)
                    if len(items) >= 60:
                        break

        # Sibling adapters hand back ~30-60 tiles/page; unrolled albums can
        # dwarf that (60 albums x 24 files = 1440), so trim to match rather
        # than flooding the grid with one page's worth of results.
        had_more_locally = len(items) > 60
        items = items[:60]

        has_more = had_more_locally or bool(data.get("has_more", bool(raw_items)))
        return Page(
            items=items,
            page=page,
            has_more=has_more,
            total=data.get("total") or data.get("available_total"),
            extra={"source": self.source, "mode": mode},
        )

    async def browse(self, *, sort: str = "", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        return await self.search("", sort=sort, page=page, **filters)

    async def related(self, url: str) -> Page:
        """Unroll a Bunkr album into its member files."""
        from .. import main as _app_main
        data = await _app_main.discovery_hub_album_files(url=url)
        items = [
            _item_to_tile(item) for item in (data.get("items") or [])
            if _is_playable(item) or item.get("url")
        ]
        return Page(items=items, has_more=False,
                    extra={"related_mode": "album-files", "album_url": url})

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        """Resolve duration/height/size for file rows still missing them."""
        extractor = self._get_extractor()
        sem = asyncio.Semaphore(6)

        async def _one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    result = await extractor.extract(url)
                except Exception:
                    return url, {}
            if not result:
                return url, {}
            height = int(result.get("height") or 0)
            duration_sec = int(result.get("duration") or 0)
            quality = f"{height}p" if 0 < height < 2000 else ("4K" if height >= 2000 else "")
            return url, {
                "quality": quality,
                "height": height,
                "duration_sec": duration_sec,
                "size_mb": None,
            }

        pairs = await asyncio.gather(*[_one(u) for u in urls], return_exceptions=False)
        return {url: data for url, data in pairs if data}

    async def resolve(self, url: str) -> dict:
        data = await self._get_extractor().extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("Bunkr: stream sa nepodarilo získať")
        return {
            "stream_url": data["stream_url"],
            "is_hls": bool(data.get("is_hls")),
            "title": data.get("title") or "Bunkr súbor",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        # No raise_for_status(): a dead/expired thumbnail (common on Bunkr — the
        # CDN prunes them independently of the album) should surface as the
        # router's "Empty media" 404 for an empty body, not a fake 502 "gateway
        # failure" that reads as a proxy/network problem it isn't.
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
        referer = "https://findr.to/" if "findr.to" in host else self.stream_referer
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
            "Referer": referer,
        }
        client = self._get_media_client()
        try:
            resp = await client.get(url, headers=headers)
            if resp.status_code < 400 and resp.content:
                return resp.content, resp.headers.get("content-type", "application/octet-stream")
        except Exception:
            pass

        # Fallback to curl_cffi for CDN edges that reject httpx's TLS fingerprint.
        def _cf_get():
            from curl_cffi import requests as cr
            r = cr.get(url, headers=headers, impersonate="chrome", timeout=12, allow_redirects=True)
            if r.status_code < 400 and r.content:
                return r.content, r.headers.get("content-type", "application/octet-stream")
            return b"", "application/octet-stream"

        try:
            return await asyncio.to_thread(_cf_get)
        except Exception:
            return b"", "application/octet-stream"
