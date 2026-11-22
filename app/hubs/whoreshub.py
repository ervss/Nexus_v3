import asyncio
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup

from .base import Page
from .kvs import KvsHub


class WhoresHub(KvsHub):
    source = "whoreshub"
    label = "WhoresHub"
    origin = "https://www.whoreshub.com"
    video_re = re.compile(r"/videos/\d+(?:/|$)", re.I)
    category_kind = "tags"
    card_class_re = re.compile(r"(?:^|\s)(?:box|thumb)(?:\s|$)", re.I)
    media_hosts = ("whoreshub.com", "cdntrex.com")
    stream_referer = "https://www.whoreshub.com/"
    # Narrower than the KvsHub default: measured live 2026-07-25, this skin's cards
    # carry no resolution badge and print the view count without the word "views",
    # so neither survives the shared parser — claiming them would be a lie.
    listing_fields = frozenset({"duration", "date", "preview"})
    curated_categories = (
        ("4k", "4K"), ("hd", "HD"), ("amateur", "Amateur"), ("milf", "MILF"),
        ("pov", "POV"), ("anal", "Anal"), ("lesbian", "Lesbian"),
        ("mature", "Mature"), ("big-tits", "Big Tits"), ("asian", "Asian"),
        ("ebony", "Ebony"), ("vr", "VR"),
    )

    def _playlist_page_url(self, base: str, page: int) -> str:
        return base if page <= 1 else f"{base}?from={page}"

    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:
        """Load a WhoresHub playlist; whoreshub pages have 8 videos, so we aggregate them in batches of 50."""
        raw = urllib.parse.unquote((pid or "").strip())
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", raw, re.I)
        if not match:
            raise ValueError("Neplatné ID playlistu")
        clean_id = f"{match.group(1)}/{match.group(2)}"
        base = f"{self.origin}/playlists/{clean_id}/"
        page = max(1, int(page or 1))

        BATCH_SIZE = 50
        SITE_PAGE_SIZE = 8
        start_idx = (page - 1) * BATCH_SIZE
        end_idx = page * BATCH_SIZE
        start_site_page = (start_idx // SITE_PAGE_SIZE) + 1
        end_site_page = ((end_idx - 1) // SITE_PAGE_SIZE) + 1

        # Fetch the start_site_page first to get info and total count
        start_url = self._playlist_page_url(base, start_site_page)
        status, html_start, final_url = await self._get_html(start_url)
        if status != 200:
            raise RuntimeError(f"HTTP {status} on URL: {start_url}")

        soup = BeautifulSoup(html_start, "html.parser")
        heading = soup.select_one("h1, .headline h1, .playlist-info .title")
        name = heading.get_text(" ", strip=True) if heading else match.group(2).replace("-", " ").title()

        # Parse total count from the first page HTML
        total_count = 0
        for use in soup.select('use[xlink\\:href="#icon-video"], use[href="#icon-video"]'):
            li = use.find_parent('li')
            if li:
                val = li.select_one('.value')
                if val:
                    try:
                        total_count = int(re.sub(r"\D", "", val.get_text(strip=True)))
                    except ValueError:
                        pass
        
        # Fallback to pagination
        if not total_count:
            pager_links = soup.select('.pagination a[data-parameters]')
            max_from = 1
            for a in pager_links:
                params = a.get('data-parameters', '')
                from_match = re.search(r'from:(\d+)', params)
                if from_match:
                    max_from = max(max_from, int(from_match.group(1)))
            if max_from > 1:
                total_count = max_from * SITE_PAGE_SIZE

        # Now determine other pages in this batch to fetch
        pages_to_fetch = list(range(start_site_page + 1, end_site_page + 1))
        if total_count:
            max_site_pages = ((total_count - 1) // SITE_PAGE_SIZE) + 1
            pages_to_fetch = [p for p in pages_to_fetch if p <= max_site_pages]

        results = []
        if pages_to_fetch:
            results = await asyncio.gather(
                *[self._get_html(self._playlist_page_url(base, p)) for p in pages_to_fetch],
                return_exceptions=True
            )

        # Parse items
        all_fetched_items = []
        start_items = self._parse_tiles(html_start)
        all_fetched_items.extend(start_items)

        for r in results:
            if isinstance(r, Exception) or r[0] != 200:
                continue
            all_fetched_items.extend(self._parse_tiles(r[1]))

        # Slice the items to match the exact BATCH_SIZE request
        relative_start = start_idx - (start_site_page - 1) * SITE_PAGE_SIZE
        relative_end = relative_start + BATCH_SIZE
        
        items = all_fetched_items[relative_start:relative_end]

        # Enrich the items with detail metadata (from cache or JIT fetch)
        sem = asyncio.Semaphore(10) # fetch up to 10 concurrently
        
        async def enrich_tile(tile):
            url = tile.get("url")
            if not url:
                return tile
            try:
                async with sem:
                    meta = await self._detail_metadata(url)
                if meta:
                    tile["duration_sec"] = meta.get("duration_sec") or tile.get("duration_sec") or 0
                    tile["duration"] = meta.get("duration") or tile.get("duration") or ""
                    tile["quality"] = meta.get("quality") or tile.get("quality") or ""
                    tile["height"] = meta.get("height") or tile.get("height") or 0
                    tile["size_mb"] = meta.get("size_mb") or tile.get("size_mb")
                    tile["added"] = meta.get("upload_date") or tile.get("added") or ""
                    tile["hd"] = meta.get("hd") or tile.get("hd") or False
                    tile["enrichedQ"] = True
                    tile["enriched"] = True
                    if "views" in meta and meta["views"]:
                        tile["views"] = meta["views"]
                    if "performers" in meta:
                        tile["performers"] = meta["performers"]
                    if "categories" in meta:
                        tile["categories"] = meta["categories"]
                    if "video_tags" in meta:
                        tile["videoTags"] = meta["video_tags"]
                        tile["tags"] = meta["video_tags"]
            except Exception as e:
                import logging
                logging.getLogger(__name__).warning(f"[WhoresHub playlist enrich] failed for {url}: {e}")
            return tile

        # Run enrich on all items in parallel
        enriched_items = await asyncio.gather(*[enrich_tile(item) for item in items])
        # Save cache
        self._save_detail_cache()

        # Determine has_more
        if total_count:
            has_more = end_idx < total_count
        else:
            next_path = f"/playlists/{clean_id}/{end_site_page + 1}/"
            has_next = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
            has_more = len(enriched_items) >= BATCH_SIZE and (has_next or len(all_fetched_items) >= (end_site_page - start_site_page + 1) * SITE_PAGE_SIZE)

        return Page(
            items=enriched_items,
            page=page,
            has_more=has_more,
            total=total_count or len(enriched_items),
            extra={"view": "playlist", "pid": clean_id, "name": name}
        )

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.whoreshub import WhoresHubExtractor
        return await WhoresHubExtractor().extract(url)
