"""DrTuber Hub adapter for the unified Fusion Hub."""
from __future__ import annotations

import asyncio
import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile, secs_to_pretty

_ORIGIN = "https://www.drtuber.com"
_WATCH_RE = re.compile(r"/video/\d+")

# UA required to bypass basic bot checks
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

class DrTuberHub(HubAdapter):
    """Adapter for DrTuber.com."""

    source = "drtuber"
    label = "DrTuber"
    needs_enrich = False  # DrTuber returns duration, titles, and sometimes quality on listings
    media_hosts = ("drtuber.com", "drtst.com")
    stream_referer = "https://www.drtuber.com/"

    async def resolve(self, url: str) -> dict:
        def _extract():
            """Fetch the same signed stream configuration as DrTuber's player.

            yt-dlp currently receives a list-shaped response from this provider.
            The watch page itself initializes an HTTP session first and then
            calls ``/player_config_json/`` with the numeric video id.  Replaying
            those two requests produces the short-lived MP4 URL used by the
            provider's own player.
            """
            video_match = re.search(r"/video/(\d+)", url or "")
            if not video_match:
                raise RuntimeError("DrTuber URL does not contain a video id")

            session = cr.Session(
                impersonate="chrome",
                headers={
                    "User-Agent": _UA,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            )
            page = session.get(url, timeout=20)
            if page.status_code != 200:
                raise RuntimeError(f"DrTuber watch page HTTP {page.status_code}")

            config = session.get(
                f"{_ORIGIN}/player_config_json/",
                params={
                    "vid": video_match.group(1),
                    "aid": "0",
                    "domain_id": "0",
                    "embed": "0",
                    "ref": "null",
                    "check_speed": "0",
                },
                headers={
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "Referer": url,
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout=20,
            )
            if config.status_code != 200:
                raise RuntimeError(f"DrTuber player config HTTP {config.status_code}")
            data = config.json()
            if not isinstance(data, dict):
                raise RuntimeError("DrTuber player config did not contain stream data")

            files = data.get("files") or {}
            stream_url = str(files.get("hq") or files.get("lq") or "").strip()
            if not stream_url:
                raise RuntimeError("DrTuber player config did not contain an MP4 URL")
            return {
                "stream_url": stream_url,
                "title": str(data.get("title") or ""),
                "duration": float(data.get("duration") or 0),
                "thumbnail": str(data.get("poster") or ""),
                "is_hls": False,
            }
        try:
            return await asyncio.to_thread(_extract)
        except Exception as e:
            raise RuntimeError(f"DrTuber resolve failed: {e}")

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

    def _list_url(self, query: str, sort: str, category: str, page: int) -> str:
        page = max(1, page)
        # 1) Search
        if query:
            base = f"{_ORIGIN}/search/{urllib.parse.quote_plus(query)}"
            return base if page <= 1 else f"{base}?page={page}"
        # 2) Category
        if category:
            slug = re.sub(r"[^a-z0-9]+", "-", category.lower()).strip("-")
            base = f"{_ORIGIN}/porn/{slug}"
            return base if page <= 1 else f"{base}?page={page}"
        # 3) Sort
        if sort == "top_rated":
            base = f"{_ORIGIN}/videos/top"
            return base if page <= 1 else f"{base}?page={page}"
        if sort in {"most_viewed", "popular"}:
            base = f"{_ORIGIN}/videos/most-viewed"
            return base if page <= 1 else f"{base}?page={page}"
        # 4) Default (recent)
        base = f"{_ORIGIN}/videos/newest"
        return base if page <= 1 else f"{base}?page={page}"

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

        # Usually DrTuber items are .item or similar. 
        # But looking for any anchor matching /video/\d+ with an img inside works best.
        for a in soup.find_all("a", href=_WATCH_RE):
            href = a.get("href") or ""
            if href.startswith("/"):
                url = _ORIGIN + href
            else:
                url = href
            
            # remove tracking params
            url = url.split("?")[0]

            if url in seen:
                continue

            card = a.find_parent("div") or a
            img = a.find("img") or card.find("img")
            if not img:
                continue

            seen.add(url)
            
            title = (a.get("title") or img.get("alt") or "").strip()
            thumb = img.get("data-src") or img.get("data-original") or img.get("src") or ""
            if thumb.startswith("//"):
                thumb = "https:" + thumb
            elif thumb.startswith("/"):
                thumb = _ORIGIN + thumb

            text_content = card.get_text(" ", strip=True).upper()
            duration = self._parse_duration(text_content)
            
            is_hd = "HD" in text_content or "1080" in text_content or "720" in text_content
            is_4k = "4K" in text_content or "2160" in text_content
            height = 2160 if is_4k else (1080 if is_hd else 480)

            items.append({
                "url": url,
                "title": title,
                "thumb": thumb,
                "duration": duration,
                "hd": is_hd,
                "height": height,
                "quality": "4K" if is_4k else ("1080p" if is_hd else "480p"),
                "views": 0,  # Could be parsed but optional
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
            raise RuntimeError(f"DrTuber HTTP {status} — {url}")
        
        raw_items = self._parse_tiles(html)
        
        vids = []
        for r in raw_items:
            vids.append(Tile(
                
                id=r["url"].split("/video/")[1].split("/")[0],
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
        m = re.search(r"/video/(\d+)", url)
        video_id = m.group(1) if m else ""
        raw_items = self._parse_tiles(html)
        vids = []
        for r in raw_items:
            vid = r["url"].split("/video/")[1].split("/")[0]
            if vid == video_id:
                continue
            vids.append(Tile(

                id=vid,
                url=r["url"],
                title=r["title"],
                thumb=r["thumb"],
                duration_sec=int(r.get("duration",0)), duration=secs_to_pretty(int(r.get("duration",0))),
                hd=r["hd"],
                height=r["height"],
                quality=r["quality"],
            ))
        return Page(items=vids, has_more=False)

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            from curl_cffi import requests as cr
            response = cr.get(url, headers={"Referer": self.stream_referer},
                              impersonate="chrome", timeout=15)
            if response.status_code != 200:
                raise RuntimeError(f"Media HTTP {response.status_code}")
            return response.content, response.headers.get("Content-Type", "image/jpeg")
        return await asyncio.to_thread(_do)
