"""PornHub adapter for the unified Fusion Hub.

PornHub already had a full, standalone discovery engine in `app/pornhub_hub.py`
(its own router + its own UI panel) written before the `HubAdapter` contract
existed. Nothing here re-scrapes the site: this module is a thin, honest
translation layer that maps that module's dict-shaped surfaces onto `Tile`/`Page`
so PornHub becomes one more selectable source next to Eporner/xHamster/…

What the legacy module actually gives us (verified live 2026-07-25, see the
verification notes below), because that is what the declarations here must match:

  * listing (`_parse_tiles`) → title, url, thumb, **webm hover preview**, duration,
    views, uploader, and a boolean `hd` BADGE. There is no upload date, no tags and
    no real resolution — the `hd` flag is the presence of a `.hd-thumbnail` element,
    not a height — so `listing_fields` claims duration/views/preview only and
    `needs_enrich` stays True.
  * `enrich()` → the heavy yt-dlp path (PornhubExtractor) giving the real height,
    quality, duration, tags, upload date and a size.
  * media (thumbs, previews and the resolved HLS stream) is hot-link protected and
    all of it lives under *.phncdn.com — hence `media_hosts` + `stream_referer`,
    which gate both /hub/pornhub/media and /hub/pornhub/stream.

Deliberately NOT implemented: `playlists()` (the browse-a-list-of-playlists
surface). PornHub publishes no public playlist directory — the legacy module says
so explicitly and approximates playlist discovery by aggregating the playlists that
the top search hits appear in. That is a search, not a browsable feed, so it is
exposed through `find_playlist()` instead; `playlists()` is left undefined so the
registry's `hasattr` capability probe honestly reports "no playlist browser".
`member_profile()`/`member_videos()` are likewise absent (no member surface exists
in the legacy module).
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

from .. import pornhub_hub as ph
from .base import HubAdapter, Page, Tile, secs_to_pretty

logger = logging.getLogger(__name__)

#: Filter kwargs the legacy module's search/browse/pornstar surfaces accept.
_FILTER_KEYS = ("period", "hd", "production", "dur")


def _filters(raw: dict[str, Any]) -> dict[str, Any]:
    """Keep only the filters `pornhub_hub` really honours; drop the rest silently."""
    out: dict[str, Any] = {}
    for key in _FILTER_KEYS:
        value = raw.get(key)
        if value in (None, ""):
            continue
        out[key] = bool(value) if key == "hd" else str(value)
    return out


def _views(text: str) -> str:
    """PornHub's tile renders "74Kviews" as one run-together token."""
    return re.sub(r"(?i)\s*views\s*$", "", (text or "").strip()).strip()


def _viewkey(url: str) -> str:
    match = re.search(r"viewkey=([A-Za-z0-9]+)", url or "")
    return match.group(1) if match else (url or "")


def _tile(row: dict) -> Tile:
    """One `pornhub_hub._parse_tiles` row -> a uniform hub Tile.

    The field names only *look* alike: the legacy row has no `tags`/`added`/
    `height`/`quality`/`size_mb` at all, and its `hd` is a thumbnail badge, so
    those Tile fields stay at their empty defaults until enrich() fills them.
    """
    duration_sec = int(row.get("duration_sec") or 0)
    return Tile(
        id=str(row.get("id") or "") or _viewkey(row.get("url") or ""),
        title=(row.get("title") or "").strip(),
        url=row.get("url") or "",
        thumb=row.get("thumb") or "",
        preview=row.get("preview") or "",
        duration_sec=duration_sec,
        duration=(row.get("duration") or "").strip() or secs_to_pretty(duration_sec),
        views=_views(row.get("views") or ""),
        rating=(row.get("rating") or "").strip(),
        uploader=(row.get("uploader") or "").strip(),
        uploader_url=row.get("uploader_url") or "",
        hd=bool(row.get("hd")),
        enriched=False,
    )


def _tiles(rows: list[dict]) -> list[dict]:
    return [_tile(r).to_dict() for r in rows or [] if r.get("url")]


def _quality_str(height: int) -> str:
    if height >= 2160:
        return "4K"
    if height >= 1440:
        return "1440p"
    if height >= 1080:
        return "1080p"
    if height >= 720:
        return "720p"
    if height >= 480:
        return "480p"
    return f"{height}p" if height > 0 else ""


class PornHubHub(HubAdapter):
    source = "pornhub"
    label = "PornHub"
    #: The listing carries no resolution and no size — both come from the yt-dlp
    #: enrich pass, so the quality gate must ask for it.
    needs_enrich = True
    #: Every thumb (pix-fl / pix-cdn77 / ei), every hover preview (ew) and every
    #: resolved stream (hv-h) is a *.phncdn.com host; the router matches
    #: `host == h or host.endswith("." + h)`, so the apex entry covers them all.
    media_hosts = ("pornhub.com", "phncdn.com")
    stream_referer = "https://www.pornhub.com/"
    #: Exactly the keys of `pornhub_hub._SORT`. Each maps to a real `?o=` code that
    #: `_build_query` puts on search, browse, category and pornstar URLs alike, so
    #: every button here changes the listing the user gets back. "relevance" is
    #: absent on purpose: it is merely the absence of `o`, and would be a no-op
    #: button on the browse feeds.
    supported_sorts = ("recent", "hottest", "top_rated", "most_viewed", "longest")
    #: Live-verified against a real /video/search page: 26–40 tiles, each with a
    #: duration, a view count and a webm `data-mediabook` preview. No upload date,
    #: no tags, and the `hd` marker is a badge rather than a measured height, so
    #: neither "date" nor "height" may be claimed here.
    listing_fields = frozenset({"duration", "views", "preview"})

    # ── discovery ────────────────────────────────────────────────────────────
    async def search(self, query: str, *, sort: str = "", page: int = 1,
                     category: str = "", **filters: Any) -> Page:
        """Keyword search. PornHub's /video/search takes no category parameter, so a
        category picked alongside a query is folded into the keywords (the same
        approximation the Eporner adapter makes); category-only browsing goes to the
        real /categories/{slug} feed via browse()."""
        query = (query or "").strip()
        category = (category or "").strip().lower()
        if category and not query:
            return await self.browse(sort=sort, category=category, page=page, **filters)
        effective = " ".join(t for t in (query, category.replace("-", " ")) if t)
        page = max(1, int(page or 1))
        data = await ph.search(effective, sort=sort or "", page=page, **_filters(filters))
        items = _tiles(data.get("items") or [])
        return Page(items=items, page=page, has_more=len(items) >= 20,
                    extra={"query": query, "category": category})

    async def browse(self, *, sort: str = "", category: str = "", page: int = 1,
                     **filters: Any) -> Page:
        page = max(1, int(page or 1))
        data = await ph.browse(sort=sort or "hottest", page=page,
                               category=(category or "").strip().lower(),
                               **_filters(filters))
        items = _tiles(data.get("items") or [])
        return Page(items=items, page=page, has_more=len(items) >= 20,
                    extra={"category": data.get("category") or ""})

    async def _fetch_categories(self) -> list[tuple[str, str]]:
        """`pornhub_hub.categories()` already returns {slug,name} (scraped, with a
        curated fallback); hand the pairs to the base class so its cache and
        `dedupe_categories` normalisation apply like every other source."""
        rows = await ph.categories()
        return [(str(r.get("slug") or ""), str(r.get("name") or "")) for r in rows or []]

    async def related(self, url: str) -> Page:
        data = await ph.related(url)
        items = _tiles(data.get("items") or [])
        current = (url or "").rstrip("/")
        items = [it for it in items if (it.get("url") or "").rstrip("/") != current]
        return Page(items=items, page=1, has_more=False,
                    extra={"related_mode": "watch-page-tiles"})

    # ── performers ───────────────────────────────────────────────────────────
    async def pornstar_videos(self, slug: str, *, sort: str = "", page: int = 1,
                              kind: str = "pornstar", **filters: Any) -> Page:
        page = max(1, int(page or 1))
        data = await ph.pornstar_videos(slug, kind=kind, sort=sort or "", page=page,
                                        **_filters(filters))
        items = _tiles(data.get("items") or [])
        return Page(items=items, page=page, has_more=len(items) >= 20,
                    extra={"view": "pornstar", "slug": data.get("slug") or slug,
                           "name": data.get("name") or "", "avatar": ""})

    async def find_pornstar(self, name: str) -> dict:
        """Resolve a typed name to a performer page.

        `pornhub_hub.pornstars(query=…)` is NOT a performer search — it scrapes every
        /pornstar/ and /model/ link off a video-search page, so it happily returns
        performers who have nothing to do with the typed name (searching "riley reid"
        returned Kandy Lux first). Trusting its first row would send the user to the
        wrong profile, so a name match is required, and the slug is confirmed by
        actually loading the profile's video listing.

        The guessed slug needs a stricter proof than a name-matched suggestion: a
        nonexistent /pornstar/{slug}/videos page does not 404 cleanly — it still
        renders a couple of recommendation cards, so "any tiles at all" reported a
        performer for "zzzz nonexistent". A guess is only accepted on a full grid.
        """
        needle = " ".join((name or "").split()).lower()
        if not needle:
            return {"found": False}
        slug = re.sub(r"[^a-z0-9]+", "-", needle).strip("-")

        matches: list[dict] = []
        try:
            data = await ph.pornstars(query=needle)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[PornHub Hub] pornstar suggestion scrape failed: %s", exc)
            data = {}
        for row in data.get("items") or []:
            row_name = (row.get("name") or "").strip()
            low = row_name.lower()
            if not row_name or needle not in low:
                continue
            matches.append({"slug": row.get("slug") or "", "name": row_name,
                            "avatar": row.get("thumb") or "",
                            "kind": row.get("kind") or "pornstar",
                            "_rank": 0 if low == needle else 1})
        matches.sort(key=lambda m: m.pop("_rank"))

        candidates = [dict(m, min_tiles=1) for m in matches if m.get("slug")]
        if slug and slug not in [m["slug"] for m in candidates]:
            candidates.append({"slug": slug, "name": needle.title(), "avatar": "",
                               "kind": "pornstar", "min_tiles": 6})
        for cand in candidates[:3]:
            try:
                page = await ph.pornstar_videos(cand["slug"], kind=cand.get("kind", "pornstar"))
            except Exception as exc:  # noqa: BLE001
                logger.debug("[PornHub Hub] pornstar probe failed %s: %s", cand["slug"], exc)
                continue
            if len(page.get("items") or []) >= cand["min_tiles"]:
                return {"found": True, "slug": cand["slug"],
                        "name": page.get("name") or cand["name"],
                        "avatar": cand.get("avatar", ""),
                        "count_hint": len(page["items"]),
                        "matches": matches}
        return {"found": False, "slug": slug, "matches": matches}

    # ── playlists (search + open; no browsable directory — see module docstring) ─
    async def playlist_videos(self, pid: str, *, page: int = 1) -> Page:
        """One page of a public playlist.

        The legacy helper defaults to `all_pages=True`, which pulls EVERY chunk in
        one call and then reports `has_more=False`; that is the standalone UI's
        "load the whole list" contract, not the hub's infinite scroll. Ask for a
        single page instead and derive `has_more` from the playlist's own
        `total_items` (page 1 holds 36 tiles, later chunks 40 — PornHub's public
        pagination contract, quoted in the module).
        """
        page = max(1, int(page or 1))
        data = await ph.playlist_videos(pid, page=page, all_pages=False)
        items = _tiles(data.get("items") or [])
        total = int(data.get("total_items") or 0)
        consumed = 36 + (page - 1) * 40 if page > 1 else len(items)
        return Page(items=items, page=page,
                    has_more=bool(items) and bool(total) and consumed < total,
                    total=total or len(items),
                    extra={"view": "playlist", "pid": data.get("playlist_id") or pid,
                           "name": data.get("playlist_name") or "",
                           "partial": bool(data.get("partial"))})

    async def find_playlist(self, ref: str) -> dict:
        """A pasted playlist URL/id, or a keyword search over the playlists that the
        top results for that keyword are featured in (PornHub has no playlist-search
        endpoint — every /playlists?search= URL 404s)."""
        ref = (ref or "").strip()
        if not ref:
            return {"found": False}
        pid = ph._playlist_id(ref)
        if pid:
            return {"found": True, "id": pid, "name": ""}
        rows = await ph.search_playlists(ref)
        matches = [{"id": r.get("id") or "", "name": r.get("name") or "",
                    "thumb": r.get("thumb") or "", "count": r.get("count") or 0}
                   for r in rows if r.get("id")]
        if not matches:
            return {"found": False}
        best = matches[0]
        return {"found": True, "id": best["id"], "name": best["name"], "matches": matches}

    # ── heavy passes ─────────────────────────────────────────────────────────
    async def enrich(self, urls: list[str], concurrency: int = 8) -> dict[str, dict]:
        """url -> real quality/height/duration/tags/date, via the legacy enrich().

        Shape notes, so nothing here over-claims:
          * `performers`/`categories`/`description`/`codec` have no source in the
            legacy pass (the extractor returns tags + uploader only), so they are
            reported as empty rather than invented — the frontend's `_ephPatchItem`
            keeps the tile's existing value for any falsy field.
          * `size_estimated` is deliberately NOT set. The legacy pass takes its size
            from yt-dlp's `filesize`/`filesize_approx`, from a bitrate × duration
            derivation, or from a ranged GET on a progressive mp4 — and its return
            value does not say which. Claiming `False` would present a bitrate guess
            as a measured byte count; claiming `True` would flag a real
            Content-Length as approximate. Unknown provenance stays unstated.
        """
        urls = [u for u in (urls or []) if u]
        if not urls:
            return {}
        raw = await ph.enrich(urls, concurrency=concurrency)
        out: dict[str, dict] = {}
        for url, data in (raw or {}).items():
            if not data:
                continue
            height = int(data.get("height") or 0)
            duration_sec = int(data.get("duration_sec") or 0)
            tags = [t for t in (data.get("tags") or []) if t][:24]
            upload_date = data.get("upload_date") or ""
            out[url] = {
                "quality": data.get("quality") or _quality_str(height),
                "height": height,
                "hd": height >= 720,
                "size_mb": data.get("size_mb"),
                "codec": "",
                "performers": [],
                "categories": [],
                "video_tags": tags,
                "tags": tags,
                "upload_date": upload_date,
                # Mirrored because the hub Tile's date field is `added`, while the
                # frontend patcher reads `upload_date` first.
                "added": upload_date,
                "description": "",
                "duration_sec": duration_sec,
                "duration": secs_to_pretty(duration_sec),
            }
        return out

    async def resolve(self, url: str) -> dict:
        if "pornhub." not in (url or "").lower():
            raise ValueError("Not a PornHub URL")
        from ..extractors.pornhub import PornhubExtractor
        res: Optional[dict] = await PornhubExtractor().extract(url)
        if not res or not res.get("stream_url"):
            raise RuntimeError("Could not resolve a PornHub stream")
        return {
            "stream_url": res["stream_url"],
            "is_hls": bool(res.get("is_hls")),
            "title": res.get("title", ""),
            "duration": res.get("duration", 0),
            "thumbnail": res.get("thumbnail") or "",
        }

    async def fetch_media(self, url: str) -> tuple[bytes, str]:
        return await ph.fetch_media(url)
