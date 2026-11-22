"""CamWhoresBay adapter for the unified Fusion Hub.

CamWhoresBay.com is a close sibling of the already-integrated Camwhores.tv
(CamwhoresHub) — same operator, same KVS getEmbed/get_file/kt_player skin
template, different domain/brand. Live-verified 2026-09-04: canonical origin
is https://www.camwhoresbay.com (bare requests redirect there — origin is set
to the canonical `www.` form up front to avoid the extra redirect hop on
every request), video URLs are /videos/{id}/{slug}/, /latest-updates/ has 70
active cards.

Because this is the same site template as camwhores.py, this subclass mirrors
its non-trivial overrides rather than WhoresHub/PornTrex's plainer shape:
  * `_parse_tiles` drops PRIVATE (members-only) cards, which have no get_file
    stream and would otherwise 502 on resolve().
  * `_base_url` uses Camwhores' own landing paths (no /most-viewed/, no
    /longest/ — verified 404 on the sibling skin) instead of the KVS default.
  * `_page_url` pages /search/ via ?from_videos=N while every other listing
    pages via the /N/ path form (Camwhores' pagination split).
  * pornstar_videos() name/avatar cleanup for the same "<Name>'s New Videos"
    heading shape.

These path/behaviour choices are carried over from camwhores.py on the
assumption CamWhoresBay runs the identical template (same operator) — they
were NOT independently re-verified live on this domain (only /videos/ URL
shape and /latest-updates/ card count were). Spot-check /most-popular/,
/top-rated/, and the /search/ pagination form before relying on them.
"""
from __future__ import annotations

import re
from typing import Optional

from bs4 import BeautifulSoup

from .base import Page
from .kvs import KvsHub, _slug


class CamwhoresbayHub(KvsHub):
    source = "camwhoresbay"
    label = "CamWhoresBay"
    origin = "https://www.camwhoresbay.com"
    video_re = re.compile(r"/videos/\d+(?:/|$)", re.I)
    category_kind = "categories"
    card_class_re = re.compile(r"(?:^|\s)(?:item|box|thumb|video-item)(?:\s|$)", re.I)
    media_hosts = ("camwhoresbay.com", "www.camwhoresbay.com", "cwb.cdntrex.com")
    stream_referer = "https://www.camwhoresbay.com/"
    supported_sorts = ("recent", "popular", "top_rated", "most_viewed")
    # Not individually measured live for this domain; carried over from the
    # camwhores.tv sibling skin (cam recordings: duration + relative date only).
    listing_fields = frozenset({"duration", "date"})
    curated_categories = (
        ("chaturbate", "Chaturbate"), ("onlyfans", "OnlyFans"), ("myfreecams", "MyFreeCams"),
        ("cam4", "Cam4"), ("bongacams", "BongaCams"), ("stripchat", "Stripchat"),
        ("naked", "Naked"), ("fansly", "Fansly"), ("manyvids", "ManyVids"),
        ("amateur", "Amateur"), ("teen", "Teen"), ("milf", "MILF"),
    )

    def _parse_tiles(self, html: str) -> list[dict]:  # type: ignore[override]
        # Same private-card filtering as camwhores.py: CamWhoresBay is assumed
        # to mix members-only videos into listings the same way its sibling
        # does. They render as cards but have no get_file stream.
        soup = BeautifulSoup(html or "", "html.parser")
        for card in soup.select("div.item.private, .item.private, .private .item"):
            card.decompose()
        for badge in soup.select(".line-private, .ico-private"):
            holder = badge.find_parent(class_=re.compile(r"\bitem\b")) or badge.parent
            if holder:
                holder.decompose()
        return super()._parse_tiles(str(soup))

    def _base_url(self, query: str, category: str, sort: str) -> str:
        if query:
            return f"{self.origin}/search/{_slug(query)}/"
        if category:
            return f"{self.origin}/categories/{_slug(category)}/"
        if sort in {"hottest", "most_viewed", "popular", "longest", "duration"}:
            return f"{self.origin}/most-popular/"
        if sort in {"top_rated", "rating"}:
            return f"{self.origin}/top-rated/"
        return f"{self.origin}/latest-updates/"

    def _page_url(self, base: str, page: int) -> str:  # type: ignore[override]
        if page <= 1:
            return base
        if "/search/" in base:
            return f"{base.rstrip('/')}/?from_videos={page}"
        return f"{base.rstrip('/')}/{page}/"

    async def pornstar_videos(self, slug: str, *, sort: str = "recent", page: int = 1):  # type: ignore[override]
        result = await super().pornstar_videos(slug, sort=sort, page=page)
        name = result.extra.get("name") or ""
        name = re.sub(r"['’]s\s+new\s*$", "", name, flags=re.I).strip()
        name = re.sub(r"['’]s$", "", name, flags=re.I).strip()
        if name:
            result.extra["name"] = name
        return result

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.camwhoresbay import CamwhoresbayExtractor
        return await CamwhoresbayExtractor().extract(url)
