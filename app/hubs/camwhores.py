"""Camwhores adapter for the unified Fusion Hub.

Camwhores.tv runs the same KVS gallery engine as WhoresHub/PornTrex, so almost
everything is inherited from KvsHub. Two things differ and are overridden here:

  * Pagination is path-based (/N/) for browse/category/model listings, but the
    /search/ listing 404s on the path form and instead pages via ?from_videos=N.
  * The site is served from the `www.` host and hot-links thumbs from cdn.camwhores.tv.

Live-verified 2026-07-14. Category/model/browse listings advance on the path form;
search needs the query param. See the camwhores-hub / camwhores-pagination-split memos.
"""
from __future__ import annotations

import asyncio
import os
import re
from typing import Any, Optional

from bs4 import BeautifulSoup

from .base import Page
from .kvs import ENRICH_MAX, KvsHub, _slug


def _normalize_rel_date(value: str) -> str:
    """Turn CamWhores' relative watch-page date ("2 years ago", "1 day ago") into
    YYYY-MM-DD. Absolute dates pass through; unknown text returns ''."""
    import datetime as _dt
    text = (value or "").strip().lower()
    if not text:
        return ""
    m = re.search(r"(20\d\d)[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    now = _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)
    if text in ("today", "just now"):
        return now.strftime("%Y-%m-%d")
    if text == "yesterday":
        return (now - _dt.timedelta(days=1)).strftime("%Y-%m-%d")
    m = re.search(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago", text)
    if not m:
        return ""
    n, unit = int(m.group(1)), m.group(2)
    days = {"second": 0, "minute": 0, "hour": 0, "day": n,
            "week": n * 7, "month": n * 30, "year": n * 365}.get(unit, 0)
    return (now - _dt.timedelta(days=days)).strftime("%Y-%m-%d")


class CamwhoresHub(KvsHub):
    source = "camwhores"
    label = "Camwhores"
    origin = "https://www.camwhores.tv"
    video_re = re.compile(r"/videos/\d+(?:/|$)", re.I)
    category_kind = "categories"
    card_class_re = re.compile(r"(?:^|\s)(?:item|box|thumb|video-item)(?:\s|$)", re.I)
    media_hosts = ("camwhores.tv", "cdn.camwhores.tv", "camwhores.cloud")
    stream_referer = "https://www.camwhores.tv/"
    supports_deep_enrich = True
    # Camwhores gives each sort its own landing path (see _base_url); it has no
    # "longest" listing, so that id is deliberately absent from the KVS default.
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    # Measured live 2026-07-25: cam recordings carry a duration and a relative date
    # only — the quality badge appears on a handful of cards (3 of 39), which is
    # noise rather than a field, and the view count / hover preview never render.
    listing_fields = frozenset({"duration", "date"})
    curated_categories = (
        ("chaturbate", "Chaturbate"), ("onlyfans", "OnlyFans"), ("myfreecams", "MyFreeCams"),
        ("cam4", "Cam4"), ("bongacams", "BongaCams"), ("stripchat", "Stripchat"),
        ("naked", "Naked"), ("fansly", "Fansly"), ("manyvids", "ManyVids"),
        ("amateur", "Amateur"), ("teen", "Teen"), ("milf", "MILF"),
    )

    def _parse_tiles(self, html: str) -> list[dict]:  # type: ignore[override]
        # Camwhores mixes PRIVATE (members-only) videos into every listing —
        # often >50% of a page. They render fine as cards but have NO get_file
        # stream, so resolve() 502s and the tile is dead weight. Drop them before
        # the base parser runs: private cards are `<div class="item private">`
        # (also carry a `.line-private` / `.ico-private` badge). Live-verified.
        soup = BeautifulSoup(html or "", "html.parser")
        for card in soup.select("div.item.private, .item.private, .private .item"):
            card.decompose()
        # Belt-and-suspenders: also nuke any card that still holds a private badge.
        for badge in soup.select(".line-private, .ico-private"):
            holder = badge.find_parent(class_=re.compile(r"\bitem\b")) or badge.parent
            if holder:
                holder.decompose()
        return super()._parse_tiles(str(soup))

    async def _playlists_sorted(self, sort_by: str, page: int) -> list[dict]:
        """Fetch one page of the playlist browser under a specific KVS sort via the
        ajax block. `sort_by=last_content_date` surfaces recently-updated playlists
        (where fresh ones like 'BBC Lust' live) — the base playlists() uses the
        default order and misses them."""
        import urllib.parse as _up
        page_param = f"{page:02d}"
        url = (f"{self.origin}/playlists/?mode=async&function=get_block"
               f"&block_id=list_playlists_common_playlists_list"
               f"&sort_by={_up.quote(sort_by)}&from={page_param}")
        status, html, _ = await self._get_html(url, referer=self.origin + "/playlists/")
        if status != 200:
            return []
        soup = BeautifulSoup(html, "html.parser")
        out: list[dict] = []
        seen: set[str] = set()
        for anchor in soup.find_all("a", href=True):
            m = re.search(r"/playlists/(\d+)/([a-z0-9-]+)", anchor.get("href") or "", re.I)
            if not m:
                continue
            pid = f"{m.group(1)}/{m.group(2)}"
            if pid in seen:
                continue
            seen.add(pid)
            card = anchor.find_parent("a", class_=re.compile(r"item")) or anchor
            title_el = card.select_one("strong.title, .title")
            title = (title_el.get_text(strip=True) if title_el else (anchor.get("title") or "")).strip()
            img = card.select_one("img.thumb") or card.find("img")
            thumb = ""
            if img:
                thumb = (img.get("data-original") or img.get("src") or "").strip()
                if thumb.startswith("data:"):
                    thumb = ""
            cnt = ""
            cm = re.search(r"(\d[\d,\s]*)\s*videos?", card.get_text(" ", strip=True), re.I)
            if cm:
                cnt = re.sub(r"\D", "", cm.group(1))
            out.append({"id": pid, "title": title, "thumb": self._absolute(thumb) if thumb else "", "count": cnt})
        return out

    async def find_playlist(self, ref: str) -> dict:  # type: ignore[override]
        # CamWhores has no native playlist search. The old (working) discovery
        # browsed the RECENTLY-UPDATED sort — fresh playlists like "BBC Lust" only
        # surface there, not in the default order the KVS base find_playlist scans.
        # Scan several sorts (recent first) in parallel and title-filter.
        ref = (ref or "").strip()
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", ref, re.I)
        if match:
            return {"found": True, "id": f"{match.group(1)}/{match.group(2)}",
                    "name": match.group(2).replace("-", " ").title()}
        if not ref:
            return {"found": False}
        needle = ref.lower()
        matches: list[dict] = []
        seen: set[str] = set()
        # recently-updated first (catches new playlists), then rating + views for coverage
        for sort_by in ("last_content_date", "rating", "playlist_viewed"):
            pages = list(range(1, 11))  # 10 pages × 30 = 300 playlists per sort
            results = await asyncio.gather(*[self._playlists_sorted(sort_by, p) for p in pages],
                                           return_exceptions=True)
            for res in results:
                if isinstance(res, Exception):
                    continue
                for it in res:
                    pid = it.get("id")
                    title = (it.get("title") or "")
                    if not pid or pid in seen or needle not in title.lower():
                        continue
                    seen.add(pid)
                    tl = title.lower()
                    rank = 0 if tl == needle else 1 if tl.startswith(needle) else 2
                    matches.append({"id": pid, "name": title, "thumb": it.get("thumb", ""),
                                    "count": it.get("count", ""), "_rank": rank})
            if len(matches) >= 40:
                break
        if not matches:
            return {"found": False}
        matches.sort(key=lambda m: m.pop("_rank"))
        best = matches[0]
        return {"found": True, "id": best["id"], "name": best["name"], "matches": matches}

    async def playlist_videos(self, pid: str, *, page: int = 1):  # type: ignore[override]
        # Camwhores playlist pages lazy-load: raw HTML holds only ~8 preview cards,
        # so the KVS base parser undercounts (a 145-video playlist showed 5). The
        # full list is behind the ajax block `playlist_view_playlist_view`, which
        # pages 8 at a time via ?from=N. Collect every page once (server-side loop,
        # capped), cache it, then paginate client-side at 60. Live-verified
        # 2026-07-14 (74/74 videos). Same shape as PornTrex's override.
        import urllib.parse as _up
        import time as _t
        raw = _up.unquote((pid or "").strip())
        match = re.search(r"(?:/playlists/)?(\d+)/([a-z0-9-]+)", raw, re.I)
        if not match:
            raise ValueError("Neplatné ID playlistu")
        clean_id = f"{match.group(1)}/{match.group(2)}"
        page = max(1, int(page or 1))
        base = f"{self.origin}/playlists/{clean_id}/"

        cache_key = f"cwpl::{clean_id}"
        cached = self._page_cache.get(cache_key)
        if cached and _t.monotonic() - cached[0] < self.cache_seconds:
            items = cached[1]
        else:
            items = []
            seen = set()
            seen_raw: set[str] = set()
            for src_page in range(1, 200):  # cap: 200*8 = 1600 videos, plenty
                ajax = (f"{base}?mode=async&function=get_block"
                        f"&block_id=playlist_view_playlist_view"
                        f"&sort_by=added2fav_date&from={src_page}")
                status, html, _ = await self._get_html(ajax, referer=base)
                if status != 200:
                    break
                # STOP only when the RAW page has no new video links at all — NOT
                # when _parse_tiles returns nothing, because a whole page can be
                # private (filtered out) while later pages still hold public videos.
                raw_urls = set(re.findall(r'href="([^"]*/videos/\d+/[^"]*)"', html))
                new_raw = [u for u in raw_urls if u not in seen_raw]
                if not new_raw:
                    break
                seen_raw.update(new_raw)
                # keep only the playable (non-private) tiles for the grid
                for t in self._parse_tiles(html):
                    u = t.get("url")
                    if u and u not in seen:
                        seen.add(u)
                        items.append(t)
            if not items:
                # ajax yielded nothing playable — fall back to the base HTML parser.
                return await super().playlist_videos(pid, page=page)
            self._page_cache[cache_key] = (_t.monotonic(), items)

        name = match.group(2).replace("-", " ").title()
        start = (page - 1) * 60
        window = items[start:start + 60]
        return Page(items=window, page=page,
                    has_more=(start + 60) < len(items),
                    total=len(items),
                    extra={"view": "playlist", "pid": clean_id, "name": name})

    async def search(self, query: str, *, sort: str = "recent", page: int = 1,
                     category: str = "", **filters: Any):  # type: ignore[override]
        # Camwhores /search/<q>/ ignores ?sort_by=post_date and always returns
        # relevance order (3-4 year old clips first). For sort="recent", /tags/<slug>/
        # IS sorted newest-first; use it when available and fall back to /search/.
        q = (query or "").strip()
        cat = (category or "").strip()
        s = (sort or "recent").strip().lower()
        if q and not cat and s == "recent":
            import time as _t
            page_num = max(1, int(page or 1))
            tag_base = f"{self.origin}/tags/{_slug(q)}/"
            tag_url = self._page_url(tag_base, page_num)
            cached = self._page_cache.get(tag_url)
            if cached and _t.monotonic() - cached[0] < self.cache_seconds:
                return cached[1]
            started = _t.perf_counter()
            status, html, final_url = await self._get_html(tag_url)
            if status == 200:
                items = self._parse_tiles(html)
                redirected_back = page_num > 1 and final_url.rstrip("/") == tag_base.rstrip("/")
                if items and not redirected_back:
                    soup = BeautifulSoup(html, "html.parser")
                    next_path = f"/{page_num + 1}/"
                    has_next = any(next_path in (a.get("href") or "") for a in soup.find_all("a", href=True))
                    result = Page(
                        items=items,
                        page=page_num,
                        has_more=has_next or len(items) >= 20,
                        total=None,
                        took_ms=round((_t.perf_counter() - started) * 1000),
                        extra={"source": self.source, "page_url": final_url},
                    )
                    self._page_cache[tag_url] = (_t.monotonic(), result)
                    return result
        return await super().search(query, sort=sort, page=page, category=category, **filters)

    def _base_url(self, query: str, category: str, sort: str) -> str:
        # Camwhores browse landing paths differ from the KVS defaults.
        if query:
            return f"{self.origin}/search/{_slug(query)}/"
        if category:
            return f"{self.origin}/categories/{_slug(category)}/"
        # Live-verified 2026-07-25: /most-viewed/ and /longest/ 404 on this skin —
        # they used to be routed here and every such browse died with HTTP 404.
        # /most-popular/ is the view-ordered listing and it also accepts the KVS
        # `?sort_by=duration`, which is where "longest" now comes from;
        # /latest-updates/ is a fixed feed that ignores sort_by entirely.
        if sort in {"hottest", "most_viewed", "popular", "longest", "duration"}:
            return f"{self.origin}/most-popular/"
        if sort in {"top_rated", "rating"}:
            return f"{self.origin}/top-rated/"
        return f"{self.origin}/latest-updates/"

    async def pornstar_videos(self, slug: str, *, sort: str = "recent", page: int = 1):  # type: ignore[override]
        # Inherit the KVS model browse, then fix Camwhores-specific profile chrome:
        # its <h1> reads "Caylin's New Videos" and the avatar lives on a
        # cdn.camwhores.tv model image the base selector misses.
        result = await super().pornstar_videos(slug, sort=sort, page=page)
        # Base KvsHub strips a trailing "Videos", leaving "<Name>'s New". Peel the
        # possessive "'s New" tail too so we land on the bare model name.
        name = result.extra.get("name") or ""
        name = re.sub(r"['’]s\s+new\s*$", "", name, flags=re.I).strip()
        name = re.sub(r"['’]s$", "", name, flags=re.I).strip()
        if name:
            result.extra["name"] = name
        if not result.extra.get("avatar") and page == 1:
            try:
                status, html, _ = await self._get_html(f"{self.origin}/models/{result.extra.get('slug', slug)}/")
                if status == 200:
                    from bs4 import BeautifulSoup
                    soup = BeautifulSoup(html, "html.parser")
                    img = soup.select_one('img[src*="/contents/models/"], .headline img, .avatar img')
                    if img:
                        src = img.get("data-src") or img.get("src") or ""
                        if src and not src.startswith("data:"):
                            result.extra["avatar"] = self._absolute(src)
            except Exception:
                pass
        return result

    # ── Member surface (a Camwhores member is 3 content sources at once) ──────
    # posted videos = what they uploaded; favourites = their curated picks from
    # anywhere on the site; playlists = themed collections. Live-verified paging:
    # posted -> /videos/N/ ; favourites -> ajax block list_videos_favourite_videos
    # with from_fav_videos=N (from=/from_videos= silently re-serve page 1).

    @staticmethod
    def _member_id(ref: str) -> str:
        ref = (ref or "").strip()
        if ref.isdigit():
            return ref
        m = re.search(r"/members/(\d+)", ref)
        return m.group(1) if m else ""

    async def member_profile(self, ref: str) -> dict:
        """Summary: name, avatar, posted/favourite counts, public/private split, playlists."""
        mid = self._member_id(ref)
        if not mid:
            raise ValueError("Neplatné member id")
        base = f"{self.origin}/members/{mid}"
        status, html, _ = await self._get_html(base + "/")
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, "html.parser")

        h1 = soup.select_one("h1")
        name = re.sub(r"['’]s Page\s*$", "", h1.get_text(strip=True)).strip() if h1 else f"Member {mid}"
        av = soup.select_one('.avatar img, img[src*="/contents/avatars/"], img.thumb')
        avatar = self._absolute(av.get("data-src") or av.get("src") or "") if av else ""

        def _count(frag: str, *, exclude: str = "") -> int:
            # "/videos/" is a substring of "/favourites/videos/", and the menu link
            # ("Videos 99+") carries no number — so require a numeric "<n> videos"
            # text and skip the excluded path.
            for anchor in soup.find_all("a", href=True):
                href = anchor["href"]
                if frag not in href or (exclude and exclude in href):
                    continue
                m = re.search(r"(\d[\d\s,]*)\s*videos?\b", anchor.get_text(" ", strip=True), re.I)
                if m:
                    return int(re.sub(r"\D", "", m.group(1)) or 0)
            return 0

        public = private = 0
        for anchor in soup.select(".headline a, .headline span, .tabs a"):
            txt = re.sub(r"\s+", " ", anchor.get_text(" ", strip=True))
            mp = re.search(r"Public\s*\((\d[\d\s]*)\)", txt, re.I)
            mv = re.search(r"Private\s*\((\d[\d\s]*)\)", txt, re.I)
            if mp:
                public = int(re.sub(r"\D", "", mp.group(1)))
            if mv:
                private = int(re.sub(r"\D", "", mv.group(1)))

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
            playlists.append({
                "id": f"{pm.group(1)}/{pm.group(2)}",
                "url": self._absolute(anchor["href"]),
                "title": title,
                "count": vc.group(1) if vc else "",
            })

        return {
            "member_id": mid, "name": name, "avatar": avatar, "url": base + "/",
            "posted_count": _count("/videos/", exclude="/favourites/"),
            "favourite_count": _count("/favourites/videos/"),
            "public_count": public, "private_count": private,
            "playlists": playlists,
        }

    async def member_videos(self, ref: str, *, kind: str = "posted", page: int = 1):
        """List a member's posted OR favourite videos as a uniform Page of tiles."""
        mid = self._member_id(ref)
        if not mid:
            raise ValueError("Neplatné member id")
        page = max(1, int(page or 1))
        kind = (kind or "posted").strip().lower()
        if kind == "favourites":
            root = f"{self.origin}/members/{mid}/favourites/videos/"
            url = root if page <= 1 else (
                f"{root}?mode=async&function=get_block"
                f"&block_id=list_videos_favourite_videos"
                f"&fav_type=0&playlist_id=0&sort_by=&from_fav_videos={page}"
            )
        else:
            # Public uploads live on the member profile, paged as /members/{id}/{n}/.
            # /members/{id}/videos/ is often an empty shell without the card list.
            root = f"{self.origin}/members/{mid}/"
            url = root if page <= 1 else f"{root}{page}/"
        status, html, final_url = await self._get_html(url)
        if status == 404 and page > 1:
            return Page(items=[], page=page, has_more=False,
                        extra={"view": "member", "kind": kind, "member_id": mid})
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        block_id = (
            "list_videos_favourite_videos" if kind == "favourites"
            else "list_videos_uploaded_videos"
        )
        items = self._parse_member_video_block(html, block_id) or (
            self._parse_tiles(html) if kind == "favourites" else []
        )
        redirected_back = page > 1 and final_url.rstrip("/") == root.rstrip("/")
        # Camwhores member pages often hold < 8 public items on a page (e.g. 3 or 12)
        # even when hundreds more exist on /2/, /3/... — never stop solely on
        # len(items) < 8. Check raw .item count and .pagination instead.
        has_more = False
        if not redirected_back:
            soup = BeautifulSoup(html or "", "html.parser")
            scope = soup.select_one(f"#{block_id}") or (soup if kind == "favourites" else None)
            raw_count = len(scope.select(".item")) if scope else 0
            pag_links = scope.select(".pagination a") if scope else []
            if pag_links:
                has_next = any(
                    (a.get_text(strip=True).lower() in {"next", "last"} and "disabled" not in (a.get("class") or []))
                    or (a.get_text(strip=True).isdigit() and int(a.get_text(strip=True)) > page)
                    for a in pag_links
                )
                has_more = has_next
            else:
                has_more = bool(items) or raw_count > 0
        return Page(items=items, page=page,
                    has_more=has_more,
                    extra={"view": "member", "kind": kind, "member_id": mid})

    def _parse_member_video_block(self, html: str, block_id: str) -> list[dict]:
        soup = BeautifulSoup(html or "", "html.parser")
        block = soup.select_one(f"#{block_id}")
        if not block:
            return []
        return self._parse_tiles(str(block))

    def _page_url(self, base: str, page: int) -> str:  # type: ignore[override]
        # Browse/category/model/playlist listings page via the /N/ path form
        # (KVS default). The /search/ listing 404s on that and instead pages via
        # ?from_videos=N — detect it by the /search/ segment. Instance method (not
        # the base @staticmethod) so this stays per-call and thread-safe.
        if page <= 1:
            return base
        if "/search/" in base:
            return f"{base.rstrip('/')}/?from_videos={page}"
        return f"{base.rstrip('/')}/{page}/"

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.camwhores import CamwhoresExtractor
        return await CamwhoresExtractor().extract(url)

    @staticmethod
    def _split_metadata(value: str) -> list[dict]:
        out, seen = [], set()
        for part in re.split(r"[,\|]", value or ""):
            name = part.strip()
            key = name.lower()
            if name and key not in seen:
                seen.add(key)
                out.append({"slug": _slug(name), "name": name})
        return out

    async def _detail_metadata(self, url: str, *, deep: bool = False) -> dict:  # type: ignore[override]
        """Fast HTML metadata by default; stream/size probing only when requested."""
        cached = self._detail_cache_get(url, deep=deep)
        if cached:
            return cached

        from .base import secs_to_pretty
        from ..extractors.camwhores import CamwhoresExtractor
        extractor = CamwhoresExtractor()

        if deep:
            data = await self._extract(url)
            if not data:
                return await self._detail_metadata(url, deep=False)
            height = int(data.get("height") or 0)
            size_bytes = int(data.get("size_bytes") or 0)
            tags = data.get("tags") or []
            if isinstance(tags, str):
                tags = [t.strip() for t in re.split(r"[,\|]", tags) if t.strip()]
            duration_sec = int(data.get("duration") or 0)
            result = {
                "title": data.get("title") or "",
                "thumbnail": data.get("thumbnail") or "",
                "duration_sec": duration_sec,
                "duration": secs_to_pretty(duration_sec),
                "height": height,
                "quality": "4K" if height >= 2160 else (f"{height}p" if height else ""),
                "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
                # The deep pass probes the resolved stream with a real range/HEAD
                # request, so this is a measured byte count, not a bitrate guess.
                "size_estimated": False,
                "codec": "mp4" if data.get("stream_url") else "",
                "hd": height >= 720,
                "performers": self._split_metadata(data.get("models") or ""),
                "categories": self._split_metadata(data.get("categories") or ""),
                "video_tags": [t["name"] for t in self._split_metadata(",".join(tags))] if tags else [],
                "upload_date": data.get("upload_date") or "",
                "description": data.get("description") or "",
                "preview": data.get("preview_mp4_url") or "",
                "uploader": data.get("uploader") or "",
                "uploader_id": data.get("uploader_id") or "",
                "metadata_level": "deep",
            }
            return self._detail_cache_put(url, result, deep=True)

        status, html, _ = await self._get_html(url, referer=self.origin + "/")
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        flashvars = extractor._parse_flashvars(html)
        candidates = extractor._extract_candidates_from_html(html)
        height = 0
        # preview_height1 IS the video height here — the screenshot is generated at the
        # source resolution (verified against the mp4 tkhd box: 1200 -> 1920x1200,
        # 1280 -> 960x1280, 736 -> 544x736). Values that look wrong for a 16:9 tube are
        # portrait cam recordings. video_height is absent on this skin.
        raw_height = flashvars.get("preview_height1") or flashvars.get("video_height") or ""
        if str(raw_height).isdigit():
            height = int(raw_height)
        if not height and candidates:
            height = extractor._infer_height_from_url(candidates[0])

        # CamWhores publishes no size anywhere in the page; the single unlabelled
        # `video_url` does answer a HEAD, which is the only cheap way to get one without
        # the deep (stream-resolving) pass.
        size_bytes = 0
        if candidates:
            size_bytes = await self._head_size(candidates[0])
        duration_sec = extractor._extract_duration(html)
        extras = extractor._extract_page_extras(html)
        tags = self._split_metadata(flashvars.get("video_tags") or "")
        preview_img = flashvars.get("preview_url1") or flashvars.get("preview_url") or ""
        preview = re.sub(r"\.(?:jpg|png|webp|jpeg)$", ".mp4", preview_img, flags=re.I) if preview_img else ""
        result = {
            "title": flashvars.get("video_title") or extractor._extract_title(html),
            "thumbnail": extractor._extract_thumbnail(html) or "",
            "duration_sec": duration_sec,
            "duration": secs_to_pretty(duration_sec),
            "height": height,
            "quality": "4K" if height >= 2160 else (f"{height}p" if height else ""),
            "size_mb": round(size_bytes / (1024 * 1024), 1) if size_bytes else None,
            # HEAD content-length on the unlabelled `video_url` — measured.
            "size_estimated": False,
            "codec": "mp4" if candidates else "",
            "hd": height >= 720,
            "performers": self._split_metadata(flashvars.get("video_models") or ""),
            "categories": self._split_metadata(flashvars.get("video_categories") or ""),
            "video_tags": [row["name"] for row in tags],
            "upload_date": extras.get("upload_date") or "",
            "description": "",
            "preview": preview,
            "uploader": extras.get("uploader") or "",
            "uploader_id": extras.get("uploader_id") or "",
            "metadata_level": "fast",
        }
        return self._detail_cache_put(url, result)

    async def enrich(self, urls: list[str], *, deep: bool = False) -> dict[str, dict]:  # type: ignore[override]
        limit = 4 if deep else max(4, int(os.getenv("CAMWHORES_FAST_METADATA_CONCURRENCY", "10")))
        sem = asyncio.Semaphore(limit)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                return url, await self._detail_metadata(url, deep=deep)

        results = dict(await asyncio.gather(*[one(url) for url in urls[:ENRICH_MAX]]))
        self._save_detail_cache()
        return results

    async def enrich_stream(self, urls: list[str], *, deep: bool = False):  # type: ignore[override]
        limit = 4 if deep else max(4, int(os.getenv("CAMWHORES_FAST_METADATA_CONCURRENCY", "10")))
        sem = asyncio.Semaphore(limit)

        async def one(url: str) -> tuple[str, dict]:
            async with sem:
                return url, await self._detail_metadata(url, deep=deep)

        tasks = [asyncio.create_task(one(url)) for url in urls[:ENRICH_MAX]]
        try:
            for task in asyncio.as_completed(tasks):
                try:
                    yield await task
                except Exception:
                    continue
        finally:
            self._save_detail_cache()
