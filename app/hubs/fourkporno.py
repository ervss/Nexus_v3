"""4KPorno Hub adapter for the unified Fusion Hub.

4KPorno.xxx runs the KVS engine and hosts 4K studio content (Brazzers, Bangbros,
Nubiles, Adult Time …). Verified live 2026-07-21:
  * newest listing:   /latest-updates/  (page 2+ -> /latest-updates/N/)
  * tile:             div.item > a.thumb_img[href*="/videos/ID/slug/"]
                      img.thumb[src] (thumb) + div.thumb__img[data-preview] (mp4)
                      duration in .duration ("Full Video 30:46")
  * watch page ships direct get_file mp4 links, highest first
    (…/get_file/8512/<hash>/…/ID_2160m.mp4) — NO license_code / token scrambling,
    the 2160 link streams straight (206 video/mp4). Titles carry the upload date
    ("… / 21.07.2026"), so `added` is populated for date sorting.
"""
from __future__ import annotations

import asyncio
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import (HubAdapter, Page, Tile, keywords_from_title,
                   label_without_count, secs_to_pretty)

_ORIGIN = "https://www.4kporno.xxx"
_WATCH_RE = re.compile(r"/videos/\d+/")
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
#: get_file stream file suffix carries the height: …/ID_2160m.mp4, _1080m, _720m
_STREAM_RE = re.compile(r"(https?://[^\s'\"]*?get_file/[^\s'\"]+?_(\d{3,4})m?\.mp4[^\s'\"]*)")
_DATE_RE = re.compile(r"/\s*(\d{2}\.\d{2}\.\d{4})\s*$")


class FourKPornoHub(HubAdapter):
    """Adapter for 4KPorno.xxx — KVS site, 4K-first studio content."""

    source = "4kporno"
    label = "4KPorno"
    needs_enrich = False  # duration + preview in listing; exact height via resolve
    media_hosts = ("4kporno.xxx", "www.4kporno.xxx", "img.4kporno.xxx",
                   "cast.4kporno.xxx")
    stream_referer = "https://www.4kporno.xxx/"
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    listing_fields = frozenset({"duration", "preview"})

    # ── networking ───────────────────────────────────────────────────────────
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
    async def _get(self, url: str, referer: str = "") -> tuple[int, str]:
        def _do():
            resp = cr.get(
                url,
                headers={"User-Agent": _UA, "Referer": referer or _ORIGIN},
                impersonate="chrome",
                timeout=20,
                allow_redirects=True,
            )
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    # ── url building ─────────────────────────────────────────────────────────
    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        page = max(1, page)
        if query:
            q = urllib.parse.quote_plus(query)
            base = f"{_ORIGIN}/search/{q}/"
            return base if page <= 1 else f"{base}{page}/"
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/categories/{slug}/"
            return base if page <= 1 else f"{base}{page}/"
        if sort in {"most_viewed", "popular"}:
            base = f"{_ORIGIN}/most-popular/"
            return base if page <= 1 else f"{base}{page}/"
        if sort == "top_rated":
            base = f"{_ORIGIN}/top-rated/"
            return base if page <= 1 else f"{base}{page}/"
        # default: recent
        base = f"{_ORIGIN}/latest-updates/"
        return base if page <= 1 else f"{base}{page}/"

    def _parse_duration(self, text: str) -> float:
        c = re.search(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)", text or "")
        if not c:
            return 0.0
        if c.group(3):
            return float(int(c.group(1)) * 3600 + int(c.group(2)) * 60 + int(c.group(3)))
        return float(int(c.group(1)) * 60 + int(c.group(2)))

    # ── tile parsing ─────────────────────────────────────────────────────────
    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()

        for card in soup.select("div.item"):
            a = card.find("a", href=_WATCH_RE) or card.find("a", class_="thumb_img")
            if not a or not a.get("href"):
                continue
            href = a["href"]
            url = (_ORIGIN + href) if href.startswith("/") else href
            url = url.split("?")[0]

            m = re.search(r"/videos/(\d+)/", url)
            vid_id = m.group(1) if m else ""
            if not vid_id or vid_id in seen:
                continue
            seen.add(vid_id)

            img = a.find("img") or card.find("img")
            thumb = ""
            title = ""
            if img:
                for attr in ("data-src", "data-original", "src"):
                    val = (img.get(attr) or "").strip()
                    if val and not val.startswith("data:"):
                        thumb = val
                        break
                title = (img.get("alt") or "").strip()
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb

            preview = ""
            pv = a.find("div", attrs={"data-preview": True}) or card.find(attrs={"data-preview": True})
            if pv:
                preview = pv.get("data-preview", "")
            if preview.startswith("//"):
                preview = "https:" + preview

            if not title:
                title = (a.get("title") or "").strip()

            dur_el = card.select_one(".duration")
            dur_text = dur_el.get_text(" ", strip=True) if dur_el else card.get_text(" ", strip=True)
            duration = self._parse_duration(dur_text)

            # Quality: 4kporno is 4K-first but the tile badge is JS-rendered, so
            # trust an explicit textual "4K"/height marker, else leave blank and
            # let resolve() report the real height. Never fake a 4K label.
            txt = card.get_text(" ", strip=True).upper()
            height = 0
            if "2160" in txt or re.search(r"\b4K\b", txt):
                height = 2160
            elif "1440" in txt:
                height = 1440
            elif "1080" in txt:
                height = 1080
            elif "720" in txt:
                height = 720
            quality = ("4K" if height >= 2160 else "1440p" if height >= 1440
                       else "1080p" if height >= 1080 else "720p" if height >= 720 else "")

            items.append({
                "id": vid_id,
                "url": url,
                "title": title,
                "thumb": thumb,
                "preview": preview,
                "duration": duration,
                "hd": height >= 720,
                "height": height,
                "quality": quality,
            })

        return items

    def _tile(self, r: dict) -> Tile:
        return Tile(
            id=r["id"],
            url=r["url"],
            title=r["title"],
            thumb=r["thumb"],
            preview=r.get("preview", ""),
            duration_sec=int(r.get("duration", 0)),
            duration=secs_to_pretty(int(r.get("duration", 0))),
            hd=r["hd"],
            height=r["height"],
            quality=r["quality"],
        )

    # ── surfaces ─────────────────────────────────────────────────────────────
    async def browse(self, *, sort: str = "recent", category: str = "",
                      page: int = 1, **filters) -> Page:
        return await self.search("", sort=sort, category=category, page=page)

    async def search(self, query: str, *, sort: str = "recent", category: str = "",
                     page: int = 1, **filters) -> Page:
        url = self._list_url(query, sort, category, page)
        status, html = await self._get(url)
        if status != 200:
            raise RuntimeError(f"4KPorno HTTP {status} — {url}")
        raw = self._parse_tiles(html)
        vids = [self._tile(r) for r in raw]
        return Page(items=vids, page=page,
                    has_more=bool(vids and len(vids) >= 15), total=None)

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        status, html = await self._get(f"{_ORIGIN}/categories/")
        if status != 200:
            return []
        soup = BeautifulSoup(html, "html.parser")
        rows: list[tuple[str, str]] = []
        for a in soup.select("a[href*='/categories/']"):
            href = a.get("href") or ""
            m = re.search(r"4kporno\.xxx/categories/([a-z0-9\-]+)/?$", href)
            if not m:
                m2 = re.match(r"^/categories/([a-z0-9\-]+)/?$", href)
                slug = m2.group(1) if m2 else ""
            else:
                slug = m.group(1)
            if not slug:
                continue
            rows.append((slug, label_without_count(a)))
        return rows

    async def resolve(self, url: str) -> dict:
        """Watch URL -> playable stream. Picks the highest-res get_file mp4 link
        embedded directly in the page (no token unscrambling on this KVS site)."""
        status, html = await self._get(url)
        if status != 200:
            raise RuntimeError(f"4KPorno resolve HTTP {status}")

        candidates: list[tuple[int, str]] = []
        for m in _STREAM_RE.finditer(html):
            candidates.append((int(m.group(2)), m.group(1)))
        if not candidates:
            raise RuntimeError("4KPorno: no get_file stream found")
        candidates.sort(key=lambda x: x[0], reverse=True)
        best_h, stream_url = candidates[0]

        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.find("h1")
        title = h1.get_text(strip=True) if h1 else ""
        added = ""
        dm = _DATE_RE.search(title)
        if dm:
            # "dd.mm.yyyy" -> "yyyy-mm-dd" and strip the date tail from the title
            d, mo, y = dm.group(1).split(".")
            added = f"{y}-{mo}-{d}"
            title = title[:dm.start()].strip(" /")

        thumb = ""
        og = soup.find("meta", property="og:image")
        if og:
            thumb = og.get("content", "")

        return {
            "stream_url": stream_url,
            "title": title,
            "duration": 0,
            "thumbnail": thumb,
            "height": best_h,
            "added": added,
            "is_hls": False,
        }

    async def related(self, url: str) -> Page:
        status, html = await self._get(url)
        if status == 200:
            raw = self._parse_tiles(html)
            m = re.search(r"/videos/(\d+)/", url)
            this_id = m.group(1) if m else ""
            vids = [self._tile(r) for r in raw if r["id"] != this_id]
            if vids:
                return Page(items=vids, has_more=False)
        soup = BeautifulSoup(html or "", "html.parser")
        h1 = soup.find("h1")
        q = keywords_from_title(h1.get_text(strip=True) if h1 else "")
        if q:
            return await self.search(q, page=1)
        return Page(items=[], has_more=False)
