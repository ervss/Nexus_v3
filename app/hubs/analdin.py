"""Analdin Hub adapter for the unified Fusion Hub."""
from __future__ import annotations

import asyncio
import html as html_lib
import re
import urllib.parse
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

_ORIGIN = "https://www.analdin.com"
_WATCH_RE = re.compile(r"/videos/\d+/[a-z0-9-]+/?", re.I)

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


class AnaldinHub(HubAdapter):
    """Adapter for Analdin.com (KVS-based)."""

    source = "analdin"
    label = "Analdin"
    needs_enrich = False
    media_hosts = ("analdin.com", "www.analdin.com", "i.analdin.com")
    stream_referer = "https://www.analdin.com/"
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    listing_fields = frozenset({"duration", "height", "preview"})

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
        status, body = await self._get(url, referer=_ORIGIN + "/")
        if status != 200:
            raise RuntimeError(f"Analdin fetch failed with status {status}")

        soup = BeautifulSoup(body, "html.parser")

        candidates: list[tuple[int, str]] = []
        # 1. KVS flashvars video_url / video_alt_url*
        fv_match = re.search(r"var\s+flashvars\s*=\s*\{(.+?)\};", body, re.S)
        if fv_match:
            fv = dict(re.findall(r"(\w+)\s*:\s*'([^']*)'", fv_match.group(1)))
            for key, text_key in (
                ("video_url", "video_url_text"),
                ("video_alt_url", "video_alt_url_text"),
                ("video_alt_url2", "video_alt_url2_text"),
                ("video_alt_url3", "video_alt_url3_text"),
            ):
                u = (fv.get(key) or "").replace("\\/", "/")
                if u.startswith("http"):
                    qt = fv.get(text_key) or u
                    hm = re.search(r"(\d{3,4})p?", qt)
                    h = int(hm.group(1)) if hm else (480 + len(candidates) * 240)
                    candidates.append((h, html_lib.unescape(u)))

        # 2. Direct get_file mp4 links in HTML/scripts
        if not candidates:
            for m in re.finditer(r"(https?://[^\s'\"]+?get_file/[^\s'\"]+?\.mp4[^\s'\"]*)", body):
                u = m.group(1).replace("\\/", "/")
                if "_vthumb" in u:
                    continue
                hm = re.search(r"_(\d{3,4})p?\.mp4", u)
                h = int(hm.group(1)) if hm else 480
                candidates.append((h, html_lib.unescape(u)))

        # 3. <video> / <source> tag
        stream_url = ""
        best_h = 0
        if candidates:
            candidates.sort(key=lambda x: x[0], reverse=True)
            best_h, stream_url = candidates[0]
        else:
            video = soup.find("video")
            if video:
                stream_url = video.get("src") or ""
                if not stream_url:
                    src_tag = video.find("source")
                    if src_tag:
                        stream_url = src_tag.get("src") or ""

        if not stream_url:
            raise RuntimeError("Could not find Analdin stream url")

        h1 = soup.find("h1")
        title = h1.get_text(strip=True) if h1 else ""
        if not title:
            og_t = soup.find("meta", property="og:title")
            if og_t:
                title = (og_t.get("content") or "").strip()

        thumb = ""
        og_i = soup.find("meta", property="og:image")
        if og_i:
            thumb = (og_i.get("content") or "").strip()

        dur = 0
        og_d = soup.find("meta", property="video:duration")
        if og_d and str(og_d.get("content") or "").isdigit():
            dur = int(og_d["content"])

        return {
            "stream_url": stream_url,
            "title": title,
            "duration": dur,
            "thumbnail": thumb,
            "height": best_h or None,
            "is_hls": ".m3u8" in stream_url,
        }

    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        page = max(1, page)
        if query:
            slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
            base = f"{_ORIGIN}/tags/{slug}/"
            return base if page <= 1 else f"{base}{page}/"
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/tags/{slug}/"
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

        cards = soup.select("div.item")
        for card in cards:
            a = card.find("a", href=_WATCH_RE)
            if not a or not a.get("href"):
                continue
            href = a["href"]
            url = (_ORIGIN + href) if href.startswith("/") else href
            url = url.split("?")[0]
            if url in seen:
                continue
            seen.add(url)

            title_el = card.select_one("strong.title, .title")
            img = card.find("img")
            title = (
                (title_el.get_text(" ", strip=True) if title_el else "")
                or (a.get("title") or "")
                or (img.get("alt") if img else "")
                or ""
            ).strip()

            thumb = ""
            if img:
                for attr in ("data-original", "data-src", "src"):
                    val = (img.get(attr) or "").strip()
                    if val and not val.startswith("data:"):
                        thumb = val
                        break
            if not thumb:
                thumb = (a.get("thumb") or "").strip()
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb

            preview = (a.get("vthumb") or "").strip()
            if preview.startswith("//"):
                preview = "https:" + preview
            elif preview.startswith("/"):
                preview = _ORIGIN + preview

            dur_el = card.select_one(".duration")
            dur_text = dur_el.get_text(" ", strip=True) if dur_el else card.get_text(" ", strip=True)
            duration = self._parse_duration(dur_text)

            text_content = card.get_text(" ", strip=True).upper()
            is_4k = "4K" in text_content or "2160" in text_content
            is_hd = is_4k or "HD" in text_content or "1080" in text_content or "720" in text_content or bool(card.select_one(".is-hd"))
            height = 2160 if is_4k else (1080 if "1080" in text_content else (720 if is_hd else 0))

            m = re.search(r"/videos/(\d+)/", url)
            vid_id = m.group(1) if m else url.rstrip("/").split("/")[-1]

            items.append({
                "id": vid_id,
                "url": url,
                "title": title,
                "thumb": thumb,
                "preview": preview,
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
            preview=r.get("preview", ""),
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
        query = (query or "").strip()
        url = self._list_url(query, sort, category, page)
        status, html = await self._get(url)

        # Analdin's /search/ endpoint returns empty on their server, so we map
        # queries to /tags/{slug}/. If a multi-word tag 404s, try individual words.
        if query and (status != 200 or not self._parse_tiles(html)):
            words = [w for w in re.findall(r"[a-z0-9]+", query.lower()) if len(w) > 2]
            for w in words:
                tag_url = f"{_ORIGIN}/tags/{w}/" + (f"{page}/" if page > 1 else "")
                st2, h2 = await self._get(tag_url)
                if st2 == 200 and self._parse_tiles(h2):
                    status, html = st2, h2
                    break

        if status != 200:
            if query:
                return Page(items=[], page=page, has_more=False, total=None)
            raise RuntimeError(f"Analdin HTTP {status} — {url}")

        raw_items = self._parse_tiles(html)
        if query and len(query.split()) > 1:
            q_words = [w.lower() for w in query.split() if len(w) > 2]
            filtered = [r for r in raw_items if any(w in (r["title"] or "").lower() for w in q_words)]
            if filtered:
                raw_items = filtered

        vids = [self._to_tile(r) for r in raw_items]
        return Page(
            items=vids,
            page=page,
            has_more=bool(vids and len(vids) >= 20),
            total=None,
        )

    async def related(self, url: str) -> Page:
        status, html = await self._get(url)
        if status != 200:
            return Page(items=[], has_more=False)
        m = re.search(r"/videos/(\d+)/", url)
        video_id = m.group(1) if m else ""
        raw_items = self._parse_tiles(html)
        vids = [self._to_tile(r) for r in raw_items if r["id"] != video_id]
        return Page(items=vids, has_more=False)
