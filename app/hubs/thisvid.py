"""ThisVid Hub adapter for the unified Fusion Hub."""
from __future__ import annotations

import asyncio
import re
import urllib.parse
from typing import Any

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

_ORIGIN = "https://thisvid.com"
_WATCH_RE = re.compile(r"^https?://(?:www\.)?thisvid\.com/videos/[a-z0-9-]+/?$|^/videos/[a-z0-9-]+/?$", re.I)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class ThisVidHub(HubAdapter):
    """Adapter for ThisVid.com."""

    source = "thisvid"
    label = "ThisVid"
    needs_enrich = False
    media_hosts = ("thisvid.com", "www.thisvid.com", "static.thisvid.com")
    stream_referer = "https://thisvid.com/"
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    listing_fields = frozenset({"duration", "date"})

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do():
            resp = cr.get(
                url,
                headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                impersonate="chrome",
                timeout=15,
                allow_redirects=True,
            )
            if resp.status_code >= 400 or not resp.content:
                return b"", "application/octet-stream"
            return resp.content, resp.headers.get("content-type", "image/jpeg")
        return await asyncio.to_thread(_do)

    async def resolve(self, url: str) -> dict:
        def _extract():
            import yt_dlp
            ydl_opts = {
                "quiet": True,
                "simulate": True,
                "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                return {
                    "stream_url": info.get("url"),
                    "title": info.get("title", ""),
                    "duration": info.get("duration", 0),
                    "thumbnail": info.get("thumbnail", ""),
                    "is_hls": "m3u8" in (info.get("url") or ""),
                }
        try:
            return await asyncio.to_thread(_extract)
        except Exception as e:
            raise RuntimeError(f"ThisVid resolve failed: {e}")

    async def _get(self, url: str, referer: str = "") -> tuple[int, str]:
        def _do():
            resp = cr.get(
                url,
                headers={"User-Agent": _UA, "Referer": referer or _ORIGIN + "/"},
                impersonate="chrome",
                timeout=20,
                allow_redirects=True,
            )
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        page = max(1, page)
        if query:
            base = f"{_ORIGIN}/search/?q={urllib.parse.quote_plus(query)}"
            return base if page <= 1 else f"{base}&from={page}"
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/categories/{slug}/"
            return base if page <= 1 else f"{base}{page}/"
        if sort == "top_rated":
            base = f"{_ORIGIN}/top-rated/"
            return base if page <= 1 else f"{base}{page}/"
        if sort in {"most_viewed", "popular"}:
            base = f"{_ORIGIN}/most-popular/"
            return base if page <= 1 else f"{base}{page}/"
        base = f"{_ORIGIN}/latest-updates/"
        return base if page <= 1 else f"{base}{page}/"

    def _parse_duration(self, text: str) -> float:
        c = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)", text or "")
        if not c:
            return 0.0
        if c.group(3):
            return float(int(c.group(1)) * 3600 + int(c.group(2)) * 60 + int(c.group(3)))
        return float(int(c.group(1)) * 60 + int(c.group(2)))

    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()

        # Each `a.tumbpu` is a self-contained video card on ThisVid.
        anchors = soup.select("a.tumbpu")
        if not anchors:
            anchors = [a for a in soup.find_all("a", href=_WATCH_RE) if a.find("img")]

        for a in anchors:
            href = (a.get("href") or "").strip()
            if not href or not _WATCH_RE.match(href.split("?")[0]):
                continue
            url = (_ORIGIN + href) if href.startswith("/") else href
            url = url.split("?")[0]
            if url in seen:
                continue

            img = a.find("img")
            if not img:
                continue

            # Skip private/members-only videos (no public thumbnail or stream).
            raw_src = (img.get("src") or "").strip()
            raw_orig = (img.get("data-original") or img.get("data-src") or "").strip()
            if "bg_private_video" in raw_src or "bg_private_video" in raw_orig:
                continue
            if (img.get("alt") or "").strip().lower() == "private" and not raw_orig:
                continue

            thumb = ""
            for candidate in (raw_orig, raw_src):
                if candidate and not candidate.startswith("data:"):
                    thumb = candidate
                    break
            if not thumb:
                continue
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb

            seen.add(url)

            title_el = a.select_one(".title")
            title = (
                (title_el.get_text(" ", strip=True) if title_el else "")
                or (a.get("title") or "")
                or (img.get("alt") or "")
            ).strip()

            dur_el = a.select_one(".duration")
            duration = self._parse_duration(dur_el.get_text(" ", strip=True) if dur_el else "")

            text_content = a.get_text(" ", strip=True).upper()
            is_4k = "4K" in text_content or "2160" in text_content
            is_hd = is_4k or "1080" in text_content or "720" in text_content or bool(a.select_one(".hd, .is-hd"))
            height = 2160 if is_4k else (1080 if "1080" in text_content else (720 if is_hd else 0))

            m = re.search(r"/videos/([a-z0-9-]+)/", url)
            vid_id = m.group(1) if m else url.rstrip("/").split("/")[-1]

            items.append({
                "id": vid_id,
                "url": url,
                "title": title,
                "thumb": thumb,
                "duration": duration,
                "hd": is_hd,
                "height": height,
                "quality": "4K" if is_4k else ("1080p" if height >= 1080 else ("720p" if is_hd else "")),
            })

        return items

    def _to_tile(self, r: dict) -> Tile:
        dur = int(r.get("duration", 0))
        return Tile(
            id=r["id"],
            url=r["url"],
            title=r["title"],
            thumb=r["thumb"],
            duration_sec=dur,
            duration=secs_to_pretty(dur),
            hd=r["hd"],
            height=r["height"],
            quality=r["quality"],
        )

    async def browse(
        self,
        sort: str = "recent",
        category: str = "",
        page: int = 1,
        **filters: Any,
    ) -> Page:
        return await self.search("", sort=sort, category=category, page=page)

    async def search(
        self,
        query: str,
        sort: str = "recent",
        category: str = "",
        page: int = 1,
        **filters: Any,
    ) -> Page:
        url = self._list_url(query, sort, category, page)
        status, html = await self._get(url)

        if status != 200:
            raise RuntimeError(f"ThisVid HTTP {status} — {url}")

        raw_items = self._parse_tiles(html)
        vids = [self._to_tile(r) for r in raw_items]

        return Page(
            items=vids,
            page=page,
            has_more=bool(vids and len(vids) >= 12),
            total=None,
        )

    async def related(self, url: str) -> Page:
        status, html = await self._get(url)
        if status != 200:
            return Page(items=[], has_more=False)
        m = re.search(r"/videos/([a-z0-9-]+)/", url)
        video_id = m.group(1) if m else ""
        raw_items = self._parse_tiles(html)
        vids = [self._to_tile(r) for r in raw_items if r["id"] != video_id]
        return Page(items=vids, has_more=False)
