"""PornTrex adapter for the unified Fusion Hub."""
from __future__ import annotations

import re
import urllib.parse
from typing import Optional

from .base import Page
from .kvs import KvsHub

_PLAYLIST_PAGE_SIZE = 60


class PornTrexHub(KvsHub):
    source = "porntrex"
    label = "PornTrex"
    origin = "https://www.porntrex.com"
    video_re = re.compile(r"/video/\d+(?:/|$)", re.I)
    category_kind = "categories"
    card_class_re = re.compile(r"video-item", re.I)
    media_hosts = ("porntrex.com", "cdntrex.com")
    stream_referer = "https://www.porntrex.com/"
    # Measured live 2026-07-25: every card carries duration/height/views/date, but
    # the hover preview is loaded lazily by JS and never appears in the raw HTML.
    listing_fields = frozenset({"duration", "date", "height", "views"})
    curated_categories = (
        ("4k-porn", "4K"), ("hd", "HD"), ("amateur", "Amateur"), ("milf", "MILF"),
        ("pov", "POV"), ("anal", "Anal"), ("lesbian", "Lesbian"),
        ("mature", "Mature"), ("big-tits", "Big Tits"), ("asian", "Asian"),
        ("ebony", "Ebony"), ("vr", "VR"),
    )

    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:  # type: ignore[override]
        # PornTrex playlist pages lazy-load their videos — the raw HTML only holds
        # ~4 preview cards, so the KVS base parser undercounts badly. The full list
        # comes from the KVS ajax block `playlist_view_playlist_view`, which returns
        # the WHOLE playlist in one call. Fetch it once, then paginate client-side
        # so the grid isn't flooded. Live-verified 2026-07-14 (937/936 videos).
        raw = urllib.parse.unquote((pid or "").strip())
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", raw, re.I)
        if not match:
            raise ValueError("Neplatné ID playlistu")
        clean_id = f"{match.group(1)}/{match.group(2)}"
        page = max(1, int(page or 1))

        base = f"{self.origin}/playlists/{clean_id}/"
        ajax = (f"{base}?mode=async&function=get_block"
                f"&block_id=playlist_view_playlist_view"
                f"&sort_by=added2fav_date&from=1")
        cache_key = f"pl::{clean_id}"
        cached = self._page_cache.get(cache_key)
        import time as _t
        if cached and _t.monotonic() - cached[0] < self.cache_seconds:
            items = cached[1]
        else:
            status, html, _ = await self._get_html(ajax, referer=base)
            if status != 200:
                raise RuntimeError(f"HTTP {status}")
            items = self._parse_tiles(html)
            # If ajax somehow yielded nothing, fall back to the base HTML parser.
            if not items:
                return await super().playlist_videos(pid, page=page)
            self._page_cache[cache_key] = (_t.monotonic(), items)

        # Derive a readable name from the slug.
        name = match.group(2).replace("-", " ").title()
        start = (page - 1) * _PLAYLIST_PAGE_SIZE
        window = items[start:start + _PLAYLIST_PAGE_SIZE]
        return Page(items=window, page=page,
                    has_more=(start + _PLAYLIST_PAGE_SIZE) < len(items),
                    total=len(items),
                    extra={"view": "playlist", "pid": clean_id, "name": name})

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.porntrex import PorntrexExtractor
        return await PorntrexExtractor().extract(url)
