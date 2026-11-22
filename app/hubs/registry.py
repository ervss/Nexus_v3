"""Hub adapter registry — maps a source id ("eporner") to its adapter instance."""
from __future__ import annotations

import logging
from typing import Optional

from .base import HubAdapter

logger = logging.getLogger(__name__)

_ADAPTERS: dict[str, HubAdapter] = {}

#: The listing capabilities the frontend asks about. Reported for every source
#: even when False, so a badge can distinguish "no date" from "not asked".
_LISTING_KEYS = ("tags", "date", "height", "preview", "views", "duration")


def register(adapter: HubAdapter) -> None:
    _ADAPTERS[adapter.source] = adapter


def get(source: str) -> Optional[HubAdapter]:
    return _ADAPTERS.get((source or "").lower())


_DOMAIN_TO_SOURCE: dict[str, str] = {
    "eporner.com": "eporner",
    "pornhub.com": "pornhub",
    "pornhub.org": "pornhub",
    "pornhub.net": "pornhub",
    "xvideos.com": "xvideos",
    "xvideos.red": "xvideos",
    "xhamster.com": "xhamster",
    "xhamster.desi": "xhamster",
    "spankbang.com": "spankbang",
    "redtube.com": "redtube",
    "tnaflix.com": "tnaflix",
    "drtuber.com": "drtuber",
    "hqporner.com": "hqporner",
    "porntrex.com": "porntrex",
    "noodlemagazine.com": "noodlemagazine",
    "camwhores.tv": "camwhores",
    "camwhoresbay.com": "camwhoresbay",
    "whoreshub.com": "whoreshub",
    "faphouse.com": "faphouse",
    "4kporno.xxx": "fourkporno",
    "fourkporno.com": "fourkporno",
    "analdin.com": "analdin",
    "sxyprn.com": "sxyprn",
    "thisvid.com": "thisvid",
    "thothub.to": "thothub",
    "thothub.is": "thothub",
    "turbo.cr": "turbocr",
    "anysex.com": "anysex",
    "pimpbunny.com": "pimpbunny",
    "bunkr.site": "bunkr",
    "bunkrr.su": "bunkr",
    "bunkr.is": "bunkr",
    "bunkr.cr": "bunkr",
    "bunkr.black": "bunkr",
    "xxbrits.com": "xxbrits",
}


def get_by_url(url: str) -> Optional[HubAdapter]:
    """Find a registered HubAdapter capable of handling the URL."""
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").rstrip(".").lower()
    except Exception:
        return None
    if not host:
        return None

    # Ensure hubs are initialized
    init_hubs()

    # 1. Exact or suffix match via _DOMAIN_TO_SOURCE
    for domain, source in _DOMAIN_TO_SOURCE.items():
        if host == domain or host.endswith("." + domain):
            adapter = get(source)
            if adapter:
                return adapter

    # 2. Check registered adapters media_hosts or source matching host
    for adapter in _ADAPTERS.values():
        if adapter.source in host:
            return adapter
        for mh in getattr(adapter, "media_hosts", ()):
            if host == mh or host.endswith("." + mh):
                return adapter

    return None


def all_sources() -> list[dict]:
    """Every registered hub with what it can honestly do.

    `sorts` and `listing` are declarations the adapter makes about itself; the
    UI renders from them instead of showing the same six sort buttons for every
    source and hoping. A source that never sets them falls back to the base
    class defaults — one sort, no trusted listing fields — which is the safe
    lie-free position, not a claim that the source is poor.
    """
    return [
        {
            "source": a.source,
            "label": a.label,
            "needs_enrich": a.needs_enrich,
            "sorts": list(a.supported_sorts),
            "listing": {k: (k in a.listing_fields) for k in _LISTING_KEYS},
            "capabilities": {
                # Every adapter used to have a real category taxonomy, so this
                # was hardcoded True — Bunkr (balbums.st/bunkrr.pics: search +
                # trending/latest only, no tag/category index) is the first
                # exception, so this now reflects whether the adapter actually
                # overrides `_fetch_categories()` rather than claiming it does.
                "categories": type(a)._fetch_categories is not HubAdapter._fetch_categories,
                # every adapter now ships a real related() (watch-page tiles or a
                # title-based same-source search), so this is honestly True.
                "related": True,
                "pornstars": hasattr(a, "pornstar_videos"),
                "playlists": hasattr(a, "playlists"),
                "members": hasattr(a, "member_profile"),
            },
        }
        for a in _ADAPTERS.values()
    ]


def init_hubs() -> None:
    """Import + register every adapter. Idempotent.

    Each adapter is registered independently under its own try/except so that a
    broken import or constructor for one source cannot take down the others.
    """
    if _ADAPTERS:
        return
    from .analdin import AnaldinHub
    from .anysex import AnysexHub
    from .bunkr import BunkrHub
    from .camwhores import CamwhoresHub
    from .camwhoresbay import CamwhoresbayHub
    from .drtuber import DrTuberHub
    from .eporner import EpornerHub
    from .faphouse import FaphouseHub
    from .fourkporno import FourKPornoHub
    from .hqporner import HQPornerHub
    from .porntrex import PornTrexHub
    from .noodlemagazine import NoodleMagazineHub
    from .pimpbunny import PimpBunnyHub
    from .pornhub import PornHubHub
    from .redtube import RedTubeHub
    from .spankbang import SpankBangHub
    from .sxyprn import SxyPrnHub
    from .thisvid import ThisVidHub
    from .thothub import ThothubHub
    from .tnaflix import TnaflixHub
    from .turbocr import TurboCrHub
    from .whoreshub import WhoresHub
    from .xhamster import XHamsterHub
    from .xvideos import XVideosHub
    from .xxbrits import XXBritsHub

    for factory in (EpornerHub, WhoresHub, PornTrexHub, CamwhoresHub,
                    TnaflixHub, RedTubeHub, XXBritsHub,
                    XVideosHub, XHamsterHub, NoodleMagazineHub,
                    HQPornerHub, PornHubHub, PimpBunnyHub, SpankBangHub,
                    BunkrHub, AnysexHub, FourKPornoHub,
                    AnaldinHub, SxyPrnHub, ThisVidHub, DrTuberHub, TurboCrHub,
                    ThothubHub, CamwhoresbayHub, FaphouseHub):
        try:
            register(factory())
        except Exception as exc:  # noqa: BLE001 — one bad adapter must not break the rest
            logger.warning("init_hubs: adapter %s failed to register: %s",
                           getattr(factory, "__name__", factory), exc)
