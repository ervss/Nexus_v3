"""
Central catalog: external search source keys, UI metadata, and URL classification for library health.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

# Keys handled by ExternalSearchEngine per-source / multi-source discovery
DISCOVERY_SEARCH_SOURCE_KEYS = frozenset({
    "erome",
    "xvideos",
    "pornhub",
    "eporner",
    "whoreshub",
    "porntrex",
    "bunkr",
    "gofile",
    "spankbang",
    "xhamster",
    "noodlemagazine",
    "leakporner",
    "djav",
    "cyberleaks",
    "simpcity",
    "beeg",
    "pixeldrain",
    "reddit",
    "hqporner",
    "mypornerleak",
    "slutvids",
    "pimpbunny",
    "hornysimp",
    "camwhores",
    "nsfw247",
    "oneporn",
    "fpo",
    "pornone",
    "internetchicks",
    "leakedzone",
    "telegram",
})

SOURCE_KEY_ALIASES: Dict[str, str] = {
    "ph": "pornhub",
    "pornhub.com": "pornhub",
    "xb": "xvideos",
    "xvideos.com": "xvideos",
    "xvideos.red": "xvideos",
    "sb": "spankbang",
    "spankbang.com": "spankbang",
    "pt": "porntrex",
    "porntrex.com": "porntrex",
    "wh": "whoreshub",
    "whoreshub.com": "whoreshub",
    "ep": "eporner",
    "eporner.com": "eporner",
    "erome.com": "erome",
    "coomer": "kemono",
    "kemono.party": "kemono",
    "kemono.su": "kemono",
    "gofile.io": "gofile",
    "xh": "xhamster",
    "xhamster.com": "xhamster",
    "xhamster4.com": "xhamster",
    "noodlemagazine.com": "noodlemagazine",
    "nm": "noodlemagazine",
    "leakporner.com": "leakporner",
    "lp": "leakporner",
    "djav.org": "djav",
    "dj": "djav",
    "pornhat.com": "pornhat",
    "pornhut.com": "pornhat",
    "pornhut": "pornhat",
    "cyberleaks.top": "cyberleaks",
    "cl": "cyberleaks",
    "slutvids.net.lv": "slutvids",
    "1porn": "oneporn",
    "1porn.tv": "oneporn",
    "www.1porn.tv": "oneporn",
    "fpo.xxx": "fpo",
    "www.fpo.xxx": "fpo",
    "pornone.com": "pornone",
    "www.pornone.com": "pornone",
    "ic": "internetchicks",
    "internetchicks.com": "internetchicks",
    "www.internetchicks.com": "internetchicks",
    "t.me": "telegram",
    "telegram.me": "telegram",
    "lz": "leakedzone",
    "leakedzone.com": "leakedzone",
    "www.leakedzone.com": "leakedzone",
}

# API + discovery UI (id must be a canonical DISCOVERY_SEARCH_SOURCE_KEYS member)
DISCOVERY_SOURCE_OPTIONS: List[Dict[str, Any]] = [
    {"id": "leakedzone", "label": "Leakedzone", "has_search": False},
    {"id": "oneporn", "label": "1Porn", "has_search": True},
    {"id": "fpo", "label": "FPO.xxx", "has_search": True},
    {"id": "pornone", "label": "PornOne", "has_search": True},
    {"id": "telegram", "label": "Telegram", "has_search": True},
    {"id": "reddit", "label": "Reddit", "has_search": True},
    {"id": "erome", "label": "Erome", "has_search": True},
    {"id": "xvideos", "label": "XVideos", "has_search": True},
    {"id": "pornhub", "label": "Pornhub", "has_search": True},
    {"id": "eporner", "label": "Eporner", "has_search": True},
    {"id": "whoreshub", "label": "WhoresHub", "has_search": True},
    {"id": "porntrex", "label": "PornTrex", "has_search": True},
    {"id": "bunkr", "label": "Bunkr (mirrors)", "has_search": True},
    {"id": "gofile", "label": "GoFile", "has_search": True},
    {"id": "spankbang", "label": "SpankBang", "has_search": True},
    {"id": "xhamster", "label": "xHamster", "has_search": True},
    {"id": "leakporner", "label": "LeakPorner", "has_search": True},
    {"id": "djav", "label": "DJAV", "has_search": True},
    {"id": "cyberleaks", "label": "CyberLeaks", "has_search": True},
    {"id": "simpcity", "label": "SimpCity", "has_search": True},
    {"id": "beeg", "label": "Beeg", "has_search": True},
    {"id": "pixeldrain", "label": "Pixeldrain", "has_search": True},
    {"id": "noodlemagazine", "label": "NoodleMagazine", "has_search": True},
    {"id": "hqporner", "label": "HQPorner", "has_search": True},
    {"id": "mypornerleak", "label": "MyPornerLeak", "has_search": True},
    {"id": "slutvids", "label": "SlutVids", "has_search": True},
    {"id": "pimpbunny", "label": "PimpBunny", "has_search": True},
    {"id": "hornysimp", "label": "HornySimp", "has_search": True},
    {"id": "camwhores", "label": "Camwhores", "has_search": True},
    {"id": "nsfw247", "label": "NSFW247", "has_search": True},
    {"id": "internetchicks", "label": "InternetChicks", "has_search": True},
]

# Extractors / playback without a dedicated row in DISCOVERY_SOURCE_OPTIONS (search-only elsewhere)
EXTRACT_ONLY_SOURCE_NOTES: List[Dict[str, str]] = [
    {"id": "archivebate", "label": "Archivebate", "note": "Import URL only"},
    {"id": "camwhores", "label": "Camwhores", "note": "Import URL only"},
    {"id": "filester", "label": "Filester", "note": "Import URL only"},
    {"id": "hornysimp", "label": "HornySimp", "note": "Import URL only"},
    {"id": "krakenfiles", "label": "KrakenFiles", "note": "Import URL only"},
    {"id": "lulustream", "label": "LuluStream", "note": "Import URL only"},
    {"id": "mypornerleak", "label": "MyPornerLeak", "note": "Import URL only"},
    {"id": "slutvids", "label": "SlutVids", "note": "Import URL only"},
    {"id": "pimpbunny", "label": "PimpBunny", "note": "Import URL only"},
    {"id": "fnxtube", "label": "FNXTube", "note": "Import URL only"},
    {"id": "pornhd4k", "label": "PornHD4K", "note": "Import URL only"},
    {"id": "recurbate", "label": "Recurbate", "note": "Import URL only"},
    {"id": "sxyprn", "label": "SxyPrn", "note": "Import URL only"},
    {"id": "vidara", "label": "Vidara", "note": "Import URL only"},
    {"id": "vk", "label": "VK", "note": "Import URL only"},
    {"id": "nsfw247", "label": "NSFW247", "note": "Import URL only"},
    {"id": "pxp", "label": "PornXP", "note": "Import URL only"},
    {"id": "turbo", "label": "Turbo", "note": "Import URL only"},
    {"id": "tnaflix", "label": "Tnaflix", "note": "Import URL only"},
    {"id": "pornone", "label": "PornOne", "note": "Import URL only"},
    {"id": "redgifs", "label": "RedGIFs", "note": "Import URL only"},
    {"id": "hqporner", "label": "HQPorner", "note": "Import URL only"},
    {"id": "beeg", "label": "Beeg", "note": "Import URL only"},
    {"id": "pixeldrain", "label": "Pixeldrain", "note": "Import URL only"},
    {"id": "noodlemagazine", "label": "NoodleMagazine", "note": "Import URL only"},
    {"id": "thotstv", "label": "Thots.tv", "note": "Import URL only"},
    {"id": "pornhat", "label": "PornHat", "note": "Import URL only"},
    {"id": "tubed69", "label": "69Tubed", "note": "Import URL only"},
]

# Ordered: first substring match wins (specific before generic)
_LIBRARY_URL_SOURCE_RULES: Tuple[Tuple[str, str], ...] = (
    ("fnxtube.com", "FNXTube"),
    ("eporner.com", "Eporner"),
    ("xvideos.com", "XVideos"),
    ("xvideos.red", "XVideos"),
    ("spankbang.com", "SpankBang"),
    ("pornhub.com", "Pornhub"),
    ("porntrex.com", "PornTrex"),
    ("whoreshub.com", "WhoresHub"),
    ("xhamster.com", "xHamster"),
    ("xhamster4.com", "xHamster"),
    ("ixxx.com", "iXXX"),
    ("noodlemagazine.com", "NoodleMagazine"),
    ("leakporner.com", "LeakPorner"),
    ("djav.org", "DJAV"),
    ("1porn.tv", "1Porn"),
    ("1porn.", "1Porn"),
    ("58img.top", "LeakPorner"),
    ("erome.com", "Erome"),
    ("kemono.", "Kemono"),
    ("coomer.", "Kemono"),
    ("simpcity.", "SimpCity"),
    ("gofile.io", "Gofile"),
    ("pixeldrain.com", "Pixeldrain"),
    ("fileditchfiles.", "FileDitch"),
    ("fileditchvids.", "FileDitch"),
    ("theditch.", "FileDitch"),
    ("freakingfileditch.", "FileDitch"),
    ("blehpooffileditchvidsstuff.", "FileDitch"),
    ("donotsharethesetemplinksyouidiot.", "FileDitch"),
    ("webshare.cz", "Webshare"),
    ("webshare.", "Webshare"),
    ("wsfiles.cz", "Webshare"),
    ("bunkr.", "Bunkr"),
    ("bunkrr.", "Bunkr"),
    ("turbo.cr", "Turbo"),
    ("vk.com", "VK"),
    ("vk.video", "VK"),
    ("vkvideo.", "VK"),
    ("okcdn.ru", "VK"),
    ("nsfw247.", "NSFW247"),
    ("redgifs.com", "RedGIFs"),
    ("hqporner.com", "HQPorner"),
    ("69tubed.", "69Tubed"),
    ("beeg.com", "Beeg"),
    ("tnaflix.com", "Tnaflix"),
    ("pornone.com", "PornOne"),
    ("thots.tv", "Thots.tv"),
    ("thot.tv", "Thots.tv"),
    ("pornhat.com", "PornHat"),
    ("cyberleaks.top", "CyberLeaks"),
    ("slutvids.net.lv", "SlutVids"),
    ("pxp.cool", "PornXP"),
    ("porn-xp.eu", "PornXP"),
    ("pornxp.sh", "PornXP"),
    ("internetchicks.com", "InternetChicks"),
    ("leakedzone.com", "Leakedzone"),
)


def normalize_search_source_key(raw: Optional[str]) -> Optional[str]:
    """Return canonical discovery search key, or None if 'all' / unknown."""
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if not s or s in ("all", "*", "any"):
        return None
    s = SOURCE_KEY_ALIASES.get(s, s)
    for suf in (".com", ".net", ".su", ".io", ".cz", ".to", ".cr", ".la", ".party", ".red", ".black"):
        if s.endswith(suf):
            base = s[: -len(suf)]
            if base in DISCOVERY_SEARCH_SOURCE_KEYS:
                return base
            s = base
            break
    return s if s in DISCOVERY_SEARCH_SOURCE_KEYS else None


def filter_valid_discovery_sources(raw_list: Optional[List[Any]]) -> List[str]:
    """Deduplicated list of canonical search keys."""
    if not raw_list:
        return []
    out: List[str] = []
    for item in raw_list:
        if item is None:
            continue
        k = normalize_search_source_key(str(item).strip())
        if k and k not in out:
            out.append(k)
    return out


def classify_library_source_name(url: Optional[str], source_url: Optional[str] = None) -> str:
    """Bucket name for /api/health/sources (aligned with previous dashboard labels)."""
    for candidate in (source_url, url):
        if not candidate:
            continue
        low = candidate.lower()
        for needle, label in _LIBRARY_URL_SOURCE_RULES:
            if needle in low:
                return label
    return "Unknown"


def unknown_domain_from_urls(url: Optional[str], source_url: Optional[str] = None) -> Optional[str]:
    """If classification is Unknown, return registrable hostname for backlog stats."""
    if classify_library_source_name(url, source_url) != "Unknown":
        return None
    for candidate in (source_url, url):
        if not candidate or not candidate.startswith(("http://", "https://")):
            continue
        try:
            netloc = urlparse(candidate).netloc.lower()
            if netloc.startswith("www."):
                netloc = netloc[4:]
            if netloc:
                return netloc
        except Exception:
            continue
    return None
