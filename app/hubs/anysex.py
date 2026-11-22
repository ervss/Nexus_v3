"""AnySex Hub adapter for the unified Fusion Hub.

AnySex runs the KVS (KernelVideoSharing) engine. Verified live 2026-07-21:
  * newest listing:   /videos/new/  (page 2+ -> /videos/new/N/)
  * tile:             div.item[data-video-id] > a.popfire[href*="/video/ID/slug/"]
                      img[data-jpg] (thumb) / img[data-preview] (mp4 hover)
                      span.item-quality > span.is-hd.hdNNNN  (exact height!)
  * watch page ships the direct get_file mp4 links right in the HTML
    (…/get_file/1/<hash>/…/ID_1080.mp4?br=…) — no token deobfuscation needed,
    the highest-res link streams straight (206 video/mp4).
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

_ORIGIN = "https://anysex.com"
_WATCH_RE = re.compile(r"/video/\d+/")
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
#: span class "hd1080" / "hd2160" carries the exact height — the most reliable
#: quality signal AnySex gives in a listing.
_HD_CLASS_RE = re.compile(r"hd(\d{3,4})")


class AnysexHub(HubAdapter):
    """Adapter for AnySex.com — KVS site with meta-rich listings."""

    source = "anysex"
    label = "AnySex"
    needs_enrich = False  # duration + exact height + preview all present in listing
    media_hosts = ("anysex.com",)
    stream_referer = "https://anysex.com/"
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    listing_fields = frozenset({"duration", "height", "preview"})

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
        # 1) Search — verified live 2026-08-02: the path form (/search/<q>/)
        # 404s on this skin; search is a query param, and it pages the KVS way
        # via from_videos (?page= and ?from= both silently re-serve page 1).
        if query:
            q = urllib.parse.quote_plus(query)
            base = f"{_ORIGIN}/search/?q={q}"
            return base if page <= 1 else f"{base}&from_videos={page}"
        # 2) Category — real path is /videos/categories/<slug>/
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/videos/categories/{slug}/"
            return base if page <= 1 else f"{base}{page}/"
        # 3) Sort
        if sort == "top_rated":
            base = f"{_ORIGIN}/top-rated/"
            return base if page <= 1 else f"{base}{page}/"
        if sort in {"most_viewed", "popular"}:
            base = f"{_ORIGIN}/most-popular/"
            return base if page <= 1 else f"{base}{page}/"
        # 4) Default (recent) — verified working listing
        base = f"{_ORIGIN}/videos/new/"
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
            a = card.find("a", href=_WATCH_RE) or card.find("a", class_="popfire")
            if not a or not a.get("href"):
                continue
            href = a["href"]
            url = (_ORIGIN + href) if href.startswith("/") else href
            url = url.split("?")[0]

            m = re.search(r"/video/(\d+)/", url)
            vid_id = m.group(1) if m else (card.get("data-video-id") or "")
            if not vid_id or vid_id in seen:
                continue
            seen.add(vid_id)

            img = a.find("img") or card.find("img")
            thumb = ""
            preview = ""
            title = ""
            if img:
                for attr in ("data-jpg", "data-src", "data-original", "src"):
                    val = (img.get(attr) or "").strip()
                    if val and not val.startswith("data:"):
                        thumb = val
                        break
                preview = img.get("data-preview") or ""
                title = (img.get("alt") or "").strip()
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb
            if preview.startswith("//"):
                preview = "https:" + preview

            if not title:
                title = (a.get("title") or "").strip()

            # Exact height from span.item-quality > span.hdNNNN
            height = 0
            qspan = card.select_one(".item-quality")
            if qspan:
                for sp in qspan.find_all("span"):
                    for cls in (sp.get("class") or []):
                        hm = _HD_CLASS_RE.match(cls)
                        if hm:
                            height = int(hm.group(1))
                            break
                    if height:
                        break

            text_content = card.get_text(" ", strip=True).upper()
            duration = self._parse_duration(text_content)
            if not height:  # fallback to textual markers
                if "4K" in text_content or "2160" in text_content:
                    height = 2160
                elif "1080" in text_content:
                    height = 1080
                elif "720" in text_content or "HD" in text_content:
                    height = 720

            is_4k = height >= 2160
            is_hd = height >= 720
            quality = ("4K" if is_4k else "1440p" if height >= 1440
                       else "1080p" if height >= 1080 else "720p" if height >= 720
                       else ("480p" if height else ""))

            items.append({
                "id": vid_id,
                "url": url,
                "title": title,
                "thumb": thumb,
                "preview": preview,
                "duration": duration,
                "hd": is_hd,
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
            raise RuntimeError(f"AnySex HTTP {status} — {url}")
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
        for a in soup.select("a[href*='/videos/categories/']"):
            href = a.get("href") or ""
            # same-host category pages only: anysex.com/videos/categories/<slug>/
            # (skip ru./de./es./fr. language subdomains and the bare index).
            m = re.search(r"^https?://anysex\.com/videos/categories/([a-z0-9\-]+)/?$", href)
            if not m:
                m2 = re.match(r"^/videos/categories/([a-z0-9\-]+)/?$", href)
                slug = m2.group(1) if m2 else ""
            else:
                slug = m.group(1)
            if not slug:
                continue
            # names carry a "3.9k videos Old+Young (18…" count badge — strip it
            name = label_without_count(a)
            name = re.sub(r"^[\d.,]+k?\s*videos?\s*", "", name, flags=re.I).strip()
            rows.append((slug, name))
        return rows

    async def resolve(self, url: str) -> dict:
        """Watch URL -> playable stream. AnySex embeds direct get_file mp4 links
        (highest-res first) straight in the page HTML; no token unscrambling."""
        status, html = await self._get(url)
        if status != 200:
            raise RuntimeError(f"AnySex resolve HTTP {status}")

        # Collect every get_file link with its height (…/ID_1080.mp4 / _720 / _2160)
        candidates: list[tuple[int, str]] = []
        for m in re.finditer(r"(https?://[^\s'\"]*?get_file/[^\s'\"]+?_(\d{3,4})\.mp4[^\s'\"]*)", html):
            link, h = m.group(1), int(m.group(2))
            candidates.append((h, link))
        # relative form
        if not candidates:
            for m in re.finditer(r"(/get_file/[^\s'\"]+?_(\d{3,4})\.mp4[^\s'\"]*)", html):
                candidates.append((int(m.group(2)), _ORIGIN + m.group(1)))

        if not candidates:
            raise RuntimeError("AnySex: no get_file stream found")

        candidates.sort(key=lambda x: x[0], reverse=True)
        best_h, stream_url = candidates[0]

        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.find("h1")
        title = h1.get_text(strip=True) if h1 else ""
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
            "is_hls": False,
        }

    async def related(self, url: str) -> Page:
        """Same-source related rail: reuse the watch page's own tile grid, else a
        title-derived keyword search."""
        status, html = await self._get(url)
        if status == 200:
            raw = self._parse_tiles(html)
            m = re.search(r"/video/(\d+)/", url)
            this_id = m.group(1) if m else ""
            vids = [self._tile(r) for r in raw if r["id"] != this_id]
            if vids:
                return Page(items=vids, has_more=False)
        # fallback: keyword search from the page title
        soup = BeautifulSoup(html or "", "html.parser")
        h1 = soup.find("h1")
        q = keywords_from_title(h1.get_text(strip=True) if h1 else "")
        if q:
            return await self.search(q, page=1)
        return Page(items=[], has_more=False)
