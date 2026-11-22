"""XXBrits adapter for the unified Fusion Hub.

XXBrits runs the KernelVideoSharing (KVS) engine — the same gallery engine as
WhoresHub / PornTrex / CamWhores — so `KvsHub` supplies listing, search, categories,
enrich, related and media handling; only the per-site URL policy lives here.

Engine evidence (structural KVS fingerprints):
  * watch URLs  /videos/{id}/{slug}/
  * screenshots /contents/videos_screenshots/{id_bucket}/{id}/{size}/{n}.jpg
  * async block controller  ?mode=async&function=get_block&block_id=...
  * kt_player + inline `flashvars`

Per-site paths below follow the reported URL shapes: search `/search/{slug}/`,
categories `/ct/{slug}/`, pagination as a trailing `/{N}/` path segment — all of which
match what `KvsHub._base_url` / `_page_url` already generate. `recent_path` is the KVS
default and should be confirmed against the live site on first run.
"""
from __future__ import annotations

import re
from typing import Optional

from .kvs import KvsHub


class XXBritsHub(KvsHub):
    source = "xxbrits"
    label = "XXBrits"
    origin = "https://www.xxbrits.com"
    video_re = re.compile(r"/videos/\d+(?:/|$)", re.I)
    # Categories live under /ct/{slug}/ on this skin rather than KVS's /categories/.
    category_kind = "ct"
    # Live-verified 2026-07-16: KVS default "/latest-updates/" 404s on this skin;
    # the real recent-listing path is "/latest/".
    recent_path = "/latest/"
    card_class_re = re.compile(r"(?:^|\s)(?:item|box|thumb|video-item)(?:\s|$)", re.I)
    media_hosts = ("xxbrits.com", "edge.xxbrits.com")
    stream_referer = "https://www.xxbrits.com/"
    # Measured live 2026-07-25: no resolution badge on this skin (height only ever
    # arrives from enrich's flashvars pass), everything else the KVS parser reads.
    listing_fields = frozenset({"duration", "date", "views", "preview"})

    async def _extract(self, url: str) -> Optional[dict]:
        from ..extractors.xxbrits import XXBritsExtractor
        return await XXBritsExtractor().extract(url)
