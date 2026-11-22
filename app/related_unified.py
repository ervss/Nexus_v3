"""Zjednotený vyhľadávací motor pre Related Search (GPU SigLIP2 + FTS5 + Web + Visual CBIR + RRF)."""
from __future__ import annotations

import asyncio
import datetime
import hashlib
import html as _html
import json
import logging
import re
import time
import urllib.parse
from typing import Any, AsyncGenerator, Dict, List, Optional, Sequence, Set, Tuple

import httpx
from sqlalchemy import or_
from sqlalchemy.orm import Session

from .config import config
from .database import CBIRSearchCache, Video
from .related_media import (
    _CBIR_UA,
    classify_cbir_url,
    extract_search_frames,
    resolve_video_thumb_bytes,
    validate_public_http_url,
)
from .related_query_planner import (
    ai_analyze_for_related,
    clean_title_for_search,
    get_performer_aliases,
    plan_related_queries,
    sanitize_video_tags_list,
    split_csv,
)
from .related_creator_discovery import (
    ai_disambiguate_creator,
    extract_creators_from_ocr_text,
    extract_creators_from_visual_hits,
    extract_watermark_text_via_vision,
    namethatporn_cbir_search,
)
from .search_engine import ExternalSearchEngine
from .source_catalog import filter_valid_discovery_sources

logger = logging.getLogger(__name__)

_PIPELINE_VERSION = 16

# Rýchle keyword enginy pre CBIR / Visual+Web režim (vrátane opraveného spankbang bez cloudscraper)
_FAST_CBIR_ENGINES = ("eporner", "xhamster", "xvideos", "spankbang", "erome")


def _clean_text(t: Any) -> str:
    return re.sub(r"\s+", " ", _html.unescape(str(t or ""))).strip()


def _parse_duration_sec(val: Any) -> int:
    """Bezpečne prevedie trvanie (int, float alebo 'MM:SS' / 'HH:MM:SS') na sekundy."""
    if not val:
        return 0
    if isinstance(val, (int, float)):
        return max(0, int(val))
    txt = str(val).strip()
    if ":" in txt:
        try:
            parts = [int(p) for p in txt.split(":")]
            if len(parts) == 2:
                return parts[0] * 60 + parts[1]
            if len(parts) == 3:
                return parts[0] * 3600 + parts[1] * 60 + parts[2]
        except Exception:
            return 0
    digits = re.sub(r"[^\d]", "", txt)
    return int(digits) if digits else 0


def _parse_int_safe(val: Any) -> int:
    """Bezpečne prevedie číslo vrátane formátov ako '12,345' alebo '1.2M'."""
    if not val:
        return 0
    if isinstance(val, (int, float)):
        return max(0, int(val))
    txt = str(val).strip().upper().replace(",", "").replace(" ", "")
    m = re.match(r"^([\d.]+)([KM])$", txt)
    if m:
        num = float(m.group(1))
        return int(num * (1_000_000 if m.group(2) == "M" else 1_000))
    digits = re.sub(r"[^\d]", "", txt)
    return int(digits) if digits else 0


def _normalise_url(url: str) -> Tuple[str, str]:
    """Zjednotí URL a odstráni sledovacie parametre pre spoľahlivú deduplikáciu."""
    try:
        parts = urllib.parse.urlsplit(url.strip())
        query = urllib.parse.urlencode([
            (k, v)
            for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
            if not k.lower().startswith(("utm_", "fbclid", "gclid", "ref"))
        ])
        host = re.sub(r"^www\.", "", (parts.hostname or "").lower())
        norm = urllib.parse.urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", query, ""))
        return norm, host
    except Exception:
        return url, ""


async def _search_eporner_fast(cl: httpx.AsyncClient, query: str, limit: int = 12) -> List[Dict[str, Any]]:
    try:
        r = await cl.get(
            "https://www.eporner.com/api/v2/video/search/",
            params={"query": query, "per_page": min(limit, 24), "format": "json", "thumbsize": "medium"},
        )
        if r.status_code != 200:
            return []
        out = []
        for v in (r.json() or {}).get("videos", []):
            thumb = (v.get("default_thumb") or {}).get("src", "")
            out.append({
                "url": v.get("url", ""),
                "title": _clean_text(v.get("title", "")),
                "thumbnail": thumb,
                "duration": int(v.get("length_sec") or 0),
                "source": "eporner",
                "kind": "video",
                "tags": v.get("keywords", ""),
                "views": int(v.get("views") or 0),
                "rating": v.get("rate", ""),
                "reason": "eporner",
            })
        return out
    except Exception as exc:
        logger.debug("[UNIFIED/eporner] %s: %s", query, exc)
        return []


async def _search_xhamster_fast(cl: httpx.AsyncClient, query: str, limit: int = 12) -> List[Dict[str, Any]]:
    try:
        slug = re.sub(r"[^\w\s-]", "", query.lower()).strip().replace(" ", "-")
        if not slug:
            return []
        r = await cl.get(f"https://xhamster.com/search/{slug}")
        if r.status_code != 200:
            return []
        html_txt = r.text
        out = []
        for m in re.finditer(r'"pageURL"\s*:\s*"(https:\\/\\/xhamster\.com\\/videos\\/[^"]+)"', html_txt):
            url = m.group(1).replace("\\/", "/")
            ctx = html_txt[max(0, m.start() - 600):m.end() + 200]
            title_m = re.search(r'"title"\s*:\s*"([^"]{5,150})"', ctx)
            thumb_m = re.search(r'"thumbURL"\s*:\s*"([^"]{20,400})"', ctx)
            dur_m = re.search(r'"duration"\s*:\s*(\d+)', ctx)
            views_m = re.search(r'"views"\s*:\s*(\d+)', ctx)
            title = _clean_text(title_m.group(1)) if title_m else url.split("/")[-1].replace("-", " ").title()
            if "Porn Videos" in title and len(title) < 50:
                continue
            out.append({
                "url": url,
                "title": title,
                "thumbnail": thumb_m.group(1).replace("\\/", "/") if thumb_m else "",
                "duration": int(dur_m.group(1)) if dur_m else 0,
                "source": "xhamster",
                "kind": "video",
                "views": int(views_m.group(1)) if views_m else 0,
                "reason": "xHamster",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as exc:
        logger.debug("[UNIFIED/xhamster] %s: %s", query, exc)
        return []


async def _search_xvideos_fast(cl: httpx.AsyncClient, query: str, limit: int = 12) -> List[Dict[str, Any]]:
    try:
        r = await cl.get("https://www.xvideos.com/", params={"k": query})
        if r.status_code != 200:
            return []
        out = []
        for chunk in re.split(r'class="[^"]*thumb-block', r.text)[1:limit * 2]:
            chunk = chunk[:2500]
            url_m = re.search(r'<a href="(/video[^"]+)"', chunk)
            if not url_m:
                continue
            title_m = re.search(r'title="([^"]{3,180})"', chunk)
            thumb_m = re.search(r'data-src="([^"]+)"', chunk)
            dur_m = re.search(r'class="duration"[^>]*>\s*([\d]+)\s*(sec|min|h)', chunk)
            dur = 0
            if dur_m:
                n, unit = int(dur_m.group(1)), dur_m.group(2)
                dur = n if unit == "sec" else n * 60 if unit == "min" else n * 3600
            out.append({
                "url": "https://www.xvideos.com" + url_m.group(1),
                "title": _clean_text(title_m.group(1)) if title_m else url_m.group(1).split("/")[-1].replace("_", " "),
                "thumbnail": thumb_m.group(1) if thumb_m else "",
                "duration": dur,
                "source": "xvideos",
                "kind": "video",
                "reason": "XVideos",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as exc:
        logger.debug("[UNIFIED/xvideos] %s: %s", query, exc)
        return []


async def _search_spankbang_fast(_cl: httpx.AsyncClient, query: str, limit: int = 12) -> List[Dict[str, Any]]:
    """Používa curl_cffi (TLS impersonate) namiesto chýbajúceho cloudscraperu."""
    slug = re.sub(r"[^\w\s-]", "", query.lower()).strip().replace(" ", "+")
    if not slug:
        return []
    html_txt = ""
    try:
        from curl_cffi.requests import AsyncSession
        async with AsyncSession(impersonate="chrome124", timeout=12) as session:
            for domain in ("spankbang.com", "spankbang.party"):
                try:
                    resp = await session.get(f"https://{domain}/s/{slug}/")
                    if resp.status_code == 200 and len(resp.text) > 1500:
                        html_txt = resp.text
                        base_domain = domain
                        break
                except Exception:
                    continue
    except Exception as exc:
        logger.debug("[UNIFIED/spankbang] %s: %s", query, exc)
        return []

    if not html_txt:
        # Fallback cez ExternalSearchEngine (Yahoo search fallback pre SpankBang pri Cloudflare 403)
        try:
            ext_sb = ExternalSearchEngine()
            sb_res = await asyncio.wait_for(
                ext_sb.search_sources(query, ["spankbang"], result_limit=limit, online_only=True),
                timeout=8.0,
            )
            items = sb_res.get("results") if isinstance(sb_res, dict) else (sb_res or [])
            out_fb = []
            for it in items[:limit]:
                out_fb.append({
                    "url": str(it.get("url") or ""),
                    "title": _clean_text(it.get("title") or ""),
                    "thumbnail": str(it.get("thumbnail") or it.get("thumb") or ""),
                    "duration": _parse_duration_sec(it.get("duration")),
                    "source": "spankbang",
                    "kind": "video",
                    "reason": "SpankBang",
                })
            return [x for x in out_fb if x["url"]]
        except Exception:
            return []

    out = []
    for chunk in re.split(r'class="[^"]*video-item', html_txt)[1:limit * 2]:
        chunk = chunk[:2600]
        url_m = re.search(r'<a\s+href="(/[a-z0-9]+/video/[^"]+)"', chunk)
        if not url_m:
            continue
        thumb_m = re.search(r'data-src="([^"]+)"', chunk) or re.search(r'<img\s+src="(https://[^"]+)"', chunk)
        title_m = re.search(r'alt="([^"]{3,180})"', chunk) or re.search(r'title="([^"]{3,180})"', chunk)
        dur_m = re.search(r">\s*(\d+)\s*min\b", chunk) or re.search(r'class="l"[^>]*>\s*(\d+)m', chunk)
        thumb = thumb_m.group(1) if thumb_m else ""
        if thumb.startswith("//"):
            thumb = "https:" + thumb
        out.append({
            "url": f"https://{base_domain}" + url_m.group(1),
            "title": _clean_text(title_m.group(1)) if title_m else url_m.group(1).split("/")[-1].replace("+", " "),
            "thumbnail": thumb,
            "duration": int(dur_m.group(1)) * 60 if dur_m else 0,
            "source": "spankbang",
            "kind": "video",
            "reason": "SpankBang",
        })
        if len(out) >= limit:
            break
    return out


async def _search_erome_fast(cl: httpx.AsyncClient, query: str, limit: int = 12) -> List[Dict[str, Any]]:
    try:
        r = await cl.get("https://www.erome.com/search", params={"q": query})
        if r.status_code != 200:
            return []
        out = []
        for chunk in re.split(r'<a class="album-link"', r.text)[1:limit * 2]:
            chunk = chunk[:2000]
            url_m = re.search(r'href="(https://www\.erome\.com/a/[^"]+)"', chunk)
            if not url_m:
                continue
            title_m = re.search(r'alt="([^"]{3,180})"', chunk)
            thumb_m = re.search(r'src="(https://[^"]+/thumbs/[^"]+)"', chunk)
            out.append({
                "url": url_m.group(1),
                "title": _clean_text(title_m.group(1)) if title_m else url_m.group(1).split("/")[-1],
                "thumbnail": thumb_m.group(1) if thumb_m else "",
                "duration": 0,
                "source": "erome",
                "kind": "collection",
                "reason": "Erome album",
            })
            if len(out) >= limit:
                break
        return out
    except Exception as exc:
        logger.debug("[UNIFIED/erome] %s: %s", query, exc)
        return []


_FAST_CBIR_FUNCS = {
    "eporner": _search_eporner_fast,
    "xhamster": _search_xhamster_fast,
    "xvideos": _search_xvideos_fast,
    "spankbang": _search_spankbang_fast,
    "erome": _search_erome_fast,
}


def rrf_fuse_and_explain(
    candidates: List[Dict[str, Any]],
    source_video: Any,
    performers: Sequence[str],
    tags: Sequence[str],
    clean_title: str,
    limit: int = 60,
    intent: str = "similar",
) -> List[Dict[str, Any]]:
    """Zlúči výsledky z knižnice, webu a CBIR cez Reciprocal Rank Fusion (RRF) s vysvetlením zhody."""
    if not candidates:
        return []

    src_id = int(getattr(source_video, "id", 0) or 0) if source_video is not None else 0
    src_url_raw = str(getattr(source_video, "source_url", "") or getattr(source_video, "url", "") or "").strip() if source_video is not None else ""
    src_url_key = _normalise_url(src_url_raw)[0] if src_url_raw.startswith("http") else ""
    src_title_low = str(getattr(source_video, "title", "") or "").strip().lower() if source_video is not None else ""
    src_thumb_str = str(getattr(source_video, "thumbnail_path", "") or "").strip() if source_video is not None else ""
    src_dur = int(getattr(source_video, "duration", 0) or 0)
    src_height = int(getattr(source_video, "height", 0) or 0)
    clean_tags = sanitize_video_tags_list(tags or [], exclude_performers=performers)
    tag_low = [t.lower() for t in clean_tags if len(t) >= 3]
    title_tokens = {w for w in re.findall(r"[a-z]{4,}", (clean_title or "").lower())}

    # Pripravíme vzory pre zhodu každého performera vrátane jeho známych aliasov a kompaktných tvarov
    perf_matchers: List[Tuple[str, List[str], List[str]]] = []
    for p in performers or ():
        p_clean = str(p or "").strip()
        if len(p_clean) < 4:
            continue
        phrases = [re.sub(r"[._\-+/]+", " ", p_clean.lower()).strip()]
        compacts = [re.sub(r"[^a-z0-9]", "", p_clean.lower())]
        for al in get_performer_aliases(p_clean):
            al_low = al.lower().strip()
            if len(al_low) >= 4:
                phrases.append(al_low)
                compacts.append(re.sub(r"[^a-z0-9]", "", al_low))
        perf_matchers.append((p_clean, [x for x in phrases if len(x) >= 4], [c for c in compacts if len(c) >= 5]))

    merged: Dict[str, Dict[str, Any]] = {}
    for raw in candidates:
        url = str(raw.get("url") or "").strip()
        if not url:
            continue
        is_lib = bool(raw.get("is_library"))
        if src_id and int(raw.get("video_id") or 0) == src_id:
            continue
        if is_lib and not url.startswith("http"):
            key = f"library:{raw.get('video_id') or url}"
            cls_info = {
                "blocked": False, "tier": "library", "kind": "video",
                "is_video_site": True, "importable": True, "importability": "confirmed",
                "domain": "library", "penalty": 0,
            }
        else:
            key, host = _normalise_url(url)
            if not host:
                continue
            if src_url_key and key == src_url_key:
                continue
            cls_info = classify_cbir_url(
                url,
                str(raw.get("title") or ""),
                str(raw.get("source") or ""),
                explicit_kind=str(raw.get("kind") or ""),
            )
            if cls_info["blocked"] or cls_info.get("kind") == "image":
                continue

        # Preskočenie presného klonu zdrojového videa v knižnici (rovnaký náhľad alebo totožný titul + dĺžka)
        if is_lib:
            cand_thumb = str(raw.get("thumbnail") or "").strip()
            cand_title_low = str(raw.get("title") or "").strip().lower()
            cand_dur = _parse_duration_sec(raw.get("duration"))
            if src_thumb_str and cand_thumb and cand_thumb == src_thumb_str:
                continue
            if src_title_low and cand_title_low and cand_title_low == src_title_low and (src_dur <= 0 or cand_dur <= 0 or abs(src_dur - cand_dur) <= 2):
                continue

        item = dict(raw)
        if is_lib and str(item.get("source") or "").strip().lower() in {"", "unknown", "none", "null"}:
            item["source"] = "library"
        item["duration"] = _parse_duration_sec(item.get("duration"))
        item["height"] = _parse_int_safe(item.get("height"))
        item["views"] = _parse_int_safe(item.get("views"))
        item["visual_score"] = _parse_int_safe(item.get("visual_score"))
        item["relevancy_score"] = float(item.get("relevancy_score") or 0)
        item["domain"] = cls_info["domain"] or item.get("domain") or ""
        item["domain_tier"] = cls_info["tier"]
        item["is_video_site"] = cls_info["is_video_site"]
        item["kind"] = "video" if is_lib else (item.get("kind") or cls_info["kind"])
        if is_lib:
            item["importable"] = True
            item["importability"] = "confirmed"
        else:
            item["importable"] = bool(item.get("importable") if item.get("importable") is not None else cls_info.get("importable", True))
            item["importability"] = str(item.get("importability") or cls_info.get("importability") or "unknown")
        item["_domain_penalty"] = 0 if is_lib else cls_info["penalty"]
        item["match_types"] = set(item.get("match_types") or [])
        if item.get("match_type"):
            item["match_types"].add(str(item["match_type"]))
        item["engines_seen"] = set(item.get("engines_seen") or [str(item.get("source") or "web").lower()])

        old = merged.get(key)
        if old:
            old["match_types"].update(item["match_types"])
            old["engines_seen"].update(item["engines_seen"])
            if not old.get("thumbnail") and item.get("thumbnail"):
                old["thumbnail"] = item["thumbnail"]
            if not old.get("preview_url") and item.get("preview_url"):
                old["preview_url"] = item["preview_url"]
            if item.get("importability") == "confirmed" or (old.get("importability") == "unsupported" and item.get("importable")):
                old["importable"] = item["importable"]
                old["importability"] = item["importability"]
                old["kind"] = item["kind"]
            for num_k in ("duration", "height", "views", "visual_score"):
                old[num_k] = max(int(old.get(num_k) or 0), int(item.get(num_k) or 0))
            old["relevancy_score"] = max(float(old.get("relevancy_score") or 0), float(item.get("relevancy_score") or 0))
            if item.get("ntp_solved"):
                old["ntp_solved"] = True
                old["ntp_models"] = item.get("ntp_models") or old.get("ntp_models") or []
                old["models"] = item.get("models") or old.get("models") or ""
            if item.get("is_library"):
                old["is_library"] = True
                old["video_id"] = item.get("video_id")
            continue
        merged[key] = item

    items = list(merged.values())
    if not items:
        return []

    # 1. Spočítame textovú/entitnú relevanciu pre každého kandidáta
    filtered_items: List[Dict[str, Any]] = []
    for it in items:
        raw_haystack = (
            f"{it.get('title', '')} {it.get('tags', '')} {it.get('models', '')} "
            f"{it.get('reason', '')} {it.get('domain', '')} {it.get('url', '')}"
        ).lower()
        norm_haystack = f" {re.sub(r'[._\-+/]+', ' ', raw_haystack).strip()} "
        compact_haystack = re.sub(r"[^a-z0-9]", "", raw_haystack)

        perf_hits: List[str] = []
        for canon_name, p_phrases, p_compacts in perf_matchers:
            if any(f" {ph} " in norm_haystack or ph in norm_haystack for ph in p_phrases) or any(
                cp in compact_haystack for cp in p_compacts
            ):
                perf_hits.append(canon_name)

        tag_hits = [t for t in tag_low if f" {t} " in norm_haystack or t in norm_haystack]
        cand_tokens = {w for w in re.findall(r"[a-z]{4,}", norm_haystack)}
        word_hits = len(title_tokens & cand_tokens)

        vis = int(it.get("visual_score") or 0)
        dur = int(it.get("duration") or 0)
        dur_close = False
        dur_exact = False
        dur_mismatch = False
        dur_ratio = 0.0
        if src_dur > 30 and dur > 30:
            dur_ratio = round(dur / src_dur, 3)
            dur_diff_ratio = abs(src_dur - dur) / max(src_dur, dur)
            dur_exact = abs(src_dur - dur) <= 10 or dur_diff_ratio <= 0.08
            dur_close = dur_diff_ratio <= 0.25
            dur_mismatch = not dur_close

        raw_visual_exact = bool(it.get("exact_frame")) or ("exact" in it["match_types"] and vis >= 75) or vis >= 94
        # Samotný podobný cover s výrazne odlišným trvaním nesmie spôsobiť potvrdenú exaktnú zhodu!
        is_exact = raw_visual_exact and not dur_mismatch

        # Odfiltrovanie neoverených cudzích webov bez zhody performera a bez silnej vizuálnej zhody
        if it.get("domain_tier") == "unverified_web" and not perf_hits and vis < 68 and not raw_visual_exact:
            continue

        # Ak poznáme performera zdrojového videa, odfiltrujeme knižničný šum bez zhody performera,
        # bez silnej vizuálnej zhody (<58%) a bez zhody slov z názvu
        if perf_matchers and it.get("is_library") and not perf_hits and vis < 58 and not raw_visual_exact and word_hits == 0:
            continue

        meta_score = (
            len(perf_hits) * 56.0
            + min(24.0, len(tag_hits) * 8.0)
            + min(18.0, word_hits * 5.5)
            + (6.0 if (dur_close and (perf_hits or tag_hits or word_hits > 0 or vis >= 52)) else 0.0)
            + (float(it.get("relevancy_score") or 0) * (0.25 if (perf_hits or not perf_matchers) else 0.08))
        )
        it["_perf_hits"] = perf_hits
        it["_tag_hits"] = tag_hits
        it["_word_hits"] = word_hits
        it["_dur_close"] = dur_close
        it["_dur_exact"] = dur_exact
        it["_dur_mismatch"] = dur_mismatch
        it["_dur_ratio"] = dur_ratio
        it["_raw_visual_exact"] = raw_visual_exact
        it["_meta_score"] = meta_score
        filtered_items.append(it)

    items = filtered_items
    if not items:
        return []

    # 2. Vytvoríme nezávislé poradia pre RRF (k = 60)
    # Do visual_ranked zaraďujeme len kandidátov so skutočnou vizuálnou zhodou (visual_score >= 52 alebo exact),
    # aby generické pozadia (visual_score 30-42%) neprebíjali skutočné zhody modelky!
    k_rrf = 60.0
    visual_ranked = sorted(
        [
            it for it in items
            if int(it.get("visual_score") or 0) >= 52
            or bool(it.get("exact_frame"))
            or "exact" in it["match_types"]
        ],
        key=lambda x: (1 if (x.get("exact_frame") or "exact" in x["match_types"]) else 0, float(x.get("visual_score") or 0), -int(x.get("engine_rank") or 0)),
        reverse=True,
    )
    meta_ranked = sorted(
        [it for it in items if it["_meta_score"] > 0],
        key=lambda x: (len(x["_perf_hits"]), x["_meta_score"], int(x.get("is_library") or 0)),
        reverse=True,
    )
    consensus_ranked = sorted(items, key=lambda x: (len(x["_perf_hits"]), len(x["engines_seen"]), 1 if x.get("is_video_site") else 0), reverse=True)

    vis_pos = {id(it): idx for idx, it in enumerate(visual_ranked)}
    meta_pos = {id(it): idx for idx, it in enumerate(meta_ranked)}
    cons_pos = {id(it): idx for idx, it in enumerate(consensus_ranked)}

    for it in items:
        rrf = 0.0
        if id(it) in vis_pos:
            rrf += 1.45 / (k_rrf + vis_pos[id(it)])
        if id(it) in meta_pos:
            rrf += 1.40 / (k_rrf + meta_pos[id(it)])
        rrf += 0.55 / (k_rrf + cons_pos[id(it)])

        # Výrazný bonus za zhodu performera/tvorcu a presnú zhodu snímky
        if it["_perf_hits"]:
            rrf += 0.028
            if it.get("is_library"):
                rrf += 0.010
            elif it.get("is_video_site"):
                rrf += 0.006
        if it.get("exact_frame"):
            rrf += 0.035
        elif "exact" in it["match_types"]:
            rrf += 0.018
        if it.get("is_video_site"):
            rrf += 0.006
        if it.get("ntp_solved"):
            rrf += 0.026
            if it.get("importable"):
                rrf += 0.012
        if str(it.get("source") or "").lower() in {"serpapi", "yandex", "google_vision", "vision", "namethatporn"} and it.get("is_video_site"):
            rrf += 0.006
        if it.get("is_library") and (it.get("visual_score", 0) >= 80 or it["_perf_hits"]):
            rrf += 0.006
        rrf -= (it.get("_domain_penalty", 0) * 0.0005)
        it["_rrf"] = rrf

    # 3. Prevod na zrozumiteľnú dôveru (0..99) + štruktúrované vysvetlenia
    max_rrf = max((it["_rrf"] for it in items), default=0.05) or 0.05
    for it in items:
        ratio = max(0.0, min(1.0, it["_rrf"] / max_rrf))
        vis = int(it.get("visual_score") or 0)
        dur = int(it.get("duration") or 0)
        cand_h = int(it.get("height") or 0)
        dur_close = bool(it.get("_dur_close"))
        dur_exact = bool(it.get("_dur_exact"))
        dur_mismatch = bool(it.get("_dur_mismatch"))
        dur_ratio = float(it.get("_dur_ratio") or 0.0)
        raw_visual_exact = bool(it.get("_raw_visual_exact")) or bool(it.get("ntp_solved") and vis >= 75)
        is_exact = raw_visual_exact and not dur_mismatch
        has_perf = bool(it["_perf_hits"]) or bool(it.get("ntp_solved") and it.get("ntp_models"))
        conf = int(max(12, min(99, round(ratio * 84 + (12 if is_exact else 0) + (8 if has_perf else 0) + min(6, len(it["engines_seen"]) * 3)))))
        if it.get("ntp_solved") and not dur_mismatch:
            conf = max(conf, 95 if it.get("importable") else 92)
        elif has_perf:
            floor = 84 if (it.get("is_library") or vis >= 52 or it["_tag_hits"]) else 76
            conf = max(conf, floor)
        elif perf_matchers and not is_exact and vis < 62:
            # Ak poznáme performera, výsledky bez zhody performera a bez silnej vizuálnej zhody nesmú mať umelo 80%+
            conf = min(conf, 64 if vis >= 52 else 52)
        if dur_mismatch and raw_visual_exact:
            # Podobný náhľad s výrazne odlišným trvaním nesmie byť prezentovaný ako 95%+ totožné video
            conf = min(conf, 79)
        it["confidence"] = conf

        # Klasifikácia vzťahu verzie voči zdrojovému videu (celý záznam vs. iná kvalita vs. zostrih vs. kandidát na porovnanie)
        version_relation = "similar"
        version_label = ""
        if dur_mismatch and (raw_visual_exact or vis >= 68 or (has_perf and it["_word_hits"] >= 1)):
            if dur_ratio > 0 and dur_ratio < 0.75:
                version_relation = "probable_cut"
                version_label = "Pravdepodobný zostrih"
            elif dur_ratio >= 1.30:
                version_relation = "full_recording"
                version_label = "Dlhší / celý záznam"
            else:
                version_relation = "probable_cut"
                version_label = "Odlišná dĺžka (zostrih)"
        elif (is_exact or (vis >= 82 and (dur_exact or (dur_close and it["_word_hits"] >= 1)))):
            if dur > 0 and src_dur > 30 and (dur_exact or dur_close):
                if src_height > 0 and cand_h > src_height:
                    version_relation = "upgrade_quality"
                    version_label = f"Vyššia kvalita ({cand_h}p)"
                elif src_height > 0 and 0 < cand_h < src_height:
                    version_relation = "lower_quality"
                    version_label = f"Iná kvalita ({cand_h}p)"
                else:
                    version_relation = "confirmed_version"
                    version_label = "Celý záznam · potvrdená verzia"
            else:
                # Iba podobný cover bez overeného trvania vytvorí návrh na porovnanie
                version_relation = "compare_candidate"
                version_label = "Podobný náhľad · porovnaj"
        elif has_perf:
            version_relation = "same_creator"
            version_label = "Rovnaký tvorca"

        reasons: List[Dict[str, str]] = []
        if it.get("ntp_solved"):
            reasons.append({"type": "ntp_solved", "label": "NTP Answered ✓", "tone": "green"})
        if version_relation == "probable_cut":
            reasons.append({"type": "cut", "label": version_label, "tone": "amber"})
        elif version_relation == "full_recording":
            reasons.append({"type": "full_recording", "label": version_label, "tone": "cyan"})
        elif version_relation == "upgrade_quality":
            reasons.append({"type": "upgrade_quality", "label": version_label, "tone": "green"})
        elif version_relation == "confirmed_version":
            reasons.append({"type": "confirmed_version", "label": "Celý záznam", "tone": "green"})

        if is_exact and ( it.get("exact_frame") or vis >= 94 ):
            reasons.append({"type": "exact", "label": "Presná zhoda rámu", "tone": "green"})
        elif is_exact and "exact" in it["match_types"]:
            reasons.append({"type": "exact", "label": "Vizuálna zhoda zdroja", "tone": "green"})
        elif vis >= 52:
            reasons.append({"type": "visual", "label": f"Vizuál {vis}%", "tone": "cyan"})
        if it["_perf_hits"]:
            reasons.append({"type": "performer", "label": f"Modelka: {it['_perf_hits'][0]}", "tone": "purple"})
        elif it.get("ntp_models"):
            reasons.append({"type": "performer", "label": f"Modelka: {it['ntp_models'][0]}", "tone": "purple"})
        if it.get("is_library"):
            reasons.append({"type": "library", "label": "V knižnici", "tone": "amber"})
        if it["_tag_hits"]:
            reasons.append({"type": "tags", "label": f"Tagy ({len(it['_tag_hits'])})", "tone": "cyan"})
        if dur_close and (it["_perf_hits"] or it["_tag_hits"] or vis >= 52):
            reasons.append({"type": "duration", "label": "Podobná dĺžka", "tone": "slate"})
        if len(it["engines_seen"]) > 1:
            reasons.append({"type": "consensus", "label": f"{len(it['engines_seen'])}× zdroje", "tone": "green"})
        if not reasons:
            reasons.append({"type": "source", "label": str(it.get("source") or "Web"), "tone": "slate"})

        it["match_reasons"] = reasons[:4]
        it["version_relation"] = version_relation
        it["version_label"] = version_label
        it["confirmed_same_video"] = version_relation in {"confirmed_version", "upgrade_quality", "lower_quality"}
        it["is_upgrade"] = version_relation == "upgrade_quality"
        it["tier"] = "exact" if is_exact else ("strong" if conf >= 72 else ("similar" if conf >= 45 else "broad"))
        it["match_types"] = sorted(it["match_types"])
        it["engines_seen"] = sorted(it["engines_seen"])
        it["signals"] = {
            "is_exact": is_exact,
            "exact_frame": bool(it.get("exact_frame")) and not dur_mismatch,
            "raw_visual_exact": raw_visual_exact,
            "visual_score": vis,
            "perf_hits_count": len(it["_perf_hits"]),
            "performers": list(it["_perf_hits"]),
            "tag_hits_count": len(it["_tag_hits"]),
            "word_hits": int(it["_word_hits"]),
            "dur_close": dur_close,
            "dur_exact": dur_exact,
            "dur_mismatch": dur_mismatch,
            "dur_ratio": dur_ratio,
            "rrf_score": round(float(it["_rrf"]), 6),
            "version_relation": version_relation,
        }
        it["_has_perf"] = has_perf
        # Vyčistenie interných pomocných kľúčov
        for priv in ("_perf_hits", "_tag_hits", "_word_hits", "_dur_close", "_dur_exact", "_dur_mismatch", "_dur_ratio", "_raw_visual_exact", "_meta_score", "_domain_penalty", "_rrf"):
            it.pop(priv, None)

    # 4. Source diversity interleaving v rámci silných výsledkov (nikdy neodsúva zhody performera za nezhodné videá!)
    ordered = sorted(
        items,
        key=lambda x: (
            1 if (x.get("signals", {}).get("exact_frame") or (int(x.get("visual_score") or 0) >= 90 and not x.get("signals", {}).get("dur_mismatch"))) else 0,
            1 if x.get("_has_perf") else 0,
            x["confidence"],
            int(x.get("visual_score") or 0),
            int(x.get("views") or 0),
        ),
        reverse=True,
    )
    for it in ordered:
        it.pop("_has_perf", None)

    if len(ordered) > 10 and limit > 10:
        cap_per_src = max(4, min(6, int(limit * 0.22)))
        cap_library = max(4, min(7, int(limit * 0.22)))
        strong_group = [it for it in ordered if it.get("tier") in {"exact", "strong"}]
        rest_group = [it for it in ordered if it.get("tier") not in {"exact", "strong"}]

        counts: Dict[str, int] = {}
        lib_count = 0
        head: List[Dict[str, Any]] = []
        overflow_strong: List[Dict[str, Any]] = []
        for it in strong_group:
            src = str(it.get("source") or "other").lower()
            is_lib_item = bool(it.get("is_library"))
            true_exact = bool(it.get("signals", {}).get("exact_frame")) or (int(it.get("visual_score") or 0) >= 94 and not it.get("signals", {}).get("dur_mismatch"))
            if not true_exact:
                if is_lib_item and lib_count >= cap_library:
                    overflow_strong.append(it)
                    continue
                if counts.get(src, 0) >= cap_per_src:
                    overflow_strong.append(it)
                    continue
            head.append(it)
            counts[src] = counts.get(src, 0) + 1
            if is_lib_item:
                lib_count += 1
        ordered = head + overflow_strong + rest_group

    ordered = apply_related_intent_order(ordered, intent=intent)
    return ordered[:limit]


def apply_related_intent_order(items: Sequence[Dict[str, Any]], intent: str = "similar") -> List[Dict[str, Any]]:
    """Deterministicky zoradí kandidátov podľa zvoleného zámeru ('similar', 'same_video', 'same_creator', 'upgrade')
    bez nutnosti znova spúšťať vyhľadávacie zdroje."""
    out = [dict(it) for it in (items or [])]
    if not out or intent in {"", "similar"}:
        return out
    if intent == "same_video":
        out.sort(
            key=lambda it: (
                bool((it.get("signals") or {}).get("exact_frame", it.get("exact_frame"))),
                bool(it.get("confirmed_same_video")),
                0 if (it.get("signals") or {}).get("dur_mismatch") else 1,
                int((it.get("signals") or {}).get("visual_score", it.get("visual_score") or 0)),
                bool((it.get("signals") or {}).get("dur_close")),
                int((it.get("signals") or {}).get("word_hits") or 0),
                int(it.get("confidence") or 0),
            ),
            reverse=True,
        )
    elif intent == "same_creator":
        out.sort(
            key=lambda it: (
                int((it.get("signals") or {}).get("perf_hits_count") or (1 if it.get("ntp_models") else 0)),
                int(it.get("confidence") or 0),
                int((it.get("signals") or {}).get("visual_score", it.get("visual_score") or 0)),
            ),
            reverse=True,
        )
    elif intent == "upgrade":
        out.sort(
            key=lambda it: (
                1 if it.get("version_relation") == "upgrade_quality" else (1 if it.get("confirmed_same_video") else 0),
                0 if (it.get("signals") or {}).get("dur_mismatch") else 1,
                int(it.get("height") or 0),
                int(it.get("file_size") or 0),
                int((it.get("signals") or {}).get("visual_score", it.get("visual_score") or 0)),
                int(it.get("confidence") or 0),
            ),
            reverse=True,
        )
    return out


async def stream_unified_related(
    video_id: int,
    options: Dict[str, Any],
    db: Session,
) -> AsyncGenerator[Dict[str, Any], None]:
    """Hlavný asynchrónny generátor SSE udalostí pre jednotný Related Search."""
    from .main import (
        _google_vision_web_search,
        _r2_delete_frames,
        _r2_is_configured,
        _r2_publish_frames,
        _serpapi_google_lens_search,
        _yandex_cbir_search,
    )
    from . import visual_semantic_index as vsi

    started_all = time.perf_counter()
    external_url = str(options.get("image_url") or "").strip()
    is_external = bool(external_url) or video_id <= 0

    if is_external:
        if external_url:
            url_ok, url_reason = await asyncio.to_thread(validate_public_http_url, external_url)
            if not url_ok:
                yield {"type": "error", "msg": url_reason or "Náhľad musí byť verejná HTTP(S) URL"}
                return
        video = type("ExternalThumbSeed", (), {
            "id": 0,
            "thumbnail_path": external_url,
            "title": str(options.get("title") or ""),
            "tags": ",".join(options.get("keywords") or []),
            "ai_tags": "",
            "models": "",
            "categories": "",
            "url": "",
            "source_url": "",
            "original_thumbnail_url": external_url,
            "thumbnail_referer": "",
            "duration": 0,
            "height": 0,
        })()
    else:
        video = db.query(Video).filter(Video.id == video_id).first()
        if not video:
            yield {"type": "error", "msg": "Video sa nenašlo"}
            return

    mode = str(options.get("mode") or "hybrid").lower()
    intent = str(options.get("intent") or "similar")
    if mode not in {"hybrid", "visual", "library", "web"}:
        mode = "hybrid"

    crop_box = options.get("crop_box") if isinstance(options.get("crop_box"), dict) else None
    user_keywords = [str(k).strip() for k in (options.get("keywords") or []) if str(k).strip()][:16]
    custom_queries = [str(q).strip() for q in (options.get("queries") or []) if str(q).strip()][:6]

    raw_web_sources = options.get("web_sources")
    web_sources_explicit = raw_web_sources is not None
    web_sources = filter_valid_discovery_sources(list(raw_web_sources or [])) if web_sources_explicit else []

    raw_cbir = options.get("cbir_engines")
    cbir_explicit = raw_cbir is not None
    if cbir_explicit:
        cbir_engines = [str(e).strip().lower() for e in (raw_cbir or []) if str(e).strip()]
        if config.GOOGLE_VISION_API_KEY and "vision" not in cbir_engines:
            cbir_engines.append("vision")
    else:
        cbir_engines = ["namethatporn", "eporner", "xhamster", "xvideos", "spankbang", "erome", "yandex"]
        if config.SERPAPI_API_KEY:
            cbir_engines.append("serpapi")
        if config.GOOGLE_VISION_API_KEY:
            cbir_engines.append("vision")

    frame_mode = "deep" if str(options.get("frame_mode") or "fast").lower() == "deep" else "fast"
    limit = max(12, min(int(options.get("limit") or 60), 200))
    force_refresh = bool(options.get("force_refresh"))
    auto_ai_analyze = bool(options.get("auto_ai_analyze"))
    yandex_text = str(options.get("yandex_text") or "").strip()

    # 1. Získanie obrázka / snímok (opravené pre Telegram aj Deep mode + crop_box)
    frame_count = 3 if (frame_mode == "deep" and not crop_box) else 1
    frames = await extract_search_frames(video, count=frame_count, crop_box=crop_box)
    ref_bytes = frames[0] if frames else None

    # 2. Plánovanie queries + rýchle OCR čítanie vodoznaku v náhľade (napr. "SAMI HAYES @SSAMIBABY")
    plan = plan_related_queries(video, user_keywords=user_keywords)
    ocr_texts: List[str] = []
    if ref_bytes and config.GOOGLE_VISION_API_KEY:
        try:
            ocr_str = await extract_watermark_text_via_vision(ref_bytes)
            if ocr_str:
                ocr_texts.append(ocr_str)
                for oc in extract_creators_from_ocr_text(ocr_str, raw_title=plan.get("raw_title") or ""):
                    cname = str(oc.get("name") or "").strip()
                    if cname and cname.lower() not in {p.lower() for p in (plan.get("performers") or [])}:
                        plan["performers"] = list(plan.get("performers") or []) + [cname]
                    if not custom_queries and cname and cname.lower() not in {q.lower() for q in (plan.get("queries") or [])}:
                        plan["queries"] = [cname] + list(plan.get("queries") or [])
        except Exception as exc:
            logger.debug("[UNIFIED/ocr] preskočené: %s", exc)

    if (
        auto_ai_analyze
        and ref_bytes
        and not custom_queries
        and plan.get("is_meaningless_title")
        and not plan.get("performers")
        and options.get("gemini_api_key_ready", True)
    ):
        try:
            ai_res = await ai_analyze_for_related(ref_bytes, raw_title=plan.get("raw_title") or "")
            if ai_res:
                if ai_res.get("queries"):
                    custom_queries = ai_res["queries"]
                if ai_res.get("performers"):
                    plan["performers"] = list(dict.fromkeys(plan["performers"] + ai_res["performers"]))[:5]
                if ai_res.get("tags"):
                    plan["tags"] = list(dict.fromkeys(plan["tags"] + ai_res["tags"]))[:16]
                if ai_res.get("clean_title"):
                    plan["clean_title"] = ai_res["clean_title"]
                # Uložíme AI tagy do DB pre budúce okamžité použitie
                if not is_external and (ai_res.get("tags") or ai_res.get("performers")):
                    try:
                        existing_ai = set(split_csv(getattr(video, "ai_tags", "") or ""))
                        existing_ai.update(ai_res.get("tags") or [])
                        video.ai_tags = ",".join(sorted(existing_ai))
                        if ai_res.get("performers") and not (video.models or "").strip():
                            video.models = ", ".join(ai_res["performers"])
                        db.commit()
                    except Exception:
                        db.rollback()
        except Exception as exc:
            logger.debug("[UNIFIED] Auto AI analyze preskočené: %s", exc)

    active_queries = custom_queries if custom_queries else list(plan.get("queries") or [])
    yield {
        "type": "context",
        "clean_title": plan.get("clean_title") or "",
        "performers": plan.get("performers") or [],
        "tags": plan.get("tags") or [],
        "queries": active_queries,
        "frames_used": len(frames),
        "has_thumb": bool(ref_bytes),
        "gpu_status": vsi.get_status(),
    }

    # Kontrola cache (intent nie je súčasťou cache_key: kandidáti sú zdieľaní a pri zmene zámeru sa okamžite preradia)
    cache_material = json.dumps({
        "v": _PIPELINE_VERSION,
        "video_id": video_id,
        "mode": mode,
        "queries": active_queries,
        "web_sources": sorted(web_sources),
        "cbir_engines": sorted(cbir_engines),
        "frame_mode": frame_mode,
        "crop_box": crop_box,
        "yandex_text": yandex_text,
        "image_hash": hashlib.sha256(ref_bytes).hexdigest()[:16] if ref_bytes else "",
    }, sort_keys=True, ensure_ascii=False)
    cache_key = hashlib.sha256(cache_material.encode("utf-8")).hexdigest()
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

    if not is_external and not force_refresh:
        cached_row = db.query(CBIRSearchCache).filter(CBIRSearchCache.cache_key == cache_key).first()
        if cached_row and cached_row.expires_at > now:
            payload = dict(cached_row.response_json or {})
            payload["cached"] = True
            payload["cache_age_seconds"] = max(0, int((now - cached_row.created_at).total_seconds()))
            ordered_cached = apply_related_intent_order(payload.get("results") or [], intent=intent)
            yield {
                "type": "done",
                "results": ordered_cached,
                "engines": payload.get("engines") or {},
                "detected_creators": payload.get("detected_creators") or [],
                "cached": True,
                "cache_age_seconds": payload["cache_age_seconds"],
                "elapsed_ms": round((time.perf_counter() - started_all) * 1000),
            }
            return

    all_candidates: List[Dict[str, Any]] = []
    engine_details: Dict[str, Dict[str, Any]] = {}
    queue: asyncio.Queue = asyncio.Queue()
    active_performers: List[str] = list(plan.get("performers") or [])
    visual_hits_for_creator: List[Dict[str, Any]] = []
    detected_creators: List[Dict[str, Any]] = extract_creators_from_visual_hits(
        [],
        known_performers=active_performers,
        raw_title=str(getattr(video, "title", "") or ""),
        ocr_texts=ocr_texts,
    )
    pivoted_creators: Set[str] = {p.lower() for p in active_performers}
    auto_creator_pivot = bool(options.get("auto_creator_pivot", True))
    prev_emitted_sigs: Dict[str, str] = {}

    if detected_creators:
        yield {"type": "detected_creators", "creators": detected_creators}

    def _emit_merged_snapshot() -> List[Dict[str, Any]]:
        return rrf_fuse_and_explain(
            all_candidates,
            source_video=video,
            performers=active_performers,
            tags=plan.get("tags") or [],
            clean_title=plan.get("clean_title") or "",
            limit=limit,
            intent=intent,
        )

    def _emit_batch_payload(event_type: str, **extra: Any) -> Dict[str, Any]:
        snapshot = _emit_merged_snapshot()
        changed: List[Dict[str, Any]] = []
        order_keys: List[str] = []
        for item in snapshot:
            ikey = f"library:{item.get('video_id')}" if item.get("is_library") and item.get("video_id") else str(item.get("url") or "")
            order_keys.append(ikey)
            sig = f"{item.get('confidence')}|{item.get('visual_score')}|{item.get('height')}|{item.get('duration')}|{item.get('version_relation')}|{len(item.get('engines_seen') or [])}"
            if prev_emitted_sigs.get(ikey) != sig:
                prev_emitted_sigs[ikey] = sig
                changed.append(item)
        return {
            "type": event_type,
            **extra,
            "changed_items": changed,
            "order_keys": order_keys,
            "results": snapshot,
        }

    # ── LANE 1: Lokálna knižnica (SigLIP2 GPU + FTS5 BM25) — v režime Vizuálne (CBIR) hľadáme iba externé zdroje ──
    if mode in {"hybrid", "library"} and not is_external:
        t_lib = time.perf_counter()
        lib_items: List[Dict[str, Any]] = []
        try:
            q_txt = " ".join(active_queries[:2]) if active_queries else (plan.get("clean_title") or "")
            if vsi.is_gpu_ready():
                lib_items.extend(await asyncio.to_thread(
                    vsi.search_similar_in_library_sync,
                    ref_bytes,
                    q_txt,
                    24,
                    video_id,
                ))
            # Doplníme rýchly FTS5 dopyt
            from .related_recommendations import RelatedRecommendationService
            fts_items = await asyncio.to_thread(
                RelatedRecommendationService(db)._local_library_candidates,
                video,
                28,
            )
            lib_items.extend(fts_items)
        except Exception as exc:
            logger.debug("[UNIFIED/library] zlyhal: %s", exc)

        lib_ms = round((time.perf_counter() - t_lib) * 1000)
        if lib_items:
            all_candidates.extend(lib_items)
        engine_details["library"] = {
            "name": "library",
            "status": "ok" if lib_items else "empty",
            "count": len(lib_items),
            "latency_ms": lib_ms,
            "error": "",
        }
        yield {"type": "engine", "engine": engine_details["library"]}
        if lib_items:
            yield _emit_batch_payload("batch", lane="library")

    if mode == "library":
        final_results = _emit_merged_snapshot()
        yield {
            "type": "done",
            "results": final_results,
            "engines": engine_details,
            "detected_creators": detected_creators,
            "cached": False,
            "elapsed_ms": round((time.perf_counter() - started_all) * 1000),
        }
        return

    # ── Príprava paralelných taskov pre Fast CBIR, Visual CBIR a External Web ──
    tasks: List[asyncio.Task] = []
    published_frames: List[Dict[str, str]] = []

    async def _run_and_push(name: str, lane: str, coro) -> None:
        t0 = time.perf_counter()
        await queue.put(("engine", {"name": name, "status": "running", "count": 0, "latency_ms": 0, "error": ""}))
        try:
            res = await coro
            items = list(res or [])
            lat = round((time.perf_counter() - t0) * 1000)
            detail = {"name": name, "status": "ok" if items else "empty", "count": len(items), "latency_ms": lat, "error": ""}
            await queue.put(("result", lane, detail, items))
        except Exception as exc:
            lat = round((time.perf_counter() - t0) * 1000)
            msg = str(exc)[:220] or exc.__class__.__name__
            status = "unavailable" if "nie je nastaven" in msg.lower() else "error"
            detail = {"name": name, "status": status, "count": 0, "latency_ms": lat, "error": msg}
            await queue.put(("result", lane, detail, []))

    # Fast CBIR keyword searchers (eporner, xhamster, xvideos, spankbang, erome)
    if mode in {"hybrid", "web"} and active_queries:
        top_q = active_queries[0]
        alt_q = active_queries[1] if len(active_queries) >= 2 else ""
        wanted_fast = [s for s in cbir_engines if s in _FAST_CBIR_FUNCS]

        async def _fast_one(eng_name: str) -> List[Dict[str, Any]]:
            async with httpx.AsyncClient(
                timeout=10, follow_redirects=True,
                headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
            ) as cl:
                res = await _FAST_CBIR_FUNCS[eng_name](cl, top_q, 14)
                if len(res) < 3 and alt_q and alt_q.lower() != top_q.lower():
                    extra = await _FAST_CBIR_FUNCS[eng_name](cl, alt_q, 10)
                    seen_u = {x.get("url") for x in res}
                    res.extend([x for x in extra if x.get("url") not in seen_u])
                return res

        for eng_name in wanted_fast:
            tasks.append(asyncio.create_task(_run_and_push(eng_name, "web", _fast_one(eng_name))))

    # ExternalSearchEngine (porntrex, whoreshub, fpo, pornhub, camwhores, ...)
    target_sources = web_sources if web_sources_explicit else [
        "porntrex", "whoreshub", "fpo", "pornhub", "camwhores", "noodlemagazine", "pornone"
    ]
    if mode in {"hybrid", "web"} and active_queries and target_sources:
        ext_engine = ExternalSearchEngine()

        async def _run_ext_query(q_str: str) -> None:
            async def _on_src(src_key: str, src_items: List[Dict[str, Any]], diag_entry: Dict[str, Any]) -> None:
                detail = {
                    "name": src_key,
                    "status": diag_entry.get("status") or ("ok" if src_items else "empty"),
                    "count": len(src_items),
                    "latency_ms": int(diag_entry.get("elapsed_ms") or 0),
                    "error": str(diag_entry.get("error") or ""),
                }
                await queue.put(("result", "web", detail, list(src_items or [])))

            try:
                await asyncio.wait_for(
                    ext_engine.search_sources(
                        q_str,
                        target_sources,
                        result_limit=24,
                        online_only=True,
                        return_diagnostics=True,
                        search_depth=1,
                        source_callback=_on_src,
                        allow_fallback=False,
                        expand_variants=False,
                    ),
                    timeout=14.0,
                )
            except Exception as exc:
                logger.debug("[UNIFIED/ext] query=%r timeout/err: %s", q_str, exc)

        for q_str in active_queries[:2]:
            tasks.append(asyncio.create_task(_run_ext_query(q_str)))

    # Visual CBIR enginy (NameThatPorn, Yandex, priamy SerpApi upload, Google Vision)
    if mode in {"hybrid", "visual"} and frames:
        if "namethatporn" in cbir_engines:
            async def _run_ntp() -> List[Dict[str, Any]]:
                fallback_url = external_url if external_url.startswith(("http://", "https://")) else ""
                return await namethatporn_cbir_search(frames[:2], image_url=fallback_url, limit=24)

            tasks.append(asyncio.create_task(_run_and_push("namethatporn", "visual", _run_ntp())))

        if "yandex" in cbir_engines:
            async def _run_yandex() -> List[Dict[str, Any]]:
                batches = await asyncio.gather(*[
                    _yandex_cbir_search(fr, limit=16, text=yandex_text) for fr in frames[:2]
                ], return_exceptions=True)
                ok_batches = [b for b in batches if isinstance(b, list)]
                if not ok_batches:
                    err = next((b for b in batches if isinstance(b, Exception)), RuntimeError("Yandex zlyhal"))
                    raise err
                return [item for b in ok_batches for item in b]

            tasks.append(asyncio.create_task(_run_and_push("yandex", "visual", _run_yandex())))

        if "serpapi" in cbir_engines and config.SERPAPI_API_KEY:
            async def _run_serpapi() -> List[Dict[str, Any]]:
                fallback_url = external_url if external_url.startswith(("http://", "https://")) else ""
                return await _serpapi_google_lens_search(
                    image_url=fallback_url,
                    image_bytes=frames[0],
                    limit=32,
                )

            tasks.append(asyncio.create_task(_run_and_push("serpapi", "visual", _run_serpapi())))

        if "vision" in cbir_engines and config.GOOGLE_VISION_API_KEY:
            tasks.append(asyncio.create_task(_run_and_push(
                "vision", "visual", _google_vision_web_search(frames[:1], limit=20)
            )))

    # ── Priebežné zberanie výsledkov z fronty (vrátane dynamického 2. kroku podľa zisteného tvorcu) ──
    async def _spawn_creator_pivot_search(creator_name: str, extra_queries: Sequence[str] = ()) -> None:
        """Automaticky dohľadá ďalšie videá zisteného tvorcu na webe, vo fast CBIR aj v knižnici."""
        pivot_tasks: List[asyncio.Task] = []
        pivot_queries = [creator_name] + [q for q in (extra_queries or []) if q and q.lower() != creator_name.lower()]
        # 1. Rýchle lokálne knižničné vyhľadanie podľa mena tvorcu (SigLIP2 + FTS5)
        if mode in {"hybrid", "library"} and not is_external:
            try:
                lib_extra: List[Dict[str, Any]] = []
                if vsi.is_gpu_ready():
                    lib_extra.extend(await asyncio.to_thread(
                        vsi.search_similar_in_library_sync,
                        None,
                        creator_name,
                        16,
                        video_id,
                    ))
                from .related_recommendations import RelatedRecommendationService
                pivot_seed = type("PivotSeed", (), {
                    "id": video_id,
                    "title": creator_name,
                    "models": ", ".join(pivot_queries[:2]),
                    "tags": "",
                    "ai_tags": "",
                    "categories": "",
                    "url": getattr(video, "url", "") or "",
                    "source_url": getattr(video, "source_url", "") or "",
                    "duration": getattr(video, "duration", 0) or 0,
                    "height": getattr(video, "height", 0) or 0,
                })()
                fts_extra = await asyncio.to_thread(
                    RelatedRecommendationService(db)._local_library_candidates,
                    pivot_seed,
                    20,
                )
                lib_extra.extend(fts_extra)
                if lib_extra:
                    await queue.put(("result", "library", {"name": "library", "status": "ok", "count": len(lib_extra), "latency_ms": 0, "error": ""}, lib_extra))
            except Exception:
                pass

        # 2. Fast CBIR enginy (Eporner, xHamster, XVideos, Erome) pre zisteného tvorcu (a prípadne párovú scénu z NTP)
        wanted_p_fast = [s for s in cbir_engines if s in ("eporner", "xhamster", "xvideos", "erome")]
        for eng_name in wanted_p_fast:
            for pq in pivot_queries[:2]:
                async def _p_fast(en: str = eng_name, q_str: str = pq) -> None:
                    try:
                        async with httpx.AsyncClient(
                            timeout=9, follow_redirects=True,
                            headers={"User-Agent": _CBIR_UA, "Accept-Language": "en-US,en;q=0.8"},
                        ) as cl:
                            items_f = await _FAST_CBIR_FUNCS[en](cl, q_str, 12)
                            if items_f:
                                await queue.put(("result", "creator", {"name": en, "status": "ok", "count": len(items_f), "latency_ms": 0, "error": ""}, items_f))
                    except Exception:
                        pass
                pivot_tasks.append(asyncio.create_task(_p_fast()))

        # 3. Externé zdroje pre rozpoznaného tvorcu
        if target_sources:
            ext_p = ExternalSearchEngine()

            async def _on_p_src(src_key: str, src_items: List[Dict[str, Any]], diag_entry: Dict[str, Any]) -> None:
                detail = {
                    "name": src_key,
                    "status": diag_entry.get("status") or ("ok" if src_items else "empty"),
                    "count": len(src_items),
                    "latency_ms": int(diag_entry.get("elapsed_ms") or 0),
                    "error": str(diag_entry.get("error") or ""),
                }
                await queue.put(("result", "creator", detail, list(src_items or [])))

            pivot_tasks.append(asyncio.create_task(
                asyncio.wait_for(
                    ext_p.search_sources(
                        creator_name,
                        target_sources[:6],
                        result_limit=20,
                        online_only=True,
                        return_diagnostics=True,
                        search_depth=1,
                        source_callback=_on_p_src,
                        allow_fallback=False,
                        expand_variants=False,
                    ),
                    timeout=12.0,
                )
            ))
        if pivot_tasks:
            await asyncio.gather(*pivot_tasks, return_exceptions=True)

    async def _wait_all_tasks() -> None:
        # Spracujeme počiatočné aj dynamicky pridané (creator pivot) tasky až do úplného dobehnutia
        while True:
            pending = [t for t in tasks if not t.done()]
            if not pending:
                break
            await asyncio.gather(*pending, return_exceptions=True)
        await queue.put(("__END__",))

    watcher = asyncio.create_task(_wait_all_tasks())
    last_creator_sig = "|".join(f"{c['name']}:{c['mentions']}" for c in detected_creators[:3])
    raw_video_title = str(getattr(video, "title", "") or "")
    try:
        while True:
            msg = await queue.get()
            kind = msg[0]
            if kind == "__END__":
                # Processing earlier queued results can start a creator pivot
                # after the watcher already queued its end marker.
                if not queue.empty() or any(not task.done() for task in tasks):
                    watcher = asyncio.create_task(_wait_all_tasks())
                    continue
                break
            if kind == "engine":
                detail = msg[1]
                engine_details[detail["name"]] = detail
                yield {"type": "engine", "engine": detail}
            elif kind == "result":
                _, lane, detail, items = msg
                prev = engine_details.get(detail["name"])
                # Ak viac queries hitne rovnaký zdroj, zlúčime počty a neprepíšeme 'ok' prázdnym výsledkom
                if prev and prev.get("status") == "ok":
                    detail["count"] = int(prev.get("count") or 0) + int(detail.get("count") or 0)
                    detail["status"] = "ok"
                    detail["error"] = ""
                engine_details[detail["name"]] = detail
                yield {"type": "engine", "engine": detail}
                if items:
                    all_candidates.extend(items)
                    if lane == "visual":
                        visual_hits_for_creator.extend(items)
                        cands = extract_creators_from_visual_hits(
                            visual_hits_for_creator,
                            known_performers=active_performers,
                            raw_title=raw_video_title,
                            ocr_texts=ocr_texts,
                        )
                        if cands:
                            detected_creators = cands
                            sig = "|".join(f"{c['name']}:{c['mentions']}" for c in detected_creators[:3])
                            if sig != last_creator_sig:
                                last_creator_sig = sig
                                yield {"type": "detected_creators", "creators": detected_creators}
                            top_c = next(
                                (c for c in detected_creators if " " in str(c.get("name") or "") and "_" not in str(c.get("name") or "")),
                                detected_creators[0],
                            )
                            cname = str(top_c.get("name") or "").strip()
                            if (
                                auto_creator_pivot
                                and mode in {"hybrid", "web", "visual"}
                                and not custom_queries
                                and cname
                                and cname.lower() not in pivoted_creators
                                and len(pivoted_creators) < 2
                                and (" " in cname or int(top_c.get("mentions") or 0) >= 2)
                                and (int(top_c.get("mentions") or 0) >= 2 or int(top_c.get("confidence") or 0) >= 75)
                            ):
                                pivoted_creators.add(cname.lower())
                                if cname not in active_performers:
                                    active_performers.append(cname)
                                if cname.lower() not in {q.lower() for q in active_queries}:
                                    active_queries.insert(0, cname)
                                extra_p_queries: List[str] = []
                                for dc in detected_creators[1:3]:
                                    sec_name = str(dc.get("name") or "").strip()
                                    if sec_name and " " in sec_name and int(dc.get("confidence") or 0) >= 82:
                                        if sec_name not in active_performers:
                                            active_performers.append(sec_name)
                                        pair_q = f"{cname} {sec_name}"
                                        if pair_q not in extra_p_queries:
                                            extra_p_queries.append(pair_q)
                                yield {"type": "creator_pivot", "creator": cname}
                                tasks.append(asyncio.create_task(_spawn_creator_pivot_search(cname, extra_queries=extra_p_queries)))
                    yield _emit_batch_payload("batch", lane=lane)
    finally:
        for task in [watcher, *tasks]:
            if not task.done():
                task.cancel()
        await asyncio.gather(watcher, *tasks, return_exceptions=True)
        if published_frames:
            await _r2_delete_frames(published_frames)

    # ── Finálny GPU vizuálny re-rank na stiahnutých thumbnailoch externých výsledkov ──
    if ref_bytes and all_candidates:
        try:
            if vsi.is_gpu_ready():
                scored = await vsi.score_candidate_thumbnails(ref_bytes, all_candidates, max_fetch=64)
            else:
                from .main import _visual_rank_results
                scored = await _visual_rank_results(all_candidates, ref_bytes)
            if visual_hits_for_creator or active_performers or ocr_texts:
                refined_creators = extract_creators_from_visual_hits(
                    visual_hits_for_creator,
                    known_performers=active_performers,
                    raw_title=raw_video_title,
                    ocr_texts=ocr_texts,
                )
                if refined_creators:
                    detected_creators = refined_creators
                    yield {"type": "detected_creators", "creators": detected_creators}
                    for rc in refined_creators[:2]:
                        rc_name = str(rc.get("name") or "").strip()
                        if rc_name and int(rc.get("confidence") or 0) >= 78 and rc_name.lower() not in {p.lower() for p in active_performers}:
                            active_performers.append(rc_name)
            if scored > 0:
                yield _emit_batch_payload("rerank", visual_scored=scored)
        except Exception as exc:
            logger.debug("[UNIFIED/rerank] zlyhal: %s", exc)

    final_results = _emit_merged_snapshot()
    elapsed_ms = round((time.perf_counter() - started_all) * 1000)

    payload_to_cache = {
        "results": final_results,
        "engines": engine_details,
        "detected_creators": detected_creators,
        "count": len(final_results),
        "queries": active_queries,
    }
    has_ok = any(d.get("status") == "ok" for d in engine_details.values())
    if not is_external and final_results and has_ok:
        try:
            expires_at = now + datetime.timedelta(hours=config.CBIR_CACHE_TTL_HOURS)
            row = db.query(CBIRSearchCache).filter(CBIRSearchCache.cache_key == cache_key).first()
            if not row:
                row = CBIRSearchCache(
                    cache_key=cache_key,
                    video_id=video_id,
                    image_hash=hashlib.sha256(ref_bytes).hexdigest() if ref_bytes else "",
                    request_json={"mode": mode, "queries": active_queries},
                    response_json=payload_to_cache,
                    created_at=now,
                    expires_at=expires_at,
                )
                db.add(row)
            else:
                row.response_json = payload_to_cache
                row.created_at = now
                row.expires_at = expires_at
            db.commit()
        except Exception as exc:
            db.rollback()
            logger.debug("[UNIFIED/cache] uloženie zlyhalo: %s", exc)

    yield {
        "type": "done",
        "results": final_results,
        "engines": engine_details,
        "detected_creators": detected_creators,
        "cached": False,
        "elapsed_ms": elapsed_ms,
    }


async def discover_creator_for_video(
    video_id: int,
    crop_box: Optional[Dict[str, float]] = None,
    auto_save: bool = False,
    db: Optional[Session] = None,
) -> Dict[str, Any]:
    """Jednorazovo zistí tvorcu/performera z názvu, OCR vodoznaku v náhľade, vizuálnych CBIR zhôd a AI."""
    from .main import _google_vision_web_search, _serpapi_google_lens_search, _yandex_cbir_search
    from . import visual_semantic_index as vsi

    video = db.query(Video).filter(Video.id == video_id).first() if db else None
    if not video:
        return {"creators": [], "visual_hits_count": 0, "saved_models": ""}

    thumb_bytes = await resolve_video_thumb_bytes(
        str(video.thumbnail_path or ""),
        referer=str(getattr(video, "thumbnail_referer", "") or getattr(video, "source_url", "") or ""),
        crop_box=crop_box,
    )
    if not thumb_bytes:
        return {"creators": [], "visual_hits_count": 0, "saved_models": str(video.models or "")}

    tasks = [
        asyncio.create_task(namethatporn_cbir_search([thumb_bytes], limit=18)),
        asyncio.create_task(_yandex_cbir_search(thumb_bytes, limit=18)),
    ]
    if config.SERPAPI_API_KEY:
        tasks.append(asyncio.create_task(_serpapi_google_lens_search(image_bytes=thumb_bytes, limit=24)))
    if config.GOOGLE_VISION_API_KEY:
        tasks.append(asyncio.create_task(_google_vision_web_search([thumb_bytes], limit=20)))

    batches = await asyncio.gather(*tasks, return_exceptions=True)
    vis_hits: List[Dict[str, Any]] = []
    for b in batches:
        if isinstance(b, list):
            vis_hits.extend(b)

    if vsi.is_gpu_ready() and vis_hits:
        try:
            await vsi.score_candidate_thumbnails(thumb_bytes, vis_hits, max_fetch=36)
        except Exception:
            pass

    plan = plan_related_queries(video)
    known = list(dict.fromkeys(split_csv(getattr(video, "models", "") or "") + list(plan.get("performers") or [])))
    heuristics = extract_creators_from_visual_hits(
        vis_hits,
        known_performers=known,
        raw_title=str(video.title or ""),
    )
    vis_titles = [
        str(h.get("title") or "").strip()
        for h in vis_hits
        if h.get("title") and (int(h.get("visual_score") or 0) >= 52 or int(h.get("visual_score") or 0) == 0)
    ][:14]
    creators = await ai_disambiguate_creator(
        thumb_bytes,
        raw_title=str(video.title or ""),
        visual_titles=vis_titles,
        heuristic_candidates=heuristics,
    )

    if auto_save and creators and db is not None:
        existing_models = split_csv(getattr(video, "models", "") or "")
        top_name = str(creators[0].get("name") or "").strip()
        if top_name and top_name.lower() not in {m.lower() for m in existing_models}:
            existing_models.append(top_name)
            video.models = ", ".join(existing_models)
            try:
                db.commit()
            except Exception:
                db.rollback()

    return {
        "creators": creators,
        "visual_hits_count": len(vis_hits),
        "saved_models": str(video.models or ""),
    }


async def _head_media_size_bytes(
    media_url: str,
    referer: str = "",
    headers: Optional[Dict[str, str]] = None,
) -> int:
    """Zistí presnú veľkosť mediálneho súboru v bajtoch cez HTTP HEAD alebo Range: bytes=0-0."""
    target = str(media_url or "").strip()
    if not target.startswith(("http://", "https://")) or ".m3u8" in target.lower():
        return 0
    ok, _ = await asyncio.to_thread(validate_public_http_url, target)
    if not ok:
        return 0

    req_headers: Dict[str, str] = {"User-Agent": _CBIR_UA}
    if referer and referer.startswith(("http://", "https://")):
        req_headers["Referer"] = referer
    if isinstance(headers, dict):
        for hk, hv in headers.items():
            if hk and hv and hk.lower() not in {"host", "content-length", "range"}:
                req_headers[str(hk)] = str(hv)

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0), follow_redirects=True) as cl:
            resp = await cl.head(target, headers=req_headers)
            if resp.status_code < 400:
                clen = _parse_int_safe(resp.headers.get("content-length"))
                if clen > 50_000:
                    return clen
            # Fallback cez 1-bajtový Range GET (niektoré CDN nepovoľujú HEAD alebo vrátia 403/405)
            range_hdrs = {**req_headers, "Range": "bytes=0-0"}
            r2 = await cl.get(target, headers=range_hdrs)
            cr = str(r2.headers.get("content-range") or "")
            m = re.search(r"/(\d+)\s*$", cr)
            if m:
                total = _parse_int_safe(m.group(1))
                if total > 50_000:
                    return total
            clen2 = _parse_int_safe(r2.headers.get("content-length"))
            if r2.status_code == 200 and clen2 > 50_000:
                return clen2
    except Exception:
        pass
    return 0


def _parse_quality_height(val: Any, width: int = 0) -> int:
    """Extrahuje vertikálne rozlíšenie (height v px) z čísla, labelu ('4K', '1080p60', 'FHD') alebo šírky."""
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        h = int(val)
        if 100 <= h <= 4320:
            return h
    txt = str(val or "").strip().lower()
    if txt:
        if any(tok in txt for tok in ("2160", "4k", "uhd")):
            return 2160
        if any(tok in txt for tok in ("1440", "2k", "qhd")):
            return 1440
        if any(tok in txt for tok in ("1080", "fhd", "fullhd", "full hd")):
            return 1080
        if "720" in txt or txt == "hd":
            return 720
        if "480" in txt or txt == "sd":
            return 480
        if "360" in txt:
            return 360
        if "240" in txt:
            return 240
        m = re.search(r"(?<!\d)(\d{3,4})\s*p(?:60|50|30|25|24)?(?!\d)", txt)
        if m:
            h = int(m.group(1))
            if 100 <= h <= 4320:
                return h
        if txt.isdigit():
            h = int(txt)
            if 100 <= h <= 4320:
                return h
    w = int(width or 0)
    if w >= 3800:
        return 2160
    if w >= 2500:
        return 1440
    if w >= 1900:
        return 1080
    if w >= 1200:
        return 720
    if w >= 800:
        return 480
    if w >= 600:
        return 360
    return 0


def _pick_best_quality_format(
    formats: Sequence[Dict[str, Any]],
    *,
    duration: int = 0,
    prefer_audio: bool = False,
    require_url: bool = False,
) -> Optional[Dict[str, Any]]:
    """Vyberie najvyššiu kvalitu: najprv najvyššie rozlíšenie (height), potom najväčší súbor/bitrate."""
    best_fmt: Optional[Dict[str, Any]] = None
    best_rank: Tuple[int, int, int, float] = (-1, -1, -1, -1.0)
    for fmt in formats or []:
        if not isinstance(fmt, dict):
            continue
        vcodec = str(fmt.get("vcodec") or "").lower()
        if vcodec == "none":
            continue
        u = str(fmt.get("url") or fmt.get("stream_url") or "").strip()
        if require_url and not u.startswith(("http://", "https://")):
            continue
        fw = _parse_int_safe(fmt.get("width"))
        fh = _parse_quality_height(
            fmt.get("height")
            or fmt.get("quality")
            or fmt.get("label")
            or fmt.get("format_note")
            or fmt.get("format_id"),
            width=fw,
        )
        exact_fs = _parse_int_safe(
            fmt.get("file_size") or fmt.get("filesize") or fmt.get("size_bytes")
        )
        approx_fs = _parse_int_safe(fmt.get("filesize_approx"))
        tbr = float(fmt.get("tbr") or fmt.get("vbr") or 0.0)
        est_fs = exact_fs or approx_fs
        if est_fs <= 0 and duration > 0 and tbr > 20.0:
            est_fs = int(tbr * 1000.0 / 8.0 * duration)
        has_audio = 0
        if prefer_audio:
            acodec = str(fmt.get("acodec") or "").lower()
            has_audio = 0 if acodec == "none" else 1
        rank = (fh, has_audio, est_fs, tbr)
        if rank > best_rank:
            best_rank = rank
            best_fmt = fmt
    return best_fmt


def _find_cookiefile_for_url(url: str) -> Optional[str]:
    """Nájde najvhodnejší Netscape cookie súbor pre danú doménu."""
    import os

    try:
        host = re.sub(r"^www\.", "", (urllib.parse.urlsplit(url).hostname or "").lower())
    except Exception:
        host = ""
    candidates: List[str] = []
    if host:
        base = host.split(".")[0]
        candidates.extend([
            f"{base}.netscape.txt",
            f"{base}.cookies.txt",
            f"{host}_cookies.txt",
            f"{base}_cookies.txt",
        ])
    candidates.append("cookies.netscape.txt")
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


async def _probe_single_related_url(url: str) -> Dict[str, Any]:
    """Bezpečne zistí dĺžku, rozlíšenie a veľkosť videa v najvyššej kvalite (extraktor -> yt-dlp -> HTTP HEAD)."""
    clean_url = str(url or "").strip()
    ok, reason = await asyncio.to_thread(validate_public_http_url, clean_url)
    if not ok:
        return {"url": clean_url, "probe_ok": False, "error": reason or "Nepovolená URL"}

    duration = 0
    height = 0
    width = 0
    file_size = 0
    file_size_approx = False
    best_stream_url = ""
    best_referer = clean_url
    best_headers: Dict[str, str] = {}

    is_pornhub_extractor = False
    extractor_had_formats = False
    listed_max_height = 0
    listed_max_size = 0

    # 1. Rýchly pokus cez registrovaný Nexus extraktor (často rýchlejší a presnejší než yt-dlp)
    try:
        from .extractors import ExtractorRegistry, init_registry, register_extended_extractors

        init_registry()
        register_extended_extractors()
        extractor = ExtractorRegistry.find_extractor(clean_url)
        if extractor is not None:
            ext_name = getattr(extractor, "name", "")
            is_pornhub_extractor = ext_name == "Pornhub"
            extract_timeout = 16.0 if ext_name in ("Pornhub", "Eporner") else 12.0
            info = await asyncio.wait_for(extractor.extract(clean_url), timeout=extract_timeout)
            if isinstance(info, dict):
                duration = _parse_duration_sec(info.get("duration"))
                width = _parse_int_safe(info.get("width"))
                height = _parse_quality_height(info.get("height") or info.get("quality"), width=width)
                exact_size = _parse_int_safe(
                    info.get("file_size") or info.get("filesize") or info.get("size_bytes")
                )
                approx_size = _parse_int_safe(info.get("filesize_approx"))
                if exact_size > 0:
                    file_size = exact_size
                    file_size_approx = bool(info.get("size_estimated") or info.get("file_size_approx"))
                elif approx_size > 0:
                    file_size = approx_size
                    file_size_approx = True
                cand_stream = str(info.get("stream_url") or info.get("url") or "").strip()
                if cand_stream.startswith(("http://", "https://")) and cand_stream != clean_url:
                    best_stream_url = cand_stream
                if info.get("referer"):
                    best_referer = str(info.get("referer"))
                listed_max_height = _parse_quality_height(info.get("listed_max_height"))
                listed_max_size = _parse_int_safe(info.get("listed_max_size_bytes"))
                # Ak extraktor vracia zoznam kvalít/formátov, vyberieme najvyššiu kvalitu (najväčší súbor)
                for fmt_key in ("formats", "renditions", "sources"):
                    fmts = info.get(fmt_key)
                    if isinstance(fmts, list) and fmts:
                        extractor_had_formats = True
                        best_ext_fmt = _pick_best_quality_format(fmts, duration=duration)
                        if best_ext_fmt:
                            fw = _parse_int_safe(best_ext_fmt.get("width"))
                            fh = _parse_quality_height(
                                best_ext_fmt.get("height") or best_ext_fmt.get("quality") or best_ext_fmt.get("label"),
                                width=fw,
                            )
                            ffs = _parse_int_safe(
                                best_ext_fmt.get("file_size")
                                or best_ext_fmt.get("filesize")
                                or best_ext_fmt.get("size_bytes")
                            )
                            ffs_approx = _parse_int_safe(best_ext_fmt.get("filesize_approx"))
                            fu = str(best_ext_fmt.get("url") or best_ext_fmt.get("stream_url") or "").strip()
                            if fh > height or (fh == height and max(ffs, ffs_approx) > file_size):
                                height = fh or height
                                width = fw or width
                                if ffs > 0:
                                    file_size = ffs
                                    file_size_approx = bool(best_ext_fmt.get("size_estimated"))
                                elif ffs_approx > 0 and file_size <= 0:
                                    file_size = ffs_approx
                                    file_size_approx = True
                                if fu.startswith(("http://", "https://")):
                                    best_stream_url = fu
    except Exception as exc:
        logger.debug("[RELATED/probe] extractor zlyhal pre %s: %s", clean_url[:70], exc)

    # 2. Ak máme z extraktora priamy stream najvyššej kvality, ale chýba veľkosť, skúsime rýchly HEAD/Range
    if file_size <= 0 and best_stream_url and ".m3u8" not in best_stream_url.lower():
        head_sz = await _head_media_size_bytes(best_stream_url, referer=best_referer)
        if head_sz > 0:
            file_size = head_sz
            file_size_approx = False

    # 3. Doplnenie alebo upgrade kvality cez yt-dlp (s cookies) ak chýbajú metadáta alebo existuje šanca na vyššiu kvalitu
    skip_ytdlp_fallback = is_pornhub_extractor and (duration > 0 or height > 0)
    needs_quality_upgrade_check = (
        (listed_max_height > height)
        or (height < 1080 and not extractor_had_formats)
    )
    if not skip_ytdlp_fallback and (duration <= 0 or height <= 0 or file_size <= 0 or needs_quality_upgrade_check):
        cookiefile = _find_cookiefile_for_url(clean_url)

        def _ytdlp_probe(target: str) -> Dict[str, Any]:
            import yt_dlp
            silent = type("_SL", (), {"debug": lambda *_: None, "warning": lambda *_: None, "error": lambda *_: None})()
            opts: Dict[str, Any] = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "socket_timeout": 8,
                "logger": silent,
            }
            if cookiefile:
                opts["cookiefile"] = cookiefile
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(target, download=False) or {}

        try:
            info = await asyncio.wait_for(asyncio.to_thread(_ytdlp_probe, clean_url), timeout=12.0)
            if isinstance(info, dict) and info:
                duration = duration or _parse_duration_sec(info.get("duration"))
                w_cand = _parse_int_safe(info.get("width"))
                h_cand = _parse_quality_height(info.get("height") or info.get("quality"), width=w_cand)
                fs_cand = _parse_int_safe(info.get("filesize"))
                fs_approx_cand = _parse_int_safe(info.get("filesize_approx"))
                formats = info.get("formats") if isinstance(info.get("formats"), list) else []

                best_fmt = _pick_best_quality_format(formats, duration=duration)
                if best_fmt is not None:
                    fw = _parse_int_safe(best_fmt.get("width"))
                    fh = _parse_quality_height(
                        best_fmt.get("height")
                        or best_fmt.get("quality")
                        or best_fmt.get("format_note")
                        or best_fmt.get("format_id"),
                        width=fw,
                    )
                    exact_fs = _parse_int_safe(best_fmt.get("filesize") or best_fmt.get("file_size"))
                    approx_fs = _parse_int_safe(best_fmt.get("filesize_approx"))
                    if fh >= h_cand:
                        h_cand = fh or h_cand
                        w_cand = fw or w_cand
                    if exact_fs > 0:
                        fs_cand = exact_fs
                    elif approx_fs > 0:
                        fs_approx_cand = approx_fs
                    fmt_url = str(best_fmt.get("url") or "").strip()
                    if fmt_url.startswith(("http://", "https://")) and (h_cand > height or not best_stream_url):
                        best_stream_url = fmt_url
                        if isinstance(best_fmt.get("http_headers"), dict):
                            best_headers = dict(best_fmt["http_headers"])
                            if best_headers.get("Referer"):
                                best_referer = str(best_headers["Referer"])
                    # Ak ide o HLS alebo formát bez filesize, odhadneme veľkosť z tbr (kbps) × trvanie
                    if fs_cand <= 0 and fs_approx_cand <= 0 and duration > 0:
                        tbr_val = float(best_fmt.get("tbr") or best_fmt.get("vbr") or info.get("tbr") or 0.0)
                        if tbr_val > 20.0:
                            fs_approx_cand = int(tbr_val * 1000.0 / 8.0 * duration)

                if fs_cand <= 0 and fs_approx_cand <= 0 and best_stream_url and ".m3u8" not in best_stream_url.lower():
                    head_sz = await _head_media_size_bytes(best_stream_url, referer=best_referer, headers=best_headers)
                    if head_sz > 0:
                        fs_cand = head_sz

                if h_cand > height:
                    height = h_cand
                    width = w_cand or width
                    if fs_cand > 0:
                        file_size = fs_cand
                        file_size_approx = False
                    elif fs_approx_cand > 0:
                        file_size = fs_approx_cand
                        file_size_approx = True
                elif h_cand == height or height <= 0:
                    width = max(width, w_cand)
                    if fs_cand > file_size and (file_size <= 0 or file_size_approx):
                        file_size = fs_cand
                        file_size_approx = False
                    elif file_size <= 0 and fs_approx_cand > 0:
                        file_size = fs_approx_cand
                        file_size_approx = True
        except Exception as exc:
            logger.debug("[RELATED/probe] yt-dlp zlyhal pre %s: %s", clean_url[:70], exc)

    # Ak stránka (napr. Eporner tabuľka) explicitne uvádza vyššiu kvalitu, ktorá vyžaduje cookies/prehliadač,
    # vrátime aspoň skutočne dostupné maximum ak nemáme lepšiu informáciu
    if listed_max_height > height and height > 0:
        logger.info(
            "[RELATED/probe] %s má na stránke uvedenú vyššiu kvalitu %sp (stream pre hosťa %sp)",
            clean_url[:70],
            listed_max_height,
            height,
        )

    if duration <= 0 and height <= 0 and file_size <= 0:
        return {"url": clean_url, "probe_ok": False}

    return {
        "url": clean_url,
        "probe_ok": True,
        "duration": duration,
        "height": height,
        "width": width,
        "file_size": file_size,
        "file_size_approx": file_size_approx,
    }


def _dedupe_probe_targets(urls: Sequence[str], limit: int) -> List[str]:
    """Normalizuje a deduplikuje zoznam URL cieľov na probe."""
    out: List[str] = []
    seen: set[str] = set()
    for raw in urls or []:
        u = str(raw or "").strip()
        if not u.startswith(("http://", "https://")) or u in seen:
            continue
        seen.add(u)
        out.append(u)
        if len(out) >= limit:
            break
    return out


async def probe_related_candidates(urls: Sequence[str], limit: int = 80) -> List[Dict[str, Any]]:
    """On-demand dávková kontrola rozlíšenia, dĺžky a veľkosti súboru až po zobrazení v UI."""
    targets = _dedupe_probe_targets(urls, max(1, int(limit or 80)))
    if not targets:
        return []
    sem = asyncio.Semaphore(5)

    async def _run(u: str) -> Dict[str, Any]:
        async with sem:
            return await _probe_single_related_url(u)

    return await asyncio.gather(*[_run(u) for u in targets])


async def stream_probe_related_candidates(urls: Sequence[str], limit: int = 80) -> AsyncGenerator[Dict[str, Any], None]:
    """SSE stream dávkového overenia dĺžky a rozlíšenia s priebežným hlásením pre každý výsledok."""
    targets = _dedupe_probe_targets(urls, max(1, int(limit or 80)))
    total = len(targets)
    t0 = time.monotonic()
    yield {"type": "probe_start", "total": total}
    if not total:
        yield {"type": "probe_done", "done": 0, "total": 0, "ok_count": 0, "hd_count": 0, "elapsed_ms": 0}
        return

    sem = asyncio.Semaphore(5)

    async def _run_indexed(idx: int, u: str) -> Tuple[int, str, Dict[str, Any]]:
        async with sem:
            res = await _probe_single_related_url(u)
            return idx, u, res

    tasks = [asyncio.create_task(_run_indexed(i, u)) for i, u in enumerate(targets)]
    done = 0
    ok_count = 0
    hd_count = 0

    try:
        for fut in asyncio.as_completed(tasks):
            idx, u, res = await fut
            done += 1
            if res.get("probe_ok"):
                ok_count += 1
                if int(res.get("height") or 0) >= 720:
                    hd_count += 1
            yield {
                "type": "probe_item",
                "index": idx,
                "url": u,
                "done": done,
                "total": total,
                "ok_count": ok_count,
                "hd_count": hd_count,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
                "item": res,
            }
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()

    yield {
        "type": "probe_done",
        "done": done,
        "total": total,
        "ok_count": ok_count,
        "hd_count": hd_count,
        "elapsed_ms": int((time.monotonic() - t0) * 1000),
    }


async def resolve_related_stream_url(url: str) -> Dict[str, Any]:
    """Bezpečne získa priamu adresu video streamu pre externý výsledok Related Search."""
    clean_url = str(url or "").strip()
    ok, reason = await asyncio.to_thread(validate_public_http_url, clean_url)
    if not ok:
        return {"ok": False, "error": reason or "Nepovolená URL"}

    stream_url = ""
    is_hls = False
    referer = clean_url
    title = ""
    duration = 0
    height = 0

    # 1. Najskôr vyskúšame špecializované Nexus extraktory (PornTrex, WhoresHub, Eporner, Bunkr, CamWhores, ...)
    extractor_had_formats = False
    is_pornhub_extractor = False
    listed_max_height = 0
    try:
        from .extractors import ExtractorRegistry, init_registry, register_extended_extractors

        init_registry()
        register_extended_extractors()
        extractor = ExtractorRegistry.find_extractor(clean_url)
        if extractor is not None:
            ext_name = getattr(extractor, "name", "")
            is_pornhub_extractor = ext_name == "Pornhub"
            extract_timeout = 16.0 if ext_name in ("Pornhub", "Eporner") else 14.0
            info = await asyncio.wait_for(extractor.extract(clean_url), timeout=extract_timeout)
            if isinstance(info, dict):
                duration = _parse_duration_sec(info.get("duration"))
                height = _parse_quality_height(info.get("height") or info.get("quality"), width=_parse_int_safe(info.get("width")))
                listed_max_height = _parse_quality_height(info.get("listed_max_height"))
                cand = str(info.get("stream_url") or info.get("url") or "").strip()
                best_fmt = None
                for fmt_key in ("formats", "renditions", "sources"):
                    fmts = info.get(fmt_key)
                    if isinstance(fmts, list) and fmts:
                        extractor_had_formats = True
                        picked = _pick_best_quality_format(fmts, duration=duration, prefer_audio=True, require_url=True)
                        if picked is not None:
                            best_fmt = picked
                            break
                if best_fmt is not None:
                    fh = _parse_quality_height(
                        best_fmt.get("height") or best_fmt.get("quality") or best_fmt.get("label"),
                        width=_parse_int_safe(best_fmt.get("width")),
                    )
                    fu = str(best_fmt.get("url") or best_fmt.get("stream_url") or "").strip()
                    if fu and (fh >= height or not cand):
                        cand = fu
                        height = fh or height
                if cand.startswith(("http://", "https://")):
                    cand_ok, _ = await asyncio.to_thread(validate_public_http_url, cand)
                    if cand_ok:
                        stream_url = cand
                        is_hls = bool(info.get("is_hls")) or ".m3u8" in cand.lower()
                        referer = str(info.get("referer") or clean_url)
                        title = str(info.get("title") or "")
    except Exception as exc:
        logger.debug("[RELATED/resolve_stream] extractor zlyhal pre %s: %s", clean_url[:70], exc)

    # 2. Fallback alebo upgrade na vyššiu kvalitu cez yt-dlp (s cookies)
    needs_upgrade = not stream_url or (not is_pornhub_extractor and (listed_max_height > height or (height < 1080 and not extractor_had_formats)))
    if needs_upgrade:
        cookiefile = _find_cookiefile_for_url(clean_url)

        def _ytdlp_extract() -> Dict[str, Any]:
            import yt_dlp
            silent = type("_SL", (), {"debug": lambda *_: None, "warning": lambda *_: None, "error": lambda *_: None})()
            opts: Dict[str, Any] = {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
                "socket_timeout": 10,
                "format": "best[vcodec!=none][acodec!=none]/best",
                "logger": silent,
            }
            if cookiefile:
                opts["cookiefile"] = cookiefile
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(clean_url, download=False) or {}

        try:
            info = await asyncio.wait_for(asyncio.to_thread(_ytdlp_extract), timeout=15.0)
            formats = info.get("formats") if isinstance(info.get("formats"), list) else []
            best_fmt = _pick_best_quality_format(
                formats,
                duration=duration or _parse_duration_sec(info.get("duration")),
                prefer_audio=True,
                require_url=True,
            )
            cand = str((best_fmt or {}).get("url") or info.get("url") or "").strip()
            cand_h = _parse_quality_height(
                (best_fmt or {}).get("height")
                or (best_fmt or {}).get("quality")
                or (best_fmt or {}).get("format_note")
                or info.get("height"),
                width=_parse_int_safe((best_fmt or {}).get("width") or info.get("width")),
            )
            if cand.startswith(("http://", "https://")) and (not stream_url or cand_h > height):
                cand_ok, _ = await asyncio.to_thread(validate_public_http_url, cand)
                if cand_ok:
                    stream_url = cand
                    proto = str((best_fmt or {}).get("protocol") or info.get("protocol") or "").lower()
                    is_hls = ".m3u8" in cand.lower() or "m3u8" in proto
                    hdrs = (best_fmt or {}).get("http_headers") or info.get("http_headers") or {}
                    referer = str(hdrs.get("Referer") or clean_url)
                    title = title or str(info.get("title") or "")
                    duration = duration or _parse_duration_sec(info.get("duration"))
                    height = max(height, cand_h)
        except Exception as exc:
            logger.debug("[RELATED/resolve_stream] yt-dlp zlyhal pre %s: %s", clean_url[:70], exc)

    if not stream_url:
        return {"ok": False, "error": "Nepodarilo sa získať priamy stream videa"}

    return {
        "ok": True,
        "stream_url": stream_url,
        "is_hls": is_hls,
        "referer": referer,
        "title": title,
        "duration": duration,
        "height": height,
    }


async def identify_video_on_namethatporn(
    video_id: int,
    auto_save: bool = False,
    db: Optional[Session] = None,
) -> Dict[str, Any]:
    """Získa náhľad videa (ak chýba alebo je nečitateľný, vygeneruje ho zo streamu/súboru),
    vyhľadá zhodu na NameThatPorn.com a vráti zistené mená tvorcov + ukážkové vlákna na potvrdenie."""
    import os
    from pathlib import Path
    from .related_media import _ffmpeg_extract_frames_sync

    video = db.query(Video).filter(Video.id == video_id).first() if db else None
    if not video:
        return {"ok": False, "found": False, "error": "Video sa nenašlo", "creators": [], "matches": []}

    referer = str(getattr(video, "thumbnail_referer", "") or getattr(video, "source_url", "") or "")
    thumb_bytes = await resolve_video_thumb_bytes(
        str(video.thumbnail_path or ""),
        referer=referer,
    )
    thumbnail_generated = False

    # Ak náhľad chýba alebo sa nedá načítať, pokúsime sa ho vygenerovať z videa
    if not thumb_bytes:
        frames = await extract_search_frames(video, count=1)
        if frames:
            thumb_bytes = frames[0]
        if not thumb_bytes:
            # Skúsime lokálny súbor priamo cez ffmpeg (ak je video.url lokálna cesta)
            local_cand = str(getattr(video, "url", "") or "").strip()
            if local_cand and not local_cand.startswith(("http://", "https://", "/api/")) and os.path.isfile(local_cand):
                dur = max(0.0, float(getattr(video, "duration", 0) or 0))
                pos = round(dur * 0.25, 2) if dur > 4 else 2.0
                local_frames = await asyncio.to_thread(_ffmpeg_extract_frames_sync, local_cand, [pos], "", 8)
                if local_frames:
                    thumb_bytes = local_frames[0]

        if thumb_bytes and db is not None:
            try:
                thumb_dir = Path("app") / "static" / "thumbnails"
                thumb_dir.mkdir(parents=True, exist_ok=True)
                out_file = thumb_dir / f"thumb_{int(video.id)}.jpg"
                out_file.write_bytes(thumb_bytes)
                rel_path = f"/static/thumbnails/thumb_{int(video.id)}.jpg"
                video.thumbnail_path = rel_path
                db.commit()
                thumbnail_generated = True
            except Exception as exc:
                db.rollback()
                logger.debug("[NTP_GALLERY] Uloženie vygenerovaného náhľadu zlyhalo: %s", exc)

    if not thumb_bytes:
        return {
            "ok": False,
            "found": False,
            "video_id": int(video.id),
            "thumbnail_path": str(video.thumbnail_path or ""),
            "thumbnail_generated": False,
            "error": "Video nemá náhľad a nepodarilo sa ho vygenerovať zo zdroja",
            "creators": [],
            "matches": [],
        }

    orig_url = str(getattr(video, "original_thumbnail_url", "") or "").strip()
    ntp_hits = await namethatporn_cbir_search(
        [thumb_bytes],
        image_url=orig_url if orig_url.startswith(("http://", "https://")) else "",
        limit=18,
    )

    creators = extract_creators_from_visual_hits(
        ntp_hits,
        raw_title="",
        limit=5,
    )

    # Zoskupíme unikátne NameThatPorn vlákna pre prehľadný náhľad v potvrdzovacom modale
    by_post: Dict[str, Dict[str, Any]] = {}
    for h in ntp_hits:
        post_url = str(h.get("ntp_post_url") or (h.get("url") if "namethatporn.com/post/" in str(h.get("url") or "") else "")).strip()
        if not post_url:
            continue
        entry = by_post.get(post_url)
        if not entry:
            entry = {
                "post_url": post_url,
                "thumbnail": str(h.get("thumbnail") or ""),
                "visual_score": int(h.get("visual_score") or 0),
                "solved": bool(h.get("ntp_solved")),
                "models": list(h.get("ntp_models") or []),
                "scene_title": str(h.get("ntp_scene_title") or "").strip(),
                "video_links": [],
            }
            by_post[post_url] = entry
        u = str(h.get("url") or "").strip()
        if u and "namethatporn.com/post/" not in u and u not in entry["video_links"]:
            entry["video_links"].append(u)
        if not entry["thumbnail"] and h.get("thumbnail"):
            entry["thumbnail"] = str(h["thumbnail"])
        entry["visual_score"] = max(entry["visual_score"], int(h.get("visual_score") or 0))

    matches = sorted(
        by_post.values(),
        key=lambda m: (1 if m["solved"] else 0, m["visual_score"], len(m["models"])),
        reverse=True,
    )[:4]

    scene_title = next((m["scene_title"] for m in matches if m.get("scene_title")), "")
    saved_models = str(getattr(video, "models", "") or "")

    if auto_save and creators and db is not None:
        existing_models = split_csv(saved_models)
        existing_low = {m.lower() for m in existing_models}
        added_any = False
        for c in creators[:2]:
            cname = str(c.get("name") or "").strip()
            if cname and int(c.get("confidence") or 0) >= 85 and cname.lower() not in existing_low:
                existing_models.append(cname)
                existing_low.add(cname.lower())
                added_any = True
        if added_any:
            video.models = ", ".join(existing_models)
            try:
                db.commit()
                saved_models = str(video.models or "")
            except Exception:
                db.rollback()

    return {
        "ok": True,
        "found": bool(creators or matches),
        "video_id": int(video.id),
        "thumbnail_path": str(video.thumbnail_path or ""),
        "thumbnail_generated": thumbnail_generated,
        "creators": creators,
        "scene_title": scene_title,
        "matches": matches,
        "saved_models": saved_models,
    }
