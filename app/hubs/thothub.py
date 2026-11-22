"""Thothub adapter for the unified Fusion Hub.

Thothub.to runs the classic KVS gallery engine — same family as PornTrex/
WhoresHub/CamWhores — so most of this is inherited from KvsHub. Live-verified
2026-09-04 (fetched real listing + watch-page HTML, and cross-checked the
resolved stream in a real browser):

  * origin https://thothub.to, video URLs are /videos/{id}/{slug}/.
  * /categories/ and /latest-updates/ both live and return real cards —
    category taxonomy confirmed structurally (curated_categories below are
    still a guessed subset of names, not scraped from the live nav).
  * Cards use `<div class="item">` / `<div class="item private">` — EXACTLY
    the same markup CamWhores uses — and on /latest-updates/ the large
    majority of cards (22/24 measured) are private (members-only, no
    get_file stream). _parse_tiles below drops them the same way
    CamwhoresHub does; without this, resolve() 404s on most listed tiles.
  * No quality/height badge and no dedicated `.duration` element on cards —
    duration is recovered by the base parser's free-text regex fallback.
  * Watch-page flashvars URLs are SCRAMBLED (`function/0/…/get_file/<hash>/…`
    with a garbled hash) — see app/extractors/thothub.py for the KVS
    license_code deobfuscation (ported from PimpBunny/yt-dlp) this needs;
    confirmed byte-for-byte against the real browser-resolved stream URL.

NOT independently re-verified live: the specific slugs in curated_categories,
and the /models/ path used by pornstar_videos() (inherited from KvsHub) —
spot-check both before relying on them.
"""
from __future__ import annotations

import re
from typing import Optional

from bs4 import BeautifulSoup

from .kvs import KvsHub


class ThothubHub(KvsHub):
    source = "thothub"
    label = "Thothub"
    origin = "https://thothub.to"
    video_re = re.compile(r"/videos/\d+(?:/|$)", re.I)
    category_kind = "categories"
    card_class_re = re.compile(r"(?:^|\s)item(?:\s|$)", re.I)
    media_hosts = ("thothub.to", "www.thothub.to")
    stream_referer = "https://thothub.to/"
    # Live-verified 2026-09-04: cards carry a relative date and (usually) a
    # views count and duration recovered from free text; NO quality/height
    # badge exists anywhere on the listing skin.
    listing_fields = frozenset({"duration", "date", "views"})
    curated_categories = (
        ("4k", "4K"), ("hd", "HD"), ("amateur", "Amateur"), ("cosplay", "Cosplay"),
        ("twitch", "Twitch"), ("patreon", "Patreon"), ("onlyfans", "OnlyFans"),
        ("anal", "Anal"), ("lesbian", "Lesbian"), ("big-tits", "Big Tits"),
        ("asian", "Asian"), ("teen", "Teen"),
    )

    def _parse_tiles(self, html: str) -> list[dict]:  # type: ignore[override]
        # Thothub mixes PRIVATE (members-only) videos into every listing — 22
        # of 24 cards measured live on /latest-updates/. They render as cards
        # but have no get_file stream, so resolve() 404s; drop them before the
        # base parser runs. Identical markup to CamWhores: `<div class="item
        # private">` plus a `.line-private`/`.ico-private` badge.
        soup = BeautifulSoup(html or "", "html.parser")
        for card in soup.select("div.item.private, .item.private, .private .item"):
            card.decompose()
        for badge in soup.select(".line-private, .ico-private"):
            holder = badge.find_parent(class_=re.compile(r"\bitem\b")) or badge.parent
            if holder:
                holder.decompose()
        return super()._parse_tiles(str(soup))

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.thothub import ThothubExtractor
        return await ThothubExtractor().extract(url)
