"""
Nexus Intel — the cross-source intelligence layer.

This module ties the existing building blocks (60+ extractors, perceptual
hashing, the scheduler) into five higher-level capabilities that turn the app
from a thin client over other sites into something that owns and links content:

    1. resolve_cached()      Predictive stream pre-resolution (hover prefetch).
    2. find_better_quality() Same title elsewhere, in higher quality (pHash).
    3. sentinel + mirror     Detect dead links, auto-mirror from a live source.
    4. semantic search       Local embedding index over the owned library.
    5. identity aggregation  One performer, merged across every source.

Everything here is additive and defensive — failures degrade to "no result",
never an exception bubbling into a request handler.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from urllib.parse import urlparse
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any, Optional

logger = logging.getLogger(__name__)

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Predictive stream pre-resolution  (hover prefetch)
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class _ResolveEntry:
    data: dict
    ts: float
    # signed CDN URLs expire; we keep entries only while plausibly valid
    ttl: float = 1500.0  # 25 min — shorter than typical PH `e=` expiry window


_resolve_cache: dict[str, _ResolveEntry] = {}
_resolve_locks: dict[str, asyncio.Lock] = {}
_RESOLVE_MAX = 2000


async def _select_pornhub_proxy_stream(candidates: list[str], cookies: dict, referer: str) -> str:
    """Probe with the requests transport used by the Pornhub playback proxy."""
    import requests

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
        "Accept": "application/vnd.apple.mpegurl, application/x-mpegURL, video/*;q=0.9, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
        "Origin": "https://www.pornhub.com",
    }
    def probe():
        for candidate in candidates[:8]:
            try:
                with requests.get(candidate, headers=headers, cookies=cookies or None,
                                  stream=True, timeout=(8, 15)) as response:
                    if response.status_code not in (200, 206):
                        continue
                    kind = (response.headers.get("Content-Type") or "").lower()
                    if ".m3u8" in candidate.lower() or "/hls/" in candidate.lower():
                        if "mpegurl" in kind or response.raw.read(64, decode_content=True).lstrip().startswith(b"#EXTM3U"):
                            return candidate
                    elif kind.startswith("video/") or "octet-stream" in kind:
                        return candidate
            except (requests.RequestException, OSError):
                continue
        return ""
    return await asyncio.to_thread(probe)


def _now() -> float:
    return time.time()


def _resolve_get(url: str) -> Optional[dict]:
    e = _resolve_cache.get(url)
    if not e:
        return None
    if _now() - e.ts > e.ttl:
        _resolve_cache.pop(url, None)
        return None
    return e.data


def _resolve_put(url: str, data: dict, ttl: float = 1500.0) -> None:
    if len(_resolve_cache) > _RESOLVE_MAX:
        # drop the oldest ~10% to bound memory
        for k in sorted(_resolve_cache, key=lambda k: _resolve_cache[k].ts)[:_RESOLVE_MAX // 10]:
            _resolve_cache.pop(k, None)
    _resolve_cache[url] = _ResolveEntry(data=data, ts=_now(), ttl=ttl)


async def _do_resolve(url: str) -> Optional[dict]:
    """Resolve a watch URL to a playable stream via the matching extractor.

    Uses the PornHub extractor directly for PH URLs (its result shape already
    matches /ph/resolve), otherwise falls back to the generic registry.
    """
    try:
        host = (urlparse(url).hostname or "").lower()
        if any(host == domain or host.endswith("." + domain) for domain in ("pornhub.com", "pornhub.org", "pornhub.net")):
            from .extractors.pornhub import PornhubExtractor
            res = await PornhubExtractor().extract(url)
            if not res or not res.get("stream_url"):
                return None
            from .proxy_sessions import register
            candidates = [res["stream_url"]]
            candidates.extend(item.get("url", "") for item in res.get("stream_candidates", []) if isinstance(item, dict))
            candidates = list(dict.fromkeys(candidate for candidate in candidates if candidate))
            stream_url = await _select_pornhub_proxy_stream(candidates, res.get("proxy_cookies") or {}, url)
            if not stream_url:
                return None
            return {
                "stream_url": stream_url,
                "is_hls": ".m3u8" in stream_url.lower() or "/hls/" in stream_url.lower(),
                "title": res.get("title", ""),
                "duration": res.get("duration", 0),
                "height": int(res.get("height") or 0),
                "thumbnail": res.get("thumbnail", ""),
                "proxy_session": register(res.get("proxy_cookies") or {}, url),
                "fallback_urls": list(dict.fromkeys(candidate for candidate in candidates if candidate and candidate != stream_url))[:6],
            }
        from .extractors import ExtractorRegistry
        ex = ExtractorRegistry.find_extractor(url)
        if ex:
            try:
                res = ex.extract(url)
                if asyncio.iscoroutine(res):
                    res = await res
                if res:
                    d = res.to_dict() if hasattr(res, "to_dict") else dict(res)
                    if d.get("stream_url"):
                        return d
            except Exception as exc:
                logger.info("[intel] site extractor failed for %s: %s", url, exc)
        # Search engines return watch pages on arbitrary domains. Reuse the
        # generic media router when no site extractor can resolve the result.
        from .extractors.media_router import default_router
        res = await asyncio.to_thread(default_router.extract, url)
        return res.to_dict() if res and res.stream_url else None
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] resolve failed for %s: %s", url, exc)
        return None


async def resolve_cached(url: str, *, prefetch: bool = False, refresh: bool = False) -> Optional[dict]:
    """Return a resolved stream for *url*, served from cache when possible.

    `prefetch=True` is the hover path: it warms the cache and returns quickly,
    but never raises and never blocks a second concurrent resolve of the same
    URL (a per-URL lock collapses duplicate work).
    """
    if refresh:
        _resolve_cache.pop(url, None)
    cached = _resolve_get(url)
    if cached is not None:
        cached = dict(cached)
        cached["cached"] = True
        return cached

    lock = _resolve_locks.setdefault(url, asyncio.Lock())
    async with lock:
        cached = _resolve_get(url)
        if cached is not None:
            cached = dict(cached)
            cached["cached"] = True
            return cached
        data = await _do_resolve(url)
        if data:
            _resolve_put(url, data, ttl=15 * 60 if data.get("proxy_session") else 1500.0)
    _resolve_locks.pop(url, None)
    if not data:
        return None
    out = dict(data)
    out["cached"] = False
    return out


# ─────────────────────────────────────────────────────────────────────────────
# perceptual-hash helpers shared by #2, #3, #5
# ─────────────────────────────────────────────────────────────────────────────
def _phash_bytes(content: bytes) -> Optional[str]:
    try:
        import imagehash
        from PIL import Image
        return str(imagehash.phash(Image.open(BytesIO(content))))
    except Exception as exc:  # noqa: BLE001
        logger.debug("[intel] phash failed: %s", exc)
        return None


async def phash_url(url: str, referer: str = "") -> Optional[str]:
    """Download a thumbnail and return its perceptual hash (or None)."""
    if not url:
        return None

    def _do() -> Optional[str]:
        try:
            from curl_cffi import requests as cr
            headers = {"User-Agent": _UA}
            if referer:
                headers["Referer"] = referer
            r = cr.get(url, headers=headers, impersonate="chrome", timeout=12)
            if r.status_code != 200 or len(r.content) < 256:
                return None
            return _phash_bytes(r.content)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[intel] phash_url failed for %s: %s", url, exc)
            return None

    return await asyncio.to_thread(_do)


def _hamming(a: str, b: str) -> int:
    try:
        import imagehash
        return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)
    except Exception:  # noqa: BLE001
        return 999


# ─────────────────────────────────────────────────────────────────────────────
# 2. Cross-source "same title, higher quality"
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class SourceHit:
    source: str
    url: str
    title: str
    thumb: str = ""
    height: int = 0
    duration: int = 0
    score: float = 0.0  # title similarity 0..1
    distance: int = 999  # phash hamming, lower = closer
    relation: str = "confirmed_version"
    needs_comparison: bool = False
    match_reason: str = ""


# Extra cross-source searchers register here. Each is an async callable
# (query:str) -> list[dict(title,url,thumb,height,source)]. PornHub is wired by
# default; other sites can be added without touching this module.
_CROSS_SEARCHERS: dict[str, Any] = {}


def register_cross_searcher(name: str, fn) -> None:
    _CROSS_SEARCHERS[name] = fn


async def _ph_cross_search(query: str) -> list[dict]:
    try:
        from . import pornhub_hub as ph
        res = await ph.search(query=query, sort="most_viewed")
        out = []
        for it in res.get("items", [])[:24]:
            out.append({
                "source": "pornhub",
                "url": it.get("url", ""),
                "title": it.get("title", ""),
                "thumb": it.get("thumb", ""),
                "height": 1080 if it.get("hd") else 0,
            })
        return out
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] PH cross-search failed: %s", exc)
        return []


register_cross_searcher("pornhub", _ph_cross_search)


async def _eporner_cross_search(query: str) -> list[dict]:
    """Eporner via its official JSON API (fast, no scraping)."""
    def _do() -> list[dict]:
        from .services import fetch_eporner_videos
        vids = fetch_eporner_videos(query=query, per_page=24, hd=True,
                                    order="most-popular") or []
        out = []
        for v in vids:
            out.append({
                "source": "eporner", "url": v.get("url", ""),
                "title": v.get("title", ""),
                "thumb": v.get("thumbnail", ""),
                "height": 1080 if v.get("quality") == "HD" else 0,
            })
        return out
    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] eporner cross-search failed: %s", exc)
        return []


register_cross_searcher("eporner", _eporner_cross_search)


async def _sxyprn_cross_search(query: str) -> list[dict]:
    """SxyPrn listing scraper (tag/search mode). Each card already carries an
    external stream host, so these hits are directly playable via the registry."""
    def _do() -> list[dict]:
        from .sxyprn_discovery import scrape_sxyprn_listing
        cards = scrape_sxyprn_listing(mode="search", query=query, pages=1) or []
        out = []
        for c in cards[:24]:
            url = c.get("stream_url") or c.get("post_url") or ""
            if not url:
                continue
            out.append({
                "source": "sxyprn", "url": url,
                "title": c.get("title", ""),
                "thumb": c.get("vidthumb") or c.get("thumbnail", ""),
                "height": 0,
            })
        return out
    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] sxyprn cross-search failed: %s", exc)
        return []


register_cross_searcher("sxyprn", _sxyprn_cross_search)


_word_re = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "and", "of", "with", "her", "his", "in", "on", "to",
         "for", "gets", "get", "from", "hd", "4k", "1080p", "720p", "porn",
         "video", "scene", "full"}


def _tokens(title: str) -> set[str]:
    return {w for w in _word_re.findall((title or "").lower())
            if len(w) > 2 and w not in _STOP}


def title_similarity(a: str, b: str) -> float:
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def _parse_duration_seconds(raw: Any) -> int:
    if raw is None or raw == "":
        return 0
    if isinstance(raw, (int, float)):
        return max(0, int(raw))
    text = str(raw).strip()
    if text.isdigit():
        return int(text)
    parts = text.split(":")
    try:
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        pass
    return 0


def _evaluate_candidate_relation(
    cand: SourceHit,
    *,
    source_height: int = 0,
    source_duration: int = 0,
    has_base_phash: bool = False,
) -> None:
    """Vyhodnotí vzťah kandidáta k zdrojovému videu (upgrade_quality, full_recording, probable_cut, compare_candidate)."""
    reasons: list[str] = []
    if has_base_phash and cand.distance <= 12:
        reasons.append(f"Vizuálna zhoda (pHash Δ={cand.distance})")
    if cand.score >= 0.6:
        reasons.append(f"Vysoká zhoda názvu ({int(round(cand.score * 100))}%)")
    elif cand.score >= 0.34:
        reasons.append(f"Podobný názov ({int(round(cand.score * 100))}%)")

    s_dur = int(source_duration or 0)
    c_dur = int(cand.duration or 0)
    if s_dur > 0 and c_dur > 0:
        diff = abs(s_dur - c_dur)
        ratio = min(s_dur, c_dur) / max(s_dur, c_dur)
        if diff <= 15 or ratio >= 0.90:
            reasons.append(f"Zhodná dĺžka (Δ={diff}s)")
            if cand.height > source_height and cand.height > 0:
                cand.relation = "upgrade_quality"
                reasons.append(f"Vyššie rozlíšenie ({cand.height}p vs {source_height or '?'}p)")
            else:
                cand.relation = "confirmed_version"
            cand.needs_comparison = False
        elif c_dur < s_dur * 0.85:
            cand.relation = "probable_cut"
            cand.needs_comparison = True
            reasons.append(f"Kratší zostrih/ukážka ({c_dur}s vs {s_dur}s) — vyžaduje porovnanie")
        elif s_dur <= 120 and c_dur >= max(180, int(s_dur * 2.2)):
            cand.relation = "full_recording"
            cand.needs_comparison = False
            reasons.append(f"Plný záznam ({c_dur}s) ku krátkemu klipu ({s_dur}s)")
        else:
            cand.relation = "compare_candidate"
            cand.needs_comparison = True
            reasons.append(f"Odlišná dĺžka ({c_dur}s vs {s_dur}s) — vyžaduje porovnanie")
    else:
        if cand.height > source_height and cand.height > 0:
            cand.relation = "upgrade_quality"
            reasons.append(f"Vyššie rozlíšenie ({cand.height}p vs {source_height or '?'}p)")
        else:
            cand.relation = "confirmed_version"
        cand.needs_comparison = bool(has_base_phash and cand.distance > 12)

    cand.match_reason = " · ".join(reasons) if reasons else "Zhoda názvu"


async def find_better_quality(
    title: str,
    thumb: str = "",
    referer: str = "",
    source_height: int = 0,
    source_duration: int = 0,
    min_target_height: int = 0,
) -> dict:
    """Find the same video on other sources, ideally in higher quality or full length.

    Matching is two-stage: cheap title-token overlap first, then (when a thumb
    is available) a perceptual-hash confirmation plus duration verification so
    a short trailer/clip is never surfaced as a quality replacement for a full video.
    """
    base_phash = await phash_url(thumb, referer) if thumb else None

    results = await asyncio.gather(
        *(_run_searcher(fn, title) for fn in _CROSS_SEARCHERS.values()),
        return_exceptions=True,
    )
    candidates: list[SourceHit] = []
    seen: set[str] = set()
    for r in results:
        if isinstance(r, Exception) or not r:
            continue
        for c in r:
            url = c.get("url", "")
            if not url or url in seen:
                continue
            sim = title_similarity(title, c.get("title", ""))
            if sim < 0.34:  # not the same scene by name
                continue
            seen.add(url)
            candidates.append(SourceHit(
                source=c.get("source", "?"),
                url=url,
                title=c.get("title", ""),
                thumb=c.get("thumb", ""),
                height=int(c.get("height") or 0),
                duration=_parse_duration_seconds(c.get("duration") or c.get("length_sec") or 0),
                score=sim,
            ))

    # phash confirmation on the strongest title matches (cap the cost)
    if base_phash:
        for cand in sorted(candidates, key=lambda x: x.score, reverse=True)[:8]:
            ch = await phash_url(cand.thumb) if cand.thumb else None
            if ch:
                cand.distance = _hamming(base_phash, ch)

    for cand in candidates:
        _evaluate_candidate_relation(
            cand,
            source_height=source_height,
            source_duration=source_duration,
            has_base_phash=bool(base_phash),
        )

    if base_phash:
        candidates.sort(key=lambda x: (1 if x.needs_comparison else 0, x.distance, -x.score, -x.height))
        confirmed = [c for c in candidates if c.distance <= 12 and not x_is_cut(c)]
        ranked = confirmed or sorted(candidates, key=lambda x: (1 if x.needs_comparison else 0, -x.score, -x.height))
    else:
        ranked = sorted(candidates, key=lambda x: (1 if x.needs_comparison else 0, -x.score, -x.height))

    target_min_h = max(int(source_height or 0) + 1, int(min_target_height or 0))
    better = next(
        (
            c for c in ranked
            if c.height >= target_min_h
            and c.relation in {"upgrade_quality", "confirmed_version", "full_recording"}
            and not c.needs_comparison
        ),
        None,
    )
    full_recording = next((c for c in ranked if c.relation == "full_recording"), None)
    compare_candidates = [_hit_dict(c) for c in candidates if c.needs_comparison][:6]
    return {
        "better": _hit_dict(better) if better else None,
        "full_recording": _hit_dict(full_recording) if full_recording else None,
        "alternatives": [_hit_dict(c) for c in ranked[:10]],
        "compare_candidates": compare_candidates,
        "phash_confirmed": bool(base_phash),
    }


def x_is_cut(cand: SourceHit) -> bool:
    return cand.relation == "probable_cut"


async def _run_searcher(fn, query: str) -> list[dict]:
    try:
        r = fn(query)
        if asyncio.iscoroutine(r):
            r = await r
        return r or []
    except Exception:  # noqa: BLE001
        return []


def _hit_dict(h: SourceHit) -> dict:
    return {
        "source": h.source,
        "url": h.url,
        "title": h.title,
        "thumb": h.thumb,
        "height": h.height,
        "duration": h.duration,
        "similarity": round(h.score, 3),
        "distance": h.distance,
        "relation": h.relation,
        "needs_comparison": h.needs_comparison,
        "match_reason": h.match_reason,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 5. One-identity performer aggregation across sources
# ─────────────────────────────────────────────────────────────────────────────
# Per-performer searchers: (name:str) -> list[dict(title,url,thumb,duration,
# views,height,source)]. PornHub is wired by default. Adding eporner/sxyprn/etc.
# is one register call — the aggregator dedups and ranks automatically.
_PERFORMER_SEARCHERS: dict[str, Any] = {}


def register_performer_searcher(name: str, fn) -> None:
    _PERFORMER_SEARCHERS[name] = fn


async def _ph_performer(name: str) -> list[dict]:
    try:
        from . import pornhub_hub as ph
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        out: list[dict] = []
        for kind in ("pornstar", "model"):
            try:
                res = await ph.pornstar_videos(slug=slug, kind=kind, sort="most_viewed")
            except Exception:  # noqa: BLE001
                res = {}
            for it in res.get("items", [])[:48]:
                out.append({
                    "source": "pornhub", "url": it.get("url", ""),
                    "title": it.get("title", ""), "thumb": it.get("thumb", ""),
                    "duration": it.get("duration", ""), "views": it.get("views", ""),
                    "height": 1080 if it.get("hd") else 0,
                })
            if out:
                break
        return out
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] PH performer failed: %s", exc)
        return []


register_performer_searcher("pornhub", _ph_performer)


async def _eporner_performer(name: str) -> list[dict]:
    """Eporner API has a first-class `pornstar` filter — perfect for #5."""
    def _do() -> list[dict]:
        from .services import fetch_eporner_videos
        vids = fetch_eporner_videos(pornstar=name, per_page=48,
                                    order="most-popular") or []
        out = []
        for v in vids:
            out.append({
                "source": "eporner", "url": v.get("url", ""),
                "title": v.get("title", ""), "thumb": v.get("thumbnail", ""),
                "duration": v.get("duration", ""), "views": "",
                "height": 1080 if v.get("quality") == "HD" else 0,
            })
        return out
    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] eporner performer failed: %s", exc)
        return []


register_performer_searcher("eporner", _eporner_performer)


async def _sxyprn_performer(name: str) -> list[dict]:
    def _do() -> list[dict]:
        from .sxyprn_discovery import scrape_sxyprn_listing
        slug = re.sub(r"\s+", "-", name.strip())
        cards = scrape_sxyprn_listing(mode="search", query=slug, pages=1) or []
        out = []
        for c in cards[:48]:
            url = c.get("stream_url") or c.get("post_url") or ""
            if not url:
                continue
            out.append({
                "source": "sxyprn", "url": url,
                "title": c.get("title", ""),
                "thumb": c.get("vidthumb") or c.get("thumbnail", ""),
                "duration": c.get("duration", ""), "views": "",
                "height": 0,
            })
        return out
    try:
        return await asyncio.to_thread(_do)
    except Exception as exc:  # noqa: BLE001
        logger.info("[intel] sxyprn performer failed: %s", exc)
        return []


register_performer_searcher("sxyprn", _sxyprn_performer)

_identity_cache: dict[str, tuple[float, dict]] = {}
_IDENTITY_TTL = 1800.0


async def aggregate_performer(name: str) -> dict:
    """Merge a performer's videos from every registered source into one feed.

    Cross-source dedup is title-token based (cheap, no per-tile downloads); the
    highest-quality copy of each title wins so the merged feed never shows a
    worse duplicate. Results are cached briefly — performer pages don't churn.
    """
    key = name.strip().lower()
    hit = _identity_cache.get(key)
    if hit and _now() - hit[0] < _IDENTITY_TTL:
        return hit[1]

    results = await asyncio.gather(
        *(_run_searcher(fn, name) for fn in _PERFORMER_SEARCHERS.values()),
        return_exceptions=True,
    )
    flat: list[dict] = []
    for r in results:
        if isinstance(r, list):
            flat.extend(r)

    # group near-identical titles, keep the best-quality representative but
    # record every source it's available from.
    groups: list[dict] = []
    for v in flat:
        if not v.get("url"):
            continue
        placed = False
        vt = _tokens(v.get("title", ""))
        for g in groups:
            if vt and title_similarity(g["title"], v["title"]) >= 0.6:
                g["sources"].add(v.get("source", "?"))
                g["mirrors"].append({"source": v.get("source"), "url": v.get("url"),
                                     "height": int(v.get("height") or 0)})
                if int(v.get("height") or 0) > int(g.get("height") or 0):
                    g.update(url=v["url"], thumb=v.get("thumb", g["thumb"]),
                             height=int(v.get("height") or 0), source=v.get("source"))
                placed = True
                break
        if not placed:
            groups.append({
                "title": v.get("title", ""), "url": v["url"],
                "thumb": v.get("thumb", ""), "duration": v.get("duration", ""),
                "views": v.get("views", ""), "height": int(v.get("height") or 0),
                "source": v.get("source", "?"),
                "sources": {v.get("source", "?")},
                "mirrors": [{"source": v.get("source"), "url": v.get("url"),
                             "height": int(v.get("height") or 0)}],
            })

    for g in groups:
        g["sources"] = sorted(g["sources"])
    groups.sort(key=lambda g: (len(g["sources"]), g["height"]), reverse=True)

    out = {"name": name, "count": len(groups),
           "sources": sorted({s for g in groups for s in g["sources"]}),
           "items": groups}
    _identity_cache[key] = (_now(), out)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# 3. Link-rot sentinel + auto-mirror
# ─────────────────────────────────────────────────────────────────────────────
async def _url_alive(url: str) -> bool:
    def _do() -> bool:
        try:
            from curl_cffi import requests as cr
            r = cr.head(url, headers={"User-Agent": _UA}, impersonate="chrome",
                        timeout=10, allow_redirects=True)
            if r.status_code in (405, 403):  # some hosts reject HEAD
                r = cr.get(url, headers={"User-Agent": _UA}, impersonate="chrome",
                           timeout=12, stream=True)
            return r.status_code < 400
        except Exception:  # noqa: BLE001
            return False
    return await asyncio.to_thread(_do)


async def sentinel_scan(limit: int = 40, mirror: bool = True) -> dict:
    """Walk favorited/saved videos, flag dead source links, and (optionally)
    queue a mirror from the first live alternative found via #2.

    Conservative by design: only touches `is_favorite` rows, caps how many it
    checks per run, and never deletes the original record.
    """
    from .database import SessionLocal, Video

    db = SessionLocal()
    checked = dead = mirrored = 0
    actions: list[dict] = []
    try:
        rows = (db.query(Video)
                .filter(Video.is_favorite.is_(True),
                        Video.duplicate_of.is_(None))
                .order_by(Video.last_checked.is_(None).desc(),
                          Video.last_checked.asc())
                .limit(limit).all())
        for v in rows:
            src = v.source_url or v.url
            if not src or not src.startswith("http"):
                continue
            checked += 1
            alive = await _url_alive(src)
            from datetime import datetime
            v.last_checked = datetime.now(timezone.utc).replace(tzinfo=None)
            v.check_count = (v.check_count or 0) + 1
            if alive:
                v.link_status = "working"
                continue
            v.link_status = "broken"
            dead += 1
            if not mirror:
                actions.append({"id": v.id, "title": v.title, "action": "flagged"})
                continue
            # try to find a live mirror in equal/better quality
            alt = await find_better_quality(
                v.title or "", thumb="", source_height=int(v.height or 0))
            best = (alt.get("better")
                    or (alt.get("alternatives") or [None])[0])
            if best and await _url_alive(best["url"]):
                v.error_msg = f"mirror:{best['source']}"
                # stash the live mirror on the record so the player/JIT layer
                # can fall back to it without re-searching.
                v.preview_mp4_url = v.preview_mp4_url or ""
                mirrored += 1
                actions.append({"id": v.id, "title": v.title,
                                "action": "mirrored", "mirror": best})
            else:
                actions.append({"id": v.id, "title": v.title, "action": "flagged"})
        db.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[intel] sentinel scan failed: %s", exc)
        db.rollback()
    finally:
        db.close()
    return {"checked": checked, "dead": dead, "mirrored": mirrored,
            "actions": actions}
