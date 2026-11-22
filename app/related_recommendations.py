from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlparse

import httpx
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .database import DiscoveredVideo, Video
from .search_engine import ExternalSearchEngine
from .source_catalog import classify_library_source_name, filter_valid_discovery_sources
from .autotagger import auto_tag_video
from .related_query_planner import plan_related_queries, sanitize_video_tags_list
from .url_utils import normalize_url_key

logger = logging.getLogger(__name__)

RELATED_CACHE_TTL_SECONDS = 30 * 60
_RELATED_CACHE: Dict[str, Tuple[float, Dict[str, Any]]] = {}

# B2: persistent disk cache so related survives restarts and can be precomputed
# in the background. Persisted entries live longer than the hot in-RAM ones.
RELATED_PERSIST_TTL_SECONDS = 24 * 3600
_PERSIST_READY = False


def _ensure_persist_table() -> None:
    global _PERSIST_READY
    if _PERSIST_READY:
        return
    try:
        from .database import SessionLocal
        from sqlalchemy import text
        db = SessionLocal()
        try:
            db.execute(text(
                "CREATE TABLE IF NOT EXISTS related_cache ("
                "cache_key TEXT PRIMARY KEY, video_id INTEGER, payload TEXT, ts REAL)"))
            db.execute(text(
                "CREATE INDEX IF NOT EXISTS idx_related_cache_ts ON related_cache(ts)"))
            db.commit()
        finally:
            db.close()
        _PERSIST_READY = True
    except Exception as exc:  # noqa: BLE001
        logger.debug("[RELATED_PERSIST] table init failed: %s", exc)


def _persist_get(cache_key: str) -> Optional[Dict[str, Any]]:
    _ensure_persist_table()
    try:
        import json as _json
        from .database import SessionLocal
        from sqlalchemy import text
        db = SessionLocal()
        try:
            row = db.execute(
                text("SELECT payload, ts FROM related_cache WHERE cache_key=:k"),
                {"k": cache_key}).fetchone()
        finally:
            db.close()
        if not row:
            return None
        payload_json, ts = row[0], row[1]
        if time.time() - float(ts or 0) >= RELATED_PERSIST_TTL_SECONDS:
            return None
        return _json.loads(payload_json)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[RELATED_PERSIST] get failed: %s", exc)
        return None


def _persist_put(cache_key: str, video_id: int, payload: Dict[str, Any]) -> None:
    _ensure_persist_table()
    try:
        import json as _json
        from .database import SessionLocal
        from sqlalchemy import text
        db = SessionLocal()
        try:
            db.execute(
                text("INSERT INTO related_cache(cache_key, video_id, payload, ts) "
                     "VALUES(:k,:v,:p,:t) ON CONFLICT(cache_key) DO UPDATE SET "
                     "payload=excluded.payload, ts=excluded.ts"),
                {"k": cache_key, "v": int(video_id or 0),
                 "p": _json.dumps(payload), "t": time.time()})
            # bound the table — drop the oldest beyond 2000 rows
            db.execute(text(
                "DELETE FROM related_cache WHERE cache_key IN "
                "(SELECT cache_key FROM related_cache ORDER BY ts DESC LIMIT -1 OFFSET 2000)"))
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("[RELATED_PERSIST] put failed: %s", exc)

# Per-video metadata enrichment cache: video_id -> (timestamp, enriched_dict)
_META_SCRAPE_CACHE: Dict[int, Tuple[float, Dict[str, Any]]] = {}
_META_SCRAPE_TTL = 90 * 60  # 90 min — page content is stable

_SCRAPE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Hosty kde scrape nemá zmysel (CDN, file hosts, fóra bez štruktúrovaných metadát)
_SCRAPE_SKIP_HOSTS = frozenset({
    "bunkr.cr", "bunkr.la", "bunkr.si", "bunkr.su", "bunkrr.su", "bunkr.is",
    "bunkr.pk", "bunkr.ws", "bunkr.to", "bunkr.ac", "bunkr.fi", "bunkr.vc",
    "balbums.st", "gofile.io", "pixeldrain.com", "cyberdrop.me", "cyberdrop.cr",
    "erome.com", "t.me", "telegram.me",
})

# Site-specific selektory pre extrakciu tagov/modelov/kategórií
# Formát: host_fragment -> {"models": [css_selektory], "tags": [...], "categories": [...]}
_SITE_SELECTORS: Dict[str, Dict[str, List[str]]] = {
    "pornhub.com": {
        "models": [
            "div.pornstarsWrapper a.pstar-list-btn",
            ".pornstarsWrapper span.pstar-name",
            "a[data-mxptype='Pornstar']",
        ],
        "tags": [
            "div.categoriesWrapper a",
            ".tagsWrapper a",
            "ul.categoriesWrap a",
        ],
        "categories": [
            "div.categoriesWrapper a",
            ".categoryWrap a",
        ],
    },
    "xvideos.com": {
        "models": [
            "a.btn-xs[href*='/pornstar-']",
            "#video-channels a",
            "a[href*='/profiles/']",
        ],
        "tags": [
            "#video-keywords a",
            "a.btn-xs[href*='/tags/']",
        ],
        "categories": [
            "a.btn-xs[href*='/c/']",
        ],
    },
    "spankbang.com": {
        "models": [
            ".starring a",
            "a[href*='/profile/']",
        ],
        "tags": [
            ".tags a",
            "a[href*='/tag/']",
        ],
        "categories": [
            ".categories a",
        ],
    },
    "xhamster.com": {
        "models": [
            "a.anchor--isPrimary[href*='/pornstars/']",
            ".pornstars-section a",
        ],
        "tags": [
            ".tags-block a",
            "a[href*='/tags/']",
        ],
        "categories": [
            "a[href*='/categories/']",
        ],
    },
    "eporner.com": {
        "models": [
            "a[href*='/pornstar/']",
        ],
        "tags": [
            "a[href*='/tag/']",
            ".vtags a",
        ],
        "categories": [
            "a[href*='/cat/']",
        ],
    },
    "camwhores.tv": {
        "models": [
            "a[href*='/categories/']",
            ".tags a",
        ],
        "tags": [
            ".tags a",
        ],
        "categories": [],
    },
    "whoreshub.com": {
        "models": [
            "a[href*='/models/']",
        ],
        "tags": [
            ".tags a",
            "a[href*='/tags/']",
        ],
        "categories": [],
    },
    "porntrex.com": {
        "models": [
            "a[href*='/pornstar/']",
        ],
        "tags": [
            ".tags a",
        ],
        "categories": [
            "a[href*='/category/']",
        ],
    },
    "hqporner.com": {
        "models": [
            "a[href*='/pornstar/']",
        ],
        "tags": [
            "a[href*='/tag/']",
        ],
        "categories": [
            "a[href*='/category/']",
        ],
    },
    "beeg.com": {
        "models": [
            "a[href*='/pornstar/']",
        ],
        "tags": [
            ".tags a",
        ],
        "categories": [
            "a[href*='/category/']",
        ],
    },
}


def _should_scrape(url: str) -> bool:
    """Vráti True ak má zmysel fetchovať stránku videa pre metadáta."""
    if not url or not url.startswith("http"):
        return False
    try:
        host = urlparse(url).netloc.lower().lstrip("www.")
    except Exception:
        return False
    if any(skip in host for skip in _SCRAPE_SKIP_HOSTS):
        return False
    # Preskočiť priame CDN/media URL (mp4, m3u8, ...)
    path = urlparse(url).path.lower()
    if re.search(r"\.(mp4|m3u8|webm|mkv|avi|mov|jpg|png|gif)$", path):
        return False
    return True


def _parse_og_meta(html: str, base_url: str) -> Dict[str, Any]:
    """Rýchla extrakcia og: metadát a title bez BeautifulSoup (regex-only, ~0.3ms)."""
    result: Dict[str, Any] = {}

    def _og(prop: str) -> str:
        m = re.search(
            rf'<meta[^>]+property=["\']og:{re.escape(prop)}["\'][^>]+content=["\']([^"\']+)["\']',
            html, re.I,
        )
        if not m:
            m = re.search(
                rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:{re.escape(prop)}["\']',
                html, re.I,
            )
        return m.group(1).strip() if m else ""

    def _meta_name(name: str) -> str:
        m = re.search(
            rf'<meta[^>]+name=["\'](?:keywords|description)["\'][^>]+content=["\']([^"\']+)["\']',
            html, re.I,
        )
        return m.group(1).strip() if m else ""

    result["title"] = _og("title") or re.sub(
        r"\s*[-|].*$", "", (re.search(r"<title>([^<]+)</title>", html, re.I) or type("", (), {"group": lambda s, x: ""})()).group(1) or "", 1
    ).strip()
    result["description"] = _og("description") or _meta_name("description")
    result["thumbnail"] = _og("image")

    # JSON-LD structured data — goldmine pre modely/tagy
    json_ld_models: List[str] = []
    json_ld_tags: List[str] = []
    for jld_match in re.finditer(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.S | re.I):
        try:
            import json
            jld = json.loads(jld_match.group(1))
            if isinstance(jld, dict):
                # Schema.org VideoObject / Person
                for actor_field in ("actor", "actors", "performer", "performers"):
                    actors = jld.get(actor_field) or []
                    if isinstance(actors, dict):
                        actors = [actors]
                    for a in actors:
                        name = (a.get("name") or "") if isinstance(a, dict) else str(a)
                        if name and len(name) > 2:
                            json_ld_models.append(name.strip())
                for kw_field in ("keywords", "genre", "category"):
                    kws = jld.get(kw_field) or ""
                    if isinstance(kws, list):
                        json_ld_tags.extend([str(k).strip() for k in kws if k])
                    elif isinstance(kws, str):
                        json_ld_tags.extend([k.strip() for k in re.split(r"[,;|]+", kws) if k.strip()])
        except Exception:
            pass

    result["_json_ld_models"] = json_ld_models
    result["_json_ld_tags"] = json_ld_tags
    return result


def _parse_with_selectors(html: str, url: str) -> Dict[str, List[str]]:
    """Parsuje modely/tagy/kategórie pomocou site-specific CSS selektorov cez BeautifulSoup."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return {}

    host = urlparse(url).netloc.lower().lstrip("www.")
    selectors = None
    for site_key, site_sel in _SITE_SELECTORS.items():
        if site_key in host:
            selectors = site_sel
            break

    if not selectors:
        return {}

    try:
        soup = BeautifulSoup(html, "html.parser")
    except Exception:
        return {}

    def _extract(sel_list: List[str]) -> List[str]:
        seen: Set[str] = set()
        results: List[str] = []
        for sel in sel_list:
            try:
                for el in soup.select(sel):
                    text = el.get_text(" ", strip=True)
                    if text and len(text) > 1 and text.lower() not in seen:
                        seen.add(text.lower())
                        results.append(text)
            except Exception:
                continue
        return results[:20]

    return {
        "models": _extract(selectors.get("models", [])),
        "tags": _extract(selectors.get("tags", [])),
        "categories": _extract(selectors.get("categories", [])),
    }


async def _quick_page_meta_scrape(url: str) -> Dict[str, Any]:
    """
    Fetchne stránku videa s timeoutom 5s a vytiahne modely/tagy/kategórie.
    Kombinuje: JSON-LD structured data + og: meta + site-specific selektory.
    Vracia: {models, tags, categories, title, description, thumbnail}
    """
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(5.0, connect=3.0),
            follow_redirects=True,
            verify=False,
            headers=_SCRAPE_HEADERS,
        ) as client:
            resp = await client.get(url)
            if not resp.is_success:
                return {}
            html = resp.text
    except Exception as exc:
        logger.debug("[META_SCRAPE] fetch failed url=%s err=%s", url, exc)
        return {}

    og = _parse_og_meta(html, url)
    site = _parse_with_selectors(html, url)

    # Merge všetkých zdrojov
    models: List[str] = []
    tags: List[str] = []
    categories: List[str] = []

    # JSON-LD je najspoľahlivejší
    models.extend(og.get("_json_ld_models") or [])
    tags.extend(og.get("_json_ld_tags") or [])

    # Site-specific selektory
    for m in (site.get("models") or []):
        if m not in models:
            models.append(m)
    for t in (site.get("tags") or []):
        if t not in tags:
            tags.append(t)
    for c in (site.get("categories") or []):
        if c not in categories:
            categories.append(c)

    # Fallback: skús mená z og:description ("Starring Riley Reid and Mia Khalifa")
    desc = og.get("description") or ""
    if not models and desc:
        starring_m = re.search(r"(?:starring|with|featuring|ft\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:and|&)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)?)", desc, re.I)
        if starring_m:
            for name in re.split(r"\s+(?:and|&)\s+", starring_m.group(1), flags=re.I):
                name = name.strip()
                if len(name) > 3 and name not in models:
                    models.append(name)

    result = {
        "title": og.get("title") or "",
        "description": desc,
        "thumbnail": og.get("thumbnail") or "",
        "models": models[:8],
        "tags": tags[:15],
        "categories": categories[:8],
    }

    enriched_count = len(models) + len(tags) + len(categories)
    logger.info(
        "[META_SCRAPE] url=%s models=%d tags=%d categories=%d",
        url[:80], len(models), len(tags), len(categories),
    )
    return result

# Zdroje, ktoré sú klasifikované ako fóra
_FORUM_SOURCES = frozenset({
    "simpcity", "reddit", "telegram", "f95zone", "smg", "socialmediagirls",
    "leakedmodels", "simpcity.su", "simpcity.cr", "t.me",
})

# Zdroje, ktoré sú video tuby
_TUBE_SOURCES = frozenset({
    "pornhub", "xvideos", "spankbang", "xhamster", "eporner", "porntrex",
    "whoreshub", "ixxx", "noodlemagazine", "beeg", "hqporner", "camwhores",
    "nsfw247", "leakporner", "djav", "fpo", "pimpbunny", "hornysimp", "slutvids",
    "vkvideo", "vk.com", "vkvideo.ru",
})


def _classify_source_type(source: str) -> str:
    """Vráti typ zdroja: 'forum', 'tube', 'file', alebo 'external'."""
    s = (source or "").lower()
    for f in _FORUM_SOURCES:
        if f in s:
            return "forum"
    for t in _TUBE_SOURCES:
        if t in s:
            return "tube"
    if any(x in s for x in ("bunkr", "gofile", "pixeldrain", "erome", "kemono", "cyberleaks")):
        return "file"
    return "external"


def _extract_name_from_url(url: str) -> List[str]:
    """Extrahuje meno/identifikátor z URL path (napr. /videos/username/123 -> username)."""
    if not url:
        return []
    try:
        parsed = urlparse(url)
        parts = [p for p in parsed.path.split("/") if p and len(p) > 2]
        candidates = []
        for part in parts:
            # Preskočiť číselné segmenty a krátke tokeny
            if re.match(r'^\d+$', part):
                continue
            # Preskočiť generické slová
            if part.lower() in {"videos", "video", "watch", "embed", "player", "stream",
                                 "media", "content", "uploads", "files", "view", "v"}:
                continue
            # Preferovať segmenty s veľkým písmenom alebo podčiarkovníkmi (vyzerajú ako mená)
            cleaned = re.sub(r'[-_]+', ' ', part).strip()
            if len(cleaned) > 3:
                candidates.append(cleaned.title() if cleaned.islower() else cleaned)
        return candidates[:2]
    except Exception:
        return []

_TITLE_STOPWORDS = {
    "1080p", "720p", "2160p", "4k", "hd", "fhd", "uhd", "full", "video",
    "videos", "new", "best", "free", "watch", "official", "scene", "part",
    "the", "and", "with", "from", "for", "this", "that", "private", "public",
    "com", "www", "porn", "sex", "tape", "xxx", "porntrex", "xvideos",
    "eporner", "pornhub", "spankbang", "xhamster",
}

_QUERY_NOISE_WORDS = {
    "love", "loves", "ride", "rides", "riding", "suck", "sucks", "sucking",
    "fuck", "fucks", "fucking", "gets", "getting", "takes", "taking",
}

_STRONG_TAGS = {
    "interracial", "bbc", "milf", "anal", "pov", "blowjob", "creampie",
    "cumshot", "amateur", "lesbian", "threesome", "big tits", "busty",
    "asian", "latina", "ebony", "cosplay", "vr", "onlyfans", "hardcore",
}

# Semantic clusters: videos sharing a cluster key are considered conceptually related
# even when exact tag strings don't match (e.g. "deepthroat" ↔ "blowjob")
_TAG_SEMANTIC_CLUSTERS: dict[str, frozenset[str]] = {
    "oral": frozenset({
        "blowjob", "deepthroat", "bj", "fellatio", "throat", "throatfuck",
        "gagging", "facefuck", "sloppy", "oral", "sucking", "cock sucking",
    }),
    "bbc_ir": frozenset({
        "bbc", "interracial", "ebony", "big black cock", "black cock",
        "black", "ir",
    }),
    "pov_amateur": frozenset({
        "pov", "amateur", "homemade", "selfie", "gonzo", "self",
    }),
    "cumshot_finish": frozenset({
        "cumshot", "facial", "cum", "creampie", "swallow", "finish",
        "jizz", "load",
    }),
    "milf_mature": frozenset({
        "milf", "mature", "cougar", "mom", "mother", "stepmom",
        "mommy", "older woman",
    }),
    "teen_young": frozenset({
        "teen", "young", "18", "petite", "small", "tiny", "barely legal",
    }),
    "anal_ass": frozenset({
        "anal", "ass", "butt", "booty", "doggy", "doggystyle", "backdoor",
        "buttfuck", "ass fuck",
    }),
    "lesbian": frozenset({
        "lesbian", "girl on girl", "lez", "sapphic", "ffm", "girlongirl",
    }),
    "big_tits": frozenset({
        "big tits", "busty", "boobs", "big boobs", "huge tits",
        "natural tits", "huge boobs", "large breasts",
    }),
    "asian_jav": frozenset({
        "asian", "japanese", "jav", "korean", "chinese", "japan",
    }),
    "rough": frozenset({
        "rough", "bdsm", "bondage", "dominant", "submissive",
        "choking", "degrading", "forced",
    }),
    "threesome_group": frozenset({
        "threesome", "3some", "mmf", "ffm", "group", "gangbang", "orgy",
    }),
    "blonde": frozenset({"blonde", "blond", "fair hair"}),
    "redhead": frozenset({"redhead", "ginger", "red hair", "auburn"}),
    "brunette": frozenset({"brunette", "dark hair", "brown hair"}),
    "tattooed": frozenset({"tattoo", "tattooed", "inked"}),
    "big_ass": frozenset({"big ass", "bubble butt", "pawg", "thick", "booty"}),
    "outdoor_public": frozenset({
        "outdoor", "outside", "public", "park", "car", "street",
    }),
    "casting": frozenset({
        "casting", "audition", "first time", "tryout", "interview",
    }),
    "latina": frozenset({"latina", "latin", "hispanic", "mexican", "brazilian"}),
}


def _get_semantic_clusters(tokens: frozenset[str]) -> frozenset[str]:
    """Return cluster keys that match any token in the given set."""
    matched: set[str] = set()
    for cluster_key, cluster_tags in _TAG_SEMANTIC_CLUSTERS.items():
        if tokens & cluster_tags:
            matched.add(cluster_key)
    return frozenset(matched)


def _tokens_from_metadata(
    tags: list[str], title_words: set[str], models: list[str]
) -> frozenset[str]:
    """Combine tags + title words + model names into a single lowercase token set."""
    combined: set[str] = set()
    for t in tags:
        combined.update(t.lower().split())
    combined.update(w.lower() for w in title_words)
    for m in models:
        combined.update(m.lower().split())
    return frozenset(combined)


def _split_csv(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [item.strip() for item in re.split(r"[,;|]+", value) if item and item.strip()]


def _clean_words(value: Optional[str], limit: int = 8) -> List[str]:
    words = []
    for word in re.findall(r"[a-zA-Z0-9]+", (value or "").lower()):
        if len(word) < 3 or word in _TITLE_STOPWORDS:
            continue
        if word not in words:
            words.append(word)
        if len(words) >= limit:
            break
    return words


def _name_phrases(value: Optional[str]) -> List[str]:
    text = re.sub(r"https?://\S+", " ", value or "")
    text = re.sub(r"\b[\w.-]+\.(com|net|org|tv|xxx|to|io)\b", " ", text, flags=re.I)
    phrases = []
    for match in re.finditer(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b", text):
        phrase = match.group(1).strip()
        if phrase.lower() in {"Sex Tape", "Full Video"}:
            continue
        phrase_words = [w.lower() for w in phrase.split()]
        if len(phrase_words) >= 2 and all(word in _QUERY_NOISE_WORDS for word in phrase_words[1:]):
            continue
        if phrase not in phrases:
            phrases.append(phrase)
    return phrases[:4]


def _name_phrases_enhanced(value: Optional[str]) -> List[str]:
    """
    Vylepšená extrakcia mien — zachytí CamelCase, lowercase 'riley reid',
    podčiarknuté 'mia_khalifa', ALLCAPS skratky, a mená z URL-like segmentov.
    """
    text = re.sub(r"https?://\S+", " ", value or "")
    text = re.sub(r"\b[\w.-]+\.(com|net|org|tv|xxx|to|io)\b", " ", text, flags=re.I)
    # Normalizuj oddelovače na medzery
    text = re.sub(r"[_\-\.]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()

    phrases: List[str] = []
    seen_lower: Set[str] = set()

    def _add_phrase(p: str) -> None:
        p = p.strip()
        lo = p.lower()
        if lo in seen_lower or len(p) < 4:
            return
        words = p.split()
        if len(words) >= 2 and all(w.lower() in (_QUERY_NOISE_WORDS | _TITLE_STOPWORDS) for w in words):
            return
        seen_lower.add(lo)
        phrases.append(p)

    # 1. CamelCase (pôvodný pattern)
    for m in re.finditer(r"\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b", text):
        _add_phrase(m.group(1))

    # 2. Lowercase 2-3 slová kde obe sú dlhé (typické mená "riley reid", "mia khalifa")
    words_list = text.split()
    for i in range(len(words_list) - 1):
        w1, w2 = words_list[i], words_list[i + 1]
        if (
            len(w1) >= 3 and len(w2) >= 3
            and w1.isalpha() and w2.isalpha()
            and w1.lower() not in _TITLE_STOPWORDS
            and w2.lower() not in _TITLE_STOPWORDS
            and w1.lower() not in _QUERY_NOISE_WORDS
            and w2.lower() not in _QUERY_NOISE_WORDS
            and not w1[0].isdigit() and not w2[0].isdigit()
        ):
            phrase = f"{w1.capitalize()} {w2.capitalize()}"
            _add_phrase(phrase)
            # Optionally 3-word name
            if i + 2 < len(words_list):
                w3 = words_list[i + 2]
                if len(w3) >= 3 and w3.isalpha() and w3.lower() not in _TITLE_STOPWORDS:
                    _add_phrase(f"{w1.capitalize()} {w2.capitalize()} {w3.capitalize()}")

    # 3. ALLCAPS short names ("MILA", "AVA") — skip single short caps
    for m in re.finditer(r"\b([A-Z]{3,}(?:\s+[A-Z]{3,})?)\b", text):
        candidate = m.group(1)
        if candidate not in {"POV", "VIP", "BBC", "HD", "FHD", "UHD", "4K", "VR", "DP", "XXX", "FULL"}:
            _add_phrase(candidate.title())

    # Prioritize longer phrases (more specific = better query signal)
    phrases.sort(key=lambda p: len(p.split()), reverse=True)
    return phrases[:6]


def _norm_url(value: Optional[str]) -> str:
    return normalize_url_key(value, lowercase_query=True)


def _duration_to_seconds(value: Any) -> int:
    if not value:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if ":" in text:
        try:
            parts = [int(p) for p in text.split(":")]
            if len(parts) == 3:
                return parts[0] * 3600 + parts[1] * 60 + parts[2]
            if len(parts) == 2:
                return parts[0] * 60 + parts[1]
        except Exception:
            return 0
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else 0


def _format_duration(seconds: int) -> str:
    """Seconds -> 'M:SS' or 'H:MM:SS' for tile overlays."""
    s = int(seconds or 0)
    if s <= 0:
        return ""
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _parse_duration_from_title(title: str) -> int:
    """Extract duration in seconds from title strings like '23min', '1:23:45', '45 min 720p'."""
    if not title:
        return 0
    # MM:SS or H:MM:SS
    m = re.search(r"\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b", title)
    if m:
        h, mn, s = (int(m.group(1)), int(m.group(2)), int(m.group(3) or 0))
        if m.group(3):
            return h * 3600 + mn * 60 + s
        return h * 60 + mn
    # "23min" / "23 min"
    m = re.search(r"\b(\d{1,3})\s*min\b", title, re.I)
    if m:
        return int(m.group(1)) * 60
    # "1h23m" / "1h 23m"
    m = re.search(r"\b(\d{1,2})\s*h(?:r|rs|our)?\s*(\d{1,2})\s*m\b", title, re.I)
    if m:
        return int(m.group(1)) * 3600 + int(m.group(2)) * 60
    return 0


def _quality_height(result: Dict[str, Any]) -> int:
    for key in ("height", "quality"):
        value = result.get(key)
        if isinstance(value, (int, float)) and value:
            return int(value)
        text = str(value or "")
        # Textual badges: "4K"/"UHD" carry no digits, so match them explicitly —
        # otherwise a 4K result scores height 0 and gets dropped by a min-height
        # filter. "2K" is the 1440p tier.
        low = text.lower()
        if "4k" in low or "uhd" in low:
            return 2160
        if "2k" in low:
            return 1440
        match = re.search(r"(2160|1440|1080|720|480|360)", text)
        if match:
            return int(match.group(1))
    return 0


def _safe_int(value: Any) -> int:
    if isinstance(value, (int, float)):
        return int(value)
    digits = re.sub(r"[^\d]", "", str(value or ""))
    return int(digits) if digits else 0


class RelatedRecommendationService:
    """Hybrid related recommendations built from video metadata plus external search."""

    def __init__(self, db: Session):
        self.db = db

    async def get_related(
        self,
        discovered: DiscoveredVideo,
        limit: int = 48,
        sources: Optional[Sequence[str]] = None,
        refresh: bool = False,
        include_library: bool = False,
        include_forums: bool = False,
        min_score: float = 0.0,
        min_duration: int = 0,
        search_depth: int = 1,
        progress_callback=None,
        batch_callback=None,
    ) -> Dict[str, Any]:
        safe_limit = max(1, min(int(limit or 48), 300))
        source_keys = filter_valid_discovery_sources(list(sources or []))
        cache_key = self._cache_key(discovered, safe_limit, source_keys, include_forums, min_score, min_duration)

        if not refresh:
            cached = _RELATED_CACHE.get(cache_key)
            if cached and time.time() - cached[0] < RELATED_CACHE_TTL_SECONDS:
                payload = dict(cached[1])
                payload["cached"] = True
                return payload
            # B2: fall back to the persistent disk cache (survives restarts /
            # populated by the precompute job) before paying for a fresh search.
            persisted = _persist_get(cache_key)
            if persisted is not None:
                _RELATED_CACHE[cache_key] = (time.time(), persisted)
                payload = dict(persisted)
                payload["cached"] = True
                payload["cache_tier"] = "disk"
                return payload

        # ── Live page enrichment ────────────────────────────────────────────────
        # Ak DB nemá modely/tagy, rýchlo fetchneme stránku videa (max 5s)
        # a vytiahne štruktúrované metadáta priamo z pôvodnej stránky.
        scraped_meta: Dict[str, Any] = {}
        video_id = int(getattr(discovered, "id", 0) or 0)
        src_url = (getattr(discovered, "url", "") or getattr(discovered, "source_url", "") or "").strip()
        has_sparse_meta = (
            not (getattr(discovered, "models", "") or "").strip()
            or not (getattr(discovered, "categories", "") or "").strip()
        )

        if has_sparse_meta and _should_scrape(src_url):
            cached_meta = _META_SCRAPE_CACHE.get(video_id)
            if cached_meta and time.time() - cached_meta[0] < _META_SCRAPE_TTL:
                scraped_meta = cached_meta[1]
                logger.debug("[META_SCRAPE] cache hit video_id=%s", video_id)
            else:
                try:
                    # B4: tighter budget — the scrape only enriches queries, it
                    # must not dominate time-to-first-result.
                    scraped_meta = await asyncio.wait_for(
                        _quick_page_meta_scrape(src_url),
                        timeout=3.5,
                    )
                    if scraped_meta and video_id:
                        _META_SCRAPE_CACHE[video_id] = (time.time(), scraped_meta)
                        # Trim scrape cache
                        if len(_META_SCRAPE_CACHE) > 512:
                            oldest = sorted(_META_SCRAPE_CACHE.items(), key=lambda x: x[1][0])
                            for k, _ in oldest[:64]:
                                _META_SCRAPE_CACHE.pop(k, None)
                except asyncio.TimeoutError:
                    logger.debug("[META_SCRAPE] timeout url=%s", src_url[:80])
                except Exception as exc:
                    logger.debug("[META_SCRAPE] error url=%s err=%s", src_url[:80], exc)

        queries = self._build_queries(discovered, scraped_meta=scraped_meta)
        if not queries:
            return self._empty_payload(discovered, safe_limit, source_keys, cached=False)

        imported_urls = self._imported_url_set(discovered)
        engine = ExternalSearchEngine()
        diagnostics_queries: List[Dict[str, Any]] = []
        per_query_limit = max(12, min(safe_limit * 2, 200))
        # Viac queries keď máme explicitné zdroje alebo fóra; scale up for large limits
        max_queries = 6 if safe_limit >= 100 else (4 if (source_keys or include_forums) else 3)
        active_queries = queries[:max_queries]

        async def run_query(query: str) -> Dict[str, Any]:
            # Zdroje tlačia výsledky priamo do sinku a cez source_callback hneď po dokončení,
            # aby frontend nečakal na najpomalší zdroj.
            sink: Dict[str, Any] = {"results": [], "diagnostics": []}

            async def _on_src(src_key: str, src_items: List[Dict[str, Any]], diag_entry: Dict[str, Any]) -> None:
                if not src_items or batch_callback is None:
                    return
                await _ingest_items(src_items, query=query, source_type_label="", diag_entries=[diag_entry])

            try:
                return await asyncio.wait_for(
                    engine.search_sources(
                        query,
                        source_keys or [],
                        result_limit=per_query_limit,
                        online_only=True,
                        return_diagnostics=True,
                        search_depth=search_depth,
                        progress_callback=progress_callback,
                        partial_sink=sink,
                        source_callback=_on_src,
                        allow_fallback=bool(source_keys),
                        expand_variants=False,
                    ),
                    timeout=18 + (search_depth - 1) * 10,
                )
            except asyncio.TimeoutError:
                salvaged = list(sink.get("results") or [])
                logger.warning(
                    "[RELATED_HYBRID] query timed out query=%r — salvaged %d partial results",
                    query, len(salvaged),
                )
                diags = list(sink.get("diagnostics") or [])
                diags.append({
                    "source_key": "all", "status": "timeout",
                    "count": len(salvaged), "sample_urls": [],
                    "error": "timeout (partial results kept)" if salvaged else "timeout",
                })
                return {"results": salvaged, "diagnostics": diags}
            except Exception as exc:
                logger.warning("[RELATED_HYBRID] query failed query=%r error=%s", query, exc)
                return {
                    "results": [],
                    "diagnostics": [{"source_key": "all", "status": "error", "count": 0, "sample_urls": [], "error": str(exc)}],
                }

        async def run_forum_query(query: str) -> Dict[str, Any]:
            """Vyhľadávanie na fórach (SimpCity, Reddit) — lazy, dlhší timeout."""
            try:
                forum_sources = ["simpcity", "reddit"]
                return await asyncio.wait_for(
                    engine.search_sources(
                        query,
                        forum_sources,
                        result_limit=per_query_limit,
                        return_diagnostics=True,
                    ),
                    timeout=20,
                )
            except asyncio.TimeoutError:
                logger.warning("[RELATED_FORUM] forum query timed out query=%r", query)
                return {
                    "results": [],
                    "diagnostics": [{"source_key": "forums", "status": "timeout", "count": 0, "sample_urls": [], "error": "timeout"}],
                }
            except Exception as exc:
                logger.warning("[RELATED_FORUM] forum query failed query=%r error=%s", query, exc)
                return {
                    "results": [],
                    "diagnostics": [{"source_key": "forums", "status": "error", "count": 0, "sample_urls": [], "error": str(exc)}],
                }

        candidates: List[Dict[str, Any]] = []
        seen: Set[str] = set()
        if include_library:
            for item in self._local_library_candidates(discovered, safe_limit, scraped_meta=scraped_meta):
                url_key = _norm_url(item.get("url")) or f"library:{item.get('video_id')}"
                if url_key in seen:
                    continue
                seen.add(url_key)
                candidates.append(item)

        title_token_sets_seen: List[frozenset] = []

        def _title_tokens(t: str) -> frozenset:
            return frozenset(
                w for w in re.findall(r"[a-z]{4,}", t.lower())
                if w not in _TITLE_STOPWORDS and w not in _QUERY_NOISE_WORDS
            )

        def _is_title_duplicate(title: str) -> bool:
            """Detekuje duplikáty po titulku (rovnaké video z dvoch hostov)."""
            tk = _title_tokens(title)
            if len(tk) < 2:
                return False
            for seen_tk in title_token_sets_seen:
                if not seen_tk:
                    continue
                union = tk | seen_tk
                inter = tk & seen_tk
                if union and len(inter) / len(union) >= 0.70:
                    return True
            title_token_sets_seen.append(tk)
            return False

        def _current_related_videos() -> List[Dict[str, Any]]:
            effective_min_score = max(min_score, 5.0) if min_score == 0.0 else min_score
            filtered = [
                c for c in candidates
                if c.get("relevancy_score", 0) >= effective_min_score
                and (min_duration == 0 or int(c.get("duration") or 0) >= min_duration)
            ]
            filtered.sort(key=lambda item: item["relevancy_score"], reverse=True)
            return self._cap_results(filtered, safe_limit)

        async def _emit_batch_update(query: str, source_type_label: str = "") -> None:
            if batch_callback is None:
                return
            try:
                related_videos = _current_related_videos()
                await batch_callback({
                    "query": query,
                    "source_type": source_type_label or "all",
                    "related_videos": related_videos,
                    "diagnostics": self._build_diagnostics(diagnostics_queries, related_videos),
                })
            except Exception as exc:
                logger.debug("[RELATED_HYBRID] batch callback failed query=%r err=%s", query, exc)

        async def _ingest_items(
            raw_items: List[Dict[str, Any]],
            query: str,
            source_type_label: str = "",
            diag_entries: Optional[List[Dict[str, Any]]] = None,
        ) -> None:
            if diag_entries:
                diagnostics_queries.append({"query": query, "sources": list(diag_entries)})

            added_any = False
            for item in raw_items:
                url_key = _norm_url(item.get("url"))
                if not url_key or url_key in seen or url_key in imported_urls:
                    continue
                seen.add(url_key)
                item_title = item.get("title") or ""
                if item_title and _is_title_duplicate(item_title):
                    continue
                if not item.get("duration") and item_title:
                    parsed_dur = _parse_duration_from_title(item_title)
                    if parsed_dur:
                        item = {**item, "duration": parsed_dur}
                if not item.get("height") and item_title:
                    hm = re.search(r"\b(2160|4k|1440|1080|720|480|360)p?\b", item_title, re.I)
                    if hm:
                        raw_h = hm.group(1).lower()
                        item = {**item, "height": 2160 if raw_h in ("2160", "4k") else int(raw_h)}
                scored = self._score_candidate(discovered, item, scraped_meta=scraped_meta)
                scored["matched_query"] = query
                src_type = source_type_label or _classify_source_type(item.get("source", ""))
                scored["source_type"] = src_type
                if src_type == "forum":
                    scored["badge"] = "FÓRUM"
                elif src_type == "file":
                    scored["badge"] = "SÚBOR"
                elif src_type == "tube":
                    scored["badge"] = "TUBE"
                candidates.append(scored)
                added_any = True

            if added_any or diag_entries:
                await _emit_batch_update(query, source_type_label)

        async def _process_batch(batch_result, query: str, source_type_label: str = ""):
            if isinstance(batch_result, Exception):
                logger.warning("[RELATED_HYBRID] batch failed query=%r error=%s", query, batch_result)
                diagnostics_queries.append({
                    "query": query,
                    "sources": [{"source_key": source_type_label or "all", "status": "error", "count": 0, "sample_urls": [], "error": str(batch_result)}],
                })
                await _emit_batch_update(query, source_type_label)
                return

            batch_payload = batch_result if isinstance(batch_result, dict) else {"results": batch_result or [], "diagnostics": []}
            # Ak výsledky ešte neboli pridané cez live source_callback, doplníme ich tu
            await _ingest_items(
                list(batch_payload.get("results") or []),
                query=query,
                source_type_label=source_type_label,
                diag_entries=list(batch_payload.get("diagnostics") or []) if source_type_label == "forum" else None,
            )

        # Spustiť tube/web queries a forum queries plne paralelne a spracuj ich
        # priebežne, aby frontend mohol okamžite sypať nájdené videá.
        async def _run_tagged_query(query: str, source_type: str):
            if source_type == "forum":
                return query, source_type, await run_forum_query(query)
            return query, source_type, await run_query(query)

        pending_tasks: List[asyncio.Task] = [
            asyncio.create_task(_run_tagged_query(query, ""))
            for query in active_queries
        ]
        if include_forums:
            pending_tasks.extend(
                asyncio.create_task(_run_tagged_query(query, "forum"))
                for query in queries[:2]
            )

        for finished in asyncio.as_completed(pending_tasks):
            try:
                query, source_type, batch = await finished
            except Exception as exc:
                logger.debug("[RELATED_HYBRID] tagged query wrapper failed: %s", exc)
                query, source_type, batch = "", "", exc
            await _process_batch(batch, query, source_type)

        # B3: semantic re-rank blends embedding similarity into the scores so the
        # final ordering reflects meaning, not just shared words.
        await self._semantic_rerank(discovered, candidates, scraped_meta=scraped_meta)

        # Filtrovanie — min_score default 5.0 (filtruje šum bez real matchу)
        related_videos = _current_related_videos()

        source_kind = _classify_source_type(getattr(discovered, "source", "") or getattr(discovered, "url", "") or "")
        should_retry_broader = (
            not related_videos
            and not include_forums
            and source_kind in {"file", "forum", "external"}
        )
        if should_retry_broader:
            return await self.get_related(
                discovered,
                limit=safe_limit,
                sources=source_keys,
                refresh=refresh,
                include_library=include_library,
                include_forums=True,
                min_score=min_score,
                min_duration=min_duration,
            )

        payload = {
            "status": "success",
            "total": len(related_videos),
            "related_videos": related_videos,
            "source": getattr(discovered, "source", "unknown") or "unknown",
            "engine": "hybrid",
            "search_queries": queries,
            "searched_sources": source_keys or ["all"],
            "include_forums": include_forums,
            "diagnostics": self._build_diagnostics(diagnostics_queries, related_videos),
            "cached": False,
        }
        _RELATED_CACHE[cache_key] = (time.time(), payload)
        self._trim_cache()
        # B2: persist worthwhile results so they survive restarts and seed the
        # instant-open path. Skip empties — not worth a disk row.
        if related_videos:
            _persist_put(cache_key, int(getattr(discovered, "id", 0) or 0), payload)
        return payload

    def _build_queries(
        self,
        discovered: DiscoveredVideo,
        scraped_meta: Optional[Dict[str, Any]] = None,
    ) -> List[str]:
        """Vytvorí čisté a rozmanité dopyty bez hashov a falošných mien."""
        plan = plan_related_queries(discovered, scraped_meta=scraped_meta)
        queries = list(plan.get("queries") or [])

        # Sémantické rozšírenie pri nedostatku dopytov
        if len(queries) < 4:
            norm_title = re.sub(r"[_\-\.]+", " ", plan.get("clean_title") or "")
            tag_tokens = list(plan.get("tags") or []) + list(_clean_words(norm_title, limit=12))
            src_token_set = frozenset(w.lower() for w in tag_tokens if isinstance(w, str))
            src_clusters_build = _get_semantic_clusters(src_token_set)
            existing_q_text = " ".join(queries).lower()
            models = list(plan.get("performers") or [])
            strong_tags = [t for t in tag_tokens if t.lower() in _STRONG_TAGS]
            for cluster_key in sorted(src_clusters_build)[:2]:
                synonyms = _TAG_SEMANTIC_CLUSTERS.get(cluster_key, frozenset())
                alt_syns = sorted(s for s in synonyms if s not in existing_q_text and len(s) > 3)
                if alt_syns and models:
                    q = f"{models[0]} {alt_syns[0]}"
                elif alt_syns and strong_tags:
                    q = f"{alt_syns[0]} {strong_tags[0]}"
                elif len(alt_syns) >= 2:
                    q = f"{alt_syns[0]} {alt_syns[1]}"
                else:
                    continue
                if q.lower() not in {x.lower() for x in queries}:
                    queries.append(q)

        return queries[:8]

    def _cap_results(self, candidates: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
        """Zoradí kandidátov a zabráni jednému zdroju zaplniť všetky popredné pozície."""
        ordered = sorted(
            candidates,
            key=lambda entry: (entry.get("relevancy_score", 0), entry.get("views", 0)),
            reverse=True,
        )
        if len(ordered) <= 8 or limit <= 8:
            return ordered[:limit]

        max_per_source_top = max(4, int(limit * 0.35))
        source_counts: Dict[str, int] = {}
        primary: List[Dict[str, Any]] = []
        overflow: List[Dict[str, Any]] = []
        for item in ordered:
            src = str(item.get("source") or "external").lower()
            cnt = source_counts.get(src, 0)
            if cnt < max_per_source_top:
                primary.append(item)
                source_counts[src] = cnt + 1
            else:
                overflow.append(item)
        return (primary + overflow)[:limit]

    def _local_library_candidates(
        self, discovered: Any, limit: int, scraped_meta: Optional[Dict[str, Any]] = None
    ) -> List[Dict[str, Any]]:
        """Rýchle vyhľadávanie v lokálnej knižnici cez FTS5 BM25 a SigLIP2 index."""
        scraped_meta = scraped_meta or {}
        seed_id = int(getattr(discovered, "id", 0) or 0)
        plan = plan_related_queries(discovered, scraped_meta=scraped_meta)
        terms = list(plan.get("performers") or []) + [
            t for t in (plan.get("tags") or []) if len(t) >= 3
        ] + _clean_words(plan.get("clean_title") or "", limit=8)

        # Odstránenie duplicít pri zachovaní poradia
        needles: List[str] = []
        for t in terms:
            tl = t.strip().lower()
            if tl and tl not in {n.lower() for n in needles}:
                needles.append(t.strip())
            if len(needles) >= 8:
                break

        rows: List[Video] = []
        # 1. Primárne SQLite FTS5 (BM25, sub-milisekundové)
        if needles:
            try:
                from sqlalchemy import text as sa_text
                from .database import sanitize_fts_query

                fts_terms = []
                for n in needles[:6]:
                    safe = sanitize_fts_query(n)
                    words = [w for w in safe.split() if len(w) >= 3]
                    if len(words) > 1:
                        fts_terms.append("(" + " AND ".join(f'"{w}"' for w in words) + ")")
                    elif words:
                        fts_terms.append(f'"{words[0]}"*')
                if fts_terms:
                    match_expr = " OR ".join(fts_terms)
                    id_rows = self.db.execute(
                        sa_text(
                            "SELECT rowid FROM videos_fts WHERE videos_fts MATCH :q "
                            "ORDER BY bm25(videos_fts) LIMIT 40"
                        ),
                        {"q": match_expr},
                    ).fetchall()
                    matched_ids = [int(r[0]) for r in id_rows if int(r[0]) != seed_id]
                    if matched_ids:
                        rows = self.db.query(Video).filter(Video.id.in_(matched_ids)).all()
            except Exception as exc:
                logger.debug("[RELATED_LOCAL] FTS5 fallback na LIKE: %s", exc)

        # 2. Fallback na LIKE iba ak FTS5 nebeží (napr. in-memory test DB bez FTS5)
        if not rows and needles:
            query = self.db.query(Video).filter(Video.id != seed_id)
            filters = []
            for needle in needles[:6]:
                like = f"%{needle}%"
                filters.extend([
                    Video.title.ilike(like),
                    Video.tags.ilike(like),
                    Video.ai_tags.ilike(like),
                    Video.models.ilike(like),
                ])
            rows = query.filter(or_(*filters)).order_by(Video.id.desc()).limit(35).all()

        results = []
        for video in rows:
            source_name = getattr(video, "source", "") or classify_library_source_name(video.url, video.source_url)
            item = {
                "title": video.title or "Library Video",
                "url": video.source_url or video.url or "",
                "thumbnail": video.thumbnail_path or "",
                "duration": int(video.duration or 0),
                "views": int(video.views or 0),
                "source": source_name or "library",
                "video_id": video.id,
                "is_library": True,
            }
            scored = self._score_candidate(discovered, {
                **item,
                "description": " ".join([
                    video.tags or "",
                    video.ai_tags or "",
                    video.models or "",
                    video.categories or "",
                ]),
                "height": video.height or 0,
            })
            item.update(scored)
            item["video_id"] = video.id
            item["is_library"] = True
            item["reason"] = f"library match, {item.get('reason', 'similar metadata')}"
            item["relevancy_score"] = min(100, item.get("relevancy_score", 0) + 10)
            results.append(item)

        results.sort(key=lambda item: item["relevancy_score"], reverse=True)
        return results[:limit]

    async def _semantic_rerank(
        self,
        discovered: DiscoveredVideo,
        candidates: List[Dict[str, Any]],
        scraped_meta: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Blendne sémantickú podobnosť cez GPU OpenCLIP/SigLIP2 (alebo ST model ak je dostupný)."""
        if not candidates:
            return

        scraped_meta = scraped_meta or {}
        src_parts = [
            getattr(discovered, "title", "") or "",
            getattr(discovered, "models", "") or "",
            getattr(discovered, "categories", "") or "",
            getattr(discovered, "tags", "") or "",
            " ".join(scraped_meta.get("models") or []),
            " ".join(scraped_meta.get("tags") or []),
        ]
        src_text = " ".join(p for p in src_parts if p).strip()
        if len(src_text) < 4:
            return

        cand_texts = [
            f"{c.get('title','')} {c.get('reason','')}".strip() or c.get("title", "")
            for c in candidates
        ]

        def _compute() -> Optional[List[float]]:
            # 1. Preferujeme náš GPU SigLIP2/OpenCLIP text encoder
            try:
                from . import visual_semantic_index as vsi
                if vsi.is_gpu_ready():
                    vecs = vsi._encode_texts_sync([src_text] + cand_texts)
                    if vecs is not None and len(vecs) == len(cand_texts) + 1:
                        qv = vecs[0]
                        return [float(cv @ qv) for cv in vecs[1:]]
            except Exception as exc:
                logger.debug("[RELATED_SEMANTIC] GPU text encode zlyhal: %s", exc)

            # 2. Fallback na sentence-transformers iba ak je reálny model načítaný
            try:
                from . import semantic_search as sem
                if sem._get_model():
                    qv = sem.embed(src_text)
                    cvs = sem.embed_batch(cand_texts)
                    return [sem.cosine(qv, cv) for cv in cvs]
            except Exception as exc:  # noqa: BLE001
                logger.debug("[RELATED_SEMANTIC] ST compute zlyhal: %s", exc)
            return None

        sims = await asyncio.to_thread(_compute)
        if not sims or len(sims) != len(candidates):
            return

        for c, sim in zip(candidates, sims):
            boost = max(0.0, float(sim)) * 25.0
            c["semantic_sim"] = round(float(sim), 3)
            c["relevancy_score"] = round(min(100.0, c.get("relevancy_score", 0) + boost), 1)

    def _score_candidate(
        self,
        discovered: DiscoveredVideo,
        item: Dict[str, Any],
        scraped_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        scraped_meta = scraped_meta or {}
        src_title = getattr(discovered, "title", "") or ""
        plan = plan_related_queries(discovered, scraped_meta=scraped_meta)

        # Merge DB + scraped + lexicon performer names for scoring
        src_models = [m.lower() for m in (plan.get("performers") or []) if m]
        src_tags = [
            t.lower()
            for t in sanitize_video_tags_list(plan.get("tags") or [], exclude_performers=src_models)
        ]

        norm_src_title = re.sub(r"[_\-\.]+", " ", plan.get("clean_title") or src_title)
        src_names = [p.lower() for p in _name_phrases_enhanced(norm_src_title) if p.lower() not in src_models]
        src_words = set(_clean_words(norm_src_title, limit=12))
        src_source = (getattr(discovered, "source", "") or "").lower()
        src_duration = int(getattr(discovered, "duration", 0) or 0)
        src_height = int(getattr(discovered, "height", 0) or 0)

        title = item.get("title") or item.get("description") or "Related Video"
        raw_result_text = f"{title} {item.get('description') or ''} {item.get('tags') or ''} {item.get('url') or ''}".lower()
        result_text = re.sub(r"[._\-+/]+", " ", raw_result_text)
        result_words = set(_clean_words(result_text, limit=16))
        result_source = (item.get("source") or "").lower()
        result_duration = _duration_to_seconds(item.get("duration"))
        result_height = _quality_height(item)
        result_views = _safe_int(item.get("views"))

        score = 0.0
        reasons: List[str] = []

        # ── Model / performer name match (phrase-level, graded) ───────────────
        if src_models or src_names:
            all_src_identifiers = list(dict.fromkeys(src_models + src_names))
            full_phrase_hits = [m for m in all_src_identifiers if m and len(m) > 5 and m in result_text]
            partial_hits = [
                m for m in all_src_identifiers
                if m and m not in full_phrase_hits
                and any(w in result_text for w in m.split() if len(w) > 4)
            ]
            if full_phrase_hits:
                # Full phrase match (e.g. "riley reid" found in result) — high confidence
                score += 48 + min(12, 6 * (len(full_phrase_hits) - 1))
                reasons.append(f"model match ({', '.join(full_phrase_hits[:2])})")
            elif partial_hits:
                # Partial word match — lower confidence
                score += 18
                reasons.append("partial model match")

        # ── Tag / category overlap ─────────────────────────────────────────────
        strong_src_tags = [t for t in src_tags if t in _STRONG_TAGS]
        regular_src_tags = [t for t in src_tags if t not in _STRONG_TAGS]

        strong_hits = [t for t in strong_src_tags if t and t in result_text]
        regular_hits = [t for t in regular_src_tags if t and len(t) > 3 and t in result_text]

        if strong_hits:
            score += min(30, 10 * len(strong_hits))
            reasons.append(f"category match ({', '.join(strong_hits[:2])})")
        if regular_hits:
            score += min(12, 4 * len(regular_hits))
            if "category match" not in " ".join(reasons):
                reasons.append("tag match")

        # ── Title word overlap ────────────────────────────────────────────────
        overlap = src_words.intersection(result_words)
        non_trivial_overlap = {w for w in overlap if len(w) > 4 and w not in _QUERY_NOISE_WORDS}
        if non_trivial_overlap:
            score += min(20, 4 * len(non_trivial_overlap))
            reasons.append("title match")

        # ── Same source boost ─────────────────────────────────────────────────
        if src_source and src_source in result_source:
            score += 6
            reasons.append("same source")

        # ── Duration proximity ────────────────────────────────────────────────
        if src_duration > 30 and result_duration > 30:
            delta = abs(src_duration - result_duration) / max(src_duration, result_duration)
            if delta <= 0.20:
                score += 8
                reasons.append("similar duration")
            elif delta <= 0.40:
                score += 4

        # ── Quality level ─────────────────────────────────────────────────────
        if src_height >= 480 and result_height >= 480:
            if abs(src_height - result_height) <= 120:
                score += 4
            elif result_height > src_height:
                score += 2

        # ── Popularity soft boost (log-scaled, capped) ────────────────────────
        if result_views > 0:
            import math
            view_boost = min(6.0, math.log10(result_views + 1))
            score += view_boost

        # ── Semantic cluster overlap (synonym/concept expansion) ─────────────
        # "deepthroat pov" ↔ "blowjob amateur" → both hit oral+pov_amateur clusters
        src_tokens = _tokens_from_metadata(src_tags, src_words, src_models)
        result_tokens = _tokens_from_metadata(
            _split_csv(item.get("tags") or ""),
            result_words,
            [],
        )
        src_clusters = _get_semantic_clusters(src_tokens)
        result_clusters = _get_semantic_clusters(result_tokens)
        cluster_overlap = src_clusters & result_clusters
        if cluster_overlap:
            # Only credit clusters not already covered by exact tag match
            already_covered = {c for hit in (strong_hits + regular_hits) for c, tags in _TAG_SEMANTIC_CLUSTERS.items() if hit in tags}
            new_clusters = cluster_overlap - already_covered
            if new_clusters:
                score += min(24, 8 * len(new_clusters))
                reasons.append(f"semantic ({', '.join(sorted(new_clusters)[:2])})")

        # ── Penalize results with no real metadata overlap ────────────────────
        if not reasons:
            score -= 5  # Penalizuj výsledky bez skutočnej relevancie
            reasons.append("low relevance")

        result_rating = _safe_int(item.get("rating"))
        result_size = _safe_int(item.get("size_bytes") or item.get("file_size"))
        result_quality = item.get("quality") or (f"{result_height}p" if result_height else "")

        # ── B5: full metadata + trailer/preview URL passthrough ───────────────
        # Tube listings carry an inline webm/mp4 preview ("mediabook" etc.); keep
        # whichever field the parser provided so the frontend can hover-play it.
        preview_url = (
            item.get("preview_url") or item.get("preview") or item.get("mediabook")
            or item.get("preview_mp4") or item.get("preview_video")
            or item.get("trailer") or item.get("trailer_url") or ""
        )
        embed_url = item.get("embed") or item.get("embed_url") or ""

        return {
            "title": title,
            "url": item.get("url") or "",
            "thumbnail": item.get("thumbnail") or item.get("thumb") or "",
            "preview_url": preview_url,
            "embed_url": embed_url,
            "duration": result_duration,
            "duration_label": _format_duration(result_duration),
            "views": result_views,
            "height": result_height,
            "quality": result_quality,
            "rating": result_rating,
            "size_bytes": result_size,
            "source": item.get("source") or "external",
            "relevancy_score": round(max(0.0, min(score, 100.0)), 1),
            "reason": ", ".join(dict.fromkeys(reasons)),
        }

    def _imported_url_set(self, discovered: DiscoveredVideo) -> Set[str]:
        raw_urls = [
            getattr(discovered, "url", "") or "",
            getattr(discovered, "source_url", "") or "",
        ]
        keys = {_norm_url(url) for url in raw_urls if url}

        try:
            # Optimalizovaný limit — 5000 je dostatočné pre deduplication
            rows = self.db.query(Video.url, Video.source_url).filter(
                or_(Video.url.isnot(None), Video.source_url.isnot(None))
            ).limit(5000).all()
            for url, source_url in rows:
                if url:
                    keys.add(_norm_url(url))
                if source_url:
                    keys.add(_norm_url(source_url))
        except Exception as exc:
            logger.debug("[RELATED_HYBRID] imported URL load failed: %s", exc)

        return {key for key in keys if key}

    def _cache_key(
        self,
        discovered: DiscoveredVideo,
        limit: int,
        sources: Sequence[str],
        include_forums: bool = False,
        min_score: float = 0.0,
        min_duration: int = 0,
    ) -> str:
        fingerprint = "|".join([
            str(getattr(discovered, "id", "")),
            getattr(discovered, "title", "") or "",
            getattr(discovered, "models", "") or "",
            getattr(discovered, "categories", "") or "",
            getattr(discovered, "source", "") or "",
            str(getattr(discovered, "duration", 0) or 0),
            str(getattr(discovered, "height", 0) or 0),
            str(limit),
            ",".join(sources),
            str(include_forums),
            str(min_score),
            str(min_duration),
        ])
        return hashlib.sha1(fingerprint.encode("utf-8", errors="ignore")).hexdigest()

    def _empty_payload(
        self,
        discovered: DiscoveredVideo,
        limit: int,
        sources: Sequence[str],
        cached: bool,
    ) -> Dict[str, Any]:
        return {
            "status": "success",
            "total": 0,
            "related_videos": [],
            "source": getattr(discovered, "source", "unknown") or "unknown",
            "engine": "hybrid",
            "search_queries": [],
            "searched_sources": list(sources) or ["all"],
            "diagnostics": {"queries": [], "summary": {"sources_with_hits": 0, "failed_sources": 0, "empty_sources": 0}, "found_urls": []},
            "cached": cached,
        }

    def _build_diagnostics(self, query_diagnostics: List[Dict[str, Any]], related_videos: List[Dict[str, Any]]) -> Dict[str, Any]:
        found_urls: List[str] = []
        failed_sources = 0
        empty_sources = 0
        sources_with_hits = 0

        for query_item in query_diagnostics:
            for source_item in query_item.get("sources") or []:
                count = int(source_item.get("count") or 0)
                status = source_item.get("status") or "unknown"
                if count > 0:
                    sources_with_hits += 1
                elif status in {"error", "timeout"}:
                    failed_sources += 1
                else:
                    empty_sources += 1
                for url in source_item.get("sample_urls") or []:
                    if url and url not in found_urls:
                        found_urls.append(url)

        for item in related_videos:
            url = item.get("url") or ""
            if url and url not in found_urls:
                found_urls.append(url)

        return {
            "queries": query_diagnostics,
            "summary": {
                "sources_with_hits": sources_with_hits,
                "failed_sources": failed_sources,
                "empty_sources": empty_sources,
            },
            "found_urls": found_urls[:60],
        }

    def _trim_cache(self) -> None:
        if len(_RELATED_CACHE) <= 256:
            return
        now = time.time()
        expired = [key for key, (ts, _) in _RELATED_CACHE.items() if now - ts >= RELATED_CACHE_TTL_SECONDS]
        for key in expired:
            _RELATED_CACHE.pop(key, None)
        if len(_RELATED_CACHE) > 256:
            for key in list(_RELATED_CACHE.keys())[: len(_RELATED_CACHE) - 256]:
                _RELATED_CACHE.pop(key, None)


# ─────────────────────────────────────────────────────────────────────────────
# B2: background precompute — warm related for favorites / recently added so the
# user almost always opens into a ready, disk-cached result (instant open).
# ─────────────────────────────────────────────────────────────────────────────
async def precompute_related(limit_videos: int = 10, per_video_limit: int = 48,
                             favorites_only: bool = True, throttle_sec: float = 12.0) -> dict:
    """Gently precompute + persist related for a small set of high-value videos.

    Designed to stay out of the way: favorites only by default, a real pause
    between each (heavy) search so it never saturates the network/CPU, and it
    skips anything already cached. Not run on boot — see main.py.
    """
    from .database import SessionLocal
    db = SessionLocal()
    warmed = 0
    skipped = 0
    try:
        q = db.query(Video).filter(Video.duplicate_of.is_(None))
        if favorites_only:
            q = q.filter(Video.is_favorite.is_(True))
        rows = q.order_by(Video.is_favorite.desc(), Video.id.desc()).limit(limit_videos).all()
        svc = RelatedRecommendationService(db)
        for idx, v in enumerate(rows):
            key = svc._cache_key(v, per_video_limit, [], False, 0.0, 0)
            if _persist_get(key) is not None:
                skipped += 1
                continue
            try:
                await svc.get_related(v, limit=per_video_limit, include_library=False,
                                      min_score=0.0)
                warmed += 1
            except Exception as exc:  # noqa: BLE001
                logger.debug("[RELATED_PRECOMPUTE] video %s failed: %s", v.id, exc)
            # throttle between heavy searches so foreground stays responsive
            if throttle_sec and idx < len(rows) - 1:
                await asyncio.sleep(throttle_sec)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[RELATED_PRECOMPUTE] batch failed: %s", exc)
    finally:
        db.close()
    logger.info("[RELATED_PRECOMPUTE] warmed=%s skipped=%s", warmed, skipped)
    return {"warmed": warmed, "skipped": skipped}
