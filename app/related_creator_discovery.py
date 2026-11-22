"""Identifikácia tvorcu / modelky z názvu videa, vodoznaku v náhľade (OCR), lokálnej DB a vizuálnych CBIR zhôd."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlparse

import httpx

from .ai_tagger_batch import GEMINI_VISION_MODELS, compress_thumbnail_bytes
from .autotagger import auto_tag_video
from .related_media import classify_cbir_url
from .related_query_planner import (
    _NON_NAME_PHRASES,
    _NON_NAME_WORDS,
    _QUERY_NOISE_WORDS,
    _TITLE_STOPWORDS,
    clean_title_for_search,
    extract_performer_candidates,
    get_performer_aliases,
    get_performer_lexicon,
    is_junk_content_tag,
    is_junk_or_hash_token,
    register_discovered_performer,
    resolve_known_performer,
    sanitize_video_tags_list,
    split_camel_case_words,
)

logger = logging.getLogger(__name__)

# Slová, názvy platforiem, miest a bežné anglické slová z titulkov, ktoré NIE SÚ menami tvorcov
_PLATFORM_AND_COMMON_NOISE_WORDS: Set[str] = {
    "only", "fans", "onlyfans", "onlytarts", "fansly", "patreon", "many", "vids", "manyvids",
    "cam", "whores", "camwhores", "lamwhores", "chaturbate", "myfreecams", "stripchat",
    "bongacams", "livejasmin", "pornhub", "xhamster", "xvideos", "eporner", "spankbang",
    "porntrex", "whoreshub", "noodlemagazine", "scrolller", "redgifs", "reddit",
    "bunkr", "erome", "fapello", "simpcity", "coomer", "kemono", "leak", "leaks",
    "leaked", "vip", "uhd", "hd", "fhd", "webcam", "show", "shows", "live", "free",
    "full", "version", "mirror", "edition", "original", "upload", "post", "page",
    "print", "leopard", "billiards", "outfit", "lingerie", "stockings", "heels",
    "request", "part", "promo", "trailer", "preview", "teaser", "clip", "clips",
    "porn", "porno", "tube", "sex", "xxx", "nude", "nudes", "selfie", "photo", "photos",
    "foto", "zdjecie", "gambar", "lucah", "naakt", "gelekt", "video", "videos",
    "movie", "movies", "files", "file", "forum", "forums", "threads", "thread",
    "your", "help", "with", "sorority", "initiation", "makes", "make", "imitation",
    "las", "vegas", "new", "york", "los", "angeles", "miami", "dubai", "london",
    "hotel", "marriott", "luxury", "business", "bay", "center", "student", "experience",
    "talent", "become", "career", "rockefeller", "famous", "cultural", "landmark",
    "backstage", "professional", "profile", "twitter", "instagram", "account", "accounts",
    "sotwe", "female", "escorts", "escort", "pandesia", "world", "faphouse", "studios",
    "thicc", "finder", "search", "engine", "country", "united", "states", "best", "top",
    "creator", "creators", "rating", "poll", "stats", "data", "trials", "selects",
    "influencer", "erotic", "snapchat", "exclusive", "tagged", "fucked", "watch", "online",
    "come", "say", "total", "swinger", "wolf", "tubewolf", "passionate", "lovemaking",
    "moans", "during", "wife", "curves", "corset", "untitled", "generated", "fivestarleaks",
    "maren", "morris", "country", "music", "song", "lyrics", "dailymotion", "curzon",
    "keyboard", "underwear", "temporary", "tattoos", "light", "hearted", "art", "erotica",
    "photography", "nudity", "blond", "things", "slutty",
    "favourite", "favorite", "favourites", "favorites", "gifs", "gif", "lucky",
    "goth", "babes", "hungry", "toy", "used", "double", "collaboration", "collab",
    "between", "blowjobs", "actress", "actor", "answered", "solved", "daily",
    "porntok", "xgroovy", "fucktoyfactory", "namethatporn",
    "vid", "vids", "link", "links", "reference", "references", "source",
}

_ALL_NON_CREATOR_WORDS: Set[str] = (
    _TITLE_STOPWORDS | _QUERY_NOISE_WORDS | _NON_NAME_WORDS | _PLATFORM_AND_COMMON_NOISE_WORDS
)

# Domény SEO katalógov a ne-video stránok, z ktorých nikdy nechceme ťahať falošných "tvorcov"
_CREATOR_NOISE_HOSTS = re.compile(
    r"(^|\.)(onlyfanssigns\.com|onlyselects\.com|onlyfanslifestyle\.com|photoloading\.com|"
    r"sotwe\.com|backstage\.com|marriott\.com|rockefellercenter\.com|youtube\.com|youtu\.be|"
    r"facebook\.com|instagram\.com|tiktok\.com|wikipedia\.org|linkedin\.com|pinterest\.com|"
    r"amazon\.com|ebay\.com|umcs\.org\.ua|pornxxx24\.com)",
    re.I,
)


def _norm_creator_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _norm_title_dedupe_key(title: str) -> str:
    """Vytvorí podpis titulku pre deduplikáciu syndikovaných klonov (napr. rovnaký titulok na 3 tube weboch)."""
    cleaned = re.sub(r"https?://\S+", " ", (title or "").lower())
    # Odstránenie koncového názvu webu za pomlčkou ("... - CamWhores", "... - RedPorn", "... - EPORNER")
    cleaned = re.sub(r"\s*[-|•·]\s*[a-z0-9.\s]{2,25}$", "", cleaned)
    words = [
        w for w in re.findall(r"[a-z0-9]{3,}", cleaned)
        if w not in {"porn", "porno", "video", "videos", "free", "watch", "online", "foto", "photo", "pic", "hd"}
    ]
    return " ".join(words[:7])


def _is_valid_creator_name(name: str) -> bool:
    clean = re.sub(r"\s+", " ", (name or "").strip(" -_|·•,:;[]()@#"))
    if len(clean) < 4 or len(clean) > 38 or is_junk_or_hash_token(clean) or is_junk_content_tag(clean):
        return False
    low = clean.lower()
    if any(ch in low for ch in ("http:", "https:", "www.", "/", "\\", ".com", ".net", ".org", ".cc", ".tv", ".xxx")):
        return False
    if low in _ALL_NON_CREATOR_WORDS or low in _NON_NAME_PHRASES:
        return False
    # Ak ide o známeho performera z nášho lexikónu, je automaticky platný
    if resolve_known_performer(clean):
        return True
    tokens = [re.sub(r"[^a-z0-9_]", "", w.lower()) for w in clean.split() if w]
    if not tokens or len(tokens) > 3:
        return False
    if all(t in _ALL_NON_CREATOR_WORDS or len(t) < 2 for t in tokens):
        return False
    if len(tokens) >= 2 and any(t in _ALL_NON_CREATOR_WORDS or len(t) < 3 for t in tokens):
        return False
    return True


async def extract_watermark_text_via_vision(
    thumb_bytes: bytes,
    api_key: Optional[str] = None,
) -> str:
    """Rýchle OCR čítanie textu/vodoznaku priamo z náhľadu videa cez Google Vision TEXT_DETECTION."""
    key = (api_key or os.getenv("GOOGLE_VISION_API_KEY") or "").strip()
    if not key or not thumb_bytes:
        return ""
    try:
        fast_jpg = compress_thumbnail_bytes(thumb_bytes, max_dim=960, quality=82)
        body = {
            "requests": [{
                "image": {"content": base64.b64encode(fast_jpg).decode("ascii")},
                "features": [{"type": "TEXT_DETECTION", "maxResults": 5}],
            }]
        }
        async with httpx.AsyncClient(timeout=6.5) as cl:
            resp = await cl.post(
                "https://vision.googleapis.com/v1/images:annotate",
                headers={"X-goog-api-key": key},
                json=body,
            )
        if resp.status_code != 200:
            return ""
        data = resp.json() or {}
        resp0 = (data.get("responses") or [{}])[0]
        anns = resp0.get("textAnnotations") or []
        if not anns:
            return ""
        return str((anns[0] or {}).get("description") or "").strip()
    except Exception as exc:
        logger.debug("[CREATOR_OCR] Vision TEXT_DETECTION zlyhalo: %s", exc)
        return ""


def extract_creators_from_ocr_text(ocr_text: str, raw_title: str = "") -> List[Dict[str, Any]]:
    """Vytiahne meno tvorcu a @handle z OCR textu vodoznaku v náhľade (napr. 'SAMI HAYES @SSAMIBABY', 'OnlyFans.com/SSAMIHAYES')."""
    if not ocr_text or not ocr_text.strip():
        return []

    lines = [re.sub(r"\s+", " ", ln.strip()) for ln in ocr_text.splitlines() if ln.strip()]
    joined = " | ".join(lines)

    handles: List[str] = []
    stage_names: List[str] = []

    # 1. OnlyFans / Fansly URL vodoznaky (vrátane chýbajúceho lomítka z OCR: "OnlyFans.comSSAMIHAYES")
    for m in re.finditer(r"(?:onlyfans|fansly)\s*\.\s*com\s*/?\s*@?([A-Za-z0-9_.-]{4,28})", joined, re.I):
        h = m.group(1).strip("._-").lower()
        if h and h not in _ALL_NON_CREATOR_WORDS and h not in handles:
            handles.append(h)

    # 2. Explicitné @handle vodoznaky (napr. "@SSAMIBABY")
    for m in re.finditer(r"@([A-Za-z0-9_.]{4,28})\b", joined):
        h = m.group(1).strip("._-").lower()
        if h and h not in _ALL_NON_CREATOR_WORDS and h not in handles:
            handles.append(h)

    # 3. 2-slovné meno priamo v riadku vodoznaku (napr. "SAMI HAYES")
    for ln in lines:
        cleaned_ln = re.sub(r"(?:onlyfans|fansly)\.com\S*", " ", ln, flags=re.I)
        cleaned_ln = re.sub(r"@\S+", " ", cleaned_ln).strip()
        words = [w for w in re.findall(r"[A-Za-z]{3,15}", cleaned_ln)]
        if len(words) == 2:
            cand = f"{words[0].title()} {words[1].title()}"
            if _is_valid_creator_name(cand) and cand not in stage_names:
                stage_names.append(cand)
        else:
            for i in range(len(words) - 1):
                cand = f"{words[i].title()} {words[i + 1].title()}"
                if resolve_known_performer(cand) and cand not in stage_names:
                    stage_names.append(resolve_known_performer(cand) or cand)

    results: List[Dict[str, Any]] = []
    seen_keys: Set[str] = set()

    # Ak máme aj 2-slovné meno (napr. "Sami Hayes") aj handle (napr. "ssamibaby" / "ssamihayes"), spojíme ich!
    for sname in stage_names:
        canon = resolve_known_performer(sname) or sname
        key = _norm_creator_key(canon)
        if not key or key in seen_keys:
            continue
        seen_keys.add(key)
        matched_alias = handles[0] if handles else (get_performer_aliases(canon)[0] if get_performer_aliases(canon) else "")
        results.append({
            "name": canon,
            "alias": matched_alias,
            "confidence": 99 if handles else 96,
            "mentions": 2 if handles else 1,
            "sources": ["watermark_ocr"],
            "hosts_count": 1,
            "signals": ["ocr_watermark"],
            "is_ai": False,
            "score": 9.5,
        })

    for h in handles:
        canon = resolve_known_performer(h)
        target_name = canon or h
        key = _norm_creator_key(target_name)
        if not key or key in seen_keys:
            continue
        # Ak sa handle zhoduje s už pridaným stage_name (napr. "ssamihayes" vs "Sami Hayes"), preskočíme duplikát
        if any(key in _norm_creator_key(r["name"]) or _norm_creator_key(r["name"]) in key for r in results):
            continue
        seen_keys.add(key)
        results.append({
            "name": target_name,
            "alias": h if canon else "",
            "confidence": 97 if canon else 90,
            "mentions": 1,
            "sources": ["watermark_ocr"],
            "hosts_count": 1,
            "signals": ["ocr_watermark"],
            "is_ai": False,
            "score": 8.0 if canon else 5.5,
        })

    return results


def _strip_social_repost_noise(title: str) -> str:
    """Odstráni repostové a zoznamové obálky z X/Twitter, Redditu a xGroovy pred hľadaním mien."""
    t = re.sub(r"https?://\S+", " ", title or "")
    # X / Twitter: 'Daily HuTao on X: "RT @meowcalsheesh: ... " / X'
    t = re.sub(r"^.{1,60}?\bon\s+(?:X|Twitter)\s*:\s*\"?", " ", t, flags=re.I)
    t = re.sub(r"\b(?:RT|via|by)\s+@[A-Za-z0-9_.]+\s*:?", " ", t, flags=re.I)
    t = re.sub(r"\"?\s*/\s*(?:X|Twitter)\s*$", " ", t, flags=re.I)
    # xGroovy user gif collections: "Pxpxpx1000's Favourite GIFs"
    t = re.sub(r"\b[A-Za-z0-9_]+'s\s+Favou?rite\s+(?:GIFs?|Videos?|Porn|Clips?)\b", " ", t, flags=re.I)
    # Reddit subreddit suffix: ": r/FuckToyFactory"
    t = re.sub(r"(?:^|\s|:)\s*r/[A-Za-z0-9_]+\b", " ", t, flags=re.I)
    # NameThatPorn generic question titles
    t = re.sub(r"\b(?:Name\s+of\s+the\s+video\s+and\s+the\s+Actress|Name\s+and\s+video|Who\s+is\s+this|Whats?\s+her\s+name)\b\??", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip()


def _extract_names_from_single_hit(hit: Dict[str, Any]) -> List[Tuple[str, float, str]]:
    """Vráti zoznam (kandidát, váha, signál) z jedného overeného vizuálneho výsledku."""
    url = str(hit.get("url") or "").strip()
    title = str(hit.get("title") or "").strip()
    source = str(hit.get("source") or "").lower()

    found: List[Tuple[str, float, str]] = []

    # 0. Priamo vyriešení performeri z NameThatPorn (ANSWERED / Correct Answer)
    ntp_models = hit.get("ntp_models") or []
    ntp_aliases = hit.get("ntp_aliases") or {}
    if isinstance(ntp_models, (list, tuple)) and ntp_models:
        is_solved = bool(hit.get("ntp_solved", True))
        vis_ntp = int(hit.get("visual_score") or 85)
        ntp_w = (9.5 if is_solved else 6.8) * (1.2 if vis_ntp >= 75 else 1.0)
        for idx_m, raw_m in enumerate(ntp_models[:4]):
            m_clean = re.sub(r"\s+", " ", str(raw_m or "").strip())
            if _is_valid_creator_name(m_clean):
                alias_str = str(ntp_aliases.get(m_clean) or "") if isinstance(ntp_aliases, dict) else ""
                canon = register_discovered_performer(m_clean, alias=alias_str) or resolve_known_performer(m_clean) or m_clean
                # Hlavný performer dostane plnú váhu, vedľajší mierne nižšiu
                found.append((canon, ntp_w * (1.0 if idx_m == 0 else 0.88), "ntp_solved" if is_solved else "url_entity"))

    if url.startswith("http"):
        host = (urlparse(url).hostname or "").lower().lstrip("www.")
        if _CREATOR_NOISE_HOSTS.search(host):
            return found
        cls_info = classify_cbir_url(url, title=title, source=source)
        if cls_info.get("blocked"):
            return found
        # Neoverené všeobecné weby (hotely, univerzity, blogy) ignorujeme, ak nemajú vysokú vizuálnu zhodu
        if cls_info.get("tier") == "unverified_web" and int(hit.get("visual_score") or 0) < 70:
            return found

    vis = int(hit.get("visual_score") or 0)
    # Ak už bol výsledok vizuálne ohodnotený GPU SigLIP2 a má nízku zhodu (<52%), nejde o tú istú osobu/scénu!
    if 0 < vis < 52 and not hit.get("exact_frame") and hit.get("match_type") != "exact":
        return found

    src_boost = 1.35 if source in {"serpapi", "google_vision", "vision", "namethatporn"} else 1.0
    vis_boost = 1.65 if (hit.get("exact_frame") or vis >= 80) else (1.35 if vis >= 62 else (1.05 if vis >= 52 else 0.85))

    lex = get_performer_lexicon()

    # 1. OCR text pripojený k výsledku (napr. z Google Vision)
    ocr_txt = str(hit.get("ocr_text") or "").strip()
    if ocr_txt:
        for ocr_c in extract_creators_from_ocr_text(ocr_txt):
            found.append((ocr_c["name"], 4.5, "ocr_watermark"))

    # 2. Štruktúrovaná URL cesta (/models/bracey-bella, /pornstar/alicia-amira, ...)
    if url.startswith("http"):
        try:
            path_parts = [p for p in urlparse(url).path.split("/") if p]
            for idx, seg in enumerate(path_parts[:-1]):
                if seg.lower() in {"pornstar", "pornstars", "model", "models", "performer", "creator", "u", "profile", "profiles"}:
                    slug = re.sub(r"\.html?$", "", path_parts[idx + 1], flags=re.I)
                    slug = re.sub(r"[-_]+", " ", slug).strip()
                    if _is_valid_creator_name(slug):
                        canon = resolve_known_performer(slug) or (slug.title() if slug.islower() else slug)
                        found.append((canon, 2.4 * src_boost * vis_boost, "url_entity"))
        except Exception:
            pass

    if not title:
        return found

    cleaned_title = _strip_social_repost_noise(title)
    # Odstránenie koncového názvu stránky za pomlčkou ("... - CamWhores", "... - EPORNER")
    cleaned_title = re.sub(
        r"\s*[-|•·›]\s*(?:CamWhores|EPORNER|SpankBang|Pornhub|xHamster|XVideos|RedPorn|AnyPorn|Anyxxx|Faphouse|Fapello|Pornhex|Porntrex|PornTok|xGroovy|NameThatPorn(?:\.com)?|HDXXX\s*TOP)\b.*$",
        "",
        cleaned_title,
        flags=re.I,
    )
    if not cleaned_title:
        return found

    # 3. Známi performeri z autotaggera a databázového lexikónu
    auto = auto_tag_video(cleaned_title)
    for m in auto.get("models") or []:
        if _is_valid_creator_name(m):
            canon = resolve_known_performer(m) or m
            found.append((canon, 2.5 * src_boost * vis_boost, "known_model"))

    norm_low = re.sub(r"[^a-z0-9]+", " ", cleaned_title.lower()).strip()
    padded_low = f" {norm_low} "
    for phrase_low, canon in lex["by_phrase"].items():
        if len(phrase_low) >= 5 and f" {phrase_low} " in padded_low:
            found.append((canon, 2.4 * src_boost * vis_boost, "known_model"))

    for tok in re.findall(r"[a-zA-Z0-9_]{5,28}", cleaned_title):
        comp = _norm_creator_key(tok)
        if comp in lex["by_compact"]:
            found.append((lex["by_compact"][comp], 2.2 * src_boost * vis_boost, "known_model"))

    # 4. Posuvné okno (sliding window) po 2 Capitalized slovách (napr. "Leaked Bracey Bella" -> "Bracey Bella")
    #    Odstránime už rozpoznaných známych performerov z textu, aby zo "Meg Vicious Emma Fiore" nevzniklo krížové "Vicious Emma"
    sliding_text = split_camel_case_words(cleaned_title)
    for existing_name, _, _ in list(found):
        if " " in existing_name:
            sliding_text = re.sub(rf"\b{re.escape(existing_name)}\b", " | ", sliding_text, flags=re.I)

    for seg_chunk in sliding_text.split("|"):
        cap_words = re.findall(r"[A-Za-z]{2,16}", seg_chunk)
        i = 0
        while i < len(cap_words) - 1:
            w1, w2 = cap_words[i], cap_words[i + 1]
            if w1[0].isupper() and w2[0].isupper():
                cand = f"{w1.title()} {w2.title()}"
                if _is_valid_creator_name(cand):
                    canon = resolve_known_performer(cand) or cand
                    is_structural = bool(
                        re.search(rf"(?:^|\b(?:leaked|onlyfans|free)\s+)\b{re.escape(w1)}\s+{re.escape(w2)}\b", cleaned_title, re.I)
                        or re.search(rf"\b{re.escape(w1)}\s+{re.escape(w2)}\s*[-|–—:]", cleaned_title, re.I)
                    )
                    w_val = (1.85 if is_structural else 1.25) * src_boost * vis_boost
                    found.append((canon, w_val, "title_name"))
                    i += 2
                    continue
            i += 1

    # 5. Explicitné aliasy ("aka nasty_bimbo", "@handle") — po odfiltrovaní RT @reposter šumu
    for pat in (
        r"\baka\s+([A-Za-z0-9_.]{4,28})\b",
        r"(?:^|\s)@([A-Za-z0-9_.]{4,28})\b",
    ):
        for m in re.finditer(pat, cleaned_title, re.I):
            handle = m.group(1).strip("._-")
            if len(handle) >= 4 and handle.lower() not in _ALL_NON_CREATOR_WORDS and not is_junk_or_hash_token(handle):
                canon = resolve_known_performer(handle)
                if canon:
                    found.append((canon, 2.2 * src_boost * vis_boost, "known_model"))
                else:
                    found.append((handle, 1.35 * src_boost * vis_boost, "alias"))

    return found


def extract_creators_from_visual_hits(
    hits: Sequence[Dict[str, Any]],
    known_performers: Sequence[str] = (),
    raw_title: str = "",
    ocr_texts: Sequence[str] = (),
    min_score: float = 1.6,
    limit: int = 5,
) -> List[Dict[str, Any]]:
    """Spočíta konsenzus tvorcu/performera z metadát videa, OCR vodoznaku, NameThatPorn a vizuálnych CBIR výsledkov."""
    buckets: Dict[str, Dict[str, Any]] = {}

    def _upsert_bucket(
        cand_name: str,
        weight: float,
        signal: str,
        src: str,
        host: str = "",
        alias: str = "",
        sample_title: str = "",
    ) -> None:
        canon = resolve_known_performer(cand_name) or cand_name
        key = _norm_creator_key(canon)
        if not key or len(key) < 4:
            return
        entry = buckets.get(key)
        if not entry:
            aliases = get_performer_aliases(canon)
            entry = {
                "name": canon,
                "alias": alias or (aliases[0] if aliases else ""),
                "score": 0.0,
                "mentions": 0,
                "sources": set(),
                "hosts": set(),
                "signals": set(),
                "sample_titles": [],
                "confirmed_seed": False,
            }
            buckets[key] = entry
        if " " in canon and " " not in entry["name"]:
            entry["name"] = canon
        if alias and not entry["alias"]:
            entry["alias"] = alias
        entry["score"] += weight
        entry["mentions"] += 1
        entry["sources"].add(src)
        if host:
            entry["hosts"].add(host.lower().lstrip("www."))
        entry["signals"].add(signal)
        if signal in {"video_title", "known_model_seed", "ocr_watermark", "ntp_solved"}:
            entry["confirmed_seed"] = True
        if sample_title and sample_title not in entry["sample_titles"] and len(entry["sample_titles"]) < 3:
            entry["sample_titles"].append(sample_title[:80])

    # 1. Primárne potvrdenie z názvu a metadát samotného videa (napr. "Sami hayes dd" -> "Sami Hayes")
    seed_performers: List[str] = list(known_performers or [])
    if raw_title:
        clean_t = clean_title_for_search(raw_title)
        for p in extract_performer_candidates(clean_t, explicit_models=seed_performers, raw_title=raw_title):
            if p not in seed_performers:
                seed_performers.append(p)

    for perf in seed_performers:
        if _is_valid_creator_name(perf):
            _upsert_bucket(perf, weight=6.5, signal="video_title", src="title", sample_title=raw_title)

    # 2. Potvrdenie z OCR vodoznaku priamo v náhľade (napr. "SAMI HAYES @SSAMIBABY", "OnlyFans.com/SSAMIHAYES")
    all_ocr: List[str] = [t for t in (ocr_texts or []) if t]
    for h in hits or ():
        if h.get("ocr_text") and str(h["ocr_text"]) not in all_ocr:
            all_ocr.append(str(h["ocr_text"]))
    for ocr_str in all_ocr:
        for ocr_c in extract_creators_from_ocr_text(ocr_str, raw_title=raw_title):
            _upsert_bucket(
                ocr_c["name"],
                weight=float(ocr_c.get("score") or 8.5),
                signal="ocr_watermark",
                src="watermark",
                alias=str(ocr_c.get("alias") or ""),
            )

    has_confirmed_seed = any(b["confirmed_seed"] for b in buckets.values())
    seen_title_keys_for_cand: Dict[str, Set[str]] = {}

    # 3. Extrakcia kandidátov z vizuálnych CBIR výsledkov (vrátane NameThatPorn)
    for hit in hits or []:
        url = str(hit.get("url") or "").strip()
        host = (urlparse(url).hostname or str(hit.get("domain") or "")).lower().lstrip("www.")
        src = str(hit.get("source") or "web").lower()
        vis = int(hit.get("visual_score") or 0)
        is_strong_vis = bool(hit.get("exact_frame")) or hit.get("match_type") == "exact" or vis >= 60 or bool(hit.get("ntp_solved"))
        ntp_aliases_map = hit.get("ntp_aliases") if isinstance(hit.get("ntp_aliases"), dict) else {}

        raw_extractions = _extract_names_from_single_hit(hit)
        if not raw_extractions:
            continue

        # Zlúčime rovnakého kandidáta v rámci jedného hitu tak, že vezmeme MAX váhu + bonus za viac signálov
        per_hit: Dict[str, Tuple[str, float, Set[str]]] = {}
        for cand_name, weight, signal in raw_extractions:
            canon = resolve_known_performer(cand_name) or cand_name
            key = _norm_creator_key(canon)
            if not key or len(key) < 4:
                continue
            prev = per_hit.get(key)
            if not prev:
                per_hit[key] = (canon, weight, {signal})
            else:
                best_name = canon if (" " in canon and " " not in prev[0]) else prev[0]
                best_w = max(prev[1], weight) + 0.35
                per_hit[key] = (best_name, best_w, prev[2] | {signal})

        title_str = str(hit.get("title") or "").strip()
        t_dedupe_key = _norm_title_dedupe_key(title_str)

        for key, (canon, weight, sig_set) in per_hit.items():
            is_ntp_solved = "ntp_solved" in sig_set
            is_existing_seed = key in buckets and buckets[key]["confirmed_seed"]
            if has_confirmed_seed and not is_existing_seed and not is_strong_vis and not is_ntp_solved:
                continue

            # Deduplikácia syndikovaných klonov (rovnaký titulok na 3 rôznych doménach = 1 zmienka, nie 3!)
            seen_t = seen_title_keys_for_cand.setdefault(key, set())
            if t_dedupe_key and len(t_dedupe_key) >= 10:
                if t_dedupe_key in seen_t and not (sig_set & {"url_entity", "ntp_solved"}) and not is_existing_seed:
                    continue
                seen_t.add(t_dedupe_key)

            primary_sig = (
                "ntp_solved" if "ntp_solved" in sig_set
                else ("url_entity" if "url_entity" in sig_set else ("known_model" if "known_model" in sig_set else sorted(sig_set)[0]))
            )
            hit_alias = str(ntp_aliases_map.get(canon) or "")
            _upsert_bucket(
                canon,
                weight=weight,
                signal=primary_sig,
                src=src,
                host=host,
                alias=hit_alias,
                sample_title=title_str,
            )
            buckets[key]["signals"].update(sig_set)
            if is_ntp_solved:
                has_confirmed_seed = True

    # 4. Prepojenie jednoslovných tokenov/handle v titulkoch s 2-slovnými kandidátmi (napr. "braceybella" -> "Bracey Bella")
    multi_word_keys = {k: b for k, b in buckets.items() if " " in b["name"] and len(k) >= 6}
    if multi_word_keys:
        for hit in hits or []:
            t_low = re.sub(r"[^a-z0-9]+", " ", str(hit.get("title") or "").lower())
            for compact_tok in t_low.split():
                if compact_tok in multi_word_keys:
                    b = multi_word_keys[compact_tok]
                    host = (urlparse(str(hit.get("url") or "")).hostname or "").lower().lstrip("www.")
                    if host and host not in b["hosts"]:
                        b["hosts"].add(host)
                        b["mentions"] += 1
                        b["score"] += 1.4

    if not buckets:
        return []

    ranked: List[Dict[str, Any]] = []
    for key, b in buckets.items():
        total_score = b["score"] + max(0, len(b["sources"]) - 1) * 1.5 + max(0, len(b["hosts"]) - 1) * 0.7
        if not b["confirmed_seed"]:
            # Neoverený @handle ('alias') sám o sebe nestačí z 1 tweetu — vyžadujeme buď >=2 nezávislé zmienky,
            # alebo skutočne overený signál (url_entity / known_model / ocr_watermark / ntp_solved)
            has_strong_signal = bool(b["signals"] & {"url_entity", "known_model", "ocr_watermark", "ntp_solved"})
            if b["mentions"] < 2 and not has_strong_signal:
                continue
            if total_score < min_score:
                continue

        if b["confirmed_seed"]:
            conf = int(max(92, min(99, round(88 + min(11.0, total_score * 1.2)))))
        else:
            conf = int(max(52, min(96, round(44 + total_score * 8.5))))

        ranked.append({
            "name": b["name"],
            "alias": b.get("alias") or "",
            "confidence": conf,
            "mentions": b["mentions"],
            "sources": sorted(b["sources"]),
            "hosts_count": max(1, len(b["hosts"])),
            "signals": sorted(b["signals"]),
            "is_ai": False,
            "score": round(total_score, 2),
        })

    ranked.sort(
        key=lambda x: (
            1 if any(s in x["signals"] for s in ("ntp_solved", "ocr_watermark", "video_title")) else 0,
            1 if "ntp_solved" in x["signals"] else 0,
            len(x["sources"]),
            x["mentions"],
            1 if (" " in x["name"] and "_" not in x["name"]) else 0,
            x["score"],
            x["confidence"],
        ),
        reverse=True,
    )
    return ranked[:limit]


def _spatial_color_similarity(im1: Any, im2: Any) -> float:
    """Rýchla priestorová (16x16 RGB) + farebná (3D HSV histogram) podobnosť dvoch PIL obrázkov (0..1)."""
    try:
        import numpy as np
        from PIL import Image

        a1 = np.asarray(im1.resize((16, 16), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
        a2 = np.asarray(im2.resize((16, 16), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
        mae = float(np.mean(np.abs(a1 - a2)))
        grid_sim = max(0.0, 1.0 - mae * 2.2)

        h1 = np.asarray(im1.convert("HSV").resize((48, 48), Image.Resampling.BILINEAR), dtype=np.float32)
        h2 = np.asarray(im2.convert("HSV").resize((48, 48), Image.Resampling.BILINEAR), dtype=np.float32)
        hist1, _ = np.histogramdd(h1.reshape(-1, 3), bins=(8, 6, 6), range=((0, 256), (0, 256), (0, 256)))
        hist2, _ = np.histogramdd(h2.reshape(-1, 3), bins=(8, 6, 6), range=((0, 256), (0, 256), (0, 256)))
        v1 = hist1.flatten()
        v2 = hist2.flatten()
        hist_cos = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
        return 0.55 * grid_sim + 0.45 * hist_cos
    except Exception:
        return 0.0


def _parse_namethatporn_post_html(html_txt: str, post_url: str = "") -> Dict[str, Any]:
    """Rozparsuje detail vlákna na NameThatPorn (/post/...html) — vytiahne modelky, aliasy, názov scény a priame video linky."""
    import bs4

    soup = bs4.BeautifulSoup(html_txt or "", "html.parser")
    models: List[str] = []
    aliases: Dict[str, str] = {}
    ext_links: List[str] = []
    internal_posts: List[str] = []
    scene_titles: List[str] = []
    is_confirmed = False

    # 1. Ak je vlákno vyriešené, NameThatPorn vkladá mená modeliek aj do <title>:
    #    "Name of the video and the Actress? - Meg Vicious - Emma Fiore #1848132 › NameThatPorn.com"
    page_title = (soup.title.string if soup.title and soup.title.string else "").strip()
    if "#" in page_title and "namethatporn" in page_title.lower():
        before_hash = page_title.split("#", 1)[0].strip()
        parts_dash = [p.strip() for p in before_hash.split(" - ") if p.strip()]
        if len(parts_dash) >= 2:
            for cand_m in parts_dash[1:]:
                if _is_valid_creator_name(cand_m) and cand_m not in models:
                    models.append(cand_m)

    # 2. Hlavný obrázok vlákna (/media/large/... alebo /media/displays/...)
    display_img = ""
    for img in soup.find_all("img", src=True):
        s_url = str(img.get("src") or "").strip()
        if "/media/large/" in s_url or "/media/displays/" in s_url:
            display_img = s_url if s_url.startswith("http") else f"https://namethatporn.com{s_url}"
            break

    # 3. Odpovede (.id_answer_wrapper) — ak vlákno obsahuje potvrdenú odpoveď (Correct answer / solved),
    #    ignorujeme nepotvrdené tipy nižšie, aby falošný tip (napr. "alice_gg") neprepísal skutočnú odpoveď!
    all_ans = soup.select(".id_answer_wrapper")
    has_any_confirmed = False
    for ans in all_ans:
        top_el = ans.select_one(".id_answer_top_line")
        top_txt = (top_el.get_text(" ", strip=True) if top_el else "").lower()
        full_ans_txt = ans.get_text(" ", strip=True).lower()
        if "correct answer" in top_txt or "solved" in top_txt or "confirms this as correct" in full_ans_txt:
            has_any_confirmed = True
            break

    for ans in all_ans:
        top_el = ans.select_one(".id_answer_top_line")
        top_txt = (top_el.get_text(" ", strip=True) if top_el else "").lower()
        full_ans_txt = ans.get_text(" ", strip=True).lower()
        ans_confirmed = (
            "correct answer" in top_txt
            or "solved" in top_txt
            or "confirms this as correct" in full_ans_txt
        )
        if has_any_confirmed and not ans_confirmed:
            continue
        if ans_confirmed:
            is_confirmed = True

        body = ans.select_one(".id_answer") or ans
        ans_models: List[str] = []

        # 3a. Priame tagy modeliek (/pornstars/meg-vicious.html)
        for a in body.select("a[href*='/pornstars/'], a[href*='/models/']"):
            m_txt = re.sub(r"\s+", " ", a.get_text(" ", strip=True)).strip()
            if _is_valid_creator_name(m_txt):
                if m_txt not in models:
                    models.append(m_txt)
                if m_txt not in ans_models:
                    ans_models.append(m_txt)

        # 3b. Externé odkazy (video referencie, sociálne profily, profily na tube weboch) a interné duplicitné NTP vlákna
        for a in body.select("a[href]"):
            href = str(a.get("href") or "").strip()
            if not href:
                continue
            if href.startswith("/post/") or "namethatporn.com/post/" in href:
                full_p = f"https://namethatporn.com{href}" if href.startswith("/") else href
                full_p = full_p.split("#", 1)[0]
                if full_p != post_url and full_p not in internal_posts:
                    internal_posts.append(full_p)
                continue

            real_u = ""
            if "redir.me?" in href:
                real_u = href.split("redir.me?", 1)[1].strip()
            elif href.startswith(("http://", "https://")) and "namethatporn.com" not in href.lower():
                real_u = href

            if not real_u.startswith(("http://", "https://")):
                continue

            u_parsed = urlparse(real_u)
            u_host = (u_parsed.hostname or "").lower().lstrip("www.")
            u_path = (u_parsed.path or "").strip("/")

            # Sociálne profily (X/Twitter/OnlyFans/Instagram) bez /status/ = alias performera
            if u_host in {"x.com", "twitter.com", "onlyfans.com", "fansly.com", "instagram.com"}:
                segs = [s for s in u_path.split("/") if s]
                if len(segs) == 1 and segs[0].lower() not in {"i", "home", "explore", "search", "share", "intent", "login"}:
                    handle = segs[0].lstrip("@")
                    target_perf = ans_models[0] if ans_models else (models[0] if models else "")
                    if target_perf and handle and len(handle) >= 4:
                        aliases.setdefault(target_perf, handle)
                    continue

            # Tube profil modelky (napr. pornhub.com/pornstar/meg-vicious)
            prof_m = re.search(r"^/?(?:[a-z]{2}/)?(?:pornstar|pornstars|model|models|channels)/([a-z0-9_-]{3,40})/?$", u_parsed.path or "", re.I)
            if prof_m:
                slug_name = re.sub(r"[-_]+", " ", prof_m.group(1)).strip().title()
                if _is_valid_creator_name(slug_name) and slug_name not in models:
                    models.append(slug_name)
                continue

            if real_u not in ext_links:
                ext_links.append(real_u)

        # 3c. Názov scény a meno v texte odpovede ("Her name is Meg Vicious", "The Collaboration Between...")
        body_clone = bs4.BeautifulSoup(str(body), "html.parser")
        for a_el in body_clone.find_all("a"):
            a_el.decompose()
        raw_desc = body_clone.get_text(" ", strip=True)
        for name_m in re.finditer(
            r"\b(?:her\s+name\s+is|actress\s+is|model\s+is|performer\s+is)\s+([A-Z][a-z]{2,14}\s+[A-Z][a-z]{2,14})\b",
            raw_desc,
            re.I,
        ):
            cand_m = f"{name_m.group(1).split()[0].title()} {name_m.group(1).split()[1].title()}"
            if _is_valid_creator_name(cand_m) and cand_m not in models:
                models.append(cand_m)

        clean_desc = re.sub(r"\b(?:video\s+reference|official\s+video|full\s+video|free)\s*:?", " ", raw_desc, flags=re.I)
        clean_desc = re.sub(r"\b(?:her\s+name\s+is\s+[A-Za-z0-9_.\s]{3,25}?and\s+the\s+video\s+is(?:t)?\s+here\s*:?)", " ", clean_desc, flags=re.I)
        clean_desc = re.sub(r"\s+", " ", clean_desc).strip(" -:|,.")
        if 8 <= len(clean_desc) <= 180 and clean_desc not in scene_titles:
            scene_titles.append(clean_desc)

    return {
        "models": models,
        "aliases": aliases,
        "ext_links": ext_links,
        "internal_posts": internal_posts,
        "scene_title": scene_titles[0] if scene_titles else "",
        "is_confirmed": is_confirmed or bool(models),
        "display_img": display_img,
    }


async def namethatporn_cbir_search(
    frames: Sequence[bytes],
    image_url: str = "",
    limit: int = 24,
) -> List[Dict[str, Any]]:
    """Vyhľadá náhľad na NameThatPorn.com (upload alebo URL), overí vizuálnu zhodu náhľadov
    a z vyriešených vlákien (ANSWERED) vytiahne skutočné mená modeliek, názov scény aj priame odkazy na video."""
    from io import BytesIO
    import bs4
    import imagehash
    from PIL import Image

    valid_frames = [f for f in (frames or []) if f and len(f) > 400]
    clean_img_url = str(image_url or "").strip()
    if not valid_frames and not clean_img_url.startswith(("http://", "https://")):
        return []

    ref_bytes = valid_frames[0] if valid_frames else b""
    ref_im = None
    ref_sq = None
    ref_phash = ref_sq_phash = ref_dhash = ref_whash = None

    if ref_bytes:
        try:
            ref_im = Image.open(BytesIO(ref_bytes)).convert("RGB")
            w, h = ref_im.size
            side = min(w, h)
            ref_sq = ref_im.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
            ref_phash = imagehash.phash(ref_im)
            ref_sq_phash = imagehash.phash(ref_sq)
            ref_dhash = imagehash.dhash(ref_sq)
            ref_whash = imagehash.whash(ref_sq)
        except Exception as exc:
            logger.debug("[NTP_CBIR] Chyba dekódovania referenčného obrázka: %s", exc)

    try:
        from curl_cffi import CurlMime
        from curl_cffi.requests import AsyncSession
    except ImportError as exc:
        logger.warning("[NTP_CBIR] curl_cffi nie je dostupné: %s", exc)
        return []

    raw_cards: Dict[str, Dict[str, Any]] = {}

    async with AsyncSession(impersonate="chrome124", timeout=14) as session:
        search_htmls: List[str] = []

        # 1. Priamy multipart upload snímok (funguje pre všetky lokálne, Telegram aj orezané náhľady)
        for idx_f, fr_bytes in enumerate(valid_frames[:2]):
            try:
                jpg_up = compress_thumbnail_bytes(fr_bytes, max_dim=960, quality=85) if len(fr_bytes) > 180_000 else fr_bytes
                mp = CurlMime()
                mp.addpart(
                    name="imgfile",
                    content_type="image/jpeg",
                    filename=f"frame_{idx_f}.jpg",
                    data=jpg_up,
                )
                resp = await session.post("https://namethatporn.com/search/images.html", multipart=mp)
                if resp.status_code == 200 and "nsw_i_r_w" in resp.text:
                    search_htmls.append(resp.text)
            except Exception as exc:
                logger.debug("[NTP_CBIR] Upload frame %d zlyhal: %s", idx_f, exc)

        # 2. Ak upload nevrátil výsledky alebo máme verejnú URL náhľadu, skúsime aj ?url= parameter
        if (not search_htmls or "namethatporn.com" in clean_img_url.lower()) and clean_img_url.startswith(("http://", "https://")):
            try:
                from urllib.parse import quote
                resp_u = await session.get(f"https://namethatporn.com/search/images.html?url={quote(clean_img_url, safe=':/?&=%')}")
                if resp_u.status_code == 200 and "nsw_i_r_w" in resp_u.text:
                    search_htmls.append(resp_u.text)
            except Exception as exc:
                logger.debug("[NTP_CBIR] URL search zlyhal: %s", exc)

        if not search_htmls:
            return []

        for html_txt in search_htmls:
            soup = bs4.BeautifulSoup(html_txt, "html.parser")
            for rank_idx, card in enumerate(soup.select("a.nsw_i_r_w"), start=1):
                href = str(card.get("href") or "").strip()
                if not href or "/post/" not in href:
                    continue
                post_url = f"https://namethatporn.com{href}" if href.startswith("/") else href
                post_url = post_url.split("#", 1)[0]
                if post_url in raw_cards:
                    raw_cards[post_url]["rank"] = min(raw_cards[post_url]["rank"], rank_idx)
                    continue
                img = card.find("img")
                badge = card.find("div", class_="nsw_i_r_w_i")
                btn = card.find("button", class_="nsw_i_r_godepr")
                data_res = str(btn.get("data-res") or "").strip() if btn else ""
                sq_thumb = str((img.get("src") or img.get("data-dyn") or "") if img else "").strip()
                if sq_thumb and not sq_thumb.startswith("http"):
                    sq_thumb = f"https://namethatporn.com{sq_thumb}"
                display_url = f"https://namethatporn.com/media/displays/{data_res}.jpg" if data_res else sq_thumb
                solved = bool(badge and "slvd" in (badge.get("class") or []))
                raw_cards[post_url] = {
                    "rank": rank_idx,
                    "post_url": post_url,
                    "post_title": str(img.get("alt") or "").strip() if img else "",
                    "square_thumb": sq_thumb,
                    "display_url": display_url,
                    "solved": solved,
                    "best_dist": 99,
                    "visual_score": 0,
                }

        cand_list = sorted(raw_cards.values(), key=lambda x: x["rank"])[:22]
        if not cand_list:
            return []

        # 3. Paralelné stiahnutie štvorcových náhľadov z NameThatPorn a výpočet vizuálnej zhody (pHash/dHash/wHash + Spatial/HSV)
        sem = asyncio.Semaphore(10)

        async def _score_card_thumb(c: Dict[str, Any]) -> None:
            if not c.get("square_thumb") or ref_sq is None:
                return
            try:
                async with sem:
                    tr = await session.get(c["square_thumb"])
                if tr.status_code != 200 or len(tr.content) < 300:
                    return
                im = Image.open(BytesIO(tr.content)).convert("RGB")
                p_d = min(int(ref_phash - imagehash.phash(im)), int(ref_sq_phash - imagehash.phash(im)))
                d_d = int(ref_dhash - imagehash.dhash(im))
                w_d = int(ref_whash - imagehash.whash(im))
                best_d = min(p_d, d_d, w_d)
                sc_sim = _spatial_color_similarity(ref_sq, im)
                hash_sim = max(0.0, 1.0 - best_d / 26.0)
                comb_pct = int(round((0.52 * sc_sim + 0.48 * hash_sim) * 100))
                if best_d <= 4:
                    vis_pct = max(comb_pct, 97)
                elif best_d <= 8:
                    vis_pct = max(comb_pct, 88)
                elif best_d <= 14:
                    vis_pct = max(comb_pct, 74)
                elif best_d <= 18:
                    vis_pct = max(comb_pct, 58)
                else:
                    vis_pct = min(comb_pct, 48)
                c["best_dist"] = best_d
                c["sc_sim"] = round(sc_sim, 3)
                c["visual_score"] = max(0, min(99, vis_pct))
            except Exception:
                pass

        await asyncio.gather(*[_score_card_thumb(c) for c in cand_list], return_exceptions=True)

        # Vyberieme kandidátov na prečítanie detailu vlákna (/post/...html):
        # - všetky so silnou vizuálnou zhodou (best_dist <= 18 alebo visual_score >= 54)
        # - plus prvých 5 v poradí NameThatPorn (ak je náhľad z inej sekundy tej istej scény, overíme konsenzus mena!)
        to_inspect: List[Dict[str, Any]] = []
        for c in cand_list:
            if c["best_dist"] <= 18 or c["visual_score"] >= 54 or (c["rank"] <= 5 and (c["best_dist"] <= 25 or c["solved"])):
                to_inspect.append(c)
            if len(to_inspect) >= 7:
                break

        if not to_inspect and cand_list:
            to_inspect = cand_list[:3]

        post_details: Dict[str, Dict[str, Any]] = {}

        async def _fetch_post(u: str) -> Optional[Dict[str, Any]]:
            if u in post_details:
                return post_details[u]
            try:
                async with sem:
                    rp = await session.get(u)
                if rp.status_code == 200 and len(rp.text) > 1000:
                    parsed = _parse_namethatporn_post_html(rp.text, post_url=u)
                    post_details[u] = parsed
                    return parsed
            except Exception as exc:
                logger.debug("[NTP_CBIR] Fetch post %s zlyhal: %s", u, exc)
            return None

        await asyncio.gather(*[_fetch_post(c["post_url"]) for c in to_inspect], return_exceptions=True)

        # 4. Ak niektorá odpoveď odkazuje na iné vyriešené NTP vlákno (/post/...html), dotiahneme aj to (1-hop)
        hop_urls: List[str] = []
        for c in to_inspect:
            det = post_details.get(c["post_url"]) or {}
            if c["best_dist"] <= 18 or c["rank"] <= 3:
                for hp in det.get("internal_posts") or []:
                    if hp not in post_details and hp not in hop_urls:
                        hop_urls.append(hp)
        if hop_urls:
            await asyncio.gather(*[_fetch_post(u) for u in hop_urls[:3]], return_exceptions=True)
            for c in to_inspect:
                det = post_details.get(c["post_url"])
                if not det:
                    continue
                for hp in det.get("internal_posts") or []:
                    h_det = post_details.get(hp)
                    if not h_det:
                        continue
                    for m in h_det.get("models") or []:
                        if m not in det["models"]:
                            det["models"].append(m)
                    det["aliases"].update(h_det.get("aliases") or {})
                    for el in h_det.get("ext_links") or []:
                        if el not in det["ext_links"]:
                            det["ext_links"].append(el)
                    if not det.get("scene_title") and h_det.get("scene_title"):
                        det["scene_title"] = h_det["scene_title"]

    # 5. Spočítame konsenzus performerov naprieč skontrolovanými NTP vláknami,
    #    aby sme odfiltrovali nesúvisiace vlákna s nízkou vizuálnou zhodou
    model_post_counts: Dict[str, int] = {}
    for c in to_inspect:
        det = post_details.get(c["post_url"]) or {}
        for m in set(det.get("models") or []):
            k = _norm_creator_key(m)
            if k:
                model_post_counts[k] = model_post_counts.get(k, 0) + 1

    out: List[Dict[str, Any]] = []
    seen_urls: Set[str] = set()

    for c in to_inspect:
        det = post_details.get(c["post_url"]) or {}
        models = list(det.get("models") or [])
        aliases = dict(det.get("aliases") or {})
        ext_links = list(det.get("ext_links") or [])
        scene_title = str(det.get("scene_title") or "").strip()
        vis = int(c.get("visual_score") or 0)
        best_d = int(c.get("best_dist") or 99)

        has_consensus_model = any(model_post_counts.get(_norm_creator_key(m), 0) >= 2 for m in models)
        is_visually_verified = (
            best_d <= 16
            or vis >= 56
            or (c["rank"] <= 3 and has_consensus_model and (best_d <= 20 or vis >= 45))
            or (c["rank"] == 1 and c.get("solved") and best_d <= 18)
        )
        if not is_visually_verified:
            continue

        # Dynamicky zaregistrujeme overené modelky a ich aliasy do lexikónu
        clean_models: List[str] = []
        for m in models:
            al = str(aliases.get(m) or "")
            canon = register_discovered_performer(m, alias=al) or resolve_known_performer(m) or m
            if canon not in clean_models:
                clean_models.append(canon)
            if al:
                aliases[canon] = al

        is_exact = bool(best_d <= 10 or vis >= 82)
        eff_vis = max(vis, 88 if best_d <= 8 else (78 if best_d <= 14 else (66 if has_consensus_model else vis)))
        thumb_best = str(det.get("display_img") or c.get("display_url") or c.get("square_thumb") or "")
        perf_prefix = ", ".join(clean_models[:3])

        # A) Emitujeme priame externé video/album odkazy z vyriešenej odpovede NameThatPorn (najvyššia hodnota!)
        for ext_u in ext_links[:4]:
            if ext_u in seen_urls:
                continue
            cls_ext = classify_cbir_url(ext_u, title=scene_title or perf_prefix, source="namethatporn")
            if cls_ext.get("blocked"):
                continue
            seen_urls.add(ext_u)
            ext_title = (
                f"{perf_prefix} — {scene_title}"
                if (perf_prefix and scene_title and perf_prefix.lower() not in scene_title.lower())
                else (scene_title or (f"{perf_prefix} (NameThatPorn zdroj)" if perf_prefix else ext_u))
            )
            out.append({
                "url": ext_u,
                "title": ext_title[:180],
                "thumbnail": thumb_best,
                "duration": 0,
                "source": "namethatporn",
                "kind": cls_ext.get("kind") or "video",
                "visual_score": eff_vis,
                "exact_frame": is_exact,
                "match_type": "exact" if eff_vis >= 72 else "visual",
                "engine_rank": c["rank"],
                "models": ", ".join(clean_models),
                "ntp_solved": True,
                "ntp_models": clean_models,
                "ntp_aliases": aliases,
                "ntp_scene_title": scene_title,
                "ntp_post_url": c["post_url"],
                "reason": f"NameThatPorn ✓ · {perf_prefix}" if perf_prefix else "NameThatPorn · Overený zdroj",
            })

        # B) Emitujeme aj samotné vyriešené NameThatPorn vlákno (aby si používateľ vedel kliknúť na Web a pozrieť vlákno)
        post_u = c["post_url"]
        if post_u not in seen_urls:
            seen_urls.add(post_u)
            if clean_models:
                ntp_card_title = f"✓ [ANSWERED: {perf_prefix}] {scene_title or c.get('post_title') or 'NameThatPorn'}"
            else:
                ntp_card_title = str(c.get("post_title") or "NameThatPorn vlákno")
            out.append({
                "url": post_u,
                "title": ntp_card_title[:180],
                "thumbnail": thumb_best,
                "duration": 0,
                "source": "namethatporn",
                "kind": "collection",
                "importable": False,
                "importability": "unsupported",
                "visual_score": eff_vis,
                "exact_frame": is_exact,
                "match_type": "exact" if eff_vis >= 72 else "visual",
                "engine_rank": c["rank"],
                "models": ", ".join(clean_models),
                "ntp_solved": bool(clean_models),
                "ntp_models": clean_models,
                "ntp_aliases": aliases,
                "ntp_scene_title": scene_title,
                "reason": f"NameThatPorn ANSWERED · {perf_prefix}" if clean_models else "NameThatPorn zhoda",
            })

        if len(out) >= limit:
            break

    return out[:limit]


async def discover_creators_and_tags_fallback(
    thumb_bytes: bytes,
    raw_title: str = "",
) -> Dict[str, Any]:
    """Spoľahlivý fallback pre AI Analýzu a Identifikáciu tvorcu (NameThatPorn + Google Vision OCR + Yandex CBIR + Lexikón)."""
    from .main import _yandex_cbir_search

    ocr_task = asyncio.create_task(extract_watermark_text_via_vision(thumb_bytes))
    ntp_task = asyncio.create_task(namethatporn_cbir_search([thumb_bytes], limit=14))
    yandex_task = asyncio.create_task(_yandex_cbir_search(thumb_bytes, limit=14))
    ocr_text, ntp_res, y_res = await asyncio.gather(ocr_task, ntp_task, yandex_task, return_exceptions=True)

    ocr_str = ocr_text if isinstance(ocr_text, str) else ""
    ntp_hits = ntp_res if isinstance(ntp_res, list) else []
    y_hits = y_res if isinstance(y_res, list) else []
    vis_hits = ntp_hits + y_hits

    # Ohodnotíme stiahnuté náhľady cez GPU SigLIP2, ak je pripravený, aby sa odfiltrovali falošné zhody
    try:
        from . import visual_semantic_index as vsi
        if vsi.is_gpu_ready() and y_hits:
            await vsi.score_candidate_thumbnails(thumb_bytes, y_hits, max_fetch=24)
    except Exception:
        pass

    creators = extract_creators_from_visual_hits(
        vis_hits,
        raw_title=raw_title,
        ocr_texts=[ocr_str] if ocr_str else (),
    )
    performers = [c["name"] for c in creators if c.get("name")][:4]

    ntp_scene_titles = [
        str(h.get("ntp_scene_title") or "").strip()
        for h in ntp_hits
        if str(h.get("ntp_scene_title") or "").strip()
    ]

    # Zbierame obsahové tagy z titulku + z overených vizuálnych zhôd
    combined_titles = [raw_title] + ntp_scene_titles + [
        str(h.get("title") or "")
        for h in vis_hits
        if int(h.get("visual_score") or 0) >= 52 or h.get("exact_frame") or h.get("ntp_solved")
    ]
    auto = auto_tag_video(" ".join(combined_titles))
    tags = sanitize_video_tags_list(auto.get("tags") or [], exclude_performers=performers)[:10]

    clean_t = ntp_scene_titles[0] if ntp_scene_titles else clean_title_for_search(raw_title)
    if not clean_t and performers:
        clean_t = performers[0]

    queries: List[str] = []
    if performers:
        queries.append(performers[0])
        if len(performers) >= 2:
            queries.append(f"{performers[0]} {performers[1]}")
        aliases = get_performer_aliases(performers[0])
        if aliases:
            queries.append(f"{performers[0]} {aliases[0]}")
        if tags:
            queries.append(f"{performers[0]} {tags[0]}")
    if clean_t and clean_t.lower() not in {q.lower() for q in queries}:
        queries.append(clean_t[:80])
    if len(tags) >= 2 and len(queries) < 4:
        queries.append(f"{tags[0]} {tags[1]}")

    return {
        "clean_title": clean_t,
        "performers": performers,
        "tags": [t.lower() for t in tags],
        "queries": queries[:5],
        "creators": creators,
        "ocr_text": ocr_str,
        "model_used": "namethatporn+vision_ocr+cbir",
    }


async def ai_disambiguate_creator(
    thumb_bytes: Optional[bytes],
    raw_title: str = "",
    visual_titles: Sequence[str] = (),
    heuristic_candidates: Sequence[Dict[str, Any]] = (),
    api_key: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Určí tvorcu spojením OCR vodoznaku v náhľade, titulku videa, vizuálnych CBIR zhôd a voliteľne Gemini Vision."""
    ocr_str = ""
    if thumb_bytes:
        ocr_str = await extract_watermark_text_via_vision(thumb_bytes)

    ocr_creators = extract_creators_from_ocr_text(ocr_str, raw_title=raw_title) if ocr_str else []
    title_perfs = extract_performer_candidates(
        clean_title_for_search(raw_title),
        raw_title=raw_title,
    )

    merged: Dict[str, Dict[str, Any]] = {}
    for p in title_perfs:
        k = _norm_creator_key(p)
        if k:
            aliases = get_performer_aliases(p)
            merged[k] = {
                "name": p,
                "alias": aliases[0] if aliases else "",
                "confidence": 96,
                "mentions": 1,
                "sources": ["title"],
                "hosts_count": 1,
                "signals": ["video_title"],
                "is_ai": False,
            }

    for oc in ocr_creators:
        k = _norm_creator_key(oc["name"])
        if not k:
            continue
        old = merged.get(k)
        if old:
            old["confidence"] = max(int(old.get("confidence") or 0), int(oc["confidence"]))
            old["sources"] = sorted(set(old.get("sources") or []) | {"watermark"})
            old["signals"] = sorted(set(old.get("signals") or []) | {"ocr_watermark"})
            if oc.get("alias") and not old.get("alias"):
                old["alias"] = oc["alias"]
        else:
            merged[k] = dict(oc)

    for c in list(heuristic_candidates or []):
        k = _norm_creator_key(c.get("name") or "")
        if not k:
            continue
        old = merged.get(k)
        if old:
            old["confidence"] = max(int(old.get("confidence") or 0), int(c.get("confidence") or 0))
            old["mentions"] = max(int(old.get("mentions") or 1), int(c.get("mentions") or 1))
            old["sources"] = sorted(set(old.get("sources") or []) | set(c.get("sources") or []))
            old["signals"] = sorted(set(old.get("signals") or []) | set(c.get("signals") or []))
            if c.get("alias") and not old.get("alias"):
                old["alias"] = c["alias"]
        else:
            merged[k] = dict(c)

    key = (api_key or os.getenv("GEMINI_API_KEY") or "").strip()
    if key and thumb_bytes:
        titles_block = "\n".join(f"- {t[:120]}" for t in list(visual_titles or [])[:12] if t)
        cand_names = [c["name"] for c in merged.values() if c.get("name")]
        prompt = (
            "Identify the adult content creator / performer / OnlyFans model shown in the image, watermark text, "
            "and/or referenced in the visual reverse-image search matches below.\n"
            f"Original file title: {raw_title or '(empty)'}\n"
            f"Thumbnail OCR text: {ocr_str or '(none)'}\n"
            f"Visual CBIR matched titles:\n{titles_block or '(none)'}\n"
            f"Current candidates: {', '.join(cand_names) or '(none)'}\n\n"
            "Return strict JSON ONLY with schema:\n"
            '{"creators": [{"name": "Creator Stage Name", "alias": "optional handle", "confidence": 90}], "scene_query": "short English search phrase"}'
        )
        try:
            jpg = compress_thumbnail_bytes(thumb_bytes, max_dim=768)
        except Exception:
            jpg = thumb_bytes
        body = {
            "contents": [{
                "parts": [
                    {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(jpg).decode("ascii")}},
                    {"text": prompt},
                ]
            }],
            "generationConfig": {
                "temperature": 0.1,
                "maxOutputTokens": 280,
                "responseMimeType": "application/json",
            },
        }
        async with httpx.AsyncClient(timeout=12) as cl:
            for model in GEMINI_VISION_MODELS[:2]:
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
                    resp = await cl.post(url, json=body)
                    if resp.status_code != 200:
                        continue
                    raw_txt = (
                        ((resp.json().get("candidates") or [{}])[0].get("content") or {})
                        .get("parts", [{}])[0]
                        .get("text", "")
                    )
                    parsed = json.loads(raw_txt)
                    for item in parsed.get("creators") or []:
                        cname = re.sub(r"\s+", " ", str(item.get("name") or "").strip())
                        if cname and _is_valid_creator_name(cname):
                            canon = resolve_known_performer(cname) or cname
                            k = _norm_creator_key(canon)
                            old = merged.get(k)
                            if old:
                                old["is_ai"] = True
                                old["confidence"] = max(int(old.get("confidence") or 0), int(item.get("confidence") or 85))
                                old["sources"] = sorted(set(old.get("sources") or []) | {"gemini"})
                                if item.get("alias") and not old.get("alias"):
                                    old["alias"] = str(item.get("alias")).strip()
                            else:
                                merged[k] = {
                                    "name": canon,
                                    "alias": str(item.get("alias") or "").strip(),
                                    "confidence": max(55, min(99, int(item.get("confidence") or 80))),
                                    "mentions": 1,
                                    "sources": ["gemini"],
                                    "hosts_count": 1,
                                    "signals": ["ai_visual_consensus"],
                                    "is_ai": True,
                                }
                    break
                except Exception as exc:
                    logger.debug("[CREATOR_AI] model=%s err=%s", model, exc)

    out = list(merged.values())
    out.sort(
        key=lambda x: (
            1 if any(s in (x.get("signals") or []) for s in ("ntp_solved", "ocr_watermark", "video_title")) else 0,
            1 if "ntp_solved" in (x.get("signals") or []) else 0,
            int(x.get("mentions") or 0),
            int(x.get("confidence") or 0),
        ),
        reverse=True,
    )
    return out[:6]
