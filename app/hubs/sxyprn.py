"""SxyPrn Hub adapter for the unified Fusion Hub."""
from __future__ import annotations

import asyncio
import json
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

_ORIGIN = "https://www.sxyprn.com"
_WATCH_RE = re.compile(r"^/post/[a-z0-9]+\.html")

# UA required to bypass basic bot checks
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

class SxyPrnHub(HubAdapter):
    """Adapter for SxyPrn.com."""

    source = "sxyprn"
    label = "SxyPrn"
    needs_enrich = False

    async def _get(self, url: str, referer: str = "") -> tuple[int, str]:
        def _do():
            resp = cr.get(
                url,
                headers={"User-Agent": _UA, "Referer": referer or url},
                impersonate="chrome",
                timeout=20,
                allow_redirects=True,
            )
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    async def resolve(self, url: str) -> dict:
        status, html = await self._get(url)
        if status != 200:
            raise RuntimeError(f"SxyPrn fetch failed with status {status}")
        
        soup = BeautifulSoup(html, "html.parser")
        
        # 1. Parse video url from vidsnfo span
        vidsnfo_span = soup.find("span", class_="vidsnfo")
        stream_url = ""
        if vidsnfo_span and vidsnfo_span.has_attr("data-vnfo"):
            try:
                vnfo_data = json.loads(vidsnfo_span["data-vnfo"])
                for k, v in vnfo_data.items():
                    stream_url = v
                    break
            except Exception:
                pass
                
        # Fallback to source tag inside video
        if not stream_url:
            video = soup.find("video")
            if video and video.find("source"):
                stream_url = video.find("source").get("src", "")
            elif video:
                stream_url = video.get("src", "")
                
        if not stream_url:
            raise RuntimeError("Could not find SxyPrn stream url")
            
        if stream_url.startswith("/"):
            stream_url = "https://www.sxyprn.com" + stream_url
            
        title = ""
        ta = soup.find("textarea", id="vplayer")
        if ta:
            title = ta.get_text(strip=True)
            
        if not title:
            h1 = soup.find("h1")
            if h1: title = h1.get_text(strip=True)
            
        return {
            "stream_url": stream_url,
            "title": title,
            "duration": 0,
            "thumbnail": "",
            "is_hls": False
        }

    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        page = max(1, page)
        # 1) Search
        if query:
            base = f"{_ORIGIN}/"
            # Sxyprn search often uses just ?q= 
            # (Note: sxyprn pagination is usually page.html or /?page=)
            # Standard sxyprn uses path params like /search/query/page.html or /search/query/ depending on domain mapping.
            # Fallback to ?q= if they accept it, but sxyprn is very path-based. 
            # We will use /search/query/
            q_slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
            base = f"{_ORIGIN}/{q_slug}.html"
            if page > 1:
                base = f"{_ORIGIN}/{q_slug}/{page}.html"
            return base
            
        # 2) Category
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/category/{slug}.html"
            if page > 1:
                base = f"{_ORIGIN}/category/{slug}/{page}.html"
            return base
            
        # 3) Default (recent)
        # Sxyprn has no explicit newest other than just clicking 'home' or /new.html
        base = f"{_ORIGIN}/"
        if page > 1:
            return f"{_ORIGIN}/page{page}.html"
        return base

    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()

        for a in soup.find_all("a", href=_WATCH_RE):
            href = a.get("href") or ""
            if href.startswith("/"):
                url = _ORIGIN + href
            else:
                url = href
            
            url = url.split("?")[0]

            if url in seen:
                continue

            # Need to find title and image. Sxyprn often puts title in title attribute of a, or inside a div.
            card = a.find_parent("div") or a
            img = a.find("img") or card.find("img")
            if not img:
                continue

            seen.add(url)
            
            title = (a.get("title") or img.get("alt") or "").strip()
            # If no title, try looking for text inside the card
            if not title:
                title = a.get_text(" ", strip=True)

            thumb = img.get("data-src") or img.get("data-original") or img.get("src") or ""
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb

            text_content = card.get_text(" ", strip=True).upper()
            
            # Sxyprn doesn't always provide duration clearly in the thumb.
            is_hd = "HD" in text_content or "1080" in text_content or "720" in text_content
            is_4k = "4K" in text_content or "2160" in text_content
            height = 2160 if is_4k else (1080 if is_hd else 480)

            # Extract video ID from URL (/post/xxxx.html)
            m = re.search(r"/post/([a-z0-9]+)\.html", url)
            vid_id = m.group(1) if m else url.split("/")[-1].replace(".html", "")

            items.append({
                "id": vid_id,
                "url": url,
                "title": title or f"SxyPrn Video {vid_id}",
                "thumb": thumb,
                "duration": 0.0, # Will be parsed via ffmpeg later or from site enrich if needed
                "hd": is_hd,
                "height": height,
                "quality": "4K" if is_4k else ("1080p" if is_hd else "480p"),
            })

        return items

    async def browse(
        self,
        sort: str = "recent",
        category: str = "",
        page: int = 1,
    ) -> Page:
        return await self.search("", sort=sort, category=category, page=page)

    async def search(
        self,
        query: str,
        sort: str = "recent",
        category: str = "",
        page: int = 1,
    ) -> Page:
        url = self._list_url(query, sort, category, page)
        status, html = await self._get(url)

        if status != 200:
            raise RuntimeError(f"SxyPrn HTTP {status} — {url}")
        
        raw_items = self._parse_tiles(html)
        
        vids = []
        for r in raw_items:
            vids.append(Tile(
                
                id=r["id"],
                url=r["url"],
                title=r["title"],
                thumb=r["thumb"],
                duration_sec=int(r.get("duration",0)), duration=secs_to_pretty(int(r.get("duration",0))),
                hd=r["hd"],
                height=r["height"],
                quality=r["quality"],
            ))
        
        return Page(
            items=vids,
            page=page,
            has_more=bool(vids and len(vids) >= 15),
            total=None
        )

    async def related(self, url: str) -> Page:
        status, html = await self._get(url)
        if status != 200:
            return Page(items=[], has_more=False)
        m = re.search(r"/post/([a-z0-9]+)\.html", url)
        video_id = m.group(1) if m else ""
        raw_items = self._parse_tiles(html)
        vids = []
        for r in raw_items:
            if r["id"] == video_id:
                continue
            vids.append(Tile(

                id=r["id"],
                url=r["url"],
                title=r["title"],
                thumb=r["thumb"],
                duration_sec=int(r.get("duration",0)), duration=secs_to_pretty(int(r.get("duration",0))),
                hd=r["hd"],
                height=r["height"],
                quality=r["quality"],
            ))
        return Page(items=vids, has_more=False)
