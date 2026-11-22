"""Fast shared adapter for the KVS-style WhoresHub and PornTrex sites.

Both sites use the same gallery engine, but not the same paths.  Subclasses
provide their own URL rules while this class keeps card parsing, caching,
related results and media fetching consistent for the Fusion Hub.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from .base import (HubAdapter, Page, Tile, iso_duration_to_secs,
                   label_without_count, secs_to_pretty)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
logger = logging.getLogger(__name__)
_DETAIL_CACHE_ROOT = Path(__file__).resolve().parents[2] / "data" / "hub_detail_cache"

#: Hard cap on how many URLs one enrich() / enrich_stream() call will process.
#: MUST stay >= the router's per-request limit (app/routers/hub.py accepts 120):
#: anything above the cap is dropped WITHOUT a signal, while the frontend has
#: already marked those cards as dispatched — they then sit at "not fetched"
#: forever and the quality filters silently mis-handle them. Politeness is the
#: job of the per-call semaphore, not of this cap.
ENRICH_MAX = 120


def _slug(value: str) -> str:
    clean = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return urllib.parse.quote(clean, safe="-")


def _duration(text: str) -> int:
    match = re.search(r"(?<!\d)(\d{1,3}):(\d{2})(?::(\d{2}))?", text or "")
    if not match:
        words = re.search(
            r"(?:(\d+)\s*(?:h|hours?))?\s*"
            r"(?:(\d+)\s*(?:m|min|minutes?))?\s*"
            r"(?:(\d+)\s*(?:s|sec|seconds?))",
            text or "", re.I,
        )
        if not words:
            return 0
        return int(words.group(1) or 0) * 3600 + int(words.group(2) or 0) * 60 + int(words.group(3) or 0)
    if match.group(3) is not None:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3))
    return int(match.group(1)) * 60 + int(match.group(2))


def _height(text: str) -> int:
    value = (text or "").upper()
    if "4K" in value or "2160" in value:
        return 2160
    for height in (1440, 1080, 720, 480, 360):
        if str(height) in value:
            return height
    return 0


def _unique_links(scope: Any, path: str, *, limit: int = 40) -> list[dict]:
    output: list[dict] = []
    seen: set[str] = set()
    for anchor in scope.select(f'a[href*="/{path}/"]'):
        match = re.search(rf"/{re.escape(path)}/([^/?#]+)/?", anchor.get("href") or "", re.I)
        name = (anchor.get("title") or anchor.get_text(" ", strip=True) or "").strip(" -|\t\r\n")
        if not match or not name or name.lower() in {path, path.rstrip("s"), "suggest"}:
            continue
        slug = urllib.parse.unquote(match.group(1)).lower()
        key = slug + "|" + name.lower()
        if key in seen:
            continue
        seen.add(key)
        output.append({"slug": slug, "name": name})
        if len(output) >= limit:
            break
    return output


class KvsHub(HubAdapter):
    """Per-site path policy plus a fast, listing-only card parser."""

    origin = ""
    video_re = re.compile(r"$^")
    recent_path = "/latest-updates/"
    category_kind = "categories"
    card_class_re = re.compile(r"(?:box|video-item)", re.I)
    curated_categories: tuple[tuple[str, str], ...] = ()
    needs_enrich = True
    cache_seconds = 45
    #: Every one of these routes to a genuinely different KVS listing — either a
    #: dedicated landing path (_base_url) or a `?sort_by=` query (_SORT_QUERY).
    #: "popular"/"hottest" share the /most-popular/ landing, which is the site's
    #: own definition of both, so they are honestly the same listing.
    supported_sorts: tuple[str, ...] = ("recent", "popular", "longest",
                                        "top_rated", "most_viewed")
    #: What `_parse_tiles` gets off a KVS card. Skins differ in which badges they
    #: actually render, so subclasses narrow this to what was measured live.
    listing_fields = frozenset({"duration", "date", "height", "views", "preview"})

    def __init__(self) -> None:
        self._page_cache: dict[str, tuple[float, Page]] = {}
        self._categories_cache: tuple[float, list[dict]] = (0.0, [])
        self._detail_cache: dict[str, tuple[float, dict]] = {}
        self._detail_cache_lock = threading.RLock()
        self._detail_cache_dirty = False
        # curl_cffi Sessions are NOT safe for concurrent use, and every request
        # here runs inside asyncio.to_thread — so keep ONE session per thread
        # rather than a pool: the thread that owns it is the only user, no lock
        # is needed, and the TLS handshake is paid once per thread instead of
        # once per request (an enrich pass over 24 watch pages was 24 handshakes).
        self._local = threading.local()
        self._load_detail_cache()

    def _session(self) -> cr.Session:
        """The calling thread's reused curl_cffi Session."""
        session = getattr(self._local, "session", None)
        if session is None:
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    def _network_mode(self) -> str:
        """Per-source route: direct, tor, or direct with Tor fallback."""
        key = f"{self.source.upper()}_NETWORK_MODE"
        default = "auto" if self.source == "whoreshub" else "direct"
        value = (os.getenv(key) or default).strip().lower()
        return value if value in {"direct", "tor", "auto"} else default

    @staticmethod
    def _tor_proxies() -> dict[str, str]:
        host = (os.getenv("TOR_SOCKS_HOST") or "127.0.0.1").strip()
        port = (os.getenv("TOR_SOCKS_PORT") or "9050").strip()
        proxy = f"socks5h://{host}:{port}"
        return {"http": proxy, "https": proxy}

    def net_status(self) -> dict:
        mode = self._network_mode()
        tor = None
        if mode in {"auto", "tor"}:
            from ..tor_service import tor_service
            tor = tor_service.status()
        return {
            "mode": mode,
            "protected": bool(mode == "tor" and tor and tor.get("ready")),
            "tor": tor,
            "fallback_available": bool(mode == "auto" and tor and tor.get("ready")),
        }

    def _detail_cache_path(self) -> Path:
        return _DETAIL_CACHE_ROOT / f"{self.source}.json"

    def _detail_cache_ttl(self) -> int:
        try:
            return max(600, int(os.getenv("HUB_DETAIL_CACHE_TTL_SECONDS", "86400")))
        except ValueError:
            return 86400

    def _load_detail_cache(self) -> None:
        if (os.getenv("HUB_DETAIL_CACHE", "1").strip().lower() in {"0", "false", "no"}):
            return
        path = self._detail_cache_path()
        try:
            raw = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
            now = time.time()
            ttl = self._detail_cache_ttl()
            if isinstance(raw, dict):
                self._detail_cache = {
                    url: (float(row.get("at") or 0), row.get("data") or {})
                    for url, row in raw.items()
                    if isinstance(row, dict) and isinstance(row.get("data"), dict)
                    and now - float(row.get("at") or 0) < ttl
                }
        except Exception as exc:  # noqa: BLE001
            logger.debug("[%s] detail cache load failed: %s", self.label, exc)

    def _detail_cache_get(self, url: str, *, deep: bool = False) -> Optional[dict]:
        with self._detail_cache_lock:
            cached = self._detail_cache.get(url)
            if not cached or time.time() - cached[0] >= self._detail_cache_ttl():
                return None
            data = cached[1]
            if deep and not data.get("_deep_metadata"):
                return None
            return dict(data)

    def _detail_cache_put(self, url: str, data: dict, *, deep: bool = False) -> dict:
        row = dict(data or {})
        if deep:
            row["_deep_metadata"] = True
        with self._detail_cache_lock:
            self._detail_cache[url] = (time.time(), row)
            self._detail_cache_dirty = True
        return row

    def _save_detail_cache(self) -> None:
        if not self._detail_cache_dirty or os.getenv("HUB_DETAIL_CACHE", "1").strip().lower() in {"0", "false", "no"}:
            return
        with self._detail_cache_lock:
            try:
                _DETAIL_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
                now = time.time()
                ttl = self._detail_cache_ttl()
                rows = [
                    (url, at, data) for url, (at, data) in self._detail_cache.items()
                    if now - at < ttl
                ]
                rows.sort(key=lambda item: item[1], reverse=True)
                payload = {url: {"at": at, "data": data} for url, at, data in rows[:5000]}
                path = self._detail_cache_path()
                temp = path.with_suffix(".tmp")
                temp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                temp.replace(path)
                self._detail_cache_dirty = False
            except Exception as exc:  # noqa: BLE001
                logger.debug("[%s] detail cache save failed: %s", self.label, exc)

    #: hub sort -> KVS `?sort_by=` value. Applied on search/category/most-popular
    #: listings (all honour it). "recent"/"popular"/"hottest" keep their native
    #: landing order, so they map to no query.
    _SORT_QUERY = {
        "longest": "duration",
        "top_rated": "rating",
        "rating": "rating",
        "most_viewed": "video_viewed",
    }

    def _base_url(self, query: str, category: str, sort: str) -> str:
        if query:
            return f"{self.origin}/search/{_slug(query)}/"
        if category:
            return f"{self.origin}/{self.category_kind}/{_slug(category)}/"
        if sort in {"hottest", "most_viewed", "popular", "top_rated", "rating", "longest"}:
            return f"{self.origin}/most-popular/"
        return self.origin + self.recent_path

    def _sort_query(self, sort: str) -> str:
        return self._SORT_QUERY.get((sort or "").strip().lower(), "")

    @staticmethod
    def _page_url(base: str, page: int) -> str:
        return base if page <= 1 else f"{base.rstrip('/')}/{page}/"

    async def _get_html(self, url: str, referer: str = "") -> tuple[int, str, str]:
        def _do() -> tuple[int, str, str]:
            session = self._session()
            kwargs = {
                "headers": {"User-Agent": _UA, "Referer": referer or self.origin + "/"},
                "impersonate": "chrome",
                "timeout": 20,
                "allow_redirects": True,
            }
            mode = self._network_mode()
            if mode == "tor":
                kwargs["proxies"] = self._tor_proxies()
            try:
                response = session.get(url, **kwargs)
            except Exception:
                if mode != "auto":
                    raise
                from ..tor_service import tor_service
                state = tor_service.start(45)
                if not state.get("ready"):
                    raise
                kwargs["proxies"] = self._tor_proxies()
                response = session.get(url, **kwargs)
            if mode == "auto" and response.status_code in {403, 429, 503, 509}:
                from ..tor_service import tor_service
                state = tor_service.start(45)
                if state.get("ready"):
                    kwargs["proxies"] = self._tor_proxies()
                    response = session.get(url, **kwargs)
            return response.status_code, response.text, str(response.url)
        return await asyncio.to_thread(_do)

    def _absolute(self, value: str) -> str:
        return urllib.parse.urljoin(self.origin + "/", value or "")

    def _parse_tiles(self, html: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=True):
            href = anchor.get("href") or ""
            if not self.video_re.search(href):
                continue
            url = self._absolute(href).split("#", 1)[0]
            if url in seen:
                continue
            seen.add(url)

            card = anchor.find_parent("div", class_=self.card_class_re) or anchor.parent or anchor
            image = anchor.find("img") or card.find("img")
            title = (
                anchor.get("title")
                or (image.get("alt") if image else "")
                or ((card.select_one(".title a, .title, .description, .video-title") or {}).get_text(" ", strip=True)
                    if card.select_one(".title a, .title, .description, .video-title") else "")
            ).strip()
            if not title:
                tail = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
                title = tail.replace("-", " ").strip().title() or self.label + " video"

            thumb = ""
            preview = ""
            if image:
                thumb = image.get("data-src") or image.get("data-original") or image.get("src") or ""
                preview = image.get("data-preview") or image.get("data-video") or ""
            if thumb.startswith("data:"):
                thumb = ""
            thumb = self._absolute(thumb) if thumb else ""
            preview = self._absolute(preview) if preview else ""

            duration_el = card.select_one(".duration, .durations, [class*='duration']")
            duration_sec = _duration(duration_el.get_text(" ", strip=True) if duration_el else card.get_text(" ", strip=True))
            quality_el = card.select_one(".quality, .is-hd, [class*='quality'], .hd-text-icon")
            quality_text = quality_el.get_text(" ", strip=True) if quality_el else ""
            height = _height(quality_text + " " + title)
            quality = "4K" if height >= 2160 else (f"{height}p" if height else "")

            card_text = card.get_text(" ", strip=True)
            views_match = re.search(r"([\d,.]+\s*[KMB]?)\s*views?", card_text, re.I)
            rating_match = re.search(r"(\d{1,3}(?:\.\d+)?)%", card_text)
            date_match = re.search(
                r"(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|"
                r"\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|\d{4}-\d{2}-\d{2})",
                card_text, re.I,
            )
            vid_match = re.search(r"/(?:videos?|video)/(\d+)", url)
            items.append(Tile(
                id=vid_match.group(1) if vid_match else url,
                title=title,
                url=url,
                thumb=thumb,
                preview=preview,
                duration_sec=duration_sec,
                duration=secs_to_pretty(duration_sec),
                views=views_match.group(1) + " views" if views_match else "",
                rating=rating_match.group(1) + "%" if rating_match else "",
                quality=quality,
                height=height,
                hd=height >= 720,
                added=date_match.group(0) if date_match else "",
            ).to_dict())
        return items

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        page = max(1, int(page or 1))
        base = self._base_url(query.strip(), category.strip(), sort or "recent")
        url = self._page_url(base, page)
        sort_q = self._sort_query(sort)
        if sort_q:
            url = url + ("&" if "?" in url else "?") + f"sort_by={sort_q}"
        cached = self._page_cache.get(url)
        if cached and time.monotonic() - cached[0] < self.cache_seconds:
            return cached[1]
        started = time.perf_counter()
        status, html, final_url = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        items = self._parse_tiles(html)
        # A KVS page that redirects back to page 1 is the end, not a duplicate page.
        redirected_back = page > 1 and final_url.rstrip("/") == base.rstrip("/")
        soup = BeautifulSoup(html, "html.parser")
        next_path = f"/{page + 1}/"
        has_next_link = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
        result = Page(
            items=items,
            page=page,
            has_more=bool(items) and not redirected_back and (has_next_link or len(items) >= 20),
            total=None,
            took_ms=round((time.perf_counter() - started) * 1000),
            extra={"source": self.source, "page_url": final_url},
        )
        self._page_cache[url] = (time.monotonic(), result)
        return result

    async def browse(self, *, sort: str = "recent", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        return await self.search("", sort=sort or "recent", category=category, page=page)

    async def categories(self) -> list[dict]:
        if time.monotonic() - self._categories_cache[0] < 1800 and self._categories_cache[1]:
            return self._categories_cache[1]
        output = [{"slug": slug, "name": name} for slug, name in self.curated_categories]
        seen = {row["slug"] for row in output}
        try:
            status, html, _ = await self._get_html(f"{self.origin}/{self.category_kind}/")
            if status == 200:
                soup = BeautifulSoup(html, "html.parser")
                for anchor in soup.select(f'a[href*="/{self.category_kind}/"]'):
                    match = re.search(rf"/{self.category_kind}/([^/?#]+)/?", anchor.get("href") or "")
                    if not match:
                        continue
                    slug = match.group(1).lower()
                    # Skins hang the video count in a child node ("Onlyfans 15040" on
                    # xxbrits), so strip it structurally instead of shipping it as label.
                    name = (anchor.get("title") or label_without_count(anchor)
                            or slug.replace("-", " ")).strip()
                    if slug and slug not in seen and 1 < len(name) < 50:
                        seen.add(slug)
                        output.append({"slug": slug, "name": name})
        except Exception:
            pass
        self._categories_cache = (time.monotonic(), output[:120])
        return self._categories_cache[1]

    async def playlists(self, *, page: int = 1) -> Page:
        """Browse the source's public, recently updated playlists."""
        page = max(1, int(page or 1))
        base = f"{self.origin}/playlists/"
        url = self._page_url(base, page)
        status, html, final_url = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        soup = BeautifulSoup(html, "html.parser")
        items: list[dict] = []
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=True):
            match = re.search(r"/playlists/(\d+)/([^/?#]+)/?", anchor.get("href") or "", re.I)
            if not match:
                continue
            pid = f"{match.group(1)}/{match.group(2)}"
            if pid in seen:
                continue
            seen.add(pid)
            card = anchor.find_parent("div", class_=re.compile(r"(?:item|box|playlist)", re.I)) or anchor.parent or anchor
            image = anchor.find("img") or card.find("img")
            fallback = urllib.parse.unquote(match.group(2)).replace("-", " ").strip().title()
            title = (
                anchor.get("title")
                or (image.get("alt") if image else "")
                or ((card.select_one(".title, .name") or {}).get_text(" ", strip=True)
                    if card.select_one(".title, .name") else "")
                or fallback
            ).strip()
            thumb = ""
            if image:
                thumb = image.get("data-src") or image.get("data-original") or image.get("src") or ""
            thumb = self._absolute(thumb) if thumb and not thumb.startswith("data:") else ""
            count_match = re.search(r"(\d[\d,.]*)\s*videos?", card.get_text(" ", strip=True), re.I)
            items.append({
                "id": pid,
                "title": title or fallback or "Playlist",
                "thumb": thumb,
                "count": count_match.group(1) if count_match else "",
                "url": self._absolute(anchor.get("href") or ""),
            })
        next_path = f"/playlists/{page + 1}/"
        has_next = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
        redirected_back = page > 1 and final_url.rstrip("/") == base.rstrip("/")
        return Page(items=items, page=page, has_more=bool(items) and not redirected_back and (has_next or len(items) >= 20),
                    extra={"view": "playlists", "source": self.source})

    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:
        """Load a native KVS playlist; pid is kept as numeric-id/slug."""
        raw = urllib.parse.unquote((pid or "").strip())
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", raw, re.I)
        if not match:
            raise ValueError("Neplatné ID playlistu")
        clean_id = f"{match.group(1)}/{match.group(2)}"
        base = f"{self.origin}/playlists/{clean_id}/"
        page = max(1, int(page or 1))
        url = self._page_url(base, page)
        status, html, final_url = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        items = self._parse_tiles(html)
        soup = BeautifulSoup(html, "html.parser")
        heading = soup.select_one("h1, .headline h1, .playlist-info .title")
        name = heading.get_text(" ", strip=True) if heading else match.group(2).replace("-", " ").title()
        next_path = f"/playlists/{clean_id}/{page + 1}/"
        has_next = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
        redirected_back = page > 1 and final_url.rstrip("/") == base.rstrip("/")
        return Page(items=items, page=page, has_more=bool(items) and not redirected_back and (has_next or len(items) >= 20),
                    extra={"view": "playlist", "pid": clean_id, "name": name})

    #: how many playlist browse pages find_playlist scans for a keyword. KVS sites
    #: have NO real playlist search, so we browse + title-filter; a target can sit
    #: deep (e.g. Camwhores "Couples: Vids" is on page 8), hence a generous scan.
    playlist_search_pages = 20

    async def find_playlist(self, ref: str) -> dict:
        ref = (ref or "").strip()
        # Pasted URL / id → use directly.
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", ref, re.I)
        if match:
            return {"found": True, "id": f"{match.group(1)}/{match.group(2)}",
                    "name": match.group(2).replace("-", " ").title()}
        if not ref:
            return {"found": False}

        # No native playlist search on KVS sites → browse many pages and title-match.
        # Fetch pages in parallel BATCHES (a target can sit deep — Camwhores
        # "Couples: Vids" is on page 8 — but scanning 20 pages serially took ~28s).
        # Collect ALL matches, ranked (exact title > startswith > substring), so the
        # UI can offer a pick-list. Stop early once a batch yields no "has_more".
        needle = ref.lower()
        matches: list[dict] = []
        seen: set[str] = set()
        batch = 5
        stop = False
        for start in range(1, self.playlist_search_pages + 1, batch):
            pages = list(range(start, min(start + batch, self.playlist_search_pages + 1)))
            results = await asyncio.gather(*[self.playlists(page=p) for p in pages],
                                           return_exceptions=True)
            for result in results:
                if isinstance(result, Exception):
                    continue
                for item in result.items:
                    title = (item.get("title") or "").lower()
                    pid = item.get("id")
                    if not pid or pid in seen or needle not in title:
                        continue
                    seen.add(pid)
                    rank = 0 if title == needle else 1 if title.startswith(needle) else 2
                    matches.append({"id": pid, "name": item.get("title", ""),
                                    "thumb": item.get("thumb", ""), "count": item.get("count", ""), "_rank": rank})
                if not result.has_more:
                    stop = True
            if stop or len(matches) >= 40:
                break
        if not matches:
            return {"found": False}
        matches.sort(key=lambda m: m.pop("_rank"))
        best = matches[0]
        return {"found": True, "id": best["id"], "name": best["name"], "matches": matches}

    async def pornstar_videos(self, slug: str, *, sort: str = "recent", page: int = 1) -> Page:
        """Browse a KVS model profile. Native profile order is newest first."""
        clean = re.sub(r"[^a-z0-9-]+", "-", urllib.parse.unquote(slug or "").lower()).strip("-")
        if not clean:
            raise ValueError("Neplatné meno modela")
        base = f"{self.origin}/models/{clean}/"
        page = max(1, int(page or 1))
        url = self._page_url(base, page)
        status, html, final_url = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        items = self._parse_tiles(html)
        soup = BeautifulSoup(html, "html.parser")
        heading = soup.select_one("h1")
        name = heading.get_text(" ", strip=True) if heading else clean.replace("-", " ").title()
        name = re.sub(r"\s+(?:porn|videos?|model).*$", "", name, flags=re.I).strip() or clean.replace("-", " ").title()
        image = soup.select_one(".model-info img, .profile img, .avatar img")
        avatar = ""
        if image:
            avatar = image.get("data-src") or image.get("src") or ""
            avatar = self._absolute(avatar) if avatar else ""
        next_path = f"/models/{clean}/{page + 1}/"
        has_next = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
        redirected_back = page > 1 and final_url.rstrip("/") == base.rstrip("/")
        return Page(items=items, page=page, has_more=bool(items) and not redirected_back and (has_next or len(items) >= 20),
                    extra={"view": "pornstar", "slug": clean, "name": name, "avatar": avatar,
                           "native_sort": "recent"})

    async def find_pornstar(self, ref: str) -> dict:
        ref = (ref or "").strip()
        match = re.search(r"/models/([^/?#]+)", ref, re.I)
        clean = match.group(1) if match else re.sub(r"[^a-z0-9-]+", "-", ref.lower()).strip("-")
        if not clean:
            return {"found": False}
        try:
            result = await self.pornstar_videos(clean, page=1)
        except Exception:
            return {"found": False}
        if not result.items:
            return {"found": False}
        return {"found": True, "slug": clean, "name": result.extra.get("name") or clean.replace("-", " ").title(),
                "avatar": result.extra.get("avatar") or ""}

    # ── Member surface (uploader = posted uploads + favourites + playlists) ────
    # The KVS engine serves every member under /members/{id}/. This generic
    # implementation exposes it for every KVS site; CamWhores overrides it with a
    # richer, site-specific parser. Sites that hide member pages simply 404, which
    # the router surfaces as "member not found".

    @staticmethod
    def _member_id(ref: str) -> str:
        ref = (ref or "").strip()
        if ref.isdigit():
            return ref
        match = re.search(r"/members/(\d+)", ref)
        return match.group(1) if match else ""

    async def member_profile(self, ref: str) -> dict:
        mid = self._member_id(ref)
        if not mid:
            raise ValueError("Neplatné member id")
        base = f"{self.origin}/members/{mid}"
        status, html, _ = await self._get_html(base + "/")
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        soup = BeautifulSoup(html, "html.parser")
        h1 = soup.select_one("h1")
        name = re.sub(r"['’]s Page\s*$", "", h1.get_text(strip=True)).strip() if h1 else f"Member {mid}"
        av = soup.select_one('.avatar img, img[src*="/contents/avatars/"], img.thumb')
        avatar = self._absolute(av.get("data-src") or av.get("src") or "") if av else ""

        def _count(frag: str, *, exclude: str = "") -> int:
            for anchor in soup.find_all("a", href=True):
                href = anchor["href"]
                if frag not in href or (exclude and exclude in href):
                    continue
                m = re.search(r"(\d[\d\s,]*)\s*videos?\b", anchor.get_text(" ", strip=True), re.I)
                if m:
                    return int(re.sub(r"\D", "", m.group(1)) or 0)
            return 0

        playlists, seen = [], set()
        for anchor in soup.find_all("a", href=True):
            if "/playlists/" not in anchor["href"] or "/members/" in anchor["href"]:
                continue
            pm = re.search(r"/playlists/(\d+)/([a-z0-9-]+)", anchor["href"], re.I)
            if not pm or pm.group(1) in seen:
                continue
            txt = re.sub(r"\s+", " ", anchor.get_text(" ", strip=True))
            title = re.split(r"\s+\d+\s*video", txt)[0].strip()
            if not title or title.isdigit():
                continue
            seen.add(pm.group(1))
            vc = re.search(r"(\d+)\s*video", txt, re.I)
            playlists.append({"id": f"{pm.group(1)}/{pm.group(2)}", "url": self._absolute(anchor["href"]),
                              "title": title, "count": vc.group(1) if vc else ""})
        return {
            "member_id": mid, "name": name, "avatar": avatar, "url": base + "/",
            "posted_count": _count("/videos/", exclude="/favourites/"),
            "favourite_count": _count("/favourites/videos/"),
            "public_count": 0, "private_count": 0, "playlists": playlists,
        }

    async def member_videos(self, ref: str, *, kind: str = "posted", page: int = 1) -> Page:
        mid = self._member_id(ref)
        if not mid:
            raise ValueError("Neplatné member id")
        page = max(1, int(page or 1))
        kind = (kind or "posted").strip().lower()
        if kind == "favourites":
            root = f"{self.origin}/members/{mid}/favourites/videos/"
        else:
            root = f"{self.origin}/members/{mid}/videos/"
        url = root if page <= 1 else f"{root}{page}/"
        status, html, final_url = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        items = self._parse_tiles(html)
        redirected_back = page > 1 and final_url.rstrip("/") == root.rstrip("/")
        return Page(items=items, page=page,
                    has_more=bool(items) and not redirected_back and len(items) >= 20,
                    extra={"view": "member", "kind": kind, "member_id": mid})

    async def _extract(self, url: str) -> Optional[dict]:
        raise NotImplementedError

    async def _head_size(self, url: str) -> int:
        """content-length of a rendition, for skins with no download table."""
        def _do() -> int:
            response = self._session().head(
                url, headers={"User-Agent": _UA, "Referer": self.origin + "/"},
                impersonate="chrome", timeout=15, allow_redirects=True)
            if response.status_code >= 400:
                return 0
            try:
                return int(response.headers.get("content-length") or 0)
            except (TypeError, ValueError):
                return 0
        try:
            return await asyncio.to_thread(_do)
        except Exception:  # noqa: BLE001
            return 0

    async def _detail_metadata(self, url: str) -> dict:
        cached = self._detail_cache_get(url)
        if cached and (self.source != "porntrex" or cached.get("_watch_meta_version") == 2):
            return cached
        status, html, _ = await self._get_html(url, referer=self.origin + "/")
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        soup = BeautifulSoup(html, "html.parser")
        # PornTrex contains several generic `.info` blocks before the actual
        # watch metadata, so the dedicated video block must win explicitly.
        scope = soup.select_one(".video-info") or soup.select_one(".info") or soup

        structured: dict = {}
        for script in soup.select('script[type="application/ld+json"]'):
            try:
                value = json.loads(script.string or script.get_text() or "{}")
            except (TypeError, ValueError):
                continue
            rows = value if isinstance(value, list) else [value]
            # xxbrits nests the VideoObject inside an `@graph` array (alongside a Person),
            # so a top-level-only scan finds nothing and silently loses uploadDate.
            for row in list(rows):
                if isinstance(row, dict) and isinstance(row.get("@graph"), list):
                    rows.extend(r for r in row["@graph"] if isinstance(r, dict))
            for row in rows:
                if isinstance(row, dict) and row.get("@type") == "VideoObject":
                    structured = row
                    break
            if structured:
                break

        def meta(name: str, prop: bool = False) -> str:
            node = soup.select_one(f'meta[{"property" if prop else "name"}="{name}"]')
            return (node.get("content") or "").strip() if node else ""

        title_node = soup.select_one("h1")
        title = str(structured.get("name") or meta("og:title", True)
                    or (title_node.get_text(" ", strip=True) if title_node else "")).strip()
        thumb_value = structured.get("thumbnailUrl") or meta("og:image", True)
        if isinstance(thumb_value, list):
            thumb_value = thumb_value[0] if thumb_value else ""
        thumbnail = self._absolute(str(thumb_value)) if thumb_value else ""
        duration_sec = iso_duration_to_secs(str(structured.get("duration") or "")) or _duration(scope.get_text(" ", strip=True))
        if self.source == "porntrex":
            # The broad scope also contains tags such as "0:02". Only the
            # watch info badges describe this video's actual running time.
            badges = [node.get_text(" ", strip=True) for node in scope.select("em.badge")]
            duration_sec = iso_duration_to_secs(str(structured.get("duration") or "")) or next(
                (_duration(text) for text in badges if re.search(r"\d\s*(?:min|sec|hours?)\b", text, re.I)), 0)

        # The download table gives the exact file size for each resolution.
        # Keep the largest file among the highest available resolution.
        downloads: list[tuple[int, float]] = []
        for height, size, unit in re.findall(
            r"MP4\s*(\d{3,4})p(?:\s*4k)?\s*,\s*([\d.]+)\s*(KB|MB|GB|Kb|Mb|Gb)",
            scope.get_text(" ", strip=True), re.I,
        ):
            mb = float(size)
            if unit.lower() == "gb":
                mb *= 1024
            elif unit.lower() == "kb":
                mb /= 1024
            downloads.append((int(height), mb))
        best = max(downloads, key=lambda row: (row[0], row[1])) if downloads else (0, 0.0)
        height, size_mb = best

        # Skins without a download table (xxbrits) still declare every rendition in the
        # player's `flashvars`: `video_url` + `video_url_text: '480p'`, then
        # `video_alt_url{,2,3}` for the rest. Tiers above the free ceiling point at
        # `?login` instead of a file, so those are skipped rather than reported as
        # available. Only the size needs a request — the labels are already here.
        free_tiers: list[tuple[int, str]] = []
        if not height:
            for key in ("video_url", "video_alt_url", "video_alt_url2",
                        "video_alt_url3", "video_alt_url4"):
                url_match = re.search(rf"{key}:\s*'([^']*)'", html)
                if not url_match:
                    continue
                file_url = url_match.group(1).strip()
                text_match = re.search(rf"{key}_text:\s*'([^']*)'", html)
                if not file_url or not text_match or "?login" in file_url:
                    continue
                label = int(re.sub(r"\D", "", text_match.group(1)) or 0)
                if not label:
                    continue
                free_tiers.append((label, file_url))
            if free_tiers:
                height, stream_url = max(free_tiers, key=lambda row: row[0])
                size_bytes = await self._head_size(stream_url)
                if size_bytes:
                    size_mb = size_bytes / 1048576

        categories = _unique_links(scope, "categories", limit=30)
        performers = _unique_links(scope, "models", limit=20)
        if not performers:
            # WhoresHub currently uses /pornstars/ on watch pages while the
            # browse surface uses /models/. Support both KVS variants.
            performers = _unique_links(scope, "pornstars", limit=20)
        tag_rows = _unique_links(scope, "tags", limit=40)
        video_tags = [row["name"] for row in tag_rows]
        description = str(structured.get("description") or meta("description")).strip()
        # og/meta name varies per skin: PornTrex uses datePublished, xxbrits publishes
        # only the og-style uploadDate property.
        upload_date = str(structured.get("uploadDate") or meta("datePublished")
                          or meta("uploadDate", True) or meta("video:release_date", True)
                          or meta("og:video:release_date", True)).strip()[:10]
        if self.source == "porntrex" and not upload_date:
            upload_date = next((text for text in badges if re.search(r"\bago\b", text, re.I)), "")
        result = {
            "_watch_meta_version": 2,
            "title": title,
            "thumbnail": thumbnail,
            "duration_sec": duration_sec,
            "duration": secs_to_pretty(duration_sec),
            "height": height,
            "quality": "4K" if height >= 2160 else (f"{height}p" if height else ""),
            "size_mb": round(size_mb, 1) if size_mb else None,
            # Measured, never derived: either the skin's own download table (which
            # prints the real file size) or a HEAD content-length on the rendition.
            "size_estimated": False,
            "codec": "mp4" if (downloads or free_tiers) else "",
            "hd": height >= 720,
            "performers": performers,
            "categories": categories,
            "video_tags": video_tags,
            "upload_date": upload_date,
            "description": description,
        }
        return self._detail_cache_put(url, result)

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        sem = asyncio.Semaphore(4)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                return url, await self._detail_metadata(url)
        results = dict(await asyncio.gather(*[one(url) for url in urls[:ENRICH_MAX]]))
        self._save_detail_cache()
        return results

    async def enrich_stream(self, urls: list[str]):
        sem = asyncio.Semaphore(4)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                return url, await self._detail_metadata(url)

        tasks = [asyncio.create_task(one(url)) for url in urls[:ENRICH_MAX]]
        try:
            for task in asyncio.as_completed(tasks):
                try:
                    yield await task
                except Exception:
                    continue
        finally:
            self._save_detail_cache()

    async def resolve(self, url: str) -> dict:
        data = await self._extract(url)
        if not data or not data.get("stream_url"):
            raise RuntimeError("Stream sa nepodarilo získať")
        return {
            "stream_url": data["stream_url"],
            "is_hls": bool(data.get("is_hls")),
            "title": data.get("title") or self.label + " video",
            "duration": int(data.get("duration") or 0),
            "thumbnail": data.get("thumbnail") or "",
        }

    async def related(self, url: str) -> Page:
        status, html, _ = await self._get_html(url, referer=self.origin + "/")
        if status != 200:
            return Page(items=[], has_more=False)
        current = url.rstrip("/")
        items = [item for item in self._parse_tiles(html) if item.get("url", "").rstrip("/") != current]
        return Page(items=items[:36], has_more=False, extra={"related_mode": "same-source"})

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            response = self._session().get(
                url, headers={"User-Agent": _UA, "Referer": self.origin + "/"},
                impersonate="chrome", timeout=25)
            return response.content, response.headers.get("content-type", "application/octet-stream")
        return await asyncio.to_thread(_do)


def make_kvs_source(*, source: str, label: str, origin: str, extractor,
                    category_kind: str = "categories", recent_path: str = "/latest-updates/",
                    video_path: str = "videos", media_hosts: tuple[str, ...] = (),
                    curated_categories: tuple[tuple[str, str], ...] = ()) -> type:
    """Build a ready-to-register KVS adapter class from a config, no boilerplate.

    Every KVS site shares one gallery engine, so onboarding a new one is pure
    configuration: its origin, where categories live, and a stream extractor. This
    factory turns that config into a KvsHub subclass — the whole point of the shared
    base. `extractor` is a zero-arg callable returning an object with an async
    `extract(url)`; `media_hosts` defaults to the origin's hostname.

        WankABC = make_kvs_source(source="wankabc", label="WankABC",
                                  origin="https://www.wankabc.com",
                                  extractor=lambda: MyExtractor())

    Existing sites (WhoresHub/PornTrex/CamWhores/XXBrits) keep their hand-written
    subclasses because they each override a site-specific quirk; this is for the
    plain ones where nothing but the config differs.
    """
    host = urllib.parse.urlparse(origin).hostname or ""
    ns = {
        "source": source, "label": label, "origin": origin,
        "video_re": re.compile(rf"/{re.escape(video_path)}/\d+(?:/|$)", re.I),
        "category_kind": category_kind, "recent_path": recent_path,
        "media_hosts": media_hosts or ((host,) if host else ()),
        "stream_referer": origin + "/",
        "curated_categories": curated_categories,
        "_extractor_factory": staticmethod(extractor),
    }

    async def _extract(self, url: str):
        return await self._extractor_factory().extract(url)

    ns["_extract"] = _extract
    return type(f"{label.replace(' ', '')}Hub", (KvsHub,), ns)
