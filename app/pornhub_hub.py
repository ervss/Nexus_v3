"""
PornHub Hub — fast in-dashboard discovery engine.

Scrapes PornHub listing surfaces (search, browse, categories, pornstar pages,
related) into rich, uniform tiles — each with a webm hover-preview — so the
user discovers and curates inside the dashboard instead of leaving for the site.

Listing pages serve fine with age cookies + a browser TLS fingerprint (no JS
challenge), so this is quick. Media (thumbs + previews) is hot-link protected
and must be fetched with a pornhub Referer — see `fetch_media`.
"""
from __future__ import annotations

import asyncio
import logging
import math
import re
import time
import urllib.parse
from typing import Any, Optional

from bs4 import BeautifulSoup
from curl_cffi import requests as cr

logger = logging.getLogger(__name__)

BASE = "https://www.pornhub.com"
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
_COOKIES = {
    "age_verified": "1", "accessAgeDisclaimerPH": "1",
    "accessAgeDisclaimerUK": "1", "accessPH": "1", "platform": "pc",
}

# unified sort -> PornHub `o` code
_SORT = {
    "hottest": "ht", "recent": "mr", "top_rated": "tr",
    "most_viewed": "mv", "longest": "lg",
}
# unified period -> PornHub `t` code
_PERIOD = {"week": "w", "month": "m", "year": "y"}

# Curated category fallback so the UI always has chips.
POPULAR_CATEGORIES = [
    ("amateur", "Amateur"), ("milf", "MILF"), ("teen-18-1", "Teen (18+)"),
    ("anal", "Anal"), ("big-tits", "Big Tits"), ("big-dick", "Big Dick"),
    ("blonde", "Blonde"), ("brunette", "Brunette"), ("ebony", "Ebony"),
    ("latina", "Latina"), ("asian", "Asian"), ("pov", "POV"),
    ("threesome", "Threesome"), ("lesbian", "Lesbian"), ("creampie", "Creampie"),
    ("blowjob", "Blowjob"), ("hardcore", "Hardcore"), ("rough-sex", "Rough Sex"),
    ("hentai", "Hentai"), ("cartoon", "Cartoon"), ("japanese", "Japanese"),
    ("interracial", "Interracial"), ("bbw", "BBW"), ("mature", "Mature"),
    ("public", "Public"), ("squirt", "Squirt"), ("cumshot", "Cumshot"),
    ("verified-amateurs", "Verified Amateurs"), ("popular-with-women", "Popular With Women"),
    ("60fps-1", "60FPS"), ("vr", "VR"), ("step-fantasy", "Step Fantasy"),
]

_session: Optional[cr.Session] = None
_cat_cache: tuple[float, list] = (0.0, [])


def _sess() -> cr.Session:
    global _session
    if _session is None:
        s = cr.Session(impersonate="chrome", timeout=20)
        s.headers.update({"User-Agent": _UA})
        for k, v in _COOKIES.items():
            s.cookies.set(k, v, domain=".pornhub.com")
    return _session or s


async def _get(url: str) -> str:
    def _do():
        r = cr.get(url, headers={"User-Agent": _UA}, cookies=_COOKIES,
                   impersonate="chrome", timeout=20)
        return r.text
    return await asyncio.to_thread(_do)


# --------------------------------------------------------------------------- #
# tile parsing
# --------------------------------------------------------------------------- #
def _abs(href: str) -> str:
    if not href:
        return ""
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return BASE + href
    return href


def _parse_tiles(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    tiles: list[dict] = []
    seen: set[str] = set()
    for li in soup.select("li.pcVideoListItem, li.videoblock"):
        a = li.select_one("a.linkVideoThumb, a[href*='view_video.php']")
        if not a:
            continue
        href = _abs(a.get("href") or "")
        if not href or href in seen:
            continue
        # premium/private items are not playable from outside — skip them
        if li.select_one(".premiumIcon, .p1bClick, .premium-icon"):
            continue
        seen.add(href)

        vid = li.get("data-video-id") or ""
        title_el = li.select_one("span.title a, .title a")
        title = ((title_el.get("title") if title_el else None)
                 or (title_el.get_text(strip=True) if title_el else None)
                 or a.get("title") or "").strip()

        img = li.select_one("img")
        thumb = preview = ""
        if img:
            thumb = (img.get("data-thumb_url") or img.get("data-src")
                     or img.get("src") or "")
            preview = img.get("data-mediabook") or ""
        if not preview:
            mb = li.select_one("[data-mediabook]")
            if mb:
                preview = mb.get("data-mediabook") or ""

        dur = li.select_one(".duration")
        views = li.select_one(".views var, .views")
        rating = li.select_one(".value")
        up = li.select_one(".usernameWrap a, .uploaderName, .userInfoBlock a, .vidTitleWrapper + div a")
        up_href = up.get("href") if (up and up.has_attr("href")) else ""
        hd = bool(li.select_one(".hd-thumbnail")) or " hd " in f" {title.lower()} "

        tiles.append({
            "id": vid,
            "title": title,
            "url": href,
            "thumb": thumb,
            "preview": preview,
            "duration": dur.get_text(strip=True) if dur else "",
            "duration_sec": _dur_to_sec(dur.get_text(strip=True) if dur else ""),
            "views": views.get_text(strip=True) if views else "",
            "rating": rating.get_text(strip=True) if rating else "",
            "uploader": up.get_text(strip=True) if up else "",
            "uploader_url": _abs(up_href),
            "hd": hd,
        })
    return tiles


def _parse_pornstars(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for a in soup.select("a[href*='/pornstar/'], a[href*='/model/']"):
        href = a.get("href") or ""
        m = re.search(r"/(pornstar|model)/([a-z0-9\-]+)", href)
        if not m:
            continue
        kind, slug = m.group(1), m.group(2)
        if slug in seen or slug in ("search",):
            continue
        img = a.select_one("img")
        if not img:
            continue
        name = (a.get("data-name") or img.get("alt") or
                slug.replace("-", " ").title()).strip()
        thumb = img.get("data-thumb_url") or img.get("data-src") or img.get("src") or ""
        if not thumb or len(name) < 2:
            continue
        seen.add(slug)
        out.append({"slug": slug, "kind": kind, "name": name,
                    "thumb": thumb, "url": _abs(href)})
    return out


def _dur_to_sec(text: str) -> int:
    parts = [p for p in re.split(r"[:]", text.strip()) if p.isdigit()]
    if not parts:
        return 0
    sec = 0
    for p in parts:
        sec = sec * 60 + int(p)
    return sec


# --------------------------------------------------------------------------- #
# public surfaces
# --------------------------------------------------------------------------- #
def _build_query(sort: str, period: str, hd: bool,
                 production: str, dur: str) -> dict:
    params: dict[str, str] = {}
    if sort and sort in _SORT:
        params["o"] = _SORT[sort]
    if period and period in _PERIOD:
        params["t"] = _PERIOD[period]
    if hd:
        params["hd"] = "1"
    if production in ("professional", "homemade"):
        params["p"] = production
    if dur == "short":
        params["min_duration"] = "0"; params["max_duration"] = "10"
    elif dur == "medium":
        params["min_duration"] = "10"; params["max_duration"] = "20"
    elif dur == "long":
        params["min_duration"] = "20"
    return params


async def search(query: str, sort: str = "", period: str = "", page: int = 1,
                 hd: bool = False, production: str = "", dur: str = "") -> dict:
    params = _build_query(sort, period, hd, production, dur)
    params["search"] = query
    if page > 1:
        params["page"] = str(page)
    url = f"{BASE}/video/search?" + urllib.parse.urlencode(params)
    html = await _get(url)
    return {"items": _parse_tiles(html), "page": page, "query": query}


async def browse(sort: str = "hottest", period: str = "", page: int = 1,
                 category: str = "", hd: bool = False,
                 production: str = "", dur: str = "") -> dict:
    params = _build_query(sort, period, hd, production, dur)
    if page > 1:
        params["page"] = str(page)
    if category:
        path = f"/{'hd' if category == 'hd' else 'categories/' + category}"
        url = f"{BASE}{path}?" + urllib.parse.urlencode(params)
    else:
        url = f"{BASE}/video?" + urllib.parse.urlencode(params)
    html = await _get(url)
    return {"items": _parse_tiles(html), "page": page, "category": category}


async def related(video_url: str) -> dict:
    html = await _get(video_url)
    soup = BeautifulSoup(html, "html.parser")
    block = soup.select_one("#relatedVideosCenter, .relatedVideos, #recommendedVideos")
    tiles = _parse_tiles(str(block)) if block else _parse_tiles(html)
    return {"items": tiles[:32]}


async def categories() -> list[dict]:
    global _cat_cache
    if time.time() - _cat_cache[0] < 3600 and _cat_cache[1]:
        return _cat_cache[1]
    out: list[dict] = []
    try:
        html = await _get(f"{BASE}/categories")
        soup = BeautifulSoup(html, "html.parser")
        seen: set[str] = set()
        for a in soup.select("a[href*='/categories/']"):
            href = a.get("href") or ""
            m = re.search(r"/categories/([a-z0-9\-]+)", href)
            if not m:
                continue
            slug = m.group(1)
            if slug in seen:
                continue
            name = (a.get("data-category-name") or a.get("title") or "").strip()
            if not name:
                img = a.select_one("img")
                name = (img.get("alt") if img else "") or slug.replace("-", " ").title()
            name = re.sub(r"\d[\d,]*\s*Videos?$", "", name).strip()
            if 1 < len(name) < 28:
                seen.add(slug)
                out.append({"slug": slug, "name": name})
    except Exception as exc:  # noqa: BLE001
        logger.warning("[PH Hub] category scrape failed: %s", exc)
    if len(out) < 12:
        out = [{"slug": s, "name": n} for s, n in POPULAR_CATEGORIES]
    _cat_cache = (time.time(), out)
    return out


async def pornstars(query: str = "", page: int = 1) -> dict:
    if query.strip():
        url = f"{BASE}/video/search?" + urllib.parse.urlencode({"search": query})
        html = await _get(url)
        # search pages embed a pornstar suggestion row; fall back to directory
        stars = _parse_pornstars(html)
        if stars:
            return {"items": stars[:40], "query": query}
    params = {}
    if page > 1:
        params["page"] = str(page)
    url = f"{BASE}/pornstars" + ("?" + urllib.parse.urlencode(params) if params else "")
    html = await _get(url)
    return {"items": _parse_pornstars(html)[:60], "query": query}


async def pornstar_videos(slug: str, kind: str = "pornstar",
                          sort: str = "", page: int = 1, period: str = "",
                          hd: bool = False, production: str = "",
                          dur: str = "") -> dict:
    kind = "model" if kind == "model" else "pornstar"
    # full filter set so sort/duration/HD/production stay scoped to THIS
    # performer instead of dumping the user back into the global feed.
    params = _build_query(sort, period, hd, production, dur)
    if page > 1:
        params["page"] = str(page)
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    url = f"{BASE}/{kind}/{slug}/videos{qs}"
    html = await _get(url)
    tiles = _parse_tiles(html)
    if not tiles and kind == "pornstar":  # some are channels/models
        html = await _get(f"{BASE}/model/{slug}/videos{qs}")
        tiles = _parse_tiles(html)
    # pull the display name from the page header if present
    name = slug.replace("-", " ").title()
    m = re.search(r'<h1[^>]*>([^<]{2,60})</h1>', html)
    if m:
        name = m.group(1).strip()
    return {"items": tiles, "name": name, "slug": slug}


def _quality_str(h: int) -> str:
    if h >= 2160:
        return "4K"
    if h >= 1080:
        return "1080p"
    if h >= 720:
        return "720p"
    if h >= 480:
        return "480p"
    if h > 0:
        return f"{h}p"
    return ""


def _fmt_upload_date(raw: Optional[str], ts: Optional[int]) -> str:
    """ISO date (YYYY-MM-DD) from yt-dlp's YYYYMMDD 'upload_date' or a unix ts."""
    if raw and len(str(raw)) == 8 and str(raw).isdigit():
        s = str(raw)
        return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
    if ts:
        try:
            import datetime as _dt
            return _dt.datetime.utcfromtimestamp(int(ts)).strftime("%Y-%m-%d")
        except Exception:  # noqa: BLE001
            pass
    return ""


async def _head_size(url: str) -> int:
    """Best-effort Content-Length for a (non-HLS) mp4 stream via a ranged GET."""
    def _do() -> int:
        try:
            r = cr.get(url, headers={"User-Agent": _UA, "Referer": BASE + "/",
                                     "Range": "bytes=0-0"},
                       impersonate="chrome", timeout=15)
            cr_hdr = r.headers.get("content-range", "")
            m = re.search(r"/(\d+)\s*$", cr_hdr)
            if m:
                return int(m.group(1))
            return int(r.headers.get("content-length") or 0)
        except Exception:  # noqa: BLE001
            return 0
    return await asyncio.to_thread(_do)


async def enrich(urls: list[str], concurrency: int = 8) -> dict:
    """
    Resolve a batch of watch URLs into real quality + file size + tags, the way
    8000/tester does — but many in parallel so 30 tiles finish in a few seconds
    instead of one-by-one. Each resolve is the heavy yt-dlp path, so we cap the
    in-flight count with a semaphore.
    """
    from .extractors.pornhub import PornhubExtractor
    ext = PornhubExtractor()
    sem = asyncio.Semaphore(max(1, concurrency))

    async def _one(u: str) -> tuple[str, Optional[dict]]:
        async with sem:
            try:
                res = await ext.extract(u)
            except Exception as exc:  # noqa: BLE001
                logger.debug("[PH Hub] enrich failed %s: %s", u, exc)
                res = None
            if not res:
                return u, None
            height = int(res.get("height") or 0)
            size_bytes = res.get("size_bytes") or 0
            if not size_bytes and res.get("stream_url") and not res.get("is_hls"):
                size_bytes = await _head_size(res["stream_url"])
            return u, {
                "height": height,
                "quality": _quality_str(height),
                "size_bytes": size_bytes or None,
                "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
                "tags": res.get("tags") or [],
                "duration_sec": int(res.get("duration") or 0),
                "upload_date": _fmt_upload_date(res.get("upload_date"), res.get("timestamp")),
            }

    pairs = await asyncio.gather(*[_one(u) for u in urls])
    return {u: d for u, d in pairs if d}


def _parse_video_playlists(html: str) -> list[dict]:
    """Public playlists a PornHub video is featured in (the block PH shows under
    the player). Each `li#playlist_<id>` carries the name, video count and a thumb."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for li in soup.select("li[id^='playlist_']"):
        m = re.match(r"playlist_(\d+)", li.get("id", ""))
        if not m:
            continue
        pid = m.group(1)
        if pid in seen:
            continue
        name = ""
        ta = li.select_one("a.title")
        if ta:
            name = ta.get_text(" ", strip=True) or ta.get("title", "")
        if not name:
            for a in li.select("a[href*='/playlist/']"):
                t = a.get_text(" ", strip=True)
                if t and t.lower() not in ("view playlist", "play all"):
                    name = t
                    break
        if not name:
            continue
        num = ""
        ns = li.select_one(".number span, .number")
        if ns:
            num = re.sub(r"\D", "", ns.get_text(" ", strip=True))
        img = li.select_one("img")
        thumb = ""
        if img:
            thumb = img.get("data-thumb_url") or img.get("data-src") or img.get("src") or ""
        seen.add(pid)
        out.append({
            "id": pid,
            "name": name,
            "count": int(num) if num else 0,
            "url": f"{BASE}/playlist/{pid}",
            "thumb": thumb,
        })
    return out


def _playlist_id(value: str) -> str:
    """Return the numeric public playlist id from an id or canonical URL."""
    value = (value or "").strip()
    if "://" in value:
        host = (urllib.parse.urlparse(value).hostname or "").lower()
        if host != "pornhub.com" and not host.endswith(".pornhub.com"):
            return ""
    match = re.search(r"(?:^|/playlist/)(\d+)(?:[/?#]|$)", value)
    return match.group(1) if match else ""


def _playlist_session() -> cr.Session:
    """Create one browser-like session for a complete playlist traversal."""
    session = cr.Session(impersonate="chrome", timeout=20)
    session.headers.update({"User-Agent": _UA})
    for key, value in _COOKIES.items():
        session.cookies.set(key, value, domain=".pornhub.com")
    return session


async def _playlist_get(url: str, referer: str = "", session: Optional[cr.Session] = None) -> str:
    """Fetch a playlist page, retrying the tiny anti-bot interstitial response."""
    def _do() -> str:
        # ``viewChunked`` is an XHR endpoint. Without these two headers the
        # site may return an empty body or a short protection page even when
        # the public playlist itself was available moments before.
        headers = {
            "User-Agent": _UA,
            "Referer": referer or BASE + "/",
            "X-Requested-With": "XMLHttpRequest",
        }
        if session is not None:
            response = session.get(url, headers=headers)
        else:
            response = cr.get(url, headers=headers, cookies=_COOKIES,
                              impersonate="chrome", timeout=20)
        return response.text

    last = ""
    for attempt in range(3):
        last = await asyncio.to_thread(_do)
        # A real playlist or chunk response has many video tiles and is much
        # larger than the short JS challenge response returned intermittently.
        if len(last) > 10_000:
            return last
        if attempt < 2:
            await asyncio.sleep(0.35 * (attempt + 1))
    return last


def _playlist_page_meta(html: str) -> tuple[str, int, str]:
    """Read the id/count/token used by PornHub's public viewChunked endpoint."""
    playlist_id = re.search(r"(?:var\s+)?playlistId\s*[:=]\s*[\"']?([^\"'\s,;]+)", html, re.I)
    item_count = re.search(r"(?:var\s+)?itemsCount\s*[:=]\s*(\d+)", html, re.I)
    token = re.search(r"(?:var\s+)?token\s*[:=]\s*[\"']([^\"']+)", html, re.I)
    return (
        playlist_id.group(1) if playlist_id else "",
        int(item_count.group(1)) if item_count else 0,
        token.group(1) if token else "",
    )


def _dedupe_tiles(pages: list[list[dict]]) -> list[dict]:
    seen: set[str] = set()
    items: list[dict] = []
    for page in pages:
        for item in page:
            url = item.get("url") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            items.append(item)
    return items


def _playlist_tiles(html: str, playlist_id: str) -> list[dict]:
    """Keep playlist cards and discard the two unrelated recommendation cards.

    The playlist page includes a small recommendation rail in the same tile
    markup. Actual playlist video links carry the public playlist ``pkey``.
    """
    tiles = _parse_tiles(html)
    in_playlist = [
        tile for tile in tiles
        if playlist_id in urllib.parse.parse_qs(
            urllib.parse.urlparse(tile.get("url") or "").query
        ).get("pkey", [])
    ]
    return in_playlist or tiles


async def playlist_videos(playlist_id: str, page: int = 1, all_pages: bool = True) -> dict:
    """Return a public playlist, including all of its chunked pages by default.

    PornHub's normal ``?page=`` URL does not paginate a playlist reliably. The
    page itself exposes a token for ``/playlist/viewChunked``; use that endpoint
    so a 176-item playlist is not silently presented as the first ~40 cards.
    """
    pid = _playlist_id(playlist_id)
    if not pid:
        raise ValueError("Invalid public playlist id")
    page = max(1, int(page or 1))
    url = f"{BASE}/playlist/{pid}"
    session = _playlist_session()
    html = await _playlist_get(url, session=session)
    if len(html) <= 10_000:
        # Do not turn a temporary anti-bot response into a deceptively empty
        # playlist. The caller can retry and gets a useful error instead.
        raise RuntimeError("PornHub returned an incomplete playlist page; please retry")
    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.select_one("h1, .playlistTitle, .playlist-title")
    title = title_el.get_text(" ", strip=True) if title_el else ""
    first_page = _playlist_tiles(html, pid)
    source_id, total_items, token = _playlist_page_meta(html)

    # A caller can still request one chunk for a very large playlist. The Hub
    # defaults to the full public list because this is a review workflow.
    if page > 1 and source_id and token:
        chunk_url = f"{BASE}/playlist/viewChunked?" + urllib.parse.urlencode({
            "id": source_id, "page": str(page), "token": token,
        })
        first_page = _playlist_tiles(
            await _playlist_get(chunk_url, referer=url, session=session), pid
        )

    items = first_page
    page_count = 1
    partial = False
    if all_pages and page == 1 and source_id and token and total_items:
        # Initial page contains 36 tiles; each subsequent chunk contains up to
        # 40. This is the same public pagination contract used by yt-dlp.
        page_count = max(1, math.ceil(max(0, total_items - 36) / 40) + 1)
        chunk_urls = [
            f"{BASE}/playlist/viewChunked?" + urllib.parse.urlencode({
                "id": source_id, "page": str(chunk_page), "token": token,
            })
            for chunk_page in range(2, page_count + 1)
        ]
        # Keep the same session for each tokenized request. Parallel requests
        # occasionally invalidate the source's short-lived traversal state.
        chunks = []
        for chunk_url in chunk_urls:
            chunks.append(await _playlist_get(chunk_url, referer=url, session=session))
        parsed_chunks = [_playlist_tiles(chunk, pid) for chunk in chunks]
        items = _dedupe_tiles([first_page, *parsed_chunks])
        partial = any(not chunk for chunk in parsed_chunks)
    elif all_pages and total_items and not (source_id and token):
        partial = True

    return {
        "items": items,
        "page": page,
        "playlist_id": pid,
        "playlist_name": title,
        "total_items": total_items or len(items),
        "loaded_items": len(items),
        "has_more": (not all_pages) and page < page_count,
        "partial": partial,
    }


async def video_playlists(url: str) -> list[dict]:
    """Fetch the video page and return the public playlists it's featured in."""
    def _do():
        r = cr.get(url, headers={"User-Agent": _UA, "Referer": BASE + "/"},
                   cookies=_COOKIES, impersonate="chrome", timeout=25)
        return r.text if r.status_code == 200 else ""
    html = await asyncio.to_thread(_do)
    if not html:
        return []
    return _parse_video_playlists(html)


async def search_playlists(query: str, limit_videos: int = 6) -> list[dict]:
    """Find public playlists relevant to `query`.

    PornHub exposes no public playlist-search endpoint (every /playlists?search=
    URL 404s), so we approximate it the way the site itself surfaces playlists:
    take the top search-result videos and aggregate the playlists each is featured
    in. The result is real, keyword-relevant playlists ranked by how often they
    recur across those videos (then by size)."""
    res = await search(query=query, page=1)
    vids = [t.get("url") for t in (res.get("items") or []) if t.get("url")][:max(1, limit_videos)]

    def _page(u: str) -> str:
        r = cr.get(u, headers={"User-Agent": _UA, "Referer": BASE + "/"},
                   cookies=_COOKIES, impersonate="chrome", timeout=25)
        return r.text if r.status_code == 200 else ""

    htmls = await asyncio.gather(*[asyncio.to_thread(_page, v) for v in vids])
    agg: dict[str, dict] = {}
    for html in htmls:
        if not html:
            continue
        for p in _parse_video_playlists(html):
            row = agg.get(p["id"])
            if row:
                row["hits"] = row.get("hits", 1) + 1
            else:
                p["hits"] = 1
                agg[p["id"]] = p
    ranked = sorted(agg.values(), key=lambda p: (p.get("hits", 1), p.get("count", 0)), reverse=True)
    return ranked


async def fetch_media(url: str) -> tuple[bytes, str]:
    """Proxy a phncdn thumb/preview with a pornhub Referer (hot-link bypass)."""
    def _do():
        r = cr.get(url, headers={"User-Agent": _UA, "Referer": BASE + "/"},
                   cookies=_COOKIES, impersonate="chrome", timeout=25)
        return r.content, r.headers.get("content-type", "application/octet-stream")
    return await asyncio.to_thread(_do)
