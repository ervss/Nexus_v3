"""
Faphouse Hub adapter.

Faphouse is a cookie-gated commercial site: browsing/searching needs a real
signed-in session (not just a static consent cookie like Eporner's
age_verified=1), and full-resolution playback needs the same session on the
watch page. It runs its own React/Flixcdn player, not a KVS gallery engine —
so unlike WhoresHub/PornTrex/CamWhores this is a standalone HubAdapter, not a
KvsHub subclass.

Card scraping mirrors the selectors already proven live in the browser
extension (extensions/Nexus_Gallery/faphouse_grid_importer.js::collectCard),
since that JS has been running against the real, logged-in DOM. `resolve()`
delegates to FaphouseExtractor, which already handles the locked/trailer vs
real-stream distinction correctly via the page's own `view-state-data` blob —
that logic is not duplicated here.
"""
from __future__ import annotations

import asyncio
import html
import logging
import re
import urllib.parse
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

from ..cookie_jar import build_cookie_header, cookiejar_mtime, resolve_cookiefile
from ..extractors.faphouse import FaphouseAccessError, FaphouseExtractor
from .base import HubAdapter, Page, Tile, label_without_count, secs_to_pretty

logger = logging.getLogger(__name__)

ORIGIN = "https://faphouse.com"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

#: Same candidate list as the extractor (app/extractors/faphouse.py) — kept
#: in sync manually since each module owns its own class-level tuple, but
#: both resolve through the same app.cookie_jar helpers.
COOKIE_CANDIDATES = (
    "faphouse_cookies.txt",
    "faphouse.netscape.txt",
    "faphouse.cookies.txt",
    "app/faphouse_cookies.txt",
    "app/faphouse.netscape.txt",
    "app/faphouse.cookies.txt",
    "cookies.netscape.txt",
    "cookies.txt",
)

_DURATION_RE = re.compile(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b")


def _duration_sec(text: str) -> int:
    m = _DURATION_RE.search(text or "")
    if not m:
        return 0
    a, b, c = int(m.group(1)), int(m.group(2)), m.group(3)
    return a * 3600 + b * 60 + int(c) if c is not None else a * 60 + b


def _quality_from_badge(text: str) -> tuple[str, int]:
    low = (text or "").upper()
    if "4K" in low or "2160" in low:
        return "4K", 2160
    if "1440" in low:
        return "1440p", 1440
    if "FULL HD" in low or "1080" in low:
        return "1080p", 1080
    if "HD" in low or "720" in low:
        return "720p", 720
    return "", 0


def _parse_tiles(page_html: str, *, sort_recent: bool = False) -> list[dict]:
    """Card scraping mirroring extensions/Nexus_Gallery/faphouse_grid_importer.js::collectCard.

    Faphouse renders cards through several nested wrapper variants across page
    builds; the extension found the most reliable anchor is a[href*="/videos/"]
    filtered to real watch links (tag/category links like /videos/blonde are
    NOT watch pages and must be excluded — they collide on the same href
    prefix).

    `sort_recent`: Faphouse's own "Newest" sort is a client-side-only JS
    feature — every `sort=`/`sortBy=`/`orderBy=` query value tried against
    the raw HTML (live-verified 2026-09-05) returns byte-identical listings,
    so there is no server-side param to forward. Each card's `data-id`
    (numeric, e.g. `[data-el="Thumb"][data-id]`) is Faphouse's internal
    video-id — an auto-increment key that trends upward with catalog
    add-time — so sorting by it descending is the closest achievable
    approximation to "newest first" without an enrich() round-trip per card.
    """
    soup = BeautifulSoup(page_html or "", "html.parser")
    items: list[dict] = []
    seen: set[str] = set()
    card_ids: dict[str, int] = {}  # tile url -> numeric data-id, for sort_recent

    selectors = [
        '[data-el="Thumb"][data-id]',
        '[data-id][data-el-video]',
        ".t-m",
        '[data-el="VideoCard"]',
        ".video-item",
    ]
    cards = []
    for sel in selectors:
        found = [c for c in soup.select(sel) if c.find("img")]
        if found:
            cards = found
            break
    if not cards:
        cards = [a.parent for a in soup.select('a[href*="/videos/"]') if a.find("img")]

    for card in cards:
        anchor = card if card.name == "a" and "/videos/" in (card.get("href") or "") \
            else (card.select_one('a.t-vl[href*="/videos/"]') or card.select_one('a[href*="/videos/"]'))
        if not anchor:
            continue
        href = (anchor.get("href") or "").strip()
        if not href or href in ("/videos", "/videos/") or href.startswith("/videos/vr"):
            continue
        slug = href.split("?")[0].rstrip("/").split("/videos/")[-1]
        is_watch_href = ("t-vl" in (anchor.get("class") or [])) \
            or bool(re.search(r"-[a-zA-Z0-9]{4,}$", slug)) \
            or bool(re.fullmatch(r"[A-Za-z0-9]{5,}", slug) and re.search(r"[A-Z]", slug) and re.search(r"[a-z0-9]", slug))
        if not is_watch_href:
            continue

        url = urllib.parse.urljoin(ORIGIN + "/", href).split("#")[0]
        if url in seen:
            continue
        seen.add(url)

        vid_id = slug.split("-")[-1] or url
        img = card.select_one("img.t-i, img[src*='flixcdn'], img")
        thumb = (img.get("data-src") or img.get("src") or "") if img else ""
        if thumb.startswith("data:"):
            thumb = ""
        if thumb:
            thumb = urllib.parse.urljoin(ORIGIN + "/", thumb)
        title = (img.get("alt") if img else "") or anchor.get("title") or anchor.get_text(" ", strip=True) or ""
        title = re.sub(r"\s+", " ", html.unescape(title)).strip()
        if not title or len(title) < 3:
            title_el = card.select_one(".t-t, .title, h3, h4")
            if title_el:
                title = title_el.get_text(" ", strip=True)
        if not title:
            title = f"Faphouse Video {vid_id}"

        card_text = card.get_text(" ", strip=True)
        duration_sec = _duration_sec(card_text)
        quality, height = _quality_from_badge(card_text)

        items.append(Tile(
            id=vid_id,
            title=title,
            url=url,
            thumb=thumb,
            duration_sec=duration_sec,
            duration=secs_to_pretty(duration_sec),
            quality=quality,
            height=height,
            hd=height >= 720,
        ).to_dict())

        card_data_id = card.get("data-id") if card.name != "a" else None
        if not card_data_id:
            thumb_el = card.select_one('[data-el="Thumb"][data-id]')
            card_data_id = thumb_el.get("data-id") if thumb_el else None
        if card_data_id and str(card_data_id).isdigit():
            card_ids[url] = int(card_data_id)

    if sort_recent and card_ids:
        items.sort(key=lambda t: card_ids.get(t["url"], -1), reverse=True)
    return items


class FaphouseHub(HubAdapter):
    source = "faphouse"
    label = "Faphouse"
    needs_enrich = True
    media_hosts = ("flixcdn.com", "thumb-ah.flixcdn.com", "video-nss.flixcdn.com", "faphouse.com")
    stream_referer = "https://faphouse.com/"
    # Confirmed live 2026-09-04: sidebar exposes Trending/Newest as the only
    # true re-orderings; Quality/Duration/Access-type are filters, not sorts.
    supported_sorts = ("recent", "popular")
    # Duration + quality badge are visible per-card; tags/views/date are not
    # printed on the listing (only on the watch page's view-state-data) —
    # claiming them here would silently break the frontend's tag filter.
    listing_fields = frozenset({"duration", "height"})

    def __init__(self) -> None:
        import threading
        self._local = threading.local()

    def _session(self) -> cr.Session:
        session = getattr(self._local, "session", None)
        if session is None:
            session = cr.Session(impersonate="chrome")
            self._local.session = session
        return session

    def _cookie_file(self) -> Optional[str]:
        return resolve_cookiefile(*COOKIE_CANDIDATES)

    def net_status(self) -> dict:
        cookie_file = self._cookie_file()
        mtime = cookiejar_mtime(cookie_file)
        return {
            "mode": "cookie" if cookie_file else "signed-out",
            "cookie_file": cookie_file,
            "cookie_present": bool(cookie_file),
            "cookie_mtime": mtime,
            "protected": False,
        }

    async def _get_html(self, url: str) -> tuple[int, str]:
        def _do() -> tuple[int, str]:
            headers = {
                "User-Agent": _UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": ORIGIN + "/videos",
            }
            cookie_hdr = build_cookie_header(self._cookie_file())
            if cookie_hdr:
                headers["Cookie"] = cookie_hdr
            resp = self._session().get(url, headers=headers, impersonate="chrome", timeout=20)
            return resp.status_code, resp.text
        return await asyncio.to_thread(_do)

    def _listing_url(self, *, query: str, category: str, pornstar: str, studio: str,
                     sort: str, page: int) -> str:
        # Live-verified 2026-09-05: there is no /search/{term} path — that 404s.
        # Keyword search is the `q` QUERY PARAM on /videos (or /c/{cat}/videos),
        # and it composes with a category filter rather than replacing it, so
        # picking a category chip + typing a tag keeps both instead of the
        # category silently winning. `query=` (no `q`) is a no-op the site
        # quietly ignores — that was the original bug: every "keyword only"
        # search rendered the unfiltered /videos feed under a 404/misleading URL.
        if pornstar:
            base = f"{ORIGIN}/pornstars/{urllib.parse.quote(pornstar)}"
        elif studio:
            base = f"{ORIGIN}/studios/{urllib.parse.quote(studio)}"
        elif category:
            base = f"{ORIGIN}/c/{urllib.parse.quote(category)}/videos"
        else:
            base = f"{ORIGIN}/videos"
        # accessType=premium restricts every listing to native FapHouse
        # videos, excluding Fanclub (accessType=fan) and Paid/VOD
        # (accessType=vod) content — confirmed live 2026-09-05 via the
        # pornstar-page filter dropdown (?accessType=premium|fan|vod).
        # Omitting the param serves "All types" (premium+fan+vod mixed),
        # which is why every listing must set it explicitly.
        params = {"accessType": "premium"}
        if query:
            params["q"] = query
        if sort == "popular":
            params["sort"] = "trending"
        if page > 1:
            params["page"] = str(page)
        return base + "?" + urllib.parse.urlencode(params)

    async def search(self, query: str, *, sort: str = "", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        pornstar = str(filters.get("pornstar") or "").strip()
        studio = str(filters.get("studio") or filters.get("member") or "").strip()
        url = self._listing_url(query=(query or "").strip(), category=(category or "").strip(),
                                pornstar=pornstar, studio=studio, sort=sort, page=max(1, int(page or 1)))
        status, page_html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"Faphouse {status} on {url}")
        # sort != "popular" covers both the explicit "recent" default and any
        # future/unset value — Faphouse's own listing order isn't reliably
        # newest-first (see _parse_tiles docstring), so this is the only
        # sort mode that gets client-side reordering.
        tiles = _parse_tiles(page_html, sort_recent=(sort != "popular"))
        return Page(
            items=tiles,
            page=page,
            has_more=len(tiles) >= 20,
            extra={"query": query, "category": category},
        )

    async def browse(self, *, sort: str = "", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        return await self.search("", sort=sort, page=page, category=category, **filters)

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        status, page_html = await self._get_html(f"{ORIGIN}/categories")
        if status != 200:
            return []
        soup = BeautifulSoup(page_html, "html.parser")
        rows: list[tuple[str, str]] = []
        for a in soup.select('a[href*="/c/"]'):
            href = a.get("href") or ""
            m = re.search(r"/c/([^/?#]+)", href)
            if not m:
                continue
            # The count lives in its own ".../__counter" node as "30,514 videos"
            # — not a bare number, so base.py's label_without_count (which only
            # strips pure-numeric children) can't catch it. The title has its
            # own dedicated node too, so read that directly instead.
            title_el = a.select_one('[class*="__title"]')
            name = (title_el.get_text(" ", strip=True) if title_el else "") \
                or label_without_count(a) or m.group(1).replace("-", " ").title()
            rows.append((m.group(1), name))
        return rows

    async def pornstar_videos(self, slug: str, *, sort: str = "", page: int = 1) -> Page:
        return await self.search("", sort=sort, page=page, pornstar=slug)

    async def find_pornstar(self, name: str) -> dict:
        slug = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
        return {"slug": slug, "url": f"{ORIGIN}/pornstars/{slug}"}

    async def member_profile(self, ref: str) -> dict:
        """Studio profile — Faphouse's "member" surface is a studio/channel, not a user."""
        slug = (ref or "").strip().strip("/").split("/")[-1]
        return {"ref": slug, "name": slug.replace("-", " ").title(), "url": f"{ORIGIN}/studios/{slug}"}

    async def member_videos(self, ref: str, *, kind: str = "", page: int = 1) -> Page:
        slug = (ref or "").strip().strip("/").split("/")[-1]
        return await self.search("", page=page, studio=slug)

    async def find_playlist(self, q: str) -> dict:
        """Resolve a pasted Faphouse playlist URL or bare code to its id.

        Playlist codes are opaque random slugs (e.g. "r9047h") with no
        derivable relationship to the playlist's name, unlike a pornstar
        slug — so this only strips a full URL down to its trailing path
        segment; it cannot turn a typed title into a code the way
        find_pornstar can slugify a name.
        """
        raw = (q or "").strip()
        code = raw.rstrip("/").split("/")[-1] if "/" in raw else raw
        return {"code": code, "url": f"{ORIGIN}/playlists/{code}"}

    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:
        """One page of an external (someone else's) public Faphouse playlist.

        Distinct from this app's OWN faphouse_playlists table (DB-backed user
        collections) — `pid` here is Faphouse's own opaque playlist code, and
        the page is scraped the same way a listing page is, since a playlist
        page uses the identical card markup `_parse_tiles` already handles.
        """
        code = (pid or "").strip().strip("/").split("/")[-1]
        if not code:
            raise RuntimeError("Faphouse: chýba kód playlistu")
        url = f"{ORIGIN}/playlists/{code}" + (f"?page={page}" if page > 1 else "")
        status, page_html = await self._get_html(url)
        if status != 200:
            raise RuntimeError(f"Faphouse {status} on {url}")
        tiles = _parse_tiles(page_html)
        title_m = re.search(r"<title>(.*?)\s*\|\s*Faphouse</title>", page_html)
        return Page(
            items=tiles,
            page=page,
            # A round-number "did we get a full page" guess, same as the rest
            # of this adapter's listings — genuinely wrong on some pages (see
            # search()'s docstring), which is why the frontend's loadMore()
            # treats an empty/failing NEXT page as the real end-of-list
            # signal rather than trusting this flag outright.
            has_more=bool(tiles),
            extra={"playlist_title": html.unescape(title_m.group(1)).strip() if title_m else ""},
        )

    async def resolve(self, url: str) -> dict:
        try:
            data = await FaphouseExtractor().extract(url)
        except FaphouseAccessError as exc:
            raise RuntimeError(str(exc)) from exc
        if not data:
            raise RuntimeError("Faphouse: stream sa nenašiel")
        return {
            "stream_url": data.get("stream_url") or "",
            "is_hls": bool(data.get("is_hls")),
            "title": data.get("title") or "",
            "duration": data.get("duration") or 0,
            "thumbnail": data.get("thumbnail") or "",
        }

    async def _watch_page_details(self, url: str) -> dict:
        """Everything the listing card can't carry: real pornstar names, studio,
        upload date, and a per-quality file-size table — all live on the watch
        page, either in its `view-state-data` JSON blob or its download-quality
        picker (`data-el="DownloadLink"` rows, each with a real `<span
        class="size">`). Tags/categories are NOT here — Faphouse renders those
        client-side from a separate API call the raw HTML never carries, so
        they are intentionally left out rather than faked.
        """
        status, page_html = await self._get_html(url)
        if status != 200:
            return {}
        view_state = FaphouseExtractor._view_state(page_html)
        video_state = view_state.get("video") or {}

        sizes: dict[int, float] = {}
        for m in re.finditer(
            r'data-el="DownloadLink"[^>]*data-el-item-format="(\d+)"[^>]*>'
            r'.*?<span class="size">([\d.]+)\s*(MB|GB)</span>',
            page_html, re.S,
        ):
            height, amount, unit = int(m.group(1)), float(m.group(2)), m.group(3).upper()
            sizes[height] = amount * 1024 if unit == "GB" else amount

        # Fanclub-only videos ("access type: fan" in the site's own filter —
        # see hubs/faphouse.py's accessType=premium comment) 404 on stream
        # resolve for any account that isn't a paying fan of that specific
        # studio/pornstar. The watch page is the only place this is knowable
        # — the listing card carries no lock/access badge — so this rides
        # along on the same fetch enrich() already makes, no extra request.
        view_allowed = video_state.get("videoViewAllowed")
        access_type = str(video_state.get("videoAccessType") or "premium")
        locked = (view_allowed is False) or (access_type != "premium")

        return {
            "uploader": str(video_state.get("studioName") or "").strip(),
            "uploader_url": str(video_state.get("studioUrl") or "").strip(),
            "performers": [n for n in (video_state.get("pornstarNames") or []) if n],
            "added": str(video_state.get("publishedAt") or "").strip(),
            "duration_sec": int(float(video_state.get("duration") or 0)),
            "sizes_by_height": sizes,
            "access_type": access_type,
            "locked": locked,
        }

    async def enrich(self, urls: list[str]) -> dict[str, dict]:
        """Watch-page pass for real uploader/performers/upload-date/file-size.

        listing_fields deliberately excludes "tags" and "date" (the browse
        grid genuinely doesn't carry them) — this is the second round-trip
        that fills those in for cards the user has actually scrolled to,
        same division of labour as every other needs_enrich=True adapter.
        """
        sem = asyncio.Semaphore(8)

        async def _one(url: str) -> tuple[str, dict]:
            async with sem:
                try:
                    details = await self._watch_page_details(url)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("[Faphouse] enrich failed for %s: %s", url, exc)
                    return url, {}
            if not details:
                return url, {}
            out: dict[str, Any] = {
                "uploader": details.get("uploader") or "",
                "uploader_url": details.get("uploader_url") or "",
                "performers": details.get("performers") or [],
                "added": details.get("added") or "",
                "access_type": details.get("access_type") or "premium",
                "locked": bool(details.get("locked")),
            }
            if details.get("duration_sec"):
                out["duration_sec"] = details["duration_sec"]
                out["duration"] = secs_to_pretty(details["duration_sec"])
            sizes = details.get("sizes_by_height") or {}
            if sizes:
                # resolve()/playback always fetches the highest quality tier
                # Faphouse offers (see FaphouseExtractor._find_best_stream),
                # so the size that actually matches what plays is the
                # largest-height entry in this table — not the tile's
                # listing-badge height, which enrich() has no access to here.
                best_height = max(sizes)
                out["height"] = best_height
                out["size_mb"] = round(sizes[best_height], 1)
                out["quality"] = "4K" if best_height >= 2160 else (f"{best_height}p" if best_height else "")
            return url, out

        results = await asyncio.gather(*[_one(u) for u in dict.fromkeys(urls or [])])
        return {url: data for url, data in results if data}

    async def related(self, url: str) -> Page:
        status, page_html = await self._get_html(url)
        if status != 200:
            return Page(items=[], has_more=False)
        soup = BeautifulSoup(page_html, "html.parser")
        related_scope = soup.select_one('[data-el="RelatedVideos"], .related, aside') or soup
        tiles = _parse_tiles(str(related_scope))
        return Page(items=tiles[:24], has_more=False)

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        def _do() -> tuple[bytes, str]:
            headers = {"User-Agent": _UA, "Referer": self.stream_referer}
            resp = self._session().get(url, headers=headers, impersonate="chrome", timeout=20)
            return resp.content, resp.headers.get("content-type", "image/jpeg")
        return await asyncio.to_thread(_do)
