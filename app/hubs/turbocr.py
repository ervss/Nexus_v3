"""Turbo.cr Hub adapter — an album/folder-based video host.

Unlike every other Fusion Hub source, a turbo.cr search doesn't list videos —
it lists user *albums* (`/library?q=...`), and the listing page carries no
thumbnail or file count at all. So each result needs a follow-up fetch of the
album page (`/a/{id}`) to learn what's inside before it can become a Tile:

  * a 1-file album collapses into a normal, directly-playable video tile
    (`url` -> its `/v/{id}` watch page, `item_count` stays 1);
  * a multi-file album becomes a folder tile (`url` -> the album page,
    `item_count` = file count, `thumbs` = up to 4 file thumbnails for the
    frontend's 2x2 montage).

`resolve()` only ever receives a `/v/{id}` url (single-video tiles, or a
video picked from inside an opened folder). The embed page's `<video>` tag
ships with no `src` — the player fills it client-side from a JSON endpoint
(`/api/sign?v={id}`), so `resolve()` calls that directly instead of scraping
the embed HTML.
"""
from __future__ import annotations

import asyncio
import json
import re
import urllib.parse
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import HubAdapter, Page, Tile

_ORIGIN = "https://turbo.cr"
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_ALBUM_HREF_RE = re.compile(r"^/a/([\w-]+)$")
_VIDEO_URL_RE = re.compile(r"/v/([\w-]+)")

#: parallel album-detail fetches per search page (15 albums/page on turbo.cr)
_ALBUM_DETAIL_CONCURRENCY = 6


class TurboCrHub(HubAdapter):
    """Adapter for turbo.cr."""

    source = "turbocr"
    label = "Turbo.cr"
    needs_enrich = False
    media_hosts = ("static.scdn.st", "turbo.cr", "dl100.turbocdn.st")
    supported_sorts = ("recent", "popular")
    listing_fields = frozenset({"date"})

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

    async def _get(self, url: str) -> tuple[int, str]:
        def _do():
            resp = cr.get(
                url,
                headers={"User-Agent": _UA, "Referer": _ORIGIN + "/"},
                impersonate="chrome",
                timeout=20,
                allow_redirects=True,
            )
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    def _list_url(self, query: str, sort: str, page: int) -> str:
        params: dict[str, str] = {}
        if query:
            params["q"] = query
        if sort == "popular":
            params["view"] = "popular"
        if page > 1:
            params["page"] = str(page)
        qs = urllib.parse.urlencode(params)
        return f"{_ORIGIN}/library" + (f"?{qs}" if qs else "")

    def _parse_albums(self, page_html: str) -> list[dict]:
        soup = BeautifulSoup(page_html or "", "html.parser")
        out: list[dict] = []
        seen: set[str] = set()
        anchors = soup.select("a.alb") or soup.select("a.album-row") or soup.select('a[href^="/a/"]')
        for a in anchors:
            m = _ALBUM_HREF_RE.match((a.get("href") or "").split("?")[0])
            if not m:
                continue
            album_id = m.group(1)
            if album_id in seen:
                continue
            seen.add(album_id)
            title_el = a.select_one("[title], .truncate, .font-semibold")
            title = (
                (title_el.get("title") if title_el else "")
                or (title_el.get_text(strip=True) if title_el else "")
                or a.get("title")
                or ""
            ).strip() or album_id
            time_el = a.select_one(".text-faint") or (title_el.find_next_sibling("div") if title_el else None)
            added = time_el.get_text(strip=True) if time_el else ""
            img = a.find("img")
            thumb = (img.get("data-src") or img.get("src") or "").strip() if img else ""
            out.append({"id": album_id, "title": title, "added": added, "thumb": thumb})
        return out

    async def _fetch_album_files(self, album_id: str) -> list[dict]:
        status, page_html = await self._get(f"{_ORIGIN}/a/{album_id}")
        if status != 200:
            return []

        files: list[dict] = []
        # New turbo.cr album pages embed `const FILES = [ { id:"...", name:"...", thumb:"..." }, ... ];`
        m = re.search(r"const\s+FILES\s*=\s*(\[.*?\]);", page_html, re.S)
        if m:
            raw_js = m.group(1)
            # Quote unquoted JS object keys (`id:` -> `"id":`) so json.loads can parse it.
            json_str = re.sub(r'([{\[,]\s*)([a-zA-Z_]\w*)\s*:', r'\1"\2":', raw_js)
            # Remove trailing commas before `]` or `}` if any.
            json_str = re.sub(r",\s*([}\]])", r"\1", json_str)
            try:
                parsed = json.loads(json_str)
                for row in parsed:
                    if not isinstance(row, dict):
                        continue
                    fid = str(row.get("id") or "").strip()
                    if not fid:
                        continue
                    files.append({
                        "id": fid,
                        "name": str(row.get("name") or ""),
                        "thumb": str(row.get("thumb") or "").replace("\\/", "/"),
                    })
            except ValueError:
                pass

        if files:
            return files

        # Legacy HTML table fallback
        soup = BeautifulSoup(page_html, "html.parser")
        for row in soup.select("tr.file-row"):
            file_id = row.get("data-id") or ""
            if not file_id:
                continue
            thumb_el = row.select_one("[data-thumb]")
            thumb = (thumb_el.get("data-thumb") or "") if thumb_el else ""
            files.append({"id": file_id, "name": row.get("data-name") or "", "thumb": thumb})
        return files

    async def _album_to_tile(self, album: dict) -> Optional[Tile]:
        files = await self._fetch_album_files(album["id"])
        if not files:
            return None
        if len(files) == 1:
            f = files[0]
            return Tile(
                id=album["id"], title=album["title"],
                url=f"{_ORIGIN}/v/{f['id']}", thumb=f["thumb"],
                added=album.get("added", ""), item_count=1,
            )
        thumbs = [f["thumb"] for f in files[:4] if f["thumb"]]
        return Tile(
            id=album["id"], title=album["title"],
            url=f"{_ORIGIN}/a/{album['id']}", thumb=files[0]["thumb"],
            thumbs=thumbs, added=album.get("added", ""), item_count=len(files),
        )

    async def search(self, query: str, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        url = self._list_url(query, sort, page)
        status, page_html = await self._get(url)
        if status != 200:
            raise RuntimeError(f"turbo.cr HTTP {status} — {url}")
        albums = self._parse_albums(page_html)

        sem = asyncio.Semaphore(_ALBUM_DETAIL_CONCURRENCY)

        async def _bounded(album: dict) -> Optional[Tile]:
            async with sem:
                try:
                    return await self._album_to_tile(album)
                except Exception:  # noqa: BLE001 — one broken album must not sink the page
                    return None

        tiles = await asyncio.gather(*(_bounded(a) for a in albums))
        vids = [t for t in tiles if t]

        return Page(items=vids, page=page, has_more=len(albums) >= 15, total=None,
                    extra={"query": query})

    async def browse(self, sort: str = "recent", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        return await self.search("", sort=sort, page=page)

    async def resolve(self, url: str) -> dict:
        m = _VIDEO_URL_RE.search(url)
        if not m:
            raise RuntimeError("turbo.cr: this is a folder — open it instead of playing it")
        file_id = m.group(1)
        # The embed page's <video> tag ships with no `src` — the player fills it
        # in client-side from this JSON endpoint (verified via the network panel:
        # `GET /embed/{id}` renders a bare `<video>`, then `GET /api/sign?v={id}`
        # returns the signed CDN url). No Referer/auth needed.
        status, body = await self._get(f"{_ORIGIN}/api/sign?v={file_id}")
        if status != 200:
            raise RuntimeError(f"turbo.cr sign HTTP {status}")
        try:
            data = json.loads(body)
        except ValueError as exc:
            raise RuntimeError(f"turbo.cr: bad sign response ({exc})") from exc
        stream_url = data.get("url") or ""
        if not data.get("success") or not stream_url:
            raise RuntimeError("turbo.cr: stream url not found")
        return {"stream_url": stream_url, "is_hls": False,
                "title": data.get("original_filename") or "", "duration": 0, "thumbnail": ""}
